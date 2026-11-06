/**
 * A JPEG decoder for the Huffman-coded DCT processes: baseline, extended
 * (12-bit samples too) and progressive, which is nearly every JPEG there is.
 * Lossless, hierarchical and arithmetic-coded pictures are found but not drawn.
 * After ITU T.81; the progressive refinement follows libjpeg's jdphuff.c.
 */

/** One marker and what follows it. */
export interface Segment {
    /** The second byte of the marker: 0xD8 is SOI, 0xDA SOS and so on. */
    marker: number;
    /** Where the 0xFF is. */
    offset: number;
    /** The marker, its length field and its payload. */
    length: number;
    /** Where the payload starts, past the marker and the length. */
    body: number;
    /** For SOS: the entropy-coded data after the header, up to the next marker that isn't a restart. */
    scan?: { offset: number; length: number; restarts: number };
}

/** Markers with no length field after them. */
const STANDALONE = (m: number) => m === 0xd8 || m === 0xd9 || m === 0x01 || (m >= 0xd0 && m <= 0xd7);

/** Every segment from SOI to EOI, and where the walk stopped (bytes past it are not part of the picture). */
export function segmentsOf(data: Uint8Array): { segments: Segment[]; end: number } {
    const segments: Segment[] = [];
    let at = 0;
    while (at + 1 < data.length) {
        if (data[at] !== 0xff) break;
        // Any number of 0xFF can pad before a marker.
        let m = data[at + 1];
        const start = at;
        while (m === 0xff && at + 2 < data.length) m = data[++at + 1];
        if (STANDALONE(m)) {
            segments.push({ marker: m, offset: start, length: at + 2 - start, body: at + 2 });
            at += 2;
            if (m === 0xd9) break;
            continue;
        }
        if (at + 4 > data.length) break;
        const length = Math.min((data[at + 2] << 8) | data[at + 3], data.length - at - 2);
        const segment: Segment = { marker: m, offset: start, length: at + 2 + length - start, body: at + 4 };
        at += 2 + length;
        if (m === 0xda) {
            // The coded data runs to the first marker that isn't stuffing (0xFF00) or a restart (0xFFD0-D7).
            let end = at;
            let restarts = 0;
            while (end + 1 < data.length) {
                if (data[end] === 0xff) {
                    const next = data[end + 1];
                    if (next >= 0xd0 && next <= 0xd7) restarts++;
                    else if (next !== 0 && next !== 0xff) break;
                }
                end++;
            }
            if (end + 1 >= data.length) end = data.length;
            segment.scan = { offset: at, length: end - at, restarts };
            at = end;
        }
        segments.push(segment);
    }
    return { segments, end: at };
}

/** Where each coefficient of the zigzag order goes in the 8×8 block. */
export const ZIGZAG = new Uint8Array([
    0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
]);

/** A Huffman table as a lookup on the next 16 bits: the code's length and its symbol (0: no such code). */
export function huffmanTable(counts: ArrayLike<number>, symbols: ArrayLike<number>): Uint16Array {
    const table = new Uint16Array(65536);
    let code = 0;
    let k = 0;
    for (let length = 1; length <= 16; length++) {
        for (let i = 0; i < counts[length - 1]; i++) {
            const shift = 16 - length;
            table.fill((length << 8) | symbols[k++], code << shift, (code + 1) << shift);
            code++;
        }
        code <<= 1;
    }
    return table;
}

/** Reads the coded data a bit at a time, dropping stuffed zeros and stopping (on zeros) at a marker. */
class BitReader {
    private acc = 0;
    private count = 0;
    private atMarker = false;

    constructor(
        private readonly data: Uint8Array,
        public pos: number,
    ) {}

    private fill(): void {
        while (this.count <= 24) {
            let b = 0;
            if (!this.atMarker && this.pos < this.data.length) {
                b = this.data[this.pos];
                if (b === 0xff) {
                    const next = this.data[this.pos + 1];
                    if (next === 0) this.pos += 2;
                    else ((this.atMarker = true), (b = 0));
                } else this.pos++;
            }
            this.acc = ((this.acc << 8) | b) >>> 0;
            this.count += 8;
        }
    }

    bits(n: number): number {
        if (n === 0) return 0;
        if (this.count < n) this.fill();
        this.count -= n;
        return (this.acc >>> this.count) & ((1 << n) - 1);
    }

    bit(): number {
        return this.bits(1);
    }

