/**
 * Westwood's compression schemes. LCW and format 40 are used by SHP, CPS and
 * WSA files; LZW and RLE (further down) by older CPS files.
 *
 * LCW ("format 80") is LZ77-like: commands either copy literal bytes, repeat
 * one byte, or copy a run from earlier in the output. Format 40 is a delta
 * against the previous frame: it XORs bytes into the output or skips over them.
 */

/** How a decode went, for decoders that can say: where it stopped reading, and what was wrong. */
export interface DecodeInfo {
    /** Where in src it stopped reading (after the end marker, if it found one). */
    read: number;
    /** Whether it found the stream's end marker (rather than running out of data or room). */
    ended: boolean;
    /** Copies from outside what was decoded so far (before its start, or not written yet): damaged or crafted data. */
    badRefs: number;
}

/** Decodes LCW into dest; returns the number of bytes written. Pass info to learn where it stopped and what was wrong. */
export function lcw(src: Uint8Array, dest: Uint8Array, srcStart = 0, info?: DecodeInfo): number {
    let s = srcStart;
    let d = 0;
    let ended = false;
    let badRefs = 0;
    // Some files start with 0x00 to say offsets are relative; older ones never do.
    const relative = src[s] === 0;
    if (relative) s++;
    const copyFrom = (from: number, count: number) => {
        // Copies may overlap forward (a run), but never read what isn't there yet.
        if (from < 0 || from >= d) badRefs++;
        for (let i = 0; i < count && d < dest.length; i++) dest[d++] = from + i >= 0 ? dest[from + i] : 0;
    };

    while (s < src.length && d < dest.length) {
        const command = src[s++];
        if ((command & 0x80) === 0) {
            // 0cccpppp pppppppp: copy c+3 bytes from p bytes back.
            const count = ((command & 0x70) >> 4) + 3;
            const back = ((command & 0x0f) << 8) | src[s++];
            copyFrom(d - back, count);
        } else if ((command & 0x40) === 0) {
            // 10cccccc: copy c literal bytes; 0x80 alone ends the data.
            const count = command & 0x3f;
            if (count === 0) {
                ended = true;
                break;
            }
            for (let i = 0; i < count && d < dest.length; i++) dest[d++] = src[s++];
        } else {
            const count = command & 0x3f;
            if (count === 0x3e) {
                // 11111110 cccc v: repeat v, c times.
                const repeat = src[s] | (src[s + 1] << 8);
                const value = src[s + 2];
                s += 3;
                for (let i = 0; i < repeat && d < dest.length; i++) dest[d++] = value;
            } else {
                // 11111111 cccc pppp: copy c bytes from position p. 11cccccc pppp: copy c+3 bytes from p.
                const long = count === 0x3f;
                const length = long ? src[s] | (src[s + 1] << 8) : count + 3;
                if (long) s += 2;
                const position = src[s] | (src[s + 1] << 8);
                s += 2;
                copyFrom(relative ? d - position : position, length);
            }
        }
    }
    // Full, with the end marker next: the usual way a stream ends when the buffer is exactly its size.
    if (!ended && d >= dest.length && src[s] === 0x80) {
        ended = true;
        s++;
    }
    if (info) Object.assign(info, { read: Math.min(s, src.length), ended, badRefs });
    return d;
}

/**
 * Applies a format 40 delta to dest in place. Returns how far into dest it
 * reached: past dest's end means the delta was for something bigger (nothing
 * is written there).
 */
