import { describe, expect, it } from 'vitest';
import type { Preview } from '../../core/types';
import { detect } from '../index';
import { Ini } from '../ini-sections';
import { namesFromBinary, namesFromText } from '../mix/names';
import { imaSample } from './adpcm';
import { lzo1x } from './compression';
import { Links } from '../links';
import { rulesTable } from '../rules-table';
import { teamPalette, teamRemap } from './team-colors';
import { isoMapPreviews, readIsoMap } from './map-iso';
import pcx from '../pcx';
import wavParser from '../wav';
import csf from './csf';
import fontTs from './font-ts';
import gaba from './gaba';
import hva from './hva';
import tmp, { unpackDiamond } from './tmp';
import vqa from './vqa';
import vxl from './vxl';

/** Hand-built TS and RA2 files, so the layouts are pinned down without game data. */

const context = (name: string | null = null) => ({ name, names: [] });

function bytes(size: number, write: (v: DataView, b: Uint8Array) => void): Uint8Array {
    const b = new Uint8Array(size);
    write(new DataView(b.buffer), b);
    return b;
}

const ascii = (b: Uint8Array, at: number, text: string) => [...text].forEach((c, i) => (b[at + i] = c.charCodeAt(0)));

function stack(preview: Preview | undefined) {
    if (preview?.kind !== 'stack') throw new Error(`expected a stack, got ${preview?.kind}`);
    return preview.items.map((i) => i.preview);
}

describe('isometric tiles', () => {
    it('unpacks a diamond: 4 wide at the top, widening to the middle', () => {
        const width = 48;
        const height = 24;
        const src = Uint8Array.from({ length: (width * height) / 2 }, () => 7);
        const out = unpackDiamond(src, width, height);
        expect([...out.subarray(0, width)].filter((p) => p).length).toBe(4);
        expect([...out.subarray(11 * width, 12 * width)].filter((p) => p).length).toBe(48);
        expect([...out.subarray(23 * width)].filter((p) => p).length).toBe(0);
    });

    it('places a raised cell and its extra image', () => {
        // One TS cell at 0, 0, one level up, with a 2 × 1 extra image at 10, -5.
        const size = 576;
        const at = 20;
        const data = bytes(at + 52 + size + 2, (v, b) => {
            v.setUint32(0, 1, true);
            v.setUint32(4, 1, true);
            v.setUint32(8, 48, true);
            v.setUint32(12, 24, true);
            v.setUint32(16, at, true);
            v.setUint32(at + 8, 52 + size, true);
            v.setInt32(at + 20, 10, true);
            v.setInt32(at + 24, -5, true);
            v.setUint32(at + 28, 2, true);
            v.setUint32(at + 32, 1, true);
            b[at + 36] = 1;
            b[at + 40] = 1;
            b.fill(9, at + 52, at + 52 + size);
            b.set([5, 6], at + 52 + size);
        });
        expect(detect(data, null).id).toBe('tmp');
        const [assembled] = stack(tmp.parse(data, context('cliff01.tem')).preview);
        if (assembled.kind !== 'images') throw new Error('expected images');
        // Raised 12 pixels, the extra 5 above that: the picture spans from y = -17 to 12.
        const frame = assembled.frames[0];
        expect([frame.width, frame.height]).toEqual([48, 29]);
        expect([frame.pixels[10], frame.pixels[11]]).toEqual([5, 6]);
    });
});

