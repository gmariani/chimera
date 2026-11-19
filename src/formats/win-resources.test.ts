import { describe, expect, it } from 'vitest';
import { bitmap } from '../testing/samples';
import { bitmapFile, languageName, readMessageTable, readStringTable } from './win-resources';

const u16 = (v: number) => [v & 0xff, v >> 8];
const u32 = (v: number) => [...u16(v & 0xffff), ...u16(v >>> 16)];
const wide = (s: string) => [...s].flatMap((c) => u16(c.charCodeAt(0)));
const pad4 = (b: number[]) => [...b, ...new Array((4 - (b.length % 4)) % 4).fill(0)];

describe('Windows resources', () => {
    it('makes a bitmap resource the .bmp file it was made from', () => {
        // A resource is a .bmp file without its 14-byte file header: putting the header back gives the file again.
        for (const bits of [4, 8, 24] as const) {
            const file = bitmap(bits);
            const resource = file.subarray(14);
            expect(bitmapFile(resource, 0, resource.length), `${bits} bits`).toEqual(file);
        }
        expect(bitmapFile(Uint8Array.from(u32(41)), 0, 4)).toBeNull();
    });

    it('reads a string table: 16 strings, numbered by the resource', () => {
        // Resource #2 holds strings 16 to 31: "Hello" as 16, "World" as 19, the rest empty.
        const block = [...u16(5), ...wide('Hello'), 0, 0, 0, 0, ...u16(5), ...wide('World'), ...new Array(12 * 2).fill(0)];
        const data = Uint8Array.from(block);
        const t = readStringTable(data, 0, data.length, 2, true);
        expect(t.problems).toEqual([]);
        expect(t.strings.map((s) => [s.id, s.text])).toEqual([
            [16, 'Hello'],
            [19, 'World'],
        ]);
        expect(t.fields.map((f) => [f.name, f.value])).toEqual([
            ['String 16', 'Hello'],
            ['Not used', 'Strings 17–18'],
            ['String 19', 'World'],
            ['Not used', 'Strings 20–31'],
        ]);
        expect(t.fields.reduce((n, f) => n + f.length, 0)).toBe(data.length);

        // 16-bit: a byte for each length, the text in the code page.
        const narrow = Uint8Array.from([0, 2, 0x48, 0x69, ...new Array(14).fill(0)]);
        expect(readStringTable(narrow, 0, narrow.length, 1, false).strings).toEqual([{ id: 1, text: 'Hi', at: 1, length: 3 }]);
    });

    it('says what doesn’t fit in a string table', () => {
        const long = Uint8Array.from([...u16(50), ...wide('Hi')]);
        expect(readStringTable(long, 0, long.length, 1, true).problems).toEqual(['String 0 says it’s 50 characters long, past the end of its table.']);
        const after = Uint8Array.from([...new Array(32).fill(0), 1, 2]);
        const t = readStringTable(after, 0, after.length, 1, true);
        expect(t.problems).toEqual(['A string table has 2 bytes after its 16 strings that aren’t any of them.']);
        expect(t.fields.at(-1)).toMatchObject({ name: 'Not read', offset: 32, length: 2 });
    });

    it('reads a message table: blocks of messages, in the code page or UTF-16', () => {
        // One block, messages 100 and 101: "Ready" in the code page, "Done" in UTF-16, each padded to 4 bytes.
        const ready = pad4([...u16(0), ...u16(0), ...'Ready\r\n'.split('').map((c) => c.charCodeAt(0)), 0]);
        const done = pad4([...u16(0), ...u16(1), ...wide('Done'), 0, 0]);
        ready.splice(0, 2, ...u16(ready.length));
        done.splice(0, 2, ...u16(done.length));
        const data = Uint8Array.from([...u32(1), ...u32(100), ...u32(101), ...u32(16), ...ready, ...done]);
        const t = readMessageTable(data, 0, data.length);
        expect(t.problems).toEqual([]);
        expect(t.strings.map((s) => [s.id, s.text])).toEqual([
            [100, 'Ready'],
            [101, 'Done'],
        ]);
        expect(t.fields.map((f) => [f.name, f.offset, f.length])).toEqual([
            ['Blocks', 0, 4],
            ['Block list', 4, 12],
            ['Messages 100–101', 16, data.length - 16],
        ]);
    });

    it('says what doesn’t fit in a message table', () => {
        const problems = (b: number[]) => readMessageTable(Uint8Array.from(b), 0, b.length).problems;
        expect(problems([...u32(3), ...u32(1), ...u32(1), ...u32(16), ...u16(4), 0, 0])).toEqual(['A message table says it has 3 blocks, but has room for 1.']);
        expect(problems([...u32(1), ...u32(5), ...u32(4), ...u32(16), 0, 0, 0, 0])).toEqual(['Block 1 of a message table runs from message 5 down to 4.']);
        expect(problems([...u32(1), ...u32(1), ...u32(1), ...u32(99)])).toEqual(['Block 1 of a message table is said to start past its end.']);
        expect(problems([...u32(1), ...u32(1), ...u32(2), ...u32(16), ...u16(8), 0, 0, 0x41, 0, 0, 0])).toEqual(['A block of a message table runs out before its last message.']);
    });

    it('names languages by their Windows IDs', () => {
        expect(languageName(0x409)).toBe('English (US)');
        // Wine labels its translations with the primary language alone.
        expect(languageName(0x01)).toBe('Arabic');
        // German (Austria), not in the list of common ones: the language, and which form of it.
        expect(languageName(0xc07)).toBe('German (form 3)');
        expect(languageName(0x3ff)).toBe('language 03FF');
    });
});
