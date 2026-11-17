import { describe, expect, it } from 'vitest';
import type { Parsed } from '../core/types';
import { mp3Tagged } from '../testing/samples';
import { detect } from './index';
import mp3 from './mp3';

const parse = (data: Uint8Array) => mp3.parse(data, { name: 'sound.mp3', names: [] }) as Parsed;

describe('MP3', () => {
    it('steps over an ID3v2.4 tag’s footer to the first frame', () => {
        const data = mp3Tagged(20);
        expect(detect(data, 'sound.mp3').id).toBe('mp3');
        const r = parse(data);
        expect(r.warnings).toEqual([]);
        const tag = r.fields.find((f) => f.name === 'ID3v2 tag')!;
        expect(tag.length).toBe(10 + 20 + 10);
        expect(tag.children!.map((f) => f.name)).toEqual(['Identifier', 'Version', 'Flags', 'Size', 'Frames', 'Footer']);
        expect(r.fields.reduce((n, f) => n + f.length, 0)).toBe(data.length);
    });

    it('says when the footer a tag promises isn’t there', () => {
        expect(parse(mp3Tagged(20, 'XYZ')).warnings).toContain(`The ID3v2 tag says it has a footer, but the 10 bytes after it don't start with "3DI".`);
    });
});
