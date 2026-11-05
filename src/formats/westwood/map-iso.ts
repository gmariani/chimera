import type { Companion, Preview } from '../../core/types';
import { Bytes } from '../../core/bytes';
import { Ini } from '../ini-sections';
import { Links } from '../links';
import { lcw, lzo1x } from './compression';
import { decodeShpTs, type ShpTsFrame } from './shp-ts-frames';
import { sniffShpTs, tmpLayout } from './sniff';
import { unpackDiamond } from './tmp-diamond';
import { TEAM_COLORS, teamPalette, TS_REMAP } from './team-colors';
import { expandPalette } from './vga';
import { decodeVxl, readHva, type Hva, type Vxl } from './voxel-data';
import { drawVoxels, VOXELS_PER_CELL, type VoxelPartInput } from './voxel-sprite';

/**
 * TS and RA2 maps: INIs (.map, .mpr, .yrm, and inside RA2's .mmx and .yro)
 * whose ground is in [IsoMapPack5]: base64 of blocks (a 2-byte compressed size,
 * a 2-byte decoded size, then LZO data) holding an 11-byte record per cell: its
 * diamond coordinates, its tile, which cell of the tile, and its height. Ore,
 * walls and bridges are in [OverlayPack] and [OverlayDataPack] (LCW blocks,
 * 512 × 512 cells), trees in [Terrain], and many maps carry a small picture of
 * themselves in [PreviewPack] (LZO blocks, like the cells).
 *
 * Tiles and trees are drawn in the theater's tile palette (isotem.pal), ore and
 * Tiberium in its object palette (temperat.pal), walls in the unit palette.
 *
 * Tile numbers count through the theater INI's tile sets in order (temperat.ini,
 * or temperatmd.ini for Yuri's Revenge); each set's files are its FileName plus
 * 01, 02…. Drawing with them needs the theater's archives open.
 */

interface Cell {
    rx: number;
    ry: number;
    tile: number;
    sub: number;
    level: number;
}

export interface IsoMap {
    cells: Cell[];
    theater: string;
    size: [number, number];
    overlays: Uint8Array | null;
    overlayData: Uint8Array | null;
    /** Trees and the like: [rx, ry, name]. */
    terrain: [number, number, string][];
    /** Buildings, vehicles, infantry and aircraft. */
    objects: IsoObject[];
    /** Each house's color name, where the map sets one ([GDI] Color=Gold). */
    houseColors: Map<string, string>;
    preview: { width: number; height: number; rgb: Uint8Array } | null;
    /** [Lighting]: the light everywhere (Ambient less Ground), more each level up (Level), and its tint. */
    lighting: { ambient: number; level: number; tint: [number, number, number] };
    /** The map's own INI: the game reads it over rules.ini, so a map can add and change object types. */
    ini: Ini;
}

export interface IsoObject {
    kind: 'building' | 'unit' | 'infantry' | 'aircraft';
    house: string;
    type: string;
    rx: number;
    ry: number;
    /** 0–255, clockwise from north. */
    facing: number;
    /** Infantry: where in the cell (0 middle, then the four quarters). */
    sub: number;
    /** Out of 256. */
    health: number;
    /** A building's upgrades by slot (a Component Tower's gun), "" where there's none. */
    upgrades?: string[];
}

/**
 * Objects in a TS or RA2 map: "House,Type,Health,X,Y,Facing,…" for buildings,
 * vehicles and aircraft; infantry put a sub-cell before their mission and facing.
 * A building's 13th to 15th values are its upgrades, or None.
 */
function readObjects(ini: Ini): IsoObject[] {
    const out: IsoObject[] = [];
    const sections: [IsoObject['kind'], string][] = [['building', 'Structures'], ['unit', 'Units'], ['aircraft', 'Aircraft'], ['infantry', 'Infantry']];
    for (const [kind, section] of sections) {
        for (const [, value] of ini.entries(section)) {
            const v = value.split(',').map((x) => x.trim());
            const [rx, ry] = [Number(v[3]), Number(v[4])];
            if (!Number.isInteger(rx) || !Number.isInteger(ry)) continue;
            const upgrades = kind === 'building' ? v.slice(12, 15).map((u) => (/^none$/i.test(u) ? '' : u.toUpperCase())) : [];
            out.push({ kind, house: v[0], type: (v[1] ?? '').toUpperCase(), rx, ry, facing: Number(kind === 'infantry' ? v[7] : v[5]) || 0, sub: kind === 'infantry' ? Number(v[5]) || 0 : 0, health: Number(v[2]) || 256, ...(upgrades.some(Boolean) ? { upgrades } : {}) });
        }
    }
    return out;
}

const OVERLAY_CELLS = 512 * 512;

/** Packed sections: base64 of blocks of a 2-byte compressed size, a 2-byte decoded size, and the data. */
function unpack(ini: Ini, section: string, size: number, decode: (src: Uint8Array, dest: Uint8Array) => number): Uint8Array | null {
    const s = ini.section(section);
    if (!s) return null;
    const packed = Uint8Array.from(atob(s.entries.map((e) => e.value).join('').replace(/[^A-Za-z0-9+/]/g, '')), (c) => c.charCodeAt(0));
    const out = new Uint8Array(size);
    let [at, d] = [0, 0];
    while (at + 4 <= packed.length && d < size) {
        const compressed = packed[at] | (packed[at + 1] << 8);
        const decoded = packed[at + 2] | (packed[at + 3] << 8);
        decode(packed.subarray(at + 4, at + 4 + compressed), out.subarray(d, d + decoded));
        at += 4 + compressed;
        d += decoded;
    }
    return out.subarray(0, d);
}

export function readIsoMap(ini: Ini): IsoMap {
    const [, , w, h] = (ini.get('Map', 'Size') ?? '0,0,0,0').split(',').map(Number);
    // Cells sit inside a diamond (w + h) cells across each way.
    const raw = unpack(ini, 'IsoMapPack5', (w + h) * (w + h) * 11 + 11, lzo1x) ?? new Uint8Array();
    const v = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const cells: Cell[] = [];
    for (let at = 0; at + 11 <= raw.length; at += 11) {
        const rx = v.getUint16(at, true);
        const ry = v.getUint16(at + 2, true);
        if (rx === 0 && ry === 0) continue;
        cells.push({ rx, ry, tile: v.getInt32(at + 4, true), sub: raw[at + 8], level: raw[at + 9] });
    }
    // A cell inside the map that the pack leaves out is clear ground at level 0, as the game and the mission
    // editor start every cell (hillbtwn has a hole of them in a plaza). Inside, by the editor's test, its x
    // being our ry and its y our rx.
    if (cells.length) {
        const have = new Set(cells.map((c) => c.ry * 1024 + c.rx));
        for (let rx = 1; rx <= w + h; rx++) {
            for (let ry = 1; ry <= w + h; ry++) {
                const outside = rx + ry < w + 1 || rx + ry > w + h * 2 || (rx + 1 > w && ry - 1 < rx - w) || (ry + 1 > w && rx + w - 1 < ry);
                if (!outside && !have.has(ry * 1024 + rx)) cells.push({ rx, ry, tile: 0xffff, sub: 0, level: 0 });
            }
        }
    }
    const terrain: [number, number, string][] = ini.entries('Terrain').flatMap(([key, value]) => {
        const n = Number(key);
        return Number.isInteger(n) ? [[n % 1000, Math.floor(n / 1000), value.trim().toUpperCase()] as [number, number, string]] : [];
    });
    const houseColors = new Map<string, string>();
    for (const section of ini.sections) {
        const color = section.entries.find((e) => e.key.toLowerCase() === 'color')?.value;
        if (color) houseColors.set(section.name.toLowerCase(), color);
    }
    let preview: IsoMap['preview'] = null;
    const [, , pw, ph] = (ini.get('Preview', 'Size') ?? '').split(',').map(Number);
    if (pw > 0 && ph > 0 && pw * ph < 1 << 22) {
        const rgb = unpack(ini, 'PreviewPack', pw * ph * 3, lzo1x);
        if (rgb && rgb.length >= pw * ph * 3) preview = { width: pw, height: ph, rgb };
    }
    // Some maps write "0,5" for 0.5.
    const light = (key: string, fallback: number) => {
        const n = Number((ini.get('Lighting', key) ?? '').replace(',', '.'));
        return ini.get('Lighting', key) !== undefined && Number.isFinite(n) ? n : fallback;
    };
    return {
        cells,
        theater: (ini.get('Map', 'Theater') ?? 'TEMPERATE').toUpperCase(),
        size: [w, h],
        overlays: unpack(ini, 'OverlayPack', OVERLAY_CELLS, lcw),
        overlayData: unpack(ini, 'OverlayDataPack', OVERLAY_CELLS, lcw),
        terrain,
        objects: readObjects(ini),
        houseColors,
        preview,
        lighting: { ambient: light('Ambient', 1) - light('Ground', 0), level: light('Level', 0), tint: [light('Red', 1), light('Green', 1), light('Blue', 1)] },
        ini,
    };
}

