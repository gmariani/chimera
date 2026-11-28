import { Bytes, bytesLabel, field, fileTime, hex } from '../../core/bytes';
import type { Field, FormatParser } from '../../core/types';

/**
 * Property sets: what a compound file says about itself, in its "\x05SummaryInformation" and
 * "\x05DocumentSummaryInformation" streams. Office keeps a document's title, author, dates, program and counts there,
 * and Tiberian Sun and Red Alert 2 a saved game's name. A stream is a header (0xFFFE, a version, the system that
 * wrote it, a class ID, and one or two sets, each a format ID and where it starts), then each set: its size, how many
 * properties it has, each property's ID and where its value is, then the values, each a type and the value, padded
 * to 4 bytes. Strings are in the set's code page (property 1) unless they're UTF-16.
 * See [MS-OLEPS], "Object Linking and Embedding (OLE) Property Set Data Structures"
 * (https://learn.microsoft.com/openspecs/windows_protocols/ms-oleps), and for the summary information's properties,
 * https://learn.microsoft.com/windows/win32/stg/the-summary-information-property-set.
 */

/** The format IDs of the sets, as they're stored (the first three parts little-endian). */
const SUMMARY = 'e0859ff2f94f6810ab9108002b27b3d9';
const DOCUMENT = '02d5cdd59c2e1b10939708002b2cf9ae';
const USER = '05d5cdd59c2e1b10939708002b2cf9ae';

const SUMMARY_NAMES: Record<number, string> = {
    2: 'Title',
    3: 'Subject',
    4: 'Author',
    5: 'Keywords',
    6: 'Comments',
    7: 'Template',
    8: 'Last saved by',
    9: 'Revision',
    10: 'Time spent editing',
    11: 'Last printed',
    12: 'Created',
    13: 'Last saved',
    14: 'Pages',
    15: 'Words',
    16: 'Characters',
    17: 'Thumbnail',
    18: 'Program',
    19: 'Security',
};
const DOCUMENT_NAMES: Record<number, string> = {
    2: 'Category',
    3: 'Presentation format',
    4: 'Bytes',
    5: 'Lines',
    6: 'Paragraphs',
    7: 'Slides',
    8: 'Notes',
    9: 'Hidden slides',
    10: 'Sound and video clips',
    11: 'Thumbnail cropped',
    12: 'Headings',
    13: 'Parts',
    14: 'Manager',
    15: 'Company',
    16: 'Links up to date',
    17: 'Characters with spaces',
    19: 'Shared',
    22: 'Hyperlinks changed',
    23: 'Program version',
};
/** What the summary's Security property's bits mean. */
const SECURITY: [number, string][] = [
    [1, 'password protected'],
    [2, 'read-only recommended'],
    [4, 'read-only'],
    [8, 'locked for annotations'],
];

const TYPES: Record<number, string> = {
    2: '16-bit number',
    3: '32-bit number',
    5: 'decimal number',
    11: 'yes or no',
    18: '16-bit number',
    19: '32-bit number',
    30: 'string',
    31: 'UTF-16 string',
    64: 'date',
    65: 'bytes',
    71: 'clipboard data',
};

/** Sets hold far fewer: past this, the rest are left unread (a count can say billions). */
const MOST = 1000;

export interface Property {
    /** Which set it's in: 'summary', 'document', 'user', or the set's format ID. */
    set: string;
    /** The set's name, for people. */
    group: string;
    id: number;
    name: string;
    value: string;
}

export interface PropertySets {
    properties: Property[];
    fields: Field[];
    end: number;
    problems: string[];
}

