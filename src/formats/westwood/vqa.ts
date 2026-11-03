import { Bytes, bytesLabel, field } from '../../core/bytes';
import type { Field, FormatParser } from '../../core/types';

/**
 * Westwood's VQA video: an IFF file of big-endian chunks. This maps the chunks
 * and reads the VQHD header; it doesn't decode the video.
 */

const CHUNKS: Record<string, string> = {
    VQHD: 'Video header: size, frame count, frame rate.',
    FINF: 'Frame index: where each frame starts (in 2-byte units).',
    VQFR: 'One frame: codebook updates and the vector pointers.',
    VQFL: 'Codebook and palette changes for the next frames.',
    SND0: 'Uncompressed audio.',
    SND1: 'Westwood ADPCM audio.',
    SND2: 'IMA ADPCM audio.',
    CBF0: 'Full codebook.',
    CBFZ: 'Full codebook, LCW-compressed.',
    CBP0: 'Part of a codebook.',
    CBPZ: 'Part of a codebook, LCW-compressed.',
    CPL0: 'Palette.',
    CPLZ: 'Palette, LCW-compressed.',
    VPTZ: 'Vector pointers, LCW-compressed.',
    VPTR: 'Vector pointers.',
    CINF: 'Codebook info.',
    CINH: 'Codebook info header.',
};

/** Children are only listed for these: a VQFR is a container of sub-chunks. */
const CONTAINERS = new Set(['VQFR', 'VQFL']);
const MAX_LISTED = 20_000;

const parser: FormatParser = {
    parse(data) {
        const b = new Bytes(data);
        const be = (at: number) => (at + 4 <= data.length ? b.view.getUint32(at, false) : 0);

        const walk = (start: number, end: number, depth: number): Field[] => {
            const out: Field[] = [];
            let at = start;
            while (at + 8 <= end && out.length < MAX_LISTED) {
                const id = b.ascii(at, 4);
                const size = be(at + 4);
                const length = Math.min(8 + size, end - at);
                const chunk: Field = { name: id, offset: at, length, value: bytesLabel(size), note: CHUNKS[id] };
                if (depth === 0 && CONTAINERS.has(id)) chunk.children = walk(at + 8, at + length, 1);
                out.push(chunk);
                at += 8 + size + (size & 1);
            }
            return out;
        };

        const chunks = walk(12, data.length, 0);
        const header = chunks.find((c) => c.name === 'VQHD');
        const h = header ? header.offset + 8 : -1;
        const frames = h >= 0 ? b.u16(h + 4) : 0;
        const width = h >= 0 ? b.u16(h + 6) : 0;
        const height = h >= 0 ? b.u16(h + 8) : 0;
        const fps = h >= 0 ? b.u8(h + 12) : 0;
        if (header) {
            header.children = [
                field('Version', h, 2, b.u16(h)),
                field('Flags', h + 2, 2, b.u16(h + 2)),
                field('Frames', h + 4, 2, frames),
                field('Width', h + 6, 2, width),
                field('Height', h + 8, 2, height),
                field('Block width', h + 10, 1, b.u8(h + 10)),
                field('Block height', h + 11, 1, b.u8(h + 11)),
                field('Frame rate', h + 12, 1, `${fps} fps`),
                field('Codebook interval', h + 13, 1, b.u8(h + 13), 'A new codebook every this many frames.'),
            ];
        }
        const frameChunks = chunks.filter((c) => c.name === 'VQFR').length;

        return {
            title: 'Video (VQA)',
            summary: [
                ['Size', `${width} × ${height}`],
                ['Frames', `${frames}${fps ? `, ${(frames / fps).toFixed(1)} s at ${fps} fps` : ''}`],
                ['Chunks', `${chunks.length}${chunks.length >= MAX_LISTED ? '+' : ''}`],
            ],
            fields: [
                { name: 'FORM', offset: 0, length: 12, value: 'WVQA', children: [field('ID', 0, 4, 'FORM'), field('Size', 4, 4, bytesLabel(be(4)), 'Big-endian, like every IFF size.'), field('Type', 8, 4, 'WVQA')] },
                ...chunks,
            ],
            warnings: chunks.length >= MAX_LISTED ? [`Only the first ${MAX_LISTED} chunks are listed (${frameChunks} frames).`] : [],
        };
    },
};

export default parser;
