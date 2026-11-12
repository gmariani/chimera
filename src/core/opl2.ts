/**
 * The Yamaha YM3812 (OPL2), the FM chip of the AdLib and Sound Blaster cards:
 * nine voices of two operators each, or six and five drums. Games write its
 * registers; this turns those writes into sound.
 *
 * A port of DOSBox's DBOPL (dbopl.cpp, by the DOSBox Team, GPL-2.0-or-later;
 * as kept in ScummVM's audio/softsynth/opl), its OPL2 half only: the OPL3's
 * stereo and four-operator modes are left out. It keeps DBOPL's arithmetic,
 * 32-bit counters that wrap included, so the same writes give the same
 * samples. https://www.dosbox.com, https://github.com/scummvm/scummvm
 */

/** The chip's own rate: its 14.31818 MHz clock over 288. */
export const OPL_RATE = 14318180 / 288;

const WAVE_SH = 22;
const WAVE_MASK = (1 << WAVE_SH) - 1;
const LFO_SH = WAVE_SH - 10;
const LFO_MAX = 256 << LFO_SH;
const ENV_MAX = 511;
/** Envelopes at or past this are silent. */
const ENV_LIMIT = (12 * 256) >> 3;
const RATE_SH = 24;
const RATE_MASK = (1 << RATE_SH) - 1;
const MUL_SH = 16;
const TREMOLO_TABLE = 52;
const SHIFT_KSLBASE = 16;
const SHIFT_KEYCODE = 24;
const MASK_KSR = 0x10;
const MASK_SUSTAIN = 0x20;
const MASK_VIBRATO = 0x40;

const OFF = 0;
const RELEASE = 1;
const SUSTAIN = 2;
const DECAY = 3;
const ATTACK = 4;

const KSL_CREATE = [64, 32, 24, 19, 16, 12, 11, 10, 8, 6, 5, 4, 3, 2, 1, 0];
/** Each frequency multiplier, doubled. */
const FREQ_CREATE = [1, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 20, 24, 24, 30, 30];
const ATTACK_SAMPLES = [69, 55, 46, 40, 35, 29, 23, 20, 19, 15, 11, 10, 9];
const ENVELOPE_INCREASE = [4, 5, 6, 7, 8, 10, 12, 14, 16, 20, 24, 28, 32];
/** Each waveform's place in the wave table, its counter mask, and where its counter starts at key-on. */
const WAVE_BASE = [0x000, 0x200, 0x200, 0x800, 0xa00, 0xc00, 0x100, 0x400];
const WAVE_MASK_TABLE = [1023, 1023, 511, 511, 1023, 1023, 512, 1023];
const WAVE_START = [512, 0, 0, 0, 0, 512, 512, 256];
/** Low bits: the vibrato's shift; high bit: its sign (as signed bytes). */
const VIBRATO = [1, 0, 1, 30, 1 - 0x80, 0 - 0x80, 1 - 0x80, 30 - 0x80];
const KSL_SHIFT = [31, 1, 2, 0];

