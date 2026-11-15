import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gameDir } from '../../testing/game-data';
import { blendTable, palette6 } from '../../testing/samples';
import { detect } from '../index';
import mix from '../mix/index';
import blend from './blend-table';

const parse = (data: Uint8Array, name = 'sides.pal') => blend.parse(data, { name, names: [] });
const summary = (data: Uint8Array, key: string, name?: string) => parse(data, name).summary.find(([k]) => k === key)?.[1];

describe('TD palette blending tables', () => {
    it('reads a table made as the game makes one', () => {
        const data = blendTable();
        expect(detect(data, 'sides.pal').id).toBe('blend-table');
        expect(detect(data, null).id).toBe('blend-table');
        const r = parse(data);
        expect(r.warnings).toEqual([]);
        expect(r.end).toBe(65536);
        expect(summary(data, 'Used for')).toBe('The intro, choosing a side (INTRO.CPP)');
        // Brightened by 30% and capped at 63 as the game does, the colors that match an earlier one: the 6-bit gray ramp
        // repeats levels, and the grays from 49 up are all 63, the same as white (15).
        const p = palette6().map((v) => Math.min(63, v + Math.floor((v * 30) / 100)));
        const rgb = (i: number) => `${p[i * 3]},${p[i * 3 + 1]},${p[i * 3 + 2]}`;
        const firsts = new Map<string, number>();
        const repeated: [number, number][] = [];
        for (let i = 0; i < 256; i++) {
            if (firsts.has(rgb(i))) repeated.push([i, firsts.get(rgb(i))!]);
            else firsts.set(rgb(i), i);
        }
        expect(summary(data, 'Repeated colors')).toMatch(new RegExp(`^${repeated.length}, the same as an earlier color in the palette it was made from: ${repeated[0][0]}, `));
        for (const [i, first] of repeated) expect(r.fields[0].children![i].value).toBe(`the same as color ${first}`);
        expect(repeated.at(-1)).toEqual([255, 15]);
        // Black and white make a middle gray: the blend is in the ramp, not one of the EGA colors.
        expect(data[15]).toBeGreaterThanOrEqual(16);
    });

    it('says when a pair blends differently by which comes first', () => {
        const data = blendTable();
        data[3 * 256 + 200] = 9;
        expect(detect(data, 'sides.pal').id).not.toBe('blend-table');
        expect(parse(data).warnings).toEqual([
            `1 pair of colors blend differently by which is first (the first: 3 and 200 give 9, the other way round ${data[200 * 256 + 3]}). The game's own tables are the same either way round.`,
        ]);
    });

    it('says when a color blended with itself gives a later one', () => {
        const data = blendTable();
        data[5 * 257] = 6;
        expect(detect(data, 'sides.pal').id).not.toBe('blend-table');
        expect(parse(data).warnings).toEqual([
            "1 color blended with itself gives a later color (the first: 5 gives 6): the game's search keeps the first match, so a color can only give itself or an earlier one.",
        ]);
    });

    it('takes nothing else of its size', () => {
        expect(detect(new Uint8Array(65536), 'zeros.pal').id).not.toBe('blend-table');
        let seed = 7;
        const noise = Uint8Array.from({ length: 65536 }, () => (seed = (seed * 1103515245 + 12345) >>> 0) >>> 24);
        expect(detect(noise, 'noise.pal').id).not.toBe('blend-table');
        expect(() => parse(new Uint8Array(768))).toThrow(/^Not a blending table: it's 768 bytes/);
    });
});

const update = join(gameDir('cncRemastered') ?? '', 'TIBERIAN_DAWN/CD3/UPDATE.MIX');

describe.skipIf(!existsSync(update))('TD’s blending tables in UPDATE.MIX', () => {
    it('reads all 13, each the same either way round', () => {
        const entries = mix.parse(new Uint8Array(readFileSync(update)), { name: 'UPDATE.MIX', names: [] }).entries!.filter((e) => e.name?.endsWith('.pal'));
        expect(entries).toHaveLength(13);
        for (const e of entries) {
            expect(detect(e.data, e.name).id, e.name!).toBe('blend-table');
            const r = parse(e.data, e.name!);
            expect(r.warnings, e.name!).toEqual([]);
            expect(r.summary[0][0], e.name!).toBe('Used for');
        }
    });
});
