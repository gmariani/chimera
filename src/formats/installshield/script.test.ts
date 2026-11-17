import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Field, Parsed } from '../../core/types';
import { gameDir } from '../../testing/game-data';
import { installShieldScript } from '../../testing/samples';
import { detect } from '../index';
import { inspect } from '../inspect';
import is3 from './index';
import script from './script';

const parse = (data: Uint8Array) => script.parse(data, { name: 'SETUP.INS', names: [] }) as Parsed;
const view = (data: Uint8Array) => new DataView(data.buffer, data.byteOffset, data.byteLength);
const find = (data: Uint8Array, s: string) => new TextDecoder('latin1').decode(data).indexOf(s);
/** Every byte marked once, down to the leaves: where the marks stop being contiguous, or the end. */
function covered(fields: Field[]): number {
    const leaves = (fs: Field[]): Field[] => fs.flatMap((f) => (f.children?.length ? leaves(f.children) : [f]));
    return leaves(fields)
        .sort((a, b) => a.offset - b.offset)
        .reduce((at, f) => (at === f.offset ? at + f.length : at), 0);
}
/** Puts the checksum right again, after a change. */
const resum = (data: Uint8Array) => (
    view(data).setUint32(
        8,
        data.subarray(12).reduce((n, v) => n + v, 0),
        true
    ),
    data
);

