import { bytesLabel, field, hex } from '../../core/bytes';
import type { Entry, Field, FormatParser } from '../../core/types';
import { minOf } from '../../core/math';

/**
 * Petroglyph's MEG archives (Star Wars: Empire at War, Grey Goo, the Command
 * & Conquer Remastered Collection): a header, a table of file names (each a
 * 16-bit length and the characters), then a 20-byte record for each file,
 * sorted by the CRC-32 of its upper-case name. Three versions:
 *
 * - 1 (Empire at War): just the name and file counts.
 * - 2 (Forces of Corruption): FF FF FF FF, a version float (0.99), the data offset, then the counts.
 * - 3 (Grey Goo, the Remaster): the same, plus the name table's size; each record starts with
 *   flags (1: encrypted) and has a 16-bit name index. A signature of 0x8FFFFFFF means the
 *   tables themselves are encrypted (AES), which isn't read here.
 */

/** The 0.99 every version 2 and 3 header has, as a float's bits. */
const VERSION_FLOAT = 0x3f7d70a4;

interface Layout {
    version: 1 | 2 | 3;
    header: number;
    names: number;
    files: number;
    dataStart?: number;
    namesSize?: number;
}

/** Works out the version from the header (2 and 3 look alike up to the name table's size). */
function layout(data: Uint8Array, view: DataView): Layout {
    const u32 = (at: number) => view.getUint32(at, true);
    const sig = u32(0);
    if ((sig === 0xffffffff || sig === 0x8fffffff) && u32(4) === VERSION_FLOAT) {
        if (sig === 0x8fffffff) throw new Error("This MEG's tables are encrypted, which isn't read here.");
        // Version 3 gives the name table's size: the names from byte 24 must fill exactly that.
        const [names, size] = [u32(12), u32(20)];
        let at = 24;
        for (let i = 0; i < names && at + 2 <= data.length; i++) at += 2 + view.getUint16(at, true);
        if (at - 24 === size) return { version: 3, header: 24, names, files: u32(16), dataStart: u32(8), namesSize: size };
        return { version: 2, header: 20, names: u32(12), files: u32(16), dataStart: u32(8) };
    }
    return { version: 1, header: 8, names: u32(0), files: u32(4) };
}

const parser: FormatParser = {
    parse(data) {
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const u16 = (at: number) => view.getUint16(at, true);
        const u32 = (at: number) => view.getUint32(at, true);
        const l = layout(data, view);
        const warnings: string[] = [];
        if (l.names > 1_000_000 || l.files > 1_000_000) throw new Error('The name or file count is far too big for a MEG.');

        const headerFields: Field[] = [];
        if (l.version > 1)
            headerFields.push(
                field('Signature', 0, 4, 'FF FF FF FF'),
                field('Version', 4, 4, '0.99 (as a float)', 'The same in versions 2 and 3.'),
                field('Data start', 8, 4, l.dataStart!, "Where the first file's data is.")
            );
        const counts = l.version === 1 ? 0 : 12;
        headerFields.push(field('Name count', counts, 4, l.names), field('File count', counts + 4, 4, l.files));
        if (l.version === 3) headerFields.push(field('Name table size', 20, 4, bytesLabel(l.namesSize!)));

        // The names.
        const names: string[] = [];
        const nameFields: Field[] = [];
        let at = l.header;
        for (let i = 0; i < l.names; i++) {
            const length = u16(at);
            const name = new TextDecoder('latin1').decode(data.subarray(at + 2, at + 2 + length));
            names.push(name);
            if (nameFields.length < 5000)
                nameFields.push({ name: `${i}`, offset: at, length: 2 + length, value: name, children: [field('Length', at, 2, length), field('Name', at + 2, length, name)] });
            at += 2 + length;
        }
        const namesEnd = at;

        // The file records.
        const entries: Entry[] = [];
        const recordFields: Field[] = [];
        let encrypted = 0;
        for (let i = 0; i < l.files; i++) {
            const r = namesEnd + i * 20;
            if (r + 20 > data.length) {
                warnings.push('The file records run past the end of the file.');
                break;
            }
            const [flags, crc, index, size, start, nameIndex] =
                l.version === 3 ? [u16(r), u32(r + 2), u32(r + 6), u32(r + 10), u32(r + 14), u16(r + 18)] : [0, u32(r), u32(r + 4), u32(r + 8), u32(r + 12), u32(r + 16)];
            const path = names[nameIndex] ?? `file ${i}`;
            if (flags & 1) encrypted++;
            const children: Field[] =
                l.version === 3
                    ? [
                          field('Flags', r, 2, flags & 1 ? '1 (encrypted)' : flags),
                          field('CRC', r + 2, 4, hex(crc), 'CRC-32 of the upper-case name: the records are sorted by it, to find a file fast.'),
                          field('Index', r + 6, 4, index),
                          field('Size', r + 10, 4, bytesLabel(size)),
                          field('Start', r + 14, 4, start),
                          field('Name index', r + 18, 2, nameIndex),
                      ]
                    : [
                          field('CRC', r, 4, hex(crc), 'CRC-32 of the upper-case name: the records are sorted by it, to find a file fast.'),
                          field('Index', r + 4, 4, index),
                          field('Size', r + 8, 4, bytesLabel(size)),
                          field('Start', r + 12, 4, start),
                          field('Name index', r + 16, 4, nameIndex),
                      ];
            if (recordFields.length < 5000) recordFields.push({ name: path.split('\\').pop()!, offset: r, length: 20, value: bytesLabel(size), children });
            if (start + size > data.length) {
                warnings.push(`${path} runs past the end of the archive.`);
                continue;
            }
            const slash = path.lastIndexOf('\\');
            entries.push({
                name: path.slice(slash + 1),
                label: path.slice(slash + 1),
                offset: start,
                size,
                data: data.subarray(start, start + size),
                meta: { Folder: slash >= 0 ? path.slice(0, slash) : '', ...(flags & 1 ? { Note: 'Encrypted' } : {}) },
            });
        }
        if (encrypted) warnings.push(`${encrypted} file${encrypted === 1 ? ' is' : 's are'} encrypted, and won't open as what they are.`);
        if (names.length > 5000 || l.files > 5000) warnings.push('The first 5,000 names and records are listed.');

        const recordsEnd = namesEnd + l.files * 20;
        const dataStart = entries.length ? minOf(entries.map((e) => e.offset)) : recordsEnd;
        const total = entries.reduce((n, e) => n + e.size, 0);
        const folders = new Set(entries.map((e) => e.meta!.Folder));
        return {
            title: `Petroglyph MEG archive (version ${l.version})`,
            summary: [
                ['Version', String(l.version)],
                ['Files', String(entries.length)],
                ['Folders', String(folders.size)],
                ['Data', bytesLabel(total)],
            ],
            fields: [
                { name: 'Header', offset: 0, length: l.header, children: headerFields },
                { name: 'File names', offset: l.header, length: namesEnd - l.header, value: `${names.length} names`, children: nameFields },
                { name: 'File records', offset: namesEnd, length: l.files * 20, value: `${l.files} records`, children: recordFields },
                ...(dataStart > recordsEnd ? [field('Padding', recordsEnd, dataStart - recordsEnd)] : []),
                field('File data', dataStart, data.length - dataStart, bytesLabel(data.length - dataStart)),
            ],
            entries,
            warnings,
        };
    },
};

export default parser;
