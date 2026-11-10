import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AudioClip, Parsed } from '../core/types';
import { detect } from './index';
import { inspect } from './inspect';
import voc from './voc';
import pak from './westwood/pak';

const enc = new TextEncoder();

function header(version = 0x010a, check = (~version + 0x1234) & 0xffff): number[] {
    return [...enc.encode('Creative Voice File\x1a'), 26, 0, version & 0xff, version >> 8, check & 0xff, check >> 8];
}
const block = (type: number, body: number[]) => [type, body.length & 0xff, (body.length >> 8) & 0xff, body.length >> 16, ...body];
const parse = (bytes: number[] | Uint8Array) => voc.parse(Uint8Array.from(bytes), { name: 'x.voc', names: [] });

function audio(r: Parsed): AudioClip {
    const p = r.preview?.kind === 'stack' ? r.preview.items[0].preview : r.preview;
    if (p?.kind !== 'audio') throw new Error(`No sound: ${r.warnings.join(' ')}`);
    return p;
}

/** The WAV's samples, as 16-bit (8-bit ones scaled up as FFmpeg does). */
function samples(clip: AudioClip): number[] {
    const body = clip.wav.subarray(44);
    return clip.bits === 8 ? Array.from(body, (v) => (v - 128) << 8) : Array.from(new Int16Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.length)));
}

// A starting byte and eight bytes of codes, the same for each ADPCM width. The expected samples are FFmpeg's (adpcm_sbpro_4, _3, _2).
const ADPCM = [0x90, 0x17, 0xf3, 0x8a, 0x00, 0x7f, 0xc4, 0x29, 0xe6];
const FFMPEG: Record<number, number[]> = {
    1: [2048, 128, 1024, -768, 768, 768, 256, 256, 256, 1152, -640, -2688, -640, 384, -128, -3200, 2944],
    2: [2048, 0, -128, -256, -1024, -1024, -1280, -1280, -768, -768, -768, -768, -768, -384, -1152, -1664, -3712, -2688, -2688, -2176, -1152, -640, -3712, -2688, -2688],
    3: [2048, 0, 512, 1536, -512, -4608, -8704, -8704, -10752, -10752, -10752, -10752, -10752, -10752, -10752, -10752, -10752, -10240, -11264, -13312, -16384, -16384, -16384, -14336, -14336, -14336, -14336, -14336, -13824, -14848, -14848, -13824, -13824],
};

describe('Creative Voice (VOC)', () => {
    it('reads 8-bit sound, silence at the sound\'s rate, a marker, text and a repeat', () => {
        // 10,000 Hz (divisor 156); silence of 5 samples at 5,000 Hz is a millisecond, so 10 samples here.
        const data = [...header(), ...block(6, [2, 0]), ...block(1, [156, 0, 128, 200, 56]), ...block(3, [4, 0, 56]), ...block(4, [7, 0]), ...block(5, [...enc.encode('hi'), 0]), ...block(7, []), 0];
        const r = parse(data);
        expect(detect(Uint8Array.from(data), null).id).toBe('voc');
        expect(r.warnings).toEqual([]);
        const clip = audio(r);
        expect([clip.sampleRate, clip.channels, clip.bits]).toEqual([10000, 1, 8]);
        expect(samples(clip)).toEqual([0, 72 << 8, -72 << 8, ...new Array(10).fill(0)]);
        expect(r.summary).toEqual(expect.arrayContaining([['Markers', '7'], ['Repeats', '3 times (played once here)'], ['Version', '1.10']]));
        expect(r.preview?.kind === 'stack' && r.preview.items[1].preview).toEqual({ kind: 'text', text: 'hi' });
        expect(r.fields.at(-1)).toMatchObject({ name: 'End', offset: data.length - 1 });
    });

    it.each([1, 2, 3])('decodes Creative ADPCM codec %i as FFmpeg does', (codec) => {
        const clip = audio(parse([...header(), ...block(1, [165, codec, ...ADPCM]), 0]));
        expect(clip.sampleRate).toBe(10989);
        expect(samples(clip)).toEqual(FFMPEG[codec]);
    });

    it('takes rate and stereo from an extended block, as FFmpeg does', () => {
        const constant = 65536 - Math.floor(256_000_000 / (2 * 11025));
        const clip = audio(parse([...header(), ...block(8, [constant & 0xff, constant >> 8, 1, 1]), ...block(1, [165, 1, 0x70, 0x90, ...ADPCM.slice(1)]), 0]));
        expect([clip.sampleRate, clip.channels]).toEqual([11025, 2]);
        expect(samples(clip)).toEqual([-2048, 2048, 128, 896, -768, 1664, -768, 1152, -768, 1152, 128, 256, -896, 1280, -384, 1024, -1920, 2560]);
    });

    it('reads 16-bit sound in the newer block, and its continuation', () => {
        const body = [0x44, 0xac, 0, 0, 16, 1, 4, 0, 0, 0, 0, 0, 0x01, 0x00, 0xff, 0xff];
        const clip = audio(parse([...header(0x0114), ...block(9, body), ...block(2, [0x00, 0x80]), 0]));
        expect([clip.sampleRate, clip.bits]).toEqual([44100, 16]);
        expect(samples(clip)).toEqual([1, -1, -32768]);
    });

    it('says what doesn\'t fit the format', async () => {
        expect(parse([...header(0x010a, 0x1234), 0]).warnings.join()).toMatch(/check \(0x1234\) doesn't match/);
        expect(parse([...header(), ...block(1, [165, 0, 1, 2])]).warnings.join()).toMatch(/no end block/);
        const cut = [...header(), 1, 100, 0, 0, 165, 0, 1, 2, 3];
        expect(parse(cut).warnings.join()).toMatch(/says it's 100 bytes, but only 5 bytes are left/);
        expect(parse([...header(), ...block(1, [165, 5, 1, 2]), 0]).warnings.join()).toMatch(/codec 5/);
        expect(parse([...header(), ...block(42, [1, 2]), 0]).warnings.join()).toMatch(/types VOC files don't define|type VOC files don't define/);
        expect(() => parse([...header().slice(0, 20), 10, 0, 0, 0, 0, 0])).toThrow(/at least|less than the 26/);
        // Anything after the end block gets the usual check.
        const hidden = Uint8Array.from([...header(), ...block(1, [165, 0, 128]), 0, ...enc.encode('MZ and more')]);
        const r = await inspect(hidden, { name: 'x.voc', names: [] });
        expect(r.checks[0]).toMatchObject({ level: 'danger' });
        expect(r.checks[0].text).toMatch(/11 bytes after the end of the sound \(voc\)/);
    });
});

// Dune II's sounds, inside its PAKs, if present (they aren't committed).
const DUNE = join(__dirname, '../../samples/westwood/Dune II');
describe.skipIf(!existsSync(DUNE))('Dune II\'s VOCs', () => {
    it('reads all 226, each with a sound and nothing to warn about', () => {
        let count = 0;
        for (const name of readdirSync(DUNE).filter((n) => /\.pak$/i.test(n))) {
            const entries = pak.parse(new Uint8Array(readFileSync(join(DUNE, name))), { name, names: [] }).entries!;
            for (const e of entries.filter((x) => /\.voc$/i.test(x.label))) {
                expect(detect(e.data, e.name).id, e.label).toBe('voc');
                const r = voc.parse(e.data, { name: e.name, names: [] });
                expect(r.warnings, `${name} › ${e.label}`).toEqual([]);
                expect(audio(r).seconds, e.label).toBeGreaterThan(0);
                count++;
            }
        }
        expect(count).toBe(226);
    });
});
