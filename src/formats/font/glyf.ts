import type { PathCommand } from './raster';

/**
 * TrueType outlines (the glyf table, found through loca). A simple glyph is
 * contours of points, each on or off the curve; two off-curve points in a row
 * have an on-curve point implied halfway between them. A composite glyph is
 * other glyphs, each moved (and maybe scaled).
 */
export function trueTypeGlyph(data: Uint8Array, glyf: number, loca: number[], index: number, depth = 0): PathCommand[] {
    const start = loca[index];
    const end = loca[index + 1];
    if (start === undefined || end === undefined || end <= start || depth > 8) return [];
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let at = glyf + start;
    const contours = view.getInt16(at);
    at += 10;

    if (contours < 0) {
        // Composite: each part's flags, glyph, offset (or point numbers to match), and scale.
        const path: PathCommand[] = [];
        for (let more = true; more; ) {
            const flags = view.getUint16(at);
            const part = view.getUint16(at + 2);
            at += 4;
            const words = flags & 1;
            const [dx, dy] = words ? [view.getInt16(at), view.getInt16(at + 2)] : [view.getInt8(at), view.getInt8(at + 1)];
            at += words ? 4 : 2;
            let [a, b, c, d] = [1, 0, 0, 1];
            const f2dot14 = (o: number) => view.getInt16(o) / 16384;
            if (flags & 0x08) ((a = d = f2dot14(at)), (at += 2));
            else if (flags & 0x40) ((a = f2dot14(at)), (d = f2dot14(at + 2)), (at += 4));
            else if (flags & 0x80) ((a = f2dot14(at)), (b = f2dot14(at + 2)), (c = f2dot14(at + 4)), (d = f2dot14(at + 6)), (at += 8));
            // Offsets as point numbers (bit 1 clear) are rare; they're taken as no offset.
            const [ox, oy] = flags & 0x02 ? [dx, dy] : [0, 0];
            const map = (x: number, y: number): [number, number] => [x * a + y * c + ox, x * b + y * d + oy];
            for (const cmd of trueTypeGlyph(data, glyf, loca, part, depth + 1)) {
                if (cmd[0] === 'Z') path.push(cmd);
                else if (cmd[0] === 'Q') path.push(['Q', ...map(cmd[1], cmd[2]), ...map(cmd[3], cmd[4])]);
                else if (cmd[0] === 'M' || cmd[0] === 'L') path.push([cmd[0], ...map(cmd[1], cmd[2])]);
            }
            more = (flags & 0x20) !== 0;
        }
        return path;
    }

    const ends = Array.from({ length: contours }, (_, i) => view.getUint16(at + i * 2));
    at += contours * 2;
    at += 2 + view.getUint16(at); // the instructions
    const count = contours ? ends[contours - 1] + 1 : 0;
    const flags = new Uint8Array(count);
    for (let i = 0; i < count; ) {
        const f = data[at++];
        flags[i++] = f;
        if (f & 0x08) for (let r = data[at++]; r > 0 && i < count; r--) flags[i++] = f;
    }
    /** Coordinates: a byte (with its sign in the flags), the same as the last, or a 16-bit delta. */
    const coords = (short: number, same: number) => {
        const out = new Array<number>(count);
        let v = 0;
        for (let i = 0; i < count; i++) {
            const f = flags[i];
            if (f & short) v += f & same ? data[at++] : -data[at++];
            else if (!(f & same)) ((v += view.getInt16(at)), (at += 2));
            out[i] = v;
        }
        return out;
    };
    const xs = coords(0x02, 0x10);
    const ys = coords(0x04, 0x20);

    const path: PathCommand[] = [];
    let first = 0;
    for (const last of ends) {
        const points = Array.from({ length: last - first + 1 }, (_, k) => ({ x: xs[first + k], y: ys[first + k], on: (flags[first + k] & 1) === 1 }));
        first = last + 1;
        if (!points.length) continue;
        // Start on an on-curve point (or halfway between the first two off-curve ones).
        const startAt = points.findIndex((p) => p.on);
        const begin = startAt >= 0 ? points[startAt] : { x: (points[0].x + points[points.length - 1].x) / 2, y: (points[0].y + points[points.length - 1].y) / 2, on: true };
        const ordered = startAt >= 0 ? [...points.slice(startAt + 1), ...points.slice(0, startAt)] : points;
        path.push(['M', begin.x, begin.y]);
        let control: { x: number; y: number } | null = null;
        for (const p of [...ordered, begin]) {
            if (p.on) {
                path.push(control ? ['Q', control.x, control.y, p.x, p.y] : ['L', p.x, p.y]);
                control = null;
            } else if (control) {
                const mid = { x: (control.x + p.x) / 2, y: (control.y + p.y) / 2 };
                path.push(['Q', control.x, control.y, mid.x, mid.y]);
                control = p;
            } else {
                control = p;
            }
        }
        path.push(['Z']);
    }
    return path;
}