/** Each theater's tile set INI, tile extension, tile palette and object palette. */
const THEATERS: Record<string, { ini: string; ext: string; isoPal: string; pal: string; letter: string }> = {
    TEMPERATE: { ini: 'temperat', ext: 'tem', isoPal: 'isotem', pal: 'temperat', letter: 't' },
    SNOW: { ini: 'snow', ext: 'sno', isoPal: 'isosno', pal: 'snow', letter: 'a' },
    URBAN: { ini: 'urban', ext: 'urb', isoPal: 'isourb', pal: 'urban', letter: 'u' },
    DESERT: { ini: 'desert', ext: 'des', isoPal: 'isodes', pal: 'desert', letter: 'd' },
    LUNAR: { ini: 'lunar', ext: 'lun', isoPal: 'isolun', pal: 'lunar', letter: 'l' },
    NEWURBAN: { ini: 'urbann', ext: 'ubn', isoPal: 'isoubn', pal: 'urbann', letter: 'n' },
};

type Finder = (name: string) => Companion[];

/**
 * A theater INI's tile sets as one list: tile number → the set's file name stem,
 * the tile's number in it, and the set's name (its section of tile animations).
 * "Marble Madness" sets (NonMarbleMadness=N) are the map editor's; the game
 * draws the same tile from set N instead.
 */
function tileFiles(ini: Ini): { stem: string; n: number; set: string }[] {
    const sets = ini.sections
        .map((s) => ({ s, number: Number(s.name.match(/^TileSet(\d+)$/i)?.[1]) }))
        .filter((x) => Number.isInteger(x.number))
        .sort((a, b) => a.number - b.number)
        .map(({ s, number }) => {
            const get = (k: string) => s.entries.find((e) => e.key.toLowerCase() === k.toLowerCase())?.value;
            const plain = Number(get('NonMarbleMadness') ?? -1);
            return { number, stem: (get('FileName') ?? '').toLowerCase(), count: Number(get('TilesInSet') ?? 0), plain, name: get('SetName') ?? '' };
        });
    const out: { stem: string; n: number; set: string }[] = [];
    for (const set of sets) {
        const game = set.plain >= 0 ? sets.find((x) => x.number === set.plain) : undefined;
        for (let n = 1; n <= set.count; n++) out.push(game ? { stem: game.stem, n: Math.min(n, game.count), set: game.name } : { stem: set.stem, n, set: set.name });
    }
    return out;
}

interface Tile {
    width: number;
    height: number;
    /** Diamonds and extras by cell index in the template. */
    cells: ({ diamond: Uint8Array; extra?: { dx: number; dy: number; width: number; height: number; pixels: Uint8Array } } | null)[];
}

function readTile(data: Uint8Array): Tile | null {
    const layout = tmpLayout(data, true);
    if (!layout) return null;
    const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const { width, height, offsets } = layout;
    const size = (width * height) / 2;
    return {
        width,
        height,
        cells: offsets.map((o) => {
            if (!o) return null;
            const diamond = unpackDiamond(data.subarray(o + 52, o + 52 + size), width, height);
            if (!(data[o + 36] & 1)) return { diamond };
            const [ew, eh, at] = [v.getUint32(o + 28, true), v.getUint32(o + 32, true), o + v.getUint32(o + 8, true)];
            if (!ew || !eh || at + ew * eh > data.length) return { diamond };
            return { diamond, extra: { dx: v.getInt32(o + 20, true) - v.getInt32(o, true), dy: v.getInt32(o + 24, true) - v.getInt32(o + 4, true), width: ew, height: eh, pixels: data.subarray(at, at + ew * eh) } };
        }),
    };
}

/** Colors for the flat view: ground by height, and what's on it. */
const HEIGHT_LOW = [72, 104, 52];
const HEIGHT_HIGH = [176, 168, 128];
const MARK: Record<string, [number, number, number]> = { ore: [216, 180, 40], gems: [64, 200, 220], wall: [235, 235, 235], tree: [30, 66, 26], building: [170, 96, 210], unit: [240, 70, 70] };

/** Where in a cell infantry stand, in 1/256ths: middle, then the four quarters. */
const SUB_CELLS = [[128, 128], [64, 64], [192, 64], [64, 192], [192, 192]];

/** TS's and RA2's [Colors] are hue, saturation and value, each 0–255. */
function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
    const hue = ((h / 256) * 6) % 6;
    const sat = s / 255;
    const val = v / 255;
    const c = val * sat;
    const x = c * (1 - Math.abs((hue % 2) - 1));
    const [r, g, b] = hue < 1 ? [c, x, 0] : hue < 2 ? [x, c, 0] : hue < 3 ? [0, c, x] : hue < 4 ? [0, x, c] : hue < 5 ? [x, 0, c] : [c, 0, x];
    const m = val - c;
    return [r, g, b].map((n) => Math.round((n + m) * 255)) as [number, number, number];
}

function overlayMark(name: string): keyof typeof MARK | null {
    if (/^(TIB|GOLD|ORE|RIPARIUS|CRUENTUS|VINIFERA|ABOREUS)/i.test(name)) return 'ore';
    if (/^GEM/i.test(name)) return 'gems';
    if (/WALL|FENC|SBAG|BRIK|GA(WALL|FNCE)|NAWALL|^CYCL|^BARB/i.test(name)) return 'wall';
    return null;
}

/** An RGBA canvas that keeps only every `step`th pixel, so very large maps come out at a reasonable size. */
class Canvas {
    readonly rgba: Uint8Array;
    readonly width: number;
    readonly height: number;
    constructor(
        readonly left: number,
        readonly top: number,
        fullWidth: number,
        fullHeight: number,
        readonly step: number,
    ) {
        this.width = Math.ceil(fullWidth / step);
        this.height = Math.ceil(fullHeight / step);
        this.rgba = new Uint8Array(this.width * this.height * 4);
        this.groundDepth = new Int16Array(this.width * this.height).fill(-1);
        this.groundLevel = new Int8Array(this.width * this.height);
        this.groundOwner = new Int32Array(this.width * this.height).fill(-1);
    }
    /**
     * Which cell's ground each pixel shows: its depth (rx + ry) and height. While `ground` is set, drawing
     * records it; while `object` is set, drawing skips pixels where ground in front of the object and two
     * or more levels above it was drawn (a plateau's top hides what's behind it; a slope doesn't).
     * Ground drawn with an `owner` (a tile's raised part) can be drawn again later where it still shows,
     * with `only` set to that owner.
     */
    private readonly groundDepth: Int16Array;
    private readonly groundLevel: Int8Array;
    private readonly groundOwner: Int32Array;
    ground: { depth: number; level: number; owner?: number } | null = null;
    object: { depth: number; level: number } | null = null;
    only: number | null = null;
    /** What each color channel is multiplied by as it's drawn: the light where it stands, or null for none. */
    light: [number, number, number] | null = null;
    /** The terrain palettes; in any other, colors 240–254 are lights of their own (windows, beacons) and stay unlit. */
    readonly terrainPalettes = new Set<Uint8Array>();
    /** Whether pixel i is hidden from the current object, recording the ground there if drawing ground. */
    private covered(i: number): boolean {
        if (this.ground) {
            this.groundDepth[i] = this.ground.depth;
            this.groundLevel[i] = this.ground.level;
            this.groundOwner[i] = this.ground.owner ?? -1;
            return false;
        }
        if (this.only !== null) return this.groundOwner[i] !== this.only;
        return !!this.object && this.groundDepth[i] > this.object.depth && this.groundLevel[i] >= this.object.level + 2;
    }
    /** Draws indexed pixels (0 transparent) through a palette at x, y in map pixels. */
    /** `solid`: where pixels are drawn even as 0 (a tile's diamond, which the game fills whole, color 0 and all). */
    draw(pixels: ArrayLike<number>, w: number, h: number, x: number, y: number, palette: Uint8Array, solid?: ArrayLike<number>) {
        const s = this.step;
        for (let sy = 0; sy < h; sy++) {
            const my = y + sy - this.top;
            if (my % s || my < 0) continue;
            const ty = my / s;
            if (ty >= this.height) break;
            for (let sx = 0; sx < w; sx++) {
                const p = pixels[sy * w + sx];
                const mx = x + sx - this.left;
                if ((!p && !solid?.[sy * w + sx]) || mx % s || mx < 0) continue;
                const tx = mx / s;
                if (tx >= this.width || this.covered(ty * this.width + tx)) continue;
                const at = (ty * this.width + tx) * 4;
                const k = p >= 240 && p <= 254 && !this.terrainPalettes.has(palette) ? null : this.light;
                this.rgba[at] = k ? Math.min(255, palette[p * 3] * k[0]) : palette[p * 3];
                this.rgba[at + 1] = k ? Math.min(255, palette[p * 3 + 1] * k[1]) : palette[p * 3 + 1];
                this.rgba[at + 2] = k ? Math.min(255, palette[p * 3 + 2] * k[2]) : palette[p * 3 + 2];
                this.rgba[at + 3] = 255;
            }
        }
    }
    /** Darkens what's already there wherever pixels aren't 0: a sprite's shadow frame. */
    shadow(pixels: ArrayLike<number>, w: number, h: number, x: number, y: number) {
        const s = this.step;
        for (let sy = 0; sy < h; sy++) {
            const my = y + sy - this.top;
            if (my % s || my < 0 || my / s >= this.height) continue;
            for (let sx = 0; sx < w; sx++) {
                const mx = x + sx - this.left;
                if (!pixels[sy * w + sx] || mx % s || mx < 0 || mx / s >= this.width || this.covered((my / s) * this.width + mx / s)) continue;
                const at = ((my / s) * this.width + mx / s) * 4;
                for (let c = 0; c < 3; c++) this.rgba[at + c] >>= 1;
            }
        }
    }
    /** Brightens what's already there by an alpha image (a lamp's pool of light): each value over 127, the value ÷ 127. */
    brighten(pixels: ArrayLike<number>, w: number, h: number, x: number, y: number) {
        const s = this.step;
        for (let sy = 0; sy < h; sy++) {
            const my = y + sy - this.top;
            if (my % s || my < 0 || my / s >= this.height) continue;
            for (let sx = 0; sx < w; sx++) {
                const v = pixels[sy * w + sx];
                const mx = x + sx - this.left;
                if (v <= 127 || mx % s || mx < 0 || mx / s >= this.width) continue;
                const at = ((my / s) * this.width + mx / s) * 4;
                for (let c = 0; c < 3; c++) this.rgba[at + c] = Math.min(255, (this.rgba[at + c] * v) / 127);
            }
        }
    }
    /** Draws an RGBA picture (transparent where alpha is 0) with its top left at x, y in map pixels. */
    picture(rgba: Uint8Array, w: number, h: number, x: number, y: number) {
        const s = this.step;
        for (let sy = 0; sy < h; sy++) {
            const my = y + sy - this.top;
            if (my % s || my < 0 || my / s >= this.height) continue;
            for (let sx = 0; sx < w; sx++) {
                const mx = x + sx - this.left;
                const from = (sy * w + sx) * 4;
                if (!rgba[from + 3] || mx % s || mx < 0 || mx / s >= this.width || this.covered((my / s) * this.width + mx / s)) continue;
                const at = ((my / s) * this.width + mx / s) * 4;
                const k = this.light;
                this.rgba[at] = k ? Math.min(255, rgba[from] * k[0]) : rgba[from];
                this.rgba[at + 1] = k ? Math.min(255, rgba[from + 1] * k[1]) : rgba[from + 1];
                this.rgba[at + 2] = k ? Math.min(255, rgba[from + 2] * k[2]) : rgba[from + 2];
                this.rgba[at + 3] = 255;
            }
        }
    }
}

