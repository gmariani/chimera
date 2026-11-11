/**
 * The directions voxel normals point in, one table per class of model (the
 * byte in each limb's tailer): 1 and 3 are rare, 2 is TS's (36 directions), 4
 * RA2's (244). From voxel_normal_tables.bin in the FinalSun / FinalAlert 2
 * mission editor's source, which Electronic Arts released under the GPL 3.
 * Tables (class: count): 1: 16, 2: 36, 3: 64, 4: 245.
 *
 * The file: a table count, then for each a class, a count, and that many x, y, z floats.
 */
const DATA =
    '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' +
    'vvWdDz7/I28/QgiovvWdDz7/I28/';

let tables: Map<number, Float32Array> | null = null;

/** The normals of a class as x, y, z triples; an empty array if there's no such table. */
export function normalTable(normalClass: number): Float32Array {
    if (!tables) {
        tables = new Map();
        const bytes = Uint8Array.from(atob(DATA), (c) => c.charCodeAt(0));
        const view = new DataView(bytes.buffer);
        let at = 1;
        for (let t = 0; t < bytes[0]; t++) {
            const [cls, count] = [bytes[at], bytes[at + 1]];
            tables.set(
                cls,
                Float32Array.from({ length: count * 3 }, (_, i) => view.getFloat32(at + 2 + i * 4, true))
            );
            at += 2 + count * 12;
        }
    }
    return tables.get(normalClass) ?? new Float32Array();
}
