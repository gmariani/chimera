import { describe, expect, it } from 'vitest';
import type { Parsed, Preview } from '../core/types';
import { cursorDib, iconDib, iconDib32, iconFile, iconLibrary, samples } from '../testing/samples';
import { detect } from './index';
import { inspect } from './inspect';
import ico from './ico';
import ne from './ne';

const parse = (data: Uint8Array, name = 'x.ico') => ico.parse(data, { name, names: [] }) as Parsed;
const pictures = (p: Preview | undefined): Extract<Preview, { kind: 'picture' }>[] => (p?.kind === 'picture' ? [p] : p?.kind === 'stack' ? p.items.flatMap((i) => pictures(i.preview)) : []);
const titles = (p: Preview | undefined) => (p?.kind === 'stack' ? p.items.map((i) => i.title) : []);
const pixel = (p: Extract<Preview, { kind: 'picture' }>, x: number, y: number) => [...p.rgba.subarray((y * p.width + x) * 4, (y * p.width + x) * 4 + 4)];
const sample = (name: string) => samples().find((s) => s.name === name)!.data;

describe('Windows icons and cursors (ICO, CUR)', () => {
    it('draws each size: 16 colors with a mask, 32-bit with its own alpha, and a PNG', () => {
        const data = sample('icon.ico');
        expect(detect(data, 'icon.ico').id).toBe('ico');
        const r = parse(data);
        expect(r.warnings).toEqual([]);
        expect(titles(r.preview)).toEqual(['16 × 16, 16 colors', '32 × 32, 32-bit', '48 × 48, PNG']);
        const [small, disc] = pictures(r.preview);
        // The diamond's corner is see-through (the mask); its middle is color 12, the EGA's light red.
        expect(pixel(small, 0, 0)[3]).toBe(0);
        expect(pixel(small, 8, 8)).toEqual([252, 84, 84, 255]);
        // The disc: opaque in the middle, see-through in the corner, from its own alpha.
        expect(pixel(disc, 16, 16)[3]).toBe(255);
        expect(pixel(disc, 0, 0)[3]).toBe(0);
        expect(r.fields.reduce((n, f) => n + f.length, 0)).toBe(data.length);
    });

    it('reads a cursor and its hot spot', () => {
        const r = parse(sample('cursor.cur'), 'cursor.cur');
        expect(r.title).toBe('Cursor (CUR)');
        expect(r.warnings).toEqual([]);
        const [arrow] = pictures(r.preview);
        // The tip is the black edge; inside the arrow is white; outside, see-through.
        expect(pixel(arrow, 0, 0)).toEqual([0, 0, 0, 255]);
        expect(pixel(arrow, 2, 8)).toEqual([255, 255, 255, 255]);
        expect(pixel(arrow, 20, 2)[3]).toBe(0);
        expect(r.fields[1].children![0].children!.map((f) => f.name)).toContain('Hot spot x');
    });

    it('says when two images are the same picture', () => {
        const r = parse(
            iconFile([
                { image: iconDib(), width: 16, height: 16, colors: 16, bits: 4 },
                { image: iconDib(), width: 16, height: 16, colors: 16, bits: 4 },
            ])
        );
        expect(titles(r.preview)).toEqual(['16 × 16, 16 colors', '16 × 16, 16 colors, the same picture as image 1']);
    });

    it('says what doesn’t fit', async () => {
        // An entry's size that isn't its image's; 0 means 256 or more.
        expect(parse(iconFile([{ image: iconDib(), width: 24, height: 16, colors: 16, bits: 4 }])).warnings).toEqual(['Entry 1 says 24 × 16, but its image is 16 × 16.']);
        // An image given more room than it takes.
        expect(parse(iconFile([{ image: [...iconDib(), 1, 2, 3, 4], width: 16, height: 16, colors: 16, bits: 4 }])).warnings).toEqual([
            'Image 1 takes 296 bytes, but its entry gives it 300 bytes: the rest is never drawn.',
        ]);
        // A mask saved as UTF-8 text (as some cursor-theme converters do): every 0xFF became C3 BF.
        const dib = iconDib32();
        const maskAt = 40 + 32 * 32 * 4;
        const mangled = [...dib.slice(0, maskAt), ...new Array(32 * 4).fill(0xff).flatMap(() => [0xc3, 0xbf])];
        expect(parse(iconFile([{ image: mangled, width: 32, height: 32 }])).warnings).toEqual([
            "The image had its mask saved as UTF-8 text (the byte 0xFF became C3 BF), which made it longer than it should be. The picture carries its own transparency, so the mask isn't used and it draws as meant.",
        ]);
        // Bytes between images that nothing points to.
        const gap = iconFile([{ image: iconDib(), width: 16, height: 16, colors: 16, bits: 4 }]);
        const spaced = Uint8Array.from([...gap.subarray(0, 22), 7, 7, ...gap.subarray(22)]);
        spaced[18] = 24; // the image is 2 bytes further on
        expect(parse(spaced).warnings).toEqual(["2 bytes between the images aren't pointed to by any entry."]);
        // Not an icon: the header's fine, but the entry points at nothing like a picture.
        expect(detect(Uint8Array.from([0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 4, 0, 8, 0, 0, 0, 22, 0, 0, 0, ...new Array(8).fill(9)]), null).id).not.toBe('ico');
        // After the last image: the usual check.
        const r = await inspect(Uint8Array.from([...gap, ...new TextEncoder().encode('MZ payload')]), { name: 'x.ico', names: [] });
        expect(r.checks[0]).toMatchObject({ level: 'danger' });
        expect(r.checks[0].text).toMatch(/10 bytes after the end/);
    });

    it('opens the .ico a 16-bit module’s icon group makes', async () => {
        const module = ne.parse(iconLibrary(), { name: 'icons.icl', names: [] });
        // The module itself shows no picture: its icons are in Contents.
        expect(module.preview).toBeUndefined();
        expect(module.entries!.map((e) => e.label)).toEqual(['Icon #1.ico']);
        const r = await inspect(module.entries![0].data, { name: module.entries![0].name, names: [] });
        expect(r.format.id).toBe('ico');
        expect(r.parsed.warnings).toEqual([]);
        expect(r.checks).toEqual([]);
        expect(pictures(r.parsed.preview).map((p) => [p.width, p.height])).toEqual([[16, 16]]);
    });

    it('keeps the cursor and its picture apart', () => {
        expect(cursorDib().length).toBe(40 + 8 + 32 * 4 * 2);
        expect(iconDib32().length).toBe(40 + 32 * 32 * 4 + 32 * 4);
    });
});
