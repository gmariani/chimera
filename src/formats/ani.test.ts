import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Parsed } from '../core/types';
import { gameDir } from '../testing/game-data';
import { animatedCursor, cursorDib, iconFile } from '../testing/samples';
import ani from './ani';
import ico from './ico';
import { detect } from './index';
import { inspect } from './inspect';

const parse = (data: Uint8Array) => ani.parse(data, { name: 'cursor.ani', names: [] }) as Parsed;
const enc = new TextEncoder();
const u32 = (v: number) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, v >>> 24];
const chunk = (id: string, body: ArrayLike<number>) => [...enc.encode(id), ...u32(body.length), ...Array.from(body), ...(body.length & 1 ? [0] : [])];
const arrow = iconFile([{ image: cursorDib(), width: 32, height: 32, colors: 2, planes: 0, bits: 0 }], 2);
/** A header: frames, steps, the default time, flags. */
const anih = (frames: number, steps: number, flags = 1, own = 36) => chunk('anih', [...u32(own), ...u32(frames), ...u32(steps), ...new Array(16).fill(0), ...u32(10), ...u32(flags)]);
const frames = (...icons: ArrayLike<number>[]) => chunk('LIST', [...enc.encode('fram'), ...icons.flatMap((i) => chunk('icon', i))]);
const riff = (...chunks: number[][]) => {
    const body = [...enc.encode('ACON'), ...chunks.flat()];
    return Uint8Array.from([...enc.encode('RIFF'), ...u32(body.length), ...body]);
};
const warnings = (...chunks: number[][]) => parse(riff(...chunks)).warnings;