    huffman(table: Uint16Array): number {
        if (this.count < 16) this.fill();
        const e = table[(this.acc >>> (this.count - 16)) & 0xffff];
        if (e === 0) throw new Error('Bad Huffman code in the picture data.');
        this.count -= e >> 8;
        return e & 0xff;
    }

    /** A value of `n` bits, as T.81's EXTEND makes it signed. */
    extend(n: number): number {
        if (n === 0) return 0;
        const v = this.bits(n);
        return v < 1 << (n - 1) ? v - (1 << n) + 1 : v;
    }

    /** Past a restart marker: the bits start again at a byte. */
    restart(): void {
        while (this.pos + 1 < this.data.length && !(this.data[this.pos] === 0xff && this.data[this.pos + 1] >= 0xd0 && this.data[this.pos + 1] <= 0xd7)) this.pos++;
        this.pos += 2;
        this.acc = this.count = 0;
        this.atMarker = false;
    }
}

interface Component {
    id: number;
    h: number;
    v: number;
    tq: number;
    /** Blocks that hold the picture, across and down. */
    blocksAcross: number;
    blocksDown: number;
    /** Blocks stored per row: whole MCUs, so wider than blocksAcross at the edges. */
    stride: number;
    rows: number;
    /** 64 coefficients per block, in natural order. */
    coefficients: Int16Array;
    pred: number;
    dc?: Uint16Array;
    ac?: Uint16Array;
}

export interface Decoded {
    width: number;
    height: number;
    rgba: Uint8Array;
}

/** Start-of-frame markers: 0xC0 to 0xCF but for DHT (C4), JPG (C8) and DAC (CC). */
export const isFrame = (m: number) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;

/** What kind of process a SOF marker starts. */
export function processOf(marker: number): string {
    const kind = ['Baseline', 'Extended sequential', 'Progressive', 'Lossless'][marker & 3];
    return `${marker & 4 ? 'Differential ' + kind.toLowerCase() : kind}${marker & 8 ? ', arithmetic-coded' : ''}`;
}

/** Can the decoder draw pictures of this SOF marker: Huffman-coded, not lossless, not hierarchical. */
export const decodable = (marker: number) => marker === 0xc0 || marker === 0xc1 || marker === 0xc2;

