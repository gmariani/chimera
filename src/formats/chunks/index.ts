import { bytesLabel, field, formatSize, hex } from '../../core/bytes';
import { inflate } from '../../core/inflate';
import type { Field, FormatParser, Parsed } from '../../core/types';
import { sniffCompressedChunks } from './sniff';
import { append } from '../../core/math';

/**
 * Petroglyph's compiled data in the Remastered Collection (.bui UI layouts, and
 * .cfx, .bfd, .gtl, .gpd, .cpd and .sob). Each file is a 36-byte "CH" header and
 * a zlib stream, which unpacks to a tree of chunks: a u32 id and a u32 size, and
 * either the size's bytes or, with the top bit set, the low bits as how many
 * chunks follow inside it. A leaf holds a string (a u16 length and the
 * characters) or properties (a u8 tag, a u8 size and the value).
 *
 * None of this is documented. The tree is certain, since it uses up every byte
 * of every file in the game. What the ids mean is worked out from what's in them,
 * so only a few are named, and values are shown as what they look like.
 */

const HEADER = 36;
/** Most chunks and properties listed. */
const MAX_FIELDS = 20000;
const MAX_DEPTH = 64;

/**
 * A widget's type, as the names of the widgets of each type show it to be. The
 * ones not here (4, 10, 20, 23) had no clear pattern.
 */
const WIDGET_TYPES: Record<number, string> = {
    1: 'Image',
    2: 'Text',
    5: 'Button',
    6: 'Scene',
    7: 'Movie',
    11: 'Progress bar',
    12: 'Frame',
    13: 'Edit box',
    14: 'Scroll bar or slider',
    15: 'List box',
    16: 'Combo box',
    19: 'Group',
    21: 'Simple button',
    22: 'Tooltip',
    32: 'Tree',
    34: 'Movie (Theora)',
};

interface Chunk {
    id: number;
    /** Where the chunk's own header starts. */
    offset: number;
    /** With the header, and for a container everything inside. */
    length: number;
    children?: Chunk[];
}

const bodyOf = (data: Uint8Array, c: Chunk) => data.subarray(c.offset + 8, c.offset + c.length);

function readChunks(data: Uint8Array): Chunk[] {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const list = (start: number, count: number | null, depth: number): [Chunk[], number] => {
        const out: Chunk[] = [];
        let at = start;
        for (let i = 0; count === null ? at < data.length : i < count; i++) {
            if (at + 8 > data.length) throw new Error(`The chunk at byte ${at} runs past the end.`);
            if (depth > MAX_DEPTH) throw new Error(`The chunks at byte ${at} nest too deep.`);
            const [id, size] = [view.getUint32(at, true), view.getUint32(at + 4, true)];
            if (size >= 0x80000000) {
                const [children, end] = list(at + 8, size - 0x80000000, depth + 1);
                out.push({ id, offset: at, length: end - at, children });
                at = end;
            } else {
                if (at + 8 + size > data.length) throw new Error(`The chunk at byte ${at} runs past the end.`);
                out.push({ id, offset: at, length: 8 + size });
                at += 8 + size;
            }
        }
        return [out, at];
    };
    return list(0, null, 0)[0];
}

const latin1 = new TextDecoder('latin1');

/** A u16 length and that many printable characters, or null if it isn't one. */
function asString(bytes: Uint8Array): string | null {
    if (bytes.length < 2 || bytes[0] + bytes[1] * 256 !== bytes.length - 2) return null;
    for (let i = 2; i < bytes.length; i++) if (bytes[i] < 0x20 || bytes[i] === 0x7f) return null;
    return latin1.decode(bytes.subarray(2));
}

interface Property {
    tag: number;
    offset: number;
    bytes: Uint8Array;
}

/** A leaf's properties, or null if it isn't made of them. */
function asProperties(bytes: Uint8Array, base: number): Property[] | null {
    if (bytes.length === 0) return null;
    const out: Property[] = [];
    let at = 0;
    while (at < bytes.length) {
        if (at + 2 > bytes.length || at + 2 + bytes[at + 1] > bytes.length) return null;
        out.push({ tag: bytes[at], offset: base + at, bytes: bytes.subarray(at + 2, at + 2 + bytes[at + 1]) });
        at += 2 + bytes[at + 1];
    }
    return out;
}

/** A float that looks meant, rather than an integer or an ID read as one. */
function plausibleFloat(value: number): boolean {
    const size = Math.abs(value);
    return value === 0 || (size >= 1e-5 && size < 1e7);
}

const number = (value: number) => String(Number(value.toFixed(5)));

