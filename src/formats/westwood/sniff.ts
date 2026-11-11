import { Bytes } from '../../core/bytes';
import { pakLayout } from './pak';

/**
 * Cheap checks for Westwood's asset formats. These run on every file inside an
 * archive whose name isn't known, so each one only reads a header.
 */

/** 256 colors of 6-bit RGB: 768 bytes, every value under 64. */
export function sniffPal(data: Uint8Array): boolean {
    return data.length === 768 && data.every((v) => v < 64);
}

export const SHP_FORMAT_LCW = 0x80;
export const SHP_FORMAT_XOR_LCW = 0x40;
export const SHP_FORMAT_XOR_PREV = 0x20;

/** TD/RA sprites: a 14-byte header, then (frames + 2) offsets whose last real one is the end of the file. */
export function sniffShpTd(data: Uint8Array): boolean {
    const b = new Bytes(data);
    const frames = b.u16(0);
    const width = b.u16(6);
    const height = b.u16(8);
    if (frames === 0 || frames > 4096 || width === 0 || height === 0 || width * height > 1 << 20) return false;
    const table = 14 + (frames + 2) * 8;
    if (table > data.length) return false;
    let previous = 0;
    for (let i = 0; i <= frames; i++) {
        const raw = b.u32(14 + i * 8);
        const offset = raw & 0xffffff;
        const format = raw >>> 24;
        if (i < frames && format !== SHP_FORMAT_LCW && format !== SHP_FORMAT_XOR_LCW && format !== SHP_FORMAT_XOR_PREV) return false;
        if (offset < previous || offset > data.length) return false;
        if (i === 0 && offset !== table && offset !== table + 768) return false;
        previous = offset;
    }
    return true;
}

/**
 * Dune II-style sprites (TD and RA keep their mouse cursors in this format): a
 * frame count, then offsets counted from byte 2, the last real one being the
 * end of the file. Offsets are 2 bytes each in Dune II, 4 in C&C.
 */
export function shpD2Offsets(data: Uint8Array): number[] | null {
    const b = new Bytes(data);
    const frames = b.u16(0);
    if (frames === 0 || data.length < 6) return null;
    const wide = b.u16(4) === 0;
    const size = wide ? 4 : 2;
    if (2 + (frames + 1) * size > data.length) return null;
    const raw: number[] = [];
    for (let i = 0; i <= frames; i++) raw.push(wide ? b.u32(2 + i * size) : b.u16(2 + i * size));
    // Offsets count from the start of the file (Dune II's own sprites) or from just after the frame count
    // (TD's and RA's cursors): whichever puts the last one exactly at the end of the file.
    const base = raw[frames] === data.length ? 0 : raw[frames] + 2 === data.length ? 2 : -1;
    if (base < 0) return null;
    const offsets = raw.map((o) => o + base);
    if (offsets[0] < 2 + (frames + 1) * size) return null;
    for (let i = 0; i < frames; i++) {
        const at = offsets[i];
        // Each frame: flags, slices, width, height, then its own size. Offsets needn't be in order:
        // identical frames point at the same data.
        const size = b.u16(at + 6);
        if (b.u16(at + 3) === 0 || b.u8(at + 5) === 0 || size < 10 || at + size > data.length) return null;
    }
    return offsets;
}

export function sniffShpD2(data: Uint8Array): boolean {
    return shpD2Offsets(data) !== null;
}

/** Westwood PAK archives: offsets and DOS names, the first file starting right where they end. */
export function sniffPak(data: Uint8Array): boolean {
    return pakLayout(data) !== null;
}

