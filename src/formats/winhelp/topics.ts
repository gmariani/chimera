import { Bytes, bytesLabel, field } from '../../core/bytes';
import { checkBytes } from '../../core/limits';
import type { DocumentParagraph, Field } from '../../core/types';
import { unpackHelp } from './lz77';
import { expandPhrases, type Phrases } from './phrases';

/**
 * Windows Help's |TOPIC file: blocks of 4 KB (2 KB when |SYSTEM's flags say 8), each a 12-byte header and then its
 * data, LZ77-packed into 16 KB. Positions in it (TOPICPOS) count 16 KB to a block, after the 12 bytes of the first's
 * header; a record that runs past its block's data goes on at the start of the next. The records (TOPICLINK) are
 * chained: each its size, its text's size unpacked, the records before and after it, the size of its first part, its
 * kind. A topic header (2) has the topic's title and macros, and where its non-scrolling band ends; a text record
 * (0x20) or a table row (0x23) has, in its first part, how its paragraphs are laid out (spacing, indents, alignment,
 * borders, tab stops; a table's columns) and the codes between its strings (a font, a line break, a tab, a picture, a
 * jump), and in its second part the strings, phrase-compressed. As helpdeco's helpfile.txt describes it; the layout
 * of a paragraph, of a table (each column's width, then the gap before it) and of each code checked against helpdeco's
 * source (GPL 2 or later, facts only). Windows 3.0's topics, laid out differently, aren't read.
 */

/** Where a hotspot in a topic leads: by a context name's hash, a topic offset, a macro, or into another file. */
export interface HelpTarget {
    popup: boolean;
    /** Shown without the green underline (0xCC, 0xE6, 0xE7, 0xEE, 0xEF). */
    plain?: boolean;
    hash?: number;
    offset?: number;
    macro?: string;
    file?: string;
    window?: string;
}

export type HelpRun =
    | { kind: 'text'; text: string; font: number; link?: HelpTarget }
    | { kind: 'break' }
    | { kind: 'tab' }
    /** A picture: a |bm file's number, or the nth picture held in the topics themselves. */
    | { kind: 'picture'; bm?: number; embedded?: number; place: 'inline' | 'left' | 'right'; link?: HelpTarget }
    | { kind: 'object'; text: string };

export type HelpParagraph = Omit<DocumentParagraph, 'runs'> & { runs: HelpRun[] };
export type HelpBlock = HelpParagraph | { kind: 'table'; columns: { width: number; gap: number }[]; relative: boolean; rows: HelpParagraph[][][] };

export interface Topic {
    title: string;
    /** Where it starts, as TOPICOFFSETs count: its block × 32,768 and the characters before it in its block. */
    offset: number;
    macros: string[];
    text: string;
    /** Its non-scrolling band, then the rest. */
    fixed: HelpBlock[];
    body: HelpBlock[];
}

export interface Topics {
    topics: Topic[];
    fields: Field[];
    problems: string[];
    /** Pictures a topic holds itself, rather than in a |bm file. */
    embedded: { topic: string; data: Uint8Array }[];
    /** Where the chain ends, as a TOPICOFFSET: the title index has an empty title there. */
    endOffset: number;
}

const TEXT = 0x20;
const TABLE = 0x23;
const HEADER = 2;
const MOST_FIELDS = 2000;

