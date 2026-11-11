/**
 * Sample files made from scratch: a small, valid file of each format that can
 * be made without the original tools, so there's something real to open and
 * test against that's ours to commit. `npm run samples` writes them to
 * samples/generated/; a test makes them again and checks the committed ones
 * still match, and that each reads as its format with nothing to warn about.
 *
 * Everything is worked out here, with nothing random, so the same bytes come
 * out every time. This runs in Node (the script, without a bundler, and the
 * tests), so it imports only the plain test encoders.
 */
import { lcwLiterals, lzw, rle } from '../formats/westwood/encoders.test-util.ts';

export interface Sample {
    name: string;
    /** The format it must read as. */
    format: string;
    /** What it shows, for the samples' README. */
    about: string;
    data: Uint8Array;
}

const enc = new TextEncoder();
const u16 = (v: number) => [v & 0xff, (v >> 8) & 0xff];
const u32 = (v: number) => [...u16(v & 0xffff), ...u16(v >>> 16)];
const be32 = (v: number) => [v >>> 24, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
const text = (s: string) => Array.from(enc.encode(s));
const bytes = (...parts: ArrayLike<number>[]) => Uint8Array.from(parts.flatMap((p) => Array.from(p)));

// Pictures

/**
 * A 320 × 200 test card in 16 colors: a band of each color across the top, a
 * checkerboard, a diagonal, and a frame round the edge. Small enough in 16
 * colors for the 4-bit formats, and plain enough to see at once if it's wrong.
 */
export function testCard(width = 320, height = 200): Uint8Array {
    const p = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let v: number;
            if (x === 0 || y === 0 || x === width - 1 || y === height - 1) v = 15;
            else if (y < height / 4) v = Math.floor((x * 16) / width);
            else if (y < height / 2) v = ((x >> 3) + (y >> 3)) & 1 ? 7 : 8;
            else v = Math.abs(x - (y - height / 2) * 2) < 3 ? 14 : 1 + (((x >> 5) + (y >> 5)) % 6);
            p[y * width + x] = v;
        }
    }
    return p;
}

/** The 16 EGA colors, then a gray ramp, as a VGA palette: 6 bits a channel. */
export function palette6(): Uint8Array {
    const ega = [0x000000, 0x0000aa, 0x00aa00, 0x00aaaa, 0xaa0000, 0xaa00aa, 0xaa5500, 0xaaaaaa, 0x555555, 0x5555ff, 0x55ff55, 0x55ffff, 0xff5555, 0xff55ff, 0xffff55, 0xffffff];
    const p = new Uint8Array(768);
    for (let i = 0; i < 256; i++) {
        const rgb = i < 16 ? ega[i] : Math.round(((i - 16) * 255) / 239) * 0x010101;
        p.set(
            [(rgb >> 16) & 0xff, (rgb >> 8) & 0xff, rgb & 0xff].map((c) => c >> 2),
            i * 3
        );
    }
    return p;
}

/** CPS: the file size, the compression, the decoded size, the palette size, the palette, the picture. */
function cps(compression: number, body: ArrayLike<number>, { size = 64000, pal = palette6() as ArrayLike<number> } = {}): Uint8Array {
    const rest = [...u16(compression), ...u32(size), ...u16(pal.length), ...Array.from(pal), ...Array.from(body)];
    return bytes(u16(rest.length), rest);
}

/** The test card as five Amiga bit planes: plane n holds bit n of each pixel, the leftmost in bit 7. */
function planes(pixels: Uint8Array): Uint8Array {
    const out = new Uint8Array(40000);
    for (let i = 0; i < 64000; i++) for (let p = 0; p < 5; p++) if ((pixels[i] >> p) & 1) out[p * 8000 + (i >> 3)] |= 0x80 >> (i & 7);
    return out;
}

/** An Amiga palette: 32 colors, each a big-endian 0RGB of 4 bits a channel. */
function amigaPalette(): number[] {
    const p6 = palette6();
    return Array.from({ length: 32 }, (_, i) => {
        const [r, g, b] = [p6[i * 3] >> 2, p6[i * 3 + 1] >> 2, p6[i * 3 + 2] >> 2];
        return [r, (g << 4) | b];
    }).flat();
}

