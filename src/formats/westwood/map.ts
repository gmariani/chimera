import type { Companion, IndexedImage, Preview } from '../../core/types';
import { Ini } from '../ini-sections';
import { Links } from '../links';
import { lcw } from './compression';
import { decodeShp, type Shp } from './shp-frames';
import { sniffShpTd } from './sniff';
import { RA_TEMPLATES, TD_TEMPLATES, type Template } from './templates';
import { RA_REMAP, TD_REMAP, TEAM_COLORS, teamRemap } from './team-colors';
import { EMPTY_CELL, readTileSet, type TileSet } from './tileset';
import { expandPalette } from './vga';
import { pixelBuffer } from '../../core/limits';

/**
 * Map terrain: for each cell, a template and which of its tiles. TD keeps a
 * 64 × 64 grid in a .bin file next to the mission's INI; RA packs a 128 × 128
 * grid into the INI itself ([MapPack], base64 of LCW blocks), with ore, gems
 * and walls in [OverlayPack]. TD lists its overlays in the INI's [OVERLAY], and
 * both list trees and rocks in [TERRAIN].
 *
 * Every map gets a picture colored by the kind of terrain in each cell. When
 * the theater's archive has been opened too, it's also drawn with the game's
 * own tiles and sprites.
 */

export const CELL_PIXELS = 4;
const TILE = 24;

/** Terrain kinds: preview palette index, label, color. */
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
    ['Building', [170, 96, 210]],
    ['Unit or infantry', [240, 70, 70]],
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
    'SBAG',
    'CYCL',
    'BRIK',
    'BARB',
    'WOOD',
    'GOLD01',
    'GOLD02',
    'GOLD03',
    'GOLD04',
    'GEM01',
    'GEM02',
    'GEM03',
    'GEM04',
    'V12',
    'V13',
    'V14',
    'V15',
    'V16',
    'V17',
    'V18',
    'FPLS',
    'WCRATE',
    'SCRATE',
    'FENC',
    'WWCRATE',
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
    /** Units, infantry, buildings, ships and smudges (craters, scorch marks), from the INI. */
    objects: MapObject[];
    /** The playable part, from the INI's [Map]. */
    area?: Area;
    /** The INI's Theater= value. */
    theater?: string;
    /** Red Alert's mission INI, which the game reads over rules.ini (a mission can change an object's art). */
    ini?: Ini;
    /** Waypoints 0–7, where players start on a multiplayer map: [player number, cell]. */
    starts: [number, number][];
}

export interface MapObject {
    kind: 'unit' | 'infantry' | 'building' | 'ship' | 'smudge';
    house: string;
    /** Its type, which is also its sprite's name (MTNK, E1, FACT, CR1). */
    type: string;
    cell: number;
    /** 0–255, clockwise from north. */
    facing: number;
    /** Infantry: where in the cell (0 middle, then the four quarters); smudges: which frame. */
    sub: number;
    /** Out of 256. */
    health: number;
}

/**
 * Objects from a mission INI. Each line is "House,Type,Strength,Cell,Facing,…";
 * infantry put a sub-cell before their mission and facing; smudges are
 * "Type,Cell,Frame" (UNIT.CPP, INFANTRY.CPP, BUILDING.CPP, SMUDGE.CPP).
 */
function readObjects(ini: Ini, size: number): MapObject[] {
    const out: MapObject[] = [];
    const sections: [MapObject['kind'], string][] = [
        ['building', 'STRUCTURES'],
        ['unit', 'UNITS'],
        ['ship', 'SHIPS'],
        ['infantry', 'INFANTRY'],
    ];
    for (const [kind, section] of sections) {
        for (const [, value] of ini.entries(section)) {
            const v = value.split(',').map((x) => x.trim());
            const cell = Number(v[3]);
            if (!Number.isInteger(cell) || cell < 0 || cell >= size * size) continue;
            out.push({
                kind,
                house: v[0].toUpperCase(),
                type: (v[1] ?? '').toUpperCase(),
                cell,
                facing: Number(kind === 'infantry' ? v[6] : v[4]) || 0,
                sub: kind === 'infantry' ? Number(v[4]) || 0 : 0,
                health: Number(v[2]) || 256,
            });
        }
    }
    for (const [, value] of ini.entries('SMUDGE')) {
        const v = value.split(',').map((x) => x.trim());
        const cell = Number(v[1]);
        if (Number.isInteger(cell) && cell >= 0 && cell < size * size) out.push({ kind: 'smudge', house: '', type: v[0].toUpperCase(), cell, facing: 0, sub: Number(v[2]) || 0, health: 256 });
    }
    return out;
}

