import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Parsed, TableRow } from '../core/types';
import { gameDir, gameFile } from '../testing/game-data';
import { windowsProgram } from '../testing/samples';
import { detect } from './index';
import { inspect } from './inspect';
import pe from './pe';

const parse = (data: Uint8Array, name = 'program.exe') => pe.parse(data, { name, names: [] }) as Parsed;

/**
 * Where things are in the sample (see windowsProgram): the PE header at 0x80, the optional header after it, its
 * data directories, the section table; .rdata's bytes at 0x400 and .rsrc's at 0x600.
 */
const PE = 0x80;
const OPT = PE + 24;
const DIRS = OPT + 96;
const SECTIONS = OPT + 224;
const RDATA = 0x400;
const RSRC = 0x600;
/** The sample with some of its bytes changed. */
const changed = (change: (v: DataView, data: Uint8Array) => void, data = windowsProgram()) => {
    change(new DataView(data.buffer), data);
    return data;
};
const warningsOf = (change: (v: DataView, data: Uint8Array) => void) => parse(changed(change)).warnings;
const tableOf = (r: Parsed): TableRow[] => {
    const p = r.preview!;
    const t = p.kind === 'stack' ? p.items.find((i) => i.preview.kind === 'table')!.preview : p;
    if (t.kind !== 'table') throw new Error('no table');
    return t.rows;
};

