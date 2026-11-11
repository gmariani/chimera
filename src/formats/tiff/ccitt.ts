/**
 * CCITT fax compression for bilevel pictures (TIFF 6.0 sections 10 and 11,
 * after ITU T.4 and T.6). Rows are runs of white and black pixels, coded
 * with Huffman codes (one dimension), or as how each change of color sits
 * against the row above (two dimensions).
 *
 * - Compression 2, Modified Huffman: every row in one dimension, each starting
 *   on a byte.
 * - Compression 3, T.4 (Group 3): rows start with an end-of-line code; with
 *   T4Options bit 0, a bit after it says whether the row is 1D or 2D.
 * - Compression 4, T.6 (Group 4): every row in two dimensions, the first
 *   against an all-white row.
 *
 * Returns the rows packed 1 bit per pixel, 1 for black, each row starting on a byte.
 */

/** T.4 Table 1 (terminating codes, runs 0 to 63) and Table 2 (make-up codes, 64 to 1728), white then black. */
const WHITE_TERMINATING =
    '00110101 000111 0111 1000 1011 1100 1110 1111 10011 10100 00111 01000 001000 000011 110100 110101 101010 101011 0100111 0001100 0001000 0010111 0000011 0000100 0101000 0101011 0010011 0100100 0011000 00000010 00000011 00011010 00011011 00010010 00010011 00010100 00010101 00010110 00010111 00101000 00101001 00101010 00101011 00101100 00101101 00000100 00000101 00001010 00001011 01010010 01010011 01010100 01010101 00100100 00100101 01011000 01011001 01011010 01011011 01001010 01001011 00110010 00110011 00110100';
const WHITE_MAKEUP =
    '11011 10010 010111 0110111 00110110 00110111 01100100 01100101 01101000 01100111 011001100 011001101 011010010 011010011 011010100 011010101 011010110 011010111 011011000 011011001 011011010 011011011 010011000 010011001 010011010 011000 010011011';
const BLACK_TERMINATING =
    '0000110111 010 11 10 011 0011 0010 00011 000101 000100 0000100 0000101 0000111 00000100 00000111 000011000 0000010111 0000011000 0000001000 00001100111 00001101000 00001101100 00000110111 00000101000 00000010111 00000011000 000011001010 000011001011 000011001100 000011001101 000001101000 000001101001 000001101010 000001101011 000011010010 000011010011 000011010100 000011010101 000011010110 000011010111 000001101100 000001101101 000011011010 000011011011 000001010100 000001010101 000001010110 000001010111 000001100100 000001100101 000001010010 000001010011 000000100100 000000110111 000000111000 000000100111 000000101000 000001011000 000001011001 000000101011 000000101100 000001011010 000001100110 000001100111';
const BLACK_MAKEUP =
    '0000001111 000011001000 000011001001 000001011011 000000110011 000000110100 000000110101 0000001101100 0000001101101 0000001001010 0000001001011 0000001001100 0000001001101 0000001110010 0000001110011 0000001110100 0000001110101 0000001110110 0000001110111 0000001010010 0000001010011 0000001010100 0000001010101 0000001011010 0000001011011 0000001100100 0000001100101';
/** Make-up codes for runs of 1792 to 2560, the same for both colors. */
const EXTENDED_MAKEUP = '00000001000 00000001100 00000001101 000000010010 000000010011 000000010100 000000010101 000000010110 000000010111 000000011100 000000011101 000000011110 000000011111';

/** A code table: (length << 16 | code) to its run. */
function runTable(terminating: string, makeup: string): Map<number, number> {
    const table = new Map<number, number>();
    const add = (codes: string, run: (i: number) => number) => codes.split(' ').forEach((c, i) => table.set((c.length << 16) | parseInt(c, 2), run(i)));
    add(terminating, (i) => i);
    add(makeup, (i) => (i + 1) * 64);
    add(EXTENDED_MAKEUP, (i) => 1792 + i * 64);
    return table;
}

const WHITE = runTable(WHITE_TERMINATING, WHITE_MAKEUP);
const BLACK = runTable(BLACK_TERMINATING, BLACK_MAKEUP);

