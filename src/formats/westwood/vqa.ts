import { Bytes, bytesLabel, field } from '../../core/bytes';
import type { AudioClip, Field, FormatParser, VideoFrame } from '../../core/types';
import { decodeIma, decodeWestwood, imaSample, wav } from './adpcm';
import { lcw } from './compression';
import { expandPalette } from './vga';
import { append } from '../../core/math';

/**
 * Westwood's VQA video: an IFF file of big-endian chunks. TD and RA use
 * version 2: each frame is a grid of small blocks (4 × 2 pixels, or 4 × 4),
 * and each block is either one color or an entry in a codebook of blocks.
 * A full codebook comes first; after that, each frame carries a slice of the
 * next one, which replaces the current codebook once all its slices are in
 * (every "codebook interval" frames). Sound is interleaved, chunk by chunk.
 *
 * Sound is IMA ADPCM (SND2), Westwood ADPCM (SND1) or raw (SND0). In stereo,
 * version 2 alternates bytes between the channels; version 3 puts each chunk's
 * left channel in its first half and the right in its second.
 *
 * Tiberian Sun's movies are version 3 in high color (flag 0x10): the codebook
 * holds 15-bit RGB pixels, and each frame is a list of 16-bit commands (VPRZ,
 * VPTR) that skip blocks (keeping the last frame's) or write codebook blocks,
 * one or many times.
 */

const CHUNKS: Record<string, string> = {
    VQHD: 'Video header: size, frame count, frame rate, sound format.',
    FINF: 'Frame index: where each frame starts (in 2-byte units).',
    VQFR: 'One frame: codebook updates, palette, and the block pointers.',
    VQFL: 'Codebook and palette changes for the next frames.',
    SND0: 'Uncompressed sound.',
    SND1: 'Westwood ADPCM sound.',
    SND2: 'IMA ADPCM sound.',
    SN2J: 'Where the sound chunks are, for seeking.',
    PINF: 'Palette info.',
    CBF0: 'Full codebook.',
    CBFZ: 'Full codebook, LCW-compressed.',
    CBP0: 'A slice of the next codebook.',
    CBPZ: 'A slice of the next codebook, LCW-compressed (once all the slices are joined).',
    CPL0: 'Palette.',
    CPLZ: 'Palette, LCW-compressed.',
    VPTZ: 'Block pointers, LCW-compressed.',
    VPT0: 'Block pointers.',
    VPTR: 'Block pointers; in high-color movies, block commands.',
    VPRZ: 'Block commands, LCW-compressed (high-color movies).',
    CINF: 'Codebook info.',
    CINH: 'Codebook info header.',
};

/** Children are only listed for these: a VQFR is a container of sub-chunks. */
const CONTAINERS = new Set(['VQFR', 'VQFL']);
const MAX_LISTED = 20_000;

interface Chunk {
    id: string;
    start: number;
    end: number;
}

interface Header {
    version: number;
    frames: number;
    width: number;
    height: number;
    blockWidth: number;
    blockHeight: number;
    interval: number;
}

/**
 * Plays the frames in order, keeping the codebook and palette as it goes.
 * Going back starts again from the first frame, but frames before the one
 * wanted only have their codebook and palette changes applied, which is quick.
 */
class Decoder {
    private codebook!: Uint8Array;
    private slices: Uint8Array[] = [];
    private compressedSlices = false;
    private countdown = 0;
    private palette = new Uint8Array(768);
    private position = -1;
    private readonly blockSize: number;
    private readonly pointers: Uint8Array;
    /** A block pointer's high byte that means "one color: the low byte" instead of a codebook entry. */
    private readonly solid: number;

    constructor(
        private readonly data: Uint8Array,
        private readonly header: Header,
        private readonly frames: Chunk[][],
    ) {
        this.blockSize = header.blockWidth * header.blockHeight;
        this.pointers = new Uint8Array((header.width / header.blockWidth) * (header.height / header.blockHeight) * 2);
        this.solid = header.blockHeight === 4 ? 0xff : 0x0f;
        this.reset();
    }

    private reset() {
        this.codebook = new Uint8Array(0x10000 * this.blockSize);
        this.slices = [];
        this.countdown = this.header.interval;
        this.palette = new Uint8Array(768);
        this.position = -1;
    }

