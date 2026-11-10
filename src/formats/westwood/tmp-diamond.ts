import { pixelBuffer } from '../../core/limits';
/** Isometric tiles store just the diamond; shared by the tile parser and the map renderer. */

/** A diamond's pixels, from the bytes that store just the diamond, into a width × height rectangle (0 outside it). */
export function unpackDiamond(src: Uint8Array, width: number, height: number): Uint8Array {
    const out = pixelBuffer(width, height);
    let row = 4;
    let s = 0;
    for (let y = 0; y < height; y++) {
        const start = (width - row) / 2;
        out.set(src.subarray(s, s + row), y * width + start);
        s += row;
        row += y < height / 2 - 1 ? 4 : -4;
    }
    return out;
}
