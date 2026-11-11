import type { Song } from './smf';

/**
 * A small synthesizer, to hear a MIDI song in the browser: not a General MIDI
 * sound set, just a sound for each family of instruments (pianos, organs,
 * strings, brass...), a few harmonics and an envelope each, and drums made of
 * noise and falling tones on channel 10. It follows the General MIDI program
 * numbers; files written for the Roland MT-32 (most .XMI) number some
 * instruments differently, so those play as something near.
 *
 * It does velocity, channel volume (controller 7) and expression (11), the
 * sustain pedal (64), pitch bend (±2 semitones) and program changes, mono.
 */

export const SAMPLE_RATE = 16_000;
/** Voices sounding at once; past this the oldest is cut. */
const MAX_VOICES = 48;
const TABLE_SIZE = 4096;
/** A phase is a 32-bit number, a whole turn being 2³²; its top 12 bits index the sine table. */
const TURN = 2 ** 32;
const SHIFT = 20;
const SINE = Float32Array.from({ length: TABLE_SIZE }, (_, i) => Math.sin((2 * Math.PI * i) / TABLE_SIZE));

interface Timbre {
    /** The level of each harmonic, the fundamental first. */
    harmonics: number[];
    /** Seconds to full level, then how fast it falls (per second, exponential), to what it holds at. */
    attack: number;
    decay: number;
    sustain: number;
    release: number;
}

/** A timbre for each family of 8 General MIDI programs. */
const FAMILIES: Timbre[] = [
    { harmonics: [1, 0.5, 0.25, 0.12], attack: 0.004, decay: 1.6, sustain: 0, release: 0.25 }, // pianos
    { harmonics: [1, 0, 0.4, 0, 0.2], attack: 0.002, decay: 2.5, sustain: 0, release: 0.3 }, // chromatic percussion
    { harmonics: [1, 0.6, 0.4, 0.3, 0.2], attack: 0.01, decay: 0, sustain: 1, release: 0.08 }, // organs
    { harmonics: [1, 0.6, 0.4, 0.25, 0.15], attack: 0.003, decay: 2, sustain: 0, release: 0.2 }, // guitars
    { harmonics: [1, 0.5, 0.3, 0.15], attack: 0.005, decay: 0.8, sustain: 0.5, release: 0.12 }, // basses
    { harmonics: [1, 0.5, 0.33, 0.25, 0.2, 0.16], attack: 0.08, decay: 0, sustain: 1, release: 0.35 }, // strings
    { harmonics: [1, 0.5, 0.33, 0.25, 0.2, 0.16], attack: 0.1, decay: 0, sustain: 1, release: 0.4 }, // ensembles
    { harmonics: [1, 0.8, 0.6, 0.45, 0.3, 0.2], attack: 0.03, decay: 0.3, sustain: 0.8, release: 0.12 }, // brass
    { harmonics: [1, 0, 0.5, 0, 0.3, 0, 0.15], attack: 0.03, decay: 0, sustain: 1, release: 0.1 }, // reeds
    { harmonics: [1, 0.15, 0.05], attack: 0.04, decay: 0, sustain: 1, release: 0.12 }, // pipes
    { harmonics: [1, 0, 0.33, 0, 0.2, 0, 0.14], attack: 0.01, decay: 0, sustain: 1, release: 0.1 }, // synth leads
    { harmonics: [1, 0.5, 0.33, 0.25], attack: 0.25, decay: 0, sustain: 1, release: 0.6 }, // synth pads
    { harmonics: [1, 0.3, 0.2, 0.1], attack: 0.05, decay: 0.5, sustain: 0.6, release: 0.4 }, // synth effects
    { harmonics: [1, 0.5, 0.3, 0.1], attack: 0.003, decay: 1.5, sustain: 0, release: 0.2 }, // ethnic
    { harmonics: [1, 0.2], attack: 0.002, decay: 6, sustain: 0, release: 0.1 }, // percussive
    { harmonics: [1, 0.3], attack: 0.05, decay: 1, sustain: 0.3, release: 0.3 }, // sound effects
];

