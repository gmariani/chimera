import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Preview } from '../../core/types';
import { gameDir } from '../../testing/game-data';
import { tdMap } from '../../testing/samples';
import { detect } from '../index';
import font from './font';
import lut from './lut';
import mapTd from './map-td';
import shpTd from './shp-td';
import strings from './strings';
import ini from '../ini';
import { readLogic, tdMission, unpackSection } from './map';
import { Ini } from '../ini-sections';
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
        expect(images(parsed.preview).frames.map((f) => [...f.pixels])).toEqual([
            [1, 2, 3, 4],
            [5, 6, 7, 8],
        ]);
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
        expect(preview.frames.map((f) => [...f.pixels])).toEqual([
            [5, 6, 7, 8],
            [0, 0, 0, 0],
            [1, 2, 3, 4],
        ]);
    });
});

describe('WSA', () => {
    /** A 2 × 1 animation of one frame (XORing [3, 4] in), with these flags. */
    const oneFrame = (flags: number) => {
        const delta = [0x02, 3, 4, 0x80, 0, 0];
        const frame = [0x80 | delta.length, ...delta, 0x80];
        const table = 14 + 3 * 4;
        return bytes(table + frame.length, (v, b) => {
            v.setUint16(0, 1, true);
            v.setUint16(6, 2, true);
            v.setUint16(8, 1, true);
            v.setUint16(10, 16, true);
            v.setUint16(12, flags, true);
            v.setUint32(14, table, true);
            v.setUint32(18, table + frame.length, true);
            b.set(frame, table);
        });
    };

    it('says when the first frame is a delta over a picture from elsewhere (flag 2)', () => {
        const parsed = wsa.parse(oneFrame(2), context());
        expect(parsed.warnings).toEqual([]);
        expect(parsed.summary).toContainEqual(['First frame', 'A delta over a picture from elsewhere, which the game has on screen (shown here over a blank screen)']);
    });

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
        expect(images(wsa.parse(data, context()).preview).frames.map((f) => [...f.pixels])).toEqual([
            [3, 4],
            [2, 5],
        ]);
    });
});

