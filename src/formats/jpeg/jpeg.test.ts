import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Field, Parsed, Preview } from '../../core/types';
import { detect } from '../index';
import { huffmanTable, segmentsOf } from './decode';
import jpeg from './index';

const samples = join(__dirname, '../../../samples/images');
const fromHex = (text: string) => Uint8Array.from(text.match(/../g)!, (b) => parseInt(b, 16));

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
    expect(
        actual.every((v, i) => Math.abs(v - expected[i]) <= 3),
        `${actual} ≈ ${expected}`
    ).toBe(true);
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
    it("runs a scan's data past stuffed bytes and restarts, to the next marker", () => {
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
        expect(
            find(parsed.fields, 'DAC (Arithmetic coding conditioning)')
                ?.children?.slice(2)
                .map((t) => [t.name, t.value])
        ).toEqual([
            ['DC conditioning 1', 'L 2, U 5'],
            ['AC conditioning 0', 'Kx 7'],
        ]);
    });

    it('is found by its first bytes', () => {
        expect(detect(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]), 'photo.bin').id).toBe('jpeg');
    });
});

describe('a progressive picture with EXIF and GPS', () => {
    // 24 × 16, made by Pillow (libjpeg) from jpeg-baseline-exif.jpg, with a camera name and a GPS position.
    const file = fromHex(
        [
            'ffd8ffe000104a46494600010100000100010000ffe100b44578696600004d4d002a000000080003010f00020000000800000032011000020000000c0000003a88250004000000010000004600000000',
            '4368696d65726100546573742043616d65726100000400010002000000024e00000000020005000000030000007c00030002000000025700000000040005000000030000009400000000000000360000',
            '00010000003b000000010000007200000005000000010000000100000036000000010000003300000001ffdb00430006040506050406060506070706080a100a0a09090a140e0f0c1017141818171416',
            '161a1d251f1a1b231c1616202c20232627292a29191f2d302d283025282928ffdb0043010707070a080a130a0a13281a161a282828282828282828282828282828282828282828282828282828282828',
            '2828282828282828282828282828282828282828ffc20011080010001803012200021101031101ffc400190000020301000000000000000000000000000603040507ffc4001601010101000000000000',
            '00000000000000040102ffda000c03010002100310000001ccb6d32cd73119849fffc4001a100003000301000000000000000000000001020304051114ffda000801010001050258359abae659bad247',
            '1ab87453de6cc7a0ff00ffc4001a110002020300000000000000000000000001020011122132ffda0008010301013f01c54e846520f373ffc40019110002030100000000000000000000000000010212',
            '2111ffda0008010201013f01565ac855ad970fffc4001e10000104020301000000000000000000000100020311122141526171ffda0008010100063f02ac77f15b85f8b11b1d795947232fd28ba47466',
            '3e28a6b9a3617fffc4001c10000202020300000000000000000000000111003141617181d1ffda0008010100013f211051d154449c0c7a2171159949a83012b475356f190216ac1589ffda000c030100',
            '02000300000010803fffc4001a1101000105000000000000000000000000110001213151c1ffda0008010301013f10cc2f0f50369d9fffc40017110101010100000000000000000000000001001151ff',
            'da0008010201013f10612f78ae62dfffc4001e100101000202020300000000000000000001110031215171b1416191ffda0008010100013f10580dcd13d139f785244d917d8da78b30592ab21d9693c7',
            'e645f2449d9f07c60aad89ed477756fac514159c15dae9a712e7ffd9',
        ].join('')
    );
    const parsed = jpeg.parse(file, { name: null, names: [] });

    it('decodes it scan by scan', () => {
        expect(parsed.summary).toEqual(
            expect.arrayContaining([
                ['Size', '24 × 16'],
                ['Process', 'Progressive'],
                ['Scans', '10'],
            ])
        );
        expect(parsed.fields.filter((f) => f.name.startsWith('Scan ')).map((f) => f.value)).toContain('Y: AC 1–5, from bit 2');
        const p = picture(parsed.preview);
        // Pillow's (libjpeg's) values.
        near(pixel(p, 0, 0), [71, 83, 95]);
        near(pixel(p, 12, 8), [214, 199, 202]);
        near(pixel(p, 23, 15), [149, 122, 105]);
        expect(parsed.warnings).toEqual([]);
    });

    it("breaks its tables down to the spec's parameters", () => {
        // A DQT's values in rows of the zigzag order, a DHT's symbols by code length, a scan's component selectors.
        expect(find(parsed.fields, 'Q0–Q7')?.length).toBe(8);
        expect(find(parsed.fields, 'DC table 0')?.children?.map((c) => c.name)).toEqual(expect.arrayContaining(['Tc, Th', 'L1–L16 (code counts)']));
        expect(find(parsed.fields, 'Cs (selector)')?.value).toBe('1');
    });

    it('reads the camera and the GPS position in degrees', () => {
        expect(parsed.summary).toEqual(
            expect.arrayContaining([
                ['Camera', 'Chimera Test Camera'],
                ['GPS', '54.989667, -1.914167'],
            ])
        );
        expect(find(parsed.fields, 'GPS IFD')).toBeDefined();
    });
});