/** A property set stream's sets and their values. Throws when it doesn't start like one. */
export function readPropertySets(data: Uint8Array): PropertySets {
    const b = new Bytes(data);
    if (data.length < 48 || b.u16(0) !== 0xfffe) throw new Error('This isn’t a property set: it doesn’t start with 0xFFFE.');
    const version = b.u16(2);
    const count = b.u32(24);
    if (version > 1) throw new Error(`This isn’t a property set: it says it’s version ${version}, and there are only 0 and 1.`);
    if (count < 1 || count > 2) throw new Error(`This isn’t a property set: it says it holds ${count.toLocaleString('en-US')} sets, and a property set stream holds 1 or 2.`);
    if (data.length < 28 + count * 20) throw new Error('This isn’t a property set: it’s too short for its own list of sets.');
    const problems: string[] = [];
    const properties: Property[] = [];
    const guid = (at: number) => Array.from(data.subarray(at, at + 16), (v) => v.toString(16).padStart(2, '0')).join('');
    const os = b.u32(4);
    const fields: Field[] = [
        {
            name: 'Header',
            offset: 0,
            length: 28 + count * 20,
            value: `${count} set${count === 1 ? '' : 's'}`,
            children: [
                field('Byte order', 0, 2, '0xFFFE', 'Always 0xFFFE: the numbers are little-endian.'),
                field('Version', 2, 2, version, version ? 'Version 1: it may use the types and names version 0 can’t.' : undefined),
                field('Written on', 4, 4, `${['Windows 3.1 (16-bit)', 'Macintosh', 'Windows (32-bit)'][os >>> 16] ?? `system ${os >>> 16}`}, version ${(os >> 8) & 255}.${os & 255}`),
                field('Class ID', 8, 16, guid(8) === '0'.repeat(32) ? 'none' : guid(8)),
                field('Sets', 24, 4, count),
                ...Array.from({ length: count }, (_, i) => [
                    field(`Set ${i + 1}: format ID`, 28 + i * 20, 16, setName(guid(28 + i * 20))),
                    field(`Set ${i + 1}: at`, 44 + i * 20, 4, b.u32(44 + i * 20).toLocaleString('en-US')),
                ]).flat(),
            ],
        },
    ];
    let end = 28 + count * 20;
    for (let s = 0; s < count; s++) {
        const id = guid(28 + s * 20);
        const set = id === SUMMARY ? 'summary' : id === DOCUMENT ? 'document' : id === USER ? 'user' : id;
        const at = b.u32(44 + s * 20);
        const size = b.u32(at);
        const said = b.u32(at + 4);
        if (at < end || at + 8 > data.length) {
            problems.push(`Its ${setName(id)} is said to start at ${at.toLocaleString('en-US')}, ${at < end ? 'inside the header' : 'past the end of the stream'}.`);
            continue;
        }
        if (at + size > data.length) problems.push(`Its ${setName(id)} says it’s ${bytesLabel(size)}, but only ${bytesLabel(data.length - at)} are left in the stream.`);
        const setEnd = Math.min(data.length, at + Math.max(size, 8));
        // The list ends where the first value starts, whatever the count says: past it would be values read as places.
        const room = Math.floor((setEnd - at - 8) / 8);
        let n = 0;
        let firstValue = setEnd - at;
        while (n < Math.min(said, room, MOST) && 8 + n * 8 < firstValue) firstValue = Math.min(firstValue, b.u32(at + 12 + n++ * 8));
        if (said > n)
            problems.push(
                `Its ${setName(id)} says it has ${said.toLocaleString('en-US')} properties, but ${n < Math.min(room, MOST) ? `only ${n.toLocaleString('en-US')} are listed before its values start` : `there’s room to list only ${n.toLocaleString('en-US')}`}.`
            );
        const children: Field[] = [field('Size', at, 4, bytesLabel(size)), field('Properties', at + 4, 4, said)];
        const index: { id: number; offset: number }[] = [];
        for (let i = 0; i < n; i++) index.push({ id: b.u32(at + 8 + i * 8), offset: b.u32(at + 12 + i * 8) });
        children.push({
            name: 'Where each is',
            offset: at + 8,
            length: n * 8,
            value: `${n}`,
            children: index.map((p, i) => field(`Property ${p.id}`, at + 8 + i * 8, 8, `at ${p.offset.toLocaleString('en-US')}`, 'Its ID, and where its value is from the set’s start.')),
        });
        // The code page the strings are in: property 1, a 16-bit number (1252 for Western Windows, 1200 for UTF-16).
        const codePageAt = index.find((p) => p.id === 1);
        const codePage = codePageAt && b.u16(at + codePageAt.offset) === 2 ? b.u16(at + codePageAt.offset + 4) : 1252;
        const names = set === 'summary' ? SUMMARY_NAMES : set === 'document' ? DOCUMENT_NAMES : {};
        // The user-defined set names its own properties, in a dictionary (property 0).
        const dictionary = new Map<number, string>();
        const values: Field[] = [];
        for (const p of [...index].sort((x, y) => x.offset - y.offset)) {
            const o = at + p.offset;
            if (p.offset < 8 + n * 8 || o + 4 > setEnd) {
                problems.push(`Property ${p.id} of its ${setName(id)} is said to be at ${p.offset.toLocaleString('en-US')}, ${o + 4 > setEnd ? 'past the set’s end' : 'inside the set’s own list'}.`);
                continue;
            }
            if (p.id === 0) {
                const d = readDictionary(b, o, setEnd, codePage, dictionary);
                values.push(field('Names (dictionary)', o, d.length, `${dictionary.size}`, 'The names of the properties this set defines itself.'));
                if (d.problem) problems.push(`The names in its ${setName(id)}: ${d.problem}`);
                continue;
            }
            const v = readValue(b, o, setEnd, codePage);
            const name = p.id === 1 ? 'Code page' : p.id === 0x80000000 ? 'Locale' : (names[p.id] ?? dictionary.get(p.id) ?? `Property ${p.id}`);
            let value = v.value;
            if (set === 'summary' && p.id === 10 && v.type === 64) value = duration(b.u32(o + 4), b.u32(o + 8));
            if (set === 'summary' && p.id === 19 && (v.type === 3 || v.type === 19)) {
                const bits = b.u32(o + 4);
                value =
                    SECURITY.filter(([bit]) => bits & bit)
                        .map(([, w]) => w)
                        .join(', ') || 'none';
            }
            if (p.id === 1 && v.type === 2) value = codePageName(codePage);
            if (v.problem) problems.push(`${name}, in its ${setName(id)}: ${v.problem}`);
            values.push(field(name, o, v.length, value, TYPES[v.type] ? undefined : `Of type 0x${hex(v.type, 4)}, which isn’t read here.`));
            if (p.id !== 1 && p.id !== 0x80000000 && v.readable) properties.push({ set, group: setName(id), id: p.id, name, value });
        }
        // Names from the dictionary come after the values that use them: name those found before it.
        for (const prop of properties) if (prop.set === set && prop.name === `Property ${prop.id}` && dictionary.has(prop.id)) prop.name = dictionary.get(prop.id)!;
        for (const f of values) {
            const m = /^Property (\d+)$/.exec(f.name);
            if (m && dictionary.has(+m[1])) f.name = dictionary.get(+m[1])!;
        }
        children.push(...values);
        fields.push({ name: setName(id)[0].toUpperCase() + setName(id).slice(1), offset: at, length: setEnd - at, value: `${n} properties`, children });
        end = Math.max(end, setEnd);
    }
    return { properties, fields, end, problems };
}

