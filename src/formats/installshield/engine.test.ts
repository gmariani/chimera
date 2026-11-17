import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Parsed } from '../../core/types';
import { gameDir } from '../../testing/game-data';
import { installShieldEngine } from '../../testing/samples';
import { detect } from '../index';
import { inspect } from '../inspect';
import engine from './engine';

const parse = (data: Uint8Array) => engine.parse(data, { name: '_INST32I.EX_', names: [] }) as Parsed;
const view = (data: Uint8Array) => new DataView(data.buffer, data.byteOffset, data.byteLength);

const program = new TextEncoder().encode('MZ, then the setup engine itself. '.repeat(50));
const library = Uint8Array.from({ length: 3000 }, (_, i) => (i * 7) & 255);
const sample = () =>
    installShieldEngine([
        { name: 'INSTALL.EXE', alias: '_INS0432._MP', data: program },
        { name: 'WUTL95i.DLL', alias: '_WUTL95.DLL', data: library },
    ]);
/** Where the first entry starts, and the second: after the first's 24 bytes and two names. */
const [FIRST, SECOND] = [82, 82 + 24 + 11 + 12];

describe('InstallShield 3 setup files', () => {
    it('unpacks each file, under its first name, and marks every byte', async () => {
        const data = sample();
        expect(detect(data, '_INST32I.EX_').id).toBe('installshield-engine');
        expect(detect(data, null).id).toBe('installshield-engine');
        const inspected = await inspect(data, { name: '_INST32I.EX_', names: [] });
        expect(inspected.checks).toEqual([]);
        const r = inspected.parsed;
        expect(r.warnings).toEqual([]);
        expect(r.entries!.map((e) => [e.name, e.meta!['Unpacked as']])).toEqual([
            ['INSTALL.EXE', '_INS0432._MP'],
            ['WUTL95i.DLL', '_WUTL95.DLL'],
        ]);
        expect(r.entries![0].data).toEqual(program);
        expect(r.entries![1].data).toEqual(library);
        expect(r.summary[0]).toEqual(['Files', 'INSTALL.EXE, WUTL95i.DLL']);
        expect(r.summary[2]).toEqual(['Copyright', 'Copyright (c) 1990-1995 Stirling Technologies, Inc. All Rights Reserve']);
        expect(r.fields.map((f) => f.name)).toEqual(['Header', 'Entries', 'File data']);
        expect(r.fields.reduce((n, f) => n + f.length, 0)).toBe(data.length);
        expect(r.end).toBe(data.length);
    });

    it('says when a file doesn’t unpack as its entry says, and offers it packed when it can’t', () => {
        const longer = sample();
        view(longer).setUint32(FIRST + 8, program.length + 100, true);
        expect(parse(longer).warnings).toEqual([`INSTALL.EXE unpacks to ${program.length.toLocaleString('en-US')} bytes, but its entry says ${(program.length + 100).toLocaleString('en-US')} bytes.`]);

        const broken = sample();
        const at = view(broken).getUint32(SECOND, true);
        broken[at] = 7;
        const r = parse(broken);
        expect(r.warnings).toEqual([expect.stringMatching(/^WUTL95i\.DLL can't be unpacked: .* It's offered packed, as it is here\.$/)]);
        expect(r.entries![1].name).toBe('WUTL95i.DLL.packed');
        expect(r.entries![1].meta!.Note).toBe('Not unpacked');
    });

    it('says when data is outside the file, overlaps, or leaves bytes nothing points to', () => {
        const past = sample();
        view(past).setUint32(SECOND, past.length, true);
        expect(parse(past).warnings).toEqual([
            `WUTL95i.DLL's data is said to be at ${past.length.toLocaleString('en-US')}, ${view(past)
                .getUint32(SECOND + 4, true)
                .toLocaleString('en-US')} bytes long, which is past the end of the file.`,
        ]);

        const into = sample();
        view(into).setUint32(FIRST, 90, true);
        expect(parse(into).warnings).toEqual([
            `INSTALL.EXE's data is said to be at 90, ${view(into)
                .getUint32(FIRST + 4, true)
                .toLocaleString('en-US')} bytes long, which is inside the entries.`,
            // Its real data is now nobody's.
            `${view(into).getUint32(FIRST + 4, true)} bytes between the files' data aren't part of any of them.`,
        ]);

        const overlap = sample();
        view(overlap).setUint32(SECOND, view(overlap).getUint32(FIRST, true), true);
        expect(parse(overlap).warnings).toContain("WUTL95i.DLL's data overlaps the data before it.");

        // Five bytes slipped in before the first file's data, and both moved past them.
        const plain = sample();
        const from = view(plain).getUint32(FIRST, true);
        const gap = new Uint8Array(plain.length + 5);
        gap.set(plain.subarray(0, from));
        gap.set([1, 2, 3, 4, 5], from);
        gap.set(plain.subarray(from), from + 5);
        for (const e of [FIRST, SECOND]) view(gap).setUint32(e, view(gap).getUint32(e, true) + 5, true);
        expect(parse(gap).warnings).toEqual(["5 bytes between the files' data aren't part of any of them."]);

        const name = installShieldEngine([{ name: '..\\BOOT.EXE', alias: '_INJ0432._MP', data: library }]);
        expect(parse(name).warnings).toEqual(['File 1\'s name "..\\BOOT.EXE" isn’t a plain file name: saved as it says, it could land outside the folder it’s saved to.']);
    });

    it('refuses what isn’t one, or can’t be', () => {
        const magic = sample();
        magic[5] = 2;
        expect(detect(magic, '_INST32I.EX_').id).not.toBe('installshield-engine');
        expect(() => parse(magic)).toThrow(/^This isn't InstallShield 3's setup files/);
        expect(() => parse(sample().subarray(0, 60))).toThrow(/^This InstallShield 3 setup file is cut short/);
        const count = sample();
        view(count).setUint16(78, 60000, true);
        expect(() => parse(count)).toThrow(/^Files: the header says 60,000/);

        const short = sample();
        view(short).setUint16(78, 3, true);
        expect(parse(short.subarray(0, view(short).getUint32(FIRST, true))).warnings[0]).toMatch(/^The entries end after 2 of the 3 files/);
    });
});