/** TS/RA2 sprites: a zero word, the canvas size and frame count, then 24-byte frame headers. */
export function sniffShpTs(data: Uint8Array): boolean {
    const b = new Bytes(data);
    if (data.length < 8 || b.u16(0) !== 0) return false;
    const width = b.u16(2);
    const height = b.u16(4);
    const frames = b.u16(6);
    // An empty sprite: 0 × 0, with only blank frames (their offsets are leftover memory).
    if (width === 0 && height === 0) return frames > 0 && data.length === 8 + frames * 24 && Array.from({ length: frames }, (_, i) => b.u32(8 + i * 24 + 4)).every((wh) => wh === 0);
    if (frames === 0 || width === 0 || height === 0 || width > 2048 || height > 2048 || 8 + frames * 24 > data.length) return false;
    for (let i = 0; i < frames; i++) {
        const at = 8 + i * 24;
        const x = b.u16(at);
        const y = b.u16(at + 2);
        const w = b.u16(at + 4);
        const h = b.u16(at + 6);
        const offset = b.u32(at + 20);
        if (x + w > width || y + h > height || offset > data.length) return false;
        if (offset !== 0 && offset < 8 + frames * 24) return false;
    }
    return true;
}

/** Audio: a 12-byte header, then chunks that each start with the marker 0x0000DEAF. */
export function sniffAud(data: Uint8Array): boolean {
    const b = new Bytes(data);
    const rate = b.u16(0);
    const compression = b.u8(11);
    // Compression 0, plain PCM, stores each chunk as it plays: the first chunk's two sizes match.
    const plain = compression === 0 && b.u16(12) === b.u16(14) && b.u16(12) > 0;
    return data.length > 20 && rate >= 4000 && rate <= 48000 && b.u8(10) <= 3 && (compression === 1 || compression === 99 || plain) && b.u32(16) === 0xdeaf;
}

/** 320x200 pictures, LCW-compressed, optionally with a palette. */
export function sniffCps(data: Uint8Array): boolean {
    const b = new Bytes(data);
    const paletteSize = b.u16(8);
    return data.length > 10 && b.u16(0) + 2 === data.length && (b.u16(2) === 0 || b.u16(2) === 4) && b.u32(4) === 64000 && (paletteSize === 0 || paletteSize === 768);
}

/** Video: an IFF "FORM" of type "WVQA". */
export function sniffVqa(data: Uint8Array): boolean {
    const b = new Bytes(data);
    return b.ascii(0, 4) === 'FORM' && b.ascii(8, 4) === 'WVQA';
}

export interface TilesLayout {
    game: 'td' | 'ra';
    width: number;
    height: number;
    count: number;
    mapWidth: number;
    mapHeight: number;
    icons: number;
    map: number;
    trans: number;
    colorMap: number;
}

/**
 * Terrain tile sets: tile size and count, then offsets. TD's header is 32 bytes
 * and has the file size at 8; RA's is 40 and has it at 12. Tiles come straight
 * after the header, then the map.
 */
export function tilesLayout(data: Uint8Array): TilesLayout | null {
    const b = new Bytes(data);
    const width = b.u16(0);
    const height = b.u16(2);
    const count = b.u16(4);
    if (width === 0 || height === 0 || width > 64 || height > 64 || count === 0) return null;
    const ra = b.u32(12) === data.length && b.u32(16) === 40;
    const td = b.u32(8) === data.length && b.u32(12) === 32;
    if (!ra && !td) return null;
    const layout: TilesLayout = ra
        ? { game: 'ra', width, height, count, mapWidth: b.u16(8), mapHeight: b.u16(10), icons: 40, trans: b.u32(28), colorMap: b.u32(32), map: b.u32(36) }
        : { game: 'td', width, height, count, mapWidth: 0, mapHeight: 0, icons: 32, trans: b.u32(24), colorMap: 0, map: b.u32(28) };
    const { icons, map, trans } = layout;
    if (map < icons || (map - icons) % (width * height) !== 0 || map + count > data.length || trans < map || trans > data.length) return null;
    return layout;
}

export function sniffTiles(data: Uint8Array): boolean {
    return tilesLayout(data) !== null;
}

/** TD defines templates 0 to 215 (TemplateType in its DEFINES.H). */
const TD_TEMPLATE_COUNT = 216;

/**
 * TD map grids: 64 × 64 cells of template and tile; 0xFF (or template 0) is
 * clear ground. Every cell must name a template TD has, and a tile within reach
 * of one; 4,096 of those in a row don't happen by chance.
 */
export function sniffMapTd(data: Uint8Array): boolean {
    if (data.length !== 8192) return false;
    for (let i = 0; i < data.length; i += 2) {
        const template = data[i];
        if (template !== 0xff && (template >= TD_TEMPLATE_COUNT || data[i + 1] >= 64)) return false;
    }
    return true;
}

