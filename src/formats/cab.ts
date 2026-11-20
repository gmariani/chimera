import { Bytes, bytesLabel, dosDateTime, field, fillGaps, hex } from '../core/bytes';
import { inflate } from '../core/inflate';
import { checkBytes } from '../core/limits';
import type { Entry, Field, FormatParser, TableRow } from '../core/types';
import { sniffCab } from './cab-sniff';
import { readSignature, signedBy } from './pkcs7';

/**
 * Microsoft cabinets (.cab), from 1994 on: Windows' and Office's installers, Internet Explorer's downloads, ActiveX
 * controls, DirectX's redistributables. A 36-byte header ("MSCF", the cabinet's size, where the file list is, version
 * 1.3, how many folders and files, flags, which cabinet of a set this is), space set aside for the program that made it
 * (a signature, for Internet Explorer's), the names of the cabinets before and after it in a set, then a list of
 * folders and a list of files. A folder is a stream of data in blocks, compressed as one ("none", MSZIP, Quantum or
 * LZX), that its files are stretches of. Each block has a checksum, its compressed size and its size unpacked.
 *
 * MSZIP: each block "CK" and raw Deflate, unpacking to at most 32 KB, its back-references able to reach into the 32 KB
 * before it, in the blocks before. Quantum and LZX folders are listed, but not unpacked here.
 *
 * A signed cabinet (DirectX's redistributables) carries an Authenticode signature right after its end, and 20 bytes set
 * aside in its header say where: 0, 16 (the size of what follows), where the signature starts and its size, and 8
 * bytes of 0. That layout is as osslsigncode writes and checks it (https://github.com/mtrojnar/osslsigncode; facts only).
 *
 * See Microsoft's "Microsoft Cabinet Format" (https://learn.microsoft.com/previous-versions/bb417343(v=msdn.10)) and
 * [MS-MCI], "Microsoft ZIP (MSZIP) Compression and Decompression Data Structure"
 * (https://learn.microsoft.com/openspecs/exchange_server_protocols/ms-mci).
 */

const COMPRESSION = ['none', 'MSZIP', 'Quantum', 'LZX'];
const PREV = 0x01;
const NEXT = 0x02;
const RESERVE = 0x04;
/** A block unpacks to at most this. */
const BLOCK = 32768;
const MOST_FIELDS = 2000;

/** The checksum of a data block: its bytes, then its two sizes, each taken 4 bytes at a time and XORed together. */
export function cabChecksum(bytes: Uint8Array, seed = 0): number {
    let sum = seed;
    const whole = bytes.length & ~3;
    for (let i = 0; i < whole; i += 4) sum ^= bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24);
    // The 1 to 3 left over, the first of them highest.
    let rest = 0;
    for (let i = whole; i < bytes.length; i++) rest = (rest << 8) | bytes[i];
    return (sum ^ rest) >>> 0;
}

const ATTRIBUTES: [number, string][] = [
    [0x01, 'read-only'],
    [0x02, 'hidden'],
    [0x04, 'system'],
    [0x20, 'archive'],
    [0x40, 'run after extracting'],
    [0x80, 'name in UTF-8'],
];
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

