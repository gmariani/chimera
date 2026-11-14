import { Bytes, bytesLabel, field } from '../../core/bytes';
import { checkPixels } from '../../core/limits';
import type { AudioClip, FormatParser, VideoFrame } from '../../core/types';
import { wav } from './adpcm';
import type { BinkWasm } from './bink-wasm/bink.mjs';
import type { Bink2Wasm } from './bink2-wasm/bink2.mjs';

/**
 * Bink video (RAD Game Tools), which RA2 uses for its movies, and Bink 2 ("KB2"),
 * which the C&C Remastered Collection uses for its new ones. The container is
 * read here: a 44-byte header (4 bytes more in Bink 1's revision k and Bink 2's
 * i to k), then per sound track a size, its rate and flags, and an ID, then
 * where each frame starts (bit 0 marks a keyframe). Each frame holds, per sound
 * track, a 4-byte size and that much audio, then the video.
 *
 * The packets are decoded by FFmpeg's Bink decoders, compiled to WebAssembly
 * (wasm/bink), which load only when a Bink file is opened. Bink 2's sound is the
 * same Bink audio. Its video has no decoder in FFmpeg (RAD never published the
 * format): it's decoded by Paul B Mahol's unmerged one, taken from a fork of
 * FFmpeg with fixes of ours and built into FFmpeg 7.1 (wasm/bink2), in a
 * module of its own.
 */

const AUDIO_STEREO = 0x2000;
const AUDIO_DCT = 0x1000;
/** In the video flags: the movie has an alpha plane. */
const ALPHA = 0x100000;

let wasm: BinkWasm | null = null;
let wasm2: Bink2Wasm | null = null;
let loading: Promise<void> | null = null;

/** Loads the decoders; the format registry waits for this before parsing. */
export function ready(): Promise<void> {
    loading ??= Promise.all([
        import('./bink-wasm/bink.mjs')
            .then((m) => m.default())
            .then((w) => {
                wasm = w;
            }),
        import('./bink2-wasm/bink2.mjs')
            .then((m) => m.default())
            .then((w) => {
                wasm2 = w;
            }),
    ])
        .catch(() => {
            // Without the decoders the header is still shown.
        })
        .then(() => undefined);
    return loading;
}

interface Layout {
    tag: number;
    /** Bink 2. */
    two: boolean;
    /** Where the sound tracks' sizes start: after the header and, in later revisions, a field nobody has named. */
    base: number;
    flags: number;
    width: number;
    height: number;
    frames: { start: number; end: number; key: boolean }[];
    tracks: { rate: number; flags: number }[];
}

function layout(data: Uint8Array): Layout {
    const b = new Bytes(data);
    const two = b.ascii(0, 3) === 'KB2';
    const revision = b.ascii(3, 1);
    // As FFmpeg's demuxer has it: Bink 1's revision k and Bink 2's i, j and k add 4 bytes here.
    const base = (!two && revision === 'k') || (two && 'ijk'.includes(revision)) ? 48 : 44;
    const count = b.u32(8);
    const tracks = b.u32(40);
    const trackInfo = base + tracks * 4;
    const index = base + tracks * 12;
    // Checked before anything is sized by them: a damaged or fake header can claim billions.
    if (tracks > 256) throw new Error(`The header says there are ${tracks.toLocaleString('en-US')} sound tracks; no movie has more than a few.`);
    if (index + (count + 1) * 4 > data.length) throw new Error(`The header says there are ${count.toLocaleString('en-US')} frames, but the frame index wouldn't fit in the file.`);
    const offsets = Array.from({ length: count + 1 }, (_, i) => b.u32(index + i * 4));
    // The last frame may run a little past the end (it's cut to fit); the others must be inside.
    for (let i = 0; i < count; i++) {
        if ((offsets[i] & ~1) < index + (count + 1) * 4 || (offsets[i] & ~1) > (offsets[i + 1] & ~1) || (i + 1 < count && (offsets[i + 1] & ~1) > data.length))
            throw new Error(`Frame ${i}'s place in the frame index (${offsets[i] & ~1} to ${offsets[i + 1] & ~1}) isn't inside the file, in order.`);
    }
    return {
        tag: b.u32(0),
        two,
        base,
        flags: b.u32(36),
        width: b.u32(20),
        height: b.u32(24),
        frames: Array.from({ length: count }, (_, i) => ({ start: offsets[i] & ~1, end: Math.min(offsets[i + 1] & ~1, data.length), key: (offsets[i] & 1) === 1 })),
        tracks: Array.from({ length: tracks }, (_, i) => ({ rate: b.u16(trackInfo + i * 4), flags: b.u16(trackInfo + i * 4 + 2) })),
    };
}

