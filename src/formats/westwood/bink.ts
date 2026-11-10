import { Bytes, bytesLabel, field } from '../../core/bytes';
import type { AudioClip, FormatParser, VideoFrame } from '../../core/types';
import { wav } from './adpcm';
import type { BinkWasm } from './bink-wasm/bink.mjs';

/**
 * Bink video (RAD Game Tools), which RA2 uses for its movies, and Bink 2 ("KB2"),
 * which the C&C Remastered Collection uses for its new ones. The container is
 * read here: a 44-byte header (4 bytes more in Bink 1's revision k and Bink 2's
 * i to k), then per sound track a size, its rate and flags, and an ID, then
 * where each frame starts (bit 0 marks a keyframe). Each frame holds, per sound
 * track, a 4-byte size and that much audio, then the video.
 *
 * The packets are decoded by FFmpeg's Bink decoders, compiled to WebAssembly
 * (wasm/bink), which load only when a Bink file is opened. FFmpeg has no Bink 2
 * video decoder (RAD never published the format), so Bink 2 files play their
 * sound only; their sound is the same Bink audio as Bink 1's.
 */

const AUDIO_STEREO = 0x2000;
const AUDIO_DCT = 0x1000;

let wasm: BinkWasm | null = null;
let loading: Promise<void> | null = null;

