import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Field, Parsed } from '../core/types';
import { gameFile } from '../testing/game-data';
import { ailDriver } from '../testing/samples';
import parser from './ail';
import { detect } from './index';
import { inspect } from './inspect';
import pak from './westwood/pak';

const parse = (data: Uint8Array) => parser.parse(data, { name: 'DRIVER.ADV', names: [] }) as Parsed;
const find = (fields: Field[], name: string): Field | undefined => fields.find((f) => f.name === name);
const summary = (r: Parsed, key: string) => r.summary.find(([k]) => k === key)?.[1];
/** The sample with some of its bytes changed. */
const changed = (at: Record<number, number>) => {
    const d = ailDriver();
    for (const [i, v] of Object.entries(at)) d[Number(i)] = v;
    return d;
};
/** Where the sample's function table, and its first entry, are. */
const TABLE = ailDriver()[0];
const DESCRIPTION = TABLE + 8 * 4 + 2;

describe('Miles sound drivers (AIL 2)', () => {
    it('reads the copyright, each function and the description', () => {
        const data = ailDriver();
        expect(detect(data, 'DRIVER.ADV').id).toBe('ail');
        expect(detect(data, null).id).toBe('ail');
        const r = parse(data);
        expect(r.warnings).toEqual([]);
        expect(r.summary).toEqual([
            ['For', 'Sample Sound Card; Its Twin'],
            ['Plays', 'Digital sound (in the Sound Blaster’s way)'],
            ['Functions', '8 (8 that AIL 2 calls)'],
            ['Needs', 'AIL 2.00 or later'],
            ['Copyright', 'Copyright (C) 2026 Chimera sample, not a real driver.'],
        ]);
        const table = find(r.fields, 'Function table')!;
        expect(table.children?.map((f) => f.name).slice(0, 3)).toEqual(['100: Describe the driver', '101: Detect the device', '102: Start the driver']);
        const description = find(r.fields, 'Description')!;
        expect(find(description.children!, 'I/O port')?.value).toBe('0x0220');
        expect(find(description.children!, 'Calls a second')?.value).toBe('None: it needn’t be called on a timer');
        expect(find(r.fields, 'Code and data')?.length).toBe(8);
        expect(r.fields.reduce((n, f) => n + f.length, 0)).toBe(data.length);
    });

    it('says what doesn’t fit', () => {
        const entry = (i: number) => TABLE + i * 4;
        expect(parse(changed({ [entry(7)]: 99 })).warnings).toEqual(["Function 99 isn't one AIL 2 calls, so it's never used."]);
        expect(parse(changed({ [entry(7)]: 100 })).warnings).toEqual(['Function 100 is listed twice; AIL uses the first.']);
        expect(parse(changed({ [entry(0)]: 105 })).warnings).toEqual([
            "Function 105 isn't one AIL 2 calls, so it's never used.",
            "There's no function 100 (Describe the driver), which AIL calls first: it would refuse to load the driver.",
        ]);
        // Code said to be past the end, and in the tables.
        expect(parse(changed({ [entry(1) + 3]: 0x10 })).warnings.join()).toMatch(/^Function 101 \(Detect the device\) is at 0x10[0-9A-F]{2}, past the end of the file/);
        expect(parse(changed({ [entry(1) + 2]: 4, [entry(1) + 3]: 0 })).warnings).toEqual([
            "Function 101 (Detect the device) is at 0x0004, inside the driver's tables: calling it would run them as code.",
        ]);
        expect(parse(changed({ [DESCRIPTION + 2]: 7 })).warnings).toEqual(["The driver says it's of type 7; AIL 2 knows only 2 (digital sound) and 3 (music)."]);
        // The names' list without its empty name: the file cut off after the first name.
        const open = ailDriver().subarray(0, DESCRIPTION + 24 + 'Sample Sound Card'.length + 1);
        expect(parse(open).warnings).toContain('The list of device names runs to the end of the file without the empty name that ends it.');
    });

    it('refuses what isn’t one', () => {
        expect(() => parse(new Uint8Array(4))).toThrow(/too short for a driver/);
        expect(() => parse(Uint8Array.from([0x40, 0, 0x41, 0x1a, 0, 0, 0, 0]))).toThrow(/where the function table is, is 64/);
        expect(() => parse(changed({ [TABLE - 1]: 0x41 }))).toThrow(/doesn’t end in 0x1A/);
        expect(() => parse(changed({ 5: 1 }))).toThrow(/a byte at 5 in its text that isn't text \(0x1\)/);
        expect(() => parse(ailDriver().subarray(0, TABLE + 10))).toThrow(/without its 0xFFFF/);
        expect(() => parse(changed({ [TABLE]: 0xff, [TABLE + 1]: 0xff }))).toThrow(/The function table is empty/);
    });

    // Dune II's, in SOUND.PAK, from wherever it's installed (npm run test:setup). Miles built them; his source says what they should hold.
    const PAK = gameFile('dune2', 'SOUND.PAK') ?? '';
    it.skipIf(!PAK)('reads Dune II’s seven, as the AIL 2 source builds them', async () => {
        const drivers = pak.parse(new Uint8Array(readFileSync(PAK)), { name: 'SOUND.PAK', names: [] }).entries!.filter((e) => e.label.endsWith('.ADV'));
        expect(drivers.map((e) => e.label).sort()).toEqual(['ALGDIG.ADV', 'MT32MPU.ADV', 'PASDIG.ADV', 'PCSPKR.ADV', 'SBDIG.ADV', 'SBPDIG.ADV', 'TANDY.ADV']);
        const read: Record<string, Parsed> = {};
        for (const e of drivers) {
            expect(detect(e.data, null).id, e.label).toBe('ail');
            const r = await inspect(e.data, { name: e.label, names: [] });
            expect(r.format.id, e.label).toBe('ail');
            expect(r.parsed.warnings, e.label).toEqual([]);
            expect(
                r.checks.filter((c) => c.level !== 'info'),
                e.label
            ).toEqual([]);
            read[e.label] = r.parsed;
        }
        // SBDIG: DMASOUND.ASM's driver_index, in its order (without the Ad Lib Gold's two format calls), and its Sound Blaster settings.
        expect(
            find(read['SBDIG.ADV'].fields, 'Function table')!
                .children!.map((f) => f.name.split(':')[0])
                .slice(0, -1)
        ).toEqual(['100', '101', '102', '104', '123', '125', '126', '127', '128', '124', '129', '130', '131', '132', '120', '121', '122']);
        expect(summary(read['SBDIG.ADV'], 'For')).toBe('Creative Labs Sound Blaster(TM) Digital Sound; Media Vision Thunderboard(TM) Digital Sound');
        const sb = find(read['SBDIG.ADV'].fields, 'Description')!.children!;
        expect([find(sb, 'I/O port')?.value, find(sb, 'IRQ')?.value, find(sb, 'DMA channel')?.value]).toEqual(['0x0220', '7', '1']);
        // MT32MPU: MT32.INC's description, a music driver with the MT-32's 20-character display, called 120 times a second.
        expect(summary(read['MT32MPU.ADV'], 'For')).toBe('Roland MT-32 or compatible with Roland MPU MIDI Interface; Roland LAPC-1');
        expect(summary(read['MT32MPU.ADV'], 'Plays')).toBe('Music (XMIDI)');
        const mt = find(read['MT32MPU.ADV'].fields, 'Description')!.children!;
        expect([find(mt, 'File suffix')?.value, find(mt, 'I/O port')?.value, find(mt, 'Calls a second')?.value, find(mt, 'Display')?.value]).toEqual(['"MT"', '0x0330', '120', '20 characters']);
    });
});
