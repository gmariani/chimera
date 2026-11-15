import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Parsed } from '../core/types';
import { gameDir, gameFile } from '../testing/game-data';
import { iconLibrary } from '../testing/samples';
import { detect } from './index';
import { inspect } from './inspect';
import ico from './ico';
import ne from './ne';

const parse = (data: Uint8Array, name = 'icons.icl') => ne.parse(data, { name, names: [] }) as Parsed;

describe('16-bit Windows modules (NE)', () => {
    it('reads an icon library, and offers its icon as an .ico file', () => {
        const data = iconLibrary();
        expect(detect(data, 'icons.icl').id).toBe('ne');
        const r = parse(data);
        expect(r.warnings).toEqual([]);
        expect(r.title).toBe('16-bit Windows module with no code (NE), holding icons');
        expect(r.summary).toEqual(
            expect.arrayContaining([
                ['Module', 'CHIMERA'],
                ['For', 'Windows 3.00'],
                ['Resources', '1 icon group, 1 icon'],
            ])
        );
        // The icon is in Contents, as an .ico made from its group (it opens and draws as a file of its own; see ico.test.ts).
        expect(r.preview).toBeUndefined();
        const ico = r.entries!.find((e) => e.name?.endsWith('.ico'))!;
        expect(ico.name).toBe('icons-1.ico');
        // A 6-byte header (type 1, one image), a 16-byte entry (16 × 16, 16 colors), then the image at its true size.
        expect([...ico.data.subarray(0, 8)]).toEqual([0, 0, 1, 0, 1, 0, 16, 16]);
        expect(ico.data.length).toBe(6 + 16 + 40 + 16 * 4 + 128 + 64);
        // Every byte is in a field.
        expect(r.fields.reduce((n, f) => n + f.length, 0)).toBe(data.length);
    });

    it('says what doesn’t fit', () => {
        // A resource said to be past the end of the file.
        const cut = iconLibrary().slice(0, 400);
        expect(parse(cut).warnings.join()).toMatch(/Icon #1 is said to be .* past the end of the file/);
        // Bytes nothing points to (not zeros): in the summary, and in the structure.
        const stray = iconLibrary();
        stray[0xba] = 0x41; // between the names (to 0xB8) and the icon group (at 0xC0)
        const r = parse(stray);
        expect(r.summary).toContainEqual(['Not pointed to', expect.stringMatching(/^8 bytes between the parts/)]);
        expect(r.fields.some((f) => f.name === 'Not pointed to')).toBe(true);
        expect(() => parse(new Uint8Array(200))).toThrow(/isn't a 16-bit Windows module/);
    });

    it('is a program, and dangerous under another name, once it has code', async () => {
        const code = await inspect(iconLibrary({ segments: 1 }), { name: 'picture.ico', names: [] });
        expect(code.format.id).toBe('ne');
        expect(code.checks[0]).toMatchObject({ level: 'danger', text: expect.stringMatching(/^It's named \.ico, but it isn't Icon or cursor \(ICO, CUR\): this is 16-bit Windows module \(NE\)/) });
        // With no code, a warning: it can't run, but it isn't an .ico either.
        const icons = await inspect(iconLibrary(), { name: 'picture.ico', names: [] });
        expect(icons.checks).toEqual([{ level: 'warning', text: expect.stringMatching(/^It's named \.ico, but it's a 16-bit Windows module with no code/) }]);
        // Named as what it is: nothing to say.
        expect((await inspect(iconLibrary(), { name: 'icons.icl', names: [] })).checks).toEqual([]);
    });

    describe('debug info after the module', () => {
        /** Borland's header: "NB02", -1 for the directory, 8 bytes of FF. */
        const header = [0x4e, 0x42, 0x30, 0x32, ...Array<number>(12).fill(0xff)];
        const withTail = (tail: number[]) => {
            const lib = iconLibrary();
            const data = new Uint8Array(lib.length + tail.length);
            data.set(lib);
            data.set(tail, lib.length);
            return { data, at: lib.length };
        };
        const trailer = (back: number) => [0x4e, 0x42, 0x30, 0x32, back & 0xff, (back >> 8) & 0xff, 0, 0];

        it('names the header Borland’s linker leaves when there’s no debug info after it', async () => {
            const { data, at } = withTail(header);
            const inspected = await inspect(data, { name: 'icons.icl', names: [] });
            expect(inspected.checks).toEqual([]);
            const r = inspected.parsed;
            expect(r.warnings).toEqual([]);
            expect(r.summary).toContainEqual(['Debug info', 'None: only the 16-byte header Borland’s linker writes before it, with nothing after']);
            expect(r.fields.at(-1)).toMatchObject({ name: 'Debug info header', offset: at, length: 16 });
            expect(r.end).toBe(data.length);
        });

        it('reads Turbo Debugger’s debug info, between the header and the trailer pointing back to it', async () => {
            const body = [0xfb, 0x52, 0x01, 0x04, 1, 2, 3, 4];
            const { data, at } = withTail([...header, ...body, ...trailer(16 + body.length + 8)]);
            const inspected = await inspect(data, { name: 'icons.icl', names: [] });
            expect(inspected.checks).toEqual([]);
            const r = inspected.parsed;
            expect(r.warnings).toEqual([]);
            expect(r.summary).toContainEqual(['Debug info', 'Turbo Debugger’s (Borland), 32 bytes, after the program']);
            expect(r.fields.slice(-3).map((f) => [f.name, f.offset, f.length])).toEqual([
                ['Debug info header', at, 16],
                ['Debug info', at + 16, 8],
                ['Debug info trailer', at + 24, 8],
            ]);
            expect(r.fields.at(-2)!.children![1]).toMatchObject({ name: 'Version', value: '4.01' });
        });

        it('reads CodeView’s: its own header, then the trailer', () => {
            // "NB05" and its directory's offset, 4 bytes of debug info, then "NB05" and 20 bytes back.
            const nb05 = [0x4e, 0x42, 0x30, 0x35];
            const r = parse(withTail([...nb05, 8, 0, 0, 0, 9, 9, 9, 9, ...nb05, 20, 0, 0, 0]).data);
            expect(r.warnings).toEqual([]);
            expect(r.summary).toContainEqual(['Debug info', 'CodeView (NB05), 20 bytes, after the program']);
        });

        it('says when the trailer is missing, or points somewhere else, and leaves those bytes to the usual checks', async () => {
            const { data: open, at } = withTail([...header, 0xfb, 0x52, 0x01, 0x04]);
            const r = parse(open);
            expect(r.warnings).toEqual([
                `There's a debug-info signature ("NB02") at ${at.toLocaleString('en-US')}, where the program ends, but the file doesn't end with the trailer that goes with it.`,
            ]);
            expect(r.end).toBe(at);
            expect((await inspect(open, { name: 'icons.icl', names: [] })).checks.map((c) => c.text).join()).toMatch(/^There are 20 bytes after the end/);

            const { data: wrong } = withTail([...header, 0xfb, 0x52, 0x01, 0x04, ...trailer(99)]);
            expect(parse(wrong).warnings).toEqual([
                `The debug info's trailer says it starts 99 bytes before the end of the file, at ${(wrong.length - 99).toLocaleString('en-US')}, but its signature is at ${at.toLocaleString('en-US')}.`,
            ]);
        });

        const CNC = gameDir('cncRemastered');
        it.skipIf(!CNC)('TD’s installers have only Borland’s header; Counterstrike’s have Turbo Debugger’s debug info', () => {
            const td = parse(new Uint8Array(readFileSync(join(CNC!, 'TIBERIAN_DAWN/CD1/INSTALL.EXE'))), 'INSTALL.EXE');
            expect(td.warnings).toEqual([]);
            expect(td.summary).toContainEqual(['Debug info', expect.stringMatching(/^None: only the 16-byte header/)]);
            expect(td.fields.at(-1)).toMatchObject({ name: 'Debug info header', offset: 90112 });
            const cs = parse(new Uint8Array(readFileSync(join(CNC!, 'RED_ALERT/COUNTERSTRIKE/SETUP/SETUP.EXE'))), 'SETUP.EXE');
            expect(cs.warnings).toEqual([]);
            expect(cs.summary).toContainEqual(['Debug info', 'Turbo Debugger’s (Borland), 12,269 bytes, after the program']);
            expect(cs.fields.find((f) => f.name === 'Debug info header')?.offset).toBe(125952);
            expect(cs.end).toBe(138221);
        });
    });

    // Dune II's, from wherever it's installed (npm run test:setup).
    const ICO = gameFile('dune2', 'DUNE2.ICO') ?? '';
    it.skipIf(!ICO)('offers Dune II’s two icons from DUNE2.ICO as .ico files', () => {
        const r = parse(new Uint8Array(readFileSync(ICO)), 'DUNE2.ICO');
        expect(r.warnings).toEqual([]);
        // Its icon editor left the names table pointing into an icon, and a stale entry behind the resource table.
        expect(r.summary).toEqual(
            expect.arrayContaining([
                ['Module', 'No names: the table of them is said to be inside the module’s data'],
                ['Not pointed to', expect.stringMatching(/^27 bytes/)],
            ])
        );
        const icos = r.entries!.filter((e) => e.name?.endsWith('.ico'));
        expect(icos.map((e) => e.name)).toEqual(['DUNE2-1.ico', 'DUNE2-2.ico']);
        // Each the 32 × 32 picture at its true size (744 bytes; the module rounds it up to 752).
        for (const e of icos) {
            const x = ico.parse(e.data, { name: e.name, names: [] });
            expect(x.warnings).toEqual([]);
            expect(x.summary).toContainEqual(['Sizes', '32 × 32']);
        }
    });
});
