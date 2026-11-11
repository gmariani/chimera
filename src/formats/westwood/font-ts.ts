import { Bytes, bytesLabel, field } from '../../core/bytes';
import { pixelBuffer } from '../../core/limits';
import type { Field, FormatParser, IndexedImage } from '../../core/types';
import { BITFONT, bitFontKind } from './sniff';

/**
 * Westwood's 1-bit fonts, three of them. A header, then glyphs all the same
 * size: a width byte, then the rows at 1 bit a pixel (leftmost in the high
 * bit), each row the header's stride long.
 *
 * - "fonT" (TS, RA2's game.fnt): Unicode. A 28-byte header, then for each of
 *   the 65,536 code points its glyph number plus one (0: none), then the glyphs.
 * - "FoNt" (RA2's map editor fonts): a 48-byte header giving the first and
 *   last character, then a glyph for each.
 * - "tNoF" (Nox): the same, with a 36-byte header and no separate font height.
 *
 * The width only limits what's shown, so pixels past it never appear: a place
 * data could hide. See https://moddingwiki.shikadi.net/wiki/Westwood_BitFont_Format
 * and https://moddingwiki.shikadi.net/wiki/Westwood_Unicode_BitFont_Format.
 */

const MAX_SHOWN = 4096;
const TABLE = 28;