/** A frame's packets: one per sound track (empty if it has none this frame), then the video. */
function packets(data: Uint8Array, l: Layout, i: number): { audio: Uint8Array[]; video: Uint8Array } {
    const { start, end } = l.frames[i];
    const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let at = start;
    const audio = l.tracks.map(() => {
        const size = at + 4 <= end ? v.getUint32(at, true) : 0;
        const packet = size >= 4 && at + 4 + size <= end ? data.subarray(at + 4, at + 4 + size) : new Uint8Array();
        at = Math.min(end, at + 4 + size);
        return packet;
    });
    return { audio, video: data.subarray(at, end) };
}

/** What both decoder modules have for their memory. */
interface Memory {
    HEAPU8: Uint8Array;
    _malloc(size: number): number;
    _free(pointer: number): void;
}

/** Copies bytes into the decoders' memory (growing a reused buffer), returning where. */
class Input {
    private pointer = 0;
    private size = 0;
    constructor(private readonly w: Memory) {}
    put(bytes: Uint8Array): number {
        if (bytes.length > this.size) {
            if (this.pointer) this.w._free(this.pointer);
            this.size = bytes.length + 1024;
            this.pointer = this.w._malloc(this.size + 64);
        }
        this.w.HEAPU8.set(bytes, this.pointer);
        return this.pointer;
    }
    free() {
        if (this.pointer) this.w._free(this.pointer);
        this.pointer = this.size = 0;
    }
}

/** The video decoders' common calls: Bink 1's in one module, Bink 2's in another. */
interface Codec {
    w: Memory;
    open(l: Layout): number;
    /** 1 for a frame, written to rgba unless that's 0, 2^shift times smaller each way; negative on error. */
    decode(decoder: number, data: number, size: number, key: boolean, rgba: number, shift: number): number;
    /** The codec can draw a frame smaller, for playing large movies. */
    canShrink: boolean;
    save(decoder: number): number;
    restore(decoder: number, saved: number): number;
    forget(saved: number): void;
    flush(decoder: number): void;
    close(decoder: number): void;
}

const bink1 = (w: BinkWasm): Codec => ({
    w,
    open: (l) => w._video_open(l.tag, l.flags, l.width, l.height),
    decode: (d, data, size, _key, rgba) => w._video_decode(d, data, size, rgba),
    canShrink: false,
    save: (d) => w._video_save(d),
    restore: (d, saved) => w._video_restore(d, saved),
    forget: (saved) => w._video_forget(saved),
    flush: (d) => w._decoder_flush(d),
    close: (d) => w._decoder_close(d),
});

const bink2 = (w: Bink2Wasm): Codec => ({
    w,
    open: (l) => w._video_open(l.tag, l.flags, l.width, l.height),
    decode: (d, data, size, key, rgba, shift) => w._video_decode(d, data, size, key ? 1 : 0, rgba, shift, 0),
    canShrink: true,
    save: (d) => w._video_save(d),
    restore: (d, saved) => w._video_restore(d, saved),
    forget: (saved) => w._video_forget(saved),
    flush: (d) => w._decoder_flush(d),
    close: (d) => w._decoder_close(d),
});

