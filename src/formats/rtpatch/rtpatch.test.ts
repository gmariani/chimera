import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Companion, Parsed } from '../../core/types';
import { gameDir } from '../../testing/game-data';
import { rtPatch, rtPatchNew, rtPatchOld } from '../../testing/samples';
import { detect } from '../index';
import { inspect } from '../inspect';
import rtpatch, { rtChecksum } from './index';
import { runProgram } from './program';

/** Where the sample's parts are: its header is 30 bytes; then NEWFILE.TXT's record, OLDFILE.TXT's, PATCHME.DAT's, the end. */
const ADD = 30;
const ADDED_ENTRY = ADD + 21;
const ADDED_DATA = ADDED_ENTRY + 34;
const DELETE = ADDED_DATA + 21;
const DELETED_ENTRY = DELETE + 13;
const CHANGE = DELETED_ENTRY + 34;
const PROGRAM = CHANGE + 24 + 68;

const parse = (data: Uint8Array, find?: (name: string) => Companion[]) => rtpatch.parse(data, { name: 'patch.rtp', names: [], find }) as Parsed;
const withOld = (name: string) => (name.toLowerCase() === 'patchme.dat' ? [{ data: rtPatchOld(), source: 'PATCHME.DAT' }] : []);
const edited = (change: (v: DataView, d: Uint8Array) => void, data = rtPatch()) => {
    change(new DataView(data.buffer), data);
    return data;
};
const warningsOf = (change: (v: DataView, d: Uint8Array) => void) => parse(edited(change), withOld).warnings;
const rowsOf = (r: Parsed) => (r.preview?.kind === 'table' ? r.preview.rows.map((row) => [row.group, row.cells.file, row.cells.holds]) : []);
const summary = (r: Parsed) => Object.fromEntries(r.summary);

