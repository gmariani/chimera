import { crc32 } from './crc32';

/**
 * Writes RGBA pixels as a PNG file, synchronously, so a parser can hand out a
 * picture as a file (a SWF's lossless bitmaps). The data is stored, not
 * compressed: the bytes stay in memory, and saving them is rare.
 */
export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
    // Each row: filter type 0 (none), then the pixels.
    const raw = new Uint8Array(height * (1 + width * 4));
    for (let y = 0; y < height; y++) raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (1 + width * 4) + 1);
    const ihdr = new Uint8Array(13);
    const v = new DataView(ihdr.buffer);
    v.setUint32(0, width);
    v.setUint32(4, height);
    ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA, deflate, standard filters, not interlaced
    return concat([Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlibStored(raw)), chunk('IEND', new Uint8Array(0))]);
}

function chunk(type: string, data: Uint8Array): Uint8Array {
    const out = new Uint8Array(12 + data.length);
    const v = new DataView(out.buffer);
    v.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
}

/** A zlib stream of stored (uncompressed) blocks, at most 65,535 bytes each, and its Adler-32. */
function zlibStored(data: Uint8Array): Uint8Array {
    const blocks = Math.max(1, Math.ceil(data.length / 65535));
    const out = new Uint8Array(2 + blocks * 5 + data.length + 4);
    out.set([0x78, 0x01]);
    let o = 2;
    for (let b = 0; b < blocks; b++) {
        const part = data.subarray(b * 65535, (b + 1) * 65535);
        out.set([b === blocks - 1 ? 1 : 0, part.length & 0xff, part.length >> 8, ~part.length & 0xff, (~part.length >> 8) & 0xff], o);
        out.set(part, o + 5);
        o += 5 + part.length;
    }
    let a = 1;
    let s = 0;
    for (let i = 0; i < data.length; i++) {
        a = (a + data[i]) % 65521;
        s = (s + a) % 65521;
    }
    new DataView(out.buffer).setUint32(o, ((s << 16) | a) >>> 0);
    return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
        out.set(p, o);
        o += p.length;
    }
    return out;
}
