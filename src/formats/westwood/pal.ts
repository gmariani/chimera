import { bytesLabel, field } from '../../core/bytes';
import type { FormatParser } from '../../core/types';
import { expandPalette } from './vga';

const parser: FormatParser = {
    parse(data) {
        // 256 colors, 3 bytes each, 0 to 63 (VGA's 6 bits).
        if (data.length < 768) throw new Error(`A palette is 768 bytes; this is ${bytesLabel(data.length)}.`);
        let over = 0;
        for (let i = 0; i < 768; i++) if (data[i] > 63) over++;
        if (over && data.length !== 768) throw new Error(`This isn't a palette: a palette is 768 bytes of values up to 63, and this is ${bytesLabel(data.length)} with ${over} of its first 768 over 63.`);
        const warnings: string[] = [];
        if (over) warnings.push(`${over} of the 768 values are over 63, more than VGA's 6 bits can hold; the colors shown are likely wrong.`);
        if (data.length > 768) warnings.push(`A palette is 768 bytes, but this file is ${bytesLabel(data.length)}; the rest isn't part of it.`);
        const colors = expandPalette(data.subarray(0, 768));
        return {
            title: 'Palette',
            summary: [
                ['Colors', '256'],
                ['Depth', '6 bits per channel (VGA)'],
            ],
            fields: [
                ...Array.from({ length: 256 }, (_, i) => {
                    const [r, g, b] = data.subarray(i * 3, i * 3 + 3);
                    return field(`Color ${i}`, i * 3, 3, `${r}, ${g}, ${b}`, `#${[colors[i * 3], colors[i * 3 + 1], colors[i * 3 + 2]].map((v) => v.toString(16).padStart(2, '0')).join('')} on screen`);
                }),
                ...(data.length > 768 ? [field('Rest of the file', 768, data.length - 768, bytesLabel(data.length - 768), 'Not part of a palette.')] : []),
            ],
            preview: { kind: 'palette', colors },
            warnings,
        };
    },
};

export default parser;
