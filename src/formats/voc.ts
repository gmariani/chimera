import { Bytes, bytesLabel, field } from '../core/bytes';
import { Budget } from '../core/limits';
import type { Field, FormatParser, Preview } from '../core/types';
import { wav } from './westwood/adpcm';

/**
 * Creative Voice (.voc), Sound Blaster's sound files, which DOS games used for
 * speech and effects (Dune II keeps hundreds in its PAKs). A header (the
 * signature, its own size, a version and a check of the version), then
 * blocks, each a type byte and a 24-bit size, until a block of type 0:
 *
 *   1 sound (a rate divisor, a codec, the samples)   2 more of the same sound
 *   3 silence (how long, at what rate)               4 a marker   5 text
 *   6 repeat from here (how many times)              7 end of the repeat
 *   8 extended (rate and stereo for the next sound block)
 *   9 sound in the newer form (rate, bits, channels and codec spelled out)
 *
 * Samples are 8-bit unsigned or 16-bit signed PCM, A-law, µ-law, or Creative's
 * ADPCM at 4, 2.6 or 2 bits a sample, which decodes as FFmpeg's
 * adpcm_sbpro does (checked sample for sample against FFmpeg in every codec).
 */

const SIGNATURE = 'Creative Voice File\x1a';
const HEADER = 26;

const BLOCKS: Record<number, string> = {
    0: 'End',
    1: 'Sound',
    2: 'Sound, continued',
    3: 'Silence',
    4: 'Marker',
    5: 'Text',
    6: 'Repeat start',
    7: 'Repeat end',
    8: 'Extended',
    9: 'Sound (new form)',
};

const CODECS: Record<number, string> = {
    0: '8-bit PCM',
    1: 'Creative ADPCM, 4-bit',
    2: 'Creative ADPCM, 2.6-bit',
    3: 'Creative ADPCM, 2-bit',
    4: '16-bit PCM',
    6: 'A-law',
    7: 'µ-law',
};

/** The format of a run of samples: what the sound blocks say. */
interface Format {
    rate: number;
    channels: number;
    codec: number;
}

/** A Creative ADPCM channel: where its prediction is, and how big its steps are. */
interface Adpcm {
    predictor: number;
    step: number;
}

/** One Creative ADPCM code to a sample, as FFmpeg's adpcm_sbpro_expand_nibble. */
function expand(c: Adpcm, code: number, size: number, shift: number): number {
    const sign = code & (1 << (size - 1));
    const delta = code & ((1 << (size - 1)) - 1);
    const diff = delta << (7 + c.step + shift);
    c.predictor = Math.min(16256, Math.max(-16384, c.predictor + (sign ? -diff : diff)));
    if (delta >= 2 * size - 3 && c.step < 3) c.step++;
    else if (delta === 0 && c.step > 0) c.step--;
    return c.predictor;
}

const alaw = (v: number) => {
    v ^= 0x55;
    const exponent = (v >> 4) & 7;
    let t = (v & 15) << 4;
    t = exponent ? (t + 0x108) << (exponent - 1) : t + 8;
    return v & 0x80 ? t : -t;
};

const ulaw = (v: number) => {
    v = ~v & 0xff;
    const t = (((v & 15) << 3) + 0x84) << ((v >> 4) & 7);
    return v & 0x80 ? 0x84 - t : t - 0x84;
};

/**
 * Decodes one block's samples to 16-bit. Creative ADPCM starts each sound
 * block with a plain 8-bit sample to start from; a continuation carries on.
 */
function decode(data: Uint8Array, format: Format, adpcm: Adpcm[], fresh: boolean): Int16Array | null {
    const { codec, channels } = format;
    switch (codec) {
        case 0:
            return Int16Array.from(data, (v) => (v - 128) << 8);
        case 4:
            return new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + (data.length & ~1)));
        case 6:
            return Int16Array.from(data, alaw);
        case 7:
            return Int16Array.from(data, ulaw);
        case 1:
        case 2:
        case 3: {
            const out: number[] = [];
            let at = 0;
            if (fresh) {
                for (let ch = 0; ch < channels && at < data.length; ch++) out.push(128 * (data[at++] - 0x80));
                for (const c of adpcm) {
                    c.predictor = 0;
                    c.step = 0;
                }
            }
            const second = adpcm[channels > 1 ? 1 : 0];
            for (; at < data.length; at++) {
                const v = data[at];
                if (codec === 1) out.push(expand(adpcm[0], v >> 4, 4, 0), expand(second, v & 15, 4, 0));
                else if (codec === 2) out.push(expand(adpcm[0], v >> 5, 3, 0), expand(adpcm[0], (v >> 2) & 7, 3, 0), expand(adpcm[0], v & 3, 2, 0));
                else out.push(expand(adpcm[0], v >> 6, 2, 2), expand(adpcm[0], (v >> 4) & 3, 2, 2), expand(adpcm[0], (v >> 2) & 3, 2, 2), expand(adpcm[0], v & 3, 2, 2));
            }
            return Int16Array.from(out);
        }
        default:
            return null;
    }
}

