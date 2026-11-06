import { inflate } from '../../core/inflate';
import { encodePng } from '../../core/png';
import type { Entry } from '../../core/types';
import { decodeJpeg, segmentsOf } from '../jpeg/decode';
import { IMA_STEPS, wav } from '../westwood/adpcm';
import { decodeNellymoser } from './nellymoser';
import { soundFormat } from './tags';

/**
 * The files a SWF carries, pulled out whole: bitmaps (as JPEG, PNG or GIF;
 * lossless ones and JPEGs with alpha made into PNGs), sounds (MP3 as it is,
 * PCM and ADPCM as WAV), streamed sound joined across frames, video wrapped
 * as FLV, binary data, embedded fonts and ActionScript 3 bytecode.
 * Nellymoser speech is decoded to WAV too; Speex is left as it is.
 */

/** Where a tag's body is, and which timeline it's on (a sprite's, or the main one). */
export interface TagRef {
    code: number;
    at: number;
    length: number;
    sprite: number | null;
}

export function extractAssets(data: Uint8Array, tags: TagRef[], frameRate: number): { entries: Entry[]; texts: { title: string; text: string }[]; warnings: string[] } {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const u16 = (at: number) => view.getUint16(at, true);
    const u32 = (at: number) => view.getUint32(at, true);
    const entries: Entry[] = [];
    const texts: { title: string; text: string }[] = [];
    const warnings: string[] = [];
    const body = (t: TagRef, from = 0) => data.subarray(t.at + from, t.at + t.length);
    const cString = (at: number, end: number) => {
        let stop = at;
        while (stop < end && data[stop]) stop++;
        return { text: new TextDecoder().decode(data.subarray(at, stop)), next: stop + 1 };
    };

    // Names the SWF gives its characters: ActionScript 3 classes, and ActionScript 2 export names.
    const names = new Map<number, string>();
    for (const t of tags) {
        if (t.code !== 76 && t.code !== 56) continue;
        let at = t.at + 2;
        for (let i = u16(t.at); i > 0 && at < t.at + t.length; i--) {
            const id = u16(at);
            const { text, next } = cString(at + 2, t.at + t.length);
            if (id) names.set(id, text);
            at = next;
        }
    }
    const label = (kind: string, id: number) => `${kind} ${id}${names.has(id) ? ` (${names.get(id)})` : ''}`;
    const add = (name: string, t: TagRef, bytes: Uint8Array, meta?: Record<string, string>) => entries.push({ name: null, label: name, offset: t.at, size: bytes.length, data: bytes, meta: { Tag: tagName(t.code), ...meta } });
    const attempt = (what: string, run: () => void) => {
        try {
            run();
        } catch (e) {
            warnings.push(`${what} couldn't be extracted: ${(e as Error).message}`);
        }
    };

    let tables: Uint8Array | null = null;
    const videos = new Map<number, { tag: TagRef; codec: number; frames: { number: number; data: Uint8Array }[] }>();
    const streams = new Map<number | null, { tag: TagRef; format: number; blocks: Uint8Array[] }>();
    let abc = 0;

    for (const t of tags) {
        switch (t.code) {
            case 8:
                tables = body(t);
                break;
            case 6:
            case 21: {
                const id = u16(t.at);
                let image = fixJpeg(body(t, 2));
                if (t.code === 6 && tables && tables.length > 4) image = withTables(fixJpeg(tables), image);
                add(isGif(image) ? `${label('image', id)}.gif` : label('image', id), t, image);
                break;
            }
            case 35:
            case 90: {
                const id = u16(t.at);
                const size = u32(t.at + 2);
                const start = t.code === 90 ? 8 : 6;
                const image = fixJpeg(body(t, start).subarray(0, size));
                const alpha = body(t, start + size);
                if (!isJpeg(image) || !alpha.length) {
                    add(isGif(image) ? `${label('image', id)}.gif` : label('image', id), t, image);
                    break;
                }
                // The JPEG's colors and the alpha channel, together as a PNG.
                attempt(`Image ${id}`, () => {
                    const picture = decodeJpeg(image, segmentsOf(image).segments);
                    const a = inflate(alpha, picture.width * picture.height);
                    for (let i = 0; i < picture.width * picture.height; i++) picture.rgba[i * 4 + 3] = a[i] ?? 255;
                    add(label('image', id), t, encodePng(picture.width, picture.height, picture.rgba), { Note: 'JPEG with alpha' });
                });
                break;
            }
            case 20:
            case 36: {
                const id = u16(t.at);
                attempt(`Image ${id}`, () => {
                    const { width, height, rgba } = lossless(data, t, t.code === 36);
                    add(label('image', id), t, encodePng(width, height, rgba));
                });
                break;
            }
            case 14: {
                const id = u16(t.at);
                const s = soundFormat(data[t.at + 2]);
                const sound = body(t, 7);
                attempt(`Sound ${id}`, () => {
                    const file = soundFile(s, [sound], u32(t.at + 3));
                    add(file.ext ? `${label('sound', id)}.${file.ext}` : label('sound', id), t, file.data);
                });
                break;
            }
            case 18:
            case 45:
                streams.set(t.sprite, { tag: t, format: data[t.at + 1], blocks: [] });
                break;
            case 19: {
                const stream = streams.get(t.sprite);
                if (stream) stream.blocks.push(body(t));
                break;
            }
            case 60:
                videos.set(u16(t.at), { tag: t, codec: data[t.at + 9], frames: [] });
                break;
            case 61:
                videos.get(u16(t.at))?.frames.push({ number: u16(t.at + 2), data: body(t, 4) });
                break;
            case 87: {
                const id = u16(t.at);
                add(label('binary', id), t, body(t, 6));
                break;
            }
            case 91: {
                const id = u16(t.at);
                const { next } = cString(t.at + 3, t.at + t.length);
                if (next < t.at + t.length) add(`${label('font', id)}.otf`, t, data.subarray(next, t.at + t.length));
                break;
            }
            case 72:
            case 82: {
                const named = t.code === 82 ? cString(t.at + 4, t.at + t.length) : { text: '', next: t.at };
                abc++;
                add(`${named.text || `actions ${abc}`}.abc`, t, data.subarray(named.next, t.at + t.length));
                break;
            }
            case 77:
                texts.push({ title: 'Metadata', text: cString(t.at, t.at + t.length).text });
                break;
        }
    }

    for (const [sprite, stream] of streams) {
        if (!stream.blocks.length) continue;
        const s = soundFormat(stream.format);
        const name = sprite === null ? 'stream' : `${label('stream', sprite)}`;
        attempt(`The ${sprite === null ? 'main' : `sprite ${sprite}`} streaming sound`, () => {
            // Each MP3 block starts with its sample count and a seek.
            const blocks = s.format === 2 ? stream.blocks.map((b) => b.subarray(4)) : stream.blocks;
            const file = soundFile(s, blocks, 0);
            add(file.ext ? `${name}.${file.ext}` : name, stream.tag, file.data, { Note: `${stream.blocks.length} blocks` });
        });
    }
    for (const [id, video] of videos) {
        if (!video.frames.length) continue;
        if (video.codec < 2 || video.codec > 5) {
            warnings.push(`Video ${id} uses a codec FLV can't carry this way (${video.codec}).`);
            continue;
        }
        add(`${label('video', id)}.flv`, video.tag, flv(video.codec, video.frames, frameRate), { Note: `${video.frames.length} frames` });
    }
    return { entries, texts, warnings };
}

