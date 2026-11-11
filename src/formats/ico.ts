import { Bytes, bytesLabel, field } from '../core/bytes';
import type { Field, FormatParser, Preview } from '../core/types';
import { decodeDib } from './dib';
import { icoLayout } from './ico-sniff';
import png from './png';

/**
 * Windows icons and cursors (.ico, .cur): one picture at several sizes and
 * color depths, for Windows to pick the best fit from. A 6-byte header (0, 1
 * for an icon or 2 for a cursor, the number of images), then for each image a
 * 16-byte entry (its width and height, 0 meaning 256; its colors; for an icon
 * its planes and bits a pixel, for a cursor where its hot spot is; its size and
 * where it is), then the images: each a bitmap (DIB) with a see-through mask,
 * or, since Windows Vista, a PNG.
 * See https://learn.microsoft.com/previous-versions/ms997538(v=msdn.10).
 */

/**
 * Whether these bytes are other bytes saved as UTF-8 text, decoding to exactly `expected` of them: every byte from 0x80 up
 * written as two (0xFF as C3 BF). Some tools that turn cursor themes into .cur files do this to the mask.
 */
function savedAsUtf8(bytes: Uint8Array, expected: number): boolean {
    let decoded = 0;
    let wide = 0;
    for (let i = 0; i < bytes.length; decoded++) {
        const v = bytes[i];
        if (v < 0x80) i++;
        else if ((v === 0xc2 || v === 0xc3) && i + 1 < bytes.length && bytes[i + 1] >= 0x80 && bytes[i + 1] < 0xc0) {
            i += 2;
            wide++;
        } else return false;
    }
    return wide > 0 && decoded === expected;
}