/** A rate divisor (blocks 1 and 3) as samples a second. */
const divisorRate = (divisor: number) => Math.floor(1_000_000 / (256 - divisor));

/** The most blocks shown as fields; the rest are summed up in one. */
const MAX_FIELDS = 2000;

const parser: FormatParser = {
    parse(data) {
        const b = new Bytes(data);
        if (data.length < HEADER || b.ascii(0, SIGNATURE.length) !== SIGNATURE) throw new Error('There\'s no "Creative Voice File" signature.');
        const headerSize = b.u16(20);
        if (headerSize < HEADER || headerSize > data.length)
            throw new Error(`The header says it's ${headerSize} bytes, which ${headerSize < HEADER ? `is less than the ${HEADER} it has to be` : 'is more than the file'}.`);
        const version = b.u16(22);
        const check = b.u16(24);
        const expected = (~version + 0x1234) & 0xffff;
        const warnings: string[] = [];
        if (check !== expected) warnings.push(`The header's check (0x${check.toString(16).toUpperCase()}) doesn't match its version (it should be 0x${expected.toString(16).toUpperCase()}).`);

        const fields: Field[] = [
            {
                name: 'Header',
                offset: 0,
                length: headerSize,
                value: `version ${version >> 8}.${String(version & 0xff).padStart(2, '0')}`,
                children: [
                    field('Signature', 0, 20, 'Creative Voice File', "Ends in 0x1A, which stops DOS's TYPE from printing the rest."),
                    field('Header size', 20, 2, headerSize),
                    field('Version', 22, 2, `${version >> 8}.${String(version & 0xff).padStart(2, '0')}`),
                    field('Check', 24, 2, `0x${check.toString(16).toUpperCase()}`, 'The version inverted, plus 0x1234.'),
                    ...(headerSize > HEADER ? [field('Rest of the header', HEADER, headerSize - HEADER, bytesLabel(headerSize - HEADER))] : []),
                ],
            },
        ];

        // The samples, as 16-bit, block by block (silence as how many seconds of it); and whether all of them were 8-bit PCM (kept 8-bit in the WAV).
        const parts: (Int16Array | number)[] = [];
        let all8 = true;
        const budget = new Budget('The decoded sound');
        let format: Format | null = null;
        /** What a type 8 block says about the next sound block. */
        let extended: Format | null = null;
        const adpcm: Adpcm[] = [
            { predictor: 0, step: 0 },
            { predictor: 0, step: 0 },
        ];
        const formats: Format[] = [];
        /** The first silence block's rate, the rate to play at if there's no sound at all. */
        let silenceRate: number | undefined;
        const texts: string[] = [];
        const markers: number[] = [];
        let repeats: string | null = null;
        let unknown = 0;
        let shown = 0;
        let end: number | null = null;
        let at = headerSize;

        while (at < data.length) {
            const type = data[at];
            if (type === 0) {
                fields.push(field('End', at, 1, '0', 'The last block.'));
                end = at + 1;
                break;
            }
            if (at + 4 > data.length) {
                warnings.push(`The block at ${at} is cut short.`);
                break;
            }
            let size = b.u8(at + 1) | (b.u8(at + 2) << 8) | (b.u8(at + 3) << 16);
            if (at + 4 + size > data.length) {
                warnings.push(
                    `The ${BLOCKS[type] ?? `type ${type}`} block at ${at} says it's ${bytesLabel(size)}, but only ${bytesLabel(data.length - at - 4)} are left; it's read as far as it goes.`
                );
                size = data.length - at - 4;
            }
            const body = at + 4;
            const children: Field[] = [field('Type', at, 1, `${type} (${BLOCKS[type] ?? 'unknown'})`), field('Size', at + 1, 3, bytesLabel(size))];
            let value: string | undefined;

            /** Decodes this block's samples and adds them. */
            const sound = (from: number, f: Format, fresh: boolean) => {
                const samples = data.subarray(from, body + size);
                children.push(field('Samples', from, samples.length, `${bytesLabel(samples.length)}, ${CODECS[f.codec] ?? `codec ${f.codec}`}`));
                if (f.codec !== 0) all8 = false;
                const decoded = decode(samples, f, adpcm, fresh);
                if (!decoded) {
                    warnings.push(`The sound at ${at} uses codec ${f.codec}, which isn't one VOC files define (or that's read here); it's left out.`);
                    return;
                }
                budget.take(decoded.byteLength);
                parts.push(decoded);
                formats.push(f);
                value = `${f.rate.toLocaleString('en-US')} Hz${f.channels > 1 ? ' stereo' : ''}, ${CODECS[f.codec] ?? `codec ${f.codec}`}`;
            };

            switch (type) {
                case 1: {
                    const divisor = b.u8(body);
                    const codec = b.u8(body + 1);
                    children.push(
                        field('Rate divisor', body, 1, divisor, `${divisorRate(divisor).toLocaleString('en-US')} Hz: 1,000,000 ÷ (256 − this).`),
                        field('Codec', body + 1, 1, `${codec} (${CODECS[codec] ?? 'unknown'})`)
                    );
                    // An extended block before this one overrides its rate and codec, and says whether it's stereo.
                    format = extended ?? { rate: divisorRate(divisor), channels: 1, codec };
                    extended = null;
                    sound(body + 2, format, true);
                    break;
                }
                case 2:
                    if (!format) {
                        warnings.push(`The continued sound at ${at} doesn't follow a sound block, so its format isn't known; it's left out.`);
                        children.push(field('Samples', body, size));
                    } else sound(body, format, false);
                    break;
                case 3: {
                    const length = b.u16(body) + 1;
                    const divisor = b.u8(body + 2);
                    const rate = divisorRate(divisor);
                    children.push(
                        field('Length', body, 2, `${length.toLocaleString('en-US')} samples`, 'Stored as one less.'),
                        field('Rate divisor', body + 2, 1, divisor, `${rate.toLocaleString('en-US')} Hz.`)
                    );
                    value = `${(length / rate).toFixed(3)} s`;
                    // Its rate only says how long it lasts: it's played at the sound's rate, not counted as a rate of its own.
                    parts.push(length / rate);
                    silenceRate ??= rate;
                    break;
                }
                case 4: {
                    const marker = b.u16(body);
                    markers.push(marker);
                    children.push(field('Marker', body, 2, marker, 'A number the program playing it can wait for.'));
                    value = String(marker);
                    break;
                }
                case 5: {
                    const zero = data.indexOf(0, body);
                    const text = new TextDecoder('latin1').decode(data.subarray(body, zero >= 0 && zero < body + size ? zero : body + size));
                    texts.push(text);
                    children.push(field('Text', body, size, JSON.stringify(text.length > 80 ? `${text.slice(0, 80)}…` : text)));
                    value = JSON.stringify(text.length > 40 ? `${text.slice(0, 40)}…` : text);
                    break;
                }
                case 6: {
                    const count = b.u16(body);
                    repeats = count === 0xffff ? 'forever' : `${count + 1} times`;
                    children.push(field('Count', body, 2, count === 0xffff ? 'forever (0xFFFF)' : `${count + 1} times`, 'Stored as one less.'));
                    value = repeats;
                    break;
                }
                case 7:
                    break;
                case 8: {
                    const constant = b.u16(body);
                    const codec = b.u8(body + 2);
                    const channels = b.u8(body + 3) ? 2 : 1;
                    const rate = Math.floor(256_000_000 / (channels * (65536 - constant)));
                    extended = { rate, channels, codec };
                    children.push(
                        field('Time constant', body, 2, constant, `${rate.toLocaleString('en-US')} Hz: 256,000,000 ÷ (channels × (65,536 − this)).`),
                        field('Codec', body + 2, 1, `${codec} (${CODECS[codec] ?? 'unknown'})`),
                        field('Mode', body + 3, 1, channels > 1 ? 'stereo' : 'mono')
                    );
                    value = `for the next sound: ${rate.toLocaleString('en-US')} Hz${channels > 1 ? ' stereo' : ''}`;
                    break;
                }
                case 9: {
                    const rate = b.u32(body);
                    const bits = b.u8(body + 4);
                    const channels = b.u8(body + 5) || 1;
                    const codec = b.u16(body + 6);
                    children.push(
                        field('Rate', body, 4, `${rate.toLocaleString('en-US')} Hz`),
                        field('Bits', body + 4, 1, bits),
                        field('Channels', body + 5, 1, channels),
                        field('Codec', body + 6, 2, `${codec} (${CODECS[codec] ?? 'unknown'})`),
                        field('Reserved', body + 8, 4)
                    );
                    if (rate < 1000 || rate > 192_000 || channels > 8) warnings.push(`The sound at ${at} says ${rate.toLocaleString('en-US')} Hz and ${channels} channels, which can't be right.`);
                    format = { rate, channels, codec };
                    extended = null;
                    sound(body + 12, format, true);
                    break;
                }
                default:
                    unknown++;
                    children.push(field('Data', body, size));
            }

            if (shown < MAX_FIELDS) fields.push({ name: `${BLOCKS[type] ?? `Unknown block (${type})`}`, offset: at, length: 4 + size, value, children });
            else if (shown === MAX_FIELDS) warnings.push(`The first ${MAX_FIELDS.toLocaleString('en-US')} blocks are in the fields.`);
            shown++;
            at = body + size;
        }

        if (end === null && at >= data.length) warnings.push("There's no end block (type 0), so the file may be cut short.");
        if (unknown) warnings.push(`${unknown} block${unknown === 1 ? ' has a type' : 's have types'} VOC files don't define.`);
        if (end === null && shown >= MAX_FIELDS)
            fields.push(field('More blocks', fields[fields.length - 1].offset + fields[fields.length - 1].length, at - (fields[fields.length - 1].offset + fields[fields.length - 1].length)));

        // One rate and channel count for the whole sound: the first sound block's (a file whose blocks differ would need resampling).
        const first: Format | undefined = formats[0] ?? (silenceRate ? { rate: silenceRate, channels: 1, codec: 0 } : undefined);
        const rates = new Set(formats.map((f) => f.rate));
        if (rates.size > 1) warnings.push(`Its blocks are at different rates (${[...rates].map((r) => `${r.toLocaleString('en-US')} Hz`).join(', ')}); it plays at the first's.`);
        if (new Set(formats.map((f) => f.channels)).size > 1) warnings.push('Some blocks are mono and some stereo; it plays as the first is.');

        // Silence as samples at the rate it plays at.
        const samplesOf = (p: Int16Array | number) => (typeof p === 'number' ? Math.round(p * (first?.rate ?? 0)) * (first?.channels ?? 1) : p.length);
        const total = parts.reduce<number>((n, p) => n + samplesOf(p), 0);
        // The sound blocks were counted as they were decoded; the silence is counted here.
        budget.take(parts.reduce<number>((n, p) => n + (typeof p === 'number' ? samplesOf(p) * 2 : 0), 0));
        let preview: Preview | undefined;
        if (first && total) {
            const joined = new Int16Array(total);
            let o = 0;
            for (const p of parts) {
                if (typeof p !== 'number') joined.set(p, o);
                o += samplesOf(p);
            }
            // All 8-bit PCM stays 8-bit, as stored.
            const samples = all8 ? Uint8Array.from(joined, (v) => (v >> 8) + 128) : joined;
            const seconds = total / first.channels / first.rate;
            preview = { kind: 'audio', wav: wav(samples, first.rate, first.channels), sampleRate: first.rate, channels: first.channels, bits: all8 ? 8 : 16, seconds };
            if (texts.length)
                preview = {
                    kind: 'stack',
                    items: [
                        { title: 'Sound', preview },
                        { title: 'Text', preview: { kind: 'text', text: texts.join('\n\n') } },
                    ],
                };
        } else if (texts.length) preview = { kind: 'text', text: texts.join('\n\n') };

        const codecs = [...new Set(formats.map((f) => CODECS[f.codec] ?? `codec ${f.codec}`))];
        return {
            title: 'Sound (VOC)',
            summary: [
                ...(first && total
                    ? ([
                          ['Length', `${(total / first.channels / first.rate).toFixed(2)} s`],
                          ['Rate', `${first.rate.toLocaleString('en-US')} Hz`],
                          ['Channels', first.channels > 1 ? 'Stereo' : 'Mono'],
                          ['Codec', codecs.length ? codecs.join(', ') : 'None: silence only'],
                      ] as [string, string][])
                    : ([['Sound', 'None']] as [string, string][])),
                ['Version', `${version >> 8}.${String(version & 0xff).padStart(2, '0')}`],
                ['Blocks', shown.toLocaleString('en-US')],
                ...(markers.length ? ([['Markers', markers.join(', ')]] as [string, string][]) : []),
                ...(repeats ? ([['Repeats', `${repeats} (played once here)`]] as [string, string][]) : []),
            ],
            fields,
            preview,
            // Past the end block is nothing the file plays; the usual checks look at it.
            end: end ?? undefined,
            warnings,
        };
    },
};

export default parser;
