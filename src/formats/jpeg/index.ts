import { bytesLabel, field, hex } from '../../core/bytes';
import type { Entry, Field, FormatParser, Preview } from '../../core/types';
import { decodable, decodeJpeg, isFrame, processOf, segmentsOf, ZIGZAG, type Segment } from './decode';
import { readExif, type Exif } from './exif';

/**
 * JPEG pictures (ITU T.81, with JFIF or EXIF around them). A string of
 * segments, each a marker (0xFF and a code) and, for most, a big-endian
 * length that counts itself: tables (DQT, DHT), the frame header (SOF), and
 * application segments (APPn) that carry EXIF, XMP, ICC profiles and the like.
 * Each scan (SOS) is followed by its Huffman-coded data, which runs to the next
 * marker; a 0xFF in it is followed by a stuffed 0x00. Progressive pictures have
 * several scans, each adding detail to the last.
 */

const MARKERS: Record<number, [string, string]> = {
    0xc4: ['DHT', 'Huffman tables'],
    0xc8: ['JPG', 'Reserved'],
    0xcc: ['DAC', 'Arithmetic coding conditioning'],
    0xd8: ['SOI', 'Start of image'],
    0xd9: ['EOI', 'End of image'],
    0xda: ['SOS', 'Start of scan'],
    0xdb: ['DQT', 'Quantization tables'],
    0xdc: ['DNL', 'Number of lines'],
    0xdd: ['DRI', 'Restart interval'],
    0xde: ['DHP', 'Hierarchical progression'],
    0xdf: ['EXP', 'Expand reference components'],
    0xfe: ['COM', 'Comment'],
    0x01: ['TEM', 'Temporary'],
};

function markerName(m: number): [string, string] {
    if (MARKERS[m]) return MARKERS[m];
    if (isFrame(m)) return [`SOF${m - 0xc0}`, `Frame header: ${processOf(m).toLowerCase()}`];
    if (m >= 0xd0 && m <= 0xd7) return [`RST${m - 0xd0}`, 'Restart'];
    if (m >= 0xe0 && m <= 0xef) return [`APP${m - 0xe0}`, 'Application data'];
    return [`0x${hex(m, 2)}`, 'Reserved'];
}

/** Component names by their usual IDs (JFIF numbers them 1 to 3; Adobe's RGB uses letters). */
const COMPONENT_NAMES: Record<number, string> = { 1: 'Y', 2: 'Cb', 3: 'Cr', 4: 'I', 5: 'Q', 82: 'R', 71: 'G', 66: 'B' };

/** The IJG's luminance table at quality 50 (T.81 Annex K), in natural order: libjpeg scales it to make every quality. */
const IJG_LUMINANCE = [
    16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];

/** The quality libjpeg would have been given for this luminance table, when it looks like a scaled IJG one. */
function ijgQuality(table: number[]): number | null {
    // Quality 100 scales every value below 1, and libjpeg rounds them up.
    if (table.every((q) => q === 1)) return 100;
    const scales = table.map((q, i) => (q * 100) / IJG_LUMINANCE[i]);
    const mean = scales.reduce((a, b) => a + b, 0) / 64;
    // A table that isn't one scaled whole (a camera's own) has no IJG quality.
    const spread = scales.reduce((a, s) => a + Math.abs(s - mean), 0) / 64 / mean;
    if (spread > 0.15 && Math.max(...table) > 1) return null;
    const quality = mean <= 100 ? (200 - mean) / 2 : 5000 / mean;
    return Math.max(1, Math.min(100, Math.round(quality)));
}

const ascii = (data: Uint8Array, at: number, length: number) => String.fromCharCode(...data.subarray(at, at + Math.max(0, length)));

