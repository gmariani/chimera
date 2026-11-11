import { Bytes, bytesLabel, field } from '../../core/bytes';
import type { Field, FormatParser } from '../../core/types';
import { type DecodeInfo, westwoodLzw, westwoodRle } from './compression';
import { CMP_TYPES } from './sniff';

/**
 * The CMP pictures that came before CPS (A Nightmare on Elm Street,
 * DragonStrike): always 320 × 200, never a palette. A file size, a type byte
 * that gives the depth and compression, the decoded size for the LZW types,
 * then the picture. 4-bit pictures pack two pixels a byte (the left one in the
 * high half, as the EGA's packed modes do); type 2 stores them a column of
 * bytes at a time, top to bottom, which is turned back into rows here.
 * (Lands of Lore's .cmp sprites are something else: CPS-style packed files.)
 * See https://moddingwiki.shikadi.net/wiki/Westwood_CMP_Format.
 */

const WIDTH = 320;
const HEIGHT = 200;

/** The EGA's 16 default colors, as 8-bit RGB (the rest of the 256 black). */
const EGA = [
    [0, 0, 0],
    [0, 0, 170],
    [0, 170, 0],
    [0, 170, 170],
    [170, 0, 0],
    [170, 0, 170],
    [170, 85, 0],
    [170, 170, 170],
    [85, 85, 85],
    [85, 85, 255],
    [85, 255, 85],
    [85, 255, 255],
    [255, 85, 85],
    [255, 85, 255],
    [255, 255, 85],
    [255, 255, 255],
];
function egaPalette(): Uint8Array {
    const out = new Uint8Array(768);
    EGA.forEach((c, i) => out.set(c, i * 3));
    return out;
}

const METHOD = { rle: 'RLE', lzw12: 'LZW, 12-bit', lzw14: 'LZW, 14-bit' } as const;

const parser: FormatParser = {
    parse(data) {
        if (data.length < 4) throw new Error(`A CMP header is at least 3 bytes, then the picture; this is ${bytesLabel(data.length)}.`);
        const b = new Bytes(data);
        const fileSize = b.u16(0);
        const typeByte = data[2];
        const warnings: string[] = [];
        // DragonStrike loads any type it doesn't know as type 4; 5 is the only gap in the list, and the only one taken that way here.
        let type = CMP_TYPES[typeByte];
        if (!type && typeByte === 5) {
            type = CMP_TYPES[4];
            warnings.push("Type 5 isn't known to be used; DragonStrike reads any type it doesn't know as type 4 (8-bit RLE), so it's read that way here.");
        }
        if (!type) throw new Error(`Type ${typeByte} isn't one CMP pictures use (1 to 4, and 6, are).`);
        if (data.length < type.header + 1) throw new Error('The file ends inside its header.');

        const okSize = fileSize + 2 === data.length || (typeByte === 4 && fileSize + 3 === data.length);
        if (!okSize) warnings.push(`The header says the file is ${bytesLabel(fileSize + 2)}, but it's ${bytesLabel(data.length)}.`);
        const stated = type.header === 5 ? b.u16(3) : null;
        if (stated !== null && stated !== 64000) warnings.push(`The decoded size is ${bytesLabel(stated)}; CMP pictures are always 64,000 bytes. 64,000 are read.`);

        // A byte a pixel, or two pixels a byte.
        const size = type.bits === 8 ? WIDTH * HEIGHT : (WIDTH * HEIGHT) / 2;
        const decoded = new Uint8Array(size);
        const info: DecodeInfo = { read: data.length, ended: true, badRefs: 0 };
        const written =
            type.method === 'rle' ? westwoodRle(data, decoded, type.littleEndian === true, type.header, info) : westwoodLzw(data, decoded, type.method === 'lzw12' ? 12 : 14, type.header, info);
        const method = METHOD[type.method];
        if (written < size) warnings.push(`The picture data decodes to ${bytesLabel(written)}, short of the ${bytesLabel(size)} a ${type.bits}-bit 320 × 200 picture takes; the rest is left black.`);
        if (info.badRefs)
            warnings.push(
                `The ${method} data copies from outside what it's decoded so far ${info.badRefs.toLocaleString('en-US')} time${info.badRefs === 1 ? '' : 's'}: it's damaged, or made to trip up a decoder.`
            );
        if (type.method !== 'rle' && !info.ended)
            warnings.push(written >= size ? `The ${method} data goes on past the end of the picture without its end marker.` : `The ${method} data has no end marker.`);
        // LZW pads to whole bytes with zeros, up to two of them; type 4's size leaves out one more byte.
        let end = info.read;
        if (type.method !== 'rle') while (end < data.length && end < info.read + 2 && data[end] === 0) end++;
        if (typeByte === 4 && end === data.length - 1 && fileSize + 3 === data.length) end++;

        // Back to rows, a byte a pixel.
        const pixels = new Uint8Array(WIDTH * HEIGHT);
        if (type.bits === 8) pixels.set(decoded);
        else {
            const across = WIDTH / 2;
            for (let k = 0; k < size; k++) {
                // Type 2 went down each column of bytes (two pixels wide) before the next.
                const at = type.down ? (k % HEIGHT) * across + Math.floor(k / HEIGHT) : k;
                pixels[at * 2] = decoded[k] >> 4;
                pixels[at * 2 + 1] = decoded[k] & 15;
            }
        }

        const headerFields: Field[] = [
            field('File size', 0, 2, bytesLabel(fileSize), typeByte === 4 ? 'Not counting these two bytes (and, for type 4, often one more).' : 'Not counting these two bytes.'),
            field('Type', 2, 1, typeByte, `${type.bits}-bit, ${method}${type.down ? ', down each column' : ''}. 1, 2: 4-bit RLE (across, down); 3: 8-bit LZW-12; 4: 8-bit RLE; 6: 8-bit LZW-14.`),
        ];
        if (stated !== null) headerFields.push(field('Decoded size', 3, 2, bytesLabel(stated), 'Always 64,000.'));

        return {
            title: 'Picture (CMP)',
            summary: [
                ['Size', '320 × 200'],
                ['Colors', type.bits === 4 ? '16 (EGA)' : '256 (the game palette)'],
                ['Compression', `${method}${type.down ? ', down each column' : ''}`],
            ],
            fields: [
                { name: 'Header', offset: 0, length: type.header, children: headerFields },
                field('Picture data', type.header, end - type.header, bytesLabel(end - type.header), `${method}, to ${bytesLabel(written)}.`),
            ],
            preview: { kind: 'images', frames: [{ width: WIDTH, height: HEIGHT, pixels }], palette: type.bits === 4 ? egaPalette() : undefined },
            end,
            warnings,
        };
    },
};

export default parser;
