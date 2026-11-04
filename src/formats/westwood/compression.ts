/**
 * Westwood's two image compression schemes, used by SHP, CPS and WSA files.
 *
 * LCW ("format 80") is LZ77-like: commands either copy literal bytes, repeat
 * one byte, or copy a run from earlier in the output. Format 40 is a delta
 * against the previous frame: it XORs bytes into the output or skips over them.
 */

/** Decodes LCW into dest; returns the number of bytes written. */
export function lcw(src: Uint8Array, dest: Uint8Array, srcStart = 0): number {
    let s = srcStart;
    let d = 0;
    // Some files start with 0x00 to say offsets are relative; older ones never do.
    const relative = src[s] === 0;
    if (relative) s++;
    const copyFrom = (from: number, count: number) => {
        for (let i = 0; i < count && d < dest.length; i++) dest[d++] = dest[from + i];
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
            if (count === 0) break;
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
    return d;
}

/** Applies a format 40 delta to dest in place. */
export function format40(src: Uint8Array, dest: Uint8Array, srcStart = 0): void {
    let s = srcStart;
    let d = 0;
    const xorFill = (count: number, value: number) => {
        for (let i = 0; i < count && d < dest.length; i++) dest[d++] ^= value;
    };
    const xorCopy = (count: number) => {
        for (let i = 0; i < count && d < dest.length; i++) dest[d++] ^= src[s++];
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
