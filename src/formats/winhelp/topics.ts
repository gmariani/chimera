import { Bytes, bytesLabel, field } from '../../core/bytes';
import { checkBytes } from '../../core/limits';
import type { Field } from '../../core/types';
import { unpackHelp } from './lz77';
import { expandPhrases, type Phrases } from './phrases';

/**
 * Windows Help's |TOPIC file: blocks of 4 KB (2 KB when |SYSTEM's flags say 8), each a 12-byte header and then its
 * data, LZ77-packed into 16 KB. Positions in it (TOPICPOS) count 16 KB to a block, after the 12 bytes of the first's
 * header; a record that runs past its block's data goes on at the start of the next. The records (TOPICLINK) are
 * chained: each its size, its text's size unpacked, the records before and after it, the size of its first part, its
 * kind. A topic header (2) has the topic's title and macros; a text record (0x20) or a table (0x23) has, in its first
 * part, how its paragraphs are laid out and the codes between its strings (a font, a line break, a tab, a picture, a
 * jump), and in its second part the strings, phrase-compressed. As helpdeco's helpfile.txt describes it; the layout
 * of a paragraph, of a table and of each code checked against helpdeco's source (GPL 2 or later). Windows 3.0's topics,
 * laid out differently, aren't read.
 */

export interface Topic {
    title: string;
    /** Where it starts, as TOPICOFFSETs count: its block × 32,768 and the characters before it in its block. */
    offset: number;
    macros: string[];
    text: string;
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

/** Reads |TOPIC at `at` to `end`; `minor` and `flags` from |SYSTEM. */
export function readTopics(data: Uint8Array, at: number, end: number, minor: number, flags: number, phrases: Phrases | null): Topics {
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
            topic = { title: strings[0] ?? '', offset: block * 0x8000 + chars, macros: strings.slice(1).filter(Boolean), text: '' };
            topics.push(topic);
        } else if (type === TEXT || type === TABLE) {
            const r = readText(first, text, type, (picture) => topic && embedded.push({ topic: topic.title, data: picture }));
            counts.unknown += r.unknown;
            chars += r.length;
            if (topic) topic.text += r.text;
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

/** A text or table record's text: its strings, with the codes between them made into line breaks, tabs and placeholders. */
function readText(first: Uint8Array, strings: Uint8Array, type: number, picture: (data: Uint8Array) => void): { text: string; length: number; unknown: number } {
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
    if (type === TABLE) {
        const columns = first[p++];
        const kind = first[p++];
        if (kind === 0 || kind === 2) p += 2;
        p += columns * 4;
    }
    const out: number[] = [];
    let s = 0;
    let unknown = 0;
    const put = (text: string) => {
        for (const c of text) out.push(c.charCodeAt(0));
    };
    for (let paragraph = 0; p < first.length; paragraph++) {
        if (type === TABLE) {
            if (b.i16(p) === -1) break;
            p += 5;
        } else if (paragraph) break;
        p += 4;
        const bits = b.u16(p);
        p += 2;
        if (bits & 0x0001) long();
        for (const bit of [0x0002, 0x0004, 0x0008, 0x0010, 0x0020, 0x0040]) if (bits & bit) short();
        if (bits & 0x0100) p += 3;
        if (bits & 0x0200) for (let n = short(); n > 0 && p < first.length; n--) if (word() & 0x4000) word();
        // Then each string, and the code after it, to the end code.
        while (p < first.length) {
            const was = p;
            while (s < strings.length && strings[s]) out.push(strings[s++]);
            s++;
            const code = first[p];
            if (code === 0xff) {
                p++;
                break;
            }
            switch (code) {
                case 0x20:
                    p += 5;
                    break;
                case 0x21:
                case 0x80:
                    p += 3;
                    break;
                case 0x81:
                    put('\n');
                    p++;
                    break;
                case 0x82:
                    // In a table: the end of a paragraph in a cell, of the cell, or of the row.
                    if (type !== TABLE || first[p + 1] !== 0xff) put('\n');
                    else put(b.i16(p + 2) === -1 ? '\n' : '\t');
                    p++;
                    break;
                case 0x83:
                    put('\t');
                    p++;
                    break;
                case 0x86:
                case 0x87:
                case 0x88: {
                    const kind = first[p + 1];
                    p += 2;
                    const size = long();
                    if (kind === 0x22) word();
                    if (kind === 3 || kind === 0x22) {
                        if (b.u16(p) === 0) put(`[picture ${b.u16(p + 2)}]`);
                        else {
                            put('[picture]');
                            picture(first.subarray(p + 2, p + Math.max(2, size)));
                        }
                    } else if (kind === 5) {
                        const z = first.indexOf(0, p + 6);
                        const what = new TextDecoder('windows-1252').decode(first.subarray(p + 6, z < 0 ? p + size : z));
                        put(what.startsWith('!') ? `[button: ${what.slice(1).split(',')[0]}]` : what.startsWith('*') ? '[media]' : `[window: ${what.split(',')[0]}]`);
                    }
                    p += Math.max(0, size);
                    break;
                }
                case 0x89:
                case 0x8c:
                    p++;
                    break;
                case 0x8b:
                    put(' ');
                    p++;
                    break;
                case 0xc8:
                case 0xcc:
                case 0xea:
                case 0xeb:
                case 0xee:
                case 0xef:
                    p += b.i16(p + 1) + 3;
                    break;
                case 0xe0:
                case 0xe1:
                case 0xe2:
                case 0xe3:
                case 0xe6:
                case 0xe7:
                    p += 5;
                    break;
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
    return { text: new TextDecoder('windows-1252').decode(Uint8Array.from(out)), length, unknown };
}
