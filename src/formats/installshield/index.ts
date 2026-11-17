import { bytesLabel, field } from '../../core/bytes';
import { explode } from '../../core/explode';
import { Budget, checkCount } from '../../core/limits';
import type { Entry, Field, FormatParser } from '../../core/types';
import { sniffInstallShieldZ } from './sniff';

/**
 * InstallShield 3's archives (.z, and _SETUP.LIB, which holds the installer's own files): what Windows 3.1 and 95
 * installers of 1994 to 1997 unpacked. Red Alert's Counterstrike ships Windows themes in THEMES.Z, and Westwood Chat
 * and its other extras in more. A 59-byte header, zeros to byte 255, each file's data, packed with PKWARE's implode
 * (see core/explode.ts) unless a flag says it's stored, then a table of directories (each a count of its files, the
 * entry's size and a name with a 16-bit length) and a table of files (each its directory, sizes, where it is, its date
 * and attributes, and a name with an 8-bit length), listed directory by directory.
 *
 * InstallShield never published the format. This follows unshieldv3 (Wolfgang Frisch, from Veit Kannegieser's "stix"):
 * https://github.com/wfr/unshieldv3. What it leaves unnamed is read from Counterstrike's nine archives: the files'
 * data always starts at the byte the header gives at 0x21 (255), and the 32 bits after a file's date are 0x20 or 0,
 * as DOS's file attributes are.
 */

const HEADER = 59;
const DIRECTORY = 6;
const FILE = 30;
/** Flag: stored as it is, not packed. */
const STORED = 0x10;