/** An old CMP: the size, the type, the decoded size for the LZW types, the picture. */
function cmp(type: number, body: ArrayLike<number>): Uint8Array {
    const rest = [type, ...(type === 3 || type === 6 ? u16(64000) : []), ...Array.from(body)];
    return bytes(u16(rest.length), rest);
}

/** Two pixels a byte, the left one high. */
const pack4 = (p: Uint8Array) => Uint8Array.from({ length: p.length / 2 }, (_, i) => (p[i * 2] << 4) | p[i * 2 + 1]);

/**
 * zlib's format with the data stored, not compressed: blocks of up to 65,535 bytes, each with its length, then a checksum.
 * (Compressing would tie the bytes to a zlib version, and the committed samples have to come out the same everywhere.)
 */
function zlibStored(data: Uint8Array): number[] {
    const out = [0x78, 0x01];
    for (let i = 0; i < data.length || i === 0; i += 65535) {
        const n = Math.min(65535, data.length - i);
        out.push(i + n >= data.length ? 1 : 0, ...u16(n), ...u16(~n & 0xffff), ...data.subarray(i, i + n));
        if (!data.length) break;
    }
    let [a, b] = [1, 0];
    for (const v of data) {
        a = (a + v) % 65521;
        b = (b + a) % 65521;
    }
    return [...out, ...be32(((b << 16) | a) >>> 0)];
}

/** PNG: RGB, 8 bits a channel, the data stored (see zlibStored). */
function png(width: number, height: number, rgb: (x: number, y: number) => [number, number, number]): Uint8Array {
    const crcTable = Array.from({ length: 256 }, (_, n) => {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        return c >>> 0;
    });
    const crc = (data: number[]) => {
        let c = 0xffffffff;
        for (const v of data) c = crcTable[(c ^ v) & 0xff] ^ (c >>> 8);
        return (c ^ 0xffffffff) >>> 0;
    };
    const chunk = (type: string, body: ArrayLike<number>) => {
        const typed = [...text(type), ...Array.from(body)];
        return [...be32(body.length), ...typed, ...be32(crc(typed))];
    };
    const raw: number[] = [];
    for (let y = 0; y < height; y++) {
        raw.push(0);
        for (let x = 0; x < width; x++) raw.push(...rgb(x, y));
    }
    return bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], chunk('IHDR', [...be32(width), ...be32(height), 8, 2, 0, 0, 0]), chunk('IDAT', zlibStored(Uint8Array.from(raw))), chunk('IEND', []));
}

// Sounds

/** A tone, as unsigned 8-bit samples. */
function tone8(count: number, period = 25): number[] {
    return Array.from({ length: count }, (_, i) => 128 + Math.round(100 * Math.sin((2 * Math.PI * i) / period)));
}

/** VOC: the 26-byte header (version 1.10), then blocks of a type and a 3-byte size. */
function voc(blocks: [number, number[]][]): Uint8Array {
    const version = 0x010a;
    const header = [...text('Creative Voice File\x1a'), ...u16(26), ...u16(version), ...u16((~version + 0x1234) & 0xffff)];
    return bytes(
        header,
        blocks.flatMap(([type, body]) => [type, body.length & 0xff, (body.length >> 8) & 0xff, body.length >> 16, ...body]),
        [0]
    );
}

/** AUD: the 12-byte header, then chunks of [stored, decoded size], each marked 0xDEAF. */
function aud(rate: number, flags: number, compression: number, chunks: [number[], number][]): Uint8Array {
    const body = chunks.flatMap(([data, out]) => [...u16(data.length), ...u16(out), ...u32(0xdeaf), ...data]);
    return bytes(u16(rate), u32(body.length), u32(chunks.reduce((n, [, out]) => n + out, 0)), [flags, compression], body);
}

