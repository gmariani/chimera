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
