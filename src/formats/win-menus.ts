import { Bytes, bytesLabel, field } from '../core/bytes';
import type { Field } from '../core/types';

/**
 * Menu resources: a program's menu bar, or a menu it pops up, as a template Windows builds the menu from.
 *
 * - Classic menus: a header (version 0, then how many more header bytes), then the items. An item is its flags, its ID
 *   (unless it opens a submenu) and its text; a submenu's items follow the item that opens it, and the item flagged as
 *   the last ends each level. Text is UTF-16 in a 32-bit program's, in the code page in a 16-bit module's.
 * - Extended menus (version 1): the header's second word is its size (4); each level starts with a help ID,
 *   and each item is its type, state and ID (4 bytes each), a word of flags (0x01: opens a submenu; 0x80: the last),
 *   and its text, each item on a 4-byte boundary (32-bit only).
 *
 * See Raymond Chen's "The evolution of menu templates" (The Old New Thing, 2008:
 * https://devblogs.microsoft.com/oldnewthing/20080709-00/?p=21693 for 16-bit classic menus, ?p=21653 for 32-bit,
 * 20080716-00/?p=21603 for 32-bit extended; facts only), which Tiberian Sun's menu agrees with, and the flags'
 * values from MENUITEMINFO (https://learn.microsoft.com/windows/win32/api/winuser/ns-winuser-menuiteminfoa).
 */

const CLASSIC_FLAGS: [number, string][] = [
    [0x0001, 'grayed'],
    [0x0002, 'disabled'],
    [0x0004, 'a picture'],
    [0x0008, 'checked'],
    [0x0020, 'starts a column, with a line'],
    [0x0040, 'starts a column'],
    [0x0100, 'drawn by the program'],
    [0x0800, 'a separator'],
    [0x4000, 'on the right'],
];
const TYPES: [number, string][] = [
    [0x0004, 'a picture'],
    [0x0020, 'starts a column, with a line'],
    [0x0040, 'starts a column'],
    [0x0100, 'drawn by the program'],
    [0x0200, 'a round check mark'],
    [0x0800, 'a separator'],
    [0x2000, 'right to left'],
    [0x4000, 'on the right'],
];
const STATES: [number, string][] = [
    [0x0003, 'grayed'],
    [0x0008, 'checked'],
    [0x0080, 'highlighted'],
    [0x1000, 'the default'],
];

const words = (value: number, names: [number, string][]) =>
    names
        .filter(([bit]) => (value & bit) === bit)
        .map(([, w]) => w)
        .join(', ');

export interface MenuItem {
    text: string;
    id: number | null;
    /** What's said of it: checked, grayed, a separator. */
    marks: string;
    separator: boolean;
    items?: MenuItem[];
}

export interface Menu {
    items: MenuItem[];
    extended: boolean;
    fields: Field[];
    /** The menu as indented lines, for showing. */
    text: string;
    end: number;
    problems: string[];
}