const parser: FormatParser = {
    parse(data) {
        const u16 = (at: number) => (data[at] << 8) | data[at + 1];
        const { segments, end } = segmentsOf(data);
        if (segments[0]?.marker !== 0xd8) throw new Error('No start-of-image marker (FF D8).');
        const warnings: string[] = [];
        const fields: Field[] = [];
        const entries: Entry[] = [];
        const texts: { title: string; text: string }[] = [];
        let exif: Exif | null = null;
        let frame: { marker: number; width: number; height: number; precision: number; components: { id: number; h: number; v: number }[] } | null = null;
        let luminance: number[] | null = null;
        let adobe: number | null = null;
        let scans = 0;

        for (const s of segments) {
            const [code, title] = markerName(s.marker);
            const p = s.body;
            const size = s.offset + s.length - p;
            if (s.marker === 0xd8 || s.marker === 0xd9 || (s.marker >= 0xd0 && s.marker <= 0xd7) || s.marker === 0x01) {
                fields.push(field(code, s.offset, s.length, title));
                continue;
            }
            // The marker (after any 0xFF fill) and the length.
            const markerAt = p - 4;
            const header: Field[] = [field('Marker', markerAt, 2, `FF ${hex(s.marker, 2)} (${code})`), field('Length', markerAt + 2, 2, u16(markerAt + 2), 'Of the segment, counting these two bytes, not the marker.')];
            if (markerAt > s.offset) header.unshift(field('Fill', s.offset, markerAt - s.offset, `${markerAt - s.offset} × FF`, 'Padding before the marker.'));
            const segment = (name: string, children: Field[], value?: string): Field => ({ name, offset: s.offset, length: s.length, value, children: [...header, ...children] });

            if (s.marker === 0xdb) {
                const tables: Field[] = [];
                for (let at = p; at < p + size; ) {
                    const sixteen = data[at] >> 4;
                    const id = data[at] & 15;
                    const length = 64 * (sixteen ? 2 : 1);
                    const values = Array.from({ length: 64 }, (_, i) => (sixteen ? u16(at + 1 + i * 2) : data[at + 1 + i]));
                    if (id === 0 && !luminance) {
                        luminance = new Array(64);
                        values.forEach((v, i) => (luminance![ZIGZAG[i]] = v));
                    }
                    tables.push({
                        name: `Table ${id}`,
                        offset: at,
                        length: 1 + length,
                        value: `${sixteen ? 16 : 8}-bit`,
                        children: [field('Precision and ID', at, 1, `0x${hex(data[at], 2)}`, 'High 4 bits: 0 for 8-bit values, 1 for 16-bit; low 4: the table number.'), field('Values', at + 1, length, values.slice(0, 8).join(' ') + ' …', 'In zigzag order, the DC value first.')],
                    });
                    at += 1 + length;
                }
                fields.push(segment(`${code} (${title})`, tables, `${tables.length} table${tables.length === 1 ? '' : 's'}`));
            } else if (s.marker === 0xc4) {
                const tables: Field[] = [];
                for (let at = p; at + 17 <= p + size; ) {
                    const counts = data.subarray(at + 1, at + 17);
                    const total = counts.reduce((a, b) => a + b, 0);
                    const kind = data[at] >> 4 ? 'AC' : 'DC';
                    tables.push({
                        name: `${kind} table ${data[at] & 15}`,
                        offset: at,
                        length: 17 + total,
                        value: `${total} codes`,
                        children: [
                            field('Class and ID', at, 1, `0x${hex(data[at], 2)}`, 'High 4 bits: 0 for DC, 1 for AC; low 4: the table number.'),
                            field('Code counts', at + 1, 16, Array.from(counts).join(' '), 'How many codes there are of each length, 1 to 16 bits.'),
                            field('Symbols', at + 17, total, total <= 16 ? Array.from(data.subarray(at + 17, at + 17 + total), (b) => hex(b, 2)).join(' ') : bytesLabel(total), kind === 'DC' ? 'The bit length of each difference.' : 'Each a run of zeros (high 4 bits) and a bit length (low 4).'),
                        ],
                    });
                    at += 17 + total;
                }
                fields.push(segment(`${code} (${title})`, tables, tables.map((t) => t.name).join(', ')));
            } else if (isFrame(s.marker)) {
                const count = data[p + 5];
                const components = Array.from({ length: count }, (_, i) => ({ at: p + 6 + i * 3, id: data[p + 6 + i * 3], h: data[p + 7 + i * 3] >> 4, v: data[p + 7 + i * 3] & 15, tq: data[p + 8 + i * 3] }));
                if (!frame) frame = { marker: s.marker, precision: data[p], height: u16(p + 1), width: u16(p + 3), components };
                fields.push(
                    segment(`${code} (${processOf(s.marker)})`, [
                        field('Precision', p, 1, `${data[p]} bits per sample`),
                        field('Height', p + 1, 2, u16(p + 1), u16(p + 1) ? undefined : 'Given later, by a DNL marker.'),
                        field('Width', p + 3, 2, u16(p + 3)),
                        field('Components', p + 5, 1, count),
                        ...components.map((c) => ({
                            name: `Component ${c.id}${COMPONENT_NAMES[c.id] ? ` (${COMPONENT_NAMES[c.id]})` : ''}`,
                            offset: c.at,
                            length: 3,
                            value: `${c.h}×${c.v}, table ${c.tq}`,
                            children: [field('ID', c.at, 1, c.id), field('Sampling', c.at + 1, 1, `${c.h}×${c.v}`, 'Horizontal (high 4 bits) and vertical (low 4) sampling factors.'), field('Quantization table', c.at + 2, 1, c.tq)],
                        })),
                    ], `${u16(p + 3)} × ${u16(p + 1)}`),
                );
            } else if (s.marker === 0xda) {
                scans++;
                const count = data[p];
                const q = p + 1 + count * 2;
                const [ss, se, ah, al] = [data[q], data[q + 1], data[q + 2] >> 4, data[q + 2] & 15];
                const names = Array.from({ length: count }, (_, i) => COMPONENT_NAMES[data[p + 1 + i * 2]] ?? String(data[p + 1 + i * 2]));
                const progressive = frame?.marker === 0xc2 || frame?.marker === 0xc6 || frame?.marker === 0xca || frame?.marker === 0xce;
                const what = !progressive ? names.join(', ') : `${names.join(', ')}: ${ss === 0 ? 'DC' : `AC ${ss}–${se}`}${ah ? `, refining bit ${al}` : al ? `, from bit ${al}` : ''}`;
                const children: Field[] = [
                    field('Components', p, 1, count),
                    ...Array.from({ length: count }, (_, i) => field(`Component ${names[i]}`, p + 1 + i * 2, 2, `DC table ${data[p + 2 + i * 2] >> 4}, AC table ${data[p + 2 + i * 2] & 15}`)),
                    field('Spectral start', q, 1, ss, 'The first coefficient in the scan, in zigzag order (0 is DC).'),
                    field('Spectral end', q + 1, 1, se),
                    field('Successive approximation', q + 2, 1, `${ah}, ${al}`, 'The bit refined last time (high 4 bits) and this time (low 4); 0, 0 when it\'s all at once.'),
                ];
                const scan = s.scan!;
                const coded = field('Coded data', scan.offset, scan.length, bytesLabel(scan.length), `Huffman-coded${scan.restarts ? `, with ${scan.restarts} restart marker${scan.restarts === 1 ? '' : 's'}` : ''}; each FF in it is followed by a stuffed 00.`);
                fields.push({ name: `Scan ${scans}`, offset: s.offset, length: s.length + scan.length, value: what, children: [segment(`${code} (${title})`, children), coded] });
            } else if (s.marker === 0xdd) {
                fields.push(segment(`${code} (${title})`, [field('Interval', p, 2, u16(p), 'MCUs between restart markers (0: none).')], String(u16(p))));
            } else if (s.marker === 0xdc) {
                fields.push(segment(`${code} (${title})`, [field('Lines', p, 2, u16(p))]));
            } else if (s.marker === 0xfe) {
                const text = new TextDecoder('latin1').decode(data.subarray(p, p + size)).replace(/\0+$/, '');
                texts.push({ title: 'Comment', text });
                fields.push(segment(`${code} (${title})`, [field('Text', p, size, text.length > 60 ? `${text.slice(0, 60)}…` : text)]));
            } else if (s.marker >= 0xe0 && s.marker <= 0xef) {
                const app = readApp(data, s, p, size, texts, entries, warnings);
                if (app.exif) exif ??= app.exif;
                if (app.adobe !== undefined) adobe = app.adobe;
                fields.push(segment(`${code} (${app.name})`, app.children, app.value));
            } else {
                fields.push(segment(`${code} (${title})`, [field('Data', p, size, bytesLabel(size))]));
            }
        }

        if (segments.at(-1)?.marker !== 0xd9) warnings.push('The file ends before the end-of-image marker (FF D9).');
        if (end < data.length) {
            // Other pictures can follow the main one (a phone's depth map, MPF's preview), or just padding.
            const trailing = data.subarray(end);
            const embedded: Field[] = [];
            for (let at = 0; at + 3 < trailing.length; at++) {
                if (trailing[at] !== 0xff || trailing[at + 1] !== 0xd8 || trailing[at + 2] !== 0xff) continue;
                const next = segmentsOf(trailing.subarray(at));
                if (next.segments.at(-1)?.marker !== 0xd9) continue;
                const picture = trailing.subarray(at, at + next.end);
                entries.push({ name: null, label: `picture ${entries.length + 2}`, offset: end + at, size: picture.length, data: picture });
                embedded.push(field(`Picture ${entries.length + 1}`, end + at, picture.length, bytesLabel(picture.length), 'Another JPEG after the main one.'));
                at += next.end - 1;
            }
            fields.push(embedded.length ? { name: 'After the picture', offset: end, length: trailing.length, children: embedded } : field('After the picture', end, trailing.length, bytesLabel(trailing.length), 'Not part of the JPEG.'));
        }
        if (!frame) warnings.push('There\'s no frame header (SOF), so no size or picture.');

        let preview: Preview | undefined;
        if (frame && decodable(frame.marker)) {
            try {
                preview = { kind: 'picture', ...decodeJpeg(data, segments) };
            } catch (e) {
                warnings.push(`The picture couldn't be drawn: ${(e as Error).message}`);
            }
        } else if (frame) {
            warnings.push(`${processOf(frame.marker)} pictures aren't drawn here, only described.`);
        }
        if (texts.length) {
            const items = [...(preview ? [{ title: 'Picture', preview }] : []), ...texts.map((t) => ({ title: t.title, preview: { kind: 'text', text: t.text } as Preview }))];
            preview = items.length === 1 ? items[0].preview : { kind: 'stack', items };
        }

        const summary: [string, string][] = [];
        if (frame) {
            summary.push(['Size', `${frame.width} × ${frame.height}`], ['Process', processOf(frame.marker)]);
            summary.push(['Color', colorOf(frame.components, adobe)]);
            if (frame.precision !== 8) summary.push(['Precision', `${frame.precision} bits`]);
        }
        if (scans > 1) summary.push(['Scans', String(scans)]);
        const quality = luminance && ijgQuality(luminance);
        if (quality) summary.push(['Quality', `About ${quality} (IJG scale)`]);
        if (exif) summary.push(...exifSummary(exif));
        warnings.push(...(exif?.warnings ?? []));

        return {
            title: `Picture (JPEG, ${frame ? processOf(frame.marker).toLowerCase() : 'no frame'})`,
            summary,
            fields,
            entries: entries.length ? entries : undefined,
            preview,
            warnings,
        };
    },
};

