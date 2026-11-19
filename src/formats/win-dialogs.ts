import { Bytes, bytesLabel, field, fillGaps } from '../core/bytes';
import { decodeDib } from './dib';
import type { DialogControl, DialogControlKind, Field, Preview } from '../core/types';

/**
 * Dialog box resources: a template Windows builds a dialog from. A header (its style, how many controls, its place
 * and size, then its menu, window class and title, and with DS_SETFONT its font), then a template for each control
 * (its style, place and size, ID, window class, text, and creation data for the control's own use). Places and sizes
 * are in dialog units: a quarter of the font's average character width across, an eighth of its height down.
 *
 * There are four layouts. 32-bit programs (PE) use DLGTEMPLATE and DLGITEMTEMPLATE, with UTF-16 strings and each
 * control on a 4-byte boundary, or the extended DLGTEMPLATEEX and DLGITEMTEMPLATEEX (which start 1, 0xFFFF and add
 * help IDs and a fuller font): Microsoft's pages for each (https://learn.microsoft.com/windows/win32/api/winuser/ns-winuser-dlgtemplate,
 * https://learn.microsoft.com/windows/win32/dlgbox/dlgtemplateex and the item pages beside them). 16-bit modules (NE)
 * use the same, packed with no alignment, a byte for the count, and text in the code page, as Raymond Chen's "The
 * evolution of dialog templates" describes them (The Old New Thing, 2004:
 * https://devblogs.microsoft.com/oldnewthing/20040618-00/?p=38803 for 16-bit, ?p=38773 for 16-bit extended,
 * https://devblogs.microsoft.com/oldnewthing/20040621-00/?p=38793 for 32-bit; facts only).
 */

/** The window classes Windows predefines, by the ordinals templates use for them. */
const CLASSES: Record<number, string> = { 0x80: 'Button', 0x81: 'Edit', 0x82: 'Static', 0x83: 'ListBox', 0x84: 'ScrollBar', 0x85: 'ComboBox' };

const WS_VISIBLE = 0x10000000;
const WS_DISABLED = 0x08000000;
const WS_CAPTION = 0x00c00000;
const DS_SETFONT = 0x40;

/** The window styles worth saying, in words. */
const WINDOW_STYLES: [number, string][] = [
    [0x80000000, 'pop-up'],
    [0x40000000, 'child'],
    [WS_VISIBLE, 'visible'],
    [WS_DISABLED, 'disabled'],
    [0x00800000, 'border'],
    [0x00400000, 'dialog frame'],
    [0x00200000, 'vertical scroll bar'],
    [0x00100000, 'horizontal scroll bar'],
    [0x00080000, 'window menu'],
    [0x00040000, 'resizable'],
    [0x00020000, 'starts a group'],
    [0x00010000, 'tab stop'],
];
const DIALOG_STYLES: [number, string][] = [
    [0x01, 'absolute position'],
    [0x02, 'system modal'],
    [0x40, 'own font'],
    [0x80, 'modal frame'],
    [0x400, 'no idle messages'],
    [0x800, 'centered'],
    [0x2000, 'control'],
];

const words = (value: number, names: [number, string][]) =>
    names
        .filter(([bit]) => (value & bit) === bit)
        .map(([, w]) => w)
        .join(', ') || 'none';

