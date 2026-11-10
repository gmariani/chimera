import { bytesLabel, field, hex } from '../../core/bytes';
import type { Field, FormatParser, Preview } from '../../core/types';
import { readCff, type Cff } from './cff';
import { trueTypeGlyph } from './glyf';
import { Raster, type PathCommand } from './raster';
import { pixelBuffer } from '../../core/limits';
import { minOf, maxOf } from '../../core/math';

/**
 * TrueType and OpenType fonts (the sfnt structure, OpenType 1.9): a header and
 * a directory of tables, each a 4-letter tag, checksum, offset and length.
 * head, hhea, maxp, name, OS/2, post and cmap describe the font; the outlines
 * are TrueType curves (glyf, found through loca) or CFF. Collections (ttcf)
 * hold several fonts; the first is read.
 */

const TABLE_NAMES: Record<string, string> = {
    head: 'Font header', hhea: 'Horizontal header', hmtx: 'Horizontal metrics', maxp: 'Maximum profile', name: 'Naming', 'OS/2': 'OS/2 and Windows metrics', post: 'PostScript',
    cmap: 'Character to glyph mapping', glyf: 'Glyph data (TrueType)', loca: 'Glyph locations', 'CFF ': 'Compact Font Format outlines', CFF2: 'Compact Font Format 2 outlines', VORG: 'Vertical origins',
    kern: 'Kerning', GSUB: 'Glyph substitution', GPOS: 'Glyph positioning', GDEF: 'Glyph definitions', BASE: 'Baselines', JSTF: 'Justification', MATH: 'Math layout',
    cvt: 'Control values', fpgm: 'Font program', prep: 'Control value program', gasp: 'Grid-fitting and scan-conversion', hdmx: 'Horizontal device metrics', LTSH: 'Linear threshold', VDMX: 'Vertical device metrics',
    vhea: 'Vertical header', vmtx: 'Vertical metrics', DSIG: 'Digital signature', COLR: 'Color layers', CPAL: 'Color palettes', SVG: 'SVG glyphs', sbix: 'Bitmap graphics', CBDT: 'Color bitmap data', CBLC: 'Color bitmap locations',
    EBDT: 'Bitmap data', EBLC: 'Bitmap locations', fvar: 'Font variations', gvar: 'Glyph variations', avar: 'Axis variations', STAT: 'Style attributes', HVAR: 'Horizontal metrics variations', MVAR: 'Metrics variations', meta: 'Metadata',
}; // prettier-ignore

const NAME_IDS: Record<number, string> = {
    0: 'Copyright', 1: 'Family', 2: 'Subfamily', 3: 'Unique ID', 4: 'Full name', 5: 'Version', 6: 'PostScript name', 7: 'Trademark', 8: 'Manufacturer', 9: 'Designer', 10: 'Description',
    11: 'Vendor URL', 12: 'Designer URL', 13: 'License', 14: 'License URL', 16: 'Typographic family', 17: 'Typographic subfamily', 18: 'Compatible full name', 19: 'Sample text', 20: 'PostScript CID name', 21: 'WWS family', 22: 'WWS subfamily',
}; // prettier-ignore
const PLATFORMS = ['Unicode', 'Macintosh', 'ISO', 'Windows', 'Custom'];

/** Glyphs drawn on the sheet, at most. */
const MAX_GLYPHS = 512;
const CELL = 48;
const COLUMNS = 16;

