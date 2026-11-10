import { Bytes, bytesLabel, field } from '../core/bytes';
import type { FormatParser } from '../core/types';
import { pixelBuffer } from '../core/limits';

/**
 * ZSoft PCX pictures. A 128-byte header, run-length encoded rows (a byte with
 * the top two bits set is a count for the byte after it), and for 256-color
 * pictures, a 0x0C byte and 768 bytes of palette at the end. Westwood used
 * these for RA's high-resolution title and menu screens. True-color ones
 * (TS's menus and map previews) store each row as a red, a green and a blue
 * plane in turn.
 */
const parser: FormatParser = {
    parse(data) {
        const b = new Bytes(data);
        const bits = b.u8(3);
        const [x0, y0, x1, y1] = [b.u16(4), b.u16(6), b.u16(8), b.u16(10)];
        const width = x1 - x0 + 1;
        const height = y1 - y0 + 1;
        const planes = b.u8(65);
        const stride = b.u16(66);
        const warnings: string[] = [];
        if (bits !== 8 || (planes !== 1 && planes !== 3)) throw new Error(`Only 256-color and 24-bit PCX pictures are supported (this one is ${bits}-bit, ${planes} plane${planes === 1 ? '' : 's'}).`);
        const trueColor = planes === 3;

        const pixels = pixelBuffer(width, height);
        const rgba = trueColor ? pixelBuffer(width, height, 4) : null;
        const row = pixelBuffer(stride, planes);
        let s = 128;
        let short = false;
        for (let y = 0; y < height; y++) {
            if (s >= data.length) short = true;
            // Runs can carry on from one plane into the next.
            for (let x = 0; x < row.length && s < data.length; ) {
                const v = data[s++];
                if ((v & 0xc0) === 0xc0) {
                    const value = data[s++];
                    for (let n = v & 0x3f; n > 0 && x < row.length; n--) row[x++] = value;
                } else {
                    row[x++] = v;
                }
            }
            if (rgba) {
                for (let x = 0; x < width; x++) rgba.set([row[x], row[stride + x], row[stride * 2 + x], 255], (y * width + x) * 4);
            } else {
                pixels.set(row.subarray(0, width), y * width);
            }
        }
        if (short) warnings.push('The picture data ends before the last row.');
        const paletteAt = data.length - 769;
        const paletteBlock = paletteAt >= s && data[paletteAt] === 0x0c;
        const hasPalette = !trueColor && paletteBlock;
        if (!trueColor && !hasPalette) warnings.push('There\'s no palette at the end of the file.');
        // TS writes the palette marker after a 24-bit picture, with nothing after it.
        const loneMarker = trueColor && !paletteBlock && s === data.length - 1 && data[s] === 0x0c;

        return {
            title: 'Picture (PCX)',
            summary: [
                ['Size', `${width} × ${height}`],
                ['Colors', trueColor ? '24-bit' : '256'],
                ...(trueColor ? [] : [['Palette', hasPalette ? 'Included' : 'Missing'] as [string, string]]),
            ],
            fields: [
                {
                    name: 'Header',
                    offset: 0,
                    length: 128,
                    children: [
                        field('Manufacturer', 0, 1, b.u8(0), 'Always 10 (ZSoft).'),
                        field('Version', 1, 1, b.u8(1), '5 is 3.0, with a 256-color palette.'),
                        field('Encoding', 2, 1, b.u8(2), '1 = run-length.'),
                        field('Bits per pixel', 3, 1, bits),
                        field('Left', 4, 2, x0),
                        field('Top', 6, 2, y0),
                        field('Right', 8, 2, x1),
                        field('Bottom', 10, 2, y1),
                        field('Horizontal DPI', 12, 2, b.u16(12)),
                        field('Vertical DPI', 14, 2, b.u16(14)),
                        field('16-color palette', 16, 48, undefined, 'Unused in 256-color pictures.'),
                        field('Reserved', 64, 1),
                        field('Planes', 65, 1, planes),
                        field('Bytes per row', 66, 2, stride, 'Always even, so it can be wider than the picture.'),
                        field('Palette type', 68, 2, b.u16(68)),
                        field('Padding', 70, 58),
                    ],
                },
                field('Picture data', 128, s - 128, bytesLabel(s - 128), trueColor ? 'Run-length encoded, row by row; each row a red, green and blue plane.' : 'Run-length encoded, row by row.'),
                ...(paletteBlock
                    ? [{ name: trueColor ? 'Palette (unused)' : 'Palette', offset: paletteAt, length: 769, note: trueColor ? 'A 24-bit picture has no use for one, but some programs (TS\'s) write it anyway.' : undefined, children: [field('Marker', paletteAt, 1, '0x0C'), field('Colors', paletteAt + 1, 768, '256 colors, 8-bit')] }]
                    : []),
                ...(loneMarker ? [field('Palette marker', s, 1, '0x0C', 'With no palette after it; a 24-bit picture needs none.')] : []),
            ],
            preview: rgba ? { kind: 'picture', width, height, rgba } : { kind: 'images', frames: [{ width, height, pixels }], palette: hasPalette ? data.slice(paletteAt + 1) : undefined },
            warnings,
        };
    },
};

export default parser;
