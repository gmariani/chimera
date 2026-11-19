import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Parsed } from '../core/types';
import { gameFile } from '../testing/game-data';
import { inspect } from './inspect';
import pe from './pe';
import menuReader from './resources/menu';
import { readMenu } from './win-menus';

const u16 = (v: number) => [v & 0xff, (v >> 8) & 0xff];
const u32 = (v: number) => [...u16(v & 0xffff), ...u16(v >>> 16)];
const narrow = (s: string) => [...[...s].map((c) => c.charCodeAt(0)), 0];
const wide = (s: string) => [...[...s].flatMap((c) => u16(c.charCodeAt(0))), 0, 0];
const pad4 = (b: number[]) => [...b, ...new Array((4 - (b.length % 4)) % 4).fill(0)];

/**
 * A 16-bit classic menu, as Raymond Chen's example lays one out: &File (Open, a separator in the all-zeros form, a
 * grayed Exit, the last), then &View, the last at the top, opening a submenu of one checked item.
 */
const classic16 = Uint8Array.from([
    ...u16(0),
    ...u16(0),
    ...u16(0x10),
    ...narrow('&File'),
    ...u16(0),
    ...u16(100),
    ...narrow('&Open\tCtrl+O'),
    ...u16(0),
    ...u16(0),
    0,
    ...u16(0x81),
    ...u16(101),
    ...narrow('E&xit'),
    ...u16(0x90),
    ...narrow('&View'),
    ...u16(0x88),
    ...u16(200),
    ...narrow('&Status Bar'),
]);

/** A 32-bit extended menu: its help ID, then &File, the last at the top, opening a submenu (with its own help ID) of Open. */
const extended32 = Uint8Array.from([
    ...u16(1),
    ...u16(4),
    ...u32(0),
    ...pad4([...u32(0), ...u32(0), ...u32(0), ...u16(0x81), ...wide('&File')]),
    ...u32(0),
    ...pad4([...u32(0), ...u32(8), ...u32(100), ...u16(0x80), ...wide('&Open')]),
]);

describe('Windows menus', () => {
    it('reads a 16-bit classic menu: submenus, IDs, a separator, how items are marked', () => {
        const m = readMenu(classic16, 0, classic16.length, false);
        expect(m.problems).toEqual([]);
        expect(m.end).toBe(classic16.length);
        expect(m.text).toBe(['File', '    Open    Ctrl+O    [100]', '    ────────', '    Exit    [101] (grayed)', 'View', '    Status Bar    [200] (checked)'].join('\n'));
        expect(m.fields.reduce((n, f) => n + f.length, 0)).toBe(classic16.length);
    });

    it('reads a 32-bit extended menu, with its help IDs', () => {
        const m = readMenu(extended32, 0, extended32.length, true);
        expect(m.problems).toEqual([]);
        expect(m.extended).toBe(true);
        expect(m.text).toBe('File\n    Open    [100] (checked)');
        expect(m.fields.filter((f) => f.name === 'Help ID')).toHaveLength(2);
    });

    it('says what doesn’t fit, and refuses what isn’t one', () => {
        expect(readMenu(classic16, 0, classic16.length - 6, false).problems).toEqual(['The menu runs past the end of its resource before its last item: what’s past it wasn’t read.']);
        const odd = classic16.slice();
        odd[0] = 7;
        expect(readMenu(odd, 0, odd.length, false).problems).toContain('The menu says it’s version 7: Windows knows 0 (classic) and 1 (extended).');
        expect(() => menuReader.parse(Uint8Array.of(0, 0, 0), { name: null, names: [] })).toThrow('This isn’t a menu');
    });
});

const game = gameFile('tiberianSun', 'Game.exe');
describe.skipIf(!game)('Tiberian Sun’s Game.exe', () => {
    it('has a menu of screen sizes, which opens on its own when saved', async () => {
        const r = pe.parse(new Uint8Array(readFileSync(game!)), { name: 'Game.exe', names: [] }) as Parsed;
        const entry = r.entries!.find((e) => e.label === 'Menu #160.bin')!;
        expect(entry.format).toBe('win-menu');
        const opened = await inspect(entry.data, { name: null, names: [] }, { hint: entry.format, shownName: entry.label });
        expect(opened.format.id).toBe('win-menu');
        expect(opened.parsed.warnings).toEqual([]);
        const p = opened.parsed.preview!;
        expect(p.kind === 'text' && p.text).toBe(
            ['Mode', '    640 x 400    [40309] (checked)', '    640 x 480    [40304]', '    800 x 600    [40305]', '    1024 x 768    [40306]', '    1280 x 1024    [40307]', '    ────────'].join('\n')
        );
    });
});
