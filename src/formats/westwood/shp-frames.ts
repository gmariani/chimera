import { Bytes } from '../../core/bytes';
import type { IndexedImage } from '../../core/types';
import { format40, lcw } from './compression';
import { SHP_FORMAT_LCW, SHP_FORMAT_XOR_LCW } from './sniff';
import { Budget, checkCount, pixelBuffer } from '../../core/limits';

/**
 * Decoding TD/RA sprites, shared by the SHP parser and the map renderer (which
 * draws ore, walls and trees with them).
 */

export interface ShpFrameHeader {
    at: number;
    offset: number;
    format: number;
    ref: number;
    /** The frame this one is a delta against, or -1. */
    keyframe: number;
}

export interface Shp {
    width: number;
    height: number;
    headers: ShpFrameHeader[];
    /** The 768 bytes after the offsets, when the file carries its own palette. */
    palette?: Uint8Array;
    frames: IndexedImage[];
    warnings: string[];
}

export function decodeShp(data: Uint8Array): Shp {
    const b = new Bytes(data);
    const count = b.u16(0);
    const width = b.u16(6);
    const height = b.u16(8);
    const warnings: string[] = [];

    checkCount(count + 2, 8, data.length - 14, 'The frame count');
    const budget = new Budget('The frames');
    const raw = Array.from({ length: count + 2 }, (_, i) => {
        const at = 14 + i * 8;
        const ref = b.u32(at + 4);
        return { at, offset: b.u32(at) & 0xffffff, format: b.u32(at) >>> 24, ref: ref & 0xffffff, refShort: ref & 0xffff };
    });
    const table = 14 + (count + 2) * 8;
    const palette = raw[0].offset >= table + 768 ? data.subarray(table, table + 768) : undefined;

    const headers: ShpFrameHeader[] = [];
    const frames: IndexedImage[] = [];
    for (let i = 0; i < count; i++) {
        const h = raw[i];
        const src = data.subarray(h.offset, raw[i + 1].offset);
        budget.take(width * height);
        const pixels = pixelBuffer(width, height);
        let keyframe = -1;
        if (h.format === SHP_FORMAT_LCW) {
            lcw(src, pixels);
        } else {
            // XOR-keyframe names its keyframe by file offset (some tools only write the low 16 bits).
            keyframe = i - 1;
            if (h.format === SHP_FORMAT_XOR_LCW) {
                keyframe = raw.findIndex((x) => x.offset === h.ref);
                if (keyframe < 0) keyframe = raw.findIndex((x) => x.offset === h.refShort);
            }
            if (keyframe >= 0 && keyframe < frames.length) pixels.set(frames[keyframe].pixels);
            else warnings.push(`Frame ${i + 1} is a delta against a frame that isn't here (reference 0x${h.ref.toString(16).toUpperCase().padStart(6, '0')}).`);
            format40(src, pixels);
        }
        headers.push({ at: h.at, offset: h.offset, format: h.format, ref: h.ref, keyframe });
        frames.push({ width, height, pixels });
    }
    headers.push(...raw.slice(count).map((h) => ({ at: h.at, offset: h.offset, format: h.format, ref: h.ref, keyframe: -1 })));
    return { width, height, headers, palette, frames, warnings };
}
