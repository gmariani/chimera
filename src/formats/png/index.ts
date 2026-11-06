import { bytesLabel, field, hex } from '../../core/bytes';
import { crc32 } from '../../core/crc32';
import { inflate } from '../../core/inflate';
import type { Field, FormatParser, Preview } from '../../core/types';

/**
 * PNG pictures (ISO/IEC 15948, the W3C PNG spec): an 8-byte signature, then
 * chunks, each a big-endian length, a 4-letter type, the data and a CRC of
 * the type and data. IHDR says how the picture is stored; IDAT chunks, joined
 * and inflated, are its rows, each with a filter byte first.
 */

export const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const COLOR_TYPES: Record<number, string> = { 0: 'Grayscale', 2: 'RGB', 3: 'Palette', 4: 'Grayscale and alpha', 6: 'RGBA' };
/** Samples per pixel of each color type. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const FILTERS = ['None', 'Sub', 'Up', 'Average', 'Paeth'];

const CHUNK_NAMES: Record<string, string> = {
    IHDR: 'Header',
    PLTE: 'Palette',
    IDAT: 'Picture data',
    IEND: 'End',
    tRNS: 'Transparency',
    gAMA: 'Gamma',
    cHRM: 'Chromaticities',
    sRGB: 'sRGB rendering intent',
    iCCP: 'ICC profile',
    cICP: 'Coding-independent code points',
    tEXt: 'Text',
    zTXt: 'Compressed text',
    iTXt: 'International text',
    bKGD: 'Background color',
    pHYs: 'Pixel size',
    sBIT: 'Significant bits',
    sPLT: 'Suggested palette',
    hIST: 'Palette histogram',
    tIME: 'Last changed',
    eXIf: 'EXIF',
    acTL: 'Animation control (APNG)',
    fcTL: 'Frame control (APNG)',
    fdAT: 'Frame data (APNG)',
};

/** Adam7: each pass's first column and row, and its steps across and down. */
const ADAM7 = [
    [0, 0, 8, 8],
    [4, 0, 8, 8],
    [0, 4, 4, 8],
    [2, 0, 4, 4],
    [0, 2, 2, 4],
    [1, 0, 2, 2],
    [0, 1, 1, 2],
];

