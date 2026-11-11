/** Encoders for the tests: what Westwood's tools would have written, to check the decoders against. */

/** Standard LZW, as Westwood's decoder reads it: 256 + n is what code n made plus the first byte of code n + 1. */
export function lzw(data: Uint8Array, bits: 12 | 14): Uint8Array {
    const end = (1 << bits) - 1;
    const dict = new Map<string, number>();
    const codes: number[] = [];
    let next = 256;
    let w = '';
    for (const byte of data) {
        const c = String.fromCharCode(byte);
        if (w === '' || dict.has(w + c)) {
            w += c;
            continue;
        }
        codes.push(w.length === 1 ? w.charCodeAt(0) : dict.get(w)!);
        if (next < end) dict.set(w + c, next++);
        w = c;
    }
    codes.push(w.length === 1 ? w.charCodeAt(0) : dict.get(w)!, end);
    // High bits first, then zeros to a whole byte.
    const out: number[] = [];
    let acc = 0;
    let n = 0;
    for (const code of codes) {
        acc = (acc << bits) | code;
        n += bits;
        while (n >= 8) {
            out.push((acc >> (n - 8)) & 0xff);
            n -= 8;
        }
        acc &= (1 << n) - 1;
    }
    if (n) out.push((acc << (8 - n)) & 0xff);
    return Uint8Array.from(out);
}

/** Westwood RLE: runs as long repeats (big-endian counts, or little), the rest as copies of up to 127. */
export function rle(p: Uint8Array, littleEndian = false): number[] {
    const out: number[] = [];
    for (let i = 0; i < p.length;) {
        let run = 1;
        while (i + run < p.length && p[i + run] === p[i] && run < 0xffff) run++;
        if (run > 3) {
            out.push(0, ...(littleEndian ? [run & 0xff, run >> 8] : [run >> 8, run & 0xff]), p[i]);
            i += run;
        } else {
            const n = Math.min(127, p.length - i);
            out.push(n, ...p.subarray(i, i + n));
            i += n;
        }
    }
    return out;
}

/** LCW at its plainest: the bytes as literal copies of up to 63, then the end marker (0x80). */
export function lcwLiterals(p: Uint8Array): number[] {
    const out: number[] = [];
    for (let i = 0; i < p.length; i += 63) {
        const n = Math.min(63, p.length - i);
        out.push(0x80 | n, ...p.subarray(i, i + n));
    }
    out.push(0x80);
    return out;
}

/** Dune II's text compression (dune2-text.ts): each pair of letters that has a code becomes that one byte (0x80 and up). */
export function dune2Compress(text: string): number[] {
    const FIRST = ' etainosrlhcdupm';
    const SECOND = [
        'tasio wb',
        ' rnsdalm',
        'h ieoras',
        'nrtlc sy',
        'nstcloer',
        ' dtgesio',
        'nr ufmsw',
        ' tep.ica',
        'e oiadur',
        ' laeiyod',
        'eia otru',
        'etoakhlr',
        ' eiu,.oa',
        'nsrctlai',
        'leoiratp',
        'eaoip bm',
    ];
    const out: number[] = [];
    for (let i = 0; i < text.length; i++) {
        const a = FIRST.indexOf(text[i]);
        const b = a >= 0 && i + 1 < text.length ? SECOND[a].indexOf(text[i + 1]) : -1;
        if (b >= 0) {
            out.push(0x80 | (a << 3) | b);
            i++;
        } else out.push(text.charCodeAt(i));
    }
    return out;
}
