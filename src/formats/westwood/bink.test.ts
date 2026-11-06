import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detect } from '../index';
import bink, { ready } from './bink';

const samples = join(__dirname, '../../../samples/westwood');

describe.skipIf(!existsSync(join(samples, 'GDI13.BK2')))('Bink 2 (the Remastered Collection\'s movies)', () => {
    const open = async (name: string) => {
        await ready();
        const data = new Uint8Array(readFileSync(join(samples, name)));
        expect(detect(data, name).id).toBe('bink');
        return bink.parse(data, { name, names: [] });
    };

    it('reads the container, with revision j\'s extra header field', async () => {
        const parsed = await open('GDI01_INTRO_02.BK2');
        expect(parsed.title).toBe('Bink 2 video');
        expect(parsed.summary).toEqual(expect.arrayContaining([['Version', 'j'], ['Size', '704 × 396'], ['Frames', '311 at 30 per second (10.4 s), 1 keyframe'], ['Sound', '48000 Hz stereo, DCT']]));
        expect(parsed.fields.map((f) => f.name).slice(0, 5)).toEqual(['Header', 'Unknown', 'Track 0 largest decoded size', 'Track 0 format', 'Track 0 ID']);
    });

    it('plays the sound, and says why there\'s no picture', async () => {
        const parsed = await open('GDI01_INTRO_02.BK2');
        expect(parsed.warnings).toEqual(['Bink 2 video can\'t be shown: RAD never published the format and FFmpeg has no decoder for it. The sound plays.']);
        if (parsed.preview?.kind !== 'audio') throw new Error('expected the sound');
        // 48 kHz stereo; FFmpeg's command-line decode of it has the same 998,400 samples.
        expect([parsed.preview.sampleRate, parsed.preview.channels]).toEqual([48000, 2]);
        expect((parsed.preview.wav.length - 44) / 2).toBe(998400);
    });

    it('offers each of several sound tracks', async () => {
        const parsed = await open('GDI13.BK2');
        if (parsed.preview?.kind !== 'stack') throw new Error('expected a track each');
        expect(parsed.preview.items.map((i) => [i.title, i.preview.kind === 'audio' && i.preview.seconds.toFixed(1)])).toEqual([
            ['Sound track 1', '40.4'],
            ['Sound track 2', '40.4'],
            ['Sound track 3', '40.4'],
        ]);
    });
});
