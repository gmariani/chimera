import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Parsed, Preview } from '../core/types';
import { gameDir } from '../testing/game-data';
import { aviVideo } from '../testing/samples';
import avi from './avi';
import { drawRle, type Problem, type VideoFormat } from './avi-video';
import { detect } from './index';
import { inspect } from './inspect';

const parse = (data: Uint8Array) => avi.parse(data, { name: 'video.avi', names: [] }) as Parsed;
const enc = new TextEncoder();
/** Where a 4-letter ID first is, from `from`. */
const find = (data: Uint8Array, id: string, from = 0) => {
    const want = enc.encode(id);
    for (let i = from; i + 4 <= data.length; i++) if (want.every((v, k) => data[i + k] === v)) return i;
    throw new Error(`no ${id}`);
};
const edited = (change: (v: DataView, d: Uint8Array) => void) => {
    const d = aviVideo();
    change(new DataView(d.buffer), d);
    return d;
};
const warningsOf = (change: (v: DataView, d: Uint8Array) => void) => parse(edited(change)).warnings;
type Video = Extract<Preview, { kind: 'video' }>;
/** A frame as colors (0xRRGGBB), row by row from the top. */
const colorsOf = (p: Video, i: number): number[][] => {
    const f = p.frame(i);
    const out: number[][] = [];
    for (let y = 0; y < p.height; y++) {
        const row: number[] = [];
        for (let x = 0; x < p.width; x++) {
            const k = y * p.width + x;
            if ('rgba' in f) row.push((f.rgba[k * 4] << 16) | (f.rgba[k * 4 + 1] << 8) | f.rgba[k * 4 + 2]);
            else row.push((f.palette[f.pixels[k] * 3] << 16) | (f.palette[f.pixels[k] * 3 + 1] << 8) | f.palette[f.pixels[k] * 3 + 2]);
        }
        out.push(row);
    }
    return out;
};

