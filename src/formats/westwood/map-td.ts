import { field } from '../../core/bytes';
import type { FormatParser } from '../../core/types';
import { renderMap, terrainPalette } from './map';
import { TD_TEMPLATES } from './templates';

/**
 * TD map terrain (.bin, next to the mission's .ini): 64 × 64 cells, row by
 * row, two bytes each: the template, then which of its tiles. 0xFF is clear
 * ground. The INI says which part of the grid is playable.
 */
const SIZE = 64;

const parser: FormatParser = {
    parse(data) {
        if (data.length !== SIZE * SIZE * 2) throw new Error(`A TD map is ${SIZE * SIZE * 2} bytes; this is ${data.length}.`);
        const templates = Array.from({ length: SIZE * SIZE }, (_, i) => data[i * 2]);
        const { image, counts, unknown } = renderMap({ game: 'td', size: SIZE, templates });
        const used = new Set(templates.filter((t) => t !== 0xff));

        return {
            title: 'Map terrain (TD)',
            summary: [
                ['Size', `${SIZE} × ${SIZE} cells`],
                ['Templates used', String(used.size)],
                ...counts.map(([label, n]) => [label, `${n} cells`] as [string, string]),
            ],
            fields: Array.from({ length: SIZE }, (_, y) => ({
                name: `Row ${y}`,
                offset: y * SIZE * 2,
                length: SIZE * 2,
                children: Array.from({ length: SIZE }, (_, x) => {
                    const at = (y * SIZE + x) * 2;
                    const id = data[at];
                    return field(`Cell ${x}, ${y}`, at, 2, id === 0xff ? 'Clear' : `${TD_TEMPLATES[id]?.name ?? `Template ${id}`}, tile ${data[at + 1]}`);
                }),
            })),
            preview: { kind: 'images', frames: [image], palette: terrainPalette() },
            warnings: unknown ? [`${unknown} cells use templates the game doesn't define.`] : [],
        };
    },
};

export default parser;
