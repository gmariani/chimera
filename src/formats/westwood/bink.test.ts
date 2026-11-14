import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gameDir } from '../../testing/game-data';
import { detect } from '../index';
import png from '../png/index';
import bink, { ready } from './bink';
import createBink from './bink-wasm/bink.mjs';

const samples = join(__dirname, '../../../samples/westwood');

describe.skipIf(!existsSync(join(samples, 'GDI13.BK2')))("Bink 2 (the Remastered Collection's movies)", () => {
    const open = async (name: string) => {
        await ready();
        const data = new Uint8Array(readFileSync(join(samples, name)));
        expect(detect(data, name).id).toBe('bink');
        return bink.parse(data, { name, names: [] });
    };

    it("reads the container, with revision j's extra header field", async () => {
        const parsed = await open('GDI01_INTRO_02.BK2');
        expect(parsed.title).toBe('Bink 2 video');
        expect(parsed.summary).toEqual(
            expect.arrayContaining([
                ['Version', 'j'],
                ['Size', '704 × 396'],
                ['Frames', '311 at 30 per second (10.4 s), 1 keyframe'],
                ['Sound', '48000 Hz stereo, DCT'],
            ])
        );
        expect(parsed.fields.map((f) => f.name).slice(0, 5)).toEqual(['Header', 'Unknown', 'Track 0 largest decoded size', 'Track 0 format', 'Track 0 ID']);
    });

    it('plays the picture, with its sound', async () => {
        const parsed = await open('GDI01_INTRO_02.BK2');
        expect(parsed.warnings).toEqual([]);
        if (parsed.preview?.kind !== 'video') throw new Error('expected the movie');
        expect([parsed.preview.width, parsed.preview.height, parsed.preview.frameCount]).toEqual([704, 396, 311]);
        // 48 kHz stereo; FFmpeg's command-line decode of it has the same 998,400 samples.
        expect([parsed.preview.audio!.sampleRate, parsed.preview.audio!.channels]).toEqual([48000, 2]);
        expect((parsed.preview.audio!.wav.length - 44) / 2).toBe(998400);
    });

    // Ground truth: the decoder built natively from the same fork and patch, with FFmpeg's own command line (its
    // pictures were checked against Bink's own player, frame by frame: docs/plans/bink2-video.md). Recorded is the
    // SHA-256 of the list of every frame's MD5 (Y, U, V planes, packed), one line each.
    it.each([
        ['GDI01_INTRO_02.BK2', 'c49cb0f224c8f7828fec9ecd4db570e122fc17fe2063bcfa59226ed6c68cd399'],
        ['GDI13.BK2', '319bd4dee07c89200cb213cee32f7da9597835337d9cd01b1099fc54ed9d9fbb'],
    ])('decodes every frame of %s as the native build does', async (name, expected) => {
        const data = new Uint8Array(readFileSync(join(samples, name)));
        const w = await createBink();
        const v = new DataView(data.buffer, data.byteOffset);
        const [count, width, height, flags, tracks] = [v.getUint32(8, true), v.getUint32(20, true), v.getUint32(24, true), v.getUint32(36, true), v.getUint32(40, true)];
        const index = 48 + tracks * 12;
        const decoder = w._video_open(v.getUint32(0, true), flags, width, height);
        const size = (width * height * 3) / 2;
        const [yuv, input] = [w._malloc(size), w._malloc(1 << 20)];
        const hashes: string[] = [];
        for (let i = 0; i < count; i++) {
            const at = v.getUint32(index + i * 4, true);
            let start = at & ~1;
            const end = Math.min(v.getUint32(index + i * 4 + 4, true) & ~1, data.length);
            for (let t = 0; t < tracks; t++) start += 4 + v.getUint32(start, true);
            w.HEAPU8.set(data.subarray(start, end), input);
            expect(w._video_decode(decoder, input, end - start, at & 1, 0, 0, yuv), `frame ${i}`).toBe(1);
            hashes.push(
                createHash('md5')
                    .update(w.HEAPU8.subarray(yuv, yuv + size))
                    .digest('hex')
            );
        }
        w._decoder_close(decoder);
        expect(
            createHash('sha256')
                .update(hashes.join('\n') + '\n')
                .digest('hex')
        ).toBe(expected);
    });

    it('draws a frame the same whether played to or jumped to', async () => {
        const parsed = await open('GDI13.BK2');
        if (parsed.preview?.kind !== 'video') throw new Error('expected the movie');
        const md5 = (i: number) => {
            const f = parsed.preview?.kind === 'video' ? parsed.preview.frame(i) : null;
            return createHash('md5')
                .update((f as { rgba: Uint8Array }).rgba)
                .digest('hex');
        };
        const played: string[] = [];
        for (let i = 0; i <= 1212; i++) played.push(md5(i));
        // Back through kept states (every 100 frames), forward past them, and back to the start.
        for (const i of [1000, 350, 1212, 99, 0, 700]) expect(md5(i), `frame ${i}`).toBe(played[i]);
    }, 60_000);
    it('offers each of several sound tracks', async () => {
        const parsed = await open('GDI13.BK2');
        if (parsed.preview?.kind !== 'video') throw new Error('expected the movie');
        const { audio, audioTitle, otherAudio } = parsed.preview;
        expect([[audioTitle, audio!.seconds.toFixed(1)], ...otherAudio!.map((t) => [t.title, t.clip.seconds.toFixed(1)])]).toEqual([
            ['Sound track 1', '40.4'],
            ['Sound track 2', '40.4'],
            ['Sound track 3', '40.4'],
        ]);
    });

    it('ends where its last frame does, however many there are', async () => {
        // A field a frame stops at 2,000; a long movie (the intro's 2,996 frames) must still end at its last one, or
        // the rest would be reported as data hidden after the end.
        await ready();
        const count = 2500;
        const index = 44 + 1 * 12;
        const data = new Uint8Array(index + (count + 1) * 4 + count * 6);
        const v = new DataView(data.buffer);
        data.set([0x42, 0x49, 0x4b, 0x69]); // BIKi
        v.setUint32(8, count, true);
        v.setUint32(20, 32, true);
        v.setUint32(24, 16, true);
        v.setUint32(28, 15, true);
        v.setUint32(32, 1, true);
        v.setUint32(40, 1, true);
        v.setUint16(48, 22050, true);
        for (let i = 0; i <= count; i++) v.setUint32(index + i * 4, index + (count + 1) * 4 + i * 6 + (i === 0 ? 1 : 0), true);
        const parsed = bink.parse(data, { name: 'long.bik', names: [] });
        expect(parsed.end).toBe(data.length);
        expect(parsed.fields.at(-1)).toMatchObject({ name: 'Frames 2000 to 2499', offset: index + (count + 1) * 4 + 2000 * 6, length: 500 * 6, value: '500 more frames' });
    });

    it("says when the first frame isn't a keyframe, or doesn't decode", async () => {
        await ready();
        const data = new Uint8Array(readFileSync(join(samples, 'GDI01_INTRO_02.BK2')));
        const v = new DataView(data.buffer);
        const index = 48 + v.getUint32(40, true) * 12;
        const parse = (d: Uint8Array) => bink.parse(d, { name: 'x.bk2', names: [] }).warnings;

        const unmarked = data.slice();
        new DataView(unmarked.buffer).setUint32(index, v.getUint32(index, true) & ~1, true);
        // And with nothing to be drawn over, it doesn't decode either.
        expect(parse(unmarked)).toEqual([expect.stringMatching(/^The first frame isn't marked as a keyframe/), expect.stringMatching(/^The first frame doesn't decode/)]);

        // The first frame's video (after its one sound packet), zeroed. (The decoder takes a lot without complaint: all
        // 0xFF, or 0x55, decodes to a picture of something.)
        const damaged = data.slice();
        const start = v.getUint32(index, true) & ~1;
        const video = start + 4 + v.getUint32(start, true);
        damaged.fill(0, video, v.getUint32(index + 4, true) & ~1);
        expect(parse(damaged)).toEqual(["The first frame doesn't decode: the video is damaged, or isn't what the header says."]);
    });
});

