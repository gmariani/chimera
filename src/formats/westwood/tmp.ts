import { Bytes, field } from '../../core/bytes';
import type { Field, FormatParser, IndexedImage } from '../../core/types';
import { tmpLayout } from './sniff';
import { unpackDiamond } from './tmp-diamond';

export { unpackDiamond };

/**
 * TS and RA2 isometric terrain tiles. A file is one tile set piece: a block of
 * cells, each a diamond 48 × 24 pixels (TS) or 60 × 30 (RA2). Each cell has a
 * 52-byte header (where it goes, how high it sits, its terrain type), then the
 * diamond's pixels row by row (4 wide at the top, widening by 4 to the middle
 * and narrowing again), then a depth image of the same shape, then optionally
 * an "extra" rectangle drawn over it: a cliff face, a tree stump.
 */

const HEADER = 52;
const FLAG_EXTRA = 1;
const FLAG_DEPTH = 2;
const FLAG_DAMAGED = 4;

/** Terrain types, as TS's isotile INIs call them (LandType). */
const TERRAIN = ['Clear', 'Clear', 'Clear', 'Clear', 'Clear', 'Clear', 'Beach', 'Clear', 'Rock', 'Road', 'Water', 'Rough', 'Clear', 'Clear', 'Rough', 'Rough'];

interface Cell {
    index: number;
    offset: number;
    x: number;
    y: number;
    flags: number;
    height: number;
    terrain: number;
    ramp: number;
    diamond: Uint8Array;
    extra?: { x: number; y: number; width: number; height: number; pixels: Uint8Array };
}

