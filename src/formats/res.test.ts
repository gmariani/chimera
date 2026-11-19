import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Parsed, Preview } from '../core/types';
import { iconDib, iconFile, resourceFile } from '../testing/samples';
import { detect } from './index';
import { inspect } from './inspect';
import res from './res';

const parse = (data: Uint8Array) => res.parse(data, { name: 'resources.res', names: [] }) as Parsed;
const items = (p?: Preview) => (p?.kind === 'stack' ? p.items : p ? [{ title: '', preview: p }] : []);
const dialogOf = (r: Parsed) => {
    const d = items(r.preview).find((i) => i.preview.kind === 'dialog')?.preview;
    if (d?.kind !== 'dialog') throw new Error('no dialog');
    return d;
};

describe('resource files (.res)', () => {
    it('reads each resource and what it holds, marking every byte', async () => {
        const data = resourceFile();
        expect(detect(data, 'resources.res').id).toBe('res');
        expect(detect(data, null).id).toBe('res');
        const inspected = await inspect(data, { name: 'resources.res', names: [] });
        expect(inspected.checks).toEqual([]);
        const r = inspected.parsed;
        expect(r.warnings).toEqual([]);
        expect(r.summary).toEqual([
            ['Resources', '1 icon, 1 icon group, 1 string table, 1 dialog'],
            ['Languages', 'English (US)'],
        ]);
        expect(r.fields.map((f) => f.name)).toEqual(['Empty entry', 'Icon #1', 'Icon group #1', 'String table #7', 'Dialog #100']);
        expect(r.fields.reduce((n, f) => n + f.length, 0)).toBe(data.length);
        expect(r.end).toBe(data.length);
        // The dialog shows the icon, drawn from the file.
        const dialog = dialogOf(r);
        expect(dialog.controls.map((c) => [c.kind, c.text, c.picture?.width])).toEqual([
            ['image', '', 16],
            ['text', 'Chimera', undefined],
            ['default-button', 'OK', undefined],
        ]);
        expect(items(r.preview).find((i) => i.preview.kind === 'table')?.preview).toMatchObject({ rows: [{ cells: { id: '100', text: 'Hello' } }] });
    });

    it('saves a dialog as a .res file with the pictures it shows, so it draws on its own', async () => {
        const entry = parse(resourceFile()).entries!.find((e) => e.label === 'Dialog #100.res')!;
        const opened = await inspect(entry.data, { name: null, names: [] }, { shownName: entry.label });
        expect(opened.format.id).toBe('res');
        expect(opened.parsed.warnings).toEqual([]);
        expect(opened.parsed.summary[0]).toEqual(['Resources', '1 dialog, 1 icon group, 1 icon']);
        expect(dialogOf(opened.parsed).controls[0].picture?.width).toBe(16);
    });

    it('says what doesn’t fit, and refuses what isn’t one', () => {
        const short = resourceFile();
        new DataView(short.buffer).setUint32(32 + 4, 8, true);
        expect(parse(short).warnings).toEqual(['The resource at 32 says its header is 8 bytes, less than the 32 every header takes: what follows wasn’t read.']);
        const long = resourceFile();
        // The dialog's data size, at the start of its header.
        new DataView(long.buffer).setUint32(parse(resourceFile()).fields.at(-1)!.offset, 5000, true);
        expect(parse(long).warnings).toContain('Dialog #100 says it’s 5,000 bytes, past the end of the file: it’s cut short.');
        expect(() => parse(new Uint8Array(64))).toThrow('This isn’t a 32-bit resource file: it doesn’t start with the empty entry rc.exe writes.');
    });
});

// Ground truth from outside: what Wine's resource compiler makes of a script, when it's installed.
const wrc = spawnSync('wrc', ['--version']).status === 0;
describe.skipIf(!wrc)('resource files Wine’s resource compiler makes', () => {
    it('reads them as the script says', () => {
        const dir = mkdtempSync(join(tmpdir(), 'chimera-wrc-'));
        try {
            writeFileSync(join(dir, 'icon.ico'), iconFile([{ image: iconDib(), width: 16, height: 16, colors: 16, bits: 4 }]));
            writeFileSync(
                join(dir, 'about.rc'),
                [
                    '1 ICON "icon.ico"',
                    'STRINGTABLE',
                    'BEGIN',
                    '  100 "Hello"',
                    '  101 "World"',
                    'END',
                    '100 DIALOGEX 0, 0, 160, 60',
                    'STYLE 0x10C80040',
                    'CAPTION "About"',
                    'FONT 8, "MS Shell Dlg"',
                    'BEGIN',
                    '  ICON 1, -1, 10, 10, 20, 20',
                    '  LTEXT "Chimera", -1, 40, 14, 100, 8',
                    '  DEFPUSHBUTTON "OK", 1, 55, 40, 50, 14',
                    '  CHECKBOX "&Again", 2, 40, 26, 60, 10',
                    'END',
                ].join('\n')
            );
            expect(spawnSync('wrc', ['-o', join(dir, 'about.res'), join(dir, 'about.rc')]).status).toBe(0);
            const data = new Uint8Array(readFileSync(join(dir, 'about.res')));
            const r = parse(data);
            expect(r.warnings).toEqual([]);
            expect(r.fields.reduce((n, f) => n + f.length, 0)).toBe(data.length);
            const dialog = dialogOf(r);
            expect([dialog.title, dialog.width, dialog.height, dialog.font]).toEqual(['About', 160, 60, { name: 'MS Shell Dlg', size: 8 }]);
            expect(dialog.controls.map((c) => [c.kind, c.text, c.x, c.y, c.width, c.height, !!c.picture])).toEqual([
                ['image', '', 10, 10, 20, 20, true],
                ['text', 'Chimera', 40, 14, 100, 8, false],
                ['default-button', 'OK', 55, 40, 50, 14, false],
                ['checkbox', '&Again', 40, 26, 60, 10, false],
            ]);
            expect(items(r.preview).find((i) => i.preview.kind === 'table')?.preview).toMatchObject({
                rows: [{ cells: { id: '100', text: 'Hello' } }, { cells: { id: '101', text: 'World' } }],
            });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
