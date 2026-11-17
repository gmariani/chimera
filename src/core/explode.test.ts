import { describe, expect, it } from 'vitest';
import { explode } from './explode';
import { implode, implodeTokens } from './implode.test-util';

const text = (s: string) => new TextEncoder().encode(s);

describe('explode (PKWARE implode)', () => {
    it('decodes blast.c’s own example', () => {
        // From the comments of zlib's contrib/blast/blast.c: uncoded literals, a 1 KB window, "AIAIAIAIAIAIA".
        const r = explode(Uint8Array.of(0x00, 0x04, 0x82, 0x24, 0x25, 0x8f, 0x80, 0x7f));
        expect(new TextDecoder().decode(r.data)).toBe('AIAIAIAIAIAIA');
        expect(r.used).toBe(8);
    });

    it('gives back what was imploded, literals coded or not, with each window size', () => {
        let seed = 5;
        const noise = Uint8Array.from({ length: 3000 }, () => (seed = (seed * 1103515245 + 12345) >>> 0) >>> 24);
        const words = text('The tiberium spreads; the tiberium spreads again. '.repeat(40));
        // Long runs (matches overlapping what they write), and repeats from far back.
        const runs = Uint8Array.from({ length: 6000 }, (_, i) => (i % 1500 < 700 ? 0 : (i * 7) & 255));
        for (const data of [noise, words, runs, new Uint8Array(0), Uint8Array.of(9)])
            for (const coded of [0, 1] as const)
                for (const dict of [4, 5, 6] as const) {
                    const packed = implode(data, coded, dict);
                    const r = explode(packed, data.length);
                    expect(r.data, `${data.length} bytes, ${coded}, ${dict}`).toEqual(data);
                    expect(r.used).toBe(packed.length);
                }
    });

    it('copies the longest match there is, from the farthest back it can reach', () => {
        // 518 bytes is the longest length; 4,096 back the farthest distance with a 4 KB window, 256 for a 2-byte match.
        const start = Uint8Array.from({ length: 4096 }, (_, i) => (i * 31 + (i >> 8)) & 255);
        const tokens = [...start, { len: 518, dist: 4096 }, { len: 2, dist: 256 }];
        const r = explode(implodeTokens(tokens));
        expect(r.data.length).toBe(4096 + 520);
        expect(r.data.subarray(4096, 4096 + 518)).toEqual(start.subarray(0, 518));
        expect([...r.data.subarray(4614)]).toEqual([...r.data.subarray(4614 - 256, 4614 - 254)]);
    });

    it('refuses what isn’t implode, or reaches back before the start, or never ends', () => {
        expect(() => explode(Uint8Array.of(2, 6, 0))).toThrow("The compressed data's first byte says how literals are stored: 0 or 1, not 2.");
        expect(() => explode(Uint8Array.of(0, 7, 0))).toThrow("The compressed data's second byte, the bits of a distance stored as they are, is 7, not 4, 5 or 6.");
        expect(() => explode(Uint8Array.of(0))).toThrow('The compressed data is too short for its 2-byte header.');
        expect(() => explode(implodeTokens([65, { len: 3, dist: 2 }]))).toThrow('The compressed data copies from 2 bytes back, when only 1 have been written.');
        const whole = implode(text('Cut off before the end, this never ends.'));
        expect(() => explode(whole.subarray(0, whole.length - 2))).toThrow('The compressed data ends before its end code.');
    });

    it('stops at the limit it’s given', () => {
        const packed = implode(new Uint8Array(100_000));
        expect(packed.length).toBeLessThan(1000);
        expect(() => explode(packed, 0, 50_000)).toThrow(/^The unpacked data would be [\d,]+ bytes, more than the 50,000 the app allows/);
    });
});
