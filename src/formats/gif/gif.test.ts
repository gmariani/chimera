import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Preview } from '../../core/types';
import { detect } from '../index';
import gif, { lzw } from './index';

const enc = new TextEncoder();

function concat(...parts: (Uint8Array | number[])[]): Uint8Array {
    const arrays = parts.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p)));
    const out = new Uint8Array(arrays.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of arrays) (out.set(p, at), (at += p.length));
    return out;
}

const u16 = (v: number) => [v & 0xff, v >> 8];

/** LZW the simple way: a clear code before every pixel, so the table never grows and the code size stays put. */
function encode(pixels: number[], minCodeSize: number): Uint8Array {
    const size = minCodeSize + 1;
    const clear = 1 << minCodeSize;
    const out: number[] = [];
    let buffer = 0;
    let bits = 0;
    const put = (code: number) => {
        buffer |= code << bits;
        bits += size;
        while (bits >= 8) (out.push(buffer & 0xff), (buffer >>>= 8), (bits -= 8));
    };
    for (const p of pixels) (put(clear), put(p));
    put(clear + 1);
    if (bits) out.push(buffer & 0xff);
    return Uint8Array.from(out);
}

function subBlocks(bytes: Uint8Array): Uint8Array {
    const parts: number[] = [];
    for (let at = 0; at < bytes.length; at += 255) {
        const chunk = bytes.subarray(at, at + 255);
        parts.push(chunk.length, ...chunk);
    }
    return Uint8Array.from([...parts, 0]);
}

interface FrameSpec {
    left?: number;
    top?: number;
    width: number;
    height: number;
    pixels: number[];
    delay?: number;
    disposal?: number;
    transparent?: number;
    interlaced?: boolean;
    /** Its own colors, as RGB triples. */
    colors?: number[];
}

/** A GIF89a: four global colors (black, red, green, blue), then the frames. */
function build(width: number, height: number, frames: FrameSpec[], extra: Uint8Array[] = []): Uint8Array {
    const global = [0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255];
    const parts: (Uint8Array | number[])[] = [enc.encode('GIF89a'), [...u16(width), ...u16(height), 0x81, 0, 0], global, ...extra];
    for (const f of frames) {
        if (f.delay !== undefined || f.disposal !== undefined || f.transparent !== undefined) {
            parts.push([0x21, 0xf9, 4, ((f.disposal ?? 0) << 2) | (f.transparent !== undefined ? 1 : 0), ...u16(f.delay ?? 0), f.transparent ?? 0, 0]);
        }
        const local = f.colors ? [0x80 | (Math.log2(f.colors.length / 3) - 1)] : [0];
        parts.push([0x2c, ...u16(f.left ?? 0), ...u16(f.top ?? 0), ...u16(f.width), ...u16(f.height), local[0] | (f.interlaced ? 0x40 : 0)]);
        if (f.colors) parts.push(f.colors);
        parts.push([2], subBlocks(encode(f.pixels, 2)));
    }
    parts.push([0x3b]);
    return concat(...parts);
}

const parse = (data: Uint8Array) => gif.parse(data, { name: null, names: [] });
const pixelAt = (rgba: Uint8Array, width: number, x: number, y: number) => Array.from(rgba.subarray((y * width + x) * 4, (y * width + x) * 4 + 4));
const BLACK = [0, 0, 0, 255];
const RED = [255, 0, 0, 255];
const GREEN = [0, 255, 0, 255];
const BLUE = [0, 0, 255, 255];
const CLEAR = [0, 0, 0, 0];

function video(preview: Preview | undefined) {
    if (preview?.kind !== 'video') throw new Error(`Expected a video, got ${preview?.kind}.`);
    return preview;
}
function picture(preview: Preview | undefined) {
    if (preview?.kind !== 'picture') throw new Error(`Expected a picture, got ${preview?.kind}.`);
    return preview;
}

