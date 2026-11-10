import { Bytes, field } from '../../core/bytes';
import type { FormatParser, IndexedImage } from '../../core/types';
import { checkCount } from '../../core/limits';

/**
 * TS and RA2's voxel lighting tables (voxels.vpl). The games light each voxel
 * by how its normal faces the light, as one of a number of levels (32), and
 * each level is a table: for every palette color, the color to draw instead.
 * A header (the range of colors that take the owner's color, the number of
 * levels), a palette, then the tables, darkest first.
 */

const SWATCH = 8;

/** A table as a 16 × 16 grid of swatches: each color, through the table. */
function swatches(table: ArrayLike<number>): IndexedImage {
    const size = 16 * SWATCH;
    const pixels = new Uint8Array(size * size);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) pixels[y * size + x] = table[Math.floor(y / SWATCH) * 16 + Math.floor(x / SWATCH)];
    return { width: size, height: size, pixels };
}

const parser: FormatParser = {
    parse(data) {
        const b = new Bytes(data);
        const [start, end, sections] = [b.u32(0), b.u32(4), b.u32(8)];
        checkCount(sections, 256, data.length - 784, 'The number of lighting tables');
        const tables = Array.from({ length: sections }, (_, i) => data.subarray(784 + i * 256, 784 + (i + 1) * 256));
        // The palette is 6-bit in some files and 8-bit in others.
        const raw = data.subarray(16, 784);
        const palette = raw.every((v) => v < 64) ? raw.map((v) => (v << 2) | (v >> 4)) : raw;
        return {
            title: 'Voxel lighting tables (VPL)',
            summary: [
                ['Lighting levels', String(sections)],
                ['Owner\'s colors', `${start}–${end}`],
                ['Preview', 'Each level applied to the palette, darkest first'],
            ],
            fields: [
                {
                    name: 'Header',
                    offset: 0,
                    length: 16,
                    children: [
                        field('Remap start', 0, 4, start, 'The colors that take the owner\'s color.'),
                        field('Remap end', 4, 4, end),
                        field('Levels', 8, 4, sections),
                        field('Unused', 12, 4, undefined, 'Leftover memory.'),
                    ],
                },
                field('Palette', 16, 768),
                { name: `Tables (${sections})`, offset: 784, length: sections * 256, children: tables.map((_, i) => field(`Level ${i}`, 784 + i * 256, 256)) },
            ],
            preview: { kind: 'images', frames: tables.map(swatches), palette },
            warnings: [],
        };
    },
};

export default parser;