/**
 * The Remastered Collection's movies, in the MOVIES*.MEG archives beside its CNCDATA folder (2 to 4 GB each): read a
 * piece at a time, from the archive's own table, so a test holds one movie, never an archive.
 */
const MEGS = ((folder) =>
    folder
        ? readdirSync(join(folder, '..'))
              .filter((n) => /^MOVIES.*\.MEG$/i.test(n))
              .map((n) => join(folder, '..', n))
        : [])(gameDir('cncRemastered'));

interface MegMovie {
    archive: string;
    name: string;
    start: number;
    size: number;
}

/** Every .bk2 in a MOVIES MEG (version 3: a header, the names, then 20-byte records), from its table alone. */
function megMovies(archive: string): MegMovie[] {
    const fd = openSync(archive, 'r');
    const read = (at: number, n: number) => {
        const b = Buffer.alloc(n);
        readSync(fd, b, 0, n, at);
        return b;
    };
    try {
        const h = read(0, 24);
        const [names, files, nameBytes] = [h.readUInt32LE(12), h.readUInt32LE(16), h.readUInt32LE(20)];
        const table = read(24, nameBytes);
        const list: string[] = [];
        for (let at = 0, i = 0; i < names; i++) {
            const n = table.readUInt16LE(at);
            list.push(table.toString('latin1', at + 2, at + 2 + n));
            at += 2 + n;
        }
        const records = read(24 + nameBytes, files * 20);
        const movies: MegMovie[] = [];
        for (let i = 0; i < files; i++) {
            const name = list[records.readUInt16LE(i * 20 + 18)];
            if (/\.bk2$/i.test(name)) movies.push({ archive, name: name.split(/[\\/]/).pop()!, size: records.readUInt32LE(i * 20 + 10), start: records.readUInt32LE(i * 20 + 14) });
        }
        return movies;
    } finally {
        closeSync(fd);
    }
}

