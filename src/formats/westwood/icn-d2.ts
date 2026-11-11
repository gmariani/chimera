import { Bytes, bytesLabel, field } from '../../core/bytes';
import { checkBytes, checkCount } from '../../core/limits';
import type { Field, FormatParser, IndexedImage } from '../../core/types';
import { type DecodeInfo, lcw } from './compression';

/**
 * Dune II's map tiles (ICON.ICN): every piece of sand, rock, spice, wall and
 * building on the map, as 16 × 16 tiles in 16 colors. An IFF file, "FORM" of
 * type "ICON", whose chunks are:
 *
 * - SINF: the tile size, in 8-pixel steps (2 × 2 for 16 × 16), then two
 *   values the game doesn't read (3, and the bits a pixel, 4).
 * - SSET: the tiles' pixels, two a byte (the left one in the high half),
 *   behind the same small header a CPS picture has: a compression (0 for
 *   none, 4 for LCW), the decoded size, and a palette size.
 * - RPAL: palettes of 16 colors, each a color of the game palette (IBM.PAL).
 * - RTBL: for each tile, which of those palettes it's drawn with.
 *
 * A tile whose palette starts with color 0 is drawn with 0 left transparent
 * (the edges of buildings and units). ICON.MAP, beside it, groups the tiles
 * into what they make up. ModdingWiki has no page for the format; this follows
 * OpenDUNE's loader and drawing code (src/sprites.c Tiles_LoadICNFile,
 * src/gfx.c GFX_DrawTile): https://github.com/OpenDUNE/OpenDUNE.
 */

const CHUNKS: Record<string, string> = {
    SINF: 'The tile size',
    SSET: 'The tiles’ pixels',
    RPAL: 'The palettes',
    RTBL: 'Which palette each tile uses',
};
const MAX_SHOWN = 4096;

interface Chunk {
    id: string;
    at: number;
    size: number;
    /** Where its data starts and ends (the end clipped to the file). */
    start: number;
    end: number;
}

/** The chunks of a FORM/ICON file, or null if it isn't one. */
export function icnChunks(data: Uint8Array): { formEnd: number; chunks: Chunk[] } | null {
    const b = new Bytes(data);
    if (data.length < 12 || b.ascii(0, 4) !== 'FORM' || b.ascii(8, 4) !== 'ICON') return null;
    const formEnd = Math.min(data.length, 8 + b.u32be(4));
    const chunks: Chunk[] = [];
    let at = 12;
    while (at + 8 <= formEnd) {
        const id = b.ascii(at, 4);
        // A chunk ID is four printable characters; anything else means the list has gone wrong.
        if (!/^[\x20-\x7e]{4}$/.test(id)) break;
        const size = b.u32be(at + 4);
        const start = at + 8;
        chunks.push({ id, at, size, start, end: Math.min(start + size, data.length) });
        // Chunks are padded to an even length.
        at = start + size + (size & 1);
    }
    return { formEnd, chunks };
}

