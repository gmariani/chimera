import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detect } from '../index';
import font from './index';

const samples = join(__dirname, '../../../samples/fonts');

describe.skipIf(!existsSync(samples))('sample fonts', () => {
    const open = (name: string) => {
        const data = new Uint8Array(readFileSync(join(samples, name)));
        expect(detect(data, name).id).toBe('sfnt');
        return font.parse(data, { name, names: [] });
    };
    /** The glyph sheet's share of dark pixels: glyphs drawn, not a blank or a solid fill. */
    const ink = (parsed: ReturnType<typeof open>) => {
        const sheet = parsed.preview?.kind === 'stack' ? parsed.preview.items[0].preview : parsed.preview;
        if (sheet?.kind !== 'picture') throw new Error('expected a glyph sheet');
        return sheet.rgba.filter((v, i) => i % 4 === 0 && v < 128).length / (sheet.width * sheet.height);
    };

    it('reads an OpenType font with CFF outlines', () => {
        const parsed = open('otf-cff.otf');
        expect(parsed.summary).toEqual(expect.arrayContaining([['Family', 'C059'], ['Style', 'Bold Italic'], ['Glyphs', '855'], ['Outlines', 'CFF']]));
        expect(parsed.warnings).toEqual([]);
        expect(ink(parsed)).toBeGreaterThan(0.02);
        expect(ink(parsed)).toBeLessThan(0.3);
    });

    it('reads a TrueType font', () => {
        const parsed = open('ttf-truetype.ttf');
        expect(parsed.summary).toEqual(expect.arrayContaining([['Family', 'Droid Sans Fallback'], ['Glyphs', '49382'], ['Units per em', '256'], ['Outlines', 'TrueType']]));
        expect(parsed.warnings).toEqual([]);
        expect(ink(parsed)).toBeGreaterThan(0.02);
    });

    it('reads the first font of a collection, a CID-keyed CFF one', () => {
        const parsed = open('ttc-cid-cff.ttc');
        expect(parsed.title).toBe('Font (OpenType, CFF outlines, collection)');
        expect(parsed.summary).toEqual(expect.arrayContaining([['Family', 'Noto Sans CJK JP'], ['Glyphs', '65535']]));
        expect(parsed.fields.find((f) => f.name.startsWith('CFF'))?.children?.some((c) => c.name === 'FDArray INDEX')).toBe(true);
        expect(parsed.warnings).toEqual([]);
        expect(ink(parsed)).toBeGreaterThan(0.02);
    });
});
