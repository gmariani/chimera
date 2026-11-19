import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Parsed } from '../core/types';
import { gameDir } from '../testing/game-data';
import { dos4gwProgram } from '../testing/samples';
import module from './dos16m-module';
import { detect } from './index';
import { inspect } from './inspect';
import mz from './mz';

const parse = (data: Uint8Array, name = 'program.exe') => mz.parse(data, { name, names: [] }) as Parsed;
/** Where the sample's parts are: the loader is 33 bytes, the module's header 176 and its code 16. */
const MODULE = 33;
const PROGRAM = MODULE + 0xb0 + 16;

describe('DOS/16M and DOS/4GW', () => {
    it('reads the modules bound after the loader, and the program they run, marking every byte', async () => {
        const data = dos4gwProgram();
        const inspected = await inspect(data, { name: 'program.exe', names: [] });
        expect(inspected.checks).toEqual([]);
        const r = inspected.parsed;
        expect(r.warnings).toEqual([]);
        expect(r.title).toBe('32-bit DOS program, with DOS/16M');
        expect(r.summary).toContainEqual(['Extender', 'VMM.EXP (virtual memory)']);
        expect(r.summary).toContainEqual(['Runs', `PROGRAM, a 32-bit program (LE), bound after them at ${PROGRAM}`]);
        // And what that program is, as the LE reader has it.
        expect(r.summary).toContainEqual(['Fixups', '2: 1 inside the program, 1 imported by number']);
        expect(r.fields.slice(-2).map((f) => [f.name, f.offset, f.length])).toEqual([
            ['DOS/16M module VMM.EXP', MODULE, PROGRAM - MODULE],
            ['Bound program', PROGRAM, data.length - PROGRAM],
        ]);
        expect(
            r.fields
                .at(-1)!
                .children!.slice(0, 2)
                .map((f) => [f.name, f.offset])
        ).toEqual([
            ['DOS header and stub', PROGRAM],
            ['LE header', PROGRAM + 0x40],
        ]);
        expect(r.fields.reduce((n, f) => n + f.length, 0)).toBe(data.length);
        expect(r.entries!.map((e) => [e.label, e.offset, e.size])).toEqual([
            ['VMM.EXP', MODULE, PROGRAM - MODULE],
            ['program-program.exe', PROGRAM, data.length - PROGRAM],
            ['program-program-object-1-code.bin', data.length - 4096 - 16, 4096],
            ['program-program-object-2-data.bin', data.length - 16, 16],
        ]);
    });

    it('opens a module saved on its own', async () => {
        const saved = dos4gwProgram().subarray(MODULE, PROGRAM);
        expect(detect(saved, 'VMM.EXP').id).toBe('dos16m');
        const opened = await inspect(saved, { name: 'VMM.EXP', names: [] });
        expect(opened.checks).toEqual([]);
        expect(opened.parsed.warnings).toEqual([]);
        expect(opened.parsed.summary).toEqual([
            ['Name', 'VMM.EXP'],
            ['What', 'virtual memory manager'],
        ]);
        // "BW" alone isn't enough: the header has to name an .EXP.
        const other = saved.slice();
        other.set([0x41, 0x42, 0], 0x70);
        expect(detect(other, null).id).not.toBe('dos16m');
        expect(() => module.parse(other, { name: null, names: [] })).toThrow('This isn’t a DOS/16M module');
    });

    it('says when a module points somewhere it can’t be', () => {
        const back = dos4gwProgram();
        new DataView(back.buffer).setUint32(MODULE + 0x1c, 10, true);
        expect(parse(back).warnings).toEqual(['VMM.EXP says the next one is at 10, not after it: it’s taken to run to the end.']);
        const past = dos4gwProgram();
        new DataView(past.buffer).setUint32(MODULE + 0x1c, 99999, true);
        expect(parse(past).warnings).toEqual(['VMM.EXP says the next one is at 99,999, past the end of the file: it’s taken to run to the end.']);
        expect(parse(past).fields.at(-1)).toMatchObject({ name: 'DOS/16M module VMM.EXP', length: past.length - MODULE });
    });
});

const CNC = gameDir('cncRemastered');
describe.skipIf(!CNC)('the readme viewer and installers Westwood bound to DOS/4GW', () => {
    it('reads their extender and the program it runs, with nothing to warn about', async () => {
        for (const [path, modules, at, code] of [
            ['RED_ALERT/COUNTERSTRIKE/README.EXE', ['VMM.EXP', '4GWPRO.EXP'], 217764, 229556],
            ['TIBERIAN_DAWN/CD1/README.EXE', ['VMM.EXP', '4GWPRO.EXP'], 217764, 229556],
            ['TIBERIAN_DAWN/CD1/_SETUP.EXE', ['VMM.EXP', '4GWPRO.EXP'], 217764, 228596],
            ['RED_ALERT/COUNTERSTRIKE/SETUP/LICENSE.EXE', ['CFG4GPRO.EXP', 'VMM.EXP', '4GWPRO.EXP'], 232804, 245468],
        ] as const) {
            const data = new Uint8Array(readFileSync(join(CNC!, path)));
            const r = await inspect(data, { name: path, names: [] });
            expect(r.checks, path).toEqual([]);
            expect(r.parsed.warnings, path).toEqual([]);
            expect(r.parsed.title, path).toBe('32-bit DOS program, with DOS/4GW');
            expect(
                r.parsed.entries!.slice(0, modules.length).map((e) => e.label),
                path
            ).toEqual(modules);
            const bound = r.parsed.fields.at(-1)!;
            expect([bound.name, bound.offset, bound.children!.find((f) => f.name === 'LE header')!.offset], path).toEqual(['Bound program', at, code]);
            expect(
                r.parsed.fields.reduce((n, f) => n + f.length, 0),
                path
            ).toBe(data.length);
        }
    });
});
