import { describe, expect, it } from 'vitest';
import type { Preview } from '../../core/types';
import { detect } from '../index';
import font from './font';
import lut from './lut';
import mapTd from './map-td';
import strings from './strings';
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

    it('draws blocks from the codebook and solid colors', () => {
        // 8 × 2 pixels: two 4 × 2 blocks. Codebook entry 0 counts 1..8; the second block is solid color 9.
        const header = new Array(42).fill(0);
        Object.assign(header, { 0: 2, 4: 1, 6: 8, 8: 2, 10: 4, 11: 2, 12: 15, 13: 8 });
        const frame = [...chunk('CBF0', [1, 2, 3, 4, 5, 6, 7, 8]), ...chunk('CPL0', new Array(768).fill(63)), ...chunk('VPT0', [0, 9, 0, 0x0f])];
        const body = [...'WVQA'].map((c) => c.charCodeAt(0)).concat(chunk('VQHD', header), chunk('VQFR', frame));
        const data = Uint8Array.from([...'FORM'].map((c) => c.charCodeAt(0)).concat([0, 0, 0, body.length], body));
        expect(detect(data, null).id).toBe('vqa');
        const preview = vqa.parse(data, context()).preview;
        if (preview?.kind !== 'video') throw new Error('expected video');
        const decoded = preview.frame(0);
        if (!('pixels' in decoded)) throw new Error('expected an indexed frame');
        const { pixels, palette } = decoded;
        expect([...pixels]).toEqual([1, 2, 3, 4, 9, 9, 9, 9, 5, 6, 7, 8, 9, 9, 9, 9]);
        expect(palette[0]).toBe(255);
    });
});

describe('string tables', () => {
    it('reads each string from its offset', () => {
        // Three offsets: "Hi" at 6, "" at 9, "Bye" at 10.
        const table = Uint8Array.from([6, 0, 9, 0, 10, 0, 72, 105, 0, 0, 66, 121, 101, 0]);
        expect(detect(table, null).id).toBe('strings');
        const preview = strings.parse(table, context('conquer.eng')).preview;
        expect(preview).toEqual({ kind: 'text', text: '0  Hi\n1  \n2  Bye' });
    });

    it('turns down binary data whose first word happens to be even', () => {
        expect(detect(Uint8Array.from([4, 0, 1, 2, 3, 4, 5, 6]), null).id).not.toBe('strings');
    });
});

describe('vortex frames', () => {
    it('maps each pixel to where it comes from', () => {
        const data = new Uint8Array(64 * 64 * 3);
        for (let i = 0; i < 64 * 64; i++) data.set([i % 64, Math.floor(i / 64), 15], i * 3);
        expect(detect(data, null).id).toBe('lut');
        const preview = images(lut.parse(data, context('hole0020.lut')).preview);
        // Unwarped: the test grid's 8 × 8 blocks come out as they went in.
        expect(preview.frames[0].pixels[9 * 64 + 17]).toBe(1 * 8 + 2);
    });
});

// A TD CLEAR1 with a single 24 × 24 tile of one color (the real one has 16 variants).
function tileSet(color: number): Uint8Array {
    const size = 32 + 576 + 1 + 1;
    return bytes(size, (v, b) => {
        v.setUint16(0, 24, true);
        v.setUint16(2, 24, true);
        v.setUint16(4, 1, true);
        v.setUint32(8, size, true);
        v.setUint32(12, 32, true);
        v.setUint32(24, 32 + 576 + 1, true);
        v.setUint32(28, 32 + 576, true);
        b.fill(color, 32, 32 + 576);
    });
}

describe('maps with real tiles', () => {

    it('draws a TD mission from its .bin and the theater\'s tiles', () => {
        const bin = new Uint8Array(8192).fill(0xff);
        const text = '[MAP]\nTheater=DESERT\nX=1\nY=1\nWidth=2\nHeight=1\n';
        const files: Record<string, Uint8Array> = { 'scg01ea.bin': bin, 'clear1.des': tileSet(7), 'desert.pal': new Uint8Array(768).fill(63) };
        const find = (name: string) => (files[name] ? [{ data: files[name], source: 'X.MIX' }] : []);
        const parsed = ini.parse(new TextEncoder().encode(text), { name: 'scg01ea.ini', names: [], find });
        expect(parsed.title).toBe('Mission (TD INI)');
        expect(parsed.wanted).toBeUndefined();
        const preview = parsed.preview;
        if (preview?.kind !== 'stack') throw new Error('expected a stack');
        expect(preview.items.map((i) => i.title)).toEqual(['Map', 'Terrain kinds', 'Text']);
        const map = images(preview.items[0].preview);
        expect([map.frames[0].width, map.frames[0].height]).toEqual([48, 24]);
        expect(map.frames[0].pixels.every((p) => p === 7)).toBe(true);
        expect(images(preview.items[1].preview).legend).toEqual([{ label: 'Clear', index: 0 }]);
    });

    it('says which archive would draw it when the tiles aren\'t open', () => {
        const parsed = mapTd.parse(new Uint8Array(8192).fill(0xff), { name: 'scg01ea.bin', names: [], find: () => [] });
        expect(parsed.wanted).toMatch(/SCG01EA\.INI/);
    });
});

describe('objects on TD and RA maps', () => {
    it('reads units, infantry, buildings and smudges, and marks them on the terrain view', () => {
        const bin = new Uint8Array(8192).fill(0xff);
        const text = '[MAP]\nTheater=DESERT\nX=0\nY=0\nWidth=4\nHeight=2\n[UNITS]\n0=BadGuy,MTNK,256,65,64,Guard,None\n[INFANTRY]\n0=GoodGuy,E1,256,66,2,Guard,0,None\n[STRUCTURES]\n0=GoodGuy,FACT,256,1,0,None\n[SMUDGE]\n2=CR1,2,0\n';
        const files: Record<string, Uint8Array> = { 'scg01ea.bin': bin };
        const parsed = ini.parse(new TextEncoder().encode(text), { name: 'scg01ea.ini', names: [], find: (n) => (files[n] ? [{ data: files[n], source: 'X.MIX' }] : []) });
        expect(parsed.summary).toContainEqual(['Building', '1 cells']);
        expect(parsed.summary).toContainEqual(['Unit or infantry', '2 cells']);
    });

    it('numbers where players start on a multiplayer map, and not on a mission', () => {
        const bin = new Uint8Array(8192).fill(0xff);
        // Index 1 white, 2 near black: the badge's border and its dark square.
        const pal = new Uint8Array(768);
        pal.set([63, 63, 63, 2, 2, 2], 3);
        const files: Record<string, Uint8Array> = { 'scm01ea.bin': bin, 'clear1.des': tileSet(7), 'desert.pal': pal };
        const find = (n: string) => (files[n] ? [{ data: files[n], source: 'X.MIX' }] : []);
        const drawn = (extra: string) => {
            const text = `[MAP]\nTheater=DESERT\nX=0\nY=0\nWidth=4\nHeight=4\n[Waypoints]\n0=65\n${extra}`;
            const preview = ini.parse(new TextEncoder().encode(text), { name: 'scm01ea.ini', names: [], find }).preview;
            if (preview?.kind !== 'stack') throw new Error('expected a stack');
            return images(preview.items[0].preview).frames[0].pixels;
        };
        expect(drawn('').includes(1) && drawn('').includes(2)).toBe(true);
        expect(drawn('[UNITS]\n0=BadGuy,MTNK,256,130,64,Guard,None\n').includes(2)).toBe(false);
    });
});
