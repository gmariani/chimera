/**
 * The sound codecs Westwood used in AUD files and VQA movies, and a WAV writer
 * for what they decode to.
 */

const IMA_STEPS = [
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190,
    209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272,
    2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500,
    20350, 22385, 24623, 27086, 29794, 32767,
];
const IMA_INDEX = [-1, -1, -1, -1, 2, 4, 6, 8];

export interface ImaState {
    index: number;
    sample: number;
}

/** One IMA ADPCM nibble to the next sample. */
export function imaSample(state: ImaState, nibble: number): number {
    const step = IMA_STEPS[state.index];
    let diff = step >> 3;
    if (nibble & 1) diff += step >> 2;
    if (nibble & 2) diff += step >> 1;
    if (nibble & 4) diff += step;
    if (nibble & 8) diff = -diff;
    state.sample = Math.max(-32768, Math.min(32767, state.sample + diff));
    state.index = Math.max(0, Math.min(88, state.index + IMA_INDEX[nibble & 7]));
    return state.sample;
}

/** IMA ADPCM, low nibble first. State carries over from chunk to chunk. */
export function decodeIma(src: Uint8Array, out: Int16Array, state: ImaState, start: number): number {
    let w = start;
    for (const byte of src) {
        if (w < out.length) out[w++] = imaSample(state, byte & 0x0f);
        if (w < out.length) out[w++] = imaSample(state, byte >> 4);
    }
    return w;
}

const WS_2BIT = [-2, -1, 0, 1];
const WS_4BIT = [-9, -8, -6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 8];

/** Westwood's 8-bit scheme: each command byte picks 2-bit deltas, 4-bit deltas, raw bytes, or a repeat. */
export function decodeWestwood(src: Uint8Array, out: Uint8Array, start: number, outSize: number): number {
    let w = start;
    const end = Math.min(out.length, start + outSize);
    if (src.length === outSize) {
        out.set(src.subarray(0, end - start), start);
        return end;
    }
    let sample = 0x80;
    let r = 0;
    const put = (value: number) => {
        sample = Math.max(0, Math.min(255, value));
        if (w < end) out[w++] = sample;
    };
    while (w < end && r < src.length) {
        const command = src[r] >> 6;
        let count = src[r++] & 0x3f;
        if (command === 2) {
            if (count & 0x20) {
                // A single signed 5-bit delta.
                put(sample + ((count << 27) >> 27));
            } else {
                for (count++; count > 0 && w < end; count--) put(src[r++]);
            }
        } else if (command === 1) {
            for (count++; count > 0; count--) {
                const code = src[r++];
                put(sample + WS_4BIT[code & 0x0f]);
                put(sample + WS_4BIT[code >> 4]);
            }
        } else if (command === 0) {
            for (count++; count > 0; count--) {
                const code = src[r++];
                for (let shift = 0; shift < 8; shift += 2) put(sample + WS_2BIT[(code >> shift) & 3]);
            }
        } else {
            for (count++; count > 0; count--) put(sample);
        }
    }
    return w;
}

/** A RIFF WAVE file around PCM samples. */
export function wav(samples: Uint8Array | Int16Array, sampleRate: number, channels: number): Uint8Array {
    const bits = samples instanceof Int16Array ? 16 : 8;
    const body = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
    const out = new Uint8Array(44 + body.length);
    const v = new DataView(out.buffer);
    const text = (at: number, s: string) => [...s].forEach((c, i) => (out[at + i] = c.charCodeAt(0)));
    text(0, 'RIFF');
    v.setUint32(4, 36 + body.length, true);
    text(8, 'WAVEfmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, channels, true);
    v.setUint32(24, sampleRate, true);
    v.setUint32(28, (sampleRate * channels * bits) / 8, true);
    v.setUint16(32, (channels * bits) / 8, true);
    v.setUint16(34, bits, true);
    text(36, 'data');
    v.setUint32(40, body.length, true);
    out.set(body, 44);
    return out;
}