/** Loads the decoders; the format registry waits for this before parsing. */
export function ready(): Promise<void> {
    loading ??= import('./bink-wasm/bink.mjs')
        .then((m) => m.default())
        .then((w) => {
            wasm = w;
        })
        .catch(() => {
            // Without the decoders the header is still shown.
        });
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
        if ((offsets[i] & ~1) < index + (count + 1) * 4 || (offsets[i] & ~1) > (offsets[i + 1] & ~1) || (i + 1 < count && (offsets[i + 1] & ~1) > data.length)) throw new Error(`Frame ${i}'s place in the frame index (${offsets[i] & ~1} to ${offsets[i + 1] & ~1}) isn't inside the file, in order.`);
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

/** Copies bytes into the decoders' memory (growing a reused buffer), returning where. */
class Input {
    private pointer = 0;
    private size = 0;
    constructor(private readonly w: BinkWasm) {}
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

/** How often to keep the decoder's state while playing, so a jump only decodes from the nearest one. */
const SNAPSHOT_EVERY = 100;

/** Only the most recently opened movie keeps its decoder and snapshots; the one before lets them go. */
let current: Player | null = null;

/**
 * Plays frames in order. RA2's movies have one keyframe, at the start, so the
 * decoder's state is kept every SNAPSHOT_EVERY frames as it goes: a jump starts
 * from the nearest kept frame (or keyframe) before the one wanted.
 */
class Player {
    private decoder = 0;
    private rgba = 0;
    private input: Input | null = null;
    private position = -1;
    /** Frame number → the decoder's reference frame just after decoding it. */
    private readonly snapshots = new Map<number, number>();
    errors = 0;

    constructor(
        private readonly w: BinkWasm,
        private readonly data: Uint8Array,
        private readonly l: Layout,
    ) {
        this.open();
    }

    private open() {
        if (current && current !== this) current.close();
        current = this;
        if (this.decoder) return;
        this.decoder = this.w._video_open(this.l.tag, this.l.flags, this.l.width, this.l.height);
        if (!this.decoder) throw new Error('The Bink decoder wouldn\'t open this video.');
        this.rgba = this.w._malloc(this.l.width * this.l.height * 4);
        this.input = new Input(this.w);
        this.position = -1;
    }

    /** Lets the decoder and snapshots go; opening again starts afresh. */
    close() {
        if (!this.decoder) return;
        for (const saved of this.snapshots.values()) this.w._video_forget(saved);
        this.snapshots.clear();
        this.w._decoder_close(this.decoder);
        this.w._free(this.rgba);
        this.input?.free();
        this.decoder = this.rgba = 0;
        this.input = null;
    }

    private decode(i: number, draw: boolean) {
        const video = packets(this.data, this.l, i).video;
        if (video.length && this.w._video_decode(this.decoder, this.input!.put(video), video.length, draw ? this.rgba : 0) < 0) this.errors++;
        this.position = i;
        if (i % SNAPSHOT_EVERY === 0 && i > 0 && !this.snapshots.has(i)) {
            const saved = this.w._video_save(this.decoder);
            if (saved) this.snapshots.set(i, saved);
        }
    }

    frame(index: number): VideoFrame {
        this.open();
        // Where to start: the frame before this one, the nearest kept state, or the keyframe.
        let key = index;
        while (key > 0 && !this.l.frames[key].key) key--;
        let snapshot = -1;
        for (const at of this.snapshots.keys()) if (at < index && at >= key && at > snapshot) snapshot = at;
        const best = Math.max(key - 1, snapshot);
        if (!(this.position >= best && this.position < index)) {
            if (snapshot >= key && this.w._video_restore(this.decoder, this.snapshots.get(snapshot)!) >= 0) {
                this.position = snapshot;
            } else {
                this.w._decoder_flush(this.decoder);
                this.position = key - 1;
            }
        }
        while (this.position < index - 1) this.decode(this.position + 1, false);
        this.decode(index, true);
        return { rgba: this.w.HEAPU8.slice(this.rgba, this.rgba + this.l.width * this.l.height * 4) };
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
        let audio: AudioClip | undefined;
        /** Bink 2's other sound tracks (the Remastered Collection's movies have one per language, it seems). */
        let others: AudioClip[] = [];
        if (!wasm) warnings.push('The Bink decoder couldn\'t be loaded, so only the header is shown.');
        else {
            try {
                if (l.two) warnings.push('Bink 2 video can\'t be shown: RAD never published the format and FFmpeg has no decoder for it. The sound plays.');
                else player = new Player(wasm, data, l);
                audio = sound(wasm, data, l);
                if (l.two) others = l.tracks.slice(1).map((_, i) => sound(wasm!, data, l, i + 1)).filter((c): c is AudioClip => !!c);
            } catch (e) {
                warnings.push(e instanceof Error ? e.message : String(e));
            }
        }

        return {
            title: l.two ? 'Bink 2 video' : 'Bink video',
            summary: [
                ['Version', b.ascii(3, 1)],
                ['Size', `${l.width} × ${l.height}`],
                ['Frames', `${count} at ${+fps.toFixed(3)} per second (${fps ? (count / fps).toFixed(1) : '?'} s), ${((k) => `${k} keyframe${k === 1 ? '' : 's'}`)(l.frames.filter((f) => f.key).length)}`],
                ['Sound', l.tracks.length ? l.tracks.map((t) => `${t.rate} Hz ${t.flags & AUDIO_STEREO ? 'stereo' : 'mono'}, ${t.flags & AUDIO_DCT ? 'DCT' : 'RDFT'}`).join('; ') : 'None'],
                ['Decoder', l.two ? 'Sound only: FFmpeg\'s Bink audio decoder, compiled to WebAssembly' : 'FFmpeg\'s Bink decoders, compiled to WebAssembly'],
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
                ...(l.base > 44 ? [field('Unknown', 44, 4, `0x${b.u32(44).toString(16).padStart(8, '0')}`, 'Added in Bink 1\'s revision k and Bink 2\'s i; not documented.')] : []),
                ...l.tracks.map((_, i) => field(`Track ${i} largest decoded size`, l.base + i * 4, 4, bytesLabel(b.u32(l.base + i * 4)))),
                ...l.tracks.map((t, i) => field(`Track ${i} format`, l.base + l.tracks.length * 4 + i * 4, 4, `${t.rate} Hz${t.flags & AUDIO_STEREO ? ', stereo' : ''}${t.flags & AUDIO_DCT ? ', DCT' : ', RDFT'}`)),
                ...l.tracks.map((_, i) => field(`Track ${i} ID`, l.base + l.tracks.length * 8 + i * 4, 4, b.u32(l.base + l.tracks.length * 8 + i * 4))),
                field('Frame index', l.base + l.tracks.length * 12, (count + 1) * 4, `${count + 1} offsets`, 'Where each frame starts; bit 0 marks a keyframe.'),
                ...l.frames.slice(0, 2000).map((f, i) => field(`Frame ${i}${f.key ? ' (keyframe)' : ''}`, f.start, f.end - f.start, bytesLabel(f.end - f.start))),
            ],
            preview: player
                ? { kind: 'video', width: l.width, height: l.height, frameCount: count, fps: fps || 15, frame: (i) => player.frame(i), audio }
                : audio && others.length
                  ? { kind: 'stack', items: [audio, ...others].map((clip, i) => ({ title: `Sound track ${i + 1}`, preview: { kind: 'audio', ...clip } })) }
                  : audio
                    ? { kind: 'audio', ...audio }
                    : undefined,
            warnings,
        };
    },
};

export default parser;