/** Decodes the picture to RGBA. Throws on what it can't read. */
export function decodeJpeg(data: Uint8Array, segments: Segment[]): Decoded {
    const quant: Int32Array[] = [];
    const dcTables: Uint16Array[] = [];
    const acTables: Uint16Array[] = [];
    let restartInterval = 0;
    let adobeTransform: number | null = null;
    let jfif = false;
    let frame: { marker: number; precision: number; width: number; height: number; components: Component[]; maxH: number; maxV: number; mcusAcross: number; mcusDown: number } | null = null;
    const u16 = (at: number) => (data[at] << 8) | data[at + 1];

    for (const s of segments) {
        const p = s.body;
        const end = s.offset + s.length;
        switch (s.marker) {
            case 0xdb:
                for (let at = p; at < end; ) {
                    const sixteen = data[at] >> 4;
                    const table = new Int32Array(64);
                    for (let i = 0; i < 64; i++) table[ZIGZAG[i]] = sixteen ? u16(at + 1 + i * 2) : data[at + 1 + i];
                    quant[data[at] & 15] = table;
                    at += 1 + 64 * (sixteen ? 2 : 1);
                }
                break;
            case 0xc4:
                for (let at = p; at + 17 <= end; ) {
                    const counts = data.subarray(at + 1, at + 17);
                    const total = counts.reduce((a, b) => a + b, 0);
                    const table = huffmanTable(counts, data.subarray(at + 17, at + 17 + total));
                    (data[at] >> 4 ? acTables : dcTables)[data[at] & 15] = table;
                    at += 17 + total;
                }
                break;
            case 0xdd:
                restartInterval = u16(p);
                break;
            case 0xe0:
                if (String.fromCharCode(...data.subarray(p, p + 4)) === 'JFIF') jfif = true;
                break;
            case 0xee:
                if (String.fromCharCode(...data.subarray(p, p + 5)) === 'Adobe') adobeTransform = data[p + 11];
                break;
            default: {
                if (!isFrame(s.marker)) break;
                if (frame) throw new Error('More than one frame (a hierarchical picture), which isn\'t drawn here.');
                if (!decodable(s.marker)) throw new Error(`${processOf(s.marker)} pictures aren't drawn here.`);
                const precision = data[p];
                const height = u16(p + 1);
                const width = u16(p + 3);
                if (!width || !height) throw new Error('The frame has no size (a later DNL marker gives the height), which isn\'t drawn here.');
                const components: Component[] = [];
                for (let i = 0; i < data[p + 5]; i++) {
                    const c = p + 6 + i * 3;
                    components.push({ id: data[c], h: data[c + 1] >> 4 || 1, v: data[c + 1] & 15 || 1, tq: data[c + 2], blocksAcross: 0, blocksDown: 0, stride: 0, rows: 0, coefficients: new Int16Array(0), pred: 0 });
                }
                const maxH = Math.max(...components.map((c) => c.h));
                const maxV = Math.max(...components.map((c) => c.v));
                const mcusAcross = Math.ceil(width / (8 * maxH));
                const mcusDown = Math.ceil(height / (8 * maxV));
                for (const c of components) {
                    c.blocksAcross = Math.ceil(Math.ceil((width * c.h) / maxH) / 8);
                    c.blocksDown = Math.ceil(Math.ceil((height * c.v) / maxV) / 8);
                    c.stride = mcusAcross * c.h;
                    c.rows = mcusDown * c.v;
                    c.coefficients = new Int16Array(c.stride * c.rows * 64);
                }
                frame = { marker: s.marker, precision, width, height, components, maxH, maxV, mcusAcross, mcusDown };
                break;
            }
            case 0xda: {
                if (!frame || !s.scan) throw new Error('A scan comes before the frame header.');
                const count = data[p];
                const scanComponents: Component[] = [];
                for (let i = 0; i < count; i++) {
                    const c = frame.components.find((x) => x.id === data[p + 1 + i * 2]);
                    if (!c) throw new Error(`The scan names component ${data[p + 1 + i * 2]}, which the frame doesn't have.`);
                    c.dc = dcTables[data[p + 2 + i * 2] >> 4];
                    c.ac = acTables[data[p + 2 + i * 2] & 15];
                    scanComponents.push(c);
                }
                const q = p + 1 + count * 2;
                decodeScan(data, s.scan.offset, frame, scanComponents, restartInterval, data[q], data[q + 1], data[q + 2] >> 4, data[q + 2] & 15);
                break;
            }
        }
    }
    if (!frame) throw new Error('There\'s no frame header (SOF).');

    const planes = frame.components.map((c) => samples(c, quant[c.tq] ?? new Int32Array(64).fill(1), frame!.precision));
    return { width: frame.width, height: frame.height, rgba: toRgba(frame, planes, adobeTransform, jfif) };
}

