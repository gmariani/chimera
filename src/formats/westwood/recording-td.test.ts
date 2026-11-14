import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gameDir } from '../../testing/game-data';
import { tdRecording } from '../../testing/samples';
import { detect } from '../index';
import { parseMix } from '../mix/index';
import recording from './recording-td';

const context = { name: 'record.bin', names: [] };
const rows = (data: Uint8Array) => {
    const preview = recording.parse(data, context).preview;
    if (preview?.kind !== 'table') throw new Error('expected a table');
    return preview.rows.map((r) => `${r.cells.frame} ${r.cells.event}: ${r.cells.details}`);
};
/** Where frame 4 starts in the sample: the header, frame 0 (12 bytes), then frames 1 to 3. */
const FRAME_4 = 101 + 12 + (12 + 4 + 13) + (12 + 2 + 4 + 13) + (12 + 2 + 4);

describe('TD recorded games', () => {
    it("reads each frame's view, selection and events", () => {
        const data = tdRecording();
        expect(detect(data, 'record.bin').id).toBe('recording-td');
        const parsed = recording.parse(data, context);
        expect(parsed.warnings).toEqual([]);
        expect(parsed.summary).toEqual([
            ['Player', 'CHIMERA'],
            ['Frames', '5'],
            ['Events', '3: Build 1, Order 1, Place 1'],
            ['Frames with a selection', '3'],
        ]);
        expect(rows(data)).toEqual(['1 Build: Power Plant (NUKE)', '2 Order: Infantry 4: move to cell (25, 33)', '4 Place: A building at (22, 32)']);
        // Frame 3 changes nothing, so it's listed with the frames like it.
        expect(parsed.fields.map((f) => f.name)).toEqual(['Header', 'Frame 0', 'Frame 1', 'Frame 2', 'Frame 3', 'Frame 4']);
        expect(parsed.fields[5].children![0].value).toBe('(21, 31)');
    });

    it('says where a frame stops adding up, and reads the frames before it', () => {
        const data = tdRecording();
        data[FRAME_4 + 8]++; // The selection check no longer matches the selection.
        expect(detect(data, 'record.bin').id).not.toBe('recording-td');
        const parsed = recording.parse(data, context);
        expect(parsed.warnings).toEqual([
            `Frame 4 (at byte ${FRAME_4}) has 1 selected objects that add up to 12292, not the 12293 stored with them. The recording stops being readable there; the rest isn't read.`,
        ]);
        expect(parsed.end).toBe(FRAME_4);
    });

    it("refuses a file whose first frame doesn't fit", () => {
        const data = tdRecording();
        data.fill(0xff, 101 + 4, 101 + 8); // Frame 0 says -1 objects are selected.
        expect(() => recording.parse(data, context)).toThrow(/^Not a TD recording: Frame 0 \(at byte 101\) says -1 objects are selected/);
    });

    it('says when nothing was done', () => {
        // The header and three frames with no events: it fits, but isn't taken for a recording by its bytes alone.
        const data = new Uint8Array(101 + 12 + 16 + 16);
        expect(detect(data, 'record.bin').id).not.toBe('recording-td');
        expect(recording.parse(data, context).warnings).toEqual(['No frame has an event: nothing was done while it was recorded.']);
    });
});

const transit = join(gameDir('cncRemastered') ?? '', 'TIBERIAN_DAWN/CD1/TRANSIT.MIX');

describe.skipIf(!existsSync(transit))("TD's attract-mode demo (RECORD.BIN in TRANSIT.MIX)", () => {
    it('reads every frame to the end of the file', () => {
        const entry = parseMix(new Uint8Array(readFileSync(transit)), { name: 'TRANSIT.MIX', names: [] }).entries!.find((e) => e.name === 'record.bin')!;
        const parsed = recording.parse(entry.data, context);
        // Every frame's selection adds up to its check, and every event is for its own frame: nothing left over.
        expect(parsed.warnings).toEqual([]);
        expect(parsed.end).toBe(entry.data.length);
        expect(parsed.summary.slice(0, 2)).toEqual([
            ['Player', 'bill'],
            ['Frames', '30,293'],
        ]);
        expect(rows(entry.data).slice(0, 4)).toEqual([
            '108 Flash: Animation 71 at (29, 41), for Multiplayer 3',
            '108 Order: Infantry 11: move to cell (29, 41)',
            '191 Order: Unit 18: unload',
            '258 Build: Power Plant (NUKE)',
        ]);
    });
});