describe('Windows programs (PE)', () => {
    it('reads a program: its headers, imports, exports, resources and debug info, marking every byte', () => {
        const data = windowsProgram();
        expect(detect(data, 'program.exe').id).toBe('pe');
        const r = parse(data);
        expect(r.warnings).toEqual([]);
        expect(r.title).toBe('Windows program (PE, 32-bit)');
        expect(r.summary).toEqual(
            expect.arrayContaining([
                ['Description', 'Chimera sample program'],
                ['Version', '1.0.0.0'],
                ['Original name', 'program-pe.exe'],
                ['Linked', '2020-01-01 00:00:00 UTC, linker 1.0'],
                ['Starts', 'RVA 0x00001000, in .text'],
                ['Imports', '1 function from KERNEL32.dll'],
                ['Exports', '1 function'],
                ['Resources', '1 icon, 1 icon group, 1 version'],
                ['Debug info', 'sample.pdb'],
            ])
        );
        expect(tableOf(r).map((row) => [row.group, row.cells.name])).toEqual([
            ['KERNEL32.dll', 'ExitProcess'],
            ['Exports', 'Hello'],
        ]);
        // The icon, as an .ico from its group: a 6-byte header, one 16-byte entry, the image.
        const ico = r.entries!.find((e) => e.name?.endsWith('.ico'))!;
        expect(ico.name).toBe('program-1.ico');
        expect([...ico.data.subarray(0, 8)]).toEqual([0, 0, 1, 0, 1, 0, 16, 16]);
        expect(ico.data.length).toBe(6 + 16 + 296);
        // Every byte is in a field, once.
        expect(r.fields.reduce((n, f) => n + f.length, 0)).toBe(data.length);
        const rdata = r.fields.find((f) => f.name === 'Section .rdata')!;
        expect(rdata.children!.map((f) => f.name)).toEqual(expect.arrayContaining(['Imports', 'Imported names', 'Export directory', 'Debug directory', 'Debug info (CodeView)']));
    });

    it('reads a 64-bit one, and checks its Rich header’s checksum', () => {
        const data = windowsProgram({ wide: true, rich: true });
        const r = parse(data);
        expect(r.warnings).toEqual([]);
        expect(r.title).toBe('Windows program (PE, 64-bit)');
        expect(r.summary).toContainEqual(['Linked', '2020-01-01 00:00:00 UTC, linker 1.0 (Microsoft’s: it left a Rich header)']);
        const rich = r.fields.find((f) => f.name === 'Rich header')!;
        expect(rich.children!.map((f) => [f.name, f.value])).toContainEqual(['Tool 0104, build 30729', 'used 1 time']);
        expect(r.fields.reduce((n, f) => n + f.length, 0)).toBe(data.length);
        // A byte of the DOS stub changed, and the checksum no longer agrees.
        const edited = windowsProgram({ wide: true, rich: true });
        edited[0x50] ^= 1;
        expect(parse(edited).warnings).toEqual(['The Rich header’s checksum doesn’t match it or the DOS header: one of them was changed after the program was linked.']);
    });

    it('is a program under any other name', async () => {
        const r = await inspect(windowsProgram(), { name: 'picture.ico', names: [] });
        expect(r.format.id).toBe('pe');
        expect(r.checks[0]).toMatchObject({ level: 'danger', text: expect.stringMatching(/^It's named \.ico, but it isn't Icon or cursor \(ICO, CUR\): this is Windows program or library \(PE\)/) });
        expect((await inspect(windowsProgram(), { name: 'program.exe', names: [] })).checks).toEqual([]);
    });

    it('refuses what isn’t a program Windows could load', () => {
        expect(() => parse(new Uint8Array(200))).toThrow(/isn’t a Windows program or library/);
        expect(() => parse(changed((v) => v.setUint16(OPT, 0x107, true)))).toThrow(/ROM image/);
        expect(() => parse(changed((v) => v.setUint16(OPT, 0x1234, true)))).toThrow(/starts with 1234, not 0x10B/);
        expect(() => parse(changed((v) => v.setUint16(PE + 20, 64, true)))).toThrow(/optional header is said to be 64 bytes, too short for the 96/);
        expect(() => parse(windowsProgram().slice(0, OPT + 50))).toThrow(/ends inside its optional header/);
        // 0 is Win32s's quirk only with the 32-bit optional header's size.
        expect(() => parse(windowsProgram({ wide: true }).map((v, i) => (i === OPT || i === OPT + 1 ? 0 : v)))).toThrow(/starts with 0000, not 0x10B/);
    });

    it('reads Win32s’s own DLLs of 1996, whose magic is 0 and size only file-aligned', () => {
        const r = parse(
            changed((v) => {
                v.setUint16(OPT, 0, true);
                v.setUint32(OPT + 56, v.getUint32(OPT + 56, true) - 0x200, true);
            })
        );
        expect(r.warnings).toEqual([]);
        expect(r.title).toBe('Windows program (PE, 32-bit)');
        const magic = r.fields.find((f) => f.name === 'Optional header')!.children!.find((f) => f.name === 'Magic')!;
        expect(magic.note).toMatch(/Win32s loads them, Windows NT wouldn’t/);
        // Rounded to neither alignment, it's still said.
        expect(warningsOf((v) => (v.setUint16(OPT, 0, true), v.setUint32(OPT + 56, 0x3801, true)))).toContain(
            'It says it takes 14,337 bytes in memory, which isn’t a multiple of its section alignment (4,096).'
        );
    });

    it('says what its headers get wrong', () => {
        expect(warningsOf((v) => v.setUint32(OPT + 36, 0x300, true))).toContain(
            'Its sections are aligned to 768 bytes in the file; the spec allows a power of 2 from 512 to 65,536 (or less, when the same as in memory).'
        );
        expect(warningsOf((v) => v.setUint32(OPT + 32, 0x100, true))).toContain('Its sections are aligned to 256 bytes in memory, less than the 512 they are in the file.');
        expect(warningsOf((v) => v.setUint32(OPT + 56, 0x3800, true))).toContain('It says it takes 14,336 bytes in memory, which isn’t a multiple of its section alignment (4,096).');
        expect(warningsOf((v) => v.setUint32(OPT + 56, 0x3000, true))).toContain('It says it takes 12,288 bytes in memory, but .rsrc runs to 13,360 bytes: Windows won’t load it.');
        expect(warningsOf((v) => v.setUint32(OPT + 60, 0x100, true))).toContain('Its headers are said to be 256 bytes, but they take 496 bytes.');
        expect(warningsOf((v) => v.setUint32(OPT + 60, 0x300, true))).toContain('Its headers are said to be 768 bytes, which isn’t a multiple of its file alignment (512).');
        expect(warningsOf((v) => v.setUint32(OPT + 92, 17, true))).toContain('The optional header says it has 17 data directories, but its size leaves room for 16.');
        expect(warningsOf((v) => v.setUint32(DIRS + 7 * 8, 1, true))).toContain('The architecture entry of the data directories is set; the spec has it 0.');
        expect(warningsOf((v) => v.setUint32(DIRS + 15 * 8 + 4, 1, true))).toContain('The last entry of the data directories, which is reserved, is set; the spec has it 0.');
    });

    it('says what its sections get wrong', () => {
        expect(warningsOf((v) => v.setUint16(PE + 6, 97, true))).toEqual(
            expect.arrayContaining([
                'It has 97 sections; Windows loads programs with at most 96.',
                expect.stringMatching(/^It says it has 97 sections, but the file ends after \d+ of their headers\.$/),
            ])
        );
        expect(parse(windowsProgram().slice(0, 0x900)).warnings).toContain('.rsrc runs past the end of the file: it’s been cut short.');
        expect(warningsOf((v) => v.setUint32(SECTIONS + 40 + 20, 0x401, true))).toContain('.rdata starts in the file where its alignment (512) doesn’t allow.');
        expect(warningsOf((v) => v.setUint32(SECTIONS + 40 + 20, 0x100, true))).toContain('.rdata is said to start inside the headers.');
        expect(
            warningsOf((v) => {
                v.setUint32(SECTIONS + 80 + 12, 0x5000, true);
                v.setUint32(OPT + 56, 0x6000, true);
            })
        ).toContain('.rsrc isn’t where .rdata ends in memory, as the spec has sections one after another: it’s at RVA 0x00005000.');
        expect(warningsOf((v) => v.setUint32(OPT + 16, 0x3800, true))).toContain('It starts running at RVA 0x00003800, which isn’t in any of its sections.');
    });

    it('takes a section with no bytes in the file but a size there, as Watcom’s linker writes .bss', () => {
        // Its bytes are said to be at 0: there are none, whatever the size says (Counterstrike's PREVIEW.EXE).
        const r = parse(changed((v) => v.setUint32(SECTIONS + 20, 0, true)));
        expect(r.warnings).toEqual([]);
        expect(r.fields.find((f) => f.name === 'Section .text')).toBeUndefined();
    });

    it('says what its tables get wrong', () => {
        expect(warningsOf((v) => v.setUint32(DIRS + 8, 0x9000, true))).toContain('The import table is said to be at RVA 0x00009000, which isn’t in the file.');
        // The imports start so near the end of .rdata's bytes that the 20 zeros ending them can't fit.
        expect(warningsOf((v) => v.setUint32(DIRS + 8, 0x2000 + 215 - 20, true))).toContain('The list of imported libraries runs to the end of its section without the 20 zeros that end it.');
        expect(warningsOf((v) => v.setUint32(RDATA + 84 + 20, 1000, true))).toContain('Exported functions: the table says 1,000, but only 22 fit before the end of its section.');
        // Base relocations said to be the export directory, whose second word (0) can't be a block's size.
        expect(
            warningsOf((v) => {
                v.setUint32(DIRS + 5 * 8, 0x2000 + 84, true);
                v.setUint32(DIRS + 5 * 8 + 4, 40, true);
            })
        ).toContain('A block of base relocations (at 1,108) says it’s 0 bytes, too short for its own header.');
        expect(warningsOf((v, d) => v.setUint32(RDATA + 0x98 + 24, d.length, true))).toContain('The CodeView debug information is said to be 35 bytes at 3,072, past the end of the file.');
        expect(
            warningsOf((v, d) => {
                v.setUint32(PE + 12, d.length, true);
                v.setUint32(PE + 16, 10, true);
            })
        ).toContain('The symbol table is said to be 10 symbols at 3,072, past the end of the file.');
        const signatures = warningsOf((v, d) => {
            v.setUint32(DIRS + 4 * 8, d.length + 4, true);
            v.setUint32(DIRS + 4 * 8 + 4, 16, true);
        });
        expect(signatures).toEqual(['The signatures don’t start on an 8-byte boundary, as the spec has them.', 'The signatures are said to be 16 bytes at 3,076, past the end of the file.']);
        // A signature whose length is less than its own 8-byte header.
        expect(
            warningsOf((v, d) => {
                v.setUint32(DIRS + 4 * 8, d.length - 16, true);
                v.setUint32(DIRS + 4 * 8 + 4, 16, true);
            })
        ).toContain('Signature 1 says it’s 0 bytes, too short for its own header.');
    });

    it('takes no address worked out from the file on trust', () => {
        // The TLS directory said to be the export directory: its callbacks' address (the export's name, 0x2086, read as an
        // address in memory) is below where the program is loaded, so it's nowhere in the image.
        const r = parse(
            changed((v) => {
                v.setUint32(DIRS + 9 * 8, 0x2000 + 84, true);
                v.setUint32(DIRS + 9 * 8 + 4, 24, true);
            })
        );
        expect(r.summary.find(([k]) => k === 'Runs first')).toBeUndefined();
    });

    it('says what its resources get wrong', () => {
        // The icon's name directory points back to the top of the tree.
        expect(warningsOf((v) => v.setUint32(RSRC + 40 + 20, 0x80000000, true))).toContain(
            'The resource tree points back to one of its own directories, which a reader that trusts it would follow forever.'
        );
        // The icon's language directory points to a fourth level.
        expect(warningsOf((v) => v.setUint32(RSRC + 112 + 20, 0x80000000 | 40, true))).toContain(
            'The resource tree goes deeper than its three levels (type, name, language); Windows doesn’t look there.'
        );
        expect(warningsOf((v) => v.setUint32(RSRC + 184 + 4, 0x10000, true))).toContain('Icon #1 is said to be 65,536 bytes at RVA 0x000030E8, which runs past the end of its section.');
        expect(warningsOf((v) => v.setUint16(RSRC + 528 + 18, 2, true))).toContain("Icon group #1 names icon #2, which the program doesn't have.");
        expect(warningsOf((_, d) => (d[RSRC + 548 + 40] ^= 1))).toContain('Its version numbers don’t start with the signature Windows looks for (0xFEEF04BD), so Windows ignores them.');
        expect(warningsOf((v) => v.setUint16(RSRC + 548 + 6, 0x41, true))).toContain('Its version resource isn’t laid out as Windows lays them out: it doesn’t start with VS_VERSION_INFO.');
        // Two directories claiming 65,535 entries each: what doesn't fit is cut, what's wrong with each is said once, and the
        // tree reads no more entries than its table has room for.
        const crowded = warningsOf((v) => {
            v.setUint16(RSRC + 40 + 14, 0xffff, true);
            v.setUint16(RSRC + 64 + 14, 0xffff, true);
        });
        expect(crowded).toEqual(
            expect.arrayContaining([
                'The resource tree lists more entries than its table could hold: its directories overlap, so the rest weren’t read.',
                'Resource directory entries: the table says 65,535, but only 127 fit before the end of its section. There is 1 more like it.',
                'The entry for resource Icon › #0 is past the end of the resource table. There are 90 more like it.',
            ])
        );
        expect(crowded.length).toBeLessThan(8);
    });
});

