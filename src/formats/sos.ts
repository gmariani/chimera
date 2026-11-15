import { bytesLabel, field } from '../core/bytes';
import type { Entry, Field, FormatParser, TableRow } from '../core/types';
import { SOS_DRIVER_HEADER, SOS_FILE_HEADER, sosLayout, type SosDriver } from './sos-sniff';

/**
 * HMI's Sound Operating System (SOS) driver libraries: HMIDRV.386 (a sound card's driver, for each card and mode) and
 * HMIDET.386 (the drivers that detect which card there is), which Command & Conquer and other DOS games of 1993–96
 * shipped. The layout is SOS.H's (REDALERT/WIN32LIB in the source EA released): a 44-byte _FILEHEADER, then each
 * driver's 48-byte _DRIVERHEADER and its code, back to back. Two fields don't say what SOS.H calls them, in every
 * library the games ship: lNextDriver is the driver's size plus 92, where the next driver would be in a file of the
 * driver alone (its header and a file header), not where it is; lFileSize is the file's size cut to 16 bits. A driver
 * starts with a jump past its text: a banner ending in 0x1A, then the device's name.
 */

/** The devices SOS.H names (_SOUND_BLASTER_8_MONO and the rest): 8 or 16 bits, mono or stereo. */
const DEVICES: Record<number, string> = {
    0xe000: 'SOUND_BLASTER_8_MONO',
    0xe001: 'SOUND_BLASTER_8_ST',
    0xe00f: 'SBPRO_8_MONO',
    0xe002: 'SOUND_MASTER_II_8_MONO',
    0xe003: 'MV_PAS_8_MONO',
    0xe004: 'MV_PAS_16_MONO',
    0xe005: 'MV_PAS_8_ST',
    0xe006: 'MV_PAS_16_ST',
    0xe007: 'ADLIB_GOLD_8_ST',
    0xe008: 'ADLIB_GOLD_16_ST',
    0xe009: 'ADLIB_GOLD_8_MONO',
    0xe00a: 'ADLIB_GOLD_16_MONO',
    0xe00b: 'MICROSOFT_8_MONO',
    0xe00c: 'MICROSOFT_8_ST',
    0xe00d: 'MICROSOFT_16_MONO',
    0xe00e: 'MICROSOFT_16_ST',
    0xe010: 'SOUND_SOURCE_8_MONO_PC',
    0xe011: 'SOUND_SOURCE_8_MONO_TANDY',
    0xe012: 'GENERAL_PORT_8_MONO',
    0xe013: 'GENERAL_PORT_8_MONO_R',
    0xe014: 'SIERRA_8_MONO',
    0xe015: 'SB16_8_MONO',
    0xe016: 'SB16_8_ST',
    0xe017: 'SB16_16_MONO',
    0xe018: 'SB16_16_ST',
    0xe019: 'ESS_AUDIODRIVE_8_MONO',
    0xe01a: 'ESS_AUDIODRIVE_8_ST',
    0xe01b: 'ESS_AUDIODRIVE_16_MONO',
    0xe01c: 'ESS_AUDIODRIVE_16_ST',
    0xe01d: 'SOUNDSCAPE_8_MONO',
    0xe01e: 'SOUNDSCAPE_8_ST',
    0xe01f: 'SOUNDSCAPE_16_MONO',
    0xe020: 'SOUNDSCAPE_16_ST',
    0xe021: 'RAP10_8_MONO',
    0xe022: 'RAP10_16_MONO',
    0xe023: 'GUS_8_MONO',
    0xe024: 'GUS_8_ST',
    0xe025: 'GUS_16_MONO',
    0xe026: 'GUS_16_ST',
    0xe027: 'GUS_MAX_8_MONO',
    0xe028: 'GUS_MAX_8_ST',
    0xe029: 'GUS_MAX_16_MONO',
    0xe02a: 'GUS_MAX_16_ST',
    0xe02b: 'WAVEJAMMER_8_MONO',
    0xe02c: 'WAVEJAMMER_8_ST',
    0xe02d: 'WAVEJAMMER_16_MONO',
    0xe02e: 'WAVEJAMMER_16_ST',
    0xe02f: 'TEMPOCS_8_MONO',
    0xe030: 'TEMPOCS_8_ST',
    0xe031: 'TEMPOCS_16_MONO',
    0xe032: 'TEMPOCS_16_ST',
    0xe033: 'WAVEJAMMERCD_8_MONO',
    0xe034: 'WAVEJAMMERCD_8_ST',
    0xe035: 'WAVEJAMMERCD_16_MONO',
    0xe036: 'WAVEJAMMERCD_16_ST',
    0xe050: 'SOUND_BLASTER_8_MONO_R',
    0xe051: 'MICROSOFT_8_MONO_R',
    0xe052: 'SOUND_MASTER_II_8_MONO_R',
    0xe053: 'ADLIB_GOLD_8_MONO_R',
    0xe054: 'MV_PAS_8_MONO_R',
    0xe058: 'RAP10_8_MONO_R',
    0xe059: 'RAP10_16_MONO_R',
    0xe05a: 'SB16_8_MONO_R',
    0xe05b: 'SB16_8_ST_R',
    0xe05c: 'SB16_16_MONO_R',
    0xe05d: 'SB16_16_ST_R',
    0xe060: 'MV_PAS_16_MONO_R',
    0xe061: 'SOUNDSCAPE_8_MONO_R',
    0xe062: 'SOUNDSCAPE_8_ST_R',
    0xe063: 'SOUNDSCAPE_16_MONO_R',
    0xe064: 'SOUNDSCAPE_16_ST_R',
    0xe065: 'ESS_AUDIODRIVE_8_MONO_R',
    0xe066: 'ESS_AUDIODRIVE_8_ST_R',
    0xe067: 'ESS_AUDIODRIVE_16_MONO_R',
    0xe068: 'ESS_AUDIODRIVE_16_ST_R',
    0xe090: 'SPEECH_THING_8_MONO',
    0xe106: 'YAMAHA_8_MONO',
    0xe107: 'INT_SPEAKER_8_MONO',
};