    private body(c: Chunk) {
        return this.data.subarray(c.start, c.end);
    }

    private unpack(c: Chunk, size: number): Uint8Array {
        const out = new Uint8Array(size);
        const written = lcw(this.body(c), out);
        return out.subarray(0, written);
    }

    /** Applies one frame's changes; draws it if `pixels` is given. */
    private step(index: number, pixels?: Uint8Array) {
        const chunks = this.frames[index];
        for (const c of chunks) {
            if (c.id === 'CPL0' || c.id === 'CPLZ') {
                const six = c.id === 'CPLZ' ? this.unpack(c, 768) : this.body(c);
                this.palette = new Uint8Array(768);
                this.palette.set(expandPalette(six.subarray(0, 768)));
            } else if (c.id === 'CBF0') {
                this.codebook.set(this.body(c).subarray(0, this.codebook.length));
            } else if (c.id === 'CBFZ') {
                this.codebook.set(this.unpack(c, this.codebook.length));
            }
        }
        const vectors = chunks.find((c) => c.id === 'VPTZ' || c.id === 'VPT0' || c.id === 'VPTR');
        if (pixels && vectors) this.draw(vectors, pixels);
        // A finished set of slices takes over after this frame is drawn.
        const slice = chunks.find((c) => c.id === 'CBP0' || c.id === 'CBPZ');
        if (slice) {
            this.slices.push(this.body(slice));
            this.compressedSlices = slice.id === 'CBPZ';
            if (--this.countdown <= 0) {
                const joined = new Uint8Array(this.slices.reduce((n, s) => n + s.length, 0));
                let at = 0;
                for (const s of this.slices) {
                    joined.set(s, at);
                    at += s.length;
                }
                if (this.compressedSlices) lcw(joined, this.codebook);
                else this.codebook.set(joined.subarray(0, this.codebook.length));
                this.slices = [];
                this.countdown = this.header.interval;
            }
        }
    }

    private draw(vectors: Chunk, pixels: Uint8Array) {
        const { width, blockWidth, blockHeight } = this.header;
        const pointers = this.pointers;
        if (vectors.id === 'VPTZ') {
            pointers.fill(0);
            lcw(this.body(vectors), pointers);
        } else {
            pointers.set(this.body(vectors).subarray(0, pointers.length));
        }
        // Low bytes of every pointer, then all the high bytes.
        const half = pointers.length / 2;
        const across = width / blockWidth;
        for (let i = 0; i < half; i++) {
            const lo = pointers[i];
            const hi = pointers[half + i];
            const x = (i % across) * blockWidth;
            const y = Math.floor(i / across) * blockHeight;
            if (hi === this.solid) {
                for (let row = 0; row < blockHeight; row++) pixels.fill(lo, (y + row) * width + x, (y + row) * width + x + blockWidth);
            } else {
                let from = ((hi << 8) | lo) * this.blockSize;
                for (let row = 0; row < blockHeight; row++, from += blockWidth) pixels.set(this.codebook.subarray(from, from + blockWidth), (y + row) * width + x);
            }
        }
    }

    frame(index: number): VideoFrame {
        if (index <= this.position) this.reset();
        while (this.position < index - 1) this.step(++this.position);
        const pixels = new Uint8Array(this.header.width * this.header.height);
        this.step(++this.position, pixels);
        return { pixels, palette: this.palette };
    }
}

/** Version 3 high-color movies: a 15-bit codebook and run-length block commands, drawn over the last frame. */
class HighColorDecoder {
    private codebook = new Uint16Array(0);
    private screen: Uint16Array;
    private position = -1;
    private readonly commands: Uint8Array;
    private readonly blockSize: number;
    private readonly across: number;
    private readonly blocks: number;

    constructor(
        private readonly data: Uint8Array,
        private readonly header: Header,
        private readonly frames: Chunk[][],
    ) {
        this.blockSize = header.blockWidth * header.blockHeight;
        this.across = header.width / header.blockWidth;
        this.blocks = this.across * (header.height / header.blockHeight);
        this.screen = new Uint16Array(header.width * header.height);
        // At most a command and a byte per block.
        this.commands = new Uint8Array(this.blocks * 3 + 64);
        this.reset();
    }

