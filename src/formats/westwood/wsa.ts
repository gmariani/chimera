import { Bytes, bytesLabel, field } from '../../core/bytes';
import type { Field, FormatParser, IndexedImage } from '../../core/types';
import { format40, lcw } from './compression';
import { wsaLayout } from './sniff';
import { expandPalette } from './vga';

/**
 * WSA animations (map screens, menus, briefings). Each frame is a format 40
 * delta against the one before, LCW-compressed. A missing first frame means
 * the animation draws over whatever is already on screen; an extra frame at
 * the end takes the last one back to the first, for looping.
 */
const parser: FormatParser = {
    parse(data) {
        const layout = wsaLayout(data);
        if (!layout) throw new Error('The frame offsets don\'t line up with the file.');
        const { frames: count, offsets, palette: hasPalette } = layout;
        const b = new Bytes(data);
        const x = b.u16(2);
        const y = b.u16(4);
        const width = b.u16(6);
        const height = b.u16(8);
        const largest = b.u16(10);
        const table = 14 + (count + 2) * 4;
        const loops = offsets[count + 1] !== 0;
        const warnings: string[] = [];

        const screen = new Uint8Array(width * height);
        // The delta buffer: the game sizes it from the header, plus some slack its own code adds.
        const delta = new Uint8Array(Math.max(largest + 37, width * height * 2));
        const frames: IndexedImage[] = [];
        const dataFields: Field[] = [];
        for (let i = 0; i < count; i++) {
            const start = offsets[i];
            const end = offsets[i + 1];
            if (start === 0) {
                frames.push({ width, height, pixels: screen.slice() });
                continue;
            }
            const size = lcw(data.subarray(start, end), delta);
            format40(delta.subarray(0, size), screen);
            frames.push({ width, height, pixels: screen.slice() });
            dataFields.push(field(`Frame ${i + 1}`, start, end - start, bytesLabel(end - start), `LCW, then a format 40 delta of ${bytesLabel(size)} against frame ${i || 'the screen'}.`));
        }
        if (loops) dataFields.push(field('Loop frame', offsets[count], offsets[count + 1] - offsets[count], bytesLabel(offsets[count + 1] - offsets[count]), 'Takes the last frame back to the first.'));

        return {
            title: 'Animation (WSA)',
            summary: [
                ['Frames', `${count}${loops ? ', loops' : ''}`],
                ['Size', `${width} × ${height}${x || y ? ` at ${x}, ${y}` : ''}`],
                ['Palette', hasPalette ? 'Included' : 'Uses the game palette'],
                ...(offsets[0] === 0 ? [['First frame', 'Missing: it draws over what\'s already on screen'] as [string, string]] : []),
            ],
            fields: [
                {
                    name: 'Header',
                    offset: 0,
                    length: 14,
                    children: [
                        field('Frame count', 0, 2, count),
                        field('X', 2, 2, x, 'Where on screen it plays.'),
                        field('Y', 4, 2, y),
                        field('Width', 6, 2, width),
                        field('Height', 8, 2, height),
                        field('Largest delta', 10, 2, bytesLabel(largest), 'The buffer the game needs to decompress a frame.'),
                        field('Flags', 12, 2, b.u16(12), '1: a palette follows the offsets.'),
                    ],
                },
                {
                    name: 'Offsets',
                    offset: 14,
                    length: (count + 2) * 4,
                    note: hasPalette ? 'Not counting the palette, which sits between these and the frames.' : undefined,
                    children: Array.from({ length: count + 2 }, (_, i) =>
                        field(i < count ? `Frame ${i + 1}` : i === count ? 'Loop frame / end' : 'End', 14 + i * 4, 4, b.u32(14 + i * 4), offsets[i] === 0 ? (i === 0 ? 'No first frame.' : 'Unused.') : undefined),
                    ),
                },
                ...(hasPalette ? [field('Palette', table, 768, '256 colours, 6-bit')] : []),
                ...dataFields,
            ],
            preview: { kind: 'images', frames, palette: hasPalette ? expandPalette(data.subarray(table, table + 768)) : undefined },
            warnings,
        };
    },
};

export default parser;