/** SOS.H's DOS extenders: the one each driver was built for. */
const EXTENDERS: [number, string][] = [
    [0x8000, "Rational's DOS/4GW"],
    [0x4000, "FlashTek's X-32"],
];

const extender = (value: number) => {
    const known = EXTENDERS.filter(([bit]) => value & bit).map(([, n]) => n);
    const other = value & ~0xc000;
    return [...known, ...(other ? [`0x${other.toString(16)}`] : [])].join(' and ') || 'none';
};

/** The banner and the device's own name from a driver's text (after its first jump; the banner ends in 0x1A), if it has them. */
function text(code: Uint8Array): { banner?: string; device?: string } {
    const eof = code.subarray(0, 1024).indexOf(0x1a);
    if (eof < 0) return {};
    let start = eof;
    while (start > 0 && ((code[start - 1] >= 0x20 && code[start - 1] < 0x7f) || code[start - 1] === 13 || code[start - 1] === 10)) start--;
    const end = code.indexOf(0, eof + 1);
    const plain = (b: Uint8Array) => (b.every((c) => (c >= 0x20 && c < 0x7f) || c === 13 || c === 10) ? String.fromCharCode(...b) : undefined);
    const banner = plain(code.subarray(start, eof))?.replace(/\s+/g, ' ').trim();
    const device = end > eof + 1 && end - eof < 64 ? plain(code.subarray(eof + 1, end))?.trim() : undefined;
    return { banner: banner || undefined, device: device || undefined };
}

const deviceName = (d: SosDriver, own?: string) => {
    const known = DEVICES[d.device];
    return own ?? (known ? known.replace(/_/g, ' ') : undefined);
};