// The tables DBOPL builds once (its WAVE_TABLEMUL mode).
const MUL_TABLE = new Uint16Array(384);
const WAVE_TABLE = new Int16Array(8 * 512);
const KSL_TABLE = new Uint8Array(8 * 16);
const TREMOLO = new Uint8Array(TREMOLO_TABLE);
(() => {
    for (let i = 0; i < 384; i++) MUL_TABLE[i] = Math.trunc(0.5 + 2 ** (-1 + (255 - i * 8) / 256) * (1 << MUL_SH));
    for (let i = 0; i < 512; i++) {
        WAVE_TABLE[0x200 + i] = Math.trunc(Math.sin((i + 0.5) * (Math.PI / 512)) * 4084);
        WAVE_TABLE[i] = -WAVE_TABLE[0x200 + i];
    }
    for (let i = 0; i < 256; i++) {
        WAVE_TABLE[0x700 + i] = Math.trunc(0.5 + 2 ** (-1 + (255 - i * 8) / 256) * 4085);
        WAVE_TABLE[0x6ff - i] = -WAVE_TABLE[0x700 + i];
    }
    for (let i = 0; i < 256; i++) {
        for (const at of [0x400, 0x500, 0x900, 0xc00, 0xd00]) WAVE_TABLE[at + i] = WAVE_TABLE[0];
        WAVE_TABLE[0x800 + i] = WAVE_TABLE[0x200 + i];
        WAVE_TABLE[0xa00 + i] = WAVE_TABLE[0x200 + i * 2];
        WAVE_TABLE[0xb00 + i] = WAVE_TABLE[i * 2];
        WAVE_TABLE[0xe00 + i] = WAVE_TABLE[0x200 + i * 2];
        WAVE_TABLE[0xf00 + i] = WAVE_TABLE[0x200 + i * 2];
    }
    for (let oct = 0; oct < 8; oct++) for (let i = 0; i < 16; i++) KSL_TABLE[oct * 16 + i] = Math.max(0, oct * 8 - KSL_CREATE[i]) * 4;
    for (let i = 0; i < TREMOLO_TABLE / 2; i++) TREMOLO[i] = TREMOLO[TREMOLO_TABLE - 1 - i] = i;
})();

/** An attack, decay or release rate (0 to 75): which step of the increase table, and how far it's shifted down. */
function envelopeSelect(val: number): [index: number, shift: number] {
    if (val < 13 * 4) return [val & 3, 12 - (val >> 2)];
    if (val < 15 * 4) return [val - 12 * 4, 0];
    return [12, 0];
}

class Operator {
    waveBase = 0;
    waveMask = 0;
    waveStart = 0;
    waveIndex = 0;
    waveAdd = 0;
    waveCurrent = 0;
    chanData = 0;
    freqMul = 0;
    vibrato = 0;
    sustainLevel = ENV_MAX;
    totalLevel = ENV_MAX;
    currentLevel = ENV_MAX;
    volume = ENV_MAX;
    attackAdd = 0;
    decayAdd = 0;
    releaseAdd = 0;
    rateIndex = 0;
    rateZero = 1 << OFF;
    keyOn = 0;
    reg20 = 0;
    reg40 = 0;
    reg60 = 0;
    reg80 = 0;
    regE0 = 0;
    state = OFF;
    tremoloMask = 0;
    vibStrength = 0;
    ksr = 0;

    constructor(private readonly chip: Opl2) {}

