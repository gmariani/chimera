import { Bytes, bytesLabel, field } from '../../core/bytes';
import type { Field, FormatParser, Preview } from '../../core/types';
import { checkPixels, TooBig } from '../../core/limits';
import { append } from '../../core/math';

/**
 * GIF (87a and 89a): a screen size and an optional global color table, then
 * blocks until the trailer (3B). An image is a descriptor, an optional local
 * color table and LZW-compressed pixels in sub-blocks of up to 255 bytes; an
 * extension (21) before it can give the frame's delay, transparent color and
 * what to do with it before the next frame. Other extensions hold comments,
 * the loop count (NETSCAPE2.0) and the like.
 *
 * Frames are drawn as browsers draw them: on a transparent screen (the
 * background color is ignored), with a delay under 2 hundredths of a second
 * taken as 10.
 */

/** At most this many frames are listed in the fields. */
const MAX_FRAME_FIELDS = 2000;
/** Drawn frames kept for going back in an animation, at most. */
const CACHE_BYTES = 128 * 1024 * 1024;

const DISPOSAL = ['Not given (leave it)', 'Leave it', 'Clear to transparent', 'Put back what was under it'];

interface Frame {
    left: number;
    top: number;
    width: number;
    height: number;
    interlaced: boolean;
    /** 8-bit RGB. */
    colors: Uint8Array;
    transparent: number | null;
    disposal: number;
    /** Hundredths of a second, as stored. */
    delay: number;
    minCodeSize: number;
    data: Uint8Array;
}

/** Decodes GIF LZW into `out`, stopping once it's full. Returns how many pixels it wrote and whether the codes were sound. */
export function lzw(data: Uint8Array, minCodeSize: number, out: Uint8Array): { written: number; error: string | null } {
    const clear = 1 << minCodeSize;
    const end = clear + 1;
    const prefix = new Uint16Array(4096);
    const suffix = new Uint8Array(4096);
    const first = new Uint8Array(4096);
    const stack = new Uint8Array(4097);
    for (let i = 0; i < clear; i++) {
        suffix[i] = i;
        first[i] = i;
    }

    let size = minCodeSize + 1;
    let next = end + 1;
    let previous = -1;
    let bits = 0;
    let buffer = 0;
    let at = 0;
    let written = 0;
    while (written < out.length) {
        while (bits < size) {
            if (at >= data.length) return { written, error: written ? 'The pixel data ends early.' : 'There is no pixel data.' };
            buffer |= data[at++] << bits;
            bits += 8;
        }
        const code = buffer & ((1 << size) - 1);
        buffer >>>= size;
        bits -= size;

        if (code === clear) {
            size = minCodeSize + 1;
            next = end + 1;
            previous = -1;
            continue;
        }
        if (code === end) return { written, error: null };
        if (previous === -1) {
            if (code > clear) return { written, error: `Code ${code} comes before any string it could refer to.` };
            out[written++] = code;
            previous = code;
            continue;
        }
        if (code > next) return { written, error: `Code ${code} is past the table (${next}).` };

        // Unwind the string backwards onto the stack; a code not yet in the table is the previous string plus its first character.
        let depth = 0;
        let c = code;
        if (code === next) {
            stack[depth++] = first[previous];
            c = previous;
        }
        while (c > end) {
            stack[depth++] = suffix[c];
            c = prefix[c];
        }
        stack[depth++] = c;
        while (depth > 0 && written < out.length) out[written++] = stack[--depth];

        if (next < 4096) {
            prefix[next] = previous;
            suffix[next] = c;
            first[next] = first[previous];
            next++;
            if (next === 1 << size && size < 12) size++;
        }
        previous = code;
    }
    return { written, error: null };
}

/** Rows in the order an interlaced image stores them: every 8th from 0, every 8th from 4, every 4th from 2, every 2nd from 1. */
function interlacedRows(height: number): number[] {
    const rows: number[] = [];
    for (const [start, step] of [
        [0, 8],
        [4, 8],
        [2, 4],
        [1, 2],
    ])
        for (let y = start; y < height; y += step) rows.push(y);
    return rows;
}

/** Hundredths of a second a frame shows for, as browsers time it. */
const shownFor = (delay: number) => (delay < 2 ? 10 : delay);

function gcd(a: number, b: number): number {
    while (b) [a, b] = [b, a % b];
    return a;
}

