import { checkBytes, MAX_BYTES } from './limits';

/**
 * PKWARE's Data Compression Library "implode" (1987), undone: what InstallShield 3 packs its archives' files with, and
 * many DOS-era installers besides. Two header bytes (0 when literals are stored as plain bytes, 1 when they're coded;
 * then 4, 5 or 6, the low bits of a distance stored as they are), then, read from the low bit up, a 0 bit and a literal,
 * or a 1 bit, a length and a distance back into what's been written so far. Length 519 ends the data. The codes are
 * fixed Huffman codes, sent with their bits inverted.
 *
 * Ported from Mark Adler's blast.c (zlib's contrib/blast, version 1.3, https://github.com/madler/zlib/tree/develop/
 * contrib/blast). This is an altered version, not the original: blast.c translated to TypeScript, with checks of
 * Chimera's own added (sizes against what's expected, a limit on what it may write), and one change: it writes into
 * the whole output, not a 4 KB window, which comes to the same, since a distance blast takes never reaches before
 * what's been written. blast.c's notice, from blast.h:
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

const MAXBITS = 13;

/** A canonical Huffman code: how many codes of each length, and the symbols in code order. */
interface Huffman {
    counts: Uint16Array;
    symbols: Uint16Array;
}

/** Builds a code from blast's run-length lengths: each byte, a length in its low 4 bits and how many symbols, less one, in its high 4. */
function construct(rep: number[]): Huffman {
    const lengths: number[] = [];
    for (const r of rep) for (let n = (r >> 4) + 1; n > 0; n--) lengths.push(r & 15);
    const counts = new Uint16Array(MAXBITS + 1);
    for (const l of lengths) counts[l]++;
    const offsets = new Uint16Array(MAXBITS + 2);
    for (let l = 1; l <= MAXBITS; l++) offsets[l + 1] = offsets[l] + counts[l];
    const symbols = new Uint16Array(lengths.length);
    lengths.forEach((l, s) => {
        if (l) symbols[offsets[l]++] = s;
    });
    return { counts, symbols };
}

/** blast.c's code lengths, as they are there, run-length coded as construct() reads them. */
const IMPLODE_CODES = {
    literals: [
        11, 124, 8, 7, 28, 7, 188, 13, 76, 4, 10, 8, 12, 10, 12, 10, 8, 23, 8, 9, 7, 6, 7, 8, 7, 6, 55, 8, 23, 24, 12, 11, 7, 9, 11, 12, 6, 7, 22, 5, 7, 24, 6, 11, 9, 6, 7, 22, 7, 11, 38, 7, 9, 8, 25,
        11, 8, 11, 9, 12, 8, 12, 5, 38, 5, 38, 5, 11, 7, 5, 6, 21, 6, 10, 53, 8, 7, 24, 10, 27, 44, 253, 253, 253, 252, 252, 252, 13, 12, 45, 12, 45, 12, 61, 12, 45, 44, 173,
    ],
    lengths: [2, 35, 36, 53, 38, 23],
    distances: [2, 20, 53, 230, 247, 151, 248],
};
const LITERALS = construct(IMPLODE_CODES.literals);
const LENGTHS = construct(IMPLODE_CODES.lengths);
const DISTANCES = construct(IMPLODE_CODES.distances);
const LENGTH_BASE = [3, 2, 4, 5, 6, 7, 8, 9, 10, 12, 16, 24, 40, 72, 136, 264];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8];
/** The length that ends the data. */
const END = 519;

export interface Exploded {
    data: Uint8Array;
    /** How many bytes of the input it took, to the end code's last bit. */
    used: number;
}

/**
 * Undoes implode. `expected` is how big the output should be (to size it once); `limit` is the most it may grow to
 * before it's refused. Throws, saying what's wrong, on a bad header, a distance back before the start, or input that
 * runs out before the end code.
 */
export function explode(input: Uint8Array, expected = 0, limit = MAX_BYTES): Exploded {
    if (input.length < 2) throw new Error('The compressed data is too short for its 2-byte header.');
    const coded = input[0];
    const dict = input[1];
    if (coded > 1) throw new Error(`The compressed data's first byte says how literals are stored: 0 or 1, not ${coded}.`);
    if (dict < 4 || dict > 6) throw new Error(`The compressed data's second byte, the bits of a distance stored as they are, is ${dict}, not 4, 5 or 6.`);

    let pos = 2;
    let bitBuffer = 0;
    let bitCount = 0;
    const bits = (n: number): number => {
        while (bitCount < n) {
            if (pos >= input.length) throw new Error('The compressed data ends before its end code.');
            bitBuffer |= input[pos++] << bitCount;
            bitCount += 8;
        }
        const v = bitBuffer & ((1 << n) - 1);
        bitBuffer >>>= n;
        bitCount -= n;
        return v;
    };
    const decode = (h: Huffman): number => {
        let code = 0;
        let first = 0;
        let index = 0;
        for (let len = 1; len <= MAXBITS; len++) {
            code |= bits(1) ^ 1;
            const count = h.counts[len];
            if (code < first + count) return h.symbols[index + code - first];
            index += count;
            first = (first + count) << 1;
            code <<= 1;
        }
        // blast's tables are complete codes, so every bit pattern is one of them.
        throw new Error('The compressed data has a code that isn’t in the table.');
    };

    // A match can be up to 518 bytes from about a dozen bits: no real stream comes near 500 to 1.
    let out = new Uint8Array(Math.max(1024, Math.min(expected || input.length * 4, input.length * 500 + 1024, limit)));
    let size = 0;
    const room = (n: number) => {
        if (size + n <= out.length) return;
        const grown = new Uint8Array(checkBytes(Math.min(Math.max(out.length * 2, size + n), Math.max(limit, size + n)), 'The unpacked data', limit));
        grown.set(out.subarray(0, size));
        out = grown;
    };

    for (;;) {
        if (bits(1)) {
            const symbol = decode(LENGTHS);
            let len = LENGTH_BASE[symbol] + bits(LENGTH_EXTRA[symbol]);
            if (len === END) break;
            const low = len === 2 ? 2 : dict;
            const dist = ((decode(DISTANCES) << low) | bits(low)) + 1;
            if (dist > size) throw new Error(`The compressed data copies from ${dist.toLocaleString('en-US')} bytes back, when only ${size.toLocaleString('en-US')} have been written.`);
            room(len);
            // Byte by byte: the copy can overlap what it's writing.
            for (; len > 0; len--, size++) out[size] = out[size - dist];
        } else {
            room(1);
            out[size++] = coded ? decode(LITERALS) : bits(8);
        }
    }
    return { data: out.subarray(0, size), used: pos };
}
