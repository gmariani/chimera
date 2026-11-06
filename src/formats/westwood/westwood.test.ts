import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detect } from '../index';
import { parseMix } from '../mix';
import { format40, lcw } from './compression';

describe('LCW', () => {
    it('decodes literals, fills, and copies', () => {
        // 0x83 'abc' (3 literals), 0xFE 05 00 'x' (5 × x), 0x00 0x08 (copy 3 from 8 back), 0x80 (end)
        const src = Uint8Array.of(0x83, 97, 98, 99, 0xfe, 5, 0, 120, 0x00, 0x08, 0x80);
        const out = new Uint8Array(11);
        expect(lcw(src, out)).toBe(11);
        expect(new TextDecoder().decode(out)).toBe('abcxxxxxabc');
    });
});

describe('format 40', () => {
    it('XORs and skips', () => {
        const dest = Uint8Array.of(1, 1, 1, 1, 1, 1);
        // skip 2, xor next 2 with literal [3, 3], fill-xor 2 with 7, end
        format40(Uint8Array.of(0x82, 0x02, 3, 3, 0x00, 2, 7, 0x80, 0, 0), dest);
        expect([...dest]).toEqual([1, 1, 2, 2, 6, 6]);
    });
});

// Every file in the sample archives: what it's detected as, and that its parser runs cleanly.
const samples = join(__dirname, '../../../samples/westwood');
describe.skipIf(!existsSync(samples))('sample archive contents', () => {
    const archives = existsSync(samples) ? readdirSync(samples).filter((n) => /\.mix$/i.test(n) && !/^movies/i.test(n)) : [];
    it.each(archives)('%s', async (archive) => {
        const parsed = parseMix(new Uint8Array(readFileSync(join(samples, archive))), { name: archive, names: [] });
        const counts: Record<string, number> = {};
        const problems: string[] = [];
        for (const entry of parsed.entries!) {
            const format = detect(entry.data, entry.name);
            counts[format.id] = (counts[format.id] ?? 0) + 1;
            try {
                const result = (await format.load()).parse(entry.data, { name: entry.name, names: [] });
                if (result.warnings.length) problems.push(`${entry.label} (${format.id}): ${result.warnings[0]}`);
            } catch (e) {
                problems.push(`${entry.label} (${format.id}) threw: ${e instanceof Error ? e.message : e}`);
            }
        }
        console.log(archive, JSON.stringify(counts));
        expect(problems).toEqual([]);
    });
});
