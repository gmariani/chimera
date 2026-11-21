import { Bytes, field } from '../../core/bytes';
import type { DocumentStyle, Field } from '../../core/types';

/**
 * Windows Help's |FONT file: how many face names and font descriptors, where each list is, then the face names, each
 * the same length, and the descriptors. Windows 3.1's and 95's compilers write 11-byte descriptors (attributes, the
 * size in half points, a family, the face's number, a text color and an unused background color), and measure
 * paragraphs in half points; MediaView's, with face names starting at 12 or more, write 42-byte ones, with styles, and
 * measure in twips. A color of 1, 1, 0 is no color: the window's own. As helpdeco's helpfile.txt describes it, and
 * helpdeco's source (GPL 2 or later, facts only) for the 1, 1, 0.
 */

export interface HelpFonts {
    styles: DocumentStyle[];
    /** Points to a unit of the topics' paragraph metrics: half points, or twips. */
    unit: number;
    fields: Field[];
    problems: string[];
}

const FAMILIES: Record<number, DocumentStyle['family']> = { 1: 'monospace', 2: 'serif', 3: 'sans-serif', 4: 'cursive', 5: 'fantasy' };
const FAMILY_NAMES: Record<number, string> = { 1: 'modern (fixed pitch)', 2: 'roman (serif)', 3: 'swiss (sans serif)', 4: 'script', 5: 'decorative' };
/** Windows' LOGFONT families, in a descriptor's high four bits. */
const LOGFONT_FAMILIES: Record<number, DocumentStyle['family']> = { 1: 'serif', 2: 'sans-serif', 3: 'monospace', 4: 'cursive', 5: 'fantasy' };

/** Where each thing is in MediaView's 42-byte descriptors: italic, underline, strikeout and double underline in a row. */
const MEDIAVIEW = {
    new: { face: 1, color: 3, height: 14, weight: 30, italic: 34, family: 41 },
    mvb: { face: 0, color: 6, height: 12, weight: 28, italic: 32, family: 39 },
};

const hex = (r: number, g: number, b: number) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
/** A color, or undefined for 1, 1, 0: the window's own. */
const colorAt = (data: Uint8Array, p: number) => (data[p] === 1 && data[p + 1] === 1 && data[p + 2] === 0 ? undefined : hex(data[p], data[p + 1], data[p + 2]));