describe('AVI video', () => {
    it('plays RLE frames over each other, follows a palette change, repeats an empty frame, and plays its sound', async () => {
        const data = aviVideo();
        expect(detect(data, 'video.avi').id).toBe('avi');
        expect(detect(data, null).id).toBe('avi');
        const inspected = await inspect(data, { name: 'video.avi', names: [] });
        expect(inspected.checks).toEqual([]);
        const r = inspected.parsed;
        expect(r.warnings).toEqual([]);
        expect(r.summary).toEqual([
            ['Video', '8 × 4, Microsoft RLE, 8 bits a pixel'],
            ['Frames', '4 at 4 a second, 1.00 s'],
            ['Sound', 'PCM, mono, 8,000 Hz, 1.00 s'],
        ]);
        expect(r.fields.reduce((n, f) => n + f.length, 0)).toBe(data.length);
        const p = r.preview!;
        if (p.kind !== 'video') throw new Error('not a video');
        expect([p.width, p.height, p.frameCount, p.fps]).toEqual([8, 4, 4, 4]);
        const [black, blue, green, red, white] = [0, 0xff, 0xc000, 0xc00000, 0xffffff];
        const first = [new Array(8).fill(blue), new Array(8).fill(blue), new Array(8).fill(green), new Array(8).fill(green)];
        const second = first.map((row, y) => (y === 1 ? row.map((c, x) => (x === 3 || x === 4 ? red : c)) : row));
        expect(colorsOf(p, 0)).toEqual(first);
        expect(colorsOf(p, 1)).toEqual(second);
        expect(colorsOf(p, 2)).toEqual(second.map((row) => row.map((c) => (c === red ? white : c))));
        expect(colorsOf(p, 3)).toEqual(new Array(4).fill(new Array(8).fill(black)));
        // Back again: drawn afresh from the key frame before it.
        expect(colorsOf(p, 1)).toEqual(second);
        // The sound: the tone's samples, as they are.
        const tone = Array.from({ length: 8000 }, (_, i) => 128 + Math.round(60 * Math.sin((2 * Math.PI * 440 * i) / 8000)));
        expect([...p.audio!.wav.subarray(44)]).toEqual(tone);
        expect(r.entries!.map((e) => e.label)).toEqual(['video-sound-1.wav']);
    });

    it('draws Microsoft’s own examples of RLE at 8 and 4 bits a pixel', () => {
        // From "Bitmap Compression": runs, an absolute run, a delta 5 right and 1 up, the end of a row, the end.
        const draw = (bytes: number[], compression: number, width: number) => {
            const f: VideoFormat = { width, height: 3, topDown: false, bits: compression === 1 ? 8 : 4, compression, masks: [0, 0, 0] };
            const pixels = new Uint8Array(width * 3).fill(0xff);
            const problems = new Set<Problem>();
            drawRle(Uint8Array.from(bytes), pixels, f, problems);
            expect(problems).toEqual(new Set());
            // Rows from the bottom up, as the example lays them out; 0xFF where nothing was drawn.
            return [2, 1, 0].map((y) => [...pixels.subarray(y * width, (y + 1) * width)]);
        };
        const none = (n: number) => new Array(n).fill(0xff);
        expect(draw([0x03, 0x04, 0x05, 0x06, 0x00, 0x03, 0x45, 0x56, 0x67, 0x00, 0x02, 0x78, 0x00, 0x02, 0x05, 0x01, 0x02, 0x78, 0x00, 0x00, 0x09, 0x1e, 0x00, 0x01], 1, 20)).toEqual([
            [4, 4, 4, 6, 6, 6, 6, 6, 0x45, 0x56, 0x67, 0x78, 0x78, ...none(7)],
            [...none(18), 0x78, 0x78],
            [...new Array(9).fill(0x1e), ...none(11)],
        ]);
        expect(draw([0x03, 0x04, 0x05, 0x06, 0x00, 0x06, 0x45, 0x56, 0x67, 0x00, 0x04, 0x78, 0x00, 0x02, 0x05, 0x01, 0x04, 0x78, 0x00, 0x00, 0x09, 0x1e, 0x00, 0x01], 2, 27)).toEqual([
            [0, 4, 0, 0, 6, 0, 6, 0, 4, 5, 5, 6, 6, 7, 7, 8, 7, 8, ...none(9)],
            [...none(23), 7, 8, 7, 8],
            [1, 0xe, 1, 0xe, 1, 0xe, 1, 0xe, 1, ...none(18)],
        ]);
    });

    it('says what it gets wrong drawing RLE, never drawing outside the picture', () => {
        const f: VideoFormat = { width: 4, height: 2, topDown: false, bits: 8, compression: 1, masks: [0, 0, 0] };
        const run = (bytes: number[]) => {
            const problems = new Set<Problem>();
            const pixels = new Uint8Array(8);
            drawRle(Uint8Array.from(bytes), pixels, f, problems);
            return [...problems];
        };
        expect(run([5, 1, 0, 1])).toEqual(['past-edge']);
        expect(run([0, 2, 0, 9, 1, 1, 0, 1])).toEqual(['past-end']);
        expect(run([2, 1])).toEqual(['no-end']);
        expect(run([0, 4, 1, 1])).toEqual(['short']);
        expect(run([4, 1, 0, 0])).toEqual([]);
    });

    it('says what doesn’t agree, and what a player would get wrong', () => {
        const avih = find(aviVideo(), 'avih') + 8;
        const strh = find(aviVideo(), 'strh') + 8;
        expect(warningsOf((v) => v.setUint32(avih + 24, 3, true))).toEqual(['Its main header says it has 3 streams, but 2 are described.']);
        expect(warningsOf((v) => v.setUint32(avih + 16, 5, true))).toEqual(['Its main header says it has 5 frames, but its video has 4.']);
        expect(warningsOf((v) => v.setUint32(strh + 32, 5, true))).toEqual(['Stream 0’s header says it’s 5 frames long, but it has 4.']);
        expect(warningsOf((_v, d) => d.set(enc.encode('strx'), find(d, 'strf', find(d, 'auds'))))).toEqual(['Stream 1 has no format ("strf"): it can’t be played.']);
        expect(warningsOf((_v, d) => d.set(enc.encode('strx'), find(d, 'strh')))).toEqual(expect.arrayContaining(['Stream 0 has no header ("strh"): what it holds can’t be told.']));
        // The index pointing past its chunks.
        expect(warningsOf((v, d) => v.setUint32(find(d, 'idx1') + 8 + 8, 2, true))).toEqual([
            '1 entry of its index points where no such chunk is: a player that goes by the index would play the wrong data.',
        ]);
        // Chunks for a stream it doesn't have: the sound's chunks renamed.
        expect(
            warningsOf((_v, d) => {
                for (let at = find(d, 'movi'); at < find(d, 'idx1'); at++) if (d[at] === 0x30 && d[at + 1] === 0x31 && d[at + 2] === 0x77) d[at + 1] = 0x37;
            })
        ).toContain('The movie data has chunks for stream 7, which its header doesn’t have.');
        // The key frame's first run made one too long: past the right edge.
        expect(warningsOf((_v, d) => (d[find(d, '00dc') + 8] = 9))).toEqual(['Some RLE frames draw past the right edge of the picture: what’s past it isn’t drawn.']);
        // The palette change made to run past the palette's end.
        expect(warningsOf((_v, d) => (d[find(d, '00pc') + 9] = 254))).toEqual(['A palette change in stream 0 says it sets 254 colors from 3, which runs past the 256 a palette has.']);
        // Said to be uncompressed: the frames are then too short.
        expect(warningsOf((v, d) => v.setUint32(find(d, 'strf') + 8 + 16, 0, true))).toEqual(['3 frames are shorter than the 32 bytes an uncompressed frame takes: what’s missing is drawn black.']);
        const cut = aviVideo().subarray(0, find(aviVideo(), 'idx1') - 40);
        expect(parse(cut).warnings).toEqual(
            expect.arrayContaining([
                expect.stringMatching(/^It says it runs to [\d,]+ bytes, but the file ends at [\d,]+ bytes: it’s been cut short\.$/),
                expect.stringMatching(/^The "LIST" chunk says it’s [\d,]+ bytes, past where the file ends/),
            ])
        );
        expect(warningsOf((_v, d) => d.set(enc.encode('movx'), find(d, 'movi')))).toContain('It has no movie data ("movi" list): there’s nothing to play.');
    });

    it('refuses what isn’t one', () => {
        expect(() => parse(enc.encode('RIFF\x10\0\0\0WAVEfmt \0\0\0\0\0\0\0\0'))).toThrow('This isn’t an AVI video: it doesn’t start with RIFF and the form "AVI ".');
        expect(() => parse(edited((_v, d) => d.set(enc.encode('hdrx'), find(d, 'hdrl'))))).toThrow('This isn’t an AVI video: it has no headers ("hdrl" list).');
        expect(() => parse(edited((_v, d) => d.set(enc.encode('avix'), find(d, 'avih'))))).toThrow('This isn’t an AVI video: its headers have no main header ("avih").');
    });
});