describe('animated cursors (ANI)', () => {
    it('plays its frames in its own order, each step for its own time, and marks every byte', async () => {
        const data = animatedCursor();
        expect(detect(data, 'cursor.ani').id).toBe('ani');
        expect(detect(data, null).id).toBe('ani');
        const inspected = await inspect(data, { name: 'cursor.ani', names: [] });
        expect(inspected.checks).toEqual([]);
        const r = inspected.parsed;
        expect(r.warnings).toEqual([]);
        expect(r.summary).toEqual([
            ['Title', 'Spinning'],
            ['Author', 'Sample'],
            ['Frames', '2, 32 × 32'],
            ['Plays', '3 steps in 0.67 s, in its own order, then again'],
        ]);
        expect(r.fields.reduce((n, f) => n + f.length, 0)).toBe(data.length);
        expect(r.fields.find((f) => f.name === 'About it')!.children!.map((f) => f.name)).toEqual(['ID', 'Size', 'Form', 'Title', 'Padding', 'Author', 'Padding']);
        // 10, 20 and 10 jiffies: a tick of 10 (6 a second), the disc held for two.
        const p = r.preview!;
        if (p.kind !== 'video') throw new Error('not a video');
        expect([p.width, p.height, p.frameCount, p.fps]).toEqual([32, 32, 4, 6]);
        // Each step is its frame as the icon reader draws it on its own.
        const [first, second] = r.entries!.map((e) => {
            const q = (ico.parse(e.data, { name: null, names: [] }) as Parsed).preview!;
            return q.kind === 'picture' ? q.rgba : null;
        });
        const shown = [0, 1, 2, 3].map((i) => {
            const f = p.frame(i);
            return 'rgba' in f ? f.rgba : null;
        });
        expect(shown).toEqual([first, second, second, first]);
        expect(r.entries!.map((e) => [e.label, e.format])).toEqual([
            ['cursor-frame-1.cur', 'ico'],
            ['cursor-frame-2.cur', 'ico'],
        ]);
    });

    it('takes a RIFF size that counts its own header, as Westwood’s cursors have', async () => {
        const inspected = await inspect(animatedCursor({ wholeLength: true }), { name: 'cursor.ani', names: [] });
        expect(inspected.parsed.warnings).toEqual([]);
        expect(inspected.checks).toEqual([]);
    });

    it('says what Windows would refuse or ignore', () => {
        expect(warnings(anih(2, 2), frames(arrow))).toEqual(['Its header says it has 2 frames, but 1 is there.']);
        expect(warnings(anih(1, 1, 1, 32), frames(arrow))).toEqual(['Its header says it’s 32 bytes, not 36.']);
        expect(warnings(anih(1, 1, 0), frames(arrow))).toEqual(['Its header says the frames are bare bitmaps, not icons: Windows reads them as bitmaps with no hot spot.']);
        expect(warnings(anih(1, 1, 3), frames(arrow))).toEqual(['Its header says the steps follow a sequence, but it has none ("seq "): Windows won’t load it.']);
        expect(warnings(anih(1, 1), chunk('seq ', u32(0)), frames(arrow))).toEqual(['It has a sequence ("seq "), but its header doesn’t say to follow it: Windows ignores it.']);
        expect(warnings(anih(1, 2, 3), chunk('seq ', u32(0)), frames(arrow))).toEqual(['Its sequence has 1 step, but its header says 2.']);
        expect(warnings(anih(1, 1, 3), chunk('seq ', u32(1)), frames(arrow))).toEqual(['Step 1 of its sequence shows frame 1, but the frames are numbered 0 to 0: Windows won’t load it.']);
        expect(warnings(anih(1, 2), frames(arrow))).toEqual(['Its header says it takes 2 steps, but without a sequence it can only take one a frame (1).']);
        expect(warnings(anih(1, 1), chunk('rate', [...u32(5), ...u32(5)]), frames(arrow))).toEqual(['It gives times for 2 steps, but its header says 1.']);
        expect(warnings(anih(1, 1), anih(1, 1), frames(arrow))).toEqual(['It has a second header ("anih"): Windows reads the first.']);
        expect(warnings(chunk('anih', u32(36)), frames(arrow))).toContain('Its header ("anih") is 4 bytes, too short for the 36 it needs.');
        expect(warnings(frames(arrow))).toEqual(['It has no header ("anih"): Windows won’t load it. It’s played here one frame a step, 10 jiffies each.']);
        expect(warnings(anih(0, 0))).toEqual(['It has no list of frames ("LIST" of the form "fram"): there’s nothing to show.']);
        expect(warnings(anih(1, 1), frames([1, 2, 3, 4]))).toEqual([
            "Frame 1 isn’t an icon or cursor: This isn't a Windows icon or cursor: its header and entries don't point to pictures that fit the file.",
        ]);
        expect(warnings(anih(1, 1), frames([...arrow, 9, 9]))).toEqual(['Frame 1 has 2 bytes after its pictures that nothing reads.']);
        // Cut short: the file, then a chunk inside it.
        const whole = animatedCursor();
        expect(parse(whole.subarray(0, whole.length - 100)).warnings).toEqual(
            expect.arrayContaining([
                expect.stringMatching(/^It says it runs to [\d,]+ bytes, but the file ends at [\d,]+ bytes: it’s been cut short\.$/),
                expect.stringMatching(/^The "icon" chunk in the frames says it’s/),
            ])
        );
    });

    it('refuses what isn’t one', () => {
        expect(() => parse(enc.encode('RIFF\0\0\0\0WAVEfmt \0\0\0\0'))).toThrow('This isn’t an animated cursor: it doesn’t start with RIFF and the form ACON.');
        expect(() => parse(riff(chunk('junk', [1, 2])))).toThrow('This isn’t an animated cursor: it has neither a header ("anih") nor frames.');
    });
});

const CNC = gameDir('cncRemastered');
describe.skipIf(!CNC)('Red Alert’s cursor themes, in Counterstrike’s THEMES.Z', () => {
    it('plays all six, with no warnings', async () => {
        const archive = await inspect(new Uint8Array(readFileSync(join(CNC!, 'RED_ALERT/COUNTERSTRIKE/INSTALL/THEMES.Z'))), { name: 'THEMES.Z', names: [] });
        const cursors = archive.parsed.entries!.filter((e) => /\.ani$/i.test(e.name ?? ''));
        expect(cursors.map((e) => e.name).sort()).toEqual(['Ant Wait.ani', 'Chrono Clock.ani', 'Red Alert Help.ani', 'Red Alert Wait.ani', 'Soviet wait.ani', 'Time wait.ani']);
        for (const e of cursors) {
            const r = await inspect(e.data, { name: e.name, names: [] });
            expect([e.name, r.format.id, r.parsed.warnings, r.checks]).toEqual([e.name, 'ani', [], []]);
            expect(r.parsed.preview?.kind).toBe('video');
        }
        const clock = await inspect(cursors.find((e) => e.name === 'Chrono Clock.ani')!.data, { name: 'Chrono Clock.ani', names: [] });
        expect(clock.parsed.summary).toEqual([
            ['Title', 'Command & Conquer: Red Alert'],
            ['Author', 'Westwood Studios'],
            ['Frames', '46, 32 × 32'],
            ['Plays', '46 steps in 0.77 s, then again'],
        ]);
    });
});
