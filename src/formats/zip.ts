import { Bytes, bytesLabel, dosDateTime, field, fillGaps, hex } from '../core/bytes';
import { crc32 } from '../core/crc32';
import { explode } from '../core/explode';
import { inflate } from '../core/inflate';
import { Budget, MAX_BYTES, TooBig } from '../core/limits';
import type { Entry, Field, FormatParser, TableRow } from '../core/types';
import { dosText } from './westwood/dune2-text';
import { sniffZip } from './zip-sniff';

/**
 * ZIP archives (PKWARE, 1989): .zip files, and what's built on them: Java's .jar (Internet Explorer 3's classes.zip),
 * Office's .docx, .xlsx and .pptx, OpenDocument, EPUB, Android's .apk. Each file is its own header ("PK", 3, 4: the
 * version needed, flags, how it's compressed, its DOS date and time, CRC-32, sizes packed and unpacked, its name and
 * extra fields), its packed data, and, when the header couldn't know the sizes yet (flag 8), a descriptor after the data
 * with them. Then the central directory: an entry for each file ("PK", 1, 2) with the same and more (the system it was
 * made on, its attributes, a comment, where its header is). Last, the end record ("PK", 5, 6: how many files, where
 * the directory is, the archive's comment). ZIP64 adds a bigger end record and its locator before it, and extra fields
 * holding 64-bit sizes and offsets, for archives over 4 GB or 65,535 files.
 *
 * Programs read a ZIP from its directory, or from the files' own headers in order: an archive whose two disagree shows
 * each something different, which malware has used to get past scanners. So both are read, and compared.
 *
 * Unpacked here: stored (0), Deflate (8) and PKWARE's DCL implode (10). Others, and encrypted files, are listed.
 * See PKWARE's APPNOTE.TXT, version 6.3.10 (https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT), and
 * Info-ZIP's extra fields (its proginfo/extrafld.txt) for the ones it names.
 */

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const END64 = 0x06064b50;
const LOCATOR = 0x07064b50;
const DESCRIPTOR = 0x08074b50;
const MOST_FIELDS = 2000;

const METHODS: Record<number, string> = {
    0: 'stored',
    1: 'shrunk',
    2: 'reduced (1)',
    3: 'reduced (2)',
    4: 'reduced (3)',
    5: 'reduced (4)',
    6: 'imploded',
    8: 'Deflate',
    9: 'Deflate64',
    10: 'PKWARE DCL implode',
    12: 'bzip2',
    14: 'LZMA',
    18: 'IBM TERSE',
    19: 'IBM LZ77',
    93: 'Zstandard',
    94: 'MP3',
    95: 'xz',
    96: 'JPEG',
    97: 'WavPack',
    98: 'PPMd',
    99: 'AES-encrypted',
};
const UNPACKED = new Set([0, 8, 10]);
const HOSTS: Record<number, string> = {
    0: 'MS-DOS or Windows (FAT)',
    1: 'Amiga',
    2: 'OpenVMS',
    3: 'Unix',
    4: 'VM/CMS',
    5: 'Atari ST',
    6: 'OS/2 (HPFS)',
    7: 'Macintosh',
    8: 'Z-System',
    9: 'CP/M',
    10: 'Windows (NTFS)',
    11: 'MVS',
    12: 'VSE',
    13: 'Acorn RISC OS',
    14: 'VFAT',
    15: 'alternate MVS',
    16: 'BeOS',
    17: 'Tandem',
    18: 'OS/400',
    19: 'macOS',
};
const EXTRAS: Record<number, string> = {
    0x0001: 'ZIP64 sizes',
    0x000a: 'NTFS times',
    0x000d: 'Unix',
    0x5455: 'Times (Info-ZIP)',
    0x5855: 'Unix (Info-ZIP, old)',
    0x7855: 'Unix owner (Info-ZIP, old)',
    0x7875: 'Unix owner (Info-ZIP)',
    0x7075: 'Name in UTF-8 (Info-ZIP)',
    0x6375: 'Comment in UTF-8 (Info-ZIP)',
    0x9901: 'AES encryption',
    0xcafe: 'Java archive marker',
    0xd935: 'Android alignment',
};
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** One file, as the directory and its own header say. */
interface Item {
    name: string;
    flags: number;
    method: number;
    date: string;
    crc: number;
    packed: number;
    size: number;
    local: number;
    host: number;
    comment: string;
    /** Its sizes are in a descriptor after its data, and there's no directory to say them: it can't be taken out. */
    unknown?: boolean;
    /** Where its data is and ends (with a descriptor, past that), once its own header is read. */
    dataAt?: number;
    end?: number;
}