describe('InstallShield scripts', () => {
    it('reads the tables, lists what it calls in DLLs, leaves the code whole, and marks every byte', async () => {
        const data = installShieldScript();
        expect(detect(data, 'SETUP.INS').id).toBe('installshield-ins');
        expect(detect(data, null).id).toBe('installshield-ins');
        const inspected = await inspect(data, { name: 'SETUP.INS', names: [] });
        expect(inspected.checks).toEqual([]);
        const r = inspected.parsed;
        expect(r.warnings).toEqual([]);
        expect(r.summary).toEqual([
            ['Version', 'InstallShield 3.00.065, compiled with 3.00.076'],
            ['Functions', '1 its own, 1 in DLLs (USER)'],
            ['Variables', "3 the system's; 2 strings and 3 numbers its own"],
            ['Code', '4 bytes'],
        ]);
        expect(r.preview?.kind === 'table' && r.preview.rows.map((row) => [row.group, row.cells.name, row.cells.kind, row.cells.details])).toEqual([
            ['System variables', 'SRCDIR', 'string', 'size 512'],
            ['System variables', 'TARGETDIR', 'string', 'size 512'],
            ['System variables', 'LAST_RESULT', 'number', ''],
            ['Structures', 'RECT', 'structure', 'number left'],
            ['The script’s functions', 'Function 1', 'own', 'parameters: number'],
            ['Imported from DLLs', 'USER.ShowWindow', 'returns bool', 'parameters: hwnd'],
        ]);
        expect(r.fields.map((f) => f.name)).toEqual(['Header', 'Labels', 'String variables', 'Number variables', 'Structures', 'Functions', 'Not known', 'Code', 'Compiler', 'Compiler length']);
        const sizes = r.fields[2].children!.find((f) => f.name === 'Sizes')!.children!;
        expect(sizes.map((f) => [f.name, f.value])).toEqual([
            ['SRCDIR', '512'],
            ['TARGETDIR', '512'],
            ["String 3 (the script's own)", 'none given'],
            ["String 4 (the script's own)", '200'],
        ]);
        expect(r.fields[0].children!.find((f) => f.name === 'Checksum')!.note).toBe('The sum of every byte after it: it matches.');
        expect(covered(r.fields)).toBe(data.length);
    });

    it('says when the checksum doesn’t match, or the version isn’t the one checked', () => {
        const changed = installShieldScript();
        changed[changed.length - 12] ^= 1;
        expect(parse(changed).warnings).toEqual([
            expect.stringMatching(/^The checksum is [\d,]+, but the bytes after it add up to [\d,]+: the script has been changed, or damaged, since it was compiled\.$/),
        ]);

        const five = installShieldScript();
        view(five).setUint32(4, 0x1234001c, true);
        expect(parse(resum(five)).warnings).toEqual(["This script says it's for InstallShield 2.20.905. Only 3.00.065's and 5.00.000's have been checked here, so it may be read wrongly."]);
        const unknown = installShieldScript();
        view(unknown).setUint32(4, 0x99, true);
        expect(parse(resum(unknown)).warnings[0]).toBe(
            "This script says it's for InstallShield 0x99, a version isDcc doesn't know. Only 3.00.065's and 5.00.000's have been checked here, so it may be read wrongly."
        );
    });

    it('says when the tables disagree with themselves', () => {
        const numbered = installShieldScript();
        view(numbered).setUint16(find(numbered, 'TARGETDIR') - 4, 7, true);
        expect(parse(resum(numbered)).warnings).toEqual(["The system string variable TARGETDIR is numbered 7, but it's number 1 in the list."]);

        const type = installShieldScript({ functions: [{ params: [[9, 0]] }] });
        expect(parse(type).warnings).toEqual(["Some types aren't ones isDcc knows: 9."]);

        // Three system string variables, but a size for only two: one size taken out, and the count lowered to match.
        const three = installShieldScript({ strings: ['A', 'B', 'C'], own: [] });
        const count = find(three, '\r\n\r\n') + 6;
        const many = Uint8Array.from([...three.subarray(0, count + 4), ...three.subarray(count + 6)]);
        view(many).setUint16(count, 2, true);
        expect(parse(resum(many)).warnings).toEqual(['There are 3 system string variables, but words for only 2 string variables in all.']);
    });

    it('stops at what it can’t read, and marks the rest', () => {
        const kind = installShieldScript();
        // Its kind, return type and the DLL's name length come before the name.
        const at = find(kind, 'USER') - 6;
        view(kind).setUint16(at, 9, true);
        const r = parse(resum(kind));
        expect(r.warnings).toEqual(["Function 2 of 2 is of kind 9, which isn't one known (1 is a DLL's, 2 the script's own): the functions can't be read past it."]);
        expect(r.fields.find((f) => f.name === 'Not read')!.note).toBe("From the functions on, which couldn't be read.");
        expect(covered(r.fields)).toBe(kind.length);

        // Cut inside the functions: the compiler's version is gone too.
        const cut = installShieldScript().subarray(0, find(installShieldScript(), 'ShowWindow'));
        const c = parse(resum(Uint8Array.from(cut)));
        expect(c.warnings).toEqual([
            "The file doesn't end with the version of the compiler that made it, as InstallShield's scripts do: it may be cut short, or have something after it.",
            "The file ends inside the functions: the rest isn't read.",
        ]);
        expect(covered(c.fields)).toBe(cut.length);
    });

    it('refuses what isn’t one, or is cut short in its header', () => {
        const magic = installShieldScript();
        magic[1] = 0;
        expect(detect(magic, 'SETUP.INS').id).not.toBe('installshield-ins');
        expect(() => parse(magic)).toThrow(/^This isn't an InstallShield script/);
        expect(() => parse(installShieldScript().subarray(0, 30))).toThrow('This InstallShield script is cut short: it ends inside its header.');
    });
});

const CS = join(gameDir('cncRemastered') ?? '', 'RED_ALERT/COUNTERSTRIKE');

describe.skipIf(!existsSync(join(CS, 'SETUP95/SETUP.INS')))('Counterstrike’s InstallShield scripts', () => {
    const read = (path: string) => new Uint8Array(readFileSync(join(CS, path)));

    it('read all three, the one packed in INTERNET’s SETUP.INS too, to the last byte with nothing to say', async () => {
        const packed = is3.parse(read('INTERNET/SETUP.INS'), { name: 'SETUP.INS', names: [] }).entries![0];
        for (const [path, data] of [
            ['SETUP95/SETUP.INS', read('SETUP95/SETUP.INS')],
            ['PLANETWW/SETUP.INS', read('PLANETWW/SETUP.INS')],
            ['INTERNET/SETUP.INS › SETUP.INS', packed.data],
        ] as const) {
            expect(detect(data, 'SETUP.INS').id, path).toBe('installshield-ins');
            const inspected = await inspect(data, { name: 'SETUP.INS', names: [] });
            expect(inspected.checks, path).toEqual([]);
            expect(inspected.parsed.warnings, path).toEqual([]);
            expect(covered(inspected.parsed.fields), path).toBe(data.length);
        }
    });

    it('show the Windows 95 installer calling Westwood’s MYDLL and DirectX’s setup', () => {
        const r = parse(read('SETUP95/SETUP.INS'));
        expect(r.summary[0]).toEqual(['Version', 'InstallShield 3.00.065, compiled with 3.00.076']);
        const imports = r.preview?.kind === 'table' ? r.preview.rows.filter((row) => row.group === 'Imported from DLLs').map((row) => row.cells.name) : [];
        expect(imports).toHaveLength(51);
        expect(imports).toEqual(expect.arrayContaining(['MYDLL.Write_Value', 'MYDLL.Read_Value', 'DSETUP.DirectXSetup', 'KERNEL.LoadLibrary']));
    });
});