const parser: FormatParser = {
    parse(data) {
        const layout = icoLayout(data);
        if (!layout) throw new Error("This isn't a Windows icon or cursor: its header and entries don't point to pictures that fit the file.");
        const { type, count } = layout;
        const cursor = type === 2;
        const b = new Bytes(data);
        const warnings: string[] = [];
        const items: { title: string; preview: Preview }[] = [];
        const fields: Field[] = [
            {
                name: 'Header',
                offset: 0,
                length: 6,
                value: `${count} image${count === 1 ? '' : 's'}`,
                children: [field('Reserved', 0, 2, 0), field('Type', 2, 2, type, '1: an icon, 2: a cursor.'), field('Images', 4, 2, count)],
            },
        ];
        const entryFields: Field[] = [];
        const images: { at: number; size: number; index: number }[] = [];
        const seen = new Map<string, number>();
        /** Images whose mask was saved as UTF-8 text: said once, for all of them. */
        const utf8Masks: { index: number; drawsRight: boolean }[] = [];

        for (let i = 0; i < count; i++) {
            const e = 6 + i * 16;
            const [w, h, colors, reserved] = [data[e] || 256, data[e + 1] || 256, data[e + 2], data[e + 3]];
            const [planesOrX, bitsOrY] = [b.u16(e + 4), b.u16(e + 6)];
            const size = b.u32(e + 8);
            const at = b.u32(e + 12);
            images.push({ at, size, index: i });
            entryFields.push({
                name: `Entry ${i + 1}`,
                offset: e,
                length: 16,
                value: `${w} × ${h}`,
                children: [
                    field('Width', e, 1, w, '0 means 256.'),
                    field('Height', e + 1, 1, h),
                    field('Colors', e + 2, 1, colors, '0 for 256 or more.'),
                    field('Reserved', e + 3, 1, reserved),
                    cursor ? field('Hot spot x', e + 4, 2, planesOrX, 'Where the cursor points, from the left.') : field('Planes', e + 4, 2, planesOrX),
                    cursor ? field('Hot spot y', e + 6, 2, bitsOrY, 'From the top.') : field('Bits a pixel', e + 6, 2, bitsOrY),
                    field('Size', e + 8, 4, bytesLabel(size)),
                    field('At', e + 12, 4, at),
                ],
            });
            if (reserved) warnings.push(`Entry ${i + 1}’s reserved byte is ${reserved}, not 0.`);

            // The picture: a PNG, or a bitmap with its mask.
            const isPng = data[at] === 0x89 && data[at + 1] === 0x50;
            const key = `${size}:${Array.from(data.subarray(at, at + Math.min(size, 64))).join(',')}`;
            const same = seen.get(key);
            const sameNote = same !== undefined && data.subarray(at, at + size).every((v, k) => v === data[images[same].at + k]) ? `, the same picture as image ${same + 1}` : '';
            if (!sameNote) seen.set(key, i);
            let drawn: { width: number; height: number; rgba: Uint8Array; about: string } | null = null;
            if (isPng) {
                try {
                    const r = png.parse(data.subarray(at, at + size), { name: 'image.png', names: [] });
                    const p = r.preview?.kind === 'stack' ? r.preview.items[0].preview : r.preview;
                    if (p?.kind === 'picture') drawn = { width: p.width, height: p.height, rgba: p.rgba, about: 'PNG' };
                    warnings.push(...r.warnings.map((w) => `Image ${i + 1} (PNG): ${w}`));
                } catch (err) {
                    warnings.push(`Image ${i + 1} is a PNG that can't be read: ${err instanceof Error ? err.message : err}`);
                }
                fields.push(field(`Image ${i + 1}`, at, size, `PNG, ${bytesLabel(size)}`));
            } else {
                const dib = decodeDib(data, at, size, true);
                if ('problem' in dib) {
                    warnings.push(`Image ${i + 1} can't be drawn: ${dib.problem}.`);
                    fields.push(field(`Image ${i + 1}`, at, size, bytesLabel(size)));
                } else {
                    const { info } = dib;
                    drawn = { width: info.width, height: info.height, rgba: dib.rgba, about: info.bits <= 8 ? `${info.colors} colors` : `${info.bits}-bit` };
                    if (info.length < size) {
                        if (info.maskAt !== null && savedAsUtf8(data.subarray(at + info.maskAt, at + size), info.length - info.maskAt)) utf8Masks.push({ index: i + 1, drawsRight: info.bits === 32 });
                        else warnings.push(`Image ${i + 1} takes ${bytesLabel(info.length)}, but its entry gives it ${bytesLabel(size)}: the rest is never drawn.`);
                    }
                    if (info.inverted) warnings.push(`Image ${i + 1} has ${info.inverted} pixel${info.inverted === 1 ? '' : 's'} that invert the screen under them; they're drawn see-through here.`);
                    const children = [
                        field('Bitmap header', at, info.headerSize, `${info.width} × ${info.height * 2}`, 'Twice the height: the colors, then the mask.'),
                        ...(info.colors ? [field('Colors', at + info.colorsAt, info.pixelsAt - info.colorsAt, `${info.colors}`)] : []),
                        field('Pixels', at + info.pixelsAt, (info.maskAt ?? info.length) - info.pixelsAt, `${info.bits} bits a pixel`, 'The bottom row first.'),
                        ...(info.maskAt !== null ? [field('Mask', at + info.maskAt, info.length - info.maskAt, '1 bit a pixel', '1: see-through.')] : []),
                    ];
                    if (info.length < size) children.push(field('Unused', at + info.length, size - info.length, bytesLabel(size - info.length)));
                    fields.push({ name: `Image ${i + 1}`, offset: at, length: size, value: `${info.width} × ${info.height}, ${drawn.about}`, children });
                }
            }
            if (drawn) {
                // A size byte only goes to 255: 0 stands for 256 or more (large PNGs say 0 too).
                const fitsEntry = (actual: number, said: number, raw: number) => (raw === 0 ? actual >= 256 : actual === said);
                if (!fitsEntry(drawn.width, w, data[e]) || !fitsEntry(drawn.height, h, data[e + 1]))
                    warnings.push(`Entry ${i + 1} says ${w} × ${h}, but its image is ${drawn.width} × ${drawn.height}.`);
                items.push({ title: `${drawn.width} × ${drawn.height}, ${drawn.about}${sameNote}`, preview: { kind: 'picture', width: drawn.width, height: drawn.height, rgba: drawn.rgba } });
            }
        }
        if (utf8Masks.length) {
            const which = utf8Masks.length === count ? (count === 1 ? 'The image' : `All ${count} images`) : `Image${utf8Masks.length === 1 ? '' : 's'} ${utf8Masks.map((m) => m.index).join(', ')}`;
            const one = utf8Masks.length === 1;
            warnings.push(
                `${which} had ${one ? 'its' : 'their'} mask saved as UTF-8 text (the byte 0xFF became C3 BF), which made ${one ? 'it' : 'each'} longer than it should be. ${
                    utf8Masks.every((m) => m.drawsRight)
                        ? `The ${one ? 'picture carries its' : 'pictures carry their'} own transparency, so the mask isn't used and ${one ? 'it draws' : 'they draw'} as meant.`
                        : "The mask is wrong, so what's see-through may be."
                }`
            );
        }
        fields.splice(1, 0, { name: 'Entries', offset: 6, length: count * 16, children: entryFields });

        // Images that overlap, and bytes between them nothing points to.
        const sorted = [...images].sort((x, y) => x.at - y.at);
        let covered = 6 + count * 16;
        let stray = 0;
        for (const img of sorted) {
            if (img.at < covered) warnings.push(`Image ${img.index + 1} overlaps the one before it.`);
            else if (img.at > covered) {
                const gap = data.subarray(covered, img.at);
                if (gap.some((v) => v)) stray += gap.length;
                fields.push(field(gap.some((v) => v) ? 'Not pointed to' : 'Padding', covered, gap.length, bytesLabel(gap.length)));
            }
            covered = Math.max(covered, img.at + img.size);
        }
        if (stray) warnings.push(`${bytesLabel(stray)} between the images aren't pointed to by any entry.`);
        fields.sort((x, y) => x.offset - y.offset);

        return {
            title: cursor ? 'Cursor (CUR)' : 'Icon (ICO)',
            summary: [
                ['Images', `${count}`],
                ['Sizes', [...new Set(items.map((x) => x.title.split(',')[0]))].join(', ') || 'none drawn'],
            ],
            fields,
            preview: items.length === 1 ? items[0].preview : items.length ? { kind: 'stack', items } : undefined,
            // Past the last image is nothing the file has; the usual checks look at it.
            end: covered,
            warnings,
        };
    },
};

export default parser;