const TAG_NAMES_SHORT: Record<number, string> = { 6: 'DefineBits', 14: 'DefineSound', 18: 'SoundStreamHead', 20: 'DefineBitsLossless', 21: 'DefineBitsJPEG2', 35: 'DefineBitsJPEG3', 36: 'DefineBitsLossless2', 45: 'SoundStreamHead2', 60: 'DefineVideoStream', 72: 'DoABC', 82: 'DoABC', 87: 'DefineBinaryData', 90: 'DefineBitsJPEG4', 91: 'DefineFont4' };
const tagName = (code: number) => TAG_NAMES_SHORT[code] ?? String(code);

const isJpeg = (b: Uint8Array) => b[0] === 0xff && b[1] === 0xd8;
const isGif = (b: Uint8Array) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46;

/**
 * Before SWF 8, a JPEG could start with an extra EOI and SOI (FF D9 FF D8), and Flash 5 put the pair
 * between the tables and the picture too. Neither can be in coded data (an FF there is followed by 00 or a restart).
 */
function fixJpeg(b: Uint8Array): Uint8Array {
    if (b[0] === 0xff && b[1] === 0xd9 && b[2] === 0xff && b[3] === 0xd8) b = b.subarray(4);
    const parts: Uint8Array[] = [];
    let from = 0;
    for (let i = 2; i + 3 < b.length; i++) {
        if (b[i] === 0xff && b[i + 1] === 0xd9 && b[i + 2] === 0xff && b[i + 3] === 0xd8) {
            parts.push(b.subarray(from, i));
            from = i + 4;
            i += 3;
        }
    }
    return parts.length ? concat([...parts, b.subarray(from)]) : b;
}

