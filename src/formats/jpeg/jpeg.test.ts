import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Field, Parsed, Preview } from '../../core/types';
import { detect } from '../index';
import { huffmanTable, segmentsOf } from './decode';
import jpeg from './index';

const samples = join(__dirname, '../../../JPG Samples');
const exifTool = join(samples, 'Image-ExifTool-10.38/t/images');

const open = (path: string): [Uint8Array, Parsed] => {
    const data = new Uint8Array(readFileSync(path));
    return [data, jpeg.parse(data, { name: path, names: [] })];
};

function picture(preview: Preview | undefined) {
    const found = preview?.kind === 'stack' ? preview.items.find((i) => i.preview.kind === 'picture')?.preview : preview;
    if (found?.kind !== 'picture') throw new Error(`expected a picture, got ${preview?.kind}`);
    return found;
}

const pixel = (p: { width: number; rgba: Uint8Array }, x: number, y: number) => Array.from(p.rgba.subarray((y * p.width + x) * 4, (y * p.width + x) * 4 + 3));

/** Within libjpeg's rounding: its integer IDCT and ours differ by a level or two. */
function near(actual: number[], expected: number[]) {
    expect(actual.every((v, i) => Math.abs(v - expected[i]) <= 3), `${actual} ≈ ${expected}`).toBe(true);
}

const find = (fields: Field[], name: string): Field | undefined => {
    for (const f of fields) {
        if (f.name === name) return f;
        const inside = f.children && find(f.children, name);
        if (inside) return inside;
    }
};

describe('Huffman tables', () => {
    it('gives each code its length and symbol, shortest codes first', () => {
        // Two 2-bit codes (00, 01) and one 3-bit code (100).
        const table = huffmanTable([0, 2, 1, ...new Array(13).fill(0)], [5, 6, 7]);
        expect(table[0b00 << 14]).toBe((2 << 8) | 5);
        expect(table[(0b01 << 14) | 0x3fff]).toBe((2 << 8) | 6);
        expect(table[0b100 << 13]).toBe((3 << 8) | 7);
        expect(table[0b101 << 13]).toBe(0);
    });
});

describe('segments', () => {
    it('runs a scan\'s data past stuffed bytes and restarts, to the next marker', () => {
        // SOI, SOS (length 8), data with FF 00 and FF D0 in it, EOI.
        const data = Uint8Array.from([0xff, 0xd8, 0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0, 0x12, 0xff, 0, 0x34, 0xff, 0xd0, 0x56, 0xff, 0xd9]);
        const { segments, end } = segmentsOf(data);
        expect(segments.map((s) => s.marker)).toEqual([0xd8, 0xda, 0xd9]);
        expect(segments[1].scan).toEqual({ offset: 12, length: 7, restarts: 1 });
        expect(end).toBe(data.length);
    });

    it('breaks out the hierarchical and arithmetic-coding segments (DHP, EXP, DAC), which no sample has', () => {
        const data = Uint8Array.from([
            0xff, 0xd8,
            // DHP: 8-bit, 16 lines of 32 samples, one component (1, 2×1, table 0).
            0xff, 0xde, 0, 11, 8, 0, 16, 0, 32, 1, 1, 0x21, 0,
            // EXP: expand horizontally only.
            0xff, 0xdf, 0, 3, 0x10,
            // DAC: DC table 1 with L 2, U 5; AC table 0 with Kx 7.
            0xff, 0xcc, 0, 6, 0x01, 0x52, 0x10, 7,
            0xff, 0xd9,
        ]); // prettier-ignore
        const parsed = jpeg.parse(data, { name: null, names: [] });
        const dhp = find(parsed.fields, 'DHP (Hierarchical progression)')!;
        expect(dhp.value).toBe('32 × 16');
        expect(find(dhp.children!, 'H, V (sampling)')?.value).toBe('2×1');
        expect(find(parsed.fields, 'EXP (Expand reference components)')?.value).toBe('Expand horizontally');
        expect(find(parsed.fields, 'DAC (Arithmetic coding conditioning)')?.children?.slice(2).map((t) => [t.name, t.value])).toEqual([
            ['DC conditioning 1', 'L 2, U 5'],
            ['AC conditioning 0', 'Kx 7'],
        ]);
    });

    it('is found by its first bytes', () => {
        expect(detect(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]), 'photo.bin').id).toBe('jpeg');
    });
});