/** Every PE file in a folder and those under it. */
function programs(folder: string): string[] {
    return readdirSync(folder).flatMap((name) => {
        const path = join(folder, name);
        if (statSync(path).isDirectory()) return programs(path);
        if (!/\.(exe|dll|ex_|asi|m3d)$/i.test(name)) return [];
        return detect(new Uint8Array(readFileSync(path).subarray(0, 4096)), name).id === 'pe' ? [path] : [];
    });
}

for (const [game, quirks] of [
    // PREVIEW.EXE's debug information was taken out of the copy that shipped, but its entry left in.
    ['cncRemastered', { 'RED_ALERT/COUNTERSTRIKE/PREVIEW.EXE': ['The CodeView debug information is said to be 56,821 bytes at 106,496, past the end of the file.'] }],
    ['tiberianSun', {}],
    ['redAlert2', {}],
] as const) {
    const folder = gameDir(game);
    describe.skipIf(!folder)(`the Windows programs of ${game}`, () => {
        it('read with nothing to warn about, every byte marked', async () => {
            const found = programs(folder!);
            expect(found.length).toBeGreaterThan(2);
            for (const path of found) {
                const data = new Uint8Array(readFileSync(path));
                // As the app reads it, with the checks every file gets (which mark the zeros some have after their end).
                const r = await inspect(data, { name: path, names: [] });
                const at = relative(folder!, path).replace(/\\/g, '/');
                expect(r.format.id, at).toBe('pe');
                expect(r.parsed.warnings, at).toEqual((quirks as Record<string, string[]>)[at] ?? []);
                expect(
                    r.checks.filter((c) => c.level !== 'info'),
                    at
                ).toEqual([]);
                expect(
                    r.parsed.fields.reduce((n, f) => n + f.length, 0),
                    at
                ).toBe(data.length);
                // Its bitmaps and version information, saved, open as files of their own, with nothing to warn about either.
                // So do its string tables and dialogs, which only the program can say are what they are.
                for (const e of r.parsed.entries ?? []) {
                    const kind = e.label.match(/^(Bitmap|Version|String table|Message table|Dialog) .*\.(bmp|bin|res)$/)?.[1];
                    if (!kind) continue;
                    const opened = await inspect(e.data, { name: null, names: [] }, { hint: e.format, shownName: e.label });
                    const where = `${at} › ${e.label}`;
                    expect(opened.format.id, where).toBe({ Bitmap: 'bmp', Version: 'version', 'String table': 'win-strings', 'Message table': 'win-messages', Dialog: 'res' }[kind]);
                    expect(opened.parsed.warnings, where).toEqual([]);
                    expect(
                        opened.checks.filter((c) => c.level !== 'info'),
                        where
                    ).toEqual([]);
                }
            }
        });
    });
}

