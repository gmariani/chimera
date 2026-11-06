/** JPEG: start-of-image (FF D8), then another marker. */
export function sniffJpeg(data: Uint8Array): boolean {
    return data.length > 4 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
}
