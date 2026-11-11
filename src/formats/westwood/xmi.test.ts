import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Parsed } from '../../core/types';
import { gameFile } from '../../testing/game-data';
import { LOOP_END, XMIDI_NOTES, type XmidiNote, xmidiMusic } from '../../testing/samples';
import { detect } from '../index';
import { inspect } from '../inspect';
import pak from './pak';
import parser from './xmi';

const parse = (data: Uint8Array, name = 'MUSIC.XMI') => parser.parse(data, { name, names: [] }) as Parsed;
const text = (r: Parsed) => {
    const first = r.preview?.kind === 'stack' ? r.preview.items[0].preview : r.preview;
    return first?.kind === 'text' ? first.text : '';
};

/**
 * A standard MIDI file's notes, read the plain way (the format's own rules, apart from the reader under test): the header,
 * then the one track's events, each after a variable-length delta; note-ons paired with the note-offs that end them.
 */
function smfNotes(midi: Uint8Array): { division: number; tempos: number[]; notes: XmidiNote[]; end: number } {
    const text = (at: number) => String.fromCharCode(...midi.subarray(at, at + 4));
    const be = (at: number, n: number) => midi.subarray(at, at + n).reduce((v, x) => v * 256 + x, 0);
    expect(text(0)).toBe('MThd');
    expect([be(8, 2), be(10, 2)]).toEqual([0, 1]);
    const division = be(12, 2);
    expect(text(14)).toBe('MTrk');
    const end = 22 + be(18, 4);
    expect(end).toBe(midi.length);
    const vlq = (at: number) => {
        let v = 0;
        for (;;) {
            const x = midi[at++];
            v = v * 128 + (x & 0x7f);
            if (!(x & 0x80)) return [v, at];
        }
    };
    let at = 22;
    let time = 0;
    const open = new Map<string, XmidiNote>();
    const notes: XmidiNote[] = [];
    const tempos: number[] = [];
    let last = 0;
    while (at < end) {
        const [delta, next] = vlq(at);
        time += delta;
        at = next;
        const status = midi[at++];
        if (status === 0xff) {
            const type = midi[at++];
            const [length, body] = vlq(at);
            if (type === 0x51) tempos.push(be(body, 3));
            at = body + length;
            if (type === 0x2f) last = time;
        } else if (status >> 4 === 0x9 && midi[at + 1]) {
            const n = { time, channel: status & 15, note: midi[at], velocity: midi[at + 1], length: 0 };
            open.set(`${n.channel}:${n.note}:${time}`, n);
            notes.push(n);
            at += 2;
        } else if (status >> 4 === 0x8 || status >> 4 === 0x9) {
            // The earliest open note of this channel and pitch ends here (a note-off with none open is allowed, and ends nothing).
            const key = [...open.keys()].find((k) => k.startsWith(`${status & 15}:${midi[at]}:`));
            if (key) {
                const n = open.get(key)!;
                n.length = time - n.time;
                open.delete(key);
            }
            at += 2;
        } else at += status >> 4 === 0xc || status >> 4 === 0xd ? 1 : 2;
    }
    expect(open.size).toBe(0);
    return { division, tempos, notes, end: last };
}

