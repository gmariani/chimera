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
import { crc32 } from '../core/crc32.ts';
import { implode } from '../core/implode.test-util.ts';
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

/** A test pattern for bitmaps: the color of pixel (x, y), as RGB, the same whatever the bits a pixel. */
export function bitmapColor(bits: 4 | 8 | 24, x: number, y: number): [number, number, number] {
    if (bits === 24) return [x * 7, y * 20, (x * y) & 255];
    const index = bits === 4 ? (x + y) & 15 : (x + y * 3) & 255;
    const p = palette6();
    return [p[index * 3] << 2, p[index * 3 + 1] << 2, p[index * 3 + 2] << 2];
}

/**
 * A Windows bitmap (.bmp) of bitmapColor's pattern, 33 × 10 so each row needs padding: for 4 and 8 bits a pixel with
 * palette6's colors (16 of them, or all 256), bottom row first; for 24, top row first (a negative height). `pad` adds
 * the zeros some Windows programs write after the pixels to round the file to a multiple of 4.
 */
export function bitmap(bits: 4 | 8 | 24, { pad = false }: { pad?: boolean } = {}): Uint8Array {
    const [width, height] = [33, 10];
    const colors = bits === 24 ? 0 : 1 << bits;
    const stride = ((width * bits + 31) >> 5) * 4;
    const offset = 14 + 40 + colors * 4;
    const pixels = stride * height;
    const unpadded = offset + pixels;
    const length = pad ? (unpadded + 3) & ~3 : unpadded;
    const out = new Uint8Array(length);
    const v = new DataView(out.buffer);
    out.set([0x42, 0x4d]);
    v.setUint32(2, length, true);
    v.setUint32(10, offset, true);
    v.setUint32(14, 40, true);
    v.setInt32(18, width, true);
    v.setInt32(22, bits === 24 ? -height : height, true);
    v.setUint16(26, 1, true);
    v.setUint16(28, bits, true);
    v.setUint32(34, pixels, true);
    v.setInt32(38, 2835, true);
    v.setInt32(42, 2835, true);
    const p = palette6();
    for (let i = 0; i < colors; i++) out.set([p[i * 3 + 2] << 2, p[i * 3 + 1] << 2, p[i * 3] << 2, 0], 54 + i * 4);
    for (let y = 0; y < height; y++) {
        const row = offset + (bits === 24 ? y : height - 1 - y) * stride;
        for (let x = 0; x < width; x++) {
            if (bits === 24) {
                const [r, g, b] = bitmapColor(24, x, y);
                out.set([b, g, r], row + x * 3);
            } else if (bits === 8) out[row + x] = (x + y * 3) & 255;
            else out[row + (x >> 1)] |= ((x + y) & 15) << (x & 1 ? 0 : 4);
        }
    }
    return out;
}

/**
 * An InstallShield 3 archive laid out as InstallShield's are: the 59-byte header, zeros to byte 255, each file's data
 * (imploded, or stored when `stored`), the directory table, the file table. Dates are 1997-02-25 11:51:24.
 */
export function installShieldZ(dirs: { name: string; files: { name: string; data: Uint8Array; stored?: boolean }[] }[]): Uint8Array {
    const DATE = 0x5e6c2259;
    const latin1 = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
    const files = dirs.flatMap((d, dir) => d.files.map((f) => ({ ...f, dir, packed: f.stored ? f.data : implode(f.data) })));
    let at = 255;
    const placed = files.map((f) => ({ ...f, at: (at += f.packed.length) - f.packed.length }));
    const dirEntries = dirs.map((d) => {
        const name = latin1(d.name);
        const e = new Uint8Array(6 + name.length + 5);
        const v = new DataView(e.buffer);
        v.setUint16(0, d.files.length, true);
        v.setUint16(2, e.length, true);
        v.setUint16(4, name.length, true);
        e.set(name, 6);
        return e;
    });
    const fileEntries = placed.map((f) => {
        const name = latin1(f.name);
        const e = new Uint8Array(30 + name.length + 13);
        const v = new DataView(e.buffer);
        v.setUint16(1, f.dir, true);
        v.setUint32(3, f.data.length, true);
        v.setUint32(7, f.packed.length, true);
        v.setUint32(11, f.at, true);
        v.setUint32(15, DATE, true);
        v.setUint32(19, 0x20, true);
        v.setUint16(23, e.length, true);
        e[25] = f.stored ? 0x10 : 0;
        e[29] = name.length;
        e.set(name, 30);
        return e;
    });
    const dirsAt = at;
    const dirsSize = dirEntries.reduce((n, e) => n + e.length, 0);
    const filesSize = fileEntries.reduce((n, e) => n + e.length, 0);
    const out = new Uint8Array(dirsAt + dirsSize + filesSize);
    const v = new DataView(out.buffer);
    out.set([0x13, 0x5d, 0x65, 0x8c, 0x3a, 0x01, 0x02, 0x00]);
    v.setUint16(12, files.length, true);
    v.setUint32(14, DATE, true);
    v.setUint32(18, out.length, true);
    v.setUint32(
        22,
        files.reduce((n, f) => n + f.data.length, 0),
        true
    );
    v.setUint32(26, 0xff, true);
    v.setUint32(33, 255, true);
    v.setUint32(41, dirsAt, true);
    v.setUint32(45, dirsSize, true);
    v.setUint16(49, dirs.length, true);
    v.setUint32(51, dirsAt + dirsSize, true);
    v.setUint32(55, filesSize, true);
    for (const f of placed) out.set(f.packed, f.at);
    let p = dirsAt;
    for (const e of [...dirEntries, ...fileEntries]) {
        out.set(e, p);
        p += e.length;
    }
    return out;
}

/**
 * MPEG audio after an ID3v2.4 tag: the tag's 10-byte header (its flags saying a footer follows), `body` bytes of
 * frames left zero, the "3DI" footer; then two MPEG-1 layer III frames at 128 kbit/s and 44,100 Hz, stereo, each
 * 144 × 128,000 / 44,100 = 417 bytes of header and silence. `footer` sets the footer's first three bytes.
 */
export function mp3Tagged(body = 20, footer = '3DI'): Uint8Array {
    const size = [(body >> 21) & 0x7f, (body >> 14) & 0x7f, (body >> 7) & 0x7f, body & 0x7f];
    const frame = new Array<number>(417).fill(0);
    frame.splice(0, 4, 0xff, 0xfb, 0x90, 0x00);
    const tail = [...footer].map((c) => c.charCodeAt(0)).concat([4, 0, 0x10, ...size]);
    return Uint8Array.from([0x49, 0x44, 0x33, 4, 0, 0x10, ...size, ...new Array<number>(body).fill(0), ...tail, ...frame, ...frame]);
}

/**
 * An InstallShield 3 script (SETUP.INS) laid out as Counterstrike's are: B8 C9 0C 00, version 3.00.065, the sum of
 * every byte after it, Stirling's notice; how many labels; a size for each string variable (512 for the system's);
 * the system's string and number variables; the structures; the functions (each `dll` one in a DLL, else the
 * script's own, its parameters as [type, flags]); 0; the code given; and the compiler's version, its length last.
 */
export function installShieldScript({
    strings = ['SRCDIR', 'TARGETDIR'],
    own = [0xffff, 200],
    numbers = ['LAST_RESULT'],
    ownNumbers = 3,
    structures = [{ name: 'RECT', members: [[4, 4, 'left'] as [number, number, string]] }],
    functions = [{ params: [[4, 5]] as [number, number][] }, { dll: ['USER', 'ShowWindow'] as [string, string], returns: 6, params: [[7, 0]] as [number, number][] }],
    code = [0x2e, 0x00, 0x01, 0x00],
    compiler = '3.00.076',
}: {
    strings?: string[];
    own?: number[];
    numbers?: string[];
    ownNumbers?: number;
    structures?: { name: string; members: [number, number, string][] }[];
    functions?: { dll?: [string, string]; returns?: number; params: [number, number][] }[];
    code?: number[];
    compiler?: string;
} = {}): Uint8Array {
    const bytes: number[] = [0xb8, 0xc9, 0x0c, 0x00, 0x16, 0x00, 0x34, 0x12, 0, 0, 0, 0];
    const u16 = (...vs: number[]) => vs.forEach((v) => bytes.push(v & 255, v >> 8));
    const text = (s: string) => bytes.push(...Array.from(s, (c) => c.charCodeAt(0)));
    const name = (s: string) => {
        u16(s.length);
        text(s);
    };
    const notice = '\r\nStirling Technologies, Inc.  (c) 1990-1994\r\n\r\n';
    bytes.push(notice.length);
    text(notice);
    u16(10, strings.length + own.length, ...strings.map(() => 0x200), ...own, strings.length);
    strings.forEach((s, i) => {
        u16(i);
        name(s);
    });
    u16(numbers.length + ownNumbers, numbers.length);
    numbers.forEach((s, i) => {
        u16(i);
        name(s);
    });
    u16(structures.length);
    for (const s of structures) {
        u16(0);
        name(s.name);
        u16(s.members.length);
        for (const [type, size, member] of s.members) {
            u16(type, size);
            name(member);
        }
    }
    u16(functions.length);
    for (const f of functions) {
        if (f.dll) {
            u16(1, f.returns ?? 4);
            name(f.dll[0]);
            name(f.dll[1]);
        } else u16(2, 0, 0, 0);
        u16(f.params.length, ...f.params.flat());
    }
    u16(0);
    bytes.push(...code);
    text(compiler);
    bytes.push(compiler.length);
    const sum = bytes.slice(12).reduce((n, v) => n + v, 0);
    bytes.splice(8, 4, sum & 255, (sum >> 8) & 255, (sum >> 16) & 255, sum >>> 24);
    return Uint8Array.from(bytes);
}

/**
 * InstallShield 3's setup files (_INST32I.EX_) laid out as Counterstrike's are: 2A AB 79 D8 00 01 00 00, the
 * copyright cut off at 70 bytes, how many files, 0; each file's entry (where its data is, its sizes, 8 zeros, its two
 * names), then each file's data, imploded, one after another.
 */
export function installShieldEngine(files: { name: string; alias: string; data: Uint8Array }[]): Uint8Array {
    const latin1 = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
    const packed = files.map((f) => implode(f.data));
    const header = [0x2a, 0xab, 0x79, 0xd8, 0, 1, 0, 0, ...latin1('Copyright (c) 1990-1995 Stirling Technologies, Inc. All Rights Reserve'), files.length, 0, 0, 0];
    let at = header.length + files.reduce((n, f) => n + 24 + f.name.length + f.alias.length, 0);
    const u16 = (v: number) => [v & 255, v >> 8];
    const u32 = (v: number) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, v >>> 24];
    const entries = files.flatMap((f, i) => {
        const e = [...u32(at), ...u32(packed[i].length), ...u32(f.data.length), 0, 0, 0, 0, 0, 0, 0, 0, ...u16(f.name.length), ...latin1(f.name), ...u16(f.alias.length), ...latin1(f.alias)];
        at += packed[i].length;
        return e;
    });
    const out = new Uint8Array(at);
    out.set([...header, ...entries]);
    let p = header.length + entries.length;
    for (const d of packed) {
        out.set(d, p);
        p += d.length;
    }
    return out;
}

/**
 * An InstallShield 3 package list (SETUP.PKG) laid out as Counterstrike's three are: 4A A3, where the list of archives
 * are, 2; a block for each archive (its length, its groups, its files, each name followed by a zero); then each disk's
 * list (0, the disk, how many): on disk 1 the archives (each its name, 1 and 1, where its block starts), and on each
 * disk the files `copied` as they are (each its name, 2 and 0, its size).
 */
