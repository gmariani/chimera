import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Companion, Field, Parsed } from '../../core/types';
import { gameDir } from '../../testing/game-data';
import { installShieldPkg, installShieldZ } from '../../testing/samples';
import { detect } from '../index';
import { inspect } from '../inspect';
import is3 from './index';
import pkg from './pkg';
import { archiveTables } from './tables';

const parse = (data: Uint8Array, name = 'SETUP.PKG') => pkg.parse(data, { name, names: [] }) as Parsed;
const view = (data: Uint8Array) => new DataView(data.buffer, data.byteOffset, data.byteLength);
/** Where `s` first is in the bytes. */
const find = (data: Uint8Array, s: string) => new TextDecoder('latin1').decode(data).indexOf(s);

/** Two archives: DATA.Z with README.TXT and NOTES.TXT in DOCS and SETUP.EXE in TOOLS, EXTRA.Z with CTL3D.DLL in SYSTEM. */
const sample = () =>
    installShieldPkg([
        {
            name: 'DATA.Z',
            groups: [
                {
                    name: 'DOCS',
                    files: [
                        { name: 'README.TXT', size: 1000 },
                        { name: 'NOTES.TXT', size: 16 },
                    ],
                },
                { name: 'TOOLS', files: [{ name: 'SETUP.EXE', size: 40960 }] },
            ],
        },
        { name: 'EXTRA.Z', groups: [{ name: 'SYSTEM', files: [{ name: 'CTL3D.DLL', size: 20000 }] }] },
    ]);
/** Where EXTRA.Z's block starts: after the header and DATA.Z's. */
const SECOND = 85;