/** Reads |TOPIC at `at` to `end`; `minor` and `flags` from |SYSTEM, `unit` (points to a unit of its metrics) from |FONT. */
export function readTopics(data: Uint8Array, at: number, end: number, minor: number, flags: number, phrases: Phrases | null, unit = 0.5): Topics {
    const b = new Bytes(data);
    const problems: string[] = [];
    const topics: Topic[] = [];
    const embedded: { topic: string; data: Uint8Array }[] = [];
    const blockSize = minor <= 16 || flags === 8 ? 2048 : 4096;
    const packed = minor > 16 && (flags === 4 || flags === 8);
    const span = minor <= 16 ? 2048 : 0x4000;

    // The blocks, unpacked.
    const count = Math.ceil((end - at) / blockSize);
    checkBytes(count * span, 'Its topics, unpacked');
    const blocks: Uint8Array[] = [];
    const fields: Field[] = [];
    let before = false;
    for (let i = 0; i < count; i++) {
        const p = at + i * blockSize;
        const stop = Math.min(end, p + blockSize);
        const raw = data.subarray(Math.min(p + 12, stop), stop);
        const u = packed ? unpackHelp(raw, span) : { data: raw, beforeStart: false };
        before ||= u.beforeStart;
        blocks.push(u.data);
        if (i < MOST_FIELDS)
            fields.push({
                name: `Block ${i + 1}`,
                offset: p,
                length: stop - p,
                value: packed ? `LZ77, ${bytesLabel(u.data.length)} unpacked` : bytesLabel(stop - p),
                children: [
                    field('Last record of the block before', p, 4, `0x${b.u32(p).toString(16)}`),
                    field('First record', p + 4, 4, `0x${b.u32(p + 4).toString(16)}`),
                    field('Last topic header', p + 8, 4, `0x${b.u32(p + 8).toString(16)}`),
                    field('Data', p + 12, Math.max(0, stop - p - 12), packed ? 'LZ77' : bytesLabel(stop - p - 12)),
                ].filter((f) => f.offset + f.length <= stop),
            });
        else if (i === MOST_FIELDS) fields.push(field('More blocks', p, end - p, `Past the first ${MOST_FIELDS.toLocaleString('en-US')}, not listed one by one.`));
    }
    if (before) problems.push('Some of its topic blocks reach back before their start as they unpack: what they copy isn’t there.');
    if (minor <= 16) {
        problems.push('It’s a Windows 3.0 help file, whose topics are laid out differently: they aren’t read here.');
        return { topics, fields, problems, embedded, endOffset: -1 };
    }

    // All the unpacked bytes there are: no record can be bigger.
    const held = blocks.reduce((n, x) => n + x.length, 0);
    /** `n` bytes at TOPICPOS `pos`, going on into the blocks after when one runs out (never more than there are). */
    const read = (pos: number, n: number): Uint8Array => {
        const out = new Uint8Array(Math.min(n, held));
        let got = 0;
        let block = Math.floor((pos - 12) / span);
        let off = (pos - 12) % span;
        while (got < n && block < blocks.length) {
            const part = blocks[block].subarray(off, off + n - got);
            out.set(part, got);
            got += part.length;
            block++;
            off = 0;
        }
        return out.subarray(0, got);
    };

    let pos = 12;
    const seen = new Set<number>();
    let topic: Topic | null = null;
    // Records before this TOPICPOS are in the topic's non-scrolling band.
    let scrollAt = 0;
    let font = 0;
    let lastBlock = -1;
    let chars = 0;
    const counts = { unknown: 0, phrases: { count: 0 }, records: 0, unexpanded: 0 };
    let endOffset = -1;
    while (pos >= 12 && !seen.has(pos) && Math.floor((pos - 12) / span) < blocks.length) {
        seen.add(pos);
        const head = read(pos, 21);
        if (head.length < 21) break;
        const h = new Bytes(head);
        const size = h.i32(0);
        const textSize = h.i32(4);
        const next = h.i32(12);
        const firstSize = h.i32(16);
        const type = head[20];
        if (size < 21 || firstSize < 21 || firstSize > size) {
            problems.push(`A record of its topics at 0x${pos.toString(16)} gives sizes that don’t fit together (${size} in all, ${firstSize} in its first part): the topics after it aren’t read.`);
            break;
        }
        // TOPICOFFSETs count characters within a block: the block a record starts in.
        const block = Math.floor((pos - 12) / span);
        if (block !== lastBlock) {
            lastBlock = block;
            chars = 0;
        }
        // The last record holds nothing: it only ends the chain.
        if (next <= 0) {
            endOffset = block * 0x8000 + chars;
            break;
        }
        const link = size <= held ? read(pos, size) : new Uint8Array(0);
        if (link.length < size) {
            problems.push(`A record of its topics runs past the end of the topic file: it’s been cut short.`);
            break;
        }
        const first = link.subarray(21, firstSize);
        const rawText = link.subarray(firstSize);
        if (textSize > rawText.length && !phrases) counts.unexpanded++;
        const text = textSize > rawText.length ? expandPhrases(rawText, phrases, counts.phrases) : rawText.subarray(0, Math.max(0, textSize));
        if (type === HEADER) {
            const strings = new TextDecoder('windows-1252').decode(text).split('\0');
            topic = { title: strings[0] ?? '', offset: block * 0x8000 + chars, macros: strings.slice(1).filter(Boolean), text: '', fixed: [], body: [] };
            topics.push(topic);
            // Its header: its size, the topics before and after it to browse, its number, where its non-scrolling band
            // starts (or -1), where the scrolling part starts (or -1, when all of it stays put), and the next topic.
            if (first.length >= 28) {
                const t = new Bytes(first);
                const scroll = t.i32(20);
                const nextTopic = t.i32(24);
                scrollAt = scroll !== -1 ? scroll : nextTopic === -1 ? Infinity : nextTopic;
            } else scrollAt = 0;
        } else if (type === TEXT || type === TABLE) {
            const r = readText(
                first,
                text,
                type,
                unit,
                (picture) => {
                    embedded.push({ topic: topic?.title ?? '', data: picture });
                    return embedded.length - 1;
                },
                font
            );
            font = r.font;
            counts.unknown += r.unknown;
            chars += r.length;
            if (topic) {
                topic.text += r.text;
                const into = pos < scrollAt ? topic.fixed : topic.body;
                const last = into.at(-1);
                // Rows laid out alike, one after another, are one table.
                if (r.block.kind === 'table' && last?.kind === 'table' && last.relative === r.block.relative && JSON.stringify(last.columns) === JSON.stringify(r.block.columns))
                    last.rows.push(...r.block.rows);
                else if (r.block.kind === 'table') into.push(r.block);
                else into.push(...r.paragraphs);
            }
        } else counts.unknown++;
        counts.records++;
        pos = next;
    }
    if (counts.unknown)
        problems.push(
            counts.unknown === 1
                ? '1 code or record in its topics is of a kind this reader doesn’t know: it was skipped.'
                : `${counts.unknown.toLocaleString('en-US')} codes or records in its topics are of kinds this reader doesn’t know: they were skipped.`
        );
    if (counts.phrases.count)
        problems.push(`Its topics use phrases its phrase table doesn’t have, ${counts.phrases.count.toLocaleString('en-US')} time${counts.phrases.count === 1 ? '' : 's'}: they’re left out.`);
    if (counts.unexpanded)
        problems.push(
            `${counts.unexpanded.toLocaleString('en-US')} of its topic records ${counts.unexpanded === 1 ? 'is' : 'are'} phrase-compressed, but it has no phrase table: ${counts.unexpanded === 1 ? 'its' : 'their'} text can’t be read.`
        );
    for (const t of topics)
        t.text = t.text
            .replace(/[ \t]+\n/g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    return { topics, fields, problems, embedded, endOffset };
}

const PLACES = { 0x86: 'inline', 0x87: 'left', 0x88: 'right' } as const;

/**
 * A text or table record: its text, with the codes between its strings made into line breaks, tabs and placeholders,
 * and its paragraphs as laid out (a text record's, or a table row's). `unit` is points to a unit of its metrics;
 * `picture` keeps a picture held in the record and says its number.
 */
function readText(
    first: Uint8Array,
    strings: Uint8Array,
    type: number,
    unit: number,
    picture: (data: Uint8Array) => number,
    startFont: number
): { text: string; length: number; unknown: number; paragraphs: HelpParagraph[]; block: HelpBlock; font: number } {
    const b = new Bytes(first);
    let p = 0;
    // Compressed numbers: the low bit says whether they take the short form or the long, the value above it.
    const word = () => {
        const v = first[p] & 1 ? b.u16(p) >> 1 : first[p] >> 1;
        p += first[p] & 1 ? 2 : 1;
        return v;
    };
    const short = () => {
        const v = first[p] & 1 ? (b.u16(p) >> 1) - 0x4000 : (first[p] >> 1) - 0x40;
        p += first[p] & 1 ? 2 : 1;
        return v;
    };
    const long = () => {
        const v = first[p] & 1 ? (b.u32(p) >>> 1) - 0x40000000 : (b.u16(p) >> 1) - 0x4000;
        p += first[p] & 1 ? 4 : 2;
        return v;
    };
    long();
    const length = word();
    // A table row: how many columns, whether their widths are shares of the window's (0 and 2, after the narrowest it can
    // be) or fixed, then each column's width and the gap before it (the first's gap is the left margin). helpfile.txt has
    // the gap first, but real tables have widths of inches there and gaps of 5.5 points after, and helpdeco reads them so.
    // Microsoft's own PSS help has shares that are negative: what it meant by them isn't known, and they're kept as they
    // are, for the page to lay the table out itself.
    const columns: { width: number; gap: number }[] = [];
    let relative = false;
    if (type === TABLE) {
        const count = first[p++];
        const kind = first[p++];
        relative = kind === 0 || kind === 2;
        if (relative) p += 2;
        for (let i = 0; i < count && p + 4 <= first.length; i++, p += 4) columns.push(relative ? { width: b.i16(p), gap: b.i16(p + 2) } : { width: b.i16(p) * unit, gap: b.i16(p + 2) * unit });
    }
    const out: number[] = [];
    const cells: HelpParagraph[][] = columns.map(() => []);
    const paragraphs: HelpParagraph[] = [];
    let s = 0;
    let unknown = 0;
    // The font in use carries on from record to record, as helpdeco keeps it.
    let font = startFont;
    const put = (text: string) => {
        for (const c of text) out.push(c.charCodeAt(0));
    };
    for (let paragraph = 0; p < first.length; paragraph++) {
        let column = 0;
        if (type === TABLE) {
            column = b.i16(p);
            if (column === -1) break;
            p += 5;
        } else if (paragraph) break;
        p += 4;
        // How the paragraph is laid out: what follows, then each that does.
        const bits = b.u16(p);
        p += 2;
        const layout: Omit<HelpParagraph, 'runs'> = { kind: 'paragraph' };
        if (bits & 0x0400) layout.align = 'right';
        if (bits & 0x0800) layout.align = 'center';
        if (bits & 0x0001) long();
        if (bits & 0x0002) layout.spaceBefore = short() * unit;
        if (bits & 0x0004) layout.spaceAfter = short() * unit;
        if (bits & 0x0008) layout.lineSpacing = short() * unit;
        if (bits & 0x0010) layout.indentLeft = short() * unit;
        if (bits & 0x0020) layout.indentRight = short() * unit;
        if (bits & 0x0040) layout.indentFirst = short() * unit;
        if (bits & 0x0100) {
            const x = first[p];
            layout.border = { top: !!(x & 3), left: !!(x & 5), bottom: !!(x & 9), right: !!(x & 0x11), thick: !!(x & 0x20), double: !!(x & 0x40) };
            p += 3;
        }
        if (bits & 0x0200) {
            layout.tabs = [];
            for (let n = short(); n > 0 && p < first.length; n--) {
                const stop = word();
                const kind = stop & 0x4000 ? word() : 0;
                layout.tabs.push({ at: (stop & 0x3fff) * unit, align: kind === 1 ? 'right' : kind === 2 ? 'center' : 'left' });
            }
        }
        // A column the row doesn't have goes in its last.
        const into = type === TABLE ? (cells[column] ?? cells.at(-1) ?? (cells[0] = [])) : paragraphs;
        let current: HelpParagraph = { ...layout, runs: [] };
        into.push(current);
        let fresh = false;
        let link: HelpTarget | undefined;
        const run = (r: HelpRun) => {
            current.runs.push(r);
            fresh = false;
        };
        // Then each string, and the code after it, to the end code.
        while (p < first.length) {
            const was = p;
            const from = s;
            while (s < strings.length && strings[s]) out.push(strings[s++]);
            if (s > from) run({ kind: 'text', text: new TextDecoder('windows-1252').decode(strings.subarray(from, s)), font, ...(link && { link }) });
            s++;
            const code = first[p];
            if (code === 0xff) {
                p++;
                // A paragraph's end just before the record's (or the cell's) opens none.
                if (fresh) into.pop();
                break;
            }
            switch (code) {
                case 0x20:
                    p += 5;
                    break;
                case 0x21:
                    p += 3;
                    break;
                case 0x80:
                    font = b.u16(p + 1);
                    p += 3;
                    break;
                case 0x81:
                    put('\n');
                    run({ kind: 'break' });
                    p++;
                    break;
                case 0x82:
                    // In a table: the end of a paragraph in a cell, of the cell, or of the row.
                    if (type !== TABLE || first[p + 1] !== 0xff) put('\n');
                    else put(b.i16(p + 2) === -1 ? '\n' : '\t');
                    // The next paragraph is laid out the same.
                    current = { ...layout, runs: [] };
                    into.push(current);
                    fresh = true;
                    p++;
                    break;
                case 0x83:
                    put('\t');
                    run({ kind: 'tab' });
                    p++;
                    break;
                case 0x86:
                case 0x87:
                case 0x88: {
                    const kind = first[p + 1];
                    p += 2;
                    const size = long();
                    if (kind === 0x22) word();
                    const place = PLACES[code];
                    if (kind === 3 || kind === 0x22) {
                        if (b.u16(p) === 0) {
                            put(`[picture ${b.u16(p + 2)}]`);
                            run({ kind: 'picture', bm: b.u16(p + 2), place, ...(link && { link }) });
                        } else {
                            put('[picture]');
                            run({ kind: 'picture', embedded: picture(first.subarray(p + 2, p + Math.max(2, size))), place, ...(link && { link }) });
                        }
                    } else if (kind === 5) {
                        const z = first.indexOf(0, p + 6);
                        const what = new TextDecoder('windows-1252').decode(first.subarray(p + 6, z < 0 ? p + size : z));
                        const label = what.slice(1).split(',')[0];
                        const text = what.startsWith('!') ? (label ? `[button: ${label}]` : '[button]') : what.startsWith('*') ? '[media]' : `[window: ${what.split(',')[0]}]`;
                        put(text);
                        run({ kind: 'object', text });
                    }
                    p += Math.max(0, size);
                    break;
                }
                case 0x89:
                    link = undefined;
                    p++;
                    break;
                case 0x8c:
                    p++;
                    break;
                case 0x8b:
                    put(' ');
                    run({ kind: 'text', text: ' ', font, ...(link && { link }) });
                    p++;
                    break;
                case 0xc8:
                case 0xcc: {
                    const z = first.indexOf(0, p + 3);
                    const stop = p + 3 + Math.max(0, b.i16(p + 1));
                    link = { popup: false, plain: code === 0xcc, macro: new TextDecoder('windows-1252').decode(first.subarray(p + 3, z < 0 || z > stop ? stop : z)) };
                    p += b.i16(p + 1) + 3;
                    break;
                }
                case 0xe0:
                case 0xe1:
                    // Windows 3.0's: a topic offset.
                    link = { popup: code === 0xe0, offset: b.u32(p + 1) };
                    p += 5;
                    break;
                case 0xe2:
                case 0xe3:
                case 0xe6:
                case 0xe7:
                    // A context name's hash; 0xE6 and 0xE7 without the green underline.
                    link = { popup: code === 0xe2 || code === 0xe6, plain: code >= 0xe6, hash: b.u32(p + 1) };
                    p += 5;
                    break;
                case 0xea:
                case 0xeb:
                case 0xee:
                case 0xef: {
                    // Into another file or window: its size, the kind (0 none, 1 a window's number, 4 a file, 6 a
                    // window and a file), the context name's hash, then the window and the file.
                    const kind = first[p + 3];
                    const stop = Math.min(first.length, p + 3 + Math.max(0, b.i16(p + 1)));
                    const strz = (from: number) => {
                        const z = first.indexOf(0, from);
                        return { text: new TextDecoder('windows-1252').decode(first.subarray(from, z < 0 || z > stop ? stop : z)), next: z < 0 ? stop : z + 1 };
                    };
                    link = { popup: code === 0xea || code === 0xee, plain: code >= 0xee, hash: b.u32(p + 4) };
                    if (kind === 1) link.window = `${first[p + 8]}`;
                    else if (kind === 4) link.file = strz(p + 8).text;
                    else if (kind === 6) {
                        const w = strz(p + 8);
                        link.window = w.text;
                        link.file = strz(w.next).text;
                    }
                    p += b.i16(p + 1) + 3;
                    break;
                }
                default:
                    unknown++;
                    p++;
            }
            // A length from the file that doesn't move on (0, or negative) would go round for ever.
            if (p <= was) {
                unknown++;
                p = first.length;
            }
        }
        if (type !== TABLE) put('\n');
    }
    const block: HelpBlock = type === TABLE ? { kind: 'table', columns, relative, rows: [Array.from(cells, (c) => c ?? [])] } : (paragraphs[0] ?? { kind: 'paragraph', runs: [] });
    return { text: new TextDecoder('windows-1252').decode(Uint8Array.from(out)), length, unknown, paragraphs, block, font };
}
