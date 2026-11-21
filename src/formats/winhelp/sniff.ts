/**
 * Windows Help files (.hlp, and its annotations and index, .ann and .gid): 0x00035F3F, then where its directory is,
 * which must fit in the file. Kept apart from the reader so the sniffers don't load it.
 */
export function sniffWinHelp(data: Uint8Array): boolean {
    if (data.length < 16 + 9 + 38) return false;
    const u32 = (at: number) => (data[at] | (data[at + 1] << 8) | (data[at + 2] << 16) | (data[at + 3] << 24)) >>> 0;
    const directory = u32(4);
    return u32(0) === 0x00035f3f && directory >= 16 && directory + 9 + 38 <= data.length && data[directory + 9] === 0x3b && data[directory + 10] === 0x29;
}

/** Windows Help's pictures on their own (.shg, .mrb): "lP" or "lp", how many, and where the first is, inside the file. */
export function sniffShg(data: Uint8Array): boolean {
    if (data.length < 10 || data[0] !== 0x6c || (data[1] !== 0x50 && data[1] !== 0x70)) return false;
    const count = data[2] | (data[3] << 8);
    const first = (data[4] | (data[5] << 8) | (data[6] << 16) | (data[7] << 24)) >>> 0;
    return count > 0 && count < 64 && first >= 4 + count * 4 && first + 2 <= data.length && [5, 6, 8].includes(data[first]) && data[first + 1] <= 3;
}