/** An APPn segment's identifier (a NUL-terminated string at its start) and what's after it. */
function readApp(data: Uint8Array, s: Segment, p: number, size: number, texts: { title: string; text: string }[], entries: Entry[], warnings: string[]): { name: string; value?: string; children: Field[]; exif?: Exif; adobe?: number } {
    const u16 = (at: number) => (data[at] << 8) | data[at + 1];
    let idEnd = p;
    while (idEnd < p + Math.min(size, 80) && data[idEnd] !== 0) idEnd++;
    const id = ascii(data, p, idEnd - p);
    const n = s.marker - 0xe0;
    const idField = field('Identifier', p, Math.min(idEnd + 1, p + size) - p, id);
    const rest = idEnd + 1;
    const restSize = p + size - rest;
    const raw = (name: string, note?: string) => ({ name, children: [idField, field('Data', rest, restSize, bytesLabel(restSize), note)] });

    if (n === 0 && id === 'JFIF') {
        const units = ['none (an aspect ratio)', 'dots per inch', 'dots per cm'][data[rest + 2]] ?? String(data[rest + 2]);
        const [tw, th] = [data[rest + 7], data[rest + 8]];
        return {
            name: 'JFIF',
            value: `${data[rest]}.${String(data[rest + 1]).padStart(2, '0')}`,
            children: [
                idField,
                field('Version', rest, 2, `${data[rest]}.${String(data[rest + 1]).padStart(2, '0')}`),
                field('Units', rest + 2, 1, units),
                field('X density', rest + 3, 2, u16(rest + 3)),
                field('Y density', rest + 5, 2, u16(rest + 5)),
                field('Thumbnail width', rest + 7, 1, tw),
                field('Thumbnail height', rest + 8, 1, th),
                ...(tw * th ? [field('Thumbnail', rest + 9, tw * th * 3, bytesLabel(tw * th * 3), 'Uncompressed RGB.')] : []),
            ],
        };
    }
    if (n === 0 && id === 'JFXX') {
        const code = data[rest];
        const kinds: Record<number, string> = { 0x10: 'JPEG thumbnail', 0x11: '1 byte per pixel thumbnail', 0x13: '3 bytes per pixel thumbnail' };
        if (code === 0x10 && restSize > 1) entries.push({ name: null, label: 'thumbnail', offset: rest + 1, size: restSize - 1, data: data.subarray(rest + 1, rest + restSize) });
        return { name: 'JFIF extension', value: kinds[code], children: [idField, field('Extension code', rest, 1, `0x${hex(code, 2)}${kinds[code] ? ` (${kinds[code]})` : ''}`), field('Thumbnail', rest + 1, restSize - 1, bytesLabel(restSize - 1))] };
    }
    if (n === 0 && id === 'AVI1') {
        return { name: 'AVI1', children: [idField, field('Field', rest, 1, ['Not interlaced', 'Odd', 'Even'][data[rest]] ?? String(data[rest]), 'Which video field this frame was taken from.'), field('Reserved', rest + 1, restSize - 1)] };
    }
    if (n === 0 && id.startsWith('Ocad')) {
        const text = ascii(data, p, size);
        return { name: 'Photobucket', value: text.match(/\$Rev: *(\d+)/)?.[1], children: [field('Text', p, size, text.replace(/\0/g, ' ').trim())] };
    }
    if (n === 1 && id === 'Exif') {
        // "Exif" and two NULs, then the TIFF structure.
        const base = p + 6;
        if (data[base] !== 0x49 && data[base] !== 0x4d) {
            warnings.push('The EXIF segment has no TIFF byte order.');
            return raw('EXIF');
        }
        const exif = readExif(data, base, p + size);
        if (exif.thumbnail) entries.push({ name: null, label: 'exif thumbnail', offset: exif.thumbnail.offset, size: exif.thumbnail.length, data: data.subarray(exif.thumbnail.offset, exif.thumbnail.offset + exif.thumbnail.length) });
        return { name: 'EXIF', children: [field('Identifier', p, 6, 'Exif', 'Then two NULs.'), ...exif.fields], exif };
    }
    if (n === 1 && (id === 'http://ns.adobe.com/xap/1.0/' || id === 'http://ns.adobe.com/xmp/extension/')) {
        const extended = id.endsWith('extension/');
        // Extended XMP chunks start with the full packet's MD5 (32 hex characters), its length and this chunk's offset.
        const at = extended ? rest + 40 : rest;
        const text = new TextDecoder().decode(data.subarray(at, p + size));
        texts.push({ title: extended ? 'XMP (extended)' : 'XMP', text });
        return {
            name: extended ? 'XMP extension' : 'XMP',
            children: [idField, ...(extended ? [field('MD5 of the whole packet', rest, 32, ascii(data, rest, 32)), field('Full length', rest + 32, 4, bytesLabel(((data[rest + 32] << 24) | (data[rest + 33] << 16) | u16(rest + 34)) >>> 0)), field('Offset', rest + 36, 4)] : []), field('Packet', at, p + size - at, bytesLabel(p + size - at), 'XML (RDF) metadata.')],
        };
    }
    if (n === 2 && id === 'ICC_PROFILE') {
        return {
            name: 'ICC profile',
            value: `Part ${data[rest]} of ${data[rest + 1]}`,
            children: [idField, field('Part', rest, 1, data[rest]), field('Parts', rest + 1, 1, data[rest + 1]), field('Profile', rest + 2, restSize - 2, bytesLabel(restSize - 2), 'Profiles over 64 KB are split across segments.')],
        };
    }
    if (n === 2 && id === 'MPF') return raw('Multi-Picture Format', 'Where the other pictures after this one are (TIFF-style).');
    if (n === 2 && id === 'FPXR') return raw('FlashPix');
    if (n === 13 && id === 'Photoshop 3.0') return raw('Photoshop', 'Image resource blocks ("8BIM"), with any IPTC data.');
    if (n === 14 && id === 'Adobe') {
        const transform = data[p + 11];
        return {
            name: 'Adobe',
            value: ['RGB or CMYK', 'YCbCr', 'YCCK'][transform],
            children: [
                field('Identifier', p, 5, 'Adobe'),
                field('Version', p + 5, 2, u16(p + 5)),
                field('Flags 0', p + 7, 2, `0x${hex(u16(p + 7), 4)}`),
                field('Flags 1', p + 9, 2, `0x${hex(u16(p + 9), 4)}`),
                field('Color transform', p + 11, 1, `${transform} (${['None: RGB or CMYK', 'YCbCr', 'YCCK'][transform] ?? 'unknown'})`),
            ],
            adobe: transform,
        };
    }
    if (n === 12 && id === 'Ducky') return raw('Photoshop "Save for Web"');
    return id && /^[\x20-\x7e]+$/.test(id) ? raw(id) : { name: 'Unknown', children: [field('Data', p, size, bytesLabel(size))] };
}

