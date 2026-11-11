import { pixelBuffer } from '../../core/limits';
/**
 * Fills outlines with antialiasing: each line adds the area it covers to an
 * accumulation buffer, and a running sum across it gives each pixel's
 * coverage (the method of font-rs). Curves are cut into short lines first.
 */

/** A path: moves, lines, and quadratic and cubic curves, in font units. */
export type PathCommand = ['M', number, number] | ['L', number, number] | ['Q', number, number, number, number] | ['C', number, number, number, number, number, number] | ['Z'];

export class Raster {
    private readonly acc: Float32Array;

    constructor(
        readonly width: number,
        readonly height: number
    ) {
        this.acc = new Float32Array(width * height + 4);
    }

    /** Fills a path, mapping each point through (x, y) → (x · scale + dx, dy − y · scale), since fonts' y goes up. */
    fill(path: PathCommand[], scale: number, dx: number, dy: number): void {
        const map = (x: number, y: number): [number, number] => [x * scale + dx, dy - y * scale];
        let start: [number, number] = [0, 0];
        let at: [number, number] = [0, 0];
        let open = false;
        const close = () => {
            if (open && (at[0] !== start[0] || at[1] !== start[1])) this.line(at, start);
            open = false;
        };
        for (const c of path) {
            if (c[0] === 'M') {
                close();
                start = at = map(c[1], c[2]);
                open = true;
            } else if (c[0] === 'L') {
                const p = map(c[1], c[2]);
                this.line(at, p);
                at = p;
            } else if (c[0] === 'Q') {
                const [p1, p2] = [map(c[1], c[2]), map(c[3], c[4])];
                const n = segments(at, p2, p1);
                let prev = at;
                for (let i = 1; i <= n; i++) {
                    const t = i / n;
                    const u = 1 - t;
                    const p: [number, number] = [u * u * at[0] + 2 * u * t * p1[0] + t * t * p2[0], u * u * at[1] + 2 * u * t * p1[1] + t * t * p2[1]];
                    this.line(prev, p);
                    prev = p;
                }
                at = p2;
            } else if (c[0] === 'C') {
                const [p1, p2, p3] = [map(c[1], c[2]), map(c[3], c[4]), map(c[5], c[6])];
                const n = segments(at, p3, p1, p2);
                let prev = at;
                for (let i = 1; i <= n; i++) {
                    const t = i / n;
                    const u = 1 - t;
                    const p: [number, number] = [
                        u * u * u * at[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
                        u * u * u * at[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
                    ];
                    this.line(prev, p);
                    prev = p;
                }
                at = p3;
            } else {
                close();
                at = start;
            }
        }
        close();
    }

    private line(a: [number, number], b: [number, number]): void {
        if (a[1] === b[1]) return;
        const w = this.width;
        const [dir, p0, p1] = a[1] < b[1] ? [1, a, b] : [-1, b, a];
        const dxdy = (p1[0] - p0[0]) / (p1[1] - p0[1]);
        let x = p0[0];
        if (p0[1] < 0) x -= p0[1] * dxdy;
        const clampX = (v: number) => Math.min(Math.max(v, 0), w - 1.001);
        for (let y = Math.max(0, Math.floor(p0[1])); y < Math.min(this.height, Math.ceil(p1[1])); y++) {
            const row = y * w;
            const dy = Math.min(y + 1, p1[1]) - Math.max(y, p0[1]);
            const xNext = x + dxdy * dy;
            const d = dy * dir;
            const [x0, x1] = x < xNext ? [clampX(x), clampX(xNext)] : [clampX(xNext), clampX(x)];
            const x0Floor = Math.floor(x0);
            const x0i = x0Floor;
            const x1Ceil = Math.ceil(x1);
            const x1i = x1Ceil;
            if (x1i <= x0i + 1) {
                const xmf = 0.5 * (clampX(x) + clampX(xNext)) - x0Floor;
                this.acc[row + x0i] += d - d * xmf;
                this.acc[row + x0i + 1] += d * xmf;
            } else {
                const s = 1 / (x1 - x0);
                const x0f = x0 - x0Floor;
                const a0 = 0.5 * s * (1 - x0f) * (1 - x0f);
                const x1f = x1 - x1Ceil + 1;
                const am = 0.5 * s * x1f * x1f;
                this.acc[row + x0i] += d * a0;
                if (x1i === x0i + 2) {
                    this.acc[row + x0i + 1] += d * (1 - a0 - am);
                } else {
                    const a1 = s * (1.5 - x0f);
                    this.acc[row + x0i + 1] += d * (a1 - a0);
                    for (let xi = x0i + 2; xi < x1i - 1; xi++) this.acc[row + xi] += d * s;
                    const a2 = a1 + (x1i - x0i - 3) * s;
                    this.acc[row + x1i - 1] += d * (1 - a2 - am);
                }
                this.acc[row + x1i] += d * am;
            }
            x = xNext;
        }
    }

    /** Each pixel's coverage, 0 to 255. */
    coverage(): Uint8Array {
        const out = pixelBuffer(this.width, this.height);
        let sum = 0;
        for (let i = 0; i < out.length; i++) {
            sum += this.acc[i];
            out[i] = Math.min(255, Math.round(Math.abs(sum) * 255));
        }
        return out;
    }
}

/** How many lines to cut a curve into: more for longer ones. */
function segments(...points: [number, number][]): number {
    let length = 0;
    for (let i = 1; i < points.length; i++) length += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    return Math.max(2, Math.min(32, Math.ceil(length / 3)));
}