describe('RTPatch patches', () => {
    it('reads one: the files it adds, deletes and changes, every byte marked', async () => {
        const data = rtPatch();
        expect(detect(data, 'patch.rtp').id).toBe('rtpatch');
        expect(detect(data, null).id).toBe('rtpatch');
        const inspected = await inspect(data, { name: 'patch.rtp', names: [] });
        expect([inspected.parsed.warnings, inspected.checks]).toEqual([[], []]);
        const r = inspected.parsed;
        expect(summary(r)).toEqual({
            Version: '0x12C',
            Files: '3: 1 added, 1 changed, 1 deleted',
            'Newest file': '1997-03-17 16:46:44',
            'Largest file': '96 bytes',
            Stored: 'as it is, nothing compressed',
            'Changed files made': 'none: open the old file beside it to make it',
        });
        expect(rowsOf(r)).toEqual([
            ['Added', 'NEWFILE.TXT', 'the whole file'],
            ['Deleted', 'OLDFILE.TXT', 'nothing: the file goes'],
            ['Changed', 'PATCHME.DAT', 'keeps 54 bytes of the old file, adds 15 bytes, fills 27 bytes, changes 8 numbers in place'],
        ]);
        expect(r.fields.reduce((n, f) => n + f.length, 0)).toBe(data.length);
        expect(r.entries!.map((e) => [e.name, new TextDecoder().decode(e.data)])).toEqual([['NEWFILE.TXT', 'Added by the patch.\r\n']]);
    });

    it('makes the changed file from the old one, when it’s open, as written out by hand', () => {
        const r = parse(rtPatch(), withOld);
        expect(r.warnings).toEqual([]);
        expect(summary(r)['Changed files made']).toBe('1 of 1, from the old ones that are open');
        expect(rowsOf(r)[2][2]).toContain('(made from PATCHME.DAT)');
        const made = r.entries!.find((e) => e.name === 'PATCHME.DAT')!;
        expect([...made.data]).toEqual([...rtPatchNew()]);
        // Another file of the name isn't taken for it.
        const other = parse(rtPatch(), () => [{ data: new Uint8Array(42), source: 'elsewhere' }]);
        expect(other.entries!.map((e) => e.name)).toEqual(['NEWFILE.TXT']);
        expect(rowsOf(other)[2][2]).toContain('(the PATCHME.DAT that’s open isn’t the version it changes)');
    });

    it('reads its numbers as the spec’s worked example has them, and checksums as it describes', () => {
        // 60 E1 64 is 25,825: here, the count of zeros a program fills.
        const run = runProgram(Uint8Array.of(0x02, 0x00, 0x0b, 0x60, 0xe1, 0x64, 0x05, 0x01), 0, 25825, 1, null);
        expect([run.problem, run.filled]).toEqual([null, 25825]);
        // From 0: XOR the byte in, rotate left by 8 within 31 bits (or 30).
        expect(rtChecksum(Uint8Array.of(1), 31)).toBe(0x100);
        expect(rtChecksum(Uint8Array.of(1, 2, 3, 4), 31)).toBe(((0x01020304 * 256) % 2 ** 31) + (0x01020304 >>> 23));
        // By hand, in 30 bits: FF00, FFFF00, 3FFFFF03, then 3FFFFFFC rotated: 3FFFFCFF.
        expect(rtChecksum(Uint8Array.of(0xff, 0xff, 0xff, 0xff), 30)).toBe(0x3ffffcff);
    });

    it('stops a program that does what it can’t, and says why', () => {
        const stop = (program: number[], oldSize = 10, newSize = 10, sources = 1) => runProgram(Uint8Array.from(program), oldSize, newSize, sources, null).problem;
        expect(stop([0x02, 0x00])).toBe('its program ends without its END');
        expect(stop([0x02, 0x00, 0x05, 0x01])).toBe('its program has fewer new bytes than it leaves gaps for');
        expect(stop([0x02, 0x00, 0x03, 0x00, 0x0a, 0x01, 0x00])).toBe('its program goes on after its END');
        expect(stop([0x02, 0x00, 0x04, 0x02, 0x00, 0x08, 0x01])).toBe('its program leaves gaps it never fills');
        expect(stop([0x02, 0x00, 0x03, 0x05, 0x06, 0x01])).toBe('its program copies from past the end of the old file');
        expect(stop([0x02, 0x00, 0x03, 0x00, 0x0a, 0x0b, 0x01, 0x01])).toBe('its program writes past the end of the new file');
        expect(stop([0x02, 0x00, 0x04, 0x0b, 0x00, 0x00, 0x01])).toBe('its program leaves a gap past the end of the new file');
        expect(stop([0x02, 0x00, 0x08, 0x08, 0x05, 0x01])).toBe('its program stores a copy from past the end of the old file');
        expect(stop([0x02, 0x00, 0x09, 0x00, 0x01])).toBe('its program repeats copy 0, which it hasn’t stored');
        expect(stop([0x02, 0x00, 0x0b, 0xff, 0x01])).toBe('its program has a number of more than 5 bytes');
        expect(stop([0x02, 0x00, 0x0b, 0x81, 0x01])).toBe('its program has a negative count');
        expect(stop([0x02, 0x00, 0x0b, 0x0a, 0x06, 0x0a, 0x01, 0x01])).toBe('its program changes a number outside the new file');
        expect(stop([0x02, 0x01, 0x01])).toBe('its program names old file 1, which it doesn’t have');
        expect(stop([0x02, 0x00, 0x03, 0x02, 0x00, 0x01, 0x01], 10, 10, 2)).toBe('its program names old file 2, which it doesn’t have');
        expect(stop([0x02, 0x00, 0x20, 0x01])).toBe('its program has an operation, 0x20, that RTPatch doesn’t');
        expect(runProgram(Uint8Array.of(0x01), 1, 1, 2, new Uint8Array(1)).problem).toBe('it changes several old files into one, which isn’t done here');
    });

    it('says what’s wrong with its records', () => {
        expect(warningsOf((_v, d) => (d[DELETED_ENTRY + 24] ^= 1))).toEqual(['The entry for old OLDFILE.TXT says it’s 26 bytes, but its check bytes are for another size.']);
        expect(warningsOf((_v, d) => (d[ADDED_DATA] ^= 1))).toEqual([
            'NEWFILE.TXT, which it adds, doesn’t match the checksums it gives for it: it’s been changed since the patch was made, or damaged.',
        ]);
        expect(warningsOf((v, d) => (v.setUint32(ADDED_ENTRY + 16, 22, true), (d[ADDED_ENTRY + 24] = 22), (d[ADDED_ENTRY + 25] = 22)))).toEqual([
            'It says NEWFILE.TXT is 22 bytes, but holds 21 bytes of it.',
        ]);
        expect(warningsOf((_v, d) => (d[PROGRAM + 7] = 0x30))).toEqual(['The changes to PATCHME.DAT can’t be followed: its program copies from past the end of the old file.']);
        // The new bytes changed: what's made isn't what the patch says it makes.
        expect(warningsOf((_v, d) => (d[d.length - 40] ^= 1))).toEqual(['PATCHME.DAT, made from the one that’s open (PATCHME.DAT), doesn’t match the checksums the patch gives for it.']);
        expect(warningsOf((_v, d) => (d[CHANGE + 1] = 0x64))).toEqual([`It has a record of a kind this reader doesn’t know (6) at ${CHANGE}: what’s after it isn’t read.`]);
        expect(warningsOf((_v, d) => (d[DELETE + 12] = 0x3f))).toEqual([`A record at ${DELETE} says it has 63 versions of its file, more than fit in what’s left: what’s after it isn’t read.`]);
        expect(warningsOf((_v, d) => ((d[CHANGE + 14] = 0), (d[CHANGE + 15] = 0)))).toContain('It changes a file without saying what it was or what it becomes.');
        expect(parse(rtPatch().subarray(0, ADDED_DATA + 10)).warnings).toEqual(['What it holds for NEWFILE.TXT (21 bytes) runs past the end of the patch: it’s been cut short.']);
        expect(parse(rtPatch().subarray(0, -2), withOld).warnings).toEqual(['It has no end record: it’s been cut short.']);
        // A list of folders that doesn't fit.
        expect(warningsOf((v, d) => (v.setUint16(4, 0x92e4, true), (d[30] = 0xff), (d[31] = 0xff)))).toContain('Its list of 65,535 folders runs past the end of the file.');
    });

    it('lists what’s compressed, and reads only the header of later layouts', () => {
        // The added file said to unpack to more than it holds: compressed, and not unpacked.
        const r = parse(edited((v) => v.setUint32(ADD + 13, 40, true)));
        expect(rowsOf(r)[0]).toEqual(['Added', 'NEWFILE.TXT', 'the file, compressed: not unpacked here']);
        expect(summary(r).Stored).toBe('1 of its files and programs compressed: not unpacked here');
        const later = parse(edited((v) => v.setUint16(2, 0x0320, true)));
        expect(later.warnings).toEqual(['It’s RTPatch’s format 0x320, laid out differently from the patches this reader was made from: only its header is read.']);
    });

    it('refuses what isn’t one', () => {
        expect(() => parse(new Uint8Array(64))).toThrow('This isn’t an RTPatch patch: it doesn’t start with "K*", a version and a header that fits.');
        expect(() => parse(edited((v) => v.setUint16(2, 0x0001, true)))).toThrow('This isn’t an RTPatch patch');
        expect(() => parse(edited((_v, d) => (d[ADD + 1] = 0x94)))).toThrow('This isn’t an RTPatch patch');
    });
});