/** WAV: a RIFF of a format chunk and the samples. */
function wav(rate: number, samples: number[]): Uint8Array {
    const fmt = [...u16(1), ...u16(1), ...u32(rate), ...u32(rate), ...u16(1), ...u16(8)];
    const body = [...text('WAVE'), ...text('fmt '), ...u32(fmt.length), ...fmt, ...text('data'), ...u32(samples.length), ...samples, ...(samples.length & 1 ? [0] : [])];
    return bytes(text('RIFF'), u32(body.length), body);
}

// Animations

/** A format 40 delta of the whole frame: runs of up to 127 bytes to XOR in, then the end. */
function format40(xor: Uint8Array): number[] {
    const out: number[] = [];
    for (let i = 0; i < xor.length; i += 127) {
        const n = Math.min(127, xor.length - i);
        out.push(n, ...xor.subarray(i, i + n));
    }
    return [...out, 0x80, 0, 0];
}

/** A small animation's frames: a square moving across a 32 × 16 strip. */
function strip(count: number): Uint8Array[] {
    return Array.from({ length: count }, (_, f) => {
        const p = new Uint8Array(32 * 16).fill(1);
        for (let y = 4; y < 12; y++) for (let x = 0; x < 8; x++) p[y * 32 + f * 6 + x] = 14;
        return p;
    });
}

/** A WSA in one of its three layouts: each frame the XOR against the one before, as format 40, then LCW. */
function wsa(layout: 'cnc' | 'dune2-100' | 'dune2-107'): Uint8Array {
    const frames = strip(4);
    const bodies = frames.map((f, i) => lcwLiterals(Uint8Array.from(format40(f.map((v, k) => v ^ (i ? frames[i - 1][k] : 0))))));
    const largest = Math.max(...frames.map((f) => format40(f).length));
    const header =
        layout === 'cnc'
            ? [...u16(4), ...u16(0), ...u16(0), ...u16(32), ...u16(16), ...u16(largest), ...u16(0)]
            : [...u16(4), ...u16(32), ...u16(16), ...u16(largest), ...(layout === 'dune2-107' ? u16(0) : [])];
    let at = header.length + (frames.length + 2) * 4;
    const offsets: number[] = [];
    for (const b of bodies) {
        offsets.push(at);
        at += b.length;
    }
    offsets.push(at, 0);
    return bytes(header, offsets.flatMap(u32), bodies.flat());
}

// Archives

/** A Westwood PAK of these files, as its version writes the header. */
function pak(version: 1 | 2 | 3, files: [string, Uint8Array][]): Uint8Array {
    const names = files.map(([n]) => [...text(n), 0]);
    const headerSize = names.reduce((n, name) => n + 4 + name.length, 0) + (version === 2 ? 0 : 5) + (version === 1 ? 0 : 4);
    const header: number[] = [];
    let at = headerSize;
    for (const [i, [, data]] of files.entries()) {
        header.push(...u32(at), ...names[i]);
        at += data.length;
    }
    if (version !== 2) header.push(...u32(at), 0);
    if (version !== 1) header.push(...u32(0));
    return bytes(header, ...files.map(([, d]) => d));
}

// Tiles and fonts

/** Dune II map tiles: 16 × 16 tiles from the test card, two palettes (one with see-through 0), and which each uses. */
function icn(): Uint8Array {
    const card = testCard();
    const tiles: number[] = [];
    const count = 8;
    for (let t = 0; t < count; t++) for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x += 2) tiles.push((card[(y + 52) * 320 + t * 16 + x] << 4) | card[(y + 52) * 320 + t * 16 + x + 1]);
    const chunk = (id: string, body: number[]) => [...text(id), ...be32(body.length), ...body, ...(body.length & 1 ? [0] : [])];
    const sset = [...u16(0), ...u32(tiles.length), ...u16(0), ...tiles];
    // Palette 0 is opaque (its first color is dark gray, not 0); palette 1 starts with 0, so the game leaves that color see-through.
    const rpal = [8, ...Array.from({ length: 15 }, (_, i) => i + 1), 0, ...Array.from({ length: 15 }, (_, i) => i + 1)];
    const body = [
        ...chunk('SINF', [2, 2, 3, 4]),
        ...chunk('SSET', sset),
        ...chunk('RPAL', rpal),
        ...chunk(
            'RTBL',
            Array.from({ length: count }, (_, i) => i & 1)
        ),
    ];
    return bytes(text('FORM'), be32(4 + body.length), text('ICON'), body);
}

