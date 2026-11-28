import { describe, expect, it } from 'vitest';
import type { Parsed } from '../core/types';
import bmp from './bmp';
import { inspect } from './inspect';

/**
 * A .bmp of run-length compressed pixels: color i of its table is red i, so each pixel drawn says which color it was
 * given. `imageSize` is what the header says the pixels take (the stream's length unless given).
 */
function rleBitmap(bits: 4 | 8, stream: number[], width: number, height: number, imageSize = stream.length) {
    const colors = 1 << bits;
    const offset = 14 + 40 + colors * 4;
    const data = new Uint8Array(offset + stream.length);
    const v = new DataView(data.buffer);
    data.set([0x42, 0x4d]);
    v.setUint32(2, data.length, true);
    v.setUint32(10, offset, true);
    v.setUint32(14, 40, true);
    v.setInt32(18, width, true);
    v.setInt32(22, height, true);
    v.setUint16(26, 1, true);
    v.setUint16(28, bits, true);
    v.setUint32(30, bits === 8 ? 1 : 2, true);
    v.setUint32(34, imageSize, true);
    for (let i = 0; i < colors; i++) data[54 + i * 4 + 2] = i;
    data.set(stream, offset);
    return data;
}

const parse = (data: Uint8Array) => bmp.parse(data, { name: 'picture.bmp', names: [] }) as Parsed;

/** The picture's rows, the bottom row first as the examples give them: each pixel's color, or null where it's see-through. */
function rows(r: Parsed) {
    const p = r.preview!;
    if (p.kind !== 'picture') throw new Error(`a ${p.kind} preview`);
    return Array.from({ length: p.height }, (_, y) =>
        Array.from({ length: p.width }, (_, x) => {
            const o = ((p.height - 1 - y) * p.width + x) * 4;
            return p.rgba[o + 3] ? p.rgba[o] : null;
        })
    );
}

const skip = (n: number) => Array<null>(n).fill(null);

// Microsoft's worked examples, from https://learn.microsoft.com/windows/win32/gdi/bitmap-compression.
const RLE8 = [0x03, 0x04, 0x05, 0x06, 0x00, 0x03, 0x45, 0x56, 0x67, 0x00, 0x02, 0x78, 0x00, 0x02, 0x05, 0x01, 0x02, 0x78, 0x00, 0x00, 0x09, 0x1e, 0x00, 0x01];
const RLE4 = [0x03, 0x04, 0x05, 0x06, 0x00, 0x06, 0x45, 0x56, 0x67, 0x00, 0x04, 0x78, 0x00, 0x02, 0x05, 0x01, 0x04, 0x78, 0x00, 0x00, 0x09, 0x1e, 0x00, 0x01];

describe('run-length compressed bitmaps (RLE8, RLE4)', () => {
    it('unpacks Microsoft’s RLE8 example: runs, colors as they are, a move, an end of row and the end', async () => {
        const data = rleBitmap(8, RLE8, 20, 3);
        const inspected = await inspect(data, { name: 'picture.bmp', names: [] });
        expect(inspected.checks).toEqual([]);
        const r = inspected.parsed;
        expect(r.warnings).toEqual([]);
        expect(rows(r)).toEqual([
            [4, 4, 4, 6, 6, 6, 6, 6, 0x45, 0x56, 0x67, 0x78, 0x78, ...skip(7)],
            [...skip(18), 0x78, 0x78],
            [...Array(9).fill(0x1e), ...skip(11)],
        ]);
        expect(r.summary).toContainEqual(['Colors', '256 (8 bits a pixel), run-length compressed']);
        expect(r.end).toBe(data.length);
        expect(r.fields.reduce((n, f) => n + f.length, 0)).toBe(data.length);
        const pixels = r.fields.find((f) => f.name === 'Pixels')!;
        expect([pixels.offset, pixels.length]).toEqual([data.length - RLE8.length, RLE8.length]);
        expect(pixels.note).toBe('Run-length compressed (RLE8): counts and colors, row by row, the bottom row first. It skips 36 pixels, drawn see-through here.');
    });

    it('unpacks Microsoft’s RLE4 example: two colors a byte, in turn', () => {
        const r = parse(rleBitmap(4, RLE4, 27, 3));
        expect(r.warnings).toEqual([]);
        expect(rows(r)).toEqual([
            [0, 4, 0, 0, 6, 0, 6, 0, 4, 5, 5, 6, 6, 7, 7, 8, 7, 8, ...skip(9)],
            [...skip(23), 7, 8, 7, 8],
            [1, 14, 1, 14, 1, 14, 1, 14, 1, ...skip(18)],
        ]);
    });

    it('says what doesn’t fit', () => {
        const warnings = (bits: 4 | 8, stream: number[], width: number, height: number, imageSize?: number) => parse(rleBitmap(bits, stream, width, height, imageSize)).warnings;
        expect(warnings(8, [2, 1, 0, 1], 2, 1, 0)).toEqual(['It doesn’t say how many bytes its compressed pixels take (its image size is 0), as a compressed bitmap must.']);
        expect(warnings(8, [2, 1, 0, 1], 2, 1, 40)).toEqual(['It says its compressed pixels take 40 bytes, but only 4 bytes are there.']);
        expect(warnings(8, [2, 1, 0, 1, 0, 0], 2, 1)).toEqual(['Its compressed pixels end 4 bytes in, 2 bytes short of the 6 bytes its image size gives them.']);
        expect(warnings(8, [2, 1, 0, 0, 2, 1], 2, 3)).toEqual(['Its compressed pixels run out without the marker that ends the picture, at row 2 of 3 from the bottom.']);
        expect(warnings(8, [2, 1, 0, 5, 1, 2], 4, 2)).toEqual([
            'Its compressed pixels end partway through a run of 5 colors.',
            'Its compressed pixels run out without the marker that ends the picture, at row 1 of 2 from the bottom.',
        ]);
        // 5 pixels in a row of 3, then a move up past the top row and a pixel there.
        expect(warnings(8, [5, 1, 0, 2, 0, 4, 1, 1, 0, 1], 3, 2)).toEqual(['3 of its compressed pixels fall outside the picture, past a row’s end or above its top row: they’re left out here.']);
    });

    it('doesn’t draw what can’t be compressed so', () => {
        const eight = rleBitmap(8, [2, 1, 0, 1], 2, 1);
        new DataView(eight.buffer).setUint32(30, 2, true);
        expect(parse(eight).warnings).toEqual(["The picture can't be drawn: it’s run-length compressed for 4 bits a pixel (RLE4), but has 8."]);
        const topDown = rleBitmap(8, [2, 1, 0, 1], 2, 1);
        new DataView(topDown.buffer).setInt32(22, -1, true);
        expect(parse(topDown).warnings).toEqual(["The picture can't be drawn: it’s compressed and its height is negative (the top row first), which a compressed bitmap can’t be."]);
    });
});