const parser: FormatParser = {
    parse(data) {
        const kind = bitFontKind(data);
        if (!kind) throw new Error('This isn\'t one of Westwood\'s 1-bit fonts: no "fonT", "FoNt" or "tNoF" header whose sizes fit the file.');
        const layout = BITFONT[kind];
        const b = new Bytes(data);
        const warnings: string[] = [];
        const stride = b.u32(layout.stride);
        const lines = b.u32(layout.lines);
        const height = layout.height < 0 ? lines : b.u32(layout.height);
        const glyphSize = b.u32(layout.glyphSize);
        const width = b.u32(layout.width);
        const unicode = kind === 'fonT';
        const [first, last] = kind === 'FoNt' ? [b.u32(40), b.u32(44)] : kind === 'tNoF' ? [b.u16(32), b.u16(34)] : [0, 0];
        const count = unicode ? b.u32(20) : last - first + 1;
        const glyphStart = layout.header;
        const glyphEnd = glyphStart + count * glyphSize;

        // The values the format always has.
        for (const [at, value, name] of layout.fixed) if (b.u32(at) !== value) warnings.push(`The header's ${name} at offset ${at} is ${b.u32(at)}, where every known font has ${value}.`);
        if (glyphSize !== 1 + stride * lines)
            warnings.push(
                `Each glyph takes ${bytesLabel(glyphSize)}, but a width byte and ${lines} rows of ${stride} make ${bytesLabel(1 + stride * lines)}: ${glyphSize - 1 - stride * lines === 1 ? 'the byte left over in each never shows' : `the ${glyphSize - 1 - stride * lines} bytes left over in each never show`}.`
            );
        if (lines > height) warnings.push(`The glyphs have ${lines} rows, more than the font's height of ${height}.`);

        // Code points with a glyph, and where it is.
        const mapped: [number, number][] = [];
        const used = new Uint8Array(count);
        let pastEnd = 0;
        if (unicode) {
            for (let cp = 0; cp < 65536; cp++) {
                const n = b.u16(TABLE + cp * 2);
                if (!n) continue;
                if (n > count) {
                    pastEnd++;
                    continue;
                }
                used[n - 1] = 1;
                mapped.push([cp, glyphStart + (n - 1) * glyphSize]);
            }
        } else {
            used.fill(1);
            for (let cp = first; cp <= last; cp++) mapped.push([cp, glyphStart + (cp - first) * glyphSize]);
        }
        if (pastEnd)
            warnings.push(
                `${pastEnd.toLocaleString('en-US')} character${pastEnd === 1 ? '' : 's'} in the table point${pastEnd === 1 ? 's' : ''} past the font's ${count.toLocaleString('en-US')} glyph${count === 1 ? '' : 's'}.`
            );

        // What never shows: pixels past a glyph's width (or past the stride's rows), and glyphs nothing points at.
        const has = (at: number, from: number, to: number) => {
            for (let i = from; i < to; i++) if (data[at + i]) return true;
            return false;
        };
        let hiddenPixels = 0;
        let hiddenUnused = 0;
        let unused = 0;
        const widest = stride * 8;
        let tooWide = 0;
        for (let g = 0; g < count; g++) {
            const at = glyphStart + g * glyphSize;
            const w = data[at];
            if (w > widest) tooWide++;
            if (!used[g]) {
                unused++;
                if (has(at, 1, glyphSize)) hiddenUnused++;
                continue;
            }
            let hidden = has(at, 1 + stride * lines, glyphSize);
            for (let y = 0; y < lines && !hidden; y++) {
                for (let x = Math.min(w, widest); x < widest; x++) {
                    if (data[at + 1 + y * stride + (x >> 3)] & (0x80 >> (x & 7))) {
                        hidden = true;
                        break;
                    }
                }
            }
            if (hidden) hiddenPixels++;
        }
        if (tooWide) warnings.push(`${tooWide.toLocaleString('en-US')} glyph${tooWide === 1 ? ' is' : 's are'} said to be wider than a row holds (${widest} pixels).`);
        if (hiddenPixels)
            warnings.push(
                `${hiddenPixels.toLocaleString('en-US')} glyph${hiddenPixels === 1 ? ' has' : 's have'} pixels set past ${hiddenPixels === 1 ? 'its' : 'their'} width, which never show: a place data can hide.`
            );
        if (hiddenUnused)
            warnings.push(`${hiddenUnused.toLocaleString('en-US')} glyph${hiddenUnused === 1 ? '' : 's'} that no character uses hold${hiddenUnused === 1 ? 's' : ''} pixels, which never show.`);

        const frames: IndexedImage[] = mapped.slice(0, MAX_SHOWN).map(([, at]) => {
            const w = Math.max(1, Math.min(data[at], widest));
            // The font's height, padding included; never less than the rows stored.
            const h = Math.max(height, lines);
            const pixels = pixelBuffer(w, h);
            for (let y = 0; y < lines; y++) for (let x = 0; x < w; x++) if (data[at + 1 + y * stride + (x >> 3)] & (0x80 >> (x & 7))) pixels[y * w + x] = 1;
            return { width: w, height: h, pixels };
        });
        const palette = new Uint8Array(768);
        palette.set([255, 255, 255], 3);

        const headerFields: Field[] = [field('ID', 0, 4, JSON.stringify(b.ascii(0, 4)))];
        const named: [number, string, string | number, string?][] = [
            [layout.width, unicode ? 'Ideograph width' : 'Width', width, unicode ? "The ideographic space's width (U+3000), for Japanese." : "Perhaps the space's width, if the font has none."],
            [layout.stride, 'Stride', stride, 'Bytes in each row of every glyph.'],
            [layout.lines, 'Lines', lines, 'Rows stored for each glyph.'],
            ...(layout.height >= 0 ? [[layout.height, 'Height', height, "The font's height: below the lines is padding."] as [number, string, number, string]] : []),
            ...(unicode ? [[20, 'Glyphs', count] as [number, string, number]] : []),
            [layout.glyphSize, 'Glyph size', glyphSize, 'A width byte, then the rows.'],
            ...layout.fixed.map(([at, value]) => [at, 'Unknown', b.u32(at), `Always ${value}.`] as [number, string, number, string]),
        ];
        for (const [at, name, value, note] of named.sort((x, y) => x[0] - y[0])) headerFields.push(field(name, at, 4, value, note));
        if (kind === 'FoNt') headerFields.push(field('First character', 40, 4, first), field('Last character', 44, 4, last));
        if (kind === 'tNoF') headerFields.push(field('First character', 32, 2, first), field('Last character', 34, 2, last));

        return {
            title: unicode ? 'Unicode font (TS/RA2)' : kind === 'FoNt' ? 'Font (RA2 map editor)' : 'Font (Nox)',
            summary: [
                ['Glyphs', count.toLocaleString('en-US')],
                ['Characters', `${mapped.length.toLocaleString('en-US')} ${unicode ? 'mapped' : `(${first} to ${last})`}${mapped.length > MAX_SHOWN ? `, the first ${MAX_SHOWN} shown` : ''}`],
                ['Height', `${height} pixels${height !== lines ? ` (${lines} stored)` : ''}`],
                ...(unused ? [['Unused glyphs', unused.toLocaleString('en-US')] as [string, string]] : []),
            ],
            fields: [
                { name: 'Header', offset: 0, length: layout.header === TABLE + 65536 * 2 ? TABLE : layout.header, children: headerFields },
                ...(unicode ? [field('Character map', TABLE, 65536 * 2, '65,536 glyph numbers', 'For each code point from U+0000, its glyph number plus one; 0 for none.')] : []),
                field('Glyphs', glyphStart, glyphEnd - glyphStart, `${count.toLocaleString('en-US')} × ${bytesLabel(glyphSize)}`),
            ],
            preview: { kind: 'images', frames, palette, transparentIndex: 0 },
            // Past the last glyph is nothing a font has; the usual checks look at it.
            end: glyphEnd,
            warnings,
        };
    },
};

export default parser;
