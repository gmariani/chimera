/**
 * Sample files made from scratch: a small, valid file of each format that can
 * be made without the original tools, so there's something real to open and
 * test against that's ours to commit. `npm run samples` writes them to
 * samples/generated/; a test makes them again and checks the committed ones
 * still match, and that each reads as its format with nothing to warn about.
 *
 * Everything is worked out here, with nothing random, so the same bytes come
 * out every time. This runs in Node (the script, without a bundler, and the
 * tests), so it imports only the plain test encoders.
 */
import { dune2Compress, lcwLiterals, lzw, rle } from '../formats/westwood/encoders.test-util.ts';

export interface Sample {
    name: string;
    /** The format it must read as. */
    format: string;
    /** What it shows, for the samples' README. */
    about: string;
    data: Uint8Array;
}

const enc = new TextEncoder();
const u16 = (v: number) => [v & 0xff, (v >> 8) & 0xff];
const u32 = (v: number) => [...u16(v & 0xffff), ...u16(v >>> 16)];
const be32 = (v: number) => [v >>> 24, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
const text = (s: string) => Array.from(enc.encode(s));
const bytes = (...parts: ArrayLike<number>[]) => Uint8Array.from(parts.flatMap((p) => Array.from(p)));

// Pictures

/**
 * A 320 × 200 test card in 16 colors: a band of each color across the top, a
 * checkerboard, a diagonal, and a frame round the edge. Small enough in 16
 * colors for the 4-bit formats, and plain enough to see at once if it's wrong.
 */
export function testCard(width = 320, height = 200): Uint8Array {
    const p = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let v: number;
            if (x === 0 || y === 0 || x === width - 1 || y === height - 1) v = 15;
            else if (y < height / 4) v = Math.floor((x * 16) / width);
            else if (y < height / 2) v = ((x >> 3) + (y >> 3)) & 1 ? 7 : 8;
            else v = Math.abs(x - (y - height / 2) * 2) < 3 ? 14 : 1 + (((x >> 5) + (y >> 5)) % 6);
            p[y * width + x] = v;
        }
    }
    return p;
}

/** The 16 EGA colors, then a gray ramp, as a VGA palette: 6 bits a channel. */
export function palette6(): Uint8Array {
    const ega = [0x000000, 0x0000aa, 0x00aa00, 0x00aaaa, 0xaa0000, 0xaa00aa, 0xaa5500, 0xaaaaaa, 0x555555, 0x5555ff, 0x55ff55, 0x55ffff, 0xff5555, 0xff55ff, 0xffff55, 0xffffff];
    const p = new Uint8Array(768);
    for (let i = 0; i < 256; i++) {
        const rgb = i < 16 ? ega[i] : Math.round(((i - 16) * 255) / 239) * 0x010101;
        p.set(
            [(rgb >> 16) & 0xff, (rgb >> 8) & 0xff, rgb & 0xff].map((c) => c >> 2),
            i * 3
        );
    }
    return p;
}

/**
 * A Miles AIL 2 digital sound driver as Miles laid them out (DMASOUND.ASM): where the function table is, the copyright
 * ending in 0x1A, the table (ending 0xFFFF), the description table and its device names, then the code: here each
 * function is a bare far return (0xCB), so nothing would happen if one were called.
 */
export function ailDriver(): Uint8Array {
    const copyright = text('Copyright (C) 2026 Chimera sample, not a real driver.\x1a');
    const functions = [100, 101, 102, 104, 123, 124, 125, 126];
    const table = 2 + copyright.length;
    const description = table + functions.length * 4 + 2;
    const names = text('Sample Sound Card\0Its Twin\0\0');
    const code = description + 24 + names.length;
    return bytes(
        u16(table),
        copyright,
        ...functions.map((f, i) => [...u16(f), ...u16(code + i)]),
        u16(0xffff),
        // Needs AIL 2.00; type 2 (digital); plays VOC files; the names; port 0x220, IRQ 7, DMA 1, no DRQ; no timer; no display.
        u16(200),
        u16(2),
        text('VOC\0'),
        u16(description + 24),
        u16(0),
        u16(0x220),
        u16(7),
        u16(1),
        u16(0xffff),
        u16(0xffff),
        u16(0),
        names,
        functions.map(() => 0xcb)
    );
}

/**
 * Westwood AdLib music (.adl) as Dune II's are laid out (version 3): the track table, where each program and instrument is
 * (counting from the end of the track table), then the data. Track 0 starts the conductor (voice 9), which sets the tempo
 * and starts programs 1 and 2. Program 1, on voice 0, loops two notes with a count of 0xBB, as Westwood's tools do (the
 * repeat lands on the count, which as a command does nothing). Program 2, on voice 1, plays a note, jumps to the next
 * command, rests and stops. Then two instruments. `version` picks the tables' sizes; `change` alters the data before the
 * offsets are worked out.
 */
export function adlMusic({ version = 3, count = 0xbb, change }: { version?: 1 | 3 | 4; count?: number; change?: (programs: number[][]) => void } = {}): Uint8Array {
    const slots = version === 1 ? 150 : version === 4 ? 500 : 250;
    const programs = [
        // Voice 9, priority 0x10: tempo 0x40, start programs 1 and 2, stop.
        [9, 0x10, 0xa6, 0x40, 0x82, 1, 0x82, 2, 0x88],
        // Voice 0, priority 0x20: instrument 0, repeat count, two notes, repeat back to the count (8 back from after itself), stop.
        [0, 0x20, 0x90, 0, 0x80, count, 0x45, 0x10, 0x47, 0x10, 0x81, ...u16(-8 & 0xffff), 0x88],
        // Voice 1, priority 0x20: instrument 1, a note, a jump to the next command, a rest, stop.
        [1, 0x20, 0x90, 1, 0x30, 0x20, 0x84, 0, 0, 0x89, 0x10, 0x88],
    ];
    change?.(programs);
    // A soft organ and a bright bell, register by register (0x20, 0x23, 0xC0, 0xE0, 0xE3, 0x40, 0x43, 0x60, 0x63, 0x80, 0x83).
    const instruments = [
        [0x21, 0x21, 0x0e, 0, 0, 0x1a, 0x00, 0xf1, 0xf1, 0x55, 0x55],
        [0x07, 0x12, 0x01, 0, 0, 0x4f, 0x00, 0xf2, 0xf2, 0x60, 0x72],
    ];
    const tracks = version === 4 ? [...u16(0), ...new Array(498).fill(0xff)] : [0, ...new Array(119).fill(0xff)];
    const table = new Array(slots * 4).fill(0xff);
    let at = slots * 4;
    const body: number[] = [];
    const place = (list: number[][], from: number) =>
        list.forEach((item, i) => {
            table.splice((from + i) * 2, 2, ...u16(at));
            body.push(...item);
            at += item.length;
        });
    place(programs, 0);
    place(instruments, slots);
    return bytes(tracks, table, body);
}

