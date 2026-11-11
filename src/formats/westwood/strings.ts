import { field } from '../../core/bytes';
import type { FormatParser } from '../../core/types';
import { dosText, dune2Text, looksCompressed } from './dune2-text';
import { stringOffsets } from './sniff';

/**
 * Westwood string tables (.eng, .ger, .fre): the game's text by number. A
 * 2-byte offset per string, then the strings, each ending in a NUL. The first
 * offset is also the size of the offset table, which gives the count.
 *
 * The text is DOS's: bytes from 0x80 up are the PC's own characters (code page
 * 437), as the games' fonts are. Some of Dune II's (TEXTA.ENG, PROTECT.ENG and
 * the rest) are compressed, a byte for each common pair of letters, which
 * nothing in the file says: they're known by how many of their bytes are high,
 * and how varied (see dune2-text.ts).
 */

const parser: FormatParser = {
    parse(data) {
        const offsets = stringOffsets(data);
        if (!offsets) throw new Error("The offsets at the start don't point at a list of strings.");
        const compressed = looksCompressed(data.subarray(offsets[0]));
        let pairs = 0;
        const strings = offsets.map((offset) => {
            const end = data.indexOf(0, offset);
            const stop = end < 0 ? data.length : end;
            const bytes = data.subarray(offset, stop);
            let text: string;
            if (compressed) {
                const d = dune2Text(bytes);
                pairs += d.pairs;
                text = d.text;
            } else text = dosText(bytes);
            return { offset, length: stop - offset + (end < 0 ? 0 : 1), text };
        });
        const end = strings.at(-1)!.offset + strings.at(-1)!.length;
        const short = (s: string) => (s.length > 80 ? `${s.slice(0, 80)}…` : s);
        const width = String(strings.length - 1).length;

        return {
            title: 'String table',
            summary: [
                ['Strings', String(strings.length)],
                ['Empty', String(strings.filter((s) => !s.text).length)],
                ['Text', compressed ? `Compressed: a byte for each common pair of letters, as Dune II does (${pairs.toLocaleString('en-US')} pairs)` : 'Plain, in DOS’s characters'],
            ],
            fields: [
                {
                    name: `Offsets (${offsets.length})`,
                    offset: 0,
                    length: offsets.length * 2,
                    note: 'Where each string starts. The first one is also the size of this table.',
                    children: offsets.map((o, i) => field(`String ${i}`, i * 2, 2, o)),
                },
                {
                    name: 'Strings',
                    offset: offsets[0],
                    length: end - offsets[0],
                    note: compressed ? 'Compressed: each byte from 0x80 up is two letters.' : undefined,
                    children: strings.map((s, i) => field(`String ${i}`, s.offset, s.length, JSON.stringify(short(s.text)))),
                },
                ...(end < data.length ? [field('After the last string', end, data.length - end, undefined, 'Not pointed to by any offset.')] : []),
            ],
            preview: {
                kind: 'text',
                text: strings.length === 1 ? strings[0].text : strings.map((s, i) => `${String(i).padStart(width)}  ${s.text.replace(/\r\n|\r|\n/g, '\\n')}`).join('\n'),
            },
            end,
            warnings: [],
        };
    },
};

export default parser;