/** Keep the decoder's state at least this often while playing, so a jump only decodes from the nearest one... */
const SNAPSHOT_EVERY = 100;
/** ...but no more of them than fit in this much memory: a 26-minute 1080p movie would need 1.5 GB at every 100 frames. */
const SNAPSHOT_BUDGET = 256 * 1024 * 1024;
/**
 * A movie bigger than this many pixels plays at half size each way (a quarter of the pixels), so it keeps up: turning
 * a 4K frame into 33 MB of RGBA and handing it to the page 30 times a second is more than a browser manages, where the
 * decoding itself keeps up. 1080p plays at full size. Paused, and saved, a frame is always full size.
 */
const PLAY_SMALLER_ABOVE = 1920 * 1088;

/** Only the most recently opened movie keeps its decoder and snapshots; the one before lets them go. */
let current: Player | null = null;

/**
 * Plays frames in order. RA2's and the Remastered Collection's movies have one
 * keyframe, at the start, so the decoder's state is kept every so many frames as
 * it goes: a jump starts from the nearest kept frame (or keyframe) before the one wanted.
 */
class Player {
    private decoder = 0;
    private rgba = 0;
    private input: Input | null = null;
    private position = -1;
    /** Frame number → the decoder's reference frame just after decoding it. */
    private readonly snapshots = new Map<number, number>();
    private readonly every: number;
    errors = 0;

    constructor(
        private readonly codec: Codec,
        private readonly data: Uint8Array,
        private readonly l: Layout
    ) {
        // What one kept frame costs: the planes as the decoder pads them (to 32), and alpha's plane when there is one.
        const padded = Math.ceil(l.width / 32) * 32 * Math.ceil(l.height / 32) * 32;
        const each = padded * (l.flags & ALPHA ? 2.5 : 1.5);
        this.every = Math.max(SNAPSHOT_EVERY, Math.ceil(l.frames.length / Math.max(1, Math.floor(SNAPSHOT_BUDGET / each))));
        this.open();
    }

    private open() {
        if (current && current !== this) current.close();
        // Not an alias: the module keeps track of which video has the one decoder.
        // oxlint-disable-next-line typescript/no-this-alias
        current = this;
        if (this.decoder) return;
        this.decoder = this.codec.open(this.l);
        if (!this.decoder) throw new Error("The Bink decoder wouldn't open this video.");
        this.rgba = this.codec.w._malloc(this.l.width * this.l.height * 4);
        this.input = new Input(this.codec.w);
        this.position = -1;
    }

    /** Lets the decoder and snapshots go; opening again starts afresh. */
    close() {
        if (!this.decoder) return;
        for (const saved of this.snapshots.values()) this.codec.forget(saved);
        this.snapshots.clear();
        this.codec.close(this.decoder);
        this.codec.w._free(this.rgba);
        this.input?.free();
        this.decoder = this.rgba = 0;
        this.input = null;
    }

    private decode(i: number, draw: boolean, shift = 0) {
        const video = packets(this.data, this.l, i).video;
        if (video.length && this.codec.decode(this.decoder, this.input!.put(video), video.length, this.l.frames[i].key, draw ? this.rgba : 0, shift) < 0) this.errors++;
        this.position = i;
        if (i % this.every === 0 && i > 0 && !this.snapshots.has(i)) {
            const saved = this.codec.save(this.decoder);
            if (saved) this.snapshots.set(i, saved);
        }
    }

    frame(index: number, playing = false): VideoFrame {
        this.open();
        // Where to start: the frame before this one, the nearest kept state, or the keyframe.
        let key = index;
        while (key > 0 && !this.l.frames[key].key) key--;
        let snapshot = -1;
        for (const at of this.snapshots.keys()) if (at < index && at >= key && at > snapshot) snapshot = at;
        const best = Math.max(key - 1, snapshot);
        if (!(this.position >= best && this.position < index)) {
            if (snapshot >= key && this.codec.restore(this.decoder, this.snapshots.get(snapshot)!) >= 0) {
                this.position = snapshot;
            } else {
                this.codec.flush(this.decoder);
                this.position = key - 1;
            }
        }
        while (this.position < index - 1) this.decode(this.position + 1, false);
        const shift = playing && this.codec.canShrink && this.l.width * this.l.height > PLAY_SMALLER_ABOVE ? 1 : 0;
        this.decode(index, true, shift);
        const [width, height] = [(this.l.width + (1 << shift) - 1) >> shift, (this.l.height + (1 << shift) - 1) >> shift];
        // A copy of its own, handed over to the page whole.
        const rgba = this.codec.w.HEAPU8.slice(this.rgba, this.rgba + width * height * 4);
        return shift ? { rgba, width, height } : { rgba };
    }
}

