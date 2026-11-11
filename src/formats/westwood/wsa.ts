import { Bytes, bytesLabel, field } from '../../core/bytes';
import type { Field, FormatParser, IndexedImage } from '../../core/types';
import { format40, lcw } from './compression';
import { WSA_HEADERS, wsaLayout } from './sniff';
import { expandPalette } from './vga';

/**
 * WSA animations (Dune II's mentat screens and cutscenes, C&C's map screens,
 * menus and briefings). Each frame is a format 40 (XOR) delta against the one
 * before, LCW-compressed. A missing first frame means the animation carries on
 * from the last frame of the one before it (Dune II's INTRO8A, B and C); an
 * extra frame at the end takes the last one back to the first, for looping.
 * See https://moddingwiki.shikadi.net/wiki/Westwood_WSA_Format.
 */

/** The game allocates the header's delta size plus this (the format's own quirk). */
const SLACK = 37;

const parser: FormatParser = {
    parse(data) {
        const layout = wsaLayout(data);
        if (!layout) throw new Error('This isn\'t a WSA: its frame offsets don\'t run from the end of the header to the end of the file.');
        const { version, frames: count, width, height, x, y, largest, palette: hasPalette, table, tableEnd, offsets, loops } = layout;
        const h = WSA_HEADERS[version];
        const b = new Bytes(data);
        const warnings: string[] = [];
        const paletteAt = tableEnd;

        const screen = new Uint8Array(width * height);
        // What the game has room for, and a byte over so a delta that wants more shows.
        const room = largest + SLACK;
        const delta = new Uint8Array(Math.max(room, width * height * 2) + 1);
        const frames: IndexedImage[] = [];
        const dataFields: Field[] = [];
        const tooBig: string[] = [];
        const overrun: string[] = [];
        let biggest = 0;
        const apply = (i: number, start: number, end: number) => {
            const name = i < count ? `frame ${i + 1}` : 'the loop frame';
            const size = lcw(data.subarray(start, end), delta);
            biggest = Math.max(biggest, size);
            if (size > room) tooBig.push(name);
            if (format40(delta.subarray(0, size), screen) > screen.length) overrun.push(name);
            return size;
        };
        for (let i = 0; i < count; i++) {
            const start = offsets[i];
            const end = offsets[i + 1];
            if (start === 0) {
                frames.push({ width, height, pixels: screen.slice() });
                continue;
            }
            const size = apply(i, start, end);
            frames.push({ width, height, pixels: screen.slice() });
            dataFields.push(field(`Frame ${i + 1}`, start, end - start, bytesLabel(end - start), `LCW, then a format 40 delta of ${bytesLabel(size)} against ${i ? `frame ${i}` : offsets[0] ? 'a blank screen' : 'the screen'}.`));
        }
        if (loops) {
            const size = apply(count, offsets[count], offsets[count + 1]);
            dataFields.push(field('Loop frame', offsets[count], offsets[count + 1] - offsets[count], bytesLabel(offsets[count + 1] - offsets[count]), `Takes the last frame back to the first (a delta of ${bytesLabel(size)}).`));
            if (offsets[0] !== 0 && !screen.every((v, i) => v === frames[0].pixels[i])) {
                const loopData = data.subarray(offsets[count], offsets[count + 1]);
                const copy = loopData.length === offsets[1] - offsets[0] && loopData.every((v, i) => v === data[offsets[0] + i]);
                warnings.push(`The loop frame doesn't lead back to the first frame${copy ? ': it\'s a copy of the first frame\'s data, not a delta from the last, so looping XORs the picture a second time' : ''}.`);
            }
        }

        // "Frame 1", "Frames 1, 2 and the loop frame", "Frames 1, 2, 3, 4, 5 and 9 more".
        const list = (names: string[]) => {
            const shown = names.length > 6 ? [...names.slice(0, 5), `${names.length - 5} more`] : names;
            const text = shown.length === 1 ? shown[0] : `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}`;
            const plural = names.length > 1 && names.filter((n) => n.startsWith('frame')).length > 1;
            return (plural ? text.replace(/frame (\d)/g, '$1').replace(/^/, 'frames ') : text).replace(/^./, (c) => c.toUpperCase());
        };
        const one = (names: string[]) => names.length === 1;
        if (tooBig.length) warnings.push(`${list(tooBig)} decompress${one(tooBig) ? 'es' : ''} to more than the ${bytesLabel(room)} the header has the game set aside (${bytesLabel(largest)} + ${SLACK}): the game would write past its buffer.`);
        if (overrun.length) warnings.push(`${list(overrun)} reach${one(overrun) ? 'es' : ''} past the ${width} × ${height} frame: the game would draw outside it.`);

        const headerFields: Field[] = [field('Frame count', 0, 2, count)];
        if (h.x >= 0) headerFields.push(field('X', h.x, 2, x, 'Where on screen it plays.'), field('Y', h.y, 2, y));
        headerFields.push(field('Width', h.width, 2, width), field('Height', h.height, 2, height));
        headerFields.push(field('Largest delta', h.delta, 2, bytesLabel(largest), `The game sets aside this plus ${SLACK} bytes to decompress a frame into. The largest here is ${bytesLabel(biggest)}.`));
        if (h.flags >= 0) headerFields.push(field('Flags', h.flags, 2, b.u16(h.flags), '1: a palette follows the offsets.'));

        return {
            title: 'Animation (WSA)',
            summary: [
                ['Version', h.name],
                ['Frames', `${count}${loops ? ', loops' : ''}`],
                ['Size', `${width} × ${height}${x || y ? ` at ${x}, ${y}` : ''}`],
                ['Palette', hasPalette ? 'Included' : 'Uses the game palette'],
                ...(offsets[0] === 0 ? [['First frame', 'Missing: it carries on from the animation before (shown here over a blank screen)'] as [string, string]] : []),
            ],
            fields: [
                { name: 'Header', offset: 0, length: h.size, value: h.name, children: headerFields },
                {
                    name: 'Offsets',
                    offset: table,
                    length: tableEnd - table,
                    note: hasPalette ? 'Not counting the palette, which sits between these and the frames.' : undefined,
                    children: Array.from({ length: count + 2 }, (_, i) =>
                        field(
                            i < count ? `Frame ${i + 1}` : i === count ? (loops ? 'Loop frame' : 'End') : loops ? 'End' : 'Unused',
                            table + i * 4,
                            4,
                            b.u32(table + i * 4),
                            offsets[i] === 0 ? (i === 0 ? 'No first frame.' : 'Unused.') : undefined,
                        ),
                    ),
                },
                ...(hasPalette ? [field('Palette', paletteAt, 768, '256 colors, 6-bit')] : []),
                ...dataFields,
            ],
            preview: { kind: 'images', frames, palette: hasPalette ? expandPalette(data.subarray(paletteAt, paletteAt + 768)) : undefined },
            warnings,
        };
    },
};

export default parser;
