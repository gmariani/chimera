/**
 * The program a changed file's record holds, run. Ported from rtptool's src/apply.rs (kr4uzi's fork of
 * https://github.com/bwrsandman/rtptool, commit 258d175), Rust to TypeScript, which carries this notice:
 *
 *   MIT License
 *
 *   Copyright (c) 2026 Sandy Carter
 *
 *   Permission is hereby granted, free of charge, to any person obtaining a copy
 *   of this software and associated documentation files (the "Software"), to deal
 *   in the Software without restriction, including without limitation the rights
 *   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 *   copies of the Software, and to permit persons to whom the Software is
 *   furnished to do so, subject to the following conditions:
 *
 *   The above copyright notice and this permission notice shall be included in all
 *   copies or substantial portions of the Software.
 *
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 *   SOFTWARE.
 *
 * Changed from the original: only its strict mode is kept (nothing is clipped, grown or skipped: anything out of bounds
 * stops the program, and says why, in words); it can run without the old file, to check the program's bounds and count
 * what it keeps, adds and fills; the variable-length numbers are read with multiplication, so 5-byte ones don't
 * overflow; a program that names a second old file is refused when it's run with one.
 */

import { checkBytes } from '../../core/limits';

/**
 * RTPatch's program for a changed file, after the spec in rtptool's SPEC.md: one-byte operations and their numbers.
 * The new file starts as zeros of its size. Copies take a run of the old file to the write position, perhaps after a
 * gap left for new bytes; a copy can be stored once as a template and repeated. Fills write a byte, two or four over
 * and over. FLUSH pours the program's new bytes into every gap, in order, the last running to the end of the file.
 * Pokes add to bytes already written (a 1-, 2- or 4-byte number at running positions): an address that moved by the
 * same amount in many places.
 */

export interface ProgramRun {
    /** The new file, when the old one was given and the program ran to its end. */
    output: Uint8Array | null;
    /** Bytes of the new file copied from the old one. */
    kept: number;
    /** New bytes the program carries. */
    added: number;
    /** Bytes written as zeros or a repeated pattern. */
    filled: number;
    /** Numbers changed in place. */
    pokes: number;
    operations: number;
    /** Why it stopped short, in words, or null. */
    problem: string | null;
}

class Stop extends Error {}

/**
 * Runs `program`, which makes a file of `newSize` from an old one of `oldSize` (`sources` old files in all). With `old`,
 * the new file is made; without, the program is only checked and counted.
 */