export function format40(src: Uint8Array, dest: Uint8Array, srcStart = 0): number {
    let s = srcStart;
    let d = 0;
    // Counts are at most 0x3fff, so running past dest costs nothing; d keeps counting so the caller can tell.
    const xorFill = (count: number, value: number) => {
        for (let i = 0; i < count; i++, d++) if (d < dest.length) dest[d] ^= value;
    };
    const xorCopy = (count: number) => {
        for (let i = 0; i < count; i++, d++, s++) if (d < dest.length) dest[d] ^= src[s];
    };

    while (s < src.length) {
        const command = src[s++];
        if ((command & 0x80) === 0) {
            if (command === 0) {
                // 00000000 c v: XOR c bytes with v.
                const count = src[s++];
                xorFill(count, src[s++]);
            } else {
                // 0ccccccc: XOR the next c bytes with the following c source bytes.
                xorCopy(command);
            }
        } else if (command !== 0x80) {
            // 1ccccccc: skip c bytes.
            d += command & 0x7f;
        } else {
            const word = src[s] | (src[s + 1] << 8);
            s += 2;
            if (word === 0) break;
            if ((word & 0x8000) === 0) d += word;
            else if ((word & 0x4000) === 0) xorCopy(word & 0x3fff);
            else xorFill(word & 0x3fff, src[s++]);
        }
    }
    return d;
}

/**
 * LZO1X (as minilzo writes it), which TS and RA2 use for the map cells in
 * [IsoMapPack5]. Commands copy literal bytes or earlier output; a command's
 * low two bits say how many literals follow it. Returns the bytes written.
 */
export function lzo1x(src: Uint8Array, dest: Uint8Array): number {
    let ip = 0;
    let op = 0;
    const literals = (n: number) => {
        for (let i = 0; i < n && op < dest.length; i++) dest[op++] = src[ip++];
    };
    const copy = (from: number, n: number) => {
        for (let i = 0; i < n && op < dest.length; i++, from++) dest[op++] = from >= 0 ? dest[from] : 0;
    };
    /** A length that spills into extra bytes: each 0 adds 255, then the next byte. */
    const long = (base: number) => {
        let n = 0;
        while (ip < src.length && src[ip] === 0) {
            n += 255;
            ip++;
        }
        return n + base + src[ip++];
    };

    let t: number;
    // What to do next: read a literal run, read a match, or a match right after the first literal run.
    let state: 'literals' | 'match' | 'first' = 'literals';
    if (src[0] > 17) {
        t = src[ip++] - 17;
        literals(t);
        state = t < 4 ? 'match' : 'first';
    }
    while (ip < src.length && op < dest.length) {
        if (state === 'literals') {
            t = src[ip++];
            if (t >= 16) {
                state = 'match';
                ip--;
                continue;
            }
            literals((t === 0 ? long(15) : t) + 3);
            state = 'first';
            continue;
        }
        t = src[ip++];
        let after: number;
        if (state === 'first' && t < 16) {
            // A 3-byte match from at least 2 KB back, only possible right after a literal run.
            copy(op - (1 + 0x0800) - (t >> 2) - (src[ip++] << 2), 3);
            after = src[ip - 2] & 3;
        } else if (t >= 64) {
            copy(op - 1 - ((t >> 2) & 7) - (src[ip++] << 3), (t >> 5) + 1);
            after = src[ip - 2] & 3;
        } else if (t >= 32) {
            const n = (t & 31) === 0 ? long(31) : t & 31;
            copy(op - 1 - ((src[ip] >> 2) + (src[ip + 1] << 6)), n + 2);
            ip += 2;
            after = src[ip - 2] & 3;
        } else if (t >= 16) {
            const n = (t & 7) === 0 ? long(7) : t & 7;
            let from = op - ((t & 8) << 11) - ((src[ip] >> 2) + (src[ip + 1] << 6));
            ip += 2;
            if (from === op) break; // End of the stream.
            from -= 0x4000;
            copy(from, n + 2);
            after = src[ip - 2] & 3;
        } else {
            // A 2-byte match, only after a match's trailing literals.
            copy(op - 1 - (t >> 2) - (src[ip++] << 2), 2);
            after = src[ip - 2] & 3;
        }
        if (after === 0) {
            state = 'literals';
        } else {
            literals(after);
            state = 'match';
        }
    }
    return op;
}

