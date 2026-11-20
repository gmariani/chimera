import { Bytes, bytesLabel, field, fillGaps } from '../core/bytes';
import { pixelBuffer } from '../core/limits';
import { maxOf } from '../core/math';
import type { Entry, Field, FormatParser, Parsed, Preview } from '../core/types';
import { sniffAni } from './ani-sniff';
import ico from './ico';

/**
 * Animated cursors (.ani), from Windows NT 3.5 and Windows 95 on: the spinning hourglasses and cursor themes. A RIFF
 * file of the form ACON, its chunks in any order:
 *
 * - "anih", the header: nine u32s, its own size (36), how many frames, how many steps the animation takes, four left
 *   at 0 (a width, a height, bits a pixel and planes, which the frames say for themselves), the default time for a
 *   step in jiffies (1/60 s), and flags (1: the frames are icons; 2: the steps follow "seq ").
 * - "rate", optional: each step's own time, in jiffies.
 * - "seq ", optional: which frame each step shows, so frames can repeat or play back and forth.
 * - "LIST" of the form "INFO", optional: "INAM", its title, and "IART", its author.
 * - "LIST" of the form "fram": an "icon" chunk for each frame, each a whole .ico or .cur file.
 *
 * Each chunk is a 4-letter ID, a u32 size, and its data, padded to an even length. See the description that came
 * with the Windows 95 SDK's animated cursors (mirrored at https://www.moon-soft.com/program/FORMAT/windows/ani.htm)
 * and Wikipedia's "ANI (file format)" (https://en.wikipedia.org/wiki/ANI_(file_format)); facts only.
 */

const HEADER = 36;

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
/** Fields of a file read on its own, moved to where it is inside this one. */
const moved = (fields: Field[], by: number): Field[] => fields.map((f) => ({ ...f, offset: f.offset + by, children: f.children && moved(f.children, by) }));
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

interface Frame {
    at: number;
    size: number;
    /** The largest picture in it, when it could be drawn. */
    picture?: { width: number; height: number; rgba: Uint8Array };
    cursor: boolean;
}