/**
 * Dune II's DUNE.CFG as SETUP.EXE writes it: graphics 12; music on the MT-32 (6), effects through Westwood's AdLib player
 * (1), voices on a Sound Blaster Pro (2); the mouse and extended memory on; German. Each of the first 8 stored as
 * (value + n) XOR 0xA5, n from 7 down; the language as it is; then the checksum.
 */
export function duneCfg(values = [12, 6, 1, 2, 1, 1, 0, 0], language = 2): Uint8Array {
    const sum = values.reduce((s, v) => s + v, 0) & 0xff;
    return Uint8Array.from([...values.map((v, i) => ((v + 7 - i) & 0xff) ^ 0xa5), language, sum ^ 0xa5]);
}

/** Dune II's OPTIONS.CFG with the game's defaults: music and sounds on, normal speed, hints on, auto-scroll off. */
export function duneOptions(values = [1, 1, 2, 1, 0]): Uint8Array {
    return bytes(...values.map(u16));
}

/**
 * A Dune II script (EMC) in the game's own style, for the computer's teams: a subroutine at word 0 (wait 30 ticks,
 * return), then Normal's loop at 4, which calls it ("push where to come back to", then a jump), compares the team's
 * members with 5, and switches back to the team's first script; Flee's, at 14, returns at once. The FORM's size counts the
 * whole file, as Westwood's compiler wrote it. `change` alters the instructions before they're written.
 */
export function emcScript({ entries = [4, 4, 14, 4, 4], change }: { entries?: number[]; change?: (words: number[]) => void } = {}): Uint8Array {
    // prettier-ignore
    const code = [
        0x4300 | 30, 0x4e00, 0x4c01, 0x4801, // push 30, call routine 0 (wait), drop 1, return from a call
        0x4201, 0x8000, // push where to come back to, jump to 0
        0x4e02, 0x4200, 0x4405, 0x5104, 0x2f00, 0x8004, // call routine 2 (members), push the result, push 5, <, jump to 4 if zero
        0x4e09, 0x8004, // call routine 9 (back to the first script), jump to 4
        0x4801, // Flee: return from a call
    ];
    change?.(code);
    const be16 = (v: number) => [(v >> 8) & 0xff, v & 0xff];
    const chunk = (id: string, words: number[]) => [...text(id), ...be32(words.length * 2), ...words.flatMap(be16)];
    const body = [...text('EMC2'), ...chunk('ORDR', entries), ...chunk('DATA', code)];
    return bytes(text('FORM'), be32(8 + body.length), body);
}

/** A note for xmidiMusic: when it starts and how long it lasts, in the player's 120ths of a second, on which channel. */
export interface XmidiNote {
    time: number;
    channel: number;
    note: number;
    velocity: number;
    length: number;
}

/** The notes of xmidiMusic's two sequences: a phrase on channel 1 with a pause of 300 ticks, and a chord on channel 2. */
export const XMIDI_NOTES: XmidiNote[][] = [
    [
        { time: 0, channel: 0, note: 60, velocity: 100, length: 60 },
        { time: 60, channel: 0, note: 64, velocity: 90, length: 60 },
        { time: 420, channel: 0, note: 67, velocity: 80, length: 240 },
    ],
    [
        { time: 10, channel: 1, note: 48, velocity: 70, length: 120 },
        { time: 10, channel: 1, note: 52, velocity: 70, length: 120 },
        { time: 10, channel: 1, note: 55, velocity: 70, length: 200 },
    ],
];

/** Where xmidiMusic's loop ends, in ticks: after the first sequence's last note (420 + 240). */
export const LOOP_END = 700;

/**
 * XMIDI music as Miles's MIDIFORM wrote it: FORM XDIR with INFO (2 sequences, little-endian), then CAT XMID with a FORM
 * XMID for each. The first has a TIMB chunk (one instrument, patch 5 of bank 1), a program change, a tempo event, and
 * XMIDI_NOTES[0]; the second an RBRN chunk (branch 0 at its first note) and XMIDI_NOTES[1]. Times are interval bytes below
 * 0x80, added up; each note-on carries its length; there are no note-offs. With `loop`, the first sequence's notes are
 * wrapped in a FOR (controller 116, the count given) at time 0 and a NEXT (117, the value given) at LOOP_END; `loops` nests
 * that many FORs (each count 1) around them.
 */
export function xmidiMusic({ loop, loops = 1 }: { loop?: [count: number, next: number]; loops?: number } = {}): Uint8Array {
    const vlq = (v: number) => {
        const out = [v & 0x7f];
        for (v >>= 7; v > 0; v >>= 7) out.unshift((v & 0x7f) | 0x80);
        return out;
    };
    const intervals = (ticks: number) => {
        const out: number[] = [];
        for (; ticks > 127; ticks -= 127) out.push(127);
        if (ticks) out.push(ticks);
        return out;
    };
    const chunk = (id: string, body: number[]) => [...text(id), ...be32(body.length), ...body, ...(body.length & 1 ? [0] : [])];
    const events = (notes: XmidiNote[], before: number[], wrap?: [number, number]) => {
        const out = [...before];
        if (wrap) for (let k = 0; k < loops; k++) out.push(0xb0, 116, k === loops - 1 ? wrap[0] : 1);
        let now = 0;
        for (const n of notes) {
            out.push(...intervals(n.time - now), 0x90 | n.channel, n.note, n.velocity, ...vlq(n.length));
            now = n.time;
        }
        if (wrap) {
            out.push(...intervals(LOOP_END - now));
            now = LOOP_END;
            for (let k = 0; k < loops; k++) out.push(0xb0, 117, k === 0 ? wrap[1] : 127);
        }
        return [...out, 0xff, 0x2f, 0x00];
    };
    const form0 = [
        ...text('XMID'),
        ...chunk('TIMB', [...u16(1), 5, 1]),
        // Program 5 on channel 1, and a tempo event (which the player ignores) of 400,000 µs a beat.
        ...chunk('EVNT', events(XMIDI_NOTES[0], [0xc0, 5, 0xff, 0x51, 0x03, 0x06, 0x1a, 0x80], loop)),
    ];
    const form1 = [...text('XMID'), ...chunk('RBRN', [...u16(1), ...u16(0), ...u32(1)]), ...chunk('EVNT', events(XMIDI_NOTES[1], []))];
    const cat = [...text('XMID'), ...[form0, form1].flatMap((f) => [...text('FORM'), ...be32(f.length), ...f])];
    return bytes(chunk('FORM', [...text('XDIR'), ...chunk('INFO', u16(2))]), text('CAT '), be32(cat.length), cat);
}