    updateAttack() {
        const rate = this.reg60 >> 4;
        if (rate) {
            this.attackAdd = this.chip.attackRates[(rate << 2) + this.ksr];
            this.rateZero &= ~(1 << ATTACK);
        } else {
            this.attackAdd = 0;
            this.rateZero |= 1 << ATTACK;
        }
    }
    updateDecay() {
        const rate = this.reg60 & 0xf;
        if (rate) {
            this.decayAdd = this.chip.linearRates[(rate << 2) + this.ksr];
            this.rateZero &= ~(1 << DECAY);
        } else {
            this.decayAdd = 0;
            this.rateZero |= 1 << DECAY;
        }
    }
    updateRelease() {
        const rate = this.reg80 & 0xf;
        if (rate) {
            this.releaseAdd = this.chip.linearRates[(rate << 2) + this.ksr];
            this.rateZero &= ~(1 << RELEASE);
            if (!(this.reg20 & MASK_SUSTAIN)) this.rateZero &= ~(1 << SUSTAIN);
        } else {
            this.rateZero |= 1 << RELEASE;
            this.releaseAdd = 0;
            if (!(this.reg20 & MASK_SUSTAIN)) this.rateZero |= 1 << SUSTAIN;
        }
    }
    updateAttenuation() {
        const kslBase = (this.chanData >>> SHIFT_KSLBASE) & 0xff;
        this.totalLevel = (this.reg40 & 0x3f) << 2;
        this.totalLevel += kslBase >>> KSL_SHIFT[this.reg40 >> 6];
    }
    updateFrequency() {
        const freq = this.chanData & 1023;
        const block = (this.chanData >>> 10) & 0xff;
        this.waveAdd = Math.imul(freq << block, this.freqMul) >>> 0;
        if (this.reg20 & MASK_VIBRATO) {
            this.vibStrength = freq >> 7;
            this.vibrato = Math.imul(this.vibStrength << block, this.freqMul) >>> 0;
        } else {
            this.vibStrength = 0;
            this.vibrato = 0;
        }
    }
    updateRates() {
        let ksr = (this.chanData >>> SHIFT_KEYCODE) & 0xff;
        if (!(this.reg20 & MASK_KSR)) ksr >>= 2;
        if (this.ksr === ksr) return;
        this.ksr = ksr;
        this.updateAttack();
        this.updateDecay();
        this.updateRelease();
    }
    rateForward(add: number) {
        this.rateIndex += add;
        const ret = this.rateIndex >>> RATE_SH;
        this.rateIndex &= RATE_MASK;
        return ret;
    }
    /** The envelope's next level, as its state moves it. */
    envelope(): number {
        let vol = this.volume;
        switch (this.state) {
            case OFF:
                return ENV_MAX;
            case ATTACK: {
                const change = this.rateForward(this.attackAdd);
                if (!change) return vol;
                vol += (~vol * change) >> 3;
                if (vol < 0) {
                    this.volume = 0;
                    this.rateIndex = 0;
                    this.state = DECAY;
                    return 0;
                }
                break;
            }
            case DECAY:
                vol += this.rateForward(this.decayAdd);
                if (vol >= this.sustainLevel) {
                    if (vol >= ENV_MAX) {
                        this.volume = ENV_MAX;
                        this.state = OFF;
                        return ENV_MAX;
                    }
                    this.rateIndex = 0;
                    this.state = SUSTAIN;
                }
                break;
            case SUSTAIN:
            case RELEASE:
                // In sustain, it holds while sustaining is on; otherwise it releases as it would after key-off.
                if (this.state === SUSTAIN && this.reg20 & MASK_SUSTAIN) return vol;
                vol += this.rateForward(this.releaseAdd);
                if (vol >= ENV_MAX) {
                    this.volume = ENV_MAX;
                    this.state = OFF;
                    return ENV_MAX;
                }
                break;
        }
        this.volume = vol;
        return vol;
    }
    forwardVolume() {
        return this.currentLevel + this.envelope();
    }
    forwardWave() {
        this.waveIndex = (this.waveIndex + this.waveCurrent) >>> 0;
        return this.waveIndex >>> WAVE_SH;
    }
    write20(val: number) {
        const change = this.reg20 ^ val;
        if (!change) return;
        this.reg20 = val;
        this.tremoloMask = val & 0x80 ? 0xff : 0;
        if (change & MASK_KSR) this.updateRates();
        if (this.reg20 & MASK_SUSTAIN || !this.releaseAdd) this.rateZero |= 1 << SUSTAIN;
        else this.rateZero &= ~(1 << SUSTAIN);
        if (change & (0xf | MASK_VIBRATO)) {
            this.freqMul = this.chip.freqMul[val & 0xf];
            this.updateFrequency();
        }
    }
    write40(val: number) {
        if (!(this.reg40 ^ val)) return;
        this.reg40 = val;
        this.updateAttenuation();
    }
    write60(val: number) {
        const change = this.reg60 ^ val;
        this.reg60 = val;
        if (change & 0x0f) this.updateDecay();
        if (change & 0xf0) this.updateAttack();
    }
    write80(val: number) {
        const change = this.reg80 ^ val;
        if (!change) return;
        this.reg80 = val;
        let sustain = val >> 4;
        // 0xF means the quietest, 0x1F.
        sustain |= (sustain + 1) & 0x10;
        this.sustainLevel = sustain << 4;
        if (change & 0x0f) this.updateRelease();
    }
    writeE0(val: number) {
        if (!(this.regE0 ^ val)) return;
        // Waveforms other than the sine need register 1's bit 5.
        const waveForm = val & (3 & this.chip.waveFormMask);
        this.regE0 = val;
        this.waveBase = WAVE_BASE[waveForm];
        this.waveStart = (WAVE_START[waveForm] << WAVE_SH) >>> 0;
        this.waveMask = WAVE_MASK_TABLE[waveForm];
    }
    silent() {
        return this.totalLevel + this.volume >= ENV_LIMIT && (this.rateZero & (1 << this.state)) !== 0;
    }
    prepare() {
        const chip = this.chip;
        this.currentLevel = this.totalLevel + (chip.tremoloValue & this.tremoloMask);
        this.waveCurrent = this.waveAdd;
        if (this.vibStrength >> chip.vibratoShift) {
            const neg = chip.vibratoSign;
            const add = ((this.vibrato >>> chip.vibratoShift) ^ neg) - neg;
            this.waveCurrent = (this.waveCurrent + add) >>> 0;
        }
    }
    on(mask: number) {
        if (!this.keyOn) {
            this.waveIndex = this.waveStart;
            this.rateIndex = 0;
            this.state = ATTACK;
        }
        this.keyOn |= mask;
    }
    off(mask: number) {
        this.keyOn &= ~mask;
        if (!this.keyOn && this.state !== OFF) this.state = RELEASE;
    }
    wave(index: number, vol: number) {
        return (WAVE_TABLE[this.waveBase + (index & this.waveMask)] * MUL_TABLE[vol]) >> MUL_SH;
    }
    sample(modulation: number) {
        const vol = this.forwardVolume();
        if (vol >= ENV_LIMIT) {
            this.waveIndex = (this.waveIndex + this.waveCurrent) >>> 0;
            return 0;
        }
        return this.wave(this.forwardWave() + modulation, vol);
    }
}

