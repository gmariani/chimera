import { Bytes, bytesLabel, field } from '../../core/bytes';
import type { Field } from '../../core/types';

/**
 * Windows Help's B+ trees: its directory of internal files, and its indexes (titles, context names, keywords). A
 * 38-byte header (0x293B, flags, the page size, a string saying what an entry holds, the root page, how many pages
 * and levels, how many entries), then the pages. Index pages (an unused count, how many entries, the page before)
 * lead down to the leaves (the same, and the page after), which hold the entries, the leaves chained in order. As
 * helpdeco's helpfile.txt describes them.
 */

export const BTREE_HEADER = 38;

export interface Btree<T> {
    entries: T[];
    fields: Field[];
    problems: string[];
    /** What its header says an entry holds, as the help compiler wrote it ("z4", "L4", "Lz"). */
    structure: string;
}

/**
 * Reads the B+ tree at `at` (its header), at most to `end`. `entry` reads one leaf entry at `p`, at most to `stop`, and
 * says where the next starts, or null when it doesn't fit. Every page is a field; pages the tree never reaches are
 * said, and the walk can't loop or run past the pages there are.
 */
export function readBtree<T>(data: Uint8Array, at: number, end: number, what: string, entry: (p: number, stop: number) => { value: T; next: number; field?: Field } | null): Btree<T> {
    const b = new Bytes(data);
    const problems: string[] = [];
    const entries: T[] = [];
    if (at + BTREE_HEADER > end || b.u16(at) !== 0x293b) return { entries, fields: [], problems: [`${what} isn’t a B+ tree: it doesn’t start with 0x293B.`], structure: '' };
    const pageSize = b.u16(at + 4);
    const structure = new TextDecoder('latin1').decode(data.subarray(at + 6, at + 22)).replace(/\0.*$/s, '');
    const root = b.i16(at + 26);
    const pages = b.u16(at + 30);
    const levels = b.u16(at + 32);
    const total = b.u32(at + 34);
    const pagesAt = at + BTREE_HEADER;
    const header = {
        name: 'B+ tree header',
        offset: at,
        length: BTREE_HEADER,
        value: `${pages.toLocaleString('en-US')} page${pages === 1 ? '' : 's'} of ${bytesLabel(pageSize)}, ${total.toLocaleString('en-US')} entr${total === 1 ? 'y' : 'ies'}`,
        children: [
            field('Signature', at, 2, '0x293B'),
            field(
                'Flags',
                at + 2,
                2,
                `0x${b
                    .u16(at + 2)
                    .toString(16)
                    .toUpperCase()
                    .padStart(4, '0')}`,
                '0x0400 for the directory of internal files.'
            ),
            field('Page size', at + 4, 2, bytesLabel(pageSize)),
            field('Entries hold', at + 6, 16, JSON.stringify(structure), 'L a long, F, i or z a string ending in 0, 2 a short, 4 a long.'),
            field('Zero', at + 22, 2, b.i16(at + 22)),
            field('Page splits', at + 24, 2, b.i16(at + 24)),
            field('Root page', at + 26, 2, root),
            field('Minus one', at + 28, 2, b.i16(at + 28)),
            field('Pages', at + 30, 2, pages),
            field('Levels', at + 32, 2, levels),
            field('Entries', at + 34, 4, total),
        ],
    };
    const fields: Field[] = [header];
    if (pageSize < 8 || pagesAt + pages * pageSize > end) {
        problems.push(`${what}’s pages run past the end of the file it’s in.`);
        return { entries, fields, problems, structure };
    }
    const pageAt = (n: number) => pagesAt + n * pageSize;
    const seen = new Set<number>();
    const pageFields = new Map<number, Field>();

    // Down from the root by each index page's first link, to the first leaf.
    let page = root;
    for (let level = 1; level < levels; level++) {
        if (page < 0 || page >= pages || seen.has(page)) {
            problems.push(`${what}’s index pages lead to a page it doesn’t have (${page}).`);
            return { entries, fields, problems, structure };
        }
        seen.add(page);
        const p = pageAt(page);
        pageFields.set(page, { name: `Page ${page}: index`, offset: p, length: pageSize, value: `${b.i16(p + 2)} entries`, note: 'Leads to the pages below it.' });
        page = b.i16(p + 4);
    }
    if (levels > 1 && (page < 0 || page >= pages)) {
        problems.push(`${what}’s index pages lead to a page it doesn’t have (${page}).`);
        return { entries, fields: [...fields, ...pageFields.values()], problems, structure };
    }
    // Then along the leaves.
    let count = 0;
    while (page !== -1) {
        if (page < 0 || page >= pages || seen.has(page)) {
            problems.push(`${what}’s leaf pages lead to ${seen.has(page) ? 'one already read' : `a page it doesn’t have (${page})`}: what’s past it isn’t read.`);
            break;
        }
        seen.add(page);
        const p = pageAt(page);
        const n = b.i16(p + 2);
        const children: Field[] = [field('Free bytes', p, 2, b.u16(p)), field('Entries', p + 2, 2, n), field('Page before', p + 4, 2, b.i16(p + 4)), field('Page after', p + 6, 2, b.i16(p + 6))];
        let q = p + 8;
        for (let i = 0; i < n; i++) {
            const e = entry(q, p + pageSize);
            if (!e) {
                problems.push(`An entry of ${what} runs past the end of its page.`);
                break;
            }
            entries.push(e.value);
            if (e.field) children.push(e.field);
            q = e.next;
            count++;
        }
        if (q < p + pageSize) children.push(field('Unused', q, p + pageSize - q, bytesLabel(p + pageSize - q)));
        pageFields.set(page, { name: `Page ${page}: leaf`, offset: p, length: pageSize, value: `${n} entr${n === 1 ? 'y' : 'ies'}`, children });
        page = b.i16(p + 6);
    }
    if (count !== total) problems.push(`${what}’s header says it has ${total.toLocaleString('en-US')} entries, but its leaves hold ${count.toLocaleString('en-US')}.`);
    for (let n = 0; n < pages; n++)
        if (!pageFields.has(n)) pageFields.set(n, field(`Page ${n}: not reached`, pageAt(n), pageSize, bytesLabel(pageSize), 'Left over from the compiler: the tree doesn’t lead to it.'));
    fields.push(...[...pageFields.entries()].sort(([x], [y]) => x - y).map(([, f]) => f));
    return { entries, fields, problems, structure };
}

/** A string ending in 0 at `p`, before `stop`: its text and where it ends, or null when it doesn't end in time. */
export function stringAt(data: Uint8Array, p: number, stop: number): { text: string; next: number } | null {
    let z = p;
    while (z < stop && data[z]) z++;
    if (z >= stop) return null;
    return { text: new TextDecoder('windows-1252').decode(data.subarray(p, z)), next: z + 1 };
}
