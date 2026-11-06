import { field } from '../../core/bytes';
import type { Field } from '../../core/types';
import type { PathCommand } from './raster';

/**
 * CFF (Adobe Technical Note 5176) and its Type 2 charstrings (5177): the
 * outlines in a CFF-flavored OpenType font. A header, then INDEXes (a count,
 * an offset size, offsets, then the objects): the font names, the Top DICT,
 * strings, and global subroutines. The Top DICT points to the charstrings and
 * the Private DICT (local subroutines, default widths); a CID font has a DICT
 * for each group of glyphs (FDArray), and FDSelect says which a glyph uses.
 */

export interface Index {
    offset: number;
    end: number;
    items: [number, number][];
}

/** The INDEX at `at`: each object's start and end. */
export function readIndex(data: Uint8Array, at: number): Index {
    const count = (data[at] << 8) | data[at + 1];
    if (count === 0) return { offset: at, end: at + 2, items: [] };
    const size = data[at + 2];
    const off = (i: number) => {
        let v = 0;
        for (let k = 0; k < size; k++) v = v * 256 + data[at + 3 + i * size + k];
        return v;
    };
    const base = at + 3 + (count + 1) * size - 1;
    const items: [number, number][] = Array.from({ length: count }, (_, i) => [base + off(i), base + off(i + 1)]);
    return { offset: at, end: base + off(count), items };
}

/** Top and Private DICT operators. */
const DICT_OPS: Record<string, string> = {
    '0': 'version', '1': 'Notice', '2': 'FullName', '3': 'FamilyName', '4': 'Weight', '5': 'FontBBox', '6': 'BlueValues', '7': 'OtherBlues', '8': 'FamilyBlues', '9': 'FamilyOtherBlues', '10': 'StdHW', '11': 'StdVW',
    '13': 'UniqueID', '14': 'XUID', '15': 'charset', '16': 'Encoding', '17': 'CharStrings', '18': 'Private', '19': 'Subrs', '20': 'defaultWidthX', '21': 'nominalWidthX',
    '12 0': 'Copyright', '12 1': 'isFixedPitch', '12 2': 'ItalicAngle', '12 3': 'UnderlinePosition', '12 4': 'UnderlineThickness', '12 5': 'PaintType', '12 6': 'CharstringType', '12 7': 'FontMatrix', '12 8': 'StrokeWidth',
    '12 9': 'BlueScale', '12 10': 'BlueShift', '12 11': 'BlueFuzz', '12 12': 'StemSnapH', '12 13': 'StemSnapV', '12 14': 'ForceBold', '12 17': 'LanguageGroup', '12 18': 'ExpansionFactor', '12 19': 'initialRandomSeed',
    '12 20': 'SyntheticBase', '12 21': 'PostScript', '12 22': 'BaseFontName', '12 23': 'BaseFontBlend', '12 30': 'ROS', '12 31': 'CIDFontVersion', '12 32': 'CIDFontRevision', '12 33': 'CIDFontType', '12 34': 'CIDCount',
    '12 35': 'UIDBase', '12 36': 'FDArray', '12 37': 'FDSelect', '12 38': 'FontName',
}; // prettier-ignore
/** Operators whose operands are string IDs. */
const STRING_OPS = new Set(['version', 'Notice', 'FullName', 'FamilyName', 'Weight', 'Copyright', 'PostScript', 'BaseFontName', 'FontName']);

/** The 391 standard strings come first; a font's own String INDEX follows. Only the first few are ever needed for names. */
const STANDARD_STRINGS_COUNT = 391;

export interface DictEntry {
    op: string;
    operands: number[];
    offset: number;
    length: number;
}