/** The two-dimensional modes (T.4 Table 4): pass, horizontal, and vertical by −3 to 3. */
const PASS = -100;
const HORIZONTAL = -101;
const MODES = new Map<number, number>([
    [(4 << 16) | 0b0001, PASS],
    [(3 << 16) | 0b001, HORIZONTAL],
    [(1 << 16) | 0b1, 0],
    [(3 << 16) | 0b011, 1],
    [(6 << 16) | 0b000011, 2],
    [(7 << 16) | 0b0000011, 3],
    [(3 << 16) | 0b010, -1],
    [(6 << 16) | 0b000010, -2],
    [(7 << 16) | 0b0000010, -3],
]);

export function decodeCcitt(compression: 2 | 3 | 4, data: Uint8Array, width: number, rows: number, options: number): Uint8Array {
    const rowBytes = Math.ceil(width / 8);
    const out = new Uint8Array(rowBytes * rows);
    let pos = 0;
    const totalBits = data.length * 8;
    const peek = (n: number) => {
        let v = 0;
        for (let i = 0; i < n; i++) {
            const at = pos + i;
            v = (v << 1) | (at < totalBits ? (data[at >> 3] >> (7 - (at & 7))) & 1 : 0);
        }
        return v;
    };
    const take = (n: number) => {
        const v = peek(n);
        pos += n;
        return v;
    };
    /** The next code in a table, read a bit at a time. */
    const code = (table: Map<number, number>, longest: number, what: string): number => {
        let v = 0;
        for (let length = 1; length <= longest; length++) {
            v = (v << 1) | take(1);
            const found = table.get((length << 16) | v);
            if (found !== undefined) return found;
        }
        throw new Error(`Bad ${what} code in the fax data, at bit ${pos}.`);
    };
    /** A run of one color: make-up codes, then a terminating one. */
    const run = (black: boolean): number => {
        let total = 0;
        for (;;) {
            const r = code(black ? BLACK : WHITE, 13, black ? 'black run' : 'white run');
            total += r;
            if (r < 64) return total;
        }
    };
    /** An end-of-line code (eleven 0s and a 1, after any fill 0s), if one is next. */
    const endOfLine = () => {
        if (peek(12) === 1) return void (pos += 12);
        if (peek(12) !== 0) return;
        while (pos < totalBits && peek(1) === 0) pos++;
        pos++;
    };

    // Each row as the places its color changes, white first: a black run from changes[0] to changes[1], and so on.
    let reference: number[] = [width, width];
    const twoD = compression === 4 || (compression === 3 && (options & 1) === 1);

    for (let y = 0; y < rows; y++) {
        let changes: number[] = [];
        let oneD = !twoD;
        if (compression === 2) pos = Math.ceil(pos / 8) * 8;
        if (compression === 3) {
            endOfLine();
            if (twoD) oneD = take(1) === 1;
        }
        if (pos >= totalBits) break;

        if (oneD) {
            for (let x = 0, black = false; x < width; black = !black) {
                x += run(black);
                changes.push(Math.min(x, width));
            }
        } else {
            let a0 = -1;
            let black = false;
            while (a0 < width) {
                // b1: the first change on the row above past a0 to the color a0 isn't; b2, the one after it.
                let i = 0;
                while (i < reference.length && (reference[i] <= a0 || (i & 1) !== (black ? 1 : 0))) i++;
                const b1 = reference[i] ?? width;
                const b2 = reference[i + 1] ?? width;
                const mode = code(MODES, 7, '2D mode');
                if (mode === PASS) {
                    a0 = b2;
                } else if (mode === HORIZONTAL) {
                    const start = Math.max(a0, 0);
                    const a1 = start + run(black);
                    const a2 = a1 + run(!black);
                    changes.push(Math.min(a1, width), Math.min(a2, width));
                    a0 = a2;
                } else {
                    const a1 = b1 + mode;
                    changes.push(Math.min(Math.max(a1, 0), width));
                    a0 = a1;
                    black = !black;
                }
            }
        }

        // Paint the black runs.
        const row = y * rowBytes;
        for (let k = 0; k + 1 < changes.length + 1; k += 2) {
            const from = changes[k] ?? width;
            const to = Math.min(changes[k + 1] ?? width, width);
            for (let x = from; x < to; x++) out[row + (x >> 3)] |= 0x80 >> (x & 7);
        }
        reference = [...changes, width, width];
    }
    return out;
}
