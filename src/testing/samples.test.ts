import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detect } from '../formats/index';
import { inspect } from '../formats/inspect';
import { REPO } from './game-data';
import { samples } from './samples';

const DIR = join(REPO, 'samples/generated');

describe('generated samples', () => {
    it.each(samples().map((s) => [s.name, s] as const))('%s reads as its format, with nothing to warn about', async (_, sample) => {
        expect(detect(sample.data, sample.name).id).toBe(sample.format);
        const r = await inspect(sample.data, { name: sample.name, names: [] });
        expect(r.format.id).toBe(sample.format);
        expect(r.parsed.warnings).toEqual([]);
        expect(r.checks.filter((c) => c.level !== 'info')).toEqual([]);
    });

    // The committed files are what the generator makes today (npm run samples writes them again).
    it.each(samples().map((s) => [s.name, s] as const))('%s is committed as made', (name, sample) => {
        const path = join(DIR, name);
        expect(existsSync(path), `${name} is missing: run npm run samples`).toBe(true);
        expect(new Uint8Array(readFileSync(path)), `${name} differs from what the generator makes: run npm run samples`).toEqual(sample.data);
    });
});