    private reset() {
        this.codebook = new Uint16Array(0x2000 * this.blockSize);
        this.screen.fill(0);
        this.position = -1;
    }

    private bytes(c: Chunk, out: Uint8Array): Uint8Array {
        const body = this.data.subarray(c.start, c.end);
        if (!c.id.endsWith('Z')) return body;
        return out.subarray(0, lcw(body, out));
    }

    private block(index: number, at: number) {
        const { width, blockWidth, blockHeight } = this.header;
        if (at >= this.blocks) return;
        const x = (at % this.across) * blockWidth;
        const y = Math.floor(at / this.across) * blockHeight;
        let from = (index & 0x1fff) * this.blockSize;
        for (let row = 0; row < blockHeight; row++, from += blockWidth) this.screen.set(this.codebook.subarray(from, from + blockWidth), (y + row) * width + x);
    }

    private step(index: number) {
        for (const c of this.frames[index]) {
            if (c.id === 'CBF0' || c.id === 'CBFZ') {
                const raw = this.bytes(c, new Uint8Array(this.codebook.length * 2));
                this.codebook = new Uint16Array(this.codebook.length);
                for (let i = 0; i + 1 < raw.length && i / 2 < this.codebook.length; i += 2) this.codebook[i / 2] = raw[i] | (raw[i + 1] << 8);
            }
        }
        const vectors = this.frames[index].find((c) => c.id === 'VPRZ' || c.id === 'VPTR');
        if (!vectors) return;
        const src = this.bytes(vectors, this.commands);
        let at = 0;
        for (let s = 0; s + 1 < src.length && at < this.blocks; ) {
            const command = src[s] | (src[s + 1] << 8);
            s += 2;
            const run = 2 * (((command >> 8) & 0x1f) + 1);
            switch (command >> 13) {
                case 0: // Skip blocks: they keep the last frame's picture.
                    at += command & 0x1fff;
                    break;
                case 1: // One block, many times.
                    for (let i = 0; i < run; i++) this.block(command & 0xff, at++);
                    break;
                case 2: // One block, then as many more as listed, a byte each.
                    this.block(command & 0xff, at++);
                    for (let i = 0; i < run; i++) this.block(src[s++], at++);
                    break;
                case 3:
                case 4: // One block, once.
                    this.block(command & 0x1fff, at++);
                    break;
                case 5:
                case 6: {
                    // One block, as many times as the next byte says.
                    const count = src[s++];
                    for (let i = 0; i < count; i++) this.block(command & 0x1fff, at++);
                    break;
                }
                default:
                    s = src.length;
            }
        }
    }

    frame(index: number): VideoFrame {
        if (index <= this.position) this.reset();
        while (this.position < index) this.step(++this.position);
        const rgba = new Uint8Array(this.screen.length * 4);
        for (let i = 0; i < this.screen.length; i++) {
            const v = this.screen[i];
            const [r, g, b] = [(v >> 10) & 31, (v >> 5) & 31, v & 31];
            rgba[i * 4] = (r << 3) | (r >> 2);
            rgba[i * 4 + 1] = (g << 3) | (g >> 2);
            rgba[i * 4 + 2] = (b << 3) | (b >> 2);
            rgba[i * 4 + 3] = 255;
        }
        return { rgba };
    }
}

