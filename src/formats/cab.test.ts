import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Parsed } from '../core/types';
import { gameDir } from '../testing/game-data';
import { cabinet } from '../testing/samples';
import cab from './cab';
import { detect } from './index';
import { inspect } from './inspect';

const parse = (data: Uint8Array) => cab.parse(data, { name: 'cabinet.cab', names: [] }) as Parsed;
const latin1 = (d: Uint8Array) => new TextDecoder('latin1').decode(d);
const sentence = 'The first file in MSZIP. ';
/** The sample, unsigned: its folders at 36 and 44 (where each one's data is, its blocks, its compression), its files at 52. */
const FOLDERS = 36;
const FILES = 52;
const edited = (change: (v: DataView, d: Uint8Array) => void, data = cabinet()) => {
    change(new DataView(data.buffer), data);
    return data;
};
const warningsOf = (change: (v: DataView, d: Uint8Array) => void) => parse(edited(change)).warnings;
/** Where folder `i`'s first block is. */
const block = (i: number) => new DataView(cabinet().buffer).getUint32(FOLDERS + i * 8, true);

describe('Microsoft cabinets', () => {
    it('takes its files out: one folder stored, one in MSZIP reaching back across its blocks, every byte marked', async () => {
        const data = cabinet();
        expect(detect(data, 'cabinet.cab').id).toBe('cab');
        expect(detect(data, null).id).toBe('cab');
        const inspected = await inspect(data, { name: 'cabinet.cab', names: [] });
        expect(inspected.checks).toEqual([]);
        const r = inspected.parsed;
        expect(r.warnings).toEqual([]);
        expect(r.summary).toEqual([
            ['Files', '3, 32,818 bytes unpacked'],
            ['Compression', 'none, MSZIP'],
        ]);
        expect(r.fields.reduce((n, f) => n + f.length, 0)).toBe(data.length);
        const files = Object.fromEntries(r.entries!.map((e) => [e.name, latin1(e.data)]));
        expect(Object.keys(files)).toEqual(['readme.txt', 'data/one.txt', 'data/two.txt']);
        expect(files['readme.txt']).toBe('Chimera sample cabinet.\r\n');
        expect(files['data/one.txt']).toBe(sentence.repeat(1311).slice(0, 32761));
        // The second block's back-reference, into the first.
        expect(files['data/two.txt']).toBe(`Twice: ${sentence}`);
        const p = r.preview!;
        expect(p.kind === 'table' && p.rows.map((row) => [row.cells.name, row.cells.date, row.cells.attributes, row.cells.folder])).toEqual([
            ['readme.txt', '1997-04-23 14:02:10', 'archive', '1'],
            ['data\\one.txt', '1997-04-23 14:02:10', 'archive', '2'],
            ['data\\two.txt', '1997-04-23 14:02:10', 'archive', '2'],
        ]);
    });

    it('reads a signed one’s signature, after its end, where its header says', async () => {
        const inspected = await inspect(cabinet({ signed: true }), { name: 'cabinet.cab', names: [] });
        expect(inspected.checks).toEqual([]);
        const r = inspected.parsed;
        expect(r.warnings).toEqual([]);
        expect(Object.fromEntries(r.summary).Signed).toBe('Chimera Sample, vouched for by Chimera Test CA; the cabinet’s SHA-256 hash (Authenticode), not checked here');
        expect(r.entries!.map((e) => [e.name, e.format])).toContainEqual(['cabinet-signature.p7s', 'pkcs7']);
        expect(r.fields.reduce((n, f) => n + f.length, 0)).toBe(r.end);
    });

    it('says what doesn’t fit the format', () => {
        expect(warningsOf((v) => v.setUint16(24, 0x0102, true))).toEqual(['It says it’s version 1.2; cabinets are 1.3.']);
        expect(warningsOf((v) => v.setUint32(12, 5, true))).toEqual(['Its header’s second reserved field is 0x00000005, not 0.']);
        expect(warningsOf((v) => v.setUint16(30, 0x10, true))).toEqual(['Its header has flags the format doesn’t define (0x0010).']);
        expect(warningsOf((v) => v.setUint16(FOLDERS + 6, 9, true))).toContain('Folder 1 says it’s compressed with method 9, which cabinets don’t have.');
        expect(warningsOf((v) => v.setUint16(FILES + 14, 0x120, true))).toEqual(['readme.txt has attributes the format doesn’t define (0x0100).']);
        expect(warningsOf((v) => v.setUint16(FILES + 8, 5, true))).toEqual(['readme.txt says it’s in folder 6, but there are 2.']);
        // The list of files said to start where there's no room for one; then where one has no end to its name.
        const size = cabinet().length;
        expect(warningsOf((v) => v.setUint32(16, size - 10, true))).toContain('The list of files ends after 0 files, of the 3 its header says.');
        expect(warningsOf((v, d) => (v.setUint32(16, size - 30, true), d.fill(0x41, size - 14)))).toContain('File 1’s name runs past the end of the cabinet, or past 255 bytes.');
        expect(warningsOf((v) => v.setUint16(26, 900, true))).toContain(
            'The list of folders ends after 2 folders, of the 900 its header says.'.replace('2 folders', `${Math.floor((size - 36) / 8).toLocaleString('en-US')} folders`)
        );
        expect(warningsOf((v) => v.setUint32(16, 60, true))).toContain('Its header says the list of files is at 60, but the folders end at 52.');
        // A file past what its folder unpacks to.
        expect(warningsOf((v) => v.setUint32(FILES, 40, true))).toEqual(['1 file runs past what its folder unpacks to: it isn’t taken out.']);
    });

    it('says what’s wrong with its blocks', () => {
        const first = block(0);
        const second = block(1);
        expect(warningsOf((_v, d) => (d[first + 8] ^= 1))).toEqual(['1 block’ checksums don’t match its data: the cabinet was damaged or changed after it was made.']);
        expect(warningsOf((v) => (v.setUint32(first, 0, true), v.setUint16(first + 6, 3, true)))).toEqual([
            'Folder 1 can’t be unpacked in full: its block 1 is 25 bytes, but says it’s 3 bytes unpacked, and it isn’t compressed. The files past where it stops aren’t taken out.',
            '1 file runs past what its folder unpacks to: it isn’t taken out.',
        ]);
        expect(warningsOf((v, d) => (v.setUint32(second, 0, true), (d[second + 8] = 0x41)))).toEqual(
            expect.arrayContaining(['Folder 2 can’t be unpacked in full: its block 1 doesn’t start with "CK", as an MSZIP block does. The files past where it stops aren’t taken out.'])
        );
        expect(warningsOf((v) => (v.setUint32(second, 0, true), v.setUint16(second + 6, 40000, true)))).toEqual(
            expect.arrayContaining([
                'Folder 2 can’t be unpacked in full: its block 1 says it unpacks to 40,000 bytes, more than the 32 KB a block can. The files past where it stops aren’t taken out.',
            ])
        );
        expect(warningsOf((v) => (v.setUint32(second, 0, true), v.setUint16(second + 6, 32000, true)))).toEqual([
            'Folder 2 can’t be unpacked in full: its block 1 unpacks to 32,768 bytes, not the 32,000 bytes it says. The files past where it stops aren’t taken out.',
            '1 file runs past what its folder unpacks to: it isn’t taken out.',
        ]);
        // A first block of 32 bytes, not 32 KB, that the second reaches back into.
        const short = parse(cabinet({ short: true }));
        expect(short.warnings).toEqual([
            '1 block of folder 2 unpacks to less than 32 KB, though not the last: programs differ on what the blocks after reach back into, so its files may come out differently elsewhere.',
        ]);
        expect(latin1(short.entries!.find((e) => e.name === 'data/two.txt')!.data)).toBe(`Twice: ${sentence}`);
        // The compressed data broken: a block type Deflate doesn't have.
        expect(warningsOf((v, d) => (v.setUint32(second, 0, true), (d[second + 10] |= 6)))).toEqual(
            expect.arrayContaining([expect.stringMatching(/^Folder 2 can’t be unpacked in full: its block 1 can’t be unpacked: /)])
        );
        // A third block claimed: the second is then short, and not the last.
        expect(warningsOf((v) => v.setUint16(FOLDERS + 8 + 4, 3, true))).toEqual([
            '1 block of folder 2 unpacks to less than 32 KB, though not the last: programs differ on what the blocks after reach back into, so its files may come out differently elsewhere.',
            'Folder 2 can’t be unpacked in full: its block 3 of 3 would start past the end of the cabinet. The files past where it stops aren’t taken out.',
        ]);
        const cut = cabinet().subarray(0, cabinet().length - 10);
        expect(parse(cut).warnings).toEqual(expect.arrayContaining([expect.stringMatching(/^It says it’s [\d,]+ bytes, but the file is [\d,]+ bytes: it’s been cut short\.$/)]));
    });

    it('says when its header points to a signature that isn’t there', () => {
        const data = cabinet({ signed: true });
        new DataView(data.buffer).setUint32(48, 0x7fffff, true);
        expect(parse(data).warnings).toEqual([
            'Its header says its signature is 8,388,607 bytes at 1,096, past the end of the file.'.replace('1,096', String(new DataView(data.buffer).getUint32(44, true).toLocaleString('en-US'))),
        ]);
    });

    it('refuses what isn’t one', () => {
        expect(() => parse(new TextEncoder().encode('MSCF'.padEnd(40, '\0')))).toThrow('This isn’t a Microsoft cabinet: it doesn’t start with "MSCF" and a header that fits.');
        expect(() => parse(edited((v) => (v.setUint16(30, 4, true), v.setUint16(36, 60000, true))))).toThrow('This isn’t a Microsoft cabinet: it sets aside 60,000 bytes in its header, past its end.');
        expect(() => parse(edited((v, d) => (v.setUint16(30, 1, true), d.fill(0x41, 36, 330))))).toThrow('This isn’t a Microsoft cabinet: the name of the cabinet before it runs past its end.');
    });
});