describe('voxels', () => {
    it('reads spans into columns', () => {
        // One 1 × 1 × 3 limb: a skip of 1, one voxel of color 4 (normal 0) at z = 1, then a skip to the top.
        const body = [0, 0, 0, 0, /* end */ 7, 0, 0, 0, /* data */ 1, 1, 4, 0, 1, 1, 0, 0];
        const tailers = 802 + 28 + body.length;
        const data = bytes(tailers + 92, (v, b) => {
            ascii(b, 0, 'Voxel Animation\0');
            v.setUint32(20, 1, true);
            v.setUint32(24, 1, true);
            v.setUint32(28, body.length, true);
            ascii(b, 802, 'BODY');
            b.set(body, 830);
            v.setUint32(tailers, 0, true);
            v.setUint32(tailers + 4, 4, true);
            v.setUint32(tailers + 8, 8, true);
            b.set([1, 1, 3], tailers + 88);
        });
        expect(detect(data, null).id).toBe('vxl');
        const parsed = vxl.parse(data, context());
        expect(parsed.summary[0][1]).toBe('BODY (1 × 1 × 3, 1 voxels)');
        const [model, views] = stack(parsed.preview);
        if (model.kind !== 'voxels' || views.kind !== 'images') throw new Error('expected 3D and images');
        expect(model.parts[0].size).toEqual([1, 1, 3]);
        // Seen from the front: the top row is empty, the middle one is the voxel.
        expect([...views.frames[2].pixels]).toEqual([0, 4, 0]);
    });

    it('reads an animation\'s matrices', () => {
        const data = bytes(24 + 16 + 48, (v, b) => {
            v.setUint32(16, 1, true);
            v.setUint32(20, 1, true);
            ascii(b, 24, 'TURRET');
            v.setFloat32(40 + 12, 2.5, true);
        });
        expect(detect(data, null).id).toBe('hva');
        const frame = hva.parse(data, context()).fields.find((f) => f.name === 'Frame 0')!;
        expect(frame.children![0].value).toBe('[0, 0, 0, 2.5] [0, 0, 0, 0] [0, 0, 0, 0]');
    });
});

describe('WAV', () => {
    it('decodes IMA ADPCM blocks', () => {
        // A mono block of 8 bytes: the header's first sample (1000), then 8 nibbles of 0, which add 0 at step index 0.
        const block = [0xe8, 0x03, 0, 0, 0, 0, 0, 0];
        const data = bytes(44 + block.length, (v, b) => {
            ascii(b, 0, 'RIFF');
            v.setUint32(4, 36 + block.length, true);
            ascii(b, 8, 'WAVEfmt ');
            v.setUint32(16, 16, true);
            v.setUint16(20, 0x11, true);
            v.setUint16(22, 1, true);
            v.setUint32(24, 22050, true);
            v.setUint16(32, block.length, true);
            v.setUint16(34, 4, true);
            ascii(b, 36, 'data');
            v.setUint32(40, block.length, true);
            b.set(block, 44);
        });
        expect(detect(data, null).id).toBe('wav');
        const preview = wavParser.parse(data, context()).preview;
        if (preview?.kind !== 'audio') throw new Error('expected audio');
        const samples = new Int16Array(preview.wav.buffer, 44);
        expect(samples.length).toBe(9);
        expect(samples[0]).toBe(1000);
        expect(samples[8]).toBe(1000);
    });
});

describe('CSF', () => {
    it('flips each character\'s bits back', () => {
        const name = 'GUI:OK';
        const text = [...'Ok'].map((c) => ~c.charCodeAt(0) & 0xffff);
        const data = bytes(24 + 12 + name.length + 8 + text.length * 2, (v, b) => {
            ascii(b, 0, ' FSC');
            v.setUint32(4, 3, true);
            v.setUint32(8, 1, true);
            v.setUint32(12, 1, true);
            ascii(b, 24, ' LBL');
            v.setUint32(28, 1, true);
            v.setUint32(32, name.length, true);
            ascii(b, 36, name);
            ascii(b, 36 + name.length, ' RTS');
            v.setUint32(40 + name.length, text.length, true);
            text.forEach((c, i) => v.setUint16(44 + name.length + i * 2, c, true));
        });
        expect(detect(data, null).id).toBe('csf');
        expect(csf.parse(data, context()).preview).toEqual({ kind: 'text', text: 'GUI:OK\tOk' });
    });
});