describe('InstallShield 3 package lists', () => {
    it('lists each archive’s files in their groups, and marks every byte', async () => {
        const data = sample();
        expect(detect(data, 'SETUP.PKG').id).toBe('installshield-pkg');
        expect(detect(data, null).id).toBe('installshield-pkg');
        const inspected = await inspect(data, { name: 'SETUP.PKG', names: [] });
        expect(inspected.checks).toEqual([]);
        const r = inspected.parsed;
        expect(r.warnings).toEqual([]);
        expect(r.summary).toEqual([
            ['Archives', 'DATA.Z, EXTRA.Z'],
            ['Files', '4 in 3 groups'],
            ['Size', '61,976 bytes, as the installer counts them'],
        ]);
        expect(r.fields.map((f) => [f.name, f.offset])).toEqual([
            ['Header', 0],
            ['Block: DATA.Z', 10],
            ['Block: EXTRA.Z', SECOND],
            ['Disk 1', view(data).getUint32(2, true)],
        ]);
        // Every byte, once, down to the leaves.
        const leaves = (fs: Field[]): Field[] => fs.flatMap((f) => (f.children?.length ? leaves(f.children) : [f]));
        const marked = leaves(r.fields).sort((a, b) => a.offset - b.offset);
        expect(marked.reduce((at, f) => (f.offset === at ? at + f.length : -1), 0)).toBe(data.length);
        const readme = r.fields[1].children!.find((f) => f.name === 'README.TXT')!;
        expect(readme.children!.find((f) => f.name === 'Group')!.note).toBe('DOCS');
        expect(r.preview?.kind === 'table' && r.preview.rows.map((row) => [row.group, row.cells.file, row.cells.group, row.cells.size])).toEqual([
            ['DATA.Z', 'README.TXT', 'DOCS', '1000'],
            ['DATA.Z', 'NOTES.TXT', 'DOCS', '16'],
            ['DATA.Z', 'SETUP.EXE', 'TOOLS', '40960'],
            ['EXTRA.Z', 'CTL3D.DLL', 'SYSTEM', '20000'],
        ]);
        expect(r.end).toBe(data.length);
    });

    it('says when a file’s group isn’t one of its block’s, or a name has no zero after it', () => {
        const group = sample();
        view(group).setUint16(find(group, 'README.TXT') - 7, 5, true);
        expect(parse(group).warnings).toEqual(["README.TXT is said to be in group 5, but DATA.Z's block has only 2."]);

        const zero = sample();
        zero[find(zero, 'DOCS') + 4] = 0x41;
        expect(parse(zero).warnings).toEqual(['In DATA.Z\'s block, the group "DOCS" isn\'t followed by the zero that ends every other name.']);
    });

    it('says when a block’s length or count disagrees with what’s there', () => {
        const long = sample();
        view(long).setUint32(10, 10000, true);
        expect(parse(long).warnings).toEqual([
            "DATA.Z's block is said to be 10,000 bytes, which runs into the disks' lists.",
            `DATA.Z's block has ${view(long).getUint32(2, true) - SECOND} bytes after its last file.`,
            `EXTRA.Z's files are said to be listed at ${SECOND}, where no block starts.`,
        ]);

        const count = sample();
        view(count).setUint16(find(count, 'README.TXT') - 9, 9, true);
        const r = parse(count);
        expect(r.warnings).toEqual(["DATA.Z's block ends after 3 of its 9 files."]);
        expect(r.fields.reduce((n, f) => n + f.length, 0)).toBe(count.length);
    });

    it('says when the disks’ lists don’t match the blocks', () => {
        const pointer = sample();
        view(pointer).setUint32(pointer.length - 4, 11, true);
        expect(parse(pointer).warnings).toEqual([
            "EXTRA.Z's files are said to be listed at 11, where no block starts.",
            `The block at ${SECOND} isn't any archive's: no archive in the disks' lists points to it.`,
        ]);

        const one = { name: 'DATA.Z', groups: [{ name: 'DOCS', files: [{ name: 'README.TXT', size: 1000 }] }] };
        expect(parse(installShieldPkg([one, { ...one, name: 'data.z' }])).warnings).toEqual(['A file is in the disks’ lists more than once.']);

        const short = sample();
        const listAt = view(short).getUint32(2, true);
        view(short).setUint16(listAt + 4, 3, true);
        expect(parse(short).warnings).toEqual(["Disk 1's list ends after 2 of its 3 entries: entry 3 runs past the end of the file."]);
    });

    it('lists the files copied as they are, disk by disk, and leaves what follows the last disk to the checks after the end', async () => {
        const data = installShieldPkg(
            [{ name: 'DATA.Z', groups: [{ name: 'DOCS', files: [{ name: 'README.TXT', size: 1000 }] }] }],
            [
                { name: 'WELCOME.TXT', size: 806, disk: 1 },
                { name: 'SCAN.EXE', size: 95183, disk: 2 },
            ]
        );
        const r = parse(data);
        expect(r.warnings).toEqual([]);
        expect(r.summary.slice(3)).toEqual([
            ['Copied as they are', 'WELCOME.TXT, SCAN.EXE'],
            ['Disks', '2'],
        ]);
        expect(r.fields.map((f) => f.name)).toEqual(['Header', 'Block: DATA.Z', 'Disk 1', 'Disk 2']);
        expect(r.preview?.kind === 'table' && r.preview.rows.slice(1).map((row) => [row.group, row.cells.file, row.cells.group, row.cells.size])).toEqual([
            ['Copied as they are', 'WELCOME.TXT', 'Disk 1', '806'],
            ['Copied as they are', 'SCAN.EXE', 'Disk 2', '95183'],
        ]);
        expect(r.end).toBe(data.length);

        // Bytes after the last disk that aren't another disk's list: an earlier disk, here.
        const extra = new Uint8Array([...data, 0, 0, 1, 0, 1, 0, 1, 0, 0x41, 2, 0, 1, 0, 0, 0]);
        const inspected = await inspect(extra, { name: 'SETUP.PKG', names: [] });
        expect(inspected.parsed.end).toBe(data.length);
        expect(inspected.checks.map((c) => c.text)).toEqual([expect.stringMatching(/^There are 15 bytes after the end of the installshield 3 package list/)]);

        const kind = installShieldPkg([{ name: 'DATA.Z', groups: [] }], [{ name: 'ODD.BIN', size: 1, disk: 1 }]);
        kind[find(kind, 'ODD.BIN') + 7] = 7;
        expect(parse(kind).warnings).toEqual(["ODD.BIN is of kind 7, which isn't one known: 1 is an archive and 2 a file copied as it is."]);
    });

    it('refuses what isn’t one', () => {
        const magic = sample();
        magic[1] = 0;
        expect(detect(magic, 'SETUP.PKG').id).not.toBe('installshield-pkg');
        expect(() => parse(magic)).toThrow(/^This isn't an InstallShield 3 package list/);

        const list = sample();
        view(list).setUint32(2, list.length, true);
        expect(() => parse(list)).toThrow(/^This isn't an InstallShield 3 package list/);

        const count = sample();
        view(count).setUint16(view(count).getUint32(2, true) + 4, 60000, true);
        expect(() => parse(count)).toThrow(/^Disk 1's entries: the header says 60,000/);
    });
});

describe('InstallShield 3 package lists, against their archives', () => {
    const readme = new TextEncoder().encode('Install the missions, then play them. '.repeat(40));
    const notes = new TextEncoder().encode('Stored as it is.');
    const archive = installShieldZ([
        {
            name: 'DOCS',
            files: [
                { name: 'README.TXT', data: readme },
                { name: 'NOTES.TXT', data: notes, stored: true },
            ],
        },
    ]);
    const packed = archiveTables(archive)!.files.find((f) => f.name === 'README.TXT')!.packed;
    /** A list of DATA.Z: the files given, in the groups given. */
    const list = (files: { name: string; size: number; group?: string }[], name = 'DATA.Z') =>
        installShieldPkg([{ name, groups: [...new Set(files.map((f) => f.group ?? 'DOCS'))].map((g) => ({ name: g, files: files.filter((f) => (f.group ?? 'DOCS') === g) })) }]);
    const opened =
        (files: Record<string, Uint8Array>) =>
        (name: string): Companion[] =>
            files[name.toUpperCase()] ? [{ data: files[name.toUpperCase()], source: `CD › ${name.toUpperCase()}` }] : [];
    const check = (data: Uint8Array, files: Record<string, Uint8Array> = { 'DATA.Z': archive }) => pkg.parse(data, { name: 'SETUP.PKG', names: [], find: opened(files) }) as Parsed;
    const sizes = [
        { name: 'README.TXT', size: readme.length },
        { name: 'NOTES.TXT', size: notes.length },
    ];

    it('finds nothing to say when the list is the archive’s, whether it gives sizes unpacked or packed', () => {
        const r = check(list(sizes));
        expect(r.warnings).toEqual([]);
        expect(r.summary.at(-1)).toEqual(['Checked against', 'CD › DATA.Z: the same files, in the same groups, sizes unpacked']);
        expect(r.links).toEqual([{ name: 'data.z', role: 'Archive it lists', source: 'CD › DATA.Z' }]);
        expect(r.wanted).toBeUndefined();

        const asPacked = check(list([{ name: 'README.TXT', size: packed }, sizes[1]]));
        expect(asPacked.warnings).toEqual([]);
        expect(asPacked.summary.at(-1)![1]).toMatch(/sizes packed$/);
    });

    it('says what the list and the archive disagree on', () => {
        const r = check(
            list([
                { name: 'README.TXT', size: 5 },
                { name: 'NOTES.TXT', size: notes.length, group: 'TOOLS' },
                { name: 'GONE.TXT', size: 1 },
            ])
        );
        expect(r.warnings).toEqual([
            `README.TXT is 5 bytes here, but DATA.Z has it as ${readme.length.toLocaleString('en-US')} bytes unpacked and ${packed.toLocaleString('en-US')} bytes packed.`,
            "GONE.TXT is listed in DATA.Z, which doesn't hold it.",
            'NOTES.TXT is in the group "TOOLS" here, but in DATA.Z it\'s in the directory "DOCS".',
        ]);
        expect(r.summary.at(-1)).toEqual(['Checked against', 'CD › DATA.Z: 3 differences, sizes unpacked']);

        expect(check(list([sizes[0]])).warnings).toEqual(["DATA.Z holds DOCS\\NOTES.TXT, which this list doesn't name."]);

        const tune = Uint8Array.from({ length: 3000 }, (_, i) => (i * i) & 255);
        const two = installShieldZ([
            {
                name: 'DOCS',
                files: [
                    { name: 'README.TXT', data: readme },
                    { name: 'TUNE.BIN', data: tune },
                ],
            },
        ]);
        const tunePacked = archiveTables(two)!.files[1].packed;
        expect(check(list([sizes[0], { name: 'TUNE.BIN', size: tunePacked }]), { 'DATA.Z': two }).warnings).toEqual(['1 of the sizes for DATA.Z are its files unpacked, and 1 are them packed.']);
    });

    it('says only the first ten differences with an archive, and counts the rest', () => {
        const r = check(list([...sizes, ...Array.from({ length: 12 }, (_, i) => ({ name: `EXTRA${i}.TXT`, size: 1 }))]));
        expect(r.warnings).toHaveLength(11);
        expect(r.warnings.at(-1)).toBe('And 2 more differences with DATA.Z.');
    });

    it('finds a set split across disks by its pieces’ names, and says what it couldn’t open or read', () => {
        const split = check(list(sizes, '_SETUP.Z'), { '_SETUP.1': archive });
        expect(split.warnings).toEqual([]);
        expect(split.summary.at(-1)).toEqual(['Checked against', 'CD › _SETUP.1: the same files, in the same groups, sizes unpacked']);

        const none = check(list(sizes), {});
        expect(none.summary.some(([k]) => k === 'Checked against')).toBe(false);
        expect(none.links).toEqual([{ name: 'data.z', role: 'Archive it lists' }]);
        expect(none.wanted).toBe("Open DATA.Z as well (or the folder it's in) to check this list against what it really holds.");

        const junk = check(list(sizes), { 'DATA.Z': new Uint8Array(100) });
        expect(junk.warnings).toEqual(["CD › DATA.Z, opened for DATA.Z, isn't an InstallShield 3 archive whose tables can be read."]);
    });
});

const CS = join(gameDir('cncRemastered') ?? '', 'RED_ALERT/COUNTERSTRIKE');

describe.skipIf(!existsSync(join(CS, 'PLANETWW/SETUP.PKG')))('Counterstrike’s package lists', () => {
    const read = (path: string) => new Uint8Array(readFileSync(join(CS, path)));
    /** Each file in an archive: its size unpacked, and packed. */
    const sizes = (path: string) =>
        new Map(is3.parse(read(path), { name: null, names: [] }).entries!.map((e) => [e.name!.replace(/\.packed$/, ''), [e.data.length, Number(e.meta!.Packed.replace(/\D/g, ''))]]));

    it('read to the last byte, with nothing to say', async () => {
        for (const path of ['PLANETWW/SETUP.PKG', 'SETUP95/SETUP.PKG', 'INTERNET/SETUP.PKG']) {
            const data = read(path);
            expect(detect(data, 'SETUP.PKG').id, path).toBe('installshield-pkg');
            const inspected = await inspect(data, { name: 'SETUP.PKG', names: [] });
            expect(inspected.checks, path).toEqual([]);
            expect(inspected.parsed.warnings, path).toEqual([]);
            expect(inspected.parsed.end, path).toBe(data.length);
        }
    });

    it('give Westwood Chat’s files at their sizes unpacked, and the themes at theirs packed', () => {
        const rows = (path: string) => {
            const r = parse(read(path));
            return r.preview?.kind === 'table' ? r.preview.rows : [];
        };
        const chat = new Map([...sizes('PLANETWW/PLANETWW.Z'), ...sizes('PLANETWW/WIN32S.Z')]);
        const planet = rows('PLANETWW/SETUP.PKG');
        expect(planet).toHaveLength(122);
        expect(planet.filter((r) => r.group === 'planetww.z').map((r) => r.cells.group)).toContain('WCHAT');
        for (const r of planet) expect(Number(r.cells.size), r.cells.file).toBe(chat.get(r.cells.file)![0]);

        const themes = sizes('INSTALL/THEMES.Z');
        const listed = rows('SETUP95/SETUP.PKG');
        expect(listed).toHaveLength(143);
        for (const r of listed) expect(Number(r.cells.size), r.cells.file).toBe(themes.get(r.cells.file)![1]);
    });
    it('match their archives file for file, giving Westwood Chat’s sizes unpacked and the others’ packed', () => {
        /** The files in these folders, by name, as if they'd been opened. */
        const opened =
            (...folders: string[]) =>
            (name: string): Companion[] =>
                folders.flatMap((folder) =>
                    readdirSync(join(CS, folder))
                        .filter((f) => f.toLowerCase() === name.toLowerCase())
                        .map((f) => ({ data: read(`${folder}/${f}`), source: `${folder}/${f}` }))
                );
        const check = (path: string, ...folders: string[]) => pkg.parse(read(path), { name: 'SETUP.PKG', names: [], find: opened(...folders) }) as Parsed;

        const chat = check('PLANETWW/SETUP.PKG', 'PLANETWW');
        expect(chat.warnings).toEqual([]);
        expect(chat.summary.filter(([k]) => k === 'Checked against')).toEqual([
            ['Checked against', 'PLANETWW/PLANETWW.Z: the same files, in the same groups, sizes unpacked'],
            ['Checked against', 'PLANETWW/WIN32S.Z: the same files, in the same groups, sizes unpacked'],
        ]);
        // The themes' list is in SETUP95, their archive in INSTALL.
        const themes = check('SETUP95/SETUP.PKG', 'SETUP95', 'INSTALL');
        expect(themes.warnings).toEqual([]);
        expect(themes.summary.at(-1)).toEqual(['Checked against', 'INSTALL/THEMES.Z: the same files, in the same groups, sizes packed']);
        // It names _SETUP.Z, which is on the disk as _SETUP.1.
        const internet = check('INTERNET/SETUP.PKG', 'INTERNET');
        expect(internet.warnings).toEqual([]);
        expect(internet.summary.at(-1)).toEqual(['Checked against', 'INTERNET/_SETUP.1: the same files, in the same groups, sizes packed']);
    });
});
