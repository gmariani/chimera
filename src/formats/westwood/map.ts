import type { Companion, IndexedImage, Preview } from '../../core/types';
import type { Ini } from '../ini-sections';
import type { Links } from '../links';
import { lcw } from './compression';
import { decodeShp, type Shp } from './shp-frames';
import { sniffShpTd } from './sniff';
import { RA_TEMPLATES, TD_TEMPLATES, type Template } from './templates';
import { EMPTY_CELL, readTileSet, type TileSet } from './tileset';
import { expandPalette } from './vga';

/**
 * Map terrain: for each cell, a template and which of its tiles. TD keeps a
 * 64 × 64 grid in a .bin file next to the mission's INI; RA packs a 128 × 128
 * grid into the INI itself ([MapPack], base64 of LCW blocks), with ore, gems
 * and walls in [OverlayPack]. TD lists its overlays in the INI's [OVERLAY], and
 * both list trees and rocks in [TERRAIN].
 *
 * Every map gets a picture coloured by the kind of terrain in each cell. When
 * the theater's archive has been opened too, it's also drawn with the game's
 * own tiles and sprites.
 */

export const CELL_PIXELS = 4;
const TILE = 24;

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
    ['Ore or Tiberium', [216, 180, 40]],
    ['Gems', [64, 200, 220]],
    ['Wall or fence', [235, 235, 235]],
    ['Crate or flag', [220, 60, 60]],
    ['Trees and rocks', [36, 70, 30]],
] as const;
type KindLabel = (typeof KINDS)[number][0];
const KIND = Object.fromEntries(KINDS.map(([label], i) => [label, i])) as Record<KindLabel, number>;

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

/** RA overlays by ID (OverlayType in DEFINES.H), as INI names, which are also their sprites' names. */
const RA_OVERLAYS = [
    'SBAG', 'CYCL', 'BRIK', 'BARB', 'WOOD', 'GOLD01', 'GOLD02', 'GOLD03', 'GOLD04', 'GEM01', 'GEM02', 'GEM03', 'GEM04',
    'V12', 'V13', 'V14', 'V15', 'V16', 'V17', 'V18', 'FPLS', 'WCRATE', 'SCRATE', 'FENC', 'WWCRATE',
];

const WALLS = new Set(['SBAG', 'CYCL', 'BRIK', 'BARB', 'WOOD', 'FENC']);
const isOre = (name: string) => /^(TI\d+|GOLD\d+)$/.test(name);
const isGems = (name: string) => /^GEM\d+$/.test(name);
/** Ore, gems, Tiberium and the V12–V18 field props look different in each theater; walls and crates don't. */
const theaterSpecific = (name: string) => isOre(name) || isGems(name) || /^V1[2-8]$/.test(name);

function overlayKind(name: string): number | null {
    if (isOre(name)) return KIND['Ore or Tiberium'];
    if (isGems(name)) return KIND.Gems;
    if (WALLS.has(name)) return KIND['Wall or fence'];
    if (/CRATE|FPLS/.test(name)) return KIND['Crate or flag'];
    return null;
}