/**
 * The most a map is drawn at full scale: 64 million pixels, at most 16384 on a side (as far as browsers
 * draw a canvas). Past that it keeps every 2nd (or 3rd...) pixel.
 */
const MAX_PIXELS = 64 * 1024 * 1024;
const MAX_SIDE = 16384;
/**
 * Which of a sprite's n facing frames shows a facing (0–255, clockwise from north). The frames start
 * straight up the screen, which is northwest: north is up and to the right (-ry). Infantry and
 * defenses' turrets go counterclockwise, so facing 0 is frame 7 of 8; vehicle sprites (the Titan's legs
 * and torso, the Wolverine) go clockwise, so it's frame 1.
 */
function facingFrame(facing: number, n: number, clockwise = false): number {
    const step = Math.round((facing / 256) * n) + Math.round(n / 8);
    return (((clockwise ? step : -step) % n) + n) % n;
}
/**
 * Pixels to move a voxel turret from TurretAnimX/Y, by game: the same name can be another building in each
 * (NALASR is TS's laser turret and RA2's sentry gun). TS's laser turret, set by eye against the game, sits
 * on top of its housing; by its numbers alone it would sit at the foot. RA2's Grand Cannon's is the mission
 * editor's own (FAData.ini [BuildingVoxelTurretsRA2]).
 */
const TURRET_NUDGE: Record<'ts' | 'ra2', Record<string, [number, number]>> = { ts: { NALASR: [0, -20] }, ra2: { GTGCAN: [-2, 2] } };

/** Superweapon animations the RA2 mission editor leaves off (FAData.ini [IgnoreSuperAnim2..4]): they don't sit right at rest. */
const IGNORED_SUPER_ANIMS = ['NAMISL', 'GACSPH'];

/**
 * Where a barrel modeled around its pivot sits on its turret: forward, right and up, 1024 to a cell, from
 * OpenRA's TS rules (WithVoxelBarrel). The model files don't say, and the mission editor has no barrel here.
 * The Titan's barrel keeps the height its animation file gives it: OpenRA's 256 more put it above the torso.
 */
const BARREL_PLACES: Record<string, [number, number, number]> = { ttnkbarl: [181, 0, 362], mmchbarl: [0, 51, 0] };

/** A barrel's voxel model, placed on its turret by BARREL_PLACES. */
function barrelPart(name: string, found: { vxl: Vxl; hva: Hva | null } | null): VoxelPartInput | null {
    if (!found) return null;
    const [forward, right, up] = (BARREL_PLACES[name] ?? [0, 0, 0]).map((n) => (n * VOXELS_PER_CELL) / 1024);
    return { ...found, forward, right, up };
}
/** Theaters' letters and extensions, in the order the mission editor tries them after the map's own. */
const THEATER_LETTERS = ['g', 't', 'a', 'u', 'n', 'd', 'l'];
const THEATER_EXTENSIONS = ['tem', 'sno', 'urb', 'lun', 'des', 'ubn'];
/** BRIDGE1, BRIDGE2, RAILBRDG1 and RAILBRDG2 in both games' [OverlayTypes], and RA2's BRIDGEB1 and BRIDGEB2. */
const HIGH_BRIDGES = [0x18, 0x19, 0x3b, 0x3c, 0xed, 0xee];
/** TRACKS01–16, LOBRDG01–28, and RA2's LOBRDB01–28 and LOBRDGB1–4: drawn on their cell's center. */
const CENTERED_OVERLAYS: [number, number][] = [
    [0x27, 0x36],
    [0x4a, 0x65],
    [0xcd, 0xec],
];
const VEINHOLE = 0xa7;
/** How many levels a high bridge's deck stands above the ground under it. */
const BRIDGE_LEVELS = 4;
/** How far forward a tile animation sorts: past the rest of its tile (a tunnel's floor spans 3×4 cells). */
const TILE_ANIM_LEVELS = 6;

export interface IsoRender {
    image: { width: number; height: number; rgba: Uint8Array };
    real: boolean;
    wanted?: string;
}

/**
 * The map, drawn with the theater's tiles, overlays and trees when they're in
 * the opened archives; otherwise each cell as a flat diamond colored by height.
 */
