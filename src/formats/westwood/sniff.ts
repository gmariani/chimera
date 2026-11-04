import { Bytes } from '../../core/bytes';

/**
 * Cheap checks for Westwood's asset formats. These run on every file inside an
 * archive whose name isn't known, so each one only reads a header.
 */

/** 256 colours of 6-bit RGB: 768 bytes, every value under 64. */
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
    const read = (i: number) => (wide ? b.u32(2 + i * size) : b.u16(2 + i * size)) + 2;
    if (2 + (frames + 1) * size > data.length) return null;
    const offsets: number[] = [];
    for (let i = 0; i <= frames; i++) offsets.push(read(i));
    if (offsets[0] < 2 + (frames + 1) * size || offsets[frames] !== data.length) return null;
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

/** TS/RA2 sprites: a zero word, the canvas size and frame count, then 24-byte frame headers. */
export function sniffShpTs(data: Uint8Array): boolean {
    const b = new Bytes(data);
    if (data.length < 8 || b.u16(0) !== 0) return false;
    const width = b.u16(2);
    const height = b.u16(4);
    const frames = b.u16(6);
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
    return data.length > 20 && rate >= 4000 && rate <= 48000 && b.u8(10) <= 3 && (compression === 1 || compression === 99) && b.u32(16) === 0xdeaf;
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

/** TD map grids: 64 × 64 cells of template and tile; 0xFF is clear ground. */
export function sniffMapTd(data: Uint8Array): boolean {
    if (data.length !== 8192) return false;
    // Clear cells are FF 00 (the tile byte is ignored for them); the map's edges are almost always clear.
    let clear = 0;
    for (let i = 0; i < 128; i += 2) if (data[i] === 0xff) clear++;
    return clear > 8;
}

/**
 * WSA animations: a 14-byte header (frame count, position, size, the largest
 * delta, flags), then frame count + 2 offsets, ending at the end of the file.
 */
export function wsaLayout(data: Uint8Array): { frames: number; offsets: number[]; palette: boolean } | null {
    const b = new Bytes(data);
    const frames = b.u16(0);
    const width = b.u16(6);
    const height = b.u16(8);
    const flags = b.u16(12);
    if (frames === 0 || frames > 4096 || width === 0 || height === 0 || width > 640 || height > 480 || flags > 1) return null;
    const table = 14 + (frames + 2) * 4;
    const palette = flags === 1;
    const shift = palette ? 768 : 0;
    if (table + shift > data.length) return null;
    const offsets: number[] = [];
    for (let i = 0; i < frames + 2; i++) {
        const raw = b.u32(14 + i * 4);
        offsets.push(raw === 0 ? 0 : raw + shift);
    }
    // The first frame may be missing (a delta onto whatever was on screen); the last real offset is the end of the file
    // when the animation doesn't loop, the one after it when it does.
    const end = offsets[frames + 1] || offsets[frames];
    if (end !== data.length) return null;
    let previous = table + shift;
    for (let i = offsets[0] === 0 ? 1 : 0; i <= frames; i++) {
        if (offsets[i] < previous || offsets[i] > data.length) return null;
        previous = offsets[i];
    }
    return { frames, offsets, palette };
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
    if (b.u16(0) !== data.length || b.u8(2) !== 0 || b.u8(3) !== 5 || b.u16(4) !== 14) return false;
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