export function readFonts(data: Uint8Array, at: number, end: number): HelpFonts {
    const b = new Bytes(data);
    const problems: string[] = [];
    const styles: DocumentStyle[] = [];
    if (at + 8 > end) return { styles, unit: 0.5, fields: [], problems: ['Its |FONT file is too short for its header.'] };
    const faceCount = b.u16(at);
    const count = b.u16(at + 2);
    const facesAt = b.u16(at + 4);
    const descriptorsAt = b.u16(at + 6);
    const kind = facesAt >= 16 ? 'mvb' : facesAt >= 12 ? 'new' : 'old';
    const size = kind === 'old' ? 11 : 42;
    const unit = kind === 'old' ? 0.5 : 0.05;
    const fields: Field[] = [
        {
            name: 'Header',
            offset: at,
            length: Math.min(end - at, kind === 'mvb' ? 16 : kind === 'new' ? 12 : 8),
            children: [
                field('Face names', at, 2, faceCount),
                field('Fonts', at + 2, 2, count),
                field('Face names at', at + 4, 2, facesAt, 'From the start of the file. 12 or more: MediaView’s longer descriptors.'),
                field('Fonts at', at + 6, 2, descriptorsAt),
                ...(facesAt >= 12 && at + 12 <= end ? [field('Styles', at + 8, 2, b.u16(at + 8)), field('Styles at', at + 10, 2, b.u16(at + 10))] : []),
                ...(facesAt >= 16 && at + 16 <= end ? [field('Character maps', at + 12, 2, b.u16(at + 12)), field('Character maps at', at + 14, 2, b.u16(at + 14))] : []),
            ],
        },
    ];

    // The face names: as many as it says, sharing the space before the descriptors evenly.
    const faces: string[] = [];
    const nameSize = faceCount ? Math.floor((descriptorsAt - facesAt) / faceCount) : 0;
    if (faceCount && (nameSize < 1 || at + facesAt + faceCount * nameSize > end)) problems.push(`Its |FONT file’s ${faceCount} face names don’t fit where it says they are.`);
    else if (faceCount) {
        const children: Field[] = [];
        for (let i = 0; i < faceCount; i++) {
            const p = at + facesAt + i * nameSize;
            const name = new TextDecoder('windows-1252').decode(data.subarray(p, p + nameSize)).replace(/\0.*$/s, '');
            // A multimedia file's face name has its character map's number after a comma.
            faces.push(name.replace(/,.*$/, ''));
            children.push(field(`Face ${i}`, p, nameSize, JSON.stringify(name)));
        }
        fields.push({ name: 'Face names', offset: at + facesAt, length: faceCount * nameSize, value: faces.join(', '), children });
    }

    // The fonts the topics pick by number.
    const descriptorsEnd = at + descriptorsAt + count * size;
    if (descriptorsEnd > end) problems.push(`Its |FONT file says it has ${count} fonts, more than fit in it: those past its end aren’t read.`);
    const children: Field[] = [];
    for (let i = 0; i < count && at + descriptorsAt + (i + 1) * size <= end; i++) {
        const p = at + descriptorsAt + i * size;
        let s: DocumentStyle;
        let face: number;
        if (kind === 'old') {
            const a = data[p];
            face = b.u16(p + 3);
            s = {
                face: faces[face],
                family: FAMILIES[data[p + 2]],
                size: data[p + 1] ? data[p + 1] / 2 : undefined,
                bold: !!(a & 1),
                italic: !!(a & 2),
                underline: a & 0x10 ? 'double' : a & 4 ? 'single' : undefined,
                strike: !!(a & 8),
                color: colorAt(data, p + 5),
            };
            const attributes = ['bold', 'italic', 'underlined', 'struck out', 'double underlined', 'small capitals'].filter((_, k) => a & (1 << k));
            children.push({
                name: `Font ${i}`,
                offset: p,
                length: size,
                value: describe(s),
                children: [
                    field('Attributes', p, 1, attributes.join(', ') || 'none'),
                    field('Size', p + 1, 1, `${data[p + 1] / 2} points`, 'In half points.'),
                    field('Family', p + 2, 1, FAMILY_NAMES[data[p + 2]] ?? data[p + 2]),
                    field('Face', p + 3, 2, faces[face] ?? `${face}, which it doesn’t have`),
                    field('Color', p + 5, 3, s.color ?? 'the window’s own'),
                    field('Background', p + 8, 3, colorAt(data, p + 8) ?? 'the window’s own', 'Not used.'),
                ],
            });
        } else {
            // MediaView's two kinds hold the same things in different places; its height is in points, negative.
            const o = MEDIAVIEW[kind];
            face = b.u16(p + o.face);
            const height = b.i32(p + o.height);
            s = {
                face: faces[face],
                family: LOGFONT_FAMILIES[data[p + o.family] >> 4],
                size: height ? Math.abs(height) : undefined,
                bold: b.i16(p + o.weight) > 500,
                italic: !!data[p + o.italic],
                underline: data[p + o.italic + 3] ? 'double' : data[p + o.italic + 1] ? 'single' : undefined,
                strike: !!data[p + o.italic + 2],
                color: colorAt(data, p + o.color),
            };
            children.push(field(`Font ${i}`, p, size, describe(s)));
        }
        if (s.face === undefined && faceCount) problems.push(`Font ${i} of its |FONT file names face ${face}, which it doesn’t have.`);
        styles.push(s);
    }
    if (children.length) fields.push({ name: 'Fonts', offset: at + descriptorsAt, length: children.length * size, value: `${children.length}`, children });
    return { styles, unit, fields, problems };
}

/** A style in words: "Arial, 10 points, bold, #008000". */
export function describe(s: DocumentStyle): string {
    return [s.face ?? 'no face', s.size ? `${s.size} points` : '', s.bold && 'bold', s.italic && 'italic', s.underline && `${s.underline} underline`, s.strike && 'struck out', s.color]
        .filter(Boolean)
        .join(', ');
}
