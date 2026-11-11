import { Bytes, bytesLabel, field } from '../../core/bytes';
import type { Entry, Field, FormatParser, Preview } from '../../core/types';
import { append, maxOf } from '../../core/math';
import { readSmf } from '../midi/smf';
import { songPreview } from '../midi/song-preview';
import { DUNE2_MUSIC } from './dune2-music';

/**
 * XMIDI (.xmi), the Miles Audio Interface Library's MIDI: the music of Dune II
 * (and many DOS games of 1992 to 1995) for the Roland MT-32, and as .C55, .PCS
 * and .TAN for the Sound Canvas, the PC speaker and the Tandy. An IFF file:
 *
 * - FORM XDIR (optional): an INFO chunk, the number of sequences.
 * - CAT XMID: one FORM XMID for each sequence, holding a TIMB chunk (the
 *   instruments it needs from the driver's bank, each a patch and a bank),
 *   an RBRN chunk (branch points the game can jump to), and EVNT, the events.
 *
 * The events are MIDI's, but for three things: the time before an event is
 * one or more bytes below 0x80, added up, in 120ths of a second; a note-on
 * carries how long the note lasts (a MIDI variable-length number) and there
 * are no note-offs; and every event has its status byte. The counts in INFO,
 * TIMB and RBRN are little-endian, though IFF's chunk sizes are big-endian.
 *
 * Each sequence is offered as a standard MIDI file: 60 ticks a beat at
 * 500,000 µs a beat is the player's 120 a second, and tempo events are set to
 * that, as the player ignores them (the times are already in its ticks).
 * This follows the XMIDI specification (Miles Design, release 1.02, 1992)
 * and ScummVM's parser (audio/midiparser_xmidi.cpp).
 */

interface Chunk {
    id: string;
    at: number;
    size: number;
    start: number;
    end: number;
}

/** The chunks from `from` to `to`, as far as they make sense. */
function chunksIn(b: Bytes, from: number, to: number): Chunk[] {
    const out: Chunk[] = [];
    for (let at = from; at + 8 <= to && /^[\x20-\x7e]{4}$/.test(b.ascii(at, 4));) {
        const size = b.u32be(at + 4);
        out.push({ id: b.ascii(at, 4), at, size, start: at + 8, end: Math.min(at + 8 + size, to) });
        at += 8 + size + (size & 1);
    }
    return out;
}

interface Sequence {
    form: Chunk;
    timbres: { patch: number; bank: number }[];
    branches: { index: number; offset: number }[];
    evnt: Chunk | null;
    events: number;
    notes: number;
    channels: Set<number>;
    /** In the player's ticks, 120 a second: to the end of the last note. */
    length: number;
    tempos: number;
    /** FOR loops, and how many of them are meant to play forever. */
    loops: number;
    forever: number;
    /** Whether playing its loops out ran past what's kept (MAX_TICKS), and was cut there. */
    cut: boolean;
    midi: Uint8Array | null;
    problems: string[];
}

/** A MIDI variable-length number: 7 bits a byte, the high bit set on all but the last. At most 4 bytes, as MIDI allows. */
function vlq(data: Uint8Array, at: number, end: number): { value: number; next: number } | null {
    let value = 0;
    for (let i = 0; i < 4; i++) {
        if (at + i >= end) return null;
        const v = data[at + i];
        value = value * 128 + (v & 0x7f);
        if (!(v & 0x80)) return { value, next: at + i + 1 };
    }
    return null;
}

const writeVlq = (v: number): number[] => {
    const out = [v & 0x7f];
    for (v = Math.floor(v / 128); v > 0; v = Math.floor(v / 128)) out.unshift((v & 0x7f) | 0x80);
    return out;
};

/** How many data bytes a channel message of this status takes. */
const DATA_BYTES: Record<number, number> = { 0x8: 2, 0x9: 2, 0xa: 2, 0xb: 2, 0xc: 1, 0xd: 1, 0xe: 2 };

