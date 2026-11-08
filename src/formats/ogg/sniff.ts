/** Ogg: every page starts "OggS" and a stream structure version, which has only ever been 0. */
export function sniffOgg(data: Uint8Array): boolean {
    return data.length >= 27 && data[0] === 0x4f && data[1] === 0x67 && data[2] === 0x67 && data[3] === 0x53 && data[4] === 0;
}
