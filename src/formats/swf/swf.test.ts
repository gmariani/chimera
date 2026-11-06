import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Field } from '../../core/types';
import { detect } from '../index';
import pbj from '../pbj';
import sfnt from '../font';
import wavParser from '../wav';
import { typeEntries } from '../../lib/inspect';
import { decodeSwfAdpcm } from './assets';
import swf from './index';

const samples = join(__dirname, '../../../samples/flash');

const find = (fields: Field[], name: string): Field | undefined => {
    for (const f of fields) {
        if (f.name === name) return f;
        const inside = f.children && find(f.children, name);
        if (inside) return inside;
    }
};

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
        const parsed = open('swf-v8.swf');
        expect(parsed.summary).toEqual(expect.arrayContaining([['Stage', '550 × 400 px'], ['Frames', '226 at 24 fps'], ['Background', '#333333']]));
        expect(parsed.fields.filter((f) => f.name.startsWith('Frame ')).length).toBe(226);
        expect(find(parsed.fields, 'DefineVideoStream')?.value).toBe('#40, 320 × 240, On2 VP6');
        expect(parsed.warnings).toEqual([]);
    });

    it('pulls out its bitmaps, sounds and video as files', () => {
        const files = typeEntries(open('swf-v8.swf').entries!).map((e) => [e.fileName, e.format.id]);
        expect(files).toEqual(
            expect.arrayContaining([
                ['sound 1 (ExportADPCM).wav', 'wav'],
                ['sound 3 (ExportSpeech).wav', 'wav'],
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
        const parsed = open('swf-v10-zlib.swf');
        expect(parsed.title).toBe('Flash movie (SWF 10, compressed)');
        const files = typeEntries(parsed.entries!).map((e) => e.fileName);
        expect(files[0]).toBe('uncompressed.swf');
        expect(files).toContain('binary 44 (Demov10_fla.MainTimeline_GrayScaleKernel).pbj');
        expect(files).toContain('font 43 (Demov10_fla.MainTimeline_AdobeArabicFullFont).otf');
        // Its structure is the header and the compressed data; the uncompressed movie has the tags.
        expect(parsed.fields.map((f) => f.name)).toEqual(['Header', 'Compressed movie']);
        const inner = swf.parse(parsed.entries![0].data, { name: null, names: [] });
        expect(find(inner.fields, 'SymbolClass')).toBeDefined();
    });

    it('decodes Nellymoser speech: 109 blocks of 256 samples', () => {
        const sound = open('swf-v8.swf').entries!.find((e) => e.label === 'sound 3 (ExportSpeech)')!;
        const parsed = wavParser.parse(sound.data, { name: null, names: [] });
        expect(parsed.preview?.kind === 'audio' && Math.round(parsed.preview.seconds * 44100)).toBe(109 * 256);
        // FFmpeg's decode of it peaks at 0.671 (22,000 or so); the noise filling empty bands is random, so only roughly.
        const samples = new Int16Array(sound.data.buffer.slice(sound.data.byteOffset + 44, sound.data.byteOffset + sound.data.length));
        expect(Math.max(...samples.map(Math.abs))).toBeGreaterThan(21000);
        expect(Math.max(...samples.map(Math.abs))).toBeLessThan(23000);
    });

    it('disassembles the Pixel Bender kernel in its binary data', () => {
        const kernel = open('swf-v10-pixelbender.swf').entries!.find((e) => e.label.includes('GrayScaleKernel'))!;
        expect(detect(kernel.data, null).id).toBe('pbj');
        const parsed = pbj.parse(kernel.data, { name: null, names: [] });
        expect(parsed.summary).toEqual(expect.arrayContaining([['Name', 'GrayScale'], ['Vendor', 'Mike Chambers'], ['Instructions', '21']]));
        const text = parsed.preview?.kind === 'text' ? parsed.preview.text : '';
        expect(text).toContain('f2.xyzw = sampleNearest(texture 0, f0.xy)');
        expect(text).toContain('f0.z = 0.7154');
    });

    it('reads its embedded OpenType font and draws the glyphs', () => {
        const font = open('swf-v10-pixelbender.swf').entries!.find((e) => e.label.startsWith('font 42'))!;
        expect(typeEntries([font])[0].fileName).toBe('font 42 (FlashbugDemo_fla.MainTimeline_AdobeArabicFullFont).otf');
        const parsed = sfnt.parse(font.data, { name: null, names: [] });
        expect(parsed.summary).toEqual(expect.arrayContaining([['Family', 'Adobe Arabic'], ['Glyphs', '1214'], ['Outlines', 'CFF']]));
        expect(parsed.warnings).toEqual([]);
        const sheet = parsed.preview?.kind === 'stack' ? parsed.preview.items[0].preview : undefined;
        if (sheet?.kind !== 'picture') throw new Error('expected a glyph sheet');
        // Some ink in the cells (glyphs drawn), not all of it (not filled solid).
        const dark = sheet.rgba.filter((v, i) => i % 4 === 0 && v < 128).length;
        expect(dark / (sheet.width * sheet.height)).toBeGreaterThan(0.02);
        expect(dark / (sheet.width * sheet.height)).toBeLessThan(0.3);
    });

    it('says when an obfuscator has been at it', () => {
        expect(open('swf-obfuscated-swfprotector.swf').summary).toContainEqual(['Obfuscated', 'Yes: it has an obfuscator\'s tags']);
    });
});