export interface Area {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** Everything about a map that drawing it needs. */
export interface Mission {
    game: 'td' | 'ra';
    /** Cells along each side. */
    size: number;
    /** The template in each cell, row by row. */
    templates: ArrayLike<number>;
    /** Which of its template's tiles each cell shows. */
    icons: ArrayLike<number>;
    /** The overlay's name in each cell (ore, walls, crates), upper case. */
    overlays: (string | null)[];
    /** Trees and rocks: cell → name. */
    terrain: Map<number, string>;
    /** The playable part, from the INI's [Map]. */
    area?: Area;
    /** The INI's Theater= value. */
    theater?: string;
}

/**
 * Cells with nothing on them. RA's own maps still say 255 (TD's value) for clear
 * ground, and RA's CELL.CPP draws 255 as clear too, though it's also ARRO0003's ID.
 */
const isClear = (id: number) => id === 0 || id === 0xff || id === 0xffff;

const wholeMap = (size: number): Area => ({ x: 0, y: 0, width: size, height: size });

/** Each cell as a CELL_PIXELS square in its terrain kind's colour, plus how many cells of each kind. */
export function renderMap(m: Mission): { image: IndexedImage; counts: [string, number][]; unknown: number } {
    const { size, templates, overlays, terrain, area = wholeMap(size) } = m;
    const table = m.game === 'td' ? TD_TEMPLATES : RA_TEMPLATES;
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
            const overlay = overlays[cell] ? overlayKind(overlays[cell]) : null;
            if (overlay !== null) kind = overlay;
            if (terrain.has(cell)) kind = KIND['Trees and rocks'];
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

export const TD_SIZE = 64;
export const RA_SIZE = 128;

/** Cell → the first comma-separated value, for [TERRAIN] and TD's [OVERLAY] ("1234=T01,None"). */
function cellNames(ini: Ini, section: string, size: number): Map<number, string> {
    const out = new Map<number, string>();
    for (const [key, value] of ini.entries(section)) {
        const cell = Number(key);
        if (Number.isInteger(cell) && cell >= 0 && cell < size * size) out.set(cell, value.split(',')[0].trim().toUpperCase());
    }
    return out;
}

function playableArea(ini: Ini, size: number): Area | undefined {
    const [x, y, width, height] = ['X', 'Y', 'Width', 'Height'].map((k) => Number(ini.get('Map', k)));
    return width > 0 && height > 0 && x >= 0 && y >= 0 && x + width <= size && y + height <= size ? { x, y, width, height } : undefined;
}

/** RA: everything's in the INI. Throws if [MapPack] can't be decoded. */
export function raMission(ini: Ini): Mission {
    const cells = RA_SIZE * RA_SIZE;
    const joined = (name: string) => ini.section(name)!.entries.map((e) => e.value).join('');
    const raw = unpackSection(joined('MapPack'), cells * 3);
    const templates = new Uint16Array(cells);
    for (let i = 0; i < cells; i++) templates[i] = raw[i * 2] | (raw[i * 2 + 1] << 8);
    const packed = ini.section('OverlayPack') ? unpackSection(joined('OverlayPack'), cells) : null;
    return {
        game: 'ra',
        size: RA_SIZE,
        templates,
        icons: raw.subarray(cells * 2),
        overlays: Array.from({ length: cells }, (_, i) => (packed && packed[i] !== 0xff ? (RA_OVERLAYS[packed[i]] ?? null) : null)),
        terrain: cellNames(ini, 'TERRAIN', RA_SIZE),
        area: playableArea(ini, RA_SIZE),
        theater: ini.get('Map', 'Theater'),
    };
}

/** TD: the grid from the .bin; overlays, trees, the playable area and the theater from the INI, if there is one. */
export function tdMission(bin: Uint8Array, ini: Ini | null): Mission {
    const cells = TD_SIZE * TD_SIZE;
    const overlays = ini ? cellNames(ini, 'OVERLAY', TD_SIZE) : new Map<number, string>();
    return {
        game: 'td',
        size: TD_SIZE,
        templates: Array.from({ length: cells }, (_, i) => bin[i * 2]),
        icons: Array.from({ length: cells }, (_, i) => bin[i * 2 + 1]),
        overlays: Array.from({ length: cells }, (_, i) => overlays.get(i) ?? null),
        terrain: ini ? cellNames(ini, 'TERRAIN', TD_SIZE) : new Map(),
        area: ini ? playableArea(ini, TD_SIZE) : undefined,
        theater: ini?.get('Map', 'Theater'),
    };
}

/** Each theater's tile set extension and archive (and palette) name. */
const THEATERS: Record<'td' | 'ra', Record<string, { ext: string; root: string }>> = {
    td: { TEMPERATE: { ext: 'tem', root: 'temperat' }, DESERT: { ext: 'des', root: 'desert' }, WINTER: { ext: 'win', root: 'winter' }, JUNGLE: { ext: 'jun', root: 'jungle' } },
    ra: { TEMPERATE: { ext: 'tem', root: 'temperat' }, SNOW: { ext: 'sno', root: 'snow' }, INTERIOR: { ext: 'int', root: 'interior' } },
};

export type Finder = (name: string) => Companion[];

/** RA's Tiberium_Adjust: ore looks denser the more ore is around it; gems have fewer stages. */
const ORE_FRAMES = [0, 1, 3, 4, 6, 7, 8, 10, 11];
const GEM_FRAMES = [0, 0, 0, 1, 1, 1, 2, 2, 2];

/** For each colour, the nearest one at about half its brightness: how the game darkens what's under a shadow. */
function shadeTable(palette: Uint8Array): Uint8Array {
    const out = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
        const [r, g, b] = [palette[i * 3] / 2, palette[i * 3 + 1] / 2, palette[i * 3 + 2] / 2];
        let best = 0;
        let bestDistance = Infinity;
        for (let j = 1; j < 256; j++) {
            const d = (palette[j * 3] - r) ** 2 + (palette[j * 3 + 1] - g) ** 2 + (palette[j * 3 + 2] - b) ** 2;
            if (d < bestDistance) [best, bestDistance] = [j, d];
        }
        out[i] = best;
    }
    return out;
}

const identityTable = Uint8Array.from({ length: 256 }, (_, i) => i);

export type TileRender =
    | { status: 'drawn'; image: IndexedImage; palette?: Uint8Array; wanted?: string }
    | { status: 'needs'; wanted: string };

const GAME_NAMES = { td: 'Tiberian Dawn', ra: 'Red Alert' };

/** The map drawn the way the game draws it, from the theater's tile sets and sprites; what it used goes in `links`. */
export function renderTiles(m: Mission, find: Finder, links: Links): TileRender {
    const theater = THEATERS[m.game][(m.theater ?? 'TEMPERATE').toUpperCase()];
    if (!theater) return { status: 'needs', wanted: `This map's theater, ${m.theater}, isn't one the app knows how to draw.` };
    const { size, templates, icons, overlays, terrain, area = wholeMap(size) } = m;
    const table = m.game === 'td' ? TD_TEMPLATES : RA_TEMPLATES;
    const archive = `${theater.root.toUpperCase()}.MIX`;

    // Tile sets of the right game; the palette from the same archive as the first one found.
    const tileSets = new Map<number, TileSet | null>();
    let source: string | null = null;
    const tileSet = (id: number): TileSet | null => {
        if (!tileSets.has(id)) {
            const file = `${table[id]?.name.toLowerCase()}.${theater.ext}`;
            // Expansions can keep extra templates in another archive, so the same one is only a preference.
            const candidates = find(file).filter((c) => readTileSet(c.data)?.layout.game === m.game);
            const found = candidates.find((c) => c.source === source) ?? candidates[0];
            if (found) {
                source ??= found.source;
                links.use(file, found, `Tile set (in ${archive})`);
            } else if (table[id]) {
                links.miss(file, `Tile set (in ${archive})`);
            }
            tileSets.set(id, found ? readTileSet(found.data) : null);
        }
        return tileSets.get(id)!;
    };
    const clear = tileSet(0);
    if (!clear) return { status: 'needs', wanted: `Open ${archive} from ${GAME_NAMES[m.game]} as well to draw this map with the game's own tiles${m.game === 'ra' ? ` (it's inside MAIN.MIX, so opening MAIN.MIX does it)` : ''}.` };
    // Without the theater's palette the map is still drawn, in whichever palette the app has picked.
    // Both games have a TEMPERAT.PAL; one from an archive holding the other game's tiles is the wrong one.
    const otherGame = new Set(find(`clear1.${theater.ext}`).filter((c) => readTileSet(c.data)?.layout.game !== m.game).map((c) => c.source));
    const pal = find(`${theater.root}.pal`)
        .filter((c) => c.data.length === 768 && !otherGame.has(c.source))
        .sort((a, b) => Number(b.source === source) - Number(a.source === source))[0];
    const palette = pal ? expandPalette(pal.data) : undefined;
    if (pal) links.use(`${theater.root}.pal`, pal, 'Palette');
    else links.miss(`${theater.root}.pal`, `Palette (in ${m.game === 'ra' ? 'REDALERT.MIX' : archive})`);
    const wanted = pal ? undefined : `The colours need ${theater.root.toUpperCase()}.PAL, which is in ${m.game === 'ra' ? 'REDALERT.MIX' : archive}. Open that as well, or pick the palette beside the map.`;
    const shade = palette ? shadeTable(palette) : identityTable;

    const width = area.width * TILE;
    const height = area.height * TILE;
    const pixels = new Uint8Array(width * height);
    const blit = (src: Uint8Array, srcWidth: number, srcHeight: number, x: number, y: number, sprite: boolean) => {
        for (let sy = 0; sy < srcHeight; sy++) {
            const dy = y + sy;
            if (dy < 0 || dy >= height) continue;
            for (let sx = 0; sx < srcWidth; sx++) {
                const dx = x + sx;
                if (dx < 0 || dx >= width) continue;
                const p = src[sy * srcWidth + sx];
                if (sprite && p === 0) continue;
                // Sprites mark shadow with colour 4.
                pixels[dy * width + dx] = sprite && p === 4 ? shade[pixels[dy * width + dx]] : p;
            }
        }
    };

    for (let cy = 0; cy < area.height; cy++) {
        for (let cx = 0; cx < area.width; cx++) {
            const [x, y] = [area.x + cx, area.y + cy];
            const cell = y * size + x;
            const id = templates[cell];
            const set = isClear(id) ? null : tileSet(id);
            const clearIcon = (x & 3) | ((y & 3) << 2);
            const tile = set && set.cells[icons[cell]] !== EMPTY_CELL ? set.tiles[set.cells[icons[cell]]] : clear.tiles[clear.cells[clearIcon % clear.cells.length]];
            if (tile) blit(tile, TILE, TILE, cx * TILE, cy * TILE, false);
        }
    }

    // Sprites: theater-specific ones share the tile sets' extension; the rest are plain SHPs.
    const sprites = new Map<string, Shp | null>();
    const sprite = (name: string, theaterArt: boolean): Shp | null => {
        const file = `${name.toLowerCase()}.${theaterArt ? theater.ext : 'shp'}`;
        if (!sprites.has(file)) {
            const candidates = find(file).filter((c) => sniffShpTd(c.data));
            const found = candidates.find((c) => c.source === source) ?? candidates[0];
            const role = theaterArt ? `Sprite (in ${archive})` : `Sprite (walls and crates are in CONQUER.MIX${m.game === 'ra' ? ', inside MAIN.MIX' : ''})`;
            if (found) links.use(file, found, role);
            else links.miss(file, role);
            sprites.set(file, found ? decodeShp(found.data) : null);
        }
        return sprites.get(file)!;
    };
    const at = (x: number, y: number) => (x >= 0 && y >= 0 && x < size && y < size ? overlays[y * size + x] : null);
    const inArea = (x: number, y: number) => x >= area.x && y >= area.y && x < area.x + area.width && y < area.y + area.height;

    for (let cell = 0; cell < size * size; cell++) {
        const name = overlays[cell];
        const [x, y] = [cell % size, Math.floor(cell / size)];
        if (!name || !inArea(x, y)) continue;
        let frame = 0;
        if (isOre(name) || isGems(name)) {
            let count = 0;
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && ((n) => n && (isOre(n) || isGems(n)))(at(x + dx, y + dy))) count++;
            frame = (isGems(name) ? GEM_FRAMES : ORE_FRAMES)[count];
        } else if (WALLS.has(name)) {
            // Wall_Update: a bit for each neighbour of the same wall, N E S W.
            frame = [at(x, y - 1), at(x + 1, y), at(x, y + 1), at(x - 1, y)].reduce((bits, n, i) => bits | (n === name ? 1 << i : 0), 0);
        }
        const shp = sprite(name, theaterSpecific(name));
        const image = shp?.frames[Math.min(frame, shp.frames.length - 1)];
        if (image) blit(image.pixels, image.width, image.height, (x - area.x) * TILE, (y - area.y) * TILE, true);
    }

    // Trees and rocks are drawn from their cell's top left, and can reach into the cells below and right.
    for (const [cell, name] of [...terrain].sort(([a], [b]) => a - b)) {
        const [x, y] = [cell % size, Math.floor(cell / size)];
        const image = sprite(name, true)?.frames[0];
        if (image) blit(image.pixels, image.width, image.height, (x - area.x) * TILE, (y - area.y) * TILE, true);
    }

    return { status: 'drawn', image: { width, height, pixels }, palette, wanted };
}

/** A mission's map as previews (real tiles when they're available, and terrain kinds), with summary rows. */
export function missionPreviews(m: Mission, find: Finder | undefined, links: Links): { items: { title: string; preview: Preview }[]; summary: [string, string][]; warnings: string[]; wanted?: string } {
    const { image, counts, unknown } = renderMap(m);
    const summary: [string, string][] = [['Map', `${m.size} × ${m.size} cells${m.area ? `, playable ${m.area.width} × ${m.area.height} at ${m.area.x}, ${m.area.y} (shown)` : ''}`]];
    if (m.theater) summary.push(['Theater', m.theater]);
    summary.push(...counts.map(([label, n]) => [label, `${n} cells`] as [string, string]));
    const warnings = unknown ? [`${unknown} map cells use templates the game doesn't define.`] : [];

    const legend = counts.map(([label]) => ({ label, index: KIND[label as KindLabel] }));
    const kinds: Preview = { kind: 'images', frames: [image], palette: terrainPalette(), legend };
    const tiles = find ? renderTiles(m, find, links) : null;
    if (tiles?.status !== 'drawn') return { items: [{ title: 'Terrain kinds', preview: kinds }], summary, warnings, wanted: tiles?.wanted };
    return {
        wanted: tiles.wanted,
        items: [
            { title: 'Map', preview: { kind: 'images', frames: [tiles.image], palette: tiles.palette } },
            { title: 'Terrain kinds', preview: kinds },
        ],
        summary,
        warnings,
    };
}