function colorOf(components: { id: number; h: number; v: number }[], adobe: number | null): string {
    if (components.length === 1) return 'Grayscale';
    if (components.length === 4) return adobe === 2 ? 'YCCK' : 'CMYK';
    if (components.length !== 3) return `${components.length} components`;
    if (adobe === 0 || components.map((c) => String.fromCharCode(c.id)).join('') === 'RGB') return 'RGB';
    const [y, cb, cr] = components;
    const subsampling = cb.h === cr.h && cb.v === cr.v ? ({ '1,1': '4:4:4', '2,1': '4:2:2', '2,2': '4:2:0', '1,2': '4:4:0', '4,1': '4:1:1' } as Record<string, string>)[`${y.h / cb.h},${y.v / cb.v}`] : undefined;
    return `YCbCr${subsampling ? ` ${subsampling}` : ''}`;
}

function exifSummary(exif: Exif): [string, string][] {
    const t = exif.tags;
    const out: [string, string][] = [];
    const camera = [t.get('Make'), t.get('Model')].filter((v) => typeof v === 'string' && v) as string[];
    // Models often repeat the make ("Canon" "Canon EOS 40D").
    if (camera.length) out.push(['Camera', camera.length === 2 && camera[1].toLowerCase().startsWith(camera[0].toLowerCase()) ? camera[1] : camera.join(' ')]);
    const taken = t.get('DateTimeOriginal') ?? t.get('DateTime');
    if (typeof taken === 'string' && taken) out.push(['Taken', taken.replace(/^(\d{4}):(\d\d):(\d\d)/, '$1-$2-$3')]);
    const exposure: string[] = [];
    const time = t.get('ExposureTime');
    if (typeof time === 'number' && time > 0) exposure.push(time < 1 ? `1/${Math.round(1 / time)} s` : `${+time.toPrecision(3)} s`);
    const f = t.get('FNumber');
    if (typeof f === 'number' && f > 0) exposure.push(`f/${+f.toPrecision(3)}`);
    const iso = t.get('ISOSpeedRatings');
    if (typeof iso === 'number' && iso > 0) exposure.push(`ISO ${iso}`);
    const focal = t.get('FocalLength');
    if (typeof focal === 'number' && focal > 0) exposure.push(`${+focal.toPrecision(4)} mm`);
    if (exposure.length) out.push(['Exposure', exposure.join(', ')]);
    const orientation = t.get('Orientation');
    if (typeof orientation === 'number' && orientation > 1) out.push(['Orientation', ['', '', 'Mirrored', 'Rotated 180°', 'Mirrored vertically', 'Mirrored, rotated 270°', 'Rotated 90° clockwise', 'Mirrored, rotated 90°', 'Rotated 270° clockwise'][orientation] ?? String(orientation)]);
    if (exif.position) out.push(['GPS', exif.position.map((d) => d.toFixed(6)).join(', ')]);
    return out;
}

export default parser;