/** The most pixels drawn to check every frame as the file opens; past it, frames are only drawn as they're shown. */
const PREDECODE_PIXELS = 1 << 28;

/** Draws frames one after another onto the screen, as the disposals say. */
class Screen {
    private readonly rgba: Uint8Array;
    private drawn = -1;
    /** What was under the last frame, when it's to be put back. */
    private saved: Uint8Array | null = null;
    private readonly cache = new Map<number, Uint8Array>();
    private cached = 0;
    outOfRange = 0;
    damaged: string[] = [];

    constructor(
        private readonly width: number,
        private readonly height: number,
        private readonly frames: Frame[]
    ) {
        this.rgba = new Uint8Array(width * height * 4);
    }

    frame(index: number): Uint8Array {
        const hit = this.cache.get(index);
        if (hit) return hit;
        if (index <= this.drawn) {
            this.rgba.fill(0);
            this.drawn = -1;
            this.saved = null;
        }
        while (this.drawn < index) this.step();
        const copy = this.rgba.slice();
        if (this.cached + copy.length <= CACHE_BYTES) {
            this.cache.set(index, copy);
            this.cached += copy.length;
        }
        return copy;
    }

    private step(): void {
        // First undo the last frame, if its disposal says to.
        const last = this.frames[this.drawn];
        if (last && last.disposal === 2) this.fill(last, null);
        else if (last && last.disposal === 3 && this.saved) this.fill(last, this.saved);

        const f = this.frames[++this.drawn];
        this.saved = f.disposal === 3 ? this.rgba.slice() : null;
        const pixels = new Uint8Array(f.width * f.height);
        const { written, error } = lzw(f.data, f.minCodeSize, pixels);
        if (error || written < pixels.length) this.damaged.push(`Frame ${this.drawn + 1}: ${error ?? 'the pixel data ends early'} (${written} of ${pixels.length} pixels).`);
        const rows = f.interlaced ? interlacedRows(f.height) : null;
        const colorCount = f.colors.length / 3;
        for (let r = 0; r < f.height; r++) {
            const y = f.top + (rows ? rows[r] : r);
            if (y >= this.height) continue;
            for (let x = 0; x < f.width; x++) {
                const sx = f.left + x;
                const i = r * f.width + x;
                if (sx >= this.width || i >= written) continue;
                const index = pixels[i];
                if (index === f.transparent) continue;
                const o = (y * this.width + sx) * 4;
                if (index >= colorCount) {
                    // No such color: drawn black, as most decoders do.
                    this.outOfRange++;
                    this.rgba.set([0, 0, 0, 255], o);
                    continue;
                }
                this.rgba[o] = f.colors[index * 3];
                this.rgba[o + 1] = f.colors[index * 3 + 1];
                this.rgba[o + 2] = f.colors[index * 3 + 2];
                this.rgba[o + 3] = 255;
            }
        }
    }

    /** Clears a frame's rectangle, or puts back what was there. */
    private fill(f: Frame, from: Uint8Array | null): void {
        for (let y = f.top; y < Math.min(f.top + f.height, this.height); y++) {
            const start = (y * this.width + f.left) * 4;
            const end = (y * this.width + Math.min(f.left + f.width, this.width)) * 4;
            if (from) this.rgba.set(from.subarray(start, end), start);
            else this.rgba.fill(0, start, end);
        }
    }
}

