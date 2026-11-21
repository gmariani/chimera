import { Bytes, bytesLabel, field } from '../../core/bytes';
import type { Field } from '../../core/types';
import { decodeDib } from '../dib';
import { unpackHelp, unpackRuns } from './lz77';

/**
 * Pictures as Windows Help keeps them, in its |bm files and inside topics, and as the SHG (hotspot editor) and MRB
 * (multi-resolution bitmap) files it was given them in: "lP" or "lp", how many pictures (several resolutions of one),
 * where each is. Each is a bitmap (5, device-dependent; 6, a DIB) or a metafile (8), packed as it is (0), in runs (1),
 * in LZ77 (2) or both (3); a header of compressed numbers (resolution, planes, bits a pixel, size, colors, where its
 * data and hotspots are), a DIB's colors, then the data, and the hotspots: each a kind (a jump, a popup, a macro), a
 * rectangle, and a name and a target. As helpdeco's helpfile.txt describes them; a DDB's rows padded to 2 bytes and
 * drawn in black and white, as helpdeco draws them (it's the ground truth the tests compare with).
 */

export interface Hotspot {
    kind: string;
    /** Its code: 0xC8 and 0xCC a macro, 0xE2 to 0xE7 a popup or jump by context name, 0xEA to 0xEF into another file or window. */
    code: number;
    /** The context name's hash, for 0xE2 to 0xE7. */
    hash: number;
    x: number;
    y: number;
    width: number;
    height: number;
    name: string;
    target: string;
}

export interface HelpPicture {
    kind: 'bitmap' | 'metafile';
    width: number;
    height: number;
    about: string;
    /** Drawn, for a bitmap that could be. */
    rgba?: Uint8Array;
    /** The picture as a file of its own: a .bmp, or a .wmf with a placeable header. */
    file?: Uint8Array;
    hotspots: Hotspot[];
}

const KINDS: Record<number, string> = { 5: 'device-dependent bitmap', 6: 'bitmap (DIB)', 8: 'metafile' };
const PACKING = ['as it is', 'in runs', 'LZ77', 'LZ77 and runs'];
const HOTSPOTS: Record<number, string> = {
    0xc8: 'macro',
    0xcc: 'macro, invisible',
    0xe2: 'popup',
    0xe3: 'jump',
    0xe6: 'popup, invisible',
    0xe7: 'jump, invisible',
    0xea: 'popup into another file',
    0xeb: 'jump into another file or window',
    0xee: 'popup into another file, invisible',
    0xef: 'jump into another file or window, invisible',
};

/** The most a picture is unpacked to: no help picture comes near it. */
const MOST = 1 << 26;