/** XMIDI's loop controllers (the specification's 116 and 117). */
const FOR = 116;
const NEXT = 117;
/** How deep loops may nest: the player keeps 4. */
const MAX_DEPTH = 4;
/** Loops played out no further than this, in the player's ticks (30 minutes), or this many events. */
const MAX_TICKS = 120 * 60 * 30;
const MAX_OUT = 500_000;

type Timed = [time: number, order: number, bytes: number[]];

/**
 * A sequence's events. Read as they are (`play` false), it checks them and counts them into `seq`. Played (`play` true),
 * it follows the loops as the player does (a FOR's count is how many times its block plays, 0 for forever, played here
 * once; a NEXT of 64 or more goes back while the count lasts, one below 64 breaks out), leaving the loop controllers out,
 * and gives the events in the player's ticks.
 */
function walk(data: Uint8Array, evnt: Chunk, seq: Sequence, play: boolean): { out: Timed[]; length: number; cut: boolean } {
    // [time, order (note-offs before the rest at the same time), bytes]
    const out: Timed[] = [];
    const problem = (text: string) => {
        if (!play) seq.problems.push(text);
    };
    const loops: { at: number; left: number }[] = [];
    let time = 0;
    let ended = false;
    let cut = false;
    let at = evnt.start;
    const end = evnt.end;
    let lastTime = 0;
    while (at < end) {
        if (play && (time > MAX_TICKS || out.length > MAX_OUT)) {
            cut = true;
            break;
        }
        // The time before the event: bytes below 0x80, added up.
        while (at < end && data[at] < 0x80) time += data[at++];
        if (at >= end) break;
        const status = data[at++];
        const kind = status >> 4;
        if (kind < 0xf) {
            const n = DATA_BYTES[kind];
            if (at + n > end) {
                problem('An event runs past the end of the events.');
                break;
            }
            const values = Array.from(data.subarray(at, at + n));
            at += n;
            if (!play) {
                if (values.some((v) => v > 0x7f)) problem(`An event's values are over 127, which MIDI's can't be (at ${(at - n - 1).toLocaleString('en-US')}).`);
                seq.channels.add(status & 0x0f);
                seq.events++;
            }
            if (kind === 0x9) {
                const length = vlq(data, at, end);
                if (!length) {
                    problem('A note’s length runs past the end of the events, or past the 4 bytes MIDI allows.');
                    break;
                }
                at = length.next;
                // A length of 0: the player sounds it very briefly (ScummVM's parser gives it 1 tick, as here).
                const ticks = Math.max(1, length.value);
                if (values[1] === 0) {
                    // Velocity 0 is a note-off in MIDI, and the player takes it as one (ScummVM's parser does too): its length is unused.
                    out.push([time, 0, [0x80 | (status & 0x0f), values[0], 0x40]]);
                } else {
                    if (!play) seq.notes++;
                    out.push([time, 1, [status, values[0], values[1]]]);
                    out.push([time + ticks, 0, [0x80 | (status & 0x0f), values[0], 0x40]]);
                    lastTime = Math.max(lastTime, time + ticks);
                }
            } else if (kind === 0xb && (values[0] === FOR || values[0] === NEXT)) {
                if (values[0] === FOR) {
                    if (!play) {
                        seq.loops++;
                        if (values[1] === 0) seq.forever++;
                        if (loops.length >= MAX_DEPTH) problem(`Its loops nest more than ${MAX_DEPTH} deep; the player keeps only ${MAX_DEPTH}, and ignores the rest.`);
                    }
                    // Played: forever is played once.
                    if (loops.length < MAX_DEPTH) loops.push({ at, left: Math.max(1, values[1]) });
                } else if (loops.length) {
                    const loop = loops[loops.length - 1];
                    if (!play || values[1] < 64 || --loop.left === 0) loops.pop();
                    else at = loop.at;
                } else problem('A NEXT controller has no FOR before it; the player ignores it.');
                // Played out, the loop controllers would mean nothing to a MIDI player; read as they are, they're kept.
                if (!play) out.push([time, 1, [status, ...values]]);
            } else {
                if (kind === 0x8) problem('There’s a note-off, which XMIDI doesn’t use (each note-on says how long it lasts).');
                out.push([time, 1, [status, ...values]]);
            }
        } else if (status === 0xf0 || status === 0xf7) {
            const length = vlq(data, at, end);
            if (!length || length.next + length.value > end) {
                problem('A system-exclusive message runs past the end of the events.');
                break;
            }
            out.push([time, 1, append([status, ...writeVlq(length.value)], data.subarray(length.next, length.next + length.value))]);
            at = length.next + length.value;
            if (!play) seq.events++;
        } else if (status === 0xff) {
            if (at >= end) {
                problem('A meta event runs past the end of the events.');
                break;
            }
            const type = data[at++];
            const length = vlq(data, at, end);
            if (!length || length.next + length.value > end) {
                problem('A meta event runs past the end of the events.');
                break;
            }
            let body = Array.from(data.subarray(length.next, length.next + length.value));
            at = length.next + length.value;
            if (!play) seq.events++;
            if (type === 0x2f) {
                ended = true;
                break;
            }
            if (type === 0x51 && body.length === 3) {
                if (!play) seq.tempos++;
                body = [0x07, 0xa1, 0x20];
            }
            out.push([time, 1, append([0xff, type, ...writeVlq(body.length)], body)]);
        } else {
            problem(`There's an event 0x${status.toString(16).toUpperCase()}, which a MIDI file can't hold; the player would stop there.`);
            break;
        }
    }
    if (!ended && !cut) problem('The events have no end-of-track event: the player would read on past them.');
    else if (ended && at < end && data.subarray(at, end).some((v) => v)) problem(`${bytesLabel(end - at)} after the end-of-track event aren't events.`);
    return { out, length: Math.max(lastTime, time), cut };
}