const parser: FormatParser = {
    parse(data) {
        const layout = icnChunks(data);
        if (!layout) throw new Error('This isn\'t a Dune II tile file: it doesn\'t start with an IFF "FORM" of type "ICON".');
        const { formEnd, chunks } = layout;
        const b = new Bytes(data);
        const warnings: string[] = [];

        const formSize = b.u32be(4);
        if (8 + formSize > data.length) warnings.push(`The FORM says it's ${bytesLabel(8 + formSize)}, but the file is ${bytesLabel(data.length)}.`);
        const byId = new Map<string, Chunk>();
        for (const c of chunks) {
            if (c.start + c.size > data.length) warnings.push(`The ${c.id} chunk says it's ${bytesLabel(c.size)}, but only ${bytesLabel(data.length - c.start)} are left.`);
            if (!(c.id in CHUNKS)) warnings.push(`There's a ${c.id} chunk, which Dune II's tile files don't have; the game skips it.`);
            else if (byId.has(c.id)) warnings.push(`There are two ${c.id} chunks; the game reads only the first.`);
            else byId.set(c.id, c);
        }
        const last = chunks.at(-1);
        const chunksEnd = last ? Math.min(formEnd, last.start + last.size + (last.size & 1)) : 12;
        if (chunksEnd < formEnd) warnings.push(`${bytesLabel(formEnd - chunksEnd)} at the end of the FORM aren't a chunk.`);
        const missing = Object.keys(CHUNKS).filter((id) => !byId.has(id));
        if (missing.length) throw new Error(`This tile file has no ${missing.join(', ')} chunk${missing.length === 1 ? '' : 's'}, which the game needs.`);
        const sinf = byId.get('SINF')!;
        const sset = byId.get('SSET')!;
        const rpal = byId.get('RPAL')!;
        const rtbl = byId.get('RTBL')!;

        // The tile size: the game only takes square tiles of 8 or 16 pixels (anything else, it draws nothing).
        if (sinf.size < 4) throw new Error(`The SINF chunk is ${bytesLabel(sinf.size)}; it needs 4.`);
        const [across, down, shift, bits] = [data[sinf.start], data[sinf.start + 1], data[sinf.start + 2], data[sinf.start + 3]];
        if (across !== down || across === 0 || across > 2) throw new Error(`The tiles would be ${across * 8} × ${down * 8}; Dune II only draws square tiles of 8 or 16 pixels.`);
        if (bits !== 4) warnings.push(`SINF says ${bits} bits a pixel; the tiles are always 4 (the game reads them as 4 whatever this says).`);
        const width = across * 8;
        const height = down * 8;
        const tileBytes = (width * height) / 2;

        // The pixels, behind a CPS-style header.
        if (sset.end - sset.start < 8) throw new Error('The SSET chunk is too short for its header.');
        const compression = b.u16(sset.start);
        const decodedSize = b.u32(sset.start + 2);
        const paletteSize = b.u16(sset.start + 6);
        const dataStart = sset.start + 8 + paletteSize;
        if (compression !== 0 && compression !== 4) throw new Error(`The tiles' compression is ${compression}; the game reads only 0 (none) and 4 (LCW).`);
        if (paletteSize) warnings.push(`The SSET chunk carries a ${bytesLabel(paletteSize)} palette, which the game skips.`);
        if (dataStart > sset.end) throw new Error('The SSET chunk ends inside its own header.');
        const stored = data.subarray(dataStart, sset.end);
        // LCW makes at most about 64 bytes from each; a size claiming more is wrong (or made to exhaust memory).
        const room = checkBytes(Math.min(decodedSize, compression === 0 ? stored.length : stored.length * 64), 'The tiles', 1 << 24);
        let pixels4: Uint8Array;
        const info: DecodeInfo = { read: stored.length, ended: true, badRefs: 0 };
        if (compression === 0) {
            pixels4 = stored.subarray(0, room);
            if (stored.length !== decodedSize) warnings.push(`The SSET header says ${bytesLabel(decodedSize)} of pixels, but ${bytesLabel(stored.length)} are there.`);
        } else {
            pixels4 = new Uint8Array(room);
            const n = lcw(stored, pixels4, 0, info);
            pixels4 = pixels4.subarray(0, n);
            if (n !== decodedSize) warnings.push(`The tiles decompress to ${bytesLabel(n)}, but the SSET header says ${bytesLabel(decodedSize)}.`);
            if (info.badRefs)
                warnings.push(
                    `The LCW data copies from outside what it's decoded so far ${info.badRefs.toLocaleString('en-US')} time${info.badRefs === 1 ? '' : 's'}: it's damaged, or made to trip up a decoder.`
                );
            if (!info.ended) warnings.push('The LCW data has no end marker.');
        }
        if (pixels4.length % tileBytes)
            warnings.push(
                `The pixels (${bytesLabel(pixels4.length)}) aren't a whole number of ${width} × ${height} tiles (${tileBytes} bytes each); the last ${pixels4.length % tileBytes} bytes are left out.`
            );
        const tiles = checkCount(Math.floor(pixels4.length / tileBytes), tileBytes, pixels4.length, 'tiles');

        // The palettes, and which each tile uses.
        if (rpal.size % 16) warnings.push(`The palettes take ${bytesLabel(rpal.size)}, which isn't a whole number of 16-color palettes.`);
        const palettes = Math.floor((rpal.end - rpal.start) / 16);
        if (rtbl.size !== tiles)
            warnings.push(
                `There are ${tiles.toLocaleString('en-US')} tile${tiles === 1 ? '' : 's'} but ${rtbl.size.toLocaleString('en-US')} entr${rtbl.size === 1 ? 'y' : 'ies'} saying which palette each uses.`
            );
        let pastPalettes = 0;
        const used = new Set<number>();
        for (let t = 0; t < Math.min(tiles, rtbl.end - rtbl.start); t++) {
            const p = data[rtbl.start + t];
            if (p >= palettes) pastPalettes++;
            else used.add(p);
        }
        if (pastPalettes) warnings.push(`${pastPalettes.toLocaleString('en-US')} tile${pastPalettes === 1 ? ' uses a palette' : 's use palettes'} past the ${palettes} there are.`);

        // Each tile, in the game palette's colors: each 4-bit color through the tile's own palette.
        const frames: IndexedImage[] = [];
        let transparent = 0;
        for (let t = 0; t < Math.min(tiles, MAX_SHOWN); t++) {
            const p = t < rtbl.end - rtbl.start ? data[rtbl.start + t] : 0;
            const pal = p < palettes ? data.subarray(rpal.start + p * 16, rpal.start + p * 16 + 16) : new Uint8Array(16);
            if (pal[0] === 0) transparent++;
            const pixels = new Uint8Array(width * height);
            const from = t * tileBytes;
            for (let i = 0; i < tileBytes; i++) {
                const v = pixels4[from + i];
                pixels[i * 2] = pal[v >> 4];
                pixels[i * 2 + 1] = pal[v & 15];
            }
            frames.push({ width, height, pixels });
        }

        const chunkFields: Field[] = chunks.map((c) => {
            const length = Math.min(8 + c.size + (c.size & 1), data.length - c.at);
            const children: Field[] = [
                field('ID', c.at, 4, JSON.stringify(c.id)),
                field('Size', c.at + 4, 4, bytesLabel(c.size), 'Big-endian. Not counting these 8 bytes, or the byte that pads an odd size.'),
            ];
            if (c === sinf)
                children.push(
                    field('Tiles across', c.start, 1, `${across} (${width} pixels)`, 'In 8-pixel steps.'),
                    field('Tiles down', c.start + 1, 1, `${down} (${height} pixels)`),
                    field('Unknown', c.start + 2, 1, shift, 'The game doesn’t read it (3 in its own file).'),
                    field('Bits a pixel', c.start + 3, 1, bits, 'The game doesn’t read it; the tiles are always 4.')
                );
            else if (c === sset)
                children.push(
                    field('Compression', c.start, 2, compression, compression === 4 ? 'LCW.' : 'None.'),
                    field('Decoded size', c.start + 2, 4, bytesLabel(decodedSize)),
                    field('Palette size', c.start + 6, 2, paletteSize),
                    field('Pixels', dataStart, sset.end - dataStart, `${tiles.toLocaleString('en-US')} tiles`, `Two pixels a byte, the left in the high half; ${tileBytes} bytes a tile.`)
                );
            else if (c === rpal) children.push(field('Palettes', c.start, c.end - c.start, `${palettes} × 16 colors`, 'Each a color of the game palette.'));
            else if (c === rtbl) children.push(field('Palette of each tile', c.start, c.end - c.start, `${(c.end - c.start).toLocaleString('en-US')} tiles`));
            else if (c.end > c.start) children.push(field('Data', c.start, c.end - c.start, bytesLabel(c.end - c.start)));
            if (c.size & 1 && c.end < data.length) children.push(field('Padding', c.end, 1, 'To an even length.'));
            return { name: `${c.id} chunk`, offset: c.at, length, value: CHUNKS[c.id] ?? 'Not one the game reads', children };
        });

        return {
            title: 'Map tiles (Dune II ICN)',
            summary: [
                ['Tiles', `${tiles.toLocaleString('en-US')}, ${width} × ${height}${tiles > MAX_SHOWN ? ` (the first ${MAX_SHOWN} shown)` : ''}`],
                ['Palettes', `${palettes} of 16 colors (${used.size} used), into the game palette`],
                ['Compression', compression === 4 ? 'LCW' : 'None'],
                ['Transparent', `${transparent.toLocaleString('en-US')} tile${transparent === 1 ? ' has' : 's have'} see-through edges`],
            ],
            fields: [
                {
                    name: 'FORM header',
                    offset: 0,
                    length: 12,
                    children: [field('ID', 0, 4, '"FORM"', 'An IFF file.'), field('Size', 4, 4, bytesLabel(formSize), 'Big-endian. Everything after these 8 bytes.'), field('Type', 8, 4, '"ICON"')],
                },
                ...chunkFields,
            ],
            preview: { kind: 'images', frames, transparentIndex: 0 },
            // Past the FORM is nothing the file has; the usual checks look at it.
            end: Math.max(chunksEnd, Math.min(formEnd, data.length)),
            warnings,
        };
    },
};

export default parser;
