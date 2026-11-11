import { inflate } from '../../core/inflate';
import { decodeJpeg, segmentsOf } from '../jpeg/decode';
import { decodeCcitt } from './ccitt';
import { COMPRESSIONS, PHOTOMETRICS, type Ifd, type Tiff } from './ifd';
import { checkBytes, checkPixels, pixelBuffer } from '../../core/limits';

/**
 * Draws a TIFF picture: its strips (or tiles) decompressed, the samples read
 * at any depth from 1 to 32 bits, and turned to RGBA by its
 * PhotometricInterpretation. After TIFF 6.0 sections 3–6 and 9–23.
 */

const TAG = {
    width: 0x100,
    length: 0x101,
    bits: 0x102,
    compression: 0x103,
    photometric: 0x106,
    fillOrder: 0x10a,
    stripOffsets: 0x111,
    samples: 0x115,
    rowsPerStrip: 0x116,
    stripCounts: 0x117,
    planar: 0x11c,
    t4Options: 0x124,
    t6Options: 0x125,
    predictor: 0x13d,
    colorMap: 0x140,
    tileWidth: 0x142,
    tileLength: 0x143,
    tileOffsets: 0x144,
    tileCounts: 0x145,
    inkSet: 0x14c,
    extraSamples: 0x152,
    sampleFormat: 0x153,
    jpegTables: 0x15b,
    jpegInterchange: 0x201,
    jpegInterchangeLength: 0x202,
    yccCoefficients: 0x211,
    yccSubsampling: 0x212,
    referenceBlackWhite: 0x214,
} as const;

export interface Picture {
    width: number;
    height: number;
    rgba: Uint8Array;
}

/** Where a picture's data is: each strip or tile, as offsets in the file. */
export function chunksOf(tiff: Tiff, ifd: Ifd): { tiled: boolean; offsets: number[]; counts: number[] } {
    const tiled = ifd.entries.has(TAG.tileOffsets);
    return { tiled, offsets: tiff.values(ifd.entries.get(tiled ? TAG.tileOffsets : TAG.stripOffsets)), counts: tiff.values(ifd.entries.get(tiled ? TAG.tileCounts : TAG.stripCounts)) };
}