/** The glyphs of "CHIMERA" in a 5 × 7 font, one byte a row (the leftmost pixel in the high bit). */
const GLYPHS: Record<string, number[]> = {
    A: [0x70, 0x88, 0x88, 0xf8, 0x88, 0x88, 0x88],
    C: [0x70, 0x88, 0x80, 0x80, 0x80, 0x88, 0x70],
    E: [0xf8, 0x80, 0x80, 0xf0, 0x80, 0x80, 0xf8],
    H: [0x88, 0x88, 0x88, 0xf8, 0x88, 0x88, 0x88],
    I: [0x70, 0x20, 0x20, 0x20, 0x20, 0x20, 0x70],
    M: [0x88, 0xd8, 0xa8, 0xa8, 0x88, 0x88, 0x88],
    R: [0xf0, 0x88, 0x88, 0xf0, 0xa0, 0x90, 0x88],
};
const glyph = (c: string) => [GLYPHS[c] ? 5 : 0, ...(GLYPHS[c] ?? new Array(7).fill(0))];
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** RA2's map editor font: 48 bytes of header, then a glyph from "A" to "Z" (the letters not in CHIMERA left empty). */
function foNt(): Uint8Array {
    const first = 65;
    const last = first + LETTERS.length - 1;
    return bytes(text('FoNt'), u32(6), u32(1), u32(7), u32(7), u32(1), u32(8), u32(0x24), u32(0x30), u32(0), u32(first), u32(last), [...LETTERS].flatMap(glyph));
}

/** Nox's: 36 bytes of header, 16-bit first and last characters. */
function tNoF(): Uint8Array {
    return bytes(text('tNoF'), u32(1), u32(6), u32(1), u32(7), u32(1), u32(8), u32(0), u16(65), u16(65 + LETTERS.length - 1), [...LETTERS].flatMap(glyph));
}

// Windows

/**
 * A 16 × 16 icon in 16 colors as Windows stores one: a BITMAPINFOHEADER (the height doubled, for the mask), the 16 colors,
 * the pixels bottom row first at 4 bits each, then the mask, 1 bit each (1: see-through), each row padded to 4 bytes.
 * The picture: a diamond of color 12 on 1, with its corners see-through.
 */
export function iconDib(): number[] {
    const p6 = palette6();
    const colors = Array.from({ length: 16 }, (_, i) => [p6[i * 3 + 2] << 2, p6[i * 3 + 1] << 2, p6[i * 3] << 2, 0]).flat();
    const inside = (x: number, y: number) => Math.abs(x - 7.5) + Math.abs(y - 7.5) <= 8;
    const color = (x: number, y: number) => (Math.abs(x - 7.5) + Math.abs(y - 7.5) <= 4 ? 12 : 1);
    const rows: number[] = [];
    const mask: number[] = [];
    for (let y = 15; y >= 0; y--) {
        for (let x = 0; x < 16; x += 2) rows.push((inside(x, y) ? color(x, y) << 4 : 0) | (inside(x + 1, y) ? color(x + 1, y) : 0));
        let bits = 0;
        for (let x = 0; x < 16; x++) if (!inside(x, y)) bits |= 0x8000 >> x;
        mask.push(bits >> 8, bits & 0xff, 0, 0);
    }
    return [...u32(40), ...u32(16), ...u32(32), ...u16(1), ...u16(4), ...u32(0), ...u32(rows.length + mask.length), ...u32(0), ...u32(0), ...u32(0), ...u32(0), ...colors, ...rows, ...mask];
}

/**
 * A Windows 3 icon library: a 16-bit module (MZ, then NE) with no code, holding one icon and the group that lists it,
 * named CHIMERA. As icon editors made them, and as Dune II's DUNE2.ICO is.
 */
