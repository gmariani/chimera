import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Field } from '../../core/types';
import { encodePng } from '../../core/png';
import { detect } from '../index';
import png from '../png';
import { typeEntries } from '../../lib/inspect';
import { decodeSwfAdpcm } from './assets';
import swf from './index';

const samples = join(__dirname, '../../../SWF Samples');

const find = (fields: Field[], name: string): Field | undefined => {
    for (const f of fields) {
        if (f.name === name) return f;
        const inside = f.children && find(f.children, name);
        if (inside) return inside;
    }
};

describe('PNG', () => {
    it('reads back what it writes', () => {
        const rgba = Uint8Array.from({ length: 5 * 3 * 4 }, (_, i) => (i * 37) & 0xff);
        const file = encodePng(5, 3, rgba);
        expect(detect(file, null).id).toBe('png');
        const parsed = png.parse(file, { name: null, names: [] });
        expect(parsed.warnings).toEqual([]);
        expect(parsed.preview?.kind === 'picture' && parsed.preview.rgba).toEqual(rgba);
    });
});

describe('ADPCM', () => {
    it('reads 2-bit codes from each packet\'s first sample and index', () => {
        // Code size 0 (2 bits), sample 100, index 0, then codes 01 (up a step) and 11 (down).
        const bits = '00' + (100).toString(2).padStart(16, '0') + '000000' + '01' + '11';
        const bytes = Uint8Array.from(bits.padEnd(Math.ceil(bits.length / 8) * 8, '0').match(/.{8}/g)!, (b) => parseInt(b, 2));
        // Step 7: code 01 adds 7 + 3 (the last half step) and moves the index up 2, to step 9; code 11 takes 9 + 4 away.
        expect(Array.from(decodeSwfAdpcm(bytes, 1)).slice(0, 3)).toEqual([100, 110, 97]);
    });
});

describe.skipIf(!existsSync(samples))('sample movies', () => {
    const open = (name: string) => swf.parse(new Uint8Array(readFileSync(join(samples, name))), { name, names: [] });

    it('reads an uncompressed movie\'s tags, frame by frame', () => {
        const parsed = open('Demo v8.swf');
        expect(parsed.summary).toEqual(expect.arrayContaining([['Stage', '550 × 400 px'], ['Frames', '226 at 24 fps'], ['Background', '#333333']]));
        expect(parsed.fields.filter((f) => f.name.startsWith('Frame ')).length).toBe(226);
        expect(find(parsed.fields, 'DefineVideoStream')?.value).toBe('#40, 320 × 240, On2 VP6');
        expect(parsed.warnings).toEqual([]);
    });

    it('pulls out its bitmaps, sounds and video as files', () => {
        const files = typeEntries(open('Demo v8.swf').entries!).map((e) => [e.fileName, e.format.id]);
        expect(files).toEqual(
            expect.arrayContaining([
                ['sound 1 (ExportADPCM).wav', 'wav'],
                ['sound 3 (ExportSpeech).nelly', 'raw'],
                ['sound 4 (ExportMP3).mp3', 'mp3'],
                ['image 6.jpg', 'jpeg'],
                // DefineBitsJPEG3 with a Flash 5 JPEG (an EOI and SOI in its middle), and its alpha.
                ['image 25.png', 'png'],
                ['stream.mp3', 'mp3'],
                ['video 40.flv', 'raw'],
            ]),
        );
    });

    it('inflates a compressed movie and names assets by their classes', () => {
        const parsed = open('Demo v10.swf');
        expect(parsed.title).toBe('Flash movie (SWF 10, compressed)');
        const files = typeEntries(parsed.entries!).map((e) => e.fileName);
        expect(files[0]).toBe('uncompressed.swf');
        expect(files).toContain('binary 44 (Demov10_fla.MainTimeline_GrayScaleKernel).bin');
        expect(files).toContain('font 43 (Demov10_fla.MainTimeline_AdobeArabicFullFont).otf');
        // Its structure is the header and the compressed data; the uncompressed movie has the tags.
        expect(parsed.fields.map((f) => f.name)).toEqual(['Header', 'Compressed movie']);
        const inner = swf.parse(parsed.entries![0].data, { name: null, names: [] });
        expect(find(inner.fields, 'SymbolClass')).toBeDefined();
    });

    it('says when an obfuscator has been at it', () => {
        expect(open('Flashbug Demo_swfprotector.swf').summary).toContainEqual(['Obfuscated', 'Yes: it has an obfuscator\'s tags']);
    });
});
