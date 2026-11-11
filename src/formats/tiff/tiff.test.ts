import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { inflate } from '../../core/inflate';
import type { Field, Parsed, Preview } from '../../core/types';
import { detect } from '../index';
import { unpackBits } from './decode';
import tiff from './index';

const images = join(__dirname, '../../../samples/images');
const fromHex = (text: string) => Uint8Array.from(text.match(/../g)!, (b) => parseInt(b, 16));
const parse = (data: Uint8Array): Parsed => tiff.parse(data, { name: null, names: [] });

function picture(preview: Preview | undefined) {
    const found = preview?.kind === 'stack' ? preview.items.find((i) => i.preview.kind === 'picture')?.preview : preview;
    if (found?.kind !== 'picture') throw new Error(`expected a picture, got ${preview?.kind}`);
    return found;
}

/** The picture as rows of 1 (black) and 0 (white). */
const bilevel = (p: { width: number; height: number; rgba: Uint8Array }) =>
    Array.from({ length: p.height }, (_, y) => Array.from({ length: p.width }, (_, x) => (p.rgba[(y * p.width + x) * 4] < 128 ? '1' : '0')).join(''));

const find = (fields: Field[], name: string): Field | undefined => {
    for (const f of fields) {
        if (f.name === name) return f;
        const inside = f.children && find(f.children, name);
        if (inside) return inside;
    }
};

