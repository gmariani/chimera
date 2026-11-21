import { Bytes, bytesLabel, dosDateTime, field, fillGaps } from '../../core/bytes';
import type { Entry, Field, FormatParser, TableRow } from '../../core/types';
import { runProgram, type ProgramRun } from './program';
import { sniffRtPatch } from './sniff';

/**
 * RTPatch patches (.rtp, Pocket Soft, 1991 on): the update Counterstrike's installer applies to Red Alert, and many
 * games' patches after it. A header ("K*", a version, flags, default options, the size of its largest file), perhaps a
 * list of folders, then a record for each file it adds, deletes or changes, and an end record. Each record is a word (its
 * kind in the top 4 bits, flags below), 10 bytes not yet understood (zero in every patch seen), counts of the old and new
 * versions of the file, then a 34-byte entry for each: its 8.3 name, attributes, size, DOS date and time, its size mod 31
 * and mod 30, and two rolling checksums of its bytes. A file added is carried whole; a file changed, as a program that
 * makes the new file from the old (see program.ts). Either can be compressed, with RTPatch's own adaptive Huffman and
 * LZSS, which isn't unpacked here.
 *
 * Pocket Soft never published it. This follows rtptool's SPEC.md and SPEC-0x0320.md (Sandy Carter, and kr4uzi's fork,
 * 2026, MIT: https://github.com/bwrsandman/rtptool, https://github.com/kr4uzi/rtptool), checked against Counterstrike's
 * CSTRIKE.RTP, which is format 0x012C: its record kinds are numbered as the fork found them in 3.20 (2 adds, 3 deletes,
 * 4 changes), it has no filename after the record word though bit 2 is set, and its programs and files are stored as
 * they are. Later patches (3.00 on: Battlefield 2's) are laid out differently, and only their header is read.
 */

interface Version {
    name: string;
    attributes: number;
    size: number;
    date: string;
    /** The two rolling checksums, 31 and 30 bits. */
    sums: [number, number];
}

interface FileRecord {
    kind: 'add' | 'delete' | 'change';
    name: string;
    old: Version[];
    new: Version[];
    /** What it carries: a file, or a program; stored as it is, or compressed. */
    payload?: { at: number; stored: number; unpacked: number };
    run?: ProgramRun;
    /** The new file, made here. */
    made?: Uint8Array;
    /** Why a changed file wasn't made from one that's open, in words. */
    note?: string;
}

const KINDS: Record<number, string> = { 1: 'End', 2: 'Add a file', 3: 'Delete a file', 4: 'Change a file', 5: 'History of a file (later versions)' };
const ATTRIBUTES = ['read-only', 'hidden', 'system', 'volume', 'folder', 'archive'];

const attributesOf = (a: number) => ATTRIBUTES.filter((_, i) => a & (1 << i)).join(', ') || 'none';
const n = (v: number) => v.toLocaleString('en-US');

/**
 * RTPatch's checksum of a file: from 0, for each byte, XOR it in and rotate the whole left by 8, within `bits` bits.
 * As rtptool's SPEC.md gives it.
 */
export function rtChecksum(data: Uint8Array, bits: 30 | 31): number {
    const mask = 2 ** bits - 1;
    const high = 2 ** (bits - 8);
    let w = 0;
    for (const c of data) {
        const x = (w ^ c) & mask;
        w = ((x % high) * 256 + Math.floor(x / high)) & mask;
    }
    return w >>> 0;
}