/** Each side's color, as the games give them by default (GDI and Spain keep the art's own gold). */
const HOUSE_COLORS: Record<string, string | null> = {
    GOODGUY: null,
    BADGUY: 'Red',
    NEUTRAL: null,
    SPECIAL: null,
    JP: null,
    MULTI1: 'Teal',
    MULTI2: 'Light blue',
    MULTI3: 'Red',
    MULTI4: 'Green',
    MULTI5: 'Orange',
    MULTI6: 'Blue',
    MULTI7: 'Gray',
    MULTI8: 'Brown',
    SPAIN: null,
    GREECE: 'Light blue',
    USSR: 'Red',
    ENGLAND: 'Green',
    UKRAINE: 'Orange',
    GERMANY: 'Gray',
    FRANCE: 'Blue',
    TURKEY: 'Brown',
};
/** In RA, GoodGuy is the Allies' light blue. */
const RA_HOUSE_COLORS: Record<string, string | null> = { ...HOUSE_COLORS, GOODGUY: 'Light blue' };

/** TD's and RA's vehicles turn through 32 frames counterclockwise from north (TECHNO.CPP, BodyShape). */
const bodyFrame = (facing: number) => (32 - (((facing + 4) >> 3) & 31)) % 32;
/** Infantry stand in 8 directions (INFANTRY.CPP, HumanShape). */
const HUMAN_SHAPE = [0, 0, 7, 7, 7, 7, 6, 6, 6, 6, 5, 5, 5, 5, 5, 4, 4, 4, 3, 3, 3, 3, 2, 2, 2, 2, 1, 1, 1, 1, 1, 0];
/** Where in a cell infantry stand, in 1/256ths: middle, then the four quarters (CONST.CPP, StoppingCoordAbs). */
const SUB_CELLS = [
    [128, 128],
    [64, 64],
    [192, 64],
    [64, 192],
    [192, 192],
];
/** Defenses that turn: their frames are the 32 facings (then the same again, damaged). */
const TURRET_BUILDINGS = new Set(['GUN', 'AGUN', 'SAM']);
/** Half strength or less: the game shows the damaged frames, the second half of the building's. */
const DAMAGED = 128;
/** Vehicles whose turret is a second set of 32 frames after the body's. */
const TURRETED = new Set(['JEEP', 'BGGY', 'LTNK', 'MTNK', 'HTNK', 'MSAM', '1TNK', '2TNK', '3TNK', '4TNK']);

/**
 * Cells with nothing on them. RA's own maps still say 255 (TD's value) for clear
 * ground, and RA's CELL.CPP draws 255 as clear too, though it's also ARRO0003's ID.
 */
const isClear = (id: number) => id === 0 || id === 0xff || id === 0xffff;

const wholeMap = (size: number): Area => ({ x: 0, y: 0, width: size, height: size });