const CNC = gameDir('cncRemastered');
describe.skipIf(!CNC)('Counterstrike’s patch to Red Alert', () => {
    it('reads CSTRIKE.RTP: its files the ones on the disc, its changes followed to the end', async () => {
        const folder = join(CNC!, 'RED_ALERT/COUNTERSTRIKE');
        const data = new Uint8Array(readFileSync(join(folder, 'SETUP/INSTALL/CSTRIKE.RTP')));
        const r = await inspect(data, { name: 'CSTRIKE.RTP', names: [] });
        expect([r.format.id, r.parsed.warnings, r.checks]).toEqual(['rtpatch', [], []]);
        expect(summary(r.parsed)).toMatchObject({ Version: '0x12C', Files: '12: 3 added, 7 changed, 2 deleted', 'Largest file': '2,430,275 bytes' });
        expect(rowsOf(r.parsed).map(([group, file]) => `${group} ${file}`)).toEqual([
            'Added EXPAND.MIX',
            'Deleted README.WRI',
            'Deleted RA.PIF',
            'Added README.DOC',
            'Changed README.TXT',
            'Changed RA.EXE',
            'Changed INSTICON.EXE',
            'Changed EDWIN.EXE',
            'Changed EDIT.DAT',
            'Changed GAME.DAT',
            'Changed RA95.EXE',
            'Added RA.PIF',
        ]);
        expect(rowsOf(r.parsed)[4][2]).toBe('keeps 24,613 bytes of the old file, adds 6,463 bytes, changes 53 numbers in place');
        // The files it adds are Counterstrike's own, on its disc.
        for (const name of ['EXPAND.MIX', 'README.DOC']) expect(Buffer.from(r.parsed.entries!.find((e) => e.name === name)!.data).equals(readFileSync(join(folder, name)))).toBe(true);
    });
});
