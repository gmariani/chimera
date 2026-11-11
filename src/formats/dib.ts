import { Bytes } from '../core/bytes';

/**
 * Windows' device-independent bitmaps (DIBs), as icons, cursors and bitmap
 * resources store them: a header (BITMAPINFOHEADER, 40 bytes, or a later one
 * that starts the same way; OS/2 and Windows 2's 12-byte BITMAPCOREHEADER),
 * the colors for 1, 4 and 8 bits a pixel, then the rows, each padded to 4
 * bytes, bottom row first unless the height is negative.
 *
 * An icon or cursor gives double the height: the color rows, then as many rows
 * of a 1-bit mask, where 1 means see-through (or, with color under it, the
 * screen inverted). A 32-bit icon carries its own alpha, and the mask is then
 * only for older systems.
 * See https://learn.microsoft.com/windows/win32/api/wingdi/ns-wingdi-bitmapinfoheader.
 */

export interface DibInfo {
    width: number;
    height: number;
    bits: number;
    /** Colors in its table (0 for 16, 24 and 32 bits). */
    colors: number;
    headerSize: number;
    /** Where the colors, the pixels and the mask start, from the DIB's start. */
    colorsAt: number;
    pixelsAt: number;
    maskAt: number | null;
    /** How many bytes it takes in all. */
    length: number;
    /** Pixels the mask marks as the screen inverted (drawn see-through here). */
    inverted: number;
}

export type Dib = { info: DibInfo; rgba: Uint8Array } | { problem: string };

/** Decodes a DIB at `at` (at most `length` bytes) to RGBA; `masked` for icons and cursors. */
export function decodeDib(data: Uint8Array, at: number, length: number, masked: boolean): Dib {
    const b = new Bytes(data);
    const end = Math.min(data.length, at + length);
    if (at + 12 > end) return { problem: 'it’s too short for a bitmap header' };
    const size = b.u32(at);
    const core = size === 12;
    if (!core && ![40, 52, 56, 108, 124].includes(size)) return { problem: `its header is ${size} bytes, which isn’t a bitmap header’s size (40, or 12, 108, 124)` };
    if (at + size > end) return { problem: 'it’s too short for its own header' };
    const width = core ? b.u16(at + 4) : b.i32(at + 4);
    const rawHeight = core ? b.u16(at + 6) : b.i32(at + 8);
    const bits = b.u16(at + (core ? 10 : 14));
    const compression = core ? 0 : b.u32(at + 16);
    const topDown = rawHeight < 0 && !masked;
    const height = masked ? Math.floor(rawHeight / 2) : Math.abs(rawHeight);
    if (width <= 0 || height <= 0 || width > 4096 || height > 4096) return { problem: `it says it’s ${width} × ${height}` };
    if (compression !== 0) return { problem: `it’s compressed (method ${compression}), which isn’t drawn here` };
    if (![1, 4, 8, 16, 24, 32].includes(bits)) return { problem: `it has ${bits} bits a pixel` };
    const used = core ? 0 : b.u32(at + 32);
    const colors = bits <= 8 ? (used && used <= 1 << bits ? used : 1 << bits) : 0;
    const entry = core ? 3 : 4;
    const colorsAt = size;
    const stride = ((width * bits + 31) >> 5) * 4;
    const maskStride = ((width + 31) >> 5) * 4;
    const pixelsAt = colorsAt + colors * entry;
    const maskAt = masked ? pixelsAt + stride * height : null;
    const total = (maskAt ?? pixelsAt) + (masked ? maskStride : stride) * height;
    if (at + total > end) return { problem: `its ${width} × ${height} pixels run past the end of the data it’s given` };

    const rgba = new Uint8Array(width * height * 4);
    const color = (i: number) => {
        const c = at + colorsAt + i * entry;
        return i < colors ? [data[c + 2], data[c + 1], data[c]] : [0, 0, 0];
    };
    // 32-bit icons carry alpha; if every pixel's is 0, it's an older one that relies on the mask.
    let alpha = false;
    if (bits === 32) for (let i = 0; i < width * height && !alpha; i++) if (data[at + pixelsAt + i * 4 + 3]) alpha = true;
    let inverted = 0;
    for (let y = 0; y < height; y++) {
        const row = at + pixelsAt + (topDown ? y : height - 1 - y) * stride;
        const maskRow = maskAt === null ? 0 : at + maskAt + (height - 1 - y) * maskStride;
        for (let x = 0; x < width; x++) {
            const o = (y * width + x) * 4;
            let rgb: number[];
            let a = 255;
            if (bits <= 8) {
                const bit = x * bits;
                rgb = color((data[row + (bit >> 3)] >> (8 - bits - (bit & 7))) & ((1 << bits) - 1));
            } else if (bits === 16) {
                const v = data[row + x * 2] | (data[row + x * 2 + 1] << 8);
                rgb = [((v >> 10) & 31) * 8.23, ((v >> 5) & 31) * 8.23, (v & 31) * 8.23].map(Math.round);
            } else {
                const p = row + x * (bits / 8);
                rgb = [data[p + 2], data[p + 1], data[p]];
                if (bits === 32 && alpha) a = data[p + 3];
            }
            if (maskAt !== null && !(bits === 32 && alpha) && (data[maskRow + (x >> 3)] >> (7 - (x & 7))) & 1) {
                if (rgb.some((v) => v)) inverted++;
                a = 0;
            }
            rgba.set([rgb[0], rgb[1], rgb[2], a], o);
        }
    }
    return { info: { width, height, bits, colors, headerSize: size, colorsAt, pixelsAt, maskAt, length: total, inverted }, rgba };
}
