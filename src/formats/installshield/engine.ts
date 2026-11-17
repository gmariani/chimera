import { bytesLabel, field } from '../../core/bytes';
import { explode } from '../../core/explode';
import { Budget, checkCount } from '../../core/limits';
import type { Entry, Field, FormatParser } from '../../core/types';
import { ENGINE_HEADER, sniffInstallShieldEngine } from './sniff';

/**
 * InstallShield 3's own files (_INST32I.EX_ for 32-bit Windows, _INST16.EX_ for 16-bit): the setup engine, which
 * SETUP.EXE unpacks into a temporary folder and runs to read SETUP.INS and install from the .z archives. Counterstrike
 * has four, in each of its Windows installers: INSTALL.EXE (the engine), LZWSERV.EXE, BOOT16.EXE or BOOT32.EXE, and
 * WUTL95i.DLL in the 32-bit ones.
 *
 * InstallShield never published the format. This follows Deark's reader (Jason Summers,
 * https://github.com/jsummers/deark/blob/master/modules/installshld.c) and the Just Solve the File Format Problem wiki
 * (http://justsolve.archiveteam.org/wiki/InstallShield_installer_archive): the signature, Stirling Technologies'
 * copyright, how many files there are, then an entry for each (where its data is, its sizes packed and unpacked, 8
 * bytes, and two names), then each file's data, packed with PKWARE's implode (core/explode.ts). What Deark leaves
 * unnamed is read from Counterstrike's four: the 8 bytes are zeros, the files' data follows the entries, file after
 * file to the end, and the second name is the one setup gives the file in its temporary folder (_INS0432._MP for
 * INSTALL.EXE, the 0432 its version).
 */

/** The bytes in a file's entry around its two names: where, packed size, size, 8 not known, and the names' lengths. */
const ENTRY = 24;
const COPYRIGHT = 70;

interface Listed {
    name: string;
    alias: string;
    at: number;
    packed: number;
    size: number;
}

