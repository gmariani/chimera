import { Bytes, bytesLabel } from '../core/bytes';

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
 *
 * A bitmap of 4 or 8 bits a pixel can be run-length compressed (RLE4, RLE8), as
 * Internet Explorer's and Windows' own DLLs keep many: pairs of a count and a
 * color, or a 0 and an escape: 0 ends a row, 1 ends the picture, 2 moves right
 * and up by the next two bytes, and 3 or more is that many colors as they are,
 * padded to 2 bytes. RLE4's colors are two to a byte, used in turn. Pixels the
 * moves and early ends skip aren't given a color: they're drawn see-through
 * here. The header's image size is how many bytes the compressed pixels take.
 * See https://learn.microsoft.com/windows/win32/gdi/bitmap-compression.
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
    /** Pixels whose color number is past the end of the color table (drawn black here). */
    beyond: number;
    /** 0 for none, 1 for RLE8, 2 for RLE4. */
    compression: number;
    /** For a compressed bitmap, the pixels it skips (drawn see-through). */
    skipped: number;
    /** What's wrong with a compressed bitmap that could still be drawn, as sentences. */
    problems: string[];
}

/** What a DIB's pixels field says they are, for the fields under it. */
export function pixelsNote(info: DibInfo, topDown = false): string {
    if (!info.compression) return `Row by row, ${topDown ? 'the top row first' : 'the bottom row first'}, each padded to 4 bytes.`;
    const skipped = info.skipped ? ` It skips ${info.skipped.toLocaleString('en-US')} pixel${info.skipped === 1 ? '' : 's'}, drawn see-through here.` : '';
    return `Run-length compressed (RLE${info.compression === 1 ? 8 : 4}): counts and colors, row by row, the bottom row first.${skipped}`;
}

/** A bitmap drawn, or why not: `unsupported` when it's a kind this doesn't draw, rather than one that's wrong. */
export type Dib = { info: DibInfo; rgba: Uint8Array } | { problem: string; unsupported?: boolean };

/**
 * Decodes a DIB at `at` (at most `length` bytes) to RGBA; `masked` for icons and cursors. `pixelsFrom`, from the DIB's
 * start, is where its pixels are when something else says so (a .bmp file's header); otherwise right after the colors.
 */
export function decodeDib(data: Uint8Array, at: number, length: number, masked: boolean, pixelsFrom?: number): Dib {
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
    const rle = (compression === 1 || compression === 2) && !masked;
    if (compression !== 0 && !rle) return { problem: `it’s compressed (method ${compression}), which isn’t drawn here`, unsupported: true };
    if (rle && bits !== (compression === 1 ? 8 : 4)) return { problem: `it’s run-length compressed for ${compression === 1 ? 8 : 4} bits a pixel (RLE${compression === 1 ? 8 : 4}), but has ${bits}` };
    if (rle && rawHeight < 0) return { problem: 'it’s compressed and its height is negative (the top row first), which a compressed bitmap can’t be' };
    if (![1, 4, 8, 16, 24, 32].includes(bits)) return { problem: `it has ${bits} bits a pixel` };
    const used = core ? 0 : b.u32(at + 32);
    const colors = bits <= 8 ? (used && used <= 1 << bits ? used : 1 << bits) : 0;
    const entry = core ? 3 : 4;
    const colorsAt = size;
    const stride = ((width * bits + 31) >> 5) * 4;
    const maskStride = ((width + 31) >> 5) * 4;
    if (pixelsFrom !== undefined && pixelsFrom < colorsAt + colors * entry)
        return { problem: `its pixels are said to start at ${pixelsFrom}, inside its own header and colors (which end at ${colorsAt + colors * entry})` };
    const pixelsAt = pixelsFrom ?? colorsAt + colors * entry;
    const rgba = new Uint8Array(width * height * 4);
    let beyond = 0;
    const color = (i: number) => {
        const c = at + colorsAt + i * entry;
        if (i < colors) return [data[c + 2], data[c + 1], data[c]];
        beyond++;
        return [0, 0, 0];
    };
    if (rle) {
        if (at + colorsAt + colors * entry > end) return { problem: 'its colors run past the end of the data it’s given' };
        const said = b.u32(at + 20);
        const there = Math.max(0, end - at - pixelsAt);
        const r = unpackRle(data, at + pixelsAt, Math.min(there, said || there), width, height, compression === 1 ? 8 : 4);
        const problems: string[] = [];
        if (!said) problems.push('It doesn’t say how many bytes its compressed pixels take (its image size is 0), as a compressed bitmap must.');
        else if (said > there) problems.push(`It says its compressed pixels take ${bytesLabel(said)}, but only ${bytesLabel(there)} are there.`);
        problems.push(...r.problems);
        if (said && r.used < Math.min(said, there))
            problems.push(`Its compressed pixels end ${bytesLabel(r.used)} in, ${bytesLabel(Math.min(said, there) - r.used)} short of the ${bytesLabel(said)} its image size gives them.`);
        let skipped = 0;
        for (let y = 0; y < height; y++)
            for (let x = 0; x < width; x++) {
                const i = r.pixels[(height - 1 - y) * width + x];
                if (i < 0) skipped++;
                else rgba.set([...color(i), 255], (y * width + x) * 4);
            }
        const length = pixelsAt + (said && said <= there ? said : r.used);
        return { info: { width, height, bits, colors, headerSize: size, colorsAt, pixelsAt, maskAt: null, length, inverted: 0, beyond, compression, skipped, problems }, rgba };
    }
    const maskAt = masked ? pixelsAt + stride * height : null;
    const total = (maskAt ?? pixelsAt) + (masked ? maskStride : stride) * height;
    if (at + total > end) return { problem: `its ${width} × ${height} pixels run past the end of the data it’s given` };

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
    return { info: { width, height, bits, colors, headerSize: size, colorsAt, pixelsAt, maskAt, length: total, inverted, beyond, compression: 0, skipped: 0, problems: [] }, rgba };
}

