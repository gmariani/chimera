/**
 * Standard MIDI files (.mid): an "MThd" header chunk (the format, how many
 * tracks, and how time is counted), then an "MTrk" chunk for each track,
 * every event after a variable-length delay in ticks. Time is counted either
 * in ticks a beat, the beat's length set by tempo events (500,000 µs until
 * the first), or in frames a second and ticks a frame. Events may leave out
 * their status byte when it's the last one's ("running status").
 *
 * This reads a file into its chunks and a song: every channel event, in
 * seconds, all tracks merged. It follows the Standard MIDI File 1.0
 * specification (MIDI Manufacturers Association, 1996).
 */

/** A channel event, when it happens: status (0x80 to 0xEF) and its one or two values. */
export interface SongEvent {
    /** In seconds from the start. */
    time: number;
    status: number;
    a: number;
    b: number;
}

/** What a player needs: the channel events in order, and how long it lasts. */
export interface Song {
    events: SongEvent[];
    /** In seconds: to the last event, or the end of the last track. */
    length: number;
}

export interface SmfTrack {
    /** Where its "MTrk" chunk is, and how long it is (header too). */
    at: number;
    length: number;
    events: number;
    /** Its name (meta event 3), if it has one. */
    name: string | null;
    /** Whether it ends with an end-of-track event, as it must. */
    ended: boolean;
}

export interface Smf {
    format: number;
    /** How many tracks the header says. */
    declared: number;
    /** Ticks a beat; or, when time is in frames, frames a second and ticks a frame. */
    division: { ticksPerBeat: number } | { fps: number; ticksPerFrame: number };
    tracks: SmfTrack[];
    /** Tempo changes (µs a beat), by tick: how many. */
    tempos: number;
    song: Song;
    /** Where the chunks this reader knows end. */
    end: number;
    problems: string[];
}

/** No more events than this are read, over all tracks (a three-minute piece has a few thousand). */
const MAX_EVENTS = 2_000_000;

const ascii = (data: Uint8Array, at: number) => String.fromCharCode(data[at], data[at + 1], data[at + 2], data[at + 3]);
const be = (data: Uint8Array, at: number, n: number) => {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 256 + data[at + i];
    return v;
};

/** A variable-length number: 7 bits a byte, the high bit on all but the last; MIDI allows at most 4. */
function vlq(data: Uint8Array, at: number, end: number): [number, number] | null {
    let v = 0;
    for (let i = 0; i < 4 && at + i < end; i++) {
        const x = data[at + i];
        v = v * 128 + (x & 0x7f);
        if (!(x & 0x80)) return [v, at + i + 1];
    }
    return null;
}

const VALUES: Record<number, number> = { 0x8: 2, 0x9: 2, 0xa: 2, 0xb: 2, 0xc: 1, 0xd: 1, 0xe: 2 };