describe('GIF', () => {
    it('is found by its signature', () => {
        const data = build(1, 1, [{ width: 1, height: 1, pixels: [1] }]);
        expect(detect(data, null).id).toBe('gif');
        expect(detect(enc.encode('GIF88a and some more bytes'), null).id).not.toBe('gif');
    });

    it('decodes LZW, including a code for the string being made (KwKwK)', () => {
        // Codes for "0 0 0 0 0" with min size 2: clear(4), 0, 6 (=00, the string being added), 6 (=00), end(5); 3-bit codes.
        const codes = [4, 0, 6, 6, 5];
        let buffer = 0;
        let bits = 0;
        const bytes: number[] = [];
        for (const c of codes) {
            buffer |= c << bits;
            bits += 3;
            while (bits >= 8) (bytes.push(buffer & 0xff), (buffer >>>= 8), (bits -= 8));
        }
        if (bits) bytes.push(buffer);
        const out = new Uint8Array(5);
        expect(lzw(Uint8Array.from(bytes), 2, out)).toEqual({ written: 5, error: null });
        expect([...out]).toEqual([0, 0, 0, 0, 0]);
    });

    it('draws a still picture with its transparent color', () => {
        const parsed = parse(build(2, 2, [{ width: 2, height: 2, pixels: [1, 2, 3, 0], transparent: 0 }]));
        expect(parsed.title).toBe('Picture (GIF89a)');
        expect(parsed.warnings).toEqual([]);
        const { rgba } = picture(parsed.preview);
        expect([pixelAt(rgba, 2, 0, 0), pixelAt(rgba, 2, 1, 0), pixelAt(rgba, 2, 0, 1), pixelAt(rgba, 2, 1, 1)]).toEqual([RED, GREEN, BLUE, CLEAR]);
        expect(parsed.summary).toContainEqual(['Transparency', 'Yes']);
    });

    it('puts interlaced rows back in order', () => {
        // Rows stored 0, 4, 2, 6, 1, 3, 5, 7 (passes from 0 by 8, 4 by 8, 2 by 4, 1 by 2); each row's color is its stored position mod 4.
        const stored = [0, 4, 2, 6, 1, 3, 5, 7];
        const parsed = parse(build(1, 8, [{ width: 1, height: 8, pixels: stored.map((_, i) => i % 4), interlaced: true }]));
        const { rgba } = picture(parsed.preview);
        const colors = [BLACK, RED, GREEN, BLUE];
        for (let i = 0; i < 8; i++) expect(pixelAt(rgba, 1, 0, stored[i])).toEqual(colors[i % 4]);
        expect(parsed.summary).toContainEqual(['Interlaced', 'Yes']);
    });

    it('uses a local color table over the global one', () => {
        const parsed = parse(build(1, 1, [{ width: 1, height: 1, pixels: [1], colors: [9, 9, 9, 200, 100, 50] }]));
        expect(pixelAt(picture(parsed.preview).rgba, 1, 0, 0)).toEqual([200, 100, 50, 255]);
    });

    it('times frames on a common tick, taking delays under 2 as 10', () => {
        const parsed = parse(build(1, 1, [{ width: 1, height: 1, pixels: [1], delay: 20 }, { width: 1, height: 1, pixels: [2], delay: 1 }, { width: 1, height: 1, pixels: [3], delay: 30 }]));
        expect(parsed.title).toBe('Animation (GIF89a)');
        const v = video(parsed.preview);
        // Delays 20, 10, 30: a tick of 10 hundredths, so 10 fps and 2 + 1 + 3 ticks.
        expect(v.fps).toBe(10);
        expect(v.frameCount).toBe(6);
        const at = (i: number) => pixelAt((v.frame(i) as { rgba: Uint8Array }).rgba, 1, 0, 0);
        expect([0, 1, 2, 3, 4, 5].map(at)).toEqual([RED, RED, GREEN, BLUE, BLUE, BLUE]);
        // Going back redraws from the start.
        expect(at(0)).toEqual(RED);
        expect(parsed.summary).toContainEqual(['Length', '0.60 s']);
    });

    it('follows each disposal before drawing the next frame', () => {
        // A 2x1 screen: frame 1 fills both red, frame 2 draws green on the left, frame 3 draws a transparent pixel on the left.
        const run = (disposal: number) => {
            const v = video(
                parse(
                    build(2, 1, [
                        { width: 2, height: 1, pixels: [1, 1], delay: 10, disposal: 1 },
                        { width: 1, height: 1, pixels: [2], delay: 10, disposal },
                        { width: 1, height: 1, pixels: [0], delay: 10, transparent: 0 },
                    ]),
                ).preview,
            );
            return pixelAt((v.frame(2) as { rgba: Uint8Array }).rgba, 2, 0, 0);
        };
        expect(run(1)).toEqual(GREEN); // left as it was
        expect(run(2)).toEqual(CLEAR); // cleared to transparent
        expect(run(3)).toEqual(RED); // put back what was under it
    });

    it('reads the loop count and comments', () => {
        const loop = concat([0x21, 0xff, 11], enc.encode('NETSCAPE2.0'), [3, 1, 0, 0, 0]);
        const comment = concat([0x21, 0xfe, 5], enc.encode('hello'), [0]);
        const parsed = parse(build(1, 1, [{ width: 1, height: 1, pixels: [1], delay: 10 }, { width: 1, height: 1, pixels: [2], delay: 10 }], [loop, comment]));
        expect(parsed.summary).toContainEqual(['Loops', 'Forever']);
        expect(parsed.preview?.kind).toBe('stack');
        if (parsed.preview?.kind === 'stack') expect(parsed.preview.items[1].preview).toEqual({ kind: 'text', text: 'hello' });
    });

    it('marks every byte of the file', () => {
        const data = build(2, 2, [{ width: 2, height: 2, pixels: [1, 2, 3, 0], delay: 5 }]);
        const fields = parse(data).fields;
        expect(fields.map((f) => f.name)).toEqual(['Header', 'Logical screen', 'Global color table', 'Blocks']);
        const blocks = fields[3];
        expect(blocks.children!.map((f) => f.name)).toEqual(['Graphic control', 'Frame 1', 'Trailer']);
        expect(blocks.offset + blocks.length).toBe(data.length);
    });

    it('says when a file is damaged or cut short, and draws what it can', () => {
        const whole = build(2, 2, [{ width: 2, height: 2, pixels: [1, 2, 3, 1] }]);
        const cut = parse(whole.subarray(0, whole.length - 4));
        expect(cut.warnings.join()).toMatch(/runs past the end|ends early/);
        expect(pixelAt(picture(cut.preview).rgba, 2, 0, 0)).toEqual(RED);

        const junk = concat(whole.subarray(0, whole.length - 1), [0x99]);
        expect(parse(junk).warnings.join()).toMatch(/doesn't start a block/);

        expect(() => parse(concat(enc.encode('GIF89a'), [1, 0, 1, 0, 0, 0, 0, 0x3b]))).toThrow(/No frames/);
    });

    it('draws colors past the end of the table as black, and says so', () => {
        // A 2-color local table, and a pixel of color 3.
        const parsed = parse(build(1, 1, [{ width: 1, height: 1, pixels: [3], colors: [255, 255, 255, 1, 2, 3] }]));
        expect(pixelAt(picture(parsed.preview).rgba, 1, 0, 0)).toEqual(BLACK);
        expect(parsed.warnings.join()).toMatch(/past the end of the color table/);
    });
});

// The sample GIFs, if present (they aren't committed).
const samples = join(__dirname, '../../../samples/images');
describe.skipIf(!existsSync(join(samples, 'gif-animated.gif')))('sample GIFs', () => {
    it('reads the animated and still samples', () => {
        const animated = parse(new Uint8Array(readFileSync(join(samples, 'gif-animated.gif'))));
        expect(animated.warnings).toEqual([]);
        expect(animated.summary).toContainEqual(['Frames', '8']);
        expect(video(animated.preview).frameCount).toBe(46);
        const still = parse(new Uint8Array(readFileSync(join(samples, 'gif-static.gif'))));
        expect(still.warnings).toEqual([]);
        expect(picture(still.preview).width).toBe(65);
    });
});