/** Reads a menu template at `at`, at most `length` bytes; `wide` for a 32-bit program's, otherwise a 16-bit module's. */
export function readMenu(data: Uint8Array, at: number, length: number, wide: boolean): Menu {
    const b = new Bytes(data);
    const end = Math.min(data.length, at + length);
    const problems: string[] = [];
    const fields: Field[] = [];
    const version = b.u16(at);
    const extended = version === 1;
    let cut = false;
    let deep = false;
    const text = (p: number) => {
        let s = '';
        if (wide) for (; p + 2 <= end && b.u16(p); p += 2) s += String.fromCharCode(b.u16(p));
        else for (; p < end && data[p]; p++) s += String.fromCharCode(data[p]);
        if (p + (wide ? 2 : 1) > end) cut = true;
        return { text: s, next: Math.min(end, p + (wide ? 2 : 1)) };
    };
    const align4 = (p: number) => (wide ? at + Math.ceil((p - at) / 4) * 4 : p);
    let count = 0;
    // A level's items, to the one flagged as the last; a submenu's follow the item that opens it. Each item takes 4
    // bytes at least, so there can't be more than fit, and levels go only so deep.
    const level = (p: number, depth: number): { items: MenuItem[]; next: number } => {
        const items: MenuItem[] = [];
        if (extended) {
            p = align4(p);
            if (p + 4 > end) return { items, next: p };
            fields.push(field('Help ID', p, 4, b.u32(p), 'For this level of the menu.'));
            p += 4;
        }
        while (p < end && count < length) {
            if (extended) p = align4(p);
            const from = p;
            let flags: number, id: number | null, marks: string, separator: boolean, popup: boolean, last: boolean;
            if (extended) {
                if (p + 14 > end) {
                    cut = true;
                    break;
                }
                const type = b.u32(p);
                const state = b.u32(p + 4);
                id = b.u32(p + 8);
                flags = b.u16(p + 12);
                popup = !!(flags & 0x01);
                last = !!(flags & 0x80);
                separator = !!(type & 0x800);
                marks = [words(type, TYPES), words(state, STATES)].filter(Boolean).join(', ');
                p += 14;
            } else {
                if (p + 2 > end) {
                    cut = true;
                    break;
                }
                flags = b.u16(p);
                popup = !!(flags & 0x10);
                last = !!(flags & 0x80);
                id = popup ? null : b.u16(p + 2);
                p += popup ? 2 : 4;
                marks = words(flags & ~0x90, CLASSIC_FLAGS);
                separator = false;
            }
            const t = text(p);
            p = t.next;
            // A separator, officially, has its flag; the other form is all zeros, with no text.
            if (!extended) separator = !!(flags & 0x800) || (!popup && id === 0 && !t.text);
            count++;
            const item: MenuItem = { text: t.text, id: popup && !extended ? null : id, marks, separator };
            fields.push(
                field(
                    separator ? 'Separator' : popup ? `Submenu "${t.text.replace(/&(.)/g, '$1')}"` : `"${t.text.replace(/&(.)/g, '$1')}"`,
                    from,
                    p - from,
                    [item.id !== null && !separator ? `ID ${item.id}` : '', marks, last ? 'the last at its level' : ''].filter(Boolean).join(', ') || undefined
                )
            );
            if (popup) {
                if (depth >= 16) {
                    deep = true;
                    break;
                }
                const sub = level(p, depth + 1);
                item.items = sub.items;
                p = sub.next;
            }
            items.push(item);
            if (last) return { items, next: p };
        }
        if (p >= end) cut = true;
        return { items, next: p };
    };

    let p: number;
    if (extended) {
        const offset = b.u16(at + 2);
        fields.push(field('Version', at, 2, '1: extended'), field('Header size', at + 2, 2, bytesLabel(offset), 'Where the menu starts, from here: 4, as Windows 95 needs it.'));
        if (offset > 4 && at + offset <= end) fields.push(field('More header', at + 4, offset - 4, bytesLabel(offset - 4)));
        p = at + Math.max(4, offset);
    } else {
        const extra = b.u16(at + 2);
        if (version !== 0) problems.push(`The menu says it’s version ${version}: Windows knows 0 (classic) and 1 (extended).`);
        fields.push(field('Version', at, 2, version === 0 ? '0: classic' : version), field('More header', at + 2, 2, bytesLabel(extra), 'Always 0 in practice.'));
        if (extra) fields.push(field('Header', at + 4, Math.min(extra, end - at - 4), bytesLabel(extra)));
        p = at + 4 + extra;
    }
    const { items, next } = level(p, 0);
    if (cut) problems.push('The menu runs past the end of its resource before its last item: what’s past it wasn’t read.');
    if (deep) problems.push('The menu nests deeper than any real one does: what’s below wasn’t read.');

    const lines: string[] = [];
    const show = (list: MenuItem[], indent: string) => {
        for (const it of list) {
            if (it.separator) lines.push(`${indent}────────`);
            else {
                const [label, keys] = it.text
                    .split('&&')
                    .map((part) => part.replace(/&/g, ''))
                    .join('&')
                    .split('\t');
                const marks = it.marks ? ` (${it.marks})` : '';
                lines.push(`${indent}${label}${keys ? `    ${keys}` : ''}${it.id !== null && !it.items ? `    [${it.id}]` : ''}${marks}`);
            }
            if (it.items) show(it.items, `${indent}    `);
        }
    };
    show(items, '');
    return { items, extended, fields, text: lines.join('\n'), end: Math.min(next, end), problems };
}
