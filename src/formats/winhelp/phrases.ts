import { Bytes, bytesLabel, field } from '../../core/bytes';
import type { Field } from '../../core/types';
import { unpackHelp } from './lz77';

/**
 * The phrases a help file's topic text is shortened with. Windows 3.x's |Phrases: how many, 0x0100, (after Windows
 * 3.0) their size unpacked, where each starts, then the phrases, LZ77-packed after Windows 3.0. Windows 95's Hall
 * compression: |PhrIndex (a header, then each phrase's length, bit-packed) and |PhrImage (the phrases, LZ77-packed
 * unless its sizes agree). As helpdeco's helpfile.txt describes them; helpdeco's source (GPL 2 or later) settled the
 * two-byte Hall codes (128 + the code ÷ 4 × 256 + the next byte).
 */

export interface Phrases {
    list: Uint8Array[];
    hall: boolean;
    fields: Field[];
    problems: string[];
}

/** The most phrases a table may hold: a code reaches 16,511 at most. */
const MOST = 16512;

/** |Phrases at `at` to `end`; `packed` after Windows 3.0. */
export function readPhrases(data: Uint8Array, at: number, end: number, packed: boolean): Phrases {
    const b = new Bytes(data);
    const problems: string[] = [];
    // MediaView's put 0x0800 and 30 more bytes first.
    const mvb = b.u16(at) === 0x0800 && b.u16(at + 4) === 0x0100;
    const h = mvb ? at + 2 : at;
    const count = Math.min(b.u16(h), MOST);
    const size = packed ? b.u32(h + 4) : 0;
    const offsetsAt = h + (packed ? 8 : 4) + (mvb ? 30 : 0);
    const textAt = offsetsAt + (count + 1) * 2;
    const fields: Field[] = [
        field('Phrases', h, 2, count),
        field('0x0100', h + 2, 2, `0x${b.u16(h + 2).toString(16)}`),
        ...(packed ? [field('Size unpacked', h + 4, 4, bytesLabel(size))] : []),
        field('Where each starts', offsetsAt, (count + 1) * 2, `${count + 1}`),
    ];
    if (textAt > end) return { list: [], hall: false, fields, problems: ['Its phrase table runs past the end of its file.'] };
    const text = packed ? unpackHelp(data.subarray(textAt, end), Math.min(size, 1 << 24)).data : data.subarray(textAt, end);
    fields.push(field('The phrases', textAt, end - textAt, packed ? `${bytesLabel(end - textAt)}, LZ77-packed to ${bytesLabel(text.length)}` : bytesLabel(text.length)));
    if (packed && text.length !== size) problems.push(`Its phrases unpack to ${bytesLabel(text.length)}, not the ${bytesLabel(size)} it says.`);
    // The offsets count from where they start, the first pointing just past them.
    const first = b.u16(offsetsAt);
    const list: Uint8Array[] = [];
    let bad = 0;
    for (let i = 0; i < count; i++) {
        const from = b.u16(offsetsAt + i * 2) - first;
        const to = b.u16(offsetsAt + i * 2 + 2) - first;
        if (from < 0 || to < from || to > text.length) bad++;
        list.push(text.subarray(Math.max(0, from), Math.max(from, Math.min(to, text.length))));
    }
    if (bad) problems.push(`${bad} of its phrases ${bad === 1 ? 'is' : 'are'} said to be outside the phrase text.`);
    return { list, hall: false, fields, problems };
}

/** Hall compression's |PhrIndex at `at` and |PhrImage at `image`. */
export function readHallPhrases(data: Uint8Array, at: number, end: number, image: number, imageEnd: number): Phrases {
    const b = new Bytes(data);
    const problems: string[] = [];
    const count = Math.min(b.u32(at + 4), MOST);
    const imageSize = b.u32(at + 12);
    const imagePacked = b.u32(at + 16);
    const bitCount = b.u16(at + 24) & 15;
    const fields: Field[] = [
        field('Signature', at, 4, b.u32(at)),
        field('Phrases', at + 4, 4, b.u32(at + 4)),
        field('Lengths’ size', at + 8, 4, bytesLabel(b.u32(at + 8))),
        field('Phrases’ size', at + 12, 4, bytesLabel(imageSize)),
        field('Phrases’ size packed', at + 16, 4, bytesLabel(imagePacked)),
        field('Zero', at + 20, 4, b.u32(at + 20)),
        field('Bits', at + 24, 2, bitCount, 'How the lengths are packed.'),
        field('Unknown', at + 26, 2, `0x${b.u16(at + 26).toString(16)}`),
    ];
    // Each phrase's length, its bits taken from the lowest of each 32-bit word on.
    let bit = 0;
    const bits = at + 28;
    const get = () => {
        const p = bits + (bit >> 5) * 4;
        const v = p + 4 <= end ? (b.u32(p) >>> (bit & 31)) & 1 : 0;
        bit++;
        return v;
    };
    const starts = [0];
    for (let i = 0; i < count && bits + (bit >> 5) * 4 < end; i++) {
        let n = 1;
        while (get() && n < 1 << 16) n += 1 << bitCount;
        // The first of these bits is always there, even when the count says 0.
        for (let k = 0; k < Math.max(1, bitCount); k++) if (get()) n += 1 << k;
        starts.push(starts[i] + n);
    }
    if (starts.length - 1 < count) problems.push(`Its phrase lengths run out after ${starts.length - 1} of the ${count} phrases.`);
    fields.push(field('Lengths and flags', bits, end - bits, bytesLabel(end - bits), 'Each phrase’s length, bit-packed; then a bit for each, for full-text search.'));
    const raw = data.subarray(image, imageEnd);
    const text = imagePacked !== imageSize ? unpackHelp(raw, Math.min(imageSize, 1 << 24)).data : raw;
    if (text.length < imageSize) problems.push(`Its phrases unpack to ${bytesLabel(text.length)}, not the ${bytesLabel(imageSize)} its index says.`);
    const list = starts.slice(0, -1).map((s, i) => text.subarray(Math.min(s, text.length), Math.min(starts[i + 1], text.length)));
    return { list, hall: true, fields, problems };
}

/** Topic text with its phrases put back. */
export function expandPhrases(input: Uint8Array, phrases: Phrases | null, missing: { count: number }): Uint8Array {
    if (!phrases) return input;
    const out: number[] = [];
    const put = (n: number, space = false) => {
        const phrase = phrases.list[n];
        if (!phrase) missing.count++;
        else for (const v of phrase) out.push(v);
        if (space) out.push(0x20);
    };
    for (let i = 0; i < input.length; i++) {
        const c = input[i];
        if (!phrases.hall) {
            // 1 to 15 and the next byte: a phrase, and a space after it when the number is odd.
            if (c === 0 || c > 15 || i + 1 >= input.length) out.push(c);
            else {
                const n = c * 256 - 256 + input[++i];
                put(n >> 1, !!(n & 1));
            }
        } else if (!(c & 1)) put(c >> 1);
        else if ((c & 3) === 1) put(128 + (c >> 2) * 256 + (input[++i] ?? 0));
        else if ((c & 7) === 3) for (let k = (c >> 3) + 1; k > 0 && i + 1 < input.length; k--) out.push(input[++i]);
        else if ((c & 15) === 7) for (let k = (c >> 4) + 1; k > 0; k--) out.push(0x20);
        else for (let k = (c >> 4) + 1; k > 0; k--) out.push(0);
    }
    return Uint8Array.from(out);
}
