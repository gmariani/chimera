import { field } from '../../core/bytes';
import type { FormatParser } from '../../core/types';
import { expandPalette } from './vga';

const parser: FormatParser = {
    parse(data) {
        const colors = expandPalette(data.subarray(0, 768));
        return {
            title: 'Palette',
            summary: [
                ['Colors', '256'],
                ['Depth', '6 bits per channel (VGA)'],
            ],
            fields: Array.from({ length: 256 }, (_, i) => {
                const [r, g, b] = data.subarray(i * 3, i * 3 + 3);
                return field(`Color ${i}`, i * 3, 3, `${r}, ${g}, ${b}`, `#${[colors[i * 3], colors[i * 3 + 1], colors[i * 3 + 2]].map((v) => v.toString(16).padStart(2, '0')).join('')} on screen`);
            }),
            preview: { kind: 'palette', colors },
            warnings: [],
        };
    },
};

export default parser;
