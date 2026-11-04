import { Bytes, bytesLabel, field } from '../../core/bytes';
import type { Field, FormatParser, IndexedImage, ParseContext, VoxelPart } from '../../core/types';
import { Links } from '../links';
import { decodeVxl, LIMB_HEADER, readHva, VXL_HEADER, type Limb } from './voxel-data';

/**
 * TS and RA2 voxel models (.vxl): units drawn from 3D blocks. A header (with a
 * palette the games ignore; they use the theater's unit palette), a 28-byte
 * header per limb (a part: a body, a turret), the body of voxel data, then a
 * 92-byte tailer per limb with its size, scale, transform and bounds.
 *
 * The animation (.hva) of the same name places and moves the limbs. Tanks keep
 * their turret and barrel in models of their own (htnktur.vxl, htnkbarl.vxl);
 * when those are in an opened archive, they're shown too.
 */

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

/** A model's limbs as 3D parts, placed and animated by its .hva when there is one. */
function parts(file: string, data: Uint8Array, find: ParseContext['find'], links: Links): { parts: VoxelPart[]; frames: number; animated: boolean } {
    const vxl = decodeVxl(data);
    const hvaFile = file.replace(/\.vxl$/i, '.hva');
    const found = find?.(hvaFile).find((c) => readHva(c.data)?.names.length === vxl.limbs.length);
    const hva = found ? readHva(found.data) : null;
    if (found) links.use(hvaFile, found, `Animation of ${file} (places its limbs)`);
    else if (find) links.miss(hvaFile, `Animation of ${file} (places its limbs)`);
    return {
        parts: vxl.limbs.map((l, i) => ({
            name: `${file} › ${l.name}`,
            size: l.size,
            colours: l.colours,
            min: l.min,
            max: l.max,
            // The animation's translations are in the limb's own units.
            frames: hva
                ? Array.from({ length: hva.frames }, (_, f) => {
                      const m = hva.matrices.slice((f * hva.names.length + i) * 12, (f * hva.names.length + i + 1) * 12);
                      for (const t of [3, 7, 11]) m[t] *= l.scale;
                      return m;
                  })
                : [],
        })),
        frames: hva?.frames ?? 1,
        animated: hva !== null,
    };
}

const parser: FormatParser = {
    parse(data, context) {
        const b = new Bytes(data);
        const vxl = decodeVxl(data);
        const { limbs, body, bodySize, tailerCount } = vxl;
        const warnings: string[] = [];
        if (tailerCount !== limbs.length) warnings.push(`${limbs.length} limb headers but ${tailerCount} tailers.`);

        // This model, then its turret and barrel if they're separate files.
        const name = context.name ?? 'model.vxl';
        const links = new Links();
        const own = parts(name, data, context.find, links);
        const all = [own];
        const stem = name.replace(/\.vxl$/i, '');
        if (!/(tur|barl)$/i.test(stem)) {
            // Not every unit has these, so they're only listed when found.
            for (const [extra, role] of [[`${stem}tur.vxl`, 'Turret'], [`${stem}barl.vxl`, 'Barrel']]) {
                const found = context.find?.(extra)[0];
                if (!found) continue;
                links.use(extra, found, role);
                all.push(parts(extra, found.data, context.find, links));
            }
        }

        const floats = (at: number, n: number) => Array.from({ length: n }, (_, i) => +b.f32(at + i * 4).toFixed(3)).join(', ');
        const fields: Field[] = [
            {
                name: 'Header',
                offset: 0,
                length: VXL_HEADER,
                children: [
                    field('ID', 0, 16, 'Voxel Animation'),
                    field('Palettes', 16, 4, b.u32(16)),
                    field('Limbs', 20, 4, limbs.length),
                    field('Tailers', 24, 4, tailerCount),
                    field('Body size', 28, 4, bytesLabel(bodySize)),
                    field('Remap start', 32, 1, vxl.remap[0], 'The palette range recoloured to the owner\'s colour.'),
                    field('Remap end', 33, 1, vxl.remap[1]),
                    field('Palette', 34, 768, undefined, 'Unused by the games, which draw voxels with the unit palette.'),
                ],
            },
            ...limbs.map((l, i) => ({
                name: `Limb header ${i}: ${l.name}`,
                offset: VXL_HEADER + i * LIMB_HEADER,
                length: LIMB_HEADER,
                children: [field('Name', VXL_HEADER + i * LIMB_HEADER, 16, l.name), field('Number', VXL_HEADER + i * LIMB_HEADER + 16, 4, b.u32(VXL_HEADER + i * LIMB_HEADER + 16))],
            })),
            field('Body', body, bodySize, bytesLabel(bodySize), 'Each limb\'s column offsets and spans.'),
            ...limbs.map((l, i) => ({
                name: `Limb tailer ${i}: ${l.name}`,
                offset: l.tailer,
                length: 92,
                children: [
                    field('Span starts', l.tailer, 4, b.u32(l.tailer), 'From the start of the body.'),
                    field('Span ends', l.tailer + 4, 4, b.u32(l.tailer + 4)),
                    field('Span data', l.tailer + 8, 4, b.u32(l.tailer + 8)),
                    field('Scale', l.tailer + 12, 4, +l.scale.toFixed(4)),
                    field('Transform', l.tailer + 16, 48, floats(l.tailer + 16, 12), '3 × 4, row by row.'),
                    field('Minimum bounds', l.tailer + 64, 12, floats(l.tailer + 64, 3)),
                    field('Maximum bounds', l.tailer + 76, 12, floats(l.tailer + 76, 3)),
                    field('Size', l.tailer + 88, 3, l.size.join(' × ')),
                    field('Normals', l.tailer + 91, 1, l.normals === 2 ? 'TS (36 directions)' : l.normals === 4 ? 'RA2 (244 directions)' : l.normals),
                ],
            })),
        ];

        const ownPalette = vxl.palette.some((v) => v) ? vxl.palette : undefined;
        const frameCount = Math.max(...all.map((p) => p.frames));
        return {
            title: 'Voxel model (TS/RA2)',
            summary: [
                ['Limbs', limbs.map((l) => `${l.name} (${l.size.join(' × ')}, ${l.count} voxels)`).join('; ')],
                ['Shown with', all.length > 1 ? all.slice(1).map((p) => p.parts[0].name.split(' › ')[0]).join(', ') : 'Nothing else'],
                ['Animation', own.animated ? `${stem}.hva, ${own.frames} frame${own.frames === 1 ? '' : 's'}` : 'None found, so the limbs aren\'t placed'],
                ['Colours', 'Best with the unit palette (unittem.pal)'],
            ],
            fields,
            preview: {
                kind: 'stack',
                items: [
                    { title: '3D', preview: { kind: 'voxels', parts: all.flatMap((p) => p.parts), frameCount, palette: ownPalette } },
                    { title: 'Each limb, from four sides', preview: { kind: 'images', frames: limbs.flatMap(views), palette: ownPalette, transparentIndex: 0 } },
                ],
            },
            links: links.list,
            wanted: own.animated || !context.find ? undefined : `${stem.toUpperCase()}.HVA places this model's limbs and animates them. Open the archive it's in (usually the same one) to use it.`,
            warnings,
        };
    },
};

export default parser;