describe.skipIf(!existsSync(samples))('sample pictures', () => {
    it('decodes a baseline 4:2:2 photo as libjpeg does', () => {
        const [, parsed] = open(join(samples, 'Sample_Ocad.jpg'));
        expect(parsed.summary).toEqual(expect.arrayContaining([['Size', '600 × 800'], ['Process', 'Baseline'], ['Color', 'YCbCr 4:2:2']]));
        const p = picture(parsed.preview);
        // Pillow's (libjpeg's) values.
        near(pixel(p, 0, 0), [23, 37, 37]);
        near(pixel(p, 300, 400), [216, 201, 204]);
        near(pixel(p, 599, 799), [136, 118, 104]);
        near(pixel(p, 123, 456), [163, 130, 99]);
        expect(parsed.warnings).toEqual([]);
    });

    it('decodes a progressive picture, scan by scan', () => {
        const [, parsed] = open(join(samples, 'FLCL Thumb.jpg'));
        expect(parsed.summary).toEqual(expect.arrayContaining([['Process', 'Progressive'], ['Scans', '10']]));
        expect(parsed.fields.filter((f) => f.name.startsWith('Scan ')).map((f) => f.value)).toContain('Y: AC 1–5, from bit 2');
        // Tables down to the spec's parameters: a DQT's values in rows of the zigzag order, a DHT's symbols by code length.
        expect(find(parsed.fields, 'Q0–Q7')?.length).toBe(8);
        expect(find(parsed.fields, 'DC table 0')?.children?.map((c) => c.name)).toEqual(expect.arrayContaining(['Tc, Th', 'L1–L16 (code counts)']));
        expect(find(parsed.fields, 'Cs (selector)')?.value).toBe('1');
        const p = picture(parsed.preview);
        near(pixel(p, 0, 0), [211, 233, 244]);
        near(pixel(p, 40, 30), [231, 216, 131]);
        near(pixel(p, 77, 63), [237, 231, 173]);
        // Its XMP is shown as text beside the picture.
        expect(parsed.preview?.kind === 'stack' && parsed.preview.items.map((i) => i.title)).toEqual(['Picture', 'XMP']);
    });

    it('reads EXIF tags, with their meanings, and offers the thumbnail', () => {
        const [data, parsed] = open(join(samples, 'Sample_Ocad.jpg'));
        expect(parsed.summary).toEqual(expect.arrayContaining([['Camera', 'OLYMPUS IMAGING CORP. u710,S710'], ['Exposure', '1/100 s, f/3.4, ISO 64, 6.5 mm']]));
        // Out of line: the entry gives an offset, and the value is where it points.
        const exposure = find(parsed.fields, 'ExposureTime')!;
        expect(exposure.value).toBe('1/100');
        expect(exposure.children?.map((c) => c.name)).toEqual(['Tag', 'Type', 'Count', 'Value offset', 'Value']);
        expect(find(exposure.children!, 'Type')?.value).toBe('5 (RATIONAL)');
        expect(find(parsed.fields, 'ResolutionUnit')?.value).toBe('2 (Inches)');
        const thumbnail = parsed.entries!.find((e) => e.label === 'exif thumbnail')!;
        expect(Array.from(data.subarray(thumbnail.offset, thumbnail.offset + 2))).toEqual([0xff, 0xd8]);
        expect(detect(thumbnail.data, thumbnail.label).id).toBe('jpeg');
    });

    it('finds GPS positions in degrees', () => {
        const [, parsed] = open(join(exifTool, 'GPS.jpg'));
        expect(parsed.summary).toContainEqual(['GPS', '54.989667, -1.914167']);
    });

    it('names the application segments it knows', () => {
        const [, parsed] = open(join(exifTool, 'ExifTool.jpg'));
        const names = parsed.fields.map((f) => f.name);
        expect(names).toEqual(expect.arrayContaining(['APP0 (JFIF)', 'APP1 (EXIF)', 'APP1 (XMP)', 'APP2 (ICC profile)', 'APP13 (Photoshop)', 'APP14 (Adobe)']));
        picture(parsed.preview);
    });
});
