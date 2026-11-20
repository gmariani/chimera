/**
 * Microsoft cabinets (.cab): "MSCF", a reserved 0, the cabinet's size, and version 1. Kept apart from the reader so the
 * sniffers don't load it.
 */
export function sniffCab(data: Uint8Array): boolean {
    if (data.length < 36 || data[0] !== 0x4d || data[1] !== 0x53 || data[2] !== 0x43 || data[3] !== 0x46) return false;
    const u32 = (at: number) => (data[at] | (data[at + 1] << 8) | (data[at + 2] << 16) | (data[at + 3] << 24)) >>> 0;
    return u32(4) === 0 && u32(8) >= 36 && u32(16) >= 36 && u32(16) < u32(8) && data[25] === 1;
}
