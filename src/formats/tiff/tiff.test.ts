import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { inflate } from '../../core/inflate';
import type { Field, Parsed, Preview } from '../../core/types';
import { detect } from '../index';
import { unpackBits } from './decode';
import tiff from './index';

const images = join(__dirname, '../../../JPG Samples/Image-ExifTool-10.38/t/images');
const fromHex = (text: string) => Uint8Array.from(text.match(/../g)!, (b) => parseInt(b, 16));
const parse = (data: Uint8Array): Parsed => tiff.parse(data, { name: null, names: [] });

function picture(preview: Preview | undefined) {
    const found = preview?.kind === 'stack' ? preview.items.find((i) => i.preview.kind === 'picture')?.preview : preview;
    if (found?.kind !== 'picture') throw new Error(`expected a picture, got ${preview?.kind}`);
    return found;
}

/** The picture as rows of 1 (black) and 0 (white). */
const bilevel = (p: { width: number; height: number; rgba: Uint8Array }) => Array.from({ length: p.height }, (_, y) => Array.from({ length: p.width }, (_, x) => (p.rgba[(y * p.width + x) * 4] < 128 ? '1' : '0')).join(''));

const find = (fields: Field[], name: string): Field | undefined => {
    for (const f of fields) {
        if (f.name === name) return f;
        const inside = f.children && find(f.children, name);
        if (inside) return inside;
    }
};

describe('decompression', () => {
    it('unpacks PackBits as the spec\'s example does', () => {
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
        const file = fromHex('49492a001e00000026a1ab906bbcc9c8b7e6ce0f82ffe6c1ac1a80080080090000010300010000002800000001010300010000000a00000002010300010000000100000003010300010000000400000006010300010000000100000011010400010000000800000016010300010000000a0000001701040001000000160000001c010300010000000100000000000000');
        expect(bilevel(picture(parse(file).preview))).toEqual(expected);
    });

    it('decodes Group 3 (T.4, one-dimensional, rows after end-of-line codes)', () => {
        const file = fromHex('49492a003a000000001350d580013506bb8004d64e2d8c004d64f605001358b82e0026b270ce0026b270ce0026b270ce0026b5835800c06a0e00090000010300010000002800000001010300010000000a00000002010300010000000100000003010300010000000300000006010300010000000100000011010400010000000800000016010300010000000a0000001701040001000000310000001c010300010000000100000000000000');
        expect(bilevel(picture(parse(file).preview))).toEqual(expected);
    });
});

describe('structure', () => {
    it('is found by its header, either byte order', () => {
        expect(detect(fromHex('49492a0008000000'), 'x.bin').id).toBe('tiff');
        expect(detect(fromHex('4d4d002a00000008'), 'x.bin').id).toBe('tiff');
    });

    it('says BigTIFF isn\'t read rather than misreading it', () => {
        expect(() => parse(fromHex('49492b0008000000100000000000000000'))).toThrow(/BigTIFF/);
    });
});

describe.skipIf(!existsSync(images))('sample files', () => {
    const open = (name: string) => parse(new Uint8Array(readFileSync(join(images, name))));

    it('draws a big-endian LZW picture and reads its EXIF', () => {
        const parsed = open('ExifTool.tif');
        expect(parsed.summary).toEqual(expect.arrayContaining([['Size', '160 × 120'], ['Compression', 'LZW'], ['Byte order', 'Big-endian (MM)'], ['Camera', 'Canon EOS DIGITAL REBEL']]));
        const p = picture(parsed.preview);
        expect([p.width, p.height]).toEqual([160, 120]);
        expect(find(parsed.fields, 'IFD0 data')?.value).toMatch(/^\d+ strips?, /);
    });

    it('draws a palette picture and names GeoTIFF\'s tags', () => {
        const parsed = open('GeoTiff.tif');
        expect(parsed.summary).toContainEqual(['Color', 'Palette, 8-bit']);
        expect(find(parsed.fields, 'GeoKeyDirectory')).toBeDefined();
        picture(parsed.preview);
    });

    it('follows a DNG\'s SubIFDs and says why the raw data isn\'t drawn', () => {
        const parsed = open('DNG.dng');
        expect(parsed.title).toBe('Picture (TIFF, DNG)');
        expect(parsed.summary).toContainEqual(['SubIFDs', '3']);
        expect(parsed.warnings).toContain('IFD0 › SubIFD 1 couldn\'t be drawn: It\'s raw sensor data, which isn\'t drawn here.');
    });
});