/**
 * Unpacks RLE8 or RLE4 pixels (`length` bytes at `at`) to color numbers, the bottom row first, -1 where it gives no
 * color; `used` is how many bytes it took, up to and with the end-of-picture marker.
 */
function unpackRle(data: Uint8Array, at: number, length: number, width: number, height: number, bits: 8 | 4): { pixels: Int16Array; used: number; problems: string[] } {
    const pixels = new Int16Array(width * height).fill(-1);
    const end = at + length;
    const problems: string[] = [];
    let p = at;
    let x = 0;
    let y = 0;
    let outside = 0;
    let ended = false;
    const put = (i: number) => {
        if (x < width && y < height) pixels[y * width + x] = i;
        else outside++;
        x++;
    };
    // Every turn takes at least 2 bytes, so the loop ends with the data.
    while (p + 2 <= end) {
        const count = data[p];
        const value = data[p + 1];
        p += 2;
        if (count) {
            for (let n = 0; n < count; n++) put(bits === 8 ? value : n & 1 ? value & 15 : value >> 4);
        } else if (value === 0) {
            x = 0;
            y++;
        } else if (value === 1) {
            ended = true;
            break;
        } else if (value === 2) {
            if (p + 2 > end) break;
            x += data[p];
            y += data[p + 1];
            p += 2;
        } else {
            const bytes = bits === 8 ? value : (value + 1) >> 1;
            if (p + bytes > end) {
                problems.push(`Its compressed pixels end partway through a run of ${value} colors.`);
                p = end;
                break;
            }
            for (let n = 0; n < value; n++) put(bits === 8 ? data[p + n] : n & 1 ? data[p + (n >> 1)] & 15 : data[p + (n >> 1)] >> 4);
            p += bytes + (bytes & 1);
        }
    }
    if (!ended)
        problems.push(
            `Its compressed pixels run out without the marker that ends the picture${y < height ? `, at row ${(y + 1).toLocaleString('en-US')} of ${height.toLocaleString('en-US')} from the bottom` : ''}.`
        );
    if (outside)
        problems.push(
            `${outside.toLocaleString('en-US')} of its compressed pixel${outside === 1 ? ' falls' : 's fall'} outside the picture, past a row’s end or above its top row: ${outside === 1 ? 'it’s' : 'they’re'} left out here.`
        );
    return { pixels, used: Math.min(p, end) - at, problems };
}