function setName(id: string): string {
    return id === SUMMARY ? 'summary information' : id === DOCUMENT ? 'document summary' : id === USER ? 'own properties (user-defined)' : `set ${id}`;
}

/** A 16-bit Windows code page's name, for the code page property. */
function codePageName(codePage: number): string {
    const named: Record<number, string> = { 1200: 'UTF-16', 65001: 'UTF-8', 1252: 'Windows Western (1252)', 437: 'DOS (437)', 10000: 'Macintosh Roman' };
    return named[codePage] ?? String(codePage);
}

function decoder(codePage: number): TextDecoder {
    try {
        return new TextDecoder(codePage === 1200 ? 'utf-16le' : codePage === 65001 ? 'utf-8' : codePage === 10000 ? 'macintosh' : `windows-${codePage}`);
    } catch {
        return new TextDecoder('windows-1252');
    }
}

/** Text up to its first NUL. */
const untilNul = (text: string) => text.split('\0')[0];

/** A typed value at `at` (its type, 2 bytes of padding, then the value): what it says, and how many bytes it takes. */
function readValue(b: Bytes, at: number, end: number, codePage: number): { type: number; value: string; length: number; readable: boolean; problem?: string } {
    const type = b.u16(at);
    const room = end - at - 4;
    const fixed = (size: number, value: () => string) =>
        room < size ? { type, value: 'cut off', length: end - at, readable: false, problem: 'it runs past the set’s end.' } : { type, value: value(), length: 4 + size, readable: true };
    switch (type) {
        case 2:
            return fixed(4, () => String(b.i16(at + 4)));
        case 18:
            return fixed(4, () => String(b.u16(at + 4)));
        case 3:
            return fixed(4, () => b.i32(at + 4).toLocaleString('en-US'));
        case 19:
            return fixed(4, () => b.u32(at + 4).toLocaleString('en-US'));
        case 5:
            return fixed(8, () => String(b.view.getFloat64(at + 4, true)));
        case 11:
            return fixed(4, () => (b.u16(at + 4) ? 'yes' : 'no'));
        case 64:
            return fixed(8, () => fileTime(b.u32(at + 4), b.u32(at + 8)) ?? (b.u32(at + 4) || b.u32(at + 8) ? 'not a date' : 'none'));
        case 30:
        case 31: {
            const count = b.u32(at + 4);
            const bytes = type === 31 ? count * 2 : count;
            if (8 + bytes > end - at) return { type, value: 'cut off', length: end - at, readable: false, problem: `it says it’s ${bytesLabel(bytes)}, past the set’s end.` };
            const text = untilNul(decoder(type === 31 ? 1200 : codePage).decode(b.data.subarray(at + 8, at + 8 + bytes)));
            return { type, value: text, length: Math.min(end - at, 8 + ((bytes + 3) & ~3)), readable: true };
        }
        case 65:
        case 71: {
            const size = b.u32(at + 4);
            if (8 + size > end - at) return { type, value: 'cut off', length: end - at, readable: false, problem: `it says it’s ${bytesLabel(size)}, past the set’s end.` };
            return { type, value: bytesLabel(size), length: Math.min(end - at, 8 + ((size + 3) & ~3)), readable: type === 65 };
        }
        default:
            // Vectors, variants and the rest: their length isn't read here, so the value is as far as the next one.
            return { type, value: `type 0x${hex(type, 4)}`, length: Math.min(4, end - at), readable: false };
    }
}

