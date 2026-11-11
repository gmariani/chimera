import type { MusicNote, Preview } from '../../core/types';
import { wav } from '../westwood/adpcm';
import type { Song } from './smf';
import { renderSong, SAMPLE_RATE } from './synth';

/**
 * A song's preview: its notes for the timeline, and the song rendered by the
 * small synthesizer to play along with them.
 */

/** Said under every song played here. */
export const SYNTHESIZED = 'Played through a simple synthesizer, so it won’t sound exactly like the original.';

/** The song's notes: each note-on paired with the note-off (or velocity-0 note-on) that ends it, or the song's end. */
export function notesOf(song: Song): MusicNote[] {
    const open = new Map<number, MusicNote[]>();
    const notes: MusicNote[] = [];
    for (const e of song.events) {
        const kind = e.status >> 4;
        if (kind !== 0x8 && kind !== 0x9) continue;
        const key = ((e.status & 15) << 7) | e.a;
        if (kind === 0x9 && e.b > 0) {
            const n = { start: e.time, end: song.length, channel: e.status & 15, note: e.a };
            notes.push(n);
            const waiting = open.get(key);
            if (waiting) waiting.push(n);
            else open.set(key, [n]);
        } else {
            const n = open.get(key)?.shift();
            if (n) n.end = e.time;
        }
    }
    return notes;
}

const minutes = (s: number) => `${Math.round(s / 60)} minute${Math.round(s / 60) === 1 ? '' : 's'}`;

/**
 * A song as a music preview. With `listen` false, no sound: `elsewhere` then says where to hear it. A song longer than
 * `maxSeconds` plays that far.
 */
export function songPreview(song: Song, { listen = true, maxSeconds = 600, elsewhere }: { listen?: boolean; maxSeconds?: number; elsewhere?: string } = {}): Preview {
    const notes = notesOf(song);
    if (!listen || !notes.length) {
        const note = notes.length ? (elsewhere ?? 'Not played here.') : 'It has no notes to play.';
        return { kind: 'music', notes, length: song.length, note };
    }
    const samples = renderSong(song, maxSeconds);
    const seconds = samples.length / SAMPLE_RATE;
    const cut = song.length > maxSeconds;
    return {
        kind: 'music',
        notes,
        length: song.length,
        audio: { wav: wav(samples, SAMPLE_RATE, 1), sampleRate: SAMPLE_RATE, channels: 1, bits: 16, seconds },
        note: `${SYNTHESIZED}${cut ? ` Only the first ${minutes(maxSeconds)} play here.` : ''}`,
    };
}
