import type { Companion, Preview } from '../../core/types';
import { Ini } from '../ini-sections';
import type { Links } from '../links';
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
}

/**
 * Objects in a TS or RA2 map: "House,Type,Health,X,Y,Facing,…" for buildings,
 * vehicles and aircraft; infantry put a sub-cell before their mission and facing.
 */
function readObjects(ini: Ini): IsoObject[] {
    const out: IsoObject[] = [];
    const sections: [IsoObject['kind'], string][] = [['building', 'Structures'], ['unit', 'Units'], ['aircraft', 'Aircraft'], ['infantry', 'Infantry']];
    for (const [kind, section] of sections) {
        for (const [, value] of ini.entries(section)) {
            const v = value.split(',').map((x) => x.trim());
            const [rx, ry] = [Number(v[3]), Number(v[4])];
            if (!Number.isInteger(rx) || !Number.isInteger(ry)) continue;
            out.push({ kind, house: v[0], type: (v[1] ?? '').toUpperCase(), rx, ry, facing: Number(kind === 'infantry' ? v[7] : v[5]) || 0, sub: kind === 'infantry' ? Number(v[5]) || 0 : 0, health: Number(v[2]) || 256 });
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
 * A theater INI's tile sets as one list: tile number → the set's file name stem
 * and the tile's number in it. "Marble Madness" sets (NonMarbleMadness=N) are
 * the map editor's; the game draws the same tile from set N instead.
 */
function tileFiles(ini: Ini): { stem: string; n: number }[] {
    const sets = ini.sections
        .map((s) => ({ s, number: Number(s.name.match(/^TileSet(\d+)$/i)?.[1]) }))
        .filter((x) => Number.isInteger(x.number))
        .sort((a, b) => a.number - b.number)
        .map(({ s, number }) => {
            const get = (k: string) => s.entries.find((e) => e.key.toLowerCase() === k.toLowerCase())?.value;
            const plain = Number(get('NonMarbleMadness') ?? -1);
            return { number, stem: (get('FileName') ?? '').toLowerCase(), count: Number(get('TilesInSet') ?? 0), plain };
        });
    const out: { stem: string; n: number }[] = [];
    for (const set of sets) {
        const game = set.plain >= 0 ? sets.find((x) => x.number === set.plain) : undefined;
        for (let n = 1; n <= set.count; n++) out.push(game ? { stem: game.stem, n: Math.min(n, game.count) } : { stem: set.stem, n });
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
    }
    /** Draws indexed pixels (0 transparent) through a palette at x, y in map pixels. */
    draw(pixels: ArrayLike<number>, w: number, h: number, x: number, y: number, palette: Uint8Array) {
        const s = this.step;
        for (let sy = 0; sy < h; sy++) {
            const my = y + sy - this.top;
            if (my % s || my < 0) continue;
            const ty = my / s;
            if (ty >= this.height) break;
            for (let sx = 0; sx < w; sx++) {
                const p = pixels[sy * w + sx];
                const mx = x + sx - this.left;
                if (!p || mx % s || mx < 0) continue;
                const tx = mx / s;
                if (tx >= this.width) continue;
                const at = (ty * this.width + tx) * 4;
                this.rgba[at] = palette[p * 3];
                this.rgba[at + 1] = palette[p * 3 + 1];
                this.rgba[at + 2] = palette[p * 3 + 2];
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
                if (!pixels[sy * w + sx] || mx % s || mx < 0 || mx / s >= this.width) continue;
                const at = ((my / s) * this.width + mx / s) * 4;
                for (let c = 0; c < 3; c++) this.rgba[at + c] >>= 1;
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
                if (!rgba[from + 3] || mx % s || mx < 0 || mx / s >= this.width) continue;
                this.rgba.set(rgba.subarray(from, from + 4), ((my / s) * this.width + mx / s) * 4);
            }
        }
    }
}

const MAX_SIDE = 4096;
/** Theaters' letters and extensions, in the order the mission editor tries them after the map's own. */
const THEATER_LETTERS = ['g', 't', 'a', 'u', 'n', 'd', 'l'];
const THEATER_EXTENSIONS = ['tem', 'sno', 'urb', 'lun', 'des', 'ubn'];
/** BRIDGE1, BRIDGE2, RAILBRDG1 and RAILBRDG2 in both games' [OverlayTypes], and RA2's BRIDGEB1 and BRIDGEB2. */
const HIGH_BRIDGES = [0x18, 0x19, 0x3b, 0x3c, 0xed, 0xee];

export interface IsoRender {
    image: { width: number; height: number; rgba: Uint8Array };
    real: boolean;
    wanted?: string;
}

/**
 * The map, drawn with the theater's tiles, overlays and trees when they're in
 * the opened archives; otherwise each cell as a flat diamond colored by height.
 */
export function renderIsoMap(map: IsoMap, find: Finder | undefined, yuri: boolean, links: Links): IsoRender {
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
    const files = theaterIni ? tileFiles(Ini.of(theaterIni.data)) : [];
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
    const step = Math.max(1, Math.ceil(Math.max(fullW, fullH) / MAX_SIDE));
    const canvas = new Canvas(left, top, fullW, fullH, step);
    const levels = new Map<number, number>();
    for (const c of cells) levels.set(c.ry * 1024 + c.rx, c.level);

    // Ground.
    const flat = new Uint8Array(768);
    const diamond = unpackDiamond(new Uint8Array((tw * th) / 2).fill(1), tw, th);
    for (const c of cells) {
        const [x, y] = place(c);
        if (real) {
            const t = tile((c.tile & 0xffff) === 0xffff ? 0 : c.tile);
            const cell = t?.cells[c.sub] ?? t?.cells.find(Boolean) ?? first!.cells.find(Boolean);
            if (!cell) continue;
            canvas.draw(cell.diamond, t?.width ?? tw, t?.height ?? th, x, y, isoPalette);
            if (cell.extra) canvas.draw(cell.extra.pixels, cell.extra.width, cell.extra.height, x + cell.extra.dx, y + cell.extra.dy, isoPalette);
        } else {
            const k = Math.min(c.level, 14) / 14;
            flat.set(HEIGHT_LOW.map((lo, i) => Math.round(lo + (HEIGHT_HIGH[i] - lo) * k)), 3);
            canvas.draw(diamond, tw, th, x, y, flat);
        }
    }

    // Overlays and trees: sprites centered on their cell when drawing for real, otherwise a mark.
    const rules = pick(yuri ? ['rulesmd.ini', 'rules.ini'] : ['rules.ini', 'rulesmd.ini'], 'Rules (what each overlay is)');
    const rulesIni = rules ? Ini.of(rules.data) : null;
    const overlayNames = rulesIni?.entries('OverlayTypes').map(([, v]) => v.trim().toUpperCase()) ?? [];
    // art.ini can point an object at another's art (Image=).
    const artFile = pick(yuri ? ['artmd.ini', 'art.ini'] : ['art.ini', 'artmd.ini'], 'Art (which picture each object uses)');
    const art = artFile ? Ini.of(artFile.data) : null;
    const image = (name: string) => (rulesIni?.get(name, 'Image') ?? art?.get(name, 'Image') ?? name).trim().toUpperCase();
    const sprites = new Map<string, { width: number; height: number; frames: ShpTsFrame[] } | null>();
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
    // rules.ini marks walls (Wall=yes), which are drawn in the unit palette; their names don't say so (TS's sandbags are GASAND).
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
    const overlayPalette = (name: string) => {
        const kind = overlayMark(name);
        if (/^(yes|true|1)$/i.test(rulesIni?.get(name, 'Tiberium') ?? '')) return tiberiumPalette(name);
        return kind === 'ore' || kind === 'gems' ? objPalette : isWall(name) ? unitPalette : isoPalette;
    };

    // Each side's color: the map's own ([GDI] Color=Gold), else rules.ini's, from the game's [Colors] (hue, saturation, value).
    const teams = new Map<string, Uint8Array>();
    const teamPaletteFor = (house: string, base: Uint8Array) => {
        const key = `${house}:${base === unitPalette ? 'unit' : base === isoPalette ? 'iso' : 'other'}`;
        if (!teams.has(key)) {
            const name = map.houseColors.get(house.toLowerCase()) ?? rulesIni?.get(house, 'Color') ?? rulesIni?.get(rulesIni.get(house, 'Country') ?? '', 'Color');
            const hsv = name ? rulesIni?.get('Colors', name)?.split(',').map(Number) : undefined;
            const rgb = hsv && hsv.length === 3 ? hsvToRgb(hsv[0], hsv[1], hsv[2]) : TEAM_COLORS.find((c) => c.name === 'Gold')!.rgb;
            teams.set(key, teamPalette(base, TS_REMAP, rgb));
        }
        return teams.get(key)!;
    };
    const yes = (value: string | undefined) => /^(yes|true|1)$/i.test(value ?? '');
    /**
     * The palette an object's art is drawn in: the theater's terrain palette for art marked TerrainPalette
     * (civilian buildings, lamps), else the unit palette; and the owner's color only where it's Remapable.
     */
    const artPalette = (artName: string, house: string) => {
        const base = yes(art?.get(artName, 'TerrainPalette')) ? isoPalette : unitPalette;
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
     * High bridges (BRIDGE1/2 and RAILBRDG1/2, by their place in [OverlayTypes]) are drawn higher than
     * other overlays so their deck meets the ramp tiles: half a cell, or a whole one for the frames
     * running the other way (9–17). The offsets are the TS/RA2 mission editor's (EA's GPL source).
     */
    const overlayLift = (id: number, frame: number) => (HIGH_BRIDGES.includes(id) ? (frame >= 9 && frame <= 17 ? -th : -th / 2) : 0);
    const objects: { rx: number; ry: number; draw: () => void }[] = [];
    if (map.overlays) {
        for (let i = 0; i < map.overlays.length; i++) {
            const id = map.overlays[i];
            if (id === 0xff) continue;
            const [rx, ry] = [i % 512, Math.floor(i / 512)];
            const name = overlayNames[id];
            if (real && name) objects.push({ rx, ry, draw: () => drawSprite(rx, ry, name, map.overlayData?.[i] ?? 0, overlayPalette(name), false, overlayLift(id, map.overlayData?.[i] ?? 0)) });
            else {
                const kind = name ? (isWall(name) ? 'wall' : overlayMark(name)) : null;
                if (kind) objects.push({ rx, ry, draw: () => mark(rx, ry, MARK[kind]) });
            }
        }
    }
    for (const [rx, ry, name] of map.terrain) objects.push({ rx, ry, draw: () => (real ? drawSprite(rx, ry, name, 0, isoPalette, true) : mark(rx, ry, MARK.tree)) });

    for (const o of map.objects) {
        if (!real) {
            objects.push({ rx: o.rx, ry: o.ry, draw: () => mark(o.rx, o.ry, MARK[o.kind === 'building' ? 'building' : 'unit']) });
            continue;
        }
        const img = image(o.type);
        if (o.kind === 'building') {
            // Drawn centered on its footprint: its foundation slab (bib), the building (damaged at half
            // strength or less), its animated parts, then a defense's turret.
            const [fw, fh] = (art?.get(img, 'Foundation') ?? art?.get(o.type, 'Foundation') ?? '1x1').split(/x/i).map((n) => Number(n) || 1);
            const damaged = o.health <= 128;
            objects.push({ rx: o.rx + fw - 1, ry: o.ry + fh - 1, draw: () => {
                const [cx, cy] = point(o.rx + fw / 2, o.ry + fh / 2);
                const palette = artPalette(img, o.house);
                const bib = art?.get(img, 'BibShape');
                const bibShp = bib ? spriteFor(bib.toUpperCase(), 'Building foundation sprite') : null;
                if (bibShp) drawFrame(bibShp, 0, cx, cy, palette, false);
                const shp = spriteFor(o.type, 'Building sprite');
                // Its frames: whole, damaged (, rubble), then the same again as shadows.
                if (shp) drawFrame(shp, damaged && shp.frames.length >= 4 ? 1 : 0, cx, cy, palette, true);
                for (const key of ['ActiveAnim', 'ActiveAnimTwo', 'ActiveAnimThree', 'ActiveAnimFour', 'IdleAnim']) {
                    const anim = (damaged && art?.get(img, `${key}Damaged`)) || art?.get(img, key);
                    if (!anim) continue;
                    const animShp = spriteFor(anim.toUpperCase(), 'Building animation sprite');
                    const dx = Number(art?.get(img, `${key}X`) ?? 0);
                    const dy = Number(art?.get(img, `${key}Y`) ?? 0);
                    // An animation in the terrain palette says so; otherwise it's drawn like its building.
                    const animPalette = yes(art?.get(anim, 'TerrainPalette')) ? artPalette(anim, o.house) : palette;
                    if (animShp) drawFrame(animShp, Number(art?.get(anim, 'Start') ?? 0) || 0, cx + dx, cy + dy, animPalette, false);
                }
                // A defense's turret: a voxel model or a sprite of 32 facings, placed in pixels from the building's center.
                const turret = /^(yes|true|1)$/i.test(rulesIni?.get(o.type, 'Turret') ?? '') ? rulesIni?.get(o.type, 'TurretAnim') ?? art?.get(img, 'TurretAnim') : undefined;
                if (!turret) return;
                const tx = cx + Number(rulesIni?.get(o.type, 'TurretAnimX') ?? 0);
                const ty = cy + Number(rulesIni?.get(o.type, 'TurretAnimY') ?? 0);
                if (/^(yes|true|1)$/i.test(rulesIni?.get(o.type, 'TurretAnimIsVoxel') ?? '')) {
                    const key = `${turret}:${o.facing}:${o.house}`;
                    if (!voxelPictures.has(key)) {
                        const parts: VoxelPartInput[] = [];
                        for (const [file, role] of [[turret.toLowerCase(), 'Defense turret model'], [`${turret.toLowerCase()}barl`, 'Defense barrel model']]) {
                            const m = model(file, role);
                            if (m) parts.push({ ...m, forward: 0 });
                        }
                        voxelPictures.set(key, parts.length ? drawVoxels(parts, o.facing, tw, th, palette) : null);
                    }
                    const picture = voxelPictures.get(key);
                    if (picture) canvas.picture(picture.rgba, picture.width, picture.height, Math.round(tx - picture.originX), Math.round(ty - picture.originY));
                } else {
                    const turretShp = spriteFor(turret.toUpperCase(), 'Defense turret sprite');
                    if (turretShp) drawFrame(turretShp, Math.round(((256 - o.facing) % 256) / 8) % 32, tx, ty, palette, false);
                }
            } });
            continue;
        }
        if (o.kind === 'infantry') {
            const [sx, sy] = SUB_CELLS[o.sub] ?? SUB_CELLS[0];
            objects.push({ rx: o.rx, ry: o.ry, draw: () => {
                const shp = spriteFor(o.type, 'Infantry sprite');
                if (!shp) return;
                const [cx, cy] = point(o.rx + sx / 256, o.ry + sy / 256);
                // Standing still, facing one of 8 ways, counterclockwise from north.
                drawFrame(shp, (8 - Math.round(o.facing / 32)) % 8, cx, cy, artPalette(img, o.house), true);
            } });
            continue;
        }
        // Vehicles and aircraft: voxels when the art says so, with a turret and barrel if there are files for them.
        objects.push({ rx: o.rx, ry: o.ry, draw: () => {
            const [cx, cy] = point(o.rx + 0.5, o.ry + 0.5);
            const palette = teamPaletteFor(o.house, unitPalette);
            const voxel = /^(yes|true|1)$/i.test(art?.get(img, 'Voxel') ?? rulesIni?.get(o.type, 'Voxel') ?? '');
            if (!voxel) {
                const shp = spriteFor(o.type, 'Vehicle sprite');
                if (shp) drawFrame(shp, Math.round(((256 - o.facing) % 256) / 8) % Math.max(1, shp.frames.length >> 1), cx, cy, palette, true);
                return;
            }
            const key = `${img}:${o.facing}:${o.house}`;
            if (!voxelPictures.has(key)) {
                const parts: VoxelPartInput[] = [];
                const body = model(img.toLowerCase(), 'Vehicle model');
                if (body) parts.push({ ...body, forward: 0 });
                // TurretOffset is in leptons, 256 to a cell.
                const offset = (Number(art?.get(img, 'TurretOffset') ?? 0) * VOXELS_PER_CELL) / 256;
                for (const part of ['tur', 'barl']) {
                    const extra = model(`${img.toLowerCase()}${part}`, part === 'tur' ? 'Turret model' : 'Barrel model');
                    if (extra) parts.push({ ...extra, forward: offset });
                }
                voxelPictures.set(key, parts.length ? drawVoxels(parts, o.facing, tw, th, palette) : null);
            }
            const picture = voxelPictures.get(key);
            if (picture) canvas.picture(picture.rgba, picture.width, picture.height, Math.round(cx - picture.originX), Math.round(cy - picture.originY));
        } });
    }
    objects.sort((a, b) => a.rx + a.ry - (b.rx + b.ry));
    for (const o of objects) o.draw();

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
    const items: { title: string; preview: Preview }[] = [{ title: render.real ? 'Map' : 'Map (height and objects; open the theater archives for tiles)', preview: { kind: 'picture', ...render.image } }];
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
