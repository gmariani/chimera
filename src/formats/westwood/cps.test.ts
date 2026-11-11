import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { IndexedImage, Parsed, Preview } from '../../core/types';
import { detect } from '../index';
import { inspect } from '../inspect';
import { type DecodeInfo, westwoodLzw, westwoodRle } from './compression';
import cps from './cps';
import pak from './pak';

const u16 = (v: number) => [v & 0xff, v >> 8];
const u32 = (v: number) => [...u16(v & 0xffff), ...u16(v >>> 16)];
const hex = (s: string) => Uint8Array.from(s.match(/../g)!.map((h) => parseInt(h, 16)));

/** A CPS: the file size doesn't count itself. */
function build(compression: number, body: ArrayLike<number>, { size = 64000, palette = [] as number[], fileSize }: { size?: number; palette?: number[]; fileSize?: number } = {}): Uint8Array {
    const rest = [...u16(compression), ...u32(size), ...u16(palette.length), ...palette, ...Array.from(body)];
    return Uint8Array.from([...u16(fileSize ?? rest.length), ...rest]);
}

/** Standard LZW, as Westwood's decoder reads it: 256 + n is what code n made plus the first byte of code n + 1. */
function lzw(data: Uint8Array, bits: 12 | 14): Uint8Array {
    const end = (1 << bits) - 1;
    const dict = new Map<string, number>();
    const codes: number[] = [];
    let next = 256;
    let w = '';
    for (const byte of data) {
        const c = String.fromCharCode(byte);
        if (dict.has(w + c) || (w === '' && true)) {
            w += c;
            continue;
        }
        codes.push(w.length === 1 ? w.charCodeAt(0) : dict.get(w)!);
        if (next < end) dict.set(w + c, next++);
        w = c;
    }
    codes.push(w.length === 1 ? w.charCodeAt(0) : dict.get(w)!, end);
    // High bits first, then zeros to a whole byte.
    const out: number[] = [];
    let acc = 0;
    let n = 0;
    for (const code of codes) {
        acc = (acc << bits) | code;
        n += bits;
        while (n >= 8) {
            out.push((acc >> (n - 8)) & 0xff);
            n -= 8;
        }
        acc &= (1 << n) - 1;
    }
    if (n) out.push((acc << (8 - n)) & 0xff);
    return Uint8Array.from(out);
}

/** A 320 × 200 picture with runs, repeats and noise, in values below 32 (so the Amiga can have it too). */
function picture(): Uint8Array {
    const p = new Uint8Array(64000);
    let seed = 7;
    for (let i = 0; i < p.length; i++) {
        const x = i % 320;
        const y = Math.floor(i / 320);
        seed = (seed * 1103515245 + 12345) >>> 0;
        p[i] = y < 50 ? 3 : y < 100 ? (x >> 4) & 31 : y < 150 ? (x ^ y) & 31 : (seed >>> 16) & 31;
    }
    return p;
}

const parse = (data: Uint8Array) => cps.parse(data, { name: 'x.cps', names: [] }) as Parsed;
const images = (p: Preview | undefined): IndexedImage[] => (p?.kind === 'images' ? p.frames : []);

describe('LZW', () => {
    it('decodes the shikadi example (Eye of the Beholder\'s BLUE.EGA)', () => {
        // 000 100 100 008 006 008 105 101 107, then the end marker.
        const out = new Uint8Array(64);
        const info: DecodeInfo = { read: 0, ended: false, badRefs: 0 };
        const n = westwoodLzw(hex('000100100008006008105101107fff00'), out, 12, 0, info);
        expect([...out.subarray(0, n)]).toEqual([0, 0, 0, 0, 0, 8, 6, 8, 8, 8, 0, 0, 0, 0, 0, 0, 0]);
        expect(info).toEqual({ read: 15, ended: true, badRefs: 0 });
    });

    it('stops at a code from the future', () => {
        const info: DecodeInfo = { read: 0, ended: false, badRefs: 0 };
        expect(westwoodLzw(hex('041105fff0'), new Uint8Array(8), 12, 0, info)).toBe(1);
        expect(info.badRefs).toBe(1);
    });
});

describe('RLE', () => {
    it('copies, repeats (0x80 is 128), and repeats long, big-endian on the PC and little on the Amiga', () => {
        const src = [0x02, 5, 6, 0xfd, 9, 0x80, 1, 0x00, 0x01, 0x02, 7];
        const pc = new Uint8Array(1000);
        expect(westwoodRle(Uint8Array.from(src), pc, false)).toBe(2 + 3 + 128 + 258);
        expect([...pc.subarray(0, 5)]).toEqual([5, 6, 9, 9, 9]);
        expect(pc[5 + 127]).toBe(1);
        expect(pc[5 + 128 + 257]).toBe(7);
        expect(westwoodRle(Uint8Array.from(src), new Uint8Array(1000), true)).toBe(2 + 3 + 128 + 513);
    });
});