/**
 * A standard MIDI file, format 1 at 480 ticks a beat: track 1 the tempo (500,000 µs a beat, then 250,000 from tick 480),
 * track 2 named "Melody", program 40 on channel 1, a note from 0 to 480 and one from 960 to 1440, the second pair written
 * with running status (and a velocity-0 note-on for its note-off), and a system-exclusive message.
 */
export function standardMidi(): Uint8Array {
    const track = (events: number[]) => [...text('MTrk'), ...be32(events.length), ...events];
    // A delay of 480 is 0x83 0x60 as a variable-length number.
    const tempo = track([0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20, 0x83, 0x60, 0xff, 0x51, 0x03, 0x03, 0xd0, 0x90, 0x00, 0xff, 0x2f, 0x00]);
    const melody = track([
        ...[0x00, 0xff, 0x03, 0x06, ...text('Melody')],
        ...[0x00, 0xc0, 40],
        ...[0x00, 0xf0, 0x03, 0x41, 0x10, 0xf7],
        ...[0x00, 0x90, 60, 100],
        ...[0x83, 0x60, 0x80, 60, 64],
        ...[0x83, 0x60, 0x90, 64, 90],
        ...[0x83, 0x60, 64, 0],
        ...[0x00, 0xff, 0x2f, 0x00],
    ]);
    return bytes(text('MThd'), be32(6), [0, 1, 0, 2, 0x01, 0xe0], tempo, melody);
}

/**
 * A remap like Dune II's GRAYRMAP.TBL, for that palette: color 0 (see-through) and the grays stay as they are, and each
 * EGA color becomes the gray of its brightness.
 */
export function grayRemap(): Uint8Array {
    const p = palette6();
    return Uint8Array.from({ length: 256 }, (_, i) => {
        if (i === 0 || i >= 16) return i;
        const light = 0.3 * p[i * 3] + 0.59 * p[i * 3 + 1] + 0.11 * p[i * 3 + 2];
        return 16 + Math.round((light / 63) * 239);
    });
}

/** CPS: the file size, the compression, the decoded size, the palette size, the palette, the picture. */
function cps(compression: number, body: ArrayLike<number>, { size = 64000, pal = palette6() as ArrayLike<number> } = {}): Uint8Array {
    const rest = [...u16(compression), ...u32(size), ...u16(pal.length), ...Array.from(pal), ...Array.from(body)];
    return bytes(u16(rest.length), rest);
}

/** The test card as five Amiga bit planes: plane n holds bit n of each pixel, the leftmost in bit 7. */
function planes(pixels: Uint8Array): Uint8Array {
    const out = new Uint8Array(40000);
    for (let i = 0; i < 64000; i++) for (let p = 0; p < 5; p++) if ((pixels[i] >> p) & 1) out[p * 8000 + (i >> 3)] |= 0x80 >> (i & 7);
    return out;
}

/** An Amiga palette: 32 colors, each a big-endian 0RGB of 4 bits a channel. */
function amigaPalette(): number[] {
    const p6 = palette6();
    return Array.from({ length: 32 }, (_, i) => {
        const [r, g, b] = [p6[i * 3] >> 2, p6[i * 3 + 1] >> 2, p6[i * 3 + 2] >> 2];
        return [r, (g << 4) | b];
    }).flat();
}

/** An old CMP: the size, the type, the decoded size for the LZW types, the picture. */
function cmp(type: number, body: ArrayLike<number>): Uint8Array {
    const rest = [type, ...(type === 3 || type === 6 ? u16(64000) : []), ...Array.from(body)];
    return bytes(u16(rest.length), rest);
}

/** Two pixels a byte, the left one high. */
const pack4 = (p: Uint8Array) => Uint8Array.from({ length: p.length / 2 }, (_, i) => (p[i * 2] << 4) | p[i * 2 + 1]);

/**
 * zlib's format with the data stored, not compressed: blocks of up to 65,535 bytes, each with its length, then a checksum.
 * (Compressing would tie the bytes to a zlib version, and the committed samples have to come out the same everywhere.)
 */
function zlibStored(data: Uint8Array): number[] {
    const out = [0x78, 0x01];
    for (let i = 0; i < data.length || i === 0; i += 65535) {
        const n = Math.min(65535, data.length - i);
        out.push(i + n >= data.length ? 1 : 0, ...u16(n), ...u16(~n & 0xffff), ...data.subarray(i, i + n));
        if (!data.length) break;
    }
    let [a, b] = [1, 0];
    for (const v of data) {
        a = (a + v) % 65521;
        b = (b + a) % 65521;
    }
    return [...out, ...be32(((b << 16) | a) >>> 0)];
}

/** PNG: RGB, 8 bits a channel, the data stored (see zlibStored). */
function png(width: number, height: number, rgb: (x: number, y: number) => [number, number, number]): Uint8Array {
    const crcTable = Array.from({ length: 256 }, (_, n) => {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        return c >>> 0;
    });
    const crc = (data: number[]) => {
        let c = 0xffffffff;
        for (const v of data) c = crcTable[(c ^ v) & 0xff] ^ (c >>> 8);
        return (c ^ 0xffffffff) >>> 0;
    };
    const chunk = (type: string, body: ArrayLike<number>) => {
        const typed = [...text(type), ...Array.from(body)];
        return [...be32(body.length), ...typed, ...be32(crc(typed))];
    };
    const raw: number[] = [];
    for (let y = 0; y < height; y++) {
        raw.push(0);
        for (let x = 0; x < width; x++) raw.push(...rgb(x, y));
    }
    return bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], chunk('IHDR', [...be32(width), ...be32(height), 8, 2, 0, 0, 0]), chunk('IDAT', zlibStored(Uint8Array.from(raw))), chunk('IEND', []));
}

// Sounds

/** A tone, as unsigned 8-bit samples. */
function tone8(count: number, period = 25): number[] {
    return Array.from({ length: count }, (_, i) => 128 + Math.round(100 * Math.sin((2 * Math.PI * i) / period)));
}

/** VOC: the 26-byte header (version 1.10), then blocks of a type and a 3-byte size. */
function voc(blocks: [number, number[]][]): Uint8Array {
    const version = 0x010a;
    const header = [...text('Creative Voice File\x1a'), ...u16(26), ...u16(version), ...u16((~version + 0x1234) & 0xffff)];
    return bytes(
        header,
        blocks.flatMap(([type, body]) => [type, body.length & 0xff, (body.length >> 8) & 0xff, body.length >> 16, ...body]),
        [0]
    );
}