export function installShieldPkg(
    archives: { name: string; groups: { name: string; files: { name: string; size: number }[] }[] }[],
    copied: { name: string; size: number; disk: number }[] = []
): Uint8Array {
    const bytes: number[] = [0x4a, 0xa3, 0, 0, 0, 0, 2, 0, 0, 0];
    const u16 = (v: number) => bytes.push(v & 255, v >> 8);
    const u32 = (v: number) => bytes.push(v & 255, (v >> 8) & 255, (v >> 16) & 255, v >>> 24);
    const latin1 = (s: string) => bytes.push(...Array.from(s, (c) => c.charCodeAt(0)));
    const blocks = archives.map((a) => {
        const at = bytes.length;
        u32(0);
        u16(a.groups.length);
        for (const g of a.groups) {
            u16(g.name.length);
            latin1(g.name);
            bytes.push(0);
        }
        u16(a.groups.reduce((n, g) => n + g.files.length, 0));
        a.groups.forEach((g, i) =>
            g.files.forEach((f) => {
                u16(i);
                u32(f.size);
                bytes.push(f.name.length);
                latin1(f.name);
                bytes.push(0);
            })
        );
        const length = bytes.length - at - 4;
        bytes.splice(at, 4, length & 255, (length >> 8) & 255, (length >> 16) & 255, length >>> 24);
        return at;
    });
    const listAt = bytes.length;
    bytes.splice(2, 4, listAt & 255, (listAt >> 8) & 255, (listAt >> 16) & 255, listAt >>> 24);
    const disks = Math.max(1, ...copied.map((f) => f.disk));
    for (let disk = 1; disk <= disks; disk++) {
        const here = copied.filter((f) => f.disk === disk);
        u16(0);
        u16(disk);
        u16((disk === 1 ? archives.length : 0) + here.length);
        if (disk === 1)
            archives.forEach((a, i) => {
                u16(a.name.length);
                latin1(a.name);
                bytes.push(1, 1);
                u32(blocks[i]);
            });
        for (const f of here) {
            u16(f.name.length);
            latin1(f.name);
            bytes.push(2, 0);
            u32(f.size);
        }
    }
    return Uint8Array.from(bytes);
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
 * A resource file (.res) as a resource compiler writes one, from this script:
 *
 *     1 ICON "diamond.ico"                       (the 16 × 16 icon of iconDib, as icon #1 and its group #1)
 *     STRINGTABLE { 100 "Hello" }                (in block #7, strings 96 to 111)
 *     100 DIALOG 0, 0, 160, 60
 *     STYLE WS_CAPTION | WS_VISIBLE | DS_SETFONT
 *     CAPTION "About"
 *     FONT 8, "MS Shell Dlg"
 *     { ICON 1, -1, 10, 10, 20, 20
 *       LTEXT "Chimera", -1, 40, 14, 100, 8
 *       DEFPUSHBUTTON "OK", 1, 55, 40, 50, 14 }
 *
 * An empty entry first, then each resource: its header (sizes, type, name, then version, flags, language) and data, on
 * 4-byte boundaries. English (US).
 */
export function resourceFile(): Uint8Array {
    const pad4 = (b: number[]) => [...b, ...new Array((4 - (b.length % 4)) % 4).fill(0)];
    const wide = (s: string) => [...[...s].flatMap((c) => u16(c.charCodeAt(0))), 0, 0];
    const entry = (type: number, name: number, data: number[]) =>
        pad4([...u32(data.length), ...u32(32), ...u16(0xffff), ...u16(type), ...u16(0xffff), ...u16(name), ...u32(0), ...u16(0x1030), ...u16(0x409), ...u32(0), ...u32(0), ...data]);
    const empty = [...u32(0), ...u32(32), ...u16(0xffff), ...u16(0), ...u16(0xffff), ...u16(0), ...new Array(16).fill(0)];
    const icon = iconDib();
    const group = [...u16(0), ...u16(1), ...u16(1), 16, 16, 16, 0, ...u16(1), ...u16(4), ...u32(icon.length), ...u16(1)];
    // Strings 96 to 111: four empty, "Hello" (100), eleven empty.
    const strings = [...new Array(4 * 2).fill(0), ...u16(5), ...[...'Hello'].flatMap((c) => u16(c.charCodeAt(0))), ...new Array(11 * 2).fill(0)];
    const control = (style: number, x: number, y: number, w: number, h: number, id: number, cls: number, label: number[]) =>
        pad4([...u32(style), ...u32(0), ...u16(x), ...u16(y), ...u16(w), ...u16(h), ...u16(id), ...u16(0xffff), ...u16(cls), ...label, ...u16(0)]);
    const VISIBLE = 0x10000000;
    const dialog = [
        ...pad4([...u32(0x00c00000 | VISIBLE | 0x40), ...u32(0), ...u16(3), ...u16(0), ...u16(0), ...u16(160), ...u16(60), ...u16(0), ...u16(0), ...wide('About'), ...u16(8), ...wide('MS Shell Dlg')]),
        ...control(VISIBLE | 3, 10, 10, 20, 20, 0xffff, 0x82, [...u16(0xffff), ...u16(1)]),
        ...control(VISIBLE, 40, 14, 100, 8, 0xffff, 0x82, wide('Chimera')),
        ...control(VISIBLE | 1, 55, 40, 50, 14, 1, 0x80, wide('OK')),
    ];
    return Uint8Array.from([...empty, ...entry(3, 1, icon), ...entry(14, 1, group), ...entry(6, 7, strings), ...entry(5, 100, dialog)]);
}

// Signatures and certificates, in DER: each value its tag, its length (one byte under 128, else 0x81 or 0x82 and the
// length), and its contents.
const der = (tag: number, ...contents: number[][]) => {
    const body = contents.flat();
    const n = body.length;
    return [tag, ...(n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 0xff]), ...body];
};
const derOid = (oid: string) => {
    const [a, b, ...rest] = oid.split('.').map(Number);
    const base128 = (v: number) => {
        const out = [v & 0x7f];
        for (v = Math.floor(v / 128); v; v = Math.floor(v / 128)) out.unshift((v & 0x7f) | 0x80);
        return out;
    };
    return der(0x06, [a * 40 + b, ...rest.flatMap(base128)]);
};
const derName = (parts: [string, string][]) => der(0x30, ...parts.map(([oid, v]) => der(0x31, der(0x30, derOid(oid), der(0x13, text(v))))));

/**
 * A certificate (X.509 version 3) as a certificate authority issues one, for code signing: serial number 0x1234, signed
 * with SHA-256 and RSA, issued by "Chimera Test CA" to "Chimera Sample" (organization "Chimera", country US), valid
 * from 2020-01-01 to 2030-12-31, a 1,024-bit RSA key (its modulus 0x80 followed by 127 bytes of 0x11; exponent 65537),
 * an extended key usage of code signing, and 32 bytes standing in for the issuer's signature.
 */
export function certificate({ v1 = false }: { v1?: boolean } = {}): number[] {
    const sha256Rsa = der(0x30, derOid('1.2.840.113549.1.1.11'), der(0x05));
    const modulus = der(0x02, [0x00, 0x80, ...new Array(127).fill(0x11)]);
    const key = der(0x30, der(0x30, derOid('1.2.840.113549.1.1.1'), der(0x05)), der(0x03, [0, ...der(0x30, modulus, der(0x02, [1, 0, 1]))]));
    const eku = der(0x30, derOid('2.5.29.37'), der(0x04, der(0x30, derOid('1.3.6.1.5.5.7.3.3'))));
    const tbs = der(
        0x30,
        // Version 1 writes no version, and has no extensions.
        ...(v1 ? [] : [der(0xa0, der(0x02, [2]))]),
        der(0x02, [0x12, 0x34]),
        sha256Rsa,
        derName([['2.5.4.3', 'Chimera Test CA']]),
        der(0x30, der(0x17, text('200101000000Z')), der(0x17, text('301231235959Z'))),
        derName([
            ['2.5.4.6', 'US'],
            ['2.5.4.10', 'Chimera'],
            ['2.5.4.3', 'Chimera Sample'],
        ]),
        key,
        ...(v1 ? [] : [der(0xa3, der(0x30, eku))])
    );
    return der(0x30, tbs, sha256Rsa, der(0x03, [0, ...new Array(32).fill(0x5a)]));
}

/**
 * A bag of certificates as Internet Explorer 3's softpub.dll keeps one: PKCS #7 signed data alone, without the
 * ContentInfo around it (version 1, no hash algorithms, plain data with nothing in it), holding the certificate above
 * and its version 1 form, and no signers.
 */
export function certificateBag(): Uint8Array {
    return Uint8Array.from(der(0x30, der(0x02, [1]), der(0x31), der(0x30, derOid('1.2.840.113549.1.7.1')), der(0xa0, certificate(), certificate({ v1: true })), der(0x31)));
}

/**
 * An Authenticode signature, as a Windows program carries one (PKCS #7 signed data): the program's SHA-256 hash (32
 * bytes of 0xAB), the certificate above, and its holder's signature, which vouches for the hash, the signing time
 * (2021-06-15 12:00:00 UTC) and the program's name, "Chimera Sample", with 64 bytes standing in for the signature
 * itself. Then, as Windows pads them in a program, zeros to a multiple of 8 bytes.
 */
export function authenticode(): Uint8Array {
    const sha256 = der(0x30, derOid('2.16.840.1.101.3.4.2.1'), der(0x05));
    const content = der(
        0x30,
        derOid('1.3.6.1.4.1.311.2.1.4'),
        der(0xa0, der(0x30, der(0x30, derOid('1.3.6.1.4.1.311.2.1.15'), der(0x30, der(0x03, [0]))), der(0x30, sha256, der(0x04, new Array(32).fill(0xab)))))
    );
    const attribute = (oid: string, value: number[]) => der(0x30, derOid(oid), der(0x31, value));
    const signed = der(
        0xa0,
        attribute('1.2.840.113549.1.9.3', derOid('1.3.6.1.4.1.311.2.1.4')),
        attribute('1.2.840.113549.1.9.5', der(0x17, text('210615120000Z'))),
        attribute(
            '1.3.6.1.4.1.311.2.1.12',
            der(
                0x30,
                der(
                    0xa0,
                    der(
                        0x80,
                        [...'Chimera Sample'].flatMap((c) => [0, c.charCodeAt(0)])
                    )
                )
            )
        ),
        attribute('1.2.840.113549.1.9.4', der(0x04, new Array(32).fill(0xcd)))
    );
    const signer = der(
        0x30,
        der(0x02, [1]),
        der(0x30, derName([['2.5.4.3', 'Chimera Test CA']]), der(0x02, [0x12, 0x34])),
        sha256,
        signed,
        der(0x30, derOid('1.2.840.113549.1.1.1'), der(0x05)),
        der(0x04, new Array(64).fill(0x77))
    );
    const signedData = der(0x30, der(0x02, [1]), der(0x31, sha256), content, der(0xa0, certificate()), der(0x31, signer));
    const info = der(0x30, derOid('1.2.840.113549.1.7.2'), der(0xa0, signedData));
    return Uint8Array.from([...info, ...new Array((8 - (info.length % 8)) % 8).fill(0)]);
}

/**
 * A Linear Executable as Watcom's linker lays one out, LE (or LX with `lx`): a DOS header pointing straight to the
 * linear header (no stub), then its tables (two objects, code and data, a page each; the module's name, PROGRAM, and
 * an exported entry point, START, at the start of the code; two fixups on the code's page, one to the data object and
 * one importing function 5 from DOSCALLS; the imported module's name), then the pages: 4,096 bytes of code (a RET,
 * then the two places the fixups fill) and 16 of data.
 */
export function linearProgram({ lx = false }: { lx?: boolean } = {}): Uint8Array {
    const HEADER = 196;
    const pascal = (s: string) => [s.length, ...text(s)];
    const objects = [...u32(4096), ...u32(0x10000), ...u32(0x2005), ...u32(1), ...u32(1), ...u32(0), ...u32(16), ...u32(0x20000), ...u32(0x2003), ...u32(2), ...u32(1), ...u32(0)];
    const map = lx ? [...u32(0), ...u16(4096), ...u16(0), ...u32(4096), ...u16(16), ...u16(0)] : [0, 0, 1, 0, 0, 0, 2, 0];
    const resident = [...pascal('PROGRAM'), ...u16(0), ...pascal('START'), ...u16(1), 0];
    const entry = [1, 3, ...u16(1), 1, ...u32(0), 0];
    // Page 1: a 32-bit offset at 1 to object 2's start (internal, 8-bit object, 32-bit target); a 32-bit offset at 5 to
    // DOSCALLS's function 5 (by number, 8-bit module, 16-bit number).
    const records = [7, 0x10, ...u16(1), 2, ...u32(0), 7, 0x01, ...u16(5), 1, ...u16(5)];
    const fixupPages = [...u32(0), ...u32(records.length), ...u32(records.length)];
    const imports = pascal('DOSCALLS');
    const at = { objects: HEADER } as Record<string, number>;
    at.map = at.objects + objects.length;
    at.resident = at.map + map.length;
    at.entry = at.resident + resident.length;
    at.fixupPages = at.entry + entry.length;
    at.records = at.fixupPages + fixupPages.length;
    at.imports = at.records + records.length;
    at.names = at.imports + imports.length;
    const tablesEnd = at.names;
    const pagesAt = Math.ceil((0x40 + tablesEnd) / 16) * 16;
    const h = new Array(HEADER).fill(0);
    const set32 = (o: number, v: number) => h.splice(o, 4, ...u32(v));
    h.splice(0, 2, ...text(lx ? 'LX' : 'LE'));
    h.splice(8, 4, ...u16(2), ...u16(1));
    for (const [o, v] of [
        [0x14, 2],
        [0x18, 1],
        [0x1c, 0],
        [0x20, 2],
        [0x24, 16],
        [0x28, 4096],
        [0x2c, lx ? 0 : 16],
        [0x30, fixupPages.length + records.length],
        [0x38, at.fixupPages - at.objects],
        [0x40, at.objects],
        [0x44, 2],
        [0x48, at.map],
        [0x50, at.resident],
        [0x58, at.resident],
        [0x5c, at.entry],
        [0x68, at.fixupPages],
        [0x6c, at.records],
        [0x70, at.imports],
        [0x74, 1],
        [0x78, at.names],
        [0x80, pagesAt],
    ])
        set32(o, v);
    const dos = [...text('MZ'), ...u16(0x40), ...u16(1), ...u16(0), ...u16(4), ...new Array(0x3c - 10).fill(0), ...u32(0x40)];
    const tables = [...h.slice(HEADER), ...objects, ...map, ...resident, ...entry, ...fixupPages, ...records, ...imports];
    const code = [0xc3, ...new Array(4095).fill(0)];
    const data = Array.from({ length: 16 }, (_, i) => i);
    return Uint8Array.from([...dos, ...h, ...tables, ...new Array(pagesAt - 0x40 - HEADER - tables.length).fill(0), ...code, ...data]);
}

/**
 * A 32-bit DOS program as DOS/4GW binds one: a DOS program (the extender's loader; here its code is a bare RETF), then
 * a DOS/16M module ("BW", its 176-byte header naming VMM.EXP and where the next part is, then 16 bytes standing in for
 * its code), then the program the extender runs, linearProgram's.
 */
export function dos4gwProgram(): Uint8Array {
    const loader = [
        ...text('MZ'),
        ...u16(33),
        ...u16(1),
        ...u16(0),
        ...u16(2),
        ...u16(0),
        ...u16(0xffff),
        ...u16(0),
        ...u16(0x100),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u16(0x1e),
        ...u16(0),
        ...new Array(4).fill(0),
        0xcb,
    ];
    const moduleAt = loader.length;
    const programAt = moduleAt + 0xb0 + 16;
    const header = new Array(0xb0).fill(0);
    header.splice(0, 6, ...text('BW'), ...u16((0xb0 + 16) % 512), ...u16(1));
    header.splice(0x1a, 10, ...u16(0x818), ...u32(programAt), ...u32(0xb0 + 16));
    header.splice(0x70, 8, ...text('VMM.EXP'), 0);
    return Uint8Array.from([...loader, ...header, ...new Array(16).fill(0x90), ...linearProgram()]);
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

/** UTF-16 text and its closing 0, as Windows' resources store names and strings. */
const utf16z = (s: string) => [...[...s].flatMap((c) => u16(c.charCodeAt(0))), 0, 0];
const pad4 = (b: number[]) => [...b, ...new Array((4 - (b.length % 4)) % 4).fill(0)];

/**
 * A version resource (VS_VERSIONINFO): each node its length, its value's length, its type (1: text, counted in
 * characters), its key, then its value and its children, each on a 4-byte boundary.
 */
export function versionNode(key: string, type: number, value: number[], children: number[][] = []): number[] {
    const head = pad4([0, 0, 0, 0, ...u16(type), ...utf16z(key)]);
    const body = [...head, ...pad4(value), ...children.flatMap(pad4)];
    const valueLength = type === 1 ? value.length / 2 : value.length;
    return [...u16(body.length), ...u16(valueLength), ...body.slice(4)];
}

/**
 * A version resource as a program carries it (32-bit): the fixed numbers (file and product version 1.0.0.0, for
 * 32-bit Windows, a program), one string table in English (US) and Unicode, and the translation list naming it.
 */
export function versionResource(): number[] {
    const strings = [
        ['CompanyName', 'Chimera'],
        ['FileDescription', 'Chimera sample program'],
        ['FileVersion', '1.0.0.0'],
        ['OriginalFilename', 'program-pe.exe'],
        ['ProductName', 'Chimera'],
    ];
    const fixed = [...u32(0xfeef04bd), ...u32(0x10000), ...u32(0x10000), ...u32(0), ...u32(0x10000), ...u32(0), ...u32(0x3f), ...u32(0), ...u32(0x40004), ...u32(1), ...u32(0), ...u32(0), ...u32(0)];
    return versionNode('VS_VERSION_INFO', 0, fixed, [
        versionNode(
            'StringFileInfo',
            1,
            [],
            [
                versionNode(
                    '040904B0',
                    1,
                    [],
                    strings.map(([k, v]) => versionNode(k, 1, utf16z(v)))
                ),
            ]
        ),
        versionNode('VarFileInfo', 1, [], [versionNode('Translation', 0, [...u16(0x409), ...u16(0x4b0)])]),
    ]);
}

/**
 * A Windows program (PE) in three sections, as a linker lays one out: .text, whose code is `xor eax, eax` and `ret`
 * (it does nothing, and exits at once); .rdata, with the import of KERNEL32's ExitProcess, the export of a function
 * named Hello (the same code), and a CodeView debug entry naming sample.pdb; and .rsrc, with a 16 × 16 icon, its
 * group, and version information. 32-bit, or 64-bit with `wide`. With `rich`, a Rich header (as Microsoft's linker
 * leaves) between the DOS stub and the PE header, with one tool's record and its checksum. With `typeLibrary`, a type
 * library (a TYPELIB resource, named, as OLE's are; only the start of one, "MSFT") in place of the version information.
 */
export function windowsProgram({ wide = false, rich = false, typeLibrary = false }: { wide?: boolean; rich?: boolean; typeLibrary?: boolean } = {}): Uint8Array {
    const FA = 0x200;
    const SA = 0x1000;
    const up = (n: number, to: number) => Math.ceil(n / to) * to;
    const w = wide ? 8 : 4;
    const pe = rich ? 0xa0 : 0x80;
    const optSize = wide ? 240 : 224;
    const headers = up(pe + 24 + optSize + 3 * 40, FA);

    // .rdata, from RVA 0x2000: the import descriptors (KERNEL32 and the zeros that end them), the lookup and address
    // tables, the hint and name, the library's name; the export directory and its three tables, the names; the debug entry.
    const RD = 0x2000;
    const at = { desc: 0, ilt: 40, iat: 40 + 2 * w, hint: 40 + 4 * w } as Record<string, number>;
    at.dll = at.hint + 14;
    at.exp = up(at.dll + 13, 4);
    at.eat = at.exp + 40;
    at.enpt = at.eat + 4;
    at.eot = at.enpt + 4;
    at.expName = at.eot + 2;
    at.fnName = at.expName + 11;
    at.dbg = up(at.fnName + 6, 4);
    at.cv = at.dbg + 28;
    const rdata = new Uint8Array(at.cv + 4 + 16 + 4 + 11);
    const rv = new DataView(rdata.buffer);
    const thunk = (off: number) => (wide ? rv.setBigUint64(off, BigInt(RD + at.hint), true) : rv.setUint32(off, RD + at.hint, true));
    rv.setUint32(at.desc, RD + at.ilt, true);
    rv.setUint32(at.desc + 12, RD + at.dll, true);
    rv.setUint32(at.desc + 16, RD + at.iat, true);
    thunk(at.ilt);
    thunk(at.iat);
    rdata.set([...u16(0), ...text('ExitProcess'), 0], at.hint);
    rdata.set([...text('KERNEL32.dll'), 0], at.dll);
    for (const [off, v] of [
        [12, RD + at.expName],
        [16, 1],
        [20, 1],
        [24, 1],
        [28, RD + at.eat],
        [32, RD + at.enpt],
        [36, RD + at.eot],
    ])
        rv.setUint32(at.exp + off, v, true);
    rv.setUint32(at.eat, 0x1000, true);
    rv.setUint32(at.enpt, RD + at.fnName, true);
    rdata.set([...text('sample.exe'), 0, ...text('Hello'), 0], at.expName);
    // The debug entry: CodeView (2), its size, where it is in memory and in the file; then "RSDS", a GUID, the age, the path.
    const cvSize = rdata.length - at.cv;
    rv.setUint32(at.dbg + 12, 2, true);
    rv.setUint32(at.dbg + 16, cvSize, true);
    rv.setUint32(at.dbg + 20, RD + at.cv, true);
    rv.setUint32(at.dbg + 24, headers + FA + at.cv, true);
    rdata.set([...text('RSDS'), ...Array.from({ length: 16 }, (_, i) => i * 17), ...u32(1), ...text('sample.pdb'), 0], at.cv);

    // .rsrc, from RVA 0x3000: the types (icon, icon group, version), a name and a language (English, US) under each, the
    // three leaves, then the icon, the group and the version information.
    const RS = 0x3000;
    const icon = iconDib();
    const group = [...u16(0), ...u16(1), ...u16(1), 16, 16, 16, 0, ...u16(1), ...u16(4), ...u32(icon.length), ...u16(1)];
    const version = typeLibrary ? [...text('MSFT'), ...u16(2), ...u16(1), ...new Array(56).fill(0)] : versionResource();
    const leaves = 184;
    const iconAt = leaves + 48;
    const groupAt = up(iconAt + icon.length, 4);
    const versionAt = up(groupAt + group.length, 4);
    // A named type's name: its length, then UTF-16.
    const typeName = up(versionAt + version.length, 2);
    const rsrc = new Uint8Array(typeLibrary ? typeName + 2 + 14 : versionAt + version.length);
    const sv = new DataView(rsrc.buffer);
    const directory = (off: number, id: number, target: number) => {
        sv.setUint16(off + 14, 1, true);
        sv.setUint32(off + 16, id, true);
        sv.setUint32(off + 20, target, true);
    };
    // Named types come before numbered ones.
    sv.setUint16(12, typeLibrary ? 1 : 0, true);
    sv.setUint16(14, typeLibrary ? 2 : 3, true);
    const order = typeLibrary ? [2, 0, 1] : [0, 1, 2];
    order.forEach((i, slot) => {
        sv.setUint32(16 + slot * 8, i === 2 && typeLibrary ? 0x80000000 | typeName : [3, 14, 16][i], true);
        sv.setUint32(20 + slot * 8, 0x80000000 | (40 + i * 24), true);
    });
    if (typeLibrary) rsrc.set([...u16(7), ...[...'TYPELIB'].flatMap((c) => u16(c.charCodeAt(0)))], typeName);
    [0, 1, 2].forEach((i) => {
        directory(40 + i * 24, 1, 0x80000000 | (112 + i * 24));
        directory(112 + i * 24, 0x409, leaves + i * 16);
        const [where, size] = [
            [iconAt, icon.length],
            [groupAt, group.length],
            [versionAt, version.length],
        ][i];
        sv.setUint32(leaves + i * 16, RS + where, true);
        sv.setUint32(leaves + i * 16 + 4, size, true);
    });
    rsrc.set(icon, iconAt);
    rsrc.set(group, groupAt);
    rsrc.set(version, versionAt);

    const sections = [
        { name: '.text', va: 0x1000, data: Uint8Array.from([0x31, 0xc0, 0xc3]), flags: 0x60000020 },
        { name: '.rdata', va: RD, data: rdata, flags: 0x40000040 },
        { name: '.rsrc', va: RS, data: rsrc, flags: 0x40000040 },
    ];
    let filePos = headers;
    const placed = sections.map((s) => {
        const p = { ...s, ptr: filePos, raw: up(s.data.length, FA) };
        filePos += p.raw;
        return p;
    });
    const out = new Uint8Array(filePos);
    const v = new DataView(out.buffer);
    out.set(text('MZ'), 0);
    v.setUint16(2, 0x90, true); // the DOS header's sizes: one page and a bit, as a linker writes them
    v.setUint16(4, 3, true);
    v.setUint16(8, 4, true);
    v.setUint16(0x18, 0x40, true);
    v.setUint32(0x3c, pe, true);
    // The DOS stub: push cs; pop ds; mov dx, 0x0E; mov ah, 9; int 21h (print the message); mov ax, 0x4C01; int 21h (exit).
    out.set([0x0e, 0x1f, 0xba, 0x0e, 0x00, 0xb4, 0x09, 0xcd, 0x21, 0xb8, 0x01, 0x4c, 0xcd, 0x21, ...text('This program needs Windows.\r\n$')], 0x40);
    if (rich) {
        // One record: tool 0x0104, build 30729, used once. The key is the checksum (see pe.ts).
        const tool = (0x0104 << 16) | 30729;
        const rotl = (x: number, n: number) => (n & 31 ? ((x << (n & 31)) | (x >>> (32 - (n & 31)))) >>> 0 : x >>> 0);
        let key = 0x80;
        for (let i = 0; i < 0x80; i++) if (i < 0x3c || i > 0x3f) key = (key + rotl(out[i], i)) >>> 0;
        key = (key + rotl(tool, 1)) >>> 0;
        [0x536e6144, 0, 0, 0, tool, 1].forEach((x, i) => v.setUint32(0x80 + i * 4, (x ^ key) >>> 0, true));
        out.set(text('Rich'), 0x98);
        v.setUint32(0x9c, key, true);
    }
    out.set(text('PE'), pe);
    v.setUint16(pe + 4, wide ? 0x8664 : 0x14c, true);
    v.setUint16(pe + 6, 3, true);
    v.setUint32(pe + 8, 0x5e0be100, true); // 2020-01-01
    v.setUint16(pe + 20, optSize, true);
    v.setUint16(pe + 22, wide ? 0x0022 : 0x0102, true); // a program; 32-bit (or, 64-bit, large addresses)
    const o = pe + 24;
    v.setUint16(o, wide ? 0x20b : 0x10b, true);
    out[o + 2] = 1; // linker 1.0
    v.setUint32(o + 4, FA, true);
    v.setUint32(o + 8, placed[1].raw + placed[2].raw, true);
    v.setUint32(o + 16, 0x1000, true);
    v.setUint32(o + 20, 0x1000, true);
    if (wide) v.setBigUint64(o + 24, 0x140000000n, true);
    else {
        v.setUint32(o + 24, RD, true);
        v.setUint32(o + 28, 0x400000, true);
    }
    v.setUint32(o + 32, SA, true);
    v.setUint32(o + 36, FA, true);
    v.setUint16(o + 40, 4, true); // Windows 4.0 (95 and NT 4)
    v.setUint16(o + 44, 1, true);
    v.setUint16(o + 48, 4, true);
    v.setUint32(o + 56, 0x4000, true);
    v.setUint32(o + 60, headers, true);
    v.setUint16(o + 68, 2, true); // a window
    const sizes = wide ? [72, 80, 88, 96] : [72, 76, 80, 84];
    [0x100000, 0x1000, 0x100000, 0x1000].forEach((n, i) => (wide ? v.setBigUint64(o + sizes[i], BigInt(n), true) : v.setUint32(o + sizes[i], n, true)));
    const dirs = o + (wide ? 112 : 96);
    v.setUint32(dirs - 4, 16, true);
    for (const [i, rva, size] of [
        [0, RD + at.exp, at.fnName + 6 - at.exp],
        [1, RD + at.desc, 40],
        [2, RS, rsrc.length],
        [6, RD + at.dbg, 28],
        [12, RD + at.iat, 2 * w],
    ]) {
        v.setUint32(dirs + i * 8, rva, true);
        v.setUint32(dirs + i * 8 + 4, size, true);
    }
    placed.forEach((s, i) => {
        const e = o + optSize + i * 40;
        out.set(text(s.name), e);
        v.setUint32(e + 8, s.data.length, true);
        v.setUint32(e + 12, s.va, true);
        v.setUint32(e + 16, s.raw, true);
        v.setUint32(e + 20, s.ptr, true);
        v.setUint32(e + 36, s.flags, true);
        out.set(s.data, s.ptr);
    });
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

/** A RIFF chunk: its 4-letter ID, its size, its data, and a byte of padding when the size is odd. */
const riffChunk = (id: string, body: ArrayLike<number>) => [...text(id), ...u32(body.length), ...Array.from(body), ...(body.length & 1 ? [0] : [])];

/**
 * An animated cursor (.ani): its title and author (an odd-length title, so padded), the header, each step's time and the
 * order of its steps, and two frames, each a whole .cur: the arrow, then the fading disc with its hot spot in the middle.
 * It plays arrow, disc, arrow, for 10, 20 and 10 jiffies. `wholeLength` gives the RIFF size as Westwood's tools did,
 * counting the RIFF header's 8 bytes too.
 */
export function animatedCursor({ wholeLength = false }: { wholeLength?: boolean } = {}): Uint8Array {
    const arrow = iconFile([{ image: cursorDib(), width: 32, height: 32, colors: 2, planes: 0, bits: 0 }], 2);
    const disc = iconFile([{ image: iconDib32(), width: 32, height: 32, planes: 16, bits: 16 }], 2);
    const body = [
        ...text('ACON'),
        ...riffChunk('LIST', [...text('INFO'), ...riffChunk('INAM', text('Spinning\0')), ...riffChunk('IART', text('Sample\0'))]),
        ...riffChunk('anih', [...u32(36), ...u32(2), ...u32(3), ...u32(0), ...u32(0), ...u32(0), ...u32(0), ...u32(10), ...u32(3)]),
        ...riffChunk('rate', [...u32(10), ...u32(20), ...u32(10)]),
        ...riffChunk('seq ', [...u32(0), ...u32(1), ...u32(0)]),
        ...riffChunk('LIST', [...text('fram'), ...riffChunk('icon', arrow), ...riffChunk('icon', disc)]),
    ];
    return bytes(text('RIFF'), u32(body.length + (wholeLength ? 8 : 0)), body);
}

/**
 * An AVI video, 8 × 4 in Microsoft RLE at 8 bits, with a 4-color palette and a second of 8-bit sound at 8,000 Hz. Four
 * frames at 4 a second: a key frame (the top two rows color 1, the bottom two color 2), one drawn over it (two pixels
 * of color 3 on the second row from the top, put there by a delta and a run of colors as they are), then a palette
 * change (color 3 to white) and a frame that's empty (the one before it again, in the new colors), and a last key
 * frame of color 0. The sound is in four chunks, one with each frame, and an index lists every chunk.
 */
export function aviVideo(): Uint8Array {
    const W = 8;
    const H = 4;
    // Blue, green, red and a spare byte each: black, blue, green, red.
    const colors = [0, 0, 0, 0, 0xff, 0, 0, 0, 0, 0xc0, 0, 0, 0, 0, 0xc0, 0];
    // From the bottom row up: two rows of color 2, two of color 1, each ending its row; then the end of the picture.
    const key = [8, 2, 0, 0, 8, 2, 0, 0, 8, 1, 0, 0, 8, 1, 0, 0, 0, 1];
    // Move 3 right and 2 up (to the second row from the top), then 3 colors as they are (3, 3, 1), padded; the end.
    const over = [0, 2, 3, 2, 0, 3, 3, 3, 1, 0, 0, 1];
    const blank = [8, 0, 0, 0, 8, 0, 0, 0, 8, 0, 0, 0, 8, 0, 0, 0, 0, 1];
    const tone = Array.from({ length: 8000 }, (_, i) => 128 + Math.round(60 * Math.sin((2 * Math.PI * 440 * i) / 8000)));
    const strh = (type: string, handler: string, scale: number, rate: number, length: number, sampleSize: number) => [
        ...text(type),
        ...text(handler),
        ...u32(0),
        ...u16(0),
        ...u16(0),
        ...u32(0),
        ...u32(scale),
        ...u32(rate),
        ...u32(0),
        ...u32(length),
        ...u32(0),
        ...u32(0xffffffff),
        ...u32(sampleSize),
        ...u16(0),
        ...u16(0),
        ...u16(type === 'vids' ? W : 0),
        ...u16(type === 'vids' ? H : 0),
    ];
    const bitmap = [...u32(40), ...u32(W), ...u32(H), ...u16(1), ...u16(8), ...u32(1), ...u32(0), ...u32(0), ...u32(0), ...u32(4), ...u32(0), ...colors];
    const sound = [...u16(1), ...u16(1), ...u32(8000), ...u32(8000), ...u16(1), ...u16(8), ...u16(0)];
    const hdrl = riffChunk('LIST', [
        ...text('hdrl'),
        ...riffChunk('avih', [...u32(250000), ...u32(0), ...u32(0), ...u32(0x110), ...u32(4), ...u32(0), ...u32(2), ...u32(0), ...u32(W), ...u32(H), ...new Array(16).fill(0)]),
        ...riffChunk('LIST', [...text('strl'), ...riffChunk('strh', strh('vids', 'mrle', 1, 4, 4, 0)), ...riffChunk('strf', bitmap)]),
        ...riffChunk('LIST', [...text('strl'), ...riffChunk('strh', strh('auds', '\0\0\0\0', 1, 8000, 8000, 1)), ...riffChunk('strf', sound)]),
    ]);
    // Palette change: from color 3, 1 color, flags 0, then red, green, blue and flags.
    const change = [3, 1, 0, 0, 255, 255, 255, 0];
    const parts: [string, number[], number][] = [
        ['00dc', key, 0x10],
        ['01wb', tone.slice(0, 2000), 0x10],
        ['00dc', over, 0],
        ['01wb', tone.slice(2000, 4000), 0x10],
        ['00pc', change, 0],
        ['00dc', [], 0],
        ['01wb', tone.slice(4000, 6000), 0x10],
        ['00dc', blank, 0x10],
        ['01wb', tone.slice(6000), 0x10],
    ];
    const movi: number[] = [...text('movi')];
    const index: number[] = [];
    for (const [id, body, flags] of parts) {
        index.push(...text(id), ...u32(flags), ...u32(movi.length), ...u32(body.length));
        movi.push(...riffChunk(id, body));
    }
    const body = [...text('AVI '), ...hdrl, ...riffChunk('LIST', movi), ...riffChunk('idx1', index)];
    return bytes(text('RIFF'), u32(body.length), body);
}

/**
 * Raw Deflate (RFC 1951) in one block with the fixed codes, from literal bytes and back-references given as
 * [length, distance]: a back-reference can reach into what came before this data (`before` bytes of it), as MSZIP's
 * blocks do. Written by hand, not by zlib, so the bytes are the same everywhere.
 */
function fixedDeflate(ops: (number | [number, number])[]): number[] {
    const out: number[] = [];
    let bits = 0;
    let count = 0;
    const put = (value: number, n: number) => {
        for (let i = 0; i < n; i++) {
            bits |= ((value >> i) & 1) << count++;
            if (count === 8) {
                out.push(bits);
                bits = 0;
                count = 0;
            }
        }
    };
    // Huffman codes go most significant bit first.
    const code = (value: number, n: number) => put(Number.parseInt(value.toString(2).padStart(n, '0').split('').reverse().join(''), 2), n);
    const symbol = (s: number) => (s < 144 ? code(0x30 + s, 8) : s < 256 ? code(0x190 + s - 144, 9) : s < 280 ? code(s - 256, 7) : code(0xc0 + s - 280, 8));
    const LENGTHS = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
    const LENGTH_BITS = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
    const DISTANCES = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
    const DISTANCE_BITS = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
    put(1, 1);
    put(1, 2);
    for (const op of ops) {
        if (typeof op === 'number') {
            symbol(op);
            continue;
        }
        const [length, distance] = op;
        const l = LENGTHS.findLastIndex((v) => v <= length);
        symbol(257 + l);
        put(length - LENGTHS[l], LENGTH_BITS[l]);
        const d = DISTANCES.findLastIndex((v) => v <= distance);
        code(d, 5);
        put(distance - DISTANCES[d], DISTANCE_BITS[d]);
    }
    symbol(256);
    if (count) out.push(bits);
    return out;
}

/** A cabinet data block's checksum (Microsoft's CSUMCompute): its data, then its two sizes, 4 bytes at a time, XORed. */
function cabSum(bytes: number[], seed = 0): number {
    let sum = seed;
    const whole = bytes.length & ~3;
    for (let i = 0; i < whole; i += 4) sum ^= bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24);
    let rest = 0;
    for (let i = whole; i < bytes.length; i++) rest = (rest << 8) | bytes[i];
    return (sum ^ rest) >>> 0;
}

/**
 * A Microsoft cabinet of three files in two folders. The first folder isn't compressed and holds readme.txt. The
 * second is MSZIP, in two blocks: the first unpacks to a full 32 KB (data\one.txt, a sentence again and again, and
 * the start of data\two.txt), and the second finishes two.txt with a back-reference reaching into the first block.
 * Every block has its checksum. `signed` sets aside 20 bytes in the header saying where a signature is, and puts one
 * (the sample Authenticode) after the cabinet. `short` makes one.txt the sentence once, so the first block is 32 bytes,
 * not 32 KB: what no real cabinet does, and where programs differ on what the second block reaches back into.
 */
export function cabinet({ signed = false, short = false }: { signed?: boolean; short?: boolean } = {}): Uint8Array {
    const readme = text('Chimera sample cabinet.\r\n');
    const sentence = text('The first file in MSZIP. ');
    const twoStart = text('Twice: ');
    const oneLength = short ? sentence.length : 32768 - twoStart.length;
    const one = Array.from({ length: oneLength }, (_, i) => sentence[i % sentence.length]);
    // one.txt: the sentence, then copies of what came before, 258 bytes at most each.
    const ops: (number | [number, number])[] = [...sentence];
    for (let left = oneLength - sentence.length; left > 0; left -= Math.min(258, left)) ops.push([Math.min(258, left), sentence.length]);
    const block1 = [...text('CK'), ...fixedDeflate([...ops, ...twoStart])];
    // two.txt ends with a copy of the sentence from where it starts in one.txt, 43 bytes before the second block.
    const reach = oneLength + twoStart.length - Math.floor((oneLength - sentence.length) / sentence.length) * sentence.length;
    const block2 = [...text('CK'), ...fixedDeflate([[sentence.length, reach]])];
    const blocks = [
        { folder: 0, packed: readme, size: readme.length },
        { folder: 1, packed: block1, size: oneLength + twoStart.length },
        { folder: 1, packed: block2, size: sentence.length },
    ];
    const files = [
        { name: 'readme.txt', size: readme.length, offset: 0, folder: 0 },
        { name: 'data\\one.txt', size: one.length, offset: 0, folder: 1 },
        { name: 'data\\two.txt', size: twoStart.length + sentence.length, offset: one.length, folder: 1 },
    ];
    const reserve = signed ? 20 : 0;
    const headerSize = 36 + (signed ? 4 + reserve : 0);
    const foldersAt = headerSize;
    const filesAt = foldersAt + 2 * 8;
    // 1997-04-23 14:02:10.
    const [date, time] = [(17 << 9) | (4 << 5) | 23, (14 << 11) | (2 << 5) | 5];
    const fileBytes = files.flatMap((f) => [...u32(f.size), ...u32(f.offset), ...u16(f.folder), ...u16(date), ...u16(time), ...u16(0x20), ...text(f.name), 0]);
    let at = filesAt + fileBytes.length;
    const dataAt = [at, 0];
    const blockBytes = blocks.flatMap((k, i) => {
        if (i === 1) dataAt[1] = at;
        const sizes = [...u16(k.packed.length), ...u16(k.size)];
        at += 8 + k.packed.length;
        return [...u32(cabSum(sizes, cabSum(Array.from(k.packed)))), ...sizes, ...Array.from(k.packed)];
    });
    const size = at;
    const signature = signed ? Array.from(authenticode()) : [];
    const header = [
        ...text('MSCF'),
        ...u32(0),
        ...u32(size),
        ...u32(0),
        ...u32(filesAt),
        ...u32(0),
        3,
        1,
        ...u16(2),
        ...u16(files.length),
        ...u16(signed ? 4 : 0),
        ...u16(0x1997),
        ...u16(0),
        ...(signed ? [...u16(reserve), 0, 0, ...u16(0), ...u16(16), ...u32(size), ...u32(signature.length), ...u32(0), ...u32(0)] : []),
    ];
    const folders = [...u32(dataAt[0]), ...u16(1), ...u16(0), ...u32(dataAt[1]), ...u16(2), ...u16(1)];
    return bytes(header, folders, fileBytes, blockBytes, signature);
}

/** A file for zipArchive: its name, its data, and how it's packed. */
export interface ZipFile {
    name: string;
    data: Uint8Array;
    /** 0 stored, 8 Deflate (fixed codes, the data as literals), 10 PKWARE DCL implode. */
    method?: 0 | 8 | 10;
    /** Sizes and CRC in a descriptor after the data, its header leaving them 0 (flag 8). */
    descriptor?: boolean;
    /** The name in UTF-8 (flag 0x800), not code page 437. */
    utf8?: boolean;
}

/**
 * A ZIP archive (PKWARE's APPNOTE): each file's header and data (and descriptor), then the directory, then the end
 * record with `comment`. Dates are 1997-04-23 14:02:10, made on MS-DOS (ZIP64: Unix). `prefix` goes before it all, as a
 * self-extractor's program does, with the offsets counting from after it; `zip64` writes ZIP64's end record and
 * locator, and each directory entry's header offset as 0xFFFFFFFF with the real one in a ZIP64 extra field.
 */
export function zipArchive(files: ZipFile[], { comment = '', prefix = [], zip64 = false }: { comment?: string; prefix?: number[]; zip64?: boolean } = {}): Uint8Array {
    const [date, time] = [(17 << 9) | (4 << 5) | 23, (14 << 11) | (2 << 5) | 5];
    const local: number[] = [];
    const central: number[] = [];
    for (const f of files) {
        const method = f.method ?? 0;
        const packed = method === 8 ? fixedDeflate(Array.from(f.data)) : method === 10 ? Array.from(implode(f.data)) : Array.from(f.data);
        const crc = crc32(f.data);
        const name = f.utf8 ? Array.from(new TextEncoder().encode(f.name)) : text(f.name);
        const flags = (f.descriptor ? 8 : 0) | (f.utf8 ? 0x800 : 0);
        const at = local.length;
        const sizes = f.descriptor ? [...u32(0), ...u32(0), ...u32(0)] : [...u32(crc), ...u32(packed.length), ...u32(f.data.length)];
        // ZIP64 needs version 4.5 to read it; the rest, 2.0.
        const needed = zip64 ? 45 : 20;
        local.push(...text('PK\x03\x04'), ...u16(needed), ...u16(flags), ...u16(method), ...u16(time), ...u16(date), ...sizes, ...u16(name.length), ...u16(0), ...name, ...packed);
        if (f.descriptor) local.push(...text('PK\x07\x08'), ...u32(crc), ...u32(packed.length), ...u32(f.data.length));
        const extra = zip64 ? [...u16(1), ...u16(8), ...u32(at), ...u32(0)] : [];
        central.push(
            ...text('PK\x01\x02'),
            // Made on MS-DOS, or for ZIP64 on Unix, as Python makes them: Info-ZIP's UnZip 6.0 takes a UTF-8 name from
            // MS-DOS for code page 437 when there's a ZIP64 extra field, and says the names disagree.
            ...u16(needed | ((zip64 ? 3 : 0) << 8)),
            ...u16(needed),
            ...u16(flags),
            ...u16(method),
            ...u16(time),
            ...u16(date),
            ...u32(crc),
            ...u32(packed.length),
            ...u32(f.data.length),
            ...u16(name.length),
            ...u16(extra.length),
            ...u16(0),
            ...u16(0),
            ...u16(0),
            ...u32(f.name.endsWith('/') ? 0x10 : 0x20),
            ...u32(zip64 ? 0xffffffff : at),
            ...name,
            ...extra
        );
    }
    const end64 = zip64
        ? [
              ...text('PK\x06\x06'),
              ...u32(44),
              ...u32(0),
              ...u16(45),
              ...u16(45),
              ...u32(0),
              ...u32(0),
              ...u32(files.length),
              ...u32(0),
              ...u32(files.length),
              ...u32(0),
              ...u32(central.length),
              ...u32(0),
              ...u32(local.length),
              ...u32(0),
          ]
        : [];
    const locator = zip64 ? [...text('PK\x06\x07'), ...u32(0), ...u32(local.length + central.length), ...u32(0), ...u32(1)] : [];
    const note = text(comment);
    const end = [...text('PK\x05\x06'), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length), ...u32(central.length), ...u32(local.length), ...u16(note.length), ...note];
    return bytes(prefix, local, central, end64, locator, end);
}

/** The sample ZIP: a stored file, one in Deflate, one imploded, a folder, a name in UTF-8, one with a descriptor. */
export function zipSample(options: { comment?: string; prefix?: number[]; zip64?: boolean } = { comment: 'Chimera sample archive' }): Uint8Array {
    const line = text('ZIP keeps each file whole, and lists them again at its end. ');
    return zipArchive(
        [
            { name: 'readme.txt', data: Uint8Array.from(text('Chimera sample ZIP.\r\n')) },
            { name: 'data/', data: new Uint8Array(0) },
            { name: 'data/deflated.txt', data: Uint8Array.from([...line, ...line]), method: 8 },
            { name: 'data/imploded.txt', data: Uint8Array.from([...line, ...line, ...line]), method: 10 },
            { name: 'Grüße.txt', data: Uint8Array.from(text('Hallo.\n')), utf8: true },
            { name: 'later.txt', data: Uint8Array.from(text('Sizes after the data.\n')), descriptor: true },
        ],
        options
    );
}

/** LZ77 as Windows Help packs it, with every byte as it is: a flag byte of 0 before each 8. */
function helpLz77(data: number[]): number[] {
    const out: number[] = [];
    for (let i = 0; i < data.length; i += 8) out.push(0, ...data.slice(i, i + 8));
    return out;
}

/** A Windows Help B+ tree of one leaf page: its header, then the page, its entries, the rest unused. */
function helpBtree(structure: string, entries: number[][], directory = false): number[] {
    const PAGE = 1024;
    const used = entries.reduce((n, e) => n + e.length, 0);
    const name = [...text(structure), ...new Array(16 - structure.length).fill(0)];
    const header = [...u16(0x293b), ...u16(directory ? 0x0402 : 0x0002), ...u16(PAGE), ...name, ...u16(0), ...u16(0), ...u16(0), ...u16(0xffff), ...u16(1), ...u16(1), ...u32(entries.length)];
    const page = [...u16(PAGE - 8 - used), ...u16(entries.length), ...u16(0xffff), ...u16(0xffff), ...entries.flat()];
    return [...header, ...page, ...new Array(PAGE - page.length).fill(0)];
}

/** A compressed number of Windows Help: a word as a byte (value × 2) or two (× 2 + 1); a long as two bytes or four. */
const helpWord = (v: number) => (v < 128 ? [v * 2] : u16(v * 2 + 1));
const helpLong = (v: number) => (v < 32768 ? u16(v * 2) : u32(v * 2 + 1));
/** A signed one, as a record's sizes are: 0x4000 added in the short form (0x40000000 in the long). */
const helpSignedLong = (v: number) => (v + 0x4000 < 32768 ? u16((v + 0x4000) * 2) : u32((v + 0x40000000) * 2 + 1));

/**
 * A Windows Help file, made small: two topics, the first with a font change (to bold green Arial, from |FONT), a tab, a
 * line break, a jump (to the second) and a picture, the second with a table of two cells, all of it non-scrolling. Its phrase table shortens the text, as Windows 3.1's
 * help compiler does (|Phrases, the file version 21), or with `hall` as Windows 95's does (|PhrIndex and |PhrImage,
 * version 33). |SYSTEM gives a title, a copyright, the contents topic, a macro and a window; there are title, context,
 * keyword and map indexes, and |bm0, a 1-bit picture packed in runs, with a hotspot that jumps to the second topic.
 * The topics are LZ77-packed (every byte as it is), in one 4 KB block. Made by hand after helpdeco's helpfile.txt.
 */
export function winHelp({ hall = false }: { hall?: boolean } = {}): Uint8Array {
    // Windows' character set: ’ is 0x92.
    const ansi = (s: string) => [...s].map((c) => (c === '’' ? 0x92 : c.charCodeAt(0)));
    const zstr = (s: string) => [...ansi(s), 0];
    const phrases = ['Chimera', 'sample', 'the '];

    // A topic record (TOPICLINK): its size, its text's size unpacked, the records before and after, its first part's size, its kind.
    type Link = { type: number; first: number[]; strings: string[] };
    /** The strings, with the phrases put in: Windows 3.1's codes (1 to 15 and a byte) or Hall's. */
    const shorten = (s: number[]): number[] => {
        const out: number[] = [];
        const literal: number[] = [];
        const flush = () => {
            // Hall: runs of up to 32 bytes as they are, after (length - 1) × 8 + 3.
            for (let i = 0; i < literal.length; i += 32) {
                const part = literal.slice(i, i + 32);
                out.push(((part.length - 1) << 3) | 3, ...part);
            }
            literal.length = 0;
        };
        for (let i = 0; i < s.length;) {
            const n = phrases.findIndex((ph) => ansi(ph).every((v, k) => s[i + k] === v));
            if (n < 0) {
                if (hall) literal.push(s[i]);
                else out.push(s[i]);
                i++;
                continue;
            }
            i += phrases[n].length;
            if (hall) {
                flush();
                out.push(n * 2);
            } else {
                // A space after it, when there is one, goes in the code's low bit.
                const space = s[i] === 0x20 && !phrases[n].endsWith(' ');
                if (space) i++;
                const v = n * 2 + (space ? 1 : 0);
                out.push((v >> 8) + 1, v & 0xff);
            }
        }
        flush();
        return out;
    };
    const topicOffsets: number[] = [];
    const links: Link[] = [];
    // The first topic: its header, then its text.
    const textStrings = ['Chimera’s sample help, ', 'in bold.', 'Name', 'Value', 'See ', 'the second topic', '.', '', ''];
    const charsOf = (strings: string[]) => strings.reduce((n, s) => n + ansi(s).length + 1, 0);
    const firstChars = charsOf(textStrings);
    // Its codes: a font, the end of a paragraph, a tab, a line break, a jump (to the second topic: the hash of its context
    // name, as |CONTEXT has it), its end, the end of a paragraph, a picture (bm0, with 1 hotspot), and the end.
    const paragraph = [0, 0x80, ...u16(0), ...u16(0x0002), ...helpWord(0x40 + 5)];
    const picture = [0x86, 0x22, ...helpSignedLong(4), ...helpWord(1), ...u16(0), ...u16(0)];
    // The hashes of the topics' context names, "welcome" and "second", as WinHelp makes them (helpfile.txt).
    const WELCOME = 0x2454ab76;
    const SECOND = 0x370e6d04;
    const codes1 = [0x80, ...u16(1), 0x82, 0x83, 0x81, 0xe3, ...u32(SECOND), 0x89, 0x82, ...picture, 0xff];
    const tableStrings = ['Left', '', 'Right', '', ''];
    const tableChars = charsOf(tableStrings);
    // A table of 2 columns, of fixed width: each 2 inches wide (288 half points), the first's gap (its left margin) 0, the
    // second's 5.5 points, as real ones are (helpfile.txt puts the gap first; real files, and helpdeco, the width). Each
    // cell's paragraph its column, then the end of its paragraph and the end.
    const cell = (column: number) => [...u16(column), ...u16(0), 0, 0, 0x80, ...u16(0), ...u16(0)];
    const table = [2, 1, ...u16(288), ...u16(0), ...u16(288), ...u16(11), ...cell(0), 0x82, 0xff, ...cell(1), 0x82, 0xff, ...u16(0xffff)];
    topicOffsets.push(0, firstChars);
    links.push({ type: 2, first: [], strings: ['Welcome', 'Chimera()'] });
    links.push({ type: 0x20, first: [...helpSignedLong(0), ...helpWord(firstChars), ...paragraph, ...codes1], strings: textStrings });
    links.push({ type: 2, first: [], strings: ['Second topic'] });
    links.push({ type: 0x23, first: [...helpSignedLong(0), ...helpWord(tableChars), ...table], strings: tableStrings });
    // The records, laid out from TOPICPOS 12; a topic header's first part is its TOPICHEADER.
    const stream: number[] = [];
    const sizes = links.map((l) => {
        const raw = l.strings.flatMap((s) => [...ansi(s), 0]);
        // Stored as it is when shortening wouldn't make it shorter, as the compilers do (its size then says it isn't shortened).
        const short = l.type === 2 ? raw : shorten(raw);
        const packed = short.length < raw.length ? short : raw;
        const first = l.type === 2 ? 28 : l.first.length;
        return { raw, packed, first: 21 + first };
    });
    const positions: number[] = [];
    let at = 12;
    for (const s of sizes) {
        positions.push(at);
        at += s.first + s.packed.length;
    }
    const endAt = at;
    links.forEach((l, i) => {
        const s = sizes[i];
        const next = positions[i + 1] ?? endAt;
        // The second topic is all non-scrolling: its band starts at its table, and the scrolling part is -1.
        const band = i === 2 ? [...u32(positions[3]), ...u32(0xffffffff)] : [...u32(0xffffffff), ...u32(positions[i])];
        const first = l.type === 2 ? [...u32(0), ...u32(0xffffffff), ...u32(0xffffffff), ...u32(i >> 1), ...band, ...u32(positions[i + 2] ?? endAt)] : l.first;
        stream.push(...u32(s.first + s.packed.length), ...u32(s.raw.length), ...u32(positions[i - 1] ?? 0xffffffff), ...u32(next), ...u32(s.first), l.type, ...first, ...s.packed);
    });
    // The last record: it only ends the chain.
    stream.push(...u32(21), ...u32(0), ...u32(positions.at(-1)!), ...u32(0xffffffff), ...u32(21), 2);
    const topic = [...u32(0xffffffff), ...u32(12), ...u32(positions[2]), ...helpLz77(stream)];
    const endOffset = firstChars + tableChars;

    // The phrases.
    const phraseBytes = phrases.flatMap(ansi);
    let phraseFiles: [string, number[]][];
    if (!hall) {
        const offsets: number[] = [];
        let o = 2 * (phrases.length + 1);
        for (const p of phrases) {
            offsets.push(o);
            o += p.length;
        }
        offsets.push(o);
        phraseFiles = [['|Phrases', [...u16(phrases.length), ...u16(0x0100), ...u32(phraseBytes.length), ...offsets.flatMap(u16), ...helpLz77(phraseBytes)]]];
    } else {
        // Each length: as many 1s as it has 4s past the first, a 0, then 2 bits of what's left; the bits from the lowest up.
        const bits: number[] = [];
        for (const p of phrases) {
            const n = p.length - 1;
            for (let k = 0; k < n >> 2; k++) bits.push(1);
            bits.push(0, n & 1, (n >> 1) & 1);
        }
        const words: number[] = [];
        for (let i = 0; i < bits.length; i += 32) words.push(bits.slice(i, i + 32).reduce((w, v, k) => w | (v << k), 0) >>> 0);
        const index = [...u32(1), ...u32(phrases.length), ...u32(0), ...u32(phraseBytes.length), ...u32(phraseBytes.length), ...u32(0), ...u16(2), ...u16(0x4a00), ...words.flatMap(u32), ...u32(0)];
        phraseFiles = [
            ['|PhrIndex', index],
            ['|PhrImage', phraseBytes],
        ];
    }

    // |SYSTEM: its header (1997-01-01), then its records.
    const record = (type: number, data: number[]) => [...u16(type), ...u16(data.length), ...data];
    const fixed = (s: string, n: number) => [...ansi(s), ...new Array(n - s.length).fill(0)];
    const window = [
        ...u16(0x7f),
        ...fixed('main', 10),
        ...fixed('main', 9),
        ...fixed('Chimera Help', 51),
        ...u16(100),
        ...u16(100),
        ...u16(600),
        ...u16(800),
        ...u16(0),
        ...u32(0xffffff),
        ...u32(0xc0c0c0),
    ];
    const system = [
        ...u16(0x036c),
        ...u16(hall ? 33 : 21),
        ...u16(1),
        ...u32(852076800),
        ...u16(4),
        ...record(1, zstr('Chimera Sample Help')),
        ...record(2, zstr('Chimera, 1997')),
        ...record(3, u32(0)),
        ...record(4, zstr('BrowseButtons()')),
        ...record(6, window),
    ];
    // |bm0: a 1-bit 8 × 2 picture, its rows packed in runs, and a hotspot (a jump to "second") over all of it.
    // Rows of 4 bytes (8 pixels, padded), the bottom one first: F0 00 00 00 and 0F 00 00 00, each a byte as it is, then 3 zeros.
    const pixels = [0x81, 0xf0, 0x03, 0x00, 0x81, 0x0f, 0x03, 0x00];
    const hotspots = [1, ...u16(1), ...u32(0), 0xe3, 0, 0, ...u16(0), ...u16(0), ...u16(8), ...u16(2), ...u32(SECOND), ...zstr('arrow'), ...zstr('second')];
    const head = [
        6,
        1,
        ...helpLong(96),
        ...helpLong(96),
        ...helpWord(1),
        ...helpWord(1),
        ...helpLong(8),
        ...helpLong(2),
        ...helpLong(2),
        ...helpLong(0),
        ...helpLong(pixels.length),
        ...helpLong(hotspots.length),
    ];
    const pictureAt = 8;
    const dataAt = head.length + 8 + 8;
    const bm0 = [...u16(0x506c), ...u16(1), ...u32(pictureAt), ...head, ...u32(dataAt), ...u32(dataAt + pixels.length), ...[0, 0, 0, 0, 255, 255, 255, 0], ...pixels, ...hotspots];
    const files: [string, number[]][] = [
        ['|SYSTEM', system],
        ...phraseFiles,
        ['|TOPIC', topic],
        [
            '|TTLBTREE',
            helpBtree('Lz', [
                [...u32(0), ...zstr('Welcome')],
                [...u32(topicOffsets[1]), ...zstr('Second topic')],
                [...u32(endOffset), 0],
            ]),
        ],
        [
            '|CONTEXT',
            helpBtree('L4', [
                [...u32(WELCOME), ...u32(0)],
                [...u32(SECOND), ...u32(topicOffsets[1])],
            ]),
        ],
        [
            '|KWBTREE',
            helpBtree('F24', [
                [...zstr('chimera'), ...u16(2), ...u32(0)],
                [...zstr('table'), ...u16(1), ...u32(8)],
            ]),
        ],
        ['|KWDATA', [...u32(0), ...u32(topicOffsets[1]), ...u32(topicOffsets[1])]],
        ['|CTXOMAP', [...u16(1), ...u32(100), ...u32(0)]],
        ['|bm0', bm0],
        // Two faces of 20 bytes, then two fonts: MS Sans Serif, 10 points, in the window's color (1, 1, 0); Arial, 12
        // points, bold and green.
        [
            '|FONT',
            [
                ...u16(2),
                ...u16(2),
                ...u16(8),
                ...u16(48),
                ...fixed('MS Sans Serif', 20),
                ...fixed('Arial', 20),
                ...[0, 20, 3, ...u16(0), 1, 1, 0, 1, 1, 0],
                ...[1, 24, 3, ...u16(1), 0, 0x80, 0, 1, 1, 0],
            ],
        ],
    ];
    // Laid out from byte 16: each file's 9-byte header and its bytes, then the directory.
    const out: number[] = [];
    const where: [string, number][] = [];
    for (const [name, bytes] of files) {
        where.push([name, 16 + out.length]);
        out.push(...u32(9 + bytes.length), ...u32(bytes.length), 4, ...bytes);
    }
    const directoryAt = 16 + out.length;
    const directory = helpBtree(
        'z4',
        where.sort(([x], [y]) => (x < y ? -1 : 1)).map(([name, at]) => [...zstr(name), ...u32(at)]),
        true
    );
    out.push(...u32(9 + directory.length), ...u32(directory.length), 4, ...directory);
    return bytes([...u32(0x00035f3f), ...u32(directoryAt), ...u32(0xffffffff), ...u32(16 + out.length)], out);
}

/** RTPatch's checksum: each byte XORed in, then the whole rotated left by 8, within `bits` bits. As rtptool's SPEC.md has it. */
function rtSum(data: ArrayLike<number>, bits: number): number {
    const mask = (1n << BigInt(bits)) - 1n;
    let w = 0n;
    for (let i = 0; i < data.length; i++) {
        const x = (w ^ BigInt(data[i])) & mask;
        w = ((x << 8n) | (x >> BigInt(bits - 8))) & mask;
    }
    return Number(w);
}

/** The file the RTPatch sample changes: a line of text, then a long (1,000), a short (300) and a byte (7). */
export function rtPatchOld(): Uint8Array {
    return bytes(text('Red Alert 1996: v1.00 by Westwood\r\n'), u32(1000), u16(300), [7]);
}

/**
 * An RTPatch patch, made small, laid out as Counterstrike's (format 0x012C, everything stored as it is): it adds
 * NEWFILE.TXT, deletes OLDFILE.TXT, and changes PATCHME.DAT (rtPatchOld) with a program that uses every operation:
 * copies, with a gap for new bytes before them and through a stored template; zero fills and fills of 1, 2 and 4 bytes,
 * with and without a gap; the new bytes poured into the gaps; and numbers of 1, 2 and 4 bytes changed in place. Its
 * numbers take 1, 2 and 3 bytes. Made by hand after rtptool's SPEC.md.
 */
export function rtPatch(): Uint8Array {
    const date = [...u16((17 << 9) | (3 << 5) | 17), ...u16((16 << 11) | (46 << 5) | 22)];
    const entry = (name: string, attributes: number, data: ArrayLike<number>) => [
        ...text(name),
        ...new Array(14 - name.length).fill(0),
        ...u16(attributes),
        ...u32(data.length),
        ...date,
        data.length % 31,
        data.length % 30,
        ...u32(rtSum(data, 31)),
        ...u32(rtSum(data, 30)),
    ];
    const added = text('Added by the patch.\r\n');
    const deleted = text('Notes the patch deletes.\r\n');
    const old = rtPatchOld();
    const made = rtPatchNew();
    const program = [
        ...[0x02, 0x00],
        ...[0x08, 0x00, 0x09], // template 0: "Red Alert"
        ...[0x03, 0x00, 0x0a], // "Red Alert "
        ...[0x04, 0x04, 0x0e, 0x05], // a gap for "1997", then ": v1."
        ...[0x04, 0x02, 0x15, 0x0e], // a gap for "10", then " by Westwood" and its line end
        ...[0x03, 0x40, 0x23, 0x07], // the numbers, from 35 (a 2-byte number)
        ...[0x09, 0x00], // template 0 again
        ...[0x0b, 0x03], // 3 zeros
        ...[0x11, 0x2d, 0x03], // "---"
        ...[0x12, 0x61, 0x62, 0x04], // "abab"
        ...[0x13, 0x57, 0x58, 0x59, 0x5a, 0x06], // "WXYZWX"
        ...[0x0a, 0x01, 0x00], // a gap for "!", then template 0
        ...[0x14, 0x02, 0x3d, 0x03], // a gap for the line end, then "==="
        ...[0x0c, 0x01, 0x02], // a gap for "#", then 2 zeros
        ...[0x16, 0x01, 0x31, 0x32, 0x33, 0x34, 0x04], // a gap for "+", then "1234"
        ...[0x15, 0x01, 0x78, 0x79, 0x02], // a gap for "*", then "xy"
        ...[0x05, ...text('1997'), ...text('10'), ...text('!'), 0x0d, 0x0a, ...text('#'), ...text('+'), ...text('*'), ...text('END')], // the last gap runs to the end
        ...[0x10, ...u32(24), 0x01, 0x60, 0x23, 0x00], // the long at 35 (a 3-byte number), 1,000 to 1,024
        ...[0x0f, ...u16(0xffff), 0x01, 0x27], // the short at 39, 300 to 299
        ...[0x06, 0x02, 0x01], // 2 on from there, the byte at 41: 7 to 8
        ...[0x0d, 0x02, 0x00, 0x20, 0x04, 0x20], // "R" and "A" at 0 and 4 to lower case
        ...[0x07, 0x01, 0x02, 0x36, 0x01], // the dashes at 54 and 55 to dots
        ...[0x0e, 0x02, 0x01, 0x39], // the "a" at 57 to "c"
        0x01,
    ];
    const nothing = new Array(10).fill(0);
    return bytes(
        [0x4b, 0x2a, ...u16(0x012c), ...u16(0x90e4), ...u32(0), ...u16(0x0020), ...u32(made.length), ...u32(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0)],
        [...u16(0x2441), ...nothing, 0x01, ...u32(added.length), ...u32(added.length), ...entry('NEWFILE.TXT', 0x20, added), ...added],
        [...u16(0x3441), ...nothing, 0x01, ...entry('OLDFILE.TXT', 0x20, deleted)],
        [...u16(0x4441), ...nothing, ...u16(0x0009), 0x01, 0x01, ...u32(program.length), ...u32(program.length), ...entry('PATCHME.DAT', 0x20, old), ...entry('PATCHME.DAT', 0x20, made), ...program],
        u16(0x1000)
    );
}

/** What the RTPatch sample makes of PATCHME.DAT, written out by hand. */
export function rtPatchNew(): Uint8Array {
    return bytes(text('red alert 1997: v1.10 by Westwood\r\n'), u32(1024), u16(299), [8], text('Red Alert'), [0, 0, 0], text('..-cbabWXYZWX!Red Alert\r\n===#'), [0, 0], text('+1234*xyEND'));
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
 * A Westwood sound driver laid out as ALFX.DRV is: two jumps (to the dispatcher, and to what the timer calls), then the
 * code: functions 0 and 1 handing back the version (1.00) and the driver's size, function 2 taking two values, function 13
 * taking three and doing nothing, the rest returning at once; an AdLib player's lookup of three music commands; the
 * table of 18 functions; the dispatcher; and the commands' table. Every routine is a bare return.
 */
export function westwoodDriver(): Uint8Array {
    const out = new Array<number>(117).fill(0);
    const put = (at: number, bytes: number[]) => out.splice(at, bytes.length, ...bytes);
    const rel = (from: number, to: number) => u16((to - from) & 0xffff);
    put(0, [0xe9, ...rel(3, 99), 0xe9, ...rel(6, 41)]);
    put(6, [0xb8, ...u16(0x100), 0xcb]);
    put(10, [0xb8, ...u16(117), 0xcb]);
    put(14, [0x0e, 0xe8, ...rel(18, 6), 0xcf]);
    put(18, [0x0e, 0xe8, ...rel(22, 10), 0xcf]);
    put(22, [0xcb]);
    put(23, [0x52, 0x50, 0x0e, 0xe8, ...rel(29, 22), 0x83, 0xc4, 0x04, 0xcf]);
    put(33, [0x51, 0x52, 0x50, 0x83, 0xc4, 0x06, 0xcf]);
    put(40, [0xcf, 0xcb]);
    put(42, [0x24, 0x7f, 0x3c, 0x02, 0x7e, 0x02, 0xb0, 0x02, 0x8a, 0xd8, 0x32, 0xff, 0xd0, 0xe3, 0x2e, 0xff, 0x97, ...u16(111), 0xc3, 0xc3]);
    const functions = Array.from({ length: 18 }, (_, i) => ({ 0: 14, 1: 18, 2: 23, 13: 33 })[i] ?? 40);
    put(63, functions.flatMap(u16));
    put(99, [0x83, 0xfb, 17, 0x77, (40 - 104) & 0xff, 0xd1, 0xe3, 0x2e, 0xff, 0xa7, ...u16(63)]);
    put(111, [62, 62, 62].flatMap(u16));
    return Uint8Array.from(out);
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

/**
 * TD map terrain (.bin): 64 × 64 cells, row by row, two bytes each: the template, then which of its tiles (across, then
 * down). 0xFF is clear ground, as everything outside a mission's playable area is. Each template is placed whole, as the
 * map editor does, and only ones every theater but jungle has (template IDs and sizes from CDATA.CPP).
 */
export function tdMap(): Uint8Array {
    const cells = new Uint8Array(64 * 64 * 2);
    for (let i = 0; i < cells.length; i += 2) cells[i] = 0xff;
    const place = (template: number, width: number, height: number, x: number, y: number) => {
        for (let j = 0; j < height; j++) {
            for (let i = 0; i < width; i++) {
                const at = ((y + j) * 64 + x + i) * 2;
                cells[at] = template;
                cells[at + 1] = j * width + i;
            }
        }
    };
    // A road across (D10, 4 × 2), a ford where a stream would cross it (FORD1, 3 × 3), rough ground (P07, 4 × 2) and
    // a bend of road (D05, 3 × 4), all inside the middle of the map, with boulders (B1, B2) scattered about.
    for (let x = 12; x < 48; x += 4) place(102, 4, 2, x, 30);
    place(161, 3, 3, 48, 29);
    place(97, 3, 4, 20, 32);
    place(73, 4, 2, 36, 20);
    place(73, 4, 2, 16, 40);
    for (const [x, y] of [
        [14, 22],
        [30, 24],
        [42, 38],
        [26, 44],
    ])
        place(82, 1, 1, x, y);
    place(83, 2, 1, 40, 26);
    return cells;
}

/**
 * A TD recorded game (RECORD.BIN): a 101-byte header with the player's name at byte 6, then each frame's view (x and y
 * in 256ths of a cell), its selection (a count, the sum of their TARGETs, the TARGETs) and, after frame 0, its events:
 * a type, the frame (with the house ID in bits 27 to 30), a player ID and 7 bytes of data.
 */
export function tdRecording(): Uint8Array {
    const header = new Array(101).fill(0);
    header.splice(6, 7, ...text('CHIMERA'));
    const view = (x: number, y: number) => u32(((y << 8) << 16) | (x << 8));
    const selection = (targets: number[]) => [...u32(targets.length), ...u32(targets.reduce((a, b) => a + b, 0)), ...targets.flatMap(u16)];
    const event = (type: number, frame: number, data: number[]) => [type, ...u32(frame | (6 << 27)), 0, ...data, ...new Array(7 - data.length).fill(0)];
    const events = (list: number[][]) => [...u32(list.length), ...list.flat()];
    const infantry = 0x3000 | 4;
    const cell = (x: number, y: number) => 0x1000 | (y * 64 + x);
    return bytes(
        header,
        // Frame 0: the view only (network games record no events for it).
        view(20, 30),
        selection([]),
        // Frame 1: start building a power plant (a building type, number 12).
        view(20, 30),
        selection([]),
        events([event(10, 1, [8, ...u32(12)])]),
        // Frame 2: an infantryman selected, and sent to cell (25, 33).
        view(20, 30),
        selection([infantry]),
        events([event(2, 2, [...u16(infantry), 2, ...u16(0), ...u16(cell(25, 33))])]),
        // Frame 3: nothing new; frame 4: the view moves, and the power plant is placed at (22, 32).
        view(20, 30),
        selection([infantry]),
        events([]),
        view(21, 31),
        selection([infantry]),
        events([event(7, 4, [7, ...u16(32 * 64 + 22)])])
    );
}

/**
 * A TD palette blending table, made as the game makes one (Create_Palette_Interpolation_Table in INTERPAL.CPP): the
 * palette brightened by 30% and capped at 63, then for each pair of colors the first color nearest the halfway point.
 * The cap makes the top of palette6()'s gray ramp one color, so those blend as the first of them.
 */
export function blendTable(palette = palette6()): Uint8Array {
    const p = palette.map((v) => Math.min(63, v + Math.floor((v * 30) / 100)));
    const table = new Uint8Array(256 * 256);
    for (let a = 0; a < 256; a++) {
        for (let b = 0; b < 256; b++) {
            const half = [0, 1, 2].map((c) => (p[a * 3 + c] + p[b * 3 + c]) >> 1);
            let best = 0;
            let bestDistance = 500000;
            for (let k = 0; k < 256; k++) {
                const d = (p[k * 3] - half[0]) ** 2 + (p[k * 3 + 1] - half[1]) ** 2 + (p[k * 3 + 2] - half[2]) ** 2;
                if (d < bestDistance) {
                    bestDistance = d;
                    best = k;
                }
            }
            table[a * 256 + b] = best;
        }
    }
    return table;
}

/**
 * An HMI SOS driver library (HMIDRV.386's layout, from SOS.H): a 44-byte header (a name, the driver count, where the
 * first driver is, the file's size cut to 16 bits), then each driver's 48-byte header (its name, its size plus 92, its
 * size, the device's ID, the DOS extender) and its code, which starts with a jump past a banner ending in 0x1A and the
 * device's name. These drivers' code is only that jump and a RET.
 */
export function sosLibrary(): Uint8Array {
    const driver = (name: string, device: number, extender: number, banner: string, deviceName: string) => {
        const body = [...text(`  ${banner}\r\n`), 0x1a, ...text(deviceName), 0];
        const code = [0xe9, ...u32(body.length), ...body, 0xc3];
        const field = [...text(name), ...new Array(32 - name.length).fill(0)];
        return [...field, ...u32(code.length + 92), ...u32(code.length), ...u32(device), ...u32(extender), ...code];
    };
    const drivers = [
        driver('sbdrv.com', 0xe000, 0x4000, 'HMI DMA Driver For Sound Blaster', 'Sound Blaster 8 Mono'),
        driver('sbdrvw.com', 0xe000, 0x8000, 'HMI DMA Driver For Sound Blaster', 'Sound Blaster 8 Mono'),
    ];
    const size = 44 + drivers.reduce((n, d) => n + d.length, 0);
    return bytes([...text('3'), ...new Array(31).fill(0)], u32(drivers.length), u32(44), u32(size & 0xffff), ...drivers);
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
        { name: 'cursor.ani', format: 'ani', about: 'Animated cursor: two frames (an arrow, a fading disc) in three steps of their own times and order, with a title', data: animatedCursor() },
        { name: 'video.avi', format: 'avi', about: 'AVI video: Microsoft RLE frames, one drawn over the last, a palette change, an empty frame, 8-bit sound, an index', data: aviVideo() },
        { name: 'cabinet.cab', format: 'cab', about: 'Microsoft cabinet: a folder stored, a folder in MSZIP whose second block reaches back into the first, checksums', data: cabinet() },
        {
            name: 'cabinet-signed.cab',
            format: 'cab',
            about: 'Microsoft cabinet, signed: the same files, an Authenticode signature after it that its header points to',
            data: cabinet({ signed: true }),
        },
        {
            name: 'certificate-v1.cer',
            format: 'x509',
            about: 'X.509 certificate, version 1: no version written, no extensions, as the first roots were',
            data: Uint8Array.from(certificate({ v1: true })),
        },
        {
            name: 'certificates.spc',
            format: 'pkcs7',
            about: 'A bag of certificates: PKCS #7 signed data alone with two certificates and no signer, as Internet Explorer 3 keeps one',
            data: certificateBag(),
        },
        { name: 'archive.zip', format: 'zip', about: 'ZIP archive: stored, Deflate and DCL-imploded files, a folder, a name in UTF-8, sizes in a descriptor, a comment', data: zipSample() },
        { name: 'archive-zip64.zip', format: 'zip', about: 'ZIP archive with ZIP64’s end record, locator, and header offsets in ZIP64 extra fields', data: zipSample({ zip64: true }) },
        {
            name: 'help.hlp',
            format: 'winhelp',
            about: 'Windows Help file (Windows 3.1): two topics, one with a table in its non-scrolling band, two fonts, phrase-compressed and LZ77, indexes, a window, a picture with a hotspot',
            data: winHelp(),
        },
        {
            name: 'patch.rtp',
            format: 'rtpatch',
            about: 'RTPatch patch, laid out as Counterstrike’s: a file added, one deleted, and one changed by a program using every operation',
            data: rtPatch(),
        },
        { name: 'help-hall.hlp', format: 'winhelp', about: 'Windows Help file (Windows 95): the same, its phrases Hall-compressed', data: winHelp({ hall: true }) },
        { name: 'icons.icl', format: 'ne', about: 'Windows 3 icon library: a 16-bit module with no code, holding one 16 × 16 icon', data: iconLibrary() },
        { name: 'music.mid', format: 'midi', about: 'Standard MIDI file, two tracks: a tempo change halfway, a named melody written with running status', data: standardMidi() },
        { name: 'music.xmi', format: 'xmi', about: 'XMIDI music, two sequences: a phrase with an instrument from the bank, and a chord with a branch point', data: xmidiMusic() },
        { name: 'team.emc', format: 'emc', about: 'Dune II script for the computer’s teams, in the game’s own style: a subroutine, a loop, a call to it', data: emcScript() },
        { name: 'credits.eng', format: 'dune2-credits', about: 'Dune II credits, as 1.07’s: a title, a role and its names, a centered line, the small print', data: duneCredits() },
        { name: 'mentat.eng', format: 'mentat', about: 'Dune II mentat encyclopedia: a briefing topic and a structure, its text compressed as the game does', data: mentat() },
        { name: 'music.adl', format: 'adl', about: 'Westwood AdLib music, as Dune II’s: a conductor starting two voices, one looping as Westwood’s tools do', data: adlMusic() },
        {
            name: 'alfx.drv',
            format: 'westwood-drv',
            about: 'Westwood sound driver, laid out as Dune II’s ALFX.DRV: 18 functions, an AdLib player’s three music commands, every routine a bare return',
            data: westwoodDriver(),
        },
        { name: 'driver.adv', format: 'ail', about: 'Miles AIL 2 sound driver: the tables of a Sound Blaster digital driver, each function a bare RETF', data: ailDriver() },
        { name: 'signature.p7s', format: 'pkcs7', about: 'Authenticode signature (PKCS #7): a program’s hash, a code-signing certificate, the signer’s attributes', data: authenticode() },
        { name: 'certificate.cer', format: 'x509', about: 'Certificate (X.509 version 3) for code signing, with a 1,024-bit RSA key', data: Uint8Array.from(certificate()) },
        { name: 'program-le.exe', format: 'le', about: 'A Linear Executable (LE) as Watcom lays one out: two objects, an exported entry point, two fixups, an import', data: linearProgram() },
        { name: 'program-dos4gw.exe', format: 'mz', about: 'A 32-bit DOS program as DOS/4GW binds one: its loader, a DOS/16M module (VMM.EXP), then the program (LE) it runs', data: dos4gwProgram() },
        { name: 'program.exe', format: 'mz', about: 'DOS program linked as Borland’s TLINK does with overlays: relocations, the segment table, one overlay with a fixup', data: dosProgram() },
        {
            name: 'program-pe.exe',
            format: 'pe',
            about: 'Windows program (PE, 32-bit) that does nothing: an import, an export, debug info naming a PDB, an icon and version information',
            data: windowsProgram(),
        },
        { name: 'program-pe64.exe', format: 'pe', about: 'The same program, 64-bit (PE32+), with a Rich header as Microsoft’s linker leaves', data: windowsProgram({ wide: true, rich: true }) },
        { name: 'resources.res', format: 'res', about: 'Resource file (.res) as a resource compiler writes one: an icon, a string, and a dialog that shows the icon', data: resourceFile() },
        {
            name: 'version-info.bin',
            format: 'version',
            about: 'Version information saved from a Windows program: version 1.0.0.0, five strings in English (US)',
            data: Uint8Array.from(versionResource()),
        },
        { name: 'program.pif', format: 'pif', about: 'Windows program information file: runs CHIMERA.EXE /SAMPLE, with the Windows 3 sections', data: pif() },
        { name: 'strings-dune2.eng', format: 'strings', about: 'Dune II string table, compressed as the game does', data: stringTable(true) },
        { name: 'strings-dos.ger', format: 'strings', about: 'C&C-style string table, plain, with accented letters in DOS characters', data: stringTable(false) },
        { name: 'record.bin', format: 'recording-td', about: 'TD recorded game: a power plant built and placed, an infantryman sent across', data: tdRecording() },
        { name: 'map-td.bin', format: 'map-td', about: 'TD map terrain: clear around the edges, a road with a bend and a ford, rough ground, boulders', data: tdMap() },
        { name: 'sides.pal', format: 'blend-table', about: 'TD palette blending table, made from the EGA colors and a gray ramp as the game makes them', data: blendTable() },
        { name: 'hmidrv.386', format: 'sos', about: 'HMI SOS sound driver library: two Sound Blaster drivers, for each DOS extender', data: sosLibrary() },
        { name: 'palette.pal', format: 'pal', about: 'VGA palette: the 16 EGA colors, then a gray ramp', data: palette6() },
        { name: 'dune.cfg', format: 'dune2-cfg', about: 'Dune II settings: MT-32 music, AdLib effects, Sound Blaster Pro voices, in German', data: duneCfg() },
        { name: 'options.cfg', format: 'dune2-options', about: 'Dune II game options, the game’s defaults', data: duneOptions() },
        { name: 'grayrmap.tbl', format: 'gray-remap', about: 'Dune II-style gray remap for palette.pal: each EGA color to the gray of its brightness', data: grayRemap() },
        { name: 'bmp-8.bmp', format: 'bmp', about: 'Windows bitmap: 256 colors, bottom row first, padded at the end as Paint pads them', data: bitmap(8, { pad: true }) },
        { name: 'bmp-4.bmp', format: 'bmp', about: 'Windows bitmap: 16 colors, two pixels a byte', data: bitmap(4) },
        { name: 'bmp-24.bmp', format: 'bmp', about: 'Windows bitmap: 24-bit, top row first (a negative height)', data: bitmap(24) },
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
        { name: 'pak-v3.pak', format: 'pak', about: 'Westwood PAK, version 3 (Kyrandia 2 and 3), holding three of these', data: pak(3, archived) },
        {
            name: 'installshield.z',
            format: 'installshield-z',
            about: 'InstallShield 3 archive: two directories, two files imploded and one stored, three of these',
            data: installShieldZ([
                {
                    name: 'PICTURES',
                    files: [
                        { name: 'CARD.CPS', data: archived[0][1] },
                        { name: 'PALETTE.PAL', data: archived[2][1], stored: true },
                    ],
                },
                { name: 'SOUNDS', files: [{ name: 'TONE.VOC', data: archived[1][1] }] },
            ]),
        },
        {
            name: 'mp3-id3v24.mp3',
            format: 'mp3',
            about: 'MPEG-1 layer III: an ID3v2.4 tag with a footer, then two silent 417-byte frames at 128 kbit/s and 44,100 Hz',
            data: mp3Tagged(),
        },
        {
            name: 'installshield.ins',
            format: 'installshield-ins',
            about: 'InstallShield 3 script: two system strings and two of its own, a number, a structure, a function of its own and one in a DLL, four bytes of code',
            data: installShieldScript(),
        },
        {
            name: 'installshield.ex_',
            format: 'installshield-engine',
            about: 'InstallShield 3 setup files: two of these, imploded, each with the second name setup unpacks it as',
            data: installShieldEngine([
                { name: 'CARD.CPS', alias: '_CARD.CPS', data: archived[0][1] },
                { name: 'TONE.VOC', alias: '_INV0432._MP', data: archived[1][1] },
            ]),
        },
        {
            name: 'installshield.pkg',
            format: 'installshield-pkg',
            about: 'InstallShield 3 package list: the files of installshield.z, in its two groups, at their unpacked sizes',
            data: installShieldPkg([
                {
                    name: 'INSTALLSHIELD.Z',
                    groups: [
                        {
                            name: 'PICTURES',
                            files: [
                                { name: 'CARD.CPS', size: archived[0][1].length },
                                { name: 'PALETTE.PAL', size: archived[2][1].length },
                            ],
                        },
                        { name: 'SOUNDS', files: [{ name: 'TONE.VOC', size: archived[1][1].length }] },
                    ],
                },
            ]),
        }
    );
    return out;
}