const FM = 0;
const AM = 1;
const PERCUSSION = 2;

class Channel {
    readonly op: [Operator, Operator];
    mode = FM;
    chanData = 0;
    old0 = 0;
    old1 = 0;
    feedback = 31;
    regB0 = 0;
    regC0 = 0;

    constructor(
        private readonly chip: Opl2,
        /** Channels 6 to 8 make the drums in rhythm mode. */
        readonly drums: boolean
    ) {
        this.op = [new Operator(chip), new Operator(chip)];
    }

    setChanData(data: number) {
        const change = (this.chanData ^ data) >>> 0;
        this.chanData = data;
        for (const op of this.op) {
            op.chanData = data;
            op.updateFrequency();
        }
        if (change & (0xff << SHIFT_KSLBASE)) for (const op of this.op) op.updateAttenuation();
        if (change & (0xff << SHIFT_KEYCODE)) for (const op of this.op) op.updateRates();
    }
    updateFrequency() {
        let data = this.chanData & 0xffff;
        const kslBase = KSL_TABLE[data >> 6];
        let keyCode = (data & 0x1c00) >> 9;
        keyCode |= this.chip.reg08 & 0x40 ? (data & 0x100) >> 8 : (data & 0x200) >> 9;
        data = (data | (keyCode << SHIFT_KEYCODE) | (kslBase << SHIFT_KSLBASE)) >>> 0;
        this.setChanData(data);
    }
    writeA0(val: number) {
        const change = (this.chanData ^ val) & 0xff;
        if (change) {
            this.chanData = (this.chanData ^ change) >>> 0;
            this.updateFrequency();
        }
    }
    writeB0(val: number) {
        const change = (this.chanData ^ (val << 8)) & 0x1f00;
        if (change) {
            this.chanData = (this.chanData ^ change) >>> 0;
            this.updateFrequency();
        }
        if (!((val ^ this.regB0) & 0x20)) return;
        this.regB0 = val;
        if (val & 0x20) for (const op of this.op) op.on(1);
        else for (const op of this.op) op.off(1);
    }
    writeC0(val: number) {
        if (!(val ^ this.regC0)) return;
        this.regC0 = val;
        const feedback = (val >> 1) & 7;
        this.feedback = feedback ? 9 - feedback : 31;
        // In rhythm mode the drum channels keep their way of playing.
        if (this.drums && this.chip.regBD & 0x20) return;
        this.mode = val & 1 ? AM : FM;
    }
    resetC0() {
        const val = this.regC0;
        this.regC0 ^= 0xff;
        this.writeC0(val);
    }
}

