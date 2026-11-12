import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Field, Parsed } from '../core/types';
import { gameFile, gameFiles } from '../testing/game-data';
import { dosProgram } from '../testing/samples';
import { detect } from './index';
import { inspect } from './inspect';
import parser from './mz';

const parse = (data: Uint8Array, name = 'PROGRAM.EXE') => parser.parse(data, { name, names: [] }) as Parsed;
const find = (fields: Field[], name: string): Field | undefined => fields.find((f) => f.name === name);
const summary = (r: Parsed, key: string) => r.summary.find(([k]) => k === key)?.[1];
/** The sample with some of its words (or, given as [value, 4], double words) changed. */
const changed = (at: Record<number, number | [number, 4]>, data = dosProgram()) => {
    const v = new DataView(data.buffer);
    for (const [i, value] of Object.entries(at)) {
        if (Array.isArray(value)) v.setUint32(Number(i), value[0], true);
        else v.setUint16(Number(i), value, true);
    }
    return data;
};
/** Where the sample's parts are: the image after an 80-byte header, the stub at segment 4, the overlays after the image. */
const STUB = 80 + 4 * 16;
const FBOV = 240;

describe('DOS programs (MZ)', () => {
    it('reads the header, the relocations, TLINK’s segments and the overlay', async () => {
        const data = dosProgram();
        expect(detect(data, 'PROGRAM.EXE').id).toBe('mz');
        expect(detect(data, null).id).toBe('mz');
        const inspected = await inspect(data, { name: 'PROGRAM.EXE', names: [] });
        expect(inspected.format.id).toBe('mz');
        expect(inspected.checks).toEqual([]);
        const r = inspected.parsed;
        expect(r.warnings).toEqual([]);
        expect(r.title).toBe('DOS program (MZ), with Borland overlays');
        expect(r.summary).toEqual([
            ['Linked with', 'Borland TLINK 5.0'],
            ['Program', '160 bytes'],
            ['Extra memory', '256 bytes at least, as much as DOS has at most'],
            ['Starts at', '0000:0000, at 80 in the file'],
            ['Stack', '000A:0100'],
            ['Relocations', '2'],
            ['Overlays', '1 piece of code, 22 bytes, loaded from PROGRAM.EXE when they’re called'],
            ['Segments', '5 in TLINK’s table: 1 code, 1 overlaid, 3 data'],
        ]);
        const header = find(r.fields, 'Header')!.children!;
        expect(find(header, 'Checksum')?.note).toBe('Matches: the file’s words add up to 0xFFFF.');
        expect(find(header, 'Stack pointer (SP)')?.note).toBe('The stack’s top is 256 bytes past the image, in the memory DOS adds.');
        expect(find(r.fields, 'Relocations')?.children?.map((f) => [f.name, f.value])).toEqual([['In segment 0x0000', '2 places']]);
        expect(find(r.fields, 'Program image')?.children?.map((f) => [f.name, f.offset, f.length, f.value])).toEqual([
            ['Segment 0x0000', 80, 32, 'Code'],
            ['Segment 0x0002', 112, 32, 'Data'],
            ['Segment 0x0004', 144, 48, "Overlay 1's stub"],
            ['Segment 0x0007', 192, 48, 'Data'],
        ]);
        const overlays = find(r.fields, 'Overlays')!;
        expect(overlays.children?.map((f) => [f.name, f.offset, f.length])).toEqual([
            ['Overlay header', 240, 16],
            ['Overlay 1', 256, 6],
        ]);
        // Every byte is marked, once.
        let covered = 0;
        for (const f of r.fields) {
            expect(f.offset, f.name).toBe(covered);
            covered = f.offset + f.length;
        }
        expect(covered).toBe(data.length);
        // The overlay's code, to save; the segments, to look through.
        expect([...r.entries![0].data]).toEqual([0xb8, 0x08, 0x00, 0xcb]);
        expect(r.preview?.kind === 'table' && r.preview.rows.map((row) => [row.group, row.cells.segment, row.cells.kind])).toEqual([
            ['Code', '0x0000', 'Code'],
            ['Data', '0x0002', 'Data'],
            ['Overlaid code', '0x0004', 'Overlay 1'],
            ['Data', '0x0007', 'Data'],
            ['Not in the file', '0x000A', 'Data'],
        ]);
    });

    it('knows packers’ marks', () => {
        const lz = dosProgram();
        lz.set(new TextEncoder().encode('LZ91'), 0x1c);
        expect(summary(parse(lz), 'Packed with')).toBe('LZEXE 0.91');
        expect(find(parse(lz).fields, 'Program image')?.note).toMatch(/^Packed: it unpacks itself/);
    });

    it('says what doesn’t fit', () => {
        expect(parse(changed({ 2: 600 })).warnings).toContain("The last page is said to hold 600 bytes, more than a page's 512.");
        expect(parse(dosProgram().subarray(0, 200)).warnings).toEqual(['The header says the program runs to 240, but the file ends at 200: the last 40 bytes would be whatever was in memory.']);
        expect(parse(changed({ 0x0c: 8 })).warnings).toEqual(['It asks for at least 256 bytes more memory, but at most 128 bytes.']);
        expect(parse(changed({ 0x16: 0x20 })).warnings).toEqual(['It starts running at 0020:0000, 512 bytes in, past the end of its image (160 bytes): it would run whatever is in memory there.']);
        // Segments wrap at 1 MB: FFF0:0100, where packers start, is the image's first byte; FFF0:0000 is in the PSP before it.
        expect(parse(changed({ 0x16: 0xfff0, 0x14: 0x100 })).warnings).toEqual([]);
        expect(summary(parse(changed({ 0x16: 0xfff0, 0x14: 0x100 })), 'Starts at')).toBe('FFF0:0100, at 80 in the file');
        expect(parse(changed({ 0x16: 0xfff0 })).warnings).toEqual([
            'It starts running at FFF0:0000, 256 bytes before its image, in the PSP, the 256 bytes DOS puts there: it would run whatever is in memory there.',
        ]);
        expect(parse(changed({ 0x44: 0x40 })).warnings).toEqual(["Relocation 2 points past the end of the program's image: DOS would change memory beyond it."]);
        expect(parse(changed({ 0x18: 0x4c })).warnings).toContain("The relocations run past the header, into the program's image: DOS would load them as part of the program.");
        // The overlays.
        expect(parse(changed({ [FBOV + 4]: [0x1000, 4] })).warnings).toEqual(['The overlays are said to be 4,096 bytes, more than the 6 bytes left in the file.']);
        expect(parse(changed({ [FBOV + 8]: [1000, 4] })).warnings).toEqual(['The table of segments is said to be 5 entries at 1,000, past the end of the file.']);
        expect(parse(changed({ [FBOV + 8]: [4, 4] })).warnings).toContain('The table of segments is outside the program’s image, where the overlay manager can’t find it.');
        expect(parse(changed({ [STUB]: 0x9090 })).warnings).toEqual(["Overlay 1's stub (segment 0x0004) isn't one: it doesn't start with INT 3Fh, which loads the overlay."]);
        expect(parse(changed({ [STUB + 4]: [100, 4] })).warnings).toEqual(["Overlay 1's code is said to be 6 bytes at 356, past the end of the overlays."]);
        expect(parse(changed({ [STUB + 12]: 100 })).warnings).toEqual(["Overlay 1's stub lists 100 entry points, running past the program's image."]);
        expect(parse(changed({ [STUB + 8]: 3, [STUB + 10]: 3 })).warnings).toContain("Overlay 1's fixups are said to be 3 bytes, which isn't a whole number of 2-byte fixups.");
        expect(parse(dosProgram({ fixup: 3 })).warnings).toEqual(['Overlay 1 has 1 fixup pointing past its code: loading it would change memory beyond it.']);
    });

    it('leaves what’s after the image to the usual checks', async () => {
        const plain = new Uint8Array(FBOV + 32);
        plain.set(dosProgram().subarray(0, FBOV));
        plain.set(new TextEncoder().encode('Hidden after the program, which DOS never loads.'.slice(0, 32)), FBOV);
        const r = await inspect(plain, { name: 'PROGRAM.EXE', names: [] });
        expect(r.format.id).toBe('mz');
        expect(r.parsed.title).toBe('DOS program (MZ)');
        expect(r.checks.map((c) => c.text).join()).toMatch(/There are 32 bytes after the end of the dos program/);
    });

    /** The sample's program (without its overlays) and a one-file ZIP after it, its offsets counting from the file or the ZIP. */
    const selfExtracting = (relative: boolean, cut = 0) => {
        const name = new TextEncoder().encode('README.TXT');
        const body = new TextEncoder().encode('Unpacked by the program.');
        const zipAt = FBOV;
        const local = [...[0x50, 0x4b, 3, 4], ...new Array(14).fill(0), ...le32(body.length), ...le32(body.length), ...le16(name.length), 0, 0, ...name, ...body];
        const base = relative ? zipAt : 0;
        const central = [...[0x50, 0x4b, 1, 2], ...new Array(16).fill(0), ...le32(body.length), ...le32(body.length), ...le16(name.length), ...new Array(12).fill(0), ...le32(zipAt - base), ...name];
        const directory = zipAt + local.length - base;
        const end = [...[0x50, 0x4b, 5, 6], 0, 0, 0, 0, 1, 0, 1, 0, ...le32(central.length + cut), ...le32(directory), 0, 0];
        return Uint8Array.from([...dosProgram().subarray(0, FBOV), ...local, ...central, ...end]);
    };
    const le16 = (v: number) => [v & 0xff, v >> 8];
    const le32 = (v: number) => [...le16(v & 0xffff), ...le16(v >>> 16)];

    it('knows a self-extracting archive: a whole ZIP after the program', async () => {
        for (const relative of [false, true]) {
            const r = await inspect(selfExtracting(relative), { name: 'UNPACK.EXE', names: [] });
            expect(r.format.id).toBe('mz');
            expect(r.checks).toEqual([]);
            expect(r.parsed.warnings).toEqual([]);
            expect(r.parsed.title).toBe('DOS program (MZ), a self-extracting ZIP');
            expect(summary(r.parsed, 'Unpacks')).toBe('README.TXT, from the ZIP after it');
            const zip = find(r.parsed.fields, 'ZIP archive')!;
            expect(zip.children?.map((f) => f.name)).toEqual(['Files', 'Central directory', 'End record']);
            expect(zip.offset + zip.length).toBe(selfExtracting(relative).length);
            expect(r.parsed.entries?.map((e) => e.label)).toEqual(['UNPACK.zip']);
        }
        // A ZIP whose directory doesn't end where its end record starts isn't whole: the usual checks call it out.
        const broken = await inspect(selfExtracting(false, 1), { name: 'UNPACK.EXE', names: [] });
        expect(broken.parsed.title).toBe('DOS program (MZ)');
        expect(broken.checks.map((c) => c.level)).toContain('danger');
    });

    it('refuses what isn’t one', () => {
        expect(() => parse(new Uint8Array(10))).toThrow(/shorter than the 28 bytes/);
        expect(() => parse(changed({ 0: 0x5858 }))).toThrow(/doesn’t start with "MZ"/);
        const pe = changed({ 0x3c: [100, 4] });
        pe.set(new TextEncoder().encode('PE\0\0'), 100);
        expect(() => parse(pe)).toThrow(/a program for Windows or OS\/2: the word at 0x3C points to its "PE" header/);
        expect(detect(pe, 'PROGRAM.EXE').id).not.toBe('mz');
        expect(() => parse(changed({ 4: 0 }))).toThrow(/0 pages long/);
        expect(() => parse(changed({ 8: 1 }))).toThrow(/said to be 16 bytes, too short to hold itself/);
        expect(() => parse(changed({ 8: 100 }))).toThrow(/1,600 bytes, more than the file/);
        expect(() => parse(changed({ 2: 40 }))).toThrow(/said to end at 40, before its header does/);
        expect(() => parse(changed({ 6: 1000 }))).toThrow(/1,000 relocations are said to be at 62, running past the end of the file/);
        // Early DOS took "ZM" too.
        expect(parse(changed({ 0: 0x4d5a })).fields[0].children?.[0].note).toBe('Reversed: early DOS took either.');
    });

    // Dune II's 1.07 patch, if it's beside the game: PKZIP's self-extractor, packed with PKLITE.
    const PATCH = gameFiles('dune2', /^DUNE2_107.*\.EXE$/i)[0] ?? '';
    it.skipIf(!PATCH)('reads Dune II’s 1.07 patch, a self-extracting ZIP', async () => {
        const r = await inspect(new Uint8Array(readFileSync(PATCH)), { name: 'DUNE2_107.EXE', names: [] });
        expect(r.format.id).toBe('mz');
        expect(r.parsed.warnings).toEqual([]);
        expect(r.checks).toEqual([]);
        expect(summary(r.parsed, 'Packed with')).toBe('PKLITE 1.20');
        // It starts at FFF0:0100: the image's first byte, as packers do.
        expect(summary(r.parsed, 'Starts at')).toBe('FFF0:0100, at 96 in the file');
        expect(summary(r.parsed, 'Unpacks')).toBe('PATCH.EXE, PATCH.RTP, from the ZIP after it');
    });

    // Dune II's, from wherever it's installed (npm run test:setup).
    const GAME = gameFile('dune2', 'DUNE2.EXE') ?? '';
    const SETUP = gameFile('dune2', 'SETUP.EXE') ?? '';
    it.skipIf(!GAME || !SETUP)('reads Dune II’s, and its overlays', async () => {
        const game = await inspect(new Uint8Array(readFileSync(GAME)), { name: 'DUNE2.EXE', names: [] });
        expect(game.format.id).toBe('mz');
        expect(game.parsed.warnings).toEqual([]);
        expect(game.checks).toEqual([]);
        expect(summary(game.parsed, 'Linked with')).toBe('Borland TLINK 5.0');
        expect(summary(game.parsed, 'Relocations')).toBe('4,388');
        expect(summary(game.parsed, 'Overlays')).toBe('36 pieces of code, 98,848 bytes, loaded from DUNE2.EXE when they’re called');
        expect(game.parsed.entries).toHaveLength(36);
        // The data segment 0x332F, where the DUNE.CFG reader found the game's tables of sound drivers by hand, is TLINK's too.
        const rows = game.parsed.preview?.kind === 'table' ? game.parsed.preview.rows : [];
        expect(rows.find((r) => r.cells.segment === '0x332F')?.cells.size).toBe(String(0x9230));

        const setup = await inspect(new Uint8Array(readFileSync(SETUP)), { name: 'SETUP.EXE', names: [] });
        expect(setup.format.id).toBe('mz');
        expect(setup.parsed.warnings).toEqual([]);
        expect(setup.parsed.title).toBe('DOS program (MZ)');
        expect(summary(setup.parsed, 'Relocations')).toBe('1,194');
    });
});
