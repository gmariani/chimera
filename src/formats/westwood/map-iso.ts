import type { Companion, Preview } from '../../core/types';
import { Ini } from '../ini-sections';
import { lcw, lzo1x } from './compression';
import { decodeShpTs, type ShpTsFrame } from './shp-ts-frames';
import { sniffShpTs, tmpLayout } from './sniff';
import { unpackDiamond } from './tmp-diamond';
import { expandPalette } from './vga';

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
    preview: { width: number; height: number; rgb: Uint8Array } | null;
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

/** Colours for the flat view: ground by height, and what's on it. */
const HEIGHT_LOW = [72, 104, 52];
const HEIGHT_HIGH = [176, 168, 128];
const MARK: Record<string, [number, number, number]> = { ore: [216, 180, 40], gems: [64, 200, 220], wall: [235, 235, 235], tree: [30, 66, 26] };

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
}

const MAX_SIDE = 4096;

export interface IsoRender {
    image: { width: number; height: number; rgba: Uint8Array };
    real: boolean;
    missing: string[];
    wanted?: string;
}

/**
 * The map, drawn with the theater's tiles, overlays and trees when they're in
 * the opened archives; otherwise each cell as a flat diamond coloured by height.
 */
export function renderIsoMap(map: IsoMap, find: Finder | undefined, yuri: boolean): IsoRender {
    const theater = THEATERS[map.theater] ?? THEATERS.TEMPERATE;
    const missing = new Set<string>();
    const pick = (names: string[]) => {
        for (const n of names) {
            const found = find?.(n)[0];
            if (found) return found;
        }
        return undefined;
    };

    // The theater INI (Yuri's Revenge has its own), its palettes, and a first tile to learn the size from.
    const iniNames = yuri ? [`${theater.ini}md.ini`, `${theater.ini}.ini`] : [`${theater.ini}.ini`, `${theater.ini}md.ini`];
    const theaterIni = pick(iniNames);
    const files = theaterIni ? tileFiles(Ini.of(theaterIni.data)) : [];
    const isoPal = pick([`${theater.isoPal}.pal`, `${theater.isoPal}md.pal`]);
    const objPal = pick([`${theater.pal}.pal`, `${theater.pal}md.pal`]);
    const unitPal = pick([`unit${theater.ext}.pal`, `unit${theater.ext}md.pal`]);
    const tiles = new Map<number, Tile | null>();
    const tile = (index: number): Tile | null => {
        const i = index < 0 || index >= files.length ? 0 : index;
        if (!tiles.has(i)) {
            const f = files[i];
            const name = f ? `${f.stem}${String(f.n).padStart(2, '0')}.${theater.ext}` : '';
            const found = f && pick([name, `${f.stem}${String(f.n).padStart(2, '0')}a.${theater.ext}`]);
            if (f && !found) missing.add(name);
            tiles.set(i, found ? readTile(found.data) : null);
        }
        return tiles.get(i)!;
    };
    const first = files.length ? tile(0) : null;
    const real = !!(first && isoPal);
    const archive = `ISO${theater.ext.toUpperCase()}.MIX`;
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

    // Overlays and trees: sprites centred on their cell when drawing for real, otherwise a mark.
    const rules = pick(yuri ? ['rulesmd.ini', 'rules.ini'] : ['rules.ini', 'rulesmd.ini']);
    const rulesIni = rules ? Ini.of(rules.data) : null;
    const overlayNames = rulesIni?.entries('OverlayTypes').map(([, v]) => v.trim().toUpperCase()) ?? [];
    // art.ini can point an object at another's art (Image=).
    const artFile = pick(yuri ? ['artmd.ini', 'art.ini'] : ['art.ini', 'artmd.ini']);
    const art = artFile ? Ini.of(artFile.data) : null;
    const image = (name: string) => (rulesIni?.get(name, 'Image') ?? art?.get(name, 'Image') ?? name).trim().toUpperCase();
    const sprites = new Map<string, { width: number; height: number; frames: ShpTsFrame[] } | null>();
    const sprite = (name: string) => {
        if (!sprites.has(name)) {
            const n = image(name).toLowerCase();
            const candidates = [`${n}.${theater.ext}`, `${n}.shp`, n.length > 2 ? `${n[0]}${theater.letter}${n.slice(2)}.shp` : ''];
            const found = candidates.map((f) => f && find?.(f).find((c) => sniffShpTs(c.data))).find(Boolean);
            if (!found) missing.add(`${n}.shp`);
            sprites.set(name, found ? decodeShpTs(found.data) : null);
        }
        return sprites.get(name)!;
    };
    const mark = (rx: number, ry: number, colour: [number, number, number]) => {
        const [x, y] = place({ rx, ry, level: levels.get(ry * 1024 + rx) ?? 0 });
        const pal = new Uint8Array(768);
        pal.set(colour, 3);
        const small = unpackDiamond(new Uint8Array((tw * th) / 2).fill(1), tw, th);
        canvas.draw(small, tw, th, x, y, pal);
    };
    const drawSprite = (rx: number, ry: number, name: string, frame: number, palette: Uint8Array) => {
        const shp = sprite(name);
        const f = shp?.frames[Math.min(frame, shp.frames.length - 1)];
        if (!shp || !f) return;
        const [x, y] = place({ rx, ry, level: levels.get(ry * 1024 + rx) ?? 0 });
        canvas.draw(f.pixels, shp.width, shp.height, Math.round(x + tw / 2 - shp.width / 2), Math.round(y + th / 2 - shp.height / 2), palette);
    };
    const overlayPalette = (name: string) => {
        const kind = overlayMark(name);
        return kind === 'ore' || kind === 'gems' ? objPalette : kind === 'wall' ? unitPalette : isoPalette;
    };

    const objects: { rx: number; ry: number; draw: () => void }[] = [];
    if (map.overlays) {
        for (let i = 0; i < map.overlays.length; i++) {
            const id = map.overlays[i];
            if (id === 0xff) continue;
            const [rx, ry] = [i % 512, Math.floor(i / 512)];
            const name = overlayNames[id];
            if (real && name) objects.push({ rx, ry, draw: () => drawSprite(rx, ry, name, map.overlayData?.[i] ?? 0, overlayPalette(name)) });
            else {
                const kind = name ? overlayMark(name) : null;
                if (kind) objects.push({ rx, ry, draw: () => mark(rx, ry, MARK[kind]) });
            }
        }
    }
    for (const [rx, ry, name] of map.terrain) objects.push({ rx, ry, draw: () => (real ? drawSprite(rx, ry, name, 0, isoPalette) : mark(rx, ry, MARK.tree)) });
    objects.sort((a, b) => a.rx + a.ry - (b.rx + b.ry));
    for (const o of objects) o.draw();

    return { image: { width: canvas.width, height: canvas.height, rgba: canvas.rgba }, real, missing: [...missing], wanted };
}

