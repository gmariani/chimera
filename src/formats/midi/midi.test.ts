import { describe, expect, it } from 'vitest';
import type { Parsed } from '../../core/types';
import { standardMidi } from '../../testing/samples';
import { detect } from '../index';
import parser from './midi';
import { readSmf, type Song } from './smf';
import { notesOf, SYNTHESIZED } from './song-preview';
import { renderSong, SAMPLE_RATE } from './synth';

const parse = (data: Uint8Array) => parser.parse(data, { name: 'MUSIC.MID', names: [] }) as Parsed;
const song = (data: Uint8Array) => {
    const smf = readSmf(data);
    if (typeof smf === 'string') throw new Error(smf);
    return smf;
};

/** How often a sound crosses zero going up, a second, over its middle second: its pitch, for a near-pure tone. */
function pitchOf(samples: Int16Array, from: number): number {
    let crossings = 0;
    for (let i = from + 1; i < from + SAMPLE_RATE; i++) if (samples[i - 1] < 0 && samples[i] >= 0) crossings++;
    return crossings;
}

describe('Standard MIDI files', () => {
    it('reads the tracks, and times the events through the tempo map', () => {
        const data = standardMidi();
        expect(detect(data, 'MUSIC.MID').id).toBe('midi');
        expect(detect(data, null).id).toBe('midi');
        const r = parse(data);
        expect(r.warnings).toEqual([]);
        expect(r.summary).toEqual([
            ['Format', '1: tracks played together'],
            ['Tracks', '2'],
            ['Length', '0:01'],
            ['Notes', '2 on 1 channel (1)'],
            ['Time', '480 ticks a beat, 2 tempo changes'],
        ]);
        expect(r.fields.map((f) => f.name)).toEqual(['Header (MThd)', 'Track 1', 'Track 2: "Melody"']);
        // By hand, from the specification: 480 ticks at 500,000 µs a beat is half a second; from tick 480, a beat is 250,000 µs.
        const notes = song(data).song.events.filter((e) => e.status >> 4 === 0x8 || e.status >> 4 === 0x9);
        expect(notes.map((e) => [e.time, e.status, e.a, e.b])).toEqual([
            [0, 0x90, 60, 100],
            [0.5, 0x80, 60, 64],
            [0.75, 0x90, 64, 90],
            [1, 0x90, 64, 0],
        ]);
        expect(r.preview).toMatchObject({
            kind: 'music',
            length: 1,
            note: SYNTHESIZED,
            notes: [
                { start: 0, end: 0.5, channel: 0, note: 60 },
                { start: 0.75, end: 1, channel: 0, note: 64 },
            ],
        });
        expect(r.preview?.kind === 'music' && r.preview.audio?.seconds).toBe(2);
    });

    it('counts time in frames when the header says so', () => {
        // 25 frames a second of 40 ticks: 1,000 ticks a second. One note from tick 0 to 500.
        const data = Uint8Array.from(
            [...'MThd']
                .map((c) => c.charCodeAt(0))
                .concat(
                    [0, 0, 0, 6, 0, 0, 0, 1, 0xe7, 40],
                    [...'MTrk'].map((c) => c.charCodeAt(0)),
                    [0, 0, 0, 12, 0, 0x90, 60, 100, 0x83, 0x74, 0x80, 60, 0, 0, 0xff, 0x2f]
                )
        );
        // (Its end-of-track is cut short: the length byte is missing.)
        const smf = song(data);
        expect(smf.division).toEqual({ fps: 25, ticksPerFrame: 40 });
        expect(smf.song.events.map((e) => e.time)).toEqual([0, 0.5]);
        expect(smf.problems.join()).toMatch(/meta event runs past the end of the track/);
    });

    it('says what doesn’t fit', () => {
        const header = (tracks: number) => [...'MThd'].map((c) => c.charCodeAt(0)).concat([0, 0, 0, 6, 0, 0, 0, tracks, 0, 96]);
        const mtrk = (events: number[]) => [...[...'MTrk'].map((c) => c.charCodeAt(0)), 0, 0, 0, events.length, ...events];
        // The header says 2 tracks; there's 1.
        expect(parse(Uint8Array.from([...header(2), ...mtrk([0, 0xff, 0x2f, 0])])).warnings).toEqual(['The header says 2 tracks, but there is 1.']);
        // Running status with nothing to run on.
        expect(parse(Uint8Array.from([...header(1), ...mtrk([0, 60, 100, 0, 0xff, 0x2f, 0])])).warnings).toContain('Track 1: an event leaves out its status, with none before it to take.');
        // No end-of-track.
        expect(parse(Uint8Array.from([...header(1), ...mtrk([0, 0x90, 60, 100])])).warnings).toEqual(['Track 1 has no end-of-track event.']);
        expect(() => parse(new TextEncoder().encode('RIFF....RMIDdata'))).toThrow(/doesn’t start with an "MThd" header/);
    });
});