describe('RA2 sound bank', () => {
    it('cuts each sound out of the .bag and wraps it as a WAV', () => {
        const idx = bytes(12 + 36, (v, b) => {
            ascii(b, 0, 'GABA');
            v.setUint32(4, 2, true);
            v.setUint32(8, 1, true);
            ascii(b, 12, 'beep');
            v.setUint32(28, 2, true);
            v.setUint32(32, 4, true);
            v.setUint32(36, 22050, true);
            v.setUint32(40, 4, true);
        });
        const bag = Uint8Array.of(9, 9, 1, 0, 2, 0, 9);
        expect(detect(idx, null).id).toBe('gaba');
        const parsed = gaba.parse(idx, { name: 'audio.idx', names: [], find: (n) => (n === 'audio.bag' ? [{ data: bag, source: 'x' }] : []) });
        expect(parsed.entries!.map((e) => e.name)).toEqual(['beep.wav']);
        const preview = wavParser.parse(parsed.entries![0].data, context()).preview;
        if (preview?.kind !== 'audio') throw new Error('expected audio');
        expect([...new Int16Array(preview.wav.buffer, 44)]).toEqual([1, 2]);
        expect(gaba.parse(idx, { name: 'audio.idx', names: [], find: () => [] }).wanted).toMatch(/AUDIO\.BAG/);
    });
});

describe('1-bit fonts', () => {
    it('reads a FoNt glyph, leftmost pixel in the high bit', () => {
        // Characters 65 and 66, each a width byte and 2 rows of 1 byte.
        const data = bytes(48 + 2 * 3, (v, b) => {
            ascii(b, 0, 'FoNt');
            v.setUint32(8, 1, true);
            v.setUint32(12, 2, true);
            v.setUint32(24, 3, true);
            v.setUint32(40, 65, true);
            v.setUint32(44, 66, true);
            b.set([3, 0b1010_0000, 0b0100_0000], 48);
        });
        expect(detect(data, 'map.fnt').id).toBe('fnt-ts');
        const preview = fontTs.parse(data, context('map.fnt')).preview;
        if (preview?.kind !== 'images') throw new Error('expected images');
        expect([...preview.frames[0].pixels]).toEqual([1, 0, 1, 0, 1, 0]);
    });
});

describe('high-color VQA', () => {
    it('draws codebook blocks and keeps skipped ones', () => {
        const chunk = (id: string, body: number[]) => [...id].map((c) => c.charCodeAt(0)).concat([0, 0, body.length >> 8, body.length & 255], body, body.length & 1 ? [0] : []);
        // 8 × 2 pixels: two 4 × 2 blocks. Codebook entry 1 is all 0x7C00 (pure red in 15 bits).
        const header = new Array(42).fill(0);
        Object.assign(header, { 0: 3, 2: 0x10, 4: 2, 6: 8, 8: 2, 10: 4, 11: 2, 12: 15 });
        const codebook = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...new Array(8).fill([0x00, 0x7c]).flat()];
        // Frame 1: block 1 once (command 3), then block 1 once. Frame 2: skip 1, block 0 once.
        const frame1 = [...chunk('CBF0', codebook), ...chunk('VPTR', [0x01, 0x60, 0x01, 0x60])];
        const frame2 = chunk('VPTR', [0x01, 0x00, 0x00, 0x60]);
        const body = [...'WVQA'].map((c) => c.charCodeAt(0)).concat(chunk('VQHD', header), chunk('VQFR', frame1), chunk('VQFR', frame2));
        const data = Uint8Array.from([...'FORM'].map((c) => c.charCodeAt(0)).concat([0, 0, body.length >> 8, body.length & 255], body));
        const preview = vqa.parse(data, context()).preview;
        if (preview?.kind !== 'video') throw new Error('expected video');
        const red = (f: ReturnType<typeof preview.frame>, x: number) => ('rgba' in f ? f.rgba[x * 4] : -1);
        expect([red(preview.frame(0), 0), red(preview.frame(0), 4)]).toEqual([255, 255]);
        // The first block was skipped, so it's still red; the second is now black.
        expect([red(preview.frame(1), 0), red(preview.frame(1), 4)]).toEqual([255, 0]);
    });
});