/** A sequence's events, checked; and, its loops played out, a standard MIDI file of them. */
function decodeEvents(data: Uint8Array, evnt: Chunk, seq: Sequence): void {
    walk(data, evnt, seq, false);
    const { out, length, cut } = walk(data, evnt, seq, true);
    seq.length = length;
    seq.cut = cut;

    // A standard MIDI file: format 0, one track, 60 ticks a beat (with MIDI's own 500,000 µs a beat, 120 a second).
    out.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    const track: number[] = [];
    let now = 0;
    for (const [t, , bytes] of out) {
        append(track, writeVlq(t - now));
        append(track, bytes);
        now = t;
    }
    track.push(...writeVlq(Math.max(0, seq.length - now)), 0xff, 0x2f, 0x00);
    const be32 = (v: number) => [(v >>> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
    const header = [...new TextEncoder().encode('MThd'), ...be32(6), 0, 0, 0, 1, 0, 60];
    const midi = new Uint8Array(header.length + 8 + track.length);
    midi.set(header, 0);
    midi.set([...new TextEncoder().encode('MTrk'), ...be32(track.length)], header.length);
    midi.set(track, header.length + 8);
    seq.midi = midi;
}

/** How much of the sequences that aren't the game's music, in seconds, is rendered for the page; the rest plays when its .mid is opened. */
const LISTEN_BUDGET = 4 * 60;
/** Lines of the outline shown before it scrolls, so the first sequence's player shows below it. */
const OUTLINE_LINES = 10;

const seconds = (ticks: number) => {
    const s = Math.round(ticks / 120);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const parser: FormatParser = {
    parse(data, context) {
        const b = new Bytes(data);
        const warnings: string[] = [];
        if (data.length < 12 || !['FORM', 'CAT '].includes(b.ascii(0, 4))) throw new Error('This isn\'t XMIDI music: it doesn\'t start with an IFF "FORM" or "CAT ".');
        const top = chunksIn(b, 0, data.length);
        const fields: Field[] = [];

        // The directory: FORM XDIR, its INFO the number of sequences.
        let declared: number | null = null;
        let cat: Chunk | null = null;
        let single: Chunk | null = null;
        for (const c of top) {
            const type = c.end - c.start >= 4 ? b.ascii(c.start, 4) : '';
            if (c.id === 'FORM' && type === 'XDIR' && declared === null) {
                const inner = chunksIn(b, c.start + 4, c.end);
                const info = inner.find((x) => x.id === 'INFO');
                if (info && info.end - info.start >= 2) declared = b.u16(info.start);
                else warnings.push('The XDIR directory has no INFO chunk saying how many sequences there are.');
                fields.push({
                    name: 'Directory (FORM XDIR)',
                    offset: c.at,
                    length: Math.min(8 + c.size + (c.size & 1), data.length - c.at),
                    value: declared === null ? 'no count' : `${declared} sequences`,
                    children: [
                        field('ID', c.at, 4, '"FORM"'),
                        field('Size', c.at + 4, 4, bytesLabel(c.size), 'Big-endian.'),
                        field('Type', c.start, 4, '"XDIR"'),
                        ...inner.map((x) =>
                            x === info && declared !== null
                                ? {
                                      name: 'INFO chunk',
                                      offset: x.at,
                                      length: 8 + x.size,
                                      children: [
                                          field('ID', x.at, 4, '"INFO"'),
                                          field('Size', x.at + 4, 4, bytesLabel(x.size)),
                                          field('Sequences', x.start, 2, declared!, 'Little-endian, unlike the sizes.'),
                                      ],
                                  }
                                : field(`${x.id} chunk`, x.at, 8 + x.size, bytesLabel(x.size), 'Not one XMIDI has.')
                        ),
                    ],
                });
            } else if (c.id === 'CAT ' && type === 'XMID' && !cat) cat = c;
            else if (c.id === 'FORM' && type === 'XMID' && !cat && !single) single = c;
            else {
                warnings.push(`There's a ${c.id.trim()} chunk${type ? ` of type ${type}` : ''} at ${c.at.toLocaleString('en-US')}, which an XMIDI file doesn't have; the player skips it.`);
                fields.push(field(`${c.id.trim()} chunk`, c.at, Math.min(8 + c.size + (c.size & 1), data.length - c.at), bytesLabel(c.size), 'Not part of the music.'));
            }
            if (c.start + c.size > data.length) warnings.push(`The ${c.id.trim()} chunk says it's ${bytesLabel(c.size)}, but only ${bytesLabel(data.length - c.start)} are left.`);
        }
        if (!cat && !single) throw new Error('This XMIDI file has no CAT of type XMID (nor a lone FORM XMID): there are no sequences.');

        // The sequences: FORM XMID in the CAT, or the one on its own.
        const forms = cat ? chunksIn(b, cat.start + 4, cat.end).filter((c) => c.id === 'FORM' && b.ascii(c.start, 4) === 'XMID') : [single!];
        const sequences: Sequence[] = forms.map((form) => {
            const seq: Sequence = {
                form,
                timbres: [],
                branches: [],
                evnt: null,
                events: 0,
                notes: 0,
                channels: new Set(),
                length: 0,
                tempos: 0,
                loops: 0,
                forever: 0,
                cut: false,
                midi: null,
                problems: [],
            };
            for (const c of chunksIn(b, form.start + 4, form.end)) {
                if (c.id === 'TIMB') {
                    const count = c.end - c.start >= 2 ? b.u16(c.start) : 0;
                    if (2 + count * 2 !== c.size) seq.problems.push(`Its TIMB chunk says ${count} instruments, but is ${bytesLabel(c.size)}.`);
                    for (let i = 0; i < count && c.start + 2 + i * 2 + 2 <= c.end; i++) seq.timbres.push({ patch: data[c.start + 2 + i * 2], bank: data[c.start + 3 + i * 2] });
                } else if (c.id === 'RBRN') {
                    const count = c.end - c.start >= 2 ? b.u16(c.start) : 0;
                    if (2 + count * 6 !== c.size) seq.problems.push(`Its RBRN chunk says ${count} branch points, but is ${bytesLabel(c.size)}.`);
                    for (let i = 0; i < count && c.start + 2 + i * 6 + 6 <= c.end; i++) seq.branches.push({ index: b.u16(c.start + 2 + i * 6), offset: b.u32(c.start + 4 + i * 6) });
                } else if (c.id === 'EVNT') seq.evnt = c;
                else seq.problems.push(`It has a ${c.id} chunk, which XMIDI doesn't; the player skips it.`);
            }
            if (!seq.evnt) seq.problems.push('It has no EVNT chunk: there are no events to play.');
            else {
                decodeEvents(data, seq.evnt, seq);
                for (const br of seq.branches)
                    if (br.offset >= seq.evnt.end - seq.evnt.start) seq.problems.push(`Its branch point ${br.index} is at ${br.offset.toLocaleString('en-US')}, past the end of its events.`);
            }
            return seq;
        });
        if (declared !== null && declared !== sequences.length)
            warnings.push(
                `The directory says there are ${declared} sequences, but there are ${sequences.length}: the game would ${declared > sequences.length ? 'find nothing for the rest' : 'never play the others'}.`
            );
        sequences.forEach((s, i) => {
            for (const p of s.problems) warnings.push(`Sequence ${i}: ${p}`);
        });

        // What Dune II plays as music, where it's one of the game's files.
        const stem = context.name?.replace(/\.[^.]+$/, '').toUpperCase() ?? '';
        const music = DUNE2_MUSIC[stem] ?? [];

        // The sequences as fields, and each as a MIDI file.
        const container = cat ?? single!;
        const sequenceFields: Field[] = sequences.map((s, i) => ({
            name: `Sequence ${i}${music.includes(i) ? ' (music in Dune II)' : ''}`,
            offset: s.form.at,
            length: Math.min(8 + s.form.size + (s.form.size & 1), data.length - s.form.at),
            value: s.evnt ? `${seconds(s.length)}, ${s.notes.toLocaleString('en-US')} notes` : 'no events',
            children: [
                field('ID', s.form.at, 4, '"FORM"'),
                field('Size', s.form.at + 4, 4, bytesLabel(s.form.size), 'Big-endian.'),
                field('Type', s.form.start, 4, '"XMID"'),
                ...chunksIn(b, s.form.start + 4, s.form.end).map((c) => {
                    const length = Math.min(8 + c.size + (c.size & 1), data.length - c.at);
                    if (c.id === 'TIMB')
                        return {
                            name: 'Instruments (TIMB)',
                            offset: c.at,
                            length,
                            value: `${s.timbres.length}`,
                            note: 'What it needs from the driver’s instrument bank, each a patch and a bank. The count is little-endian.',
                            children: s.timbres.map((t, k) => field(`Instrument ${k + 1}`, c.start + 2 + k * 2, 2, `patch ${t.patch}, bank ${t.bank}`)),
                        };
                    if (c.id === 'RBRN')
                        return {
                            name: 'Branch points (RBRN)',
                            offset: c.at,
                            length,
                            value: `${s.branches.length}`,
                            note: 'Places in the events the game can jump to. Little-endian.',
                            children: s.branches.map((br, k) => field(`Branch ${br.index}`, c.start + 2 + k * 6, 6, `at ${br.offset.toLocaleString('en-US')}`)),
                        };
                    if (c.id === 'EVNT')
                        return field(
                            'Events (EVNT)',
                            c.at,
                            length,
                            `${s.events.toLocaleString('en-US')} events on channel${s.channels.size === 1 ? '' : 's'} ${[...s.channels]
                                .sort((x, y) => x - y)
                                .map((ch) => ch + 1)
                                .join(', ')}`,
                            `${seconds(s.length)} long, in 120ths of a second.${s.tempos ? ` Its ${s.tempos} tempo event${s.tempos === 1 ? ' is' : 's are'} ignored by the player.` : ''}`
                        );
                    return field(`${c.id} chunk`, c.at, length, bytesLabel(c.size), 'Not one XMIDI has.');
                }),
            ],
        }));
        fields.push({
            name: cat ? 'Sequences (CAT XMID)' : 'Sequence (FORM XMID)',
            offset: container.at,
            length: Math.min(8 + container.size + (container.size & 1), data.length - container.at),
            value: `${sequences.length}`,
            children: cat
                ? [field('ID', cat.at, 4, '"CAT "'), field('Size', cat.at + 4, 4, bytesLabel(cat.size), 'Big-endian.'), field('Type', cat.start, 4, '"XMID"'), ...sequenceFields]
                : sequenceFields[0].children,
        });

        const pad = String(sequences.length - 1).length;
        const entries: Entry[] = sequences.flatMap((s, i) =>
            s.midi
                ? [
                      {
                          name: null,
                          label: `${stem || 'sequence'}-${String(i).padStart(pad, '0')}.mid`,
                          offset: s.form.at,
                          size: s.midi.length,
                          data: s.midi,
                          meta: { Length: seconds(s.length), Notes: s.notes.toLocaleString('en-US') },
                      },
                  ]
                : []
        );
        const loopsOf = (s: Sequence) =>
            s.loops ? `, ${s.loops} loop${s.loops === 1 ? '' : 's'}${s.forever ? ` (${s.forever} meant to play forever, played once)` : ''}${s.cut ? ', cut off at 30 minutes' : ''}` : '';
        const outline = sequences.map(
            (s, i) =>
                `Sequence ${i}${music.includes(i) ? ' (music in Dune II)' : ''}: ${s.evnt ? `${seconds(s.length)}, ${s.notes.toLocaleString('en-US')} notes on ${s.channels.size} channel${s.channels.size === 1 ? '' : 's'}` : 'no events'}${s.timbres.length ? `, ${s.timbres.length} instrument${s.timbres.length === 1 ? '' : 's'} from the bank` : ''}${s.branches.length ? `, ${s.branches.length} branch point${s.branches.length === 1 ? '' : 's'}` : ''}${loopsOf(s)}`
        );

        // Each sequence with notes, on a timeline; the game's own music plays here (it's what these files are opened for), and
        // the others as far as LISTEN_BUDGET goes, in order (each .mid in the contents plays in full when it's opened).
        const songs = sequences.map((s) => {
            const smf = s.midi && s.notes ? readSmf(s.midi) : null;
            return smf && typeof smf !== 'string' ? smf.song : null;
        });
        const listen = new Set<number>();
        let budget = LISTEN_BUDGET;
        sequences.forEach((_, i) => {
            const song = songs[i];
            if (!song) return;
            if (music.includes(i)) listen.add(i);
            else if (song.length <= budget) {
                listen.add(i);
                budget -= song.length;
            }
        });
        const items: { title: string; preview: Preview }[] = [{ title: 'Sequences', preview: { kind: 'text', text: outline.join('\n'), maxLines: OUTLINE_LINES } }];
        sequences.forEach((s, i) => {
            if (!songs[i]) return;
            // Only some are played here, to keep the page light: the rest say where to hear them.
            const label = entries.find((e) => e.offset === s.form.at)?.label;
            items.push({
                title: `Sequence ${i}${music.includes(i) ? ' (music in Dune II)' : ''}`,
                preview: songPreview(songs[i]!, { listen: listen.has(i), elsewhere: label ? `To hear it, open ${label} in the contents.` : undefined }),
            });
        });
        const playing = sequences.filter((s) => s.notes > 0).length;
        const lastEnd = top.length ? maxOf(top.map((c) => c.at + 8 + c.size + (c.size & 1))) : 0;
        return {
            title: 'Music (XMIDI)',
            summary: [
                ['Sequences', `${sequences.length}${declared !== null ? '' : ' (no directory)'}, ${playing} with notes`],
                ['Longest', seconds(sequences.length ? maxOf(sequences.map((s) => s.length)) : 0)],
                ...(music.length ? [['In Dune II', `It plays sequence${music.length === 1 ? '' : 's'} ${music.join(', ')} as music (OpenDUNE’s table)`] as [string, string]] : []),
                ['Loops', sequences.some((s) => s.loops) ? `${sequences.reduce((n, s) => n + s.loops, 0)}, played out in the .mid files and the sound` : 'None'],
                ['Save', 'Each sequence as a standard MIDI file (.mid), from the contents'],
            ],
            fields,
            entries,
            preview: { kind: 'stack', items },
            // IFF pads each chunk to an even length; past the last chunk is nothing the file has.
            end: Math.min(data.length, lastEnd),
            warnings,
        };
    },
};

export default parser;
