import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Parsed } from '../core/types';
import { gameFile } from '../testing/game-data';
import { pif } from '../testing/samples';
import { detect } from './index';
import { inspect } from './inspect';
import parser from './pif';

const parse = (data: Uint8Array) => parser.parse(data, { name: 'x.pif', names: [] }) as Parsed;

describe('program information files (PIF)', () => {
    it('says what it runs, with what, and how', () => {
        const data = pif();
        expect(detect(data, 'program.pif').id).toBe('pif');
        const r = parse(data);
        expect(r.warnings).toEqual([]);
        expect(r.summary).toEqual(
            expect.arrayContaining([
                ['Title', 'Chimera'],
                ['Runs', 'CHIMERA.EXE'],
                ['With', '/SAMPLE'],
                ['Starts in', 'C:\\CHIMERA'],
                ['Memory', '256 to 640 KB'],
                ['Screen', '25 rows × 80 columns'],
                ['When it ends', 'The window closes'],
            ])
        );
        expect(r.fields.reduce((n, f) => n + f.length, 0)).toBe(data.length);
    });

    it('says what doesn’t fit', async () => {
        expect(parse(pif({ sections: [['WINDOWS 386 3.0', 0x40]] })).warnings).toEqual(['The "WINDOWS 386 3.0" section is 64 bytes; it\'s always 104 bytes.']);
        expect(parse(pif({ sections: [['WINDOWS 999 9.9', 4]] })).warnings).toEqual(['There\'s a section "WINDOWS 999 9.9", which no Windows defines; none would read it.']);
        // No list of sections after the basic one: not a PIF (by content), and refused as one.
        const plain = Uint8Array.from([...pif().subarray(0, 0x171), ...new Array(40).fill(7)]);
        expect(detect(plain, null).id).not.toBe('pif');
        expect(() => parse(plain)).toThrow(/no list of sections/);
        // After the last section: the usual check.
        const r = await inspect(Uint8Array.from([...pif(), ...new TextEncoder().encode('MZ payload')]), { name: 'x.pif', names: [] });
        expect(r.format.id).toBe('pif');
        expect(r.checks[0]).toMatchObject({ level: 'danger' });
        expect(r.checks[0].text).toMatch(/10 bytes after the end/);
    });

    it('calls out a program named .pif: Windows runs it as one', async () => {
        const program = new Uint8Array(512);
        program.set(new TextEncoder().encode('MZ'), 0);
        program[0x3c] = 0x40;
        program.set(new TextEncoder().encode('PE\0\0'), 0x40);
        program.set([0x4c, 0x01], 0x44);
        const r = await inspect(program, { name: 'readme.pif', names: [] });
        expect(r.checks.some((c) => c.level === 'danger')).toBe(true);
    });

    // Dune II's, from wherever it's installed (npm run test:setup).
    const DUNE = gameFile('dune2', 'DUNE2.PIF') ?? '';
    it.skipIf(!DUNE)('reads Dune II’s DUNE2.PIF', () => {
        const r = parse(new Uint8Array(readFileSync(DUNE)));
        expect(r.warnings).toEqual([]);
        expect(r.summary).toEqual(
            expect.arrayContaining([
                ['Title', 'Dune II'],
                ['Runs', 'DUNE2.EXE'],
                ['Starts in', 'f:\\games\\dune2'],
            ])
        );
        expect(r.fields.find((f) => f.name === 'Windows 95 and 98 settings')?.note).toMatch(/It names: PIFMGR\.DLL, Terminal, Lucida Console/);
    });
});