export function iconLibrary({ segments = 0 }: { segments?: number } = {}): Uint8Array {
    const icon = iconDib();
    const group = [...u16(0), ...u16(1), ...u16(1), 16, 16, 16, 0, ...u16(1), ...u16(4), ...u32(icon.length), ...u16(1)];
    const shift = 4;
    const align = (n: number) => Math.ceil(n / 16) * 16;
    // Laid out: the MZ header, the NE header at 0x40, the resource table at 0x80, the names, then the resources, 16-byte aligned.
    const resTable = 0x80;
    const resTableLength = 2 + (8 + 12) * 2 + 2 + 1;
    const resident = resTable + resTableLength;
    const name = [7, ...text('CHIMERA'), ...u16(0), 0];
    const after = resident + name.length;
    const groupAt = align(after);
    const iconAt = align(groupAt + group.length);
    const out = new Uint8Array(align(iconAt + icon.length));
    const v = new DataView(out.buffer);
    out.set(text('MZ'), 0);
    v.setUint32(0x3c, 0x40, true);
    const ne = 0x40;
    out.set(text('NE'), ne);
    out.set([5, 1], ne + 2);
    for (const [at, value] of [
        [0x04, after - ne], // the entry table (empty)
        [0x1c, segments],
        [0x22, resTable - ne], // the segment table (empty), where the resources start
        [0x24, resTable - ne],
        [0x26, resident - ne],
        [0x28, after - ne], // module references (none)
        [0x2a, after - ne], // imported names (none)
        [0x32, shift],
    ])
        v.setUint16(ne + at, value, true);
    out[ne + 0x36] = 2; // Windows
    out.set([0, 3], ne + 0x3e); // Windows 3.00
    const entry = (at: number, length: number, id: number) => [...u16(at >> shift), ...u16(Math.ceil(length / 16)), ...u16(0x1c30), ...u16(0x8000 | id), ...u32(0)];
    out.set([...u16(shift), ...u16(0x800e), ...u16(1), ...u32(0), ...entry(groupAt, group.length, 1), ...u16(0x8003), ...u16(1), ...u32(0), ...entry(iconAt, icon.length, 1), ...u16(0), 0], resTable);
    out.set(name, resident);
    out.set(group, groupAt);
    out.set(icon, iconAt);
    return out;
}

/** A 32 × 32 icon at 32 bits a pixel: a disc fading from opaque in the middle to see-through at its edge, with its own alpha. */
export function iconDib32(): number[] {
    const pixels: number[] = [];
    for (let y = 31; y >= 0; y--)
        for (let x = 0; x < 32; x++) {
            const r = Math.hypot(x - 15.5, y - 15.5);
            pixels.push(255 - x * 6, 40 + y * 6, 200, r > 15 ? 0 : Math.round(255 * Math.min(1, (15 - r) / 4)));
        }
    // The mask is all 0s: the alpha says what's see-through.
    const mask = new Array(32 * 4).fill(0);
    return [...u32(40), ...u32(32), ...u32(64), ...u16(1), ...u16(32), ...u32(0), ...u32(pixels.length + mask.length), ...u32(0), ...u32(0), ...u32(0), ...u32(0), ...pixels, ...mask];
}

/** A 32 × 32 arrow at 1 bit a pixel: white with a black edge, its hot spot at the tip (0, 0). */
export function cursorDib(): number[] {
    const inside = (x: number, y: number) => x <= y && x + y < 40 && y < 26;
    const edge = (x: number, y: number) => inside(x, y) && !(inside(x - 1, y) && inside(x + 1, y) && inside(x, y - 1) && inside(x, y + 1));
    const rows: number[] = [];
    const mask: number[] = [];
    for (let y = 31; y >= 0; y--) {
        let color = 0;
        let clear = 0;
        for (let x = 0; x < 32; x++) {
            if (inside(x, y) && !edge(x, y)) color |= 2 ** (31 - x);
            if (!inside(x, y)) clear |= 2 ** (31 - x);
        }
        rows.push(...be32(color));
        mask.push(...be32(clear));
    }
    return [
        ...u32(40),
        ...u32(32),
        ...u32(64),
        ...u16(1),
        ...u16(1),
        ...u32(0),
        ...u32(rows.length + mask.length),
        ...u32(0),
        ...u32(0),
        ...u32(2),
        ...u32(0),
        0,
        0,
        0,
        0,
        255,
        255,
        255,
        0,
        ...rows,
        ...mask,
    ];
}