/** A sound track (the first, unless told), decoded whole. */
function sound(w: BinkWasm, data: Uint8Array, l: Layout, index = 0): AudioClip | undefined {
    const track = l.tracks[index];
    if (!track || !track.rate) return undefined;
    const channels = track.flags & AUDIO_STEREO ? 2 : 1;
    const decoder = w._audio_open(track.flags & AUDIO_DCT ? 1 : 0, l.tag, track.rate, channels);
    if (!decoder) return undefined;
    const max = 1 << 18;
    const out = w._malloc(max * 2);
    const input = new Input(w);
    const chunks: Int16Array[] = [];
    try {
        for (let i = 0; i < l.frames.length; i++) {
            const packet = packets(data, l, i).audio[index];
            if (!packet.length) continue;
            const n = w._audio_decode(decoder, input.put(packet), packet.length, out, max);
            if (n > 0) chunks.push(w.HEAP16.slice(out >> 1, (out >> 1) + n));
        }
    } finally {
        w._free(out);
        input.free();
        w._decoder_close(decoder);
    }
    const samples = new Int16Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of chunks) {
        samples.set(c, at);
        at += c.length;
    }
    return { wav: wav(samples, track.rate, channels), sampleRate: track.rate, channels, bits: 16, seconds: samples.length / channels / track.rate };
}

/**
 * What a sound track is called: only its number, since nothing in the file names it. (The Remastered Collection's
 * movies with three tracks hold the dialogue in English, German and French, in that order, but their track IDs are
 * just 0, 1 and 2.)
 */
const trackTitle = (i: number, _count: number) => `Sound track ${i + 1}`;

