import { checkBytes, MAX_BYTES } from './limits';

/**
 * Inflate (RFC 1951), for Deflate-compressed data: zlib streams (RFC 1950,
 * with their 2-byte header) or raw. Synchronous, unlike the browser's
 * DecompressionStream, so a parser can use it.
 */

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
/** The order code-length code lengths come in. */
const CODE_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** A canonical Huffman code: how many codes of each length, and the symbols in code order. */
interface Huffman {
    counts: Uint16Array;
    symbols: Uint16Array;
}

function huffman(lengths: ArrayLike<number>): Huffman {
    const counts = new Uint16Array(16);
    for (let i = 0; i < lengths.length; i++) counts[lengths[i]]++;
    counts[0] = 0;
    const offsets = new Uint16Array(16);
    for (let i = 1; i < 16; i++) offsets[i] = offsets[i - 1] + counts[i - 1];
    const symbols = new Uint16Array(lengths.length);
    for (let i = 0; i < lengths.length; i++) if (lengths[i]) symbols[offsets[lengths[i]]++] = i;
    return { counts, symbols };
}

const FIXED_LITERALS = huffman(Array.from({ length: 288 }, (_, i) => (i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8)));
const FIXED_DISTANCES = huffman(new Array(30).fill(5));

/**
 * `expected` is how big the output should be (a header's say-so, to size the
 * buffer once); `limit` is the most it may grow to before it's refused, since
 * a small stream can claim, or inflate to, gigabytes.
 */
export function inflate(input: Uint8Array, expected = 0, limit = MAX_BYTES): Uint8Array {
    // A zlib header: CM 8 (deflate) and a check that makes the first two bytes a multiple of 31.
    let pos = (input[0] & 0x0f) === 8 && ((input[0] << 8) | input[1]) % 31 === 0 ? 2 : 0;
    let bitBuffer = 0;
    let bitCount = 0;
    // Deflate can't do better than about 1032 to 1, so a bigger claim is wrong; it's only a hint.
    const hint = Math.min(expected, input.length * 1032 + 1024, limit);
    let out = new Uint8Array(Math.max(hint, Math.min(input.length * 4, limit), 1024));
    let size = 0;

    const bits = (n: number): number => {
        while (bitCount < n) {
            if (pos >= input.length) throw new Error('The compressed data ends early.');
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
        for (let len = 1; len < 16; len++) {
            code |= bits(1);
            const count = h.counts[len];
            if (code - first < count) return h.symbols[index + code - first];
            index += count;
            first = (first + count) << 1;
            code <<= 1;
        }
        throw new Error('Bad Huffman code in the compressed data.');
    };
    const room = (n: number) => {
        if (size + n <= out.length) return;
        checkBytes(size + n, 'The uncompressed data', limit);
        const grown = new Uint8Array(Math.min(Math.max(out.length * 2, size + n), limit));
        grown.set(out.subarray(0, size));
        out = grown;
    };

    for (let last = 0; !last;) {
        last = bits(1);
        const type = bits(2);
        if (type === 0) {
            bitBuffer = bitCount = 0;
            const length = input[pos] | (input[pos + 1] << 8);
            pos += 4;
            if (pos + length > input.length) throw new Error('A stored block runs past the end.');
            room(length);
            out.set(input.subarray(pos, pos + length), size);
            size += length;
            pos += length;
            continue;
        }
        let literals = FIXED_LITERALS;
        let distances = FIXED_DISTANCES;
        if (type === 2) {
            const nLit = bits(5) + 257;
            const nDist = bits(5) + 1;
            const nCode = bits(4) + 4;
            const codeLengths = new Uint8Array(19);
            for (let i = 0; i < nCode; i++) codeLengths[CODE_ORDER[i]] = bits(3);
            const codes = huffman(codeLengths);
            const lengths = new Uint8Array(nLit + nDist);
            for (let i = 0; i < nLit + nDist;) {
                const sym = decode(codes);
                if (sym < 16) lengths[i++] = sym;
                else {
                    const [value, repeat] = sym === 16 ? [lengths[i - 1], 3 + bits(2)] : sym === 17 ? [0, 3 + bits(3)] : [0, 11 + bits(7)];
                    lengths.fill(value, i, i + repeat);
                    i += repeat;
                }
            }
            literals = huffman(lengths.subarray(0, nLit));
            distances = huffman(lengths.subarray(nLit));
        } else if (type === 3) {
            throw new Error('Bad block type in the compressed data.');
        }
        for (;;) {
            const sym = decode(literals);
            if (sym < 256) {
                room(1);
                out[size++] = sym;
            } else if (sym === 256) {
                break;
            } else {
                const length = LENGTH_BASE[sym - 257] + bits(LENGTH_EXTRA[sym - 257]);
                const d = decode(distances);
                const distance = DIST_BASE[d] + bits(DIST_EXTRA[d]);
                if (distance > size) throw new Error('A back-reference reaches before the start.');
                room(length);
                for (let i = 0; i < length; i++, size++) out[size] = out[size - distance];
            }
        }
    }
    return out.subarray(0, size);
}