const parser: FormatParser = {
    parse(data) {
        const layout = tmpLayout(data, true);
        if (!layout) throw new Error('This isn\'t an isometric tile file the app understands.');
        const b = new Bytes(data);
        const { across, down, width, height, offsets } = layout;
        const warnings: string[] = [];
        const size = (width * height) / 2;

        const cells: Cell[] = [];
        offsets.forEach((offset, index) => {
            if (!offset) return;
            const flags = b.u8(offset + 36);
            const cell: Cell = {
                index,
                offset,
                x: b.i32(offset),
                y: b.i32(offset + 4),
                flags,
                height: b.u8(offset + 40),
                terrain: b.u8(offset + 41),
                ramp: b.u8(offset + 42),
                diamond: unpackDiamond(data.subarray(offset + HEADER, offset + HEADER + size), width, height),
            };
            if (flags & FLAG_EXTRA) {
                const [ex, ey, ew, eh, at] = [b.i32(offset + 20), b.i32(offset + 24), b.u32(offset + 28), b.u32(offset + 32), offset + b.u32(offset + 8)];
                if (ew > 0 && eh > 0 && ew * eh <= 1 << 20 && at + ew * eh <= data.length) cell.extra = { x: ex, y: ey, width: ew, height: eh, pixels: data.subarray(at, at + ew * eh) };
                else warnings.push(`Cell ${index}'s extra image doesn't fit in the file.`);
            }
            cells.push(cell);
        });

        if (!cells.length) {
            return {
                title: `Isometric tiles (${width === 60 ? 'RA2' : 'TS'})`,
                summary: [['Cells', `None of ${across} × ${down}: an empty template`]],
                fields: [
                    { name: 'Header', offset: 0, length: 16, children: [field('Cells across', 0, 4, across), field('Cells down', 4, 4, down), field('Cell width', 8, 4, width), field('Cell height', 12, 4, height)] },
                    field('Offsets', 16, offsets.length * 4, 'all 0: no cells'),
                ],
                warnings,
            };
        }

        // Put each cell where it goes, raised by its height (half a cell per level); extras on top.
        const lift = height / 2;
        const boxes = cells.flatMap((c) => [
            { x: c.x, y: c.y - c.height * lift, w: width, h: height },
            ...(c.extra ? [{ x: c.extra.x, y: c.extra.y - c.height * lift, w: c.extra.width, h: c.extra.height }] : []),
        ]);
        const left = Math.min(...boxes.map((r) => r.x));
        const top = Math.min(...boxes.map((r) => r.y));
        const w = Math.max(...boxes.map((r) => r.x + r.w)) - left;
        const h = Math.max(...boxes.map((r) => r.y + r.h)) - top;
        const pixels = new Uint8Array(w * h);
        const draw = (src: ArrayLike<number>, sw: number, sh: number, x: number, y: number) => {
            for (let sy = 0; sy < sh; sy++) for (let sx = 0; sx < sw; sx++) if (src[sy * sw + sx]) pixels[(y - top + sy) * w + (x - left + sx)] = src[sy * sw + sx];
        };
        for (const c of cells) draw(c.diamond, width, height, c.x, c.y - c.height * lift);
        for (const c of cells) if (c.extra) draw(c.extra.pixels, c.extra.width, c.extra.height, c.extra.x, c.extra.y - c.height * lift);
        const assembled: IndexedImage = { width: w, height: h, pixels };

        const cellFields: Field[] = cells.map((c) => ({
            name: `Cell ${c.index % across}, ${Math.floor(c.index / across)}`,
            offset: c.offset,
            length: HEADER + size,
            children: [
                field('X', c.offset, 4, c.x, 'Where the diamond goes, in pixels.'),
                field('Y', c.offset + 4, 4, c.y),
                field('Extra offset', c.offset + 8, 4, c.extra ? b.u32(c.offset + 8) : '—', 'From the start of this header.'),
                field('Depth offset', c.offset + 12, 4, b.u32(c.offset + 12)),
                field('Extra depth offset', c.offset + 16, 4, c.flags & FLAG_EXTRA ? b.u32(c.offset + 16) : '—'),
                field('Extra X', c.offset + 20, 4, c.extra ? c.extra.x : '—'),
                field('Extra Y', c.offset + 24, 4, c.extra ? c.extra.y : '—'),
                field('Extra width', c.offset + 28, 4, c.extra ? c.extra.width : '—'),
                field('Extra height', c.offset + 32, 4, c.extra ? c.extra.height : '—'),
                field('Flags', c.offset + 36, 4, [c.flags & FLAG_EXTRA && 'extra image', c.flags & FLAG_DEPTH && 'depth', c.flags & FLAG_DAMAGED && 'damaged version'].filter(Boolean).join(', ') || 'none', 'Only the low byte means anything; the rest is leftover memory.'),
                field('Height', c.offset + 40, 1, c.height, 'In levels; each lifts the cell half a cell.'),
                field('Terrain', c.offset + 41, 1, `${c.terrain} (${TERRAIN[c.terrain] ?? 'unknown'})`),
                field('Ramp', c.offset + 42, 1, c.ramp, 'Which way the ground slopes, 0 for flat.'),
                field('Radar colors', c.offset + 43, 6, `left ${[...data.subarray(c.offset + 43, c.offset + 46)].join(',')}; right ${[...data.subarray(c.offset + 46, c.offset + 49)].join(',')}`),
                field('Pixels', c.offset + HEADER, size, `${width} × ${height} diamond`),
            ],
        }));

        return {
            title: `Isometric tiles (${width === 60 ? 'RA2' : 'TS'})`,
            summary: [
                ['Cells', `${cells.length} of ${across} × ${down}`],
                ['Cell size', `${width} × ${height}`],
                ['Highest', `${Math.max(...cells.map((c) => c.height))} levels`],
                ['Extra images', String(cells.filter((c) => c.extra).length)],
            ],
            fields: [
                {
                    name: 'Header',
                    offset: 0,
                    length: 16,
                    children: [field('Cells across', 0, 4, across), field('Cells down', 4, 4, down), field('Cell width', 8, 4, width), field('Cell height', 12, 4, height)],
                },
                { name: `Offsets (${offsets.length})`, offset: 16, length: offsets.length * 4, children: offsets.map((o, i) => field(`Cell ${i}`, 16 + i * 4, 4, o || 'none')) },
                ...cellFields,
            ],
            preview: {
                kind: 'stack',
                items: [
                    { title: 'Assembled', preview: { kind: 'images', frames: [assembled], transparentIndex: 0 } },
                    { title: 'Each cell', preview: { kind: 'images', frames: cells.map((c) => ({ width, height, pixels: c.diamond })), transparentIndex: 0 } },
                ],
            },
            warnings,
        };
    },
};

export default parser;