/** AUD: the 12-byte header, then chunks of [stored, decoded size], each marked 0xDEAF. */
function aud(rate: number, flags: number, compression: number, chunks: [number[], number][]): Uint8Array {
    const body = chunks.flatMap(([data, out]) => [...u16(data.length), ...u16(out), ...u32(0xdeaf), ...data]);
    return bytes(u16(rate), u32(body.length), u32(chunks.reduce((n, [, out]) => n + out, 0)), [flags, compression], body);
}

/** WAV: a RIFF of a format chunk and the samples. */
function wav(rate: number, samples: number[]): Uint8Array {
    const fmt = [...u16(1), ...u16(1), ...u32(rate), ...u32(rate), ...u16(1), ...u16(8)];
    const body = [...text('WAVE'), ...text('fmt '), ...u32(fmt.length), ...fmt, ...text('data'), ...u32(samples.length), ...samples, ...(samples.length & 1 ? [0] : [])];
    return bytes(text('RIFF'), u32(body.length), body);
}

// Animations

/** A format 40 delta of the whole frame: runs of up to 127 bytes to XOR in, then the end. */
function format40(xor: Uint8Array): number[] {
    const out: number[] = [];
    for (let i = 0; i < xor.length; i += 127) {
        const n = Math.min(127, xor.length - i);
        out.push(n, ...xor.subarray(i, i + n));
    }
    return [...out, 0x80, 0, 0];
}

/** A small animation's frames: a square moving across a 32 × 16 strip. */
function strip(count: number): Uint8Array[] {
    return Array.from({ length: count }, (_, f) => {
        const p = new Uint8Array(32 * 16).fill(1);
        for (let y = 4; y < 12; y++) for (let x = 0; x < 8; x++) p[y * 32 + f * 6 + x] = 14;
        return p;
    });
}

/** A WSA in one of its three layouts: each frame the XOR against the one before, as format 40, then LCW. */
function wsa(layout: 'cnc' | 'dune2-100' | 'dune2-107'): Uint8Array {
    const frames = strip(4);
    const bodies = frames.map((f, i) => lcwLiterals(Uint8Array.from(format40(f.map((v, k) => v ^ (i ? frames[i - 1][k] : 0))))));
    const largest = Math.max(...frames.map((f) => format40(f).length));
    const header =
        layout === 'cnc'
            ? [...u16(4), ...u16(0), ...u16(0), ...u16(32), ...u16(16), ...u16(largest), ...u16(0)]
            : [...u16(4), ...u16(32), ...u16(16), ...u16(largest), ...(layout === 'dune2-107' ? u16(0) : [])];
    let at = header.length + (frames.length + 2) * 4;
    const offsets: number[] = [];
    for (const b of bodies) {
        offsets.push(at);
        at += b.length;
    }
    offsets.push(at, 0);
    return bytes(header, offsets.flatMap(u32), bodies.flat());
}

// Archives

/** A Westwood PAK of these files, as its version writes the header. */
function pak(version: 1 | 2 | 3, files: [string, Uint8Array][]): Uint8Array {
    const names = files.map(([n]) => [...text(n), 0]);
    const headerSize = names.reduce((n, name) => n + 4 + name.length, 0) + (version === 2 ? 0 : 5) + (version === 1 ? 0 : 4);
    const header: number[] = [];
    let at = headerSize;
    for (const [i, [, data]] of files.entries()) {
        header.push(...u32(at), ...names[i]);
        at += data.length;
    }
    if (version !== 2) header.push(...u32(at), 0);
    if (version !== 1) header.push(...u32(0));
    return bytes(header, ...files.map(([, d]) => d));
}

// Tiles and fonts

/** Dune II map tiles: 16 × 16 tiles from the test card, two palettes (one with see-through 0), and which each uses. */
export function icn(): Uint8Array {
    const card = testCard();
    const tiles: number[] = [];
    const count = 8;
    for (let t = 0; t < count; t++) for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x += 2) tiles.push((card[(y + 52) * 320 + t * 16 + x] << 4) | card[(y + 52) * 320 + t * 16 + x + 1]);
    const chunk = (id: string, body: number[]) => [...text(id), ...be32(body.length), ...body, ...(body.length & 1 ? [0] : [])];
    const sset = [...u16(0), ...u32(tiles.length), ...u16(0), ...tiles];
    // Palette 0 is opaque (its first color is dark gray, not 0); palette 1 starts with 0, so the game leaves that color see-through.
    const rpal = [8, ...Array.from({ length: 15 }, (_, i) => i + 1), 0, ...Array.from({ length: 15 }, (_, i) => i + 1)];
    const body = [
        ...chunk('SINF', [2, 2, 3, 4]),
        ...chunk('SSET', sset),
        ...chunk('RPAL', rpal),
        ...chunk(
            'RTBL',
            Array.from({ length: count }, (_, i) => i & 1)
        ),
    ];
    return bytes(text('FORM'), be32(4 + body.length), text('ICON'), body);
}

/**
 * Dune II's ICON.MAP for those 8 tiles: the 26 groups the game reads, each a tile or two (a building, one state of its
 * footprint), then the 0 that ends the index.
 */
export function iconMap(): Uint8Array {
    // How many tiles each group has: 10 that aren't buildings, then the buildings' footprints (OpenDUNE's layouts).
    const sizes = [1, 1, 1, 1, 2, 2, 2, 1, 2, 1, 9, 4, 6, 6, 4, 4, 4, 4, 4, 9, 6, 6, 1, 1, 4, 4];
    const index = [sizes.length + 1];
    const tiles: number[] = [];
    for (const n of sizes) {
        index.push(sizes.length + 2 + tiles.length);
        for (let i = 0; i < n; i++) tiles.push((tiles.length * 3) % 8);
    }
    index.push(0);
    return bytes(...index.map(u16), ...tiles.map(u16));
}

/** The glyphs of "CHIMERA" in a 5 × 7 font, one byte a row (the leftmost pixel in the high bit). */
const GLYPHS: Record<string, number[]> = {
    A: [0x70, 0x88, 0x88, 0xf8, 0x88, 0x88, 0x88],
    C: [0x70, 0x88, 0x80, 0x80, 0x80, 0x88, 0x70],
    E: [0xf8, 0x80, 0x80, 0xf0, 0x80, 0x80, 0xf8],
    H: [0x88, 0x88, 0x88, 0xf8, 0x88, 0x88, 0x88],
    I: [0x70, 0x20, 0x20, 0x20, 0x20, 0x20, 0x70],
    M: [0x88, 0xd8, 0xa8, 0xa8, 0x88, 0x88, 0x88],
    R: [0xf0, 0x88, 0x88, 0xf0, 0xa0, 0x90, 0x88],
};
const glyph = (c: string) => [GLYPHS[c] ? 5 : 0, ...(GLYPHS[c] ?? new Array(7).fill(0))];
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** RA2's map editor font: 48 bytes of header, then a glyph from "A" to "Z" (the letters not in CHIMERA left empty). */
function foNt(): Uint8Array {
    const first = 65;
    const last = first + LETTERS.length - 1;
    return bytes(text('FoNt'), u32(6), u32(1), u32(7), u32(7), u32(1), u32(8), u32(0x24), u32(0x30), u32(0), u32(first), u32(last), [...LETTERS].flatMap(glyph));
}