// Ground truth from outside: cabextract (libmspack), when it's installed.
const cabextract = spawnSync('cabextract', ['--version']).status === 0;
describe.skipIf(!cabextract)('what cabextract takes out', () => {
    it('agrees on every file of the sample, and on its checksums', () => {
        const dir = mkdtempSync(join(tmpdir(), 'chimera-cab-'));
        try {
            const file = join(dir, 'sample.cab');
            writeFileSync(file, cabinet());
            for (const e of parse(cabinet()).entries!) {
                const out = spawnSync('cabextract', ['-q', '-p', '-F', e.name!, file]);
                expect([e.name, out.status, Buffer.from(e.data).equals(out.stdout)]).toEqual([e.name, 0, true]);
            }
            // A byte changed: cabextract finds the checksum wrong too.
            writeFileSync(
                file,
                edited((_v, d) => (d[block(0) + 8] ^= 1))
            );
            expect(spawnSync('cabextract', ['-t', file], { encoding: 'utf-8' }).stdout).toContain('checksum error');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

const CNC = gameDir('cncRemastered');
describe.skipIf(!CNC)('Internet Explorer 3’s setup files, in Counterstrike’s INTERNET folder', () => {
    it('takes out its 18 files, and the 131 of the cabinet inside, with no warnings', async () => {
        // _SETUP.1 (InstallShield) › PIE.exe › its CABINET resource.
        const setup = await inspect(new Uint8Array(readFileSync(join(CNC!, 'RED_ALERT/COUNTERSTRIKE/INTERNET/_SETUP.1'))), { name: '_SETUP.1', names: [] });
        const pie = setup.parsed.entries!.find((e) => (e.name ?? e.label) === 'PIE.exe')!;
        const program = await inspect(pie.data, { name: 'PIE.exe', names: [] });
        const resource = program.parsed.entries!.find((e) => e.label === 'Raw data CABINET.bin')!;
        const outer = await inspect(resource.data, { name: null, names: [] }, { shownName: resource.label });
        expect([outer.format.id, outer.parsed.warnings, outer.checks]).toEqual(['cab', [], []]);
        expect(outer.parsed.entries!.map((e) => e.name)).toContain('Iexplore.cab');
        expect(outer.parsed.entries).toHaveLength(18);
        const inner = await inspect(outer.parsed.entries!.find((e) => e.name === 'Iexplore.cab')!.data, { name: 'Iexplore.cab', names: [] });
        expect([inner.format.id, inner.parsed.warnings, inner.checks, inner.parsed.entries!.length]).toEqual(['cab', [], [], 131]);
    });
});

const TS = gameDir('tiberianSun');
const themes = TS && existsSync(join(TS, 'Themes/themes.cab')) ? join(TS, 'Themes/themes.cab') : null;
describe.skipIf(!themes)('Tiberian Sun’s desktop themes', () => {
    it('takes out all 85 files, with no warnings', async () => {
        const r = await inspect(new Uint8Array(readFileSync(themes!)), { name: 'themes.cab', names: [] });
        expect([r.format.id, r.parsed.warnings, r.checks, r.parsed.entries!.length]).toEqual(['cab', [], [], 85]);
    });
});
