/** Standard MIDI files: "MThd", then a header of at least 6 bytes. Kept apart from the reader so the sniffers don't load it. */
export function sniffMidi(data: Uint8Array): boolean {
    return data.length >= 14 && data[0] === 0x4d && data[1] === 0x54 && data[2] === 0x68 && data[3] === 0x64 && data[4] === 0 && data[5] === 0 && data[6] === 0 && data[7] >= 6;
}
