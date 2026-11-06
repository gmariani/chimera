/**
 * MEG: versions 2 and 3 start FF FF FF FF (FF FF FF 8F when encrypted: 0x8FFFFFFF, little-endian) and the float 0.99; version 1 has no
 * signature, so it's taken on shape: a name count and file count that agree, then a printable first name.
 */
export function sniffMeg(data: Uint8Array): boolean {
    if (data.length < 12) return false;
    if (data[0] === 0xff && data[1] === 0xff && data[2] === 0xff && (data[3] === 0xff || data[3] === 0x8f)) return data[4] === 0xa4 && data[5] === 0x70 && data[6] === 0x7d && data[7] === 0x3f;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const names = view.getUint32(0, true);
    const files = view.getUint32(4, true);
    const length = view.getUint16(8, true);
    if (names === 0 || names !== files || names > 1_000_000 || length === 0 || length > 260 || 10 + length > data.length) return false;
    return data.subarray(10, 10 + length).every((b) => b >= 0x20 && b < 0x7f);
}
