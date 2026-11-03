import { describe, expect, it } from 'vitest';
import type { Preview } from '../../core/types';
import { detect } from '../index';
import font from './font';
import ini from '../ini';
import { unpackSection } from './map';
import pcx from '../pcx';
import tiles from './tiles';
import vqa from './vqa';
import wsa from './wsa';

/** Small hand-built files for each format, so the layouts are pinned down without game data. */

const context = (name: string | null = null) => ({ name, names: [] });

function bytes(size: number, write: (v: DataView, b: Uint8Array) => void): Uint8Array {
    const b = new Uint8Array(size);
    write(new DataView(b.buffer), b);
    return b;
}

function images(preview: Preview | undefined) {
    if (preview?.kind !== 'images') throw new Error(`expected images, got ${preview?.kind}`);
    return preview;
}

describe('tile sets', () => {
    // Two 2×2 tiles; a 3-cell map: tile 1, empty, tile 0.
    const tiles2x2 = Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8);
    const map = Uint8Array.of(1, 0xff, 0);

    it('reads a TD tile set and lays out a known template', () => {
        const size = 32 + 8 + 3 + 2;
        const data = bytes(size, (v, b) => {
            v.setUint16(0, 2, true);
            v.setUint16(2, 2, true);
            v.setUint16(4, 3, true);
            v.setUint32(8, size, true);
            v.setUint32(12, 32, true);
            v.setUint32(24, 32 + 8 + 3, true);
            v.setUint32(28, 32 + 8, true);
            b.set(tiles2x2, 32);
            b.set(map, 40);
        });
        expect(detect(data, null).id).toBe('tiles');
        // TD's SH4 is 2 × 1 cells; with 3 cells this doesn't fit, so the tiles are shown as they are.
        const parsed = tiles.parse(data, context('sh4.tem'));
        expect(images(parsed.preview).frames.map((f) => [...f.pixels])).toEqual([[1, 2, 3, 4], [5, 6, 7, 8]]);
        expect(parsed.warnings).toEqual([]);
    });

    it('reads an RA tile set and assembles it from its own size', () => {
        const size = 40 + 8 + 3 + 2 + 2;
        const data = bytes(size, (v, b) => {
            v.setUint16(0, 2, true);
            v.setUint16(2, 2, true);
            v.setUint16(4, 3, true);
            v.setUint16(8, 3, true);
            v.setUint16(10, 1, true);
            v.setUint32(12, size, true);
            v.setUint32(16, 40, true);
            v.setUint32(28, 40 + 8 + 3, true);
            v.setUint32(32, 40 + 8 + 3 + 2, true);
            v.setUint32(36, 40 + 8, true);
            b.set(tiles2x2, 40);
            b.set(map, 48);
        });
        const preview = images(tiles.parse(data, context()).preview);
        expect(preview.columns).toBe(3);
        expect(preview.frames.map((f) => [...f.pixels])).toEqual([[5, 6, 7, 8], [0, 0, 0, 0], [1, 2, 3, 4]]);
    });
});

describe('WSA', () => {
    it('applies each frame as a delta on the one before', () => {
        // 2×1 pixels, 2 frames. Frame 1 XORs [3, 4] in; frame 2 XORs [1, 1]. Each is LCW around a format 40 delta.
        const delta1 = [0x02, 3, 4, 0x80, 0, 0];
        const delta2 = [0x02, 1, 1, 0x80, 0, 0];
        const frame1 = [0x80 | delta1.length, ...delta1, 0x80];
        const frame2 = [0x80 | delta2.length, ...delta2, 0x80];
        const table = 14 + 4 * 4;
        const data = bytes(table + frame1.length + frame2.length, (v, b) => {
            v.setUint16(0, 2, true);
            v.setUint16(6, 2, true);
            v.setUint16(8, 1, true);
            v.setUint16(10, 16, true);
            v.setUint32(14, table, true);
            v.setUint32(18, table + frame1.length, true);
            v.setUint32(22, table + frame1.length + frame2.length, true);
            b.set(frame1, table);
            b.set(frame2, table + frame1.length);
        });
        expect(detect(data, null).id).toBe('wsa');
        expect(images(wsa.parse(data, context()).preview).frames.map((f) => [...f.pixels])).toEqual([[3, 4], [2, 5]]);
    });
});

