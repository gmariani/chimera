import { Bytes, bytesLabel, field, hex } from '../core/bytes';
import { checkCount } from '../core/limits';
import type { Entry, Field, FormatParser, TableRow } from '../core/types';
import { mzLayout } from './mz-sniff';

/**
 * DOS programs (.EXE), "MZ" after their first two bytes: what DOS games such
 * as Dune II run as. A header, then the program's image, which DOS copies into
 * memory as it is:
 *
 * - The header says how long the image is (in 512-byte pages), how much more
 *   memory the program needs beyond it, where it starts running (CS:IP) and
 *   where its stack is (SS:SP), all counting from where it's loaded.
 * - The relocations: each place in the image that holds a segment, which DOS
 *   adds the load segment to, since a program doesn't know where it'll be.
 * - Linkers and packers leave their mark after the fields: Borland's TLINK,
 *   LZEXE and PKLITE are known here.
 *
 * DOS loads nothing past the image. A program can read what's there itself:
 * Borland's overlay manager (VROOMM, "FBOV") keeps code there that it loads
 * when it's called, so a program bigger than DOS's memory still runs (Dune II
 * does). Its stand-ins in the image, the stubs, say where each piece is. TLINK
 * writes a table of every segment for it, which says what each is.
 *
 * The header follows Microsoft's MS-DOS Programmer's Reference (and Ralf
 * Brown's notes on INT 21h function 4Bh). The overlays follow Borland's
 * run-time library (SE.ASM), as LoadBorlandOverlays.java reads them:
 * https://github.com/GeReV/ghidra_scripts/blob/main/LoadBorlandOverlays.java.
 * Nothing here runs the code.
 */

