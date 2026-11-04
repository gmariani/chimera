import { field } from '../../core/bytes';
import type { Field, FormatParser, IndexedImage } from '../../core/types';

/**
 * Colour remap tables (.mrf) from TD's theater archives, which the game builds
 * from the theater's palette (DISPLAY.CPP, Init_Theater). The name is the
 * theater's first letter and what the table is for: TGREEN.MRF.
 *
 * A fading table is 256 bytes: the colour to draw in place of each colour. A
 * translucency table is 256 bytes saying which of the tables after it each
 * colour uses (0xFF: none, it's drawn as it is), then one 256-byte table per
 * translucent colour: what each colour behind it turns into.
 */

const PURPOSES: Record<string, string> = {
    GREEN: 'Every colour faded toward green',
    YELLOW: 'Every colour faded toward yellow',
    RED: 'Every colour faded toward red',
    SHADE: 'Every colour darkened',
    LIGHT: 'Every colour lightened',
    MOUSE: 'Translucent colours for the mouse cursor',
    TRANS: 'Translucent colours for effects',
    WHITE: 'Translucent white',
    SHADOW: 'Shadows',
    UNITS: 'Unit shadows',
    CLOCK: 'The sidebar\'s build clock',
};
const THEATERS: Record<string, string> = { T: 'Temperate', D: 'Desert', W: 'Winter', J: 'Jungle' };

const SWATCH = 8;

/** A table as a 16 × 16 grid of swatches: for each colour, the one it becomes. */
function swatches(table: ArrayLike<number>): IndexedImage {
    const size = 16 * SWATCH;
    const pixels = new Uint8Array(size * size);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) pixels[y * size + x] = table[Math.floor(y / SWATCH) * 16 + Math.floor(x / SWATCH)];
    return { width: size, height: size, pixels };
}

const identity = Array.from({ length: 256 }, (_, i) => i);

const parser: FormatParser = {
    parse(data, context) {
        const count = Math.floor(data.length / 256);
        if (count === 0) throw new Error('A remap table is 256 bytes; this is shorter.');
        const warnings = data.length % 256 ? [`${data.length % 256} bytes after the last whole table.`] : [];
        const stem = context.name?.replace(/\.[^.]+$/, '').toUpperCase() ?? '';
        const purpose = PURPOSES[stem.slice(1)];
        const theater = purpose ? THEATERS[stem[0]] : undefined;
        const tables = Array.from({ length: count }, (_, i) => data.subarray(i * 256, (i + 1) * 256));
        const summary: [string, string][] = [];
        if (purpose) summary.push(['For', purpose]);
        if (theater) summary.push(['Theater', theater]);

        let fields: Field[];
        let frames: IndexedImage[];
        if (count === 1) {
            summary.push(['Kind', 'Fading: each colour is replaced by another']);
            fields = [{ name: 'Remap', offset: 0, length: 256, children: identity.map((i) => field(`Colour ${i}`, i, 1, data[i])) }];
            frames = [swatches(identity), swatches(data)];
        } else {
            const [selector, ...blends] = tables;
            const users = blends.map((_, t) => identity.filter((c) => selector[c] === t));
            summary.push(['Kind', 'Translucency: colours that let the one behind show through'], ['Translucent colours', String(identity.filter((c) => selector[c] !== 0xff).length)]);
            fields = [
                { name: 'Which table each colour uses', offset: 0, length: 256, note: '0xFF: none, the colour is drawn as it is.', children: identity.map((i) => field(`Colour ${i}`, i, 1, selector[i] === 0xff ? 'None' : `Table ${selector[i] + 1}`)) },
                ...blends.map((t, i) => ({
                    name: `Table ${i + 1}`,
                    offset: (i + 1) * 256,
                    length: 256,
                    value: users[i].length ? `for colour ${users[i].join(', ')}` : 'unused',
                    note: 'What each colour behind turns into.',
                    children: identity.map((c) => field(`Behind: ${c}`, (i + 1) * 256 + c, 1, t[c])),
                })),
            ];
            frames = [swatches(identity), ...blends.map((t) => swatches(t))];
        }

        return {
            title: 'Colour remap tables (MRF)',
            summary: [...summary, ['Tables', String(count)], ['Preview', 'The palette, then each table applied to it; pick the theater\'s palette']],
            fields,
            preview: { kind: 'images', frames },
            warnings,
        };
    },
};

export default parser;