/** What a control is, by its class and style. */
function kindOf(className: string, style: number): { kind: DialogControlKind; align?: 'left' | 'center' | 'right'; what: string } {
    const cls = className.toLowerCase();
    if (cls === 'button') {
        const t = style & 0xf;
        if (t === 1) return { kind: 'default-button', what: 'default button' };
        if (t === 2 || t === 3 || t === 5 || t === 6) return { kind: 'checkbox', what: t >= 5 ? 'three-state check box' : 'check box' };
        if (t === 4 || t === 9) return { kind: 'radio', what: 'radio button' };
        if (t === 7) return { kind: 'group', what: 'group box' };
        if (t === 0xb) return { kind: 'custom', what: 'button the program draws itself' };
        return { kind: 'button', what: 'button' };
    }
    if (cls === 'edit' || cls.startsWith('richedit')) return { kind: 'edit', what: style & 4 ? 'text box, several lines' : 'text box' };
    if (cls === 'static') {
        const t = style & 0x1f;
        if (t === 1) return { kind: 'text', align: 'center', what: 'text' };
        if (t === 2) return { kind: 'text', align: 'right', what: 'text' };
        if (t === 3) return { kind: 'image', what: 'icon' };
        if (t === 0xe) return { kind: 'image', what: 'bitmap' };
        if (t === 0xf) return { kind: 'image', what: 'metafile' };
        if (t >= 4 && t <= 6) return { kind: 'rect', what: 'filled rectangle' };
        if ((t >= 7 && t <= 9) || t === 0x12) return { kind: 'frame', what: 'frame' };
        if (t === 0x10 || t === 0x11) return { kind: 'line', what: 'line' };
        if (t === 0xd) return { kind: 'custom', what: 'drawn by the program' };
        return { kind: 'text', align: 'left', what: 'text' };
    }
    if (cls === 'listbox') return { kind: 'list', what: 'list' };
    if (cls === 'combobox') return { kind: 'combo', what: (style & 3) === 1 ? 'list with a text box' : 'drop-down list' };
    if (cls === 'scrollbar') return { kind: 'scrollbar', what: 'scroll bar' };
    return { kind: 'custom', what: `a ${className} control` };
}

/** A picture an image control names (an icon group or a bitmap, by number or name), as drawn, if the program has it. */
export type FindPicture = (kind: 'icon' | 'bitmap', ref: number | string) => { width: number; height: number; rgba: Uint8Array } | null;

export interface Dialog {
    preview: Extract<Preview, { kind: 'dialog' }>;
    fields: Field[];
    /** How it's laid out, in words: "32-bit, extended". */
    layout: string;
    /** Where it ends. */
    end: number;
    /** The icons and bitmaps its image controls name. */
    pictures: { kind: 'icon' | 'bitmap'; ref: number | string }[];
    problems: string[];
}

/**
 * Reads a dialog template at `at`, at most `length` bytes; `wide` for a 32-bit program's (UTF-16, aligned), otherwise a
 * 16-bit module's. `find` gives the pictures its image controls name. Null when it's too short for even its header.
 */