const parser: FormatParser = {
    parse(data) {
        if (!PNG_SIGNATURE.every((b, i) => data[i] === b)) throw new Error('No PNG signature.');
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const fields: Field[] = [field('Signature', 0, 8, '89 PNG CR LF SUB LF', 'Its bytes catch transfers that mangle line endings or the 8th bit.')];
        const warnings: string[] = [];
        const texts: string[] = [];
        const idat: Uint8Array[] = [];
        let header: { width: number; height: number; depth: number; color: number; interlace: number } | null = null;
        let palette: Uint8Array | null = null;
        let transparency: Uint8Array | null = null;
        let frames = 0;

        let at = 8;
        for (; at + 12 <= data.length; ) {
            const length = view.getUint32(at);
            const type = String.fromCharCode(...data.subarray(at + 4, at + 8));
            const body = at + 8;
            if (body + length + 4 > data.length) {
                warnings.push(`The ${type} chunk at ${at} runs past the end of the file.`);
                break;
            }
            const chunk = data.subarray(body, body + length);
            const crc = view.getUint32(body + length);
            const crcOk = crc32(data.subarray(at + 4, body + length)) === crc;
            if (!crcOk) warnings.push(`The ${type} chunk at ${at} fails its CRC.`);
            // The case of each letter is a flag: critical, public, reserved, safe to copy.
            const flags = `${type[0] === type[0].toUpperCase() ? 'Critical' : 'Ancillary'}, ${type[1] === type[1].toUpperCase() ? 'public' : 'private'}, ${type[3] === type[3].toUpperCase() ? 'unsafe to copy' : 'safe to copy'}`;
            const children: Field[] = [field('Length', at, 4, length), field('Type', at + 4, 4, type, flags + '.')];
            let value: string | undefined;
            const u32 = (o: number) => view.getUint32(body + o);

            switch (type) {
                case 'IHDR':
                    header = { width: u32(0), height: u32(4), depth: chunk[8], color: chunk[9], interlace: chunk[12] };
                    value = `${header.width} × ${header.height}, ${COLOR_TYPES[header.color] ?? `color type ${header.color}`}, ${header.depth}-bit`;
                    children.push(
                        field('Width', body, 4, header.width),
                        field('Height', body + 4, 4, header.height),
                        field('Bit depth', body + 8, 1, header.depth, 'Bits per sample, or per palette index.'),
                        field('Color type', body + 9, 1, `${header.color} (${COLOR_TYPES[header.color] ?? 'unknown'})`, '1: palette, 2: color, 4: alpha, added together.'),
                        field('Compression', body + 10, 1, chunk[10], '0 is deflate, the only one.'),
                        field('Filter method', body + 11, 1, chunk[11], '0: the five row filters, the only method.'),
                        field('Interlace', body + 12, 1, `${chunk[12]} (${chunk[12] ? 'Adam7' : 'None'})`),
                    );
                    break;
                case 'PLTE':
                    palette = chunk;
                    value = `${length / 3} colors`;
                    children.push(field('Colors', body, length, value, 'Red, green, blue, 8 bits each.'));
                    break;
                case 'tRNS':
                    transparency = chunk;
                    children.push(field('Alpha', body, length, header?.color === 3 ? `${length} palette alphas` : 'The transparent color'));
                    break;
                case 'IDAT':
                    idat.push(chunk);
                    children.push(field('Data', body, length, bytesLabel(length), 'Part of one deflate stream that runs across every IDAT.'));
                    break;
                case 'gAMA':
                    value = String(u32(0) / 100000);
                    children.push(field('Gamma', body, 4, value, 'Times 100,000.'));
                    break;
                case 'sRGB':
                    value = ['Perceptual', 'Relative colorimetric', 'Saturation', 'Absolute colorimetric'][chunk[0]] ?? String(chunk[0]);
                    children.push(field('Rendering intent', body, 1, value));
                    break;
                case 'pHYs': {
                    const unit = chunk[8] === 1 ? 'per meter' : '(aspect ratio only)';
                    value = `${u32(0)} × ${u32(4)} ${unit}`;
                    children.push(field('Pixels per unit, X', body, 4, u32(0)), field('Pixels per unit, Y', body + 4, 4, u32(4)), field('Unit', body + 8, 1, `${chunk[8]} (${chunk[8] === 1 ? 'meter' : 'unknown'})`));
                    break;
                }
                case 'tIME': {
                    const p = (n: number) => String(n).padStart(2, '0');
                    value = `${view.getUint16(body)}-${p(chunk[2])}-${p(chunk[3])} ${p(chunk[4])}:${p(chunk[5])}:${p(chunk[6])} UTC`;
                    children.push(field('Time', body, 7, value));
                    break;
                }
                case 'tEXt':
                case 'zTXt':
                case 'iTXt': {
                    const keyEnd = chunk.indexOf(0);
                    const key = new TextDecoder('latin1').decode(chunk.subarray(0, keyEnd));
                    let text = '';
                    let textAt = keyEnd + 1;
                    try {
                        if (type === 'tEXt') text = new TextDecoder('latin1').decode(chunk.subarray(textAt));
                        else if (type === 'zTXt') text = new TextDecoder('latin1').decode(inflate(chunk.subarray((textAt += 1))));
                        else {
                            // Compressed flag, method, language tag, translated keyword, then the text.
                            const compressed = chunk[textAt];
                            let p = textAt + 2;
                            p = chunk.indexOf(0, p) + 1;
                            p = chunk.indexOf(0, p) + 1;
                            textAt = p;
                            text = new TextDecoder().decode(compressed ? inflate(chunk.subarray(p)) : chunk.subarray(p));
                        }
                    } catch (e) {
                        warnings.push(`The ${type} chunk "${key}" couldn't be read: ${(e as Error).message}`);
                    }
                    value = key;
                    texts.push(`${key}:\n${text}`);
                    children.push(field('Keyword', body, keyEnd, key), field('Text', body + textAt, length - textAt, text.length > 60 ? `${text.slice(0, 60)}…` : text));
                    break;
                }
                case 'acTL':
                    frames = u32(0);
                    value = `${frames} frames, ${u32(4) || 'endless'} plays`;
                    children.push(field('Frames', body, 4, frames), field('Plays', body + 4, 4, u32(4), '0: forever.'));
                    break;
                default:
                    if (length) children.push(field('Data', body, length, bytesLabel(length)));
            }
            children.push(field('CRC', body + length, 4, `${hex(crc)}${crcOk ? '' : ' (wrong)'}`, 'CRC-32 of the type and data.'));
            fields.push({ name: `${type} (${CHUNK_NAMES[type] ?? 'Unknown'})`, offset: at, length: length + 12, value, children });
            at = body + length + 4;
            if (type === 'IEND') break;
        }
        if (at < data.length) fields.push(field('After the end', at, data.length - at, bytesLabel(data.length - at), 'Not part of the PNG.'));
        if (!header) throw new Error('There\'s no IHDR chunk.');

        let preview: Preview | undefined;
        try {
            const joined = new Uint8Array(idat.reduce((n, c) => n + c.length, 0));
            idat.reduce((o, c) => (joined.set(c, o), o + c.length), 0);
            preview = { kind: 'picture', width: header.width, height: header.height, rgba: decodePng(header, inflate(joined), palette, transparency) };
        } catch (e) {
            warnings.push(`The picture couldn't be drawn: ${(e as Error).message}`);
        }
        if (texts.length) preview = { kind: 'stack', items: [...(preview ? [{ title: 'Picture', preview }] : []), { title: 'Text', preview: { kind: 'text', text: texts.join('\n\n') } }] };

        return {
            title: frames ? 'Picture (APNG, animated PNG)' : 'Picture (PNG)',
            summary: [
                ['Size', `${header.width} × ${header.height}`],
                ['Color', `${COLOR_TYPES[header.color] ?? header.color}, ${header.depth}-bit${transparency ? ', with transparency' : ''}`],
                ['Interlace', header.interlace ? 'Adam7' : 'None'],
                ...(frames ? [['Frames', `${frames} (the first is shown)`] as [string, string]] : []),
            ],
            fields,
            preview,
            warnings,
        };
    },
};