export function decodeTiff(data: Uint8Array, tiff: Tiff, ifd: Ifd): Picture {
    const all = (tag: number) => tiff.values(ifd.entries.get(tag));
    const one = (tag: number, fallback: number) => all(tag)[0] ?? fallback;
    const width = one(TAG.width, 0);
    const height = one(TAG.length, 0);
    const jpeg = embeddedJpeg(data, all);
    // A camera's preview: an IFD that only says where a JPEG is.
    if ((!width || !height) && jpeg) return decodeJpeg(jpeg, segmentsOf(jpeg).segments);
    if (!width || !height) throw new Error('It has no width or height.');
    checkPixels(width, height);
    const compression = one(TAG.compression, 1);
    const spp = one(TAG.samples, 1);
    const bitsList = all(TAG.bits);
    const bits = bitsList[0] ?? 1;
    if (bitsList.some((b) => b !== bits)) throw new Error(`Samples of different sizes (${bitsList.join(', ')} bits) aren't drawn here.`);
    const photometric = one(TAG.photometric, spp >= 3 ? 2 : 1);
    const format = one(TAG.sampleFormat, 1);
    const planar = one(TAG.planar, 1);
    const extra = all(TAG.extraSamples);

    if (photometric === 32803 || photometric === 34892) throw new Error("It's raw sensor data, which isn't drawn here.");
    if (!(photometric in PHOTOMETRICS) || photometric === 9 || photometric === 10)
        throw new Error(`${PHOTOMETRICS[photometric] ?? `Photometric interpretation ${photometric}`} pictures aren't drawn here.`);

    // Old-style JPEG (section 22, since withdrawn): drawn when the whole JPEG stream is in one place, by
    // JPEGInterchangeFormat or as the only strip (as Canon's raw files have it).
    if (compression === 6) {
        const [at] = all(TAG.stripOffsets);
        const [length] = all(TAG.stripCounts);
        const strip = all(TAG.stripOffsets).length === 1 && at !== undefined && data[at] === 0xff && data[at + 1] === 0xd8 ? data.subarray(at, at + length) : null;
        const stream = jpeg ?? strip;
        if (!stream) throw new Error("Old-style JPEG without a whole JPEG stream isn't drawn here.");
        return decodeJpeg(stream, segmentsOf(stream).segments, photometric === 6 ? true : photometric === 2 ? false : undefined);
    }

    const { tiled, offsets, counts } = chunksOf(tiff, ifd);
    if (!offsets.length) throw new Error('It has no strip or tile offsets.');
    const chunkWidth = tiled ? one(TAG.tileWidth, width) : width;
    const chunkHeight = Math.min(tiled ? one(TAG.tileLength, height) : one(TAG.rowsPerStrip, height), tiled ? Infinity : height);
    const across = Math.ceil(width / chunkWidth);
    const down = Math.ceil(height / chunkHeight);
    const planes = planar === 2 ? spp : 1;
    const perPixel = planar === 2 ? 1 : spp;
    const rgba = pixelBuffer(width, height, 4);

    if (compression === 7) {
        // Each strip or tile is a JPEG stream; JPEGTables holds the tables they share.
        if (planes > 1) throw new Error("JPEG-compressed pictures stored plane by plane aren't drawn here.");
        const tables = all(TAG.jpegTables);
        const tableBytes = tables.length > 4 ? Uint8Array.from(tables.slice(0, -2)) : null;
        for (let c = 0; c < across * down && c < offsets.length; c++) {
            let chunk = data.subarray(offsets[c], offsets[c] + (counts[c] ?? 0));
            if (tableBytes) {
                // The tables' SOI and segments, without their EOI, then the chunk without its SOI.
                const merged = new Uint8Array(tableBytes.length + chunk.length - 2);
                merged.set(tableBytes);
                merged.set(chunk.subarray(2), tableBytes.length);
                chunk = merged;
            }
            const picture = decodeJpeg(chunk, segmentsOf(chunk).segments, photometric === 6 ? true : photometric === 2 ? false : undefined);
            blit(rgba, width, height, picture, (c % across) * chunkWidth, Math.floor(c / across) * chunkHeight);
        }
        return { width, height, rgba };
    }

    // Each pixel's samples, scaled to 8 bits (a palette's are left as indexes).
    const indexed = photometric === 3 || (photometric <= 1 && bits === 1) || photometric === 4;
    const samples = new Uint16Array(checkBytes(width * height * spp * 2, 'The samples') / 2);
    const [subX, subY] = photometric === 6 ? [one(TAG.yccSubsampling, 2), all(TAG.yccSubsampling)[1] ?? 2] : [1, 1];
    const fillOrder = one(TAG.fillOrder, 1);
    const predictor = one(TAG.predictor, 1);
    if (predictor === 3) throw new Error("Floating-point prediction isn't drawn here.");

    for (let plane = 0; plane < planes; plane++) {
        for (let c = 0; c < across * down; c++) {
            const index = plane * across * down + c;
            const x0 = (c % across) * chunkWidth;
            const y0 = Math.floor(c / across) * chunkHeight;
            const rows = tiled ? chunkHeight : Math.min(chunkHeight, height - y0);
            const rowBytes = Math.ceil((chunkWidth * perPixel * bits) / 8);
            const subsampled = subX * subY > 1;
            // Subsampled YCbCr comes in blocks: subX × subY luma samples, then one Cb and one Cr.
            const expected = subsampled ? Math.ceil(chunkWidth / subX) * Math.ceil(rows / subY) * (subX * subY + 2) : rowBytes * rows;
            const at = offsets[index];
            if (at === undefined || at >= data.length) continue;
            let packed = data.subarray(at, Math.min(at + (counts[index] ?? data.length - at), data.length));
            if (fillOrder === 2) packed = packed.map(reverseBits);
            let raw = decompress(compression, packed, expected, { width: chunkWidth, rows, options: one(compression === 3 ? TAG.t4Options : TAG.t6Options, 0) });
            if (predictor === 2) raw = undoPredictor(raw, chunkWidth, rows, rowBytes, perPixel, bits, tiff.little);

            if (subsampled) {
                if (bits !== 8) throw new Error("Subsampled YCbCr that isn't 8-bit isn't drawn here.");
                const blocksAcross = Math.ceil(chunkWidth / subX);
                for (let b = 0, p = 0; p + subX * subY + 2 <= raw.length && b < blocksAcross * Math.ceil(rows / subY); b++, p += subX * subY + 2) {
                    const bx = x0 + (b % blocksAcross) * subX;
                    const by = y0 + Math.floor(b / blocksAcross) * subY;
                    for (let j = 0; j < subY; j++) {
                        for (let i = 0; i < subX; i++) {
                            const [x, y] = [bx + i, by + j];
                            if (x >= width || y >= height || x >= x0 + chunkWidth) continue;
                            const o = (y * width + x) * spp;
                            samples[o] = raw[p + j * subX + i];
                            samples[o + 1] = raw[p + subX * subY];
                            samples[o + 2] = raw[p + subX * subY + 1];
                        }
                    }
                }
                continue;
            }

            const read = sampleReader(raw, bits, format, tiff.little, indexed);
            for (let y = 0; y < rows && y0 + y < height; y++) {
                for (let x = 0; x < chunkWidth && x0 + x < width; x++) {
                    const o = ((y0 + y) * width + x0 + x) * spp;
                    for (let s = 0; s < perPixel; s++) samples[o + (planes > 1 ? plane : s)] = read(y * rowBytes, x * perPixel + s);
                }
            }
        }
    }

    toRgba(samples, rgba, width * height, spp, photometric, bits, extra, all, one);
    return { width, height, rgba };
}

