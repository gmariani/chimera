import { Bytes } from '../../core/bytes';
import { hvaLayout } from './sniff';

/**
 * Reading TS and RA2 voxel models (.vxl) and their animations (.hva), shared
 * by both parsers and the 3D preview.
 *
 * A model is limbs (body, turret…), each a box of voxels stored column by
 * column: for every x, y, a list of spans up the z axis, each a skip, a count,
 * that many colour and normal pairs, then the count again.
 */

export const VXL_HEADER = 802;
export const LIMB_HEADER = 28;
export const TAILER = 92;
const EMPTY = 0xffffffff;

export interface Limb {
    name: string;
    size: [number, number, number];
    /** Colour per voxel, x fastest then y then z; 0 for empty (colour 0 is stored as 1 so it shows). */
    colours: Uint8Array;
    count: number;
    tailer: number;
    scale: number;
    min: [number, number, number];
    max: [number, number, number];
    normals: number;
}

export interface Vxl {
    limbs: Limb[];
    bodySize: number;
    body: number;
    tailerCount: number;
    palette: Uint8Array;
    remap: [number, number];
}

export function decodeVxl(data: Uint8Array): Vxl {
    const b = new Bytes(data);
    if (b.ascii(0, 16) !== 'Voxel Animation\0') throw new Error('No "Voxel Animation" header.');
    const [limbCount, tailerCount, bodySize] = [b.u32(20), b.u32(24), b.u32(28)];
    const body = VXL_HEADER + limbCount * LIMB_HEADER;
    const tailers = body + bodySize;
    if (limbCount === 0 || limbCount > 256 || tailers + tailerCount * TAILER > data.length) throw new Error('The limb counts and body size don\'t fit the file.');

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
        const vec = (at: number): [number, number, number] => [b.f32(at), b.f32(at + 4), b.f32(at + 8)];
        limbs.push({
            name: b.asciiz(VXL_HEADER + i * LIMB_HEADER).text.slice(0, 16),
            size,
            colours,
            count,
            tailer: t,
            scale: b.f32(t + 12),
            min: vec(t + 64),
            max: vec(t + 76),
            normals: b.u8(t + 91),
        });
    }
    return { limbs, bodySize, body, tailerCount, palette: data.subarray(34, 34 + 768), remap: [b.u8(32), b.u8(33)] };
}

export interface Hva {
    frames: number;
    names: string[];
    /** For each frame, each section's 3 × 4 transform, row by row: frames × sections × 12. */
    matrices: Float32Array;
}

export function readHva(data: Uint8Array): Hva | null {
    const layout = hvaLayout(data);
    if (!layout) return null;
    const b = new Bytes(data);
    const { frames, sections } = layout;
    const names = Array.from({ length: sections }, (_, i) => b.asciiz(24 + i * 16).text.slice(0, 16));
    const at = 24 + sections * 16;
    const matrices = Float32Array.from({ length: frames * sections * 12 }, (_, i) => b.f32(at + i * 4));
    return { frames, names, matrices };
}