const parser: FormatParser = {
    parse(data) {
        const layout = sosLayout(data);
        if (typeof layout === 'string') throw new Error(`Not an SOS driver library: ${layout}`);
        const warnings: string[] = [];
        const cut = layout.sizeField & 0xffff;
        if (cut !== (data.length & 0xffff))
            warnings.push(
                `The header's size, cut to 16 bits as the games' libraries have it, is ${cut.toLocaleString('en-US')}; the file's is ${(data.length & 0xffff).toLocaleString('en-US')} (${data.length.toLocaleString('en-US')} in full).`
            );
        const offLink = layout.drivers.filter((d) => d.next !== d.size + 92);
        if (offLink.length)
            warnings.push(
                `${offLink.length.toLocaleString('en-US')} driver${offLink.length === 1 ? "'s" : "s'"} next-driver field isn't its size plus 92, as in every library the games ship (the first: ${offLink[0].name}, ${offLink[0].next.toLocaleString('en-US')}).`
            );

        const rows: TableRow[] = [];
        const entries: Entry[] = [];
        const fields: Field[] = [
            {
                name: 'Header',
                offset: 0,
                length: SOS_FILE_HEADER,
                children: [
                    field('Name', 0, 32, layout.name, 'SOS.H\'s szName. Both of TD\'s libraries say "3".'),
                    field('Drivers', 32, 4, layout.count),
                    field('First driver', 36, 4, layout.first, 'Right after this header.'),
                    field('File size, cut to 16 bits', 40, 4, `0x${layout.sizeField.toString(16)}`, "SOS.H's lFileSize: the file's size, cut to 16 bits (and sign-extended, in HMIDRV.386)."),
                ],
            },
        ];
        for (const d of layout.drivers) {
            const code = data.subarray(d.at + SOS_DRIVER_HEADER, d.at + SOS_DRIVER_HEADER + d.size);
            const own = text(code);
            const device = deviceName(d, own.device);
            const id = `0x${d.device.toString(16).padStart(4, '0')}`;
            fields.push({
                name: d.name,
                offset: d.at,
                length: SOS_DRIVER_HEADER + d.size,
                value: device ?? id,
                children: [
                    field('Name', d.at, 32, d.name),
                    field(
                        'Next driver',
                        d.at + 32,
                        4,
                        d.next,
                        `Its size plus 92: where the next driver would be in a file of this one alone. The next is at ${(d.at + SOS_DRIVER_HEADER + d.size).toLocaleString('en-US')}.`
                    ),
                    field('Size', d.at + 36, 4, bytesLabel(d.size)),
                    field('Device', d.at + 40, 4, id, DEVICES[d.device] ? `_${DEVICES[d.device]} in SOS.H.` : 'Not one SOS.H names.'),
                    field('DOS extender', d.at + 44, 4, `0x${d.extender.toString(16)}`, extender(d.extender)),
                    field('Code', d.at + SOS_DRIVER_HEADER, d.size, own.banner, 'The driver, loaded and called by the game: a jump past its text first.'),
                ],
            });
            entries.push({ name: d.name, label: d.name, offset: d.at + SOS_DRIVER_HEADER, size: d.size, data: code, meta: { Device: device ?? id } });
            rows.push({ group: extender(d.extender), cells: { driver: d.name, device: device ?? 'Not named', id, size: d.size.toLocaleString('en-US') } });
        }
        const devices = new Set(layout.drivers.map((d) => d.device)).size;
        return {
            title: 'Sound drivers (HMI SOS)',
            summary: [
                ['Drivers', layout.count.toLocaleString('en-US')],
                ['Devices', `${devices.toLocaleString('en-US')} (by SOS.H's IDs)`],
                ['For', [...new Set(layout.drivers.map((d) => extender(d.extender)))].join('; ')],
            ],
            fields,
            entries,
            preview: {
                kind: 'table',
                columns: [
                    { key: 'driver', label: 'Driver' },
                    { key: 'device', label: 'Device' },
                    { key: 'id', label: 'ID' },
                    { key: 'size', label: 'Size', numeric: true },
                ],
                groups: [...new Set(rows.map((r) => r.group))],
                rows,
            },
            end: layout.end,
            warnings,
        };
    },
};

export default parser;
