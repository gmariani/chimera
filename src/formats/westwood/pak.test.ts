import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detect } from '../index';
import { inspect } from '../inspect';
import pak from './pak';
import { pakLayout } from './pak-layout';
import { gameDir } from '../../testing/game-data';

const enc = new TextEncoder();
const u32 = (v: number) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];

/** A PAK of these files, as each version writes it. `end` overrides the end offset (versions 1 and 3). */
function build(version: 1 | 2 | 3, files: [string, Uint8Array][], { end, after = [] }: { end?: number; after?: number[] } = {}): Uint8Array {
    const names = files.map(([name]) => [...enc.encode(name), 0]);
    const marker = version === 2 ? 0 : 5; // version 1 and 3's end entry: an offset and an empty name
    const terminator = version === 1 ? 0 : 4;
    const headerSize = names.reduce((n, name) => n + 4 + name.length, 0) + marker + terminator;
    const header: number[] = [];
    let at = headerSize;
    for (const [i, [, data]] of files.entries()) {
        header.push(...u32(at), ...names[i]);
        at += data.length;
    }
    if (version !== 2) header.push(...u32(end ?? at), 0);
    if (version !== 1) header.push(...u32(0));
    return Uint8Array.from([...header, ...files.flatMap(([, data]) => [...data]), ...after]);
}

const files: [string, Uint8Array][] = [
    ['TEXT.ENG', enc.encode('hello\0')],
    ['DUNE.PAL', new Uint8Array(768).fill(7)],
    ['EMPTY.BIN', new Uint8Array(0)],
    ['LAST.DAT', enc.encode('the end')],
];
const parse = (data: Uint8Array) => pak.parse(data, { name: 'test.pak', names: [] });

