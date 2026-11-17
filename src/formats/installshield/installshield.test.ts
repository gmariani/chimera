import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Parsed } from '../../core/types';
import { gameDir } from '../../testing/game-data';
import { installShieldZ } from '../../testing/samples';
import { detect } from '../index';
import { inspect } from '../inspect';
import is3 from './index';

const parse = (data: Uint8Array, name = 'archive.z') => is3.parse(data, { name, names: [] }) as Parsed;
const text = (s: string) => new TextEncoder().encode(s);

const readme = text('Red Alert: Counterstrike. Install the missions, then play them. '.repeat(30));
const notes = text('Stored as it is.');
const tune = Uint8Array.from({ length: 2000 }, (_, i) => (i * i) & 255);
/** Two directories: README.TXT imploded and NOTES.TXT stored in DOCS, TUNE.BIN imploded in the top one (no name). */
const sample = () =>
    installShieldZ([
        {
            name: 'DOCS',
            files: [
                { name: 'README.TXT', data: readme },
                { name: 'NOTES.TXT', data: notes, stored: true },
            ],
        },
        { name: '', files: [{ name: 'TUNE.BIN', data: tune }] },
    ]);

const view = (data: Uint8Array) => new DataView(data.buffer, data.byteOffset, data.byteLength);
/** Where file `i`'s entry starts in the file table. */
function fileEntry(data: Uint8Array, i: number): number {
    const v = view(data);
    let at = v.getUint32(51, true);
    for (let k = 0; k < i; k++) at += v.getUint16(at + 23, true);
    return at;
}

