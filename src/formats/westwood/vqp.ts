import { Bytes, field } from '../../core/bytes';
import type { FormatParser } from '../../core/types';
import { VQP_TABLE } from './sniff';

/**
 * VQA palette blending tables (.vqp), one per movie in RA. To play a 320-wide
 * movie at 640 wide, the game fills each gap between two pixels with the
 * palette colour closest to their average; these tables hold the answers.
 * Each is triangular: the colour for (a, b) is the same as for (b, a), so only
 * a ≥ b is stored, row by row.
 */
const parser: FormatParser = {
    parse(data) {
        const count = new Bytes(data).u32(0);
        const tables = Array.from({ length: count }, (_, i) => 4 + i * VQP_TABLE);

        // The first table as a picture: (a, b) on a 256 × 256 grid, mirrored across the diagonal.
        const pixels = new Uint8Array(256 * 256);
        let at = 4;
        for (let a = 0; a < 256; a++) {
            for (let b = 0; b <= a; b++) {
                pixels[a * 256 + b] = data[at];
                pixels[b * 256 + a] = data[at++];
            }
        }

        return {
            title: 'Palette blending tables (VQP)',
            summary: [
                ['Tables', String(count)],
                ['Each', '256 × 256 colour pairs, stored as a triangle'],
            ],
            fields: [
                field('Table count', 0, 4, count, 'One per palette the movie uses.'),
                ...tables.map((offset, i) => field(`Table ${i + 1}`, offset, VQP_TABLE, '32,896 entries', 'Row a has a + 1 entries: the blend of colour a with colours 0 to a.')),
            ],
            preview: { kind: 'images', frames: [{ width: 256, height: 256, pixels }] },
            warnings: [],
        };
    },
};

export default parser;
