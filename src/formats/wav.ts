import { Bytes, bytesLabel, field } from '../core/bytes';
import type { Field, FormatParser } from '../core/types';
import { imaSample, wav } from './westwood/adpcm';

/**
 * WAV files (RIFF): chunks of a 4-letter ID and a size. "fmt " says how the
 * sound is stored; "data" holds it. TS and RA2 store theirs as IMA ADPCM
 * (format 0x11), and the C&C Remastered Collection its music as Microsoft
 * ADPCM (format 2); browsers play neither, so both are decoded to plain samples.
 */

export const WAV_PCM = 1;
export const WAV_MS_ADPCM = 2;
export const WAV_IMA_ADPCM = 0x11;

const FORMATS: Record<number, string> = { [WAV_PCM]: 'PCM', [WAV_MS_ADPCM]: 'Microsoft ADPCM', 3: 'IEEE float', 6: 'A-law', 7: 'µ-law', [WAV_IMA_ADPCM]: 'IMA ADPCM' };

/** Microsoft's IMA ADPCM: blocks that each start with every channel's sample and step index; stereo interleaves 4 bytes (8 samples) per channel. */
export function decodeImaWav(data: Uint8Array, channels: number, blockAlign: number): Int16Array {
    const perBlock = ((blockAlign - 4 * channels) * 8) / (4 * channels) + 1;
    const blocks = Math.floor(data.length / blockAlign);
    const out = new Int16Array(blocks * perBlock * channels);
    for (let blk = 0; blk < blocks; blk++) {
        const at = blk * blockAlign;
        const base = blk * perBlock * channels;
        for (let c = 0; c < channels; c++) {
            const h = at + c * 4;
            const state = { sample: ((data[h] | (data[h + 1] << 8)) << 16) >> 16, index: Math.min(data[h + 2], 88) };
            out[base + c] = state.sample;
            let n = 1;
            for (let group = 0; at + 4 * channels + (group * channels + c) * 4 < at + blockAlign; group++) {
                const g = at + 4 * channels + (group * channels + c) * 4;
                for (let i = 0; i < 4; i++) {
                    const byte = data[g + i];
                    out[base + n++ * channels + c] = imaSample(state, byte & 0x0f);
                    out[base + n++ * channels + c] = imaSample(state, byte >> 4);
                }
            }
        }
    }
    return out;
}

/** How much each 4-bit code scales the step (Microsoft ADPCM's adaptation table, in 256ths). */
const MS_ADAPTATION = [230, 230, 230, 230, 307, 409, 512, 614, 768, 614, 512, 409, 307, 230, 230, 230];
/** The seven predictor coefficient pairs every Microsoft ADPCM file has (in 256ths); a file can list more. */
export const MS_COEFFICIENTS: [number, number][] = [
    [256, 0],
    [512, -256],
    [0, 0],
    [192, 64],
    [240, 0],
    [460, -208],
    [392, -232],
];

/**
 * Microsoft ADPCM: blocks that each start with every channel's predictor
 * (which coefficient pair), step, and two samples (the second is the first
 * played), then 4-bit codes, high nibble first; stereo takes one nibble a channel.
 */
export function decodeMsAdpcm(data: Uint8Array, channels: number, blockAlign: number, coefficients: [number, number][]): Int16Array {
    const header = 7 * channels;
    const perBlock = ((blockAlign - header) * 2) / channels + 2;
    const blocks = Math.floor(data.length / blockAlign);
    const out = new Int16Array(blocks * perBlock * channels);
    const s16 = (at: number) => ((data[at] | (data[at + 1] << 8)) << 16) >> 16;
    const clamp = (v: number) => (v < -32768 ? -32768 : v > 32767 ? 32767 : v);
    const c1 = new Int32Array(channels);
    const c2 = new Int32Array(channels);
    const delta = new Int32Array(channels);
    const s1 = new Int32Array(channels);
    const s2 = new Int32Array(channels);
    let o = 0;
    for (let b = 0; b < blocks; b++) {
        const at = b * blockAlign;
        for (let c = 0; c < channels; c++) {
            [c1[c], c2[c]] = coefficients[data[at + c]] ?? coefficients[0];
            delta[c] = s16(at + channels + c * 2);
            s1[c] = s16(at + channels * 3 + c * 2);
            s2[c] = s16(at + channels * 5 + c * 2);
        }
        for (let c = 0; c < channels; c++) out[o++] = s2[c];
        for (let c = 0; c < channels; c++) out[o++] = s1[c];
        const nibble = (c: number, code: number) => {
            // The prediction divides by 256 as C does, toward zero (a shift would round negative ones down).
            const predicted = clamp(Math.trunc((s1[c] * c1[c] + s2[c] * c2[c]) / 256) + ((code << 28) >> 28) * delta[c]);
            s2[c] = s1[c];
            s1[c] = predicted;
            delta[c] = Math.max(16, (MS_ADAPTATION[code] * delta[c]) >> 8);
            out[o++] = predicted;
        };
        // Codes run channel by channel in turn: mono, high nibble then low; stereo, left then right in each byte.
        let channel = 0;
        for (let k = at + header; k < at + blockAlign; k++) {
            nibble(channel, data[k] >> 4);
            channel = (channel + 1) % channels;
            nibble(channel, data[k] & 15);
            channel = (channel + 1) % channels;
        }
    }
    return out;
}