/** Joins the sound chunks into one clip. */
function decodeSound(data: Uint8Array, chunks: Chunk[], rate: number, channels: number, bits: number, version: number): AudioClip | undefined {
    const sound = chunks.filter((c) => c.id === 'SND0' || c.id === 'SND1' || c.id === 'SND2');
    if (!sound.length) return undefined;
    const kind = sound[0].id;
    const b = new Bytes(data);
    let samples: Int16Array | Uint8Array;
    if (kind === 'SND2') {
        // Two samples per byte. In stereo, bytes alternate between the channels.
        const out = new Int16Array(sound.reduce((n, c) => n + (c.end - c.start) * 2, 0));
        const states = Array.from({ length: channels }, () => ({ index: 0, sample: 0 }));
        let w = 0;
        for (const c of sound) {
            const body = data.subarray(c.start, c.end);
            if (channels === 1) {
                w = decodeIma(body, out, states[0], w);
                continue;
            }
            if (version === 3) {
                // Version 3 (TS): each chunk is the left channel's half, then the right's, low nibble first.
                const half = body.length >> 1;
                for (let c = 0; c < 2; c++) {
                    let at = w + c;
                    for (const byte of body.subarray(c * half, (c + 1) * half)) {
                        out[at] = imaSample(states[c], byte & 0x0f);
                        out[at + 2] = imaSample(states[c], byte >> 4);
                        at += 4;
                    }
                }
                w += half * 4;
                continue;
            }
            for (let i = 0; i + 1 < body.length; i += 2, w += 4) {
                out[w] = imaSample(states[0], body[i] & 0x0f);
                out[w + 2] = imaSample(states[0], body[i] >> 4);
                out[w + 1] = imaSample(states[1], body[i + 1] & 0x0f);
                out[w + 3] = imaSample(states[1], body[i + 1] >> 4);
            }
        }
        samples = out.subarray(0, w);
    } else if (kind === 'SND1') {
        // Each chunk: decoded size, compressed size, then the data.
        const out = new Uint8Array(sound.reduce((n, c) => n + b.u16(c.start), 0));
        let w = 0;
        for (const c of sound) w = decodeWestwood(data.subarray(c.start + 4, c.end), out, w, b.u16(c.start));
        samples = out.subarray(0, w);
        bits = 8;
    } else {
        const joined = new Uint8Array(sound.reduce((n, c) => n + c.end - c.start, 0));
        let at = 0;
        for (const c of sound) {
            joined.set(data.subarray(c.start, c.end), at);
            at += c.end - c.start;
        }
        samples = bits === 16 ? new Int16Array(joined.buffer, 0, joined.length >> 1) : joined;
    }
    const seconds = samples.length / channels / rate;
    return { wav: wav(samples, rate, channels), sampleRate: rate, channels, bits: samples instanceof Int16Array ? 16 : 8, seconds };
}

