import { Bytes, field } from '../../core/bytes';
import type { FormatParser, IndexedImage } from '../../core/types';
import { pixelBuffer } from '../../core/limits';

/**
 * TS and RA2 bitmap fonts. Unicode ones (game.fnt, "fonT"): a 28-byte header,
 * then for each of the 65,536 code points the glyph it uses, then the glyphs.
 * Smaller ones (map.fnt, "FoNt"): a 48-byte header naming the first and last
 * character, then a glyph for each. A glyph is a width byte and then its rows
 * at 1 bit per pixel, leftmost pixel in the high bit.
 */

const MAX_SHOWN = 4096;

const parser: FormatParser = {
    parse(data) {
        const b = new Bytes(data);
        const unicode = b.ascii(0, 4) === 'fonT';
        const [rowBytes, height] = [b.u32(8), b.u32(12)];
        const glyphSize = b.u32(24);
        const [first, last] = unicode ? [0, 0] : [b.u32(40), b.u32(44)];
        const glyphs = unicode ? b.u32(20) : last - first + 1;
        const table = 28;
        const glyphStart = unicode ? table + 65536 * 2 : 48;
        if (glyphStart + glyphs * glyphSize > data.length || rowBytes * height + 1 > glyphSize) throw new Error('The header\'s sizes don\'t fit the file.');

        // Code points with a glyph of their own (in a Unicode font, glyph 0 is what unmapped ones get), and where it is.
        const mapped: [number, number][] = [];
        if (unicode) {
            for (let cp = 0; cp < 65536; cp++) if (b.u16(table + cp * 2)) mapped.push([cp, glyphStart + b.u16(table + cp * 2) * glyphSize]);
        } else {
            for (let cp = first; cp <= last; cp++) mapped.push([cp, glyphStart + (cp - first) * glyphSize]);
        }
        const frames: IndexedImage[] = mapped.slice(0, MAX_SHOWN).map(([, at]) => {
            const width = Math.max(1, Math.min(b.u8(at), rowBytes * 8));
            const pixels = pixelBuffer(width, height);
            for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (data[at + 1 + y * rowBytes + (x >> 3)] & (0x80 >> (x & 7))) pixels[y * width + x] = 1;
            return { width, height, pixels };
        });
        const palette = new Uint8Array(768);
        palette.set([255, 255, 255], 3);

        return {
            title: unicode ? 'Unicode font (TS/RA2)' : 'Font (TS/RA2)',
            summary: [
                ['Glyphs', String(glyphs)],
                ['Characters', `${mapped.length.toLocaleString('en-US')} mapped${mapped.length > MAX_SHOWN ? ` (the first ${MAX_SHOWN} shown)` : ''}`],
                ['Height', `${height} pixels`],
            ],
            fields: [
                {
                    name: 'Header',
                    offset: 0,
                    length: glyphStart === 48 ? 48 : 28,
                    children: [
                        field('ID', 0, 4, b.ascii(0, 4)),
                        field('Unknown', 4, 4, b.u32(4)),
                        field('Bytes per row', 8, 4, rowBytes),
                        field('Height', 12, 4, height),
                        field('Widest', 16, 4, b.u32(16)),
                        field(unicode ? 'Glyphs' : 'Unknown', 20, 4, b.u32(20)),
                        field('Glyph size', 24, 4, glyphSize, 'A width byte, then the rows.'),
                        ...(unicode ? [] : [field('Unknown', 28, 12), field('First character', 40, 4, first), field('Last character', 44, 4, last)]),
                    ],
                },
                ...(unicode ? [field('Character map', table, 65536 * 2, '65,536 glyph numbers', 'For each code point from U+0000, which glyph it uses.')] : []),
                field('Glyphs', glyphStart, glyphs * glyphSize, `${glyphs} × ${glyphSize} bytes`),
            ],
            preview: { kind: 'images', frames, palette, transparentIndex: 0 },
            warnings: [],
        };
    },
};

export default parser;
