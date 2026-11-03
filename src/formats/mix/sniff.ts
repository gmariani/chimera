import { Bytes } from '../../core/bytes';

export const FLAG_CHECKSUM = 0x00010000;
export const FLAG_ENCRYPTED = 0x00020000;
export const CHECKSUM_SIZE = 20;
export const INDEX_ENTRY_SIZE = 12;

/**
 * Does a MIX header start here? Tiberian Dawn files open with a non-zero file
 * count; later ones open with a flags dword whose low word is zero. Without a
 * name to go on, the sizes have to add up exactly. Encrypted headers can't be
 * checked without decrypting, so those are trusted on their flags alone.
 */
export function sniffMix(data: Uint8Array): boolean {
    if (data.length < 6) return false;
    const bytes = new Bytes(data);
    if (bytes.u16(0) !== 0) return sizesAddUp(bytes, 0, 0);
    const flags = bytes.u32(0);
    if (flags & ~(FLAG_CHECKSUM | FLAG_ENCRYPTED)) return false;
    if (flags & FLAG_ENCRYPTED) return data.length >= 4 + 80 + 8;
    return sizesAddUp(bytes, 4, flags & FLAG_CHECKSUM ? CHECKSUM_SIZE : 0);
}

function sizesAddUp(bytes: Bytes, start: number, trailer: number): boolean {
    const count = bytes.u16(start);
    const bodySize = bytes.u32(start + 2);
    return start + 6 + count * INDEX_ENTRY_SIZE + bodySize + trailer === bytes.length;
}