describe('24-bit PCX', () => {
    it('reads each row as red, green and blue planes', () => {
        const rle = [10, 20, 30, 40, 50, 60];
        const data = bytes(128 + rle.length, (v, b) => {
            b.set([0x0a, 5, 1, 8]);
            v.setUint16(8, 1, true);
            b[65] = 3;
            v.setUint16(66, 2, true);
            b.set(rle, 128);
        });
        const preview = pcx.parse(data, context()).preview;
        if (preview?.kind !== 'picture') throw new Error('expected a picture');
        expect([...preview.rgba]).toEqual([10, 30, 50, 255, 20, 40, 60, 255]);
    });
});

describe('names from INIs', () => {
    it('tries each value with asset extensions, theater images, and numbered tile sets', () => {
        const names = namesFromText(['[GAPOWR]\nImage=GAPOWR\n', '[TileSet0001]\nFileName=cliff\nTilesInSet=2\n', '[IsoMapPack5]\n1=bm9pc2U=\n']);
        expect(names).toEqual(expect.arrayContaining(['gapowr.shp', 'gtpowr.shp', 'gapowr.vxl', 'cliff01.tem', 'cliff02.urb']));
        // Maps are skipped: their packed sections are base64.
        expect(names).not.toContain('bm9pc2u.shp');
    });
});

describe('LZO', () => {
    it('copies literals, then a match from earlier output', () => {
        // 4 literals; a 4-byte match from 4 back (M2: length (t >> 5) + 1, distance 1 + ((t >> 2) & 7) + (next << 3)); the end marker.
        const src = Uint8Array.of(17 + 4, 97, 98, 99, 100, 0x6c, 0x00, 0x11, 0x00, 0x00);
        const out = new Uint8Array(16);
        const n = lzo1x(src, out);
        expect(new TextDecoder().decode(out.subarray(0, n))).toBe('abcdabcd');
    });
});

describe('TS and RA2 maps', () => {
    it('reads cells from [IsoMapPack5] and draws them flat without the theater', () => {
        // Two cells: (10, 5) at height 0, (11, 5) at height 3; packed as one LZO block of literals.
        const cells = new Uint8Array(22);
        const v = new DataView(cells.buffer);
        [[10, 5, 0], [11, 5, 3]].forEach(([x, y, level], i) => {
            v.setUint16(i * 11, x, true);
            v.setUint16(i * 11 + 2, y, true);
            v.setInt32(i * 11 + 4, -1, true);
            cells[i * 11 + 9] = level;
        });
        const lzo = Uint8Array.of(17 + 22, ...cells, 0x11, 0, 0);
        const block = Uint8Array.of(lzo.length, 0, 22, 0, ...lzo);
        const text = `[Map]\nTheater=SNOW\nSize=0,0,10,10\n[IsoMapPack5]\n1=${btoa(String.fromCharCode(...block))}\n[Terrain]\n5010=TREE01\n`;
        const ini = new Ini(text);
        const map = readIsoMap(ini);
        expect(map.cells.map((c) => [c.rx, c.ry, c.level])).toEqual([[10, 5, 0], [11, 5, 3]]);
        expect(map.terrain).toEqual([[10, 5, 'TREE01']]);
        const links = new Links();
        const previews = isoMapPreviews(ini, () => [], 'test.map', links);
        expect(previews.items[0].preview.kind).toBe('picture');
        expect(previews.wanted).toMatch(/SNOW\.INI/);
        // What it looked for and didn't find is listed, so the user can see what to add.
        expect(links.missed.map((l) => l.name)).toEqual(expect.arrayContaining(['snow.ini', 'isosno.pal']));
    });
});

describe('names from executables', () => {
    it('finds file names and expands printf patterns', () => {
        const exe = new TextEncoder().encode('\0\0MZ\0RULES.INI\0junk\0E%02dSC%02d.MIX\0ISO%s.PAL\0');
        const names = namesFromBinary(exe);
        expect(names).toEqual(expect.arrayContaining(['rules.ini', 'e01sc02.mix', 'e99sc99.mix', 'isotem.pal']));
    });
});