/**
 * Westwood's LZW ("format 1" with 12-bit codes, "format 2" with 14), from Eye
 * of the Beholder and BattleTech: The Crescent Hawk's Revenge. Codes are read
 * high bits first. Below 256 a code is a byte; 256 + n repeats what code n of
 * the stream made, plus the first byte of what code n + 1 made (when n + 1 is
 * this code, its own first byte). All ones ends the stream. The dictionary
 * never resets. See https://moddingwiki.shikadi.net/wiki/Westwood_LZW-12.
 * Returns the number of bytes written.
 */
export function westwoodLzw(src: Uint8Array, dest: Uint8Array, bits: 12 | 14, srcStart = 0, info?: DecodeInfo): number {
    const end = (1 << bits) - 1;
    // Where each code's bytes start in dest, so a later code can copy them (and the next one's first byte).
    const starts = new Int32Array(Math.floor(((src.length - srcStart) * 8) / bits) + 2);
    let codes = 0;
    let bit = srcStart * 8;
    let d = 0;
    let ended = false;
    let badRefs = 0;
    const total = src.length * 8;
    while (bit + bits <= total && d < dest.length) {
        let code = 0;
        for (let i = 0; i < bits; i++, bit++) code = (code << 1) | ((src[bit >> 3] >> (7 - (bit & 7))) & 1);
        if (code === end) {
            ended = true;
            break;
        }
        starts[codes] = d;
        if (code < 256) {
            dest[d++] = code;
        } else {
            const n = code - 256;
            // Only codes already read: n + 1 may be this one, n can't be.
            if (n >= codes) {
                badRefs++;
                break;
            }
            const from = starts[n];
            const length = starts[n + 1] - from;
            for (let i = 0; i < length && d < dest.length; i++) dest[d++] = dest[from + i];
            // The first byte of code n + 1: already written, even when n + 1 is this code (it's then the first byte just copied).
            if (d < dest.length) dest[d++] = dest[starts[n + 1]];
        }
        codes++;
        starts[codes] = d;
    }
    // Full, with the end marker next: the usual way a stream ends when the buffer is exactly its size.
    if (!ended && d >= dest.length && bit + bits <= total) {
        let code = 0;
        for (let i = 0; i < bits; i++) code = (code << 1) | ((src[(bit + i) >> 3] >> (7 - ((bit + i) & 7))) & 1);
        if (code === end) {
            ended = true;
            bit += bits;
        }
    }
    if (info) Object.assign(info, { read: Math.min(Math.ceil(bit / 8), src.length), ended, badRefs });
    return d;
}

/**
 * Westwood RLE ("format 3"). 1 to 127: copy that many bytes. 0x80 to 0xFF:
 * repeat the next byte 256 minus that many times. 0: a 16-bit count, then the
 * byte to repeat; the count is big-endian on the PC, little-endian on the
 * Amiga. No end marker: it stops when dest is full or src runs out. Returns
 * the number of bytes written.
 * See https://moddingwiki.shikadi.net/wiki/Westwood_RLE.
 */
export function westwoodRle(src: Uint8Array, dest: Uint8Array, littleEndian: boolean, srcStart = 0, info?: DecodeInfo): number {
    let s = srcStart;
    let d = 0;
    while (s < src.length && d < dest.length) {
        const command = src[s++];
        // 0x80 is a repeat of 128 (Westwood's encoder uses the long form for that, but decoders take the byte as signed).
        if (command & 0x80) {
            const value = src[s++];
            for (let i = 0x100 - command; i > 0 && d < dest.length; i--) dest[d++] = value;
        } else if (command) {
            for (let i = 0; i < command && d < dest.length; i++) dest[d++] = src[s++];
        } else {
            const count = littleEndian ? src[s] | (src[s + 1] << 8) : (src[s] << 8) | src[s + 1];
            const value = src[s + 2];
            s += 3;
            for (let i = 0; i < count && d < dest.length; i++) dest[d++] = value;
        }
    }
    if (info) Object.assign(info, { read: Math.min(s, src.length), ended: d >= dest.length, badRefs: 0 });
    return d;
}