export class Opl2 {
    lfoCounter = 0;
    lfoAdd = 0;
    noiseCounter = 0;
    noiseAdd = 0;
    noiseValue = 1;
    readonly freqMul = new Uint32Array(16);
    readonly linearRates = new Uint32Array(76);
    readonly attackRates = new Uint32Array(76);
    readonly chan: Channel[];
    reg08 = 0;
    regBD = 0;
    vibratoIndex = 0;
    tremoloIndex = 0;
    vibratoSign = 0;
    vibratoShift = 0;
    tremoloValue = 0;
    vibratoStrength = 0;
    tremoloStrength = 0;
    waveFormMask = 0;
    /** Operators by register offset (0x00 to 0x15; gaps where there are none). */
    private readonly ops: (Operator | null)[] = [];

    /** A chip whose samples come out at `rate` a second. */
    constructor(readonly rate: number) {
        this.chan = Array.from({ length: 9 }, (_, i) => new Channel(this, i >= 6));
        for (let i = 0; i < 0x20; i++) {
            const slot = i % 8;
            this.ops[i] = i < 0x16 && slot < 6 ? this.chan[Math.floor(i / 8) * 3 + (slot % 3)].op[slot < 3 ? 0 : 1] : null;
        }
        const scale = OPL_RATE / rate;
        this.noiseAdd = Math.trunc(0.5 + scale * (1 << LFO_SH));
        this.lfoAdd = Math.trunc(0.5 + scale * (1 << LFO_SH));
        const freqScale = Math.trunc(0.5 + scale * (1 << (WAVE_SH - 1 - 10)));
        for (let i = 0; i < 16; i++) this.freqMul[i] = freqScale * FREQ_CREATE[i];
        for (let i = 0; i < 76; i++) {
            const [index, shift] = envelopeSelect(i);
            this.linearRates[i] = Math.trunc(scale * (ENVELOPE_INCREASE[index] << (RATE_SH - shift - 3)));
        }
        // The attack rate that best matches how many samples the real chip's attack takes.
        for (let i = 0; i < 62; i++) {
            const [index, shift] = envelopeSelect(i);
            const original = Math.trunc((ATTACK_SAMPLES[index] << shift) / scale);
            let guessAdd = Math.trunc(scale * (ENVELOPE_INCREASE[index] << (RATE_SH - shift - 3)));
            let bestAdd = guessAdd;
            let bestDiff = 1 << 30;
            for (let passes = 0; passes < 16; passes++) {
                let volume = ENV_MAX;
                let samples = 0;
                let count = 0;
                while (volume > 0 && samples < original * 2) {
                    count = (count + guessAdd) >>> 0;
                    const change = count >>> RATE_SH;
                    count &= RATE_MASK;
                    if (change) volume += (~volume * change) >> 3;
                    samples++;
                }
                const diff = original - samples;
                const lDiff = Math.abs(diff);
                if (lDiff < bestDiff) {
                    bestDiff = lDiff;
                    bestAdd = guessAdd;
                    if (!bestDiff) break;
                }
                if (diff !== 0) {
                    const mul = Math.trunc(((original - diff) << 12) / original);
                    guessAdd = (Math.imul(guessAdd, mul) >> 12) + (diff < 0 ? 1 : -1);
                }
            }
            this.attackRates[i] = bestAdd;
        }
        for (let i = 62; i < 76; i++) this.attackRates[i] = 8 << RATE_SH;
        // Every register written, as DBOPL's set-up does: all bits on, then off. It does so twice, as an OPL3 and then as an
        // OPL2, and the first pass leaves its mark: by the second's key-ons, the waveforms are set, so each operator starts
        // its wave where a sine starts (halfway round its table), not at 0.
        for (let pass = 0; pass < 2; pass++)
            for (let i = 0; i < 255; i++) {
                this.write(i, 0xff);
                this.write(i, 0);
            }
    }

