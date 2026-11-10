import { field } from '../../core/bytes';
import type { FormatParser } from '../../core/types';
import { stringOffsets } from './sniff';

/**
 * Westwood string tables (.eng, .ger, .fre): the game's text by number. A
 * 2-byte offset per string, then the strings, each ending in a NUL. The first
 * offset is also the size of the offset table, which gives the count.
 */

const latin1 = new TextDecoder('latin1');

const parser: FormatParser = {
    parse(data) {
        const offsets = stringOffsets(data);
        if (!offsets) throw new Error('The offsets at the start don\'t point at a list of strings.');
        const strings = offsets.map((offset) => {
            const end = data.indexOf(0, offset);
            const stop = end < 0 ? data.length : end;
            return { offset, length: stop - offset + (end < 0 ? 0 : 1), text: latin1.decode(data.subarray(offset, stop)) };
        });
        const end = strings.at(-1)!.offset + strings.at(-1)!.length;
        const short = (s: string) => (s.length > 80 ? `${s.slice(0, 80)}…` : s);
        const width = String(strings.length - 1).length;

        return {
            title: 'String table',
            summary: [
                ['Strings', String(strings.length)],
                ['Empty', String(strings.filter((s) => !s.text).length)],
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
                    children: strings.map((s, i) => field(`String ${i}`, s.offset, s.length, JSON.stringify(short(s.text)))),
                },
                ...(end < data.length ? [field('After the last string', end, data.length - end, undefined, 'Not pointed to by any offset.')] : []),
            ],
            preview: {
                kind: 'text',
                text: strings.length === 1 ? strings[0].text : strings.map((s, i) => `${String(i).padStart(width)}  ${s.text.replace(/\r?\n/g, '\\n')}`).join('\n'),
            },
            end,
            warnings: [],
        };
    },
};

export default parser;