const parser: FormatParser = {
    parse(data) {
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const u16 = (at: number) => view.getUint16(at);
        const i16 = (at: number) => view.getInt16(at);
        const u32 = (at: number) => view.getUint32(at);
        const tag = (at: number) => String.fromCharCode(...data.subarray(at, at + 4));
        const fields: Field[] = [];
        const warnings: string[] = [];

        // A collection: its header, then the first font's offset table.
        let base = 0;
        if (tag(0) === 'ttcf') {
            const count = u32(8);
            base = u32(12);
            fields.push({ name: 'Collection header', offset: 0, length: 12 + count * 4, value: `${count} fonts`, children: [field('Tag', 0, 4, 'ttcf'), field('Version', 4, 4, `${u16(4)}.${u16(6)}`), field('Fonts', 8, 4, count), field('Offsets', 12, count * 4, `${count} offsets; the first font is read`)] });
        }
        const version = u32(base);
        const flavor = version === 0x4f54544f ? 'CFF' : version === 0x00010000 || version === 0x74727565 ? 'TrueType' : `0x${hex(version)}`;
        const numTables = u16(base + 4);
        fields.push({
            name: 'Offset table',
            offset: base,
            length: 12,
            value: `${numTables} tables`,
            children: [
                field('sfnt version', base, 4, version === 0x4f54544f ? 'OTTO (CFF outlines)' : version === 0x74727565 ? 'true (Apple TrueType)' : `0x${hex(version)} (TrueType outlines)`),
                field('Table count', base + 4, 2, numTables),
                field('Search range', base + 6, 2, u16(base + 6), '16 × the largest power of 2 ≤ the table count, for binary search.'),
                field('Entry selector', base + 8, 2, u16(base + 8)),
                field('Range shift', base + 10, 2, u16(base + 10)),
            ],
        });

        const tables = new Map<string, { offset: number; length: number }>();
        const records: Field[] = [];
        for (let i = 0; i < numTables; i++) {
            const at = base + 12 + i * 16;
            const t = tag(at);
            const offset = u32(at + 8);
            const length = u32(at + 12);
            tables.set(t, { offset, length });
            records.push({ name: t, offset: at, length: 16, value: bytesLabel(length), children: [field('Tag', at, 4, t), field('Checksum', at + 4, 4, hex(u32(at + 4))), field('Offset', at + 8, 4, offset), field('Length', at + 12, 4, bytesLabel(length))] });
            if (offset + length > data.length) warnings.push(`The ${t} table runs past the end of the file.`);
        }
        fields.push({ name: 'Table records', offset: base + 12, length: numTables * 16, children: records });

        const names = new Map<number, string>();
        let unitsPerEm = 1000;
        let ascender = 800;
        let descender = -200;
        let glyphCount = 0;
        let longLoca = false;
        let cff: Cff | null = null;

        // Each table, in the order they sit in the file.
        for (const [t, { offset: at, length }] of [...tables].sort((a, b) => a[1].offset - b[1].offset)) {
            const children: Field[] = [];
            let value: string | undefined;
            const f = (name: string, o: number, n: number, v?: string | number, note?: string) => children.push(field(name, at + o, n, v, note));
            const fixed = (o: number) => +(i16(at + o) + u16(at + o + 2) / 65536).toFixed(4);
            /** LONGDATETIME: seconds since 1904. */
            const date = (o: number) => new Date((u32(at + o) * 2 ** 32 + u32(at + o + 4) - 2082844800) * 1000).toISOString().slice(0, 19).replace('T', ' ');
            try {
                switch (t) {
                    case 'head':
                        unitsPerEm = u16(at + 18);
                        longLoca = i16(at + 50) === 1;
                        value = `${unitsPerEm} units per em`;
                        f('Version', 0, 4, `${u16(at)}.${u16(at + 2)}`);
                        f('Font revision', 4, 4, fixed(4));
                        f('Checksum adjustment', 8, 4, hex(u32(at + 8)), 'Makes the whole file\'s checksum 0xB1B0AFBA.');
                        f('Magic number', 12, 4, hex(u32(at + 12)), 'Always 5F0F3CF5.');
                        f('Flags', 16, 2, `0x${hex(u16(at + 16), 4)}`);
                        f('Units per em', 18, 2, unitsPerEm);
                        f('Created', 20, 8, date(20));
                        f('Modified', 28, 8, date(28));
                        f('xMin', 36, 2, i16(at + 36));
                        f('yMin', 38, 2, i16(at + 38));
                        f('xMax', 40, 2, i16(at + 40));
                        f('yMax', 42, 2, i16(at + 42));
                        f('Mac style', 44, 2, ['Bold', 'Italic', 'Underline', 'Outline', 'Shadow', 'Condensed', 'Extended'].filter((_, k) => u16(at + 44) & (1 << k)).join(', ') || 'Regular');
                        f('Smallest readable size', 46, 2, `${u16(at + 46)} px`);
                        f('Font direction hint', 48, 2, i16(at + 48), 'Deprecated; 2.');
                        f('Index to loca format', 50, 2, longLoca ? '1 (32-bit offsets)' : '0 (16-bit offsets, halved)');
                        f('Glyph data format', 52, 2, i16(at + 52));
                        break;
                    case 'hhea':
                        ascender = i16(at + 4);
                        descender = i16(at + 6);
                        value = `ascender ${ascender}, descender ${descender}`;
                        f('Version', 0, 4, `${u16(at)}.${u16(at + 2)}`);
                        f('Ascender', 4, 2, ascender);
                        f('Descender', 6, 2, descender);
                        f('Line gap', 8, 2, i16(at + 8));
                        f('Advance width max', 10, 2, u16(at + 10));
                        f('Min left side bearing', 12, 2, i16(at + 12));
                        f('Min right side bearing', 14, 2, i16(at + 14));
                        f('x max extent', 16, 2, i16(at + 16));
                        f('Caret slope rise', 18, 2, i16(at + 18));
                        f('Caret slope run', 20, 2, i16(at + 20));
                        f('Caret offset', 22, 2, i16(at + 22));
                        f('Reserved', 24, 8);
                        f('Metric data format', 32, 2, i16(at + 32));
                        f('Horizontal metrics count', 34, 2, u16(at + 34), 'Entries in hmtx with their own advance width.');
                        break;
                    case 'maxp':
                        glyphCount = u16(at + 4);
                        value = `${glyphCount} glyphs`;
                        f('Version', 0, 4, u32(at) === 0x5000 ? '0.5 (CFF)' : '1.0 (TrueType)');
                        f('Glyph count', 4, 2, glyphCount);
                        if (u32(at) === 0x10000) {
                            ['Max points', 'Max contours', 'Max composite points', 'Max composite contours', 'Max zones', 'Max twilight points', 'Max storage', 'Max function defs', 'Max instruction defs', 'Max stack elements', 'Max instruction size', 'Max component elements', 'Max component depth'].forEach((n, k) => f(n, 6 + k * 2, 2, u16(at + 6 + k * 2)));
                        }
                        break;
                    case 'name': {
                        const count = u16(at + 2);
                        const strings = at + u16(at + 4);
                        f('Format', 0, 2, u16(at));
                        f('Count', 2, 2, count);
                        f('Strings offset', 4, 2, u16(at + 4));
                        for (let k = 0; k < count; k++) {
                            const r = at + 6 + k * 12;
                            const [platform, encoding, language, id, len, off] = [u16(r), u16(r + 2), u16(r + 4), u16(r + 6), u16(r + 8), u16(r + 10)];
                            const bytes = data.subarray(strings + off, strings + off + len);
                            // Unicode and Windows names are UTF-16 (big-endian); Macintosh Roman is close to Latin-1.
                            const text = platform === 0 || platform === 3 ? new TextDecoder('utf-16be').decode(bytes) : new TextDecoder('latin1').decode(bytes);
                            if (platform === 3 || !names.has(id)) names.set(id, text);
                            children.push({
                                name: NAME_IDS[id] ?? `Name ${id}`,
                                offset: r,
                                length: 12,
                                value: text.length > 60 ? `${text.slice(0, 60)}…` : text,
                                note: `${PLATFORMS[platform] ?? platform}, encoding ${encoding}, language 0x${hex(language, 4)}.`,
                                children: [field('Platform', r, 2, PLATFORMS[platform] ?? platform), field('Encoding', r + 2, 2, encoding), field('Language', r + 4, 2, `0x${hex(language, 4)}`), field('Name ID', r + 6, 2, id), field('Length', r + 8, 2, len), field('Offset', r + 10, 2, off), field('String', strings + off, len, text)],
                            });
                        }
                        break;
                    }
                    case 'OS/2': {
                        const v = u16(at);
                        value = `version ${v}`;
                        f('Version', 0, 2, v);
                        f('Average width', 2, 2, i16(at + 2));
                        f('Weight class', 4, 2, `${u16(at + 4)}${{ 100: ' (Thin)', 200: ' (Extra-light)', 300: ' (Light)', 400: ' (Regular)', 500: ' (Medium)', 600: ' (Semi-bold)', 700: ' (Bold)', 800: ' (Extra-bold)', 900: ' (Black)' }[u16(at + 4)] ?? ''}`);
                        f('Width class', 6, 2, u16(at + 6));
                        f('Embedding (fsType)', 8, 2, `0x${hex(u16(at + 8), 4)}`, '0 installable, 2 restricted, 4 preview and print, 8 editable; 0x100 no subsetting, 0x200 bitmaps only.');
                        ['Subscript x size', 'Subscript y size', 'Subscript x offset', 'Subscript y offset', 'Superscript x size', 'Superscript y size', 'Superscript x offset', 'Superscript y offset', 'Strikeout size', 'Strikeout position'].forEach((n, k) => f(n, 10 + k * 2, 2, i16(at + 10 + k * 2)));
                        f('Family class', 30, 2, `${data[at + 30]}, subclass ${data[at + 31]}`);
                        f('PANOSE', 32, 10, Array.from(data.subarray(at + 32, at + 42)).join(' '), 'Ten numbers classing the typeface.');
                        f('Unicode ranges', 42, 16, `${hex(u32(at + 42))} ${hex(u32(at + 46))} ${hex(u32(at + 50))} ${hex(u32(at + 54))}`);
                        f('Vendor ID', 58, 4, tag(at + 58));
                        f('Selection flags', 62, 2, ['Italic', 'Underscore', 'Negative', 'Outlined', 'Strikeout', 'Bold', 'Regular', 'Use typo metrics', 'WWS', 'Oblique'].filter((_, k) => u16(at + 62) & (1 << k)).join(', ') || 'None');
                        f('First character', 64, 2, `U+${hex(u16(at + 64), 4)}`);
                        f('Last character', 66, 2, `U+${hex(u16(at + 66), 4)}`);
                        f('Typo ascender', 68, 2, i16(at + 68));
                        f('Typo descender', 70, 2, i16(at + 70));
                        f('Typo line gap', 72, 2, i16(at + 72));
                        f('Windows ascent', 74, 2, u16(at + 74));
                        f('Windows descent', 76, 2, u16(at + 76));
                        if (v >= 1 && length >= 86) f('Code page ranges', 78, 8, `${hex(u32(at + 78))} ${hex(u32(at + 82))}`);
                        if (v >= 2 && length >= 96) {
                            f('x height', 86, 2, i16(at + 86));
                            f('Cap height', 88, 2, i16(at + 88));
                            f('Default character', 90, 2, u16(at + 90));
                            f('Break character', 92, 2, u16(at + 92));
                            f('Max context', 94, 2, u16(at + 94));
                        }
                        break;
                    }
                    case 'post':
                        value = `version ${u16(at)}.${u16(at + 2) >> 12}`;
                        f('Version', 0, 4, `${u16(at)}.${u16(at + 2) >> 12}`, '1: standard Mac glyph names; 2: its own names; 3: no names.');
                        f('Italic angle', 4, 4, fixed(4));
                        f('Underline position', 8, 2, i16(at + 8));
                        f('Underline thickness', 10, 2, i16(at + 10));
                        f('Fixed pitch', 12, 4, u32(at + 12) ? 'Yes' : 'No');
                        f('Memory use', 16, 16, 'Min and max for Type 42 and Type 1');
                        if (length > 32) f('Glyph names', 32, length - 32, bytesLabel(length - 32));
                        break;
                    case 'cmap': {
                        const count = u16(at + 2);
                        f('Version', 0, 2, u16(at));
                        f('Subtables', 2, 2, count);
                        const subtables: string[] = [];
                        for (let k = 0; k < count; k++) {
                            const r = at + 4 + k * 8;
                            const sub = at + u32(r + 4);
                            const format = u16(sub);
                            subtables.push(`format ${format}`);
                            children.push({ name: `${PLATFORMS[u16(r)] ?? u16(r)}, encoding ${u16(r + 2)}`, offset: r, length: 8, value: `format ${format}`, children: [field('Platform', r, 2, PLATFORMS[u16(r)] ?? u16(r)), field('Encoding', r + 2, 2, u16(r + 2)), field('Offset', r + 4, 4, u32(r + 4)), field('Subtable format', sub, 2, format)] });
                        }
                        value = subtables.join(', ');
                        break;
                    }
                    case 'CFF ':
                        cff = readCff(data, at);
                        children.push(...cff.fields);
                        value = cff.name;
                        break;
                    default:
                        f('Data', 0, length, bytesLabel(length));
                }
            } catch (e) {
                warnings.push(`The ${t} table couldn't be read: ${(e as Error).message}`);
            }
            fields.push({ name: `${t.trim()} (${TABLE_NAMES[t.trim()] ?? 'Unknown'})`, offset: at, length, value, children });
        }

        // The outlines, CFF or TrueType.
        let outline: ((g: number) => PathCommand[]) | null = null;
        const glyf = tables.get('glyf');
        const loca = tables.get('loca');
        if (cff) {
            const c: Cff = cff;
            outline = (g) => c.glyph(g);
            glyphCount ||= cff.glyphCount;
        } else if (glyf && loca) {
            const offsets = Array.from({ length: glyphCount + 1 }, (_, k) => (longLoca ? u32(loca.offset + k * 4) : u16(loca.offset + k * 2) * 2));
            outline = (g) => trueTypeGlyph(data, glyf.offset, offsets, g);
        } else if (tables.has('CFF2')) {
            warnings.push('CFF2 (variable font) outlines aren\'t drawn here.');
        } else {
            warnings.push('There are no outlines (bitmap-only, or a font this doesn\'t read).');
        }

        const items: { title: string; preview: Preview }[] = [];
        if (outline && glyphCount) {
            const shown = Math.min(glyphCount, MAX_GLYPHS);
            const rows = Math.ceil(shown / COLUMNS);
            const width = COLUMNS * CELL;
            const height = rows * CELL;
            const rgba = pixelBuffer(width, height, 4).fill(255);
            const scale = (CELL - 10) / Math.max(1, ascender - descender);
            let failed = 0;
            for (let g = 0; g < shown; g++) {
                const cx = (g % COLUMNS) * CELL;
                const cy = Math.floor(g / COLUMNS) * CELL;
                // Each cell's edge, in light gray.
                for (let k = 0; k < CELL; k++) {
                    rgba.set([220, 220, 220], ((cy + k) * width + cx) * 4);
                    rgba.set([220, 220, 220], (cy * width + cx + k) * 4);
                }
                let path: PathCommand[];
                try {
                    path = outline(g);
                } catch {
                    failed++;
                    continue;
                }
                // Centered across by the outline's extent; the baseline where the ascender puts it.
                const xs = path.flatMap((c) => (c[0] === 'Z' ? [] : c.filter((_, k) => k % 2 === 1) as number[]));
                const left = xs.length ? minOf(xs) : 0;
                const right = xs.length ? maxOf(xs) : 0;
                const raster = new Raster(CELL, CELL);
                raster.fill(path, scale, CELL / 2 - ((left + right) / 2) * scale, 5 + ascender * scale);
                const cover = raster.coverage();
                for (let k = 0; k < cover.length; k++) {
                    if (!cover[k]) continue;
                    const o = ((cy + Math.floor(k / CELL)) * width + cx + (k % CELL)) * 4;
                    const v = 255 - cover[k];
                    rgba[o] = rgba[o + 1] = rgba[o + 2] = Math.min(rgba[o], v);
                }
            }
            if (failed) warnings.push(`${failed} glyph${failed === 1 ? '' : 's'} couldn't be drawn.`);
            items.push({ title: `Glyphs${glyphCount > shown ? ` (the first ${shown} of ${glyphCount})` : ''}`, preview: { kind: 'picture', width, height, rgba } });
        }
        if (names.size) items.push({ title: 'Names', preview: { kind: 'text', text: [...names].sort((a, b) => a[0] - b[0]).map(([id, text]) => `${NAME_IDS[id] ?? `Name ${id}`}: ${text}`).join('\n') } });

        const name = (id: number) => names.get(id) ?? '';
        return {
            title: `Font (${flavor === 'CFF' ? 'OpenType, CFF outlines' : flavor === 'TrueType' ? 'TrueType' : 'sfnt'}${base ? ', collection' : ''})`,
            summary: [
                ['Family', name(16) || name(1) || cff?.strings.get('FamilyName') || ''],
                ['Style', name(17) || name(2)],
                ['Full name', name(4) || cff?.strings.get('FullName') || ''],
                ['Version', name(5)],
                ['Glyphs', String(glyphCount)],
                ['Units per em', String(unitsPerEm)],
                ['Outlines', flavor],
            ].filter(([, v]) => v) as [string, string][],
            fields,
            preview: items.length === 1 ? items[0].preview : items.length ? { kind: 'stack', items } : undefined,
            warnings,
        };
    },
};

export default parser;
