import { Bytes, field } from '../core/bytes';
import type { Field } from '../core/types';

/**
 * Accelerator tables ("shortcut keys"): the keys a program's window answers, each sending a command (by its ID, as a
 * menu item would). Each entry is its flags (whether the key is a virtual key, or a character; Shift, Ctrl, Alt; 0x80
 * on the last), the key, and the command's ID: 8 bytes in a 32-bit program (a word of flags, the key, the ID, a word
 * of padding), 5 in a 16-bit module's (a byte of flags, then the key and the ID).
 *
 * See Microsoft's ACCELTABLEENTRY (https://learn.microsoft.com/windows/win32/menurc/acceltableentry), Raymond Chen's
 * "The format of accelerator table resources" (The Old New Thing, 2007,
 * https://devblogs.microsoft.com/oldnewthing/20070316-00/?p=27593; facts only) for the 16-bit form, and Microsoft's
 * "Virtual-Key Codes" (https://learn.microsoft.com/windows/win32/inputdev/virtual-key-codes) for the keys' names.
 */

/** Virtual keys' names, but for letters and digits, which are their own characters. */
const KEYS: Record<number, string> = {
    0x03: 'Break',
    0x08: 'Backspace',
    0x09: 'Tab',
    0x0c: 'Clear',
    0x0d: 'Enter',
    0x13: 'Pause',
    0x14: 'Caps Lock',
    0x1b: 'Esc',
    0x20: 'Space',
    0x21: 'Page Up',
    0x22: 'Page Down',
    0x23: 'End',
    0x24: 'Home',
    0x25: 'Left',
    0x26: 'Up',
    0x27: 'Right',
    0x28: 'Down',
    0x2c: 'Print Screen',
    0x2d: 'Insert',
    0x2e: 'Delete',
    0x2f: 'Help',
    0x5d: 'Menu',
    0x6a: 'Num *',
    0x6b: 'Num +',
    0x6c: 'Num Separator',
    0x6d: 'Num -',
    0x6e: 'Num .',
    0x6f: 'Num /',
    0x90: 'Num Lock',
    0x91: 'Scroll Lock',
    0xba: ';',
    0xbb: '=',
    0xbc: ',',
    0xbd: '-',
    0xbe: '.',
    0xbf: '/',
    0xc0: '`',
    0xdb: '[',
    0xdc: '\\',
    0xdd: ']',
    0xde: "'",
};

/** A virtual key in words. */
function keyName(key: number): string {
    if ((key >= 0x30 && key <= 0x39) || (key >= 0x41 && key <= 0x5a)) return String.fromCharCode(key);
    if (key >= 0x60 && key <= 0x69) return `Num ${key - 0x60}`;
    if (key >= 0x70 && key <= 0x87) return `F${key - 0x6f}`;
    return KEYS[key] ?? `key 0x${key.toString(16).toUpperCase().padStart(2, '0')}`;
}

export interface Accelerator {
    /** The keys, as a person presses them: "Ctrl+Shift+V". */
    keys: string;
    id: number;
}

export interface Accelerators {
    entries: Accelerator[];
    fields: Field[];
    end: number;
    problems: string[];
}

/** Reads an accelerator table at `at`, at most `length` bytes; `wide` for a 32-bit program's (8-byte entries), otherwise a 16-bit module's (5). */
export function readAccelerators(data: Uint8Array, at: number, length: number, wide: boolean): Accelerators {
    const b = new Bytes(data);
    const end = Math.min(data.length, at + length);
    const size = wide ? 8 : 5;
    const entries: Accelerator[] = [];
    const fields: Field[] = [];
    const problems: string[] = [];
    let p = at;
    let last = false;
    for (; p + size <= end && !last; p += size) {
        const flags = wide ? b.u16(p) : data[p];
        const key = b.u16(p + (wide ? 2 : 1));
        const id = b.u16(p + (wide ? 4 : 3));
        last = !!(flags & 0x80);
        const virtual = flags & 0x01;
        // A character: itself, or, below a space, Ctrl and the letter it's typed with (^C is 3).
        const base = virtual ? keyName(key) : key < 0x20 ? `Ctrl+${String.fromCharCode(key + 0x40)}` : key === 0x20 ? 'Space' : String.fromCharCode(key);
        const keys = [flags & 0x08 && virtual ? 'Ctrl' : '', flags & 0x10 && virtual ? 'Alt' : '', flags & 0x04 && virtual ? 'Shift' : '', base].filter(Boolean).join('+');
        entries.push({ keys, id });
        const children = [
            field('Flags', p, wide ? 2 : 1, [virtual ? 'a virtual key' : 'a character', flags & 0x02 ? 'menu not highlighted' : '', last ? 'the last' : ''].filter(Boolean).join(', ')),
            field('Key', p + (wide ? 2 : 1), 2, virtual ? `${keyName(key)} (0x${key.toString(16).toUpperCase().padStart(2, '0')})` : base),
            field('Command', p + (wide ? 4 : 3), 2, id),
            ...(wide ? [field('Padding', p + 6, 2, b.u16(p + 6))] : []),
        ];
        fields.push({ ...field(keys, p, size, `command ${id}`), children });
        if (!virtual && flags & 0x1c) problems.push(`The shortcut ${base} (command ${id}) asks for Ctrl, Alt or Shift on a character, which Windows only honors on virtual keys.`);
    }
    if (!last) problems.push('The shortcut keys run to the end of their resource without the entry marked as the last.');
    return { entries, fields, end: p, problems };
}
