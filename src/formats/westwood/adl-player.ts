/**
 * Westwood's AdLib player: what ALFX.DRV (Dune II) and its successors in
 * Kyrandia and Lands of Lore do with an .ADL file's programs, 72 times a
 * second, writing the OPL2 chip's registers as they go.
 *
 * A port of ScummVM's reimplementation of the driver (engines/kyra/sound/
 * drivers/adlib.cpp, GPL-2.0-or-later), as AdPlug carries it (src/adl.cpp,
 * with its "repeating" flag for knowing when a song has come round), for
 * versions 2 and 3: Dune II's, Kyrandia's and Eye of the Beholder II's. It
 * keeps the driver's 8- and 16-bit arithmetic, wrap-arounds included.
 * https://github.com/scummvm/scummvm, https://github.com/adplug/adplug
 *
 * One difference, on purpose: an instrument the file's table lacks (an offset
 * of 0 or 0xFFFF) is set up from wherever that offset points, as ALFX.DRV
 * does (it adds the offset to the data's start in a 16-bit register, with no
 * check), where ScummVM ignores it. With `missing: 'skip'`, it does as
 * ScummVM does.
 */

/** Each channel's first operator's register offset; the second's is 3 more. */
const REG_OFFSET = [0x00, 0x01, 0x02, 0x08, 0x09, 0x0a, 0x10, 0x11, 0x12];
/** The F-number of each note of the octave. */
const FREQ = [0x0134, 0x0147, 0x015a, 0x016f, 0x0184, 0x019c, 0x01b4, 0x01ce, 0x01e9, 0x0207, 0x0225, 0x0246];
/** The first value of each of updateCallback46's six tables (ScummVM's _unkTable2): the only one it ever reads. */
const TABLE2_FIRST = [0x50, 0x00, 0x50, 0x00, 0x40, 0x00];
// prettier-ignore
const PITCH_BEND = [
    [0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x21],
    [0x00, 0x01, 0x02, 0x03, 0x04, 0x06, 0x07, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x22, 0x24],
    [0x00, 0x01, 0x02, 0x03, 0x04, 0x06, 0x08, 0x09, 0x0a, 0x0c, 0x0d, 0x0e, 0x0f, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x19, 0x1a, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x21, 0x22, 0x24, 0x25, 0x26],
    [0x00, 0x01, 0x02, 0x03, 0x04, 0x06, 0x08, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x1a, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x21, 0x23, 0x25, 0x27, 0x28],
    [0x00, 0x01, 0x02, 0x03, 0x04, 0x06, 0x08, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x11, 0x13, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1b, 0x1d, 0x1f, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x28, 0x2a],
    [0x00, 0x01, 0x02, 0x03, 0x05, 0x07, 0x09, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x13, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1b, 0x1d, 0x1f, 0x20, 0x21, 0x22, 0x23, 0x25, 0x27, 0x29, 0x2b, 0x2d],
    [0x00, 0x01, 0x02, 0x03, 0x05, 0x07, 0x09, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x13, 0x15, 0x16, 0x17, 0x18, 0x1a, 0x1c, 0x1e, 0x21, 0x24, 0x25, 0x26, 0x27, 0x29, 0x2b, 0x2d, 0x2f, 0x30],
    [0x00, 0x01, 0x02, 0x04, 0x06, 0x08, 0x0a, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x13, 0x15, 0x18, 0x19, 0x1a, 0x1c, 0x1d, 0x1f, 0x21, 0x23, 0x25, 0x26, 0x27, 0x29, 0x2b, 0x2d, 0x2f, 0x30, 0x32],
    [0x00, 0x01, 0x02, 0x04, 0x06, 0x08, 0x0a, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x14, 0x17, 0x1a, 0x19, 0x1a, 0x1c, 0x1e, 0x20, 0x22, 0x25, 0x28, 0x29, 0x2a, 0x2b, 0x2d, 0x2f, 0x31, 0x33, 0x35],
    [0x00, 0x01, 0x03, 0x05, 0x07, 0x09, 0x0b, 0x0e, 0x0f, 0x10, 0x12, 0x14, 0x16, 0x18, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x20, 0x22, 0x24, 0x26, 0x29, 0x2a, 0x2c, 0x2e, 0x30, 0x32, 0x34, 0x36, 0x39],
    [0x00, 0x01, 0x03, 0x05, 0x07, 0x09, 0x0b, 0x0e, 0x0f, 0x10, 0x12, 0x14, 0x16, 0x19, 0x1b, 0x1e, 0x1f, 0x21, 0x23, 0x25, 0x27, 0x29, 0x2b, 0x2d, 0x2e, 0x2f, 0x31, 0x32, 0x34, 0x36, 0x39, 0x3c],
    [0x00, 0x01, 0x03, 0x05, 0x07, 0x0a, 0x0c, 0x0f, 0x10, 0x11, 0x13, 0x15, 0x17, 0x19, 0x1b, 0x1e, 0x1f, 0x20, 0x22, 0x24, 0x26, 0x28, 0x2b, 0x2e, 0x2f, 0x30, 0x32, 0x34, 0x36, 0x39, 0x3c, 0x3f],
    [0x00, 0x02, 0x04, 0x06, 0x08, 0x0b, 0x0d, 0x10, 0x11, 0x12, 0x14, 0x16, 0x18, 0x1b, 0x1e, 0x21, 0x22, 0x23, 0x25, 0x27, 0x29, 0x2c, 0x2f, 0x32, 0x33, 0x34, 0x36, 0x38, 0x3b, 0x34, 0x41, 0x44],
    [0x00, 0x02, 0x04, 0x06, 0x08, 0x0b, 0x0d, 0x11, 0x12, 0x13, 0x15, 0x17, 0x1a, 0x1d, 0x20, 0x23, 0x24, 0x25, 0x27, 0x29, 0x2c, 0x2f, 0x32, 0x35, 0x36, 0x37, 0x39, 0x3b, 0x3e, 0x41, 0x44, 0x47],
];

