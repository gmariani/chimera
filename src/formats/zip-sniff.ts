/**
 * ZIP archives: a file's own header ("PK", 3, 4) first, or, for an empty archive, the end record ("PK", 5, 6) alone.
 * Kept apart from the reader so the sniffers don't load it.
 */
export function sniffZip(data: Uint8Array): boolean {
    if (data.length < 22 || data[0] !== 0x50 || data[1] !== 0x4b) return false;
    if (data[2] === 3 && data[3] === 4) return data.length >= 30;
    // Empty: the end record and its comment are the whole file.
    return data[2] === 5 && data[3] === 6 && 22 + (data[20] | (data[21] << 8)) === data.length;
}