describe('small leftovers', () => {
    it('reads voxel lighting tables', () => {
        const data = bytes(16 + 768 + 2 * 256, (v) => {
            v.setUint32(0, 16, true);
            v.setUint32(4, 31, true);
            v.setUint32(8, 2, true);
        });
        expect(detect(data, null).id).toBe('vpl');
    });

    it('recognizes an empty sprite', () => {
        const data = bytes(8 + 24, (v) => {
            v.setUint16(6, 1, true);
            v.setUint32(8 + 20, 0x12fb00, true);
        });
        expect(detect(data, null).id).toBe('shp-ts');
    });
});

describe('Bink', () => {
    it('reads the frame index, keyframes and sound tracks, and loads the decoders', async () => {
        // One stereo DCT sound track; two frames, the first a keyframe, each an empty sound packet and 2 bytes of video.
        const index = 44 + 12;
        const frames = index + 3 * 4;
        const data = bytes(frames + 12, (v, b) => {
            ascii(b, 0, 'BIKi');
            v.setUint32(8, 2, true);
            v.setUint32(20, 32, true);
            v.setUint32(24, 16, true);
            v.setUint32(28, 15, true);
            v.setUint32(32, 1, true);
            v.setUint32(40, 1, true);
            v.setUint16(48, 22050, true);
            v.setUint16(50, 0x2000 | 0x1000, true);
            v.setUint32(index, frames | 1, true);
            v.setUint32(index + 4, frames + 6, true);
            v.setUint32(index + 8, frames + 12, true);
        });
        expect(detect(data, null).id).toBe('bink');
        const format = detect(data, null);
        const parsed = (await format.load()).parse(data, context('test.bik'));
        expect(parsed.warnings).toEqual([]);
        expect(parsed.summary).toContainEqual(['Frames', '2 at 15 per second (0.1 s), 1 keyframe']);
        expect(parsed.summary).toContainEqual(['Sound', '22050 Hz stereo, DCT']);
        expect(parsed.fields.map((f) => f.name)).toEqual(expect.arrayContaining(['Frame 0 (keyframe)', 'Frame 1']));
        expect(parsed.preview?.kind).toBe('video');
    });
});

describe('team colors', () => {
    it('recolors only the remap range', () => {
        const palette = Uint8Array.from({ length: 768 }, (_, i) => i % 256);
        const out = teamPalette(palette, [16, 31], [200, 0, 0]);
        expect([...out.subarray(15 * 3, 16 * 3)]).toEqual([...palette.subarray(15 * 3, 16 * 3)]);
        expect(out[16 * 3]).toBeGreaterThan(200);
        expect(out[16 * 3 + 1]).toBe(0);
        expect([...out.subarray(32 * 3, 33 * 3)]).toEqual([...palette.subarray(32 * 3, 33 * 3)]);
    });

    it('sends a range to the nearest colors outside it', () => {
        const palette = new Uint8Array(768);
        palette.set([255, 0, 0], 5 * 3);
        palette.set([0, 0, 255], 6 * 3);
        const table = teamRemap(palette, [80, 95], [255, 0, 0]);
        expect(table[80]).toBe(5);
        expect(table[4]).toBe(4);
    });
});

describe('objects on TS and RA2 maps', () => {
    it('reads buildings, units and infantry by X and Y', () => {
        const ini = new Ini('[Map]\nSize=0,0,10,10\n[Structures]\n0=GDI,GAPOWR,256,20,30,0,None\n[Units]\n0=Nod,BGGY,256,21,31,64,Guard\n[Infantry]\n0=GDI,E1,256,22,32,3,Guard,128\n[GDI]\nColor=Gold\n');
        const map = readIsoMap(ini);
        expect(map.objects).toEqual([
            { kind: 'building', house: 'GDI', type: 'GAPOWR', rx: 20, ry: 30, facing: 0, sub: 0, health: 256 },
            { kind: 'unit', house: 'Nod', type: 'BGGY', rx: 21, ry: 31, facing: 64, sub: 0, health: 256 },
            { kind: 'infantry', house: 'GDI', type: 'E1', rx: 22, ry: 32, facing: 128, sub: 3, health: 256 },
        ]);
        expect(map.houseColors.get('gdi')).toBe('Gold');
    });
});