const u8 = (v: number) => v & 0xff;
const s8 = (v: number) => (v << 24) >> 24;
const s16 = (v: number) => (v << 16) >> 16;
const clip = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
/** A timer/tempo pair: the tempo is added each call, and the timer wrapping past 255 is the signal to act. */
const advance = (c: Channel, timer: 'timer' | 'slideTimer' | 'vibratoTimer' | 'secondaryEffectTimer', tempo: number) => {
    const old = c[timer];
    c[timer] = u8(old + tempo);
    return c[timer] < old;
};

type Effect = 'slide' | 'vibrato' | 'secondary' | null;

class Channel {
    repeating = false;
    opExtraLevel2 = 0;
    /** Where its program is (a place in the file), or -1 when it's stopped. */
    dataptr = -1;
    duration = 0;
    repeatCounter = 0;
    baseOctave = 0;
    priority = 0;
    dataptrStack: number[] = [];
    baseNote = 0;
    slideTempo = 0;
    slideTimer = 0;
    slideStep = 0;
    vibratoStep = 0;
    vibratoStepRange = 0;
    vibratoStepsCountdown = 0;
    vibratoNumSteps = 0;
    vibratoDelay = 0;
    vibratoTempo = 0;
    vibratoTimer = 0;
    vibratoDelayCountdown = 0;
    opExtraLevel1 = 0;
    spacing2 = 0;
    baseFreq = 0;
    tempo = 0xff;
    timer = 0;
    regAx = 0;
    regBx = 0;
    primaryEffect: Effect = null;
    secondaryEffect: Effect = null;
    fractionalSpacing = 0;
    opLevel1 = 0;
    opLevel2 = 0;
    opExtraLevel3 = 0;
    twoChan = 0;
    spacing1 = 1;
    durationRandomness = 0;
    secondaryEffectTempo = 0;
    secondaryEffectTimer = 0;
    secondaryEffectSize = 0;
    secondaryEffectPos = 0;
    secondaryEffectRegbase = 0;
    secondaryEffectData = 0;
    tempoReset = 0;
    rawNote = 0;
    pitchBend = 0;
    volumeModifier = 0;
}

interface QueueEntry {
    data: number;
    id: number;
    volume: number;
}

/** How many values each command takes, by its number (the byte less 0x80), and what it does. */
type Command = [values: number, run: (d: AdlDriver, c: Channel, v: number) => number];

export class AdlDriver {
    private curChannel = 0;
    soundTrigger = 0;
    private rnd = 0x1234;
    private beatDivider = 0;
    private beatDivCnt = 0;
    private callbackTimer = 0xff;
    private beatCounter = 0;
    private beatWaiting = 0;
    private opLevelBD = 0;
    private opLevelHH = 0;
    private opLevelSD = 0;
    private opLevelTT = 0;
    private opLevelCY = 0;
    private extra1 = { HH: 0, CY: 0, TT: 0, SD: 0, BD: 0 };
    private extra2 = { HH: 0, CY: 0, TT: 0, SD: 0, BD: 0 };
    private readonly queue: QueueEntry[] = Array.from({ length: 16 }, () => ({ data: -1, id: 0, volume: 0 }));
    private programStartTimeout = 0;
    private queueStart = 0;
    private queueEnd = 0;
    private retrySounds = false;
    private sfxPointer = -1;
    private sfxPriority = 0;
    private sfxVelocity = 0;
    readonly channels = Array.from({ length: 10 }, () => new Channel());
    private vibratoAndAMDepthBits = 0;
    private rhythmSectionBits = 0;
    private curRegOffset = 0;
    private tempo = 0;
    private readonly musicVolume = 0xff;
    private readonly sfxVolume = 0xff;
    private readonly numPrograms: number;
    /** The file, copied: the player changes a sound effect's bytes while it plays, and puts them back. */
    private readonly mem: Uint8Array;
    private readonly end: number;
    /** The instruments the file lacks that were set up anyway (as ALFX.DRV does), by number. */
    readonly missingUsed = new Set<number>();

    /**
     * A player for the data starting at `base` in `file` (the end of the track table), of `version` 1 to 4, writing the
     * chip's registers through `write`.
     */
    constructor(
        file: Uint8Array,
        private readonly base: number,
        private readonly version: number,
        private readonly write: (reg: number, val: number) => void,
        private readonly missing: 'dune2' | 'skip' = 'dune2'
    ) {
        this.mem = file.slice();
        this.end = file.length;
        this.numPrograms = version === 1 ? 150 : version === 4 ? 500 : 250;
    }

    /** `ptr + n`, if it's within the data (its end included), else -1. */
    private check(ptr: number, n: number) {
        return ptr >= 0 && ptr + n >= this.base && ptr + n <= this.end ? ptr + n : -1;
    }
    private word(at: number) {
        return this.mem[at] | (this.mem[at + 1] << 8);
    }