/** A DICT: operands (numbers in several encodings) then an operator. */
export function readDict(data: Uint8Array, start: number, end: number): DictEntry[] {
    const out: DictEntry[] = [];
    let operands: number[] = [];
    let entryStart = start;
    for (let at = start; at < end; ) {
        const b = data[at];
        if (b <= 21) {
            const op = b === 12 ? `12 ${data[at + 1]}` : String(b);
            at += b === 12 ? 2 : 1;
            out.push({ op: DICT_OPS[op] ?? `op ${op}`, operands, offset: entryStart, length: at - entryStart });
            operands = [];
            entryStart = at;
        } else if (b === 28) {
            operands.push(((data[at + 1] << 24) | (data[at + 2] << 16)) >> 16);
            at += 3;
        } else if (b === 29) {
            operands.push((data[at + 1] << 24) | (data[at + 2] << 16) | (data[at + 3] << 8) | data[at + 4]);
            at += 5;
        } else if (b === 30) {
            // A real number, as nibbles: digits, a point, E, E-, a minus sign, and an end.
            let text = '';
            for (at++; ; at++) {
                const nibbles = [data[at] >> 4, data[at] & 15];
                const stop = nibbles.some((n) => n === 15);
                for (const n of nibbles) {
                    if (n === 15) break;
                    text += n <= 9 ? String(n) : ['.', 'E', 'E-', '', '-'][n - 10];
                }
                if (stop) break;
            }
            at++;
            operands.push(Number(text));
        } else if (b >= 32 && b <= 246) {
            operands.push(b - 139);
            at++;
        } else if (b >= 247 && b <= 250) {
            operands.push((b - 247) * 256 + data[at + 1] + 108);
            at += 2;
        } else if (b >= 251 && b <= 254) {
            operands.push(-(b - 251) * 256 - data[at + 1] - 108);
            at += 2;
        } else {
            at++;
        }
    }
    return out;
}

export interface Cff {
    fields: Field[];
    name: string;
    strings: Map<string, string>;
    glyphCount: number;
    /** The outline of a glyph, in font units. */
    glyph(index: number): PathCommand[];
}

