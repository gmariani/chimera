import type { Hva, Vxl } from './voxel-data';

/**
 * Voxel units drawn into a TS or RA2 map: each limb placed by its bounds and
 * animation, turned to the unit's facing, and projected the way the map's
 * diamonds are, with a depth buffer. The games light each voxel by its normal;
 * here the top of each column is lit and the rest shaded, which reads as close.
 */

/** Roughly how many voxels span a cell; RA2's tanks are about 30 long. */
export const VOXELS_PER_CELL = 30;
/** A cell of height, in screen pixels per tile height (TS/RA2 heights are 104 leptons a level, half a tile each). */
const HEIGHT_SCALE = 1.23;

export interface VoxelPartInput {
    vxl: Vxl;
    hva: Hva | null;
    /** Moves the part forward, in voxels (a turret's place on the hull). */
    forward: number;
}

/** A model's voxels as a small RGBA picture, and where its origin (the unit's position) falls in it. */
export interface VoxelPicture {
    width: number;
    height: number;
    rgba: Uint8Array;
    originX: number;
    originY: number;
}

/**
 * Draws a model facing `facing` (0–255, clockwise from north) for a map whose
 * diamonds are tw × th pixels.
 */
export function drawVoxels(parts: VoxelPartInput[], facing: number, tw: number, th: number, palette: Uint8Array): VoxelPicture | null {
    // Heading and left in map cell space: north is up the screen, which is -rx and -ry together.
    const angle = (facing / 256) * Math.PI * 2;
    const north = [-Math.SQRT1_2, -Math.SQRT1_2];
    const east = [Math.SQRT1_2, -Math.SQRT1_2];
    const ahead = [Math.cos(angle) * north[0] + Math.sin(angle) * east[0], Math.cos(angle) * north[1] + Math.sin(angle) * east[1]];
    const left = [Math.sin(angle) * north[0] - Math.cos(angle) * east[0], Math.sin(angle) * north[1] - Math.cos(angle) * east[1]];

    type Point = { sx: number; sy: number; depth: number; color: number; lit: boolean };
    const points: Point[] = [];
    for (const { vxl, hva, forward } of parts) {
        vxl.limbs.forEach((limb, li) => {
            const [sx, sy, sz] = limb.size;
            const scale = [0, 1, 2].map((i) => (limb.max[i] - limb.min[i]) / (limb.size[i] || 1));
            // The animation's first frame, its translation in the limb's own units.
            const m = hva && hva.names.length === vxl.limbs.length ? hva.matrices.subarray(li * 12, li * 12 + 12) : null;
            const transform = (p: number[]): number[] => {
                if (!m) return p;
                return [0, 1, 2].map((r) => m[r * 4] * p[0] + m[r * 4 + 1] * p[1] + m[r * 4 + 2] * p[2] + m[r * 4 + 3] * limb.scale);
            };
            for (let z = 0; z < sz; z++) {
                for (let y = 0; y < sy; y++) {
                    for (let x = 0; x < sx; x++) {
                        const color = limb.colors[x + sx * (y + sy * z)];
                        if (!color) continue;
                        const above = z + 1 < sz ? limb.colors[x + sx * (y + sy * (z + 1))] : 0;
                        const [px, py, pz] = transform([limb.min[0] + (x + 0.5) * scale[0] + forward, limb.min[1] + (y + 0.5) * scale[1], limb.min[2] + (z + 0.5) * scale[2]]);
                        // Model x is ahead, y to the left, z up; into cells, then onto the screen.
                        const rx = (px * ahead[0] + py * left[0]) / VOXELS_PER_CELL;
                        const ry = (px * ahead[1] + py * left[1]) / VOXELS_PER_CELL;
                        const h = pz / VOXELS_PER_CELL;
                        points.push({ sx: ((rx - ry) * tw) / 2, sy: ((rx + ry) * th) / 2 - h * th * HEIGHT_SCALE, depth: rx + ry + h, color, lit: !above });
                    }
                }
            }
        });
    }
    if (!points.length) return null;

    // Each voxel covers about this many pixels across.
    const dot = Math.max(1, Math.ceil(tw / VOXELS_PER_CELL / Math.SQRT2 + 0.5));
    const left0 = Math.floor(Math.min(...points.map((p) => p.sx))) - dot;
    const top0 = Math.floor(Math.min(...points.map((p) => p.sy))) - dot;
    const width = Math.ceil(Math.max(...points.map((p) => p.sx))) - left0 + dot * 2;
    const height = Math.ceil(Math.max(...points.map((p) => p.sy))) - top0 + dot * 2;
    const rgba = new Uint8Array(width * height * 4);
    const depth = new Float32Array(width * height).fill(-Infinity);
    for (const p of points) {
        const x0 = Math.round(p.sx - left0);
        const y0 = Math.round(p.sy - top0);
        const k = p.lit ? 1 : 0.72;
        for (let dy = 0; dy < dot; dy++) {
            for (let dx = 0; dx < dot; dx++) {
                const i = (y0 + dy) * width + x0 + dx;
                if (p.depth <= depth[i]) continue;
                depth[i] = p.depth;
                rgba[i * 4] = palette[p.color * 3] * k;
                rgba[i * 4 + 1] = palette[p.color * 3 + 1] * k;
                rgba[i * 4 + 2] = palette[p.color * 3 + 2] * k;
                rgba[i * 4 + 3] = 255;
            }
        }
    }
    return { width, height, rgba, originX: -left0, originY: -top0 };
}
