import { pixelBuffer } from '../../core/limits';
import type { Preview } from '../../core/types';
import { wav } from '../westwood/adpcm';
import type { Song } from './smf';
import { renderSong, SAMPLE_RATE } from './synth';

/**
 * A song's previews: a piano roll (its notes over time, a row for each pitch,
 * colored by channel) and the song rendered by Chimera's small synthesizer.
 */

/** The widest piano roll, in pixels; a long song is squeezed to fit. */
const MAX_WIDTH = 2400;
/** Pixels a second, when the song is short enough. */
const PER_SECOND = 24;
const MAX_ROW = 5;
const MIN_ROW = 2;

/** The page's blueprint colors: the ground, its grid, and one color for each channel (10, the drums, in gray). */
const GROUND = [0x0b, 0x1f, 0x3d];
const GRID = [0x1d, 0x3a, 0x63];
const GRID_STRONG = [0x2f, 0x55, 0x8a];
const CHANNEL_COLORS = [
    [0x7f, 0xd4, 0xff],
    [0xff, 0xb3, 0x47],
    [0x9b, 0xe5, 0x6b],
    [0xff, 0x7a, 0x8a],
    [0xc9, 0x9b, 0xff],
    [0x5f, 0xe0, 0xc8],
    [0xff, 0xe0, 0x66],
    [0xff, 0x9a, 0xd5],
    [0x8f, 0xb4, 0xff],
    [0xb8, 0xc4, 0xd6],
    [0xe8, 0x9b, 0x6c],
    [0x6c, 0xc6, 0x8f],
    [0xd6, 0x7f, 0x7f],
    [0x9f, 0xd0, 0xe8],
    [0xe0, 0xc0, 0x8f],
    [0xb0, 0xe0, 0x70],
];

interface Note {
    start: number;
    end: number;
    channel: number;
    note: number;
}

/** The song's notes: each note-on paired with the note-off (or velocity-0 note-on) that ends it, or the song's end. */
function notesOf(song: Song): Note[] {
    const open = new Map<number, Note[]>();
    const notes: Note[] = [];
    for (const e of song.events) {
        const kind = e.status >> 4;
        if (kind !== 0x8 && kind !== 0x9) continue;
        const key = ((e.status & 15) << 7) | e.a;
        if (kind === 0x9 && e.b > 0) {
            const n = { start: e.time, end: song.length, channel: e.status & 15, note: e.a };
            notes.push(n);
            open.set(key, [...(open.get(key) ?? []), n]);
        } else {
            const waiting = open.get(key);
            const n = waiting?.shift();
            if (n) n.end = e.time;
        }
    }
    return notes;
}

/** The notes, drawn: time across, pitch up (the lowest and highest the song uses), a line each second and each C. */
export function pianoRoll(song: Song): { width: number; height: number; rgba: Uint8Array } | null {
    const notes = notesOf(song);
    if (!notes.length) return null;
    let low = 127;
    let high = 0;
    for (const n of notes) {
        low = Math.min(low, n.note);
        high = Math.max(high, n.note);
    }
    low = Math.max(0, low - 2);
    high = Math.min(127, high + 2);
    const rows = high - low + 1;
    const row = Math.max(MIN_ROW, Math.min(MAX_ROW, Math.floor(360 / rows)));
    const length = Math.max(song.length, 0.5);
    const perSecond = Math.max(0.5, Math.min(PER_SECOND, MAX_WIDTH / length));
    const width = Math.max(16, Math.ceil(length * perSecond));
    const height = rows * row;
    const rgba = pixelBuffer(width, height, 4, 'The piano roll');
    const put = (x: number, y: number, c: number[]) => {
        const i = (y * width + x) * 4;
        rgba[i] = c[0];
        rgba[i + 1] = c[1];
        rgba[i + 2] = c[2];
        rgba[i + 3] = 255;
    };
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) put(x, y, GROUND);
    // A line at each C, and each second (stronger each ten).
    for (let n = low; n <= high; n++) if (n % 12 === 0) for (let x = 0; x < width; x++) put(x, (high - n) * row + row - 1, GRID);
    const every = perSecond < 4 ? 10 : 1;
    for (let s = 0; s * perSecond < width; s += every) {
        const x = Math.round(s * perSecond);
        for (let y = 0; y < height; y++) put(x, y, s % 10 === 0 ? GRID_STRONG : GRID);
    }
    for (const n of notes) {
        const x0 = Math.floor(n.start * perSecond);
        const x1 = Math.max(x0 + 1, Math.ceil(n.end * perSecond));
        const y0 = (high - n.note) * row;
        const color = CHANNEL_COLORS[n.channel];
        for (let y = y0; y < y0 + Math.max(1, row - 1); y++) for (let x = x0; x < Math.min(width, x1); x++) put(x, y, color);
    }
    return { width, height, rgba };
}

/** A song's player and piano roll, as previews; the sound left out when `listen` is false. */
export function songPreviews(song: Song, title: string, { listen = true, maxSeconds = 600 } = {}): { title: string; preview: Preview }[] {
    const items: { title: string; preview: Preview }[] = [];
    if (listen && song.events.length) {
        const samples = renderSong(song, maxSeconds);
        const seconds = samples.length / SAMPLE_RATE;
        const cut = song.length + 1 > maxSeconds;
        items.push({
            title: `${title}: listen${cut ? ` (the first ${Math.round(maxSeconds / 60)} minutes)` : ''}, through Chimera’s simple synthesizer`,
            preview: { kind: 'audio', wav: wav(samples, SAMPLE_RATE, 1), sampleRate: SAMPLE_RATE, channels: 1, bits: 16, seconds },
        });
    }
    const roll = pianoRoll(song);
    if (roll) items.push({ title: `${title}: notes, by channel`, preview: { kind: 'picture', ...roll } });
    return items;
}