const parser: FormatParser = {
    parse(data, context) {
        if (!sniffCab(data)) throw new Error('This isn’t a Microsoft cabinet: it doesn’t start with "MSCF" and a header that fits.');
        const b = new Bytes(data);
        const warnings: string[] = [];
        const size = b.u32(8);
        const filesAt = b.u32(16);
        const [minor, major] = [data[24], data[25]];
        const folderCount = b.u16(26);
        const fileCount = b.u16(28);
        const flags = b.u16(30);
        const setId = b.u16(32);
        const number = b.u16(34);
        let end = Math.min(size, data.length);
        if (size > data.length) warnings.push(`It says it’s ${bytesLabel(size)}, but the file is ${bytesLabel(data.length)}: it’s been cut short.`);
        if (major !== 1 || minor !== 3) warnings.push(`It says it’s version ${major}.${minor}; cabinets are 1.3.`);
        for (const [at, name] of [
            [12, 'second'],
            [20, 'third'],
        ] as const)
            if (b.u32(at)) warnings.push(`Its header’s ${name} reserved field is 0x${hex(b.u32(at))}, not 0.`);
        if (flags & ~7) warnings.push(`Its header has flags the format doesn’t define (0x${hex(flags & ~7, 4)}).`);

        const fields: Field[] = [];
        const header: Field[] = [
            field('Signature', 0, 4, 'MSCF'),
            field('Reserved', 4, 4, b.u32(4)),
            field('Size', 8, 4, bytesLabel(size), 'Of the whole cabinet.'),
            field('Reserved', 12, 4, b.u32(12)),
            field('Files at', 16, 4, filesAt, 'Where the list of files starts.'),
            field('Reserved', 20, 4, b.u32(20)),
            field('Version', 24, 2, `${major}.${minor}`),
            field('Folders', 26, 2, folderCount),
            field('Files', 28, 2, fileCount),
            field(
                'Flags',
                30,
                2,
                [flags & PREV ? 'a cabinet before it' : '', flags & NEXT ? 'a cabinet after it' : '', flags & RESERVE ? 'space set aside' : ''].filter(Boolean).join(', ') || 'none',
                '1: there’s a cabinet before it in the set; 2: one after; 4: it has space set aside.'
            ),
            field('Set', 32, 2, setId, 'The same for every cabinet of a set.'),
            field('Number in its set', 34, 2, number, 'From 0.'),
        ];
        let p = 36;
        let signature: { at: number; length: number } | null = null;
        let folderReserve = 0;
        let blockReserve = 0;
        if (flags & RESERVE) {
            const headerReserve = b.u16(36);
            folderReserve = data[38];
            blockReserve = data[39];
            header.push(
                field('Set aside in the header', 36, 2, bytesLabel(headerReserve)),
                field('Set aside in each folder', 38, 1, bytesLabel(folderReserve)),
                field('Set aside in each block', 39, 1, bytesLabel(blockReserve))
            );
            p = 40;
            if (p + headerReserve > end) throw new Error(`This isn’t a Microsoft cabinet: it sets aside ${bytesLabel(headerReserve)} in its header, past its end.`);
            if (headerReserve >= 20 && b.u16(p) === 0 && b.u16(p + 2) === 16) {
                signature = { at: b.u32(p + 4), length: b.u32(p + 8) };
                header.push({
                    name: 'Set aside',
                    offset: p,
                    length: headerReserve,
                    value: 'where its signature is',
                    children: fillGaps(
                        data,
                        [
                            field('Marker', p, 4, `0x${hex(b.u32(p))}`, '0, then 16: the size of what follows.'),
                            field('Signature at', p + 4, 4, signature.at),
                            field('Signature size', p + 8, 4, bytesLabel(signature.length)),
                            field('Zeros', p + 12, 8, `0x${hex(b.u32(p + 12))}${hex(b.u32(p + 16))}`),
                        ],
                        p,
                        p + headerReserve,
                        'The rest'
                    ),
                });
            } else if (headerReserve) {
                const empty = data.subarray(p, p + headerReserve).every((v) => v === 0);
                header.push(
                    field('Set aside', p, headerReserve, bytesLabel(headerReserve), empty ? 'Empty: space kept for the program that made it, as for a signature.' : 'For the program that made it.')
                );
            }
            p += headerReserve;
        }
        /** A string ending in a 0, at most 255 bytes and the 0. */
        const string = (at: number, utf: boolean): { text: string; next: number } | null => {
            const stop = Math.min(end, at + 256);
            let z = at;
            while (z < stop && data[z]) z++;
            if (z >= stop) return null;
            return { text: new TextDecoder(utf ? 'utf-8' : 'latin1').decode(data.subarray(at, z)), next: z + 1 };
        };
        const links: [string, string][] = [];
        for (const [flag, which] of [
            [PREV, 'before'],
            [NEXT, 'after'],
        ] as const) {
            if (!(flags & flag)) continue;
            const cabinet = string(p, false);
            const disk = cabinet && string(cabinet.next, false);
            if (!cabinet || !disk) throw new Error(`This isn’t a Microsoft cabinet: the name of the cabinet ${which} it runs past its end.`);
            header.push(field(`Cabinet ${which}`, p, cabinet.next - p, JSON.stringify(cabinet.text)), field(`Disk ${which}`, cabinet.next, disk.next - cabinet.next, JSON.stringify(disk.text)));
            links.push([`Cabinet ${which}`, `${cabinet.text}${disk.text ? ` (on “${disk.text}”)` : ''}`]);
            p = disk.next;
        }
        fields.push({ name: 'Header', offset: 0, length: p, value: `version ${major}.${minor}, ${plural(folderCount, 'folder')}, ${plural(fileCount, 'file')}`, children: header });

        // Folders.
        const folders: { at: number; blocks: number; type: number }[] = [];
        const folderFields: Field[] = [];
        for (let i = 0; i < folderCount; i++, p += 8 + folderReserve) {
            if (p + 8 + folderReserve > end) {
                warnings.push(`The list of folders ends after ${plural(i, 'folder')}, of the ${folderCount.toLocaleString('en-US')} its header says.`);
                break;
            }
            const f = { at: b.u32(p), blocks: b.u16(p + 4), type: b.u16(p + 6) };
            folders.push(f);
            const method = COMPRESSION[f.type & 15] ?? `method ${f.type & 15}`;
            const window = (f.type & 15) >= 2 ? `, a ${2 ** ((f.type >> 8) & 31) / 1024} KB window` : '';
            folderFields.push({
                name: `Folder ${i + 1}`,
                offset: p,
                length: 8 + folderReserve,
                value: `${method}${window}, ${plural(f.blocks, 'block')}`,
                children: [
                    field('Data at', p, 4, f.at),
                    field('Blocks', p + 4, 2, f.blocks),
                    field('Compression', p + 6, 2, `${method}${window}`, '0 none, 1 MSZIP, 2 Quantum, 3 LZX; for Quantum and LZX, the window’s size in bits above.'),
                    ...(folderReserve ? [field('Set aside', p + 8, folderReserve, bytesLabel(folderReserve))] : []),
                ],
            });
            if ((f.type & 15) > 3) warnings.push(`Folder ${i + 1} says it’s compressed with method ${f.type & 15}, which cabinets don’t have.`);
        }
        if (folderFields.length) fields.push({ name: 'Folders', offset: folderFields[0].offset, length: p - folderFields[0].offset, children: folderFields });
        if (filesAt !== p) warnings.push(`Its header says the list of files is at ${filesAt.toLocaleString('en-US')}, but the folders end at ${p.toLocaleString('en-US')}.`);

        // Files.
        p = filesAt;
        const files: { name: string; size: number; offset: number; folder: number; date: string; attributes: number; at: number }[] = [];
        const fileFields: Field[] = [];
        for (let i = 0; i < fileCount; i++) {
            if (p + 17 > end) {
                warnings.push(`The list of files ends after ${plural(i, 'file')}, of the ${fileCount.toLocaleString('en-US')} its header says.`);
                break;
            }
            const attributes = b.u16(p + 14);
            const name = string(p + 16, !!(attributes & 0x80));
            if (!name) {
                warnings.push(`File ${i + 1}’s name runs past the end of the cabinet, or past 255 bytes.`);
                break;
            }
            const f = { name: name.text, size: b.u32(p), offset: b.u32(p + 4), folder: b.u16(p + 8), date: dosDateTime(b.u16(p + 10), b.u16(p + 12)), attributes, at: p };
            files.push(f);
            const folderText =
                f.folder === 0xfffd
                    ? 'begins in the cabinet before'
                    : f.folder === 0xfffe
                      ? 'goes on in the cabinet after'
                      : f.folder === 0xffff
                        ? 'goes on before and after'
                        : `folder ${f.folder + 1}`;
            const attributeText = ATTRIBUTES.filter(([bit]) => attributes & bit).map(([, text]) => text);
            fileFields.push({
                name: f.name,
                offset: p,
                length: name.next - p,
                value: bytesLabel(f.size),
                children: [
                    field('Size', p, 4, bytesLabel(f.size)),
                    field('Offset in its folder', p + 4, 4, f.offset, 'Where it starts in its folder, unpacked.'),
                    field('Folder', p + 8, 2, folderText, '0xFFFD: it begins in the cabinet before; 0xFFFE: it goes on in the one after; 0xFFFF: both.'),
                    field('Date', p + 10, 2, f.date.slice(0, 10)),
                    field('Time', p + 12, 2, f.date.slice(11)),
                    field('Attributes', p + 14, 2, attributeText.join(', ') || 'none'),
                    field('Name', p + 16, name.next - p - 16, JSON.stringify(f.name)),
                ],
            });
            if (attributes & ~0xe7) warnings.push(`${f.name} has attributes the format doesn’t define (0x${hex(attributes & ~0xe7, 4)}).`);
            if (f.folder < 0xfffd && f.folder >= folderCount)
                warnings.push(`${f.name} says it’s in folder ${f.folder + 1}, but there ${folderCount === 1 ? 'is' : 'are'} ${folderCount.toLocaleString('en-US')}.`);
            p = name.next;
        }
        if (fileFields.length) fields.push({ name: 'Files', offset: filesAt, length: p - filesAt, children: fileFields });

        // Each folder's blocks, unpacked when it's a kind unpacked here.
        const unpacked: (Uint8Array | null)[] = [];
        let total = 0;
        let badSums = 0;
        let listed = 0;
        for (const [i, f] of folders.entries()) {
            const method = f.type & 15;
            const blockFields: Field[] = [];
            const parts: Uint8Array[] = [];
            let q = f.at;
            let failed = '';
            let history: Uint8Array = new Uint8Array(0);
            let short = 0;
            for (let k = 0; k < f.blocks; k++) {
                if (q + 8 + blockReserve > end) {
                    failed = `its block ${k + 1} of ${f.blocks.toLocaleString('en-US')} would start past the end of the cabinet`;
                    break;
                }
                const sum = b.u32(q);
                const packed = b.u16(q + 4);
                const unpackedSize = b.u16(q + 6);
                const at = q + 8 + blockReserve;
                if (at + packed > end) {
                    failed = `its block ${k + 1} runs past the end of the cabinet`;
                    break;
                }
                const bytes = data.subarray(at, at + packed);
                if (sum && cabChecksum(data.subarray(q + 4, q + 8), cabChecksum(bytes)) !== sum) badSums++;
                if (listed < MOST_FIELDS)
                    blockFields.push({
                        name: `Block ${k + 1}`,
                        offset: q,
                        length: 8 + blockReserve + packed,
                        value: `${bytesLabel(packed)}, ${bytesLabel(unpackedSize)} unpacked`,
                        children: [
                            field('Checksum', q, 4, sum ? `0x${hex(sum)}` : 'none', 'Of its data, then of its two sizes; 0 when there’s none.'),
                            field('Size', q + 4, 2, bytesLabel(packed)),
                            field('Unpacked', q + 6, 2, bytesLabel(unpackedSize)),
                            ...(blockReserve ? [field('Set aside', q + 8, blockReserve, bytesLabel(blockReserve))] : []),
                            field('Data', at, packed, bytesLabel(packed)),
                        ],
                    });
                else if (listed === MOST_FIELDS) blockFields.push(field('More blocks', q, 0, `Past the first ${MOST_FIELDS.toLocaleString('en-US')}, not listed one by one.`));
                listed++;
                q = at + packed;
                if (failed || method > 1) continue;
                if (unpackedSize > BLOCK) {
                    failed = `its block ${k + 1} says it unpacks to ${bytesLabel(unpackedSize)}, more than the 32 KB a block can`;
                    continue;
                }
                total = checkBytes(total + unpackedSize, 'The cabinet’s files, unpacked');
                if (method === 0) {
                    if (packed !== unpackedSize) failed = `its block ${k + 1} is ${bytesLabel(packed)}, but says it’s ${bytesLabel(unpackedSize)} unpacked, and it isn’t compressed`;
                    else parts.push(bytes);
                    continue;
                }
                if (bytes[0] !== 0x43 || bytes[1] !== 0x4b) {
                    failed = `its block ${k + 1} doesn’t start with "CK", as an MSZIP block does`;
                    continue;
                }
                try {
                    const out = inflate(bytes.subarray(2), unpackedSize, BLOCK, { raw: true, dictionary: history });
                    if (out.length !== unpackedSize) failed = `its block ${k + 1} unpacks to ${bytesLabel(out.length)}, not the ${bytesLabel(unpackedSize)} it says`;
                    // Every block but the last is a full 32 KB in every real cabinet: the history is then the same
                    // whether a program keeps it as a 32 KB window (libmspack, cabextract) or as what came before.
                    if (k < f.blocks - 1 && out.length < BLOCK) short++;
                    parts.push(out);
                    // What the next block can reach back into: the last 32 KB, of this block and those before.
                    const next = new Uint8Array(Math.min(BLOCK, history.length + out.length));
                    const fromOut = Math.min(out.length, next.length);
                    next.set(history.subarray(history.length - (next.length - fromOut)));
                    next.set(out.subarray(out.length - fromOut), next.length - fromOut);
                    history = next;
                } catch (e) {
                    failed = `its block ${k + 1} can’t be unpacked: ${e instanceof Error ? e.message : e}`;
                }
            }
            if (blockFields.length) fields.push({ name: `Folder ${i + 1}’s data`, offset: f.at, length: q - f.at, value: plural(f.blocks, 'block'), children: blockFields });
            if (short)
                warnings.push(
                    `${plural(short, 'block')} of folder ${i + 1} ${short === 1 ? 'unpacks' : 'unpack'} to less than 32 KB, though not the last: programs differ on what the blocks after reach back into, so its files may come out differently elsewhere.`
                );
            if (failed) warnings.push(`Folder ${i + 1} can’t be unpacked in full: ${failed}. The files past where it stops aren’t taken out.`);
            if (method > 1) {
                unpacked.push(null);
                continue;
            }
            const joined = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
            let w = 0;
            for (const x of parts) {
                joined.set(x, w);
                w += x.length;
            }
            unpacked.push(joined);
        }
        if (badSums) warnings.push(`${plural(badSums, 'block')}’ checksums don’t match ${badSums === 1 ? 'its' : 'their'} data: the cabinet was damaged or changed after it was made.`);

        // The files, from their folders.
        const entries: Entry[] = [];
        const rows: TableRow[] = [];
        let continued = 0;
        let skipped = 0;
        for (const f of files) {
            const folder = f.folder >= 0xfffd ? null : unpacked[f.folder];
            const method = f.folder < folders.length ? COMPRESSION[folders[f.folder].type & 15] : undefined;
            if (f.folder >= 0xfffd) continued++;
            const inside = folder && f.offset + f.size <= folder.length ? folder.subarray(f.offset, f.offset + f.size) : null;
            if (folder && !inside) skipped++;
            const path = f.name.replace(/\\/g, '/');
            if (inside) entries.push({ name: path, label: path, offset: folders[f.folder].at, size: f.size, data: inside, meta: { Date: f.date } });
            rows.push({
                group: 'Files',
                cells: {
                    name: f.name,
                    size: f.size.toLocaleString('en-US'),
                    date: f.date,
                    attributes: ATTRIBUTES.filter(([bit]) => f.attributes & bit)
                        .map(([, text]) => text)
                        .join(', '),
                    folder: f.folder >= 0xfffd ? 'spans cabinets' : `${f.folder + 1}${method && method !== 'none' && method !== 'MSZIP' ? ` (${method}, not unpacked here)` : ''}`,
                },
            });
        }
        if (skipped)
            warnings.push(
                `${plural(skipped, 'file')} ${skipped === 1 ? 'runs' : 'run'} past what ${skipped === 1 ? 'its' : 'their'} folder unpacks to: ${skipped === 1 ? 'it isn’t' : 'they aren’t'} taken out.`
            );

        // The signature, right after the cabinet.
        let signed = '';
        if (signature) {
            const { at, length } = signature;
            if (at !== size || at + length > data.length)
                warnings.push(
                    `Its header says its signature is ${bytesLabel(length)} at ${at.toLocaleString('en-US')}, ${at + length > data.length ? 'past the end of the file' : 'not right after the cabinet, where Windows looks for it'}.`
                );
            else {
                const inside: Field[] = [];
                try {
                    const info = readSignature(data, at, at + length);
                    inside.push(...info.fields);
                    warnings.push(...info.problems.map((t) => `Its signature: ${t}`));
                    signed = `${signedBy(info)}${info.digest ? `; the cabinet’s ${info.digest.algorithm} hash` : ''}${info.signers[0]?.timestamp ? `; timestamped ${info.signers[0].timestamp.at.slice(0, 10)}` : ''} (Authenticode), not checked here`;
                } catch (e) {
                    warnings.push(`Its signature isn’t one Windows could read: ${e instanceof Error ? e.message : String(e)}.`);
                }
                fields.push({ name: 'Signature', offset: at, length, value: signed ? signed.split(';')[0] : bytesLabel(length), children: fillGaps(data, inside, at, at + length, 'Padding') });
                const stem = (context.name ?? context.label ?? 'cabinet').replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '');
                entries.push({ name: `${stem}-signature.p7s`, label: 'Signature', offset: at, size: length, data: data.subarray(at, at + length), format: 'pkcs7' });
                end = at + length;
            }
        }

        const methods = [...new Set(folders.map((f) => COMPRESSION[f.type & 15] ?? 'unknown'))];
        const unpackable = folders.filter((f) => (f.type & 15) > 1).length;
        return {
            title: 'Microsoft cabinet (CAB)',
            summary: [
                ['Files', `${fileCount.toLocaleString('en-US')}, ${bytesLabel(files.reduce((n, f) => n + f.size, 0))} unpacked`],
                ['Compression', methods.join(', ') || 'none'],
                ...(unpackable
                    ? [['Not unpacked', `${plural(unpackable, 'folder')} in ${methods.filter((m) => m !== 'none' && m !== 'MSZIP').join(' and ')}, which isn’t unpacked here`] as [string, string]]
                    : []),
                ...(flags & (PREV | NEXT)
                    ? [
                          [
                              'Set',
                              `number ${number + 1}, set ${setId}${continued ? `; ${plural(continued, 'file')} ${continued === 1 ? 'spans' : 'span'} cabinets, and can’t be taken out of this one alone` : ''}`,
                          ] as [string, string],
                      ]
                    : []),
                ...links,
                ...(signed ? [['Signed', signed] as [string, string]] : []),
            ],
            fields: fillGaps(data, fields, 0, end, 'Not pointed to'),
            preview: {
                kind: 'table',
                columns: [
                    { key: 'name', label: 'Name' },
                    { key: 'size', label: 'Size', numeric: true },
                    { key: 'date', label: 'Date' },
                    { key: 'attributes', label: 'Attributes' },
                    { key: 'folder', label: 'Folder' },
                ],
                groups: ['Files'],
                rows,
            },
            entries,
            end,
            warnings,
        };
    },
};

export default parser;