export function readDialog(data: Uint8Array, at: number, length: number, wide: boolean, find?: FindPicture): Dialog | null {
    const b = new Bytes(data);
    const end = Math.min(data.length, at + length);
    const problems: string[] = [];
    const extended = b.u16(at) === 1 && b.u16(at + 2) === 0xffff;
    const align = (p: number, to: number) => at + Math.ceil((p - at) / to) * to;
    const header = wide ? (extended ? 26 : 18) : extended ? 25 : 13;
    if (at + header > end) return null;
    let cut = false;

    /** Text to its terminator, within the template. */
    const text = (p: number): { text: string; next: number } => {
        let s = '';
        if (wide) {
            for (; p + 2 <= end && b.u16(p); p += 2) s += String.fromCharCode(b.u16(p));
            if (p + 2 > end) cut = true;
            return { text: s, next: Math.min(end, p + 2) };
        }
        for (; p < end && data[p]; p++) s += String.fromCharCode(data[p]);
        if (p >= end) cut = true;
        return { text: s, next: Math.min(end, p + 1) };
    };
    /** A name or a number: 0xFFFF (32-bit) or 0xFF (16-bit), then the number; otherwise text. `bare` takes 16-bit's one-byte classes. */
    const nameOrNumber = (p: number, bare = false): { value: number | string; next: number } => {
        if (wide) {
            if (b.u16(p) === 0xffff) return { value: b.u16(p + 2), next: p + 4 };
            const t = text(p);
            return { value: t.text, next: t.next };
        }
        if (bare && data[p] >= 0x80) return { value: data[p], next: p + 1 };
        if (data[p] === 0xff) return { value: b.u16(p + 1), next: p + 3 };
        const t = text(p);
        return { value: t.text, next: t.next };
    };
    const shown = (v: number | string) => (typeof v === 'number' ? `#${v}` : v ? `"${v}"` : 'none');

    // The header.
    const head: Field[] = [];
    let style: number, count: number, p: number;
    if (extended) {
        style = b.u32(at + 12);
        head.push(
            field('Layout version', at, 2, 1),
            field('Extended', at + 2, 2, '0xFFFF', 'Marks the extended layout.'),
            field('Help ID', at + 4, 4, b.u32(at + 4)),
            field(
                'Extended style',
                at + 8,
                4,
                `0x${b
                    .u32(at + 8)
                    .toString(16)
                    .toUpperCase()}`
            )
        );
        head.push(field('Style', at + 12, 4, `${words(style, WINDOW_STYLES)}; ${words(style, DIALOG_STYLES)}`));
        count = wide ? b.u16(at + 16) : data[at + 16];
        p = at + (wide ? 18 : 17);
        head.push(field('Controls', at + 16, wide ? 2 : 1, count));
    } else if (wide) {
        style = b.u32(at);
        head.push(
            field('Style', at, 4, `${words(style, WINDOW_STYLES)}; ${words(style, DIALOG_STYLES)}`),
            field(
                'Extended style',
                at + 4,
                4,
                `0x${b
                    .u32(at + 4)
                    .toString(16)
                    .toUpperCase()}`
            )
        );
        count = b.u16(at + 8);
        head.push(field('Controls', at + 8, 2, count));
        p = at + 10;
    } else {
        style = b.u32(at);
        head.push(field('Style', at, 4, `${words(style, WINDOW_STYLES)}; ${words(style, DIALOG_STYLES)}`));
        count = data[at + 4];
        head.push(field('Controls', at + 4, 1, count));
        p = at + 5;
    }
    const i16 = (q: number) => (b.u16(q) << 16) >> 16;
    const [x, y, cx, cy] = [i16(p), i16(p + 2), i16(p + 4), i16(p + 6)];
    head.push(field('Place', p, 4, `${x}, ${y}`, 'In dialog units, from its owner’s top left (or the screen’s).'), field('Size', p + 4, 4, `${cx} × ${cy}`, 'In dialog units.'));
    p += 8;
    const menu = nameOrNumber(p);
    head.push(field('Menu', p, menu.next - p, shown(menu.value)));
    p = menu.next;
    if (wide) p = align(p, 2);
    const cls = nameOrNumber(p);
    head.push(field('Window class', p, cls.next - p, cls.value === '' ? 'the usual one for dialogs' : shown(cls.value)));
    p = cls.next;
    if (wide) p = align(p, 2);
    const title = text(p);
    head.push(field('Title', p, title.next - p, title.text || '(none)'));
    p = title.next;
    let font = { name: '', size: 0 };
    // DS_SHELLFONT includes DS_SETFONT's bit.
    if (style & DS_SETFONT) {
        if (wide) p = align(p, 2);
        const size = b.u16(p);
        const fontAt = p;
        p += extended ? 6 : 2;
        const name = text(p);
        font = { name: name.text, size };
        head.push(
            field('Font', fontAt, name.next - fontAt, `${name.text}, ${size} point`, extended ? 'Its size, weight, whether it’s italic, its character set, and its name.' : 'Its size and name.')
        );
        p = name.next;
    }
    const fields: Field[] = [{ ...field('Header', at, p - at, title.text || 'no title'), children: fillGaps(data, head, at, p, 'Not read') }];

    // Each control. The smallest is 24 bytes (32-bit), 14 (16-bit), so the count can't ask for more than fit.
    const smallest = wide ? (extended ? 28 : 24) : extended ? 30 : 14;
    const fitting = Math.max(0, Math.floor((end - p) / smallest) + 1);
    if (count > fitting) problems.push(`The dialog says it has ${count.toLocaleString('en-US')} controls, more than its ${bytesLabel(length)} can hold.`);
    const controls: DialogControl[] = [];
    const pictures: { kind: 'icon' | 'bitmap'; ref: number | string }[] = [];
    for (let i = 0; i < Math.min(count, fitting); i++) {
        if (wide) p = align(p, 4);
        if (p + (wide ? 18 : 13) > end) {
            cut = true;
            break;
        }
        const from = p;
        const parts: Field[] = [];
        let cStyle: number, id: number;
        let place: number;
        if (wide && extended) {
            parts.push(
                field('Help ID', p, 4, b.u32(p)),
                field(
                    'Extended style',
                    p + 4,
                    4,
                    `0x${b
                        .u32(p + 4)
                        .toString(16)
                        .toUpperCase()}`
                )
            );
            cStyle = b.u32(p + 8);
            parts.push(field('Style', p + 8, 4, words(cStyle, WINDOW_STYLES)));
            place = p + 12;
            id = b.u32(p + 20);
            parts.push(field('ID', p + 20, 4, id));
            p += 24;
        } else if (wide) {
            cStyle = b.u32(p);
            parts.push(
                field('Style', p, 4, words(cStyle, WINDOW_STYLES)),
                field(
                    'Extended style',
                    p + 4,
                    4,
                    `0x${b
                        .u32(p + 4)
                        .toString(16)
                        .toUpperCase()}`
                )
            );
            place = p + 8;
            id = b.u16(p + 16);
            parts.push(field('ID', p + 16, 2, id));
            p += 18;
        } else if (extended) {
            parts.push(
                field('Help ID', p, 4, b.u32(p)),
                field(
                    'Extended style',
                    p + 4,
                    4,
                    `0x${b
                        .u32(p + 4)
                        .toString(16)
                        .toUpperCase()}`
                )
            );
            cStyle = b.u32(p + 8);
            parts.push(field('Style', p + 8, 4, words(cStyle, WINDOW_STYLES)));
            place = p + 12;
            id = b.u32(p + 20);
            parts.push(field('ID', p + 20, 4, id));
            p += 24;
        } else {
            place = p;
            id = b.u16(p + 8);
            cStyle = b.u32(p + 10);
            parts.push(field('ID', p + 8, 2, id), field('Style', p + 10, 4, words(cStyle, WINDOW_STYLES)));
            p += 14;
        }
        const [ix, iy, iw, ih] = [i16(place), i16(place + 2), i16(place + 4), i16(place + 6)];
        parts.push(field('Place', place, 4, `${ix}, ${iy}`), field('Size', place + 4, 4, `${iw} × ${ih}`));
        if (wide) p = align(p, 2);
        const c = nameOrNumber(p, true);
        const className = typeof c.value === 'number' ? (CLASSES[c.value] ?? `class #${c.value}`) : c.value;
        parts.push(field('Window class', p, c.next - p, className));
        p = c.next;
        if (wide) p = align(p, 2);
        const t = nameOrNumber(p);
        parts.push(field('Text', p, t.next - p, typeof t.value === 'number' ? `#${t.value}` : t.value));
        p = t.next;
        // Creation data: a count (a byte for 16-bit classic, a word otherwise), then that many bytes, on a word boundary for 32-bit.
        const extraAt = p;
        const extra = wide || extended ? b.u16(p) : data[p];
        p += wide || extended ? 2 : 1;
        if (extra && wide) p = align(p, 2);
        if (p + extra > end) cut = true;
        p = Math.min(end, p + extra);
        parts.push(field('Creation data', extraAt, p - extraAt, extra ? bytesLabel(extra) : 'none', 'For the control’s own use.'));

        const { kind, align: textAlign, what } = kindOf(className, cStyle);
        // A drop-down list's height is how far its list drops; closed, it's a line of text tall.
        const shownHeight = kind === 'combo' && (cStyle & 3) !== 1 ? Math.min(ih, 14) : ih;
        const control: DialogControl = {
            kind,
            x: ix,
            y: iy,
            width: iw,
            height: shownHeight,
            text: typeof t.value === 'string' ? t.value : '',
            id,
            className,
            ...(textAlign ? { align: textAlign } : {}),
        };
        if (!(cStyle & WS_VISIBLE)) control.hidden = true;
        if (cStyle & WS_DISABLED) control.disabled = true;
        if (kind === 'image') {
            const ref = t.value;
            if (ref !== '' && what !== 'metafile') pictures.push({ kind: what === 'icon' ? 'icon' : 'bitmap', ref });
            const picture = ref !== '' && what !== 'metafile' && find ? find(what === 'icon' ? 'icon' : 'bitmap', ref) : null;
            if (picture) control.picture = picture;
            else control.text = `${what[0].toUpperCase()}${what.slice(1)} ${ref === '' ? 'the program sets itself' : shown(ref)}`;
        }
        controls.push(control);
        const label = control.text && kind !== 'image' ? ` "${control.text.replace(/&(.)/g, '$1')}"` : '';
        fields.push({
            ...field(`Control ${i + 1}`, from, p - from, `${what[0].toUpperCase()}${what.slice(1)}${label}, ID ${id}`, control.hidden ? 'Hidden until the program shows it.' : undefined),
            children: fillGaps(data, parts, from, p, 'Not read'),
        });
    }
    // (A count past what fits has already been said: running out is then expected.)
    if (cut && count <= fitting) problems.push('The dialog runs past the end of its resource: what’s past it wasn’t read.');

    // Dialog units to pixels: a quarter of the font's average character width, an eighth of its height. Windows measures
    // the font; this takes the sizes MS Sans Serif and Tahoma have at 96 dots an inch (6 × 13 pixels at 8 points), and
    // the system font's 8 × 16 for a dialog with no font of its own.
    const tall = font.size ? Math.round(((font.size * 96) / 72) * 1.22) : 16;
    const across = font.size ? Math.round((tall * 6) / 13) : 8;
    return {
        preview: { kind: 'dialog', title: title.text, caption: (style & WS_CAPTION) === WS_CAPTION, width: cx, height: cy, units: [across / 4, tall / 8], font, controls },
        fields: fillGaps(data, fields, at, p, 'Not read'),
        layout: `${wide ? '32-bit' : '16-bit'}${extended ? ', extended' : ''}`,
        end: p,
        pictures,
        problems,
    };
}

