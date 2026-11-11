import { Bytes, bytesLabel, field } from '../../core/bytes';
import { checkBytes } from '../../core/limits';
import type { Field, FormatParser, IndexedImage, Preview } from '../../core/types';
import { type DecodeInfo, lcw, westwoodLzw, westwoodRle } from './compression';
import { detect, extensionOf } from '../index';
import { cpsKind } from './sniff';
import { expandPalette } from './vga';

/**
 * Full-screen 320 × 200 pictures (title screens, backgrounds), 1991–1996: Eye
 * of the Beholder, Dune II, Kyrandia, Lands of Lore, C&C, Red Alert. A 10-byte
 * header, the palette, then the picture, compressed one of five ways. On the
 * PC the picture is a byte a pixel and the palette 256 6-bit colors; on the
 * Amiga it's five bit planes and up to four 32-color palettes.
 * See https://moddingwiki.shikadi.net/wiki/Westwood_CPS_Format.
 */

export const CPS_COMPRESSION = ['None', 'LZW, 12-bit', 'LZW, 14-bit', 'RLE', 'LCW'] as const;
const PC_SIZE = 64000;
const PLANE = 8000;

/** Five bit planes of 8,000 bytes to a byte a pixel: bit 7 is the leftmost pixel, plane n gives bit n. */
function unplanar(planes: Uint8Array): Uint8Array {
    const out = new Uint8Array(PC_SIZE);
    for (let i = 0; i < PC_SIZE; i++) {
        const at = i >> 3;
        const shift = 7 - (i & 7);
        let v = 0;
        for (let p = 0; p < 5; p++) v |= ((planes[p * PLANE + at] >> shift) & 1) << p;
        out[i] = v;
    }
    return out;
}

/** An Amiga palette: 32 big-endian 0RGB colors, 4 bits each, to 256 8-bit RGB (the rest black). */
function amigaPalette(src: Uint8Array): Uint8Array {
    const out = new Uint8Array(768);
    for (let i = 0; i < 32 && i * 2 + 1 < src.length; i++) {
        const v = (src[i * 2] << 8) | src[i * 2 + 1];
        out[i * 3] = ((v >> 8) & 15) * 17;
        out[i * 3 + 1] = ((v >> 4) & 15) * 17;
        out[i * 3 + 2] = (v & 15) * 17;
    }
    return out;
}