function megRead(m: MegMovie): Uint8Array {
    const fd = openSync(m.archive, 'r');
    try {
        const b = new Uint8Array(m.size);
        readSync(fd, b, 0, m.size, m.start);
        return b;
    } finally {
        closeSync(fd);
    }
}

describe.skipIf(!MEGS.length)("The Remastered Collection's movies", () => {
    it('plays a movie with alpha: transparent until the picture draws in', async () => {
        await ready();
        // A score screen piece, 700 × 500, 35 frames, 341 kB: it starts empty, and a unit draws in over an alpha mask.
        const m = MEGS.flatMap(megMovies).find((m) => m.name === 'SCORE_TOPSCORES_ON.BK2');
        if (!m) throw new Error('SCORE_TOPSCORES_ON.BK2 not found in the MOVIES archives');
        const parsed = bink.parse(megRead(m), { name: m.name, names: [] });
        expect(parsed.warnings).toEqual([]);
        if (parsed.preview?.kind !== 'video') throw new Error('expected the movie');
        expect([parsed.preview.transparent, parsed.preview.frameCount]).toEqual([true, 35]);
        const alpha = (rgba: Uint8Array) => rgba.filter((_, i) => i % 4 === 3);
        // Ground truth: the native build of the decoder (its alpha plane, MD5). The first frame carries no alpha data:
        // fully transparent, over a flat gray picture.
        const first = parsed.preview.frame(0) as { rgba: Uint8Array };
        expect(alpha(first.rgba).every((a) => a === 0)).toBe(true);
        expect(first.rgba.filter((_, i) => i % 4 !== 3).every((v) => v === 128)).toBe(true);
        const last = parsed.preview.frame(34) as { rgba: Uint8Array };
        const a = alpha(last.rgba);
        expect(createHash('md5').update(a).digest('hex')).toBe('a76605809a45d629f56a5d502ae0711a');
        expect(a.filter((v) => v > 0).length).toBe(61622);
    });

    it('draws a frame without alpha data at the alpha its flags give', async () => {
        await ready();
        // The intro: 1080p, and opaque through most of it, where its frames carry no alpha data and their flags' top
        // byte says 255. Ground truth: RAD Video Tools' export of frame 747 (0-based 746) is opaque throughout.
        const m = MEGS.flatMap(megMovies).find((m) => m.name === 'INTRO2.BK2');
        if (!m) throw new Error('INTRO2.BK2 not found in the MOVIES archives');
        const parsed = bink.parse(megRead(m), { name: m.name, names: [] });
        if (parsed.preview?.kind !== 'video') throw new Error('expected the movie');
        expect(parsed.preview.frameCount).toBe(3283);
        const f = parsed.preview.frame(746) as { rgba: Uint8Array };
        for (let i = 3; i < f.rgba.length; i += 4) if (f.rgba[i] !== 255) throw new Error(`pixel ${(i - 3) / 4} has alpha ${f.rgba[i]}`);
    }, 120_000);

    // RAD Video Tools' own frames, exported with alpha (PNG) where the user keeps them (samples/bink/, not committed):
    // the only reference that shows Bink 2's alpha plane, which Bink's Linux player draws opaque.
    const RAD = join(__dirname, '../../../samples/bink/score_topscores_on');
    it.skipIf(!existsSync(RAD))(
        "matches RAD Video Tools' alpha, frame by frame",
        async () => {
            await ready();
            const m = MEGS.flatMap(megMovies).find((m) => m.name === 'SCORE_TOPSCORES_ON.BK2')!;
            const parsed = bink.parse(megRead(m), { name: m.name, names: [] });
            if (parsed.preview?.kind !== 'video') throw new Error('expected the movie');
            for (let i = 0; i < 35; i++) {
                const name = `SCORE_TOPSCORES_ON${String(i).padStart(2, '0')}.png`;
                const ref = png.parse(new Uint8Array(readFileSync(join(RAD, name))), { name, names: [] }).preview;
                if (ref?.kind !== 'picture') throw new Error(`${name} didn't decode`);
                const mine = (parsed.preview.frame(i) as { rgba: Uint8Array }).rgba;
                // Within 8 levels everywhere (the decoder's DC rounding differs from Bink's on a few blocks).
                let worst = 0;
                for (let p = 3; p < mine.length; p += 4) worst = Math.max(worst, Math.abs(mine[p] - ref.rgba[p]));
                expect(worst, `frame ${i}`).toBeLessThanOrEqual(8);
            }
        },
        120_000
    );

    // Every movie, every frame: about 15 GB read and decoded, so only when asked (CHIMERA_ALL_MOVIES=1).
    it.skipIf(!process.env.CHIMERA_ALL_MOVIES)(
        'decodes every frame of every movie',
        async () => {
            const w = await createBink();
            const input = w._malloc(16 << 20);
            const failed: string[] = [];
            let movies = 0;
            for (const m of MEGS.flatMap(megMovies)) {
                const data = megRead(m);
                const v = new DataView(data.buffer, data.byteOffset);
                const [count, width, height, flags, tracks] = [v.getUint32(8, true), v.getUint32(20, true), v.getUint32(24, true), v.getUint32(36, true), v.getUint32(40, true)];
                const index = 48 + tracks * 12;
                const decoder = w._video_open(v.getUint32(0, true), flags, width, height);
                let errors = 0;
                for (let i = 0; i < count; i++) {
                    const at = v.getUint32(index + i * 4, true);
                    let start = at & ~1;
                    const end = Math.min(v.getUint32(index + i * 4 + 4, true) & ~1, data.length);
                    for (let t = 0; t < tracks; t++) start += 4 + v.getUint32(start, true);
                    if (end - start > 16 << 20) throw new Error(`${m.name}: frame ${i} is ${end - start} bytes`);
                    w.HEAPU8.set(data.subarray(start, end), input);
                    if (w._video_decode(decoder, input, end - start, at & 1, 0, 0, 0) !== 1) errors++;
                }
                w._decoder_close(decoder);
                if (errors) failed.push(`${m.name}: ${errors} of ${count} frames`);
                movies++;
            }
            w._free(input);
            expect(failed).toEqual([]);
            expect(movies).toBe(438);
        },
        60 * 60 * 1000
    );
});