/**
 * The three WSA headers, by where their fields sit. C&C (and Kyrandia) put the
 * animation's place on screen after the count; Dune II has no place, and
 * version 1.00 no flags either (so never a palette).
 */
export const WSA_HEADERS = {
    cnc: { size: 14, x: 2, y: 4, width: 6, height: 8, delta: 10, flags: 12, name: 'C&C, Kyrandia' },
    'dune2-107': { size: 10, x: -1, y: -1, width: 2, height: 4, delta: 6, flags: 8, name: 'Dune II 1.07' },
    'dune2-100': { size: 8, x: -1, y: -1, width: 2, height: 4, delta: 6, flags: -1, name: 'Dune II 1.00' },
} as const;
export type WsaVersion = keyof typeof WSA_HEADERS;

export interface WsaLayout {
    version: WsaVersion;
    frames: number;
    width: number;
    height: number;
    x: number;
    y: number;
    /** The delta buffer the header asks for (37 bytes short of what the game allocates). */
    largest: number;
    flags: number;
    palette: boolean;
    /** Where the offset table starts and ends. */
    table: number;
    tableEnd: number;
    /** Frame count + 2 offsets, the palette's 768 bytes added (an offset of 0 stays 0). */
    offsets: number[];
    loops: boolean;
}

/**
 * A WSA's layout, or null if the bytes don't make one: a header (frame count,
 * size, the largest delta, maybe a place and flags), then frame count + 2
 * offsets. The first frame starts right after the offsets (and palette), each
 * frame starts where the last ends, and the last ends at the end of the file.
 */
export function wsaLayout(data: Uint8Array): WsaLayout | null {
    for (const version of Object.keys(WSA_HEADERS) as WsaVersion[]) {
        const layout = wsaAs(data, version);
        if (layout) return layout;
    }
    return null;
}

function wsaAs(data: Uint8Array, version: WsaVersion): WsaLayout | null {
    const h = WSA_HEADERS[version];
    const b = new Bytes(data);
    if (data.length < h.size) return null;
    const frames = b.u16(0);
    const width = b.u16(h.width);
    const height = b.u16(h.height);
    const flags = h.flags < 0 ? 0 : b.u16(h.flags);
    if (frames === 0 || frames > 4096 || width === 0 || height === 0 || width > 640 || height > 480 || flags > 1) return null;
    const tableEnd = h.size + (frames + 2) * 4;
    const palette = flags === 1;
    const shift = palette ? 768 : 0;
    if (tableEnd + shift > data.length) return null;
    const offsets: number[] = [];
    for (let i = 0; i < frames + 2; i++) {
        const raw = b.u32(h.size + i * 4);
        offsets.push(raw === 0 ? 0 : raw + shift);
    }
    // The last real offset is the end of the file: the one after the frames when the animation doesn't loop (then 0),
    // the one after that when it does (with the loop frame between).
    const loops = offsets[frames + 1] !== 0;
    const end = loops ? offsets[frames + 1] : offsets[frames];
    if (end !== data.length) return null;
    // The first frame may be missing (a delta onto the last frame of the animation before); otherwise it starts right
    // after the table, and each frame where the one before ends.
    let previous = tableEnd + shift;
    const first = offsets[0] === 0 ? 1 : 0;
    if (offsets[first] !== previous) return null;
    for (let i = first; i <= frames + (loops ? 1 : 0); i++) {
        if (offsets[i] < previous || offsets[i] > data.length) return null;
        previous = offsets[i];
    }
    return {
        version,
        frames,
        width,
        height,
        x: h.x < 0 ? 0 : b.u16(h.x),
        y: h.y < 0 ? 0 : b.u16(h.y),
        largest: b.u16(h.delta),
        flags,
        palette,
        table: h.size,
        tableEnd,
        offsets,
        loops,
    };
}

export function sniffWsa(data: Uint8Array): boolean {
    return wsaLayout(data) !== null;
}

