import { bytesLabel, field } from '../core/bytes';
import type { Field, FormatParser } from '../core/types';

/**
 * MPEG audio (MP3, and layers I and II): frames, each a 4-byte header (11 sync
 * bits, then the version, layer, bit rate, sample rate, padding and channel
 * mode) and the coded sound. An ID3v2 tag can come first and an ID3v1 tag
 * (128 bytes, "TAG") last. The browser plays it; this reads the frames.
 */

const BITRATES: Record<string, number[]> = {
    // MPEG-1, layers I, II, III; then MPEG-2 and 2.5, layer I, and layers II and III.
    '1-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    '1-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
    '2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const RATES: Record<number, number[]> = { 1: [44100, 48000, 32000], 2: [22050, 24000, 16000], 25: [11025, 12000, 8000] };
const MODES = ['Stereo', 'Joint stereo', 'Dual channel', 'Mono'];
/** At most this many frames are listed. */
const MAX_FRAMES = 2000;

export interface MpegFrame {
    version: number;
    layer: number;
    bitrate: number;
    rate: number;
    channels: number;
    length: number;
    samples: number;
}

/** The frame header at `at`, if there's a valid one. */
export function mpegFrame(data: Uint8Array, at: number): MpegFrame | null {
    if (at + 4 > data.length || data[at] !== 0xff || (data[at + 1] & 0xe0) !== 0xe0) return null;
    const v = (data[at + 1] >> 3) & 3;
    const l = (data[at + 1] >> 1) & 3;
    const b = data[at + 2] >> 4;
    const r = (data[at + 2] >> 2) & 3;
    if (v === 1 || l === 0 || b === 0 || b === 15 || r === 3) return null;
    const version = v === 3 ? 1 : v === 2 ? 2 : 25;
    const layer = 4 - l;
    const bitrate = BITRATES[version === 1 ? `1-${layer}` : layer === 1 ? '2-1' : '2-2'][b] * 1000;
    const rate = RATES[version][r];
    const padding = (data[at + 2] >> 1) & 1;
    const samples = layer === 1 ? 384 : layer === 3 && version !== 1 ? 576 : 1152;
    const length = layer === 1 ? (Math.floor((12 * bitrate) / rate) + padding) * 4 : Math.floor(((samples / 8) * bitrate) / rate) + padding;
    return { version, layer, bitrate, rate, channels: data[at + 3] >> 6 === 3 ? 1 : 2, length, samples };
}

const parser: FormatParser = {
    parse(data) {
        const fields: Field[] = [];
        const warnings: string[] = [];
        let at = 0;
        if (data[0] === 0x49 && data[1] === 0x44 && data[2] === 0x33) {
            // ID3v2: the size is four 7-bit bytes ("syncsafe"), not counting the 10-byte header.
            const size = ((data[6] & 0x7f) << 21) | ((data[7] & 0x7f) << 14) | ((data[8] & 0x7f) << 7) | (data[9] & 0x7f);
            fields.push({
                name: 'ID3v2 tag',
                offset: 0,
                length: 10 + size,
                value: `v2.${data[3]}`,
                children: [field('Identifier', 0, 3, 'ID3'), field('Version', 3, 2, `2.${data[3]}.${data[4]}`), field('Flags', 5, 1, data[5]), field('Size', 6, 4, bytesLabel(size), 'Seven bits in each byte.'), field('Frames', 10, size, bytesLabel(size))],
            });
            at = 10 + size;
        }
        const end = data.length >= 128 && data[data.length - 128] === 0x54 && data[data.length - 127] === 0x41 && data[data.length - 126] === 0x47 ? data.length - 128 : data.length;
        const frames: Field[] = [];
        let first: MpegFrame | null = null;
        let count = 0;
        let samples = 0;
        let bits = 0;
        const start = at;
        while (at + 4 <= end) {
            const f = mpegFrame(data, at);
            if (!f || f.length < 4) {
                // Junk between frames: skip to the next sync.
                const next = data.indexOf(0xff, at + 1);
                if (next < 0 || next >= end) break;
                if (count) warnings.push(`Bytes ${at} to ${next} aren't an MPEG frame.`);
                at = next;
                continue;
            }
            first ??= f;
            count++;
            samples += f.samples;
            bits += f.bitrate;
            if (frames.length < MAX_FRAMES) frames.push(field(`Frame ${count}`, at, Math.min(f.length, end - at), `${f.bitrate / 1000} kbit/s`));
            at += f.length;
        }
        if (!first) throw new Error('No MPEG audio frames.');
        fields.push({ name: 'Frames', offset: start, length: at - start, value: `${count} frames`, children: frames });
        if (count > MAX_FRAMES) warnings.push(`The first ${MAX_FRAMES} of ${count} frames are listed.`);
        if (end < data.length) {
            const text = (o: number, n: number) => new TextDecoder('latin1').decode(data.subarray(end + o, end + o + n)).replace(/\0.*$/, '').trim();
            fields.push({ name: 'ID3v1 tag', offset: end, length: 128, value: text(3, 30), children: [field('Identifier', end, 3, 'TAG'), field('Title', end + 3, 30, text(3, 30)), field('Artist', end + 33, 30, text(33, 30)), field('Album', end + 63, 30, text(63, 30)), field('Year', end + 93, 4, text(93, 4)), field('Comment', end + 97, 30, text(97, 30)), field('Genre', end + 127, 1, data[end + 127])] });
        }
        const seconds = samples / first.rate;
        return {
            title: `Sound (MPEG-${first.version === 25 ? '2.5' : first.version} layer ${'I'.repeat(first.layer)})`,
            summary: [
                ['Length', `${seconds.toFixed(2)} s`],
                ['Sample rate', `${first.rate} Hz`],
                ['Bit rate', `${Math.round(bits / count / 1000)} kbit/s${bits / count !== first.bitrate ? ' (average)' : ''}`],
                ['Channels', MODES[data[start + 3] >> 6] ?? String(first.channels)],
            ],
            fields,
            preview: { kind: 'audio', wav: data, mime: 'audio/mpeg', sampleRate: first.rate, channels: first.channels, bits: 16, seconds },
            warnings,
        };
    },
};

export default parser;