/** The JPEG an IFD points to with JPEGInterchangeFormat, if it's in the file. */
function embeddedJpeg(data: Uint8Array, all: (tag: number) => number[]): Uint8Array | null {
    const [at] = all(TAG.jpegInterchange);
    const [length] = all(TAG.jpegInterchangeLength);
    return at !== undefined && length > 0 && at + length <= data.length ? data.subarray(at, at + length) : null;
}

/** Copies a decoded tile or strip into the picture, clipped at its edges. */
function blit(rgba: Uint8Array, width: number, height: number, part: Picture, x0: number, y0: number) {
    for (let y = 0; y < part.height && y0 + y < height; y++) {
        const w = Math.min(part.width, width - x0);
        rgba.set(part.rgba.subarray(y * part.width * 4, (y * part.width + w) * 4), ((y0 + y) * width + x0) * 4);
    }
}

const reverseBits = (b: number) => {
    b = ((b & 0xf0) >> 4) | ((b & 0x0f) << 4);
    b = ((b & 0xcc) >> 2) | ((b & 0x33) << 2);
    return ((b & 0xaa) >> 1) | ((b & 0x55) << 1);
};

/** Reads sample `n` of a row starting at `row`: at 8-bit scale, or (for palettes and bilevel) the value itself. */
function sampleReader(raw: Uint8Array, bits: number, format: number, little: boolean, indexed: boolean): (row: number, n: number) => number {
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const signed = format === 2;
    if (bits === 8) return signed ? (row, n) => raw[row + n] ^ 0x80 : (row, n) => raw[row + n];
    if (bits === 16) {
        if (format === 3) throw new Error("16-bit floating-point samples aren't drawn here.");
        // A palette's 16-bit indexes stay whole.
        return (row, n) => {
            const at = row + n * 2;
            const v = at + 2 <= raw.length ? view.getUint16(at, little) ^ (signed ? 0x8000 : 0) : 0;
            return indexed ? v : Math.round(v / 257);
        };
    }
    if (bits === 32) {
        return (row, n) => {
            const at = row + n * 4;
            if (at + 4 > raw.length) return 0;
            if (format === 3) return Math.round(Math.min(1, Math.max(0, view.getFloat32(at, little))) * 255);
            return ((view.getUint32(at, little) ^ (signed ? 0x80000000 : 0)) >>> 24) & 0xff;
        };
    }
    if (bits < 8) {
        const max = (1 << bits) - 1;
        return (row, n) => {
            const bit = n * bits;
            const v = (raw[row + (bit >> 3)] >> (8 - bits - (bit & 7))) & max;
            return indexed ? v : Math.round((v * 255) / max);
        };
    }
    throw new Error(`${bits}-bit samples aren't drawn here.`);
}

/** Section 14: each sample was stored as the difference from the one to its left. */
function undoPredictor(raw: Uint8Array, width: number, rows: number, rowBytes: number, perPixel: number, bits: number, little: boolean): Uint8Array {
    if (bits !== 8 && bits !== 16) throw new Error(`The predictor on ${bits}-bit samples isn't drawn here.`);
    const out = raw.slice();
    const view = new DataView(out.buffer);
    for (let y = 0; y < rows; y++) {
        const row = y * rowBytes;
        if (bits === 8) {
            for (let i = perPixel; i < width * perPixel && row + i < out.length; i++) out[row + i] = (out[row + i] + out[row + i - perPixel]) & 0xff;
        } else {
            for (let i = perPixel; i < width * perPixel && row + i * 2 + 2 <= out.length; i++)
                view.setUint16(row + i * 2, (view.getUint16(row + i * 2, little) + view.getUint16(row + (i - perPixel) * 2, little)) & 0xffff, little);
        }
    }
    return out;
}