/** JPEGTables' tables (without their EOI), then the image (without its SOI). */
function withTables(tables: Uint8Array, image: Uint8Array): Uint8Array {
    const head = tables[tables.length - 2] === 0xff && tables[tables.length - 1] === 0xd9 ? tables.subarray(0, -2) : tables;
    const tail = isJpeg(image) ? image.subarray(2) : image;
    const out = new Uint8Array(head.length + tail.length);
    out.set(head);
    out.set(tail, head.length);
    return out;
}

/** DefineBitsLossless(2): zlib-compressed, rows padded to 4 bytes; color-mapped, 15-bit or 24/32-bit. */
function lossless(data: Uint8Array, t: TagRef, alpha: boolean): { width: number; height: number; rgba: Uint8Array } {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const format = data[t.at + 2];
    const width = view.getUint16(t.at + 3, true);
    const height = view.getUint16(t.at + 5, true);
    const mapped = format === 3;
    const colors = mapped ? data[t.at + 7] + 1 : 0;
    const raw = inflate(data.subarray(t.at + (mapped ? 8 : 7), t.at + t.length));
    const rgba = new Uint8Array(width * height * 4);
    if (mapped) {
        const size = alpha ? 4 : 3;
        const stride = (width + 3) & ~3;
        const base = colors * size;
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const c = raw[base + y * stride + x] * size;
                rgba.set([raw[c], raw[c + 1], raw[c + 2], alpha ? raw[c + 3] : 255], (y * width + x) * 4);
            }
        }
    } else if (format === 4) {
        const stride = (width * 2 + 3) & ~3;
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const v = (raw[y * stride + x * 2] << 8) | raw[y * stride + x * 2 + 1];
                const five = (n: number) => Math.round((((v >> n) & 31) * 255) / 31);
                rgba.set([five(10), five(5), five(0), 255], (y * width + x) * 4);
            }
        }
    } else if (format === 5) {
        // Each pixel ARGB (Lossless2: alpha premultiplied) or a pad byte and RGB.
        for (let i = 0; i < width * height; i++) {
            const a = alpha ? raw[i * 4] : 255;
            const un = (c: number) => (alpha && a > 0 && a < 255 ? Math.min(255, Math.round((c * 255) / a)) : c);
            rgba.set([un(raw[i * 4 + 1]), un(raw[i * 4 + 2]), un(raw[i * 4 + 3]), a], i * 4);
        }
    } else {
        throw new Error(`Unknown bitmap format ${format}.`);
    }
    return { width, height, rgba };
}

/** A sound as a file: MP3 frames as they are; PCM, ADPCM and Nellymoser as WAV; Speex raw. */
function soundFile(s: ReturnType<typeof soundFormat>, parts: Uint8Array[], samples: number): { data: Uint8Array; ext?: string } {
    const joined = concat(parts);
    switch (s.format) {
        case 2:
            // DefineSound's MP3 data starts with a 16-bit seek; streamed blocks have had theirs taken off.
            return { data: samples ? joined.subarray(2) : joined };
        case 0:
        case 3:
            if (s.bits === 8) return { data: wav(joined, s.rate, s.channels) };
            return { data: wav(new Int16Array(joined.buffer.slice(joined.byteOffset, joined.byteOffset + (joined.length & ~1))), s.rate, s.channels) };
        case 1:
            return { data: wav(concatSamples(parts.map((p) => decodeSwfAdpcm(p, s.channels))), s.rate, s.channels) };
        case 4:
        case 5:
        case 6:
            // Mono; formats 4 and 5 are fixed at 16 and 8 kHz.
            return { data: wav(decodeNellymoser(joined), s.format === 4 ? 16000 : s.format === 5 ? 8000 : s.rate, 1) };
        case 11:
            return { data: joined, ext: 'spx' };
    }
    throw new Error(`Unknown sound format ${s.format}.`);
}

