import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { encodePng } from '../../core/png';
import { detect } from '../index';
import png from './index';

const samples = join(__dirname, '../../../samples/images');

describe('PNG', () => {
    it('reads back what it writes', () => {
        const rgba = Uint8Array.from({ length: 5 * 3 * 4 }, (_, i) => (i * 37) & 0xff);
        const file = encodePng(5, 3, rgba);
        expect(detect(file, null).id).toBe('png');
        const parsed = png.parse(file, { name: null, names: [] });
        expect(parsed.warnings).toEqual([]);
        expect(parsed.preview?.kind === 'picture' && parsed.preview.rgba).toEqual(rgba);
    });

    it.skipIf(!existsSync(samples))('draws a sample exactly as Pillow does', () => {
        const parsed = png.parse(new Uint8Array(readFileSync(join(samples, 'png-rgb.png'))), { name: null, names: [] });
        expect(parsed.summary).toEqual(expect.arrayContaining([['Size', '626 × 626'], ['Color', 'RGB, 8-bit']]));
        expect(parsed.fields.map((f) => f.name)).toEqual(expect.arrayContaining(['sRGB (sRGB rendering intent)', 'gAMA (Gamma)', 'pHYs (Pixel size)', 'IEND (End)']));
        const p = parsed.preview;
        if (p?.kind !== 'picture') throw new Error('expected a picture');
        const px = (x: number, y: number) => Array.from(p.rgba.subarray((y * p.width + x) * 4, (y * p.width + x) * 4 + 4));
        expect([px(0, 0), px(313, 313), px(625, 625)]).toEqual([
            [255, 254, 255, 255],
            [99, 68, 65, 255],
            [255, 254, 255, 255],
        ]);
        expect(parsed.warnings).toEqual([]);
    });
});
