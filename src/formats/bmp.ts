import { Bytes, bytesLabel, field } from '../core/bytes';
import type { Field, FormatParser } from '../core/types';
import { sniffBmp } from './bmp-sniff';
import { decodeDib, pixelsNote } from './dib';

/**
 * Windows bitmaps (.bmp, .dib): a 14-byte file header ("BM", the file's size, two reserved words, where the pixels
 * start), then a device-independent bitmap: its own header, the colors for 1, 4 and 8 bits a pixel, and the rows,
 * each padded to 4 bytes, the bottom row first unless the height is negative (see dib.ts). TS's and RA2's launchers
 * and Counterstrike's Windows setup use them; TS and RA2 also keep their autorun screens as 00000409.256 and .016
 * (the 256- and 16-color versions, for English, language 0x409).
 * See https://learn.microsoft.com/windows/win32/api/wingdi/ns-wingdi-bitmapfileheader.
 */

const COMPRESSION = ['none', 'run-length, 8 bits a pixel (RLE8)', 'run-length, 4 bits a pixel (RLE4)', 'bit fields', 'JPEG', 'PNG', 'bit fields with alpha'];

/** Pixels per meter as dots per inch, as programs show them. */
const dpi = (ppm: number) => `${Math.round(ppm * 0.0254)} dpi`;

const hex = (r: number, g: number, b: number) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0').toUpperCase()).join('')}`;