/** ZSoft PCX: manufacturer 10, a known version, RLE encoding. */
export function sniffPcx(data: Uint8Array): boolean {
    return data.length > 128 && data[0] === 0x0a && [0, 2, 3, 4, 5].includes(data[1]) && data[2] === 1 && [1, 2, 4, 8].includes(data[3]);
}

/**
 * Westwood fonts: the file size, then (for TD/RA's format) 0x0500 and offsets
 * to the info, glyph offset, width, data and height blocks.
 */
export function sniffFont(data: Uint8Array): boolean {
    const b = new Bytes(data);
    // 0, 5 in TD and RA (4 bits a pixel); 2, 0 in TS (8 bits).
    const kind = (b.u8(2) === 0 && b.u8(3) === 5) || (b.u8(2) === 2 && b.u8(3) === 0);
    if (b.u16(0) !== data.length || !kind || b.u16(4) !== 14) return false;
    const blocks = [b.u16(6), b.u16(8), b.u16(10), b.u16(12)];
    return blocks.every((o) => o >= 20 && o < data.length);
}

/** VQA palette blending tables: a count, then that many triangular 256 × 256 tables. */
export const VQP_TABLE = (256 * 257) / 2;

export function sniffVqp(data: Uint8Array): boolean {
    const count = new Bytes(data).u32(0);
    return count > 0 && count < 256 && data.length === 4 + count * VQP_TABLE;
}

/** Mostly printable bytes and no NULs: INI files, mission scripts, credits. */
export function sniffText(data: Uint8Array): boolean {
    if (data.length === 0) return false;
    const sample = data.subarray(0, 4096);
    let printable = 0;
    for (const c of sample) {
        if (c === 0) return false;
        if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127) || c >= 128) printable++;
    }
    return printable / sample.length > 0.95;
}

/** Text with a [section] line near the top. */
export function sniffIni(data: Uint8Array): boolean {
    if (!sniffText(data)) return false;
    const head = new TextDecoder('latin1').decode(data.subarray(0, 4096));
    return /^\s*\[[^\]\r\n]+\]\s*$/m.test(head);
}

/**
 * Westwood string tables (.eng, .ger, .fre): a 2-byte offset per string, then
 * the strings, each ending in a NUL. The first offset says how many there are.
 * Returns the offsets, or null if this isn't one.
 */
export function stringOffsets(data: Uint8Array): number[] | null {
    if (data.length < 3) return null;
    const first = data[0] | (data[1] << 8);
    if (first < 2 || first % 2 || first >= data.length) return null;
    const offsets: number[] = [];
    for (let i = 0; i < first; i += 2) {
        const offset = data[i] | (data[i + 1] << 8);
        // In order, and each string starts right after the one before ends.
        if (offset < (offsets.at(-1) ?? first) || offset >= data.length || (i > 0 && data[offset - 1] !== 0)) return null;
        offsets.push(offset);
    }
    let text = 0;
    for (let i = first; i < data.length; i++) if (data[i] === 0 || data[i] === 9 || data[i] === 10 || data[i] === 13 || data[i] >= 32) text++;
    // The last string ends the file (give or take padding): otherwise this is something else that happens to start like one.
    const last = data.indexOf(0, offsets[offsets.length - 1]);
    if (last < 0 || data.length - (last + 1) >= 16) return null;
    return text / (data.length - first) > 0.95 && data.indexOf(0, first) >= 0 ? offsets : null;
}

export function sniffStrings(data: Uint8Array): boolean {
    return stringOffsets(data) !== null;
}

/** RA's chronal vortex frames (HOLE0000.LUT…): 64 × 64 pixels of source x, source y and a shade under 16. */
export const VORTEX_SIZE = 64;

export function sniffVortex(data: Uint8Array): boolean {
    if (data.length !== VORTEX_SIZE * VORTEX_SIZE * 3) return false;
    for (let i = 0; i < data.length; i += 3) if (data[i] >= VORTEX_SIZE || data[i + 1] >= VORTEX_SIZE || data[i + 2] >= 16) return false;
    return true;
}

/**
 * TS and RA2 isometric tiles (.tem, .sno, .urb… in the theater archives): cells
 * across and down, then the size of a cell (48 × 24 in TS, 60 × 30 in RA2), then
 * an offset per cell (0: no tile there).
 */