export function readCff(data: Uint8Array, base: number): Cff {
    const fields: Field[] = [
        {
            name: 'Header',
            offset: base,
            length: data[base + 2],
            children: [field('Major version', base, 1, data[base]), field('Minor version', base + 1, 1, data[base + 1]), field('Header size', base + 2, 1, data[base + 2]), field('Offset size', base + 3, 1, data[base + 3], 'Of offsets to objects in the CFF.')],
        },
    ];
    const text = (from: number, to: number) => new TextDecoder('latin1').decode(data.subarray(from, to));
    const indexField = (name: string, index: Index, describe?: (i: number, item: [number, number]) => string) => ({
        name,
        offset: index.offset,
        length: index.end - index.offset,
        value: `${index.items.length} item${index.items.length === 1 ? '' : 's'}`,
        children: [
            field('Count', index.offset, 2, index.items.length),
            ...(index.items.length ? [field('Offset size', index.offset + 2, 1, data[index.offset + 2]), field('Offsets', index.offset + 3, (index.items.length + 1) * data[index.offset + 2], `${index.items.length + 1} offsets`)] : []),
            ...(describe && index.items.length <= 64 ? index.items.map((item, i) => field(`${i}`, item[0], item[1] - item[0], describe(i, item))) : []),
        ],
    });

    const names = readIndex(data, base + data[base + 2]);
    fields.push(indexField('Name INDEX', names, (_, [a, b]) => text(a, b)));
    const topIndex = readIndex(data, names.end);
    const top = topIndex.items.length ? readDict(data, topIndex.items[0][0], topIndex.items[0][1]) : [];
    const stringIndex = readIndex(data, topIndex.end);
    const string = (sid: number) => (sid < STANDARD_STRINGS_COUNT ? `(standard string ${sid})` : stringIndex.items[sid - STANDARD_STRINGS_COUNT] ? text(...stringIndex.items[sid - STANDARD_STRINGS_COUNT]) : `(string ${sid})`);
    const showDict = (entries: DictEntry[]) => entries.map((e) => field(e.op, e.offset, e.length, STRING_OPS.has(e.op) ? string(e.operands[0]) : e.operands.join(' ')));
    fields.push({ ...indexField('Top DICT INDEX', topIndex), children: [...indexField('', topIndex).children, ...showDict(top)] });
    fields.push(indexField('String INDEX', stringIndex, (_, [a, b]) => text(a, b)));
    const globalSubrs = readIndex(data, stringIndex.end);
    fields.push(indexField('Global Subr INDEX', globalSubrs));

    const get = (dict: DictEntry[], op: string) => dict.find((e) => e.op === op)?.operands;
    const strings = new Map<string, string>();
    for (const e of top) if (STRING_OPS.has(e.op)) strings.set(e.op, string(e.operands[0]));

    const charStringsAt = get(top, 'CharStrings')?.[0];
    const charStrings = charStringsAt !== undefined ? readIndex(data, base + charStringsAt) : { offset: 0, end: 0, items: [] };
    if (charStringsAt !== undefined) fields.push(indexField('CharStrings INDEX', charStrings));

    /** A Private DICT's local subroutines and widths. */
    const readPrivate = (entry: number[] | undefined, label: string) => {
        if (!entry) return { subrs: { offset: 0, end: 0, items: [] } as Index, defaultWidth: 0, nominalWidth: 0 };
        const [size, offset] = entry;
        const dict = readDict(data, base + offset, base + offset + size);
        fields.push({ name: label, offset: base + offset, length: size, children: showDict(dict) });
        const subrsAt = get(dict, 'Subrs')?.[0];
        const subrs = subrsAt !== undefined ? readIndex(data, base + offset + subrsAt) : { offset: 0, end: 0, items: [] };
        if (subrsAt !== undefined) fields.push(indexField(`${label}: Subrs INDEX`, subrs));
        return { subrs, defaultWidth: get(dict, 'defaultWidthX')?.[0] ?? 0, nominalWidth: get(dict, 'nominalWidthX')?.[0] ?? 0 };
    };

    // A CID font's DICTs per group of glyphs, and which group each glyph is in.
    const fdArrayAt = get(top, 'FDArray')?.[0];
    const privates: ReturnType<typeof readPrivate>[] = [];
    let fdSelect: (glyph: number) => number = () => 0;
    if (fdArrayAt !== undefined) {
        const fdArray = readIndex(data, base + fdArrayAt);
        fields.push(indexField('FDArray INDEX', fdArray));
        fdArray.items.forEach(([a, b], i) => privates.push(readPrivate(get(readDict(data, a, b), 'Private'), `Private DICT ${i}`)));
        const selectAt = base + (get(top, 'FDSelect')?.[0] ?? 0);
        const format = data[selectAt];
        if (format === 0) fdSelect = (g) => data[selectAt + 1 + g];
        else if (format === 3) {
            const ranges = (data[selectAt + 1] << 8) | data[selectAt + 2];
            fdSelect = (g) => {
                for (let r = 0; r < ranges; r++) {
                    const at = selectAt + 3 + r * 3;
                    const next = (data[at + 3] << 8) | data[at + 4];
                    if (g >= ((data[at] << 8) | data[at + 1]) && g < next) return data[at + 2];
                }
                return 0;
            };
        }
    } else {
        privates.push(readPrivate(get(top, 'Private'), 'Private DICT'));
    }

    return {
        fields,
        name: names.items[0] ? text(...names.items[0]) : '',
        strings,
        glyphCount: charStrings.items.length,
        glyph: (index) => {
            const item = charStrings.items[index];
            if (!item) return [];
            const p = privates[fdSelect(index)] ?? privates[0];
            return charstring(data, item, globalSubrs, p.subrs);
        },
    };
}

const bias = (index: Index) => (index.items.length < 1240 ? 107 : index.items.length < 33900 ? 1131 : 32768);