/** The dictionary of a set's own property names: how many, then each ID, length and name. */
function readDictionary(b: Bytes, at: number, end: number, codePage: number, out: Map<number, string>): { length: number; problem?: string } {
    const count = b.u32(at);
    let p = at + 4;
    for (let i = 0; i < count && i < MOST; i++) {
        if (p + 8 > end) return { length: end - at, problem: 'they run past the set’s end.' };
        const id = b.u32(p);
        const chars = b.u32(p + 4);
        const bytes = codePage === 1200 ? chars * 2 : chars;
        if (p + 8 + bytes > end) return { length: end - at, problem: 'they run past the set’s end.' };
        out.set(id, untilNul(decoder(codePage).decode(b.data.subarray(p + 8, p + 8 + bytes))));
        // UTF-16 names are padded to 4 bytes; others aren't.
        p += 8 + (codePage === 1200 ? (bytes + 3) & ~3 : bytes);
    }
    return { length: ((p - at + 3) & ~3) > end - at ? end - at : (p - at + 3) & ~3 };
}

/** 100 years in FILETIME's steps: no one edits a file that long. */
const CENTURY = 100 * 365.25 * 86400 * 1e7;

/**
 * A FILETIME holding a span of time, not a date: the summary's time spent editing. Tiberian Sun's and Red Alert 2's
 * saved games put the date there instead: anything over a century is shown as the date it is.
 */
function duration(low: number, high: number): string {
    const steps = high * 2 ** 32 + low;
    if (steps > CENTURY) return `${fileTime(low, high) ?? 'not a date'} (a date, where a length of time belongs)`;
    const minutes = Math.round(steps / 600_000_000);
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
    const hours = Math.floor(minutes / 60);
    return `${hours.toLocaleString('en-US')} hour${hours === 1 ? '' : 's'}, ${minutes % 60} minute${minutes % 60 === 1 ? '' : 's'}`;
}

/** A property set saved from a compound file: it has no signature of its own past 0xFFFE, so it's read this way when it comes from one. */
const parser: FormatParser = {
    parse(data) {
        const r = readPropertySets(data);
        const shown = r.properties.filter((p) => p.value);
        return {
            title: 'Document properties (OLE property set)',
            summary: shown.slice(0, 12).map((p) => [p.name, p.value] as [string, string]),
            fields: r.fields,
            preview: shown.length
                ? {
                      kind: 'table',
                      columns: [
                          { key: 'name', label: 'Property' },
                          { key: 'value', label: 'Value' },
                      ],
                      groups: [...new Set(shown.map((p) => p.group))],
                      rows: shown.map((p) => ({ group: p.group, cells: { name: p.name, value: p.value } })),
                  }
                : undefined,
            end: r.end,
            warnings: r.problems,
        };
    },
};

export default parser;
