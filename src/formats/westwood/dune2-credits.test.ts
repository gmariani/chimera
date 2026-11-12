import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Parsed } from '../../core/types';
import { gameDir, gameFile } from '../../testing/game-data';
import { duneCredits } from '../../testing/samples';
import { detect } from '../index';
import { inspect } from '../inspect';
import parser from './dune2-credits';
import { sniffDuneCredits } from './dune2-credits-layout';
import pak from './pak';

const parse = (data: Uint8Array) => parser.parse(data, { name: 'CREDITS.ENG', names: [] }) as Parsed;
const latin1 = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

describe('Dune II credits', () => {
    it('reads each row, its strings and their styles, and lays them out as the game does', async () => {
        const data = duneCredits();
        expect(detect(data, 'CREDITS.ENG').id).toBe('dune2-credits');
        expect(detect(data, null).id).toBe('dune2-credits');
        const inspected = await inspect(data, { name: 'CREDITS.ENG', names: [] });
        expect(inspected.checks).toEqual([]);
        const r = inspected.parsed;
        expect(r.warnings).toEqual([]);
        expect(r.summary).toEqual([
            ['Roles', '1'],
            ['Names', '2'],
            ['Rows', '10'],
        ]);
        expect(r.fields.map((f) => [f.name, f.value])).toEqual([
            ['Title', 'CHIMERA'],
            ['Blank row', undefined],
            ['Role', 'Samples By: · Chimera'],
            ['Name', 'Its Tests'],
            ['Blank rows', '2'],
            ['Centered line', 'And you'],
            ['Blank row', undefined],
            ['Small print', "(c) 2026 Chimera sample, not the game's."],
            ['Blank row', undefined],
            ['End', 'NUL'],
        ]);
        // The role and its first name share a row: the role, 0x05, then the name with its own style byte.
        expect(r.fields[2].children?.map((f) => [f.name, f.offset, f.length, f.value])).toEqual([
            ['Style', 10, 1, 'Role'],
            ['Text', 11, 11, '"Samples By:"'],
            ['Same row', 22, 1, '0x05'],
            ['Style', 23, 1, 'Name'],
            ['Text', 24, 7, '"Chimera"'],
            ['End of row', 31, 1, 'CR'],
        ]);
        expect(r.fields.reduce((n, f) => n + f.length, 0)).toBe(data.length);
        // Roles end at the middle and names start there; the rest is centered on it.
        expect(r.preview?.kind === 'text' && r.preview.text).toBe(
            ['                 CHIMERA', '', '        Samples By:  Chimera', '                     Its Tests', '', '', '                 And you', '', "(c) 2026 Chimera sample, not the game's."].join(
                '\n'
            )
        );
    });

    it('says what the game would get wrong', () => {
        expect(parse(duneCredits('\x04Odd\x03 one\r')).warnings).toEqual([
            'Row 11 has a 0x03 inside "Odd\\u0003 one": the game reads a style byte only at a string’s start, and draws it as a character.',
        ]);
        const open = duneCredits().subarray(0, duneCredits().length - 1);
        expect(parse(open).warnings).toEqual(['There’s no NUL to end the credits: the game would scroll on through whatever is in memory after them.']);
    });

    it('refuses what isn’t credits', () => {
        expect(() => parse(latin1('Plain text, ended by a NUL.\r\0'))).toThrow(/no line starts with a style byte/);
        expect(() => parse(new Uint8Array(64001))).toThrow(/64,000-byte buffer/);
        // What the sniffer leaves to other formats: an LF, a control byte, bytes after the NUL, no NUL.
        expect(sniffDuneCredits(latin1('\x02Title\r\n\0'))).toBe(false);
        expect(sniffDuneCredits(latin1('\x02Title\x07\r\0'))).toBe(false);
        expect(sniffDuneCredits(latin1('\x02Title\r\0x'))).toBe(false);
        expect(sniffDuneCredits(latin1('\x02Title\r'))).toBe(false);
        expect(sniffDuneCredits(latin1('\x02Title\r\0\0'))).toBe(true);
    });

    // 1.07's, loose and in ENGLISH.PAK, when a copy sits beside the installed game; 1.00's ENGLISH.PAK has a C header by the name.
    const game = gameDir('dune2');
    const v107 = game && existsSync(join(game, '..', 'dune II 1.07', 'CREDITS.ENG')) ? join(game, '..', 'dune II 1.07') : '';
    const fromPak = (path: string) => pak.parse(new Uint8Array(readFileSync(path)), { name: 'ENGLISH.PAK', names: [] }).entries!.find((e) => e.label === 'CREDITS.ENG')!.data;
    it.skipIf(!v107)('reads 1.07’s', async () => {
        const loose = new Uint8Array(readFileSync(join(v107, 'CREDITS.ENG')));
        expect([...fromPak(join(v107, 'ENGLISH.PAK'))]).toEqual([...loose]);
        const r = await inspect(loose, { name: 'CREDITS.ENG', names: [] });
        expect(r.format.id).toBe('dune2-credits');
        expect(r.parsed.warnings).toEqual([]);
        expect(r.checks).toEqual([]);
        expect(r.parsed.summary).toEqual([
            ['Roles', '14'],
            ['Names', '41, of 34 people'],
            ['Rows', '119'],
        ]);
    });
    const PAK = gameFile('dune2', 'ENGLISH.PAK') ?? '';
    it.skipIf(!PAK)('leaves 1.00’s C header to the text reader', () => {
        expect(detect(fromPak(PAK), 'CREDITS.ENG').id).toBe('text');
    });
});