/** Nox's: 36 bytes of header, 16-bit first and last characters. */
function tNoF(): Uint8Array {
    return bytes(text('tNoF'), u32(1), u32(6), u32(1), u32(7), u32(1), u32(8), u32(0), u16(65), u16(65 + LETTERS.length - 1), [...LETTERS].flatMap(glyph));
}

// Windows

/**
 * A 16 × 16 icon in 16 colors as Windows stores one: a BITMAPINFOHEADER (the height doubled, for the mask), the 16 colors,
 * the pixels bottom row first at 4 bits each, then the mask, 1 bit each (1: see-through), each row padded to 4 bytes.
 * The picture: a diamond of color 12 on 1, with its corners see-through.
 */
export function iconDib(): number[] {
    const p6 = palette6();
    const colors = Array.from({ length: 16 }, (_, i) => [p6[i * 3 + 2] << 2, p6[i * 3 + 1] << 2, p6[i * 3] << 2, 0]).flat();
    const inside = (x: number, y: number) => Math.abs(x - 7.5) + Math.abs(y - 7.5) <= 8;
    const color = (x: number, y: number) => (Math.abs(x - 7.5) + Math.abs(y - 7.5) <= 4 ? 12 : 1);
    const rows: number[] = [];
    const mask: number[] = [];
    for (let y = 15; y >= 0; y--) {
        for (let x = 0; x < 16; x += 2) rows.push((inside(x, y) ? color(x, y) << 4 : 0) | (inside(x + 1, y) ? color(x + 1, y) : 0));
        let bits = 0;
        for (let x = 0; x < 16; x++) if (!inside(x, y)) bits |= 0x8000 >> x;
        mask.push(bits >> 8, bits & 0xff, 0, 0);
    }
    return [...u32(40), ...u32(16), ...u32(32), ...u16(1), ...u16(4), ...u32(0), ...u32(rows.length + mask.length), ...u32(0), ...u32(0), ...u32(0), ...u32(0), ...colors, ...rows, ...mask];
}

/**
 * A Windows 3 icon library: a 16-bit module (MZ, then NE) with no code, holding one icon and the group that lists it,
 * named CHIMERA. As icon editors made them, and as Dune II's DUNE2.ICO is.
 */
export function iconLibrary({ segments = 0 }: { segments?: number } = {}): Uint8Array {
    const icon = iconDib();
    const group = [...u16(0), ...u16(1), ...u16(1), 16, 16, 16, 0, ...u16(1), ...u16(4), ...u32(icon.length), ...u16(1)];
    const shift = 4;
    const align = (n: number) => Math.ceil(n / 16) * 16;
    // Laid out: the MZ header, the NE header at 0x40, the resource table at 0x80, the names, then the resources, 16-byte aligned.
    const resTable = 0x80;
    const resTableLength = 2 + (8 + 12) * 2 + 2 + 1;
    const resident = resTable + resTableLength;
    const name = [7, ...text('CHIMERA'), ...u16(0), 0];
    const after = resident + name.length;
    const groupAt = align(after);
    const iconAt = align(groupAt + group.length);
    const out = new Uint8Array(align(iconAt + icon.length));
    const v = new DataView(out.buffer);
    out.set(text('MZ'), 0);
    v.setUint32(0x3c, 0x40, true);
    const ne = 0x40;
    out.set(text('NE'), ne);
    out.set([5, 1], ne + 2);
    for (const [at, value] of [
        [0x04, after - ne], // the entry table (empty)
        [0x1c, segments],
        [0x22, resTable - ne], // the segment table (empty), where the resources start
        [0x24, resTable - ne],
        [0x26, resident - ne],
        [0x28, after - ne], // module references (none)
        [0x2a, after - ne], // imported names (none)
        [0x32, shift],
    ])
        v.setUint16(ne + at, value, true);
    out[ne + 0x36] = 2; // Windows
    out.set([0, 3], ne + 0x3e); // Windows 3.00
    const entry = (at: number, length: number, id: number) => [...u16(at >> shift), ...u16(Math.ceil(length / 16)), ...u16(0x1c30), ...u16(0x8000 | id), ...u32(0)];
    out.set([...u16(shift), ...u16(0x800e), ...u16(1), ...u32(0), ...entry(groupAt, group.length, 1), ...u16(0x8003), ...u16(1), ...u32(0), ...entry(iconAt, icon.length, 1), ...u16(0), 0], resTable);
    out.set(name, resident);
    out.set(group, groupAt);
    out.set(icon, iconAt);
    return out;
}

/** A 32 × 32 icon at 32 bits a pixel: a disc fading from opaque in the middle to see-through at its edge, with its own alpha. */
export function iconDib32(): number[] {
    const pixels: number[] = [];
    for (let y = 31; y >= 0; y--)
        for (let x = 0; x < 32; x++) {
            const r = Math.hypot(x - 15.5, y - 15.5);
            pixels.push(255 - x * 6, 40 + y * 6, 200, r > 15 ? 0 : Math.round(255 * Math.min(1, (15 - r) / 4)));
        }
    // The mask is all 0s: the alpha says what's see-through.
    const mask = new Array(32 * 4).fill(0);
    return [...u32(40), ...u32(32), ...u32(64), ...u16(1), ...u16(32), ...u32(0), ...u32(pixels.length + mask.length), ...u32(0), ...u32(0), ...u32(0), ...u32(0), ...pixels, ...mask];
}