export function renderIsoMap(map: IsoMap, find: Finder | undefined, yuri: boolean, links: Links, lighting = true): IsoRender {
    const theater = THEATERS[map.theater] ?? THEATERS.TEMPERATE;
    const archive = `ISO${theater.ext.toUpperCase()}.MIX`;
    /** The first of these names that's in the session; recorded as used, or the first name as missing. */
    const pick = (names: string[], role: string) => {
        for (const n of names) {
            const found = find?.(n)[0];
            if (found) {
                links.use(n, found, role);
                return found;
            }
        }
        if (find) links.miss(names[0], role);
        return undefined;
    };

    // The theater INI (Yuri's Revenge has its own), its palettes, and a first tile to learn the size from.
    const iniNames = yuri ? [`${theater.ini}md.ini`, `${theater.ini}.ini`] : [`${theater.ini}.ini`, `${theater.ini}md.ini`];
    const theaterIni = pick(iniNames, 'Tile list (which file each tile number is)');
    const tileIni = theaterIni ? Ini.of(theaterIni.data) : null;
    const files = tileIni ? tileFiles(tileIni) : [];
    const isoPal = pick([`${theater.isoPal}.pal`, `${theater.isoPal}md.pal`], 'Palette for tiles and trees');
    const objPal = pick([`${theater.pal}.pal`, `${theater.pal}md.pal`], 'Palette for ore and Tiberium');
    const unitPal = pick([`unit${theater.ext}.pal`, `unit${theater.ext}md.pal`], 'Palette for walls');
    const tiles = new Map<number, Tile | null>();
    const tile = (index: number): Tile | null => {
        const i = index < 0 || index >= files.length ? 0 : index;
        if (!tiles.has(i)) {
            const f = files[i];
            const name = f ? `${f.stem}${String(f.n).padStart(2, '0')}.${theater.ext}` : '';
            const found = f ? pick([name, `${f.stem}${String(f.n).padStart(2, '0')}a.${theater.ext}`], `Tile (in ${archive})`) : undefined;
            tiles.set(i, found ? readTile(found.data) : null);
        }
        return tiles.get(i)!;
    };
    /**
     * A sprite drawn over one of a tile's cells: a tunnel's top, a waterfall. The theater INI's section
     * named after the tile set gives it as TileNNAnim (the sprite, with the theater's extension),
     * TileNNAttachesTo (which cell), and TileNNXOffset/YOffset (pixels from that cell's center). Like
     * the mission editor (EA's GPL source), the second frame unless that's a shadow, else the first.
     */
    const anims = new Map<number, { cell: number; dx: number; dy: number; width: number; height: number; pixels: Uint8Array } | null>();
    const tileAnim = (index: number) => {
        if (!anims.has(index)) {
            const f = files[index];
            const key = f ? `Tile${String(f.n).padStart(2, '0')}` : '';
            const anim = f && tileIni?.get(f.set, `${key}Anim`);
            const found = anim ? pick([`${anim.toLowerCase()}.${theater.ext}`, `${anim.toLowerCase()}.tem`], 'Tile animation (a tunnel top, a waterfall)') : undefined;
            const shp = found && sniffShpTs(found.data) ? decodeShpTs(found.data) : null;
            // A frame header's 4 bytes at 12 are 0 for a shadow frame.
            const second = shp && shp.frames.length > 1 && new Bytes(found!.data).u32(8 + 24 + 12) !== 0;
            const frame = shp?.frames[second ? 1 : 0];
            const get = (k: string) => Number(tileIni!.get(f!.set, `${key}${k}`) ?? 0) || 0;
            anims.set(index, shp && frame ? { cell: get('AttachesTo'), dx: get('XOffset'), dy: get('YOffset'), width: shp.width, height: shp.height, pixels: frame.pixels } : null);
        }
        return anims.get(index)!;
    };
    const first = files.length ? tile(0) : null;
    const real = !!(first && isoPal);
    const wanted = real
        ? undefined
        : `Open the game's main archive as well (RA2's RA2.MIX, or TS's TIBSUN.MIX) to draw this map with its tiles: it needs ${iniNames[0].toUpperCase()}, ${theater.isoPal.toUpperCase()}.PAL and ${archive}.`;

    // Diamond size: the tiles' own, or a small flat one.
    const [tw, th] = real ? [first!.width, first!.height] : [16, 8];
    const isoPalette = isoPal ? expandPalette(isoPal.data) : new Uint8Array(768);
    const objPalette = objPal ? expandPalette(objPal.data) : isoPalette;
    const unitPalette = unitPal ? expandPalette(unitPal.data) : objPalette;

    // Where each cell's diamond goes, raised by its height.
    const place = (c: { rx: number; ry: number; level: number }) => [((c.rx - c.ry) * tw) / 2, ((c.rx + c.ry) * th) / 2 - (c.level * th) / 2];
    const cells = [...map.cells].sort((a, b) => a.rx + a.ry - (b.rx + b.ry) || a.rx - b.rx);
    const xs = cells.map((c) => place(c)[0]);
    const ys = cells.map((c) => place(c)[1]);
    // Room for cliffs and trees that reach above and beside their cells.
    const pad = real ? th * 2 : 0;
    const left = Math.min(...xs) - pad;
    const top = Math.min(...ys) - pad * 2;
    const fullW = Math.max(...xs) + tw + pad - left;
    const fullH = Math.max(...ys) + th + pad - top;
    const step = Math.max(1, Math.ceil(Math.max(fullW / MAX_SIDE, fullH / MAX_SIDE, Math.sqrt((fullW * fullH) / MAX_PIXELS))));
    const canvas = new Canvas(left, top, fullW, fullH, step);
    canvas.terrainPalettes.add(isoPalette);
    const levels = new Map<number, number>();
    for (const c of cells) levels.set(c.ry * 1024 + c.rx, c.level);
    const rules = pick(yuri ? ['rulesmd.ini', 'rules.ini'] : ['rules.ini', 'rulesmd.ini'], 'Rules (what each overlay is)');
    // Rules as the game has them for this map: rules.ini with the map read over it (all01umd adds its own power plants).
    const rulesIni = rules ? Ini.of(rules.data).overriddenBy(map.ini) : null;

    // Light, as the game lights a map (and OpenRA's TS does): the map's light, more for each level up, and
    // each lamp's within its LightVisibility (in leptons, 256 to a cell), fading to nothing at its edge.
    // Intensity scales the tint: (ambient + level × height + Σ fade × lamp's) × (tint + Σ fade × lamp's).
    const ruleNumber = (type: string, key: string) => Number((rulesIni?.get(type, key) ?? '').replace(',', '.')) || 0;
    const lamps = map.objects
        .filter((o) => o.kind === 'building' && ruleNumber(o.type, 'LightVisibility') > 0)
        .map((o) => ({ x: o.rx + 0.5, y: o.ry + 0.5, range: ruleNumber(o.type, 'LightVisibility') / 256, intensity: ruleNumber(o.type, 'LightIntensity'), tint: ['LightRedTint', 'LightGreenTint', 'LightBlueTint'].map((k) => ruleNumber(o.type, k)) }));
    const lights = new Map<string, [number, number, number]>();
    // Units, infantry and aircraft get a little more ([AudioVisual] ExtraUnitLight and the like).
    const extraLight = (kind: string) => Number((rulesIni?.get('AudioVisual', kind === 'infantry' ? 'ExtraInfantryLight' : kind === 'aircraft' ? 'ExtraAircraftLight' : 'ExtraUnitLight') ?? '0').replace(',', '.')) || 0;
    const lightAt = (rx: number, ry: number, extra = 0): [number, number, number] | null => {
        if (!real || !lighting) return null;
        const key = `${rx},${ry},${extra}`;
        let light = lights.get(key);
        if (!light) {
            let intensity = map.lighting.ambient + map.lighting.level * (levels.get(ry * 1024 + rx) ?? 0) + extra;
            const tint = [...map.lighting.tint];
            for (const lamp of lamps) {
                const distance = Math.hypot(rx + 0.5 - lamp.x, ry + 0.5 - lamp.y);
                if (distance >= lamp.range) continue;
                const fade = (lamp.range - distance) / lamp.range;
                intensity += fade * lamp.intensity;
                for (let i = 0; i < 3; i++) tint[i] += fade * lamp.tint[i];
            }
            // Limited as the game limits them (CNCMaps' renderer, which matches it): intensity and each tint
            // 0 to 2, the tint scaled so its strongest channel is 1, and that channel's light at most 2. Many
            // lamps overlapping (sov01t's 27 yellow ones) would otherwise wash a map out.
            const amb = Math.min(Math.max(intensity, 0), 2);
            const t = tint.map((v) => Math.min(Math.max(v, 0), 2));
            const most = Math.max(...t);
            const strength = most < 0.001 ? 0 : Math.min(amb * most, 2);
            light = most < 0.001 ? [0, 0, 0] : [strength * (t[0] / most), strength * (t[1] / most), strength * (t[2] / most)];
            lights.set(key, light);
        }
        return light;
    };

    // Ground. The parts of tiles that stand above their diamond (cliff faces, rocks) are drawn with it,
    // so the ground in front trims them, then what's left of them again in depth order with the objects,
    // so a cliff hides what's behind it.
    const raised: { rx: number; ry: number; owner: number; draw: () => void }[] = [];
    const animated: { rx: number; ry: number; up: number; draw: () => void }[] = [];
    const flat = new Uint8Array(768);
    const diamond = unpackDiamond(new Uint8Array((tw * th) / 2).fill(1), tw, th);
    // A cell at a different level from a neighbor can leave a gap where their tiles don't meet (a flat tile a
    // level down, as nod12a has at 90,80; one four levels up, as gdi10b has at 200,73; a cliff a map doesn't
    // line up). Its tile goes first at each of its neighbors' levels, under everything, so it shows only in
    // such a gap; the cell itself is still drawn at its own level.
    if (real) {
        const at = new Map(cells.map((c) => [c.ry * 1024 + c.rx, c.level]));
        for (const c of cells) {
            // The eight cells around it: a slope can leave a gap toward a corner as well as a side.
            const around = [-1, 0, 1].flatMap((dy) => [-1, 0, 1].map((dx) => (dx || dy ? at.get((c.ry + dy) * 1024 + c.rx + dx) : undefined)));
            const levels = new Set(around.filter((l): l is number => l !== undefined && l !== c.level));
            if (!levels.size) continue;
            // As the ground below: a tile with no file (RA2's placeholder height pieces) is clear ground.
            const t = tile((c.tile & 0xffff) === 0xffff ? 0 : c.tile);
            const cell = t?.cells[c.sub] ?? t?.cells.find(Boolean) ?? first?.cells.find(Boolean);
            if (!cell) continue;
            for (const level of levels) {
                const [x, y] = place({ ...c, level });
                canvas.ground = { depth: c.rx + c.ry, level };
                canvas.light = lightAt(c.rx, c.ry);
                canvas.draw(cell.diamond, tw, th, x, y, isoPalette, diamond);
            }
        }
    }
    for (const c of cells) {
        const [x, y] = place(c);
        if (real) {
            const t = tile((c.tile & 0xffff) === 0xffff ? 0 : c.tile);
            canvas.ground = { depth: c.rx + c.ry, level: c.level };
            canvas.light = lightAt(c.rx, c.ry);
            const cell = t?.cells[c.sub] ?? t?.cells.find(Boolean) ?? first!.cells.find(Boolean);
            if (!cell) continue;
            canvas.draw(cell.diamond, t?.width ?? tw, t?.height ?? th, x, y, isoPalette, (t?.width ?? tw) === tw ? diamond : undefined);
            const extra = cell.extra;
            if (extra) {
                const owner = raised.length;
                const draw = () => canvas.draw(extra.pixels, extra.width, extra.height, x + extra.dx, y + extra.dy, isoPalette);
                canvas.ground = { depth: c.rx + c.ry, level: c.level, owner };
                draw();
                raised.push({ rx: c.rx, ry: c.ry, owner, draw });
            }
            // A tile animation goes over all the ground, its whole tile included, so it's drawn whole with the objects.
            const anim = tileAnim((c.tile & 0xffff) === 0xffff ? 0 : c.tile);
            if (anim && anim.cell === c.sub) {
                const [ax, ay] = [x + tw / 2 - anim.width / 2 + anim.dx, y + th / 2 - anim.height / 2 + anim.dy];
                animated.push({ rx: c.rx, ry: c.ry, up: TILE_ANIM_LEVELS, draw: () => canvas.draw(anim.pixels, anim.width, anim.height, ax, ay, isoPalette) });
            }
        } else {
            const k = Math.min(c.level, 14) / 14;
            flat.set(HEIGHT_LOW.map((lo, i) => Math.round(lo + (HEIGHT_HIGH[i] - lo) * k)), 3);
            canvas.draw(diamond, tw, th, x, y, flat);
        }
    }

    // Overlays and trees: sprites centered on their cell when drawing for real, otherwise a mark.
    const overlayNames = rulesIni?.entries('OverlayTypes').map(([, v]) => v.trim().toUpperCase()) ?? [];
    // art.ini can point an object at another's art (Image=).
    const artFile = pick(yuri ? ['artmd.ini', 'art.ini'] : ['art.ini', 'artmd.ini'], 'Art (which picture each object uses)');
    const art = artFile ? Ini.of(artFile.data) : null;
    const image = (name: string) => (rulesIni?.get(name, 'Image') ?? art?.get(name, 'Image') ?? name).trim().toUpperCase();
    const sprites = new Map<string, { width: number; height: number; frames: ShpTsFrame[] } | null>();
    /** The file each sprite came from, which says its palette: theater art (.tem…) is drawn in the terrain palette, a .shp in the unit palette. */
    const spriteFiles = new Map<string, string>();
    /**
     * An object's sprite, found the way the TS/RA2 mission editor finds it (EA's GPL source): each
     * candidate in turn, the first that exists wins.
     *  1. Theater=yes art: the image name with a theater's extension (tib01.tem), this theater's first.
     *  2. Names starting G, N, C or Y (GDI, Nod, civilian, Yuri), flagged NewTheater=yes or not: the
     *     second letter swapped for a theater's, this one's, then G (generic), T, A, U, N, D, L.
     *     GASAND is the snow sandbag and GTSAND the temperate; NARADR has no NewTheater=yes, yet
     *     temperate maps draw the radar from NTRADR.
     *  3. The plain name, then with each theater's extension.
     *  4. The second-letter swap for any other name.
     */
    const spriteFor = (name: string, role: string) => {
        if (!sprites.has(name)) {
            const img = image(name);
            const n = img.toLowerCase();
            // Image=none: the object has no picture (an invisible marker), so there's nothing to find.
            if (n === 'none') {
                sprites.set(name, null);
                return null;
            }
            const yesFlag = (key: string) => /^(yes|true|1)$/i.test(art?.get(img, key) ?? art?.get(name, key) ?? '');
            const extended = [theater.ext, ...THEATER_EXTENSIONS].map((e) => `${n}.${e}`);
            const lettered = n.length > 2 ? [theater.letter, ...THEATER_LETTERS].map((l) => `${n[0]}${l}${n.slice(2)}.shp`) : [];
            const candidates = [
                ...new Set([
                    ...(yesFlag('Theater') ? extended : []),
                    ...(/^[gncy]/.test(n) ? lettered : []),
                    `${n}.shp`,
                    ...extended,
                    ...lettered,
                ]),
            ];
            let found: Companion | undefined;
            for (const f of candidates) {
                found = find?.(f).find((c) => sniffShpTs(c.data));
                if (found) {
                    links.use(f, found, role);
                    spriteFiles.set(name, f);
                    break;
                }
            }
            if (!found) links.miss(`${n}.shp`, role);
            sprites.set(name, found ? decodeShpTs(found.data) : null);
        }
        return sprites.get(name)!;
    };
    const sprite = (name: string) => spriteFor(name, 'Sprite (overlay or tree)');
    const mark = (rx: number, ry: number, color: [number, number, number]) => {
        const [x, y] = place({ rx, ry, level: levels.get(ry * 1024 + rx) ?? 0 });
        const pal = new Uint8Array(768);
        pal.set(color, 3);
        const small = unpackDiamond(new Uint8Array((tw * th) / 2).fill(1), tw, th);
        canvas.draw(small, tw, th, x, y, pal);
    };
    /** Where a point in cells (fractions allowed) falls on the screen, at a cell's height. */
    const point = (fx: number, fy: number) => {
        const level = levels.get(Math.floor(fy) * 1024 + Math.floor(fx)) ?? 0;
        return [((fx - fy) * tw) / 2 + tw / 2, ((fx + fy) * th) / 2 - (level * th) / 2];
    };
    /** A sprite frame centered on a point, its shadow (the second half of the frames) under it. */
    const drawFrame = (shp: { width: number; height: number; frames: ShpTsFrame[] }, frame: number, cx: number, cy: number, palette: Uint8Array, shadow: boolean) => {
        const x = Math.round(cx - shp.width / 2);
        const y = Math.round(cy - shp.height / 2);
        const half = shp.frames.length >> 1;
        if (shadow && shp.frames.length > 1 && shp.frames.length % 2 === 0 && frame < half) canvas.shadow(shp.frames[frame + half].pixels, shp.width, shp.height, x, y);
        const f = shp.frames[Math.min(frame, shp.frames.length - 1)];
        if (f) canvas.draw(f.pixels, shp.width, shp.height, x, y, palette);
    };
    const drawSprite = (rx: number, ry: number, name: string, frame: number, palette: Uint8Array, shadow = false, dy = 0) => {
        const shp = sprite(name);
        if (!shp) return;
        const [cx, cy] = point(rx + 0.5, ry + 0.5);
        drawFrame(shp, frame, cx, cy + dy, palette, shadow);
    };
    // rules.ini marks walls (Wall=yes); their names don't say so (TS's sandbags are GASAND).
    const isWall = (name: string) => /^(yes|true|1)$/i.test(rulesIni?.get(name, 'Wall') ?? '') || overlayMark(name) === 'wall';
    /**
     * TS draws Tiberium in the unit palette, whose gray base the crystals sit on, with entries 16–31 in
     * its type's color (rules.ini [Tiberiums]: Riparius is NeonGreen). TIB01–TIB20 are type 1, TIB2_xx type 2 and so on; BTIB is type 2. RA2's ore and gems
     * carry their own colors (its NeonGreen isn't even defined), so they're left as they are.
     */
    const tiberiumPalettes = new Map<number, Uint8Array>();
    const tiberiumPalette = (name: string) => {
        const image = Number(name.match(/^TIB(\d)_/i)?.[1] ?? (/^(BTIB|GEM)/i.test(name) ? 2 : 1));
        if (!tiberiumPalettes.has(image)) {
            const type = rulesIni?.entries('Tiberiums').map(([, v]) => v.trim()).find((t) => Number(rulesIni.get(t, 'Image')) === image);
            const hsv = type ? rulesIni?.get('Colors', rulesIni.get(type, 'Color') ?? '')?.split(',').map(Number) : undefined;
            tiberiumPalettes.set(image, tw === 48 && hsv?.length === 3 && hsv[2] > 0 ? teamPalette(unitPalette, TS_REMAP, hsvToRgb(hsv[0], hsv[1], hsv[2])) : objPalette);
        }
        return tiberiumPalettes.get(image)!;
    };
    /**
     * Palettes as the TS/RA2 mission editor picks them (EA's GPL source, and FinalSun's FSData.ini):
     * by the file the sprite came from, unless named otherwise. Tiberium, veins and the veinhole are
     * drawn in TS's unit palette, RA2's theater palette; crates in the terrain palette; Tiberium
     * trees, the veinhole and BIGBLU in the unit palette.
     */
    const fromFile = (name: string) => (sprite(name), /\.shp$/.test(spriteFiles.get(name) ?? '') ? unitPalette : isoPalette);
    const overlayPalette = (name: string) => {
        if (yes(rulesIni?.get(name, 'Tiberium'))) return tiberiumPalette(name);
        if (yes(rulesIni?.get(name, 'IsVeins')) || yes(rulesIni?.get(name, 'IsVeinholeMonster')) || /^VEINHOLE/i.test(name)) return tw === 48 ? unitPalette : objPalette;
        // TS's props (crates, pallets, drums) are plain .shp files but drawn in the terrain palette: the mission
        // editor forces it for CRAT only, which leaves its pallets red and white. Only walls take the unit palette.
        if (tw === 48 && !yes(rulesIni?.get(name, 'Wall'))) return isoPalette;
        if (/^CRAT/i.test(name)) return isoPalette;
        return fromFile(name);
    };
    const terrainPalette = (name: string) => (/^(TIBTRE|VEINHOLE|BIGBLU)/i.test(image(name)) ? unitPalette : yes(art?.get(image(name), 'TerrainPalette')) ? isoPalette : fromFile(name));

    // Each side's color: the map's own ([GDI] Color=Gold), else rules.ini's, from the game's [Colors] (hue, saturation, value).
    const teams = new Map<string, Uint8Array>();
    const teamPaletteFor = (house: string, base: Uint8Array) => {
        const key = `${house}:${base === unitPalette ? 'unit' : base === isoPalette ? 'iso' : 'other'}`;
        if (!teams.has(key)) {
            const name = map.houseColors.get(house.toLowerCase()) ?? rulesIni?.get(house, 'Color') ?? rulesIni?.get(rulesIni.get(house, 'Country') ?? '', 'Color');
            const hsv = name ? rulesIni?.get('Colors', name)?.split(',').map(Number) : undefined;
            const rgb = hsv && hsv.length === 3 ? hsvToRgb(hsv[0], hsv[1], hsv[2]) : TEAM_COLORS.find((c) => c.name === 'Gold')!.rgb;
            teams.set(key, teamPalette(base, TS_REMAP, rgb));
            if (canvas.terrainPalettes.has(base)) canvas.terrainPalettes.add(teams.get(key)!);
        }
        return teams.get(key)!;
    };
    const yes = (value: string | undefined) => /^(yes|true|1)$/i.test(value ?? '');
    /**
     * The palette an object's art is drawn in: the theater's terrain palette for art marked TerrainPalette
     * (civilian buildings, lamps), else the unit palette; and the owner's color only where it's Remapable.
     */
    // Art with a palette of its own (Palette=lib: the Statue of Liberty's copper, liburb.pal on an urban map;
    // the mission editor always takes libtem.pal).
    const ownPalettes = new Map<string, Uint8Array | null>();
    const ownPalette = (name: string) => {
        if (!ownPalettes.has(name)) {
            const file = pick([`${name}${theater.ext}.pal`, `${name}tem.pal`], 'Palette of its own (art Palette=)');
            ownPalettes.set(name, file ? expandPalette(file.data) : null);
        }
        return ownPalettes.get(name);
    };
    const artPalette = (artName: string, house: string) => {
        const own = art?.get(artName, 'Palette')?.trim().toLowerCase();
        const base = (own && ownPalette(own)) || (yes(art?.get(artName, 'TerrainPalette')) ? isoPalette : unitPalette);
        return yes(art?.get(artName, 'Remapable')) ? teamPaletteFor(house, base) : base;
    };

    // Voxel models (and their animations), by file.
    const models = new Map<string, { vxl: Vxl; hva: Hva | null } | null>();
    const model = (file: string, role: string) => {
        if (!models.has(file)) {
            const found = find?.(`${file}.vxl`)[0];
            let entry: { vxl: Vxl; hva: Hva | null } | null = null;
            if (found) {
                try {
                    const hvaFile = find?.(`${file}.hva`)[0];
                    entry = { vxl: decodeVxl(found.data), hva: hvaFile ? readHva(hvaFile.data) : null };
                    links.use(`${file}.vxl`, found, role);
                    if (hvaFile) links.use(`${file}.hva`, hvaFile, `${role} (animation)`);
                } catch {
                    entry = null;
                }
            } else if (role === 'Vehicle model') {
                links.miss(`${file}.vxl`, role);
            }
            models.set(file, entry);
        }
        return models.get(file)!;
    };
    const voxelPictures = new Map<string, ReturnType<typeof drawVoxels>>();

    /**
     * How far above its cell's center an overlay is drawn, by its place in [OverlayTypes], as the TS/RA2
     * mission editor draws them (EA's GPL source). Most sit on the cell's top corner, half a cell up, like
     * buildings; tracks and low bridges on its center. High bridges' frames running the other way
     * (9–17) go half a cell further, so their deck meets the ramp tiles, and the veinhole, two cells
     * across, a cell and a half further.
     */
    const overlayLift = (id: number, frame: number) => {
        if (CENTERED_OVERLAYS.some(([from, to]) => id >= from && id <= to)) return 0;
        if (HIGH_BRIDGES.includes(id) && frame >= 9 && frame <= 17) return -th;
        if (id === VEINHOLE) return -th * 2;
        return -th / 2;
    };
    // Raised ground first, so at the same depth an object stands in front of it (the sort keeps order).
    // `up`: levels above its cell, which bring it forward (a high bridge's deck is over what's under it).
    // `owner`: raised ground, drawn again only where it showed.
    // `extra`: light added to its cell's (a unit's ExtraUnitLight).
    const objects: { rx: number; ry: number; up?: number; owner?: number; extra?: number; draw: () => void }[] = [...raised, ...animated];
    if (map.overlays) {
        for (let i = 0; i < map.overlays.length; i++) {
            const id = map.overlays[i];
            if (id === 0xff) continue;
            const [rx, ry] = [i % 512, Math.floor(i / 512)];
            const name = overlayNames[id];
            if (real && name) objects.push({ rx, ry, up: HIGH_BRIDGES.includes(id) ? BRIDGE_LEVELS : 0, draw: () => drawSprite(rx, ry, name, map.overlayData?.[i] ?? 0, overlayPalette(name), false, overlayLift(id, map.overlayData?.[i] ?? 0)) });
            else {
                const kind = name ? (isWall(name) ? 'wall' : overlayMark(name)) : null;
                if (kind) objects.push({ rx, ry, draw: () => mark(rx, ry, MARK[kind]) });
            }
        }
    }
    for (const [rx, ry, name] of map.terrain) objects.push({ rx, ry, draw: () => (real ? drawSprite(rx, ry, name, 0, terrainPalette(name), true) : mark(rx, ry, MARK.tree)) });

    // Laser fences. Most maps place only the posts, and the game links each to the next of its house in
    // line: posts 3 to 5 cells apart get sections between them, while 6 or more is left open (the gaps
    // missions leave for a road). A map that has its sections already (gdi9c) keeps them.
    const isPost = (o: (typeof map.objects)[number]) => o.kind === 'building' && yes(rulesIni?.get(o.type, 'LaserFencePost'));
    const isSection = (o: (typeof map.objects)[number]) => o.kind === 'building' && yes(rulesIni?.get(o.type, 'LaserFence'));
    const sectionType = rulesIni?.entries('BuildingTypes').map(([, v]) => v.trim()).find((t) => yes(rulesIni?.get(t, 'LaserFence')));
    const objectsHere = new Map<number, (typeof map.objects)[number]>();
    for (const o of map.objects) if (o.kind === 'building') objectsHere.set(o.ry * 1024 + o.rx, o);
    const sections: (typeof map.objects)[number][] = [];
    for (const post of sectionType ? map.objects.filter(isPost) : []) {
        for (const [dx, dy] of [[1, 0], [0, 1]]) {
            let n = 1;
            while (n <= 5 && !objectsHere.has((post.ry + dy * n) * 1024 + post.rx + dx * n)) n++;
            const other = objectsHere.get((post.ry + dy * n) * 1024 + post.rx + dx * n);
            if (n < 2 || n > 5 || !other || !isPost(other) || other.house !== post.house) continue;
            for (let k = 1; k < n; k++) sections.push({ ...post, type: sectionType!, rx: post.rx + dx * k, ry: post.ry + dy * k });
        }
    }
    const allObjects = [...map.objects, ...sections];
    // Laser fence posts and sections, by cell: a section's beams run toward its neighbors.
    const fence = new Set(allObjects.filter((o) => isPost(o) || isSection(o)).map((o) => o.ry * 1024 + o.rx));
    // Firestorm wall sections join their neighbors like walls: frame = 1 north (-ry) + 2 east + 4 south + 8 west.
    const firestorm = new Set(allObjects.filter((o) => o.kind === 'building' && yes(rulesIni?.get(o.type, 'FirestormWall'))).map((o) => o.ry * 1024 + o.rx));
    const firestormFrame = (rx: number, ry: number) =>
        (firestorm.has((ry - 1) * 1024 + rx) ? 1 : 0) | (firestorm.has(ry * 1024 + rx + 1) ? 2 : 0) | (firestorm.has((ry + 1) * 1024 + rx) ? 4 : 0) | (firestorm.has(ry * 1024 + rx - 1) ? 8 : 0);
    for (const o of allObjects) {
        if (!real) {
            objects.push({ rx: o.rx, ry: o.ry, draw: () => mark(o.rx, o.ry, MARK[o.kind === 'building' ? 'building' : 'unit']) });
            continue;
        }
        const img = image(o.type);
        // Invisible light posts and the like light the map but aren't seen.
        if (yes(rulesIni?.get(o.type, 'InvisibleInGame'))) continue;
        if (o.kind === 'building') {
            // Its foundation slab (bib), the building (damaged at half strength or less), its animated
            // parts, then a defense's turret, each sprite centered on the top corner of the building's
            // first cell, as the TS/RA2 mission editor (EA's GPL source) draws them.
            const [fw, fh] = (art?.get(img, 'Foundation') ?? art?.get(o.type, 'Foundation') ?? '1x1').split(/x/i).map((n) => Number(n) || 1);
            const damaged = o.health <= 128;
            objects.push({ rx: o.rx + fw - 1, ry: o.ry + fh - 1, draw: () => {
                const [cx, cy] = point(o.rx, o.ry);
                const palette = artPalette(img, o.house);
                const bib = art?.get(img, 'BibShape');
                const bibShp = bib ? spriteFor(bib.toUpperCase(), 'Building foundation sprite') : null;
                if (bibShp) drawFrame(bibShp, 0, cx, cy, palette, false);
                const shp = spriteFor(o.type, 'Building sprite');
                // Its frames: whole, damaged (, rubble), then the same again as shadows.
                // A laser fence section, powered: frames 0–3 run along rx, 4–7 along ry, and each set
                // animates from its last (as OpenRA's TS sequences have it).
                const section = yes(rulesIni?.get(o.type, 'LaserFence'));
                const alongRy = fence.has((o.ry - 1) * 1024 + o.rx) || fence.has((o.ry + 1) * 1024 + o.rx);
                const frame = section ? (alongRy ? 7 : 3) : firestorm.has(o.ry * 1024 + o.rx) ? firestormFrame(o.rx, o.ry) : damaged && shp && shp.frames.length >= 4 ? 1 : 0;
                if (shp) drawFrame(shp, frame, cx, cy, palette, true);
                // The mission editor's set: active, idle, special (a silo's fill, a repair depot's arm) and super
                // (a superweapon's) animations. Production animations play while something's built or repaired (a
                // construction yard's crane, a repair depot's flashing platform), so like the editor, not at rest.
                const animKeys = ['ActiveAnim', 'IdleAnim', 'SpecialAnim', 'SuperAnim'].flatMap((k) => ['', 'Two', 'Three', 'Four'].map((n) => k + n)).filter((k) => !/^IdleAnim./.test(k));
                for (const key of animKeys) {
                    if (/^SuperAnim./.test(key) && IGNORED_SUPER_ANIMS.includes(img)) continue;
                    const anim = (damaged && art?.get(img, `${key}Damaged`)) || art?.get(img, key);
                    if (!anim) continue;
                    const animShp = spriteFor(anim.toUpperCase(), 'Building animation sprite');
                    const dx = Number(art?.get(img, `${key}X`) ?? 0);
                    const dy = Number(art?.get(img, `${key}Y`) ?? 0);
                    // Each animation shows its Start frame (0 unless set). That can differ from the building's own art,
                    // and is still right: the hospital's (CAHOSP_A) cross loops yellow, orange, red, so it shows yellow
                    // over a red cross. Left as is on purpose; it's not a palette bug.
                    // An animation in the terrain palette says so; otherwise it's drawn like its building.
                    const animPalette = yes(art?.get(anim, 'TerrainPalette')) ? artPalette(anim, o.house) : palette;
                    // Special animations play on an event (a repair) from their Start, so like the mission editor they
                    // show frame 0, at rest: the depot's three point into one file, its arm folding out and back.
                    const start = key.startsWith('SpecialAnim') ? 0 : Number(art?.get(anim, 'Start') ?? 0) || 0;
                    if (animShp) drawFrame(animShp, start, cx + dx, cy + dy, animPalette, false);
                }
                // Upgrades, placed by the building's PowerUpNLocXX/YY as the mission editor does, their art named by
                // their own art section's Image (GAVULC → GACTWR_B). A gun (Turret=yes, a Component Tower's) turns to
                // the building's facing among 32; the rest (a power plant's turbine) are animations, at their Start.
                o.upgrades?.forEach((upgrade, slot) => {
                    if (!upgrade) return;
                    const upgradeImg = image(art?.get(image(upgrade), 'Image') ?? image(upgrade));
                    const upgradeShp = spriteFor(upgradeImg, 'Upgrade sprite');
                    if (!upgradeShp) return;
                    const ux = cx + Number(art?.get(img, `PowerUp${slot + 1}LocXX`) ?? 0);
                    const uy = cy + Number(art?.get(img, `PowerUp${slot + 1}LocYY`) ?? 0);
                    const gun = yes(rulesIni?.get(upgrade, 'Turret'));
                    const frame = gun ? facingFrame(o.facing, Math.min(32, upgradeShp.frames.length)) : Number(art?.get(upgradeImg, 'Start') ?? 0) || 0;
                    drawFrame(upgradeShp, frame, ux, uy, palette, false);
                });
                // A defense's turret: a voxel model or a sprite of 32 facings, placed in pixels from the building's center.
                const turret = /^(yes|true|1)$/i.test(rulesIni?.get(o.type, 'Turret') ?? '') ? rulesIni?.get(o.type, 'TurretAnim') ?? art?.get(img, 'TurretAnim') : undefined;
                if (!turret) return;
                const [nx, ny] = TURRET_NUDGE[tw === 48 ? 'ts' : 'ra2'][o.type] ?? [0, 0];
                const tx = cx + Number(rulesIni?.get(o.type, 'TurretAnimX') ?? 0) + nx;
                const ty = cy + Number(rulesIni?.get(o.type, 'TurretAnimY') ?? 0) + ny;
                if (/^(yes|true|1)$/i.test(rulesIni?.get(o.type, 'TurretAnimIsVoxel') ?? '')) {
                    // TurretAnimZAdjust lowers a voxel turret, in leptons (104 to a level, half a tile high): RA2's
                    // Tech Outpost's -140 sets its turret on its tower rather than 20 pixels above it.
                    const zAdjust = (Number(rulesIni?.get(o.type, 'TurretAnimZAdjust') ?? 0) || 0) * (th / 2 / 104);
                    const key = `${turret}:${o.facing}:${o.house}`;
                    if (!voxelPictures.has(key)) {
                        const parts: VoxelPartInput[] = [];
                        const name = turret.toLowerCase();
                        const turretModel = model(name, 'Defense turret model');
                        if (turretModel) parts.push({ ...turretModel, forward: 0 });
                        // The barrel goes by the turret's name with "barl" for "tur": the Tick Tank's TTNKTUR, ttnkbarl.
                        const barrel = name.endsWith('tur') ? `${name.slice(0, -3)}barl` : `${name}barl`;
                        const barrelModel = barrelPart(barrel, model(barrel, 'Defense barrel model'));
                        if (barrelModel) parts.push(barrelModel);
                        voxelPictures.set(key, parts.length ? drawVoxels(parts, o.facing, tw, th, palette) : null);
                    }
                    const picture = voxelPictures.get(key);
                    if (picture) canvas.picture(picture.rgba, picture.width, picture.height, Math.round(tx - picture.originX), Math.round(ty - zAdjust - picture.originY));
                } else {
                    const turretShp = spriteFor(turret.toUpperCase(), 'Defense turret sprite');
                    if (turretShp) drawFrame(turretShp, facingFrame(o.facing, 32), tx, ty, palette, false);
                }
            } });
            continue;
        }
        if (o.kind === 'infantry') {
            const [sx, sy] = SUB_CELLS[o.sub] ?? SUB_CELLS[0];
            objects.push({ rx: o.rx, ry: o.ry, extra: extraLight(o.kind), draw: () => {
                const shp = spriteFor(o.type, 'Infantry sprite');
                if (!shp) return;
                const [cx, cy] = point(o.rx + sx / 256, o.ry + sy / 256);
                // Standing still, facing one of 8 ways, counterclockwise from north.
                drawFrame(shp, facingFrame(o.facing, 8), cx, cy, artPalette(img, o.house), true);
            } });
            continue;
        }
        // Vehicles and aircraft: voxels when the art says so, with a turret and barrel if there are files for them.
        objects.push({ rx: o.rx, ry: o.ry, extra: extraLight(o.kind), draw: () => {
            const [cx, cy] = point(o.rx + 0.5, o.ry + 0.5);
            const palette = teamPaletteFor(o.house, unitPalette);
            const voxel = /^(yes|true|1)$/i.test(art?.get(img, 'Voxel') ?? rulesIni?.get(o.type, 'Voxel') ?? '');
            // A turret and barrel only with Turret=yes, as in FinalSun: the Tick Tank's body has its turret
            // built in, and its tur/barl models are for when it deploys.
            const turreted = /^(yes|true|1)$/i.test(rulesIni?.get(o.type, 'Turret') ?? '');
            if (!voxel) {
                const shp = spriteFor(o.type, 'Vehicle sprite');
                if (!shp) return;
                // A walker has WalkFrames for each of its 8 facings; an animation like the Visceroid's has one facing.
                const half = shp.frames.length >> 1;
                const walk = Number(art?.get(img, 'WalkFrames') ?? 0) || 1;
                // Where the walks start (the mission editor's StartWalkFrame); the turret and standing frames follow them.
                const start = Number(art?.get(img, 'StartWalkFrame') ?? 0) || 0;
                const facings = Number(art?.get(img, 'Facings') ?? 0) || (half % 8 === 0 && half >= 8 * walk ? 8 : 1);
                const dir = facingFrame(o.facing, facings, true);
                // Standing still: a walker without a turret has a standing frame per facing after its walks (the
                // Wolverine); otherwise it stands on the first frame of each walk.
                const standing = !turreted && walk > 1 && half >= start + facings * (walk + 1);
                drawFrame(shp, start + (standing ? facings * walk + dir : dir * walk), cx, cy, palette, true);
                // The Titan's torso: 32 facings after its walks, and a voxel barrel on it.
                if (!turreted || half < start + facings * walk + 32) return;
                drawFrame(shp, start + facings * walk + facingFrame(o.facing, 32, true), cx, cy, palette, true);
                const key = `${img}barl:${o.facing}:${o.house}`;
                if (!voxelPictures.has(key)) {
                    const barrel = barrelPart(`${img.toLowerCase()}barl`, model(`${img.toLowerCase()}barl`, 'Barrel model'));
                    voxelPictures.set(key, barrel ? drawVoxels([barrel], o.facing, tw, th, palette) : null);
                }
                const picture = voxelPictures.get(key);
                if (picture) canvas.picture(picture.rgba, picture.width, picture.height, Math.round(cx - picture.originX), Math.round(cy - picture.originY));
                return;
            }
            const key = `${img}:${o.facing}:${o.house}`;
            if (!voxelPictures.has(key)) {
                const parts: VoxelPartInput[] = [];
                const body = model(img.toLowerCase(), 'Vehicle model');
                if (body) parts.push({ ...body, forward: 0 });
                // TurretOffset is in leptons, 256 to a cell.
                const offset = (Number(art?.get(img, 'TurretOffset') ?? 0) * VOXELS_PER_CELL) / 256;
                for (const part of turreted ? ['tur', 'barl'] : []) {
                    const extra = model(`${img.toLowerCase()}${part}`, part === 'tur' ? 'Turret model' : 'Barrel model');
                    if (extra) parts.push({ ...extra, forward: offset });
                }
                voxelPictures.set(key, parts.length ? drawVoxels(parts, o.facing, tw, th, palette) : null);
            }
            const picture = voxelPictures.get(key);
            if (picture) canvas.picture(picture.rgba, picture.width, picture.height, Math.round(cx - picture.originX), Math.round(cy - picture.originY));
        } });
    }
    objects.sort((a, b) => a.rx + a.ry + (a.up ?? 0) - (b.rx + b.ry + (b.up ?? 0)));
    canvas.ground = null;
    for (const o of objects) {
        canvas.only = o.owner ?? null;
        canvas.object = o.owner !== undefined ? null : { depth: o.rx + o.ry, level: (levels.get(o.ry * 1024 + o.rx) ?? 0) + (o.up ?? 0) };
        // Lit by the cell it stands on (a building by its front corner's).
        canvas.light = lightAt(Math.floor(o.rx), Math.floor(o.ry), o.extra);
        o.draw();
    }
    canvas.object = null;
    canvas.only = null;
    canvas.light = null;

    // Pools of light some lamps cast instead of lighting their cells (AlphaImage=, the "AlphaLightPost"'s
    // ALPHATST): an image of brightness, 127 for none, laid over everything, centered on the building.
    if (real && lighting) {
        const alphas = new Map<string, ReturnType<typeof decodeShpTs> | null>();
        for (const o of map.objects) {
            if (o.kind !== 'building') continue;
            const name = (rulesIni?.get(o.type, 'AlphaImage') ?? art?.get(image(o.type), 'AlphaImage'))?.trim().toLowerCase();
            if (!name || name === 'none') continue;
            if (!alphas.has(name)) {
                const file = pick([`${name}.shp`], 'Lamp light (alpha image)');
                let shp: ReturnType<typeof decodeShpTs> | null = null;
                try {
                    shp = file ? decodeShpTs(file.data) : null;
                } catch {
                    shp = null;
                }
                alphas.set(name, shp);
            }
            const shp = alphas.get(name);
            const frame = shp?.frames[0];
            if (!shp || !frame) continue;
            const [cx, cy] = point(o.rx + 0.5, o.ry + 0.5);
            canvas.brighten(frame.pixels, shp.width, shp.height, Math.round(cx - shp.width / 2), Math.round(cy - shp.height / 2));
        }
    }

    return { image: { width: canvas.width, height: canvas.height, rgba: canvas.rgba }, real, wanted };
}