const parser: FormatParser = {
    parse(data, context) {
        const b = new Bytes(data);
        const warnings: string[] = [];
        const fields: Field[] = [];
        const u64 = (at: number) => b.u32(at) + b.u32(at + 4) * 2 ** 32;
        const name = (at: number, length: number, utf8: boolean) => {
            const bytes = data.subarray(at, Math.min(data.length, at + length));
            return utf8 ? new TextDecoder().decode(bytes) : dosText(bytes);
        };

        // The end record: the last "PK", 5, 6 whose comment fits in what's left (the comment can be up to 65,535 bytes).
        let endAt = -1;
        for (let at = data.length - 22; at >= Math.max(0, data.length - 22 - 0xffff); at--) {
            if (b.u32(at) === END && at + 22 + b.u16(at + 20) <= data.length) {
                endAt = at;
                break;
            }
        }

        // A ZIP starts with a file's header; one with something in front of it (a self-extractor's program) is read
        // when it's opened as a ZIP, from its end record.
        if (!sniffZip(data) && endAt < 0) throw new Error('This isn’t a ZIP archive: it doesn’t start with a file’s header, and has no end record.');
        const items: Item[] = [];
        let directoryAt = 0;
        let directoryEnd = 0;
        let base = 0;
        let end = data.length;
        let comment = '';
        if (endAt < 0) {
            // No end record: cut short, or never finished. What can be read is the files' own headers, in order.
            warnings.push('It has no end record, so no directory: it’s been cut short, or was never finished. Its files are read from their own headers, in order.');
            for (let at = 0; at + 30 <= data.length && b.u32(at) === LOCAL;) {
                const flags = b.u16(at + 6);
                const n = b.u16(at + 26);
                const item: Item = {
                    name: name(at + 30, n, !!(flags & 0x800)),
                    flags,
                    method: b.u16(at + 8),
                    date: dosDateTime(b.u16(at + 12), b.u16(at + 10)),
                    crc: b.u32(at + 14),
                    packed: b.u32(at + 18),
                    size: b.u32(at + 22),
                    local: at,
                    host: 0,
                    comment: '',
                };
                items.push(item);
                // With a descriptor, the header doesn't know the size: the walk can't go on past it.
                if (flags & 8) {
                    item.unknown = true;
                    break;
                }
                at += 30 + n + b.u16(at + 28) + item.packed;
            }
        } else {
            let count = b.u16(endAt + 10);
            let size = b.u32(endAt + 12);
            let offset = b.u32(endAt + 16);
            const commentLength = b.u16(endAt + 20);
            comment = dosText(data.subarray(endAt + 22, endAt + 22 + commentLength));
            end = endAt + 22 + commentLength;
            const disk = b.u16(endAt + 4);
            if (disk || b.u16(endAt + 6) || b.u16(endAt + 8) !== count)
                warnings.push(`It’s part ${disk + 1} of an archive split across disks: only the files whose data is in this part can be taken out.`);
            const endFields: Field[] = [
                field('Signature', endAt, 4, 'PK 5 6'),
                field('This disk', endAt + 4, 2, disk),
                field('Directory’s disk', endAt + 6, 2, b.u16(endAt + 6)),
                field('Files on this disk', endAt + 8, 2, b.u16(endAt + 8)),
                field('Files', endAt + 10, 2, count),
                field('Directory size', endAt + 12, 4, bytesLabel(size)),
                field('Directory at', endAt + 16, 4, offset),
                field('Comment length', endAt + 20, 2, commentLength),
                ...(commentLength ? [field('Comment', endAt + 22, commentLength, JSON.stringify(comment))] : []),
            ];
            fields.push({ name: 'End record', offset: endAt, length: 22 + commentLength, value: plural(count, 'file'), children: endFields });
            let directoryEnds = endAt;
            // ZIP64: its locator right before the end record, pointing to the bigger end record.
            if (endAt >= 20 && b.u32(endAt - 20) === LOCATOR) {
                const at = u64(endAt - 12);
                fields.push({
                    name: 'ZIP64 locator',
                    offset: endAt - 20,
                    length: 20,
                    children: [
                        field('Signature', endAt - 20, 4, 'PK 6 7'),
                        field('Its disk', endAt - 16, 4, b.u32(endAt - 16)),
                        field('ZIP64 end record at', endAt - 12, 8, at),
                        field('Disks', endAt - 4, 4, b.u32(endAt - 4)),
                    ],
                });
                directoryEnds = endAt - 20;
                // Its offset counts from the archive's start, which may not be the file's.
                const at64 = at + 56 <= data.length && b.u32(at) === END64 ? at : endAt - 20 - 56 >= 0 && b.u32(endAt - 76) === END64 ? endAt - 76 : -1;
                if (at64 < 0) warnings.push('Its ZIP64 locator points to a ZIP64 end record that isn’t there.');
                else {
                    const recordSize = u64(at64 + 4);
                    count = u64(at64 + 32);
                    size = u64(at64 + 40);
                    offset = u64(at64 + 48);
                    const length = Math.min(12 + recordSize, endAt - 20 - at64);
                    fields.push({
                        name: 'ZIP64 end record',
                        offset: at64,
                        length,
                        value: plural(count, 'file'),
                        children: fillGaps(
                            data,
                            [
                                field('Signature', at64, 4, 'PK 6 6'),
                                field('Its size', at64 + 4, 8, bytesLabel(recordSize)),
                                field('Made by', at64 + 12, 2, b.u16(at64 + 12)),
                                field('Version needed', at64 + 14, 2, b.u16(at64 + 14)),
                                field('This disk', at64 + 16, 4, b.u32(at64 + 16)),
                                field('Directory’s disk', at64 + 20, 4, b.u32(at64 + 20)),
                                field('Files on this disk', at64 + 24, 8, u64(at64 + 24)),
                                field('Files', at64 + 32, 8, count),
                                field('Directory size', at64 + 40, 8, bytesLabel(size)),
                                field('Directory at', at64 + 48, 8, offset),
                            ],
                            at64,
                            at64 + length,
                            'Extensible data'
                        ),
                    });
                    directoryEnds = at64;
                }
            }
            // The directory ends where the end records start. If its offset says otherwise, something came before the
            // archive (a self-extracting program), and every offset in it counts from the archive's own start.
            directoryAt = offset;
            if (directoryEnds - size >= 0 && b.u32(directoryEnds - size) === CENTRAL && (offset + 4 > data.length || b.u32(offset) !== CENTRAL)) {
                base = directoryEnds - size - offset;
                directoryAt = directoryEnds - size;
            } else if (count && (offset + 4 > data.length || b.u32(offset) !== CENTRAL)) {
                warnings.push(`Its end record says the directory is at ${offset.toLocaleString('en-US')}, but it isn’t there: its files can’t be found.`);
                count = 0;
            }
            if (count && directoryAt + size !== directoryEnds)
                warnings.push(
                    `Its directory is said to be ${bytesLabel(size)}, but it runs from ${directoryAt.toLocaleString('en-US')} to the end record at ${directoryEnds.toLocaleString('en-US')}.`
                );

            // The directory.
            const listed: Field[] = [];
            let p = directoryAt;
            const stop = Math.min(directoryEnds, data.length);
            for (let i = 0; i < count; i++) {
                if (p + 46 > stop || b.u32(p) !== CENTRAL) {
                    warnings.push(`Its directory ends after ${plural(i, 'file')}, of the ${count.toLocaleString('en-US')} its end record says.`);
                    break;
                }
                const flags = b.u16(p + 8);
                const [n, extraLength, commentLength] = [b.u16(p + 28), b.u16(p + 30), b.u16(p + 32)];
                const item: Item = {
                    name: name(p + 46, n, !!(flags & 0x800)),
                    flags,
                    method: b.u16(p + 10),
                    date: dosDateTime(b.u16(p + 14), b.u16(p + 12)),
                    crc: b.u32(p + 16),
                    packed: b.u32(p + 20),
                    size: b.u32(p + 24),
                    local: b.u32(p + 42),
                    host: data[p + 5],
                    comment: name(p + 46 + n + extraLength, commentLength, !!(flags & 0x800)),
                };
                const extras = readExtras(p + 46 + n, extraLength, item, p + 46);
                items.push(item);
                const length = 46 + n + extraLength + commentLength;
                if (listed.length < MOST_FIELDS)
                    listed.push({
                        name: item.name,
                        offset: p,
                        length,
                        value: `${METHODS[item.method] ?? `method ${item.method}`}, ${bytesLabel(item.size)}`,
                        children: [
                            field('Signature', p, 4, 'PK 1 2'),
                            field('Made by', p + 4, 2, `${HOSTS[item.host] ?? `system ${item.host}`}, ZIP ${Math.floor(data[p + 4] / 10)}.${data[p + 4] % 10}`),
                            field('Version needed', p + 6, 2, `${Math.floor(b.u16(p + 6) / 10)}.${b.u16(p + 6) % 10}`),
                            field('Flags', p + 8, 2, flagText(flags), '1: encrypted; 8: sizes in a descriptor after the data; 0x800: name in UTF-8.'),
                            field('Compression', p + 10, 2, METHODS[item.method] ?? `method ${item.method}`),
                            field('Time', p + 12, 2, item.date.slice(11)),
                            field('Date', p + 14, 2, item.date.slice(0, 10)),
                            field('CRC-32', p + 16, 4, `0x${hex(item.crc)}`, 'Of the file unpacked.'),
                            field('Packed', p + 20, 4, bytesLabel(b.u32(p + 20))),
                            field('Size', p + 24, 4, bytesLabel(b.u32(p + 24))),
                            field('Name length', p + 28, 2, n),
                            field('Extra length', p + 30, 2, extraLength),
                            field('Comment length', p + 32, 2, commentLength),
                            field('Disk', p + 34, 2, b.u16(p + 34)),
                            field('Internal attributes', p + 36, 2, b.u16(p + 36) & 1 ? 'text' : 'binary'),
                            field(
                                'External attributes',
                                p + 38,
                                4,
                                `0x${hex(b.u32(p + 38))}`,
                                item.host === 3 ? 'Unix: the mode in the top 16 bits.' : 'MS-DOS: 1 read-only, 2 hidden, 4 system, 0x10 a folder, 0x20 archive.'
                            ),
                            field('Header at', p + 42, 4, item.local),
                            field('Name', p + 46, n, JSON.stringify(item.name)),
                            ...extras,
                            ...(commentLength ? [field('Comment', p + 46 + n + extraLength, commentLength, JSON.stringify(item.comment))] : []),
                        ],
                    });
                p += length;
            }
            directoryEnd = p;
            if (listed.length)
                fields.push({
                    name: 'Directory',
                    offset: directoryAt,
                    length: p - directoryAt,
                    value: plural(items.length, 'file'),
                    children:
                        items.length > listed.length
                            ? [
                                  ...listed,
                                  field(
                                      'More entries',
                                      listed.at(-1)!.offset + listed.at(-1)!.length,
                                      p - listed.at(-1)!.offset - listed.at(-1)!.length,
                                      `${(items.length - listed.length).toLocaleString('en-US')} more`
                                  ),
                              ]
                            : listed,
                });
        }

        /** The extra fields from `at`, as fields; ZIP64's sizes and Info-ZIP's UTF-8 name taken into `item`. */
        function readExtras(at: number, length: number, item: Item, nameAt: number): Field[] {
            const out: Field[] = [];
            const stop = Math.min(data.length, at + length);
            let p = at;
            while (p + 4 <= stop) {
                const id = b.u16(p);
                const size = Math.min(b.u16(p + 2), stop - p - 4);
                const v = p + 4;
                if (id === 0x0001) {
                    // Only the values the header left at 0xFFFFFFFF are here, in this order.
                    let q = v;
                    for (const key of ['size', 'packed', 'local'] as const)
                        if (item[key] === 0xffffffff && q + 8 <= v + size) {
                            item[key] = u64(q);
                            q += 8;
                        }
                } else if (id === 0x7075 && size >= 5 && data[v] === 1 && b.u32(v + 1) === crc32(data.subarray(nameAt, at))) {
                    item.name = new TextDecoder().decode(data.subarray(v + 5, v + size));
                }
                out.push(field(`Extra: ${EXTRAS[id] ?? `0x${hex(id, 4)}`}`, p, 4 + size, bytesLabel(size)));
                p = v + size;
            }
            if (p < stop) out.push(field('Extra: too short for a field', p, stop - p, bytesLabel(stop - p)));
            return out;
        }

        // Something before the archive only explains a directory that isn't where the end record says if the files'
        // headers are then where it puts them. If they're where the offsets say as they are, the end record is wrong.
        const signature = (at: number) => (at >= 0 && at + 4 <= data.length ? b.u32(at) : -1);
        if (base && items.length && signature(base + items[0].local) !== LOCAL && signature(items[0].local) === LOCAL) {
            warnings.push(`Its end record says the directory is at ${(directoryAt - base).toLocaleString('en-US')}, but it’s at ${directoryAt.toLocaleString('en-US')}.`);
            base = 0;
        }

        // Each file's own header, compared with the directory; then its data, unpacked.
        const entries: Entry[] = [];
        const rows: TableRow[] = [];
        const fileFields: Field[] = [];
        const budget = new Budget('Its files, unpacked');
        let overBudget = false;
        const disagree: string[] = [];
        const counts = { crc: 0, failed: 0, skipped: 0 };
        const seen = new Map<string, number>();
        for (const item of items) {
            const at = base + item.local;
            let note = '';
            if (at + 30 > data.length || b.u32(at) !== LOCAL) {
                warnings.push(`${item.name}’s header isn’t where the directory says (${at.toLocaleString('en-US')}): it can’t be taken out.`);
                rows.push(row(item, 'its header isn’t there'));
                continue;
            }
            const flags = b.u16(at + 6);
            const [n, extraLength] = [b.u16(at + 26), b.u16(at + 28)];
            const own: Item = { ...item, name: name(at + 30, n, !!(flags & 0x800)), flags, method: b.u16(at + 8), crc: b.u32(at + 14), packed: b.u32(at + 18), size: b.u32(at + 22) };
            const extras = readExtras(at + 30 + n, extraLength, own, at + 30);
            // Programs that go by the headers in order see the header's; those that go by the directory, its.
            const differences = [
                own.name !== item.name ? `its name (${JSON.stringify(own.name)})` : '',
                own.method !== item.method ? `how it’s compressed (${METHODS[own.method] ?? own.method})` : '',
                !(flags & 8) && own.crc !== item.crc ? 'its CRC' : '',
                !(flags & 8) && (own.packed !== item.packed || own.size !== item.size) ? `its sizes (${bytesLabel(own.packed)} packed, ${bytesLabel(own.size)})` : '',
            ].filter(Boolean);
            if (differences.length) disagree.push(`${item.name}: its own header gives ${differences.join(', ')}`);
            const dataAt = at + 30 + n + extraLength;
            let dataEnd = dataAt + item.packed;
            const children: Field[] = [
                {
                    name: 'Header',
                    offset: at,
                    length: Math.min(30 + n + extraLength, data.length - at),
                    children: [
                        field('Signature', at, 4, 'PK 3 4'),
                        field('Version needed', at + 4, 2, `${Math.floor(b.u16(at + 4) / 10)}.${b.u16(at + 4) % 10}`),
                        field('Flags', at + 6, 2, flagText(flags)),
                        field('Compression', at + 8, 2, METHODS[own.method] ?? `method ${own.method}`),
                        field('Time', at + 10, 2, dosDateTime(b.u16(at + 12), b.u16(at + 10)).slice(11)),
                        field('Date', at + 12, 2, dosDateTime(b.u16(at + 12), b.u16(at + 10)).slice(0, 10)),
                        field('CRC-32', at + 14, 4, `0x${hex(own.crc)}`, flags & 8 ? 'In the descriptor after the data.' : undefined),
                        field('Packed', at + 18, 4, bytesLabel(b.u32(at + 18))),
                        field('Size', at + 22, 4, bytesLabel(b.u32(at + 22))),
                        field('Name length', at + 26, 2, n),
                        field('Extra length', at + 28, 2, extraLength),
                        field('Name', at + 30, n, JSON.stringify(own.name)),
                        ...extras,
                    ],
                },
            ];
            if (dataEnd > data.length) {
                warnings.push(`${item.name}’s data runs past the end of the file: it’s been cut short.`);
                dataEnd = data.length;
            }
            if (item.packed) children.push(field('Data', dataAt, dataEnd - dataAt, `${bytesLabel(dataEnd - dataAt)}, ${METHODS[item.method] ?? `method ${item.method}`}`));
            // The descriptor, with or without its signature, and 8-byte sizes in ZIP64.
            if (flags & 8 && !item.unknown && dataEnd + 12 <= data.length) {
                const signed = b.u32(dataEnd) === DESCRIPTOR ? 4 : 0;
                const wide = item.packed > 0xffffffff || item.size > 0xffffffff;
                const length = signed + 4 + (wide ? 16 : 8);
                children.push({ name: 'Descriptor', offset: dataEnd, length, value: `CRC 0x${hex(b.u32(dataEnd + signed))}`, note: 'The CRC and sizes, written after the data.' });
                dataEnd += length;
            }
            item.dataAt = dataAt;
            item.end = dataEnd;
            if (fileFields.length < MOST_FIELDS) fileFields.push({ name: item.name, offset: at, length: dataEnd - at, value: bytesLabel(item.size), children });

            // What a careless extractor would do with the name.
            const path = item.name.replace(/\\/g, '/');
            if (/^\/|^[A-Za-z]:|(^|\/)\.\.(\/|$)/.test(path)) {
                note = 'its name climbs out of the folder it’s extracted to';
                warnings.push(`${item.name}: its name climbs out of the folder it’s extracted to: a program extracting it without care would write outside that folder.`);
            }
            seen.set(path.toLowerCase(), (seen.get(path.toLowerCase()) ?? 0) + 1);
            const folder = path.endsWith('/') && !item.size;
            if (folder) {
                rows.push(row(item, 'a folder'));
                continue;
            }
            if (item.flags & 1) {
                rows.push(row(item, 'encrypted: not taken out'));
                continue;
            }
            if (item.unknown) {
                rows.push(row(item, 'its sizes are after its data, and with no directory, where that ends can’t be told'));
                continue;
            }
            if (!UNPACKED.has(item.method)) {
                counts.skipped++;
                rows.push(row(item, `${METHODS[item.method] ?? `method ${item.method}`} isn’t unpacked here`));
                continue;
            }
            if (overBudget) {
                rows.push(row(item, 'past what the app unpacks for one file'));
                continue;
            }
            const packed = data.subarray(dataAt, Math.min(dataAt + item.packed, data.length));
            let out: Uint8Array;
            try {
                budget.take(item.size);
                const limit = Math.min(item.size, MAX_BYTES);
                out = item.method === 0 ? packed : item.method === 8 ? inflate(packed, item.size, limit, { raw: true }) : explode(packed, item.size, limit).data;
            } catch (e) {
                if (e instanceof TooBig && e.message.includes('Its files, unpacked')) {
                    overBudget = true;
                    warnings.push(
                        `Its files would unpack to more than the app allows for one file: ${item.name} and those after it aren’t taken out. Sizes like that mean a damaged archive, or one made to exhaust memory (a zip bomb).`
                    );
                    rows.push(row(item, 'past what the app unpacks for one file'));
                    continue;
                }
                counts.failed++;
                warnings.push(
                    e instanceof TooBig
                        ? `${item.name} unpacks to more than the ${bytesLabel(item.size)} it says: it’s damaged, or made to exhaust memory.`
                        : `${item.name} can’t be unpacked: ${e instanceof Error ? e.message : e}`
                );
                rows.push(row(item, 'can’t be unpacked'));
                continue;
            }
            if (out.length !== item.size) {
                counts.failed++;
                warnings.push(`${item.name} unpacks to ${bytesLabel(out.length)}, not the ${bytesLabel(item.size)} it says.`);
            }
            if (crc32(out) !== item.crc) counts.crc++;
            entries.push({ name: path.replace(/^\/+/, ''), label: path, offset: at, size: out.length, data: out, meta: { Date: item.date } });
            rows.push(row(item, note));
        }
        if (disagree.length)
            warnings.push(
                `${plural(disagree.length, 'file')}’ own headers disagree with the directory, so programs that read one or the other see different files: ${disagree.slice(0, 3).join('; ')}${disagree.length > 3 ? `; and ${disagree.length - 3} more` : ''}.`
            );
        if (counts.crc)
            warnings.push(`${plural(counts.crc, 'file')} ${counts.crc === 1 ? 'doesn’t' : 'don’t'} match ${counts.crc === 1 ? 'its' : 'their'} CRC: damaged, or changed after the archive was made.`);
        const twice = [...seen].filter(([, k]) => k > 1);
        if (twice.length)
            warnings.push(
                `${plural(twice.length, 'name')} ${twice.length === 1 ? 'is' : 'are'} in it more than once (${twice
                    .slice(0, 3)
                    .map(([nm]) => nm)
                    .join(', ')}): which one a program takes out differs.`
            );

        // Files sharing their data: a zip bomb's trick, or damage.
        const spans = items.filter((x) => x.end !== undefined).sort((x, y) => x.local - y.local);
        let overlaps = 0;
        for (let i = 1; i < spans.length; i++) if (base + spans[i].local < spans[i - 1].end!) overlaps++;
        if (overlaps) warnings.push(`${plural(overlaps, 'file')} ${overlaps === 1 ? 'overlaps' : 'overlap'} the one before: they share data, as a zip bomb’s do, or the archive is damaged.`);

        // Files' headers the directory doesn't list: what a program going by the directory never shows.
        const filesEnd = endAt < 0 ? (spans.at(-1)?.end ?? data.length) : directoryAt;
        const hidden: string[] = [];
        let covered = base;
        const claimed = new Set(spans.map((x) => base + x.local));
        for (const s of [...spans, null]) {
            const to = s ? base + s.local : filesEnd;
            for (let at = covered; at + 30 <= to; at++) {
                if (b.u32(at) !== LOCAL || claimed.has(at)) continue;
                const n = b.u16(at + 26);
                if (at + 30 + n > to) continue;
                hidden.push(name(at + 30, n, !!(b.u16(at + 6) & 0x800)));
            }
            if (s) covered = Math.max(covered, s.end!);
        }
        if (hidden.length && endAt >= 0)
            warnings.push(
                `${plural(hidden.length, 'file')} ${hidden.length === 1 ? 'is' : 'are'} in it that the directory doesn’t list, which programs going by the directory never show: ${hidden
                    .slice(0, 5)
                    .map((h) => JSON.stringify(h))
                    .join(', ')}.`
            );

        if (!sniffZip(data) && !items.length) throw new Error('This isn’t a ZIP archive: it has what looks like an end record, but no files where it says.');
        if (fileFields.length) fields.push(...fileFields);
        // Bytes before its first file (or its directory, when it has no files): a self-extractor's program, or worse.
        const first = Math.min(spans.length ? base + spans[0].local : Infinity, endAt >= 0 ? directoryAt : Infinity);
        if (Number.isFinite(first) && first > 0)
            fields.push(
                field(
                    'Before the archive',
                    0,
                    first,
                    bytesLabel(first),
                    base ? 'Its offsets count from after this: a self-extracting archive’s program, or something put in front.' : 'Its offsets count from the file’s start, this included.'
                )
            );

        const kind = items.some((x) => x.name === 'META-INF/MANIFEST.MF')
            ? 'Java archive (.jar)'
            : items.some((x) => x.name === '[Content_Types].xml')
              ? 'Office document (Office Open XML)'
              : items[0]?.name === 'mimetype'
                ? `OpenDocument or EPUB (${new TextDecoder().decode(entries.find((e) => e.name === 'mimetype')?.data.subarray(0, 80) ?? new Uint8Array(0)) || 'its type unread'})`
                : items.some((x) => x.name === 'AndroidManifest.xml')
                  ? 'Android app (.apk)'
                  : '';
        const methods = [...new Set(items.map((x) => METHODS[x.method] ?? `method ${x.method}`))];
        const hosts = [...new Set(items.map((x) => HOSTS[x.host] ?? `system ${x.host}`))];
        const stem = (context.name ?? context.label ?? 'archive').replace(/^.*[\\/]/, '');
        return {
            title: 'ZIP archive',
            summary: [
                ...(kind ? [['Kind', kind] as [string, string]] : []),
                ['Files', `${items.filter((x) => !x.name.endsWith('/')).length.toLocaleString('en-US')}, ${bytesLabel(items.reduce((n, x) => n + x.size, 0))} unpacked`],
                ['Compression', methods.join(', ') || 'none'],
                ...(endAt >= 0 && items.length ? [['Made on', hosts.join(', ')] as [string, string]] : []),
                ...(counts.skipped
                    ? [['Not unpacked', `${plural(counts.skipped, 'file')}, in ${methods.filter((m) => !['stored', 'Deflate', 'PKWARE DCL implode'].includes(m)).join(' and ')}`] as [string, string]]
                    : []),
                ...(base > 0 ? [['Before it', `${bytesLabel(base)}: ${stem} is a self-extracting archive, or has something in front`] as [string, string]] : []),
                ...(comment ? [['Comment', comment] as [string, string]] : []),
            ],
            fields: fillGaps(data, fields, 0, end, 'Not pointed to'),
            preview: {
                kind: 'table',
                columns: [
                    { key: 'name', label: 'Name' },
                    { key: 'size', label: 'Size', numeric: true },
                    { key: 'packed', label: 'Packed', numeric: true },
                    { key: 'method', label: 'Compression' },
                    { key: 'date', label: 'Date' },
                    { key: 'note', label: 'Note' },
                ],
                groups: ['Files'],
                rows,
            },
            entries,
            end: Math.max(end, directoryEnd),
            warnings,
        };
    },
};

function flagText(flags: number): string {
    return (
        [flags & 1 ? 'encrypted' : '', flags & 8 ? 'sizes after the data' : '', flags & 0x40 ? 'strong encryption' : '', flags & 0x800 ? 'UTF-8 name' : '', flags & 0x2000 ? 'directory encrypted' : '']
            .filter(Boolean)
            .join(', ') || 'none'
    );
}

function row(item: Item, note: string): TableRow {
    return {
        group: 'Files',
        cells: {
            name: item.name,
            size: item.size.toLocaleString('en-US'),
            packed: item.packed.toLocaleString('en-US'),
            method: METHODS[item.method] ?? `method ${item.method}`,
            date: item.date,
            note,
        },
    };
}

export default parser;
