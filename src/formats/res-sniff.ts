/**
 * 32-bit resource files (.res): they start with an empty entry, 32 bytes, that no 16-bit resource file has (no data,
 * a 32-byte header, type and name both the number 0, the rest 0). Kept apart from the reader so the sniffers don't load it.
 */
export function sniffRes(data: Uint8Array): boolean {
    if (data.length < 32) return false;
    const start = [0, 0, 0, 0, 0x20, 0, 0, 0, 0xff, 0xff, 0, 0, 0xff, 0xff, 0, 0];
    return start.every((v, i) => data[i] === v) && data.subarray(16, 32).every((v) => v === 0);
}
