import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gameDir } from '../testing/game-data';
import { sosLibrary } from '../testing/samples';
import { detect } from './index';
import sos from './sos';

const context = { name: 'hmidrv.386', names: [] };
const rows = (data: Uint8Array) => {
    const p = sos.parse(data, context).preview;
    if (p?.kind !== 'table') throw new Error('expected a table');
    return p.rows.map((r) => Object.values(r.cells).join(', '));
};
/** Where the sample's second driver's header starts: the file header, then the first driver (48 bytes and its code). */
const second = (data: Uint8Array) => 44 + 48 + new DataView(data.buffer).getUint32(44 + 36, true);

describe('HMI SOS driver libraries', () => {
    it("reads each driver: its device, from its own text and SOS.H's IDs, and its DOS extender", () => {
        const data = sosLibrary();
        expect(detect(data, 'hmidrv.386').id).toBe('sos');
        const parsed = sos.parse(data, context);
        expect(parsed.warnings).toEqual([]);
        expect(parsed.entries!.map((e) => e.name)).toEqual(['sbdrv.com', 'sbdrvw.com']);
        expect(rows(data)).toEqual(['sbdrv.com, Sound Blaster 8 Mono, 0xe000, 64', 'sbdrvw.com, Sound Blaster 8 Mono, 0xe000, 64']);
        expect(parsed.summary).toContainEqual(['For', "FlashTek's X-32; Rational's DOS/4GW"]);
        expect(parsed.end).toBe(data.length);
    });

    it("says when the size field isn't the file's size cut to 16 bits", () => {
        const data = sosLibrary();
        data[40] ^= 1;
        expect(sos.parse(data, context).warnings).toEqual([
            `The header's size, cut to 16 bits as the games' libraries have it, is ${(data.length & 0xffff) ^ 1}; the file's is ${data.length & 0xffff} (${data.length} in full).`,
        ]);
    });

    it("says when a driver's next-driver field isn't its size plus 92", () => {
        const data = sosLibrary();
        data[second(data) + 32] ^= 1;
        expect(sos.parse(data, context).warnings).toEqual([
            expect.stringMatching(/^1 driver's next-driver field isn't its size plus 92, as in every library the games ship \(the first: sbdrvw\.com, /),
        ]);
    });

    it('refuses a library whose drivers run past its end', () => {
        const data = sosLibrary().subarray(0, 100);
        expect(detect(data, 'hmidrv.386').id).not.toBe('sos');
        expect(() => sos.parse(data, context)).toThrow(/^Not an SOS driver library: Driver 1, sbdrv\.com, says it's 64 bytes, more than the rest of the file\./);
    });
});

const cd1 = join(gameDir('cncRemastered') ?? '', 'TIBERIAN_DAWN/CD1');

describe.skipIf(!existsSync(join(cd1, 'HMIDRV.386')))("TD's HMI drivers", () => {
    it.each([
        ['HMIDRV.386', 96, 'gus8m.com, Gravis UltraSound 8 Mono, 0xe023, 6,024'],
        ['HMIDET.386', 77, 'gmax16sd.com, Gravis UltraSound MAX, 0xe02a, 1,380'],
    ])('%s: every driver, back to back to the end of the file', (name, count, first) => {
        const data = new Uint8Array(readFileSync(join(cd1, name)));
        const parsed = sos.parse(data, { name, names: [] });
        expect(parsed.warnings).toEqual([]);
        expect(parsed.entries).toHaveLength(count);
        expect(parsed.end).toBe(data.length);
        expect(rows(data)[0]).toBe(first);
    });
});