/** A DOS date (low 16 bits) and time (high 16), as InstallShield stores them. */
function dosDate(v: number): string {
    const [d, t] = [v & 0xffff, v >>> 16];
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${1980 + (d >> 9)}-${pad((d >> 5) & 15)}-${pad(d & 31)} ${pad(t >> 11)}:${pad((t >> 5) & 63)}:${pad((t & 31) * 2)}`;
}

/** DOS's file attributes, in words. */
function attributes(v: number): string {
    const names = [
        [1, 'read-only'],
        [2, 'hidden'],
        [4, 'system'],
        [0x20, 'archive'],
    ] as const;
    const set = names.filter(([bit]) => v & bit).map(([, name]) => name);
    const other = v & ~0x27;
    return [...set, ...(other ? [`0x${other.toString(16)}`] : [])].join(', ') || 'none';
}

interface Listed {
    name: string;
    path: string;
    directory: number;
    size: number;
    packed: number;
    at: number;
    flags: number;
    split: number;
    entry: number;
}

const parser: FormatParser = {
    parse(data) {
        if (!sniffInstallShieldZ(data)) throw new Error("This isn't an InstallShield 3 archive: it doesn't start with 13 5D 65 8C 3A 01 02 00.");
        if (data.length < HEADER) throw new Error(`This InstallShield 3 archive is cut short: it's ${bytesLabel(data.length)}, too short for its ${HEADER}-byte header.`);
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const u8 = (at: number) => data[at];
        const u16 = (at: number) => view.getUint16(at, true);
        const u32 = (at: number) => view.getUint32(at, true);
        const latin1 = (at: number, length: number) => new TextDecoder('latin1').decode(data.subarray(at, at + length));
        const warnings: string[] = [];

        const spans = u16(10);
        const fileCount = u16(12);
        const date = u32(14);
        const archiveSize = u32(18);
        const unpackedSize = u32(22);
        const [disks, disk] = [u8(30), u8(31)];
        const dataStart = u32(33);
        const [dirsAt, dirsSize, dirCount, filesAt, filesSize] = [u32(41), u32(45), u16(49), u32(51), u32(55)];

        if (archiveSize !== data.length) warnings.push(`The header says the archive is ${bytesLabel(archiveSize)}, but it's ${bytesLabel(data.length)}.`);
        if (dirsAt < HEADER || dirsAt + dirsSize > data.length)
            throw new Error(`The directory table is said to be at ${dirsAt.toLocaleString('en-US')}, ${bytesLabel(dirsSize)} long, which isn't inside the archive (${bytesLabel(data.length)}).`);
        if (filesAt < HEADER || filesAt + filesSize > data.length)
            throw new Error(`The file table is said to be at ${filesAt.toLocaleString('en-US')}, ${bytesLabel(filesSize)} long, which isn't inside the archive (${bytesLabel(data.length)}).`);
        checkCount(dirCount, DIRECTORY, dirsSize, 'Directories');
        checkCount(fileCount, FILE + 1, filesSize, 'Files');

        const header: Field = {
            name: 'Header',
            offset: 0,
            length: HEADER,
            value: `${fileCount.toLocaleString('en-US')} file${fileCount === 1 ? '' : 's'}`,
            children: [
                field('Signature', 0, 4, '13 5D 65 8C'),
                field('Signature', 4, 4, '3A 01 02 00', 'The same in every InstallShield 3 archive.'),
                field('Not known', 8, 2, u16(8)),
                field('Spans disks', 10, 2, spans, spans ? 'This archive is one of a set, one a disk.' : 'No: it’s whole.'),
                field('Files', 12, 2, fileCount),
                field('Made', 14, 4, dosDate(date)),
                field('Archive size', 18, 4, bytesLabel(archiveSize)),
                field('Unpacked size', 22, 4, bytesLabel(unpackedSize), 'All its files, unpacked.'),
                field('Not known', 26, 4, u32(26)),
                field('Disks', 30, 1, disks, 'In a set, on the first disk only.'),
                field('Disk', 31, 1, disk, 'Which of the set this is, from 1.'),
                field('Not known', 32, 1, u8(32)),
                field('Data starts', 33, 4, dataStart, 'Where the first file’s data is.'),
                field('Split file ends', 37, 4, u32(37), 'In a set, where a file carried over from the disk before ends.'),
                field('Directory table at', 41, 4, dirsAt),
                field('Directory table size', 45, 4, bytesLabel(dirsSize)),
                field('Directories', 49, 2, dirCount),
                field('File table at', 51, 4, filesAt),
                field('File table size', 55, 4, bytesLabel(filesSize)),
            ],
        };
        const fields: Field[] = [header];

        // The directories.
        const dirs: { name: string; files: number }[] = [];
        const dirFields: Field[] = [];
        let at = dirsAt;
        const dirsEnd = dirsAt + dirsSize;
        for (let i = 0; i < dirCount; i++) {
            if (at + DIRECTORY > dirsEnd) {
                warnings.push(`The directory table ends after ${i} of its ${dirCount} directories.`);
                break;
            }
            const [files, size, length] = [u16(at), u16(at + 2), u16(at + 4)];
            if (size < DIRECTORY + length || at + size > dirsEnd) {
                warnings.push(
                    `Directory ${i + 1}'s entry is said to be ${size} bytes, which ${size < DIRECTORY + length ? `doesn't hold its ${length}-character name` : 'runs past the end of the table'}.`
                );
                break;
            }
            const name = latin1(at + 6, length);
            dirs.push({ name, files });
            dirFields.push({
                name: name || '(top)',
                offset: at,
                length: size,
                value: `${files} file${files === 1 ? '' : 's'}`,
                children: [
                    field('Files', at, 2, files),
                    field('Entry size', at + 2, 2, size),
                    field('Name length', at + 4, 2, length),
                    ...(length ? [field('Name', at + 6, length, name || '(none)', name ? undefined : 'Empty: the files go where the installer is told.')] : []),
                    ...(size > DIRECTORY + length ? [field('Not known', at + 6 + length, size - DIRECTORY - length, bytesLabel(size - DIRECTORY - length), 'Zeros in every archive seen.')] : []),
                ],
            });
            at += size;
        }
        fields.push({ name: 'Directory table', offset: dirsAt, length: dirsSize, value: `${dirs.length} director${dirs.length === 1 ? 'y' : 'ies'}`, children: dirFields });
        if (at < dirsEnd) warnings.push(`The directory table has ${bytesLabel(dirsEnd - at)} after its last directory.`);
        if (filesAt !== dirsEnd) warnings.push(`The file table is said to be at ${filesAt.toLocaleString('en-US')}, but the directory table ends at ${dirsEnd.toLocaleString('en-US')}.`);
        const listedCount = dirs.reduce((n, d) => n + d.files, 0);
        if (listedCount !== fileCount)
            warnings.push(`The directories list ${listedCount.toLocaleString('en-US')} files between them, but the header says there are ${fileCount.toLocaleString('en-US')}.`);

        // The files, directory by directory.
        const listed: Listed[] = [];
        const fileFields: Field[] = [];
        const filesEnd = filesAt + filesSize;
        const dirOf = dirs.flatMap((d, i) => Array<number>(d.files).fill(i));
        at = filesAt;
        for (let i = 0; i < fileCount; i++) {
            if (at + FILE > filesEnd) {
                warnings.push(`The file table ends after ${i} of its ${fileCount} files.`);
                break;
            }
            const directory = u16(at + 1);
            const [size, packed, offset, when, attrs, entry] = [u32(at + 3), u32(at + 7), u32(at + 11), u32(at + 15), u32(at + 19), u16(at + 23)];
            const [flags, split, firstDisk, lastDisk, length] = [u8(at + 25), u8(at + 26), u8(at + 28), u8(at), u8(at + 29)];
            if (entry < FILE + length || at + entry > filesEnd) {
                warnings.push(`File ${i + 1}'s entry is said to be ${entry} bytes, which ${entry < FILE + length ? `doesn't hold its ${length}-character name` : 'runs past the end of the table'}.`);
                break;
            }
            const name = latin1(at + FILE, length);
            const folder = dirs[directory]?.name;
            const path = folder ? `${folder}\\${name}` : name;
            if (directory >= dirs.length) warnings.push(`${name} is said to be in directory ${directory}, but there are only ${dirs.length}.`);
            else if (dirOf[i] !== undefined && dirOf[i] !== directory)
                warnings.push(`${name} is listed with directory ${dirOf[i]} ("${dirs[dirOf[i]].name}"), but says it's in directory ${directory}.`);
            if (/[\\/]|^\.\.?$/.test(name) || !name)
                warnings.push(`File ${i + 1}'s name, "${name}", ${name ? 'isn’t a plain file name: saved as it says, it could land outside the folder it’s saved to' : 'is empty'}.`);
            listed.push({ name, path, directory, size, packed, at: offset, flags, split, entry: i });
            if (fileFields.length < 5000)
                fileFields.push({
                    name: path,
                    offset: at,
                    length: entry,
                    value: bytesLabel(size),
                    children: [
                        field('Last disk', at, 1, lastDisk),
                        field('Directory', at + 1, 2, directory, folder === undefined ? undefined : folder || '(the top)'),
                        field('Size', at + 3, 4, bytesLabel(size), 'Unpacked.'),
                        field('Packed size', at + 7, 4, bytesLabel(packed)),
                        field('At', at + 11, 4, offset),
                        field('Date', at + 15, 4, dosDate(when)),
                        field('Attributes', at + 19, 4, attributes(attrs), 'As DOS keeps them.'),
                        field('Entry size', at + 23, 2, entry),
                        field('Flags', at + 25, 1, `0x${flags.toString(16).padStart(2, '0')}`, flags & STORED ? 'Stored as it is (0x10), not packed.' : 'Packed with implode.'),
                        field('Split', at + 26, 1, split, split ? 'It carries on into the next disk’s archive.' : 'No: it’s whole here.'),
                        field('Not known', at + 27, 1, u8(at + 27)),
                        field('First disk', at + 28, 1, firstDisk),
                        field('Name length', at + 29, 1, length),
                        ...(length ? [field('Name', at + FILE, length, name)] : []),
                        ...(entry > FILE + length
                            ? [field('Not known', at + FILE + length, entry - FILE - length, bytesLabel(entry - FILE - length), 'Zeros, or numbers that may be a program’s version.')]
                            : []),
                    ],
                });
            at += entry;
        }
        fields.push({ name: 'File table', offset: filesAt, length: filesSize, value: `${listed.length.toLocaleString('en-US')} file${listed.length === 1 ? '' : 's'}`, children: fileFields });
        if (at < filesEnd) warnings.push(`The file table has ${bytesLabel(filesEnd - at)} after its last file.`);
        if (fileFields.length < listed.length) warnings.push('The first 5,000 files are listed in the structure.');

        // Each file's data: unpacked, and where it lies, to find overlaps and bytes nothing points to.
        const entries: Entry[] = [];
        const budget = new Budget('The unpacked files');
        let unpackedTotal = 0;
        for (const f of listed) {
            const meta: Record<string, string> = { Folder: dirs[f.directory]?.name ?? '', Packed: bytesLabel(f.packed) };
            if (f.at + f.packed > data.length) {
                warnings.push(`${f.path} is said to be at ${f.at.toLocaleString('en-US')}, ${bytesLabel(f.packed)} long, past the end of the archive.`);
                continue;
            }
            const packed = data.subarray(f.at, f.at + f.packed);
            unpackedTotal += f.size;
            let unpacked: Uint8Array | null = null;
            if (f.split) warnings.push(`${f.path} carries on into the next disk's archive, which isn't read with this one: it's offered packed, as it is here.`);
            else if (f.flags & STORED) {
                unpacked = packed;
                if (f.packed !== f.size) warnings.push(`${f.path} is stored as it is, but its sizes differ: ${bytesLabel(f.packed)} here, ${bytesLabel(f.size)} unpacked.`);
            } else {
                try {
                    const r = explode(packed, f.size);
                    budget.take(r.data.length);
                    unpacked = r.data;
                    if (r.data.length !== f.size) warnings.push(`${f.path} unpacks to ${bytesLabel(r.data.length)}, but its entry says ${bytesLabel(f.size)}.`);
                    if (r.used < f.packed) warnings.push(`${f.path}'s packed data ends ${bytesLabel(f.packed - r.used)} before the space its entry gives it.`);
                } catch (e) {
                    if (e instanceof Error && e.name === 'TooBig') throw e;
                    warnings.push(`${f.path} can't be unpacked: ${e instanceof Error ? e.message : e} It's offered packed, as it is here.`);
                }
            }
            entries.push({
                name: unpacked ? f.name : `${f.name}.packed`,
                label: unpacked ? f.name : `${f.name} (packed)`,
                offset: f.at,
                // What it is once taken out; Packed says what it takes here.
                size: (unpacked ?? packed).length,
                data: unpacked ?? packed,
                meta: unpacked ? meta : { ...meta, Note: 'Not unpacked' },
            });
        }
        if (unpackedTotal !== unpackedSize && listed.length === fileCount)
            warnings.push(`The header says the files come to ${bytesLabel(unpackedSize)} unpacked, but their entries add up to ${bytesLabel(unpackedTotal)}.`);

        // The header's padding, the files' data in order, and the gaps between.
        const spansData = listed.filter((f) => f.at + f.packed <= data.length).sort((a, b) => a.at - b.at);
        const dataFields: Field[] = [];
        const dataFrom = Math.max(HEADER, Math.min(spansData[0]?.at ?? dirsAt, dirsAt));
        let stray = 0;
        const gap = (from: number, to: number, what: string) => {
            if (to <= from) return;
            const zeros = data.subarray(from, to).every((v) => v === 0);
            if (!zeros) stray += to - from;
            (from < dataFrom ? fields : dataFields).push(field(zeros ? 'Padding' : 'Not pointed to', from, to - from, bytesLabel(to - from), zeros ? what : undefined));
        };
        gap(HEADER, dataFrom, 'Zeros, to where the files’ data starts.');
        if (spansData.length && spansData[0].at !== dataStart)
            warnings.push(`The header says the files' data starts at ${dataStart.toLocaleString('en-US')}, but the first file is at ${spansData[0].at.toLocaleString('en-US')}.`);
        let covered = dataFrom;
        for (const f of spansData) {
            if (f.at < covered) warnings.push(`${f.path}'s data overlaps the file before it.`);
            else gap(covered, f.at, 'Zeros between files.');
            if (f.at >= HEADER) dataFields.push(field(f.path, f.at, f.packed, bytesLabel(f.packed), f.flags & STORED ? 'Stored as it is.' : `Packed; ${bytesLabel(f.size)} unpacked.`));
            else warnings.push(`${f.path}'s data is said to start at ${f.at}, inside the header.`);
            covered = Math.max(covered, f.at + f.packed);
        }
        if (covered > dirsAt) warnings.push('The files’ data runs into the directory table.');
        else gap(covered, dirsAt, 'Zeros before the directory table.');
        if (stray) warnings.push(`${bytesLabel(stray)} between the files aren't part of any of them.`);
        if (dataFields.length)
            fields.push({
                name: 'File data',
                offset: dataFrom,
                length: Math.min(covered, dirsAt) - dataFrom,
                value: bytesLabel(Math.min(covered, dirsAt) - dataFrom),
                children: dataFields.slice(0, 5000),
            });
        fields.sort((a, b) => a.offset - b.offset);

        const end = Math.max(dirsEnd, filesEnd);
        return {
            title: 'InstallShield 3 archive',
            summary: [
                [
                    'Files',
                    `${entries.length.toLocaleString('en-US')}${
                        dirs.some((d) => d.name)
                            ? ` in ${dirs
                                  .filter((d) => d.name)
                                  .map((d) => d.name)
                                  .join(', ')}`
                            : ''
                    }`,
                ],
                ['Size', `${bytesLabel(unpackedTotal)} unpacked, ${bytesLabel(data.length)} packed`],
                ['Made', dosDate(date)],
                ...(spans ? [['Disk', `${disk}${disks ? ` of ${disks}` : ''}`] as [string, string]] : []),
            ],
            fields,
            entries,
            end,
            warnings,
        };
    },
};

export default parser;
