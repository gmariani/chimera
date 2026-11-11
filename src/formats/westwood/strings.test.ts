import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Parsed } from '../../core/types';
import { gameDir, gameFile } from '../../testing/game-data';
import { stringTable } from '../../testing/samples';
import { detect } from '../index';
import { parseMix } from '../mix';
import pak from './pak';
import parser from './strings';

const parse = (data: Uint8Array, name = 'x.eng') => parser.parse(data, { name, names: [] }) as Parsed;
const text = (r: Parsed) => (r.preview?.kind === 'text' ? r.preview.text : '');

describe('Westwood string tables', () => {
    it('reads plain ones in DOS characters', () => {
        const r = parse(stringTable(false), 'x.ger');
        expect(r.warnings).toEqual([]);
        expect(text(r)).toBe('0  Build\n1  Gebäude ausbauen\n2  Amélioration');
        expect(r.summary).toContainEqual(['Text', 'Plain, in DOS’s characters']);
    });

    it('decompresses Dune II’s', () => {
        const data = stringTable(true);
        expect(detect(data, 'TEXTA.ENG').id).toBe('strings');
        const r = parse(data);
        expect(r.warnings).toEqual([]);
        expect(text(r)).toContain('0  The Harkonnen come from the dark planet of Giedi Prime.');
        expect(r.summary).toContainEqual(['Text', expect.stringMatching(/^Compressed: a byte for each common pair of letters, as Dune II does \(\d+ pairs\)$/)]);
    });

    // The games' own, from wherever they're installed (npm run test:setup).
    const ENGLISH = gameFile('dune2', 'ENGLISH.PAK') ?? '';
    it.skipIf(!ENGLISH)('decompresses Dune II’s TEXTA.ENG, and leaves its plain DUNE.ENG as it is', () => {
        const entries = pak.parse(new Uint8Array(readFileSync(ENGLISH)), { name: 'ENGLISH.PAK', names: [] }).entries!;
        const texta = parse(entries.find((e) => e.label === 'TEXTA.ENG')!.data);
        expect(texta.summary).toContainEqual(['Text', expect.stringMatching(/^Compressed/)]);
        // Dune II breaks lines with a lone carriage return.
        expect(text(texta)).toContain('House Atreides\\nCaladan, home planet of the Atreides');
        expect(text(texta)).not.toMatch(/[\u0080-ÿ]{2}/);
        expect(parse(entries.find((e) => e.label === 'DUNE.ENG')!.data).summary).toContainEqual(['Text', 'Plain, in DOS’s characters']);
    });

    const CNC = gameDir('cncRemastered') ?? '';
    it.skipIf(!CNC)('reads C&C’s German and French with their accents', () => {
        const entries = parseMix(new Uint8Array(readFileSync(join(CNC, 'TIBERIAN_DAWN/CD1/CCLOCAL.MIX'))), { name: null, names: ['conquer.ger', 'conquer.fre'] }).entries!;
        expect(text(parse(entries.find((e) => e.name === 'conquer.ger')!.data, 'conquer.ger'))).toContain('Gebäude ausbauen');
        expect(text(parse(entries.find((e) => e.name === 'conquer.fre')!.data, 'conquer.fre'))).toContain('Amélioration');
    });
});