describe('XMIDI music', () => {
    it('reads each sequence, and saves it as a standard MIDI file with the same notes', () => {
        const data = xmidiMusic();
        expect(detect(data, 'MUSIC.XMI').id).toBe('xmi');
        expect(detect(data, null).id).toBe('xmi');
        const r = parse(data);
        expect(r.warnings).toEqual([]);
        expect(r.summary).toEqual([
            ['Sequences', '2, 2 with notes'],
            ['Longest', '0:06'],
            ['Loops', 'None'],
            ['Save', 'Each sequence as a standard MIDI file (.mid), from the contents'],
        ]);
        expect(text(r)).toBe('Sequence 0: 0:06, 3 notes on 1 channel, 1 instrument from the bank\nSequence 1: 0:02, 3 notes on 1 channel, 1 branch point');
        expect(r.entries!.map((e) => e.label)).toEqual(['MUSIC-0.mid', 'MUSIC-1.mid']);
        // Round trip: the notes written into the XMIDI file come back out of the MIDI file, at 60 ticks a beat (120 a second).
        r.entries!.forEach((e, i) => {
            const smf = smfNotes(e.data);
            expect(smf.division).toBe(60);
            expect(smf.notes).toEqual(XMIDI_NOTES[i]);
            expect(smf.end).toBe(Math.max(...XMIDI_NOTES[i].map((n) => n.time + n.length)));
        });
        // The tempo event is set to MIDI's own 500,000 µs a beat, as the player ignores it.
        expect(smfNotes(r.entries![0].data).tempos).toEqual([500000]);
        const seq0 = r.fields[1].children!.find((f) => f.name === 'Sequence 0')!;
        expect(seq0.children!.find((f) => f.name === 'Instruments (TIMB)')!.children![0].value).toBe('patch 5, bank 1');
        expect(r.fields.reduce((n, f) => n + f.length, 0)).toBe(data.length);
    });

    it('plays loops out as the player does', () => {
        const notesOf = (data: Uint8Array) => smfNotes(parse(data).entries![0].data).notes;
        const repeat = (times: number) => Array.from({ length: times }, (_, k) => XMIDI_NOTES[0].map((n) => ({ ...n, time: n.time + k * LOOP_END }))).flat();
        // FOR 3 ... NEXT: the block three times, each LOOP_END after the last.
        const three = parse(xmidiMusic({ loop: [3, 127] }));
        expect(three.warnings).toEqual([]);
        expect(notesOf(xmidiMusic({ loop: [3, 127] }))).toEqual(repeat(3));
        expect(three.summary).toContainEqual(['Loops', '1, played out in the .mid files and the sound']);
        // A NEXT below 64 is a BREAK: once through.
        expect(notesOf(xmidiMusic({ loop: [3, 10] }))).toEqual(repeat(1));
        // Forever is played once, and said.
        const forever = parse(xmidiMusic({ loop: [0, 127] }));
        expect(notesOf(xmidiMusic({ loop: [0, 127] }))).toEqual(repeat(1));
        expect(forever.preview?.kind === 'stack' && forever.preview.items[0].preview.kind === 'text' && forever.preview.items[0].preview.text).toMatch(
            /1 loop \(1 meant to play forever, played once\)/
        );
        // Nested past what the player keeps.
        // (The fifth FOR is ignored, as the player does, so its NEXT has nothing to go back to.)
        expect(parse(xmidiMusic({ loop: [2, 127], loops: 5 })).warnings).toEqual([
            'Sequence 0: Its loops nest more than 4 deep; the player keeps only 4, and ignores the rest.',
            'Sequence 0: A NEXT controller has no FOR before it; the player ignores it.',
        ]);
    });

    it('says what doesn’t fit', () => {
        // The directory counting 3.
        const three = xmidiMusic();
        three[20] = 3;
        expect(parse(three).warnings).toEqual(['The directory says there are 3 sequences, but there are 2: the game would find nothing for the rest.']);
        // The first sequence's end-of-track turned into a note-on whose length runs out.
        const open = xmidiMusic();
        const firstEnd = open.indexOf(0x2f) - 1;
        open[firstEnd] = 0x90;
        open[firstEnd + 1] = 60;
        open[firstEnd + 2] = 100;
        expect(parse(open).warnings[0]).toMatch(/^Sequence 0: A note’s length runs past the end of the events/);
        // An event MIDI files can't hold, in place of the end-of-track.
        const odd = xmidiMusic();
        odd[firstEnd] = 0xf4;
        expect(parse(odd).warnings[0]).toBe("Sequence 0: There's an event 0xF4, which a MIDI file can't hold; the player would stop there.");
        // A branch point past the end of its events.
        const branch = xmidiMusic();
        const rbrn = new TextDecoder('latin1').decode(branch).indexOf('RBRN');
        branch[rbrn + 12] = 0x80;
        expect(parse(branch).warnings).toEqual(['Sequence 1: Its branch point 0 is at 128, past the end of its events.']);
        expect(() => parse(new TextEncoder().encode('FORM\0\0\0\x0aXDIRINFO\0\0\0\x02\x01\0'))).toThrow(/no CAT of type XMID/);
        expect(() => parse(new TextEncoder().encode('RIFF\0\0\0\0WAVEfmt '))).toThrow(/isn't XMIDI music/);
    });

    // Dune II's own: the same 21 pieces for four sound cards, in SOUND.PAK (npm run test:setup).
    const PAK = gameFile('dune2', 'SOUND.PAK') ?? '';
    // Each file's page renders up to 4 minutes of music: 85 of them take a while.
    it.skipIf(!PAK)('reads Dune II’s 85, the music where OpenDUNE says it is', { timeout: 120_000 }, async () => {
        const files = pak.parse(new Uint8Array(readFileSync(PAK)), { name: 'SOUND.PAK', names: [] }).entries!.filter((e) => /\.(XMI|C55|PCS|TAN)$/.test(e.label));
        expect(files).toHaveLength(85);
        for (const e of files) {
            expect(detect(e.data, null).id, e.label).toBe('xmi');
            const r = await inspect(e.data, { name: e.label, names: [] });
            expect(r.format.id, e.label).toBe('xmi');
            expect(r.parsed.warnings, e.label).toEqual([]);
            expect(
                r.checks.filter((c) => c.level !== 'info'),
                e.label
            ).toEqual([]);
            // Every MIDI file it makes reads back with its notes paired.
            for (const m of r.parsed.entries!) smfNotes(m.data);
        }
        // DUNE1: the game's music is sequences 2 to 6 and 8 (OpenDUNE's table); 6 is the longest.
        const dune1 = parse(files.find((e) => e.label === 'DUNE1.XMI')!.data, 'DUNE1.XMI');
        expect(dune1.summary).toContainEqual(['In Dune II', 'It plays sequences 2, 3, 4, 5, 6, 8 as music (OpenDUNE’s table)']);
        expect(text(dune1)).toContain('Sequence 6 (music in Dune II): 3:42, 1,610 notes on 6 channels, 14 instruments from the bank');
    });
});