export function runProgram(program: Uint8Array, oldSize: number, newSize: number, sources: number, old: Uint8Array | null): ProgramRun {
    const run: ProgramRun = { output: null, kept: 0, added: 0, filled: 0, pokes: 0, operations: 0, problem: null };
    if (old && sources !== 1) return { ...run, problem: 'it changes several old files into one, which isn’t done here' };
    const out = old ? new Uint8Array(checkBytes(newSize, 'The new file')) : null;
    let p = 0;
    const stop = (why: string): never => {
        throw new Stop(why);
    };
    const byte = () => (p < program.length ? program[p++] : stop('its program ends before its END'));
    const bytes = (n: number) => {
        if (n > program.length - p) stop('its program ends before its END');
        p += n;
        return program.subarray(p - n, p);
    };
    /** A number: a lead byte (its top bit the sign, then a 1 for each byte after it, then the high bits), then the low bytes. */
    const vli = () => {
        const b = byte();
        let count = 0;
        for (let mask = 0x40; mask && b & mask; mask >>= 1) count++;
        if (count > 4) stop('its program has a number of more than 5 bytes');
        // The lead byte's bits below its 1s are the highest; 6 of them when it has none.
        let value = b & ((0x40 >> count) - 1);
        let low = 0;
        for (let i = 0, scale = 1; i < count; i++, scale *= 256) low += byte() * scale;
        value = value * 256 ** count + low;
        return b & 0x80 ? -value : value;
    };
    const count = () => {
        const v = vli();
        return v < 0 ? stop('its program has a negative count') : v;
    };
    const sourceIndex = () => {
        if (sources < 2) return;
        const i = vli();
        if (i < 0 || i >= sources) stop(`its program names old file ${i}, which it doesn’t have`);
    };

    let at = 0;
    let poke = 0;
    let gaps: [number, number][] = [];
    let gapBytes = 0;
    const templates: [number, number][] = [];
    const gap = (n: number) => {
        if (n < 0 || n > newSize - at) stop('its program leaves a gap past the end of the new file');
        if (n) {
            gaps.push([at, n]);
            gapBytes += n;
            at += n;
        }
    };
    const copy = (from: number, n: number) => {
        if (from < 0 || n < 0 || from > oldSize || n > oldSize - from) stop('its program copies from past the end of the old file');
        if (n > newSize - at) stop('its program writes past the end of the new file');
        if (out && old) out.set(old.subarray(from, from + n), at);
        at += n;
        run.kept += n;
    };
    const fill = (pattern: Uint8Array | null, n: number) => {
        if (n > newSize - at) stop('its program writes past the end of the new file');
        if (out) {
            if (!pattern) out.fill(0, at, at + n);
            else for (let i = 0; i < n; i++) out[at + i] = pattern[i % pattern.length];
        }
        at += n;
        run.filled += n;
    };
    const add = (position: number, width: 1 | 2 | 4, delta: number) => {
        if (position < 0 || position > newSize - width) stop('its program changes a number outside the new file');
        run.pokes++;
        if (!out) return;
        const view = new DataView(out.buffer, out.byteOffset);
        if (width === 1) out[position] = (out[position] + delta) & 0xff;
        else if (width === 2) view.setInt16(position, view.getInt16(position, true) + delta, true);
        else view.setInt32(position, (view.getInt32(position, true) + delta) | 0, true);
    };
    const s8 = (v: number) => (v << 24) >> 24;
    /** Pokes of one delta at running positions, after a fresh start. */
    const pokes = (width: 1 | 2 | 4, delta: number) => {
        poke = 0;
        for (let n = count(); n > 0; n--) add((poke += vli()), width, delta);
    };

    try {
        for (;;) {
            if (p >= program.length) stop('its program ends without its END');
            const op = program[p++];
            run.operations++;
            if (op === 0x01) {
                if (p !== program.length) stop('its program goes on after its END');
                if (gaps.length) stop('its program leaves gaps it never fills');
                break;
            }
            switch (op) {
                case 0x02: {
                    const i = vli();
                    if (i < 0 || i >= sources) stop(`its program names old file ${i}, which it doesn’t have`);
                    at = 0;
                    poke = 0;
                    break;
                }
                case 0x03:
                case 0x04: {
                    const advance = op === 0x04 ? vli() : 0;
                    sourceIndex();
                    const from = vli();
                    const n = vli();
                    gap(advance);
                    copy(from, n);
                    break;
                }
                case 0x05: {
                    if (newSize > at) {
                        gaps.push([at, newSize - at]);
                        gapBytes += newSize - at;
                    }
                    if (gapBytes > program.length - p) stop('its program has fewer new bytes than it leaves gaps for');
                    for (const [where, n] of gaps) {
                        const b = bytes(n);
                        if (out) out.set(b, where);
                        run.added += n;
                    }
                    gaps = [];
                    gapBytes = 0;
                    break;
                }
                case 0x06: {
                    poke += vli();
                    add(poke, 1, s8(byte()));
                    break;
                }
                case 0x07:
                case 0x0e:
                    pokes(1, s8(byte()));
                    break;
                case 0x08: {
                    sourceIndex();
                    const from = vli();
                    const n = vli();
                    if (from < 0 || n < 0 || from > oldSize || n > oldSize - from) stop('its program stores a copy from past the end of the old file');
                    templates.push([from, n]);
                    break;
                }
                case 0x09:
                case 0x0a: {
                    const advance = op === 0x0a ? vli() : 0;
                    const i = vli();
                    const t = templates[i];
                    if (!t) stop(`its program repeats copy ${i}, which it hasn’t stored`);
                    gap(advance);
                    copy(t[0], t[1]);
                    break;
                }
                case 0x0b:
                case 0x0c: {
                    const advance = op === 0x0c ? vli() : 0;
                    const n = count();
                    gap(advance);
                    fill(null, n);
                    break;
                }
                case 0x0d: {
                    poke = 0;
                    for (let n = count(); n > 0; n--) {
                        poke += vli();
                        add(poke, 1, s8(byte()));
                    }
                    break;
                }
                case 0x0f:
                    pokes(2, new DataView(bytes(2).slice().buffer).getInt16(0, true));
                    break;
                case 0x10:
                    pokes(4, new DataView(bytes(4).slice().buffer).getInt32(0, true));
                    break;
                case 0x11:
                case 0x12:
                case 0x13:
                case 0x14:
                case 0x15:
                case 0x16: {
                    const advance = op >= 0x14 ? vli() : 0;
                    const pattern = bytes([1, 2, 4][(op - 0x11) % 3]);
                    const n = count();
                    gap(advance);
                    fill(pattern, n);
                    break;
                }
                default:
                    stop(`its program has an operation, 0x${op.toString(16).padStart(2, '0')}, that RTPatch doesn’t`);
            }
        }
    } catch (e) {
        if (!(e instanceof Stop)) throw e;
        run.problem = e.message;
        return run;
    }
    run.output = out;
    return run;
}
