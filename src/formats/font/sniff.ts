/** sfnt fonts: TrueType (0x00010000 or "true"), OpenType with CFF ("OTTO"), or a collection ("ttcf"). */
export function sniffFont(data: Uint8Array): boolean {
    if (data.length < 12) return false;
    const tag = String.fromCharCode(data[0], data[1], data[2], data[3]);
    return tag === 'OTTO' || tag === 'true' || tag === 'ttcf' || (data[0] === 0 && data[1] === 1 && data[2] === 0 && data[3] === 0 && data[4] === 0 && data[5] > 0);
}