const seg = (v: number) => `0x${hex(v, 4)}`;
const at = (s: number, o: number) => `${hex(s, 4)}:${hex(o, 4)}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** TLINK's segment flags. */
const CODE = 1;
const OVERLAID = 2;
const DATA = 4;
const kindOf = (flags: number) => (flags & OVERLAID ? 'Overlay stub' : flags & CODE ? 'Code' : flags & DATA ? 'Data' : 'Unmarked');

interface Overlay {
    n: number;
    segment: number;
    stubAt: number;
    codeAt: number;
    code: number;
    fixups: number;
    entries: number;
}

/** What made it, from the bytes after the header's fields: a linker's or a packer's mark. */
function maker(data: Uint8Array, room: number): { name: string; packed: boolean; length: number; note: string } | null {
    const b = new Bytes(data);
    if (room >= 0x22 && data[0x1e] === 0xfb && b.ascii(0x20, 2) === 'jr')
        return { name: `Borland TLINK ${data[0x1f] >> 4}.${data[0x1f] & 15}`, packed: false, length: 6, note: 'Borland’s linker marks what it links: 0xFB, its version, "jr".' };
    if (room >= 0x20 && (b.ascii(0x1c, 4) === 'LZ09' || b.ascii(0x1c, 4) === 'LZ91')) return { name: `LZEXE 0.${b.ascii(0x1e, 2)}`, packed: true, length: 4, note: 'Fabrice Bellard’s packer.' };
    if (room >= 0x24 && b.ascii(0x1e, 6) === 'PKLITE') {
        let end = 0x1e;
        while (end < room && data[end] >= 0x20 && data[end] < 0x7f) end++;
        return { name: `PKLITE ${data[0x1d] & 15}.${data[0x1c].toString().padStart(2, '0')}`, packed: true, length: end - 0x1c, note: 'PKWARE’s packer: its version, then its copyright.' };
    }
    return null;
}

const parser: FormatParser = {
    parse(data, context) {
        const layout = mzLayout(data);
        if (typeof layout === 'string') throw new Error(`This isn't a DOS program. ${layout}`);
        const { signature, headerSize, imageEnd, relocations, relocationsAt } = layout;
        const b = new Bytes(data);
        const warnings: string[] = [];
        const lastPage = b.u16(2);
        const pages = b.u16(4);
        const minAlloc = b.u16(0x0a);
        const maxAlloc = b.u16(0x0c);
        const [ss, sp, checksum, ip, cs, overlayNumber] = [0x0e, 0x10, 0x12, 0x14, 0x16, 0x1a].map((o) => b.u16(o));
        const loaded = Math.min(imageEnd, data.length);
        const imageSize = imageEnd - headerSize;

        if (lastPage > 511) warnings.push(`The last page is said to hold ${lastPage} bytes, more than a page's 512.`);
        if (imageEnd > data.length)
            warnings.push(
                `The header says the program runs to ${imageEnd.toLocaleString('en-US')}, but the file ends at ${data.length.toLocaleString('en-US')}: the last ${bytesLabel(imageEnd - data.length)} would be whatever was in memory.`
            );
        if (minAlloc > maxAlloc && maxAlloc) warnings.push(`It asks for at least ${bytesLabel(minAlloc * 16)} more memory, but at most ${bytesLabel(maxAlloc * 16)}.`);
        const entry = cs * 16 + ip;
        const stackTop = ss * 16 + (sp || 0x10000);
        if (entry >= imageSize)
            warnings.push(
                `It starts running at ${at(cs, ip)}, ${entry.toLocaleString('en-US')} bytes in, past the end of its image (${bytesLabel(imageSize)}): it would run whatever is in memory there.`
            );

        // The checksum: the words of the file add up to 0xFFFF with it, when it's set. Nothing checks it.
        let sum = 0;
        if (checksum) for (let i = 0; i < data.length; i += 2) sum = (sum + data[i] + (data[i + 1] ?? 0) * 256) & 0xffff;

        // The relocations: an offset, then a segment, each counting from the start of the image.
        const outside: number[] = [];
        const runs: { from: number; count: number; segment: number }[] = [];
        for (let i = 0; i < relocations; i++) {
            const o = relocationsAt + i * 4;
            const s = b.u16(o + 2);
            if (s * 16 + b.u16(o) + 2 > imageSize) outside.push(i);
            if (runs.length && runs[runs.length - 1].segment === s) runs[runs.length - 1].count++;
            else runs.push({ from: o, count: 1, segment: s });
        }
        if (outside.length)
            warnings.push(
                `${outside.length === 1 ? `Relocation ${outside[0] + 1} points` : `${outside.length.toLocaleString('en-US')} relocations point`} past the end of the program's image: DOS would change memory beyond it.`
            );
        if (relocations && relocationsAt + relocations * 4 > headerSize) warnings.push(`The relocations run past the header, into the program's image: DOS would load them as part of the program.`);

        // Header fields, then what's between them and the image: a maker's mark, the relocations, padding.
        const made = maker(data, Math.min(headerSize, relocations ? relocationsAt : headerSize));
        const fields: Field[] = [
            {
                name: 'Header',
                offset: 0,
                length: 28,
                value: `"${signature}"`,
                note: `The fields DOS reads. The whole header, relocations and all, is ${bytesLabel(headerSize)}.`,
                children: [
                    field('Signature', 0, 2, `"${signature}"`, signature === 'ZM' ? 'Reversed: early DOS took either.' : undefined),
                    field('Bytes in the last page', 2, 2, lastPage, lastPage ? undefined : '0: the last page is full.'),
                    field('Pages', 4, 2, pages, `Of 512 bytes, counting the header: ${bytesLabel(imageEnd)} in all.`),
                    field('Relocations', 6, 2, relocations),
                    field('Header size', 8, 2, `${b.u16(8)} paragraphs`, `In 16-byte steps: ${bytesLabel(headerSize)}.`),
                    field(
                        'Least extra memory',
                        0x0a,
                        2,
                        `${minAlloc} paragraphs`,
                        minAlloc ? `${bytesLabel(minAlloc * 16)} after the image, which it can’t run without.` : 'It needs none beyond its image.'
                    ),
                    field(
                        'Most extra memory',
                        0x0c,
                        2,
                        maxAlloc === 0xffff ? 'All there is' : `${maxAlloc} paragraphs`,
                        maxAlloc === 0xffff ? '0xFFFF: as much as DOS has.' : bytesLabel(maxAlloc * 16)
                    ),
                    field('Stack segment (SS)', 0x0e, 2, seg(ss), 'From the start of the image.'),
                    field(
                        'Stack pointer (SP)',
                        0x10,
                        2,
                        seg(sp),
                        stackTop > imageSize ? `The stack’s top is ${bytesLabel(stackTop - imageSize)} past the image, in the memory DOS adds.` : 'The stack’s top is inside the image.'
                    ),
                    field(
                        'Checksum',
                        0x12,
                        2,
                        checksum ? seg(checksum) : 'Not set',
                        checksum ? (sum === 0xffff ? 'Matches: the file’s words add up to 0xFFFF.' : 'Doesn’t match the file, which nothing checks.') : undefined
                    ),
                    field('Instruction pointer (IP)', 0x14, 2, seg(ip)),
                    field('Code segment (CS)', 0x16, 2, seg(cs), `Where it starts running, from the start of the image: ${at(cs, ip)}.`),
                    field('Relocations at', 0x18, 2, relocationsAt),
                    field('Overlay number', 0x1a, 2, overlayNumber, overlayNumber ? 'Not 0: an overlay for another program, not a program of its own.' : '0: the program itself.'),
                ],
            },
        ];
        if (made) fields.push(field(made.packed ? 'Packer’s mark' : 'Linker’s mark', 0x1c, made.length, made.name, made.note));
        if (relocations)
            fields.push({
                name: 'Relocations',
                offset: relocationsAt,
                length: relocations * 4,
                value: plural(relocations, 'place'),
                note: 'Each an offset, then a segment: a word in the image that DOS adds the load segment to.',
                children: runs.map((r) => field(`In segment ${seg(r.segment)}`, r.from, r.count * 4, plural(r.count, 'place'))),
            });
        // A newer header's offset, where a plain DOS program's relocations don't cover it.
        const lfanew = b.u32(0x3c);
        if (headerSize >= 0x40 && (!relocations || relocationsAt >= 0x40) && lfanew && !(made && 0x1c + made.length > 0x3c))
            fields.push(field('Newer header at', 0x3c, 4, lfanew, 'Where a Windows or OS/2 program’s own header would be. There’s none there: this one is for DOS alone.'));
        // The rest of the header: zeros, or bytes that nothing points to (DOS doesn't load them).
        const headerFields = fields.slice().sort((x, y) => x.offset - y.offset);
        const header: Field[] = [];
        let covered = 0;
        const gap = (from: number, to: number) => {
            if (to <= from) return;
            const zeros = data.subarray(from, to).every((v) => v === 0);
            header.push(field(zeros ? 'Padding' : 'Unused', from, to - from, bytesLabel(to - from), zeros ? 'Zeros, to the end of the header.' : 'Nothing points here, and DOS doesn’t load it.'));
        };
        for (const f of headerFields) {
            gap(covered, Math.min(f.offset, headerSize));
            header.push(f);
            covered = Math.max(covered, f.offset + f.length);
        }
        gap(covered, headerSize);

        // TLINK's table of segments, and the overlays, when Borland's overlay manager keeps code after the image.
        const fbov = imageEnd + 16 <= data.length && b.ascii(imageEnd, 4) === 'FBOV' ? imageEnd : -1;
        const overlays: Overlay[] = [];
        const segments: { segment: number; size: number; flags: number; low: number; entryAt: number }[] = [];
        let overlayEnd = fbov;
        let tableAt = -1;
        if (fbov >= 0) {
            const size = b.u32(fbov + 4);
            overlayEnd = fbov + 16 + size;
            if (overlayEnd > data.length) {
                warnings.push(`The overlays are said to be ${bytesLabel(size)}, more than the ${bytesLabel(data.length - fbov - 16)} left in the file.`);
                overlayEnd = data.length;
            }
            tableAt = b.u32(fbov + 8);
            const count = b.u32(fbov + 12);
            if (tableAt + count * 8 > data.length) {
                warnings.push(`The table of segments is said to be ${plural(count, 'entry', 'entries')} at ${tableAt.toLocaleString('en-US')}, past the end of the file.`);
                tableAt = -1;
            } else {
                checkCount(count, 8, data.length - tableAt, 'Segments');
                if (tableAt < headerSize || tableAt + count * 8 > loaded) warnings.push('The table of segments is outside the program’s image, where the overlay manager can’t find it.');
                for (let i = 0; i < count; i++) {
                    const e = tableAt + i * 8;
                    segments.push({ segment: b.u16(e), size: b.u16(e + 2), flags: b.u16(e + 4), low: b.u16(e + 6), entryAt: e });
                }
            }
            // Each overlay's stub: INT 3Fh, then where the code is (from the end of the FBOV header), its size, its fixups' and
            // how many entry points follow (5 bytes each: INT 3Fh, an offset in the code, a spare byte).
            for (const s of segments) {
                if (!(s.flags & OVERLAID)) continue;
                const stubAt = headerSize + s.segment * 16;
                const n = overlays.length + 1;
                if (stubAt + 32 > loaded || data[stubAt] !== 0xcd || data[stubAt + 1] !== 0x3f) {
                    warnings.push(`Overlay ${n}'s stub (segment ${seg(s.segment)}) isn't one: it doesn't start with INT 3Fh, which loads the overlay.`);
                    continue;
                }
                const o: Overlay = { n, segment: s.segment, stubAt, codeAt: fbov + 16 + b.u32(stubAt + 4), code: b.u16(stubAt + 8), fixups: b.u16(stubAt + 10), entries: b.u16(stubAt + 12) };
                if (o.codeAt + o.code + o.fixups > overlayEnd) {
                    warnings.push(`Overlay ${n}'s code is said to be ${bytesLabel(o.code + o.fixups)} at ${o.codeAt.toLocaleString('en-US')}, past the end of the overlays.`);
                    continue;
                }
                if (stubAt + 32 + o.entries * 5 > loaded) warnings.push(`Overlay ${n}'s stub lists ${o.entries} entry points, running past the program's image.`);
                if (o.fixups & 1) warnings.push(`Overlay ${n}'s fixups are said to be ${o.fixups} bytes, which isn't a whole number of 2-byte fixups.`);
                let wild = 0;
                for (let f = 0; f + 1 < o.fixups; f += 2) if (b.u16(o.codeAt + o.code + f) + 2 > o.code) wild++;
                if (wild) warnings.push(`Overlay ${n} has ${plural(wild, 'fixup')} pointing past its code: loading it would change memory beyond it.`);
                overlays.push(o);
            }
        }

        // The image, segment by segment when TLINK's table says where they are.
        const starts = [...new Set(segments.map((s) => s.segment * 16).filter((o) => o < imageSize))].sort((x, y) => x - y);
        const imageParts: Field[] = [];
        for (let i = 0; i < starts.length; i++) {
            const from = headerSize + starts[i];
            const to = Math.min(i + 1 < starts.length ? headerSize + starts[i + 1] : imageEnd, loaded);
            if (to <= from) continue;
            if (i === 0 && from > headerSize) imageParts.push(field('Before the first segment', headerSize, from - headerSize, bytesLabel(from - headerSize)));
            const here = segments.filter((s) => s.segment * 16 === starts[i]);
            const kinds = [...new Set(here.map((s) => kindOf(s.flags)))];
            const stub = overlays.find((o) => o.stubAt === from);
            imageParts.push(
                field(`Segment ${seg(starts[i] / 16)}`, from, to - from, stub ? `Overlay ${stub.n}'s stub` : kinds.join(', '), stub ? 'Calls to it load the overlay from the file.' : undefined)
            );
        }
        fields.length = 0;
        fields.push(...header);
        if (loaded > headerSize)
            fields.push({
                name: 'Program image',
                offset: headerSize,
                length: loaded - headerSize,
                value: bytesLabel(imageSize),
                note: made?.packed ? 'Packed: it unpacks itself when it runs, so the code here isn’t what runs.' : 'Code and data, as DOS loads it.',
                children: imageParts.length ? imageParts : undefined,
            });

        // The overlays: the FBOV header, then each piece of code and its fixups.
        const entries: Entry[] = [];
        if (fbov >= 0) {
            const parts: Field[] = [
                {
                    name: 'Overlay header',
                    offset: fbov,
                    length: 16,
                    value: '"FBOV"',
                    children: [
                        field('Signature', fbov, 4, '"FBOV"', 'Borland’s overlays follow.'),
                        field('Size', fbov + 4, 4, bytesLabel(b.u32(fbov + 4)), 'After this header.'),
                        field('Segment table at', fbov + 8, 4, b.u32(fbov + 8), 'In the program’s image: what TLINK says each segment is.'),
                        field('Segments', fbov + 12, 4, b.u32(fbov + 12)),
                    ],
                },
            ];
            let covered = fbov + 16;
            for (const o of [...overlays].sort((x, y) => x.codeAt - y.codeAt)) {
                if (o.codeAt > covered) {
                    const zeros = data.subarray(covered, o.codeAt).every((v) => v === 0);
                    parts.push(
                        field(zeros ? 'Padding' : 'Unused', covered, o.codeAt - covered, bytesLabel(o.codeAt - covered), zeros ? 'Zeros, to the next 16 bytes.' : 'No overlay’s stub points here.')
                    );
                }
                parts.push({
                    name: `Overlay ${o.n}`,
                    offset: o.codeAt,
                    length: o.code + o.fixups,
                    value: `${bytesLabel(o.code)} of code, ${plural(o.entries, 'entry point')}`,
                    note: `Its stub is segment ${seg(o.segment)}.`,
                    children: [
                        field('Code', o.codeAt, o.code, bytesLabel(o.code)),
                        ...(o.fixups ? [field('Fixups', o.codeAt + o.code, o.fixups, plural(o.fixups >> 1, 'place'), 'Each where the code names a segment, set when it’s loaded.')] : []),
                    ],
                });
                covered = Math.max(covered, o.codeAt + o.code + o.fixups);
                entries.push({
                    name: null,
                    label: `overlay-${String(o.n).padStart(2, '0')}.bin`,
                    offset: o.codeAt,
                    size: o.code,
                    data: data.subarray(o.codeAt, o.codeAt + o.code),
                    meta: { Stub: seg(o.segment), 'Entry points': String(o.entries) },
                });
            }
            if (overlayEnd > covered) {
                const zeros = data.subarray(covered, overlayEnd).every((v) => v === 0);
                parts.push(field(zeros ? 'Padding' : 'Unused', covered, overlayEnd - covered, bytesLabel(overlayEnd - covered), zeros ? undefined : 'No overlay’s stub points here.'));
            }
            fields.push({
                name: 'Overlays',
                offset: fbov,
                length: overlayEnd - fbov,
                value: plural(overlays.length, 'piece'),
                note: 'Not loaded by DOS: Borland’s overlay manager loads each when it’s called.',
                children: parts,
            });
        }

        // The segments, to look through: what TLINK says each is, how big, and where.
        const rows: TableRow[] = segments.map((s) => {
            const o = s.flags & OVERLAID ? overlays.find((x) => x.segment === s.segment) : undefined;
            const inFile = s.segment * 16 < imageSize;
            const group = o ? 'Overlaid code' : !inFile ? 'Not in the file' : kindOf(s.flags);
            return {
                group,
                cells: {
                    segment: seg(s.segment),
                    kind: o ? `Overlay ${o.n}` : kindOf(s.flags),
                    size: o ? String(o.code) : s.size === 0xffff ? '' : String(s.size),
                    at: o ? String(o.codeAt) : inFile ? String(headerSize + s.segment * 16) : '',
                    entries: o ? String(o.entries) : '',
                },
            };
        });
        const groups = ['Code', 'Overlaid code', 'Data', 'Unmarked', 'Not in the file'].filter((g) => rows.some((r) => r.group === g));

        const SAID: Record<string, string> = { Code: 'code', 'Overlay stub': 'overlaid', Data: 'data', Unmarked: 'marked as neither' };
        const counts = new Map<string, number>(Object.values(SAID).map((k) => [k, 0]));
        for (const s of segments) counts.set(SAID[kindOf(s.flags)], counts.get(SAID[kindOf(s.flags)])! + 1);
        const stem = (context.name ?? '').toUpperCase();
        return {
            title: fbov >= 0 ? 'DOS program (MZ), with Borland overlays' : 'DOS program (MZ)',
            summary: [
                ...(made ? [[made.packed ? 'Packed with' : 'Linked with', made.name] as [string, string]] : []),
                ['Program', `${bytesLabel(imageSize)}${made?.packed ? ', packed' : ''}`],
                ['Extra memory', `${bytesLabel(minAlloc * 16)} at least, ${maxAlloc === 0xffff ? 'as much as DOS has at most' : `${bytesLabel(maxAlloc * 16)} at most`}`],
                ['Starts at', `${at(cs, ip)}, at ${(headerSize + entry).toLocaleString('en-US')} in the file`],
                ['Stack', at(ss, sp)],
                ['Relocations', relocations.toLocaleString('en-US')],
                ...(fbov >= 0
                    ? [['Overlays', `${plural(overlays.length, 'piece')} of code, ${bytesLabel(overlayEnd - fbov)}, loaded from ${stem || 'the file'} when they’re called`] as [string, string]]
                    : []),
                ...(segments.length
                    ? [
                          [
                              'Segments',
                              `${segments.length.toLocaleString('en-US')} in TLINK’s table: ${[...counts]
                                  .filter(([, n]) => n)
                                  .map(([k, n]) => `${n} ${k}`)
                                  .join(', ')}`,
                          ] as [string, string],
                      ]
                    : []),
            ],
            fields,
            entries: entries.length ? entries : undefined,
            preview: rows.length
                ? {
                      kind: 'table',
                      columns: [
                          { key: 'segment', label: 'Segment' },
                          { key: 'kind', label: 'Kind' },
                          { key: 'size', label: 'Size', numeric: true },
                          { key: 'at', label: 'In the file at', numeric: true },
                          { key: 'entries', label: 'Entry points', numeric: true },
                      ],
                      groups,
                      rows,
                  }
                : undefined,
            // DOS loads nothing past the image; anything there that isn't Borland's overlays is the shared checks' to look at.
            end: fbov >= 0 ? overlayEnd : loaded,
            warnings,
        };
    },
};

export default parser;
