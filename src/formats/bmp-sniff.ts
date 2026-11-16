/**
 * Windows bitmaps (.bmp): "BM", then a bitmap header of one of the sizes Windows and OS/2 define, whole, and the pixels
 * said to start past it. A file cut short before its pixels is still one, and the reader says so. Kept apart from the
 * reader so the sniffers don't load it.
 */
export function sniffBmp(data: Uint8Array): boolean {
    if (data.length < 26 || data[0] !== 0x42 || data[1] !== 0x4d) return false;
    const u32 = (at: number) => (data[at] | (data[at + 1] << 8) | (data[at + 2] << 16) | (data[at + 3] << 24)) >>> 0;
    const header = u32(14);
    const pixels = u32(10);
    return [12, 40, 52, 56, 108, 124].includes(header) && 14 + header <= data.length && pixels >= 14 + header;
}
