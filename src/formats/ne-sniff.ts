/**
 * 16-bit Windows (and OS/2) modules: an MZ header whose word at 0x3C points
 * to an "NE" header, all of which fits the file. Kept apart from the reader so
 * the sniffers don't load it.
 */
export function neOffset(data: Uint8Array): number | null {
    if (data.length < 128 || data[0] !== 0x4d || data[1] !== 0x5a) return null;
    const at = (data[0x3c] | (data[0x3d] << 8) | (data[0x3e] << 16) | (data[0x3f] << 24)) >>> 0;
    if (at < 64 || at + 64 > data.length || data[at] !== 0x4e || data[at + 1] !== 0x45) return null;
    return at;
}

export function sniffNe(data: Uint8Array): boolean {
    return neOffset(data) !== null;
}