const parser: FormatParser = {
    parse(data, context) {
        if (data.length <= 10) throw new Error(`A CPS header is 10 bytes, and this is ${bytesLabel(data.length)}.`);
        const b = new Bytes(data);
        const fileSize = b.u16(0);
        const compression = b.u16(2);
        const size = b.u32(4);
        const paletteSize = b.u16(8);
        if (compression > 4) throw new Error(`Compression ${compression} isn't one CPS files use (0 to 4 are).`);
        if (10 + paletteSize > data.length) throw new Error(`The palette is said to be ${bytesLabel(paletteSize)}, more than the file holds.`);
        const kind = cpsKind(data) ?? (size === 40000 || size === 40064 ? 'amiga' : 'pc');
        const amiga = kind === 'amiga';
        const packed = kind === 'packed';
        const warnings: string[] = [];

        // The size doesn't count its own two bytes (for the older compressions it may count them; both pass).
        if (fileSize + 2 !== data.length && !(compression >= 1 && compression <= 3 && fileSize === data.length)) {
            warnings.push(`The header says the file is ${bytesLabel(fileSize + 2)}, but it's ${bytesLabel(data.length)}.`);
        }
        const expected = amiga ? [40000, 40064] : [PC_SIZE];
        if (!packed && !expected.includes(size)) warnings.push(`The decoded size is ${bytesLabel(size)}; ${amiga ? 'Amiga' : 'PC'} pictures are ${expected.map((n) => n.toLocaleString('en-US')).join(' or ')} bytes. It's read as ${Math.floor(size / 320)} rows.`);
        if (amiga ? paletteSize % 64 !== 0 || paletteSize > 256 : paletteSize !== 0 && paletteSize !== 768) {
            warnings.push(`The palette is ${bytesLabel(paletteSize)}; ${amiga ? 'Amiga palettes are 64 bytes each, up to four' : 'PC palettes are 768 bytes, or none'}.`);
        }
        if (!packed && size < 320) throw new Error(`The decoded size (${bytesLabel(size)}) isn't even one row of 320 pixels.`);

        // Always 64,000 (or 40,000) in the games; anything much bigger is a damaged or crafted header.
        const decoded = new Uint8Array(checkBytes(size, packed ? 'The packed file' : 'The picture', 1 << 22));
        const start = 10 + paletteSize;
        const info: DecodeInfo = { read: data.length, ended: true, badRefs: 0 };
        let written: number;
        switch (compression) {
            case 0:
                written = Math.min(size, data.length - start);
                decoded.set(data.subarray(start, start + written));
                info.read = start + written;
                break;
            case 1:
            case 2:
                written = westwoodLzw(data, decoded, compression === 1 ? 12 : 14, start, info);
                break;
            case 3:
                written = westwoodRle(data, decoded, amiga, start, info);
                break;
            default:
                written = lcw(data, decoded, start, info);
        }
        const method = CPS_COMPRESSION[compression];
        if (written < size) warnings.push(`The ${packed ? 'packed' : 'picture'} data ${compression ? 'decodes' : 'comes'} to ${bytesLabel(written)}, short of the ${bytesLabel(size)} the header gives; ${packed ? 'only that much is there' : 'the rest is left black'}.`);
        if (info.badRefs) warnings.push(`The ${method} data copies from outside what it's decoded so far ${info.badRefs.toLocaleString('en-US')} time${info.badRefs === 1 ? '' : 's'}: it's damaged, or made to trip up a decoder.`);
        // LZW and LCW end on a marker; reaching the picture's size first means there was more than it holds.
        if ((compression === 1 || compression === 2 || compression === 4) && !info.ended && written >= size) warnings.push(`The ${method} data goes on past the end of the ${packed ? 'packed file' : 'picture'} (${bytesLabel(size)}) without its end marker.`);
        else if ((compression === 1 || compression === 2) && !info.ended) warnings.push(`The ${method} data has no end marker.`);
        // What follows the data. LZW pads to whole bytes, with zeros: up to two of them.
        let end = info.read;
        if (compression === 1 || compression === 2) while (end < data.length && end < info.read + 2 && data[end] === 0) end++;

        const headerFields: Field[] = [
            field('File size', 0, 2, bytesLabel(fileSize), 'Not counting these two bytes.'),
            field('Compression', 2, 2, compression, `${method}. 0: none, 1: LZW 12-bit, 2: LZW 14-bit, 3: RLE, 4: LCW.`),
            field('Decoded size', 4, 4, bytesLabel(size), packed ? 'Not a picture\'s size: a file packed this way.' : amiga ? '40,000: five bit planes of 320 × 200; 40,064 with a palette after them.' : '320 × 200, a byte a pixel.'),
            field('Palette size', 8, 2, paletteSize),
        ];

        // Not a picture: a whole file packed in a picture's wrapping (Lands of Lore's sprites). What's inside is a file of its own.
        if (packed) {
            const inner = decoded.subarray(0, written);
            const format = detect(inner, null);
            const stem = (context.name ?? 'packed').replace(/\.[^.]*$/, '');
            const name = `${stem}.${format.id === 'raw' ? 'bin' : extensionOf(format)}`;
            return {
                title: 'Packed file (CPS-style)',
                summary: [
                    ['Compression', method],
                    ['Contents', `${format.id === 'raw' ? 'Unrecognized' : format.name}, ${bytesLabel(written)}`],
                ],
                fields: [
                    { name: 'Header', offset: 0, length: 10, children: headerFields },
                    ...(paletteSize ? [field('Palette', 10, paletteSize, 'Never used: what\'s packed isn\'t a picture.')] : []),
                    field('Packed data', start, end - start, bytesLabel(end - start), `${method}, to ${bytesLabel(written)}.`),
                ],
                entries: [{ name, label: name, offset: start, size: written, data: inner, meta: { Packed: bytesLabel(end - start) } }],
                end,
                warnings,
            };
        }

        // The pictures, and their palettes.
        let pixels: Uint8Array = decoded.subarray(0, Math.floor(size / 320) * 320);
        const palettes: Uint8Array[] = [];
        if (amiga) {
            for (let at = 10; at + 64 <= start; at += 64) palettes.push(amigaPalette(data.subarray(at, at + 64)));
            // Eye of the Beholder 1 puts its palette after the picture instead, and says so with the decoded size.
            if (size === 40064) palettes.push(amigaPalette(decoded.subarray(40000)));
            pixels = unplanar(decoded);
        } else if (paletteSize >= 768) {
            palettes.push(expandPalette(data.subarray(10, 10 + 768)));
        }
        const height = pixels.length / 320;
        const frame: IndexedImage = { width: 320, height, pixels };
        // Several Amiga palettes: Eye of the Beholder II shows a quarter of the picture with each, or flashes between them (lightning).
        const preview: Preview =
            palettes.length > 1
                ? { kind: 'stack', items: palettes.map((palette, i) => ({ title: `Palette ${i + 1}`, preview: { kind: 'images', frames: [frame], palette } })) }
                : { kind: 'images', frames: [frame], palette: palettes[0] };

        const paletteFields: Field[] = amiga
            ? palettes.slice(0, paletteSize / 64).map((_, i) => field(`Palette ${i + 1}`, 10 + i * 64, 64, '32 colors, 12-bit'))
            : paletteSize ? [field('Palette', 10, paletteSize, paletteSize === 768 ? '256 colors, 6-bit' : bytesLabel(paletteSize))] : [];

        return {
            title: 'Picture (CPS)',
            summary: [
                ['Size', `320 × ${height}`],
                ['Machine', amiga ? 'Amiga (5 bit planes, 32 colors)' : 'PC'],
                ['Compression', method],
                ['Palette', palettes.length ? (palettes.length > 1 ? `${palettes.length} included` : 'Included') : 'Uses the game palette'],
            ],
            fields: [
                { name: 'Header', offset: 0, length: 10, children: headerFields },
                ...paletteFields,
                field('Picture data', start, end - start, bytesLabel(end - start), compression ? `${method}, to ${bytesLabel(written)}.` : undefined),
            ],
            preview,
            // Past the picture's data is nothing a CPS has; the usual checks look at it.
            end,
            warnings,
        };
    },
};

export default parser;