const parser: FormatParser = {
    parse(data) {
        if (!sniffInstallShieldEngine(data)) throw new Error("This isn't InstallShield 3's setup files: it doesn't start with 2A AB 79 D8 00 01.");
        if (data.length < ENGINE_HEADER) throw new Error(`This InstallShield 3 setup file is cut short: it's ${bytesLabel(data.length)}, too short for its ${ENGINE_HEADER}-byte header.`);
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const u16 = (at: number) => view.getUint16(at, true);
        const u32 = (at: number) => view.getUint32(at, true);
        const latin1 = (at: number, length: number) => new TextDecoder('latin1').decode(data.subarray(at, at + length));
        const warnings: string[] = [];

        const count = checkCount(u16(78), ENTRY, data.length - ENGINE_HEADER, 'Files');
        const copyright = latin1(8, COPYRIGHT).replace(/\0+$/, '');
        const fields: Field[] = [
            {
                name: 'Header',
                offset: 0,
                length: ENGINE_HEADER,
                value: `${count} file${count === 1 ? '' : 's'}`,
                children: [
                    field('Signature', 0, 4, '2A AB 79 D8'),
                    field('Not known', 4, 4, Array.from(data.subarray(4, 8), (v) => v.toString(16).padStart(2, '0')).join(' '), '00 01 00 00 in every one seen.'),
                    field('Copyright', 8, COPYRIGHT, copyright, 'Stirling Technologies made InstallShield; the text is cut off where the room for it ends.'),
                    field('Files', 78, 2, count),
                    field('Not known', 80, 2, u16(80), '0 in every one seen.'),
                ],
            },
        ];

        // The entries.
        const listed: Listed[] = [];
        const entryFields: Field[] = [];
        let at = ENGINE_HEADER;
        const name = (from: number) => (from + 2 <= data.length && from + 2 + u16(from) <= data.length ? latin1(from + 2, u16(from)) : null);
        for (let i = 0; i < count; i++) {
            const first = at + 22 <= data.length ? name(at + 20) : null;
            const second = first === null ? null : name(at + 22 + first.length);
            if (first === null || second === null) {
                warnings.push(`The entries end after ${i} of the ${count} files: file ${i + 1}'s runs past the end of the file.`);
                break;
            }
            const [where, packed, size] = [u32(at), u32(at + 4), u32(at + 8)];
            const length = ENTRY + first.length + second.length;
            listed.push({ name: first, alias: second, at: where, packed, size });
            for (const n of [first, second])
                if (/[\\/:]|^\.\.?$/.test(n) || !n)
                    warnings.push(`File ${i + 1}'s name "${n}" ${n ? 'isn’t a plain file name: saved as it says, it could land outside the folder it’s saved to' : 'is empty'}.`);
            const blank = data.subarray(at + 12, at + 20).every((v) => v === 0);
            entryFields.push({
                name: first || '(no name)',
                offset: at,
                length,
                value: bytesLabel(size),
                children: [
                    field('Data at', at, 4, where.toLocaleString('en-US')),
                    field('Packed size', at + 4, 4, bytesLabel(packed)),
                    field('Size', at + 8, 4, bytesLabel(size), 'Unpacked.'),
                    field('Not known', at + 12, 8, blank ? 'zeros' : Array.from(data.subarray(at + 12, at + 20), (v) => v.toString(16).padStart(2, '0')).join(' '), 'Zeros in every one seen.'),
                    field('Name length', at + 20, 2, first.length),
                    ...(first ? [field('Name', at + 22, first.length, first)] : []),
                    field('Second name length', at + 22 + first.length, 2, second.length),
                    ...(second ? [field('Second name', at + 24 + first.length, second.length, second, 'What setup names it in its temporary folder.')] : []),
                ],
            });
            at += length;
        }
        const entriesEnd = at;
        fields.push({ name: 'Entries', offset: ENGINE_HEADER, length: entriesEnd - ENGINE_HEADER, value: `${listed.length} file${listed.length === 1 ? '' : 's'}`, children: entryFields });

        // Each file's data, unpacked.
        const entries: Entry[] = [];
        const budget = new Budget('The unpacked files');
        const inside = listed.filter((f) => {
            if (f.at < entriesEnd || f.at + f.packed > data.length) {
                warnings.push(
                    `${f.name}'s data is said to be at ${f.at.toLocaleString('en-US')}, ${bytesLabel(f.packed)} long, which is ${f.at < entriesEnd ? 'inside the entries' : 'past the end of the file'}.`
                );
                return false;
            }
            return true;
        });
        for (const f of inside) {
            const packed = data.subarray(f.at, f.at + f.packed);
            let unpacked: Uint8Array | null = null;
            try {
                const r = explode(packed, f.size);
                budget.take(r.data.length);
                unpacked = r.data;
                if (r.data.length !== f.size) warnings.push(`${f.name} unpacks to ${bytesLabel(r.data.length)}, but its entry says ${bytesLabel(f.size)}.`);
                if (r.used < f.packed) warnings.push(`${f.name}'s packed data ends ${bytesLabel(f.packed - r.used)} before the space its entry gives it.`);
            } catch (e) {
                if (e instanceof Error && e.name === 'TooBig') throw e;
                warnings.push(`${f.name} can't be unpacked: ${e instanceof Error ? e.message : e} It's offered packed, as it is here.`);
            }
            const meta: Record<string, string> = { 'Unpacked as': f.alias, Packed: bytesLabel(f.packed) };
            entries.push({
                name: unpacked ? f.name : `${f.name}.packed`,
                label: unpacked ? f.name : `${f.name} (packed)`,
                offset: f.at,
                size: (unpacked ?? packed).length,
                data: unpacked ?? packed,
                meta: unpacked ? meta : { ...meta, Note: 'Not unpacked' },
            });
        }

        // The data in order, and the bytes between that no file takes.
        const dataFields: Field[] = [];
        let covered = entriesEnd;
        let stray = 0;
        for (const f of [...inside].sort((a, b) => a.at - b.at)) {
            if (f.at < covered) warnings.push(`${f.name}'s data overlaps the data before it.`);
            else if (f.at > covered) {
                stray += f.at - covered;
                dataFields.push(field('Not pointed to', covered, f.at - covered, bytesLabel(f.at - covered)));
            }
            dataFields.push(field(f.name, f.at, f.packed, bytesLabel(f.packed), `Packed; ${bytesLabel(f.size)} unpacked.`));
            covered = Math.max(covered, f.at + f.packed);
        }
        if (stray) warnings.push(`${bytesLabel(stray)} between the files' data aren't part of any of them.`);
        if (dataFields.length) fields.push({ name: 'File data', offset: entriesEnd, length: covered - entriesEnd, value: bytesLabel(covered - entriesEnd), children: dataFields });

        const total = listed.reduce((n, f) => n + f.size, 0);
        return {
            title: 'InstallShield 3 setup files',
            summary: [
                ['Files', listed.map((f) => f.name).join(', ') || 'none'],
                ['Size', `${bytesLabel(total)} unpacked, ${bytesLabel(data.length)} packed`],
                ['Copyright', copyright],
            ],
            fields,
            entries,
            end: covered,
            warnings,
        };
    },
};

export default parser;