describe('rules tables', () => {
    it('lists objects by type, with names from the string table and links to their art', () => {
        const rules = '[VehicleTypes]\n0=HTNK\n[InfantryTypes]\n0=E1\n[HTNK]\nUIName=Name:HTNK\nCost=900\nStrength=400\n[E1]\nName=GI\nImage=GI\nCost=200\n';
        const art = new TextEncoder().encode('[HTNK]\nVoxel=yes\nCameo=HTNKICON\n[GI]\nCameo=GIICON\n');
        const name = 'Name:HTNK';
        const text = [...'Rhino'].map((c) => ~c.charCodeAt(0) & 0xffff);
        const csf = bytes(24 + 12 + name.length + 8 + text.length * 2, (v, b) => {
            ascii(b, 0, ' FSC');
            v.setUint32(8, 1, true);
            ascii(b, 24, ' LBL');
            v.setUint32(28, 1, true);
            v.setUint32(32, name.length, true);
            ascii(b, 36, name);
            ascii(b, 36 + name.length, ' RTS');
            v.setUint32(40 + name.length, text.length, true);
            text.forEach((c, i) => v.setUint16(44 + name.length + i * 2, c, true));
        });
        const files: Record<string, Uint8Array> = { 'art.ini': art, 'ra2.csf': csf, 'htnk.vxl': new Uint8Array(1) };
        const find = (n: string) => (files[n] ? [{ data: files[n], source: 'ra2.mix' }] : []);
        const table = rulesTable(new Ini(rules), 'rules.ini', find, new Links());
        if (table?.preview.kind !== 'table') throw new Error('expected a table');
        expect(table.preview.groups).toEqual(['Infantry', 'Vehicles']);
        const [gi, htnk] = table.preview.rows;
        expect(htnk.cells).toMatchObject({ id: 'HTNK', name: 'Rhino', cost: '900', art: 'htnk.vxl', cameo: 'htnkicon.shp (not in the files in use)' });
        expect(gi.cells).toMatchObject({ id: 'E1', name: 'GI', art: 'gi.shp (not in the files in use)' });
        expect(gi.files?.art[0]).toBe('gi.shp');
    });
});

describe('TS movie sound', () => {
    it('reads version 3 stereo as the left half of each chunk, then the right', () => {
        const chunk = (id: string, body: number[]) => [...id].map((c) => c.charCodeAt(0)).concat([0, 0, body.length >> 8, body.length & 255], body, body.length & 1 ? [0] : []);
        const header = new Array(42).fill(0);
        Object.assign(header, { 0: 3, 24: 0x22, 25: 0x56, 26: 2, 27: 16 });
        // Left: bytes 0x21, 0x43 (nibbles 1, 2, 3, 4); right: 0x65, 0x07 (5, 6, 7, 0).
        const body = [...'WVQA'].map((c) => c.charCodeAt(0)).concat(chunk('VQHD', header), chunk('SND2', [0x21, 0x43, 0x65, 0x07]));
        const data = Uint8Array.from([...'FORM'].map((c) => c.charCodeAt(0)).concat([0, 0, 0, body.length], body));
        const preview = vqa.parse(data, context()).preview;
        const clip = preview?.kind === 'audio' ? preview : preview?.kind === 'video' ? preview.audio : undefined;
        if (!clip) throw new Error('expected sound');
        const samples = new Int16Array(clip.wav.buffer, clip.wav.byteOffset + 44, 8);
        const expect4 = (nibbles: number[]) => {
            const state = { index: 0, sample: 0 };
            return nibbles.map((n) => imaSample(state, n));
        };
        const [left, right] = [expect4([1, 2, 3, 4]), expect4([5, 6, 7, 0])];
        expect([...samples]).toEqual(left.flatMap((l, i) => [l, right[i]]));
    });
});
