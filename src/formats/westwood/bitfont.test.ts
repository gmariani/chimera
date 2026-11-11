import { describe, expect, it } from 'vitest';
import type { IndexedImage, Parsed } from '../../core/types';
import { detect } from '../index';
import { inspect } from '../inspect';
import font from './font-ts';

const u16 = (v: number) => [v & 0xff, v >> 8];
const u32 = (v: number) => [...u16(v & 0xffff), ...u16(v >>> 16)];
const id = (s: string) => [...s].map((c) => c.charCodeAt(0));

// Two glyphs, 1 byte a row and 2 rows: "A" is 3 wide (#.# / .#.), "B" 2 wide (## / #.).
const A = [3, 0b1010_0000, 0b0100_0000];
const B = [2, 0b1100_0000, 0b1000_0000];

/** RA2's map editor font: 48 bytes of header, then a glyph for each character from first to last. */
const foNt = (glyphs: number[][], { first = 65, fixed = [1, 0x24, 0x30, 0], glyphSize = 3, after = [] as number[] } = {}) =>
    Uint8Array.from([
        ...id('FoNt'),
        ...u32(5),
        ...u32(1),
        ...u32(2),
        ...u32(2),
        ...fixed.flatMap(u32).slice(0, 4),
        ...u32(glyphSize),
        ...fixed.slice(1).flatMap(u32),
        ...u32(first),
        ...u32(first + glyphs.length - 1),
        ...glyphs.flat(),
        ...after,
    ]);

/** Nox's: 36 bytes, no height, 16-bit first and last characters. */
const tNoF = (glyphs: number[][], first = 65) =>
    Uint8Array.from([...id('tNoF'), ...u32(1), ...u32(5), ...u32(1), ...u32(2), ...u32(1), ...u32(3), ...u32(0), ...u16(first), ...u16(first + glyphs.length - 1), ...glyphs.flat()]);

/** The Unicode one: 28 bytes, the map of code points to glyph number + 1, then the glyphs. */
function fonT(map: Record<number, number>, glyphs: number[][]): Uint8Array {
    const table = new Uint8Array(65536 * 2);
    for (const [cp, n] of Object.entries(map)) table.set(u16(n), Number(cp) * 2);
    return Uint8Array.from([...id('fonT'), ...u32(0), ...u32(1), ...u32(2), ...u32(3), ...u32(glyphs.length), ...u32(3), ...table, ...glyphs.flat()]);
}

const parse = (data: Uint8Array) => font.parse(data, { name: 'x.fnt', names: [] }) as Parsed;
const frames = (r: Parsed): IndexedImage[] => (r.preview?.kind === 'images' ? r.preview.frames : []);
const rows = (f: IndexedImage) =>
    Array.from({ length: f.height }, (_, y) =>
        Array.from(f.pixels.subarray(y * f.width, (y + 1) * f.width))
            .map((v) => (v ? '#' : '.'))
            .join('')
    );

describe('1-bit fonts', () => {
    it("reads RA2's map editor fonts (FoNt)", () => {
        const data = foNt([A, B]);
        expect(detect(data, 'x.fnt').id).toBe('fnt-ts');
        const r = parse(data);
        expect(r.warnings).toEqual([]);
        expect(r.title).toBe('Font (RA2 map editor)');
        expect(frames(r).map(rows)).toEqual([
            ['#.#', '.#.'],
            ['##', '#.'],
        ]);
        expect(r.summary).toContainEqual(['Characters', '2 (65 to 66)']);
    });

    it("reads Nox's fonts (tNoF)", () => {
        const data = tNoF([A, B]);
        expect(detect(data, 'x.fnt').id).toBe('fnt-ts');
        const r = parse(data);
        expect(r.warnings).toEqual([]);
        expect(r.title).toBe('Font (Nox)');
        expect(frames(r).map(rows)).toEqual([
            ['#.#', '.#.'],
            ['##', '#.'],
        ]);
    });

    it("reads a Unicode font (fonT): its map holds glyph numbers plus one, and pads to the font's height", () => {
        // "A" and "C" share glyph 2 (B's picture); "B" has glyph 1 (A's).
        const r = parse(fonT({ 65: 2, 66: 1, 67: 2 }, [A, B]));
        expect(r.warnings).toEqual([]);
        expect(frames(r).map(rows)).toEqual([
            ['##', '#.', '..'],
            ['#.#', '.#.', '...'],
            ['##', '#.', '..'],
        ]);
        expect(r.summary).toContainEqual(['Height', '3 pixels (2 stored)']);
    });

    it('finds what never shows', async () => {
        // A pixel past "A"'s width of 3 (bit 4 of its first row).
        const hidden = parse(foNt([[3, 0b1010_1000, 0b0100_0000], B])).warnings;
        expect(hidden).toEqual(['1 glyph has pixels set past its width, which never show: a place data can hide.']);
        // Spare bytes in each glyph, past its rows.
        expect(
            parse(
                foNt(
                    [
                        [...A, 0],
                        [...B, 9],
                    ],
                    { glyphSize: 4 }
                )
            ).warnings.join()
        ).toMatch(/the byte left over in each never shows.*1 glyph has pixels set past/);
        // A glyph no character uses, with pixels in it.
        const unused = parse(fonT({ 65: 1 }, [A, B]));
        expect(unused.warnings).toEqual(['1 glyph that no character uses holds pixels, which never show.']);
        expect(unused.summary).toContainEqual(['Unused glyphs', '1']);
        // A map entry past the glyphs, a width wider than a row, and an odd header value.
        expect(parse(fonT({ 65: 1, 66: 3 }, [A])).warnings).toEqual(["1 character in the table points past the font's 1 glyph."]);
        expect(parse(foNt([[9, 0, 0]])).warnings).toEqual(['1 glyph is said to be wider than a row holds (8 pixels).']);
        expect(parse(foNt([A], { fixed: [1, 0x24, 0x31, 0] })).warnings).toEqual(["The header's value at offset 32 is 49, where every known font has 48."]);
        // After the last glyph: the usual check.
        const r = await inspect(foNt([A, B], { after: [...new TextEncoder().encode('MZ payload')] }), { name: 'x.fnt', names: [] });
        expect(r.format.id).toBe('fnt-ts');
        expect(r.checks[0]).toMatchObject({ level: 'danger' });
        expect(r.checks[0].text).toMatch(/10 bytes after the end/);
    });

    it("isn't fooled by headers that don't fit", () => {
        // Glyphs that run past the file, a glyph too small for its rows, and no glyphs.
        expect(detect(foNt([A, B]).subarray(0, 50), 'x.fnt').id).not.toBe('fnt-ts');
        expect(
            detect(
                foNt(
                    [
                        [3, 1],
                        [2, 1],
                    ],
                    { glyphSize: 2 }
                ),
                'x.fnt'
            ).id
        ).not.toBe('fnt-ts');
        expect(() => parse(Uint8Array.from([...id('tNoF'), ...new Array(40).fill(0)]))).toThrow(/isn't one of Westwood's 1-bit fonts/);
    });
});
