import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Parsed } from '../core/types';
import { gameDir } from '../testing/game-data';
import { linearProgram } from '../testing/samples';
import { detect } from './index';
import { inspect } from './inspect';
import le from './le';

const parse = (data: Uint8Array) => le.parse(data, { name: 'program.exe', names: [] }) as Parsed;
/** Where the sample's parts are: the linear header at 0x40, its tables from 0x40 + 196, its pages at 384. */
const HEADER = 0x40;
const OBJECTS = HEADER + 196;
/** Where the pages start: LX's page table is twice as big. */
const pagesOf = (lx: boolean) => (lx ? 400 : 384);
const changed = (change: (v: DataView, d: Uint8Array) => void, data = linearProgram()) => (change(new DataView(data.buffer), data), data);

describe('Linear Executables (LE, LX)', () => {
    it('reads the header, the objects, the pages, the names, the entry points and the fixups, marking every byte', async () => {
        for (const lx of [false, true]) {
            const data = linearProgram({ lx });
            const kind = lx ? 'LX' : 'LE';
            expect(detect(data, 'program.exe').id, kind).toBe('le');
            const inspected = await inspect(data, { name: 'program.exe', names: [] });
            expect(inspected.checks, kind).toEqual([]);
            const r = inspected.parsed;
            expect(r.warnings, kind).toEqual([]);
            expect(r.title, kind).toBe(lx ? 'OS/2 program (LX)' : '32-bit DOS program, for a DOS extender (LE)');
            expect(r.summary, kind).toEqual([
                ['Module', 'PROGRAM'],
                ['For', lx ? 'OS/2, 80386 or later' : 'a DOS extender (the header says OS/2, as DOS extenders’ linkers mark them), 80386 or later'],
                ['Objects', 'code (4,096 bytes), data (16 bytes)'],
                ['Starts', 'object 1 + 0x00000000'],
                ['Entry points', '1, 1 named'],
                ['Imports from', 'DOSCALLS'],
                ['Fixups', '2: 1 inside the program, 1 imported by number'],
            ]);
            expect(
                r.fields.reduce((n, f) => n + f.length, 0),
                kind
            ).toBe(data.length);
            expect(r.end, kind).toBe(data.length);
            const PAGES = pagesOf(lx);
            expect(
                r.fields.slice(-2).map((f) => [f.name, f.offset, f.length]),
                kind
            ).toEqual([
                ['Object 1', PAGES, 4096],
                ['Object 2', PAGES + 4096, 16],
            ]);
            expect(
                r.entries!.map((e) => [e.label, e.offset, e.size]),
                kind
            ).toEqual([
                ['program-object-1-code.bin', PAGES, 4096],
                ['program-object-2-data.bin', PAGES + 4096, 16],
            ]);
            expect(r.fields.find((f) => f.name === 'Resident names')!.children!.map((f) => [f.name, f.value])).toEqual([
                ['Module name', 'PROGRAM'],
                ['START', 'entry 1'],
                ['End', '0'],
            ]);
        }
    });

    it('says what doesn’t fit', () => {
        expect(parse(changed((v) => v.setUint32(HEADER + 0x28, 512, true))).warnings).toContain('It says its pages are 512 bytes: every LE program’s are 4,096.');
        expect(parse(changed((v) => v.setUint32(HEADER + 0x44, 9999, true))).warnings).toContain('It says it has 9,999 objects, but the object table has room for 176.');
        expect(parse(changed((v) => v.setUint32(HEADER + 0x1c, 5000, true))).warnings).toEqual(['It says it starts 5,000 bytes into object 1, past its end.']);
        expect(parse(changed((v) => v.setUint32(OBJECTS + 24 + 12, 7, true))).warnings).toEqual(['Object 2 is said to be pages 7 to 7, but there are 2 pages.']);
        // The first page said to be the 9th in the file, which has 2.
        expect(parse(changed((_, d) => (d[OBJECTS + 48 + 2] = 9))).warnings).toEqual([
            'Page 1 is said to be page 9 in the file, which has 2 pages.',
            'Page 1 (object 1) is said to be 4,096 bytes at 33,152, past the end of the file.',
        ]);
        // The fixup page table saying page 1's records end one byte early: the last record can't be read whole.
        const fixupPages = HEADER + new DataView(linearProgram().buffer).getUint32(HEADER + 0x68, true);
        expect(parse(changed((v) => v.setUint32(fixupPages + 4, 15, true))).warnings).toContainEqual(
            expect.stringMatching(/^Page 1's fixup records don’t end where the fixup page table says: they can’t all be read\./)
        );
        const entry = HEADER + new DataView(linearProgram().buffer).getUint32(HEADER + 0x5c, true);
        expect(parse(changed((_, d) => (d[entry + 1] = 9))).warnings).toEqual(['The entry table has a bundle of type 9, which isn’t one: the rest of it wasn’t read.']);
        expect(() => parse(new Uint8Array(64))).toThrow('This isn’t a Linear Executable');
    });
});

const CNC = gameDir('cncRemastered');
describe.skipIf(!CNC)('the programs Westwood bound to DOS/4GW', () => {
    it('reads the readme viewer: its two objects, and its fixups, all inside it', () => {
        const r = parse(new Uint8Array(readFileSync(join(CNC!, 'RED_ALERT/COUNTERSTRIKE/README.EXE'))).subarray(217764));
        expect(r.warnings).toEqual([]);
        expect(r.summary).toEqual(
            expect.arrayContaining([
                ['Module', 'readme'],
                ['Objects', 'code (11,705 bytes), data (109,232 bytes)'],
                ['Starts', 'object 1 + 0x00000B00'],
                ['Fixups', '221, all inside the program'],
            ])
        );
    });
});