/** A 32 × 32 arrow at 1 bit a pixel: white with a black edge, its hot spot at the tip (0, 0). */
export function cursorDib(): number[] {
    const inside = (x: number, y: number) => x <= y && x + y < 40 && y < 26;
    const edge = (x: number, y: number) => inside(x, y) && !(inside(x - 1, y) && inside(x + 1, y) && inside(x, y - 1) && inside(x, y + 1));
    const rows: number[] = [];
    const mask: number[] = [];
    for (let y = 31; y >= 0; y--) {
        let color = 0;
        let clear = 0;
        for (let x = 0; x < 32; x++) {
            if (inside(x, y) && !edge(x, y)) color |= 2 ** (31 - x);
            if (!inside(x, y)) clear |= 2 ** (31 - x);
        }
        rows.push(...be32(color));
        mask.push(...be32(clear));
    }
    return [
        ...u32(40),
        ...u32(32),
        ...u32(64),
        ...u16(1),
        ...u16(1),
        ...u32(0),
        ...u32(rows.length + mask.length),
        ...u32(0),
        ...u32(0),
        ...u32(2),
        ...u32(0),
        0,
        0,
        0,
        0,
        255,
        255,
        255,
        0,
        ...rows,
        ...mask,
    ];
}

/** An .ico or .cur: a 6-byte header, a 16-byte entry for each image (width, height, colors, 0, then planes and bits or the hot spot), then the images. */
export function iconFile(images: { image: ArrayLike<number>; width: number; height: number; colors?: number; planes?: number; bits?: number }[], type: 1 | 2 = 1): Uint8Array {
    let at = 6 + images.length * 16;
    const entries = images.flatMap((x) => {
        const e = [x.width & 0xff, x.height & 0xff, x.colors ?? 0, 0, ...u16(x.planes ?? 1), ...u16(x.bits ?? 32), ...u32(x.image.length), ...u32(at)];
        at += x.image.length;
        return e;
    });
    return bytes([0, 0, ...u16(type), ...u16(images.length)], entries, ...images.map((x) => x.image));
}

/**
 * Dune II's mentat encyclopedia, made small: a heading, a briefing topic (its text is the mission's), and a topic with its
 * animation, description and text. Each topic in NAME: its length, where its text is (big-endian), its heading's number, "0"
 * for a heading or "1" for a topic, its name and a NUL, the mission it's listed from. The texts in DESC are compressed.
 */
export function mentat(): Uint8Array {
    const topics: { section: string; heading: boolean; name: string; mission: number; text: string }[] = [
        { section: '0', heading: true, name: 'Briefing', mission: 0, text: 'No file?NO Desc' },
        { section: '0', heading: false, name: 'Advice', mission: 1, text: '3*No desc' },
        { section: '1', heading: true, name: 'Structures', mission: 0, text: 'No file?NO Desc' },
        { section: '1', heading: false, name: 'Wind Trap', mission: 1, text: 'windtrap.wsa*Wind Trap\rPower Output: 100 \fThe wind trap draws water from the air, and power from the wind.' },
    ];
    // The size byte, 4 bytes of where, the heading and kind, the name, its NUL, the mission.
    const entries = topics.map((t) => 1 + 4 + 2 + t.name.length + 1 + 1);
    const nameSize = entries.reduce((n, e) => n + e, 0);
    const texts = topics.map((t) => [...dune2Compress(t.text), 0]);
    const descStart = 12 + 8 + nameSize + (nameSize & 1) + 8;
    let at = descStart;
    const name: number[] = [];
    topics.forEach((t, i) => {
        name.push(entries[i], ...be32(at), t.section.charCodeAt(0), t.heading ? 0x30 : 0x31, ...text(t.name), 0, t.mission);
        at += texts[i].length;
    });
    const desc = texts.flat();
    const chunk = (id: string, body: number[]) => [...text(id), ...be32(body.length), ...body, ...(body.length & 1 ? [0] : [])];
    const longest = Math.max(...texts.map((t) => t.length));
    const body = [...chunk('NAME', name), ...chunk('DESC', desc), ...chunk('INFO', [0, 0, 0, 0, 0, 0, 0, 0, ...be32(longest)])];
    return bytes(text('FORM'), be32(4 + body.length), text('MENT'), body);
}

/**
 * Dune II's credits (CREDITS.ENG), as 1.07's: a title, a role with two names (the first sharing its row, after 0x05), a
 * centered line with no style byte, the small print, blank rows, and the NUL that ends them. `extra` goes before the NUL.
 */
export function duneCredits(extra = ''): Uint8Array {
    return bytes(text(`\x02CHIMERA\r\r\x03Samples By:\x05\x04Chimera\r\x04Its Tests\r\r\rAnd you\r\r\x01(c) 2026 Chimera sample, not the game's.\r\r${extra}`), [0]);
}

/**
 * A DOS program as Borland's TLINK lays one out with overlays, as Dune II's is: an 80-byte header with TLINK's mark and two
 * relocations (at 0x3E, where TLINK puts them), then a 160-byte image in segments of 16 bytes each:
 *
 * - 0x0000, code: sets DS to the data segment, calls the overlay through its stub, prints the message, and exits;
 * - 0x0002, data: the message, ending in "$" as DOS prints it;
 * - 0x0004, the overlay's stub: INT 3Fh, where the overlay's code is, and one entry point;
 * - 0x0007, data: TLINK's table of the segments, with the stack's (0x000A, in the memory DOS adds).
 *
 * After the image, the overlays: the FBOV header, then the overlay's code (loading the data segment into AX, through a
 * fixup naming segment entry 1) and its fixup. `fixup` changes the fixup's offset; the checksum is set to match.
 */
export function dosProgram({ fixup = 1 }: { fixup?: number } = {}): Uint8Array {
    const pad = (b: number[], n: number) => [...b, ...Array<number>(n - b.length).fill(0)];
    const code = pad([0xb8, ...u16(2), 0x8e, 0xd8, 0x9a, ...u16(0x20), ...u16(4), 0xb4, 0x09, 0xba, ...u16(0), 0xcd, 0x21, 0xb8, ...u16(0x4c00), 0xcd, 0x21], 32);
    const message = pad(text('Hello from Chimera.$'), 32);
    const overlay = [0xb8, ...u16(1 << 3), 0xcb];
    const stub = pad([0xcd, 0x3f, ...u16(0), ...u32(0), ...u16(overlay.length), ...u16(2), ...u16(1), ...u16(0), ...Array<number>(16).fill(0), 0xcd, 0x3f, ...u16(0), 0], 48);
    const table = pad(
        [
            [0, 22, 1],
            [2, 20, 4],
            [4, 37, 3],
            [7, 40, 4],
            [10, 0x100, 4],
        ].flatMap(([s, size, flags]) => [...u16(s), ...u16(size), ...u16(flags), ...u16(0)]),
        48
    );
    const image = [...code, ...message, ...stub, ...table];
    const headerSize = 80;
    const end = headerSize + image.length;
    const header = pad(
        [
            ...text('MZ'),
            ...u16(end % 512),
            ...u16(Math.ceil(end / 512)),
            ...u16(2),
            ...u16(headerSize / 16),
            ...u16(0x10),
            ...u16(0xffff),
            ...u16(10),
            ...u16(0x100),
            ...u16(0),
            ...u16(0),
            ...u16(0),
            ...u16(0x3e),
            ...u16(0),
            ...u16(1),
            0xfb,
            0x50,
            ...text('jr'),
            ...Array<number>(0x3e - 0x22).fill(0),
            ...u32(1),
            ...u16(8),
            ...u16(0),
        ],
        headerSize
    );
    const data = bytes(header, image, text('FBOV'), u32(overlay.length + 2), u32(headerSize + 112), u32(5), overlay, u16(fixup));
    // The checksum: what makes the file's words add up to 0xFFFF.
    let sum = 0;
    for (let i = 0; i < data.length; i += 2) sum = (sum + data[i] + (data[i + 1] ?? 0) * 256) & 0xffff;
    data.set(u16((0xffff - sum) & 0xffff), 0x12);
    return data;
}