const parser: FormatParser = {
    parse(data) {
        const b = new Bytes(data);
        const be = (at: number) => (at + 4 <= data.length ? b.view.getUint32(at, false) : 0);

        // Every chunk, for decoding; the structure tree lists the first MAX_LISTED.
        const top: Chunk[] = [];
        const frameChunks: Chunk[][] = [];
        const listed: Field[] = [];
        let ahead: Chunk[] = [];
        for (let at = 12; at + 8 <= data.length; ) {
            const id = b.ascii(at, 4);
            const size = be(at + 4);
            const end = Math.min(at + 8 + size, data.length);
            top.push({ id, start: at + 8, end });
            let children: Field[] | undefined;
            if (CONTAINERS.has(id)) {
                const subs: Chunk[] = [];
                children = [];
                for (let s = at + 8; s + 8 <= end; ) {
                    const sid = b.ascii(s, 4);
                    const ssize = be(s + 4);
                    subs.push({ id: sid, start: s + 8, end: Math.min(s + 8 + ssize, end) });
                    children.push({ name: sid, offset: s, length: Math.min(8 + ssize, end - s), value: bytesLabel(ssize), note: CHUNKS[sid] });
                    s += 8 + ssize + (ssize & 1);
                }
                // A VQFL's changes apply ahead of the next frame.
                if (id === 'VQFR') {
                    frameChunks.push([...ahead, ...subs]);
                    ahead = [];
                } else {
                    append(ahead, subs.filter((c) => !c.id.startsWith('VPT')));
                }
            }
            if (listed.length < MAX_LISTED) listed.push({ name: id, offset: at, length: end - at, value: bytesLabel(size), note: CHUNKS[id], children });
            at += 8 + size + (size & 1);
        }

        const vqhd = top.find((c) => c.id === 'VQHD');
        const h = vqhd ? vqhd.start : -1;
        const header: Header = {
            version: h >= 0 ? b.u16(h) : 0,
            frames: h >= 0 ? b.u16(h + 4) : 0,
            width: h >= 0 ? b.u16(h + 6) : 0,
            height: h >= 0 ? b.u16(h + 8) : 0,
            blockWidth: h >= 0 ? b.u8(h + 10) : 0,
            blockHeight: h >= 0 ? b.u8(h + 11) : 0,
            interval: h >= 0 ? b.u8(h + 13) : 0,
        };
        const fps = h >= 0 ? b.u8(h + 12) : 0;
        const rate = (h >= 0 && b.u16(h + 24)) || 22050;
        const channels = h >= 0 && b.u8(h + 26) === 2 ? 2 : 1;
        const bits = h >= 0 && b.u8(h + 27) === 8 ? 8 : 16;
        const flags = h >= 0 ? b.u16(h + 2) : 0;
        if (vqhd) {
            listed.find((c) => c.name === 'VQHD')!.children = [
                field('Version', h, 2, b.u16(h), '2 for TD and RA; 3 for Tiberian Sun\'s high-color movies.'),
                field('Flags', h + 2, 2, `0x${flags.toString(16)}`, 'Bit 0: has sound. Bit 4: high color (15-bit codebook, no palette).'),
                field('Frames', h + 4, 2, b.u16(h + 4)),
                field('Width', h + 6, 2, b.u16(h + 6)),
                field('Height', h + 8, 2, b.u16(h + 8)),
                field('Block width', h + 10, 1, b.u8(h + 10)),
                field('Block height', h + 11, 1, b.u8(h + 11)),
                field('Frame rate', h + 12, 1, `${fps} fps`),
                field('Codebook interval', h + 13, 1, b.u8(h + 13), 'A new codebook every this many frames, sent in that many slices.'),
                field('Colors', h + 14, 2, b.u16(h + 14)),
                field('Largest codebook', h + 16, 2, b.u16(h + 16), 'In blocks.'),
                field('Unknown', h + 18, 6),
                field('Sample rate', h + 24, 2, `${b.u16(h + 24)} Hz`),
                field('Channels', h + 26, 1, b.u8(h + 26)),
                field('Bits per sample', h + 27, 1, b.u8(h + 27)),
                field('Unknown', h + 28, Math.max(0, vqhd.end - h - 28)),
            ];
        }

        const warnings: string[] = [];
        const highColor = header.version === 3 && (flags & 0x10) !== 0;
        const fits = header.width > 0 && header.blockWidth > 0 && header.blockHeight > 0 && header.width % header.blockWidth === 0 && header.height % header.blockHeight === 0;
        const drawable = fits && ((header.version === 2 && [2, 4].includes(header.blockHeight)) || highColor);
        if (!drawable) warnings.push(`Version ${header.version} movies${header.version === 3 ? ' in 256 colors' : ''} aren't decoded yet; the chunks are still listed.`);
        if (listed.length >= MAX_LISTED) warnings.push(`Only the first ${MAX_LISTED} chunks are listed (${frameChunks.length} frames).`);

        let sound: AudioClip | undefined;
        try {
            sound = decodeSound(data, top, rate, channels, bits, header.version);
        } catch (e) {
            warnings.push(`The sound couldn't be decoded: ${e instanceof Error ? e.message : e}`);
        }
        const decoder = !drawable ? null : highColor ? new HighColorDecoder(data, header, frameChunks) : new Decoder(data, header, frameChunks);

        return {
            title: 'Video (VQA)',
            summary: [
                ['Size', `${header.width} × ${header.height}`],
                ['Frames', `${frameChunks.length}${fps ? `, ${(frameChunks.length / fps).toFixed(1)} s at ${fps} fps` : ''}`],
                ['Blocks', `${header.blockWidth} × ${header.blockHeight}${highColor ? ', high color (15-bit)' : `, a new codebook every ${header.interval} frames`}`],
                ['Sound', sound ? `${sound.sampleRate} Hz, ${sound.channels === 2 ? 'stereo' : 'mono'}, ${top.find((c) => c.id.startsWith('SND'))?.id}` : 'None'],
            ],
            fields: [
                { name: 'FORM', offset: 0, length: 12, value: 'WVQA', children: [field('ID', 0, 4, 'FORM'), field('Size', 4, 4, bytesLabel(be(4)), 'Big-endian, like every IFF size.'), field('Type', 8, 4, 'WVQA')] },
                ...listed,
            ],
            preview: decoder
                ? { kind: 'video', width: header.width, height: header.height, frameCount: frameChunks.length, fps: fps || 15, frame: (i) => decoder.frame(i), audio: sound }
                : sound && { kind: 'audio', ...sound },
            warnings,
        };
    },
};

export default parser;