// Ground truth from outside: what FFmpeg makes, and how it decodes it, when it's installed.
const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
/** FFmpeg's decode of a file: its frames as RGB, or its sound as 16-bit or 8-bit samples. */
const decoded = (file: string, ...args: string[]) => spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, ...args, '-'], { maxBuffer: 1 << 28 }).stdout as Buffer;
const sameFrames = (p: Video, file: string) => {
    const want = decoded(file, '-f', 'rawvideo', '-pix_fmt', 'rgb24');
    const n = p.width * p.height * 3;
    expect(want.length).toBe(n * p.frameCount);
    for (let i = 0; i < p.frameCount; i++) {
        const mine = colorsOf(p, i)
            .flat()
            .flatMap((c) => [c >> 16, (c >> 8) & 255, c & 255]);
        expect([i, Buffer.from(mine).equals(want.subarray(i * n, (i + 1) * n))]).toEqual([i, true]);
    }
};

describe.skipIf(!ffmpeg)('what FFmpeg makes', () => {
    const made = (video: string[], audio: string[] = []) => {
        const dir = mkdtempSync(join(tmpdir(), 'chimera-avi-'));
        const file = join(dir, 'made.avi');
        // 50 pixels across: rows that need padding to 4 bytes at every depth.
        const sources = ['-f', 'lavfi', '-i', 'testsrc=size=50x30:rate=5:duration=2', ...(audio.length ? ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=11025:duration=2'] : [])];
        const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...sources, ...video, ...audio, file]);
        if (r.status !== 0) throw new Error(String(r.stderr));
        return { file, dir, r: parse(new Uint8Array(readFileSync(file))) };
    };

    it('draws its frames as FFmpeg does: RLE, and uncompressed at 8, 16, 24 and 32 bits', () => {
        for (const video of [
            ['-c:v', 'msrle', '-pix_fmt', 'pal8'],
            ['-c:v', 'rawvideo', '-pix_fmt', 'pal8'],
            ['-c:v', 'rawvideo', '-pix_fmt', 'rgb555le'],
            ['-c:v', 'rawvideo', '-pix_fmt', 'bgr24'],
            ['-c:v', 'rawvideo', '-pix_fmt', 'bgra'],
        ]) {
            const { file, dir, r } = made(video);
            try {
                expect([video.join(' '), r.warnings]).toEqual([video.join(' '), []]);
                if (r.preview?.kind !== 'video') throw new Error('not a video');
                sameFrames(r.preview, file);
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        }
    });

    it('plays its sound as FFmpeg does: PCM, Microsoft ADPCM, and IMA ADPCM within its rounding', () => {
        for (const [codec, bits, channels] of [
            ['pcm_u8', 8, 1],
            ['pcm_s16le', 16, 2],
            ['adpcm_ms', 16, 2],
            ['adpcm_ima_wav', 16, 1],
        ] as const) {
            const { file, dir, r } = made(['-c:v', 'msrle', '-pix_fmt', 'pal8'], ['-c:a', codec, '-ac', String(channels)]);
            try {
                expect([codec, r.warnings]).toEqual([codec, []]);
                const clip = r.preview?.kind === 'video' ? r.preview.audio! : null;
                const mine = clip!.wav.subarray(44);
                const want = decoded(file, '-vn', '-f', bits === 8 ? 'u8' : 's16le');
                expect(mine.length).toBe(want.length);
                if (codec !== 'adpcm_ima_wav') expect(Buffer.from(mine).equals(want)).toBe(true);
                else {
                    // FFmpeg works out each step's change by multiplying; the IMA's algorithm, followed here, adds
                    // shifted steps, which rounds a little differently. Each block starts afresh, so it never drifts.
                    const a = new Int16Array(mine.buffer.slice(mine.byteOffset, mine.byteOffset + mine.length));
                    const b = new Int16Array(want.buffer.slice(want.byteOffset, want.byteOffset + want.length));
                    expect(Math.max(...a.map((v, i) => Math.abs(v - b[i])))).toBeLessThan(64);
                }
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        }
    });
});

const CNC = gameDir('cncRemastered');
const ie3 = CNC && join(CNC, 'RED_ALERT/COUNTERSTRIKE/INTERNET/MSIE/IE301M95.EXE');
describe.skipIf(!ie3)('Internet Explorer 3’s installer, in Counterstrike’s INTERNET folder', () => {
    it('plays its animation: 26 frames of RLE, as FFmpeg draws them', async () => {
        const program = await inspect(new Uint8Array(readFileSync(ie3!)), { name: 'IE301M95.EXE', names: [] });
        const entry = program.parsed.entries!.find((e) => e.label === 'AVI #3001.avi')!;
        const opened = await inspect(entry.data, { name: null, names: [] }, { shownName: entry.label });
        expect(opened.format.id).toBe('avi');
        expect(opened.parsed.warnings).toEqual([]);
        expect(opened.checks).toEqual([]);
        expect(opened.parsed.summary).toEqual([
            ['Video', '272 × 60, Microsoft RLE, 8 bits a pixel'],
            ['Frames', '26 at 10 a second, 2.60 s'],
        ]);
        if (!ffmpeg) return;
        const dir = mkdtempSync(join(tmpdir(), 'chimera-avi-'));
        try {
            const file = join(dir, 'ie3.avi');
            writeFileSync(file, entry.data);
            if (opened.parsed.preview?.kind !== 'video') throw new Error('not a video');
            sameFrames(opened.parsed.preview, file);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