function decodeScan(
    data: Uint8Array,
    offset: number,
    frame: { marker: number; components: Component[]; mcusAcross: number; mcusDown: number },
    components: Component[],
    restartInterval: number,
    ss: number,
    se: number,
    ah: number,
    al: number,
): void {
    const r = new BitReader(data, offset);
    const progressive = frame.marker === 0xc2;
    let eobrun = 0;
    for (const c of components) {
        if (!c.dc && (!progressive || ss === 0) && ah === 0) throw new Error(`Component ${c.id} has no DC Huffman table.`);
        if (!c.ac && (!progressive || ss > 0)) throw new Error(`Component ${c.id} has no AC Huffman table.`);
    }

    const baseline = (c: Component, at: number) => {
        const k = c.coefficients;
        c.pred += r.extend(r.huffman(c.dc!));
        k[at] = c.pred;
        for (let i = 1; i < 64; ) {
            const rs = r.huffman(c.ac!);
            const s = rs & 15;
            if (s === 0) {
                if (rs >> 4 < 15) break;
                i += 16;
                continue;
            }
            i += rs >> 4;
            if (i > 63) break;
            k[at + ZIGZAG[i++]] = r.extend(s);
        }
    };
    const dcFirst = (c: Component, at: number) => {
        c.pred += r.extend(r.huffman(c.dc!));
        c.coefficients[at] = c.pred * (1 << al);
    };
    const dcRefine = (c: Component, at: number) => {
        if (r.bit()) c.coefficients[at] |= 1 << al;
    };
    const acFirst = (c: Component, at: number) => {
        if (eobrun > 0) return void eobrun--;
        const k = c.coefficients;
        for (let i = ss; i <= se; ) {
            const rs = r.huffman(c.ac!);
            const s = rs & 15;
            const run = rs >> 4;
            if (s === 0) {
                if (run < 15) {
                    eobrun = (1 << run) - 1 + r.bits(run);
                    break;
                }
                i += 16;
                continue;
            }
            i += run;
            if (i > 63) break;
            k[at + ZIGZAG[i++]] = r.extend(s) * (1 << al);
        }
    };
    const acRefine = (c: Component, at: number) => {
        const k = c.coefficients;
        const p1 = 1 << al;
        const m1 = -1 << al;
        const refine = (z: number) => {
            if (r.bit() && (k[z] & p1) === 0) k[z] += k[z] >= 0 ? p1 : m1;
        };
        let i = ss;
        if (eobrun <= 0) {
            for (; i <= se; i++) {
                const rs = r.huffman(c.ac!);
                let run = rs >> 4;
                let s = rs & 15;
                if (s) s = r.bit() ? p1 : m1;
                else if (run !== 15) {
                    eobrun = (1 << run) + r.bits(run);
                    break;
                }
                // Past `run` coefficients that are still zero, refining the ones that aren't on the way.
                for (; i <= se; i++) {
                    const z = at + ZIGZAG[i];
                    if (k[z]) refine(z);
                    else if (--run < 0) break;
                }
                if (s && i <= se) k[at + ZIGZAG[i]] = s;
            }
        }
        if (eobrun > 0) {
            for (; i <= se; i++) {
                const z = at + ZIGZAG[i];
                if (k[z]) refine(z);
            }
            eobrun--;
        }
    };
    const decode = !progressive ? baseline : ss === 0 ? (ah === 0 ? dcFirst : dcRefine) : ah === 0 ? acFirst : acRefine;

    // One component alone is coded block by block over just the blocks that hold the picture; several are coded MCU by MCU.
    const single = components.length === 1;
    const total = single ? components[0].blocksAcross * components[0].blocksDown : frame.mcusAcross * frame.mcusDown;
    for (let n = 0; n < total; n++) {
        if (restartInterval && n > 0 && n % restartInterval === 0) {
            r.restart();
            eobrun = 0;
            for (const c of components) c.pred = 0;
        }
        if (single) {
            const c = components[0];
            const row = Math.floor(n / c.blocksAcross);
            decode(c, (row * c.stride + (n % c.blocksAcross)) * 64);
            continue;
        }
        const mcuRow = Math.floor(n / frame.mcusAcross);
        const mcuCol = n % frame.mcusAcross;
        for (const c of components) {
            for (let y = 0; y < c.v; y++) for (let x = 0; x < c.h; x++) decode(c, ((mcuRow * c.v + y) * c.stride + mcuCol * c.h + x) * 64);
        }
    }
}

/** IDCT basis: COS[x * 8 + u] = C(u) / 2 · cos((2x + 1)uπ / 16). */
const COS = new Float32Array(64);
for (let x = 0; x < 8; x++) for (let u = 0; u < 8; u++) COS[x * 8 + u] = ((u === 0 ? Math.SQRT1_2 : 1) / 2) * Math.cos(((2 * x + 1) * u * Math.PI) / 16);

/** A component's samples: every block dequantized and inverse-transformed, as 8-bit values. */
function samples(c: Component, q: Int32Array, precision: number): { width: number; height: number; pixels: Uint8Array } {
    const width = c.stride * 8;
    const pixels = new Uint8Array(width * c.rows * 8);
    const shift = 1 << (precision - 1);
    const scale = precision > 8 ? 1 << (precision - 8) : 1;
    const block = new Float32Array(64);
    const temp = new Float32Array(64);
    for (let by = 0; by < c.rows; by++) {
        for (let bx = 0; bx < c.stride; bx++) {
            const at = (by * c.stride + bx) * 64;
            for (let i = 0; i < 64; i++) block[i] = c.coefficients[at + i] * q[i];
            // Rows, then columns.
            for (let y = 0; y < 8; y++) {
                for (let x = 0; x < 8; x++) {
                    let sum = 0;
                    for (let u = 0; u < 8; u++) sum += COS[x * 8 + u] * block[y * 8 + u];
                    temp[y * 8 + x] = sum;
                }
            }
            for (let x = 0; x < 8; x++) {
                for (let y = 0; y < 8; y++) {
                    let sum = 0;
                    for (let v = 0; v < 8; v++) sum += COS[y * 8 + v] * temp[v * 8 + x];
                    const value = Math.round((sum + shift) / scale);
                    pixels[(by * 8 + y) * width + bx * 8 + x] = value < 0 ? 0 : value > 255 ? 255 : value;
                }
            }
        }
    }
    return { width, height: c.rows * 8, pixels };
}

