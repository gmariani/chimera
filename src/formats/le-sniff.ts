/**
 * Linear Executables (LE, LX): a DOS header whose newer-header field (at 0x3C) points past it to "LE" or "LX", then
 * the byte and word order, both 0 (least significant first) on every PC. Kept apart from the reader so the sniffers
 * don't load it.
 */
export function leOffset(data: Uint8Array): number | null {
    if (data.length < 0x40 || data[0] !== 0x4d || data[1] !== 0x5a) return null;
    const at = (data[0x3c] | (data[0x3d] << 8) | (data[0x3e] << 16) | (data[0x3f] << 24)) >>> 0;
    if (at < 0x40 || at + 0xb0 > data.length) return null;
    const sig = String.fromCharCode(data[at], data[at + 1]);
    return (sig === 'LE' || sig === 'LX') && data[at + 2] === 0 && data[at + 3] === 0 ? at : null;
}

export function sniffLe(data: Uint8Array): boolean {
    return leOffset(data) !== null;
}
