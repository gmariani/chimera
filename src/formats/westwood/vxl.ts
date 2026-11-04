import { Bytes, bytesLabel, field } from '../../core/bytes';
import type { Field, FormatParser, IndexedImage } from '../../core/types';

/**
 * TS and RA2 voxel models (.vxl): units drawn from 3D blocks. A header (with a
 * palette the games ignore; they use the theater's unit palette), a 28-byte
 * header per limb (a part: a body, a turret), the body of voxel data, then a
 * 92-byte tailer per limb with its size, scale, transform and bounds.
 *
 * Each limb's voxels are stored by column: for every x, y, a list of spans,
 * each a skip up the z axis, a count, that many colour and normal pairs, then
 * the count again. The animation (.hva) of the same name moves the limbs.
 */

const HEADER = 802;
const LIMB_HEADER = 28;
const TAILER = 92;
const EMPTY = 0xffffffff;

interface Limb {
    name: string;
    size: [number, number, number];
    /** Colour index per voxel, x fastest then y then z; 0 for empty. */
    colours: Uint8Array;
    count: number;
    tailer: number;
}

/** Each limb seen four ways: from above, the front, the side, and from above at an angle as in the game. */
function views(l: Limb): IndexedImage[] {
    const [sx, sy, sz] = l.size;
    const at = (x: number, y: number, z: number) => l.colours[x + sx * (y + sy * z)];
    const ortho = (w: number, h: number, pick: (u: number, v: number) => number): IndexedImage => {
        const pixels = new Uint8Array(w * h);
        for (let v = 0; v < h; v++) for (let u = 0; u < w; u++) pixels[v * w + u] = pick(u, v);
        return { width: w, height: h, pixels };
    };
    const first = (n: number, f: (i: number) => number) => {
        for (let i = 0; i < n; i++) if (f(i)) return f(i);
        return 0;
    };
    const top = ortho(sx, sy, (x, y) => first(sz, (i) => at(x, y, sz - 1 - i)));
    const front = ortho(sx, sz, (x, v) => first(sy, (i) => at(x, sy - 1 - i, sz - 1 - v)));
    const side = ortho(sy, sz, (y, v) => first(sx, (i) => at(sx - 1 - i, y, sz - 1 - v)));
    // Turned 45° and seen from above: each voxel a 2 × 2 block, farthest drawn first.
    const w = (sx + sy) * 2 + 2;
    const h = sx + sy + sz * 2 + 2;
    const pixels = new Uint8Array(w * h);
    for (let s = 0; s < sx + sy + sz; s++) {
        for (let z = 0; z < sz; z++) {
            for (let x = 0; x < sx; x++) {
                const y = s - x - z;
                if (y < 0 || y >= sy) continue;
                const c = at(x, y, z);
                if (!c) continue;
                const u = (x - y + sy) * 2;
                const v = x + y + (sz - 1 - z) * 2;
                for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) pixels[(v + dy) * w + u + dx] = c;
            }
        }
    }
    return [{ width: w, height: h, pixels }, top, front, side];
}

