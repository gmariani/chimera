import type { IndexedImage } from '../../core/types';
import { lcw } from './compression';
import { RA_TEMPLATES, TD_TEMPLATES, type Template } from './templates';

/**
 * Map terrain: for each cell, a template and which of its tiles. TD keeps a
 * 64 × 64 grid in a .bin file next to the mission's INI; RA packs a 128 × 128
 * grid into the INI itself ([MapPack], base64 of LCW blocks), with ore, gems
 * and walls in [OverlayPack].
 *
 * Drawing the real tiles needs the theater's archive, so the preview colours
 * each cell by the kind of terrain its template is.
 */

export const CELL_PIXELS = 4;

/** Terrain kinds: preview palette index, label, colour. */
const KINDS = [
    ['Clear', [92, 112, 56]],
    ['Water', [36, 72, 140]],
    ['Shore', [196, 176, 112]],
    ['Cliffs', [96, 76, 56]],
    ['Road', [150, 140, 120]],
    ['River', [72, 120, 176]],
    ['Rough ground', [122, 120, 72]],
    ['Boulders', [128, 112, 96]],
    ['Bridges and fords', [168, 132, 84]],
    ['Floors (interior)', [110, 110, 120]],
    ['Walls (interior)', [60, 60, 70]],
    ['Unknown template', [200, 0, 200]],
    ['Ore', [216, 180, 40]],
    ['Gems', [64, 200, 220]],
    ['Wall or fence', [235, 235, 235]],
    ['Crate or flag', [220, 60, 60]],
] as const;
const KIND = Object.fromEntries(KINDS.map(([label], i) => [label, i])) as Record<(typeof KINDS)[number][0], number>;

export function terrainPalette(): Uint8Array {
    const palette = new Uint8Array(768);
    KINDS.forEach(([, rgb], i) => palette.set(rgb, i * 3));
    return palette;
}

function kindOf(template: Template | undefined): number {
    if (!template) return KIND['Unknown template'];
    const prefix = template.name.replace(/\d.*$/, '');
    switch (prefix) {
        case 'CLEAR':
            return KIND.Clear;
        case 'W':
        case 'WC':
            return KIND.Water;
        case 'SH':
            return KIND.Shore;
        case 'S':
        case 'RC':
        case 'HILL':
            return KIND.Cliffs;
        case 'D':
        case 'F':
            return KIND.Road;
        case 'RV':
            return KIND.River;
        case 'P':
        case 'RF':
            return KIND['Rough ground'];
        case 'B':
            return KIND.Boulders;
        case 'BR':
        case 'BRIDGE':
        case 'FORD':
        case 'FALLS':
            // TD's BR templates are boulders; RA's are bridges.
            return template.name.startsWith('BRIDGE') || !/^BR\d+$/.test(template.name) ? KIND['Bridges and fords'] : KIND.Boulders;
        case 'ARRO':
        case 'FLOR':
        case 'GFLR':
        case 'GSTR':
        case 'STRP':
        case 'XTRA':
            return KIND['Floors (interior)'];
        case 'WALL':
        case 'LWAL':
            return KIND['Walls (interior)'];
        default:
            return KIND['Unknown template'];
    }
}

/** RA overlays by ID (OverlayType in DEFINES.H). */
const RA_OVERLAYS = [
    'Sandbag wall', 'Chain-link wall', 'Concrete wall', 'Barbed wire', 'Wooden fence', 'Ore', 'Ore', 'Ore', 'Ore', 'Gems', 'Gems', 'Gems', 'Gems',
    'V12', 'V13', 'V14', 'V15', 'V16', 'V17', 'V18', 'Flag spot', 'Wooden crate', 'Steel crate', 'Fence', 'Water crate',
];

function overlayKind(id: number): number | null {
    const name = RA_OVERLAYS[id];
    if (!name) return null;
    if (name === 'Ore') return KIND.Ore;
    if (name === 'Gems') return KIND.Gems;
    if (/wall|wire|fence/i.test(name)) return KIND['Wall or fence'];
    if (/crate|flag/i.test(name)) return KIND['Crate or flag'];
    return null;
}

export interface MapGrid {
    game: 'td' | 'ra';
    /** Cells along each side. */
    size: number;
    /** The template in each cell, row by row. */
    templates: ArrayLike<number>;
    /** RA's overlay in each cell; 0xFF for none. */
    overlays?: ArrayLike<number>;
    /** Only draw (and count) this part: the playable area. */
    area?: { x: number; y: number; width: number; height: number };
}

/**
 * Cells with nothing on them. RA's own maps still say 255 (TD's value) for clear
 * ground, and RA's CELL.CPP draws 255 as clear too, though it's also ARRO0003's ID.
 */
const isClear = (id: number) => id === 0 || id === 0xff || id === 0xffff;

/** Each cell as a CELL_PIXELS square in its terrain kind's colour, plus how many cells of each kind. */
export function renderMap({ game, size, templates, overlays, area = { x: 0, y: 0, width: size, height: size } }: MapGrid): { image: IndexedImage; counts: [string, number][]; unknown: number } {
    const table = game === 'td' ? TD_TEMPLATES : RA_TEMPLATES;
    const width = area.width * CELL_PIXELS;
    const pixels = new Uint8Array(width * area.height * CELL_PIXELS);
    const counts = new Array<number>(KINDS.length).fill(0);
    let unknown = 0;
    for (let cy = 0; cy < area.height; cy++) {
        for (let cx = 0; cx < area.width; cx++) {
            const cell = (area.y + cy) * size + area.x + cx;
            const id = templates[cell];
            let kind = isClear(id) ? KIND.Clear : kindOf(table[id]);
            if (kind === KIND['Unknown template']) unknown++;
            const overlay = overlays && overlays[cell] !== 0xff ? overlayKind(overlays[cell]) : null;
            if (overlay !== null) kind = overlay;
            counts[kind]++;
            for (let dy = 0; dy < CELL_PIXELS; dy++) {
                const row = (cy * CELL_PIXELS + dy) * width + cx * CELL_PIXELS;
                pixels.fill(kind, row, row + CELL_PIXELS);
            }
        }
    }
    return { image: { width, height: area.height * CELL_PIXELS, pixels }, counts: counts.map((n, i) => [KINDS[i][0], n] as [string, number]).filter(([, n]) => n > 0), unknown };
}

/**
 * RA's packed INI sections: the entries' values joined and base64-decoded give
 * blocks of a 2-byte compressed size, a 2-byte decoded size, then LCW data.
 */
export function unpackSection(base64: string, size: number): Uint8Array {
    const packed = Uint8Array.from(atob(base64.replace(/[^A-Za-z0-9+/]/g, '')), (c) => c.charCodeAt(0));
    const out = new Uint8Array(size);
    let s = 0;
    let d = 0;
    while (s + 4 <= packed.length && d < size) {
        const compressed = packed[s] | (packed[s + 1] << 8);
        const decoded = packed[s + 2] | (packed[s + 3] << 8);
        lcw(packed.subarray(s + 4, s + 4 + compressed), out.subarray(d, d + decoded));
        s += 4 + compressed;
        d += decoded;
    }
    return out;
}