/**
 * The pictures a module's dialogs can show, from its resources: an icon group's image nearest 32 × 32 (as Windows
 * shows an icon control), or a bitmap. Resources are matched by number, or by name without regard to case.
 */
export function pictureFinder(data: Uint8Array, resources: { type: number; id: number; name: string; at: number; length: number }[]): FindPicture {
    const b = new Bytes(data);
    const named = (type: number, ref: number | string) => resources.find((r) => r.type === type && (typeof ref === 'number' ? r.id === ref : r.id < 0 && r.name.toUpperCase() === ref.toUpperCase()));
    return (kind, ref) => {
        if (kind === 'bitmap') {
            const r = named(2, ref);
            const dib = r && decodeDib(data, r.at, r.length, false);
            return dib && 'rgba' in dib ? { width: dib.info.width, height: dib.info.height, rgba: dib.rgba } : null;
        }
        const group = named(14, ref);
        if (!group || group.at + 6 > data.length) return null;
        // The group's images: 14 bytes each after its 6-byte header, the width first (0 for 256) and the icon's ID last.
        const count = Math.min(b.u16(group.at + 4), Math.floor((Math.min(group.length, data.length - group.at) - 6) / 14));
        const images = Array.from({ length: Math.max(0, count) }, (_, i) => {
            const e = group.at + 6 + i * 14;
            return { width: data[e] || 256, bits: b.u16(e + 6), id: b.u16(e + 12) };
        }).sort((x, y) => Math.abs(x.width - 32) - Math.abs(y.width - 32) || y.bits - x.bits);
        for (const image of images) {
            const icon = named(3, image.id);
            const dib = icon && decodeDib(data, icon.at, icon.length, true);
            if (dib && 'rgba' in dib) return { width: dib.info.width, height: dib.info.height, rgba: dib.rgba };
        }
        return null;
    };
}