/** The index changes for 2- to 5-bit ADPCM codes, by the code's magnitude. */
const INDEX_TABLES: Record<number, number[]> = {
    2: [-1, 2],
    3: [-1, -1, 2, 4],
    4: [-1, -1, -1, -1, 2, 4, 6, 8],
    5: [-1, -1, -1, -1, -1, -1, -1, -1, 1, 2, 4, 6, 8, 10, 13, 16],
};

/**
 * Flash's ADPCM: a 2-bit code size (2 to 5 bits), then packets of 4096
 * samples a channel, each starting with every channel's 16-bit sample and
 * 6-bit step index, the rest as codes, interleaved.
 */
export function decodeSwfAdpcm(data: Uint8Array, channels: number): Int16Array {
    let bit = 0;
    const total = data.length * 8;
    const read = (n: number) => {
        let v = 0;
        for (let i = 0; i < n; i++, bit++) v = (v << 1) | ((data[bit >> 3] >> (7 - (bit & 7))) & 1);
        return v;
    };
    const codeBits = read(2) + 2;
    const table = INDEX_TABLES[codeBits];
    const sign = 1 << (codeBits - 1);
    const out: number[] = [];
    while (bit + 22 * channels <= total) {
        const state = Array.from({ length: channels }, () => {
            const raw = read(16);
            return { sample: raw >= 0x8000 ? raw - 0x10000 : raw, index: read(6) };
        });
        for (const s of state) out.push(s.sample);
        for (let n = 1; n < 4096 && bit + codeBits * channels <= total; n++) {
            for (const s of state) {
                const code = read(codeBits);
                const step = IMA_STEPS[s.index];
                let diff = 0;
                let k = sign >> 1;
                let part = step;
                for (; k; k >>= 1, part >>= 1) if (code & k) diff += part;
                diff += part;
                s.sample = Math.max(-32768, Math.min(32767, code & sign ? s.sample - diff : s.sample + diff));
                s.index = Math.max(0, Math.min(88, s.index + table[code & (sign - 1)]));
                out.push(s.sample);
            }
        }
    }
    return Int16Array.from(out);
}

/** Video frames in an FLV file (video only), as Flashbug made them. */
function flv(codec: number, frames: { number: number; data: Uint8Array }[], frameRate: number): Uint8Array {
    const vp6 = codec === 4 || codec === 5;
    const parts: Uint8Array[] = [Uint8Array.from([0x46, 0x4c, 0x56, 1, 0x01, 0, 0, 0, 9, 0, 0, 0, 0])];
    frames.forEach((f, i) => {
        const size = f.data.length + 1 + (vp6 ? 1 : 0);
        const tag = new Uint8Array(11 + size + 4);
        const v = new DataView(tag.buffer);
        const ms = Math.round((f.number * 1000) / (frameRate || 12));
        tag[0] = 9;
        tag.set([size >> 16, (size >> 8) & 0xff, size & 0xff], 1);
        tag.set([(ms >> 16) & 0xff, (ms >> 8) & 0xff, ms & 0xff, (ms >> 24) & 0xff], 4);
        // Frame type (1 key, 2 inter: the first is taken as the key frame) and codec; VP6 adds a size adjustment byte.
        tag[11] = ((i === 0 ? 1 : 2) << 4) | codec;
        if (vp6) tag[12] = codec === 4 ? 0 : 128;
        tag.set(f.data, 12 + (vp6 ? 1 : 0));
        v.setUint32(11 + size, 11 + size);
        parts.push(tag);
    });
    return concat(parts);
}

function concat(parts: Uint8Array[]): Uint8Array {
    if (parts.length === 1) return parts[0];
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    parts.reduce((o, p) => (out.set(p, o), o + p.length), 0);
    return out;
}

function concatSamples(parts: Int16Array[]): Int16Array {
    const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
    parts.reduce((o, p) => (out.set(p, o), o + p.length), 0);
    return out;
}
