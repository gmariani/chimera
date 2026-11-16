import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Parsed } from '../core/types';
import { gameDir } from '../testing/game-data';
import { bitmap, bitmapColor } from '../testing/samples';
import bmp from './bmp';
import { detect } from './index';
import { inspect } from './inspect';

const parse = (data: Uint8Array, name = 'picture.bmp') => bmp.parse(data, { name, names: [] }) as Parsed;
const summary = (r: Parsed, key: string) => r.summary.find(([k]) => k === key)?.[1];

/** Every pixel drawn as the pattern it was written from. */
function expectPattern(r: Parsed, bits: 4 | 8 | 24) {
    const p = r.preview!;
    if (p.kind !== 'picture') throw new Error(`a ${p.kind} preview`);
    expect([p.width, p.height]).toEqual([33, 10]);
    for (let y = 0; y < 10; y++) for (let x = 0; x < 33; x++) expect([...p.rgba.subarray((y * 33 + x) * 4, (y * 33 + x) * 4 + 4)], `${x}, ${y}`).toEqual([...bitmapColor(bits, x, y), 255]);
}

describe('Windows bitmaps (BMP)', () => {
    it('reads 8, 4 and 24 bits a pixel, bottom row first or top row first', async () => {
        for (const bits of [8, 4, 24] as const) {
            const data = bitmap(bits);
            expect(detect(data, 'picture.bmp').id).toBe('bmp');
            expect(detect(data, null).id).toBe('bmp');
            const inspected = await inspect(data, { name: 'picture.bmp', names: [] });
            expect(inspected.checks, `${bits} bits`).toEqual([]);
            const r = inspected.parsed;
            expect(r.warnings).toEqual([]);
            expectPattern(r, bits);
            expect(summary(r, 'Colors')).toBe(bits === 24 ? '24-bit' : `${1 << bits} (${bits} bits a pixel)`);
            expect(summary(r, 'Resolution')).toBe('72 dpi');
            expect(r.end).toBe(data.length);
            // Every byte is in a field.
            expect(r.fields.reduce((n, f) => n + f.length, 0)).toBe(data.length);
        }
    });

    it('takes the zeros some programs pad the file with, and flags anything else after the pixels', async () => {
        const padded = bitmap(8, { pad: true });
        const plain = bitmap(8);
        expect(padded.length - plain.length).toBe(2);
        const r = parse(padded);
        expect(r.warnings).toEqual([]);
        expect(r.fields.at(-1)).toMatchObject({ name: 'Padding', offset: plain.length, length: 2 });
        expect((await inspect(padded, { name: 'picture.bmp', names: [] })).checks).toEqual([]);

        const tail = new Uint8Array(plain.length + 2);
        tail.set(plain);
        tail.set([0x41, 0x42], plain.length);
        new DataView(tail.buffer).setUint32(2, tail.length, true);
        expect(parse(tail).end).toBe(plain.length);
        expect((await inspect(tail, { name: 'picture.bmp', names: [] })).checks.map((c) => c.text).join()).toMatch(/^There are 2 bytes after the end/);
    });

    it('starts the pixels where the file header says, past a gap after the colors', () => {
        const plain = bitmap(4);
        const data = new Uint8Array(plain.length + 8);
        const offset = 14 + 40 + 16 * 4;
        data.set(plain.subarray(0, offset));
        data.set(plain.subarray(offset), offset + 8);
        const v = new DataView(data.buffer);
        v.setUint32(2, data.length, true);
        v.setUint32(10, offset + 8, true);
        const r = parse(data);
        expect(r.warnings).toEqual([]);
        expect(r.fields.find((f) => f.name === 'Padding')).toMatchObject({ offset, length: 8 });
        expectPattern(r, 4);
        data[offset + 1] = 7;
        expect(parse(data).warnings).toEqual(["8 bytes between the colors and the pixels aren't part of the picture."]);
    });

    it('says what doesn’t fit', () => {
        const at = (data: Uint8Array) => new DataView(data.buffer);
        const size = bitmap(8);
        at(size).setUint32(2, 1000, true);
        expect(parse(size).warnings).toEqual([`The header says the file is 1,000 bytes, but it's ${size.length.toLocaleString('en-US')} bytes.`]);

        const reserved = bitmap(8);
        at(reserved).setUint16(6, 5, true);
        expect(parse(reserved).warnings).toEqual(['The two reserved words are 5 and 0, not 0: something kept its own data there.']);

        const planes = bitmap(8);
        at(planes).setUint16(26, 3, true);
        expect(parse(planes).warnings).toEqual(['It says it has 3 planes; a bitmap always has 1.']);

        const image = bitmap(8);
        at(image).setUint32(34, 99, true);
        expect(parse(image).warnings).toEqual(['The header says the pixels take 99 bytes, but 33 × 10 at 8 bits a pixel takes 360 bytes.']);

        const important = bitmap(4);
        at(important).setUint32(50, 20, true);
        expect(parse(important).warnings).toEqual(['It says 20 colors are important, but it has only 16.']);

        // Colors used: 4, but the pattern uses all 16. The pixels start at the same place (the header says so).
        const few = bitmap(4);
        at(few).setUint32(46, 4, true);
        const r = parse(few);
        // The 12 colors left in the file after the 4 it says it has are no longer part of the picture.
        expect(r.warnings).toEqual([
            "48 bytes between the colors and the pixels aren't part of the picture.",
            expect.stringMatching(/^\d+ pixels use colors past the 4 in its table; they’re drawn black here/),
        ]);
        expect(r.fields.find((f) => f.name === 'Not pointed to')).toMatchObject({ offset: 54 + 16, length: 48 });
    });

    it('marks what it can of a picture it can’t draw', () => {
        const cut = bitmap(8).slice(0, 600);
        const r = parse(cut);
        expect(r.warnings).toContain("The picture can't be drawn: its 33 × 10 pixels run past the end of the data it’s given.");
        expect(r.preview).toBeUndefined();
        expect(r.end).toBe(cut.length);

        const rle = bitmap(8);
        new DataView(rle.buffer).setUint32(30, 1, true);
        expect(parse(rle).warnings).toContain("The picture can't be drawn: it’s compressed (method 1), which isn’t drawn here.");
        expect(
            parse(rle)
                .fields.find((f) => f.name === 'Bitmap header')!
                .children!.find((f) => f.name === 'Compression')!.value
        ).toBe('run-length, 8 bits a pixel (RLE8)');

        const inside = bitmap(8);
        new DataView(inside.buffer).setUint32(10, 100, true);
        expect(parse(inside).warnings).toContain("The picture can't be drawn: its pixels are said to start at 86, inside its own header and colors (which end at 1064).");
    });

    it('takes nothing that only starts with "BM"', () => {
        const text = new TextEncoder().encode('BMW owners club newsletter, spring edition.');
        const wrongHeader = bitmap(8);
        wrongHeader[14] = 41;
        expect(detect(wrongHeader, null).id).not.toBe('bmp');
        expect(() => parse(wrongHeader)).toThrow(/^This isn't a Windows bitmap/);
        // Pixels said to start inside the headers.
        const inHeader = bitmap(8);
        new DataView(inHeader.buffer).setUint32(10, 20, true);
        expect(detect(inHeader, null).id).not.toBe('bmp');
        expect(detect(text, null).id).not.toBe('bmp');
    });
});

const ts = gameDir('tiberianSun');
const ra2 = gameDir('redAlert2');
const cnc = gameDir('cncRemastered');
const real = [
    ...(ts ? ['00000409.256', '00000409.016', 'LAUNCHER.BMP'].map((n) => join(ts, n)) : []),
    ...(ra2 ? ['00000409.256', '00000409.016', 'LAUNCHER.BMP', 'launchermd.bmp'].map((n) => join(ra2, n)) : []),
    ...(cnc ? ['SETUP95/SETUP.BMP', 'PLANETWW/SETUP.BMP'].map((n) => join(cnc, 'RED_ALERT/COUNTERSTRIKE', n)) : []),
].filter((p) => existsSync(p));

describe.skipIf(!real.length)('the games’ bitmaps', () => {
    it('reads the launchers’ and autorun screens’ bitmaps, with nothing left over', async () => {
        for (const path of real) {
            const data = new Uint8Array(readFileSync(path));
            const inspected = await inspect(data, { name: path.split('/').at(-1)!, names: [] });
            expect(inspected.format.id, path).toBe('bmp');
            expect(inspected.checks, path).toEqual([]);
            expect(inspected.parsed.warnings, path).toEqual([]);
            expect(inspected.parsed.preview?.kind, path).toBe('picture');
        }
    });
});
