import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { IndexedImage, Parsed } from '../../core/types';
import { gameFile } from '../../testing/game-data';
import { detect } from '../index';
import { inspect } from '../inspect';
import { lcwLiterals } from './encoders.test-util';
import icn from './icn-d2';
import pak from './pak';

const enc = new TextEncoder();
const be32 = (v: number) => [v >>> 24, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
const le16 = (v: number) => [v & 0xff, v >> 8];
const le32 = (v: number) => [...le16(v & 0xffff), ...le16(v >>> 16)];
const chunk = (id: string, body: ArrayLike<number>) => [...enc.encode(id), ...be32(body.length), ...Array.from(body), ...(body.length & 1 ? [0] : [])];

/** Two 16 × 16 tiles: the first all color 1 with a column of 2 at the left, the second a checkerboard of 0 and 3. */
function tiles(): Uint8Array {
    const t = new Uint8Array(256);
    for (let i = 0; i < 128; i++) t[i] = i % 8 === 0 ? 0x21 : 0x11;
    for (let i = 128; i < 256; i++) t[i] = (Math.floor((i - 128) / 8) & 1) === 0 ? 0x03 : 0x30;
    return t;
}

/** A FORM/ICON of those tiles, palette 0 opaque (colors 50, 51, 52, 53…) and palette 1 starting with 0 (see-through). */
function build({ lcw = false, sinf = [2, 2, 3, 4], rtbl = [0, 1], extra = [] as number[][], after = [] as number[] } = {}): Uint8Array {
    const pixels = tiles();
    const body = lcw ? lcwLiterals(pixels) : Array.from(pixels);
    const sset = [...le16(lcw ? 4 : 0), ...le32(pixels.length), ...le16(0), ...body];
    const rpal = [...Array.from({ length: 16 }, (_, i) => 50 + i), 0, 60, 61, 62, ...new Array(12).fill(70)];
    const chunks = [...chunk('SINF', sinf), ...chunk('SSET', sset), ...chunk('RPAL', rpal), ...chunk('RTBL', rtbl), ...extra.flat()];
    return Uint8Array.from([...enc.encode('FORM'), ...be32(4 + chunks.length), ...enc.encode('ICON'), ...chunks, ...after]);
}

const parse = (data: Uint8Array) => icn.parse(data, { name: 'ICON.ICN', names: [] }) as Parsed;
const frames = (r: Parsed): IndexedImage[] => (r.preview?.kind === 'images' ? r.preview.frames : []);

describe('Dune II map tiles (ICN)', () => {
    it.each([false, true])('reads the tiles through their own palettes (LCW: %s)', (lcw) => {
        const data = build({ lcw });
        expect(detect(data, 'ICON.ICN').id).toBe('icn-d2');
        const r = parse(data);
        expect(r.warnings).toEqual([]);
        expect(r.summary).toContainEqual(['Tiles', '2, 16 × 16']);
        const [a, b] = frames(r);
        // Tile 1 through palette 0: color 1 is 51, the left column's 2 is 52.
        expect([a.pixels[0], a.pixels[1], a.pixels[16]]).toEqual([52, 51, 52]);
        // Tile 2 through palette 1: 0 stays 0 (see-through), 3 is 62.
        expect([b.pixels[0], b.pixels[1]]).toEqual([0, 62]);
        expect(r.summary).toContainEqual(['Transparent', '1 tile has see-through edges']);
        // Every byte is in a field.
        expect(r.fields.reduce((n, f) => n + f.length, 0)).toBe(data.length);
    });

    it("says what doesn't fit the format", async () => {
        expect(parse(build({ rtbl: [0] })).warnings).toEqual(['There are 2 tiles but 1 entry saying which palette each uses.']);
        expect(parse(build({ rtbl: [0, 9] })).warnings).toEqual(['1 tile uses a palette past the 2 there are.']);
        expect(parse(build({ sinf: [2, 2, 3, 8] })).warnings.join()).toMatch(/SINF says 8 bits a pixel/);
        expect(parse(build({ extra: [chunk('XTRA', [1, 2, 3])] })).warnings).toEqual(["There's a XTRA chunk, which Dune II's tile files don't have; the game skips it."]);
        expect(() => parse(build({ sinf: [2, 1, 3, 4] }))).toThrow(/Dune II only draws square tiles/);
        expect(() => parse(Uint8Array.from([...enc.encode('FORM'), ...be32(4), ...enc.encode('ICON')]))).toThrow(/no SINF, SSET, RPAL, RTBL chunks/);
        expect(() => parse(enc.encode('FORM....ILBM'))).toThrow(/isn't a Dune II tile file/);
        // After the FORM: the usual check.
        const r = await inspect(build({ after: [...enc.encode('MZ payload')] }), { name: 'ICON.ICN', names: [] });
        expect(r.format.id).toBe('icn-d2');
        expect(r.checks[0]).toMatchObject({ level: 'danger' });
        expect(r.checks[0].text).toMatch(/10 bytes after the end/);
    });

    // The game's own, inside DUNE.PAK, from wherever Dune II is installed (npm run test:setup).
    const DUNE = gameFile('dune2', 'DUNE.PAK') ?? '';
    it.skipIf(!DUNE)("reads Dune II's ICON.ICN with nothing to warn about", async () => {
        const entry = pak.parse(new Uint8Array(readFileSync(DUNE)), { name: 'DUNE.PAK', names: [] }).entries!.find((e) => e.label === 'ICON.ICN')!;
        const r = parse(entry.data);
        expect(r.warnings).toEqual([]);
        expect(r.summary).toEqual(
            expect.arrayContaining([
                ['Tiles', '399, 16 × 16'],
                ['Palettes', '169 of 16 colors (169 used), into the game palette'],
            ])
        );
        expect(r.end).toBe(entry.data.length);
        expect((await inspect(entry.data, { name: 'ICON.ICN', names: [] })).checks).toEqual([]);
    });
});