const parser: FormatParser = {
    parse(data) {
        const b = new Bytes(data);
        if (b.ascii(0, 4) !== 'RIFF' || b.ascii(8, 4) !== 'WAVE') throw new Error('No RIFF/WAVE header.');
        const fields: Field[] = [
            {
                name: 'RIFF header',
                offset: 0,
                length: 12,
                children: [field('ID', 0, 4, 'RIFF'), field('Size', 4, 4, bytesLabel(b.u32(4)), 'Of everything after this field.'), field('Type', 8, 4, 'WAVE')],
            },
        ];
        const warnings: string[] = [];
        let format = 0,
            channels = 0,
            rate = 0,
            blockAlign = 0,
            bits = 0;
        let fmtAt = 0;
        let sound: Uint8Array | null = null;
        for (let at = 12; at + 8 <= data.length;) {
            const id = b.ascii(at, 4);
            const size = b.u32(at + 4);
            const body = at + 8;
            if (id === 'fmt ') {
                fmtAt = body;
                [format, channels, rate, blockAlign, bits] = [b.u16(body), b.u16(body + 2), b.u32(body + 4), b.u16(body + 12), b.u16(body + 14)];
                fields.push({
                    name: 'fmt ',
                    offset: at,
                    length: 8 + size,
                    children: [
                        field('Format', body, 2, `${format} (${FORMATS[format] ?? 'unknown'})`),
                        field('Channels', body + 2, 2, channels),
                        field('Sample rate', body + 4, 4, `${rate} Hz`),
                        field('Bytes per second', body + 8, 4, b.u32(body + 8)),
                        field('Block size', body + 12, 2, blockAlign, 'Bytes in each block of samples.'),
                        field('Bits per sample', body + 14, 2, bits),
                        ...(size > 16 && format === WAV_MS_ADPCM
                            ? [
                                  field('Extra size', body + 16, 2, b.u16(body + 16)),
                                  field('Samples per block', body + 18, 2, b.u16(body + 18)),
                                  field('Coefficient count', body + 20, 2, b.u16(body + 20)),
                                  field(
                                      'Coefficients',
                                      body + 22,
                                      b.u16(body + 20) * 4,
                                      Array.from({ length: b.u16(body + 20) }, (_, k) => `${(b.u16(body + 22 + k * 4) << 16) >> 16} ${(b.u16(body + 24 + k * 4) << 16) >> 16}`).join(', '),
                                      'Predictor pairs, in 256ths: each block names the one it uses.'
                                  ),
                              ]
                            : size > 16
                              ? [field('Extra', body + 16, size - 16, format === WAV_IMA_ADPCM ? `${b.u16(body + 18)} samples per block` : undefined)]
                              : []),
                    ],
                });
            } else {
                if (id === 'data') sound = data.subarray(body, Math.min(body + size, data.length));
                fields.push(field(id, at, 8 + size, bytesLabel(size), id === 'data' ? 'The sound.' : undefined));
            }
            at = body + size + (size & 1);
        }
        if (!sound) warnings.push("There's no data chunk.");

        let clip;
        if (sound && channels > 0 && rate > 0) {
            if (format === WAV_PCM) {
                clip = { wav: data, sampleRate: rate, channels, bits, seconds: sound.length / (rate * channels * (bits / 8)) };
            } else if (format === WAV_MS_ADPCM && blockAlign > 7 * channels) {
                const count = fmtAt && b.u16(fmtAt + 20);
                const coefficients: [number, number][] = count
                    ? Array.from({ length: count }, (_, k) => [(b.u16(fmtAt + 22 + k * 4) << 16) >> 16, (b.u16(fmtAt + 24 + k * 4) << 16) >> 16])
                    : MS_COEFFICIENTS;
                const samples = decodeMsAdpcm(sound, channels, blockAlign, coefficients);
                clip = { wav: wav(samples, rate, channels), sampleRate: rate, channels, bits: 16, seconds: samples.length / channels / rate };
            } else if (format === WAV_IMA_ADPCM && blockAlign > 4 * channels) {
                const samples = decodeImaWav(sound, channels, blockAlign);
                clip = { wav: wav(samples, rate, channels), sampleRate: rate, channels, bits: 16, seconds: samples.length / channels / rate };
            } else {
                warnings.push(`Sound in format ${FORMATS[format] ?? format} can't be played here.`);
            }
        }

        return {
            title: `Sound (WAV, ${FORMATS[format] ?? `format ${format}`})`,
            summary: [
                ['Format', FORMATS[format] ?? String(format)],
                ['Channels', channels === 2 ? 'Stereo' : channels === 1 ? 'Mono' : String(channels)],
                ['Sample rate', `${rate} Hz`],
                ...(clip ? [['Length', `${clip.seconds.toFixed(2)} s`] as [string, string]] : []),
            ],
            fields,
            preview: clip ? { kind: 'audio', ...clip } : undefined,
            warnings,
        };
    },
};

export default parser;
