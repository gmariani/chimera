/**
 * The kinds of video an AVI holds that are drawn here: Windows bitmaps, uncompressed (1, 4 or 8 bits a pixel, indexing
 * a palette; 16 bits as 5-5-5, or as the masks BI_BITFIELDS gives; 24 and 32 bits as blue, green, red) or in
 * Microsoft's RLE (8 or 4 bits a pixel), each RLE frame drawn over the one before it.
 *
 * RLE: pairs of bytes from the bottom row up. A count and a color repeat the color, or for 4 bits alternate the color
 * byte's two halves. A count of 0 is an escape: 0 ends the row, 1 ends the picture, 2 moves right and up by the next
 * two bytes, and 3 or more is that many colors as they are, padded to an even number of bytes. See Microsoft's
 * "Bitmap Compression" (https://learn.microsoft.com/windows/win32/gdi/bitmap-compression).
 */

export interface VideoFormat {
    width: number;
    height: number;
    /** Rows stored from the top down (a negative height), not from the bottom up. */
    topDown: boolean;
    bits: number;
    /** 0 uncompressed, 1 RLE 8-bit, 2 RLE 4-bit, 3 uncompressed with masks. */
    compression: number;
    /** Red, green and blue masks, for 16 and 32 bits. */
    masks: [number, number, number];
}

/** What went wrong drawing a frame, said once for all the frames it happens in. */
export type Problem = 'past-edge' | 'past-end' | 'no-end' | 'short';

/** The bytes in a row of an uncompressed frame: whole pixels, padded to 4 bytes. */
export const strideOf = (f: VideoFormat) => Math.floor((f.width * f.bits + 31) / 32) * 4;

/**
 * Draws an RLE frame over `pixels` (palette indexes, top row first), as the frame before it left them. Says what it
 * runs into; never writes outside the picture.
 */
export function drawRle(data: Uint8Array, pixels: Uint8Array, f: VideoFormat, problems: Set<Problem>): void {
    const { width, height } = f;
    const four = f.compression === 2;
    let x = 0;
    let row = 0;
    let p = 0;
    const put = (v: number) => {
        if (x >= width || row >= height) {
            problems.add(row >= height ? 'past-end' : 'past-edge');
        } else pixels[(f.topDown ? row : height - 1 - row) * width + x] = v;
        x++;
    };
    while (p + 1 < data.length) {
        const count = data[p];
        const value = data[p + 1];
        p += 2;
        if (count) {
            for (let i = 0; i < count; i++) put(four ? (i & 1 ? value & 15 : value >> 4) : value);
        } else if (value === 0) {
            x = 0;
            row++;
        } else if (value === 1) return;
        else if (value === 2) {
            if (p + 1 >= data.length) break;
            x += data[p];
            row += data[p + 1];
            p += 2;
        } else {
            const bytes = four ? Math.ceil(value / 2) : value;
            if (p + bytes > data.length) {
                problems.add('short');
                return;
            }
            for (let i = 0; i < value; i++) put(four ? (i & 1 ? data[p + (i >> 1)] & 15 : data[p + (i >> 1)] >> 4) : data[p + i]);
            p += bytes + (bytes & 1);
        }
    }
    // Run out without the end-of-picture escape, which Video for Windows' frames (Internet Explorer 3's) and FFmpeg's
    // both end with. Stopping right after a row's end loses nothing; stopping in the middle of a row is a frame cut short.
    if (x !== 0) problems.add('no-end');
}

/** Draws an uncompressed frame of 8 bits or fewer a pixel into `pixels` (palette indexes, top row first). */
export function drawIndexed(data: Uint8Array, pixels: Uint8Array, f: VideoFormat): void {
    const stride = strideOf(f);
    const per = 8 / f.bits;
    const mask = (1 << f.bits) - 1;
    for (let y = 0; y < f.height; y++) {
        const from = (f.topDown ? y : f.height - 1 - y) * stride;
        if (from >= data.length) break;
        for (let x = 0; x < f.width; x++) {
            const at = from + Math.floor(x / per);
            if (at >= data.length) break;
            pixels[y * f.width + x] = (data[at] >> (8 - f.bits - (x % per) * f.bits)) & mask;
        }
    }
}

/**
 * Where a mask's bits are and how many, to widen them to 8 by repeating their top bits below them (5 bits abcde become
 * abcdeabc), as FFmpeg does: black stays 0, and full stays 255.
 */
function channel(mask: number): { shift: number; width: number } {
    if (!mask) return { shift: 0, width: 0 };
    let shift = 0;
    while (!((mask >>> shift) & 1)) shift++;
    let width = 0;
    while ((mask >>> (shift + width)) & 1) width++;
    return { shift, width };
}

/** A channel's value, `width` bits of it, as 8 bits. */
function widen(v: number, width: number): number {
    if (!width) return 0;
    if (width >= 8) return (v >>> (width - 8)) & 255;
    let out = v << (8 - width);
    for (let have = width; have < 8; have += width) out |= out >>> have;
    return out & 255;
}

/** Draws an uncompressed frame of 16, 24 or 32 bits a pixel as RGBA, top row first. */
export function drawTrueColor(data: Uint8Array, f: VideoFormat): Uint8Array {
    const rgba = new Uint8Array(f.width * f.height * 4);
    const stride = strideOf(f);
    const bytes = f.bits / 8;
    const [r, g, b] = f.masks.map(channel);
    const masks = f.masks;
    for (let y = 0; y < f.height; y++) {
        const from = (f.topDown ? y : f.height - 1 - y) * stride;
        for (let x = 0; x < f.width; x++) {
            const at = from + x * bytes;
            const o = (y * f.width + x) * 4;
            rgba[o + 3] = 255;
            if (at + bytes > data.length) continue;
            if (f.bits === 24 || (f.bits === 32 && f.compression === 0)) {
                rgba[o] = data[at + 2];
                rgba[o + 1] = data[at + 1];
                rgba[o + 2] = data[at];
                continue;
            }
            const v = f.bits === 16 ? data[at] | (data[at + 1] << 8) : (data[at] | (data[at + 1] << 8) | (data[at + 2] << 16) | (data[at + 3] << 24)) >>> 0;
            rgba[o] = widen((v & masks[0]) >>> r.shift, r.width);
            rgba[o + 1] = widen((v & masks[1]) >>> g.shift, g.width);
            rgba[o + 2] = widen((v & masks[2]) >>> b.shift, b.width);
        }
    }
    return rgba;
}