/** An .ico or .cur: a 6-byte header, a 16-byte entry for each image (width, height, colors, 0, then planes and bits or the hot spot), then the images. */
export function iconFile(images: { image: ArrayLike<number>; width: number; height: number; colors?: number; planes?: number; bits?: number }[], type: 1 | 2 = 1): Uint8Array {
    let at = 6 + images.length * 16;
    const entries = images.flatMap((x) => {
        const e = [x.width & 0xff, x.height & 0xff, x.colors ?? 0, 0, ...u16(x.planes ?? 1), ...u16(x.bits ?? 32), ...u32(x.image.length), ...u32(at)];
        at += x.image.length;
        return e;
    });
    return bytes([0, 0, ...u16(type), ...u16(images.length)], entries, ...images.map((x) => x.image));
}

// The list

/** Every sample, in the order they're listed. */
export function samples(): Sample[] {
    const card = testCard();
    const card4 = pack4(card);
    const down = Uint8Array.from({ length: 32000 }, (_, k) => card4[(k % 200) * 160 + Math.floor(k / 200)]);
    const tone = tone8(1100);
    const ima = Array.from({ length: 64 }, (_, i) => ((i * 7) & 0x0f) | (((i * 3 + 5) & 0x0f) << 4));
    const out: Sample[] = [
        { name: 'cps-none.cps', format: 'cps', about: 'CPS picture, uncompressed, with its palette', data: cps(0, card) },
        { name: 'cps-lzw12.cps', format: 'cps', about: 'CPS picture, LZW with 12-bit codes', data: cps(1, lzw(card, 12)) },
        { name: 'cps-lzw14.cps', format: 'cps', about: 'CPS picture, LZW with 14-bit codes', data: cps(2, lzw(card, 14)) },
        { name: 'cps-rle.cps', format: 'cps', about: 'CPS picture, Westwood RLE', data: cps(3, rle(card)) },
        { name: 'cps-lcw.cps', format: 'cps', about: 'CPS picture, LCW (as literal copies), using the game palette', data: cps(4, lcwLiterals(card), { pal: [] }) },
        { name: 'cps-amiga.cps', format: 'cps', about: 'CPS picture as the Amiga stores it: five bit planes, a 32-color palette', data: cps(0, planes(card), { size: 40000, pal: amigaPalette() }) },
        { name: 'cmp-type1.cmp', format: 'cmp', about: 'CMP picture: 16 colors, RLE across the rows', data: cmp(1, rle(card4, true)) },
        { name: 'cmp-type2.cmp', format: 'cmp', about: 'CMP picture: 16 colors, RLE down each column', data: cmp(2, rle(down, true)) },
        { name: 'cmp-type3.cmp', format: 'cmp', about: 'CMP picture: 256 colors, LZW with 12-bit codes', data: cmp(3, lzw(card, 12)) },
        { name: 'cmp-type4.cmp', format: 'cmp', about: 'CMP picture: 256 colors, RLE', data: cmp(4, rle(card)) },
        { name: 'cmp-type6.cmp', format: 'cmp', about: 'CMP picture: 256 colors, LZW with 14-bit codes', data: cmp(6, lzw(card, 14)) },
        { name: 'icn-dune2.icn', format: 'icn-d2', about: 'Dune II map tiles: 8 tiles, two palettes (one with see-through edges)', data: icn() },
        { name: 'wsa-cnc.wsa', format: 'wsa', about: 'WSA animation, the C&C header: a square moving across', data: wsa('cnc') },
        { name: 'wsa-dune2-100.wsa', format: 'wsa', about: 'WSA animation, Dune II 1.00’s header', data: wsa('dune2-100') },
        { name: 'wsa-dune2-107.wsa', format: 'wsa', about: 'WSA animation, Dune II 1.07’s header', data: wsa('dune2-107') },
        {
            name: 'voc-pcm8.voc',
            format: 'voc',
            about: 'VOC sound: an 8-bit tone, a silence, a text block',
            data: voc([
                [1, [165, 0, ...tone]],
                [3, [...u16(499), 165]],
                [5, [...text('made by Chimera'), 0]],
            ]),
        },
        { name: 'voc-adpcm4.voc', format: 'voc', about: 'VOC sound: Creative 4-bit ADPCM', data: voc([[1, [165, 1, 128, ...ima]]]) },
        {
            name: 'aud-pcm8.aud',
            format: 'aud',
            about: 'AUD sound: plain 8-bit PCM in two chunks',
            data: aud(11025, 0, 0, [
                [tone.slice(0, 512), 512],
                [tone.slice(512, 1024), 512],
            ]),
        },
        { name: 'aud-ima.aud', format: 'aud', about: 'AUD sound: IMA ADPCM, 16-bit out', data: aud(22050, 2, 99, [[ima, ima.length * 4]]) },
        { name: 'wav-pcm8.wav', format: 'wav', about: 'WAV sound: 8-bit PCM', data: wav(11025, tone) },
        { name: 'fnt-ra2-map.fnt', format: 'fnt-ts', about: 'RA2 map editor font (FoNt), the letters of CHIMERA', data: foNt() },
        { name: 'fnt-nox.fnt', format: 'fnt-ts', about: 'Nox font (tNoF), the letters of CHIMERA', data: tNoF() },
        {
            name: 'icon.ico',
            format: 'ico',
            about: 'Windows icon at three sizes: 16 × 16 in 16 colors, 32 × 32 with its own transparency, and 48 × 48 as a PNG',
            data: iconFile([
                { image: iconDib(), width: 16, height: 16, colors: 16, bits: 4 },
                { image: iconDib32(), width: 32, height: 32, bits: 32 },
                { image: png(48, 48, (x, y) => [x * 5, 255 - y * 5, 128]), width: 48, height: 48, bits: 32 },
            ]),
        },
        {
            name: 'cursor.cur',
            format: 'ico',
            about: 'Windows cursor: a 32 × 32 arrow in 2 colors, its hot spot at the tip',
            data: iconFile([{ image: cursorDib(), width: 32, height: 32, colors: 2, planes: 0, bits: 0 }], 2),
        },
        { name: 'icons.icl', format: 'ne', about: 'Windows 3 icon library: a 16-bit module with no code, holding one 16 × 16 icon', data: iconLibrary() },
        { name: 'palette.pal', format: 'pal', about: 'VGA palette: the 16 EGA colors, then a gray ramp', data: palette6() },
        { name: 'png-rgb.png', format: 'png', about: 'PNG picture: RGB, a color wheel of sorts', data: png(64, 64, (x, y) => [x * 4, y * 4, 255 - (x + y) * 2]) },
    ];
    const byName = (name: string) => out.find((s) => s.name === name)!.data;
    const archived: [string, Uint8Array][] = [
        ['CARD.CPS', byName('cps-none.cps')],
        ['TONE.VOC', byName('voc-pcm8.voc')],
        ['PALETTE.PAL', byName('palette.pal')],
    ];
    out.push(
        { name: 'pak-v1.pak', format: 'pak', about: 'Westwood PAK, version 1 (Eye of the Beholder), holding three of these', data: pak(1, archived) },
        { name: 'pak-v2.pak', format: 'pak', about: 'Westwood PAK, version 2 (Dune II), holding three of these', data: pak(2, archived) },
        { name: 'pak-v3.pak', format: 'pak', about: 'Westwood PAK, version 3 (Kyrandia 2 and 3), holding three of these', data: pak(3, archived) }
    );
    return out;
}