describe('decompression', () => {
    it("unpacks PackBits as the spec's example does", () => {
        // TIFF 6.0, section 9.
        const packed = fromHex('FEAA0280002AFDAA0380002A22F7AA');
        expect(Array.from(unpackBits(packed, 24), (b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ')).toBe('AA AA AA 80 00 2A AA AA AA AA 80 00 2A 22 AA AA AA AA AA AA AA AA AA AA');
    });

    it('inflates zlib streams, stored, fixed and dynamic', () => {
        const text = new TextEncoder().encode('TIFF '.repeat(400) + Array.from({ length: 2000 }, (_, i) => String.fromCharCode(33 + ((i * 7919) % 90))).join(''));
        for (const level of [0, 1, 9]) expect(inflate(new Uint8Array(deflateSync(text, { level })))).toEqual(text);
    });
});

describe('CCITT fax', () => {
    // A 40 × 10 picture from Pillow (libtiff): a box, a diagonal line and a corner pixel.
    const expected = [
        '0000000000000000000000000000000000000111',
        '0000000000000000000000000000000001111000',
        '0001111111111111111110000000011110000000',
        '0001111111111111111110001111100000000000',
        '0001111111111111111111110000000000000000',
        '0001111111111111111110000000000000000000',
        '0001111111111111111110000000000000000000',
        '0001111111111111111110000000000000000000',
        '0001111000000000000000000000000000000000',
        '1110000000000000000000000000000000000001',
    ];

    it('decodes Group 4 (T.6, two-dimensional)', () => {
        const file = fromHex(
            '49492a001e00000026a1ab906bbcc9c8b7e6ce0f82ffe6c1ac1a80080080090000010300010000002800000001010300010000000a00000002010300010000000100000003010300010000000400000006010300010000000100000011010400010000000800000016010300010000000a0000001701040001000000160000001c010300010000000100000000000000'
        );
        expect(bilevel(picture(parse(file).preview))).toEqual(expected);
    });

    it('decodes Group 3 (T.4, one-dimensional, rows after end-of-line codes)', () => {
        const file = fromHex(
            '49492a003a000000001350d580013506bb8004d64e2d8c004d64f605001358b82e0026b270ce0026b270ce0026b270ce0026b5835800c06a0e00090000010300010000002800000001010300010000000a00000002010300010000000100000003010300010000000300000006010300010000000100000011010400010000000800000016010300010000000a0000001701040001000000310000001c010300010000000100000000000000'
        );
        expect(bilevel(picture(parse(file).preview))).toEqual(expected);
    });
});

describe('structure', () => {
    it('is found by its header, either byte order', () => {
        expect(detect(fromHex('49492a0008000000'), 'x.bin').id).toBe('tiff');
        expect(detect(fromHex('4d4d002a00000008'), 'x.bin').id).toBe('tiff');
    });

    it("says BigTIFF isn't read rather than misreading it", () => {
        expect(() => parse(fromHex('49492b0008000000100000000000000000'))).toThrow(/BigTIFF/);
    });
});

describe('a palette picture', () => {
    /** A little-endian TIFF: the header, one IFD of SHORT and LONG entries (arrays stored after it), then the data. */
    function tiff(entries: [tag: number, type: 3 | 4, values: number[]][], data: number[]): Uint8Array {
        const ifdSize = 2 + entries.length * 12 + 4;
        const arrays = entries.filter(([, type, v]) => v.length * (type === 3 ? 2 : 4) > 4).reduce((n, [, type, v]) => n + v.length * (type === 3 ? 2 : 4), 0);
        const dataAt = 8 + ifdSize + arrays;
        const out = new Uint8Array(dataAt + data.length);
        const view = new DataView(out.buffer);
        out.set([0x49, 0x49, 42, 0, 8, 0, 0, 0]);
        view.setUint16(8, entries.length, true);
        let arrayAt = 8 + ifdSize;
        entries.forEach(([tag, type, values], i) => {
            const at = 10 + i * 12;
            const size = type === 3 ? 2 : 4;
            // The strip offset (273) is where the data goes.
            const v = tag === 273 ? [dataAt] : values;
            view.setUint16(at, tag, true);
            view.setUint16(at + 2, type, true);
            view.setUint32(at + 4, v.length, true);
            let to = at + 8;
            if (v.length * size > 4) (view.setUint32(at + 8, arrayAt, true), (to = arrayAt), (arrayAt += v.length * size));
            v.forEach((n, k) => (size === 2 ? view.setUint16(to + k * 2, n, true) : view.setUint32(to + k * 4, n, true)));
        });
        out.set(data, dataAt);
        return out;
    }

    it('draws 2-bit indexes through the ColorMap', () => {
        // Four colors: black, red, green, blue (16-bit, reds then greens then blues); two rows, 0 1 2 3 and 3 2 1 0.
        const colorMap = [0, 65535, 0, 0, 0, 0, 65535, 0, 0, 0, 0, 65535];
        const file = tiff(
            [
                [256, 3, [4]],
                [257, 3, [2]],
                [258, 3, [2]],
                [259, 3, [1]],
                [262, 3, [3]],
                [273, 4, [0]],
                [278, 3, [2]],
                [279, 4, [2]],
                [320, 3, colorMap],
            ],
            [0b00011011, 0b11100100]
        );
        const parsed = parse(file);
        expect(parsed.summary).toContainEqual(['Color', 'Palette, 2-bit']);
        const p = picture(parsed.preview);
        const colors = Array.from({ length: 8 }, (_, i) => Array.from(p.rgba.subarray(i * 4, i * 4 + 3)).join(','));
        expect(colors).toEqual(['0,0,0', '255,0,0', '0,255,0', '0,0,255', '0,0,255', '0,255,0', '255,0,0', '0,0,0']);
    });
});

describe.skipIf(!existsSync(images))('sample files', () => {
    const open = (name: string) => parse(new Uint8Array(readFileSync(join(images, name))));
    const pixel = (p: { width: number; rgba: Uint8Array }, x: number, y: number) => Array.from(p.rgba.subarray((y * p.width + x) * 4, (y * p.width + x) * 4 + 4));

    it('draws JPEG-compressed tiles or strips as libtiff does', () => {
        const parsed = open('tiff-jpeg.tif');
        expect(parsed.summary).toEqual(
            expect.arrayContaining([
                ['Size', '512 × 512'],
                ['Compression', 'JPEG'],
            ])
        );
        const p = picture(parsed.preview);
        // Pillow's (libtiff's and libjpeg's) values, within a level or two of rounding.
        for (const [x, y, expected] of [
            [0, 0, [254, 254, 254]],
            [256, 256, [49, 156, 200]],
            [511, 511, [255, 255, 255]],
            [100, 400, [182, 195, 87]],
        ] as [number, number, number[]][]) {
            expect(
                pixel(p, x, y)
                    .slice(0, 3)
                    .every((v, i) => Math.abs(v - expected[i]) <= 3),
                `${x}, ${y}`
            ).toBe(true);
        }
        expect(parsed.warnings).toEqual([]);
    });

    it('draws a Deflate-compressed RGBA picture exactly', () => {
        const parsed = open('tiff-deflate-rgba.tif');
        expect(parsed.summary).toEqual(
            expect.arrayContaining([
                ['Size', '1920 × 1080'],
                ['Compression', 'Deflate'],
            ])
        );
        const p = picture(parsed.preview);
        expect(pixel(p, 0, 0)).toEqual([4, 6, 8, 255]);
        expect(pixel(p, 960, 540)).toEqual([138, 123, 109, 255]);
        expect(pixel(p, 1919, 1079)).toEqual([0, 0, 0, 255]);
        expect(pixel(p, 300, 800)).toEqual([22, 26, 31, 255]);
        expect(find(parsed.fields, 'IFD0 data')?.value).toMatch(/^\d+ (strips?|tiles?), /);
    });
});
