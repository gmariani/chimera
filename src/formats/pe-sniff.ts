/**
 * Windows programs and libraries (PE): an MZ header whose word at 0x3C points to "PE" and two zero bytes, with the
 * 20-byte file header after it inside the file. Kept apart from the reader so the sniffers don't load it.
 */

/** Where the "PE" signature is, or null when it isn't a PE file. */
export function peOffset(data: Uint8Array): number | null {
    if (data.length < 64 || data[0] !== 0x4d || data[1] !== 0x5a) return null;
    const at = (data[0x3c] | (data[0x3d] << 8) | (data[0x3e] << 16) | (data[0x3f] << 24)) >>> 0;
    // The header may start inside the MZ header's own fields (Windows reads it anyway; very small programs do this), but not at 0.
    if (at < 4 || at + 24 > data.length) return null;
    return data[at] === 0x50 && data[at + 1] === 0x45 && data[at + 2] === 0 && data[at + 3] === 0 ? at : null;
}

export function sniffPe(data: Uint8Array): boolean {
    return peOffset(data) !== null;
}