    /** Writes a value to a register. */
    write(reg: number, val: number) {
        reg &= 0xff;
        val &= 0xff;
        switch (reg >> 4) {
            case 0x0:
                if (reg === 0x01) this.waveFormMask = val & 0x20 ? 7 : 0;
                else if (reg === 0x08) this.reg08 = val;
                return;
            case 0x2:
            case 0x3:
                return this.ops[reg & 0x1f]?.write20(val);
            case 0x4:
            case 0x5:
                return this.ops[reg & 0x1f]?.write40(val);
            case 0x6:
            case 0x7:
                return this.ops[reg & 0x1f]?.write60(val);
            case 0x8:
            case 0x9:
                return this.ops[reg & 0x1f]?.write80(val);
            case 0xa:
                if ((reg & 0xf) < 9) this.chan[reg & 0xf].writeA0(val);
                return;
            case 0xb:
                if (reg === 0xbd) this.writeBD(val);
                else if ((reg & 0xf) < 9) this.chan[reg & 0xf].writeB0(val);
                return;
            case 0xc:
                if ((reg & 0xf) < 9) this.chan[reg & 0xf].writeC0(val);
                return;
            case 0xe:
            case 0xf:
                return this.ops[reg & 0x1f]?.writeE0(val);
        }
    }

    private writeBD(val: number) {
        const change = this.regBD ^ val;
        if (!change) return;
        this.regBD = val;
        this.vibratoStrength = val & 0x40 ? 0 : 1;
        this.tremoloStrength = val & 0x80 ? 0 : 2;
        const [c6, c7, c8] = [this.chan[6], this.chan[7], this.chan[8]];
        if (val & 0x20) {
            if (change & 0x20) c6.mode = PERCUSSION;
            const key = (op: Operator, on: number) => (on ? op.on(2) : op.off(2));
            key(c6.op[0], val & 0x10);
            key(c6.op[1], val & 0x10);
            key(c7.op[0], val & 0x01);
            key(c7.op[1], val & 0x08);
            key(c8.op[0], val & 0x04);
            key(c8.op[1], val & 0x02);
        } else if (change & 0x20) {
            c6.resetC0();
            for (const c of [c6, c7, c8]) for (const op of c.op) op.off(2);
        }
    }

    private forwardNoise() {
        this.noiseCounter = (this.noiseCounter + this.noiseAdd) >>> 0;
        let count = this.noiseCounter >>> LFO_SH;
        // As DBOPL has it: the counter is kept to the wave's bits, not the LFO's.
        this.noiseCounter &= WAVE_MASK;
        for (; count > 0; count--) {
            this.noiseValue ^= 0x800302 & -(this.noiseValue & 1);
            this.noiseValue >>>= 1;
        }
        return this.noiseValue;
    }