/**
 * A program information file, as Windows 3's PIF Editor wrote one: the 0x171-byte basic section (title, memory, program,
 * folder, parameters, screen), then the section headers, each a 16-character name, the next header's offset, and its
 * data's offset and length: "MICROSOFT PIFEX" (pointing back at the basic section), then the enhanced-mode and
 * standard-mode settings (left empty here).
 */
export function pif({
    sections = [
        ['WINDOWS 386 3.0', 0x68],
        ['WINDOWS 286 3.0', 6],
    ] as [string, number][],
} = {}): Uint8Array {
    const basic = new Uint8Array(0x171);
    const put = (at: number, value: string, length: number, pad = 0x20) => {
        basic.fill(pad, at, at + length);
        basic.set(text(value), at);
    };
    put(0x02, 'Chimera', 30);
    basic.set([...u16(640), ...u16(256)], 0x20);
    put(0x24, 'CHIMERA.EXE', 63);
    basic[0x24 + 'CHIMERA.EXE'.length] = 0;
    basic.set(u16(0x10), 0x63); // close the window when it ends
    put(0x65, 'C:\\CHIMERA', 64, 0);
    put(0xa5, '/SAMPLE', 64, 0);
    basic.set([0, 1, 0, 0xff, 25, 80], 0xe5);
    const all: [string, number][] = [['MICROSOFT PIFEX', 0x171], ...sections];
    const headers: number[] = [];
    let at = 0x171;
    all.forEach(([name, length], i) => {
        const headerAt = at;
        const ownData = i === 0 ? 0 : headerAt + 22;
        const next = i === all.length - 1 ? 0xffff : headerAt + 22 + (i === 0 ? 0 : length);
        headers.push(...text(name.padEnd(15, '\0')), 0, ...u16(next), ...u16(ownData), ...u16(length), ...(i === 0 ? [] : new Array(length).fill(0)));
        at = next;
    });
    return bytes(basic, headers);
}

/**
 * A Westwood string table: a 2-byte offset for each string (the first is also the table's size), then the strings, each
 * ending in a NUL. With `compressed`, Dune II's: each common pair of letters a byte. Otherwise plain DOS text, its
 * accented letters in the PC's own character set (code page 437: 0x84 is ä, 0x82 é).
 */
export function stringTable(compressed: boolean): Uint8Array {
    const lines = compressed
        ? [
              'The Harkonnen come from the dark planet of Giedi Prime.',
              'Our ancestral home is the lush planet of Caladan, where we respect the lives and rights of all people.',
              'House Ordos was formed by a group of wealthy families, driven by a lust for credits and control.',
              'Spice is the most valuable substance in the universe: whoever controls the spice controls the universe.',
              'Build a windtrap to power your base, then a refinery to process the spice your harvesters collect.',
          ]
        : ['Build', 'Geb\x84ude ausbauen', 'Am\x82lioration'];
    const encoded = lines.map((l) => [...(compressed ? dune2Compress(l) : Array.from(l, (c) => c.charCodeAt(0))), 0]);
    let at = lines.length * 2;
    const offsets = encoded.flatMap((e) => {
        const o = u16(at);
        at += e.length;
        return o;
    });
    return bytes(offsets, encoded.flat());
}

// The list