function decompress(compression: number, packed: Uint8Array, expected: number, fax: { width: number; rows: number; options: number }): Uint8Array {
    switch (compression) {
        case 1:
            return packed;
        case 32773:
            return unpackBits(packed, expected);
        case 5:
            return lzw(packed, expected);
        case 8:
        case 32946:
            return inflate(packed, expected);
        case 2:
        case 3:
        case 4:
            return decodeCcitt(compression, packed, fax.width, fax.rows, fax.options);
    }
    throw new Error(`${COMPRESSIONS[compression] ?? `Compression ${compression}`} isn't drawn here.`);
}

/** Section 9: a count n, then n + 1 bytes as they are (n ≥ 0) or one byte 1 − n times (n < 0; −128 is skipped). */
export function unpackBits(packed: Uint8Array, expected: number): Uint8Array {
    const out = new Uint8Array(expected);
    let o = 0;
    for (let i = 0; i < packed.length && o < expected;) {
        const n = (packed[i++] << 24) >> 24;
        if (n >= 0) {
            out.set(packed.subarray(i, i + n + 1).subarray(0, expected - o), o);
            o += n + 1;
            i += n + 1;
        } else if (n !== -128) {
            out.fill(packed[i++], o, Math.min(o - n + 1, expected));
            o += 1 - n;
        }
    }
    return out;
}

/**
 * Section 13: LZW with codes of 9 to 12 bits, most significant bit first. 256
 * clears the table, 257 ends the data; the code width grows one code early
 * (at 511, 1023, 2047). Old files (before TIFF 6) have codes least significant
 * bit first, and grow on time; they start 00 01.
 */
export function lzw(packed: Uint8Array, expected: number): Uint8Array {
    const old = packed[0] === 0 && (packed[1] & 1) === 1;
    const early = old ? 0 : 1;
    const out = new Uint8Array(expected);
    let o = 0;
    // The table as links: each code's last byte, the code for the rest, and its length.
    const suffix = new Uint8Array(4096);
    const prefix = new Uint16Array(4096);
    const length = new Uint16Array(4096);
    for (let i = 0; i < 256; i++) {
        suffix[i] = i;
        length[i] = 1;
    }
    let next = 258;
    let width = 9;
    let bitPos = 0;
    const totalBits = packed.length * 8;

    const read = (): number => {
        if (bitPos + width > totalBits) return 257;
        let v = 0;
        if (old) for (let i = 0; i < width; i++, bitPos++) v |= ((packed[bitPos >> 3] >> (bitPos & 7)) & 1) << i;
        else for (let i = 0; i < width; i++, bitPos++) v = (v << 1) | ((packed[bitPos >> 3] >> (7 - (bitPos & 7))) & 1);
        return v;
    };
    const first = (code: number) => {
        while (length[code] > 1) code = prefix[code];
        return suffix[code];
    };
    const emit = (code: number) => {
        const n = length[code];
        for (let i = n - 1, c = code; i >= 0; i--, c = prefix[c]) if (o + i < expected) out[o + i] = suffix[c];
        o += n;
    };
    const add = (previous: number, byte: number) => {
        if (next < 4096) {
            suffix[next] = byte;
            prefix[next] = previous;
            length[next] = length[previous] + 1;
            next++;
        }
        if (next + early >= 1 << width && width < 12) width++;
    };

    for (let previous = -1; o < expected;) {
        const code = read();
        if (code === 257) break;
        if (code === 256) {
            next = 258;
            width = 9;
            previous = -1;
            continue;
        }
        if (previous < 0) {
            if (code > 255) break;
        } else if (code < next) {
            add(previous, first(code));
        } else {
            // The code being defined right now: the previous string and its own first byte.
            add(previous, first(previous));
        }
        emit(code);
        previous = code;
    }
    return out;
}