const parser: FormatParser = {
    parse(data) {
        const b = new Bytes(data);
        const signature = b.ascii(0, 3);
        if (signature !== 'BIK' && signature !== 'KB2') throw new Error('No "BIK" or "KB2" header.');
        const l = layout(data);
        const [dividend, divider] = [b.u32(28), b.u32(32)];
        const fps = divider ? dividend / divider : 0;
        const count = l.frames.length;
        const warnings: string[] = [];

        let player: Player | null = null;
        let tracks: AudioClip[] = [];
        if (!wasm) warnings.push("The Bink decoder couldn't be loaded, so only the header is shown.");
        else {
            try {
                checkPixels(l.width, l.height, 'The movie');
                if (count && !l.frames[0].key) warnings.push("The first frame isn't marked as a keyframe, which every Bink movie starts with: there's nothing for it to be drawn over.");
                if (!l.two) player = new Player(bink1(wasm), data, l);
                else if (wasm2) player = new Player(bink2(wasm2), data, l);
                else warnings.push("The Bink 2 video decoder couldn't be loaded, so the picture can't be shown. The sound plays.");
                // The first frame is decoded now, as it's the first shown: a movie whose picture can't be decoded says so.
                if (player && count) {
                    player.frame(0);
                    if (player.errors) warnings.push("The first frame doesn't decode: the video is damaged, or isn't what the header says.");
                }
                tracks = l.tracks.map((_, i) => sound(wasm!, data, l, i)).filter((c): c is AudioClip => !!c);
            } catch (e) {
                warnings.push(e instanceof Error ? e.message : String(e));
            }
        }
        const [audio, ...others] = tracks;

        return {
            title: l.two ? 'Bink 2 video' : 'Bink video',
            summary: [
                ['Version', b.ascii(3, 1)],
                ['Size', `${l.width} × ${l.height}`],
                [
                    'Frames',
                    `${count} at ${+fps.toFixed(3)} per second (${fps ? (count / fps).toFixed(1) : '?'} s), ${((k) => `${k} keyframe${k === 1 ? '' : 's'}`)(l.frames.filter((f) => f.key).length)}`,
                ],
                ['Sound', l.tracks.length ? l.tracks.map((t) => `${t.rate} Hz ${t.flags & AUDIO_STEREO ? 'stereo' : 'mono'}, ${t.flags & AUDIO_DCT ? 'DCT' : 'RDFT'}`).join('; ') : 'None'],
                ['Decoder', l.two ? "An unmerged Bink 2 decoder built into FFmpeg, and FFmpeg's Bink audio decoder, compiled to WebAssembly" : "FFmpeg's Bink decoders, compiled to WebAssembly"],
            ],
            fields: [
                {
                    name: 'Header',
                    offset: 0,
                    length: 44,
                    children: [
                        field('ID', 0, 3, signature),
                        field('Version', 3, 1, b.ascii(3, 1)),
                        field('Size', 4, 4, bytesLabel(b.u32(4)), 'Of everything after this field.'),
                        field('Frames', 8, 4, count),
                        field('Largest frame', 12, 4, bytesLabel(b.u32(12))),
                        field('Frames (again)', 16, 4, b.u32(16)),
                        field('Width', 20, 4, l.width),
                        field('Height', 24, 4, l.height),
                        field('Frame rate dividend', 28, 4, dividend),
                        field('Frame rate divider', 32, 4, divider),
                        field('Video flags', 36, 4, `0x${l.flags.toString(16)}`, 'Bit 20: an alpha plane. Bit 17: grayscale.'),
                        field('Sound tracks', 40, 4, l.tracks.length),
                    ],
                },
                ...(l.base > 44 ? [field('Unknown', 44, 4, `0x${b.u32(44).toString(16).padStart(8, '0')}`, "Added in Bink 1's revision k and Bink 2's i; not documented.")] : []),
                ...l.tracks.map((_, i) => field(`Track ${i} largest decoded size`, l.base + i * 4, 4, bytesLabel(b.u32(l.base + i * 4)))),
                ...l.tracks.map((t, i) =>
                    field(`Track ${i} format`, l.base + l.tracks.length * 4 + i * 4, 4, `${t.rate} Hz${t.flags & AUDIO_STEREO ? ', stereo' : ''}${t.flags & AUDIO_DCT ? ', DCT' : ', RDFT'}`)
                ),
                ...l.tracks.map((_, i) => field(`Track ${i} ID`, l.base + l.tracks.length * 8 + i * 4, 4, b.u32(l.base + l.tracks.length * 8 + i * 4))),
                field('Frame index', l.base + l.tracks.length * 12, (count + 1) * 4, `${count + 1} offsets`, 'Where each frame starts; bit 0 marks a keyframe.'),
                // A field a frame, up to a point: a long movie has tens of thousands.
                ...l.frames.slice(0, 2000).map((f, i) => field(`Frame ${i}${f.key ? ' (keyframe)' : ''}`, f.start, f.end - f.start, bytesLabel(f.end - f.start))),
                ...(count > 2000
                    ? [field(`Frames 2000 to ${count - 1}`, l.frames[2000].start, l.frames[count - 1].end - l.frames[2000].start, `${(count - 2000).toLocaleString('en-US')} more frames`)]
                    : []),
            ],
            end: count ? l.frames[count - 1].end : l.base + l.tracks.length * 12 + (count + 1) * 4,
            preview: player
                ? {
                      kind: 'video',
                      width: l.width,
                      height: l.height,
                      frameCount: count,
                      fps: fps || 15,
                      frame: (i, playing) => player.frame(i, playing),
                      audio,
                      ...(others.length ? { audioTitle: trackTitle(0, tracks.length), otherAudio: others.map((clip, i) => ({ title: trackTitle(i + 1, tracks.length), clip })) } : {}),
                      ...(l.flags & ALPHA ? { transparent: true } : {}),
                  }
                : audio && others.length
                  ? { kind: 'stack', items: tracks.map((clip, i) => ({ title: trackTitle(i, tracks.length), preview: { kind: 'audio', ...clip } })) }
                  : audio
                    ? { kind: 'audio', ...audio }
                    : undefined,
            warnings,
        };
    },
};

export default parser;