describe('fonts', () => {
    it('reads 4-bit glyphs, low nibble first', () => {
        // One character, 3 wide and 2 high, one row down in a 3-high font.
        const data = bytes(40, (v, b) => {
            v.setUint16(0, 40, true);
            b[3] = 5;
            v.setUint16(4, 14, true);
            v.setUint16(6, 20, true);
            v.setUint16(8, 22, true);
            v.setUint16(10, 24, true);
            v.setUint16(12, 28, true);
            b[18] = 3; // largest height
            b[19] = 3; // largest width
            v.setUint16(20, 24, true);
            b[22] = 3;
            b.set([0x21, 0x03, 0x54, 0x06], 24);
            b.set([1, 2], 28);
        });
        expect(detect(data, null).id).toBe('fnt');
        const glyph = images(font.parse(data, context()).preview).frames[0];
        expect([...glyph.pixels]).toEqual([0, 0, 0, 1, 2, 3, 4, 5, 6]);
    });
});

describe('PCX', () => {
    it('expands runs and reads the palette at the end', () => {
        const rle = [0xc3, 9, 7];
        const data = bytes(128 + rle.length + 769, (v, b) => {
            b.set([0x0a, 5, 1, 8]);
            v.setUint16(8, 3, true);
            b[65] = 1;
            v.setUint16(66, 4, true);
            b.set(rle, 128);
            b[128 + rle.length] = 0x0c;
            b[128 + rle.length + 1 + 9 * 3] = 255;
        });
        const preview = images(pcx.parse(data, context()).preview);
        expect([...preview.frames[0].pixels]).toEqual([9, 9, 9, 7]);
        expect(preview.palette![9 * 3]).toBe(255);
    });
});

describe('RA map packs', () => {
    it('joins LCW blocks of a 4-byte header each', () => {
        // Two blocks: "aaaa" as a fill, then "bc" as literals.
        const packed = Uint8Array.of(5, 0, 4, 0, 0xfe, 4, 0, 97, 0x80, 4, 0, 2, 0, 0x82, 98, 99, 0x80);
        const out = unpackSection(btoa(String.fromCharCode(...packed)), 6);
        expect(new TextDecoder().decode(out)).toBe('aaaabc');
    });

    it('shows the map in an RA mission', () => {
        // All 128 × 128 cells clear (255), as one fill per 8 KB block, and the template bytes come first.
        const block = [5, 0, 0x00, 0x20, 0xfe, 0x00, 0x20, 0xff, 0x80];
        const packed = Uint8Array.from({ length: 6 * block.length }, (_, i) => block[i % block.length]);
        const base64 = btoa(String.fromCharCode(...packed));
        const text = `[Map]\nTheater=TEMPERATE\nX=1\nY=2\nWidth=10\nHeight=5\n\n[MapPack]\n1=${base64.slice(0, 20)}\n2=${base64.slice(20)}\n`;
        const parsed = ini.parse(new TextEncoder().encode(text), context('scg01ea.ini'));
        expect(parsed.summary).toContainEqual(['Clear', '50 cells']);
        const preview = parsed.preview;
        expect(preview?.kind).toBe('stack');
        if (preview?.kind === 'stack') expect(images(preview.items[0].preview).frames[0].width).toBe(10 * 4);
    });
});

describe('VQA', () => {
    function chunk(id: string, body: number[]): number[] {
        const size = body.length;
        return [...id].map((c) => c.charCodeAt(0)).concat([size >>> 24, (size >> 16) & 255, (size >> 8) & 255, size & 255], body, size & 1 ? [0] : []);
    }

    it('draws blocks from the codebook and solid colours', () => {
        // 8 × 2 pixels: two 4 × 2 blocks. Codebook entry 0 counts 1..8; the second block is solid colour 9.
        const header = new Array(42).fill(0);
        Object.assign(header, { 0: 2, 4: 1, 6: 8, 8: 2, 10: 4, 11: 2, 12: 15, 13: 8 });
        const frame = [...chunk('CBF0', [1, 2, 3, 4, 5, 6, 7, 8]), ...chunk('CPL0', new Array(768).fill(63)), ...chunk('VPT0', [0, 9, 0, 0x0f])];
        const body = [...'WVQA'].map((c) => c.charCodeAt(0)).concat(chunk('VQHD', header), chunk('VQFR', frame));
        const data = Uint8Array.from([...'FORM'].map((c) => c.charCodeAt(0)).concat([0, 0, 0, body.length], body));
        expect(detect(data, null).id).toBe('vqa');
        const preview = vqa.parse(data, context()).preview;
        if (preview?.kind !== 'video') throw new Error('expected video');
        const { pixels, palette } = preview.frame(0);
        expect([...pixels]).toEqual([1, 2, 3, 4, 9, 9, 9, 9, 5, 6, 7, 8, 9, 9, 9, 9]);
        expect(palette[0]).toBe(255);
    });
});