export function tmpLayout(data: Uint8Array, allowEmpty = false): { across: number; down: number; width: number; height: number; offsets: number[] } | null {
    const b = new Bytes(data);
    if (data.length < 16) return null;
    const [across, down, width, height] = [b.u32(0), b.u32(4), b.u32(8), b.u32(12)];
    if (!((width === 48 && height === 24) || (width === 60 && height === 30)) || across === 0 || down === 0 || across * down > 400) return null;
    const table = 16 + across * down * 4;
    if (table > data.length) return null;
    const offsets = Array.from({ length: across * down }, (_, i) => b.u32(16 + i * 4));
    const tile = 52 + (width * height) / 2;
    // An empty one is valid (the editor's marble.mix has a few), but too plain to recognize by content.
    if ((!allowEmpty && offsets.every((o) => o === 0)) || offsets.some((o) => o !== 0 && (o < table || o + tile > data.length))) return null;
    return { across, down, width, height, offsets };
}

export function sniffTmp(data: Uint8Array): boolean {
    return tmpLayout(data) !== null;
}

/** TS and RA2 voxel models. */
export function sniffVxl(data: Uint8Array): boolean {
    return new Bytes(data).ascii(0, 16) === 'Voxel Animation\0';
}

/** TS and RA2 voxel animations: a name, frame and section counts, section names, then a 3 × 4 matrix per section per frame. */
export function hvaLayout(data: Uint8Array): { frames: number; sections: number } | null {
    const b = new Bytes(data);
    const [frames, sections] = [b.u32(16), b.u32(20)];
    // A few have no sections at all: just the 24-byte header.
    if (frames === 0 || frames > 10000 || sections > 256 || (sections === 0 && !/^[A-Za-z]:\\/.test(b.ascii(0, 3)))) return null;
    return data.length === 24 + sections * 16 + frames * sections * 48 ? { frames, sections } : null;
}

export function sniffHva(data: Uint8Array): boolean {
    return hvaLayout(data) !== null;
}

/** RIFF WAVE. */
export function sniffWav(data: Uint8Array): boolean {
    const b = new Bytes(data);
    return b.ascii(0, 4) === 'RIFF' && b.ascii(8, 4) === 'WAVE';
}

/** RA2's string tables (.csf). */
export function sniffCsf(data: Uint8Array): boolean {
    return new Bytes(data).ascii(0, 4) === ' FSC';
}

/** RA2's sound index (audio.idx); the sounds are in the .bag of the same name. */
export function sniffGaba(data: Uint8Array): boolean {
    const b = new Bytes(data);
    return b.ascii(0, 4) === 'GABA' && (b.u32(4) === 1 || b.u32(4) === 2) && data.length >= 12 + b.u32(8) * (b.u32(4) === 2 ? 36 : 32);
}

/** Bink video (RA2's movies): "BIK", or "KB2" for Bink 2 (the Remastered Collection's), then a revision letter. */
export function sniffBink(data: Uint8Array): boolean {
    const id = new Bytes(data).ascii(0, 3);
    return id === 'BIK' || id === 'KB2';
}

/**
 * TS and RA2 bitmap fonts at 1 bit a pixel: "fonT" (game.fnt), with a glyph
 * number for each of 65,536 code points, or "FoNt" (map.fnt), with a glyph for
 * each character from a first to a last.
 */
export function sniffUnicodeFont(data: Uint8Array): boolean {
    const b = new Bytes(data);
    if (b.ascii(0, 4) === 'fonT') return data.length === 28 + 65536 * 2 + b.u32(20) * b.u32(24);
    return b.ascii(0, 4) === 'FoNt' && b.u32(44) >= b.u32(40) && data.length === 48 + (b.u32(44) - b.u32(40) + 1) * b.u32(24);
}

/** TS and RA2's voxel lighting tables (voxels.vpl): a header, a palette, then a 256-color remap per lighting level. */
export function sniffVpl(data: Uint8Array): boolean {
    const b = new Bytes(data);
    const [start, end, sections] = [b.u32(0), b.u32(4), b.u32(8)];
    return start <= end && end < 256 && sections > 0 && sections <= 256 && data.length === 16 + 768 + sections * 256;
}
