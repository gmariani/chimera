import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Parsed } from '../../core/types';
import { detect } from '../index';
import { inspect } from '../inspect';
import cmp from './cmp';
import cps from './cps';
import { lzw, rle } from './encoders.test-util';
import pak from './pak';
import { gameFile } from '../../testing/game-data';

const u16 = (v: number) => [v & 0xff, v >> 8];
const u32 = (v: number) => [...u16(v & 0xffff), ...u16(v >>> 16)];

/** An old CMP: the size (not counting itself), the type, the decoded size for the LZW types, then the picture. */
function build(type: number, body: ArrayLike<number>, { stated = 64000, extra = 0 }: { stated?: number; extra?: number } = {}): Uint8Array {
    const rest = [type, ...(type === 3 || type === 6 ? u16(stated) : []), ...Array.from(body)];
    return Uint8Array.from([...u16(rest.length - extra), ...rest]);
}

/** A 320 × 200 picture in 16 colors: bands, a gradient across, and a diagonal. */
function picture(): Uint8Array {
    const p = new Uint8Array(64000);
    for (let i = 0; i < p.length; i++) {
        const x = i % 320;
        const y = Math.floor(i / 320);
        p[i] = y < 40 ? 9 : y < 120 ? x >> 5 : (x + y) & 15;
    }
    return p;
}

/** Two pixels a byte, the left one high. */
const pack4 = (p: Uint8Array) => Uint8Array.from({ length: p.length / 2 }, (_, i) => (p[i * 2] << 4) | p[i * 2 + 1]);

const parse = (data: Uint8Array) => cmp.parse(data, { name: 'x.cmp', names: [] }) as Parsed;
const pixels = (r: Parsed) => (r.preview?.kind === 'images' ? r.preview.frames[0].pixels : null);

describe('CMP', () => {
    const p = picture();
    const packed = pack4(p);
    // Type 2 stores a column of bytes (two pixels wide) at a time, top to bottom.
    const down = Uint8Array.from({ length: 32000 }, (_, k) => packed[(k % 200) * 160 + Math.floor(k / 200)]);

    it.each([
        [1, '4-bit RLE, across', () => rle(packed, true)],
        [2, '4-bit RLE, down each column', () => rle(down, true)],
        [3, '8-bit LZW-12', () => lzw(p, 12)],
        [4, '8-bit RLE', () => rle(p)],
        [6, '8-bit LZW-14', () => lzw(p, 14)],
    ] as const)('reads type %i (%s)', (type, _, body) => {
        const data = build(type, body());
        expect(detect(data, null).id).toBe('cmp');
        const r = parse(data);
        expect(r.warnings).toEqual([]);
        expect(pixels(r)).toEqual(p);
        expect(r.end).toBe(data.length);
        // 4-bit pictures come with the EGA's colors: 9 is light blue.
        if (type <= 2) expect(r.preview?.kind === 'images' && [...r.preview.palette!.subarray(27, 30)]).toEqual([85, 85, 255]);
    });

    it("takes type 4's size one byte short, as the format's notes have it", () => {
        const data = build(4, [...rle(p), 0], { extra: 1 });
        expect(detect(data, null).id).toBe('cmp');
        expect(parse(data).warnings).toEqual([]);
        expect(parse(data).end).toBe(data.length);
    });

    it("says what doesn't fit the format", async () => {
        // Type 5: read as type 4, as DragonStrike does.
        const five = build(5, rle(p));
        expect(detect(five, null).id).not.toBe('cmp');
        expect(parse(five).warnings).toEqual([expect.stringMatching(/Type 5 isn't known to be used/)]);
        expect(pixels(parse(five))).toEqual(p);
        expect(() => parse(build(7, rle(p)))).toThrow(/Type 7 isn't one CMP pictures use/);
        // A decoded size that isn't 64,000, a size that's off, and a picture that's short.
        expect(parse(build(3, lzw(p, 12), { stated: 1234 })).warnings).toEqual([expect.stringMatching(/decoded size is 1,234 bytes; CMP pictures are always 64,000/)]);
        expect(parse(build(4, rle(p), { extra: 5 })).warnings.join()).toMatch(/header says the file is/);
        expect(parse(build(4, rle(p.subarray(0, 1000)))).warnings.join()).toMatch(/decodes to 1,000 bytes, short of the 64,000 bytes/);
        // LZW: a code from the future.
        expect(parse(build(3, [0x10, 0x5f, 0xff, 0])).warnings.join()).toMatch(/copies from outside what it's decoded so far/);
        // Hidden after the picture.
        const hidden = build(6, [...lzw(p, 14), ...new TextEncoder().encode('MZ payload')]);
        expect(detect(hidden, 'x.cmp').id).toBe('cmp');
        const r = await inspect(hidden, { name: 'x.cmp', names: [] });
        expect(r.checks[0]).toMatchObject({ level: 'danger' });
        expect(r.checks[0].text).toMatch(/10 bytes after the end/);
    });
});

describe("Lands of Lore's .cmp: CPS-style packed files", () => {
    const packedCps = (compression: number, inner: Uint8Array, body: ArrayLike<number> = inner) => {
        const rest = [...u16(compression), ...u32(inner.length), 0, 0, ...Array.from(body)];
        return Uint8Array.from([...u16(rest.length), ...rest]);
    };

    it("unpacks what's inside as a file of its own", () => {
        const inner = new TextEncoder().encode('[Basic]\nName=Test\n'.repeat(20));
        for (const [compression, body] of [
            [0, inner],
            [1, lzw(inner, 12)],
            [2, lzw(inner, 14)],
        ] as const) {
            const data = packedCps(compression, inner, body);
            expect(detect(data, 'x.cmp').id).toBe('cps');
            const r = cps.parse(data, { name: 'thing.cmp', names: [] });
            expect(r.warnings).toEqual([]);
            expect(r.title).toBe('Packed file (CPS-style)');
            expect(r.entries).toHaveLength(1);
            expect(r.entries![0].data).toEqual(inner);
            expect(r.entries![0].name).toBe('thing.ini');
        }
    });

    // A real Dune II sprite, packed as Lands of Lore packs its own.
    const DUNE = gameFile('dune2', 'DUNE.PAK') ?? '';
    it.skipIf(!DUNE)('finds a Dune II sprite inside', () => {
        const shp = pak.parse(new Uint8Array(readFileSync(DUNE)), { name: 'DUNE.PAK', names: [] }).entries!.find((e) => /\.shp$/i.test(e.label))!;
        const data = packedCps(1, shp.data, lzw(shp.data, 12));
        const r = cps.parse(data, { name: 'GOBLIN.CMP', names: [] });
        expect(r.summary).toContainEqual(['Contents', expect.stringMatching(/^Sprite \(Dune II-style SHP\)/)]);
        expect(r.entries![0].name).toBe('GOBLIN.shp');
        expect(detect(r.entries![0].data, r.entries![0].name).id).toBe('shp-d2');
    });
});