type Drum = 'kick' | 'snare' | 'hat' | 'open hat' | 'cymbal' | 'tom' | 'other';
/** What sound a note on channel 10 is, by General MIDI's drum map. */
function drumOf(note: number): Drum {
    if (note === 35 || note === 36) return 'kick';
    if (note === 38 || note === 40 || note === 37 || note === 39) return 'snare';
    if (note === 42 || note === 44) return 'hat';
    if (note === 46) return 'open hat';
    if (note === 49 || note === 51 || note === 52 || note === 55 || note === 57 || note === 59) return 'cymbal';
    if (note >= 41 && note <= 50) return 'tom';
    return 'other';
}

interface Voice {
    channel: number;
    note: number;
    /** Hertz before pitch bend. */
    frequency: number;
    phase: number;
    level: number;
    timbre: Timbre | null;
    drum: Drum | null;
    /** Seconds since it started, and since it was let go (or -1). */
    age: number;
    released: number;
    /** Held by the sustain pedal after its note-off. */
    held: boolean;
    noise: number;
    lastNoise: number;
}

interface Channel {
    program: number;
    volume: number;
    expression: number;
    bend: number;
    sustain: boolean;
}

/** Samples worked out together: the envelopes and pitch bend once a block, the level eased across it. About 2 ms. */
const BLOCK = 32;

/** A voice's level `age` seconds in (and `released` after its note-off, or -1), before velocity and volume. */
function envelope(v: Voice, age: number, released: number): number {
    if (v.drum) {
        const fall = v.drum === 'kick' || v.drum === 'snare' ? 0.12 : v.drum === 'hat' ? 0.04 : v.drum === 'cymbal' ? 0.8 : 0.25;
        return Math.exp(-age / fall);
    }
    const t = v.timbre!;
    let amp = age < t.attack ? age / t.attack : t.sustain + (1 - t.sustain) * (t.decay ? Math.exp(-(age - t.attack) / t.decay) : 1);
    if (released >= 0) amp *= Math.exp(-released / t.release);
    return amp;
}