/** Undoes each row's filter, then reads the samples (every pass, if interlaced) into RGBA. */
export function decodePng(h: { width: number; height: number; depth: number; color: number; interlace: number }, raw: Uint8Array, palette: Uint8Array | null, trns: Uint8Array | null): Uint8Array {
    const channels = CHANNELS[h.color];
    if (!channels) throw new Error(`Unknown color type ${h.color}.`);
    const bpp = Math.max(1, (channels * h.depth) >> 3);
    const rgba = new Uint8Array(h.width * h.height * 4);
    const max = (1 << h.depth) - 1;
    // The transparent color, for types 0 and 2.
    const key = trns && h.color === 0 ? [(trns[0] << 8) | trns[1]] : trns && h.color === 2 ? [0, 2, 4].map((i) => (trns[i] << 8) | trns[i + 1]) : null;
    let at = 0;
    const passes = h.interlace ? ADAM7 : [[0, 0, 1, 1]];
    for (const [x0, y0, dx, dy] of passes) {
        const w = Math.ceil((h.width - x0) / dx);
        const rows = Math.ceil((h.height - y0) / dy);
        if (w <= 0 || rows <= 0) continue;
        const stride = Math.ceil((w * channels * h.depth) / 8);
        let previous = new Uint8Array(stride);
        for (let r = 0; r < rows; r++) {
            const filter = raw[at];
            const line = raw.slice(at + 1, at + 1 + stride);
            at += 1 + stride;
            if (line.length < stride) throw new Error('The picture data ends early.');
            unfilter(filter, line, previous, bpp);
            previous = line;
            const sample = (n: number): number => {
                if (h.depth === 8) return line[n];
                if (h.depth === 16) return (line[n * 2] << 8) | line[n * 2 + 1];
                const bit = n * h.depth;
                return (line[bit >> 3] >> (8 - h.depth - (bit & 7))) & max;
            };
            const to8 = (v: number) => (h.depth === 16 ? v >> 8 : h.depth === 8 ? v : Math.round((v * 255) / max));
            for (let i = 0; i < w; i++) {
                const o = (((y0 + r * dy) * h.width) + x0 + i * dx) * 4;
                const s = i * channels;
                let px: number[];
                switch (h.color) {
                    case 0: {
                        const v = sample(s);
                        px = [to8(v), to8(v), to8(v), key && v === key[0] ? 0 : 255];
                        break;
                    }
                    case 2: {
                        const [r16, g16, b16] = [sample(s), sample(s + 1), sample(s + 2)];
                        px = [to8(r16), to8(g16), to8(b16), key && r16 === key[0] && g16 === key[1] && b16 === key[2] ? 0 : 255];
                        break;
                    }
                    case 3: {
                        const p = sample(s);
                        px = palette ? [palette[p * 3], palette[p * 3 + 1], palette[p * 3 + 2], trns && p < trns.length ? trns[p] : 255] : [0, 0, 0, 255];
                        break;
                    }
                    case 4:
                        px = [to8(sample(s)), to8(sample(s)), to8(sample(s)), to8(sample(s + 1))];
                        break;
                    default:
                        px = [to8(sample(s)), to8(sample(s + 1)), to8(sample(s + 2)), to8(sample(s + 3))];
                }
                rgba.set(px, o);
            }
        }
    }
    return rgba;
}

/** The five filters: each byte was stored as its difference from a prediction (left, up, their average, or Paeth's pick). */
function unfilter(filter: number, line: Uint8Array, up: Uint8Array, bpp: number) {
    for (let i = 0; i < line.length; i++) {
        const a = i >= bpp ? line[i - bpp] : 0;
        const b = up[i];
        const c = i >= bpp ? up[i - bpp] : 0;
        switch (filter) {
            case 0:
                return;
            case 1:
                line[i] = (line[i] + a) & 0xff;
                break;
            case 2:
                line[i] = (line[i] + b) & 0xff;
                break;
            case 3:
                line[i] = (line[i] + ((a + b) >> 1)) & 0xff;
                break;
            case 4: {
                const p = a + b - c;
                const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
                line[i] = (line[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
                break;
            }
            default:
                throw new Error(`Unknown row filter ${filter} (filters are ${FILTERS.join(', ')}).`);
        }
    }
}

export default parser;