    /** Where a program is, or -1: the driver ignores offsets of 0 (the table itself) and those past the data. */
    getProgram(id: number) {
        if (id < 0 || id >= (this.end - this.base) >> 1) return -1;
        const offset = this.word(this.base + id * 2);
        return offset === 0 || offset >= this.end - this.base ? -1 : this.base + offset;
    }
    /** Where an instrument is, or -1. ALFX.DRV takes any offset, wrapping at 64 KB: 0 is the table, 0xFFFF the byte before. */
    private getInstrument(id: number) {
        if (this.missing === 'skip') return this.getProgram(this.numPrograms + id);
        const entry = this.base + (this.numPrograms + id) * 2;
        if (entry < this.base || entry + 2 > this.end) return -1;
        const offset = this.word(entry);
        if (offset === 0 || offset === 0xffff) this.missingUsed.add(id);
        const at = this.base + offset < this.end ? this.base + offset : this.base + offset - 0x10000;
        return at >= 0 && at + 11 <= this.end ? at : -1;
    }

    initDriver() {
        this.resetAdLibState();
    }

    startSound(program: number, volume: number) {
        const data = this.getProgram(program);
        if (data < 0) return;
        if (this.queueEnd === this.queueStart && this.queue[this.queueEnd].data >= 0) return;
        this.queue[this.queueEnd] = { data, id: program, volume };
        this.queueEnd = (this.queueEnd + 1) & 15;
    }

    isChannelPlaying(channel: number) {
        return this.channels[channel].dataptr >= 0;
    }
    isChannelRepeating(channel: number) {
        return this.channels[channel].repeating;
    }

    stopAllChannels() {
        for (let channel = 0; channel <= 9; channel++) {
            this.curChannel = channel;
            const chan = this.channels[channel];
            chan.priority = 0;
            chan.dataptr = -1;
            if (channel !== 9) this.noteOff(chan);
        }
        this.retrySounds = false;
        this.queueStart = this.queueEnd = 0;
        this.queue[0] = { data: -1, id: 0, volume: 0 };
        this.programStartTimeout = 0;
    }

    /** One tick of the timer: start what's queued, run each channel's program, and keep the beat. */
    callback() {
        if (this.programStartTimeout) this.programStartTimeout--;
        else this.setupPrograms();
        this.executePrograms();
        const old = this.callbackTimer;
        this.callbackTimer = u8(old + this.tempo);
        if (this.callbackTimer < old) {
            this.beatDivCnt = u8(this.beatDivCnt - 1);
            if (!this.beatDivCnt) {
                this.beatDivCnt = this.beatDivider;
                this.beatCounter = u8(this.beatCounter + 1);
            }
        }
    }

    private setupPrograms() {
        const entry = this.queue[this.queueStart];
        let ptr = entry.data;
        if (this.queueStart === this.queueEnd && ptr < 0) return;
        let retry: QueueEntry | null = null;
        if (entry.id === 0) this.retrySounds = true;
        else if (this.retrySounds) retry = { ...entry };
        entry.data = -1;
        this.queueStart = (this.queueStart + 1) & 15;
        if (this.check(ptr, 2) < 0) return;
        const chan = this.mem[ptr];
        if (chan > 9 || (chan < 9 && this.check(ptr, 4) < 0)) return;
        const channel = this.channels[chan];
        this.adjustSfxData(ptr++, entry.volume);
        const priority = this.mem[ptr++];
        if (priority >= channel.priority) {
            this.initChannel(channel);
            channel.priority = priority;
            channel.dataptr = ptr;
            channel.tempo = 0xff;
            channel.timer = 0xff;
            channel.duration = 1;
            channel.volumeModifier = chan <= 5 ? this.musicVolume : this.sfxVolume;
            this.initAdlibChannel(chan);
            this.programStartTimeout = 2;
            retry = null;
        }
        if (retry && retry.data >= 0) this.startSound(retry.id, retry.volume);
    }

    private adjustSfxData(ptr: number, volume: number) {
        const m = this.mem;
        if (this.sfxPointer >= 0) {
            m[this.sfxPointer + 1] = this.sfxPriority;
            m[this.sfxPointer + 3] = this.sfxVelocity;
            this.sfxPointer = -1;
        }
        if (m[ptr] === 9) return;
        this.sfxPointer = ptr;
        this.sfxPriority = m[ptr + 1];
        this.sfxVelocity = m[ptr + 3];
        if (volume !== 0xff) {
            if (this.version >= 3) {
                const newVal = (((m[ptr + 3] + 63) * volume) >> 8) & 0xff;
                m[ptr + 3] = u8(-newVal + 63);
                m[ptr + 1] = ((m[ptr + 1] * volume) >> 8) & 0xff;
            } else {
                const newVal = ((this.sfxVelocity << 2) ^ 0xff) * volume;
                m[ptr + 3] = u8((newVal >> 10) ^ 0x3f);
                m[ptr + 1] = u8(newVal >> 11);
            }
        }
    }