/** Every sample, in the order they're listed. */
export function samples(): Sample[] {
    const card = testCard();
    const card4 = pack4(card);
    const down = Uint8Array.from({ length: 32000 }, (_, k) => card4[(k % 200) * 160 + Math.floor(k / 200)]);
    const tone = tone8(1100);
    const ima = Array.from({ length: 64 }, (_, i) => ((i * 7) & 0x0f) | (((i * 3 + 5) & 0x0f) << 4));
    const out: Sample[] = [
        { name: 'cps-none.cps', format: 'cps', about: 'CPS picture, uncompressed, with its palette', data: cps(0, card) },
        { name: 'cps-lzw12.cps', format: 'cps', about: 'CPS picture, LZW with 12-bit codes', data: cps(1, lzw(card, 12)) },
        { name: 'cps-lzw14.cps', format: 'cps', about: 'CPS picture, LZW with 14-bit codes', data: cps(2, lzw(card, 14)) },
        { name: 'cps-rle.cps', format: 'cps', about: 'CPS picture, Westwood RLE', data: cps(3, rle(card)) },
        { name: 'cps-lcw.cps', format: 'cps', about: 'CPS picture, LCW (as literal copies), using the game palette', data: cps(4, lcwLiterals(card), { pal: [] }) },
        { name: 'cps-amiga.cps', format: 'cps', about: 'CPS picture as the Amiga stores it: five bit planes, a 32-color palette', data: cps(0, planes(card), { size: 40000, pal: amigaPalette() }) },
        { name: 'cmp-type1.cmp', format: 'cmp', about: 'CMP picture: 16 colors, RLE across the rows', data: cmp(1, rle(card4, true)) },
        { name: 'cmp-type2.cmp', format: 'cmp', about: 'CMP picture: 16 colors, RLE down each column', data: cmp(2, rle(down, true)) },
        { name: 'cmp-type3.cmp', format: 'cmp', about: 'CMP picture: 256 colors, LZW with 12-bit codes', data: cmp(3, lzw(card, 12)) },
        { name: 'cmp-type4.cmp', format: 'cmp', about: 'CMP picture: 256 colors, RLE', data: cmp(4, rle(card)) },
        { name: 'cmp-type6.cmp', format: 'cmp', about: 'CMP picture: 256 colors, LZW with 14-bit codes', data: cmp(6, lzw(card, 14)) },
        { name: 'icn-dune2.icn', format: 'icn-d2', about: 'Dune II map tiles: 8 tiles, two palettes (one with see-through edges)', data: icn() },
        { name: 'icon-dune2.map', format: 'icon-map', about: 'Dune II ICON.MAP: the 26 groups the game reads, of icn-dune2.icn’s tiles', data: iconMap() },
        { name: 'wsa-cnc.wsa', format: 'wsa', about: 'WSA animation, the C&C header: a square moving across', data: wsa('cnc') },
        { name: 'wsa-dune2-100.wsa', format: 'wsa', about: 'WSA animation, Dune II 1.00’s header', data: wsa('dune2-100') },
        { name: 'wsa-dune2-107.wsa', format: 'wsa', about: 'WSA animation, Dune II 1.07’s header', data: wsa('dune2-107') },
        {
            name: 'voc-pcm8.voc',
            format: 'voc',
            about: 'VOC sound: an 8-bit tone, a silence, a text block',
            data: voc([
                [1, [165, 0, ...tone]],
                [3, [...u16(499), 165]],
                [5, [...text('made by Chimera'), 0]],
            ]),
        },
        { name: 'voc-adpcm4.voc', format: 'voc', about: 'VOC sound: Creative 4-bit ADPCM', data: voc([[1, [165, 1, 128, ...ima]]]) },
        {
            name: 'aud-pcm8.aud',
            format: 'aud',
            about: 'AUD sound: plain 8-bit PCM in two chunks',
            data: aud(11025, 0, 0, [
                [tone.slice(0, 512), 512],
                [tone.slice(512, 1024), 512],
            ]),
        },
        { name: 'aud-ima.aud', format: 'aud', about: 'AUD sound: IMA ADPCM, 16-bit out', data: aud(22050, 2, 99, [[ima, ima.length * 4]]) },
        { name: 'wav-pcm8.wav', format: 'wav', about: 'WAV sound: 8-bit PCM', data: wav(11025, tone) },
        { name: 'fnt-ra2-map.fnt', format: 'fnt-ts', about: 'RA2 map editor font (FoNt), the letters of CHIMERA', data: foNt() },
        { name: 'fnt-nox.fnt', format: 'fnt-ts', about: 'Nox font (tNoF), the letters of CHIMERA', data: tNoF() },
        {
            name: 'icon.ico',
            format: 'ico',
            about: 'Windows icon at three sizes: 16 × 16 in 16 colors, 32 × 32 with its own transparency, and 48 × 48 as a PNG',
            data: iconFile([
                { image: iconDib(), width: 16, height: 16, colors: 16, bits: 4 },
                { image: iconDib32(), width: 32, height: 32, bits: 32 },
                { image: png(48, 48, (x, y) => [x * 5, 255 - y * 5, 128]), width: 48, height: 48, bits: 32 },
            ]),
        },
        {
            name: 'cursor.cur',
            format: 'ico',
            about: 'Windows cursor: a 32 × 32 arrow in 2 colors, its hot spot at the tip',
            data: iconFile([{ image: cursorDib(), width: 32, height: 32, colors: 2, planes: 0, bits: 0 }], 2),
        },
        { name: 'icons.icl', format: 'ne', about: 'Windows 3 icon library: a 16-bit module with no code, holding one 16 × 16 icon', data: iconLibrary() },
        { name: 'music.mid', format: 'midi', about: 'Standard MIDI file, two tracks: a tempo change halfway, a named melody written with running status', data: standardMidi() },
        { name: 'music.xmi', format: 'xmi', about: 'XMIDI music, two sequences: a phrase with an instrument from the bank, and a chord with a branch point', data: xmidiMusic() },
        { name: 'team.emc', format: 'emc', about: 'Dune II script for the computer’s teams, in the game’s own style: a subroutine, a loop, a call to it', data: emcScript() },
        { name: 'credits.eng', format: 'dune2-credits', about: 'Dune II credits, as 1.07’s: a title, a role and its names, a centered line, the small print', data: duneCredits() },
        { name: 'mentat.eng', format: 'mentat', about: 'Dune II mentat encyclopedia: a briefing topic and a structure, its text compressed as the game does', data: mentat() },
        { name: 'music.adl', format: 'adl', about: 'Westwood AdLib music, as Dune II’s: a conductor starting two voices, one looping as Westwood’s tools do', data: adlMusic() },
        { name: 'driver.adv', format: 'ail', about: 'Miles AIL 2 sound driver: the tables of a Sound Blaster digital driver, each function a bare RETF', data: ailDriver() },
        { name: 'program.exe', format: 'mz', about: 'DOS program linked as Borland’s TLINK does with overlays: relocations, the segment table, one overlay with a fixup', data: dosProgram() },
        { name: 'program.pif', format: 'pif', about: 'Windows program information file: runs CHIMERA.EXE /SAMPLE, with the Windows 3 sections', data: pif() },
        { name: 'strings-dune2.eng', format: 'strings', about: 'Dune II string table, compressed as the game does', data: stringTable(true) },
        { name: 'strings-dos.ger', format: 'strings', about: 'C&C-style string table, plain, with accented letters in DOS characters', data: stringTable(false) },
        { name: 'palette.pal', format: 'pal', about: 'VGA palette: the 16 EGA colors, then a gray ramp', data: palette6() },
        { name: 'dune.cfg', format: 'dune2-cfg', about: 'Dune II settings: MT-32 music, AdLib effects, Sound Blaster Pro voices, in German', data: duneCfg() },
        { name: 'options.cfg', format: 'dune2-options', about: 'Dune II game options, the game’s defaults', data: duneOptions() },
        { name: 'grayrmap.tbl', format: 'gray-remap', about: 'Dune II-style gray remap for palette.pal: each EGA color to the gray of its brightness', data: grayRemap() },
        { name: 'png-rgb.png', format: 'png', about: 'PNG picture: RGB, a color wheel of sorts', data: png(64, 64, (x, y) => [x * 4, y * 4, 255 - (x + y) * 2]) },
    ];
    const byName = (name: string) => out.find((s) => s.name === name)!.data;
    const archived: [string, Uint8Array][] = [
        ['CARD.CPS', byName('cps-none.cps')],
        ['TONE.VOC', byName('voc-pcm8.voc')],
        ['PALETTE.PAL', byName('palette.pal')],
    ];
    out.push(
        { name: 'pak-v1.pak', format: 'pak', about: 'Westwood PAK, version 1 (Eye of the Beholder), holding three of these', data: pak(1, archived) },
        { name: 'pak-v2.pak', format: 'pak', about: 'Westwood PAK, version 2 (Dune II), holding three of these', data: pak(2, archived) },
        { name: 'pak-v3.pak', format: 'pak', about: 'Westwood PAK, version 3 (Kyrandia 2 and 3), holding three of these', data: pak(3, archived) }
    );
    return out;
}
