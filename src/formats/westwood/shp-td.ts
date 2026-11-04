import { Bytes, bytesLabel, field, hex } from '../../core/bytes';
import type { Field, FormatParser } from '../../core/types';
import { decodeShp } from './shp-frames';
import { SHP_FORMAT_LCW, SHP_FORMAT_XOR_LCW, SHP_FORMAT_XOR_PREV } from './sniff';
import { expandPalette } from './vga';

/**
 * Tiberian Dawn / Red Alert sprites. Every frame is the same size; each is
 * either LCW-compressed whole, or a format 40 delta against an earlier frame.
 */

const FORMAT_NAMES: Record<number, string> = {
    [SHP_FORMAT_LCW]: 'LCW (a whole frame)',
    [SHP_FORMAT_XOR_LCW]: 'XOR against a keyframe',
    [SHP_FORMAT_XOR_PREV]: 'XOR against the previous frame',
};

const parser: FormatParser = {
    parse(data) {
        const b = new Bytes(data);
        const count = b.u16(0);
        const width = b.u16(6);
        const height = b.u16(8);
        const flags = b.u16(12);

        const { headers, palette: embedded, frames, warnings } = decodeShp(data);
        const table = 14 + (count + 2) * 8;
        const frameFields: Field[] = headers.slice(0, count).map((h, i) => {
            const note = (FORMAT_NAMES[h.format] ?? `Unknown format 0x${hex(h.format, 2)}`) + (h.keyframe >= 0 ? ` (frame ${h.keyframe + 1})` : '');
            return {
                name: `Frame ${i + 1} offsets`,
                offset: h.at,
                length: 8,
                children: [
                    field('Data offset', h.at, 3, h.offset),
                    field('Format', h.at + 3, 1, `0x${hex(h.format, 2)}`, note),
                    field('Reference', h.at + 4, 4, `0x${hex(h.ref, 6)}`, h.format === SHP_FORMAT_LCW ? 'Unused for whole frames.' : 'The keyframe this delta applies to.'),
                ],
            };
        });

        const dataFields: Field[] = headers.slice(0, count).map((h, i) => field(`Frame ${i + 1} data`, h.offset, headers[i + 1].offset - h.offset, bytesLabel(headers[i + 1].offset - h.offset), FORMAT_NAMES[h.format]));

        return {
            title: 'Sprite (TD/RA SHP)',
            summary: [
                ['Frames', String(count)],
                ['Size', `${width} × ${height}`],
                ['Largest frame', bytesLabel(b.u16(10))],
                ['Palette', embedded ? 'Included' : 'Uses the game palette'],
            ],
            fields: [
                {
                    name: 'Header',
                    offset: 0,
                    length: 14,
                    children: [
                        field('Frame count', 0, 2, count),
                        field('X', 2, 2, b.u16(2), 'Usually 0.'),
                        field('Y', 4, 2, b.u16(4), 'Usually 0.'),
                        field('Width', 6, 2, width),
                        field('Height', 8, 2, height),
                        field('Largest frame', 10, 2, bytesLabel(b.u16(10)), 'The size of the biggest compressed frame: the buffer the game needs.'),
                        field('Flags', 12, 2, `0x${hex(flags, 4)}`, 'Bit 0: a palette follows the offsets.'),
                    ],
                },
                {
                    name: 'Offsets',
                    offset: 14,
                    length: (count + 2) * 8,
                    note: 'One entry per frame, then one marking the end of the file, then a zero entry.',
                    children: [
                        ...frameFields,
                        field('End of file', headers[count].at, 8, headers[count].offset, 'Where the last frame ends.'),
                        field('Terminator', headers[count + 1].at, 8),
                    ],
                },
                ...(embedded ? [field('Palette', table, 768)] : []),
                ...dataFields,
            ],
            preview: { kind: 'images', frames, palette: embedded && expandPalette(embedded), transparentIndex: 0, shadowIndex: 4 },
            warnings,
        };
    },
};

export default parser;
