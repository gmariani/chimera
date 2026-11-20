import { Bytes, bytesLabel, field, fillGaps, hex } from '../core/bytes';
import { checkBytes, checkPixels } from '../core/limits';
import type { AudioClip, Entry, Field, FormatParser, Preview } from '../core/types';
import { sniffAvi } from './avi-sniff';
import { drawIndexed, drawRle, drawTrueColor, strideOf, type Problem, type VideoFormat } from './avi-video';
import { decodeImaWav, decodeMsAdpcm, MS_COEFFICIENTS, WAV_IMA_ADPCM, WAV_MS_ADPCM, WAV_PCM } from './wav';
import { wav } from './westwood/adpcm';

/**
 * AVI video (Audio Video Interleave), Microsoft's movie file from Video for Windows (1992) on: the animations in
 * Windows' own programs (copying files, searching) and installers, and most PC video of the 1990s.
 *
 * A RIFF file of the form "AVI ": chunks of a 4-letter ID, a u32 size and the data, padded to an even length, and lists
 * of more chunks ("LIST", a size, a 4-letter form). First the "hdrl" list: the main header ("avih": the time a frame
 * takes in microseconds, flags, frames, streams, the size), then a "strl" list for each stream with its header ("strh":
 * video or sound, its codec, its rate as a fraction, its length) and its format ("strf": a bitmap header and palette
 * for video, a WAVEFORMATEX for sound). Then the "movi" list: the streams' data, each chunk named for its stream's
 * number and what it holds ("00dc" a compressed frame of stream 0, "00db" an uncompressed one, "00pc" a palette change,
 * "01wb" sound), sometimes grouped in "rec " lists. Last, an index ("idx1": each chunk's ID, flags, where it is and its
 * size; flag 0x10 marks a key frame, one drawn without the frames before it). Files over 1 GB go on in "AVIX" RIFFs
 * after the first (OpenDML).
 *
 * See Microsoft's "AVI RIFF File Reference" (https://learn.microsoft.com/windows/win32/directshow/avi-riff-file-reference),
 * AVIMAINHEADER, AVISTREAMHEADER, AVIOLDINDEX and AVIPALCHANGE (https://learn.microsoft.com/windows/win32/api/aviriff/,
 * https://learn.microsoft.com/windows/win32/api/vfw/ns-vfw-avipalchange), and OpenDML's AVI File Format Extensions 1.02
 * for AVIX.
 */

const VIDEO_CODECS: Record<string, string> = {
    cvid: 'Cinepak',
    CVID: 'Cinepak',
    msvc: 'Microsoft Video 1',
    MSVC: 'Microsoft Video 1',
    CRAM: 'Microsoft Video 1',
    cram: 'Microsoft Video 1',
    IV31: 'Indeo 3',
    IV32: 'Indeo 3',
    IV41: 'Indeo 4',
    IV50: 'Indeo 5',
    ULTI: 'IBM UltiMotion',
    MJPG: 'Motion JPEG',
    DIV3: 'DivX 3 (MPEG-4)',
    DIVX: 'DivX (MPEG-4)',
    DX50: 'DivX 5 (MPEG-4)',
    XVID: 'Xvid (MPEG-4)',
    H264: 'H.264',
    avc1: 'H.264',
    TSCC: 'TechSmith screen capture',
    smc: 'Apple Graphics',
    rpza: 'Apple Video',
};
const SOUND_FORMATS: Record<number, string> = {
    [WAV_PCM]: 'PCM',
    [WAV_MS_ADPCM]: 'Microsoft ADPCM',
    3: 'IEEE float',
    6: 'A-law',
    7: 'µ-law',
    [WAV_IMA_ADPCM]: 'IMA ADPCM',
    0x31: 'GSM 6.10',
    0x50: 'MPEG audio',
    0x55: 'MP3',
    0x161: 'Windows Media Audio',
    0x2000: 'AC-3',
};
const MOST_FIELDS = 2000;
/** The index's flag for a key frame: one drawn on its own, not over the frames before it. */
const KEY_FLAG = 0x10;