describe('CPS', () => {
    const pixels = picture();
    const rle = (p: Uint8Array) => {
        // Runs as long repeats; the rest as copies of up to 127.
        const out: number[] = [];
        for (let i = 0; i < p.length; ) {
            let run = 1;
            while (i + run < p.length && p[i + run] === p[i] && run < 0xffff) run++;
            if (run > 3) {
                out.push(0, run >> 8, run & 0xff, p[i]);
                i += run;
            } else {
                const n = Math.min(127, p.length - i);
                out.push(n, ...p.subarray(i, i + n));
                i += n;
            }
        }
        return out;
    };

    it.each([
        [0, 'None', () => pixels],
        [1, 'LZW, 12-bit', () => lzw(pixels, 12)],
        [2, 'LZW, 14-bit', () => lzw(pixels, 14)],
        [3, 'RLE', () => rle(pixels)],
    ] as const)('reads compression %i (%s)', (compression, name, body) => {
        const data = build(compression, body());
        expect(detect(data, null).id).toBe('cps');
        const r = parse(data);
        expect(r.warnings).toEqual([]);
        expect(r.summary).toContainEqual(['Compression', name]);
        expect(images(r.preview)[0].pixels).toEqual(pixels);
    });

    it('reads a palette', () => {
        const palette = new Array(768).fill(0);
        palette[3] = 63;
        const r = parse(build(0, pixels, { palette }));
        expect(r.preview?.kind === 'images' && [...r.preview.palette!.subarray(0, 6)]).toEqual([0, 0, 0, 255, 0, 0]);
    });

    it('reads the Amiga\'s bit planes and palettes', () => {
        // Five planes: plane n holds bit n of each pixel, the leftmost in bit 7.
        const planes = new Uint8Array(40000);
        for (let i = 0; i < 64000; i++) for (let p = 0; p < 5; p++) if ((pixels[i] >> p) & 1) planes[p * 8000 + (i >> 3)] |= 0x80 >> (i & 7);
        const palette = [...new Array(64).fill(0)];
        palette.splice(2, 2, 0x0f, 0x80); // color 1: red 15, green 8, blue 0
        const r = parse(build(0, planes, { size: 40000, palette: [...palette, ...palette] }));
        expect(r.warnings).toEqual([]);
        expect(r.summary).toContainEqual(['Machine', 'Amiga (5 bit planes, 32 colors)']);
        // Two palettes: the picture once with each.
        expect(r.preview?.kind).toBe('stack');
        const first = r.preview?.kind === 'stack' ? r.preview.items[0].preview : undefined;
        expect(images(first)[0].pixels).toEqual(pixels);
        expect(first?.kind === 'images' && [...first.palette!.subarray(3, 6)]).toEqual([255, 136, 0]);
        // RLE on the Amiga counts little-endian.
        expect(images(parse(build(3, [0x00, 0x40, 0x9c, 0x00], { size: 40000 })).preview)[0].pixels.every((v) => v === 0)).toBe(true);
    });

    it('says what doesn\'t fit the format', async () => {
        expect(parse(build(0, pixels, { fileSize: 5 })).warnings.join()).toMatch(/header says the file is 7 bytes/);
        expect(parse(build(0, pixels.subarray(0, 1000))).warnings.join()).toMatch(/comes to 1,000 bytes, short of the 64,000 bytes the header gives/);
        // LZW: a reference to a code that isn't there yet, and no end marker.
        expect(parse(build(1, hex('105fff00'))).warnings.join()).toMatch(/copies from outside what it's decoded so far 1 time/);
        expect(parse(build(1, lzw(pixels, 12).subarray(0, 4000))).warnings.join()).toMatch(/has no end marker/);
        // LCW: one byte, then a copy of 3 from position 4,096, which isn't written yet.
        expect(parse(build(4, [0x81, 5, 0xc0, 0x00, 0x10, 0x80])).warnings.join()).toMatch(/LCW data copies from outside what it's decoded so far 1 time/);
        expect(() => parse(build(5, pixels))).toThrow(/Compression 5 isn't one CPS files use/);
        // Hidden after the picture.
        const hidden = build(1, [...lzw(pixels, 12), ...new TextEncoder().encode('MZ payload')]);
        const r = await inspect(hidden, { name: 'x.cps', names: [] });
        expect(r.checks[0]).toMatchObject({ level: 'danger' });
        expect(r.checks[0].text).toMatch(/10 bytes after the end/);
    });
});

// Dune II's pictures, inside its PAKs, if present (they aren't committed).
const DUNE = join(__dirname, '../../../samples/westwood/Dune II');
describe.skipIf(!existsSync(DUNE))('Dune II\'s CPS pictures', () => {
    it('reads all 20 with nothing to warn about', () => {
        let count = 0;
        for (const name of readdirSync(DUNE).filter((n) => /\.pak$/i.test(n))) {
            for (const e of pak.parse(new Uint8Array(readFileSync(join(DUNE, name))), { name, names: [] }).entries!.filter((x) => /\.cps$/i.test(x.label))) {
                expect(detect(e.data, e.name).id, e.label).toBe('cps');
                const r = parse(e.data);
                expect(r.warnings, `${name} › ${e.label}`).toEqual([]);
                expect(r.end, e.label).toBe(e.data.length);
                count++;
            }
        }
        expect(count).toBe(20);
    });
});
