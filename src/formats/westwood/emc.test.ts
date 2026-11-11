import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Parsed } from '../../core/types';
import { gameFile } from '../../testing/game-data';
import { emcScript } from '../../testing/samples';
import { detect } from '../index';
import { inspect } from '../inspect';
import parser from './emc';
import pak from './pak';

const parse = (data: Uint8Array, name = 'TEAM.EMC') => parser.parse(data, { name, names: [] }) as Parsed;
const text = (r: Parsed) => (r.preview?.kind === 'text' ? r.preview.text : '');
const summary = (r: Parsed, key: string) => r.summary.find(([k]) => k === key)?.[1];

describe('Dune II scripts (EMC)', () => {
    it('lists each script and decodes its instructions, naming the game’s routines', () => {
        const data = emcScript();
        expect(detect(data, 'TEAM.EMC').id).toBe('emc');
        expect(detect(data, null).id).toBe('emc');
        const r = parse(data);
        expect(r.warnings).toEqual([]);
        expect(r.summary).toEqual([
            ['For', 'The computer’s teams (TEAM.EMC)'],
            ['Scripts', '5, starting at 2 places'],
            ['Instructions', '14 (15 words)'],
            ['Calls', '3, to 3 different routines'],
        ]);
        expect(text(r)).toBe(
            [
                '; (shared code)',
                '   0> Push 30',
                '   1  Call routine 0: Wait',
                '   2  Drop 1 value',
                '   3  Return from a call',
                '',
                '; Normal (team 0)',
                '; Staging (team 1)',
                '; Kamikaze (team 3)',
                '; Guard (team 4)',
                '   4> Push where to come back to (a call follows)',
                '   5  Jump to 0',
                '   6  Call routine 2: How many members',
                '   7  Push the result',
                '   8  Push 5',
                '   9  Combine the top two: <',
                '  10  Jump to 4 if zero',
                '  12  Call routine 9: Switch back to the team’s first script',
                '  13  Jump to 4',
                '',
                '; Flee (team 2)',
                '  14  Return from a call',
            ].join('\n')
        );
        // The FORM's size counts the whole file, as Westwood's compiler did; IFF's own way (without its header) is read too.
        expect(r.fields[0].children![1].note).toMatch(/The whole file/);
        const iff = emcScript();
        iff.set([0, 0, 0, iff.length - 8], 4);
        expect(parse(iff).warnings).toEqual([]);
        // A value in the next word, as a push of 1,000 is written.
        expect(text(parse(emcScript({ change: (w) => w.splice(0, 1, 0x2300, 1000) })))).toContain('   0> Push 1000');
        // Without the file's name, the routines are only numbers.
        expect(text(parse(data, 'SCRIPT.EMC'))).toContain('Call routine 2\n');
    });

    it('says what doesn’t fit', () => {
        expect(parse(emcScript({ change: (w) => (w[8] = 0x1500) })).warnings).toEqual(["1 instruction has an opcode the game doesn't have: it stops the script there."]);
        expect(parse(emcScript({ change: (w) => (w[9] = 0x5112) })).warnings).toEqual(["1 instruction asks for an operation the game doesn't have: it stops the script there."]);
        expect(parse(emcScript({ change: (w) => (w[6] = 0x4e20) })).warnings).toEqual([`1 call is to a routine this script's list doesn't have: the game reports "Unknown function".`]);
        expect(parse(emcScript({ change: (w) => (w[13] = 0x8100) })).warnings).toEqual(['1 jump goes past the end of DATA or into the middle of an instruction.']);
        // An entry pointing at the second word of a two-word jump.
        expect(parse(emcScript({ entries: [4, 4, 11, 4, 4] })).warnings).toEqual(['Flee (team 2) starts at word 11, into the middle of an instruction.']);
        // A building script with too few entries for the game's 19 structure types.
        expect(parse(emcScript(), 'BUILD.EMC').warnings).toEqual(['There are 5 entries; the game has 19 structure types, and would read past the table for the rest.']);
        // A value meant to be in the next word, past the end.
        expect(
            parse(emcScript({ change: (w) => (w[14] = 0x2300) }))
                .fields[2].children!.at(-1)!
                .children!.at(-1)!.note
        ).toMatch(/past the end of DATA/);
        expect(() => parse(new TextEncoder().encode('FORM\0\0\0\x0cEMC2ORDR\0\0\0\0'))).toThrow(/no DATA chunk; the game won't load it/);
        expect(() => parse(new TextEncoder().encode('FORM\0\0\0\x0cILBMBMHD\0\0\0\0'))).toThrow(/isn't a Dune II script/);
    });

    // The game's own three, in DUNE.PAK, from wherever Dune II is installed (npm run test:setup).
    const PAK = gameFile('dune2', 'DUNE.PAK') ?? '';
    it.skipIf(!PAK)('reads Dune II’s three, every call to a routine OpenDUNE has, with nothing to warn about', async () => {
        const entries = pak.parse(new Uint8Array(readFileSync(PAK)), { name: 'DUNE.PAK', names: [] }).entries!;
        const expected: Record<string, [string, string]> = {
            'BUILD.EMC': ['For', 'Structures (BUILD.EMC)'],
            'UNIT.EMC': ['For', 'Units (UNIT.EMC)'],
            'TEAM.EMC': ['For', 'The computer’s teams (TEAM.EMC)'],
        };
        for (const [name, line] of Object.entries(expected)) {
            const data = entries.find((e) => e.label === name)!.data;
            expect(detect(data, null).id, name).toBe('emc');
            const r = await inspect(data, { name, names: [] });
            expect(r.format.id, name).toBe('emc');
            expect(r.parsed.warnings, name).toEqual([]);
            expect(
                r.checks.filter((c) => c.level !== 'info'),
                name
            ).toEqual([]);
            expect(r.parsed.summary, name).toContainEqual(line);
        }
        // One script for each of OpenDUNE's 19 structure types and 27 unit types.
        const build = parse(entries.find((e) => e.label === 'BUILD.EMC')!.data, 'BUILD.EMC');
        expect(summary(build, 'Scripts')).toBe('19, starting at 19 places');
        const unit = parse(entries.find((e) => e.label === 'UNIT.EMC')!.data, 'UNIT.EMC');
        expect(summary(unit, 'Scripts')).toBe('27, starting at 27 places');
        // A team in its normal script checks its size and spread, and switches to staging (team 1) if it's too small.
        const team = text(parse(entries.find((e) => e.label === 'TEAM.EMC')!.data));
        expect(team).toContain('   3  Call routine 2: How many members\n   4  Push the result\n   5  Call routine 12: Team variable 6');
        expect(team).toContain('  10  Push 1\n  11  Call routine 8: Switch to another team script');
    });
});
