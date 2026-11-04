import { Bytes, bytesLabel, field } from '../../core/bytes';
import type { Field, FormatParser, IndexedImage } from '../../core/types';
import { decodeShpTs } from './shp-ts-frames';

/**
 * Tiberian Sun / Red Alert 2 sprites. Each frame is a rectangle placed on a
 * shared canvas, stored raw, as raw scanlines, or with runs of zeros squeezed out.
 */

const COMPRESSION: Record<number, string> = {
    0: 'Uncompressed',
    1: 'Uncompressed',
    2: 'Scanlines, each with a 2-byte length',
    3: 'Scanlines with runs of transparent pixels compressed',
};

const parser: FormatParser = {
    parse(data) {
        const b = new Bytes(data);
        const width = b.u16(2);
        const height = b.u16(4);
        const count = b.u16(6);
        const frames: IndexedImage[] = [];
        const headerFields: Field[] = [];
        const dataFields: Field[] = [];

        const decoded = decodeShpTs(data);
        for (let i = 0; i < count; i++) {
            const at = 8 + i * 24;
            const { x, y, width: w, height: h, compression, offset, end, pixels: canvas } = decoded.frames[i];
            if (offset !== 0 && w && h) dataFields.push(field(`Frame ${i + 1} data`, offset, end - offset, bytesLabel(end - offset), COMPRESSION[compression]));
            frames.push({ width, height, pixels: canvas });
            headerFields.push({
                name: `Frame ${i + 1}`,
                offset: at,
                length: 24,
                value: offset ? `${w} × ${h} at ${x}, ${y}` : 'empty',
                children: [
                    field('X', at, 2, x),
                    field('Y', at + 2, 2, y),
                    field('Width', at + 4, 2, w),
                    field('Height', at + 6, 2, h),
                    field('Compression', at + 8, 1, compression, COMPRESSION[compression] ?? 'Unknown'),
                    field('Unknown', at + 9, 3),
                    field('Radar colour', at + 12, 4, `#${b.u32(at + 12).toString(16).padStart(6, '0').slice(-6)}`, 'Used for the minimap.'),
                    field('Reserved', at + 16, 4),
                    field('Data offset', at + 20, 4, offset, offset ? undefined : 'Zero: the frame is empty.'),
                ],
            });
        }

        return {
            title: 'Sprite (TS/RA2 SHP)',
            summary: [
                ['Frames', String(count)],
                ['Canvas', `${width} × ${height}`],
            ],
            fields: [
                {
                    name: 'Header',
                    offset: 0,
                    length: 8,
                    children: [field('Zero', 0, 2, 0, 'Always 0; tells this format apart from TD sprites.'), field('Width', 2, 2, width), field('Height', 4, 2, height), field('Frame count', 6, 2, count)],
                },
                { name: 'Frame headers', offset: 8, length: count * 24, children: headerFields },
                ...dataFields,
            ],
            preview: { kind: 'images', frames, transparentIndex: 0 },
            warnings: [],
        };
    },
};

export default parser;