    private executePrograms() {
        for (this.curChannel = 9; this.curChannel >= 0; this.curChannel--) {
            const channel = this.channels[this.curChannel];
            if (channel.dataptr < 0) continue;
            this.curRegOffset = this.curChannel === 9 ? 0 : REG_OFFSET[this.curChannel];
            if (channel.tempoReset) channel.tempo = this.tempo;
            let result = 1;
            if (advance(channel, 'timer', channel.tempo)) {
                channel.duration = u8(channel.duration - 1);
                if (channel.duration) {
                    if (channel.duration === channel.spacing2) this.noteOff(channel);
                    if (channel.duration === channel.spacing1 && this.curChannel !== 9) this.noteOff(channel);
                } else result = 0;
            }
            while (result === 0 && channel.dataptr >= 0) {
                let opcode = 0xff;
                if (this.check(channel.dataptr, 1) >= 0) opcode = this.mem[channel.dataptr++];
                if (opcode & 0x80) {
                    const [values, run] = COMMANDS[clip(opcode & 0x7f, 0, COMMANDS.length - 1)];
                    if (this.check(channel.dataptr, values) < 0) {
                        result = this.stopChannel(channel);
                        break;
                    }
                    channel.dataptr += values;
                    result = run(this, channel, channel.dataptr - values);
                } else {
                    if (this.check(channel.dataptr, 1) < 0) {
                        result = this.stopChannel(channel);
                        break;
                    }
                    const duration = this.mem[channel.dataptr++];
                    this.setupNote(opcode, channel);
                    this.noteOn(channel);
                    this.setupDuration(duration, channel);
                    result = duration !== 0 ? 1 : 0;
                }
            }
            if (result === 1) {
                this.runEffect(channel.primaryEffect, channel);
                this.runEffect(channel.secondaryEffect, channel);
            }
        }
    }

    private runEffect(effect: Effect, channel: Channel) {
        if (effect === 'slide') this.primaryEffectSlide(channel);
        else if (effect === 'vibrato') this.primaryEffectVibrato(channel);
        else if (effect === 'secondary') this.secondaryEffect1(channel);
    }

    private resetAdLibState() {
        this.rnd = 0x1234;
        this.write(0x01, 0x20);
        this.write(0x08, 0x00);
        this.write(0xbd, 0x00);
        this.initChannel(this.channels[9]);
        for (let loop = 8; loop >= 0; loop--) {
            this.write(0x40 + REG_OFFSET[loop], 0x3f);
            this.write(0x43 + REG_OFFSET[loop], 0x3f);
            this.initChannel(this.channels[loop]);
        }
    }

    private initChannel(channel: Channel) {
        const keep = channel.opExtraLevel2;
        Object.assign(channel, new Channel());
        channel.opExtraLevel2 = keep;
    }

    private noteOff(channel: Channel) {
        if (this.curChannel >= 9) return;
        if (this.rhythmSectionBits && this.curChannel >= 6) return;
        channel.regBx &= 0xdf;
        this.write(0xb0 + this.curChannel, channel.regBx);
    }

    private initAdlibChannel(chan: number) {
        if (chan >= 9) return;
        if (this.rhythmSectionBits && chan >= 6) return;
        const offset = REG_OFFSET[chan];
        this.write(0x60 + offset, 0xff);
        this.write(0x63 + offset, 0xff);
        this.write(0x80 + offset, 0xff);
        this.write(0x83 + offset, 0xff);
        this.write(0xb0 + chan, 0x00);
        this.write(0xb0 + chan, 0x20);
    }

    private getRandomNr() {
        this.rnd = (this.rnd + 0x9248) & 0xffff;
        const lowBits = this.rnd & 7;
        this.rnd = (this.rnd >> 3) | (lowBits << 13);
        return this.rnd;
    }

    private setupDuration(duration: number, channel: Channel) {
        if (channel.durationRandomness) {
            channel.duration = u8(duration + (this.getRandomNr() & channel.durationRandomness));
            return;
        }
        if (channel.fractionalSpacing) channel.spacing2 = u8((duration >> 3) * channel.fractionalSpacing);
        channel.duration = duration;
    }

    private setupNote(rawNote: number, channel: Channel, flag = false) {
        if (this.curChannel >= 9) return;
        channel.rawNote = rawNote;
        let note = s8((rawNote & 0x0f) + channel.baseNote);
        let octave = s8(((rawNote + channel.baseOctave) >> 4) & 0x0f);
        if (note >= 12) {
            octave = s8(octave + Math.trunc(note / 12));
            note %= 12;
        } else if (note < 0) {
            const octaves = s8(Math.trunc(-(note + 1) / 12) + 1);
            octave = s8(octave - octaves);
            note = s8(note + 12 * octaves);
        }
        let freq = (FREQ[note] + channel.baseFreq) & 0xffff;
        if (channel.pitchBend || flag) {
            const indexNote = clip(rawNote & 0x0f, 0, 11);
            if (channel.pitchBend >= 0) freq = (freq + PITCH_BEND[indexNote + 2][clip(channel.pitchBend, 0, 31)]) & 0xffff;
            else freq = (freq - PITCH_BEND[indexNote][clip(-channel.pitchBend, 0, 31)]) & 0xffff;
        }
        const oct = clip(octave, 0, 7) << 2;
        channel.regAx = freq & 0xff;
        channel.regBx = (channel.regBx & 0x20) | oct | ((freq >> 8) & 0x03);
        this.write(0xa0 + this.curChannel, channel.regAx);
        this.write(0xb0 + this.curChannel, channel.regBx);
    }

    private setupInstrument(regOffset: number, at: number, channel: Channel) {
        if (this.curChannel >= 9) return;
        if (at < 0 || at + 11 > this.end) return;
        const m = this.mem;
        this.write(0x20 + regOffset, m[at]);
        this.write(0x23 + regOffset, m[at + 1]);
        const temp = m[at + 2];
        this.write(0xc0 + this.curChannel, temp);
        channel.twoChan = temp & 1;
        this.write(0xe0 + regOffset, m[at + 3]);
        this.write(0xe3 + regOffset, m[at + 4]);
        channel.opLevel1 = m[at + 5];
        channel.opLevel2 = m[at + 6];
        this.write(0x40 + regOffset, this.calculateOpLevel1(channel));
        this.write(0x43 + regOffset, this.calculateOpLevel2(channel));
        this.write(0x60 + regOffset, m[at + 7]);
        this.write(0x63 + regOffset, m[at + 8]);
        this.write(0x80 + regOffset, m[at + 9]);
        this.write(0x83 + regOffset, m[at + 10]);
    }