const parser: FormatParser = {
    parse(data) {
        if (!sniffBmp(data)) throw new Error('This isn\'t a Windows bitmap: it doesn\'t start with "BM" and a bitmap header, with its pixels inside the file.');
        const b = new Bytes(data);
        const warnings: string[] = [];
        const said = b.u32(2);
        const [reserved1, reserved2] = [b.u16(6), b.u16(8)];
        const offset = b.u32(10);
        const size = b.u32(14);
        const core = size === 12;
        const width = core ? b.u16(18) : b.i32(18);
        const height = core ? b.u16(20) : b.i32(22);
        const planes = b.u16(core ? 22 : 26);
        const bits = b.u16(core ? 24 : 28);
        const compression = core ? 0 : b.u32(30);
        const imageSize = core ? 0 : b.u32(34);
        const used = core ? 0 : b.u32(46);
        const important = core ? 0 : b.u32(50);
        const topDown = height < 0;

        if (said !== data.length) warnings.push(`The header says the file is ${bytesLabel(said)}, but it's ${bytesLabel(data.length)}.`);
        if (reserved1 || reserved2) warnings.push(`The two reserved words are ${reserved1} and ${reserved2}, not 0: something kept its own data there.`);
        if (planes !== 1) warnings.push(`It says it has ${planes} planes; a bitmap always has 1.`);

        const header: Field = {
            name: 'File header',
            offset: 0,
            length: 14,
            value: '"BM"',
            children: [
                field('Signature', 0, 2, '"BM"'),
                field('File size', 2, 4, bytesLabel(said)),
                field('Reserved', 6, 2, reserved1),
                field('Reserved', 8, 2, reserved2),
                field('Pixels at', 10, 4, offset.toLocaleString('en-US'), 'From the start of the file.'),
            ],
        };
        const heightNote = topDown ? 'Negative: the top row comes first.' : 'The bottom row comes first.';
        const info: Field = {
            name: 'Bitmap header',
            offset: 14,
            length: size,
            value: `${Math.abs(width)} × ${Math.abs(height)}, ${bits} bits a pixel`,
            children: core
                ? [
                      field('Header size', 14, 4, size, 'OS/2’s and Windows 2’s header (BITMAPCOREHEADER).'),
                      field('Width', 18, 2, width),
                      field('Height', 20, 2, height, heightNote),
                      field('Planes', 22, 2, planes),
                      field('Bits a pixel', 24, 2, bits),
                  ]
                : [
                      field(
                          'Header size',
                          14,
                          4,
                          size,
                          size === 40
                              ? 'Windows 3’s header (BITMAPINFOHEADER).'
                              : size >= 108
                                ? `Windows ${size === 108 ? '95' : '98'}’s header (BITMAPV${size === 108 ? 4 : 5}HEADER).`
                                : 'BITMAPINFOHEADER, with color masks after it.'
                      ),
                      field('Width', 18, 4, width),
                      field('Height', 22, 4, height, heightNote),
                      field('Planes', 26, 2, planes),
                      field('Bits a pixel', 28, 2, bits),
                      field('Compression', 30, 4, COMPRESSION[compression] ?? `${compression}: none Windows defines`),
                      field('Image size', 34, 4, imageSize ? bytesLabel(imageSize) : '0', imageSize ? undefined : 'Allowed when it isn’t compressed: the size follows from the width and height.'),
                      field('Horizontal resolution', 38, 4, dpi(b.i32(38)), `${b.i32(38).toLocaleString('en-US')} pixels a meter.`),
                      field('Vertical resolution', 42, 4, dpi(b.i32(42)), `${b.i32(42).toLocaleString('en-US')} pixels a meter.`),
                      field('Colors used', 46, 4, used, used ? undefined : 'All the bits a pixel allow, or none for more than 8 bits.'),
                      field('Colors important', 50, 4, important, important ? 'How many a display short of colors should keep.' : 'All of them.'),
                      ...(size > 40 ? [field('More of the header', 54, size - 40, bytesLabel(size - 40), 'Color masks, and for the later headers a color space.')] : []),
                  ],
        };
        const fields: Field[] = [header, info];

        const dib = decodeDib(data, 14, data.length - 14, false, offset - 14);
        if ('problem' in dib) {
            // Not drawn: what the header says the pixels take, or the rest of the file.
            warnings.push(`The picture can't be drawn: ${dib.problem}.`);
            const end = imageSize && offset + imageSize <= data.length ? offset + imageSize : data.length;
            if (offset > 14 + size) fields.push(field('Colors and the rest', 14 + size, offset - 14 - size, bytesLabel(offset - 14 - size)));
            fields.push(field('Pixels', offset, end - offset, bytesLabel(end - offset)));
            return {
                title: 'Picture (BMP)',
                summary: [
                    ['Size', `${Math.abs(width)} × ${Math.abs(height)}`],
                    ['Colors', `${bits} bits a pixel`],
                ],
                fields,
                end,
                warnings,
            };
        }

        const d = dib.info;
        const entry = core ? 3 : 4;
        const colorsAt = 14 + d.colorsAt;
        if (d.colors)
            fields.push({
                name: 'Colors',
                offset: colorsAt,
                length: d.colors * entry,
                value: `${d.colors}`,
                note: core ? 'Blue, green, red.' : 'Blue, green, red, and a byte left as 0.',
                children: Array.from({ length: d.colors }, (_, i) => {
                    const c = colorsAt + i * entry;
                    return field(`Color ${i}`, c, entry, hex(data[c + 2], data[c + 1], data[c]));
                }),
            });
        const colorsEnd = colorsAt + d.colors * entry;
        if (offset > colorsEnd) {
            const gap = data.subarray(colorsEnd, offset);
            const zeros = gap.every((v) => v === 0);
            fields.push(field(zeros ? 'Padding' : 'Not pointed to', colorsEnd, gap.length, bytesLabel(gap.length)));
            if (!zeros) warnings.push(`${bytesLabel(gap.length)} between the colors and the pixels aren't part of the picture.`);
        }
        const stride = ((d.width * bits + 31) >> 5) * 4;
        const pixelsEnd = 14 + d.length;
        fields.push(field('Pixels', offset, pixelsEnd - offset, `${d.width} × ${d.height}`, pixelsNote(d, topDown)));
        warnings.push(...d.problems);
        if (important > d.colors && d.colors) warnings.push(`It says ${important} colors are important, but it has only ${d.colors}.`);
        if (d.beyond)
            warnings.push(
                `${d.beyond.toLocaleString('en-US')} pixel${d.beyond === 1 ? ' uses a color' : 's use colors'} past the ${d.colors} in its table; ${d.beyond === 1 ? 'it’s' : 'they’re'} drawn black here, and other programs may draw them differently.`
            );

        // Paint and other Windows programs of the time pad the file to a multiple of 4 with zeros after the pixels, and
        // count the padding in the file size: TS's and RA2's launcher and autorun bitmaps have 2 bytes of it.
        // Some count it in the pixels' size in the header too: the 24-bit bitmaps in the Remastered Collection's launcher, in
        // C&C 3's and RA3's, and in FinalSun and FinalAlert 2 say their pixels take the 2 bytes more that they're padded with.
        let end = pixelsEnd;
        const after = data.subarray(pixelsEnd);
        const padded = after.length > 0 && after.length < 4 && after.every((v) => v === 0) && data.length % 4 === 0;
        if (padded) {
            fields.push(field('Padding', pixelsEnd, after.length, bytesLabel(after.length), 'Zeros to round the file up to a multiple of 4 bytes, which some programs write.'));
            end = data.length;
        }
        if (!d.compression && imageSize && imageSize !== stride * d.height && !(padded && imageSize === stride * d.height + after.length))
            warnings.push(`The header says the pixels take ${bytesLabel(imageSize)}, but ${d.width} × ${d.height} at ${bits} bits a pixel takes ${bytesLabel(stride * d.height)}.`);

        const colors = `${bits <= 8 ? `${d.colors} (${bits} bit${bits === 1 ? '' : 's'} a pixel)` : `${bits}-bit`}${d.compression ? `, run-length compressed` : ''}`;
        return {
            title: 'Picture (BMP)',
            summary: [
                ['Size', `${d.width} × ${d.height}`],
                ['Colors', colors],
                ...(core ? [] : [['Resolution', b.i32(38) === b.i32(42) ? dpi(b.i32(38)) : `${dpi(b.i32(38))} across, ${dpi(b.i32(42))} down`] as [string, string]]),
            ],
            fields,
            preview: { kind: 'picture', width: d.width, height: d.height, rgba: dib.rgba },
            end,
            warnings,
        };
    },
};

export default parser;
