import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Parsed } from '../core/types';
import { gameFile } from '../testing/game-data';
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