    private noteOn(channel: Channel) {
        if (this.curChannel >= 9) return;
        channel.regBx |= 0x20;
        this.write(0xb0 + this.curChannel, channel.regBx);
        const shift = 9 - clip(s8(channel.vibratoStepRange), 0, 9);
        const freq = ((channel.regBx << 8) | channel.regAx) & 0x3ff;
        channel.vibratoStep = (freq >> shift) & 0xff;
        channel.vibratoDelayCountdown = channel.vibratoDelay;
    }

    private adjustVolume(channel: Channel) {
        if (this.curChannel >= 9) return;
        this.write(0x43 + REG_OFFSET[this.curChannel], this.calculateOpLevel2(channel));
        if (channel.twoChan) this.write(0x40 + REG_OFFSET[this.curChannel], this.calculateOpLevel1(channel));
    }

    private primaryEffectSlide(channel: Channel) {
        if (this.curChannel >= 9) return;
        if (!advance(channel, 'slideTimer', channel.slideTempo)) return;
        let freq = s16(((channel.regBx & 0x03) << 8) | channel.regAx);
        let octave = channel.regBx & 0x1c;
        const noteOn = channel.regBx & 0x20;
        freq = s16(freq + clip(channel.slideStep, -0x3ff, 0x3ff));
        if (channel.slideStep >= 0 && freq >= 734) {
            freq >>= 1;
            if (!(freq & 0x3ff)) freq++;
            octave = u8(octave + 4);
        } else if (channel.slideStep < 0 && freq < 388) {
            if (freq < 0) freq = 0;
            freq = s16(freq << 1);
            if (!(freq & 0x3ff)) freq--;
            octave = u8(octave - 4);
        }
        channel.regAx = freq & 0xff;
        channel.regBx = noteOn | (octave & 0x1c) | ((freq >> 8) & 0x03);
        this.write(0xa0 + this.curChannel, channel.regAx);
        this.write(0xb0 + this.curChannel, channel.regBx);
    }

    private primaryEffectVibrato(channel: Channel) {
        if (this.curChannel >= 9) return;
        if (channel.vibratoDelayCountdown) {
            channel.vibratoDelayCountdown--;
            return;
        }
        if (advance(channel, 'vibratoTimer', channel.vibratoTempo)) {
            channel.vibratoStepsCountdown = u8(channel.vibratoStepsCountdown - 1);
            if (!channel.vibratoStepsCountdown) {
                channel.vibratoStep = s16(-channel.vibratoStep);
                channel.vibratoStepsCountdown = channel.vibratoNumSteps;
            }
            const freq = ((((channel.regBx << 8) | channel.regAx) & 0x3ff) + channel.vibratoStep) & 0xffff;
            channel.regAx = freq & 0xff;
            channel.regBx = u8((channel.regBx & 0xfc) | (freq >> 8));
            this.write(0xa0 + this.curChannel, channel.regAx);
            this.write(0xb0 + this.curChannel, channel.regBx);
        }
    }

    private secondaryEffect1(channel: Channel) {
        if (this.curChannel >= 9) return;
        if (advance(channel, 'secondaryEffectTimer', channel.secondaryEffectTempo)) {
            channel.secondaryEffectPos = s8(channel.secondaryEffectPos - 1);
            if (channel.secondaryEffectPos < 0) channel.secondaryEffectPos = channel.secondaryEffectSize;
            const at = this.base + channel.secondaryEffectData + channel.secondaryEffectPos;
            this.write(u8(channel.secondaryEffectRegbase + this.curRegOffset), at >= 0 && at < this.end ? this.mem[at] : 0);
        }
    }

    private level3(channel: Channel) {
        let level3 = ((channel.opExtraLevel3 ^ 0x3f) * channel.volumeModifier) & 0xffff;
        if (level3) level3 = ((level3 + 0x3f) & 0xffff) >> 8;
        return level3 ^ 0x3f;
    }
    private calculateOpLevel1(channel: Channel) {
        let value = channel.opLevel1 & 0x3f;
        if (channel.twoChan) value = u8(value + channel.opExtraLevel1 + channel.opExtraLevel2 + this.level3(channel));
        value = Math.min(value, 0x3f);
        if (!channel.volumeModifier) value = 0x3f;
        return value | (channel.opLevel1 & 0xc0);
    }
    private calculateOpLevel2(channel: Channel) {
        let value = u8((channel.opLevel2 & 0x3f) + channel.opExtraLevel1 + channel.opExtraLevel2 + this.level3(channel));
        value = Math.min(value, 0x3f);
        if (!channel.volumeModifier) value = 0x3f;
        return value | (channel.opLevel2 & 0xc0);
    }

    // The commands.
    private v(at: number) {
        return this.mem[at];
    }
    stopChannel(channel: Channel) {
        channel.priority = 0;
        if (this.curChannel !== 9) this.noteOff(channel);
        channel.dataptr = -1;
        return 2;
    }

