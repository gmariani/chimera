import { bytesLabel, field } from '../../core/bytes';
import type { Entry, Field, FormatParser, Preview } from '../../core/types';
import { chunksOf, decodeTiff } from './decode';
import { COMPRESSIONS, exifSummary, PHOTOMETRICS, readTiff, type Ifd, type Tiff } from './ifd';

/**
 * TIFF pictures (TIFF 6.0): a header, then a chain of IFDs, each a page with
 * its tags, which say where the page's strips or tiles of picture data are and
 * how to read them. Camera raw files (DNG, NEF, CR2) are TIFFs too: their
 * first IFD is usually a preview, with the sensor data in a SubIFD.
 */

/** At most this many strips or tiles are listed per picture. */
const MAX_CHUNKS = 2048;
/** At most this many pages are drawn. */
const MAX_PAGES = 64;

const describe = (tiff: Tiff, ifd: Ifd) => {
    const one = (tag: number) => tiff.values(ifd.entries.get(tag))[0];
    const bits = tiff.values(ifd.entries.get(0x102));
    const photometric = one(0x106);
    return {
        width: one(0x100),
        height: one(0x101),
        compression: COMPRESSIONS[one(0x103) ?? 1] ?? `Compression ${one(0x103)}`,
        color: `${photometric !== undefined ? (PHOTOMETRICS[photometric] ?? `Photometric ${photometric}`) : 'Unknown'}, ${bits.length > 1 ? `${bits.join('/')} bits` : `${bits[0] ?? 1}-bit`}`,
        // NewSubfileType bit 0: a reduced-resolution copy (a thumbnail or preview).
        reduced: ((one(0xfe) ?? 0) & 1) === 1,
    };
};

const parser: FormatParser = {
    parse(data) {
        const magic = data[0] === 0x49 ? data[2] | (data[3] << 8) : (data[2] << 8) | data[3];
        if (magic === 43) throw new Error('BigTIFF (64-bit offsets) isn\'t read yet.');
        if ((data[0] !== 0x49 && data[0] !== 0x4d) || data[0] !== data[1] || magic !== 42) throw new Error('No TIFF header (II or MM, then 42).');
        const tiff = readTiff(data, 0, data.length, 'file');
        const warnings = [...tiff.warnings];
        const fields: Field[] = [...tiff.fields];
        const entries: Entry[] = [];
        const items: { title: string; preview: Preview }[] = [];

        tiff.images.forEach((ifd, i) => {
            // Where its picture data is.
            const { tiled, offsets, counts } = chunksOf(tiff, ifd);
            if (offsets.length) {
                const kind = tiled ? 'Tile' : 'Strip';
                const children = offsets.slice(0, MAX_CHUNKS).map((at, k) => field(`${kind} ${k + 1}`, at, counts[k] ?? 0, bytesLabel(counts[k] ?? 0)));
                const total = counts.reduce((a, b) => a + b, 0);
                const start = Math.min(...offsets);
                const end = Math.max(...offsets.map((at, k) => at + (counts[k] ?? 0)));
                fields.push({ name: `${ifd.name} data`, offset: start, length: end - start, value: `${offsets.length} ${kind.toLowerCase()}${offsets.length === 1 ? '' : 's'}, ${bytesLabel(total)}`, children });
                if (offsets.length > MAX_CHUNKS) warnings.push(`${ifd.name} has ${offsets.length} ${kind.toLowerCase()}s; the first ${MAX_CHUNKS} are listed.`);
            }
            // A JPEG of its own (old-style JPEG, or a camera's preview).
            const [jpegAt] = tiff.values(ifd.entries.get(0x201));
            const [jpegLength] = tiff.values(ifd.entries.get(0x202));
            if (jpegAt !== undefined && jpegLength > 0 && jpegAt + jpegLength <= data.length) {
                fields.push(field(`${ifd.name} JPEG`, jpegAt, jpegLength, bytesLabel(jpegLength), 'A JPEG of its own.'));
                entries.push({ name: null, label: `${ifd.name.replace(/ › /g, ' ')} jpeg`, offset: jpegAt, size: jpegLength, data: data.subarray(jpegAt, jpegAt + jpegLength) });
            }
            if (i >= MAX_PAGES) return;
            const d = describe(tiff, ifd);
            const title = `${ifd.name}: ${d.width} × ${d.height}${d.reduced ? ' (reduced)' : ''}`;
            try {
                items.push({ title, preview: { kind: 'picture', ...decodeTiff(data, tiff, ifd) } });
            } catch (e) {
                warnings.push(`${ifd.name} couldn't be drawn: ${(e as Error).message}`);
            }
        });

        const xmp = tiff.images[0]?.entries.get(0x2bc);
        if (xmp && xmp.at + xmp.count <= data.length) items.push({ title: 'XMP', preview: { kind: 'text', text: new TextDecoder().decode(data.subarray(xmp.at, xmp.at + xmp.count)) } });

        const first = tiff.images[0] && describe(tiff, tiff.images[0]);
        const chain = tiff.images.filter((i) => !i.name.includes('SubIFD')).length;
        const summary: [string, string][] = [];
        if (first) summary.push(['Size', `${first.width} × ${first.height}`], ['Color', first.color], ['Compression', first.compression]);
        if (chain > 1) summary.push(['Pages', String(chain)]);
        if (tiff.images.length > chain) summary.push(['SubIFDs', String(tiff.images.length - chain)]);
        summary.push(['Byte order', tiff.little ? 'Little-endian (II)' : 'Big-endian (MM)']);
        summary.push(...exifSummary(tiff));

        return {
            title: `Picture (TIFF${tiff.tags.has('DNGVersion') ? ', DNG' : ''})`,
            summary,
            fields,
            entries: entries.length ? entries : undefined,
            preview: items.length === 1 ? items[0].preview : items.length ? { kind: 'stack', items } : undefined,
            warnings,
        };
    },
};

export default parser;
