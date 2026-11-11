import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Companion, Parsed } from '../../core/types';
import { gameFile } from '../../testing/game-data';
import { grayRemap, palette6 } from '../../testing/samples';
import { detect } from '../index';
import { inspect } from '../inspect';
import parser from './gray-remap';
import pak from './pak';

const paletteOnly =
    (data: Uint8Array) =>
    (name: string): Companion[] =>
        name.toUpperCase() === 'IBM.PAL' ? [{ data, source: 'DUNE.PAK' }] : [];
const parse = (data: Uint8Array, palette?: Uint8Array, name = 'GRAYRMAP.TBL') => parser.parse(data, { name, names: [], find: palette && paletteOnly(palette) }) as Parsed;
const summary = (r: Parsed, key: string) => r.summary.find(([k]) => k === key)?.[1];

describe('Dune II gray remap (GRAYRMAP.TBL)', () => {
    it('says what each color becomes, and with the palette, whether it’s gray', () => {
        const data = grayRemap();
        expect(detect(data, 'GRAYRMAP.TBL').id).toBe('gray-remap');
        const alone = parse(data);
        expect(alone.warnings).toEqual([]);
        expect(summary(alone, 'Colors')).toBe('15 replaced, 241 kept as they are');
        // White (15) is the brightest gray, 255; light gray (7, 42 of 63) is 16 + 42/63 of 239.
        expect(alone.fields[0].children?.[15].value).toBe('255');
        expect(alone.fields[0].children?.[7].value).toBe(String(16 + Math.round((42 / 63) * 239)));
        expect(alone.fields[0].children?.[0].value).toBe('0: kept');

        const r = parse(data, palette6());
        expect(summary(r, 'Grays')).toBe('Every color it draws with is a gray in IBM.PAL');
        expect(r.fields[0].children?.[1].name).toBe('Color 1 (0, 0, 42)');
        // Blue (1) to a gray as bright as it.
        expect(r.fields[0].children?.[1].value).toMatch(/^\d+ \((\d+), \1, \1\)$/);
        expect(r.preview).toMatchObject({ kind: 'images', palette: expect.any(Uint8Array) });

        // A table that draws with a color that isn't gray.
        const red = grayRemap();
        red[20] = 4;
        expect(summary(parse(red, palette6()), 'Grays')).toBe("1 of the colors it draws with isn't gray in IBM.PAL: 4");
        // Not the game's own name: what it's for isn't claimed.
        expect(summary(parse(data, undefined, 'OTHER.TBL'), 'For')).toMatch(/^Unknown/);
    });

    it('refuses what can’t be one', async () => {
        expect(() => parse(new Uint8Array(255))).toThrow(/is 256 bytes, one for each color; this is 255 bytes/);
        expect(() => parse(new Uint8Array(512))).toThrow(/this is 512 bytes/);
        // A text table named .tbl is read as text.
        const r = await inspect(new TextEncoder().encode('00=A\n01=B\n02=C\n'), { name: 'GAME.TBL', names: [] });
        expect(r.format.id).toBe('text');
    });

    // The game's own, in DUNE.PAK beside IBM.PAL, from wherever Dune II is installed (npm run test:setup).
    const PAK = gameFile('dune2', 'DUNE.PAK') ?? '';
    it.skipIf(!PAK)('reads Dune II’s, every color made a gray of IBM.PAL', async () => {
        const entries = pak.parse(new Uint8Array(readFileSync(PAK)), { name: 'DUNE.PAK', names: [] }).entries!;
        const table = entries.find((e) => e.label === 'GRAYRMAP.TBL')!.data;
        const palette = entries.find((e) => e.label === 'IBM.PAL')!.data;
        const r = await inspect(table, { name: 'GRAYRMAP.TBL', names: [], find: paletteOnly(palette) });
        expect(r.format.id).toBe('gray-remap');
        expect(r.parsed.warnings).toEqual([]);
        expect(r.checks).toEqual([]);
        expect(summary(r.parsed, 'Grays')).toBe('Every color it draws with is a gray in IBM.PAL');
        expect(summary(r.parsed, 'Drawn with')).toBe('15 colors: 0, 13, 14, 15, 126, 127, 128, 129, 130, 131, 132, 133, 134, 233, 236');
    });
});