    static readonly commands = (): Command[] => {
        const nop: Command = [0, () => 0];
        const stop: Command = [0, (d, c) => d.stopChannel(c)];
        return [
            // 0x80: set the repeat count
            [1, (d, c, v) => ((c.repeatCounter = d.v(v)), 0)],
            // 0x81: repeat, jumping back while the count lasts
            [
                2,
                (d, c, v) => {
                    c.repeatCounter = u8(c.repeatCounter - 1);
                    if (c.repeatCounter) {
                        const add = s16(d.word(v));
                        const to = d.check(c.dataptr, add);
                        if (to >= 0) c.dataptr = to;
                    }
                    return 0;
                },
            ],
            // 0x82: start a program
            [1, (d, c, v) => d.setupProgram(c, d.v(v))],
            // 0x83: note spacing
            [1, (d, c, v) => ((c.spacing1 = d.v(v)), 0)],
            // 0x84: jump
            [
                2,
                (d, c, v) => {
                    const add = s16(d.word(v));
                    c.dataptr = d.version === 1 ? d.check(d.base, add - 191) : d.check(c.dataptr, add);
                    if (c.dataptr < 0) return d.stopChannel(c);
                    if (add < 0) c.repeating = true;
                    return 0;
                },
            ],
            // 0x85: call a subroutine
            [
                2,
                (d, c, v) => {
                    const add = s16(d.word(v));
                    if (c.dataptrStack.length >= 4) return 0;
                    c.dataptrStack.push(c.dataptr);
                    c.dataptr = d.version < 3 ? d.check(d.base, add - 191) : d.check(c.dataptr, add);
                    if (c.dataptr < 0) c.dataptr = c.dataptrStack.pop()!;
                    return 0;
                },
            ],
            // 0x86: return from the subroutine
            [0, (d, c) => (c.dataptrStack.length ? ((c.dataptr = c.dataptrStack.pop()!), 0) : d.stopChannel(c))],
            // 0x87: base octave
            [1, (d, c, v) => ((c.baseOctave = s8(d.v(v))), 0)],
            // 0x88: stop
            stop,
            // 0x89: rest
            [1, (d, c, v) => (d.setupDuration(d.v(v), c), d.noteOff(c), d.v(v) !== 0 ? 1 : 0)],
            // 0x8A: write a chip register
            [2, (d, _c, v) => (d.write(d.v(v), d.v(v + 1)), 0)],
            // 0x8B: note and length
            [2, (d, c, v) => (d.setupNote(d.v(v), c), d.setupDuration(d.v(v + 1), c), d.v(v + 1) !== 0 ? 1 : 0)],
            // 0x8C: base note
            [1, (d, c, v) => ((c.baseNote = s8(d.v(v))), 0)],
            // 0x8D: secondary effect
            [
                5,
                (d, c, v) => {
                    c.secondaryEffectTimer = c.secondaryEffectTempo = d.v(v);
                    c.secondaryEffectSize = c.secondaryEffectPos = s8(d.v(v + 1));
                    c.secondaryEffectRegbase = d.v(v + 2);
                    c.secondaryEffectData = (d.word(v + 3) - 191) & 0xffff;
                    c.secondaryEffect = 'secondary';
                    const start = c.secondaryEffectData + c.secondaryEffectSize;
                    if (start < 0 || start >= d.end - d.base) c.secondaryEffect = null;
                    return 0;
                },
            ],
            // 0x8E: stop another voice
            [
                1,
                (d, _c, v) => {
                    if (d.v(v) > 9) return 0;
                    const other = d.channels[d.v(v)];
                    const keep = _c.dataptr;
                    other.duration = 0;
                    other.priority = 0;
                    other.dataptr = -1;
                    _c.dataptr = keep;
                    return 0;
                },
            ],
            // 0x8F: wait for a program to end
            [
                1,
                (d, c, v) => {
                    const ptr = d.getProgram(d.v(v));
                    if (ptr < 0) return 0;
                    const chan = d.mem[ptr];
                    if (chan > 9 || d.channels[chan].dataptr < 0) return 0;
                    if (d.channels[chan].repeating) c.repeating = true;
                    c.dataptr -= 2;
                    return 2;
                },
            ],
            // 0x90: instrument
            [1, (d, c, v) => (d.setupInstrument(d.curRegOffset, d.getInstrument(d.v(v)), c), 0)],
            // 0x91: slide
            [3, (d, c, v) => ((c.slideTempo = d.v(v)), (c.slideStep = s16((d.v(v + 1) << 8) | d.v(v + 2))), (c.primaryEffect = 'slide'), (c.slideTimer = 0xff), 0)],
            // 0x92: end the slide
            [0, (_d, c) => ((c.primaryEffect = null), (c.slideStep = 0), 0)],
            // 0x93: base frequency
            [1, (d, c, v) => ((c.baseFreq = d.v(v)), 0)],
            stop,
            // 0x95: vibrato
            [
                4,
                (d, c, v) => {
                    c.vibratoTempo = d.v(v);
                    c.vibratoStepRange = d.v(v + 1);
                    c.vibratoStepsCountdown = u8(d.v(v + 2) + 1);
                    c.vibratoNumSteps = u8(d.v(v + 2) << 1);
                    c.vibratoDelay = d.v(v + 3);
                    c.primaryEffect = 'vibrato';
                    return 0;
                },
            ],
            stop,
            stop,
            stop,
            stop,
            // 0x9A: priority
            [1, (d, c, v) => ((c.priority = d.v(v)), 0)],
            stop,
            // 0x9C: beat
            [1, (d, _c, v) => ((d.beatDivider = d.beatDivCnt = d.v(v) >> 1), (d.callbackTimer = 0xff), (d.beatCounter = d.beatWaiting = 0), 0)],
            // 0x9D: wait for the next beat
            [
                1,
                (d, c, v) => {
                    if (d.beatCounter & d.v(v) && d.beatWaiting) {
                        d.beatWaiting = 0;
                        return 0;
                    }
                    if (!(d.beatCounter & d.v(v))) d.beatWaiting = u8(d.beatWaiting + 1);
                    c.dataptr -= 2;
                    c.duration = 1;
                    return 2;
                },
            ],
            // 0x9E: level 1
            [1, (d, c, v) => ((c.opExtraLevel1 = d.v(v)), d.adjustVolume(c), 0)],
            stop,
            // 0xA0: length
            [1, (d, c, v) => (d.setupDuration(d.v(v), c), d.v(v) !== 0 ? 1 : 0)],
            // 0xA1: play the note
            [1, (d, c, v) => (d.setupDuration(d.v(v), c), d.noteOn(c), d.v(v) !== 0 ? 1 : 0)],
            stop,
            stop,
            // 0xA4: fractional note spacing
            [1, (d, c, v) => ((c.fractionalSpacing = d.v(v) & 7), 0)],
            stop,
            // 0xA6: tempo
            [1, (d, _c, v) => ((d.tempo = d.v(v)), 0)],
            // 0xA7: end the secondary effect
            [0, (_d, c) => ((c.secondaryEffect = null), 0)],
            stop,
            // 0xA9: voice tempo
            [1, (d, c, v) => ((c.tempo = d.v(v)), 0)],
            stop,
            // 0xAB: level 3
            [1, (d, c, v) => ((c.opExtraLevel3 = d.v(v)), 0)],
            // 0xAC: level 2 of a voice
            [2, (d, _c, v) => d.otherLevel2(d.v(v), () => d.v(v + 1))],
            // 0xAD: change level 2 of a voice
            [2, (d, _c, v) => d.otherLevel2(d.v(v), (old) => u8(old + d.v(v + 1)))],
            // 0xAE: tremolo depth
            [1, (d, _c, v) => ((d.vibratoAndAMDepthBits = d.v(v) & 1 ? d.vibratoAndAMDepthBits | 0x80 : d.vibratoAndAMDepthBits & 0x7f), d.write(0xbd, d.vibratoAndAMDepthBits), 0)],
            // 0xAF: vibrato depth
            [1, (d, _c, v) => ((d.vibratoAndAMDepthBits = d.v(v) & 1 ? d.vibratoAndAMDepthBits | 0x40 : d.vibratoAndAMDepthBits & 0xbf), d.write(0xbd, d.vibratoAndAMDepthBits), 0)],
            // 0xB0: change level 1
            [1, (d, c, v) => ((c.opExtraLevel1 = u8(c.opExtraLevel1 + d.v(v))), d.adjustVolume(c), 0)],
            stop,
            stop,
            // 0xB3: clear a voice
            [1, (d, c, v) => d.clearChannel(c, d.v(v))],
            stop,
            // 0xB5: change the note at random
            [
                2,
                (d, c, v) => {
                    if (d.curChannel >= 9) return 0;
                    const mask = (d.v(v) << 8) | d.v(v + 1);
                    let note = (((c.regBx & 0x1f) << 8) | c.regAx) & 0xffff;
                    note = (note + (mask & d.getRandomNr())) & 0xffff;
                    note |= (c.regBx & 0x20) << 8;
                    d.write(0xa0 + d.curChannel, note & 0xff);
                    d.write(0xb0 + d.curChannel, (note & 0xff00) >> 8);
                    return 0;
                },
            ],
            // 0xB6: end the vibrato
            [0, (_d, c) => ((c.primaryEffect = null), 0)],
            stop,
            stop,
            // 0xB9: pitch bend
            [1, (d, c, v) => ((c.pitchBend = s8(d.v(v))), d.setupNote(c.rawNote, c, true), 0)],
            // 0xBA: back to the overall tempo
            [0, (d, c) => ((c.tempo = d.tempo), 0)],
            // 0xBB: nothing
            nop,
            // 0xBC: randomness of lengths
            [1, (d, c, v) => ((c.durationRandomness = d.v(v)), 0)],
            // 0xBD: change the voice tempo
            [1, (d, c, v) => ((c.tempo = clip(c.tempo + s8(d.v(v)), 1, 255)), 0)],
            stop,
            // 0xBF: updateCallback46
            [
                2,
                (d, _c, v) => {
                    const entry = d.v(v + 1);
                    if (entry + 2 > TABLE2_FIRST.length) return 0;
                    if (d.v(v) === 2) d.write(0xa0, TABLE2_FIRST[entry + 1]);
                    return 0;
                },
            ],
            // 0xC0: nothing
            nop,
            // 0xC1: set up the drums
            [9, (d, c, v) => d.setupRhythmSection(c, v)],
            // 0xC2: play the drums
            [
                1,
                (d, _c, v) => {
                    d.write(0xbd, ((d.rhythmSectionBits & ~(d.v(v) & 0x1f)) | 0x20) & 0xff);
                    d.rhythmSectionBits |= d.v(v);
                    d.write(0xbd, (d.vibratoAndAMDepthBits | 0x20 | d.rhythmSectionBits) & 0xff);
                    return 0;
                },
            ],
            // 0xC3: end the drums
            [0, (d) => ((d.rhythmSectionBits = 0), d.write(0xbd, d.vibratoAndAMDepthBits), 0)],
            // 0xC4: drum level 2
            [2, (d, _c, v) => d.rhythmLevels(d.v(v), d.v(v + 1), 'set2')],
            // 0xC5: change drum level 1
            [2, (d, _c, v) => d.rhythmLevels(d.v(v), d.v(v + 1), 'change1')],
            // 0xC6: drum level 1
            [2, (d, _c, v) => d.rhythmLevels(d.v(v), d.v(v + 1), 'set1')],
            // 0xC7: signal the game
            [1, (d, _c, v) => ((d.soundTrigger = d.v(v)), 0)],
            // 0xC8: tempo reset
            [1, (d, c, v) => ((c.tempoReset = d.v(v)), 0)],
            // 0xC9: updateCallback56 (its values are kept, and never used)
            [2, () => 0],
            stop,
        ];
    };

