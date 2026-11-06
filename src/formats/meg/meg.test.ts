import { describe, expect, it } from 'vitest';
import { detect } from '../index';
import meg from './index';

/** A MEG of each version, holding the given files (names, then records sorted as given, then the data). */
function build(version: 1 | 2 | 3, files: [path: string, data: string][]): Uint8Array {
    const enc = new TextEncoder();
    const names = files.map(([p]) => enc.encode(p));
    const namesSize = names.reduce((n, b) => n + 2 + b.length, 0);
    const header = version === 1 ? 8 : version === 2 ? 20 : 24;
    const dataStart = header + namesSize + files.length * 20;
    const bodies = files.map(([, d]) => enc.encode(d));
    const out = new Uint8Array(dataStart + bodies.reduce((n, b) => n + b.length, 0));
    const v = new DataView(out.buffer);
    let at = 0;
    if (version > 1) {
        v.setUint32(0, 0xffffffff, true);
        v.setUint32(4, 0x3f7d70a4, true);
        v.setUint32(8, dataStart, true);
        at = 12;
    }
    v.setUint32(at, files.length, true);
    v.setUint32(at + 4, files.length, true);
    if (version === 3) v.setUint32(20, namesSize, true);
    at = header;
    for (const n of names) (v.setUint16(at, n.length, true), out.set(n, at + 2), (at += 2 + n.length));
    let start = dataStart;
    bodies.forEach((b, i) => {
        const r = at + i * 20;
        if (version === 3) {
            v.setUint16(r, 0, true);
            v.setUint32(r + 2, 0x12345678, true);
            v.setUint32(r + 6, i, true);
            v.setUint32(r + 10, b.length, true);
            v.setUint32(r + 14, start, true);
            v.setUint16(r + 18, i, true);
        } else {
            v.setUint32(r, 0x12345678, true);
            v.setUint32(r + 4, i, true);
            v.setUint32(r + 8, b.length, true);
            v.setUint32(r + 12, start, true);
            v.setUint32(r + 16, i, true);
        }
        out.set(b, start);
        start += b.length;
    });
    return out;
}

describe('MEG archives', () => {
    const files: [string, string][] = [
        ['DATA\\XML\\GAMEOBJECTFILES.XML', '<xml/>'],
        ['DATA\\AUDIO\\MUSIC\\TDR_MUS_ACT_ON_INSTINCT.WAV', 'not really a WAV'],
    ];

    for (const version of [1, 2, 3] as const) {
        it(`reads version ${version}: names, records and files`, () => {
            const data = build(version, files);
            expect(detect(data, null).id).toBe('meg');
            const parsed = meg.parse(data, { name: null, names: [] });
            expect(parsed.title).toBe(`Petroglyph MEG archive (version ${version})`);
            expect(parsed.entries!.map((e) => [e.name, e.meta!.Folder, new TextDecoder().decode(e.data)])).toEqual([
                ['GAMEOBJECTFILES.XML', 'DATA\\XML', '<xml/>'],
                ['TDR_MUS_ACT_ON_INSTINCT.WAV', 'DATA\\AUDIO\\MUSIC', 'not really a WAV'],
            ]);
            expect(parsed.warnings).toEqual([]);
        });
    }

    it('says when the tables are encrypted rather than misreading them', () => {
        const data = build(3, files);
        // 0x8FFFFFFF, little-endian.
        data[3] = 0x8f;
        expect(detect(data, null).id).toBe('meg');
        expect(() => meg.parse(data, { name: null, names: [] })).toThrow(/encrypted/);
    });
});