/** Each cell as a CELL_PIXELS square in its terrain kind's color, plus how many cells of each kind. */
export function renderMap(m: Mission): { image: IndexedImage; counts: [string, number][]; unknown: number } {
    const { size, templates, overlays, terrain, area = wholeMap(size) } = m;
    const marks = new Map<number, number>();
    for (const o of m.objects) if (o.kind !== 'smudge') marks.set(o.cell, o.kind === 'building' ? KIND.Building : KIND['Unit or infantry']);
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
            kind = marks.get(cell) ?? kind;
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
/** A map that places nothing but where players start: no units, infantry, buildings or ships. */
const isMultiplayer = (m: Mission) => !m.objects.some((o) => o.kind !== 'smudge');

/** [Waypoints] 0 to 7: on a multiplayer map, where each player starts (missions use them for their scripts). */
function startCells(ini: Ini, size: number): [number, number][] {
    return ini.entries('Waypoints').flatMap(([key, value]) => {
        const [n, cell] = [Number(key), Number(value)];
        return Number.isInteger(n) && n >= 0 && n < 8 && Number.isInteger(cell) && cell >= 0 && cell < size * size ? [[n, cell] as [number, number]] : [];
    });
}

export function raMission(ini: Ini): Mission {
    const cells = RA_SIZE * RA_SIZE;
    const joined = (name: string) =>
        ini
            .section(name)!
            .entries.map((e) => e.value)
            .join('');
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
        objects: readObjects(ini, RA_SIZE),
        area: playableArea(ini, RA_SIZE),
        theater: ini.get('Map', 'Theater'),
        ini,
        starts: startCells(ini, RA_SIZE),
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
        objects: ini ? readObjects(ini, TD_SIZE) : [],
        area: ini ? playableArea(ini, TD_SIZE) : undefined,
        theater: ini?.get('Map', 'Theater'),
        starts: ini ? startCells(ini, TD_SIZE) : [],
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

/** For each color, the nearest one at about half its brightness: how the game darkens what's under a shadow. */
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

/** The palette's color nearest to this one. */
function nearest(palette: Uint8Array, [r, g, b]: [number, number, number]): number {
    let best = 0;
    let bestDistance = Infinity;
    for (let i = 1; i < 256; i++) {
        const d = (palette[i * 3] - r) ** 2 + (palette[i * 3 + 1] - g) ** 2 + (palette[i * 3 + 2] - b) ** 2;
        if (d < bestDistance) [best, bestDistance] = [i, d];
    }
    return best;
}

/** Player numbers 1 to 8 (for waypoints 0 to 7), 3 × 5. */
const DIGITS = [
    ['.#.', '##.', '.#.', '.#.', '###'],
    ['##.', '..#', '.#.', '#..', '###'],
    ['##.', '..#', '.#.', '..#', '##.'],
    ['#.#', '#.#', '###', '..#', '..#'],
    ['###', '#..', '##.', '..#', '##.'],
    ['.##', '#..', '###', '#.#', '###'],
    ['###', '..#', '.#.', '.#.', '.#.'],
    ['###', '#.#', '###', '#.#', '###'],
];

export type TileRender = { status: 'drawn'; image: IndexedImage; palette?: Uint8Array; wanted?: string } | { status: 'needs'; wanted: string };

const GAME_NAMES = { td: 'Tiberian Dawn', ra: 'Red Alert' };

/** The map drawn the way the game draws it, from the theater's tile sets and sprites; what it used goes in `links`. */
export function renderTiles(m: Mission, find: Finder, links: Links, { starts = true }: { starts?: boolean } = {}): TileRender {
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
    if (!clear)
        return {
            status: 'needs',
            wanted: `Open ${archive} from ${GAME_NAMES[m.game]} as well to draw this map with the game's own tiles${m.game === 'ra' ? ` (it's inside MAIN.MIX, so opening MAIN.MIX does it)` : ''}.`,
        };
    // Without the theater's palette the map is still drawn, in whichever palette the app has picked.
    // Both games have a TEMPERAT.PAL; one from an archive holding the other game's tiles is the wrong one.
    const otherGame = new Set(
        find(`clear1.${theater.ext}`)
            .filter((c) => readTileSet(c.data)?.layout.game !== m.game)
            .map((c) => c.source)
    );
    const pal = find(`${theater.root}.pal`)
        .filter((c) => c.data.length === 768 && !otherGame.has(c.source))
        .sort((a, b) => Number(b.source === source) - Number(a.source === source))[0];
    const palette = pal ? expandPalette(pal.data) : undefined;
    if (pal) links.use(`${theater.root}.pal`, pal, 'Palette');
    else links.miss(`${theater.root}.pal`, `Palette (in ${m.game === 'ra' ? 'REDALERT.MIX' : archive})`);
    const wanted = pal
        ? undefined
        : `The colors need ${theater.root.toUpperCase()}.PAL, which is in ${m.game === 'ra' ? 'REDALERT.MIX' : archive}. Open that as well, or pick the palette beside the map.`;
    const shade = palette ? shadeTable(palette) : identityTable;

    const width = area.width * TILE;
    const height = area.height * TILE;
    const pixels = pixelBuffer(width, height);
    const blit = (src: Uint8Array, srcWidth: number, srcHeight: number, x: number, y: number, sprite: boolean, remap?: Uint8Array) => {
        for (let sy = 0; sy < srcHeight; sy++) {
            const dy = y + sy;
            if (dy < 0 || dy >= height) continue;
            for (let sx = 0; sx < srcWidth; sx++) {
                const dx = x + sx;
                if (dx < 0 || dx >= width) continue;
                const p = src[sy * srcWidth + sx];
                if (sprite && p === 0) continue;
                // Sprites mark shadow with color 4.
                pixels[dy * width + dx] = sprite && p === 4 ? shade[pixels[dy * width + dx]] : remap ? remap[p] : p;
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
    const conquer = `CONQUER.MIX${m.game === 'ra' ? ', inside MAIN.MIX' : ''}`;
    // Red Alert keeps its infantry (and civilians) apart from its vehicles and buildings.
    const infantryIn = m.game === 'ra' ? 'HIRES.MIX, inside REDALERT.MIX' : conquer;
    // Red Alert's rules.ini, with the mission read over it, can give an object another's art: its
    // civilians share two sprites (C5 is drawn as C2, C6 as C1).
    // TS's and RA2's are rules.ini too; Red Alert's is the one with its light tank.
    const rulesFile = m.game === 'ra' ? find('rules.ini').find((c) => Ini.of(c.data).section('1TNK')) : undefined;
    if (m.game === 'ra') {
        if (rulesFile) links.use('rules.ini', rulesFile, 'Rules (which art each object uses; in LOCAL.MIX, inside REDALERT.MIX)');
        else links.miss('rules.ini', 'Rules (which art each object uses; in LOCAL.MIX, inside REDALERT.MIX)');
    }
    const rules = rulesFile ? (m.ini ? Ini.of(rulesFile.data).overriddenBy(m.ini) : Ini.of(rulesFile.data)) : m.ini;
    const art = (type: string) => (rules?.get(type, 'Image') ?? type).trim().toUpperCase();
    /** The first of these files that's there (theater art, or plain .shp), recorded under the role. */
    const spriteFrom = (name: string, exts: string[], role: string): Shp | null => {
        const key = `${name}:${exts.join(',')}`;
        if (!sprites.has(key)) {
            let found: Companion | undefined;
            let file = '';
            for (const ext of exts) {
                file = `${name.toLowerCase()}.${ext}`;
                // Red Alert has its infantry in both HIRES.MIX and LORES.MIX: the high-resolution one first.
                const candidates = find(file)
                    .filter((c) => sniffShpTd(c.data))
                    .sort((a, b) => Number(/lores\.mix/i.test(a.source)) - Number(/lores\.mix/i.test(b.source)));
                found = candidates.find((c) => c.source === source) ?? candidates[0];
                if (found) break;
            }
            if (found) links.use(file, found, role);
            else links.miss(`${name.toLowerCase()}.${exts[0]}`, role);
            sprites.set(key, found ? decodeShp(found.data) : null);
        }
        return sprites.get(key)!;
    };
    const sprite = (name: string, theaterArt: boolean) => spriteFrom(name, [theaterArt ? theater.ext : 'shp'], theaterArt ? `Sprite (in ${archive})` : `Sprite (walls and crates are in ${conquer})`);
    // Each side's color, as a remap of the art's own range to the palette's nearest shades.
    const range = m.game === 'td' ? TD_REMAP : RA_REMAP;
    const houseColors = m.game === 'td' ? HOUSE_COLORS : RA_HOUSE_COLORS;
    const remaps = new Map<string, Uint8Array | undefined>();
    const remapFor = (house: string) => {
        if (!remaps.has(house)) {
            const color = TEAM_COLORS.find((c) => c.name === houseColors[house]);
            remaps.set(house, color && palette ? teamRemap(palette, range, color.rgb) : undefined);
        }
        return remaps.get(house);
    };
    // Craters and scorch marks lie on the ground, under everything else.
    for (const o of m.objects) {
        if (o.kind !== 'smudge') continue;
        const [x, y] = [o.cell % size, Math.floor(o.cell / size)];
        const image = spriteFrom(o.type, [theater.ext, 'shp'], `Crater or scorch mark (in ${archive})`)?.frames[o.sub];
        if (image) blit(image.pixels, image.width, image.height, (x - area.x) * TILE, (y - area.y) * TILE, true);
    }
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
            // Wall_Update: a bit for each neighbor of the same wall, N E S W.
            frame = [at(x, y - 1), at(x + 1, y), at(x, y + 1), at(x - 1, y)].reduce((bits, n, i) => bits | (n === name ? 1 << i : 0), 0);
        }
        const shp = sprite(name, theaterSpecific(name));
        const image = shp?.frames[Math.min(frame, shp.frames.length - 1)];
        if (image) blit(image.pixels, image.width, image.height, (x - area.x) * TILE, (y - area.y) * TILE, true);
    }

    // Trees, buildings, units and infantry, back to front. Trees and buildings are drawn from their
    // cell's top left; units and infantry are centered on where they stand.
    const standing: { y: number; draw: () => void }[] = [];
    // Which units, infantry and buildings had no sprite, to say where they are.
    const unseen = new Set<string>();
    const unseenInfantry = new Set<string>();
    for (const [cell, name] of terrain) {
        const [x, y] = [cell % size, Math.floor(cell / size)];
        standing.push({
            y: y * 256,
            draw: () => {
                const image = sprite(name, true)?.frames[0];
                if (image) blit(image.pixels, image.width, image.height, (x - area.x) * TILE, (y - area.y) * TILE, true);
            },
        });
    }
    for (const o of m.objects) {
        if (o.kind === 'smudge') continue;
        const [x, y] = [o.cell % size, Math.floor(o.cell / size)];
        if (!inArea(x, y)) continue;
        const remap = remapFor(o.house);
        if (o.kind === 'building') {
            standing.push({
                y: y * 256,
                draw: () => {
                    const shp = spriteFrom(art(o.type), [theater.ext, 'shp'], `Building sprite (in ${conquer}, or the theater's)`);
                    if (!shp) unseen.add(o.type);
                    const damaged = o.health <= DAMAGED;
                    const frame = !shp ? 0 : TURRET_BUILDINGS.has(o.type) ? bodyFrame(o.facing) + (damaged && shp.frames.length >= 64 ? 32 : 0) : damaged ? shp.frames.length >> 1 : 0;
                    const image = shp?.frames[frame];
                    if (image) blit(image.pixels, image.width, image.height, (x - area.x) * TILE, (y - area.y) * TILE, true, remap);
                    // A war factory's own sprite is only its floor and walls: the roof and door are drawn over it. (Red Alert's fake one uses the same art.)
                    if (art(o.type) === 'WEAP') {
                        const top = spriteFrom('WEAP2', ['shp'], `War factory roof and door (in ${conquer})`);
                        const roof = top?.frames[damaged ? top.frames.length >> 1 : 0];
                        if (roof) blit(roof.pixels, roof.width, roof.height, (x - area.x) * TILE, (y - area.y) * TILE, true, remap);
                    }
                },
            });
            continue;
        }
        const [sx, sy] = o.kind === 'infantry' ? (SUB_CELLS[o.sub] ?? SUB_CELLS[0]) : SUB_CELLS[0];
        standing.push({
            y: y * 256 + sy,
            draw: () => {
                const shp = spriteFrom(art(o.type), ['shp'], o.kind === 'infantry' ? `Infantry sprite (in ${infantryIn})` : `Unit sprite (in ${conquer})`);
                if (!shp) {
                    (o.kind === 'infantry' ? unseenInfantry : unseen).add(o.type);
                    return;
                }
                const dir32 = ((o.facing + 4) >> 3) & 31;
                const frames =
                    o.kind === 'infantry'
                        ? [HUMAN_SHAPE[dir32]]
                        : shp.frames.length >= 32
                          ? [bodyFrame(o.facing), ...(TURRETED.has(o.type) ? [32 + bodyFrame(o.facing)] : [])]
                          : [Math.floor((bodyFrame(o.facing) * shp.frames.length) / 32)];
                for (const f of frames) {
                    const image = shp.frames[f];
                    if (!image) continue;
                    const px = (x - area.x) * TILE + Math.round((sx * TILE) / 256) - (image.width >> 1);
                    const py = (y - area.y) * TILE + Math.round((sy * TILE) / 256) - (image.height >> 1);
                    blit(image.pixels, image.width, image.height, px, py, true, remap);
                }
            },
        });
    }
    for (const o of standing.sort((a, b) => a.y - b.y)) o.draw();

    // A multiplayer map places nothing but where the players start: each start numbered, as the game's
    // own map preview does. (Missions use the same waypoints for their scripts, so not on those.)
    if (starts && isMultiplayer(m)) {
        const light = palette ? nearest(palette, [240, 240, 240]) : 15;
        const dark = palette ? nearest(palette, [16, 16, 16]) : 0;
        for (const [n, cell] of m.starts) {
            const [x, y] = [cell % size, Math.floor(cell / size)];
            if (!inArea(x, y)) continue;
            // Big enough to read on a whole map fitted to the page: a dark disc in a light ring, the number.
            const [side, scale, border] = [52, 6, 4];
            const left = (x - area.x) * TILE + TILE / 2 - side / 2;
            const top = (y - area.y) * TILE + TILE / 2 - side / 2;
            const badge = pixelBuffer(side, side);
            for (let j = 0; j < side; j++) {
                for (let i = 0; i < side; i++) {
                    const r = Math.hypot(i + 0.5 - side / 2, j + 0.5 - side / 2);
                    if (r <= side / 2) badge[j * side + i] = r > side / 2 - border ? light : dark;
                }
            }
            const [gx0, gy0] = [(side - 3 * scale) / 2, (side - 5 * scale) / 2];
            DIGITS[n].forEach((row, gy) =>
                [...row].forEach((c, gx) => {
                    if (c !== '#') return;
                    for (let k = 0; k < scale * scale; k++) badge[(gy0 + gy * scale + Math.floor(k / scale)) * side + gx0 + gx * scale + (k % scale)] = light;
                })
            );
            // Only the disc: the corners outside it (0) leave the map showing.
            for (let j = 0; j < side; j++) {
                for (let i = 0; i < side; i++) {
                    const [px, py] = [left + i, top + j];
                    if (badge[j * side + i] && px >= 0 && py >= 0 && px < width && py < height) pixels[py * width + px] = badge[j * side + i];
                }
            }
        }
    }

    const some = (types: Set<string>) => `${[...types].slice(0, 4).join(', ')}${types.size > 4 ? ', …' : ''}`;
    const notes = [wanted];
    if (m.game === 'td' && unseen.size + unseenInfantry.size) {
        notes.push(`The map's units, infantry and buildings (${some(new Set([...unseen, ...unseenInfantry]))}) need their sprites from ${conquer}. Open CONQUER.MIX as well to draw them.`);
    } else {
        if (unseen.size) notes.push(`The map's vehicles and buildings (${some(unseen)}) need their sprites from ${conquer}. Open MAIN.MIX as well to draw them.`);
        if (unseenInfantry.size) notes.push(`Its infantry (${some(unseenInfantry)}) are in ${infantryIn}. Open REDALERT.MIX as well to draw them.`);
    }
    return { status: 'drawn', image: { width, height, pixels }, palette, wanted: notes.filter(Boolean).join(' ') || undefined };
}

/** A mission's map as previews (real tiles when they're available, and terrain kinds), with summary rows. */
export function missionPreviews(
    m: Mission,
    find: Finder | undefined,
    links: Links
): { items: { title: string; preview: Preview }[]; summary: [string, string][]; warnings: string[]; wanted?: string } {
    const { image, counts, unknown } = renderMap(m);
    const summary: [string, string][] = [['Map', `${m.size} × ${m.size} cells${m.area ? `, playable ${m.area.width} × ${m.area.height} at ${m.area.x}, ${m.area.y} (shown)` : ''}`]];
    if (m.theater) summary.push(['Theater', m.theater]);
    summary.push(...counts.map(([label, n]) => [label, `${n} cells`] as [string, string]));
    const warnings = unknown ? [`${unknown} map cells use templates the game doesn't define.`] : [];

    const legend = counts.map(([label]) => ({ label, index: KIND[label as KindLabel] }));
    const kinds: Preview = { kind: 'images', frames: [image], palette: terrainPalette(), legend };
    const tiles = find ? renderTiles(m, find, links) : null;
    if (tiles?.status !== 'drawn') return { items: [{ title: 'Terrain kinds', preview: kinds }], summary, warnings, wanted: tiles?.wanted };
    // The start positions can be turned off: the map is drawn again without them.
    const toggle =
        isMultiplayer(m) && m.starts.length
            ? {
                  label: 'Start positions',
                  off: () => {
                      const plain = renderTiles(m, find!, new Links(), { starts: false });
                      return plain.status === 'drawn' ? [plain.image] : [tiles.image];
                  },
              }
            : undefined;
    return {
        wanted: tiles.wanted,
        items: [
            { title: 'Map', preview: { kind: 'images', frames: [tiles.image], palette: tiles.palette, toggle } },
            { title: 'Terrain kinds', preview: kinds },
        ],
        summary,
        warnings,
    };
}
