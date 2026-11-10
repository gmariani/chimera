import { Bytes, bytesLabel, field } from '../../core/bytes';
import type { FormatParser } from '../../core/types';
import { lcw } from './compression';
import { expandPalette } from './vga';
import { checkBytes } from '../../core/limits';

/** Full-screen 320×200 pictures (title screens, backgrounds), LCW-compressed. */
const parser: FormatParser = {
    parse(data) {
        const b = new Bytes(data);
        const compression = b.u16(2);
        const size = b.u32(4);
        const paletteSize = b.u16(8);
        const start = 10 + paletteSize;
        // Always 64,000 (320 × 200) in the games; anything much bigger is a damaged or crafted header.
        const pixels = new Uint8Array(checkBytes(size, 'The picture', 1 << 22));
        if (compression === 4) lcw(data, pixels, start);
        else pixels.set(data.subarray(start, start + size));
        const palette = paletteSize === 768 ? expandPalette(data.subarray(10, 10 + 768)) : undefined;

        return {
            title: 'Picture (CPS)',
            summary: [
                ['Size', '320 × 200'],
                ['Compression', compression === 4 ? 'LCW' : 'None'],
                ['Palette', palette ? 'Included' : 'Uses the game palette'],
            ],
            fields: [
                {
                    name: 'Header',
                    offset: 0,
                    length: 10,
                    children: [
                        field('File size', 0, 2, bytesLabel(b.u16(0)), 'Not counting these two bytes.'),
                        field('Compression', 2, 2, compression, '4 = LCW, 0 = none.'),
                        field('Decoded size', 4, 4, bytesLabel(size), '320 × 200.'),
                        field('Palette size', 8, 2, paletteSize),
                    ],
                },
                ...(palette ? [field('Palette', 10, 768, '256 colors, 6-bit')] : []),
                field('Picture data', start, data.length - start, bytesLabel(data.length - start)),
            ],
            preview: { kind: 'images', frames: [{ width: 320, height: Math.floor(size / 320), pixels }], palette },
            warnings: [],
        };
    },
};

export default parser;
