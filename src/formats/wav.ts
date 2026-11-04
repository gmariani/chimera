import { Bytes, bytesLabel, field } from '../core/bytes';
import type { Field, FormatParser } from '../core/types';
import { imaSample, wav } from './westwood/adpcm';

/**
 * WAV files (RIFF): chunks of a 4-letter ID and a size. "fmt " says how the
 * sound is stored; "data" holds it. TS and RA2 store theirs as IMA ADPCM
 * (format 0x11), which browsers won't play, so that's decoded to plain samples.
 */

export const WAV_PCM = 1;
export const WAV_IMA_ADPCM = 0x11;

const FORMATS: Record<number, string> = { [WAV_PCM]: 'PCM', 2: 'Microsoft ADPCM', 3: 'IEEE float', 6: 'A-law', 7: 'µ-law', [WAV_IMA_ADPCM]: 'IMA ADPCM' };

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
            const state = { sample: (data[h] | (data[h + 1] << 8)) << 16 >> 16, index: Math.min(data[h + 2], 88) };
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

const parser: FormatParser = {
    parse(data) {
        const b = new Bytes(data);
        if (b.ascii(0, 4) !== 'RIFF' || b.ascii(8, 4) !== 'WAVE') throw new Error('No RIFF/WAVE header.');
        const fields: Field[] = [{ name: 'RIFF header', offset: 0, length: 12, children: [field('ID', 0, 4, 'RIFF'), field('Size', 4, 4, bytesLabel(b.u32(4)), 'Of everything after this field.'), field('Type', 8, 4, 'WAVE')] }];
        const warnings: string[] = [];
        let format = 0, channels = 0, rate = 0, blockAlign = 0, bits = 0;
        let sound: Uint8Array | null = null;
        for (let at = 12; at + 8 <= data.length; ) {
            const id = b.ascii(at, 4);
            const size = b.u32(at + 4);
            const body = at + 8;
            if (id === 'fmt ') {
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
                        ...(size > 16 ? [field('Extra', body + 16, size - 16, format === WAV_IMA_ADPCM ? `${b.u16(body + 18)} samples per block` : undefined)] : []),
                    ],
                });
            } else {
                if (id === 'data') sound = data.subarray(body, Math.min(body + size, data.length));
                fields.push(field(id, at, 8 + size, bytesLabel(size), id === 'data' ? 'The sound.' : undefined));
            }
            at = body + size + (size & 1);
        }
        if (!sound) warnings.push('There\'s no data chunk.');

        let clip;
        if (sound && channels > 0 && rate > 0) {
            if (format === WAV_PCM) {
                clip = { wav: data, sampleRate: rate, channels, bits, seconds: sound.length / (rate * channels * (bits / 8)) };
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
