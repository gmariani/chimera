/**
 * The LZ77 that Windows Help (and its SHG and MRB pictures) packs with: a flag byte, then for each of its bits from
 * the lowest, a byte as it is (0) or a pair of bytes (1), a little-endian word whose low 12 bits say how far back to
 * copy from (1 to 4,096) and whose top 4 bits how many bytes (3 to 18). As helpdeco's helpfile.txt describes it
 * (Manfred Winterhoff, 1997: https://github.com/joncampbell123/helpdeco/blob/master/helpfile.txt).
 */

export interface Unpacked {
    data: Uint8Array;
    /** How many bytes of the input it took. */
    used: number;
    /** A copy reached back before the start: what it would copy isn't there (it's 0 here). */
    beforeStart: boolean;
}

/** Unpacks `input`, to at most `limit` bytes: what's past that is left (a topic block holds 16 KB, no more). */
export function unpackHelp(input: Uint8Array, limit: number): Unpacked {
    const out = new Uint8Array(Math.min(limit, input.length * 18 + 18));
    let size = 0;
    let p = 0;
    let beforeStart = false;
    while (p < input.length && size < out.length) {
        const flags = input[p++];
        for (let bit = 0; bit < 8 && p < input.length && size < out.length; bit++) {
            if (!(flags & (1 << bit))) {
                out[size++] = input[p++];
                continue;
            }
            if (p + 1 >= input.length) {
                p = input.length;
                break;
            }
            const word = input[p] | (input[p + 1] << 8);
            p += 2;
            let from = size - (word & 0xfff) - 1;
            for (let n = (word >> 12) + 3; n > 0 && size < out.length; n--, from++) {
                if (from < 0) beforeStart = true;
                out[size++] = from < 0 ? 0 : out[from];
            }
        }
    }
    return { data: out.subarray(0, size), used: p, beforeStart };
}

/** The run-length packing of SHG and MRB pictures: a byte n, then n & 0x7F bytes as they are if its top bit is set, else the next byte n times. */
export function unpackRuns(input: Uint8Array, limit: number): Uint8Array {
    // A run of 2 bytes makes at most 127.
    const out = new Uint8Array(Math.min(limit, input.length * 64 + 128));
    limit = out.length;
    let size = 0;
    let p = 0;
    while (p < input.length && size < limit) {
        const n = input[p++];
        if (n & 0x80) {
            const count = Math.min(n & 0x7f, input.length - p, limit - size);
            out.set(input.subarray(p, p + count), size);
            size += count;
            p += n & 0x7f;
        } else if (p < input.length) {
            const count = Math.min(n, limit - size);
            out.fill(input[p++], size, size + count);
            size += count;
        }
    }
    return out.subarray(0, size);
}