const parser: FormatParser = {
    parse(data) {
        const b = new Bytes(data);
        const version = b.ascii(0, 6);
        const warnings: string[] = [];
        const [width, height, packed, background, aspect] = [b.u16(6), b.u16(8), b.u8(10), b.u8(11), b.u8(12)];
        const hasGlobal = (packed & 0x80) !== 0;
        const globalSize = hasGlobal ? 3 << ((packed & 7) + 1) : 0;
        const globalColors = data.subarray(13, 13 + globalSize);

        const fields: Field[] = [
            { name: 'Header', offset: 0, length: 6, value: version, children: [field('Signature', 0, 3, 'GIF'), field('Version', 3, 3, version.slice(3))] },
            {
                name: 'Logical screen',
                offset: 6,
                length: 7,
                value: `${width} × ${height}`,
                children: [
                    field('Width', 6, 2, width),
                    field('Height', 8, 2, height),
                    field(
                        'Flags',
                        10,
                        1,
                        `${packed}`,
                        `Global color table: ${hasGlobal ? `yes, ${globalSize / 3} colors${packed & 8 ? ', sorted by importance' : ''}` : 'no'}. Source had ${((packed >> 4) & 7) + 1} bits per channel.`
                    ),
                    field('Background color', 11, 1, background, 'An index into the global color table. Browsers ignore it and start from transparent.'),
                    field('Pixel aspect', 12, 1, aspect ? `${((aspect + 15) / 64).toFixed(3)}` : '0 (square)'),
                ],
            },
        ];
        if (hasGlobal) fields.push(field('Global color table', 13, globalSize, `${globalSize / 3} colors`));

        const frames: Frame[] = [];
        const blockFields: Field[] = [];
        const comments: string[] = [];
        let loops: number | null = null;
        let pending: Pick<Frame, 'transparent' | 'disposal' | 'delay'> | null = null;
        let at = 13 + globalSize;
        let ended = false;

        /** Sub-blocks from `start`: their bytes joined, and where they end (after the 0 that closes them). */
        const subBlocks = (start: number): { bytes: Uint8Array; end: number; count: number; complete: boolean } => {
            const parts: Uint8Array[] = [];
            let p = start;
            let count = 0;
            while (p < data.length) {
                const size = data[p];
                if (size === 0) return { bytes: join(parts), end: p + 1, count, complete: true };
                if (p + 1 + size > data.length) {
                    // Cut short: keep what there is, so as much as possible still draws.
                    parts.push(data.subarray(p + 1));
                    count++;
                    break;
                }
                parts.push(data.subarray(p + 1, p + 1 + size));
                p += 1 + size;
                count++;
            }
            return { bytes: join(parts), end: data.length, count, complete: false };
        };

        while (at < data.length) {
            const kind = data[at];
            if (kind === 0x3b) {
                if (blockFields.length < MAX_FRAME_FIELDS * 2) blockFields.push(field('Trailer', at, 1, '3B'));
                at++;
                ended = true;
                break;
            }
            if (kind === 0x21) {
                const label = data[at + 1];
                const start = at;
                const body = subBlocks(at + 2);
                if (!body.complete) warnings.push(`The extension at byte ${start} runs past the end of the file.`);
                at = body.end;
                const bytes = body.bytes;
                const list = blockFields.length < MAX_FRAME_FIELDS * 2;
                if (label === 0xf9 && bytes.length >= 4) {
                    const flags = bytes[0];
                    const delay = bytes[1] | (bytes[2] << 8);
                    const disposal = (flags >> 2) & 7;
                    pending = { transparent: flags & 1 ? bytes[3] : null, disposal: disposal > 3 ? 0 : disposal, delay };
                    if (list)
                        blockFields.push({
                            name: 'Graphic control',
                            offset: start,
                            length: at - start,
                            value: `${delay / 100} s${flags & 1 ? `, color ${bytes[3]} transparent` : ''}`,
                            children: [
                                field('Introducer', start, 2, '21 F9'),
                                field('Size', start + 2, 1, data[start + 2]),
                                field(
                                    'Flags',
                                    start + 3,
                                    1,
                                    flags,
                                    `After this frame: ${DISPOSAL[disposal] ?? `${disposal} (unknown)`}.${flags & 2 ? ' Waits for input.' : ''}${flags & 1 ? ' Has a transparent color.' : ''}`
                                ),
                                field('Delay', start + 4, 2, `${delay} hundredths of a second`, delay < 2 ? 'Under 2: browsers show it for 10.' : undefined),
                                field('Transparent color', start + 6, 1, bytes[3], flags & 1 ? undefined : 'Not used: the flag is off.'),
                            ],
                        });
                } else if (label === 0xfe) {
                    const text = new TextDecoder('latin1').decode(bytes);
                    comments.push(text);
                    if (list) blockFields.push(field('Comment', start, at - start, JSON.stringify(text.length > 80 ? `${text.slice(0, 80)}…` : text)));
                } else if (label === 0xff) {
                    const id = new TextDecoder('latin1').decode(data.subarray(start + 3, start + 3 + Math.min(11, data[start + 2])));
                    const netscape = /^(NETSCAPE2\.0|ANIMEXTS1\.0)$/.test(id);
                    // The loop count is its own sub-block after the 11-byte name: 1, then a 16-bit count.
                    const loopAt = start + 3 + data[start + 2];
                    if (netscape && data[loopAt] === 3 && data[loopAt + 1] === 1) loops = data[loopAt + 2] | (data[loopAt + 3] << 8);
                    if (list)
                        blockFields.push(
                            field(
                                'Application extension',
                                start,
                                at - start,
                                id,
                                netscape && loops !== null ? (loops === 0 ? 'Loops forever.' : `Loop count ${loops}.`) : id.startsWith('XMP') ? 'XMP metadata.' : undefined
                            )
                        );
                } else if (list) {
                    blockFields.push(
                        field(
                            label === 0x01 ? 'Plain text' : `Extension ${label.toString(16).toUpperCase()}`,
                            start,
                            at - start,
                            bytesLabel(bytes.length),
                            label === 0x01 ? 'Text drawn over the picture; browsers ignore it.' : undefined
                        )
                    );
                }
                continue;
            }
            if (kind === 0x2c) {
                const start = at;
                const [left, top, w, h, flags] = [b.u16(at + 1), b.u16(at + 3), b.u16(at + 5), b.u16(at + 7), b.u8(at + 9)];
                const hasLocal = (flags & 0x80) !== 0;
                const localSize = hasLocal ? 3 << ((flags & 7) + 1) : 0;
                const colorsAt = at + 10;
                const minAt = colorsAt + localSize;
                if (minAt >= data.length) {
                    warnings.push(`The image at byte ${start} runs past the end of the file.`);
                    break;
                }
                const minCodeSize = data[minAt];
                const body = subBlocks(minAt + 1);
                if (!body.complete) warnings.push(`Frame ${frames.length + 1}'s pixel data runs past the end of the file.`);
                at = body.end;
                const colors = hasLocal ? data.subarray(colorsAt, colorsAt + localSize) : globalColors;
                if (minCodeSize < 1 || minCodeSize > 11) warnings.push(`Frame ${frames.length + 1} has an LZW code size of ${minCodeSize}, which isn't allowed.`);
                else if (!colors.length) warnings.push(`Frame ${frames.length + 1} has no color table to draw it with.`);
                else
                    frames.push({
                        left,
                        top,
                        width: w,
                        height: h,
                        interlaced: (flags & 0x40) !== 0,
                        colors,
                        minCodeSize,
                        data: body.bytes,
                        transparent: pending?.transparent ?? null,
                        disposal: pending?.disposal ?? 0,
                        delay: pending?.delay ?? 0,
                    });
                pending = null;
                if (blockFields.length < MAX_FRAME_FIELDS * 2)
                    blockFields.push({
                        name: `Frame ${frames.length}`,
                        offset: start,
                        length: at - start,
                        value: `${w} × ${h} at ${left}, ${top}${flags & 0x40 ? ', interlaced' : ''}`,
                        children: [
                            field('Separator', start, 1, '2C'),
                            field('Left', start + 1, 2, left),
                            field('Top', start + 3, 2, top),
                            field('Width', start + 5, 2, w),
                            field('Height', start + 7, 2, h),
                            field(
                                'Flags',
                                start + 9,
                                1,
                                flags,
                                `Local color table: ${hasLocal ? `yes, ${localSize / 3} colors` : 'no, uses the global one'}. ${flags & 0x40 ? 'Interlaced.' : 'Not interlaced.'}`
                            ),
                            ...(hasLocal ? [field('Local color table', colorsAt, localSize, `${localSize / 3} colors`)] : []),
                            field('LZW code size', minAt, 1, minCodeSize),
                            field('Pixel data', minAt + 1, at - minAt - 1, `${bytesLabel(body.bytes.length)} in ${body.count} sub-block${body.count === 1 ? '' : 's'}`),
                        ],
                    });
                continue;
            }
            warnings.push(`Byte ${at} (${kind.toString(16).toUpperCase().padStart(2, '0')}) doesn't start a block; stopped there.`);
            break;
        }
        if (!ended && !warnings.some((w) => /stopped there|past the end/.test(w))) warnings.push('There is no trailer (3B), so the file may be cut short.');
        if (blockFields.length >= MAX_FRAME_FIELDS * 2) warnings.push(`The first ${MAX_FRAME_FIELDS.toLocaleString('en-US')} or so blocks are in the fields.`);
        fields.push({ name: 'Blocks', offset: 13 + globalSize, length: at - 13 - globalSize, value: `${frames.length} frame${frames.length === 1 ? '' : 's'}`, children: blockFields });
        const trailerEnd = at;
        if (at < data.length) fields.push(field('After the trailer', at, data.length - at, bytesLabel(data.length - at), "Not part of the picture; it's ignored."));
        if (!frames.length) throw new Error('No frames to draw.');

        // The screen, drawn frame by frame, unless the sizes are past what the app will draw (the structure is still all there).
        let screen: Screen | null = null;
        let preview: Preview | undefined;
        try {
            checkPixels(width, height, 'The screen');
            for (const [i, f] of frames.entries()) checkPixels(f.width, f.height, `Frame ${i + 1}`);
            screen = new Screen(width, height, frames);
        } catch (e) {
            if (!(e instanceof TooBig)) throw e;
            warnings.push(`Not drawn: ${e.message} Sizes like that mean a damaged file, or one made to exhaust memory.`);
        }
        const shown = frames.map((f) => shownFor(f.delay));
        const seconds = shown.reduce((n, d) => n + d, 0) / 100;
        if (screen) {
            const drawn = screen;
            const first = drawn.frame(0);
            if (frames.length === 1) {
                preview = { kind: 'picture', width, height, rgba: first };
            } else {
                // A video has one rate: tick at the delays' common divisor, and show each frame for as many ticks as its delay.
                const tick = shown.reduce(gcd);
                const ends: number[] = [];
                let total = 0;
                for (const d of shown) ends.push((total += d / tick));
                preview = {
                    kind: 'video',
                    width,
                    height,
                    frameCount: total,
                    fps: 100 / tick,
                    frame(index) {
                        let lo = 0;
                        let hi = ends.length - 1;
                        while (lo < hi) {
                            const mid = (lo + hi) >> 1;
                            if (ends[mid] > index) hi = mid;
                            else lo = mid + 1;
                        }
                        return { rgba: drawn.frame(lo) };
                    },
                };
            }
            if (comments.length)
                preview = {
                    kind: 'stack',
                    items: [
                        { title: frames.length === 1 ? 'Picture' : 'Animation', preview },
                        { title: 'Comments', preview: { kind: 'text', text: comments.join('\n\n') } },
                    ],
                };

            // Check every frame decodes, so damage shows up as the file opens rather than partway through playing (unless that's too much work to do up front).
            const work = frames.reduce((n, f) => n + width * height + f.width * f.height, 0);
            if (frames.length > 1 && work <= PREDECODE_PIXELS) for (let i = 1; i < frames.length; i++) screen.frame(i);
            append(warnings, screen.damaged);
            if (screen.outOfRange) warnings.push(`${screen.outOfRange.toLocaleString('en-US')} pixel${screen.outOfRange === 1 ? '' : 's'} use a color past the end of the color table, drawn black.`);
        }

        const interlaced = frames.filter((f) => f.interlaced).length;
        return {
            title: `${frames.length > 1 ? 'Animation' : 'Picture'} (GIF${version.slice(3)})`,
            summary: [
                ['Size', `${width} × ${height}`],
                ['Frames', String(frames.length)],
                ...(frames.length > 1
                    ? ([
                          ['Length', `${seconds.toFixed(2)} s`],
                          [
                              'Loops',
                              loops === null
                                  ? 'No loop count (most browsers play it once)'
                                  : loops === 0
                                    ? 'Forever'
                                    : `Loop count ${loops} (players differ on whether that counts the first time through)`,
                          ],
                      ] as [string, string][])
                    : []),
                ['Colors', hasGlobal ? `${globalSize / 3} in the global table${frames.some((f) => f.colors !== globalColors) ? ', and local tables' : ''}` : 'Local tables only'],
                ...(frames.some((f) => f.transparent !== null) ? ([['Transparency', 'Yes']] as [string, string][]) : []),
                ...(interlaced ? ([['Interlaced', interlaced === frames.length ? 'Yes' : `${interlaced} of ${frames.length} frames`]] as [string, string][]) : []),
            ],
            fields,
            preview,
            end: trailerEnd,
            warnings,
        };
    },
};

function join(parts: Uint8Array[]): Uint8Array {
    if (parts.length === 1) return parts[0];
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
        out.set(p, at);
        at += p.length;
    }
    return out;
}

export default parser;