describe('Westwood PAK', () => {
    it.each([1, 2, 3] as const)('reads version %i', (version) => {
        const data = build(version, files);
        expect(detect(data, 'x.pak').id).toBe('pak');
        const r = parse(data);
        expect(r.title).toBe(`Westwood PAK archive (version ${version})`);
        expect(r.entries!.map((e) => [e.name, e.size])).toEqual(files.map(([name, d]) => [name, d.length]));
        for (const [i, [, d]] of files.entries()) expect(r.entries![i].data).toEqual(d);
        expect(r.warnings).toEqual(['1 file is empty (0 bytes).']);
        // Every byte is in a field: the header, then the files.
        expect(r.fields[0].length + r.fields[1].length).toBe(data.length);
    });

    it("takes the archive's end when version 1's end offset is garbage, and says so", () => {
        const r = parse(build(1, files, { end: 0x7fffffff }));
        expect(r.entries!.at(-1)!.data).toEqual(enc.encode('the end'));
        expect(r.warnings.join()).toMatch(/end offset \(2,147,483,647\) can't be where the last file ends/);
    });

    it('flags data hidden after the last file of a version 3 archive', async () => {
        const data = build(3, files, { after: [...enc.encode('MZ hidden payload')] });
        const r = await inspect(data, { name: 'x.pak', names: [] });
        expect(r.format.id).toBe('pak');
        expect(r.checks[0].level).toBe('danger');
        expect(r.checks[0].text).toMatch(/17 bytes after the end of the westwood pak archive/);
    });

    it("isn't fooled by other files", async () => {
        // Chrome's resource pack (.pak too): a version number, an encoding, counts, then a table.
        const chrome = Uint8Array.from([5, 0, 0, 0, 1, 0, 3, 0, 0, 0, ...new Array(40).fill(9)]);
        expect(pakLayout(chrome)).toBeNull();
        // Named .pak but not Westwood's: not a claim, so not called out.
        expect((await inspect(chrome, { name: 'resources.pak', names: [] })).checks.filter((c) => c.level === 'danger')).toEqual([]);

        const good = build(2, files);
        // A name that isn't a DOS name.
        const badName = good.slice();
        badName[4] = 0x01;
        expect(pakLayout(badName)).toBeNull();
        // Offsets out of order.
        const swapped = good.slice();
        swapped.set(u32(good.length), 4 + 9);
        expect(pakLayout(swapped)).toBeNull();
        // The first file not starting where the header ends.
        const gap = good.slice();
        gap.set(u32(new DataView(good.buffer).getUint32(0, true) + 1), 0);
        expect(pakLayout(gap)).toBeNull();
        expect(pakLayout(enc.encode('Just some text that happens to be here.'))).toBeNull();

        // A second, different file under a name already listed: the game never sees it.
        const twice = parse(
            build(2, [
                ['A.TXT', enc.encode('one')],
                ['A.TXT', enc.encode('two')],
            ])
        );
        expect(twice.warnings).toEqual([expect.stringMatching(/A\.TXT is listed 2 times .* The copies differ/)]);
        expect(() => parse(new Uint8Array(20))).toThrow(/isn't a Westwood PAK/);
    });
});

// Dune II's own files, from wherever it's installed (npm run test:setup); they aren't ours to commit.
const DUNE = gameDir('dune2') ?? '';
describe.skipIf(!DUNE)('Dune II PAKs', () => {
    it('reads every one, and every file in them', () => {
        let count = 0;
        for (const name of readdirSync(DUNE).filter((n) => /\.pak$/i.test(n))) {
            const data = new Uint8Array(readFileSync(join(DUNE, name)));
            expect(detect(data, name).id, name).toBe('pak');
            const r = parse(data);
            expect(r.title, name).toBe('Westwood PAK archive (version 2)');
            // The houses' archives list their attack voice twice, as shipped: identical copies.
            const twice = { 'ATRE.PAK': 'AATTACK.VOC', 'HARK.PAK': 'HATTACK.VOC', 'ORDOS.PAK': 'OATTACK.VOC' }[name];
            expect(r.warnings, name).toEqual(twice ? [expect.stringMatching(new RegExp(`^${twice} is listed 2 times .* The copies are identical\\.$`))] : []);
            expect(r.entries!.reduce((n, e) => n + e.size, 0) + r.fields[0].length, name).toBe(data.length);
            count += r.entries!.length;
        }
        expect(count).toBe(559);
    });

    it('opens the Dune II sprites inside as Dune II sprites', () => {
        const data = new Uint8Array(readFileSync(join(DUNE, 'DUNE.PAK')));
        const sprites = parse(data).entries!.filter((e) => /\.shp$/i.test(e.label));
        expect(sprites.length).toBe(13);
        for (const e of sprites) expect(detect(e.data, e.name).id, e.label).toBe('shp-d2');
    });

    // 1.07's ENGLISH.PAK, when a copy sits beside the installed game: the sprites and pictures with English on them are
    // named .ENG, as its text is, and that's no cause for alarm.
    const ENGLISH_107 = join(DUNE, '..', 'dune II 1.07', 'ENGLISH.PAK');
    it.skipIf(!existsSync(ENGLISH_107))('opens 1.07’s sprites and pictures named for the language as what they are', async () => {
        const named = parse(new Uint8Array(readFileSync(ENGLISH_107))).entries!.filter((e) => /^(CHOAM|BTTN|MENTAT|AND|HERALD)\.ENG$/.test(e.label));
        const read: Record<string, string> = {};
        for (const e of named) {
            const r = await inspect(e.data, { name: e.name, names: [] });
            expect(
                r.checks.filter((c) => c.level !== 'info'),
                e.label
            ).toEqual([]);
            read[e.label] = r.format.id;
        }
        expect(read).toEqual({ 'CHOAM.ENG': 'shp-d2', 'BTTN.ENG': 'shp-d2', 'MENTAT.ENG': 'shp-d2', 'AND.ENG': 'cps', 'HERALD.ENG': 'cps' });
    });
});
