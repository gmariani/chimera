import { describe, expect, it } from 'vitest';
import type { Parsed } from '../core/types';
import { inspect } from './inspect';
import dialogReader from './resources/dialog';
import messagesReader from './resources/messages';
import stringsReader from './resources/strings';
import { readDialog } from './win-dialogs';

const u16 = (v: number) => [v & 0xff, (v >> 8) & 0xff];
const u32 = (v: number) => [...u16(v & 0xffff), ...u16(v >>> 16)];
const wide = (s: string) => [...[...s].flatMap((c) => u16(c.charCodeAt(0))), 0, 0];
const narrow = (s: string) => [...[...s].map((c) => c.charCodeAt(0)), 0];
const pad4 = (b: number[]) => [...b, ...new Array((4 - (b.length % 4)) % 4).fill(0)];

const WS_VISIBLE = 0x10000000;
const CAPTION = 0x00c00000;
const DS_SETFONT = 0x40;

interface Item {
    style: number;
    x: number;
    y: number;
    w: number;
    h: number;
    id: number;
    cls: number;
    text: string | number;
}
const items: Item[] = [
    { style: WS_VISIBLE | 1, x: 10, y: 50, w: 50, h: 14, id: 1, cls: 0x80, text: '&OK' },
    { style: WS_VISIBLE, x: 10, y: 10, w: 100, h: 8, id: -1 & 0xffff, cls: 0x82, text: 'Name:' },
    { style: 0, x: 10, y: 20, w: 100, h: 12, id: 100, cls: 0x81, text: '' },
    { style: WS_VISIBLE | 3, x: 120, y: 10, w: 20, h: 20, id: 101, cls: 0x82, text: 7 },
];

/** A 32-bit dialog as a resource compiler writes it (DLGTEMPLATE), or with `extended`, DLGTEMPLATEEX. */
function dialog32(extended = false, list = items): Uint8Array {
    const style = WS_VISIBLE | CAPTION | DS_SETFONT;
    let out = extended
        ? [...u16(1), ...u16(0xffff), ...u32(0), ...u32(0), ...u32(style), ...u16(list.length), ...u16(0), ...u16(0), ...u16(200), ...u16(80)]
        : [...u32(style), ...u32(0), ...u16(list.length), ...u16(0), ...u16(0), ...u16(200), ...u16(80)];
    out.push(...u16(0), ...u16(0), ...wide('Settings'), ...u16(8));
    if (extended) out.push(...u16(400), 0, 1);
    out.push(...wide('MS Shell Dlg'));
    for (const it of list) {
        out = pad4(out);
        const text = typeof it.text === 'number' ? [...u16(0xffff), ...u16(it.text)] : wide(it.text);
        const place = [...u16(it.x), ...u16(it.y), ...u16(it.w), ...u16(it.h)];
        if (extended) out.push(...u32(0), ...u32(0), ...u32(it.style), ...place, ...u32(it.id), ...u16(0xffff), ...u16(it.cls), ...text, ...u16(0));
        else out.push(...u32(it.style), ...u32(0), ...place, ...u16(it.id), ...u16(0xffff), ...u16(it.cls), ...text, ...u16(0));
    }
    return Uint8Array.from(out);
}

/** A 16-bit dialog: packed, a byte for the count and each class, text in the code page. */
function dialog16(): Uint8Array {
    const out = [...u32(WS_VISIBLE | CAPTION | DS_SETFONT), items.length, ...u16(0), ...u16(0), ...u16(200), ...u16(80), 0, 0, ...narrow('Settings'), ...u16(8), ...narrow('MS Sans Serif')];
    for (const it of items) {
        const text = typeof it.text === 'number' ? [0xff, ...u16(it.text)] : narrow(it.text);
        out.push(...u16(it.x), ...u16(it.y), ...u16(it.w), ...u16(it.h), ...u16(it.id), ...u32(it.style), it.cls, ...text, 0);
    }
    return Uint8Array.from(out);
}

const expected = [
    ['default-button', '&OK', 1, false],
    ['text', 'Name:', 0xffff, false],
    ['edit', '', 100, true],
    ['image', 'Icon #7', 101, false],
];