/** A song, rendered: 16-bit mono at SAMPLE_RATE, up to `maxSeconds` (the song is cut there, and fades out over its last second). */
export function renderSong(song: Song, maxSeconds: number): Int16Array {
    const seconds = Math.min(maxSeconds, song.length + 1);
    const total = Math.max(1, Math.ceil(seconds * SAMPLE_RATE));
    const out = new Int16Array(total);
    const mix = new Float32Array(BLOCK);
    const channels: Channel[] = Array.from({ length: 16 }, () => ({ program: 0, volume: 100, expression: 127, bend: 0, sustain: false }));
    const voices: Voice[] = [];
    const dt = 1 / SAMPLE_RATE;
    const span = BLOCK * dt;
    let seed = 0x1234;
    const release = (v: Voice) => {
        if (v.released < 0) v.released = 0;
    };
    const cutShort = song.length + 1 > maxSeconds;

    let e = 0;
    const events = song.events;
    for (let block = 0; block < total; block += BLOCK) {
        const now = block * dt;
        const n = Math.min(BLOCK, total - block);
        // The events due by the end of this block, applied at its start.
        while (e < events.length && events[e].time < now + span) {
            const { status, a, b } = events[e++];
            const ch = status & 0x0f;
            const c = channels[ch];
            const noteOff = () => {
                for (const v of voices)
                    if (v.channel === ch && v.note === a && v.released < 0) {
                        if (c.sustain) v.held = true;
                        else release(v);
                    }
            };
            switch (status >> 4) {
                case 0x9:
                    // Velocity 0 is a note-off.
                    if (b === 0) {
                        noteOff();
                        break;
                    }
                    if (voices.length >= MAX_VOICES) voices.shift();
                    voices.push({
                        channel: ch,
                        note: a,
                        frequency: 440 * 2 ** ((a - 69) / 12),
                        phase: 0,
                        level: (b / 127) ** 2,
                        timbre: ch === 9 ? null : FAMILIES[c.program >> 3],
                        drum: ch === 9 ? drumOf(a) : null,
                        age: 0,
                        released: -1,
                        held: false,
                        noise: 0,
                        lastNoise: 0,
                    });
                    break;
                case 0x8:
                    noteOff();
                    break;
                case 0xb:
                    if (a === 7) c.volume = b;
                    else if (a === 11) c.expression = b;
                    else if (a === 64) {
                        c.sustain = b >= 64;
                        if (!c.sustain) for (const v of voices) if (v.channel === ch && v.held) release(v);
                    } else if (a === 120 || a === 123) for (const v of voices) if (v.channel === ch) release(v);
                    break;
                case 0xc:
                    c.program = a;
                    break;
                case 0xe:
                    c.bend = ((b << 7) | a) - 8192;
                    break;
            }
        }

        mix.fill(0);
        for (let k = voices.length - 1; k >= 0; k--) {
            const v = voices[k];
            const c = channels[v.channel];
            const gain = v.level * (c.volume / 127) ** 2 * (c.expression / 127) ** 2;
            const a0 = envelope(v, v.age, v.released) * gain;
            const a1 = envelope(v, v.age + span, v.released >= 0 ? v.released + span : -1) * gain;
            const step = (a1 - a0) / n;
            if (v.drum) {
                const tone = v.drum === 'kick' || v.drum === 'tom' || v.drum === 'snare';
                const f = v.drum === 'kick' ? 45 + 90 * Math.exp(-v.age / 0.03) : v.drum === 'tom' ? v.frequency / 4 + 60 * Math.exp(-v.age / 0.05) : 185;
                const inc = Math.round(f * dt * TURN) >>> 0;
                for (let i = 0; i < n; i++) {
                    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
                    const noise = seed / 0x3fffffff - 1;
                    const high = noise - v.lastNoise;
                    v.lastNoise = noise;
                    let sample: number;
                    if (tone) {
                        v.phase = (v.phase + inc) >>> 0;
                        const sine = SINE[v.phase >>> SHIFT];
                        sample = v.drum === 'snare' ? noise * 0.7 + sine * 0.4 : sine * 1.4;
                    } else sample = v.drum === 'other' ? noise * 0.6 : high * 0.6;
                    mix[i] += sample * (a0 + step * i);
                }
                if (a1 < 0.001 * gain) {
                    voices.splice(k, 1);
                    continue;
                }
            } else {
                const t = v.timbre!;
                const f = v.frequency * 2 ** ((c.bend / 8192) * (2 / 12));
                const inc = Math.round(f * dt * TURN) >>> 0;
                // Harmonics above what the rate can hold would fold back as noise.
                let count = t.harmonics.length;
                while (count > 1 && f * count > SAMPLE_RATE / 2) count--;
                const harmonics = t.harmonics;
                let phase = v.phase;
                for (let i = 0; i < n; i++) {
                    phase = (phase + inc) >>> 0;
                    let sample = 0;
                    // The h-th harmonic's phase is h times the fundamental's, wrapping round as 32 bits do.
                    for (let h = 0; h < count; h++) if (harmonics[h]) sample += harmonics[h] * SINE[Math.imul(phase, h + 1) >>> SHIFT];
                    mix[i] += sample * (a0 + step * i);
                }
                v.phase = phase;
                if ((v.released >= 0 && v.released > t.release * 6) || (t.sustain === 0 && a1 < 0.001 * gain)) {
                    voices.splice(k, 1);
                    continue;
                }
            }
            v.age += span;
            if (v.released >= 0) v.released += span;
        }
        // A fade over the last second of a song cut short; then a soft limit, so loud chords bend rather than clip.
        for (let i = 0; i < n; i++) {
            const fade = cutShort ? Math.min(1, seconds - (block + i) * dt) : 1;
            const x = mix[i] * 0.45 * fade;
            out[block + i] = Math.round((x / (1 + Math.abs(x))) * 32767);
        }
    }
    return out;
}
