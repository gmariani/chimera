/**
 * A small, plain PKWARE implode encoder, to test explode.ts against: greedy matches found by searching back, written
 * with blast.c's fixed codes. Not how PKWARE's compresses, only a valid stream.
 *
 * The encoder is Chimera's own; its code tables (LITERALS, LENGTHS, DISTANCES and the base and extra-bit tables) are
 * copied from Mark Adler's blast.c (zlib's contrib/blast, version 1.3), which carries this notice, in blast.h:
 *
 *   Copyright (C) 2003, 2012, 2013 Mark Adler
 *   version 1.3, 24 Aug 2013
 *
 *   This software is provided 'as-is', without any express or implied
 *   warranty.  In no event will the author be held liable for any damages
 *   arising from the use of this software.
 *
 *   Permission is granted to anyone to use this software for any purpose,
 *   including commercial applications, and to alter it and redistribute it
 *   freely, subject to the following restrictions:
 *
 *   1. The origin of this software must not be misrepresented; you must not
 *      claim that you wrote the original software. If you use this software
 *      in a product, an acknowledgment in the product documentation would be
 *      appreciated but is not required.
 *   2. Altered source versions must be plainly marked as such, and must not be
 *      misrepresented as being the original software.
 *   3. This notice may not be removed or altered from any source distribution.
 *
 *   Mark Adler    madler@alumni.caltech.edu
 */

export type ImplodeToken = number | { len: number; dist: number };

/** Canonical codes from blast's run-length lengths: by length, then by symbol, counting up. */
function codes(rep: number[]): { code: number; len: number }[] {
    const lengths: number[] = [];
    for (const r of rep) for (let n = (r >> 4) + 1; n > 0; n--) lengths.push(r & 15);
    const out: { code: number; len: number }[] = [];
    let code = 0;
    for (let len = 1; len <= 13; len++) {
        lengths.forEach((l, s) => {
            if (l === len) out[s] = { code: code++, len };
        });
        code <<= 1;
    }
    return out;
}

// blast.c's tables, copied apart from explode.ts's, so the round trips check those too.
const LITERALS = codes([
    11, 124, 8, 7, 28, 7, 188, 13, 76, 4, 10, 8, 12, 10, 12, 10, 8, 23, 8, 9, 7, 6, 7, 8, 7, 6, 55, 8, 23, 24, 12, 11, 7, 9, 11, 12, 6, 7, 22, 5, 7, 24, 6, 11, 9, 6, 7, 22, 7, 11, 38, 7, 9, 8, 25, 11,
    8, 11, 9, 12, 8, 12, 5, 38, 5, 38, 5, 11, 7, 5, 6, 21, 6, 10, 53, 8, 7, 24, 10, 27, 44, 253, 253, 253, 252, 252, 252, 13, 12, 45, 12, 45, 12, 61, 12, 45, 44, 173,
]);
const LENGTHS = codes([2, 35, 36, 53, 38, 23]);
const DISTANCES = codes([2, 20, 53, 230, 247, 151, 248]);
const LENGTH_BASE = [3, 2, 4, 5, 6, 7, 8, 9, 10, 12, 16, 24, 40, 72, 136, 264];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8];

/** The stream for these literals and matches, ended with the end code. */
export function implodeTokens(tokens: ImplodeToken[], coded: 0 | 1 = 1, dict: 4 | 5 | 6 = 6): Uint8Array {
    const out: number[] = [coded, dict];
    let buffer = 0;
    let count = 0;
    const put = (value: number, n: number) => {
        for (let i = 0; i < n; i++) {
            buffer |= ((value >> i) & 1) << count++;
            if (count === 8) {
                out.push(buffer);
                buffer = count = 0;
            }
        }
    };
    // Huffman codes go first bit first, inverted.
    const putCode = (c: { code: number; len: number }) => {
        for (let i = c.len - 1; i >= 0; i--) put(((c.code >> i) & 1) ^ 1, 1);
    };
    const putLength = (len: number) => {
        const s = LENGTH_BASE.findIndex((base, i) => len >= base && len < base + (1 << LENGTH_EXTRA[i]));
        putCode(LENGTHS[s]);
        put(len - LENGTH_BASE[s], LENGTH_EXTRA[s]);
    };
    for (const t of tokens) {
        if (typeof t === 'number') {
            put(0, 1);
            if (coded) putCode(LITERALS[t]);
            else put(t, 8);
        } else {
            put(1, 1);
            putLength(t.len);
            const low = t.len === 2 ? 2 : dict;
            putCode(DISTANCES[(t.dist - 1) >> low]);
            put((t.dist - 1) & ((1 << low) - 1), low);
        }
    }
    put(1, 1);
    putLength(519);
    if (count) out.push(buffer);
    return Uint8Array.from(out);
}

/** Implodes `data`: the longest match within reach at each byte (2 bytes at most 256 back, longer ones 64 << dict), else a literal. */
export function implode(data: Uint8Array, coded: 0 | 1 = 1, dict: 4 | 5 | 6 = 6): Uint8Array {
    const tokens: ImplodeToken[] = [];
    for (let i = 0; i < data.length;) {
        let best = { len: 0, dist: 0 };
        for (let dist = 1; dist <= Math.min(i, 64 << dict); dist++) {
            let len = 0;
            while (len < 518 && i + len < data.length && data[i + len] === data[i + len - dist]) len++;
            if (len === 2 && dist > 256) continue;
            if (len > best.len) best = { len, dist };
        }
        if (best.len >= 2) {
            tokens.push(best);
            i += best.len;
        } else tokens.push(data[i++]);
    }
    return implodeTokens(tokens, coded, dict);
}
