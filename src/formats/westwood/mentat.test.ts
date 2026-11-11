import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Parsed } from '../../core/types';
import { gameFile } from '../../testing/game-data';
import { mentat } from '../../testing/samples';
import { detect } from '../index';
import { inspect } from '../inspect';
import { dune2Text } from './dune2-text';
import { dune2Compress } from './encoders.test-util';
import parser from './mentat';
import pak from './pak';

const parse = (data: Uint8Array) => parser.parse(data, { name: 'MENTATA.ENG', names: [] }) as Parsed;
const text = (r: Parsed) => (r.preview?.kind === 'text' ? r.preview.text : '');

describe('Dune II text compression', () => {
    it('makes two letters of each byte from 0x80 up, as OpenDUNE does', () => {
        // " t" is the first pair (0x80); "th" is t's first (0x80 | 2 << 3 = 0x90); 0x1B then 1 is 0x80, Ç in the PC's character set, and then 2, ü.
        expect(dune2Text(Uint8Array.from([0x80, 0x90, 0x65, 0x1b, 0x01, 0x1b, 0x02])).text).toBe(' ttheÇü');
        const words = 'The Harkonnen come from the dark planet of Giedi Prime.';
        const packed = dune2Compress(words);
        expect(packed.length).toBeLessThan(words.length);
        expect(dune2Text(Uint8Array.from(packed))).toEqual({ text: words, pairs: words.length - packed.length });
    });
});

describe('Dune II mentat encyclopedia', () => {
    it('lists the topics under their headings, with each one’s animation, description and text', () => {
        const data = mentat();
        expect(detect(data, 'MENTATA.ENG').id).toBe('mentat');
        const r = parse(data);
        expect(r.warnings).toEqual([]);
        expect(r.summary).toContainEqual(['Topics', '2 under 2 headings']);
        expect(text(r)).toContain("-- Advice --\n(from mission 1: the mission's own briefing picture and text, its text number 3)");
        expect(text(r)).toContain(
            '== STRUCTURES ==\n\n-- Wind Trap --\n(from mission 1; animation windtrap.wsa, looping)\nWind Trap\nPower Output: 100\n\nThe wind trap draws water from the air, and power from the wind.'
        );
        expect(r.fields.reduce((n, f) => n + f.length, 0)).toBe(data.length);
    });

    it('says what doesn’t fit', async () => {
        // A topic whose text is said to be outside DESC.
        const outside = mentat();
        outside.set([0, 0, 0, 4], 12 + 8 + 1); // the first topic's text, said to be at 4
        expect(parse(outside).warnings).toContain('“Briefing” says its text is at 4, outside the DESC chunk.');
        // A topic too short to be one.
        const short = mentat();
        short[12 + 8] = 3;
        expect(parse(short).warnings.join()).toMatch(/says it's 3 bytes, which can't hold a topic/);
        expect(() => parse(new TextEncoder().encode('FORM\0\0\0\x04MENT'))).toThrow(/no NAME chunk/);
        expect(() => parse(new TextEncoder().encode('Just a text file named like one'))).toThrow(/isn't Dune II's mentat encyclopedia/);
        // After the FORM: the usual check.
        const r = await inspect(Uint8Array.from([...mentat(), ...new TextEncoder().encode('MZ payload')]), { name: 'MENTATA.ENG', names: [] });
        expect(r.format.id).toBe('mentat');
        expect(r.checks[0]).toMatchObject({ level: 'danger' });
        expect(r.checks[0].text).toMatch(/10 bytes after the end/);
    });

    // The game's own, in ENGLISH.PAK (and the others' languages), from wherever Dune II is installed (npm run test:setup).
    const PAK = gameFile('dune2', 'ENGLISH.PAK') ?? '';
    it.skipIf(!PAK)('reads Dune II’s three, one a house, with nothing to warn about', async () => {
        const entries = pak.parse(new Uint8Array(readFileSync(PAK)), { name: 'ENGLISH.PAK', names: [] }).entries!.filter((e) => /^MENTAT.\.ENG$/.test(e.label));
        expect(entries.map((e) => e.label)).toEqual(['MENTATA.ENG', 'MENTATH.ENG', 'MENTATO.ENG']);
        for (const e of entries) {
            const r = await inspect(e.data, { name: e.label, names: [] });
            expect(r.format.id, e.label).toBe('mentat');
            expect(r.parsed.warnings, e.label).toEqual([]);
            expect(r.checks, e.label).toEqual([]);
            expect(r.parsed.summary, e.label).toContainEqual(['Topics', '44 under 5 headings']);
        }
        expect(text(parse(entries[0].data))).toContain('Our ancestral home is the lush planet of Caladan.');
    });
});