/** A standard MIDI file, read; or what isn't one. */
export function readSmf(data: Uint8Array): Smf | string {
    if (data.length < 14 || ascii(data, 0) !== 'MThd') return 'It doesn’t start with an "MThd" header.';
    const headerSize = be(data, 4, 4);
    if (headerSize < 6 || 8 + headerSize > data.length) return `Its header says it's ${headerSize} bytes; it's at least 6, inside the file.`;
    const problems: string[] = [];
    const format = be(data, 8, 2);
    const declared = be(data, 10, 2);
    const raw = be(data, 12, 2);
    const division: Smf['division'] = raw & 0x8000 ? { fps: -(((raw >> 8) << 24) >> 24), ticksPerFrame: raw & 0xff } : { ticksPerBeat: raw };
    if ('ticksPerBeat' in division && division.ticksPerBeat === 0) problems.push('The header says 0 ticks a beat: no time can pass.');
    if (format > 2) problems.push(`The header says format ${format}; there are 0 (one track), 1 (tracks together) and 2 (tracks apart).`);

    // Every track's events, by tick; tempo changes apart, to turn ticks into seconds.
    type Timed = { tick: number; order: number; status: number; a: number; b: number };
    const timed: Timed[] = [];
    const tempoAt: { tick: number; uspb: number }[] = [];
    const tracks: SmfTrack[] = [];
    let at = 8 + headerSize;
    let total = 0;
    let maxTick = 0;
    while (at + 8 <= data.length) {
        const id = ascii(data, at);
        const size = be(data, at + 4, 4);
        const start = at + 8;
        const end = Math.min(start + size, data.length);
        if (start + size > data.length)
            problems.push(`The ${id} chunk at ${at.toLocaleString('en-US')} says it's ${size.toLocaleString('en-US')} bytes, but only ${(data.length - start).toLocaleString('en-US')} are left.`);
        if (id !== 'MTrk') {
            if (!/^[\x20-\x7e]{4}$/.test(id)) break;
            problems.push(`There's a "${id}" chunk, which MIDI files don't have; players skip it.`);
            at = start + size;
            continue;
        }
        const track: SmfTrack = { at, length: end - at, events: 0, name: null, ended: false };
        tracks.push(track);
        let p = start;
        let tick = 0;
        let running = 0;
        while (p < end && total < MAX_EVENTS) {
            const delay = vlq(data, p, end);
            if (!delay) {
                problems.push(`Track ${tracks.length}: a delay runs past the end of the track.`);
                break;
            }
            tick += delay[0];
            p = delay[1];
            if (p >= end) {
                problems.push(`Track ${tracks.length}: it ends after a delay, with no event.`);
                break;
            }
            let status = data[p];
            if (status < 0x80) {
                // Running status: the last channel event's status, again.
                if (!running) {
                    problems.push(`Track ${tracks.length}: an event leaves out its status, with none before it to take.`);
                    break;
                }
                status = running;
            } else p++;
            track.events++;
            total++;
            if (status < 0xf0) {
                running = status;
                const n = VALUES[status >> 4];
                if (p + n > end) {
                    problems.push(`Track ${tracks.length}: an event runs past the end of the track.`);
                    break;
                }
                timed.push({ tick, order: timed.length, status, a: data[p] & 0x7f, b: n === 2 ? data[p + 1] & 0x7f : 0 });
                p += n;
            } else if (status === 0xf0 || status === 0xf7) {
                running = 0;
                const length = vlq(data, p, end);
                if (!length || length[1] + length[0] > end) {
                    problems.push(`Track ${tracks.length}: a system-exclusive message runs past the end of the track.`);
                    break;
                }
                p = length[1] + length[0];
            } else if (status === 0xff) {
                running = 0;
                const type = data[p];
                const length = vlq(data, p + 1, end);
                if (!length || length[1] + length[0] > end) {
                    problems.push(`Track ${tracks.length}: a meta event runs past the end of the track.`);
                    break;
                }
                const body = data.subarray(length[1], length[1] + length[0]);
                p = length[1] + length[0];
                if (type === 0x51 && body.length === 3) tempoAt.push({ tick, uspb: be(body, 0, 3) });
                else if (type === 0x03 && !track.name) track.name = new TextDecoder('latin1').decode(body);
                else if (type === 0x2f) {
                    track.ended = true;
                    maxTick = Math.max(maxTick, tick);
                    break;
                }
            } else {
                problems.push(`Track ${tracks.length}: there's a 0x${status.toString(16).toUpperCase()} event, which a MIDI file can't hold.`);
                break;
            }
            maxTick = Math.max(maxTick, tick);
        }
        if (!track.ended) problems.push(`Track ${tracks.length} has no end-of-track event.`);
        else if (p < end) problems.push(`Track ${tracks.length}: ${(end - p).toLocaleString('en-US')} bytes after its end-of-track event aren't read.`);
        at = start + size;
    }
    if (total >= MAX_EVENTS) problems.push(`It has more than ${MAX_EVENTS.toLocaleString('en-US')} events; the rest aren't read.`);
    if (tracks.length !== declared) problems.push(`The header says ${declared} track${declared === 1 ? '' : 's'}, but there ${tracks.length === 1 ? 'is' : 'are'} ${tracks.length}.`);

    // Ticks to seconds: through the tempo changes, in order (format 2's tracks would each have their own; they're taken together here).
    tempoAt.sort((x, y) => x.tick - y.tick);
    // At the same tick, note-offs first: a note ending and the same note starting again then sound as two.
    const isOff = (e: Timed) => e.status >> 4 === 0x8 || (e.status >> 4 === 0x9 && e.b === 0);
    timed.sort((x, y) => x.tick - y.tick || Number(isOff(y)) - Number(isOff(x)) || x.order - y.order);
    // One pass through the tempo changes alongside the events, both in order of tick.
    let next = 0;
    let fromTick = 0;
    let fromSeconds = 0;
    let uspb = 500_000;
    const seconds = (tick: number): number => {
        if ('fps' in division) return division.fps && division.ticksPerFrame ? tick / (division.fps * division.ticksPerFrame) : 0;
        if (!division.ticksPerBeat) return 0;
        while (next < tempoAt.length && tempoAt[next].tick <= tick) {
            fromSeconds += ((tempoAt[next].tick - fromTick) * uspb) / division.ticksPerBeat / 1e6;
            fromTick = tempoAt[next].tick;
            uspb = tempoAt[next].uspb;
            next++;
        }
        return fromSeconds + ((tick - fromTick) * uspb) / division.ticksPerBeat / 1e6;
    };
    const events = timed.map((e) => ({ time: seconds(e.tick), status: e.status, a: e.a, b: e.b }));
    const length = Math.max(events.length ? events[events.length - 1].time : 0, seconds(Math.max(maxTick, timed.length ? timed[timed.length - 1].tick : 0)));
    return { format, declared, division, tracks, tempos: tempoAt.length, song: { events, length }, end: at, problems };
}
