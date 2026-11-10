/** GIF: "GIF87a" or "GIF89a". */
export function sniffGif(data: Uint8Array): boolean {
    return data.length >= 13 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38 && (data[4] === 0x37 || data[4] === 0x39) && data[5] === 0x61;
}
