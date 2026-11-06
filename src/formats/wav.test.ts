import { describe, expect, it } from 'vitest';
import wav from './wav';

const fromHex = (text: string) => Uint8Array.from(text.match(/../g)!, (b) => parseInt(b, 16));

describe('Microsoft ADPCM', () => {
    // A 30 ms stereo tone (440 Hz left, 660 Hz right, 8 kHz), encoded by FFmpeg with 64-byte blocks.
    const file = fromHex(
        [
        '52494646b401000057415645666d74203200000002000200401f0000803e00004000040020003400070000010000000200ff00000000c0004000f0000000cc0130ff880118ff6661637404000000f000',
        '00004c4953541a000000494e464f495346540e0000004c61766636302e31362e3130300064617461400100000000100010006b05ed07000000007777777cf8fddecfd1d3d4e402223f6d3b4d3e2e2103',
        'f5d3b3c2dfdddbec0e1e316234443321201efbddbddeb0e3e5e3f31200003b01c801dbf77d0bacf37f0f4c4c3d3e200205d3c3b2d0dedcdcfc1e205243354332201ffcecddaedfd2c4e4f302214f3c5c',
        '3c3e2f1104e3d4a2d1dfcdeb00008801930233f05df24af04cf81f3133543333322f0cecdcaddfc1d3e4e502114f3e5d3b3e3e2112e4d4b2c2cfeedcfcfd1f205235433332201dfcdbbeced000008401',
        '130201f44bfb4cf857f4e4f312204e5c3c3c3f2f12f3e5c3b1d1ceeddb0d0e2f3264343332212efdeacdceb0d1e3e5f302114f3c5c3d3e3f1103f5c400001f01cf028100fb0fe405810dbfdeedfcfd2f',
        '315345333321201deaddaedfc0d3e4e40311305d3c5b2e2f9600000000000000000000000000000000000000',
    ].join(''),
    );

    it('decodes as FFmpeg does, sample for sample', () => {
        const parsed = wav.parse(file, { name: null, names: [] });
        expect(parsed.summary).toEqual(expect.arrayContaining([['Format', 'Microsoft ADPCM'], ['Channels', 'Stereo'], ['Sample rate', '8000 Hz']]));
        if (parsed.preview?.kind !== 'audio') throw new Error('expected audio');
        const w = parsed.preview.wav;
        const samples = new Int16Array(w.buffer.slice(w.byteOffset + 44, w.byteOffset + w.length));
        // FFmpeg's decode: 520 samples (each block's two header samples first, the second played first), and their sums.
        expect(samples.length).toBe(520);
        expect(Array.from(samples.slice(0, 12))).toEqual([0, 0, 1387, 2029, 1499, 2141, 1765, 2407, 2402, 3044, 3928, 2172]);
        expect(samples.reduce((a, b) => a + b, 0)).toBe(7932);
        expect(samples.reduce((a, b) => a + Math.abs(b), 0)).toBe(1246282);
        expect(parsed.warnings).toEqual([]);
    });

    it('lists the predictor coefficients in its format chunk', () => {
        const parsed = wav.parse(file, { name: null, names: [] });
        const fmt = parsed.fields.find((f) => f.name === 'fmt ')!;
        expect(fmt.children!.find((c) => c.name === 'Coefficients')?.value).toBe('256 0, 512 -256, 0 0, 192 64, 240 0, 460 -208, 392 -232');
    });
});
