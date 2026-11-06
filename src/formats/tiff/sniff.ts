/** TIFF: "II" and 42 little-endian, or "MM" and 42 big-endian (43 is BigTIFF). */
export function sniffTiff(data: Uint8Array): boolean {
    if (data.length < 8) return false;
    if (data[0] === 0x49 && data[1] === 0x49) return data[3] === 0 && (data[2] === 42 || data[2] === 43);
    if (data[0] === 0x4d && data[1] === 0x4d) return data[2] === 0 && (data[3] === 42 || data[3] === 43);
    return false;
}