/** Runs a Type 2 charstring, collecting its outline. */
function charstring(data: Uint8Array, item: [number, number], globals: Index, locals: Index): PathCommand[] {
    const path: PathCommand[] = [];
    const stack: number[] = [];
    let x = 0;
    let y = 0;
    let stems = 0;
    let widthDone = false;
    let open = false;
    let depth = 0;
    const moveTo = (dx: number, dy: number) => {
        if (open) path.push(['Z']);
        x += dx;
        y += dy;
        path.push(['M', x, y]);
        open = true;
    };
    const lineTo = (dx: number, dy: number) => {
        x += dx;
        y += dy;
        path.push(['L', x, y]);
    };
    const curveTo = (dx1: number, dy1: number, dx2: number, dy2: number, dx3: number, dy3: number) => {
        const x1 = x + dx1;
        const y1 = y + dy1;
        const x2 = x1 + dx2;
        const y2 = y1 + dy2;
        x = x2 + dx3;
        y = y2 + dy3;
        path.push(['C', x1, y1, x2, y2, x, y]);
    };
    /** The first operator may have the glyph's width before its operands. */
    const width = (expected: (n: number) => boolean) => {
        if (!widthDone && !expected(stack.length)) stack.shift();
        widthDone = true;
    };

    const run = (start: number, stop: number): boolean => {
        if (++depth > 10) throw new Error('Subroutines nest too deep.');
        for (let at = start; at < stop; ) {
            const b = data[at];
            if (b >= 32 || b === 28) {
                if (b === 28) ((stack.push(((data[at + 1] << 24) | (data[at + 2] << 16)) >> 16)), (at += 3));
                else if (b <= 246) (stack.push(b - 139), at++);
                else if (b <= 250) ((stack.push((b - 247) * 256 + data[at + 1] + 108)), (at += 2));
                else if (b <= 254) ((stack.push(-(b - 251) * 256 - data[at + 1] - 108)), (at += 2));
                else ((stack.push(((data[at + 1] << 24) | (data[at + 2] << 16) | (data[at + 3] << 8) | data[at + 4]) / 65536)), (at += 5));
                continue;
            }
            at++;
            switch (b) {
                case 1: // hstem
                case 3: // vstem
                case 18: // hstemhm
                case 23: // vstemhm
                    width((n) => n % 2 === 0);
                    stems += stack.length >> 1;
                    stack.length = 0;
                    break;
                case 19: // hintmask
                case 20: // cntrmask
                    width((n) => n % 2 === 0);
                    stems += stack.length >> 1;
                    stack.length = 0;
                    at += (stems + 7) >> 3;
                    break;
                case 21: // rmoveto
                    width((n) => n === 2);
                    moveTo(stack[0], stack[1]);
                    stack.length = 0;
                    break;
                case 22: // hmoveto
                    width((n) => n === 1);
                    moveTo(stack[0], 0);
                    stack.length = 0;
                    break;
                case 4: // vmoveto
                    width((n) => n === 1);
                    moveTo(0, stack[0]);
                    stack.length = 0;
                    break;
                case 5: // rlineto
                    for (let i = 0; i + 1 < stack.length; i += 2) lineTo(stack[i], stack[i + 1]);
                    stack.length = 0;
                    break;
                case 6: // hlineto
                case 7: // vlineto
                    for (let i = 0; i < stack.length; i++) ((i % 2 === 0) === (b === 6) ? lineTo(stack[i], 0) : lineTo(0, stack[i]));
                    stack.length = 0;
                    break;
                case 8: // rrcurveto
                    for (let i = 0; i + 5 < stack.length; i += 6) curveTo(stack[i], stack[i + 1], stack[i + 2], stack[i + 3], stack[i + 4], stack[i + 5]);
                    stack.length = 0;
                    break;
                case 24: {
                    // rcurveline: curves, then a line
                    let i = 0;
                    for (; i + 7 < stack.length; i += 6) curveTo(stack[i], stack[i + 1], stack[i + 2], stack[i + 3], stack[i + 4], stack[i + 5]);
                    lineTo(stack[i], stack[i + 1]);
                    stack.length = 0;
                    break;
                }
                case 25: {
                    // rlinecurve: lines, then a curve
                    let i = 0;
                    for (; i + 7 < stack.length; i += 2) lineTo(stack[i], stack[i + 1]);
                    curveTo(stack[i], stack[i + 1], stack[i + 2], stack[i + 3], stack[i + 4], stack[i + 5]);
                    stack.length = 0;
                    break;
                }
                case 26: {
                    // vvcurveto
                    let i = 0;
                    let dx1 = 0;
                    if (stack.length % 2) dx1 = stack[i++];
                    for (; i + 3 < stack.length; i += 4, dx1 = 0) curveTo(dx1, stack[i], stack[i + 1], stack[i + 2], 0, stack[i + 3]);
                    stack.length = 0;
                    break;
                }
                case 27: {
                    // hhcurveto
                    let i = 0;
                    let dy1 = 0;
                    if (stack.length % 2) dy1 = stack[i++];
                    for (; i + 3 < stack.length; i += 4, dy1 = 0) curveTo(stack[i], dy1, stack[i + 1], stack[i + 2], stack[i + 3], 0);
                    stack.length = 0;
                    break;
                }
                case 30: // vhcurveto
                case 31: {
                    // hvcurveto: alternating, the last curve taking an extra final operand
                    let horizontal = b === 31;
                    for (let i = 0; i + 3 < stack.length; i += 4) {
                        const last = i + 5 === stack.length ? stack[i + 4] : 0;
                        if (horizontal) curveTo(stack[i], 0, stack[i + 1], stack[i + 2], last, stack[i + 3]);
                        else curveTo(0, stack[i], stack[i + 1], stack[i + 2], stack[i + 3], last);
                        horizontal = !horizontal;
                    }
                    stack.length = 0;
                    break;
                }
                case 10: // callsubr
                case 29: {
                    // callgsubr
                    const subrs = b === 10 ? locals : globals;
                    const sub = subrs.items[stack.pop()! + bias(subrs)];
                    if (sub && run(sub[0], sub[1])) return true;
                    break;
                }
                case 11: // return
                    depth--;
                    return false;
                case 14: // endchar
                    width((n) => n === 0 || n === 4);
                    if (open) path.push(['Z']);
                    open = false;
                    return true;
                case 12: {
                    const op = data[at++];
                    const s = stack;
                    if (op === 35) {
                        // flex
                        curveTo(s[0], s[1], s[2], s[3], s[4], s[5]);
                        curveTo(s[6], s[7], s[8], s[9], s[10], s[11]);
                    } else if (op === 34) {
                        // hflex
                        const y0 = y;
                        curveTo(s[0], 0, s[1], s[2], s[3], 0);
                        curveTo(s[4], 0, s[5], y0 - y, s[6], 0);
                    } else if (op === 36) {
                        // hflex1
                        const y0 = y;
                        curveTo(s[0], s[1], s[2], s[3], s[4], 0);
                        curveTo(s[5], 0, s[6], s[7], s[8], y0 - y - s[7]);
                    } else if (op === 37) {
                        // flex1: the last point moves along whichever axis the flex moved more on, and returns on the other
                        const dx = s[0] + s[2] + s[4] + s[6] + s[8];
                        const dy = s[1] + s[3] + s[5] + s[7] + s[9];
                        curveTo(s[0], s[1], s[2], s[3], s[4], s[5]);
                        if (Math.abs(dx) > Math.abs(dy)) curveTo(s[6], s[7], s[8], s[9], s[10], -dy);
                        else curveTo(s[6], s[7], s[8], s[9], -dx, s[10]);
                    }
                    stack.length = 0;
                    break;
                }
                default:
                    stack.length = 0;
            }
        }
        depth--;
        return false;
    };
    run(item[0], item[1]);
    if (open) path.push(['Z']);
    return path;
}
