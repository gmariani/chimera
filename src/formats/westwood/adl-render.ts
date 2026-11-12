import { OPL_RATE, Opl2 } from '../../core/opl2';
import type { MusicNote } from '../../core/types';
import { AdlDriver } from './adl-player';

/**
 * A track of an .ADL file played as the game plays it: Westwood's player
 * (adl-player.ts) writing to an emulated OPL2 (core/opl2.ts) 72 times a
 * second, and the notes it plays, read back from those writes.
 */

/** How often the game calls the player. */
export const TICKS_PER_SECOND = 72;
export const RENDER_RATE = 22050;

/** The drums of rhythm mode, by their bit in register 0xBD, as General MIDI's drum notes: bass drum, snare, tom-tom, cymbal, hi-hat. */
const DRUMS: [bit: number, note: number][] = [
    [0x10, 36],
    [0x08, 38],
    [0x04, 45],
    [0x02, 49],
    [0x01, 42],
];
/** Notes go on the voice they play on; the drums on MIDI's drum channel. */
const DRUM_CHANNEL = 9;

/** Watches the chip's registers for notes: a voice keyed on at a pitch, until it's keyed off or moves to another. */
class NoteTracker {
    readonly notes: MusicNote[] = [];
    private readonly a = new Uint8Array(9);
    private readonly b = new Uint8Array(9);
    private readonly open: (MusicNote | null)[] = Array(9).fill(null);
    private readonly drums = new Map<number, MusicNote>();
    private rhythm = false;
    time = 0;

    /** A voice's MIDI note from its F-number and block; null for what's too low to hear (as when the player wakes a voice). */
    private pitch(voice: number) {
        const fnum = ((this.b[voice] & 3) << 8) | this.a[voice];
        const hz = (fnum * OPL_RATE) / 2 ** (20 - ((this.b[voice] >> 2) & 7));
        return hz < 20 ? null : Math.round(69 + 12 * Math.log2(hz / 440));
    }

    private end(voice: number) {
        const n = this.open[voice];
        if (n) n.end = this.time;
        this.open[voice] = null;
    }

    private update(voice: number) {
        if (this.rhythm && voice >= 6) return;
        const on = (this.b[voice] & 0x20) !== 0;
        const note = on ? this.pitch(voice) : null;
        const open = this.open[voice];
        if (open && open.note === note) return;
        this.end(voice);
        if (note !== null) {
            const n = { start: this.time, end: this.time, channel: voice, note };
            this.notes.push(n);
            this.open[voice] = n;
        }
    }

    write(reg: number, val: number) {
        if (reg >= 0xa0 && reg <= 0xa8) {
            this.a[reg - 0xa0] = val;
            this.update(reg - 0xa0);
        } else if (reg >= 0xb0 && reg <= 0xb8) {
            this.b[reg - 0xb0] = val;
            this.update(reg - 0xb0);
        } else if (reg === 0xbd) {
            const rhythm = (val & 0x20) !== 0;
            if (rhythm && !this.rhythm) for (const v of [6, 7, 8]) this.end(v);
            this.rhythm = rhythm;
            for (const [bit, note] of DRUMS) {
                const playing = this.drums.get(bit);
                const on = rhythm && (val & bit) !== 0;
                if (on && !playing) {
                    const n = { start: this.time, end: this.time, channel: DRUM_CHANNEL, note };
                    this.notes.push(n);
                    this.drums.set(bit, n);
                } else if (!on && playing) {
                    playing.end = this.time;
                    this.drums.delete(bit);
                }
            }
        }
    }

    /** Ends what's still sounding. */
    close() {
        for (let v = 0; v < 9; v++) this.end(v);
        for (const n of this.drums.values()) n.end = this.time;
        this.drums.clear();
    }
}

export interface RenderedTrack {
    /** 16-bit mono, at RENDER_RATE. */
    samples: Int16Array;
    notes: MusicNote[];
    /** How long it plays, in seconds. */
    seconds: number;
    /** Whether it comes round again (it's faded out after once round), stops by itself, or is cut at the most allowed. */
    ending: 'loops' | 'stops' | 'cut';
    /** Instruments the file lacks that it set up anyway, from what their empty entries point to. */
    missing: number[];
}

/** How long a looping track goes on fading after coming round, and a stopped one sounds on as its notes release. */
const FADE_SECONDS = 4;
const RELEASE_SECONDS = 1;

/**
 * Plays a program (a track's) of an .ADL file whose data starts at `base`, until every voice has stopped or come round,
 * at most `maxSeconds`. `missing` is how instruments the file lacks are treated (see AdlDriver).
 */
export function renderTrack(file: Uint8Array, base: number, version: number, program: number, maxSeconds = 360, missing: 'dune2' | 'skip' = 'dune2'): RenderedTrack {
    const chip = new Opl2(RENDER_RATE);
    const tracker = new NoteTracker();
    const driver = new AdlDriver(
        file,
        base,
        version,
        (reg, val) => {
            chip.write(reg, val);
            tracker.write(reg, val);
        },
        missing
    );
    driver.initDriver();
    driver.stopAllChannels();
    chip.write(0x01, 0x20);
    driver.startSound(program, 0xff);

    const maxTicks = Math.round(maxSeconds * TICKS_PER_SECOND);
    const chunks: Int32Array[] = [];
    let made = 0;
    /** The samples of ticks [0, tick): each tick its share of the rate, so they add up exactly. */
    const samplesTo = (tick: number) => Math.floor((tick * RENDER_RATE) / TICKS_PER_SECOND);
    let ending: RenderedTrack['ending'] = 'cut';
    /** The tick it stopped or came round at, and the tick the tail after it ends at. */
    let endTick = -1;
    let stopAt = -1;
    for (let tick = 0; ; tick++) {
        tracker.time = tick / TICKS_PER_SECOND;
        if (endTick < 0) {
            if (tick >= maxTicks) break;
            driver.callback();
            let going = false;
            let playing = false;
            for (let i = 0; i < 10; i++) {
                playing ||= driver.isChannelPlaying(i);
                going ||= driver.isChannelPlaying(i) && !driver.isChannelRepeating(i);
            }
            if (!going) {
                ending = playing ? 'loops' : 'stops';
                endTick = tick + 1;
                stopAt = endTick + Math.round((playing ? FADE_SECONDS : RELEASE_SECONDS) * TICKS_PER_SECOND);
            }
        } else if (tick >= stopAt) break;
        // Once round, a looping track plays on as it fades.
        else if (ending === 'loops') driver.callback();
        const chunk = new Int32Array(samplesTo(tick + 1) - made);
        chip.generate(chunk);
        chunks.push(chunk);
        made += chunk.length;
    }
    tracker.time = made / RENDER_RATE;
    tracker.close();

    // Into 16 bits, fading a looping track out after it has come round.
    const samples = new Int16Array(made);
    const fadeFrom = ending === 'loops' ? samplesTo(endTick) : made;
    let at = 0;
    for (const chunk of chunks)
        for (let i = 0; i < chunk.length; i++, at++) {
            const gain = at < fadeFrom ? 1 : 1 - (at - fadeFrom) / Math.max(1, made - fadeFrom);
            const v = chunk[i] * gain;
            samples[at] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
        }
    return { samples, notes: tracker.notes, seconds: made / RENDER_RATE, ending, missing: [...driver.missingUsed].sort((x, y) => x - y) };
}
