import { Bytes } from '../../core/bytes';

/**
 * Decoding TS and RA2 sprite frames, shared by the SHP parser and the map
 * renderer. Each frame is a rectangle on a shared canvas, stored raw (0, 1),
 * as scanlines with a 2-byte length each (2), or as scanlines with runs of
 * transparent pixels squeezed out (3).
 */

export interface ShpTsFrame {
    x: number;
    y: number;
    width: number;
    height: number;
    compression: number;
    offset: number;
    /** Where this frame's data ends in the file. */
    end: number;
    /** The whole canvas, the frame drawn in its place. */
    pixels: Uint8Array;
}

export function decodeShpTs(data: Uint8Array): { width: number; height: number; frames: ShpTsFrame[] } {
    const b = new Bytes(data);
    const width = b.u16(2);
    const height = b.u16(4);
    const count = b.u16(6);
    const frames: ShpTsFrame[] = [];
    for (let i = 0; i < count; i++) {
        const at = 8 + i * 24;
        const [x, y, w, h] = [b.u16(at), b.u16(at + 2), b.u16(at + 4), b.u16(at + 6)];
        const compression = b.u8(at + 8);
        const offset = b.u32(at + 20);
        const canvas = new Uint8Array(width * height);
        let s = offset;
        if (offset !== 0 && w && h && x + w <= width && y + h <= height) {
            for (let row = 0; row < h; row++) {
                let d = (y + row) * width + x;
                const end = d + w;
                if (compression === 2 || compression === 3) {
                    const lineEnd = s + b.u16(s);
                    s += 2;
                    while (s < lineEnd && d < end) {
                        const value = data[s++];
                        if (compression === 3 && value === 0) d += data[s++];
                        else canvas[d++] = value;
                    }
                    s = lineEnd;
                } else {
                    canvas.set(data.subarray(s, s + w), d);
                    s += w;
                }
            }
        }
        frames.push({ x, y, width: w, height: h, compression, offset, end: s, pixels: canvas });
    }
    return { width, height, frames };
}
