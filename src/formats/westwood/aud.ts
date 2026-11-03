import { Bytes, bytesLabel, field } from '../../core/bytes';
import type { Field, FormatParser } from '../../core/types';
import { decodeIma, decodeWestwood, wav } from './adpcm';

/**
 * Westwood audio. A 12-byte header, then chunks of compressed sound, each with
 * a small header ending in 0x0000DEAF. Compression 99 is IMA ADPCM (16-bit out);
 * compression 1 is Westwood's own 8-bit scheme.
 */

const COMPRESSION: Record<number, string> = { 1: 'Westwood ADPCM', 99: 'IMA ADPCM' };

const parser: FormatParser = {
    parse(data) {
        const b = new Bytes(data);
        const rate = b.u16(0);
        const size = b.u32(2);
        const outSize = b.u32(6);
        const flags = b.u8(10);
        const compression = b.u8(11);
        const channels = flags & 1 ? 2 : 1;
        const sixteen = compression === 99 || (flags & 2) !== 0;
        const warnings: string[] = [];

        const pcm = sixteen ? new Int16Array(outSize / 2) : new Uint8Array(outSize);
        const state = { index: 0, sample: 0 };
        const chunks: Field[] = [];
        let at = 12;
        let written = 0;
        while (at + 8 <= data.length) {
            const chunkSize = b.u16(at);
            const chunkOut = b.u16(at + 2);
            if (b.u32(at + 4) !== 0xdeaf) {
                warnings.push(`Chunk ${chunks.length + 1} at offset ${at} is missing its 0xDEAF marker; stopped there.`);
                break;
            }
            const src = data.subarray(at + 8, at + 8 + chunkSize);
            written =
                compression === 99
                    ? decodeIma(src, pcm as Int16Array, state, written)
                    : decodeWestwood(src, pcm as Uint8Array, written, chunkOut);
            chunks.push({
                name: `Chunk ${chunks.length + 1}`,
                offset: at,
                length: 8 + chunkSize,
                value: `${bytesLabel(chunkSize)} → ${bytesLabel(chunkOut)}`,
                children: [field('Compressed size', at, 2, chunkSize), field('Decoded size', at + 2, 2, chunkOut), field('Marker', at + 4, 4, '0x0000DEAF'), field('Data', at + 8, chunkSize)],
            });
            at += 8 + chunkSize;
        }
        const seconds = written / (rate * channels);

        return {
            title: 'Audio (AUD)',
            summary: [
                ['Length', `${seconds.toFixed(2)} s`],
                ['Format', `${rate} Hz, ${channels === 2 ? 'stereo' : 'mono'}, ${sixteen ? 16 : 8}-bit`],
                ['Compression', COMPRESSION[compression] ?? `Unknown (${compression})`],
                ['Chunks', String(chunks.length)],
            ],
            fields: [
                {
                    name: 'Header',
                    offset: 0,
                    length: 12,
                    children: [
                        field('Sample rate', 0, 2, `${rate} Hz`),
                        field('Compressed size', 2, 4, bytesLabel(size), 'Everything after this header.'),
                        field('Decoded size', 6, 4, bytesLabel(outSize)),
                        field('Flags', 10, 1, flags, 'Bit 0: stereo. Bit 1: 16-bit.'),
                        field('Compression', 11, 1, compression, COMPRESSION[compression] ?? 'Unknown'),
                    ],
                },
                { name: `Chunks (${chunks.length})`, offset: 12, length: at - 12, note: 'The game streams sound in small chunks, each decoded in turn.', children: chunks },
            ],
            preview: { kind: 'audio', wav: wav(pcm, rate, channels), sampleRate: rate, channels, bits: sixteen ? 16 : 8, seconds },
            warnings,
        };
    },
};

export default parser;