/** Where a picture's pixels fall on a subsampled plane: the two nearest samples and the weight of the second, as libjpeg's "fancy" upsampling. */
function taps(size: number, factor: number, planeSize: number): { a: Int32Array; b: Int32Array; w: Float32Array } {
    const a = new Int32Array(size);
    const b = new Int32Array(size);
    const w = new Float32Array(size);
    for (let i = 0; i < size; i++) {
        const at = Math.max(0, (i + 0.5) * factor - 0.5);
        a[i] = Math.min(Math.floor(at), planeSize - 1);
        b[i] = Math.min(a[i] + 1, planeSize - 1);
        w[i] = at - Math.floor(at);
    }
    return { a, b, w };
}

function toRgba(frame: { width: number; height: number; components: Component[]; maxH: number; maxV: number }, planes: { width: number; height: number; pixels: Uint8Array }[], adobeTransform: number | null, jfif: boolean): Uint8Array {
    const { width, height } = frame;
    // Each component brought up to the picture's size.
    const full = planes.map((plane, i) => {
        const c = frame.components[i];
        if (c.h === frame.maxH && c.v === frame.maxV) {
            if (plane.width === width) return plane.pixels;
            const out = new Uint8Array(width * height);
            for (let y = 0; y < height; y++) out.set(plane.pixels.subarray(y * plane.width, y * plane.width + width), y * width);
            return out;
        }
        const xs = taps(width, c.h / frame.maxH, Math.ceil((width * c.h) / frame.maxH));
        const ys = taps(height, c.v / frame.maxV, Math.ceil((height * c.v) / frame.maxV));
        const out = new Uint8Array(width * height);
        const p = plane.pixels;
        for (let y = 0; y < height; y++) {
            const r0 = ys.a[y] * plane.width;
            const r1 = ys.b[y] * plane.width;
            const wy = ys.w[y];
            for (let x = 0; x < width; x++) {
                const wx = xs.w[x];
                const top = p[r0 + xs.a[x]] * (1 - wx) + p[r0 + xs.b[x]] * wx;
                const bottom = p[r1 + xs.a[x]] * (1 - wx) + p[r1 + xs.b[x]] * wx;
                out[y * width + x] = Math.round(top * (1 - wy) + bottom * wy);
            }
        }
        return out;
    });

    const rgba = new Uint8Array(width * height * 4);
    const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
    const n = full.length;
    // Three components are YCbCr unless an Adobe marker says RGB, or (with no JFIF or Adobe marker) they're named R, G and B.
    const named = frame.components.map((c) => String.fromCharCode(c.id)).join('');
    const ycc = n === 3 ? (adobeTransform !== null ? adobeTransform !== 0 : jfif || named !== 'RGB') : n === 4 && adobeTransform === 2;
    for (let i = 0, o = 0; i < width * height; i++, o += 4) {
        let r: number, g: number, b: number;
        if (n < 3) {
            r = g = b = full[0][i];
        } else {
            r = full[0][i];
            g = full[1][i];
            b = full[2][i];
            if (ycc) {
                const cb = g - 128;
                const cr = b - 128;
                const y = r;
                r = clamp(y + 1.402 * cr);
                g = clamp(y - 0.344136 * cb - 0.714136 * cr);
                b = clamp(y + 1.772 * cb);
            }
            if (n === 4) {
                // CMYK (YCCK is CMY as RGB, inverted). Adobe's files store it inverted, as libjpeg hands it over.
                const k = full[3][i];
                [r, g, b] = ycc ? [255 - r, 255 - g, 255 - b] : [r, g, b];
                [r, g, b] = adobeTransform !== null ? [(r * k) / 255, (g * k) / 255, (b * k) / 255] : [((255 - r) * (255 - k)) / 255, ((255 - g) * (255 - k)) / 255, ((255 - b) * (255 - k)) / 255];
            }
        }
        rgba[o] = clamp(r);
        rgba[o + 1] = clamp(g);
        rgba[o + 2] = clamp(b);
        rgba[o + 3] = 255;
    }
    return rgba;
}
