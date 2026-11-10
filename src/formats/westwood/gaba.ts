import { Bytes, bytesLabel, field } from '../../core/bytes';
import type { Entry, FormatParser } from '../../core/types';
import { imaWav, wav } from './adpcm';
import { checkCount } from '../../core/limits';

/**
 * RA2's sound bank index (audio.idx, "GABA"). Each entry names a sound and
 * says where it is in audio.bag (the file of the same name beside it), its
 * sample rate, how it's stored, and for IMA ADPCM the size of each block. The
 * .bag is raw sound with no headers, so with it the sounds come out as WAVs.
 */

const FLAG_STEREO = 1;
const FLAG_16BIT = 4;
const FLAG_IMA = 8;

const parser: FormatParser = {
    parse(data, context) {
        const b = new Bytes(data);
        const [version, count] = [b.u32(4), b.u32(8)];
        const size = version === 2 ? 36 : 32;
        checkCount(count, size, data.length - 12, 'The number of sounds');
        const bagName = `${(context.name ?? 'audio.idx').replace(/\.[^.]+$/, '')}.bag`;
        const bagFile = context.find?.(bagName)[0];
        const bag = bagFile?.data;
        const link = bagFile ? { name: bagName, role: 'Sound data', source: bagFile.source } : { name: bagName, role: 'Sound data (next to this file)' };
        const warnings: string[] = [];

        const sounds = Array.from({ length: count }, (_, i) => {
            const at = 12 + i * size;
            return {
                at,
                name: b.asciiz(at).text.slice(0, 16),
                offset: b.u32(at + 16),
                length: b.u32(at + 20),
                rate: b.u32(at + 24),
                flags: b.u32(at + 28),
                chunk: version === 2 ? b.u32(at + 32) : 0,
            };
        });

        let entries: Entry[] | undefined;
        if (bag) {
            let beyond = 0;
            entries = sounds.map((s) => {
                const raw = bag.subarray(s.offset, s.offset + s.length);
                if (s.offset + s.length > bag.length) beyond++;
                const channels = s.flags & FLAG_STEREO ? 2 : 1;
                const file =
                    s.flags & FLAG_IMA && s.chunk
                        ? imaWav(raw, s.rate, channels, s.chunk)
                        : wav(s.flags & FLAG_16BIT ? new Int16Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + (raw.length & ~1))) : raw, s.rate, channels);
                return { name: `${s.name}.wav`, label: `${s.name}.wav`, offset: s.offset, size: s.length, data: file, meta: { Rate: `${s.rate} Hz`, Kind: s.flags & FLAG_IMA ? 'IMA ADPCM' : 'PCM' } };
            });
            if (beyond) warnings.push(`${beyond} sounds run past the end of ${bagName}.`);
        }

        return {
            title: 'Sound bank index (GABA)',
            summary: [
                ['Sounds', String(count)],
                ['Sound data', bag ? `${bagName}, ${bytesLabel(bag.length)}` : `In ${bagName}, not opened`],
            ],
            fields: [
                { name: 'Header', offset: 0, length: 12, children: [field('ID', 0, 4, 'GABA'), field('Version', 4, 4, version), field('Sounds', 8, 4, count)] },
                ...sounds.map((s) => ({
                    name: s.name,
                    offset: s.at,
                    length: size,
                    children: [
                        field('Name', s.at, 16, s.name),
                        field('Offset', s.at + 16, 4, s.offset, `In ${bagName}.`),
                        field('Size', s.at + 20, 4, bytesLabel(s.length)),
                        field('Sample rate', s.at + 24, 4, `${s.rate} Hz`),
                        field('Flags', s.at + 28, 4, [s.flags & FLAG_STEREO ? 'stereo' : 'mono', s.flags & FLAG_16BIT ? '16-bit' : '8-bit', s.flags & FLAG_IMA && 'IMA ADPCM'].filter(Boolean).join(', ')),
                        ...(version === 2 ? [field('Block size', s.at + 32, 4, s.chunk, 'Bytes per IMA ADPCM block.')] : []),
                    ],
                })),
            ],
            entries,
            links: context.find ? [link] : undefined,
            wanted: bag ? undefined : `The sounds themselves are in ${bagName.toUpperCase()}, next to this file. Open the archive it's in (or the file) to play and save them.`,
            warnings,
        };
    },
};

export default parser;