describe('The synthesizer and the piano roll', () => {
    const tone = (events: Song['events'], length = 2): Song => ({ events, length });

    it('plays a note at its pitch: A at 440 Hz, and two semitones up with the pitch bend all the way', () => {
        // Program 72 is a pipe (a near-pure tone), on channel 1.
        const a = renderSong(
            tone([
                { time: 0, status: 0xc0, a: 72, b: 0 },
                { time: 0, status: 0x90, a: 69, b: 100 },
                { time: 1.9, status: 0x80, a: 69, b: 0 },
            ]),
            10
        );
        expect(Math.abs(pitchOf(a, SAMPLE_RATE / 2) - 440)).toBeLessThanOrEqual(2);
        const bent = renderSong(
            tone([
                { time: 0, status: 0xc0, a: 72, b: 0 },
                { time: 0, status: 0xe0, a: 0x7f, b: 0x7f },
                { time: 0, status: 0x90, a: 69, b: 100 },
            ]),
            10
        );
        expect(Math.abs(pitchOf(bent, SAMPLE_RATE / 2) - 440 * 2 ** (2 / 12))).toBeLessThanOrEqual(3);
    });

    it('ends a note at its note-off, and plays drums on channel 10', () => {
        const ends = renderSong(
            tone(
                [
                    { time: 0, status: 0xc0, a: 16, b: 0 },
                    { time: 0, status: 0x90, a: 60, b: 127 },
                    { time: 0.5, status: 0x90, a: 60, b: 0 },
                ],
                2
            ),
            10
        );
        const loudness = (from: number, to: number) => Math.max(...Array.from(ends.subarray(from * SAMPLE_RATE, to * SAMPLE_RATE), Math.abs));
        expect(loudness(0.1, 0.4)).toBeGreaterThan(1000);
        expect(loudness(1.5, 2)).toBeLessThan(20);
        const kick = renderSong(tone([{ time: 0, status: 0x99, a: 36, b: 127 }], 1), 10);
        expect(Math.max(...Array.from(kick.subarray(0, SAMPLE_RATE / 10), Math.abs))).toBeGreaterThan(1000);
        // A song cut short is cut where asked.
        expect(renderSong(tone([], 100), 5)).toHaveLength(5 * SAMPLE_RATE);
    });

    it('pairs each note with what ends it', () => {
        // Two of the same note overlapping: the first note-off ends the first; one never ended lasts to the song's end.
        const notes = notesOf(
            tone(
                [
                    { time: 0, status: 0x90, a: 60, b: 100 },
                    { time: 0.5, status: 0x90, a: 60, b: 100 },
                    { time: 1, status: 0x80, a: 60, b: 0 },
                    { time: 1.5, status: 0x90, a: 60, b: 0 },
                    { time: 1, status: 0x99, a: 36, b: 100 },
                ],
                3
            )
        );
        expect(notes).toEqual([
            { start: 0, end: 1, channel: 0, note: 60 },
            { start: 0.5, end: 1.5, channel: 0, note: 60 },
            { start: 1, end: 3, channel: 9, note: 36 },
        ]);
    });
});