describe.skipIf(!existsSync(samples))('sample pictures', () => {
    it('decodes a baseline 4:2:2 photo as libjpeg does', () => {
        const [, parsed] = open(join(samples, 'jpeg-baseline-exif.jpg'));
        expect(parsed.summary).toEqual(
            expect.arrayContaining([
                ['Size', '600 × 800'],
                ['Process', 'Baseline'],
                ['Color', 'YCbCr 4:2:2'],
            ])
        );
        const p = picture(parsed.preview);
        // Pillow's (libjpeg's) values.
        near(pixel(p, 0, 0), [23, 37, 37]);
        near(pixel(p, 300, 400), [216, 201, 204]);
        near(pixel(p, 599, 799), [136, 118, 104]);
        near(pixel(p, 123, 456), [163, 130, 99]);
        expect(parsed.warnings).toEqual([]);
    });

    it('decodes a large one', () => {
        const [, parsed] = open(join(samples, 'jpeg-baseline-large.jpg'));
        expect(parsed.summary).toContainEqual(['Size', '1400 × 1400']);
        const p = picture(parsed.preview);
        near(pixel(p, 0, 0), [221, 221, 221]);
        near(pixel(p, 700, 700), [243, 243, 243]);
        near(pixel(p, 1399, 1399), [196, 196, 196]);
        near(pixel(p, 123, 987), [203, 203, 203]);
    });

    it('decodes a progressive picture whose encoder made its own scans and tables', () => {
        // Five scans, each with new Huffman tables before it, not libjpeg's usual ten; and an ICC profile.
        const [, parsed] = open(join(samples, 'jpeg-progressive-icc.jpg'));
        expect(parsed.summary).toEqual(
            expect.arrayContaining([
                ['Size', '720 × 960'],
                ['Process', 'Progressive'],
                ['Color', 'YCbCr 4:2:0'],
                ['Scans', '5'],
            ])
        );
        expect(parsed.fields.map((f) => f.name)).toContain('APP2 (ICC profile)');
        const p = picture(parsed.preview);
        near(pixel(p, 0, 0), [174, 194, 229]);
        near(pixel(p, 360, 480), [151, 162, 190]);
        near(pixel(p, 719, 959), [113, 128, 85]);
        near(pixel(p, 100, 800), [114, 140, 79]);
        expect(parsed.warnings).toEqual([]);
    });

    it("says so when a file named .jpg isn't one", () => {
        // Machine code under a JPEG's name: no markers at all.
        expect(() => open(join(samples, 'jpeg-not-a-jpeg.jpg'))).toThrow('No start-of-image marker (FF D8).');
    });

    it('reads EXIF tags, with their meanings, and offers the thumbnail', () => {
        const [data, parsed] = open(join(samples, 'jpeg-baseline-exif.jpg'));
        expect(parsed.summary).toEqual(
            expect.arrayContaining([
                ['Camera', 'OLYMPUS IMAGING CORP. u710,S710'],
                ['Exposure', '1/100 s, f/3.4, ISO 64, 6.5 mm'],
            ])
        );
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

    it('names the application segments it knows', () => {
        const [, parsed] = open(join(samples, 'jpeg-baseline-exif.jpg'));
        expect(parsed.fields.map((f) => f.name)).toEqual(expect.arrayContaining(['APP0 (JFIF)', 'APP0 (Photobucket)', 'APP1 (EXIF)']));
    });
});
