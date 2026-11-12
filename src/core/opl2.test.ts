import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { OPL_RATE, Opl2 } from './opl2';

/**
 * A script of register writes that reaches most of the chip: an instrument and a note on each channel (FM and AM,
 * every waveform, feedback, key scaling, sustain, vibrato and tremolo at both depths), 600 random writes with key-ons
 * among them, the note-select bit, and rhythm mode with each drum. Each step is a write or a number of samples to make.
 */
function script(): ([reg: number, val: number] | number)[] {
    let seed = 12345;
    const rnd = (n: number) => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 8) % n;
    const out: ([number, number] | number)[] = [];
    const w = (r: number, v: number) => out.push([r, v]);
    const OPS = [0, 1, 2, 8, 9, 10, 16, 17, 18];
    w(0x01, 0x20);
    for (let c = 0; c < 9; c++) {
        const [m, k] = [OPS[c], OPS[c] + 3];
        w(0x20 + m, (c & 1 ? 0x40 : 0) | (c & 2 ? 0x80 : 0) | (c & 4 ? 0x20 : 0) | (c & 8 ? 0x10 : 0) | (1 + (c % 4)));
        w(0x20 + k, (c & 1 ? 0x80 : 0x40) | 0x20 | ((c % 3) + 1));
        w(0x40 + m, ((c << 6) & 0xc0) | (10 + c));
        w(0x40 + k, (((c + 1) << 6) & 0xc0) | c);
        w(0x60 + m, 0xf0 - c * 0x10 + c);
        w(0x60 + k, 0xa0 + c);
        w(0x80 + m, 0x30 + c);
        w(0x80 + k, 0x20 + c * 0x11);
        w(0xe0 + m, c % 4);
        w(0xe0 + k, (c + 1) % 4);
        w(0xc0 + c, ((c % 8) << 1) | (c & 1));
        w(0xa0 + c, 0x40 + c * 23);
        w(0xb0 + c, 0x20 | ((c % 8) << 2) | (c & 3));
        out.push(300 + c * 37);
    }
    w(0xbd, 0xc0);
    out.push(4000);
    for (let c = 0; c < 9; c += 2) w(0xb0 + c, 0x10);
    out.push(3000);
    w(0x08, 0x40);
    w(0xbd, 0x00);
    const RANGES = [0x20, 0x40, 0x60, 0x80, 0xe0];
    for (let i = 0; i < 600; i++) {
        const kind = rnd(10);
        if (kind < 6) w(RANGES[rnd(5)] + OPS[rnd(9)] + (rnd(2) ? 3 : 0), rnd(256));
        else if (kind === 6) w(0xa0 + rnd(9), rnd(256));
        else if (kind === 7) w(0xb0 + rnd(9), rnd(64));
        else if (kind === 8) w(0xc0 + rnd(9), rnd(16));
        else w(0xbd, rnd(256) & 0xc0);
        if (rnd(4) === 0) out.push(1 + rnd(900));
    }
    out.push(5000);
    const drums = [
        [0x30, 0x01], [0x33, 0x01], [0x50, 0x0f], [0x53, 0x00], [0x70, 0xf8], [0x73, 0xf6], [0x90, 0x55], [0x93, 0x44],
        [0x31, 0x01], [0x34, 0x01], [0x51, 0x00], [0x54, 0x00], [0x71, 0xf7], [0x74, 0xf7], [0x91, 0x77], [0x94, 0x77],
        [0x32, 0x05], [0x35, 0x01], [0x52, 0x00], [0x55, 0x00], [0x72, 0xf6], [0x75, 0xf5], [0x92, 0x66], [0x95, 0x57],
        [0xc6, 0x0e], [0xa6, 0x57], [0xb6, 0x09], [0xa7, 0x30], [0xb7, 0x0a], [0xa8, 0x20], [0xb8, 0x05],
    ]; // prettier-ignore
    for (const [r, v] of drums) w(r, v);
    for (const bits of [0x10, 0x08, 0x04, 0x02, 0x01, 0x1f, 0x00, 0x15, 0x0a, 0x00]) {
        w(0xbd, 0x20 | bits);
        out.push(1500);
    }
    w(0xbd, 0x00);
    out.push(2000);
    return out;
}

/** The script played through a chip, 512 samples a call at most (DBOPL checks for silent channels at each call). */
function play(rate: number): Int32Array {
    const chip = new Opl2(rate);
    const steps = script();
    const out = new Int32Array(steps.reduce<number>((n, s) => n + (typeof s === 'number' ? s : 0), 0));
    let at = 0;
    for (const step of steps) {
        if (typeof step !== 'number') chip.write(...step);
        else
            for (let left = step; left > 0; left -= 512) {
                const n = Math.min(512, left);
                chip.generate(out, at, n);
                at += n;
            }
    }
    return out;
}

const sha256 = (samples: Int32Array) =>
    createHash('sha256')
        .update(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength))
        .digest('hex');

describe('OPL2 (after DOSBox’s DBOPL)', () => {
    /**
     * The same script through DBOPL itself: ScummVM's audio/softsynth/opl/dbopl.cpp built with g++ and a harness that
     * makes the writes and calls GenerateBlock2 for at most 512 samples at a time, its 101,803 samples (32-bit, little-
     * endian) hashed. Every one matches, at a rate it's resampled to and at the chip's own.
     */
    it.each([
        [22050, '23cb4cca07b42625eefe91d645375b113840fc70a515438fd48dfa8d70451939', [4426, 5793, 5708, 5467, 5058, 4705]],
        [49716, '74a7c09fecfac0fb2591b400b7e7aaea4f98e39be0a9633741e4b04d69b596fd', [3226, 1808, 1788, 1748, 1728, 1707]],
    ])('gives DBOPL’s samples at %i Hz', (rate, hash, some) => {
        const samples = play(rate);
        expect(samples.length).toBe(101803);
        expect([...samples.subarray(1000, 1006)]).toEqual(some);
        expect(sha256(samples)).toBe(hash);
    });

    it('plays a note at the pitch the chip’s formula gives', () => {
        // F-number 580, block 4, multiplier 1: 580 × 49,716 ÷ 2^(20 − 4) = 440 Hz. One sine, its modulator silent.
        const chip = new Opl2(OPL_RATE);
        chip.write(0x20, 0x21);
        chip.write(0x23, 0x21);
        chip.write(0x40, 0x3f);
        chip.write(0x43, 0x00);
        chip.write(0x63, 0xf0);
        chip.write(0x83, 0x0f);
        chip.write(0xa0, 580 & 0xff);
        chip.write(0xb0, 0x20 | (4 << 2) | (580 >> 8));
        const second = new Int32Array(Math.round(OPL_RATE));
        chip.generate(second);
        let rises = 0;
        for (let i = 1; i < second.length; i++) if (second[i - 1] < 0 && second[i] >= 0) rises++;
        expect(Math.abs(rises - (580 * OPL_RATE) / 2 ** 16)).toBeLessThanOrEqual(1);
        // Keyed off with the fastest release, it falls silent.
        chip.write(0xb0, (4 << 2) | (580 >> 8));
        const after = new Int32Array(4096);
        chip.generate(after);
        expect([...after.subarray(2048)].every((v) => v === 0)).toBe(true);
    });
});