const launcher = gameFile('redAlert2', 'Ra2.exe');
describe.skipIf(!launcher)('Red Alert 2’s launcher', () => {
    it('shows its string table: what it says when it needs a patch', () => {
        const r = parse(new Uint8Array(readFileSync(launcher!)), 'Ra2.exe');
        const p = r.preview!;
        const table = p.kind === 'stack' ? p.items.find((i) => i.title.startsWith('Strings'))?.preview : undefined;
        const rows = table?.kind === 'table' ? table.rows : [];
        expect(rows.slice(0, 2).map((row) => [row.cells.id, row.cells.text])).toEqual([
            ['1', 'Your computer needs to be restarted to continue the patch. Press OK to continue.'],
            ['2', 'About to restart'],
        ]);
    });
});

const totalAccess = gameDir('cncRemastered') && join(gameDir('cncRemastered')!, 'RED_ALERT/COUNTERSTRIKE/INTERNET/TA/SETUP.EXE');
describe.skipIf(!totalAccess)('Counterstrike’s TotalAccess setup', () => {
    it('lays out its dialogs as the program shows them', () => {
        const r = parse(new Uint8Array(readFileSync(totalAccess!)), 'SETUP.EXE');
        const p = r.preview!;
        const dialog = p.kind === 'stack' ? p.items.find((i) => i.title === 'Dialog #2: TotalAccess Installation')?.preview : undefined;
        if (dialog?.kind !== 'dialog') throw new Error('no dialog #2');
        expect([dialog.width, dialog.height, dialog.font]).toEqual([275, 210, { name: 'MS Sans Serif', size: 8 }]);
        expect(dialog.controls.map((c) => [c.kind, c.text])).toEqual(
            expect.arrayContaining([
                ['text', 'TotalAccess directory:'],
                ['edit', ''],
                ['button', '...'],
                ['default-button', '&Next >'],
                ['button', '&Cancel'],
            ])
        );
    });

    it('opens a string table it holds with the IDs it has in the program: MFC’s own, from 61440', async () => {
        const r = parse(new Uint8Array(readFileSync(totalAccess!)), 'SETUP.EXE');
        const e = r.entries!.find((x) => x.label === 'String table #3841.bin')!;
        expect(e.format).toBe('win-strings');
        const opened = await inspect(e.data, { name: null, names: [] }, { hint: e.format, shownName: e.label });
        const p = opened.parsed.preview!;
        // MFC's afxres.h: AFX_IDS_OPENFILE is 0xF000, AFX_IDS_SAVEFILE 0xF001.
        expect(p.kind === 'table' && p.rows.slice(0, 2).map((row) => [row.cells.id, row.cells.text])).toEqual([
            ['61440', 'Open'],
            ['61441', 'Save As'],
        ]);
    });
});

const win32s = gameDir('cncRemastered') && join(gameDir('cncRemastered')!, 'RED_ALERT/COUNTERSTRIKE/PLANETWW/WIN32S.Z');
describe.skipIf(!win32s)('the Win32s that Planet Westwood installs', () => {
    it('reads every 32-bit DLL in it, the eleven with magic 0, with no warnings', async () => {
        const archive = await inspect(new Uint8Array(readFileSync(win32s!)), { name: 'WIN32S.Z', names: [] });
        const odd = ['COMDLG32.DLL', 'LZ32.DLL', 'NETAPI32.DLL', 'OLECLI32.DLL', 'OLESVR32.DLL', 'SHELL32.DLL', 'VERSION.DLL', 'W32SCOMB.DLL', 'W32SKRNL.DLL', 'WSOCK32.DLL', 'WINSPOOL.DRV'];
        for (const name of odd) {
            const r = parse(archive.parsed.entries!.find((e) => e.name === name)!.data, name);
            expect([name, r.title, r.warnings]).toEqual([name, 'Windows library (DLL, 32-bit)', []]);
        }
    });
});
