import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Parsed } from '../../core/types';
import { detect } from '../index';
import pak from './pak';
import { WSA_HEADERS, wsaLayout, type WsaVersion } from './sniff';
import wsa from './wsa';

// A 2 × 1 animation: frame 1 is 3, 4; frame 2 XORs that with 1, 1 (so 2, 5); the loop frame XORs it back with 1, 1.
const lcwOf = (delta: number[]) => [0x80 | delta.length, ...delta, 0x80];
const FRAME1 = lcwOf([0x02, 3, 4, 0x80, 0, 0]);
const FRAME2 = lcwOf([0x02, 1, 1, 0x80, 0, 0]);
const LOOP = lcwOf([0x02, 1, 1, 0x80, 0, 0]);

function build(version: WsaVersion, { loop = false, palette = false, largest = 16, frames = [FRAME1, FRAME2] } = {}): Uint8Array {
    const h = WSA_HEADERS[version];
    const bodies = loop ? [...frames, LOOP] : frames;
    const tableEnd = h.size + (frames.length + 2) * 4;
    const out = new Uint8Array(tableEnd + (palette ? 768 : 0) + bodies.reduce((n, f) => n + f.length, 0));
    const v = new DataView(out.buffer);
    v.setUint16(0, frames.length, true);
    v.setUint16(h.width, 2, true);
    v.setUint16(h.height, 1, true);
    v.setUint16(h.delta, largest, true);
    if (h.flags >= 0) v.setUint16(h.flags, palette ? 1 : 0, true);
    // Offsets don't count the palette.
    let at = tableEnd;
    for (const [i, f] of bodies.entries()) {
        v.setUint32(h.size + i * 4, at, true);
        out.set(f, at + (palette ? 768 : 0));
        at += f.length;
    }
    v.setUint32(h.size + bodies.length * 4, at, true);
    return out;
}

const parse = (data: Uint8Array) => wsa.parse(data, { name: 'x.wsa', names: [] }) as Parsed;
const pixels = (r: Parsed) => (r.preview?.kind === 'images' ? r.preview.frames.map((f) => [...f.pixels]) : null);

describe('WSA', () => {
    it.each(Object.keys(WSA_HEADERS) as WsaVersion[])('reads the %s header', (version) => {
        const data = build(version);
        expect(detect(data, null).id).toBe('wsa');
        expect(wsaLayout(data)?.version).toBe(version);
        const r = parse(data);
        expect(pixels(r)).toEqual([
            [3, 4],
            [2, 5],
        ]);
        expect(r.summary[0]).toEqual(['Version', WSA_HEADERS[version].name]);
        expect(r.warnings).toEqual([]);
    });

    it('reads a palette and a loop frame', () => {
        const data = build('cnc', { loop: true, palette: true });
        data[14 + 4 * 4] = 63; // the first color's red, at full
        const r = parse(data);
        expect(r.summary).toContainEqual(['Frames', '2, loops']);
        expect(r.preview?.kind === 'images' && r.preview.palette?.[0]).toBeTruthy();
        expect(r.warnings).toEqual([]);
        // A loop frame that doesn't go back.
        const bad = build('cnc', { loop: true });
        bad[bad.length - 6] = 7; // XOR the first pixel with 7, not 1
        expect(parse(bad).warnings).toEqual(["The loop frame doesn't lead back to the first frame."]);
    });

    it('warns about frames the game has no room for', () => {
        // The header says deltas are at most 0 bytes (+37); a frame XORing 100 bytes is more than that, and more than the frame.
        const big = lcwOf([0x00, 100, 9, 0x80, 0, 0]);
        const r = parse(build('dune2-100', { largest: 0, frames: [big, FRAME2] }));
        expect(r.warnings.join(' ')).toMatch(/Frame 1 reaches past the 2 × 1 frame/);
        const huge = [0x80 | 3, 0x00, 255, 9, 0xfe, 100, 0, 0, 0x80];
        expect(parse(build('dune2-100', { largest: 0, frames: [huge, FRAME2] })).warnings.join(' ')).toMatch(/Frame 1 decompresses to more than the 37 bytes/);
        expect(parse(build('cnc', { frames: [big, big, big] })).warnings).toContain('Frames 1, 2 and 3 reach past the 2 × 1 frame: the game would draw outside it.');
    });

    it("isn't fooled by offsets that don't fit", () => {
        const good = build('dune2-100');
        // The first frame not right after the table.
        const gap = good.slice();
        gap[8] += 1;
        expect(wsaLayout(gap)).toBeNull();
        // Data after the last frame.
        expect(wsaLayout(Uint8Array.from([...good, 0]))).toBeNull();
        expect(() => parse(new Uint8Array(30))).toThrow(/isn't a WSA/);
    });
});

// Dune II's animations, inside its PAKs, if present (they aren't committed).
const DUNE = join(__dirname, '../../../samples/westwood/Dune II');
describe.skipIf(!existsSync(DUNE))("Dune II's WSAs", () => {
    it('reads all 75, as version 1.00, with nothing to warn about but one bad loop', () => {
        let count = 0;
        // As shipped: FREMEN.WSA's loop frame is its first frame again.
        const expected: Record<string, unknown[]> = { 'FREMEN.WSA': [expect.stringMatching(/it's a copy of the first frame's data/)] };
        for (const name of readdirSync(DUNE).filter((n) => /\.pak$/i.test(n))) {
            const entries = pak.parse(new Uint8Array(readFileSync(join(DUNE, name))), { name, names: [] }).entries!;
            for (const e of entries.filter((x) => /\.wsa$/i.test(x.label))) {
                expect(detect(e.data, e.name).id, e.label).toBe('wsa');
                const r = parse(e.data);
                expect(r.summary[0], e.label).toEqual(['Version', 'Dune II 1.00']);
                expect(r.warnings, `${name} › ${e.label}`).toEqual(expected[e.label] ?? []);
                count++;
            }
        }
        expect(count).toBe(75);
    });
});