/** A property's value as what it looks like: the format doesn't say. */
function showValue(bytes: Uint8Array): string {
    const text = asString(bytes);
    if (text !== null && bytes.length > 2) return JSON.stringify(text);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length === 1) return String(bytes[0]);
    if (bytes.length === 2) return String(view.getUint16(0, true));
    if (bytes.length === 4) {
        const whole = view.getUint32(0, true);
        if (whole < 0x10000) return String(whole);
        const float = view.getFloat32(0, true);
        return plausibleFloat(float) ? number(float) : hex(whole);
    }
    if (bytes.length % 4 === 0 && bytes.length <= 64) {
        const floats = Array.from({ length: bytes.length / 4 }, (_, i) => view.getFloat32(i * 4, true));
        if (floats.every(plausibleFloat)) return floats.map(number).join(', ');
    }
    const shown = Array.from(bytes.subarray(0, 32), (b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
    return bytes.length > 32 ? `${shown} …` : shown;
}

/** The chunk's text: a string leaf's own, or the strings among a leaf's properties. */
function stringsIn(data: Uint8Array, chunk: Chunk): string[] {
    if (chunk.children) return [];
    const body = bodyOf(data, chunk);
    const text = asString(body);
    if (text !== null) return text ? [text] : [];
    const properties = asProperties(body, 0) ?? [];
    return properties.flatMap((p) => (p.bytes.length > 2 ? asString(p.bytes) : null) ?? []);
}

interface Widget {
    type: number;
    /** The chunks holding its name, its other strings and the widgets inside it. */
    contents: Chunk;
}

/** A widget: a chunk 1 of a properties chunk 2, whose tag 3 is its type, and a chunk 4 of contents. */
function asWidget(data: Uint8Array, chunk: Chunk): Widget | null {
    const [info, contents] = chunk.children ?? [];
    if (chunk.id !== 1 || chunk.children?.length !== 2 || info.id !== 2 || info.children || contents.id !== 4 || !contents.children) return null;
    const tag = asProperties(bodyOf(data, info), 0)?.find((p) => p.tag === 3 && p.bytes.length === 4);
    if (!tag) return null;
    return { type: new DataView(tag.bytes.buffer, tag.bytes.byteOffset, 4).getUint32(0, true), contents };
}

/** A widget's own strings, in order: not those of the widgets inside it. */
function ownStrings(data: Uint8Array, chunk: Chunk): { name: string | null; others: string[] } {
    let name: string | null = null;
    const others: string[] = [];
    const visit = (c: Chunk) => {
        if (asWidget(data, c)) return;
        if (c.children) return c.children.forEach(visit);
        const strings = stringsIn(data, c);
        // Chunk 5 next to chunk 0's properties is the name, the first time it comes up.
        if (c.id === 5 && name === null && strings.length === 1) name = strings[0];
        else append(others, strings);
    };
    chunk.children?.forEach(visit);
    return { name, others };
}

const typeLabel = (type: number) => WIDGET_TYPES[type] ?? `Type ${type}`;

/** Every widget, indented by what it's inside. */
function outline(data: Uint8Array, top: Chunk[], indent: number): { lines: string[]; widgets: number } {
    const lines: string[] = [];
    let widgets = 0;
    const visit = (chunks: Chunk[], depth: number) => {
        for (const chunk of chunks) {
            const widget = asWidget(data, chunk);
            if (widget) {
                widgets++;
                const { name, others } = ownStrings(data, widget.contents);
                const extras = others.map((s) => ` "${s}"`).join('');
                lines.push(`${'  '.repeat(depth)}${typeLabel(widget.type)}: ${name ?? '(no name)'}${extras}`);
                visit(widget.contents.children!, depth + 1);
            } else if (chunk.children) {
                visit(chunk.children, depth);
            }
        }
    };
    visit(top, indent);
    return { lines, widgets };
}

/** The name a layout gives itself: chunk 3 of the top-level chunk 2 (not every layout has one). */
function layoutName(data: Uint8Array, top: Chunk[]): string | null {
    const named = top.find((c) => c.id === 2)?.children?.find((c) => c.id === 3 && !c.children);
    return named ? asString(bodyOf(data, named)) : null;
}

/** A layout's root, which holds every widget: chunk 0 of the top-level chunk 2, named like a widget is. */
function rootOf(data: Uint8Array, top: Chunk[]): { chunk: Chunk; name: string } | null {
    const chunk = top.find((c) => c.id === 2)?.children?.find((c) => c.id === 0 && c.children);
    const name = chunk && ownStrings(data, chunk).name;
    return chunk && name ? { chunk, name } : null;
}

function allStrings(data: Uint8Array, chunks: Chunk[]): string[] {
    return chunks.flatMap((c) => (c.children ? allStrings(data, c.children) : stringsIn(data, c)));
}

/** What the unpacked chunks amount to, for a file's summary and preview. */
function describe(data: Uint8Array, top: Chunk[]) {
    const root = rootOf(data, top);
    const { lines, widgets } = outline(data, root ? root.chunk.children! : top, root ? 1 : 0);
    if (root || widgets) {
        const name = layoutName(data, top);
        const rows: [string, string][] = [...(name ? [['Layout', name] as [string, string]] : []), ...(root ? [['Root', root.name] as [string, string]] : []), ['Widgets', String(widgets)]];
        return { title: 'UI layout (Petroglyph)', rows, text: [...(name ? [name] : []), ...(root ? [`Root: ${root.name}`] : []), ...lines].join('\n') };
    }
    const strings = allStrings(data, top);
    return { title: 'Chunk file (Petroglyph)', rows: [['Strings', String(strings.length)] as [string, string]], text: strings.join('\n') };
}

function chunkFields(data: Uint8Array, top: Chunk[]): { fields: Field[]; capped: boolean } {
    let count = 0;
    let capped = false;
    const build = (chunks: Chunk[]): Field[] => {
        const out: Field[] = [];
        for (const [i, chunk] of chunks.entries()) {
            if (count >= MAX_FIELDS) {
                // The rest as one field, so every byte is still accounted for.
                capped = true;
                const last = chunks[chunks.length - 1];
                out.push(field(`${chunks.length - i} more chunks`, chunk.offset, last.offset + last.length - chunk.offset, undefined, 'Past the limit on fields shown.'));
                break;
            }
            count++;
            const name = `Chunk ${chunk.id}`;
            if (chunk.children) {
                const widget = asWidget(data, chunk);
                const value = widget ? `${typeLabel(widget.type)}: ${ownStrings(data, widget.contents).name ?? '(no name)'}` : `${chunk.children.length} chunk${chunk.children.length === 1 ? '' : 's'}`;
                out.push({ name, offset: chunk.offset, length: chunk.length, value, children: build(chunk.children) });
                continue;
            }
            const body = bodyOf(data, chunk);
            const text = asString(body);
            const properties = text === null ? asProperties(body, chunk.offset + 8) : null;
            if (text !== null) out.push(field(name, chunk.offset, chunk.length, JSON.stringify(text)));
            else if (properties) {
                out.push({
                    name,
                    offset: chunk.offset,
                    length: chunk.length,
                    value: `${properties.length} propert${properties.length === 1 ? 'y' : 'ies'}`,
                    children: properties.map((p) => field(`Tag ${p.tag}`, p.offset, 2 + p.bytes.length, showValue(p.bytes))),
                });
                count += properties.length;
            } else out.push(field(name, chunk.offset, chunk.length, body.length ? `${bytesLabel(body.length)}: ${showValue(body)}` : 'Empty'));
        }
        return out;
    };
    return { fields: build(top), capped };
}

/** A file of chunks, unpacked: this is what the bytes on screen are, so the fields point at them. */
function parseChunks(data: Uint8Array): Parsed {
    const top = readChunks(data);
    const { title, rows, text } = describe(data, top);
    const { fields, capped } = chunkFields(data, top);
    return {
        title,
        summary: [['Size', formatSize(data.length)], ...rows],
        fields,
        preview: { kind: 'text', text },
        warnings: capped ? [`The first ${MAX_FIELDS.toLocaleString('en-US')} chunks and properties are in the fields.`] : [],
    };
}

function parseCompressed(data: Uint8Array, name: string | null): Parsed {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const compressed = view.getUint32(16, true);
    const headerBytes = Array.from(data.subarray(2, 8), (b) => hex(b, 2)).join(' ');
    const fields: Field[] = [
        {
            name: 'Header',
            offset: 0,
            length: HEADER,
            children: [
                field('Signature', 0, 2, 'CH'),
                field('Unknown', 2, 6, headerBytes, 'Nearly the same in every file (byte 4 is 21 in .cpd files).'),
                field('Unknown', 8, 4, hex(view.getUint32(8, true)), "Differs from file to file; it isn't a CRC-32 or Adler-32 of the file's contents or name."),
                field('Unknown', 12, 4, view.getUint32(12, true), 'Always 8.'),
                field('Compressed size', 16, 4, bytesLabel(compressed)),
                field('Reserved', 20, 16, undefined, 'All zero.'),
            ],
        },
        field('Compressed chunks (zlib)', HEADER, data.length - HEADER, bytesLabel(data.length - HEADER), 'Open "uncompressed" in the contents to see these byte by byte.'),
    ];
    const base: Parsed = { title: 'Compressed chunk file (Petroglyph)', summary: [['Compressed', formatSize(compressed)]], fields, warnings: [] };

    let unpacked: Uint8Array;
    try {
        unpacked = inflate(data.subarray(HEADER));
    } catch (e) {
        base.warnings.push(`The data wouldn't uncompress: ${e instanceof Error ? e.message : e}`);
        return base;
    }
    const stem = name?.split(/[\\/]/).pop() ?? 'uncompressed';
    base.summary.push(['Uncompressed', formatSize(unpacked.length)]);
    base.entries = [{ name: `${stem}.chunks`, label: `${stem}.chunks`, offset: HEADER, size: unpacked.length, data: unpacked, meta: { Note: 'The file, uncompressed' } }];

    try {
        const { title, rows, text } = describe(unpacked, readChunks(unpacked));
        base.title = title;
        base.summary.push(...rows);
        base.preview = { kind: 'text', text };
    } catch (e) {
        base.warnings.push(`It uncompressed, but isn't a tree of chunks: ${e instanceof Error ? e.message : e}`);
    }
    return base;
}

const parser: FormatParser = {
    parse(data, context) {
        return sniffCompressedChunks(data) ? parseCompressed(data, context.name) : parseChunks(data);
    },
};

export default parser;