describe('TD/RA SHP', () => {
    it("says when X holds the game's cached-sprite marker", () => {
        // One 1 × 1 frame, LCW-compressed whole; X is 56789 and Y 7, as the Windows game writes them once it caches a sprite.
        const frame = [0x81, 5, 0x80];
        const table = 14 + 3 * 8;
        const data = bytes(table + frame.length, (v, b) => {
            v.setUint16(0, 1, true);
            v.setUint16(2, 56789, true);
            v.setUint16(4, 7, true);
            v.setUint16(6, 1, true);
            v.setUint16(8, 1, true);
            v.setUint16(10, frame.length, true);
            v.setUint32(14, table | (0x80 << 24), true);
            v.setUint32(22, table + frame.length, true);
            b.set(frame, table);
        });
        expect(shpTd.parse(data, context()).warnings).toEqual([
            "X is 56789, the number the Windows version of the game writes there once it has cached a sprite's frames. It would take this sprite as cached already, and use Y (7) as its slot in the cache without checking it: the game would read through whatever that slot holds.",
        ]);
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

describe('INI', () => {
    const text = (s: string) => new TextEncoder().encode(s);
    it('finds the first section past a long comment at the top, with a comment of its own after it', () => {
        // As TS's and RA2's art.ini: 8 to 15 kB of comments, then "[ROCK] ; Rocketeer".
        const comments = '; This file controls the art.\r\n;\r\n'.repeat(400);
        expect(comments.length).toBeGreaterThan(8192);
        expect(detect(text(`${comments}\r\n[ROCK] ; Rocketeer\r\nCameo=JJETICON\r\n`), 'art.ini').id).toBe('ini');
        expect(detect(text('[General]\nName=x\n'), 'a.ini').id).toBe('ini');
    });

    it('leaves text that only has brackets in it, or nothing but comments, as text', () => {
        expect(detect(text('; Only comments\r\n; and nothing else\r\n'), 'a.ini').id).toBe('text');
        expect(detect(text(`${'; note\n'.repeat(2000)}Read me [first] please.\n`), 'a.ini').id).toBe('text');
        expect(detect(text('[Section] then words\n'), 'a.ini').id).toBe('text');
    });

    const ts = gameDir('tiberianSun');
    it.skipIf(!ts || !existsSync(join(ts, 'patch.mix')))('takes TS’s art.ini as INI', async () => {
        const { default: mix } = await import('../mix/index');
        const art = mix.parse(new Uint8Array(readFileSync(join(ts!, 'patch.mix'))), context('patch.mix')).entries!.find((e) => e.name?.toLowerCase() === 'art.ini')!;
        expect(detect(art.data, art.name).id).toBe('ini');
        expect(ini.parse(art.data, context('art.ini')).summary[0][0]).toBe('Sections');
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
    it("draws a TD mission from its .bin and the theater's tiles", () => {
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

    it('says which cells name a tile their template lacks, and still reads the map', () => {
        // As in SCB07EC.BIN: "0,,Mar" written over cells (63, 49) to (1, 50), outside the playable area. "0" (0x30) is
        // template S36, which has 4 tiles; "," is tile 44. "," (0x2C) is S32, "M" tile 77; "a" is D05, "r" tile 114.
        const bin = new Uint8Array(8192).fill(0xff);
        for (let i = 1; i < 8192; i += 2) bin[i] = 0;
        bin.set(new TextEncoder().encode('0,,Mar'), 3199 * 2);
        expect(detect(bin, 'scb07ec.bin').id).toBe('map-td');
        const ini = new TextEncoder().encode('[MAP]\nTheater=DESERT\nX=4\nY=4\nWidth=55\nHeight=56\n');
        const parsed = mapTd.parse(bin, { name: 'scb07ec.bin', names: [], find: (n) => (n === 'scb07ec.ini' ? [{ data: ini, source: 'GENERAL.MIX' }] : []) });
        expect(parsed.warnings).toEqual([
            '3 cells name a tile its template doesn\'t have: (63, 49) S36, tile 44: not one of its 4 tiles; (0, 50) S32, tile 77: not one of its 4 tiles; (1, 50) D05, tile 114: not one of its 12 tiles. All are outside the playable area, so the game never shows them. Their bytes read as the text "0,,Mar". They\'re drawn as clear ground.',
        ]);
        expect(parsed.fields[50].children![0].value).toBe('S32, tile 77: not one of its 4 tiles');
    });

    it("doesn't take text of a map's size for a map", () => {
        // Text's bytes are all below 216, so each could be a template; but text has no clear cells (0xFF), and its
        // bytes name tiles 32 and up, more than any template has.
        const text = new TextEncoder().encode('[Basic]\nName=Not a map\n'.repeat(400)).subarray(0, 8192);
        expect(text.length).toBe(8192);
        expect(detect(text, 'notes.bin').id).not.toBe('map-td');
    });

    it('takes a map cleared with template 0, as the Remastered editor saves them, when every tile fits', () => {
        // The sample, with its 0xFF cells made template 0 (their tile bytes are 0 already).
        const bin = tdMap().map((v) => (v === 0xff ? 0 : v));
        expect(detect(bin, 'scmc1ea.bin').id).toBe('map-td');
        expect(mapTd.parse(bin, { name: 'scmc1ea.bin', names: [] }).warnings).toEqual([]);
        // One tile its template doesn't have, and with no 0xFF to go on, it isn't taken.
        const off = bin.slice();
        off[(30 * 64 + 12) * 2 + 1] = 8; // D10 has 8 tiles: 0 to 7.
        expect(detect(off, 'scmc1ea.bin').id).not.toBe('map-td');
        // Nor is a file of zeros: all clear, nothing that says it's a map.
        expect(detect(new Uint8Array(8192), 'scmc1ea.bin').id).not.toBe('map-td');
    });

    const community = join(gameDir('cncRemastered') ?? '', 'TIBERIAN_DAWN/COMMUNITY');
    it.skipIf(!existsSync(community))('reads the Remastered Collection’s community maps, some of which have no 0xFF cells', () => {
        for (const n of [0, 1, 2, 3, 4, 5, 6]) {
            const name = `SCMC${n}EA.BIN`;
            const bin = new Uint8Array(readFileSync(join(community, name)));
            expect(detect(bin, name).id, name).toBe('map-td');
            const ini = new Uint8Array(readFileSync(join(community, `SCMC${n}EA.INI`)));
            const parsed = mapTd.parse(bin, { name, names: [], find: (f) => (f.toUpperCase() === `SCMC${n}EA.INI` ? [{ data: ini, source: 'COMMUNITY' }] : []) });
            expect(parsed.warnings, name).toEqual([]);
        }
    });

    it("says which archive would draw it when the tiles aren't open", () => {
        const parsed = mapTd.parse(new Uint8Array(8192).fill(0xff), { name: 'scg01ea.bin', names: [], find: () => [] });
        expect(parsed.wanted).toMatch(/SCG01EA\.INI/);
    });
});

describe('mission logic on TD and RA maps', () => {
    it('reads cell triggers, waypoints, triggers on objects and the base as TD does', () => {
        const text = [
            '[Triggers]',
            'atk1=Player Enters,Attack,0,BadGuy,None,0',
            'hunt=Attacked,Hunt,0,BadGuy,None,0',
            '[CellTriggers]',
            '100=atk1',
            '100=hunt', // The first line for a cell wins.
            '101=nope', // No such trigger.
            '0=atk1', // TD skips cell 0, as it skips the house lines some missions have here:
            'Edge=None',
            '[Waypoints]',
            '0=200',
            '26=300',
            '27=-1',
            '28=400', // TD reads 0 to 27.
            '[STRUCTURES]',
            '0=BadGuy,NUKE,256,500,0,hunt',
            '1=BadGuy,PROC,256,600,0,None',
            '[INFANTRY]',
            '0=BadGuy,E1,256,700,0,Guard,64,atk1',
            '[Base]',
            'Count=2',
            '000=NUKE,335548416', // A COORDINATE: x 16, y 20.
            '001=PROC,999', // x 3, y 0.
        ].join('\n');
        const ini = new Ini(text);
        const logic = tdMission(new Uint8Array(8192).fill(0xff), ini).logic!;
        expect([...logic.cells]).toEqual([[100, 'ATK1']]);
        expect(logic.waypoints).toEqual([
            [0, 200],
            [26, 300],
        ]);
        expect(logic.tagged).toEqual([
            [500, 'HUNT'],
            [700, 'ATK1'],
        ]);
        expect(logic.base).toEqual([
            [0, 20 * 64 + 16],
            [1, 3],
        ]);
    });

    it("reads RA's: triggers in [Trigs], cell 0 allowed, the base by cell, waypoints to 100", () => {
        const ini = new Ini(['[Trigs]', 'rnf1=0,2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0', '[CellTriggers]', '0=rnf1', '[Waypoints]', '98=1000', '100=2000', '[Base]', 'Count=1', '000=POWR,5000'].join('\n'));
        const logic = readLogic(ini, 'ra', 128, []);
        expect([...logic.cells]).toEqual([[0, 'RNF1']]);
        expect(logic.waypoints).toEqual([
            [98, 1000],
            [100, 2000],
        ]);
        expect(logic.base).toEqual([[0, 5000]]);
    });
});

describe('objects on TD and RA maps', () => {
    it('reads units, infantry, buildings and smudges, and marks them on the terrain view', () => {
        const bin = new Uint8Array(8192).fill(0xff);
        const text =
            '[MAP]\nTheater=DESERT\nX=0\nY=0\nWidth=4\nHeight=2\n[UNITS]\n0=BadGuy,MTNK,256,65,64,Guard,None\n[INFANTRY]\n0=GoodGuy,E1,256,66,2,Guard,0,None\n[STRUCTURES]\n0=GoodGuy,FACT,256,1,0,None\n[SMUDGE]\n2=CR1,2,0\n';
        const files: Record<string, Uint8Array> = { 'scg01ea.bin': bin };
        const parsed = ini.parse(new TextEncoder().encode(text), { name: 'scg01ea.ini', names: [], find: (n) => (files[n] ? [{ data: files[n], source: 'X.MIX' }] : []) });
        expect(parsed.summary).toContainEqual(['Building', '1 cells']);
        expect(parsed.summary).toContainEqual(['Unit or infantry', '2 cells']);
    });

    it('draws a war factory with its roof and door over it', () => {
        /** A 24 × 24 SHP. Each frame is one color: all of it, or only its top half when `half`. */
        const shp = (colors: number[], half = false) => {
            const frames = colors.map((c) => (half ? [0xfe, 0x20, 0x01, c, 0xfe, 0x20, 0x01, 0, 0x80] : [0xfe, 0x40, 0x02, c, 0x80]));
            const table = 14 + (frames.length + 2) * 8;
            return bytes(table + frames.reduce((n, f) => n + f.length, 0), (v, b) => {
                v.setUint16(0, frames.length, true);
                v.setUint16(6, 24, true);
                v.setUint16(8, 24, true);
                let at = table;
                frames.forEach((f, i) => {
                    v.setUint32(14 + i * 8, (at | (0x80 << 24)) >>> 0, true);
                    b.set(f, at);
                    at += f.length;
                });
                v.setUint32(14 + frames.length * 8, at, true);
            });
        };
        const files: Record<string, Uint8Array> = {
            'scm01ea.bin': new Uint8Array(8192).fill(0xff),
            'clear1.des': tileSet(7),
            'desert.pal': new Uint8Array(768),
            'weap.shp': shp([20, 21]),
            'weap2.shp': shp([30, 31, 32, 33], true),
        };
        const find = (n: string) => (files[n] ? [{ data: files[n], source: 'X.MIX' }] : []);
        /** The colors at the top and the bottom of the building's cell. */
        const drawn = (type: string, health: number) => {
            const text = `[MAP]\nTheater=DESERT\nX=0\nY=0\nWidth=4\nHeight=4\n[STRUCTURES]\n0=Neutral,${type},${health},0,0,None\n`;
            const preview = ini.parse(new TextEncoder().encode(text), { name: 'scm01ea.ini', names: [], find }).preview;
            if (preview?.kind !== 'stack') throw new Error('expected a stack');
            const { width, pixels } = images(preview.items[0].preview).frames[0];
            return [pixels[0], pixels[23 * width]];
        };
        expect(drawn('WEAP', 256)).toEqual([30, 20]);
        expect(drawn('WEAP', 100)).toEqual([32, 21]);
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