    private forwardLFO(samples: number) {
        const v = VIBRATO[this.vibratoIndex >> 2];
        this.vibratoSign = v >> 7;
        this.vibratoShift = (v & 7) + this.vibratoStrength;
        this.tremoloValue = TREMOLO[this.tremoloIndex] >> this.tremoloStrength;
        const todo = LFO_MAX - this.lfoCounter;
        let count = Math.trunc((todo + this.lfoAdd - 1) / this.lfoAdd);
        if (count > samples) {
            count = samples;
            this.lfoCounter += count * this.lfoAdd;
        } else {
            this.lfoCounter = (this.lfoCounter + count * this.lfoAdd) & (LFO_MAX - 1);
            this.vibratoIndex = (this.vibratoIndex + 1) & 31;
            this.tremoloIndex = this.tremoloIndex + 1 < TREMOLO_TABLE ? this.tremoloIndex + 1 : 0;
        }
        return count;
    }

    /** The drums, from channels 6 to 8: bass drum, hi-hat, snare, tom-tom and cymbal. */
    private percussion(c6: Channel, out: Int32Array, at: number) {
        const [c7, c8] = [this.chan[7], this.chan[8]];
        let mod = ((c6.old0 + c6.old1) >>> c6.feedback) | 0;
        c6.old0 = c6.old1;
        c6.old1 = c6.op[0].sample(mod);
        mod = c6.regC0 & 1 ? 0 : c6.old0;
        let sample = c6.op[1].sample(mod);
        const noiseBit = this.forwardNoise() & 1;
        const c2 = c7.op[0].forwardWave();
        const c5 = c8.op[1].forwardWave();
        const phaseBit = (c2 & 0x88) ^ ((c2 << 5) & 0x80) || (c5 ^ (c5 << 2)) & 0x20 ? 0x02 : 0x00;
        const hhVol = c7.op[0].forwardVolume();
        if (hhVol < ENV_LIMIT) sample += c7.op[0].wave((phaseBit << 8) | (0x34 << (phaseBit ^ (noiseBit << 1))), hhVol);
        const sdVol = c7.op[1].forwardVolume();
        if (sdVol < ENV_LIMIT) sample += c7.op[1].wave((0x100 + (c2 & 0x100)) ^ (noiseBit << 8), sdVol);
        sample += c8.op[0].sample(0);
        const tcVol = c8.op[1].forwardVolume();
        if (tcVol < ENV_LIMIT) sample += c8.op[1].wave((1 + phaseBit) << 8, tcVol);
        out[at] += sample << 1;
    }

    /** One channel's samples, added to `out`; the next channel to play (the drums take three). */
    private block(index: number, samples: number, out: Int32Array, at: number): number {
        const ch = this.chan[index];
        const [op0, op1] = ch.op;
        if (ch.mode === AM ? op0.silent() && op1.silent() : ch.mode === FM && op1.silent()) {
            ch.old0 = ch.old1 = 0;
            return index + 1;
        }
        op0.prepare();
        op1.prepare();
        if (ch.mode === PERCUSSION) {
            for (const c of [this.chan[7], this.chan[8]]) for (const op of c.op) op.prepare();
            for (let i = 0; i < samples; i++) this.percussion(ch, out, at + i);
            return index + 3;
        }
        for (let i = 0; i < samples; i++) {
            const mod = ((ch.old0 + ch.old1) >>> ch.feedback) | 0;
            ch.old0 = ch.old1;
            ch.old1 = op0.sample(mod);
            out[at + i] += ch.mode === AM ? ch.old0 + op1.sample(0) : op1.sample(ch.old0);
        }
        return index + 1;
    }

    /** Fills `out` with the chip's next samples (as DBOPL gives them, before any clipping). */
    generate(out: Int32Array, from = 0, count = out.length - from) {
        let at = from;
        let total = count;
        while (total > 0) {
            const samples = this.forwardLFO(total);
            out.fill(0, at, at + samples);
            for (let c = 0; c < 9;) c = this.block(c, samples, out, at);
            total -= samples;
            at += samples;
        }
    }
}
