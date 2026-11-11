import type { Hva, Vxl } from './voxel-data';
import { normalTable } from './voxel-normals';
import { minOf, maxOf } from '../../core/math';

/**
 * Voxel units drawn into a TS or RA2 map: each limb placed by its bounds and
 * animation, turned to the unit's facing, and projected the way the map's
 * diamonds are, with a depth buffer. Each voxel is lit by its normal against
 * the TS/RA2 mission editor's light (EA's GPL source), from the map's top left
 * and above. The editor's brightness, (200 + 300 × light) / 255, washes colors
 * out here, so the range is gentler: 0.7 facing away to 1.25 facing the light.
 */

/** Toward the light, in map cells (rx, ry) and height: the game's light is (1, 0, -1), so it comes from -rx and above. */
const TOWARD_LIGHT = [-Math.SQRT1_2, 0, Math.SQRT1_2];

/** Roughly how many voxels span a cell; RA2's tanks are about 30 long. */
export const VOXELS_PER_CELL = 30;
/** A cell of height, in screen pixels per tile height (TS/RA2 heights are 104 leptons a level, half a tile each). */
const HEIGHT_SCALE = 1.23;

export interface VoxelPartInput {
    vxl: Vxl;
    hva: Hva | null;
    /** Moves the part forward, in voxels (a turret's place on the hull). */
    forward: number;
    /** Raises the part, in voxels (a barrel modeled around its pivot, set on its turret). */
    up?: number;
    /** Moves the part to the right, in voxels. */
    right?: number;
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
 * How many times larger a model is drawn before it's averaged down: at map scale a voxel is about two pixels, and dots that size leave sloped edges (a Disruptor's nose) ragged.
 * Known gap: parts a voxel or two thick still drop out when shrunk (the Disruptor's dark blunt nose comes out as a thin point). The game keeps them, as it draws each voxel
 * as a solid block at map size; doing the same here would mean rasterizing voxels at map scale instead of shrinking a larger picture. Left for later on purpose.
 */
const SUPERSAMPLE = 3;

/**
 * Draws a model facing `facing` (0–255, clockwise from north) for a map whose
 * diamonds are tw × th pixels: drawn SUPERSAMPLE times larger, then each block of
 * pixels averaged into one, shown where at least half the block is covered.
 */
export function drawVoxels(parts: VoxelPartInput[], facing: number, tw: number, th: number, palette: Uint8Array): VoxelPicture | null {
    const s = SUPERSAMPLE;
    const big = drawVoxelsAt(parts, facing, tw * s, th * s, palette);
    if (!big) return null;
    // Line the blocks up so the origin falls on a block's corner.
    const padX = (s - (big.originX % s)) % s;
    const padY = (s - (big.originY % s)) % s;
    const width = Math.ceil((big.width + padX) / s);
    const height = Math.ceil((big.height + padY) / s);
    const rgba = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let r = 0,
                g = 0,
                b = 0,
                n = 0;
            for (let dy = 0; dy < s; dy++) {
                const by = y * s + dy - padY;
                if (by < 0 || by >= big.height) continue;
                for (let dx = 0; dx < s; dx++) {
                    const bx = x * s + dx - padX;
                    if (bx < 0 || bx >= big.width) continue;
                    const i = (by * big.width + bx) * 4;
                    if (!big.rgba[i + 3]) continue;
                    r += big.rgba[i];
                    g += big.rgba[i + 1];
                    b += big.rgba[i + 2];
                    n++;
                }
            }
            if (n * 2 < s * s) continue;
            const o = (y * width + x) * 4;
            // The block's middle, when it's covered: sharp like the game's own pixels; the average only at edges.
            const cy = y * s + (s >> 1) - padY;
            const cx = x * s + (s >> 1) - padX;
            const c = (cy * big.width + cx) * 4;
            if (cy >= 0 && cy < big.height && cx >= 0 && cx < big.width && big.rgba[c + 3]) {
                rgba.set(big.rgba.subarray(c, c + 3), o);
            } else {
                rgba[o] = r / n;
                rgba[o + 1] = g / n;
                rgba[o + 2] = b / n;
            }
            rgba[o + 3] = 255;
        }
    }
    return { width, height, rgba, originX: (big.originX + padX) / s, originY: (big.originY + padY) / s };
}