describe('InstallShield 3 archives', () => {
    it('unpacks each file, under its directory, and marks every byte', async () => {
        const data = sample();
        expect(detect(data, 'archive.z').id).toBe('installshield-z');
        expect(detect(data, null).id).toBe('installshield-z');
        const inspected = await inspect(data, { name: 'archive.z', names: [] });
        expect(inspected.checks).toEqual([]);
        const r = inspected.parsed;
        expect(r.warnings).toEqual([]);
        expect(r.entries!.map((e) => [e.name, e.meta!.Folder])).toEqual([
            ['README.TXT', 'DOCS'],
            ['NOTES.TXT', 'DOCS'],
            ['TUNE.BIN', ''],
        ]);
        expect(r.entries![0].data).toEqual(readme);
        expect(r.entries![1].data).toEqual(notes);
        expect(r.entries![2].data).toEqual(tune);
        expect(r.summary).toEqual([
            ['Files', '3 in DOCS'],
            ['Size', `${(readme.length + notes.length + tune.length).toLocaleString('en-US')} bytes unpacked, ${data.length.toLocaleString('en-US')} bytes packed`],
            ['Made', '1997-02-25 11:51:24'],
        ]);
        expect(r.fields.reduce((n, f) => n + f.length, 0)).toBe(data.length);
        expect(r.fields.map((f) => f.name)).toEqual(['Header', 'Padding', 'File data', 'Directory table', 'File table']);
        const notesEntry = r.fields.find((f) => f.name === 'File table')!.children![1];
        expect(notesEntry.name).toBe('DOCS\\NOTES.TXT');
        expect(notesEntry.children!.find((f) => f.name === 'Flags')!.note).toBe('Stored as it is (0x10), not packed.');
        expect(notesEntry.children!.find((f) => f.name === 'Attributes')!.value).toBe('archive');
        expect(r.end).toBe(data.length);
    });

    it('says when the header disagrees with the tables', () => {
        const size = sample();
        view(size).setUint32(18, 1000, true);
        expect(parse(size).warnings).toEqual([`The header says the archive is 1,000 bytes, but it's ${size.length.toLocaleString('en-US')} bytes.`]);

        const total = sample();
        view(total).setUint32(22, 99, true);
        expect(parse(total).warnings).toEqual([
            `The header says the files come to 99 bytes unpacked, but their entries add up to ${(readme.length + notes.length + tune.length).toLocaleString('en-US')} bytes.`,
        ]);

        const start = sample();
        view(start).setUint32(33, 300, true);
        expect(parse(start).warnings).toEqual(["The header says the files' data starts at 300, but the first file is at 255."]);

        // The header says 2 files: the directories list 3, and only 2 are read.
        const count = sample();
        view(count).setUint16(12, 2, true);
        expect(parse(count).warnings).toEqual(expect.arrayContaining(['The directories list 3 files between them, but the header says there are 2.']));
    });

    it('says when a file’s directory doesn’t fit', () => {
        const wrong = sample();
        view(wrong).setUint16(fileEntry(wrong, 2) + 1, 0, true);
        expect(parse(wrong).warnings).toEqual(['TUNE.BIN is listed with directory 1 (""), but says it\'s in directory 0.']);
        const none = sample();
        view(none).setUint16(fileEntry(none, 2) + 1, 7, true);
        expect(parse(none).warnings).toEqual(['TUNE.BIN is said to be in directory 7, but there are only 2.']);
    });

    it('says when a file doesn’t unpack as its entry says, and offers it packed when it can’t', () => {
        const size = sample();
        view(size).setUint32(fileEntry(size, 2) + 3, 1999, true);
        expect(parse(size).warnings).toContain('TUNE.BIN unpacks to 2,000 bytes, but its entry says 1,999 bytes.');

        const broken = sample();
        const at = view(broken).getUint32(fileEntry(broken, 0) + 11, true);
        broken[at] = 7;
        const r = parse(broken);
        expect(r.warnings).toContain("DOCS\\README.TXT can't be unpacked: The compressed data's first byte says how literals are stored: 0 or 1, not 7. It's offered packed, as it is here.");
        expect(r.entries![0]).toMatchObject({ name: 'README.TXT.packed', label: 'README.TXT (packed)', meta: { Note: 'Not unpacked' } });

        const stored = sample();
        view(stored).setUint32(fileEntry(stored, 1) + 3, 20, true);
        expect(parse(stored).warnings).toContain('DOCS\\NOTES.TXT is stored as it is, but its sizes differ: 16 bytes here, 20 bytes unpacked.');

        const split = sample();
        split[fileEntry(split, 2) + 26] = 1;
        expect(parse(split).warnings).toContain("TUNE.BIN carries on into the next disk's archive, which isn't read with this one: it's offered packed, as it is here.");
    });

    it('says when data overlaps, leaves bytes nothing points to, or names a file outside its folder', () => {
        const overlap = sample();
        const second = view(overlap).getUint32(fileEntry(overlap, 1) + 11, true);
        view(overlap).setUint32(fileEntry(overlap, 1) + 11, second - 4, true);
        expect(parse(overlap).warnings).toEqual(expect.arrayContaining(["DOCS\\NOTES.TXT's data overlaps the file before it."]));

        // The header's padding, not zeros.
        const stray = sample();
        stray[100] = 1;
        const r = parse(stray);
        expect(r.warnings).toEqual(["196 bytes between the files aren't part of any of them."]);
        expect(r.fields.find((f) => f.name === 'Not pointed to')).toMatchObject({ offset: 59, length: 196 });

        const climb = sample();
        const e = fileEntry(climb, 2);
        climb.set(text('..\\X.BIN'), e + 30);
        expect(parse(climb).warnings).toEqual(['File 3\'s name, "..\\X.BIN", isn’t a plain file name: saved as it says, it could land outside the folder it’s saved to.']);
    });

    it('refuses what isn’t one, or can’t be', () => {
        expect(detect(text('Not an archive at all, only text.'), null).id).not.toBe('installshield-z');
        expect(() => parse(text('Not an archive at all, only text.'))).toThrow(/^This isn't an InstallShield 3 archive/);
        expect(() => parse(sample().subarray(0, 40))).toThrow("This InstallShield 3 archive is cut short: it's 40 bytes, too short for its 59-byte header.");
        const tables = sample();
        view(tables).setUint32(41, tables.length, true);
        expect(() => parse(tables)).toThrow(
            `The directory table is said to be at ${tables.length.toLocaleString('en-US')}, 26 bytes long, which isn't inside the archive (${tables.length.toLocaleString('en-US')} bytes).`
        );
        const count = sample();
        view(count).setUint16(12, 60000, true);
        expect(() => parse(count)).toThrow(/^Files: the header says 60,000/);
    });
});

const CS = join(gameDir('cncRemastered') ?? '', 'RED_ALERT/COUNTERSTRIKE');
const ARCHIVES = [
    'INSTALL/THEMES.Z',
    'PLANETWW/PLANETWW.Z',
    'PLANETWW/WIN32S.Z',
    'PLANETWW/_SETUP.LIB',
    'PLANETWW/_SETUP32.LIB',
    'SETUP95/_SETUP.LIB',
    'INTERNET/_SETUP.LIB',
    'INTERNET/_SETUP.1',
    'INTERNET/SETUP.INS',
];

describe.skipIf(!existsSync(join(CS, 'INSTALL/THEMES.Z')))('Counterstrike’s InstallShield archives', () => {
    const read = (path: string) => parse(new Uint8Array(readFileSync(join(CS, path))), path.split('/')[1]);

    it('unpacks every file in all nine, each to the size its entry says', () => {
        for (const path of ARCHIVES) {
            const data = new Uint8Array(readFileSync(join(CS, path)));
            expect(detect(data, path.split('/')[1]).id, path).toBe('installshield-z');
            const r = read(path);
            // INTERNET's SETUP.INS (the installer's script, packed on its own) has a header whose unpacked size isn't its file's.
            if (path === 'INTERNET/SETUP.INS') expect(r.warnings).toEqual(['The header says the files come to 26,182,683 bytes unpacked, but their entries add up to 206,269 bytes.']);
            else expect(r.warnings, path).toEqual([]);
            expect(
                r.fields.reduce((n, f) => n + f.length, 0),
                path
            ).toBe(data.length);
            expect(
                r.entries!.every((e) => !e.meta!.Note),
                path
            ).toBe(true);
        }
    });

    it('holds Windows themes in THEMES.Z, and the same Internet Explorer in _SETUP.LIB and _SETUP.1', async () => {
        const themes = read('INSTALL/THEMES.Z');
        expect(themes.entries).toHaveLength(143);
        expect(themes.entries![0].name).toBe('RA Time (high color).Theme');
        // Its pictures and sounds open as what they are, with nothing to say.
        for (const e of themes.entries!.filter((x) => /\.(bmp|wav)$/i.test(x.name!))) {
            const inner = await inspect(e.data, { name: e.name, names: [] });
            expect(inner.checks, e.name!).toEqual([]);
            expect(inner.parsed.warnings, e.name!).toEqual([]);
        }
        const ie = read('INTERNET/_SETUP.LIB').entries!.find((e) => e.name === 'msie30.exe')!;
        const pie = read('INTERNET/_SETUP.1').entries![0];
        expect(pie.name).toBe('PIE.exe');
        expect(pie.data.length).toBe(6_761_616);
        expect(pie.data).toEqual(ie.data);
    });
});