const parser: FormatParser = {
    parse(data) {
        const b = new Bytes(data);
        if (b.ascii(0, 16) !== 'Voxel Animation\0') throw new Error('No "Voxel Animation" header.');
        const [limbCount, tailerCount, bodySize] = [b.u32(20), b.u32(24), b.u32(28)];
        const body = HEADER + limbCount * LIMB_HEADER;
        const tailers = body + bodySize;
        if (limbCount === 0 || limbCount > 256 || tailers + tailerCount * TAILER > data.length) throw new Error('The limb counts and body size don\'t fit the file.');
        const warnings: string[] = [];
        const palette = data.subarray(34, 34 + 768);

        const limbs: Limb[] = [];
        for (let i = 0; i < limbCount; i++) {
            const t = tailers + i * TAILER;
            const size: [number, number, number] = [b.u8(t + 88), b.u8(t + 89), b.u8(t + 90)];
            const [sx, sy, sz] = size;
            const colours = new Uint8Array(sx * sy * sz);
            const starts = body + b.u32(t);
            const ends = body + b.u32(t + 4);
            const spans = body + b.u32(t + 8);
            let count = 0;
            for (let col = 0; col < sx * sy; col++) {
                const start = b.u32(starts + col * 4);
                if (start === EMPTY) continue;
                let at = spans + start;
                // The end offset is the column's last byte.
                const last = Math.min(spans + b.u32(ends + col * 4), data.length - 1);
                for (let z = 0; z < sz && at <= last; ) {
                    z += b.u8(at++);
                    const n = b.u8(at++);
                    for (let k = 0; k < n && at < data.length; k++, z++, at += 2) {
                        if (z < sz) {
                            colours[col + sx * sy * z] = data[at] || 1;
                            count++;
                        }
                    }
                    at++;
                }
            }
            limbs.push({ name: b.asciiz(HEADER + i * LIMB_HEADER).text.slice(0, 16), size, colours, count, tailer: t });
        }
        if (tailerCount !== limbCount) warnings.push(`${limbCount} limb headers but ${tailerCount} tailers.`);

        const floats = (at: number, n: number) => Array.from({ length: n }, (_, i) => +b.f32(at + i * 4).toFixed(3)).join(', ');
        const fields: Field[] = [
            {
                name: 'Header',
                offset: 0,
                length: HEADER,
                children: [
                    field('ID', 0, 16, 'Voxel Animation'),
                    field('Palettes', 16, 4, b.u32(16)),
                    field('Limbs', 20, 4, limbCount),
                    field('Tailers', 24, 4, tailerCount),
                    field('Body size', 28, 4, bytesLabel(bodySize)),
                    field('Remap start', 32, 1, b.u8(32), 'The palette range recoloured to the owner\'s colour.'),
                    field('Remap end', 33, 1, b.u8(33)),
                    field('Palette', 34, 768, undefined, 'Unused by the games, which draw voxels with the unit palette.'),
                ],
            },
            ...limbs.map((l, i) => ({
                name: `Limb header ${i}: ${l.name}`,
                offset: HEADER + i * LIMB_HEADER,
                length: LIMB_HEADER,
                children: [field('Name', HEADER + i * LIMB_HEADER, 16, l.name), field('Number', HEADER + i * LIMB_HEADER + 16, 4, b.u32(HEADER + i * LIMB_HEADER + 16))],
            })),
            field('Body', body, bodySize, bytesLabel(bodySize), 'Each limb\'s column offsets and spans.'),
            ...limbs.map((l, i) => ({
                name: `Limb tailer ${i}: ${l.name}`,
                offset: l.tailer,
                length: TAILER,
                children: [
                    field('Span starts', l.tailer, 4, b.u32(l.tailer), 'From the start of the body.'),
                    field('Span ends', l.tailer + 4, 4, b.u32(l.tailer + 4)),
                    field('Span data', l.tailer + 8, 4, b.u32(l.tailer + 8)),
                    field('Scale', l.tailer + 12, 4, +b.f32(l.tailer + 12).toFixed(4)),
                    field('Transform', l.tailer + 16, 48, floats(l.tailer + 16, 12), '3 × 4, row by row.'),
                    field('Minimum bounds', l.tailer + 64, 12, floats(l.tailer + 64, 3)),
                    field('Maximum bounds', l.tailer + 76, 12, floats(l.tailer + 76, 3)),
                    field('Size', l.tailer + 88, 3, l.size.join(' × ')),
                    field('Normals', l.tailer + 91, 1, b.u8(l.tailer + 91) === 2 ? 'TS (36 directions)' : b.u8(l.tailer + 91) === 4 ? 'RA2 (244 directions)' : b.u8(l.tailer + 91)),
                ],
            })),
        ];

        const ownPalette = palette.some((v) => v) ? palette : undefined;
        return {
            title: 'Voxel model (TS/RA2)',
            summary: [
                ['Limbs', limbs.map((l) => `${l.name} (${l.size.join(' × ')}, ${l.count} voxels)`).join('; ')],
                ['Preview', 'Each limb at an angle, then from above, the front and the side; best with the unit palette (unittem.pal)'],
            ],
            fields,
            preview: { kind: 'images', frames: limbs.flatMap(views), palette: ownPalette, transparentIndex: 0 },
            warnings,
        };
    },
};

export default parser;
