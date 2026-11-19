import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Parsed } from '../core/types';
import { gameDir } from '../testing/game-data';
import { inspect } from './inspect';
import res from './res';
import keysReader from './resources/accelerators';
import { readAccelerators } from './win-accelerators';
import { resourceFile } from './win-resources';

const u16 = (v: number) => [v & 0xff, (v >> 8) & 0xff];
const wide = (s: string) => [...[...s].flatMap((c) => u16(c.charCodeAt(0))), 0, 0];
/** 32-bit entries: flags, key, command, padding. */
const entry32 = (flags: number, key: number, id: number) => [...u16(flags), ...u16(key), ...u16(id), 0, 0];

describe('shortcut keys (accelerator tables)', () => {
    it('reads virtual keys with Ctrl, Alt and Shift, and characters', () => {
        // F1; Ctrl+Shift+O; Alt+Enter; "^C" (a character, Ctrl+C); Delete, the last.
        const data = Uint8Array.from([...entry32(0x01, 0x70, 1), ...entry32(0x0d, 0x4f, 2), ...entry32(0x11, 0x0d, 3), ...entry32(0x00, 0x03, 4), ...entry32(0x81, 0x2e, 5)]);
        const a = readAccelerators(data, 0, data.length, true);
        expect(a.problems).toEqual([]);
        expect(a.entries).toEqual([
            { keys: 'F1', id: 1 },
            { keys: 'Ctrl+Shift+O', id: 2 },
            { keys: 'Alt+Enter', id: 3 },
            { keys: 'Ctrl+C', id: 4 },
            { keys: 'Delete', id: 5 },
        ]);
        expect(a.end).toBe(data.length);
        expect(a.fields.reduce((n, f) => n + f.length, 0)).toBe(data.length);
    });

    it('reads a 16-bit module’s, 5 bytes to a key', () => {
        const data = Uint8Array.of(0x09, ...u16(0x53), ...u16(10), 0x81, ...u16(0x75), ...u16(11));
        expect(readAccelerators(data, 0, data.length, false).entries).toEqual([
            { keys: 'Ctrl+S', id: 10 },
            { keys: 'F6', id: 11 },
        ]);
    });

    it('says what doesn’t fit, and refuses what isn’t one', () => {
        const open = Uint8Array.from(entry32(0x01, 0x70, 1));
        expect(readAccelerators(open, 0, open.length, true).problems).toEqual(['The shortcut keys run to the end of their resource without the entry marked as the last.']);
        const shifted = Uint8Array.from(entry32(0x84, 0x41, 1));
        expect(readAccelerators(shifted, 0, shifted.length, true).problems).toEqual([
            'The shortcut A (command 1) asks for Ctrl, Alt or Shift on a character, which Windows only honors on virtual keys.',
        ]);
        expect(() => keysReader.parse(Uint8Array.of(1, 2), { name: null, names: [] })).toThrow('This isn’t a table of shortcut keys');
    });

    it('names what each key does, from the program’s menus', () => {
        // A menu with &Open (command 100), and Ctrl+O sending command 100.
        const menu = [...u16(0), ...u16(0), ...u16(0x90), ...wide('&File'), ...u16(0x80), ...u16(100), ...wide('&Open\tCtrl+O')];
        const file = resourceFile([
            { type: 4, id: 1, name: '#1', lang: 0x409, data: Uint8Array.from(menu) },
            { type: 9, id: 1, name: '#1', lang: 0x409, data: Uint8Array.from(entry32(0x89, 0x4f, 100)) },
        ]);
        const r = res.parse(file, { name: 'app.res', names: [] }) as Parsed;
        expect(r.warnings).toEqual([]);
        const p = r.preview!;
        const keys = p.kind === 'stack' ? p.items.find((i) => i.title.startsWith('Shortcut keys'))?.preview : undefined;
        expect(keys?.kind === 'table' && keys.rows).toEqual([{ group: 'Shortcut keys #1', cells: { keys: 'Ctrl+O', id: '100', does: 'Open' } }]);
    });
});

const CNC = gameDir('cncRemastered');
describe.skipIf(!CNC)('InstallShield’s installer in Counterstrike’s INTERNET folder', () => {
    it('has F1, F3, F6 and Ctrl+Shift+V, and opens them when saved', async () => {
        // _INST32I.EX_ (an InstallShield archive) › install.exe › its shortcut keys.
        const archive = await inspect(new Uint8Array(readFileSync(join(CNC!, 'RED_ALERT/COUNTERSTRIKE/INTERNET/_INST32I.EX_'))), { name: '_INST32I.EX_', names: [] });
        const exe = archive.parsed.entries!.find((e) => (e.name ?? e.label).toLowerCase() === 'install.exe')!;
        const program = await inspect(exe.data, { name: 'install.exe', names: [] });
        const keys = program.parsed.entries!.find((e) => e.label === 'Shortcut keys #10000.bin')!;
        expect(keys.format).toBe('win-accelerators');
        const opened = await inspect(keys.data, { name: null, names: [] }, { hint: keys.format, shownName: keys.label });
        expect(opened.parsed.warnings).toEqual([]);
        expect(opened.parsed.summary).toEqual([['Keys', 'F1, F3, F6, Ctrl+Shift+V']]);
    });
});