    private setupProgram(channel: Channel, program: number) {
        if (program === 0xff) return 0;
        let ptr = this.getProgram(program);
        if (this.check(ptr, 2) < 0) return 0;
        const chan = this.mem[ptr++];
        const priority = this.mem[ptr++];
        if (chan > 9) return 0;
        const channel2 = this.channels[chan];
        if (priority >= channel2.priority) {
            const keep = channel.dataptr;
            this.programStartTimeout = 2;
            this.initChannel(channel2);
            channel2.priority = priority;
            channel2.dataptr = ptr;
            channel2.tempo = 0xff;
            channel2.timer = 0xff;
            channel2.duration = 1;
            channel2.volumeModifier = chan <= 5 ? this.musicVolume : this.sfxVolume;
            this.initAdlibChannel(chan);
            channel.dataptr = keep;
        }
        return 0;
    }

    private otherLevel2(chan: number, value: (old: number) => number) {
        if (chan > 9) return 0;
        const keep = this.curChannel;
        this.curChannel = chan;
        const channel2 = this.channels[chan];
        channel2.opExtraLevel2 = value(channel2.opExtraLevel2);
        this.adjustVolume(channel2);
        this.curChannel = keep;
        return 0;
    }

    private clearChannel(channel: Channel, chan: number) {
        if (chan > 9) return 0;
        const keepChannel = this.curChannel;
        this.curChannel = chan;
        const keep = channel.dataptr;
        const channel2 = this.channels[chan];
        channel2.duration = channel2.priority = 0;
        channel2.dataptr = -1;
        channel2.opExtraLevel2 = 0;
        if (chan !== 9) {
            const regOff = REG_OFFSET[chan];
            this.write(0xc0 + chan, 0x00);
            this.write(0x43 + regOff, 0x3f);
            this.write(0x83 + regOff, 0xff);
            this.write(0xb0 + chan, 0x00);
        }
        this.curChannel = keepChannel;
        channel.dataptr = keep;
        return 0;
    }

