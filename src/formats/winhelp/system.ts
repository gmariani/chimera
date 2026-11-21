import { Bytes, bytesLabel, field } from '../../core/bytes';
import type { Field } from '../../core/types';
import { languageName } from '../win-resources';

/**
 * Windows Help's |SYSTEM file: 0x036C, the version of the compiler's format (15 for Windows 3.0's HC30, 21 for
 * Windows 3.1's HC31, 27 for MediaView, 33 for Windows 95's HCW), 1, when it was made, and flags (4 or 8: its topics
 * LZ77-packed, in 4 or 2 KB blocks). Then Windows 3.0's has its title; later ones have records, each a type and a size:
 * the title, the copyright, the topic it opens at, macros run when it opens, its icon, its windows, the language. As
 * helpdeco's helpfile.txt describes it.
 */

export interface HelpWindow {
    type: string;
    name: string;
    caption: string;
    /** Left, top, width, height, in thousandths of the screen. */
    place?: [number, number, number, number];
    /** CSS colors of its scrolling part and of its non-scrolling band, when it gives them. */
    background?: string;
    fixedBackground?: string;
}

export interface HelpSystem {
    minor: number;
    flags: number;
    made?: string;
    title: string;
    copyright: string;
    citation: string;
    /** The topic it opens at (a TOPICOFFSET). */
    contents?: number;
    macros: string[];
    windows: HelpWindow[];
    icon?: Uint8Array;
    language?: string;
    font?: string;
    contentsFile?: string;
    fields: Field[];
    problems: string[];
}

const RECORDS: Record<number, string> = {
    1: 'Title',
    2: 'Copyright',
    3: 'Contents topic',
    4: 'Macro run on opening',
    5: 'Icon',
    6: 'Window',
    8: 'Citation',
    9: 'Language',
    10: 'Contents file (.cnt)',
    11: 'Character set',
    12: 'Default font',
    13: 'Groups',
    14: 'Index separators',
    18: 'Language name',
    19: 'DLLs',
};

/** The compiler a format version is from. */
export function compilerOf(minor: number): string {
    return minor <= 16 ? 'Windows 3.0, HC30' : minor <= 21 ? 'Windows 3.1, HC31' : minor === 27 ? 'MediaView' : minor === 33 ? 'Windows 95, HCW 4.0' : `format ${minor}`;
}

export function readSystem(data: Uint8Array, at: number, end: number): HelpSystem {
    const b = new Bytes(data);
    const text = (from: number, to: number) => new TextDecoder('windows-1252').decode(data.subarray(from, Math.min(to, end))).replace(/\0.*$/s, '');
    const minor = b.u16(at + 2);
    const date = b.u32(at + 6);
    const flags = b.u16(at + 10);
    const s: HelpSystem = { minor, flags, title: '', copyright: '', citation: '', macros: [], windows: [], fields: [], problems: [] };
    if (b.u16(at) !== 0x036c) s.problems.push(`Its |SYSTEM file doesn’t start with 0x036C, as one does.`);
    // Seconds since 1970, as C's time_t (helpfile.txt's 1980 is a slip: the dates come out 10 years late with it).
    if (date) s.made = new Date(date * 1000).toISOString().replace('T', ' ').replace('.000Z', ' UTC');
    const children: Field[] = [
        field('Signature', at, 2, '0x036C'),
        field('Format', at + 2, 2, `${minor}: ${compilerOf(minor)}`),
        field('Major', at + 4, 2, b.u16(at + 4)),
        field('Made', at + 6, 4, s.made ?? 'not said'),
        field('Flags', at + 10, 2, flags, '4: topics LZ77-packed in 4 KB blocks; 8: in 2 KB blocks; 0: not packed.'),
    ];
    let p = at + 12;
    if (minor <= 16) {
        s.title = text(p, end);
        children.push(field('Title', p, end - p, JSON.stringify(s.title)));
        p = end;
    }
    while (p + 4 <= end) {
        const type = b.u16(p);
        const size = b.u16(p + 2);
        const v = p + 4;
        if (v + size > end) {
            s.problems.push(`A record of its |SYSTEM file (type ${type}) runs past the file’s end.`);
            children.push(field('Cut short', p, end - p, bytesLabel(end - p)));
            p = end;
            break;
        }
        let value = '';
        if (type === 1) value = s.title = text(v, v + size);
        else if (type === 2) value = s.copyright = text(v, v + size);
        else if (type === 3 && size >= 4) {
            s.contents = b.u32(v);
            value = `0x${s.contents.toString(16).toUpperCase()}`;
        } else if (type === 4) {
            value = text(v, v + size);
            s.macros.push(value);
        } else if (type === 5) {
            s.icon = data.subarray(v, v + size);
            value = bytesLabel(size);
        } else if (type === 6 && size >= 90) {
            const valid = b.u16(v);
            const w: HelpWindow = { type: text(v + 2, v + 12), name: text(v + 12, v + 21), caption: text(v + 21, v + 72) };
            if (valid & 0x78) w.place = [b.i16(v + 72), b.i16(v + 74), b.i16(v + 76), b.i16(v + 78)];
            // After the place, a maximize flag, then the two colors (COLORREFs: red, green, blue, 0).
            const color = (q: number) => `#${[data[q], data[q + 1], data[q + 2]].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
            if (valid & 0x100) w.background = color(v + 82);
            if (valid & 0x200) w.fixedBackground = color(v + 86);
            s.windows.push(w);
            value = [w.name || 'main', w.caption && JSON.stringify(w.caption)].filter(Boolean).join(', ');
        } else if (type === 8) value = s.citation = text(v, v + size);
        else if (type === 9 && size >= 2) value = s.language = languageName(b.u16(v));
        else if (type === 10) value = s.contentsFile = text(v, v + size);
        else if (type === 11 && size >= 2) value = String(b.u16(v));
        else if (type === 12 && size >= 3) value = s.font = `${text(v + 2, v + size)}, ${data[v]} points`;
        else value = size ? JSON.stringify(text(v, v + size)).slice(0, 80) : '';
        children.push({
            name: RECORDS[type] ?? `Record ${type}`,
            offset: p,
            length: 4 + size,
            value,
            children: [field('Type', p, 2, type), field('Size', p + 2, 2, bytesLabel(size)), field('Data', v, size, bytesLabel(size))],
        });
        p = v + size;
    }
    if (p < end) children.push(field('Too short for a record', p, end - p, bytesLabel(end - p)));
    s.fields = children;
    return s;
}
