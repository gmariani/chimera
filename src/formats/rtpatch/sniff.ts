/**
 * RTPatch patches (.rtp): "K*", a version, flags (the top bit saying 4 more bytes of flags follow, whose low 3 bits are
 * 0), and, in the layout read here (versions before 3.00), a header whose end is where the first record's word is, a
 * type from 1 to 5 in its top 4 bits. Kept apart from the reader so the sniffers don't load it.
 */
export function sniffRtPatch(data: Uint8Array): boolean {
    if (data.length < 32 || data[0] !== 0x4b || data[1] !== 0x2a) return false;
    const u16 = (at: number) => data[at] | (data[at + 1] << 8);
    const version = u16(2);
    if (version < 0x0100 || version > 0x03ff) return false;
    const flags = u16(4);
    let p = 6;
    if (flags & 0x8000) {
        if (data[6] & 7) return false;
        p += 4;
    }
    if (version >= 0x0300) return true;
    // Options, two longs, attributes, a reserved word, the command flags (perhaps a long after), a reserved long.
    p += 14;
    if (p + 2 > data.length) return false;
    if (u16(p) & 4) p += 4;
    p += 6;
    // A list of folders first, or the first record.
    if (flags & 0x0200) return p <= data.length;
    const type = data[p + 1] >> 4;
    return p + 2 <= data.length && type >= 1 && type <= 5;
}
