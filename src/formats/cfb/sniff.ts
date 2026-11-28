/**
 * Compound files: D0 CF 11 E0 A1 B1 1A E1, then (at 24) a minor and a major version, 3 or 4, the byte order mark FFFE,
 * and sectors of 512 bytes (version 3) or 4,096 (version 4): a sector shift of 9 or 12. Kept apart from the reader so
 * the sniffers don't load it.
 */
export function sniffCfb(data: Uint8Array): boolean {
    const sig = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
    if (data.length < 512 || sig.some((v, i) => data[i] !== v)) return false;
    const major = data[26] | (data[27] << 8);
    const shift = data[30] | (data[31] << 8);
    return (major === 3 || major === 4) && data[28] === 0xfe && data[29] === 0xff && (shift === 9 || shift === 12);
}
