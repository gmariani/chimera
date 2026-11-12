import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Field, Parsed } from '../../core/types';
import { gameFile } from '../../testing/game-data';
import { westwoodDriver } from '../../testing/samples';
import { detect } from '../index';
import { inspect } from '../inspect';
import parser from './drv';
import pak from './pak';

const parse = (data: Uint8Array, name = 'ALFX.DRV') => parser.parse(data, { name, names: [] }) as Parsed;
const find = (fields: Field[], name: string): Field | undefined => fields.find((f) => f.name === name);
const summary = (r: Parsed, key: string) => r.summary.find(([k]) => k === key)?.[1];
/** The sample with some of its words changed. */
const changed = (at: Record<number, number>, data = westwoodDriver()) => {
    for (const [i, v] of Object.entries(at)) data.set([v & 0xff, v >> 8], Number(i));
    return data;
};
/** Where the sample's tables are: the functions', the dispatcher, the music commands'. */
const FUNCTIONS = 63;
const DISPATCHER = 99;
const COMMANDS = 111;

describe('Westwood sound drivers (DRV)', () => {
    it('reads the entry points, the functions, the dispatcher and the music commands', async () => {
        const data = westwoodDriver();
        expect(detect(data, 'ALFX.DRV').id).toBe('westwood-drv');
        expect(detect(data, null).id).toBe('westwood-drv');
        const inspected = await inspect(data, { name: 'ALFX.DRV', names: [] });
        expect(inspected.checks).toEqual([]);
        const r = inspected.parsed;
        expect(r.warnings).toEqual([]);
        expect(r.summary).toEqual([
            ['Plays', 'AdLib music and sound effects (.ADL files)'],
            ['Version', '1.00'],
            ['Functions', '18 (4 it does something for)'],
            ['Size', '117 bytes, as it says'],
            ['Timer', 'Called 72 times a second by Dune II'],
        ]);
        const functions = find(r.fields, 'Function table')!.children!;
        expect(functions.slice(0, 3).map((f) => [f.name, f.value, f.note])).toEqual([
            ['0: The driver’s version', '1.00', undefined],
            ['1: The driver’s size', '117 bytes', undefined],
            ['2: Start the driver', 'code at 0x0017', 'Takes 2 values.'],
        ]);
        expect(functions[13].note).toBe('Takes 3 values, and does nothing with them.');
        expect(functions[5].note).toBe('Not supported here: it returns at once.');
        expect(find(r.fields, 'Dispatcher')?.note).toBe('Takes the function’s number in BX: past 17, it goes to 0x0028, which returns at once.');
        expect(find(r.fields, 'Music commands')?.children?.map((f) => f.name)).toEqual(['0x80: Set the repeat count', '0x81: Repeat: jump back while the count lasts', '0x82: Start a program']);
        expect(r.fields.reduce((n, f) => n + f.length, 0)).toBe(data.length);
        // Under another name, the timer's rate isn't Dune II's to say.
        expect(summary(parse(data, 'MUSIC.DRV'), 'Timer')).toBeUndefined();
    });

    it('says what doesn’t fit', () => {
        const longer = Uint8Array.from([...westwoodDriver(), 0x90]);
        expect(parse(longer).warnings).toEqual(["The driver says it's 117 bytes, but the file is 118 bytes."]);
        expect(parse(changed({ [FUNCTIONS + 5 * 2]: 0xfff0 })).warnings).toEqual([
            'Function 5 (Unknown) is at 0xFFF0, past the end of the file: calling it would run whatever is in memory after the driver.',
        ]);
        expect(parse(changed({ [FUNCTIONS + 6 * 2]: DISPATCHER + 2 })).warnings).toEqual([
            "Function 6 (Start a program (a song or a sound)) is at 0x0065, inside the driver's tables: calling it would run them as code.",
        ]);
        expect(parse(changed({ [COMMANDS + 2]: 0xfff0 })).warnings).toEqual(["Music command 0x81's code is at 0xFFF0, past the end of the file."]);
    });

    it('refuses what isn’t one', () => {
        expect(() => parse(new Uint8Array(10))).toThrow(/too short for a driver/);
        expect(() => parse(changed({ 3: 0x9090 }))).toThrow(/doesn’t start with two jumps/);
        expect(() => parse(changed({ 1: 0x7ff0 }))).toThrow(/jumps land outside the file/);
        expect(() => parse(changed({ [DISPATCHER]: 0x9090 }))).toThrow(/isn’t a dispatcher/);
        expect(() => parse(changed({ [DISPATCHER + 10]: 0x1000 }))).toThrow(/table of functions runs past the end/);
        expect(() => parse(changed({ [DISPATCHER + 2]: 0x7740 }))).toThrow(/takes 65 functions/);
    });

    // Dune II's, in SOUND.PAK (the same bytes in 1.00 and 1.07); how often its timer calls each is in DUNE2.EXE's list.
    const PAK = gameFile('dune2', 'SOUND.PAK') ?? '';
    const EXE = gameFile('dune2', 'DUNE2.EXE') ?? '';
    it.skipIf(!PAK || !EXE)('reads Dune II’s two, as the game lists them', async () => {
        const drivers = pak.parse(new Uint8Array(readFileSync(PAK)), { name: 'SOUND.PAK', names: [] }).entries!.filter((e) => e.label.endsWith('.DRV'));
        const read: Record<string, Parsed> = {};
        for (const e of drivers) {
            const r = await inspect(e.data, { name: e.label, names: [] });
            expect(r.format.id, e.label).toBe('westwood-drv');
            expect(r.parsed.warnings, e.label).toEqual([]);
            expect(r.checks, e.label).toEqual([]);
            read[e.label] = r.parsed;
        }
        expect(Object.keys(read).sort()).toEqual(['ALFX.DRV', 'PCSOUND.DRV']);
        expect(read['ALFX.DRV'].summary).toEqual([
            ['Plays', 'AdLib music and sound effects (.ADL files)'],
            ['Version', '1.00'],
            ['Functions', '18 (18 it does something for)'],
            ['Size', '6,517 bytes, as it says'],
            ['Timer', 'Called 72 times a second by Dune II'],
        ]);
        expect(find(read['ALFX.DRV'].fields, 'Music commands')?.value).toBe('75 commands');
        expect(read['PCSOUND.DRV'].summary).toEqual([
            ['Plays', 'Music and sound on the PC speaker'],
            ['Version', '1.01'],
            ['Functions', '18 (11 it does something for)'],
            ['Size', '1,655 bytes, as it says'],
            ['Timer', 'Called 292 times a second by Dune II'],
        ]);
        expect(find(read['PCSOUND.DRV'].fields, 'Note pitches')?.value).toBe('95 notes, 18.35 Hz (D0) to 4,186.6 Hz (C8)');

        // DUNE2.EXE 1.00's list of music drivers (12 bytes each at 0x3D9A0: the name, the music's extension, the timer's rate).
        const exe = new Uint8Array(readFileSync(EXE));
        const word = (at: number) => exe[at] | (exe[at + 1] << 8);
        const text = (seg: number, off: number) => {
            const at = 19456 + seg * 16 + off;
            return String.fromCharCode(...exe.subarray(at, exe.indexOf(0, at)));
        };
        const listed = [1, 2].map((i) => 0x3d9a0 + i * 12).map((e) => [text(word(e + 2), word(e)), word(e + 8)]);
        expect(listed).toEqual([
            ['ALFX.DRV', 72],
            ['PCSOUND.DRV', 292],
        ]);
    });
});