function drawVoxelsAt(parts: VoxelPartInput[], facing: number, tw: number, th: number, palette: Uint8Array): VoxelPicture | null {
    // Heading and left in map cell space: north is -ry (up and right on the screen), east +rx (down and
    // right). A train facing 0 runs along a track that runs along ry; one facing 64 along rx.
    const angle = (facing / 256) * Math.PI * 2;
    const north = [0, -1];
    const east = [1, 0];
    const ahead = [Math.cos(angle) * north[0] + Math.sin(angle) * east[0], Math.cos(angle) * north[1] + Math.sin(angle) * east[1]];
    const left = [Math.sin(angle) * north[0] - Math.cos(angle) * east[0], Math.sin(angle) * north[1] - Math.cos(angle) * east[1]];

    type Point = { sx: number; sy: number; depth: number; color: number; light: number };
    const points: Point[] = [];
    for (const { vxl, hva, forward, up = 0, right = 0 } of parts) {
        vxl.limbs.forEach((limb, li) => {
            const [sx, sy, sz] = limb.size;
            const normals = normalTable(limb.normals);
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
                        const [px, py, pz] = transform([limb.min[0] + (x + 0.5) * scale[0] + forward, limb.min[1] + (y + 0.5) * scale[1] - right, limb.min[2] + (z + 0.5) * scale[2]]);
                        // The voxel's normal, turned by its limb's animation and the unit's facing, against the light.
                        let light = 1;
                        const ni = limb.normalIndexes[x + sx * (y + sy * z)] * 3;
                        if (ni + 2 < normals.length) {
                            const raw = [normals[ni], normals[ni + 1], normals[ni + 2]];
                            const [nx, ny, nz] = m ? [0, 1, 2].map((r) => m[r * 4] * raw[0] + m[r * 4 + 1] * raw[1] + m[r * 4 + 2] * raw[2]) : raw;
                            const n = [nx * ahead[0] + ny * left[0], nx * ahead[1] + ny * left[1], nz];
                            const length = Math.hypot(n[0], n[1], n[2]) || 1;
                            const facing = (n[0] * TOWARD_LIGHT[0] + n[1] * TOWARD_LIGHT[1] + n[2] * TOWARD_LIGHT[2]) / length;
                            light = 0.7 + 0.55 * Math.max(0, facing);
                        }
                        // Model x is ahead, y to the left, z up; into cells, then onto the screen.
                        const rx = (px * ahead[0] + py * left[0]) / VOXELS_PER_CELL;
                        const ry = (px * ahead[1] + py * left[1]) / VOXELS_PER_CELL;
                        const h = (pz + up) / VOXELS_PER_CELL;
                        points.push({ sx: ((rx - ry) * tw) / 2, sy: ((rx + ry) * th) / 2 - h * th * HEIGHT_SCALE, depth: rx + ry + h, color, light });
                    }
                }
            }
        });
    }
    if (!points.length) return null;

    // Each voxel covers about this many pixels across.
    const dot = Math.max(1, Math.ceil(tw / VOXELS_PER_CELL / Math.SQRT2 + 0.5));
    const left0 = Math.floor(minOf(points.map((p) => p.sx))) - dot;
    const top0 = Math.floor(minOf(points.map((p) => p.sy))) - dot;
    const width = Math.ceil(maxOf(points.map((p) => p.sx))) - left0 + dot * 2;
    const height = Math.ceil(maxOf(points.map((p) => p.sy))) - top0 + dot * 2;
    const rgba = new Uint8Array(width * height * 4);
    const depth = new Float32Array(width * height).fill(-Infinity);
    for (const p of points) {
        const x0 = Math.round(p.sx - left0);
        const y0 = Math.round(p.sy - top0);
        const k = p.light;
        for (let dy = 0; dy < dot; dy++) {
            for (let dx = 0; dx < dot; dx++) {
                const i = (y0 + dy) * width + x0 + dx;
                if (p.depth <= depth[i]) continue;
                depth[i] = p.depth;
                rgba[i * 4] = Math.min(255, palette[p.color * 3] * k);
                rgba[i * 4 + 1] = Math.min(255, palette[p.color * 3 + 1] * k);
                rgba[i * 4 + 2] = Math.min(255, palette[p.color * 3 + 2] * k);
                rgba[i * 4 + 3] = 255;
            }
        }
    }
    return { width, height, rgba, originX: -left0, originY: -top0 };
}
