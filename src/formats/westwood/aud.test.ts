import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AudioClip, Parsed } from '../../core/types';
import { detect } from '../index';
import { inspect } from '../inspect';
import aud from './aud';

const u16 = (v: number) => [v & 0xff, v >> 8];
const u32 = (v: number) => [...u16(v & 0xffff), ...u16(v >>> 16)];

/** An AUD of these chunks ([stored bytes, decoded size], the size defaulting to what the compression makes). */
function build(compression: number, flags: number, chunks: (number[] | [number[], number])[], { rate = 22050, size, out }: { rate?: number; size?: number; out?: number } = {}): Uint8Array {
    const body: number[] = [];
    let total = 0;
    for (const c of chunks) {
        const [bytes, decoded] = Array.isArray(c[0]) ? (c as [number[], number]) : [c as number[], compression === 99 ? (c as number[]).length * 4 : (c as number[]).length];
        body.push(...u16(bytes.length), ...u16(decoded), ...u32(0xdeaf), ...bytes);
        total += decoded;
    }
    return Uint8Array.from([...u16(rate), ...u32(size ?? body.length), ...u32(out ?? total), flags, compression, ...body]);
}

const parse = (data: Uint8Array) => aud.parse(data, { name: 'x.aud', names: [] }) as Parsed;
const clip = (r: Parsed) => r.preview as AudioClip;
const samples = (c: AudioClip) => {
    const body = c.wav.subarray(44);
    return c.bits === 8 ? [...body] : [...new Int16Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.length))];
};

describe('Westwood AUD', () => {
    it('reads compression 0: plain 8-bit PCM, in chunks', () => {
        const data = build(
            0,
            0,
            [
                [128, 200, 56],
                [129, 130],
            ],
            { rate: 11025 }
        );
        expect(detect(data, null).id).toBe('aud');
        const r = parse(data);
        expect(r.warnings).toEqual([]);
        expect(r.summary).toContainEqual(['Compression', 'None (PCM)']);
        expect([clip(r).sampleRate, clip(r).channels, clip(r).bits]).toEqual([11025, 1, 8]);
        expect(samples(clip(r))).toEqual([128, 200, 56, 129, 130]);
        expect(r.fields[1].children!.length).toBe(2);
    });

    it('reads plain 16-bit stereo PCM', () => {
        const r = parse(build(0, 3, [[...u16(1), ...u16(0xffff), ...u16(0x8000), ...u16(0x7fff)]]));
        expect(r.warnings).toEqual([]);
        expect([clip(r).channels, clip(r).bits, clip(r).seconds]).toEqual([2, 16, 2 / 22050]);
        expect(samples(clip(r))).toEqual([1, -1, -32768, 32767]);
    });

    it("takes IMA's one-sample-short last chunk as the games' files have it", () => {
        // 3 bytes of codes are 6 samples (12 bytes); the encoder counted a seventh it couldn't store.
        const r = parse(build(99, 2, [[[0x17, 0x8a, 0x29], 14]]));
        expect(r.warnings).toEqual([]);
        expect(clip(r).seconds).toBe(6 / 22050);
        // Anywhere but the last chunk, or by more than a sample, it's wrong.
        expect(parse(build(99, 2, [[[0x17, 0x8a, 0x29], 14], [0x11]])).warnings.join()).toMatch(/A chunk doesn't decode to the size it gives: chunk 1 says 14 bytes but makes 12/);
        expect(parse(build(99, 2, [[[0x17, 0x8a, 0x29], 16]])).warnings.join()).toMatch(/says 16 bytes but makes 12/);
    });

    it("says what doesn't fit the format", async () => {
        const good = build(0, 0, [[1, 2, 3, 4]]);
        // The size after the header.
        expect(parse(build(0, 0, [[1, 2, 3, 4]], { size: 99 })).warnings).toEqual(['The header says 99 bytes follow it, but 12 bytes do.']);
        // The decoded size against the chunks'.
        expect(
            parse(
                build(
                    0,
                    0,
                    [
                        [1, 2, 3, 4],
                        [5, 6],
                    ],
                    { out: 5 }
                )
            ).warnings.join()
        ).toMatch(/header says the sound is 5 bytes, but its chunks add up to 6 bytes/);
        // Plain PCM whose chunk says it decodes to something else.
        expect(parse(build(0, 0, [[[1, 2, 3, 4], 6]])).warnings.join()).toMatch(/Nothing is compressed, so the two sizes should match/);
        // A chunk without its marker, and one cut short.
        const unmarked = good.slice();
        unmarked[16] = 0;
        expect(parse(unmarked).warnings.join()).toMatch(/Chunk 1 at offset 12 is missing its 0xDEAF marker.*no chunks/);
        expect(parse(good.slice(0, -2)).warnings.join()).toMatch(/Chunk 1 says it's 4 bytes, but only 2 bytes are left/);
        // Flags that don't fit the compression.
        expect(parse(build(1, 2, [[[0x80 | 3, 1, 2, 3], 3]])).warnings.join()).toMatch(/Westwood ADPCM only makes 8-bit sound/);
        expect(parse(build(99, 0, [[0x11]])).warnings.join()).toMatch(/IMA ADPCM makes 16-bit sound/);
        expect(() => parse(build(5, 0, [[1, 2]]))).toThrow(/Compression 5 isn't one AUD files use/);
        expect(() => parse(new Uint8Array(6))).toThrow(/12 bytes/);
        // Anything after the last chunk gets the usual check.
        const hidden = Uint8Array.from([...good, ...new TextEncoder().encode('MZ payload')]);
        const r = await inspect(hidden, { name: 'x.aud', names: [] });
        expect(r.checks[0]).toMatchObject({ level: 'danger' });
        expect(r.checks[0].text).toMatch(/10 bytes after the end/);
    });

    it("doesn't take other files for plain PCM", () => {
        // Compression 0 is only sniffed when the first chunk's two sizes match.
        const data = build(0, 0, [[[1, 2, 3, 4], 9]]);
        expect(detect(data, null).id).not.toBe('aud');
    });
});

// The sample sounds, if present (they aren't committed).
const SAMPLES = join(__dirname, '../../../samples/westwood');
describe.skipIf(!existsSync(SAMPLES))('sample AUDs', () => {
    it('reads each with nothing to warn about', () => {
        const names = readdirSync(SAMPLES).filter((n) => /\.aud$/i.test(n));
        expect(names.length).toBeGreaterThan(0);
        for (const name of names) {
            const r = parse(new Uint8Array(readFileSync(join(SAMPLES, name))));
            expect(r.warnings, name).toEqual([]);
            expect(clip(r).seconds, name).toBeGreaterThan(1);
        }
    });
});
