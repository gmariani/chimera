import { Bytes, bytesLabel, field, hex } from '../../core/bytes';
import type { Field, FormatParser, IndexedImage } from '../../core/types';
import { lcw } from './compression';
import { shpD2Offsets } from './sniff';

/**
 * Dune II-style sprites, which TD and RA still use for their mouse cursors.
 * Unlike TD sprites, every frame has its own size. Frame data is LCW-compressed
 * (unless flag bit 1 says not), and the result has runs of transparent pixels
 * squeezed out: a 0 byte followed by how many zeros.
 */

const FLAG_REMAP = 1;
const FLAG_NOT_LCW = 2;
const FLAG_VARIABLE_REMAP = 4;

function unzero(src: Uint8Array, dest: Uint8Array): void {
    let d = 0;
    for (let s = 0; s < src.length && d < dest.length; ) {
        const value = src[s++];
        if (value === 0) d += src[s++];
        else dest[d++] = value;
    }
}

const parser: FormatParser = {
    parse(data) {
        const offsets = shpD2Offsets(data);
        if (!offsets) throw new Error('The frame offsets don\'t line up with the file.');
        const b = new Bytes(data);
        const count = offsets.length - 1;
        const wide = b.u16(4) === 0;
        const size = wide ? 4 : 2;
        const frames: IndexedImage[] = [];
        const frameFields: Field[] = [];
        const warnings: string[] = [];

        for (let i = 0; i < count; i++) {
            const at = offsets[i];
            const flags = b.u16(at);
            const width = b.u16(at + 3);
            const height = b.u8(at + 5);
            const frameSize = b.u16(at + 6);
            const decodedSize = b.u16(at + 8);
            let start = at + 10;
            let remap: Uint8Array | null = null;
            const children: Field[] = [
                field('Flags', at, 2, `0x${hex(flags, 4)}`, 'Bit 0: a color remap table follows. Bit 1: not LCW-compressed. Bit 2: the table has its own length.'),
                field('Slices', at + 2, 1, b.u8(at + 2), 'Usually the height again.'),
                field('Width', at + 3, 2, width),
                field('Height', at + 5, 1, height),
                field('Frame size', at + 6, 2, bytesLabel(frameSize), 'This header and the data after it.'),
                field('Decoded size', at + 8, 2, bytesLabel(decodedSize), 'After LCW, before the zero runs are expanded.'),
            ];
            if (flags & FLAG_REMAP) {
                const length = flags & FLAG_VARIABLE_REMAP ? b.u8(start++) : 16;
                remap = data.slice(start, start + length);
                children.push(field('Remap table', start, length, `${length} colors`, 'Frame pixels index this table, which indexes the palette (team colors).'));
                start += length;
            }
            const compressed = data.subarray(start, at + frameSize);
            children.push(field('Data', start, compressed.length, bytesLabel(compressed.length)));

            const pixels = new Uint8Array(width * height);
            if (flags & FLAG_NOT_LCW) {
                unzero(compressed, pixels);
            } else {
                const unpacked = new Uint8Array(decodedSize);
                const written = lcw(compressed, unpacked);
                if (written < decodedSize) warnings.push(`Frame ${i + 1} decoded to ${written} of ${decodedSize} bytes.`);
                unzero(unpacked, pixels);
            }
            if (remap) for (let p = 0; p < pixels.length; p++) pixels[p] = remap[pixels[p]] ?? pixels[p];

            frames.push({ width, height, pixels });
            const shared = offsets.findIndex((o) => o === at);
            frameFields.push({ name: `Frame ${i + 1}`, offset: at, length: frameSize, value: shared < i ? `${width} × ${height}, same data as frame ${shared + 1}` : `${width} × ${height}`, children });
        }

        const sizes = new Set(frames.map((f) => `${f.width} × ${f.height}`));
        return {
            title: 'Sprite (Dune II-style SHP)',
            summary: [
                ['Frames', String(count)],
                ['Size', sizes.size === 1 ? [...sizes][0] : `${sizes.size} different sizes`],
                ['Offsets', `${size} bytes each`],
            ],
            fields: [
                field('Frame count', 0, 2, count),
                {
                    name: 'Offsets',
                    offset: 2,
                    length: offsets[0] - 2,
                    note: 'Where each frame starts, counted from byte 2; the last one is the end of the file. Frames that look the same share one copy of the data.',
                    children: offsets.map((o, i) => field(i < count ? `Frame ${i + 1}` : 'End of file', 2 + i * size, size, o, i < count ? undefined : 'Any entries after this are unused.')),
                },
                ...frameFields,
            ],
            preview: { kind: 'images', frames, transparentIndex: 0 },
            warnings,
        };
    },
};

export default parser;