/** The map's own preview picture, as RGBA. */
function previewPicture(p: NonNullable<IsoMap['preview']>): Preview {
    const rgba = new Uint8Array(p.width * p.height * 4);
    for (let i = 0; i < p.width * p.height; i++) rgba.set([p.rgb[i * 3], p.rgb[i * 3 + 1], p.rgb[i * 3 + 2], 255], i * 4);
    return { kind: 'picture', width: p.width, height: p.height, rgba };
}

/** The previews and summary rows for a TS or RA2 map. */
export function isoMapPreviews(ini: Ini, find: Finder | undefined, fileName: string | null, links: Links): { items: { title: string; preview: Preview }[]; summary: [string, string][]; warnings: string[]; wanted?: string } {
    const map = readIsoMap(ini);
    const yuri = /\.yrm$/i.test(fileName ?? '') || /^(YR|MD)/i.test(ini.get('Basic', 'RequiredAddOn') ?? '') || ini.get('Basic', 'RequiredAddOn') === '1';
    const render = renderIsoMap(map, find, yuri, links);
    // Lit as in the game; the switch draws it again unlit, the art's own colors.
    const toggle = render.real ? { label: 'Lighting', off: () => renderIsoMap(map, find, yuri, new Links(), false).image.rgba } : undefined;
    const items: { title: string; preview: Preview }[] = [{ title: render.real ? 'Map' : 'Map (height and objects; open the theater archives for tiles)', preview: { kind: 'picture', ...render.image, toggle } }];
    if (map.preview) items.push({ title: 'The map\'s own preview', preview: previewPicture(map.preview) });
    const levels = map.cells.map((c) => c.level);
    const warnings: string[] = [];
    return {
        items,
        summary: [
            ['Map', `${map.size[0]} × ${map.size[1]}, ${map.cells.length} cells`],
            ['Theater', map.theater],
            ['Heights', `${Math.min(...levels)}–${Math.max(...levels)}`],
            ['Trees and terrain objects', String(map.terrain.length)],
            ['Overlays', String(map.overlays ? map.overlays.reduce((n, v) => n + (v !== 0xff ? 1 : 0), 0) : 0)],
        ],
        warnings,
        wanted: render.wanted,
    };
}