const parser: FormatParser = {
    parse(data, context) {
        if (!sniffRtPatch(data)) throw new Error('This isn’t an RTPatch patch: it doesn’t start with "K*", a version and a header that fits.');
        const b = new Bytes(data);
        const warnings: string[] = [];
        const fields: Field[] = [];
        const version = b.u16(2);
        const flags = b.u16(4);
        const head: Field[] = [
            field('Signature', 0, 2, '"K*"'),
            field('Version', 2, 2, `0x${version.toString(16).padStart(4, '0').toUpperCase()}`),
            field('Flags', 4, 2, `0x${flags.toString(16).padStart(4, '0').toUpperCase()}`, '0x8000: more flags follow; 0x0200: a list of folders follows the header.'),
        ];
        let p = 6;
        let extra = 0;
        if (flags & 0x8000) {
            extra = b.u32(p);
            head.push(field('More flags', p, 4, `0x${extra.toString(16).padStart(8, '0').toUpperCase()}`, '0x10000: its entries carry more (later versions).'));
            p += 4;
        }
        const later = version >= 0x0300;
        if (later || extra & 0x10000) {
            fields.push({ name: 'Header', offset: 0, length: p, children: head });
            warnings.push(
                `It’s RTPatch’s format 0x${version.toString(16).toUpperCase()}${later ? '' : ' with longer entries'}, laid out differently from the patches this reader was made from: only its header is read.`
            );
            return {
                title: 'RTPatch patch',
                summary: [['Version', `0x${version.toString(16).toUpperCase()}, not read past its header`]],
                fields: fillGaps(data, fields, 0, data.length, 'Not read'),
                warnings,
            };
        }
        const options = b.u16(p);
        const largest = b.u32(p + 2);
        head.push(
            field('Options', p, 2, `0x${options.toString(16).padStart(4, '0').toUpperCase()}`, 'The options of a record that doesn’t give its own.'),
            field('Largest file', p + 2, 4, bytesLabel(largest), 'In Counterstrike’s patch, the size of the biggest file it holds or makes.'),
            field('Not known', p + 6, 4, b.u32(p + 6)),
            field('Attributes', p + 10, 2, attributesOf(b.u16(p + 10)), 'For a record that doesn’t give its own.'),
            field('Reserved', p + 12, 2, b.u16(p + 12))
        );
        p += 14;
        const command = b.u16(p);
        head.push(field('Command flags', p, 2, `0x${command.toString(16).padStart(4, '0').toUpperCase()}`, '4: a long follows.'));
        p += 2;
        if (command & 4) {
            head.push(field('Combine', p, 4, b.u32(p)));
            p += 4;
        }
        head.push(field('Reserved', p, 4, b.u32(p)));
        p += 4;
        fields.push({ name: 'Header', offset: 0, length: p, children: head });

        /** A string: its length (0xFF: a 2-byte length follows), the NUL at its end counted. */
        const string = (at: number): { text: string; next: number } | null => {
            let len = data[at];
            let q = at + 1;
            if (len === 0xff) {
                len = b.u16(q);
                q += 2;
            }
            if (q + len > data.length) return null;
            return { text: new TextDecoder('windows-1252').decode(data.subarray(q, q + Math.max(0, len - 1))), next: q + len };
        };
        /** A number: a lead byte (its top bit the sign, then a 1 for each byte after it), then the low bytes. */
        const vli = (at: number): { value: number; next: number } => {
            const lead = data[at] ?? 0;
            let count = 0;
            for (let mask = 0x40; mask && lead & mask; mask >>= 1) count++;
            let value = lead & ((0x40 >> count) - 1);
            let low = 0;
            for (let i = 0, scale = 1; i < count; i++, scale *= 256) low += (data[at + 1 + i] ?? 0) * scale;
            value = value * 256 ** count + low;
            return { value: lead & 0x80 ? -value : value, next: at + 1 + count };
        };

        if (flags & 0x0200) {
            const count = b.u16(p);
            const children: Field[] = [field('Folders', p, 2, count)];
            let q = p + 2;
            for (let i = 0; i < count; i++) {
                const s = string(q);
                if (!s) {
                    warnings.push(`Its list of ${n(count)} folders runs past the end of the file.`);
                    q = data.length;
                    break;
                }
                children.push(field(`Folder ${i}`, q, s.next - q, JSON.stringify(s.text)));
                q = s.next;
            }
            fields.push({ name: 'Folders', offset: p, length: q - p, value: `${n(count)}`, children });
            p = q;
        }

        /** A 34-byte entry: a version of a file. */
        const entryAt = (at: number, what: string): { v: Version; field: Field } => {
            const name = new TextDecoder('windows-1252').decode(data.subarray(at, at + 13)).replace(/\0.*$/s, '');
            const size = b.u32(at + 16);
            const v: Version = { name, attributes: b.u16(at + 14), size, date: dosDateTime(b.u16(at + 20), b.u16(at + 22)), sums: [b.u32(at + 26) & 0x7fffffff, b.u32(at + 30) & 0x3fffffff] };
            if (data[at + 24] !== size % 31 || data[at + 25] !== size % 30) warnings.push(`The entry for ${what} ${name} says it’s ${bytesLabel(size)}, but its check bytes are for another size.`);
            return {
                v,
                field: {
                    name: `${what[0].toUpperCase()}${what.slice(1)} ${name}`,
                    offset: at,
                    length: 34,
                    value: `${bytesLabel(size)}, ${v.date}`,
                    children: [
                        field('Name', at, 13, JSON.stringify(name)),
                        field('Not known', at + 13, 1, data[at + 13]),
                        field('Attributes', at + 14, 2, attributesOf(v.attributes)),
                        field('Size', at + 16, 4, bytesLabel(size)),
                        field('Date', at + 20, 4, v.date),
                        field('Size mod 31 and 30', at + 24, 2, `${data[at + 24]}, ${data[at + 25]}`, 'A quick check of the size.'),
                        field(
                            'Checksums',
                            at + 26,
                            8,
                            `0x${v.sums[0].toString(16).toUpperCase()}, 0x${v.sums[1].toString(16).toUpperCase()}`,
                            'Each byte XORed in and the whole rotated left by 8, in 31 bits and in 30.'
                        ),
                    ],
                },
            };
        };

        /** What's wrong with a record's sizes, and its file made or its program checked. */
        const check = (r: FileRecord) => {
            const want = r.new[0];
            if (r.kind === 'add' && r.payload && want) {
                if (r.payload.unpacked !== want.size) warnings.push(`It says ${r.name} is ${bytesLabel(want.size)}, but holds ${bytesLabel(r.payload.unpacked)} of it.`);
                else if (r.payload.stored === r.payload.unpacked) {
                    r.made = data.subarray(r.payload.at, r.payload.at + r.payload.stored);
                    if (rtChecksum(r.made, 31) !== want.sums[0] || rtChecksum(r.made, 30) !== want.sums[1])
                        warnings.push(`${r.name}, which it adds, doesn’t match the checksums it gives for it: it’s been changed since the patch was made, or damaged.`);
                }
            }
            if (r.kind !== 'change' || !r.payload || r.payload.stored !== r.payload.unpacked) return;
            const old = r.old[0];
            if (!old || !want) {
                warnings.push(`It changes ${r.name || 'a file'} without saying what it was or what it becomes.`);
                return;
            }
            const program = data.subarray(r.payload.at, r.payload.at + r.payload.stored);
            r.run = runProgram(program, old.size, want.size, r.old.length, null);
            if (r.run.problem) {
                warnings.push(`The changes to ${r.name} can’t be followed: ${r.run.problem}.`);
                return;
            }
            // The old file, when one's open: the one of its size and checksums.
            const open = context.find?.(old.name) ?? [];
            const match = open.find((c) => c.data.length === old.size && rtChecksum(c.data, 31) === old.sums[0] && rtChecksum(c.data, 30) === old.sums[1]);
            if (!match) {
                if (open.length) r.note = `the ${old.name} that’s open isn’t the version it changes`;
                return;
            }
            const made = runProgram(program, old.size, want.size, r.old.length, match.data);
            if (made.problem || !made.output) {
                r.note = `it couldn’t be made from the ${old.name} that’s open: ${made.problem}`;
                return;
            }
            if (rtChecksum(made.output, 31) !== want.sums[0] || rtChecksum(made.output, 30) !== want.sums[1]) {
                warnings.push(`${r.name}, made from the one that’s open (${match.source}), doesn’t match the checksums the patch gives for it.`);
                return;
            }
            r.made = made.output;
            r.note = `made from ${match.source}`;
        };

        const records: FileRecord[] = [];
        let end = -1;
        while (p + 2 <= data.length) {
            const at = p;
            const word = b.u16(p);
            const type = word >> 12;
            if (type === 1) {
                fields.push(field('End', p, 2, '0x1000'));
                end = p + 2;
                break;
            }
            if (type < 2 || type > 4) {
                warnings.push(`It has a record of a kind this reader doesn’t know (${type}${KINDS[type] ? `: ${KINDS[type].toLowerCase()}` : ''}) at ${n(p)}: what’s after it isn’t read.`);
                break;
            }
            const children: Field[] = [field('Kind and flags', p, 2, `0x${word.toString(16).padStart(4, '0').toUpperCase()}: ${KINDS[type].toLowerCase()}`)];
            p += 2;
            // As rtptool reads them; none of them are in Counterstrike's patch. Its bit 2 brings no name, whatever rtptool says.
            let recordOptions = options;
            if (word & 0x0002) {
                recordOptions = b.u16(p);
                children.push(field('Options', p, 2, `0x${recordOptions.toString(16).padStart(4, '0').toUpperCase()}`));
                p += 2;
            }
            if (recordOptions & 0x00c0) {
                const v = vli(p);
                children.push(field('Seek', p, v.next - p, v.value));
                p = v.next;
            }
            if (word & 0x0080) {
                const v = vli(p);
                children.push(field('Disk', p, v.next - p, v.value));
                p = v.next;
            }
            if (word & 0x0100) {
                children.push(field('Attributes', p, 2, attributesOf(b.u16(p))));
                p += 2;
            }
            if (word & 0x0200) {
                for (const which of ['Old path', 'New path']) {
                    const s = string(p);
                    if (!s) break;
                    children.push(field(which, p, s.next - p, JSON.stringify(s.text)));
                    p = s.next;
                }
            }
            children.push(field('Not known', p, 10, [...data.subarray(p, p + 10)].every((v) => !v) ? 'zeros' : 'not zeros'));
            p += 10;

            const record: FileRecord = { kind: type === 2 ? 'add' : type === 3 ? 'delete' : 'change', name: '', old: [], new: [] };
            if (type === 4) {
                const modFlags = b.u16(p);
                children.push(
                    field(
                        'Change flags',
                        p,
                        2,
                        `0x${modFlags.toString(16).padStart(4, '0').toUpperCase()}`,
                        'Not yet understood: 9 or 0xD in Counterstrike’s patch (0xD where the old file is read-only).'
                    )
                );
                p += 2;
            }
            const counts: [number, number] = [0, 0];
            for (const [i, what] of [
                [0, 'Old versions'],
                [1, 'New versions'],
            ] as const) {
                if ((type === 2 && i === 0) || (type === 3 && i === 1)) continue;
                const v = vli(p);
                counts[i] = v.value;
                children.push(field(what, p, v.next - p, v.value));
                p = v.next;
            }
            if (type !== 3) {
                record.payload = { at: 0, unpacked: b.u32(p), stored: b.u32(p + 4) };
                children.push(field(type === 2 ? 'File size' : 'Program size', p, 4, bytesLabel(record.payload.unpacked)), field('Stored size', p + 4, 4, bytesLabel(record.payload.stored)));
                p += 8;
            }
            if (counts.some((c) => c < 0 || c * 34 > data.length - p)) {
                warnings.push(`A record at ${n(at)} says it has ${n(Math.max(...counts))} versions of its file, more than fit in what’s left: what’s after it isn’t read.`);
                break;
            }
            for (const [i, what] of [
                [0, 'old'],
                [1, 'new'],
            ] as const)
                for (let k = 0; k < counts[i]; k++) {
                    const e = entryAt(p, what);
                    (i ? record.new : record.old).push(e.v);
                    children.push(e.field);
                    p += 34;
                }
            record.name = (record.new[0] ?? record.old[0])?.name ?? '';
            if (record.payload) {
                const { stored, unpacked } = record.payload;
                if (stored > data.length - p) {
                    warnings.push(`What it holds for ${record.name || 'a file'} (${bytesLabel(stored)}) runs past the end of the patch: it’s been cut short.`);
                    children.push(field('Cut short', p, data.length - p, bytesLabel(data.length - p)));
                    p = data.length;
                    fields.push({ name: `${KINDS[type]}: ${record.name}`, offset: at, length: p - at, children });
                    records.push(record);
                    break;
                }
                record.payload.at = p;
                const packed = stored !== unpacked;
                children.push(field(type === 2 ? 'The file' : 'Its program', p, stored, packed ? `compressed, ${bytesLabel(unpacked)} unpacked: not unpacked here` : 'stored as it is'));
                p += stored;
            }
            fields.push({ name: `${KINDS[type]}: ${record.name}`, offset: at, length: p - at, children });
            records.push(record);
            check(record);
        }
        if (end < 0 && !warnings.some((w) => w.includes('isn’t read') || w.includes('cut short'))) warnings.push('It has no end record: it’s been cut short.');

        // What it does, file by file.
        const rows: TableRow[] = records.map((r) => {
            const o = r.old[0];
            const w = r.new[0];
            let holds = '';
            if (r.kind === 'delete') holds = 'nothing: the file goes';
            else if (r.payload && r.payload.stored !== r.payload.unpacked) holds = `${r.kind === 'add' ? 'the file' : 'its program'}, compressed: not unpacked here`;
            else if (r.kind === 'add') holds = 'the whole file';
            else if (r.run && !r.run.problem)
                holds = `keeps ${bytesLabel(r.run.kept)} of the old file, adds ${bytesLabel(r.run.added)}${r.run.filled ? `, fills ${bytesLabel(r.run.filled)}` : ''}${r.run.pokes ? `, changes ${n(r.run.pokes)} numbers in place` : ''}`;
            else holds = 'a program that can’t be followed';
            return {
                group: r.kind === 'add' ? 'Added' : r.kind === 'delete' ? 'Deleted' : 'Changed',
                cells: {
                    file: r.name,
                    old: o ? `${bytesLabel(o.size)}, ${o.date}` : '',
                    new: w ? `${bytesLabel(w.size)}, ${w.date}` : '',
                    holds: r.note ? `${holds} (${r.note})` : holds,
                },
            };
        });

        const entries: Entry[] = records.flatMap((r) =>
            r.made
                ? [
                      {
                          name: r.name,
                          label: r.name,
                          offset: r.kind === 'add' ? r.payload!.at : 0,
                          size: r.made.length,
                          data: r.made,
                          meta: { Type: r.kind === 'add' ? 'Added by the patch' : `Changed by the patch, ${r.note}` },
                      },
                  ]
                : []
        );
        const count = (kind: FileRecord['kind']) => records.filter((r) => r.kind === kind).length;
        const packed = records.filter((r) => r.payload && r.payload.stored !== r.payload.unpacked).length;
        const dates = records.flatMap((r) => r.new.map((v) => v.date)).sort();
        const changed = records.filter((r) => r.kind === 'change');
        const made = changed.filter((r) => r.made).length;
        return {
            title: 'RTPatch patch',
            summary: [
                ['Version', `0x${version.toString(16).toUpperCase()}`],
                ['Files', `${n(records.length)}: ${n(count('add'))} added, ${n(count('change'))} changed, ${n(count('delete'))} deleted`],
                ...(dates.length ? [['Newest file', dates[dates.length - 1]] as [string, string]] : []),
                ['Largest file', bytesLabel(largest)],
                ['Stored', packed ? `${n(packed)} of its files and programs compressed: not unpacked here` : 'as it is, nothing compressed'],
                ...(changed.length
                    ? [
                          [
                              'Changed files made',
                              made
                                  ? `${n(made)} of ${n(changed.length)}, from the old ones that are open`
                                  : `none: open the old ${changed.length === 1 ? 'file' : 'files'} beside it to make ${changed.length === 1 ? 'it' : 'them'}`,
                          ] as [string, string],
                      ]
                    : []),
            ],
            fields: fillGaps(data, fields, 0, end < 0 ? p : end, 'Not read'),
            preview: {
                kind: 'table',
                columns: [
                    { key: 'file', label: 'File' },
                    { key: 'old', label: 'Before' },
                    { key: 'new', label: 'After' },
                    { key: 'holds', label: 'What the patch holds' },
                ],
                groups: [...new Set(rows.map((r) => r.group))],
                rows,
            },
            entries,
            end: end < 0 ? undefined : end,
            warnings,
        };
    },
};

export default parser;
