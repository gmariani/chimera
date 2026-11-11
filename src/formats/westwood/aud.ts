import { Bytes, bytesLabel, field } from '../../core/bytes';
import { checkBytes } from '../../core/limits';
import type { Field, FormatParser } from '../../core/types';
import { decodeIma, decodeWestwood, wav } from './adpcm';

/**
 * Westwood audio (1994–1999: Kyrandia 3, C&C, Red Alert, Tiberian Sun, Dune
 * 2000, Blade Runner). A 12-byte header (rate, the size after the header, the
 * decoded size, flags, compression), then chunks of sound, each with a small
 * header ending in 0x0000DEAF. Compression 0 is plain PCM, 1 Westwood's own
 * 8-bit ADPCM, 99 IMA ADPCM (16-bit out). The games read the chunks the same
 * way whatever the compression (Red Alert's Sample_Copy), so plain PCM is in
 * chunks too. See https://moddingwiki.shikadi.net/wiki/Westwood_AUD_Format.
 */

export const AUD_COMPRESSION: Record<number, string> = { 0: 'None (PCM)', 1: 'Westwood ADPCM', 99: 'IMA ADPCM' };

const parser: FormatParser = {
    parse(data) {
        if (data.length < 12) throw new Error(`An AUD header is 12 bytes; this is ${bytesLabel(data.length)}.`);
        const b = new Bytes(data);
        const rate = b.u16(0);
        const size = b.u32(2);
        const outSize = b.u32(6);
        const flags = b.u8(10);
        const compression = b.u8(11);
        if (!(compression in AUD_COMPRESSION)) throw new Error(`Compression ${compression} isn't one AUD files use (0, 1 and 99 are).`);
        if (rate === 0) throw new Error('The sample rate is 0.');
        const channels = flags & 1 ? 2 : 1;
        const warnings: string[] = [];

        // IMA always makes 16-bit sound and Westwood's ADPCM 8-bit, whatever the flag says; plain PCM is what the flag says.
        const flagSixteen = (flags & 2) !== 0;
        const sixteen = compression === 99 || (compression === 0 && flagSixteen);
        if (compression === 1 && flagSixteen) warnings.push('The flags say 16-bit, but Westwood ADPCM only makes 8-bit sound; played as 8-bit.');
        if (compression === 99 && !flagSixteen) warnings.push('The flags say 8-bit, but IMA ADPCM makes 16-bit sound; played as 16-bit.');
        if (flags > 3) warnings.push(`Flags ${flags} set bits AUD doesn't define (only bit 0, stereo, and bit 1, 16-bit).`);
        if (size !== data.length - 12) warnings.push(`The header says ${bytesLabel(size)} follow it, but ${bytesLabel(Math.max(0, data.length - 12))} do.`);

        // At most 4 bytes of sound from each byte (1 when it isn't compressed), so a header that claims more is wrong (or made to exhaust memory).
        const most = Math.max(0, data.length - 12) * (compression === 0 ? 1 : 4);
        if (outSize > most) warnings.push(`The header says ${bytesLabel(outSize)} of sound, but ${bytesLabel(data.length)} can hold at most ${bytesLabel(most)}; only what's there is decoded.`);
        const room = checkBytes(Math.min(outSize, most), 'The sound');
        const pcm = sixteen ? new Int16Array(room >> 1) : new Uint8Array(room);
        const state = { index: 0, sample: 0 };
        const chunks: Field[] = [];
        let at = 12;
        // In samples (bytes for 8-bit sound).
        let written = 0;
        // What the chunks say they decode to, and the ones that decode to something else.
        let claimed = 0;
        const off: { index: number; says: number; made: number; short: number }[] = [];
        while (at + 8 <= data.length) {
            const chunkSize = b.u16(at);
            const chunkOut = b.u16(at + 2);
            if (b.u32(at + 4) !== 0xdeaf) {
                warnings.push(`Chunk ${chunks.length + 1} at offset ${at.toLocaleString('en-US')} is missing its 0xDEAF marker; stopped there.`);
                break;
            }
            if (at + 8 + chunkSize > data.length) warnings.push(`Chunk ${chunks.length + 1} says it's ${bytesLabel(chunkSize)}, but only ${bytesLabel(data.length - at - 8)} are left.`);
            const src = data.subarray(at + 8, at + 8 + chunkSize);
            const before = written;
            if (compression === 0) {
                if (sixteen) {
                    const n = Math.min(src.length >> 1, pcm.length - written);
                    for (let i = 0; i < n; i++) pcm[written + i] = (src[i * 2] | (src[i * 2 + 1] << 8)) << 16 >> 16;
                    written += n;
                } else {
                    const n = Math.min(src.length, pcm.length - written);
                    (pcm as Uint8Array).set(src.subarray(0, n), written);
                    written += n;
                }
            } else {
                written = compression === 99 ? decodeIma(src, pcm as Int16Array, state, written) : decodeWestwood(src, pcm as Uint8Array, written, chunkOut);
            }
            claimed += chunkOut;
            // Once the sound's room is full, a chunk can't show what it makes; the header check covers that.
            const made = (written - before) * (sixteen ? 2 : 1);
            if (made !== chunkOut && written < pcm.length) off.push({ index: chunks.length, says: chunkOut, made, short: chunkOut - made });
            chunks.push({
                name: `Chunk ${chunks.length + 1}`,
                offset: at,
                length: Math.min(8 + chunkSize, data.length - at),
                value: `${bytesLabel(chunkSize)} → ${bytesLabel(chunkOut)}`,
                children: [field('Compressed size', at, 2, chunkSize), field('Decoded size', at + 2, 2, chunkOut), field('Marker', at + 4, 4, '0x0000DEAF'), field('Data', at + 8, src.length)],
            });
            at = Math.min(at + 8 + chunkSize, data.length);
        }
        if (!chunks.length) warnings.push('There are no chunks: the sound has to follow the header in chunks, each marked 0xDEAF.');
        // Westwood's IMA encoder drops the last sample of a sound with an odd number of them (it would take half a byte), but counts
        // it in the last chunk's size: one sample (2 bytes; 1 when the header's count is odd too) short there is how the games' files are.
        const last = off.at(-1);
        if (compression === 99 && last?.index === chunks.length - 1 && (last.short === 2 || last.short === 1)) off.pop();
        if (off.length) {
            const f = off[0];
            const what = `chunk ${f.index + 1} says ${f.says.toLocaleString('en-US')} bytes but makes ${f.made.toLocaleString('en-US')}`;
            const plain = compression === 0 ? ' Nothing is compressed, so the two sizes should match.' : '';
            warnings.push(off.length === 1 ? `A chunk doesn't decode to the size it gives: ${what}.${plain}` : `${off.length.toLocaleString('en-US')} chunks don't decode to the size they give (the first: ${what}).${plain}`);
        }
        if (chunks.length && claimed !== outSize && outSize <= most) warnings.push(`The header says the sound is ${bytesLabel(outSize)}, but its chunks add up to ${bytesLabel(claimed)}.`);
        const seconds = written / (rate * channels);

        return {
            title: 'Audio (AUD)',
            summary: [
                ['Length', `${seconds.toFixed(2)} s`],
                ['Format', `${rate.toLocaleString('en-US')} Hz, ${channels === 2 ? 'stereo' : 'mono'}, ${sixteen ? 16 : 8}-bit`],
                ['Compression', AUD_COMPRESSION[compression]],
                ['Chunks', chunks.length.toLocaleString('en-US')],
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
                        field('Compression', 11, 1, compression, AUD_COMPRESSION[compression]),
                    ],
                },
                { name: `Chunks (${chunks.length})`, offset: 12, length: at - 12, note: 'The game streams sound in small chunks, each decoded in turn.', children: chunks },
            ],
            preview: { kind: 'audio', wav: wav(pcm.subarray(0, written), rate, channels), sampleRate: rate, channels, bits: sixteen ? 16 : 8, seconds },
            // Anything after the last chunk (or from a chunk without its marker) isn't sound; the usual checks look at it.
            end: at,
            warnings,
        };
    },
};

export default parser;
