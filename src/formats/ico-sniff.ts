/**
 * Windows icons and cursors (.ico, .cur): a 6-byte header (0, then 1 for an
 * icon or 2 for a cursor, then how many images), a 16-byte entry for each, and
 * the images. The header is too plain to go on alone, so every entry has to
 * point inside the file, past the entries, at a bitmap header or a PNG. Kept
 * apart from the reader so the sniffers don't load it.
 */
export function icoLayout(data: Uint8Array): { type: 1 | 2; count: number } | null {
    if (data.length < 22) return null;
    const u16 = (at: number) => data[at] | (data[at + 1] << 8);
    const u32 = (at: number) => (data[at] | (data[at + 1] << 8) | (data[at + 2] << 16) | (data[at + 3] << 24)) >>> 0;
    const type = u16(2);
    const count = u16(4);
    if (u16(0) !== 0 || (type !== 1 && type !== 2) || count === 0 || count > 256) return null;
    const first = 6 + count * 16;
    if (first > data.length) return null;
    for (let i = 0; i < count; i++) {
        const e = 6 + i * 16;
        const size = u32(e + 8);
        const at = u32(e + 12);
        if (size < 12 || at < first || at + size > data.length) return null;
        const png = data[at] === 0x89 && data[at + 1] === 0x50 && data[at + 2] === 0x4e && data[at + 3] === 0x47;
        if (!png && ![12, 40, 52, 56, 108, 124].includes(u32(at))) return null;
    }
    return { type: type as 1 | 2, count };
}

export function sniffIco(data: Uint8Array): boolean {
    return icoLayout(data) !== null;
}
