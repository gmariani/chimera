/**
 * Team colors. Unit and building art leaves 16 palette entries for the owner's
 * color, and the game swaps them for the owner's ramp of shades: entries 176–191
 * in TD, 80–95 in RA, 16–31 in TS and RA2.
 *
 * The ramps here are made from each color's base shade, light to dark. The
 * games build theirs from tables of their own, so the shades are close rather
 * than exact.
 */

export type RemapRange = [number, number];

export const TD_REMAP: RemapRange = [176, 191];
export const RA_REMAP: RemapRange = [80, 95];
export const TS_REMAP: RemapRange = [16, 31];

export interface TeamColor {
    name: string;
    rgb: [number, number, number];
}

export const TEAM_COLORS: TeamColor[] = [
    { name: 'Gold', rgb: [246, 214, 121] },
    { name: 'Red', rgb: [228, 52, 44] },
    { name: 'Blue', rgb: [60, 108, 228] },
    { name: 'Light blue', rgb: [110, 186, 236] },
    { name: 'Green', rgb: [86, 186, 70] },
    { name: 'Orange', rgb: [242, 142, 42] },
    { name: 'Purple', rgb: [160, 84, 214] },
    { name: 'Teal', rgb: [60, 196, 186] },
    { name: 'Pink', rgb: [236, 120, 186] },
    { name: 'Gray', rgb: [176, 176, 176] },
    { name: 'Brown', rgb: [168, 116, 70] },
];

/** The 16 shades of a color, lightest first, as the remap range wants them. */
export function ramp(rgb: [number, number, number]): [number, number, number][] {
    return Array.from({ length: 16 }, (_, i) => {
        const k = 1.08 - i * 0.055;
        return rgb.map((c) => Math.max(0, Math.min(255, Math.round(c * k)))) as [number, number, number];
    });
}

/** A copy of a palette (8-bit RGB) with the remap range in a team's shades. */
export function teamPalette(palette: Uint8Array, range: RemapRange, rgb: [number, number, number]): Uint8Array {
    const out = palette.slice();
    const shades = ramp(rgb);
    for (let i = range[0]; i <= range[1]; i++) out.set(shades[((i - range[0]) * (16 / (range[1] - range[0] + 1))) | 0], i * 3);
    return out;
}

/**
 * For drawing into an image that keeps one palette: each index to draw instead,
 * the remap range sent to the palette's nearest matches for the team's shades.
 */
export function teamRemap(palette: Uint8Array, range: RemapRange, rgb: [number, number, number]): Uint8Array {
    const table = Uint8Array.from({ length: 256 }, (_, i) => i);
    const shades = ramp(rgb);
    for (let i = range[0]; i <= range[1]; i++) {
        const [r, g, b] = shades[((i - range[0]) * (16 / (range[1] - range[0] + 1))) | 0];
        let best = 0;
        let bestDistance = Infinity;
        for (let j = 1; j < 256; j++) {
            // Not into the remap range itself, or the result would be recolored again.
            if (j >= range[0] && j <= range[1]) continue;
            const d = (palette[j * 3] - r) ** 2 + (palette[j * 3 + 1] - g) ** 2 + (palette[j * 3 + 2] - b) ** 2;
            if (d < bestDistance) [best, bestDistance] = [j, d];
        }
        table[i] = best;
    }
    return table;
}

/** Which of TD's and RA's ranges a sprite uses: whichever more of its pixels fall in. */
export function guessRemap(frames: { pixels: Uint8Array }[]): RemapRange {
    let td = 0;
    let ra = 0;
    for (const f of frames) {
        for (const p of f.pixels) {
            if (p >= TD_REMAP[0] && p <= TD_REMAP[1]) td++;
            else if (p >= RA_REMAP[0] && p <= RA_REMAP[1]) ra++;
        }
    }
    return td > ra ? TD_REMAP : RA_REMAP;
}