/** The map's own preview picture, as RGBA. */
function previewPicture(p: NonNullable<IsoMap['preview']>): Preview {
    const rgba = new Uint8Array(p.width * p.height * 4);
    for (let i = 0; i < p.width * p.height; i++) rgba.set([p.rgb[i * 3], p.rgb[i * 3 + 1], p.rgb[i * 3 + 2], 255], i * 4);
    return { kind: 'picture', width: p.width, height: p.height, rgba };
}

/** The previews and summary rows for a TS or RA2 map. */
export function isoMapPreviews(ini: Ini, find: Finder | undefined, fileName: string | null): { items: { title: string; preview: Preview }[]; summary: [string, string][]; warnings: string[]; wanted?: string } {
    const map = readIsoMap(ini);
    const yuri = /\.yrm$/i.test(fileName ?? '') || /^(YR|MD)/i.test(ini.get('Basic', 'RequiredAddOn') ?? '') || ini.get('Basic', 'RequiredAddOn') === '1';
    const render = renderIsoMap(map, find, yuri);
    const items: { title: string; preview: Preview }[] = [{ title: render.real ? 'Map' : 'Map (height and objects; open the theater archives for tiles)', preview: { kind: 'picture', ...render.image } }];
    if (map.preview) items.push({ title: 'The map\'s own preview', preview: previewPicture(map.preview) });
    const levels = map.cells.map((c) => c.level);
    const warnings = render.missing.length ? [`Not found in the opened archives, so not drawn: ${render.missing.slice(0, 12).join(', ')}${render.missing.length > 12 ? `, and ${render.missing.length - 12} more` : ''}.`] : [];
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