const parser: FormatParser = {
    parse(data, context) {
        if (!sniffAni(data)) throw new Error('This isn’t an animated cursor: it doesn’t start with RIFF and the form ACON.');
        const b = new Bytes(data);
        const warnings: string[] = [];
        const fields: Field[] = [];

        // The RIFF size is of what follows it. Westwood's cursors (Red Alert's themes) and Generals' count the 8 bytes
        // of the RIFF header too, giving the whole file's length; Windows loads them, so that's taken quietly.
        const said = b.u32(4);
        let end = 8 + said;
        if (said === data.length) end = data.length;
        else if (end > data.length) {
            warnings.push(`It says it runs to ${bytesLabel(end)}, but the file ends at ${bytesLabel(data.length)}: it’s been cut short.`);
            end = data.length;
        }
        fields.push({
            name: 'RIFF header',
            offset: 0,
            length: 12,
            value: 'ACON',
            children: [
                field('ID', 0, 4, 'RIFF'),
                field(
                    'Size',
                    4,
                    4,
                    bytesLabel(said),
                    said === data.length ? 'The whole file’s length, its first 8 bytes too: the spec counts only what follows this field.' : 'Of everything after this field.'
                ),
                field('Form', 8, 4, 'ACON', 'An animated cursor.'),
            ],
        });

        let header = null as { frames: number; steps: number; jiffies: number; flags: number } | null;
        let rates = null as number[] | null;
        let sequence = null as number[] | null;
        const info: Record<string, string> = {};
        const frames: Frame[] = [];
        let framesSeen = false as boolean;
        const text = (at: number, size: number) => {
            const bytes = data.subarray(at, at + size);
            const nul = bytes.indexOf(0);
            return new TextDecoder('latin1').decode(nul < 0 ? bytes : bytes.subarray(0, nul)).trim();
        };
        const u32s = (at: number, size: number) => Array.from({ length: Math.floor(size / 4) }, (_, i) => b.u32(at + i * 4));

        /** The chunks from `from` to `to`, each read by `read`; what's left over after the last is said. */
        const chunks = (from: number, to: number, where: string, read: (id: string, at: number, size: number, out: Field[]) => Field | null): Field[] => {
            const out: Field[] = [];
            let p = from;
            while (p + 8 <= to) {
                const id = b.ascii(p, 4);
                let size = b.u32(p + 4);
                if (p + 8 + size > to) {
                    warnings.push(`The ${JSON.stringify(id)} chunk ${where}says it’s ${bytesLabel(size)}, past where ${where ? 'its list' : 'the file'} ends: it’s been cut short.`);
                    size = to - p - 8;
                }
                const kids: Field[] = [field('ID', p, 4, id), field('Size', p + 4, 4, bytesLabel(size))];
                const made = read(id, p + 8, size, kids);
                out.push(
                    made
                        ? { ...made, offset: p, length: 8 + size, children: [...kids, ...(made.children ?? [])] }
                        : { name: `Chunk ${JSON.stringify(id)}`, offset: p, length: 8 + size, value: bytesLabel(size), children: kids, note: 'Not one an animated cursor has; Windows skips it.' }
                );
                p += 8 + size;
                // Chunks start on an even byte. A file that ends right after an odd chunk is left without the pad, and that's fine.
                if (size & 1 && p < to) {
                    out.push(field('Padding', p, 1, data[p], 'To make the next chunk start on an even byte.'));
                    p++;
                }
            }
            if (p < to) out.push(field('Too short for a chunk', p, to - p, bytesLabel(to - p)));
            return out;
        };

        const top = chunks(12, end, '', (id, at, size, kids) => {
            if (id === 'anih') {
                if (header) warnings.push('It has a second header ("anih"): Windows reads the first.');
                if (size < HEADER) {
                    warnings.push(`Its header ("anih") is ${bytesLabel(size)}, too short for the 36 it needs.`);
                    return { name: 'Header (too short)', offset: at, length: size };
                }
                const [own, count, steps, w, h, bits, planes, jiffies, flags] = u32s(at, HEADER);
                header ??= { frames: count, steps, jiffies, flags };
                if (own !== HEADER) warnings.push(`Its header says it’s ${bytesLabel(own)}, not 36.`);
                if (size > HEADER) kids.push(field('After the header', at + HEADER, size - HEADER, bytesLabel(size - HEADER)));
                const flagText = [flags & 1 ? 'frames are icons' : 'frames are bare bitmaps', flags & 2 ? 'steps follow "seq "' : 'one step a frame'].join(', ');
                return {
                    name: 'Header',
                    offset: at,
                    length: size,
                    value: `${plural(count, 'frame')}, ${plural(steps, 'step')}`,
                    children: [
                        field('Header size', at, 4, own, '36.'),
                        field('Frames', at + 4, 4, count, 'Different pictures.'),
                        field('Steps', at + 8, 4, steps, 'Pictures shown, one after another, before it starts over.'),
                        field('Width', at + 12, 4, w, 'Left at 0: each frame says its own.'),
                        field('Height', at + 16, 4, h),
                        field('Bits a pixel', at + 20, 4, bits),
                        field('Planes', at + 24, 4, planes),
                        field('Time a step', at + 28, 4, `${jiffies} jiffies (${(jiffies / 60).toFixed(2)} s)`, 'For steps "rate" doesn’t give: a jiffy is 1/60 s.'),
                        field('Flags', at + 32, 4, flagText, '1: the frames are icons (.ico, .cur); 2: "seq " says the order.'),
                    ],
                };
            }
            if (id === 'rate' || id === 'seq ') {
                const list = u32s(at, size);
                if (id === 'rate') rates ??= list;
                else sequence ??= list;
                if (size % 4) kids.push(field('Left over', at + size - (size % 4), size % 4, bytesLabel(size % 4)));
                return {
                    name: id === 'rate' ? 'Times' : 'Sequence',
                    offset: at,
                    length: size,
                    value: `${plural(list.length, 'step')}: ${list.slice(0, 16).join(', ')}${list.length > 16 ? ', …' : ''}`,
                    note: id === 'rate' ? 'Each step’s time, in jiffies (1/60 s).' : 'The frame each step shows, from 0.',
                };
            }
            if (id === 'LIST' && size >= 4) {
                const form = b.ascii(at, 4);
                kids.push(field('Form', at, 4, form));
                if (form === 'INFO') {
                    const inside = chunks(at + 4, at + size, 'in the INFO list ', (tag, t, n) => {
                        const value = text(t, n);
                        info[tag] = value;
                        const name = { INAM: 'Title', IART: 'Author', ICOP: 'Copyright', ICMT: 'Comment' }[tag] ?? `Text ${JSON.stringify(tag)}`;
                        return { name, offset: t, length: n, value: JSON.stringify(value) };
                    });
                    return { name: 'About it', offset: at, length: size, children: inside };
                }
                if (form === 'fram') {
                    framesSeen = true;
                    const inside = chunks(at + 4, at + size, 'in the frames ', (tag, t, n) => {
                        if (tag !== 'icon') return null;
                        const index = frames.length + 1;
                        const frame: Frame = { at: t, size: n, cursor: data[t + 2] === 2 };
                        frames.push(frame);
                        let read: Parsed | null = null;
                        try {
                            read = ico.parse(data.subarray(t, t + n), { name: null, names: [] }) as Parsed;
                        } catch (e) {
                            warnings.push(`Frame ${index} isn’t an icon or cursor: ${e instanceof Error ? e.message : e}`);
                            return { name: `Frame ${index}`, offset: t, length: n, value: bytesLabel(n) };
                        }
                        for (const w of read.warnings) warnings.push(`Frame ${index}: ${w}`);
                        const pictures = read.preview?.kind === 'stack' ? read.preview.items.map((i) => i.preview) : read.preview ? [read.preview] : [];
                        for (const p of pictures) if (p.kind === 'picture' && (!frame.picture || p.width * p.height > frame.picture.width * frame.picture.height)) frame.picture = p;
                        const used = read.end ?? n;
                        if (used < n) {
                            if (data.subarray(t + used, t + n).some((v) => v)) warnings.push(`Frame ${index} has ${bytesLabel(n - used)} after its pictures that nothing reads.`);
                            read.fields.push(field('After the pictures', used, n - used, bytesLabel(n - used)));
                        }
                        return {
                            name: `Frame ${index}`,
                            offset: t,
                            length: n,
                            value: frame.picture ? `${frame.cursor ? 'cursor' : 'icon'}, ${frame.picture.width} × ${frame.picture.height}` : bytesLabel(n),
                            children: moved(read.fields, t),
                        };
                    });
                    return { name: 'Frames', offset: at, length: size, value: plural(frames.length, 'frame'), children: inside };
                }
                return { name: `List ${JSON.stringify(form)}`, offset: at, length: size, value: bytesLabel(size), note: 'Not one an animated cursor has; Windows skips it.' };
            }
            return null;
        });
        fields.push(...top);

        if (!header && !frames.length) throw new Error('This isn’t an animated cursor: it has neither a header ("anih") nor frames.');
        // What Windows needs to play it, and what doesn't agree.
        const h = header ?? { frames: frames.length, steps: frames.length, jiffies: 10, flags: 1 };
        if (!header) warnings.push('It has no header ("anih"): Windows won’t load it. It’s played here one frame a step, 10 jiffies each.');
        if (!framesSeen) warnings.push('It has no list of frames ("LIST" of the form "fram"): there’s nothing to show.');
        else if (h.frames !== frames.length)
            warnings.push(`Its header says it has ${plural(h.frames, 'frame')}, but ${frames.length.toLocaleString('en-US')} ${frames.length === 1 ? 'is' : 'are'} there.`);
        if (!(h.flags & 1) && frames.length) warnings.push('Its header says the frames are bare bitmaps, not icons: Windows reads them as bitmaps with no hot spot.');
        if (h.flags & 2 && !sequence) warnings.push('Its header says the steps follow a sequence, but it has none ("seq "): Windows won’t load it.');
        if (!(h.flags & 2) && sequence) warnings.push('It has a sequence ("seq "), but its header doesn’t say to follow it: Windows ignores it.');
        const order: number[] = h.flags & 2 && sequence ? sequence : Array.from({ length: Math.min(h.steps, frames.length) }, (_, i) => i);
        if (h.flags & 2 && sequence) {
            if (sequence.length !== h.steps) warnings.push(`Its sequence has ${plural(sequence.length, 'step')}, but its header says ${h.steps.toLocaleString('en-US')}.`);
            const past = sequence.findIndex((f) => f >= frames.length);
            if (past >= 0) warnings.push(`Step ${past + 1} of its sequence shows frame ${sequence[past]}, but the frames are numbered 0 to ${frames.length - 1}: Windows won’t load it.`);
        } else if (h.steps > h.frames) warnings.push(`Its header says it takes ${plural(h.steps, 'step')}, but without a sequence it can only take one a frame (${h.frames.toLocaleString('en-US')}).`);
        if (rates && rates.length !== h.steps) warnings.push(`It gives times for ${plural(rates.length, 'step')}, but its header says ${h.steps.toLocaleString('en-US')}.`);

        // The animation: each step's frame, for its time.
        const steps = order.map((f, i) => ({ frame: frames[f]?.picture ? f : -1, jiffies: Math.max(1, rates?.[i] ?? h.jiffies) })).filter((s) => s.frame >= 0);
        const drawn = frames.filter((f) => f.picture);
        const width = drawn.length ? maxOf(drawn.map((f) => f.picture!.width)) : 0;
        const height = drawn.length ? maxOf(drawn.map((f) => f.picture!.height)) : 0;
        const seconds = steps.reduce((n, s) => n + s.jiffies, 0) / 60;
        let preview: Preview | undefined;
        if (steps.length === 1 || (drawn.length && !steps.length)) {
            const p = (steps.length ? frames[steps[0].frame] : drawn[0]).picture!;
            preview = { kind: 'picture', ...p };
        } else if (steps.length > 1) {
            // Frames of another size are drawn in the top left: every step the same size, as a video needs.
            const made = new Map<number, Uint8Array>();
            const canvas = (f: number) => {
                const p = frames[f].picture!;
                if (p.width === width && p.height === height) return p.rgba;
                let c = made.get(f);
                if (!c) {
                    c = pixelBuffer(width, height, 4, `Frame ${f + 1}`);
                    for (let y = 0; y < p.height; y++) c.set(p.rgba.subarray(y * p.width * 4, (y + 1) * p.width * 4), y * width * 4);
                    made.set(f, c);
                }
                return c;
            };
            // A video has one rate: tick at the times' common divisor, and show each step for as many ticks as its time.
            const tick = steps.map((s) => s.jiffies).reduce(gcd);
            const ends: number[] = [];
            let total = 0;
            for (const s of steps) ends.push((total += s.jiffies / tick));
            preview = {
                kind: 'video',
                width,
                height,
                frameCount: total,
                fps: 60 / tick,
                transparent: true,
                frame(index) {
                    let lo = 0;
                    let hi = ends.length - 1;
                    while (lo < hi) {
                        const mid = (lo + hi) >> 1;
                        if (ends[mid] > index) hi = mid;
                        else lo = mid + 1;
                    }
                    // A copy each time: what goes to the page is handed over, and gone from here after.
                    return { rgba: canvas(steps[lo].frame).slice() };
                },
            };
        }

        const stem = (context.name ?? context.label ?? 'cursor').replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '');
        const entries: Entry[] = frames.map((f, i) => {
            const ext = f.cursor ? 'cur' : 'ico';
            return { name: null, label: `${stem}-frame-${i + 1}.${ext}`, offset: f.at, size: f.size, data: data.subarray(f.at, f.at + f.size), format: 'ico' };
        });
        const summary: [string, string][] = [];
        if (info.INAM) summary.push(['Title', info.INAM]);
        if (info.IART) summary.push(['Author', info.IART]);
        summary.push(['Frames', `${frames.length.toLocaleString('en-US')}${width ? `, ${width} × ${height}` : ''}`]);
        if (steps.length > 1) summary.push(['Plays', `${plural(steps.length, 'step')} in ${seconds.toFixed(2)} s${sequence && h.flags & 2 ? ', in its own order' : ''}, then again`]);

        return {
            title: 'Animated cursor (ANI)',
            summary,
            fields: fillGaps(data, fields, 0, end, 'Not read'),
            preview,
            entries,
            end,
            warnings,
        };
    },
};

export default parser;
