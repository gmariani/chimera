import { Bytes, bytesLabel, field } from '../../core/bytes';
import type { Field, FormatParser, IndexedImage } from '../../core/types';

/**
 * TD/RA fonts. A header of block offsets, then: an info block (character count,
 * largest height and width), each character's data offset, its width, its
 * vertical offset and height, and the pixels at 4 bits each, two to a byte,
 * left pixel in the low nibble. Color 0 is transparent; the game maps 1–15
 * onto whatever colors it's printing in.
 *
 * Tiberian Sun's own fonts (8point.fnt) use the same blocks, but mark the
 * header 2, 0 instead of 0, 5, store a byte per pixel, and count each
 * character's offset from the data block.
 */

/** 15 shades of white for the font's colors, so the preview reads as text. */
function fontPalette(): Uint8Array {
    const palette = new Uint8Array(768);
    for (let i = 1; i < 16; i++) palette.fill(Math.round(80 + (175 * i) / 15), i * 3, i * 3 + 3);
    return palette;
}

const parser: FormatParser = {
    parse(data) {
        const b = new Bytes(data);
        const info = b.u16(4);
        const offsetBlock = b.u16(6);
        const widthBlock = b.u16(8);
        const dataBlock = b.u16(10);
        const heightBlock = b.u16(12);
        const count = (widthBlock - offsetBlock) / 2;
        const maxHeight = b.u8(info + 4);
        const maxWidth = b.u8(info + 5);
        const eightBit = b.u8(2) === 2;
        const warnings: string[] = [];

        const frames: IndexedImage[] = [];
        const glyphs: Field[] = [];
        for (let c = 0; c < count; c++) {
            // TS's offsets count from the data block; TD's and RA's from the start of the file.
            const at = (eightBit ? dataBlock : 0) + b.u16(offsetBlock + c * 2);
            const width = b.u8(widthBlock + c);
            const top = b.u8(heightBlock + c * 2);
            const rows = b.u8(heightBlock + c * 2 + 1);
            const stride = eightBit ? width : Math.ceil(width / 2);
            // Every glyph is drawn in a cell of the font's full size, so they line up as text does.
            const pixels = new Uint8Array(Math.max(width, 1) * maxHeight);
            for (let y = 0; y < rows && top + y < maxHeight; y++) {
                for (let x = 0; x < width; x++) {
                    const byte = b.u8(at + y * stride + (eightBit ? x : x >> 1));
                    pixels[(top + y) * Math.max(width, 1) + x] = eightBit ? byte : x & 1 ? byte >> 4 : byte & 0x0f;
                }
            }
            frames.push({ width: Math.max(width, 1), height: maxHeight, pixels });
            const label = c >= 33 && c < 127 ? ` "${String.fromCharCode(c)}"` : '';
            if (width && rows) glyphs.push(field(`Character ${c}${label}`, at, stride * rows, `${width} × ${rows}`, top ? `${top} rows down.` : undefined));
        }

        return {
            title: 'Font',
            summary: [
                ['Characters', String(count)],
                ['Largest', `${maxWidth} × ${maxHeight}`],
                ['Colors', eightBit ? '8-bit (Tiberian Sun)' : '4-bit: 15 shades plus transparent'],
            ],
            fields: [
                {
                    name: 'Header',
                    offset: 0,
                    length: 14,
                    children: [
                        field('File size', 0, 2, bytesLabel(b.u16(0))),
                        field('Format', 2, 1, b.u8(2), '0: 4 bits per pixel (TD, RA). 2: 8 bits (TS).'),
                        field('Blocks', 3, 1, b.u8(3), '5 in TD and RA; 0 in TS.'),
                        field('Info block', 4, 2, info),
                        field('Offset block', 6, 2, offsetBlock),
                        field('Width block', 8, 2, widthBlock),
                        field('Data block', 10, 2, dataBlock),
                        field('Height block', 12, 2, heightBlock),
                    ],
                },
                {
                    name: 'Info',
                    offset: info,
                    length: 6,
                    children: [
                        field('Unknown', info, 3),
                        field('Last character', info + 3, 1, b.u8(info + 3)),
                        field('Largest height', info + 4, 1, maxHeight),
                        field('Largest width', info + 5, 1, maxWidth),
                    ],
                },
                field('Offsets', offsetBlock, count * 2, `${count} characters`, eightBit ? "Where each character's pixels start, from the data block." : "Where each character's pixels start."),
                field('Widths', widthBlock, count, undefined, 'One byte per character, in pixels.'),
                field('Heights', heightBlock, count * 2, undefined, 'Two bytes per character: blank rows above it, then its height.'),
                // TD and RA put the heights after the pixels; TS puts them before.
                { name: 'Pixels', offset: dataBlock, length: (heightBlock > dataBlock ? heightBlock : data.length) - dataBlock, children: glyphs },
            ],
            // TS's 8-bit glyphs are in the game palette's colors.
            preview: { kind: 'images', frames, palette: frames.some((f) => f.pixels.some((p) => p > 15)) ? undefined : fontPalette(), transparentIndex: 0 },
            warnings,
        };
    },
};

export default parser;