    private setupRhythmSection(channel: Channel, v: number) {
        const keepChannel = this.curChannel;
        const keepOffset = this.curRegOffset;
        const set = (chan: number, instrument: number) => {
            this.curChannel = chan;
            this.curRegOffset = REG_OFFSET[chan];
            this.setupInstrument(this.curRegOffset, this.getInstrument(instrument), channel);
        };
        set(6, this.v(v));
        this.opLevelBD = channel.opLevel2;
        set(7, this.v(v + 1));
        this.opLevelHH = channel.opLevel1;
        this.opLevelSD = channel.opLevel2;
        set(8, this.v(v + 2));
        this.opLevelTT = channel.opLevel1;
        this.opLevelCY = channel.opLevel2;
        for (const [chan, i] of [
            [6, 3],
            [7, 5],
            [8, 7],
        ]) {
            this.channels[chan].regBx = this.v(v + i) & 0x2f;
            this.write(0xb0 + chan, this.channels[chan].regBx);
            this.write(0xa0 + chan, this.v(v + i + 1));
        }
        this.rhythmSectionBits = 0x20;
        this.curRegOffset = keepOffset;
        this.curChannel = keepChannel;
        return 0;
    }

    /** The drums' levels: each drum's register, its level, and which of the drums the first value picks. */
    private rhythmLevels(ops: number, v: number, how: 'set1' | 'set2' | 'change1') {
        const drums: [bit: number, name: 'HH' | 'CY' | 'TT' | 'SD' | 'BD', reg: number, level: number][] = [
            [1, 'HH', 0x51, this.opLevelHH],
            [2, 'CY', 0x55, this.opLevelCY],
            [4, 'TT', 0x52, this.opLevelTT],
            [8, 'SD', 0x54, this.opLevelSD],
            [16, 'BD', 0x53, this.opLevelBD],
        ];
        // Added as whole numbers, then kept to 0 to 63.
        const checkValue = (x: number) => clip(s16(x), 0, 0x3f);
        for (const [bit, name, reg, level] of drums) {
            if (!(ops & bit)) continue;
            if (how === 'set2') {
                this.extra2[name] = v;
                this.write(reg, checkValue(v + level + this.extra1[name] + this.extra2[name]));
            } else if (how === 'change1') {
                this.extra1[name] = checkValue(v + level + this.extra1[name] + this.extra2[name]);
                this.write(reg, this.extra1[name]);
            } else {
                this.extra1[name] = v;
                this.write(reg, checkValue(v + level + this.extra2[name]));
            }
        }
        return 0;
    }
}

const COMMANDS = AdlDriver.commands();