/** Reads the SHG/MRB container at `at` (its "lP"), at most to `end`; offsets in it count from `at`. */
export function readPictures(data: Uint8Array, at: number, end: number, what: string): { pictures: HelpPicture[]; fields: Field[]; problems: string[] } {
    const b = new Bytes(data);
    const problems: string[] = [];
    const pictures: HelpPicture[] = [];
    const magic = b.u16(at);
    const count = b.u16(at + 2);
    if (at + 4 > end || (magic !== 0x506c && magic !== 0x706c)) return { pictures, fields: [], problems: [`${what} isn’t a picture: it doesn’t start with "lP" or "lp".`] };
    if (at + 4 + count * 4 > end) return { pictures, fields: [], problems: [`${what} says it has ${count} pictures, more than fit in it.`] };
    const fields: Field[] = [
        {
            name: 'Header',
            offset: at,
            length: 4 + count * 4,
            value: `${count} picture${count === 1 ? '' : 's'}`,
            children: [
                field('Signature', at, 2, magic === 0x506c ? 'lP (SHG)' : 'lp (MRB)'),
                field('Pictures', at + 2, 2, count),
                ...Array.from({ length: count }, (_, i) => field(`Picture ${i + 1} at`, at + 4 + i * 4, 4, b.u32(at + 4 + i * 4))),
            ],
        },
    ];
    for (let i = 0; i < count; i++) {
        const p = at + b.u32(at + 4 + i * 4);
        const name = count > 1 ? `${what}, picture ${i + 1}` : what;
        if (p + 2 > end) {
            problems.push(`${name} is said to be past the end of what holds it.`);
            continue;
        }
        const type = data[p];
        const packing = data[p + 1];
        if (!KINDS[type] || packing > 3) {
            problems.push(`${name} is of kind ${type}, packed by method ${packing}, which Windows Help doesn’t have.`);
            fields.push(field(`Picture ${i + 1}`, p, 2, `kind ${type}, packing ${packing}`));
            continue;
        }
        // The compressed numbers: a byte or a word, or a word or a long, the low bit saying which, the value above it.
        let q = p + 2;
        const word = () => {
            const v = data[q] & 1 ? b.u16(q) >> 1 : data[q] >> 1;
            q += data[q] & 1 ? 2 : 1;
            return v;
        };
        const long = () => {
            const v = data[q] & 1 ? b.u32(q) >>> 1 : b.u16(q) >> 1;
            q += data[q] & 1 ? 4 : 2;
            return v;
        };
        const children: Field[] = [field('Kind', p, 1, KINDS[type]), field('Packing', p + 1, 1, PACKING[packing])];
        const numbers = (labels: [string, () => number][]) =>
            Object.fromEntries(
                labels.map(([label, read]) => {
                    const from = q;
                    const v = read();
                    children.push(field(label, from, q - from, v));
                    return [label, v];
                })
            );
        let picture: HelpPicture;
        let dataAt: number;
        let packedSize: number;
        let hotspotSize: number;
        let hotspotAt: number;
        if (type === 8) {
            const n = numbers([['Mapping mode', word]]);
            const width = b.u16(q);
            const height = b.u16(q + 2);
            children.push(field('Width', q, 2, width), field('Height', q + 2, 2, height));
            q += 4;
            const m = numbers([
                ['Size unpacked', long],
                ['Size packed', long],
                ['Hotspots size', long],
            ]);
            dataAt = p + b.u32(q);
            hotspotAt = p + b.u32(q + 4);
            children.push(field('Data at', q, 4, b.u32(q)), field('Hotspots at', q + 4, 4, b.u32(q + 4)));
            q += 8;
            packedSize = m['Size packed'];
            hotspotSize = m['Hotspots size'];
            picture = { kind: 'metafile', width, height, about: `metafile, mapping mode ${n['Mapping mode']}`, hotspots: [] };
            const raw = unpack(data.subarray(dataAt, Math.min(end, dataAt + packedSize)), packing, Math.min(m['Size unpacked'] || MOST, MOST));
            if (dataAt + packedSize > end) problems.push(`${name}’s data runs past the end of what holds it.`);
            // A placeable header (Aldus's): its key, the box (0, 0, width, height), 2,540 units an inch, its checksum.
            const head = new Uint8Array(22);
            const v = new DataView(head.buffer);
            v.setUint32(0, 0x9ac6cdd7, true);
            v.setUint16(10, width, true);
            v.setUint16(12, height, true);
            v.setUint16(14, 2540, true);
            let sum = 0;
            for (let k = 0; k < 20; k += 2) sum ^= v.getUint16(k, true);
            v.setUint16(20, sum, true);
            picture.file = Uint8Array.from([...head, ...raw]);
        } else {
            const n = numbers([
                ['Dots an inch across', long],
                ['Dots an inch down', long],
                ['Planes', word],
                ['Bits a pixel', word],
                ['Width', long],
                ['Height', long],
                ['Colors used', long],
                ['Colors important', long],
                ['Size packed', long],
                ['Hotspots size', long],
            ]);
            dataAt = p + b.u32(q);
            hotspotAt = p + b.u32(q + 4);
            children.push(field('Data at', q, 4, b.u32(q)), field('Hotspots at', q + 4, 4, b.u32(q + 4)));
            q += 8;
            const bits = n['Bits a pixel'];
            const [width, height] = [n.Width, n.Height];
            packedSize = n['Size packed'];
            hotspotSize = n['Hotspots size'];
            const colors = bits <= 8 ? n['Colors used'] || 1 << bits : n['Colors used'];
            const transparent = n['Colors important'] === 1;
            picture = { kind: 'bitmap', width, height, about: `${bits <= 8 ? `${colors} colors` : `${bits}-bit`}${transparent ? ', white see-through' : ''}`, hotspots: [] };
            // A DIB's colors follow its header; a DDB has none, and is black and white.
            const palette = type === 6 ? data.subarray(q, Math.min(end, q + colors * 4)) : Uint8Array.of(0, 0, 0, 0, 255, 255, 255, 0);
            if (type === 6) {
                children.push(field('Colors', q, palette.length, `${palette.length / 4}`, 'Blue, green, red and a spare byte each.'));
                q += palette.length;
            }
            const stride = Math.floor((width * bits + 31) / 32) * 4;
            const need = stride * height;
            if (width <= 0 || height <= 0 || ![1, 4, 8, 16, 24, 32].includes(bits)) problems.push(`${name} says it’s ${width} × ${height} at ${bits} bits a pixel, which can’t be drawn.`);
            else if (need > MOST) problems.push(`${name} says it’s ${width.toLocaleString('en-US')} × ${height.toLocaleString('en-US')}: more than is drawn here.`);
            else {
                let pixels = unpack(data.subarray(dataAt, Math.min(end, dataAt + packedSize)), packing, Math.min(type === 5 ? Math.ceil((width * bits) / 16) * 2 * height : need, MOST));
                if (dataAt + packedSize > end) problems.push(`${name}’s data runs past the end of what holds it.`);
                if (type === 5) {
                    // A DDB's rows are padded to 2 bytes: to 4, as a DIB's.
                    const from = Math.ceil((width * bits) / 16) * 2;
                    const dib = new Uint8Array(need);
                    for (let y = 0; y < height; y++) dib.set(pixels.subarray(y * from, Math.min(pixels.length, (y + 1) * from)), y * stride);
                    pixels = dib;
                }
                if (pixels.length < need) problems.push(`${name} unpacks to ${bytesLabel(pixels.length)}, short of the ${bytesLabel(need)} its pixels take: the rest is drawn black.`);
                const header = new Uint8Array(40);
                const v = new DataView(header.buffer);
                v.setUint32(0, 40, true);
                v.setInt32(4, width, true);
                v.setInt32(8, height, true);
                v.setUint16(12, 1, true);
                v.setUint16(14, bits, true);
                v.setUint32(20, need, true);
                v.setUint32(32, palette.length / 4, true);
                const dib = new Uint8Array(40 + palette.length + need);
                dib.set(header);
                dib.set(palette, 40);
                dib.set(pixels.subarray(0, need), 40 + palette.length);
                const drawn = decodeDib(dib, 0, dib.length, false);
                if ('problem' in drawn) problems.push(`${name} can’t be drawn: ${drawn.problem}.`);
                else picture.rgba = drawn.rgba;
                // As a .bmp: the 14-byte file header, then the DIB.
                const file = new Uint8Array(14 + dib.length);
                const f = new DataView(file.buffer);
                file.set([0x42, 0x4d]);
                f.setUint32(2, file.length, true);
                f.setUint32(10, 14 + 40 + palette.length, true);
                file.set(dib, 14);
                picture.file = file;
            }
        }
        // The header's fields go under the picture; its data and hotspots are where they are, after it.
        const own = { name: `Picture ${i + 1}`, offset: p, length: q - p, value: `${picture.width} × ${picture.height}, ${picture.about}`, children: [...children] };
        const after: Field[] = [];
        if (dataAt >= at && dataAt < end) after.push(field(`Picture ${i + 1}’s data`, dataAt, Math.min(end, dataAt + packedSize) - dataAt, `${bytesLabel(packedSize)}, ${PACKING[packing]}`));
        // The hotspots: a header, each one's kind and rectangle, data for macros, then each one's name and target.
        if (hotspotSize && hotspotAt > p && hotspotAt + 7 <= end) {
            const n = b.u16(hotspotAt + 1);
            const macros = b.u32(hotspotAt + 3);
            let s = hotspotAt + 7 + n * 15 + macros;
            for (let k = 0; k < n && hotspotAt + 7 + k * 15 + 15 <= end; k++) {
                const h = hotspotAt + 7 + k * 15;
                const nameEnd = data.indexOf(0, s);
                const targetEnd = nameEnd < 0 ? -1 : data.indexOf(0, nameEnd + 1);
                if (targetEnd < 0 || targetEnd >= Math.min(end, hotspotAt + hotspotSize)) {
                    problems.push(`${name}’s hotspots run past the end of where they are.`);
                    break;
                }
                const text = (from: number, to: number) => new TextDecoder('windows-1252').decode(data.subarray(from, to));
                picture.hotspots.push({
                    kind: HOTSPOTS[data[h]] ?? `kind 0x${data[h].toString(16)}`,
                    code: data[h],
                    hash: b.u32(h + 11),
                    x: b.u16(h + 3),
                    y: b.u16(h + 5),
                    width: b.u16(h + 7),
                    height: b.u16(h + 9),
                    name: text(s, nameEnd),
                    target: text(nameEnd + 1, targetEnd),
                });
                s = targetEnd + 1;
            }
            after.push(field(`Picture ${i + 1}’s hotspots`, hotspotAt, Math.min(hotspotSize, end - hotspotAt), `${picture.hotspots.length}`, 'Each a kind, a rectangle, a name and a target.'));
        }
        pictures.push(picture);
        fields.push(own, ...after);
    }
    return { pictures, fields, problems };
}

/** A picture's data unpacked: LZ77, then runs, as its packing says. */
function unpack(packed: Uint8Array, packing: number, limit: number): Uint8Array {
    // Packed both ways, LZ77 unpacks to the runs, which unpack to the picture: the limit is on the picture.
    const lz = packing & 2 ? unpackHelp(packed, packing & 1 ? MOST : limit).data : packed;
    return packing & 1 ? unpackRuns(lz, limit) : lz.subarray(0, limit);
}
