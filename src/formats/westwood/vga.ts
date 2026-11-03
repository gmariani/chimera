/** VGA DACs take 6 bits per channel; this stretches 0–63 to 0–255. */
export function expandPalette(sixBit: Uint8Array): Uint8Array {
    return sixBit.map((v) => ((v & 63) << 2) | ((v & 63) >> 4));
}