const CS = join(gameDir('cncRemastered') ?? '', 'RED_ALERT/COUNTERSTRIKE');
const FILES = ['SETUP95/_INST32I.EX_', 'INTERNET/_INST32I.EX_', 'PLANETWW/_INST32I.EX_', 'PLANETWW/_INST16.EX_'];

describe.skipIf(!existsSync(join(CS, FILES[0])))('Counterstrike’s InstallShield setup files', () => {
    it('unpack every file in all four, each to the size its entry says, with nothing to say', async () => {
        for (const path of FILES) {
            const data = new Uint8Array(readFileSync(join(CS, path)));
            expect(detect(data, path.split('/')[1]).id, path).toBe('installshield-engine');
            const inspected = await inspect(data, { name: path.split('/')[1], names: [] });
            expect(inspected.checks, path).toEqual([]);
            const r = inspected.parsed;
            expect(r.warnings, path).toEqual([]);
            expect(r.end, path).toBe(data.length);
            // Each is a Windows program or library: MZ, then a newer header where 0x3C points.
            for (const e of r.entries!) {
                expect(e.meta!.Note, `${path} › ${e.name}`).toBeUndefined();
                expect(String.fromCharCode(e.data[0], e.data[1]), `${path} › ${e.name}`).toBe('MZ');
            }
        }
    });

    it('hold the same LZWSERV.EXE in all three 32-bit installers', () => {
        const lzw = FILES.slice(0, 3).map((path) => parse(new Uint8Array(readFileSync(join(CS, path)))).entries!.find((e) => e.name!.toLowerCase() === 'lzwserv.exe')!.data);
        expect(lzw[1]).toEqual(lzw[0]);
        expect(lzw[2]).toEqual(lzw[0]);
        expect(lzw[0].length).toBe(20_656);
    });
});