/** The samples as RGBA, by PhotometricInterpretation. */
function toRgba(
    samples: Uint16Array,
    rgba: Uint8Array,
    pixels: number,
    spp: number,
    photometric: number,
    bits: number,
    extra: number[],
    all: (tag: number) => number[],
    one: (tag: number, fallback: number) => number
) {
    // An alpha channel: the first extra sample, when it says so.
    const colors = photometric === 2 || photometric === 6 || photometric === 8 ? 3 : photometric === 5 ? Math.min(4, spp) : 1;
    const alphaKind = extra[0] ?? 0;
    const alphaAt = spp > colors && (alphaKind === 1 || alphaKind === 2) ? colors : -1;
    const map = all(TAG.colorMap);
    const entries = 1 << bits;
    const max = (1 << Math.min(bits, 8)) - 1;
    const coefficients = all(TAG.yccCoefficients);
    const [lr, lg, lb] = coefficients.length === 3 ? coefficients : [0.299, 0.587, 0.114];
    const rbw = all(TAG.referenceBlackWhite);
    const [yBlack, yWhite, cbZero, cbTop, crZero, crTop] = rbw.length === 6 ? rbw : [0, 255, 128, 255, 128, 255];
    const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
    if (photometric === 5 && one(TAG.inkSet, 1) !== 1) throw new Error("Inks other than CMYK aren't drawn here.");

    for (let i = 0, s = 0, o = 0; i < pixels; i++, s += spp, o += 4) {
        let r: number, g: number, b: number;
        switch (photometric) {
            case 0:
            case 1:
            case 4: {
                const v = bits === 1 ? samples[s] * 255 : samples[s];
                r = g = b = photometric === 0 ? 255 - v : v;
                break;
            }
            case 3: {
                const index = samples[s];
                [r, g, b] = [map[index] / 257, map[entries + index] / 257, map[2 * entries + index] / 257];
                break;
            }
            case 5: {
                const [c, m, y, k] = [samples[s], samples[s + 1], samples[s + 2], spp > 3 ? samples[s + 3] : 0];
                [r, g, b] = [((255 - c) * (255 - k)) / 255, ((255 - m) * (255 - k)) / 255, ((255 - y) * (255 - k)) / 255];
                break;
            }
            case 6: {
                // Section 21: back to full range by ReferenceBlackWhite, then the luma coefficients.
                const y = ((samples[s] - yBlack) * 255) / (yWhite - yBlack || 1);
                const cb = ((samples[s + 1] - cbZero) * 127) / (cbTop - cbZero || 1);
                const cr = ((samples[s + 2] - crZero) * 127) / (crTop - crZero || 1);
                r = cr * (2 - 2 * lr) + y;
                b = cb * (2 - 2 * lb) + y;
                g = (y - lb * b - lr * r) / lg;
                break;
            }
            case 8: {
                // Section 23: CIE L*a*b* (D65 white), L in 0–255 for 0–100, a and b signed.
                const l = (samples[s] * 100) / 255;
                const a = ((samples[s + 1] << 24) >> 24) as number;
                const bb = ((samples[s + 2] << 24) >> 24) as number;
                [r, g, b] = labToRgb(l, a, bb);
                break;
            }
            default:
                [r, g, b] = [samples[s], samples[s + 1], samples[s + 2]];
        }
        rgba[o] = clamp(r);
        rgba[o + 1] = clamp(g);
        rgba[o + 2] = clamp(b);
        let alpha = alphaAt >= 0 ? samples[s + alphaAt] : 255;
        if (photometric === 3 || (photometric <= 1 && bits < 8)) alpha = alphaAt >= 0 ? Math.round((alpha * 255) / max) : 255;
        // Associated alpha was multiplied in; take it back out.
        if (alphaKind === 1 && alphaAt >= 0 && alpha > 0 && alpha < 255) for (let k = 0; k < 3; k++) rgba[o + k] = clamp((rgba[o + k] * 255) / alpha);
        rgba[o + 3] = alpha;
    }
}

function labToRgb(l: number, a: number, b: number): [number, number, number] {
    const fy = (l + 16) / 116;
    const f = (t: number) => (t > 6 / 29 ? t ** 3 : 3 * (6 / 29) ** 2 * (t - 4 / 29));
    const [x, y, z] = [0.95047 * f(fy + a / 500), f(fy), 1.08883 * f(fy - b / 200)];
    const linear = [3.2406 * x - 1.5372 * y - 0.4986 * z, -0.9689 * x + 1.8758 * y + 0.0415 * z, 0.0557 * x - 0.204 * y + 1.057 * z];
    const gamma = (c: number) => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
    return [gamma(linear[0]), gamma(linear[1]), gamma(linear[2])];
}