interface Stream {
    number: number;
    type: string;
    handler: string;
    scale: number;
    rate: number;
    length: number;
    name?: string;
    video?: VideoFormat & { colors: Uint8Array; codec: string; drawn: boolean };
    sound?: { tag: number; channels: number; sampleRate: number; bytesPerSecond: number; blockAlign: number; bits: number; coefficients: [number, number][] };
    /** Its chunks in the movie data, in order: where the data is, its size, and what it holds ("db", "dc", "pc", "wb"). */
    chunks: { at: number; size: number; kind: string }[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const STREAM_TYPES: Record<string, string> = { vids: 'video', auds: 'sound', txts: 'subtitles', mids: 'MIDI' };

const parser: FormatParser = {
    parse(data, context) {
        if (!sniffAvi(data)) throw new Error('This isn’t an AVI video: it doesn’t start with RIFF and the form "AVI ".');
        const b = new Bytes(data);
        const warnings: string[] = [];
        const said = new Set<string>();
        const once = (text: string) => {
            if (!said.has(text)) warnings.push(text);
            said.add(text);
        };
        const streams: Stream[] = [];
        let main: { frames: number; streams: number; width: number; height: number; microseconds: number } | null = null;
        let movi = 0;
        let moviCount = 0;
        let index: { at: number; size: number } | null = null;
        let extended = 0;

        /** The chunks from `from` to `to`, each read by `read` (null: a chunk it doesn't know). */
        const chunks = (from: number, to: number, where: string, read: (id: string, at: number, size: number, kids: Field[]) => Field | null, limit = Infinity): Field[] => {
            const out: Field[] = [];
            let p = from;
            let listed = 0;
            while (p + 8 <= to) {
                const id = b.ascii(p, 4);
                let size = b.u32(p + 4);
                if (p + 8 + size > to) {
                    once(`The ${JSON.stringify(id)} chunk ${where}says it’s ${bytesLabel(size)}, past where ${where ? 'its list' : 'the file'} ends: it’s been cut short.`);
                    size = to - p - 8;
                }
                const kids: Field[] = [field('ID', p, 4, id), field('Size', p + 4, 4, bytesLabel(size))];
                const made = read(id, p + 8, size, kids);
                const next = p + 8 + size + (size & 1 && p + 8 + size < to ? 1 : 0);
                if (listed < limit) {
                    out.push(
                        made
                            ? { ...made, offset: p, length: 8 + size, children: [...kids, ...(made.children ?? [])] }
                            : { name: `Chunk ${JSON.stringify(id)}`, offset: p, length: 8 + size, value: bytesLabel(size), children: kids }
                    );
                    if (next > p + 8 + size) out.push(field('Padding', p + 8 + size, 1, data[p + 8 + size], 'To make the next chunk start on an even byte.'));
                } else if (listed === limit) out.push(field('More chunks', p, to - p, bytesLabel(to - p), `Past the first ${limit.toLocaleString('en-US')}, not listed one by one.`));
                listed++;
                p = next;
            }
            if (p < to && listed <= limit) out.push(field('Too short for a chunk', p, to - p, bytesLabel(to - p)));
            return out;
        };
        const list = (at: number, size: number, kids: Field[]) => {
            const form = size >= 4 ? b.ascii(at, 4) : '';
            kids.push(field('Form', at, 4, form));
            return form;
        };

        // A stream's list: its header, its format, its name.
        const readStream = (at: number, size: number): Field[] => {
            const s: Stream = { number: streams.length, type: '', handler: '', scale: 0, rate: 0, length: 0, chunks: [] };
            streams.push(s);
            let sawFormat = false;
            const inside = chunks(at, at + size, 'in a stream’s list ', (id, t, n) => {
                if (id === 'strh' && n >= 48) {
                    s.type = b.ascii(t, 4);
                    s.handler = b.ascii(t + 4, 4).replace(/\0/g, '');
                    s.scale = b.u32(t + 20);
                    s.rate = b.u32(t + 24);
                    s.length = b.u32(t + 32);
                    return {
                        name: 'Stream header',
                        offset: t,
                        length: n,
                        value: `${STREAM_TYPES[s.type] ?? s.type}${s.handler ? `, ${JSON.stringify(s.handler)}` : ''}`,
                        children: [
                            field('Type', t, 4, s.type, 'vids video, auds sound, txts subtitles, mids MIDI.'),
                            field('Handler', t + 4, 4, s.handler, 'The codec that plays it.'),
                            field('Flags', t + 8, 4, `0x${hex(b.u32(t + 8))}`),
                            field('Priority', t + 12, 2, b.u16(t + 12)),
                            field('Language', t + 14, 2, b.u16(t + 14)),
                            field('Initial frames', t + 16, 4, b.u32(t + 16), 'How far ahead of the video the sound is stored.'),
                            field('Scale', t + 20, 4, s.scale, 'The rate is rate ÷ scale a second.'),
                            field('Rate', t + 24, 4, s.rate),
                            field('Start', t + 28, 4, b.u32(t + 28)),
                            field('Length', t + 32, 4, s.length, 'In its own units: frames, or blocks of sound.'),
                            field('Buffer size', t + 36, 4, bytesLabel(b.u32(t + 36)), 'What a player should set aside for its largest chunk.'),
                            field('Quality', t + 40, 4, b.i32(t + 40)),
                            field('Sample size', t + 44, 4, b.u32(t + 44), '0 when its chunks differ in size.'),
                            ...(n >= 56 ? [field('Frame', t + 48, 8, [0, 2, 4, 6].map((k) => (b.u16(t + 48 + k) << 16) >> 16).join(', '), 'Where its picture goes: left, top, right, bottom.')] : []),
                            ...(n > 56 ? [field('After the header', t + 56, n - 56, bytesLabel(n - 56))] : []),
                        ],
                    };
                }
                if (id === 'strf') {
                    sawFormat = true;
                    if (s.type === 'vids' && n >= 40) {
                        const headerSize = b.u32(t);
                        const width = b.i32(t + 4);
                        const rawHeight = b.i32(t + 8);
                        const bits = b.u16(t + 14);
                        const compression = b.u32(t + 16);
                        const codec = compression > 3 ? b.ascii(t + 16, 4).replace(/\0/g, '') : '';
                        const used = b.u32(t + 32);
                        const colorCount = bits <= 8 ? Math.min(used || 2 ** bits, 256) : 0;
                        const colorsAt = t + Math.max(40, Math.min(headerSize, n));
                        const masksAt = t + 40;
                        const masks: [number, number, number] =
                            compression === 3 && n >= 52 ? [b.u32(masksAt), b.u32(masksAt + 4), b.u32(masksAt + 8)] : bits === 16 ? [0x7c00, 0x3e0, 0x1f] : [0xff0000, 0xff00, 0xff];
                        const colors = new Uint8Array(768);
                        const fit = Math.min(colorCount, Math.max(0, Math.floor((t + n - colorsAt) / 4)));
                        for (let i = 0; i < fit; i++) colors.set([data[colorsAt + i * 4 + 2], data[colorsAt + i * 4 + 1], data[colorsAt + i * 4]], i * 3);
                        if (fit < colorCount) once(`Stream ${s.number}’s format says it has ${colorCount} colors, but only ${fit} fit in it.`);
                        const drawn =
                            width > 0 &&
                            rawHeight !== 0 &&
                            ((compression === 0 && [1, 4, 8, 16, 24, 32].includes(bits)) ||
                                (compression === 1 && bits === 8) ||
                                (compression === 2 && bits === 4) ||
                                (compression === 3 && (bits === 16 || bits === 32)));
                        s.video = { width, height: Math.abs(rawHeight), topDown: rawHeight < 0, bits, compression, masks, colors, codec, drawn };
                        const method =
                            ['uncompressed', 'RLE, 8 bits a pixel', 'RLE, 4 bits a pixel', 'uncompressed, with masks'][compression] ??
                            `${JSON.stringify(codec)}${VIDEO_CODECS[codec] ? ` (${VIDEO_CODECS[codec]})` : ''}`;
                        const children = [
                            field('Header size', t, 4, headerSize, '40 (BITMAPINFOHEADER).'),
                            field('Width', t + 4, 4, width),
                            field('Height', t + 8, 4, rawHeight, 'Negative when the rows are stored from the top down.'),
                            field('Planes', t + 12, 2, b.u16(t + 12)),
                            field('Bits a pixel', t + 14, 2, bits),
                            field('Compression', t + 16, 4, method),
                            field('Picture size', t + 20, 4, bytesLabel(b.u32(t + 20))),
                            field('Pixels a meter across', t + 24, 4, b.i32(t + 24)),
                            field('Pixels a meter down', t + 28, 4, b.i32(t + 28)),
                            field('Colors used', t + 32, 4, used, '0: all a pixel’s bits allow.'),
                            field('Colors needed', t + 36, 4, b.u32(t + 36)),
                        ];
                        if (compression === 3 && n >= 52) children.push(field('Masks', masksAt, 12, masks.map((m) => `0x${hex(m)}`).join(', '), 'Red, green and blue’s bits.'));
                        if (fit) children.push(field('Colors', colorsAt, fit * 4, `${fit}`, 'Blue, green, red and a spare byte each.'));
                        return {
                            name: 'Video format',
                            offset: t,
                            length: n,
                            value: `${width} × ${Math.abs(rawHeight)}, ${bits} bits a pixel, ${method}`,
                            children: fillGaps(data, children, t, t + n, 'Not read'),
                        };
                    }
                    if (s.type === 'auds' && n >= 14) {
                        const tag = b.u16(t);
                        const channels = b.u16(t + 2);
                        const sampleRate = b.u32(t + 4);
                        const blockAlign = b.u16(t + 12);
                        const bits = n >= 16 ? b.u16(t + 14) : 0;
                        const extra = n >= 18 ? b.u16(t + 16) : 0;
                        const count = tag === WAV_MS_ADPCM && n >= 22 ? Math.min(b.u16(t + 20), Math.floor((n - 22) / 4)) : 0;
                        const coefficients: [number, number][] = count
                            ? Array.from({ length: count }, (_, k) => [(b.u16(t + 22 + k * 4) << 16) >> 16, (b.u16(t + 24 + k * 4) << 16) >> 16])
                            : MS_COEFFICIENTS;
                        s.sound = { tag, channels, sampleRate, bytesPerSecond: b.u32(t + 8), blockAlign, bits, coefficients };
                        const children = [
                            field('Format', t, 2, `${tag} (${SOUND_FORMATS[tag] ?? 'unknown'})`),
                            field('Channels', t + 2, 2, channels),
                            field('Sample rate', t + 4, 4, `${sampleRate.toLocaleString('en-US')} Hz`),
                            field('Bytes a second', t + 8, 4, b.u32(t + 8)),
                            field('Block size', t + 12, 2, blockAlign, 'Bytes in each block of samples.'),
                            ...(n >= 16 ? [field('Bits a sample', t + 14, 2, bits)] : []),
                            ...(n >= 18 ? [field('Extra size', t + 16, 2, extra)] : []),
                        ];
                        return {
                            name: 'Sound format',
                            offset: t,
                            length: n,
                            value: `${SOUND_FORMATS[tag] ?? `format ${tag}`}, ${channels === 1 ? 'mono' : channels === 2 ? 'stereo' : `${channels} channels`}, ${sampleRate.toLocaleString('en-US')} Hz`,
                            children: fillGaps(data, children, t, t + n, 'Extra'),
                        };
                    }
                    return { name: 'Format', offset: t, length: n, value: bytesLabel(n) };
                }
                if (id === 'strn') {
                    s.name = new TextDecoder('latin1').decode(data.subarray(t, t + n)).replace(/\0.*$/s, '');
                    return { name: 'Stream name', offset: t, length: n, value: JSON.stringify(s.name) };
                }
                if (id === 'JUNK') return { name: 'Padding (JUNK)', offset: t, length: n, value: bytesLabel(n) };
                return null;
            });
            if (!s.type) once(`Stream ${s.number} has no header ("strh"): what it holds can’t be told.`);
            else if (!sawFormat) once(`Stream ${s.number} has no format ("strf"): it can’t be played.`);
            return inside;
        };

        /** The movie data: each chunk to its stream. */
        const readMovie = (at: number, size: number): Field[] => {
            moviCount++;
            if (!movi) movi = at - 4;
            return movieChunks(at, size);
        };
        const movieChunks = (at: number, size: number): Field[] =>
            chunks(
                at,
                at + size,
                'in the movie data ',
                (id, t, n, kids) => {
                    if (id === 'LIST' && n >= 4) {
                        const form = list(t, n, kids);
                        // A group of chunks played together.
                        if (form === 'rec ') return { name: 'Group of chunks', offset: t, length: n, value: bytesLabel(n), children: movieChunks(t + 4, n - 4) };
                        return null;
                    }
                    if (id === 'JUNK') return { name: 'Padding (JUNK)', offset: t, length: n, value: bytesLabel(n) };
                    const number = Number(id.slice(0, 2));
                    const kind = id.slice(2);
                    if (/^ix/.test(id) || !/^\d\d$/.test(id.slice(0, 2))) return null;
                    const s = streams[number];
                    if (!s) {
                        once(`The movie data has chunks for stream ${number}, which its header doesn’t have.`);
                        return null;
                    }
                    s.chunks.push({ at: t, size: n, kind });
                    const what = kind === 'dc' ? 'compressed frame' : kind === 'db' ? 'frame' : kind === 'pc' ? 'palette change' : kind === 'wb' ? 'sound' : kind;
                    return { name: `Stream ${number}: ${what}`, offset: t, length: n, value: bytesLabel(n) };
                },
                MOST_FIELDS
            );

        // The RIFF, and any AVIX RIFFs after it.
        const said4 = b.u32(4);
        let end = 8 + said4;
        if (end > data.length) {
            warnings.push(`It says it runs to ${bytesLabel(end)}, but the file ends at ${bytesLabel(data.length)}: it’s been cut short.`);
            end = data.length;
        }
        const fields: Field[] = [
            {
                name: 'RIFF header',
                offset: 0,
                length: 12,
                value: 'AVI ',
                children: [field('ID', 0, 4, 'RIFF'), field('Size', 4, 4, bytesLabel(said4), 'Of everything after this field.'), field('Form', 8, 4, 'AVI ')],
            },
        ];
        let sawHeaders = false;
        const top = (id: string, t: number, n: number, kids: Field[]): Field | null => {
            if (id === 'LIST') {
                const form = list(t, n, kids);
                if (form === 'hdrl') {
                    sawHeaders = true;
                    const inside = chunks(t + 4, t + n, 'in the headers ', (h, ht, hn, hk) => {
                        if (h === 'avih' && hn >= 40) {
                            main = { microseconds: b.u32(ht), frames: b.u32(ht + 16), streams: b.u32(ht + 24), width: b.u32(ht + 32), height: b.u32(ht + 36) };
                            const children = [
                                field('Time a frame', ht, 4, `${main.microseconds.toLocaleString('en-US')} µs`),
                                field('Bytes a second', ht + 4, 4, b.u32(ht + 4), 'At most, to play it.'),
                                field('Padding granularity', ht + 8, 4, b.u32(ht + 8)),
                                field('Flags', ht + 12, 4, `0x${hex(b.u32(ht + 12))}`, '0x10: it has an index; 0x20: play it in the index’s order; 0x100: interleaved.'),
                                field('Frames', ht + 16, 4, main.frames),
                                field('Initial frames', ht + 20, 4, b.u32(ht + 20)),
                                field('Streams', ht + 24, 4, main.streams),
                                field('Buffer size', ht + 28, 4, bytesLabel(b.u32(ht + 28))),
                                field('Width', ht + 32, 4, main.width),
                                field('Height', ht + 36, 4, main.height),
                                ...(hn >= 56
                                    ? [field('Reserved', ht + 40, 16, [0, 4, 8, 12].map((k) => `0x${hex(b.u32(ht + 40 + k))}`).join(' '), 'Unused: some tools leave whatever was in memory.')]
                                    : []),
                            ];
                            return {
                                name: 'Main header',
                                offset: ht,
                                length: hn,
                                value: `${plural(main.frames, 'frame')}, ${plural(main.streams, 'stream')}`,
                                children: fillGaps(data, children, ht, ht + hn, 'Not read'),
                            };
                        }
                        if (h === 'LIST') {
                            const f = list(ht, hn, hk);
                            if (f === 'strl') return { name: `Stream ${streams.length}`, offset: ht, length: hn, children: readStream(ht + 4, hn - 4) };
                            return { name: `List ${JSON.stringify(f)}`, offset: ht, length: hn, value: bytesLabel(hn) };
                        }
                        if (h === 'JUNK') return { name: 'Padding (JUNK)', offset: ht, length: hn, value: bytesLabel(hn) };
                        return null;
                    });
                    return { name: 'Headers', offset: t, length: n, children: inside };
                }
                if (form === 'movi') return { name: 'Movie data', offset: t, length: n, value: bytesLabel(n), children: readMovie(t + 4, n - 4) };
                if (form === 'INFO') {
                    const inside = chunks(t + 4, t + n, 'in the INFO list ', (tag, it, inn) => ({
                        name: `Text ${JSON.stringify(tag)}`,
                        offset: it,
                        length: inn,
                        value: JSON.stringify(new TextDecoder('latin1').decode(data.subarray(it, it + inn)).replace(/\0.*$/s, '')),
                    }));
                    return { name: 'About it', offset: t, length: n, children: inside };
                }
                return { name: `List ${JSON.stringify(form)}`, offset: t, length: n, value: bytesLabel(n) };
            }
            if (id === 'idx1') {
                index = { at: t, size: n };
                return { name: 'Index', offset: t, length: n, value: plural(Math.floor(n / 16), 'entry', 'entries'), note: 'Each chunk’s ID, flags (0x10: a key frame), where it is and its size.' };
            }
            if (id === 'JUNK') return { name: 'Padding (JUNK)', offset: t, length: n, value: bytesLabel(n) };
            return null;
        };
        fields.push(...chunks(12, end, '', top));
        if (!sawHeaders) throw new Error('This isn’t an AVI video: it has no headers ("hdrl" list).');
        if (!main) throw new Error('This isn’t an AVI video: its headers have no main header ("avih").');
        const header = main as { frames: number; streams: number; width: number; height: number; microseconds: number };
        // OpenDML: the movie goes on in RIFFs of the form AVIX.
        while (end + 12 <= data.length && b.ascii(end, 4) === 'RIFF' && b.ascii(end + 8, 4) === 'AVIX') {
            const at = end;
            const size = b.u32(at + 4);
            const stop = Math.min(data.length, at + 8 + size);
            if (at + 8 + size > data.length) once(`The AVIX RIFF at ${at.toLocaleString('en-US')} says it’s ${bytesLabel(size)}, past the end of the file: it’s been cut short.`);
            extended++;
            fields.push({
                name: `More of the movie (AVIX ${extended})`,
                offset: at,
                length: stop - at,
                children: [field('ID', at, 4, 'RIFF'), field('Size', at + 4, 4, bytesLabel(size)), field('Form', at + 8, 4, 'AVIX'), ...chunks(at + 12, stop, '', top)],
            });
            end = stop;
        }

        if (header.streams !== streams.length)
            warnings.push(`Its main header says it has ${plural(header.streams, 'stream')}, but ${streams.length.toLocaleString('en-US')} ${streams.length === 1 ? 'is' : 'are'} described.`);
        if (!moviCount) warnings.push('It has no movie data ("movi" list): there’s nothing to play.');

        // The index: key frames, and whether it points where the chunks are. Its offsets count from the "movi" list's
        // form, as the spec has it, or (some writers) from the file's start.
        const keys = new Set<number>();
        if (index) {
            const { at, size } = index;
            const count = Math.floor(size / 16);
            const fits = (base: number, k: number) => {
                const p = base + b.u32(at + k * 16 + 8);
                return p + 8 <= data.length && b.ascii(p, 4) === b.ascii(at + k * 16, 4);
            };
            const base = count && fits(movi, 0) ? movi : count && fits(0, 0) ? 0 : movi;
            let wrong = 0;
            for (let k = 0; k < count; k++) {
                const e = at + k * 16;
                if (!fits(base, k)) {
                    if (b.ascii(e, 4) !== 'rec ') wrong++;
                    continue;
                }
                if (b.u32(e + 4) & KEY_FLAG) keys.add(base + b.u32(e + 8) + 8);
            }
            if (wrong)
                warnings.push(
                    `${plural(wrong, 'entry', 'entries')} of its index ${wrong === 1 ? 'points' : 'point'} where no such chunk is: a player that goes by the index would play the wrong data.`
                );
        }

        // The video: the first stream of it, drawn when it's a kind drawn here.
        const video = streams.find((s) => s.type === 'vids');
        const frames = video ? video.chunks.filter((c) => c.kind === 'db' || c.kind === 'dc') : [];
        if (video && !extended && header.frames !== frames.length)
            warnings.push(`Its main header says it has ${plural(header.frames, 'frame')}, but its video has ${frames.length.toLocaleString('en-US')}.`);
        if (video && video.length !== frames.length)
            warnings.push(`Stream ${video.number}’s header says it’s ${plural(video.length, 'frame')} long, but it has ${frames.length.toLocaleString('en-US')}.`);
        const fps = video && video.rate && video.scale ? video.rate / video.scale : header.microseconds ? 1e6 / header.microseconds : 0;

        let preview: Preview | undefined;
        const v = video?.video;
        if (video && v && v.drawn && frames.length && fps > 0) {
            checkPixels(v.width, v.height, 'Each frame');
            const indexed = v.bits <= 8;
            // The palette each frame is drawn with: the format's, then each palette change from where it comes.
            const palettes: Uint8Array[] = [v.colors];
            const paletteOf: number[] = [];
            let current = v.colors;
            for (const c of video.chunks) {
                if (c.kind === 'pc') {
                    const first = data[c.at];
                    const count = data[c.at + 1] || 256;
                    if (c.size < 4 + count * 4 || first + count > 256) {
                        once(
                            `A palette change in stream ${video.number} says it sets ${count} colors from ${first}, which ${first + count > 256 ? 'runs past the 256 a palette has' : 'is more than it holds'}.`
                        );
                    }
                    const next = current.slice();
                    for (let i = 0; i < count && first + i < 256 && 4 + i * 4 + 3 <= c.size; i++) next.set([data[c.at + 4 + i * 4], data[c.at + 5 + i * 4], data[c.at + 6 + i * 4]], (first + i) * 3);
                    palettes.push(next);
                    current = next;
                } else if (c.kind === 'db' || c.kind === 'dc') paletteOf.push(palettes.length - 1);
            }
            const rle = v.compression === 1 || v.compression === 2;
            const need = strideOf(v) * v.height;
            const problems = new Set<Problem>();
            let short = 0;
            if (!rle) for (const f of frames) if (f.size && f.size < need) short++;
            if (short) warnings.push(`${plural(short, 'frame')} ${short === 1 ? 'is' : 'are'} shorter than the ${bytesLabel(need)} an uncompressed frame takes: what’s missing is drawn black.`);

            // RLE frames are drawn over the one before, so the frames from a key frame (or the first) to the one asked for.
            const pixels = new Uint8Array(v.width * v.height);
            let drawnUpTo = -1;
            const keyBefore = (i: number) => {
                for (let k = i; k > 0; k--) if (keys.has(frames[k].at)) return k;
                return 0;
            };
            const lastWithData = (i: number) => {
                let k = i;
                while (k > 0 && !frames[k].size) k--;
                return k;
            };
            const draw = (i: number) => {
                const f = frames[i];
                if (rle) drawRle(data.subarray(f.at, f.at + f.size), pixels, v, problems);
                else drawIndexed(data.subarray(f.at, f.at + f.size), pixels, v);
            };
            const frameAt = (i: number) => {
                if (rle) {
                    if (i < drawnUpTo || drawnUpTo < 0) {
                        pixels.fill(0);
                        drawnUpTo = keyBefore(i) - 1;
                    }
                    for (let k = drawnUpTo + 1; k <= i; k++) draw(k);
                    drawnUpTo = i;
                } else if (indexed) {
                    pixels.fill(0);
                    draw(lastWithData(i));
                }
            };
            // Draw them all once now, to say what's wrong with any; playing draws them again as asked.
            if (rle) for (let i = 0; i < frames.length; i++) frameAt(i);
            const told: Record<Problem, string> = {
                'past-edge': 'Some RLE frames draw past the right edge of the picture: what’s past it isn’t drawn.',
                'past-end': 'Some RLE frames draw past the top of the picture: what’s past it isn’t drawn.',
                'no-end': 'Some RLE frames stop in the middle of a row, without the code that ends a picture: they’ve been cut short.',
                short: 'Some RLE frames end in the middle of a run of colors: they’ve been cut short.',
            };
            for (const p of problems) warnings.push(told[p]);

            const audio = soundOf(streams.find((s) => s.type === 'auds'));
            preview = {
                kind: 'video',
                width: v.width,
                height: v.height,
                frameCount: frames.length,
                fps,
                frame(i) {
                    if (!indexed) return { rgba: drawTrueColor(data.subarray(frames[lastWithData(i)].at, frames[lastWithData(i)].at + frames[lastWithData(i)].size), v) };
                    frameAt(i);
                    // Copies: what goes to the page is handed over, and gone from here after.
                    return { pixels: pixels.slice(), palette: palettes[paletteOf[i]].slice() };
                },
                ...(audio ? { audio } : {}),
            };
        }

        /** A sound stream's chunks, decoded, when it's a kind played here. */
        function soundOf(s: Stream | undefined): AudioClip | undefined {
            const f = s?.sound;
            if (!s || !f || !f.channels || !f.sampleRate) return undefined;
            const parts = s.chunks.filter((c) => c.kind === 'wb');
            const total = checkBytes(
                parts.reduce((n, c) => n + c.size, 0),
                'Its sound'
            );
            const bytes = new Uint8Array(total);
            let p = 0;
            for (const c of parts) {
                bytes.set(data.subarray(c.at, c.at + c.size), p);
                p += c.size;
            }
            const { tag, channels, sampleRate: rate, blockAlign, bits } = f;
            if (tag === WAV_PCM && (bits === 8 || bits === 16)) {
                const samples = bits === 8 ? bytes : new Int16Array(bytes.buffer, 0, bytes.length >> 1);
                return { wav: wav(samples, rate, channels), sampleRate: rate, channels, bits, seconds: samples.length / channels / rate };
            }
            if (tag === WAV_MS_ADPCM && blockAlign > 7 * channels) {
                const samples = decodeMsAdpcm(bytes, channels, blockAlign, f.coefficients);
                return { wav: wav(samples, rate, channels), sampleRate: rate, channels, bits: 16, seconds: samples.length / channels / rate };
            }
            if (tag === WAV_IMA_ADPCM && blockAlign > 4 * channels) {
                const samples = decodeImaWav(bytes, channels, blockAlign);
                return { wav: wav(samples, rate, channels), sampleRate: rate, channels, bits: 16, seconds: samples.length / channels / rate };
            }
            if (tag === 0x55 && f.bytesPerSecond) return { wav: bytes, mime: 'audio/mpeg', sampleRate: rate, channels, bits: 16, seconds: total / f.bytesPerSecond };
            return undefined;
        }
        const sounds = streams.filter((s) => s.type === 'auds').map((s) => ({ s, clip: soundOf(s) }));
        if (!preview && sounds[0]?.clip) preview = { kind: 'audio', ...sounds[0].clip };

        const stem = (context.name ?? context.label ?? 'video').replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '');
        const entries: Entry[] = sounds
            .filter((x) => x.clip)
            .map(({ s, clip }) => ({ name: null, label: `${stem}-sound-${s.number}.${clip!.mime === 'audio/mpeg' ? 'mp3' : 'wav'}`, offset: 0, size: clip!.wav.length, data: clip!.wav }));

        const summary: [string, string][] = [];
        if (video) {
            const vf = video.video;
            const kind = !vf
                ? 'no format'
                : vf.compression === 1 || vf.compression === 2
                  ? `Microsoft RLE, ${vf.bits} bits a pixel`
                  : vf.compression === 0 || vf.compression === 3
                    ? `uncompressed, ${vf.bits} bits a pixel`
                    : `${VIDEO_CODECS[vf.codec] ?? JSON.stringify(vf.codec)}${vf.drawn ? '' : ', not drawn here'}`;
            summary.push(['Video', `${vf ? `${vf.width} × ${vf.height}, ` : ''}${kind}`]);
            summary.push(['Frames', `${frames.length.toLocaleString('en-US')} at ${Number(fps.toFixed(3))} a second, ${fps ? (frames.length / fps).toFixed(2) : '?'} s`]);
        }
        for (const { s, clip } of sounds) {
            const f = s.sound;
            summary.push([
                sounds.length > 1 ? `Sound ${s.number}` : 'Sound',
                f
                    ? `${SOUND_FORMATS[f.tag] ?? `format ${f.tag}`}, ${f.channels === 1 ? 'mono' : f.channels === 2 ? 'stereo' : `${f.channels} channels`}, ${f.sampleRate.toLocaleString('en-US')} Hz${clip ? `, ${clip.seconds.toFixed(2)} s` : ', not played here'}`
                    : 'no format',
            ]);
        }
        const others = streams.filter((s) => s.type !== 'vids' && s.type !== 'auds');
        if (others.length) summary.push(['Other streams', others.map((s) => STREAM_TYPES[s.type] ?? JSON.stringify(s.type)).join(', ')]);

        return {
            title: 'Video (AVI)',
            summary,
            fields: fillGaps(data, fields, 0, end, 'Not read'),
            preview,
            entries,
            end,
            warnings,
        };
    },
};

export default parser;
