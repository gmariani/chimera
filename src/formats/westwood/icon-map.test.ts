import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Companion, IndexedImage, Parsed } from '../../core/types';
import { gameFile } from '../../testing/game-data';
import { icn, iconMap } from '../../testing/samples';
import { detect } from '../index';
import { inspect } from '../inspect';
import icnParser from './icn-d2';
import parser from './icon-map';
import pak from './pak';

const words = (...w: number[]) => Uint8Array.from(w.flatMap((v) => [v & 0xff, v >> 8]));
const tilesOnly =
    (data: Uint8Array) =>
    (name: string): Companion[] =>
        name.toUpperCase() === 'ICON.ICN' ? [{ data, source: 'DUNE.PAK' }] : [];
const parse = (data: Uint8Array, tiles?: Uint8Array) => parser.parse(data, { name: 'ICON.MAP', names: [], find: tiles && tilesOnly(tiles) }) as Parsed;
const frames = (r: Parsed): IndexedImage[] => (r.preview?.kind === 'images' ? r.preview.frames : []);
/** The map's own words, changed at some of them. */
const changed = (at: Record<number, number>, extra: number[] = []) => {
    const w = Array.from({ length: iconMap().length / 2 }, (_, i) => iconMap()[i * 2] | (iconMap()[i * 2 + 1] << 8));
    for (const [i, v] of Object.entries(at)) w[Number(i)] = v;
    return words(...w, ...extra);
};

describe('Dune II map tile groups (ICON.MAP)', () => {
    it('names the 26 groups, and draws each from ICON.ICN when it’s open', () => {
        const data = iconMap();
        expect(detect(data, 'ICON.MAP').id).toBe('icon-map');
        expect(detect(data, null).id).toBe('icon-map');
        const alone = parse(data);
        expect(alone.warnings).toEqual([]);
        expect(alone.preview).toBeUndefined();
        expect(alone.summary).toContainEqual(['Pictures', 'Open ICON.ICN too (it’s in DUNE.PAK) to see each group drawn']);
        const palace = alone.fields.find((f) => f.name === 'Group 11: Palace')!;
        expect(palace.value).toBe('1 state of 3 × 3 tiles');
        expect(palace.children?.[0].value).toBe('2 5 0 3 6 1 4 7 2');
        expect(alone.fields.reduce((n, f) => n + f.length, 0)).toBe(data.length);

        // With the tiles: the palace is 3 × 3 of them, row by row, each as ICON.ICN draws it.
        const r = parse(data, icn());
        expect(r.warnings).toEqual([]);
        expect(r.summary).toContainEqual(['Pictures', '26 groups drawn from ICON.ICN (DUNE.PAK)']);
        const tiles = frames(icnParser.parse(icn(), { name: 'ICON.ICN', names: [] }) as Parsed);
        const p = frames(r)[10];
        expect([p.width, p.height]).toEqual([48, 48]);
        expect(p.pixels.subarray(0, 16)).toEqual(tiles[2].pixels.subarray(0, 16));
        expect(p.pixels.subarray(48 * 16 + 16, 48 * 16 + 32)).toEqual(tiles[3].pixels.subarray(0, 16));
    });

    it('says what doesn’t fit', () => {
        expect(parse(changed({ 27: 5 })).warnings).toEqual(['The index should end with 0, at word 27, but has 5 there.']);
        // A palace whose last tile is cut off: 8 tiles, not 9 (the light factory starts a word early).
        expect(parse(changed({ 12: iconMap()[24] - 1 })).warnings.join()).toMatch(/^Palace has 8 tiles, which isn't a whole number of its 3 × 3 footprint/);
        // Group 2 starting where group 3 does.
        expect(parse(changed({ 2: 30 })).warnings).toEqual(["Sand craters has no tiles; the game would draw the next group's in its place."]);
        expect(parse(new Uint8Array([...iconMap(), 7])).warnings).toEqual(['The file is an odd number of bytes; the game reads it as 16-bit words, so the last byte is never read.']);
        // Fewer groups than the game reads: 3, then the end marker.
        expect(parse(words(4, 5, 6, 7, 0, 1, 2, 3)).warnings).toEqual([
            'There are 3 groups; the game reads 26. For bodies in the sand and those after, it would take its tile numbers from whatever is there.',
        ]);
        // A tile ICON.ICN doesn't have (the sample has 8).
        expect(parse(changed({ 28: 8 }), icn()).warnings).toEqual(['1 tile number is past the 8 tiles of ICON.ICN: the game would draw from memory past them.']);
    });

    it('refuses what isn’t one', async () => {
        expect(() => parse(words(1, 0))).toThrow(/too short/);
        expect(() => parse(words(1, 2, 0, 0))).toThrow(/the number of index entries, is 1/);
        expect(() => parse(words(9, 10, 0, 0))).toThrow(/runs past the end/);
        expect(() => parse(words(3, 5, 4, 0, 1, 2))).toThrow(/should start right after the index, at word 4/);
        expect(() => parse(words(3, 4, 99, 0, 1, 2))).toThrow(/Group 2 starts at word 99, past the end/);
        expect(() => parse(words(4, 5, 7, 6, 0, 1, 2, 3))).toThrow(/Group 3 starts at word 6, before group 2/);
        // Something else named .map isn't taken for one.
        const r = await inspect(new TextEncoder().encode('Linker map: 0040:1000 main'), { name: 'GAME.MAP', names: [] });
        expect(r.format.id).not.toBe('icon-map');
    });

    // The game's own, in DUNE.PAK beside ICON.ICN, from wherever Dune II is installed (npm run test:setup).
    const PAK = gameFile('dune2', 'DUNE.PAK') ?? '';
    it.skipIf(!PAK)('reads Dune II’s, every building a whole number of its footprint, with nothing to warn about', async () => {
        const entries = pak.parse(new Uint8Array(readFileSync(PAK)), { name: 'DUNE.PAK', names: [] }).entries!;
        const map = entries.find((e) => e.label === 'ICON.MAP')!.data;
        const tiles = entries.find((e) => e.label === 'ICON.ICN')!.data;
        expect(detect(map, null).id).toBe('icon-map');
        const r = await inspect(map, { name: 'ICON.MAP', names: [], find: tilesOnly(tiles) });
        expect(r.format.id).toBe('icon-map');
        expect(r.parsed.warnings).toEqual([]);
        expect(r.checks).toEqual([]);
        expect(r.parsed.summary).toEqual([
            ['Groups', '26'],
            ['Tiles', '715 listed, numbers 1 to 398'],
            ['Pictures', '26 groups drawn from ICON.ICN (DUNE.PAK)'],
        ]);
        // OpenDUNE's footprints divide every building's group: the palace in 4 states, the starport in 10.
        const value = (name: string) => r.parsed.fields.find((f) => f.name === name)?.value;
        expect(value('Group 11: Palace')).toBe('4 states of 3 × 3 tiles');
        expect(value('Group 20: Starport')).toBe('10 states of 3 × 3 tiles');
        expect(value('Group 23: Gun turret')).toBe('10 states of 1 × 1 tiles');
        expect(frames(r.parsed)[10]).toMatchObject({ width: 4 * 48 + 3 * 4, height: 48 });
    });
});
