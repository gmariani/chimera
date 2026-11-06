/** SWF: "FWS", "CWS" or "ZWS", then a version byte. */
export function sniffSwf(data: Uint8Array): boolean {
    return data.length > 8 && (data[0] === 0x46 || data[0] === 0x43 || data[0] === 0x5a) && data[1] === 0x57 && data[2] === 0x53 && data[3] > 0 && data[3] < 100;
}

/**
 * MPEG audio: an ID3v2 tag, or a frame header (11 sync bits, a real version,
 * layer, bit rate and sample rate) followed by another, so a stray 0xFF doesn't count.
 */
export function sniffMp3(data: Uint8Array): boolean {
    if (data.length > 10 && data[0] === 0x49 && data[1] === 0x44 && data[2] === 0x33 && data[3] < 10) return true;
    const length = frameLength(data, 0);
    return length > 0 && frameLength(data, length) > 0;
}

function frameLength(data: Uint8Array, at: number): number {
    if (at + 4 > data.length || data[at] !== 0xff || (data[at + 1] & 0xe0) !== 0xe0) return 0;
    const v = (data[at + 1] >> 3) & 3;
    const layer = 4 - ((data[at + 1] >> 1) & 3);
    const b = data[at + 2] >> 4;
    const r = (data[at + 2] >> 2) & 3;
    if (v === 1 || layer === 4 || b === 0 || b === 15 || r === 3) return 0;
    const mpeg1 = v === 3;
    const kbps = (mpeg1 ? [[], [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448], [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384], [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]] : [[], [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256], [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160], [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]])[layer][b];
    const rate = [[11025, 12000, 8000], [], [22050, 24000, 16000], [44100, 48000, 32000]][v][r];
    const pad = (data[at + 2] >> 1) & 1;
    const samples = layer === 1 ? 384 : layer === 3 && !mpeg1 ? 576 : 1152;
    return layer === 1 ? (Math.floor((12 * kbps * 1000) / rate) + pad) * 4 : Math.floor(((samples / 8) * kbps * 1000) / rate) + pad;
}

/** Pixel Bender bytecode: a version record (A5) and a name record (A4). */
export function sniffPbj(data: Uint8Array): boolean {
    return data.length > 8 && data[0] === 0xa5 && data[2] === 0 && data[3] === 0 && data[4] === 0 && data[5] === 0xa4;
}