describe('Windows dialogs', () => {
    it('reads every layout: 32-bit, 32-bit extended and 16-bit, marking every byte', () => {
        for (const [data, isWide, layout] of [
            [dialog32(), true, '32-bit'],
            [dialog32(true), true, '32-bit, extended'],
            [dialog16(), false, '16-bit'],
        ] as const) {
            const d = readDialog(data, 0, data.length, isWide)!;
            expect(d.problems, layout).toEqual([]);
            expect(d.layout).toBe(layout);
            expect(d.end, layout).toBe(data.length);
            expect(
                d.fields.reduce((n, f) => n + f.length, 0),
                layout
            ).toBe(data.length);
            expect([d.preview.title, d.preview.caption, d.preview.width, d.preview.height], layout).toEqual(['Settings', true, 200, 80]);
            expect(
                d.preview.controls.map((c) => [c.kind, c.text, c.id, !!c.hidden]),
                layout
            ).toEqual(expected);
            expect(d.preview.controls[0]).toMatchObject({ x: 10, y: 50, width: 50, height: 14, className: 'Button' });
        }
        // 8-point MS Sans Serif or Tahoma: 6 × 13 pixels, so a dialog unit is 1.5 × 1.625.
        expect(readDialog(dialog32(), 0, 999, true)!.preview.units).toEqual([1.5, 1.625]);
    });

    it('draws the pictures it names from the program', () => {
        const picture = { width: 1, height: 1, rgba: Uint8Array.of(1, 2, 3, 255) };
        const asked: [string, number | string][] = [];
        const d = readDialog(dialog32(), 0, 9999, true, (kind, ref) => (asked.push([kind, ref]), picture))!;
        expect(asked).toEqual([['icon', 7]]);
        expect(d.preview.controls[3].picture).toBe(picture);
    });

    it('says what doesn’t fit', () => {
        const many = dialog32();
        many[8] = 200;
        expect(readDialog(many, 0, many.length, true)!.problems).toEqual(['The dialog says it has 200 controls, more than its 192 bytes can hold.']);
        const cut = dialog32();
        expect(readDialog(cut, 0, cut.length - 6, true)!.problems).toEqual(['The dialog runs past the end of its resource: what’s past it wasn’t read.']);
        expect(readDialog(cut, 0, 10, true)).toBeNull();
    });

    it('opens what a module says is a dialog, a string table or a message table, and refuses what isn’t', async () => {
        const data = dialog16();
        // Nothing about its bytes says it's a dialog: only the module it came from can.
        expect((await inspect(data, { name: null, names: [] }, { shownName: 'Dialog #100.bin' })).format.id).toBe('raw');
        const opened = await inspect(data, { name: null, names: [] }, { hint: 'win-dialog-16', shownName: 'Dialog #100.bin' });
        expect(opened.format.id).toBe('win-dialog-16');
        expect(opened.parsed.summary).toContainEqual(['Controls', '1 Button, 2 Static, 1 Edit']);
        expect(() => dialogReader.parse(Uint8Array.of(1, 2, 3), { name: null, names: [] })).toThrow('This isn’t a dialog: it’s too short for a dialog’s header.');

        // A string table's IDs come from its resource number, in the name it's shown under.
        const strings = Uint8Array.from([...u16(2), ...wide('Hi').slice(0, 4), ...new Array(30).fill(0)]);
        const read = stringsReader.parse(strings, { name: null, names: [], label: 'String table #3.bin' }) as Parsed;
        expect(read.preview).toMatchObject({ rows: [{ cells: { id: '32', text: 'Hi' } }] });
        expect(read.warnings).toEqual([]);
        expect(() => stringsReader.parse(Uint8Array.of(1, 2, 3, 4), { name: null, names: [] })).toThrow('This isn’t a string table');
        expect(() => messagesReader.parse(Uint8Array.of(0, 0, 0, 0), { name: null, names: [] })).toThrow('This isn’t a message table: it has no messages.');
    });
});
