import type { Field, FormatParser, IndexedImage } from '../../core/types';
import { VORTEX_SIZE } from './sniff';

/**
 * RA's chronal vortex, one frame per file: HOLE0000.LUT to HOLE0047.LUT, 16
 * frames each of growing, spinning and shrinking (VORTEX.CPP). For each of the
 * vortex's 64 × 64 pixels, three bytes: the x and y of the screen pixel to copy
 * from, and a shade (0 darkest, 15 unchanged) to darken it by.
 */

const SHADES = 16;
/** Own palette: a color per 8 × 8 block of a test grid for where pixels come from, then the shades as grays. */
const GRID = 8;
const SHADE_BASE = GRID * GRID;

function palette(): Uint8Array {
    const out = new Uint8Array(768);
    for (let y = 0; y < GRID; y++) {
        for (let x = 0; x < GRID; x++) {
            const check = (x + y) % 2 ? 1 : 0.7;
            out.set([((x * 255) / (GRID - 1)) * check, ((y * 255) / (GRID - 1)) * check, 160 * check], (y * GRID + x) * 3);
        }
    }
    // The game fades shade i toward black by (240 - 16i) / 256 (Build_Fading_Table).
    for (let i = 0; i < SHADES; i++) out.fill(Math.round(255 * (1 - (240 - 16 * i) / 256)), (SHADE_BASE + i) * 3, (SHADE_BASE + i + 1) * 3);
    return out;
}

const parser: FormatParser = {
    parse(data, context) {
        if (data.length !== VORTEX_SIZE * VORTEX_SIZE * 3) throw new Error(`A vortex frame is ${VORTEX_SIZE * VORTEX_SIZE * 3} bytes; this is ${data.length}.`);
        const size = VORTEX_SIZE * VORTEX_SIZE;
        const warp = new Uint8Array(size);
        const shade = new Uint8Array(size);
        for (let i = 0; i < size; i++) {
            const [x, y, s] = [data[i * 3], data[i * 3 + 1], data[i * 3 + 2]];
            warp[i] = Math.floor(y / GRID) * GRID + Math.floor(x / GRID);
            shade[i] = SHADE_BASE + Math.min(s, SHADES - 1);
        }
        const frames: IndexedImage[] = [warp, shade].map((pixels) => ({ width: VORTEX_SIZE, height: VORTEX_SIZE, pixels }));
        const number = context.name?.match(/(\d+)\.lut$/i);
        const frame = number ? Number(number[1]) : null;
        const stage = frame === null ? null : ['growing', 'spinning', 'shrinking'][Math.floor(frame / 16)];

        const fields: Field[] = Array.from({ length: VORTEX_SIZE }, (_, y) => ({
            name: `Row ${y}`,
            offset: y * VORTEX_SIZE * 3,
            length: VORTEX_SIZE * 3,
            children: Array.from({ length: VORTEX_SIZE }, (_, x) => {
                const at = (y * VORTEX_SIZE + x) * 3;
                return { name: `Pixel ${x}, ${y}`, offset: at, length: 3, value: `from ${data[at]}, ${data[at + 1]}, shade ${data[at + 2]}` };
            }),
        }));

        return {
            title: 'Chronal vortex frame (RA)',
            summary: [
                ['Size', `${VORTEX_SIZE} × ${VORTEX_SIZE} pixels`],
                ...(stage ? [['Frame', `${frame! % 16 + 1} of 16, ${stage}`] as [string, string]] : []),
                ['Preview', 'A test grid pulled through the vortex, then its shading'],
            ],
            fields,
            preview: { kind: 'images', frames, palette: palette() },
            warnings: [],
        };
    },
};

export default parser;
