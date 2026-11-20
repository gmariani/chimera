import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Parsed } from '../core/types';
import { gameDir } from '../testing/game-data';
import { zipArchive, zipSample, type ZipFile } from '../testing/samples';
import { detect } from './index';
import { inspect } from './inspect';
import zip from './zip';

const parse = (data: Uint8Array) => zip.parse(data, { name: 'archive.zip', names: [] }) as Parsed;
const enc = new TextEncoder();
const text = (s: string) => enc.encode(s);
const line = 'ZIP keeps each file whole, and lists them again at its end. ';
/** What the sample's files hold, by name. */
const SAMPLE: Record<string, string> = {
    'readme.txt': 'Chimera sample ZIP.\r\n',
    'data/deflated.txt': line.repeat(2),
    'data/imploded.txt': line.repeat(3),
    'Grüße.txt': 'Hallo.\n',
    'later.txt': 'Sizes after the data.\n',
};
const files = (r: Parsed) => Object.fromEntries(r.entries!.map((e) => [e.name, new TextDecoder().decode(e.data)]));
/** Where a 4-byte signature is: its `nth` (from 0). */
const find = (data: Uint8Array, sig: number[], nth = 0) => {
    for (let i = 0, k = 0; i + 4 <= data.length; i++) if (sig.every((v, j) => data[i + j] === v) && k++ === nth) return i;
    throw new Error('not found');
};
const LOCAL = [0x50, 0x4b, 3, 4];
const CENTRAL = [0x50, 0x4b, 1, 2];
const END = [0x50, 0x4b, 5, 6];
const edited = (change: (v: DataView, d: Uint8Array) => void, data = zipSample()) => {
    change(new DataView(data.buffer), data);
    return data;
};
const warningsOf = (change: (v: DataView, d: Uint8Array) => void, data?: Uint8Array) => parse(edited(change, data)).warnings;
const two: ZipFile[] = [
    { name: 'a.txt', data: text('First.\n') },
    { name: 'b.txt', data: text('Second.\n') },
];

describe('ZIP archives', () => {
    it('takes out its files: stored, Deflate, DCL implode, a UTF-8 name, sizes in a descriptor; every byte marked', async () => {
        const data = zipSample();
        expect(detect(data, 'archive.zip').id).toBe('zip');
        expect(detect(data, null).id).toBe('zip');
        const inspected = await inspect(data, { name: 'archive.zip', names: [] });
        expect(inspected.checks).toEqual([]);
        const r = inspected.parsed;
        expect(r.warnings).toEqual([]);
        expect(files(r)).toEqual(SAMPLE);
        expect(r.summary).toEqual([
            [
                'Files',
                `5, ${Object.values(SAMPLE)
                    .reduce((n, s) => n + enc.encode(s).length, 0)
                    .toLocaleString('en-US')} bytes unpacked`,
            ],
            ['Compression', 'stored, Deflate, PKWARE DCL implode'],
            ['Made on', 'MS-DOS or Windows (FAT)'],
            ['Comment', 'Chimera sample archive'],
        ]);
        expect(r.fields.reduce((n, f) => n + f.length, 0)).toBe(data.length);
        const p = r.preview!;
        expect(p.kind === 'table' && p.rows.find((row) => row.cells.name === 'data/')?.cells.note).toBe('a folder');
    });

    it('reads ZIP64’s end record and the offsets in its extra fields, and an archive with something before it', () => {
        const big = parse(zipSample({ zip64: true }));
        expect(big.warnings).toEqual([]);
        expect(files(big)).toEqual(SAMPLE);
        expect(big.fields.map((f) => f.name)).toEqual(expect.arrayContaining(['ZIP64 end record', 'ZIP64 locator', 'End record']));
        // A self-extractor's program in front: the offsets count from the archive's own start.
        const after = parse(zipSample({ prefix: [0x4d, 0x5a, ...new Array(98).fill(0x90)] }));
        expect(after.warnings).toEqual([]);
        expect(files(after)).toEqual(SAMPLE);
        expect(Object.fromEntries(after.summary)['Before it']).toBe('100 bytes: archive.zip is a self-extracting archive, or has something in front');
    });

    it('says when its directory and its files’ own headers disagree, or point wrong', () => {
        const data = zipSample();
        const end = find(data, END);
        // A name changed in a file's own header: programs going by one or the other see different names.
        expect(warningsOf((_v, d) => (d[find(d, LOCAL) + 30] = 0x52))).toEqual([
            '1 file’ own headers disagree with the directory, so programs that read one or the other see different files: readme.txt: its own header gives its name ("Readme.txt").',
        ]);
        // Its header then isn't listed either: both are said.
        expect(warningsOf((v, d) => v.setUint32(find(d, CENTRAL) + 42, 7, true))).toEqual([
            'readme.txt’s header isn’t where the directory says (7): it can’t be taken out.',
            '1 file is in it that the directory doesn’t list, which programs going by the directory never show: "readme.txt".',
        ]);
        expect(warningsOf((v) => v.setUint32(end + 16, 9, true))).toEqual([`Its end record says the directory is at 9, but it’s at ${find(data, CENTRAL).toLocaleString('en-US')}.`]);
        // The end record's offset wrong, and the first file's header offset past the file: said, not thrown on.
        expect(warningsOf((v, d) => (v.setUint32(end + 16, 9, true), v.setUint32(find(d, CENTRAL) + 42, 0x7fffffff, true)))).toContain(
            `readme.txt’s header isn’t where the directory says (${(0x7fffffff + find(data, CENTRAL) - 9).toLocaleString('en-US')}): it can’t be taken out.`
        );
        expect(warningsOf((v) => (v.setUint32(end + 16, 9, true), v.setUint32(end + 12, 3, true)))).toEqual([
            'Its end record says the directory is at 9, but it isn’t there: its files can’t be found.',
        ]);
        expect(warningsOf((v) => v.setUint32(end + 12, 3, true))).toEqual([
            `Its directory is said to be 3 bytes, but it runs from ${find(data, CENTRAL).toLocaleString('en-US')} to the end record at ${end.toLocaleString('en-US')}.`,
        ]);
        expect(warningsOf((v) => (v.setUint16(end + 8, 7, true), v.setUint16(end + 10, 7, true)))).toEqual(['Its directory ends after 6 files, of the 7 its end record says.']);
        expect(warningsOf((v) => v.setUint16(end + 4, 1, true))).toEqual(['It’s part 2 of an archive split across disks: only the files whose data is in this part can be taken out.']);
        const big = zipSample({ zip64: true });
        // Read from the ordinary end record instead: the broken ZIP64 one is left between the directory and the locator.
        const broken = parse(edited((_v, d) => (d[find(d, [0x50, 0x4b, 6, 6]) + 2] = 0), big));
        expect(broken.warnings).toEqual([
            'Its ZIP64 locator points to a ZIP64 end record that isn’t there.',
            expect.stringMatching(/^Its directory is said to be 417 bytes, but it runs from [\d,]+ to the end record at [\d,]+\.$/),
        ]);
        expect(files(broken)).toEqual(SAMPLE);
    });

    it('says what’s wrong with its files’ data', () => {
        const data = zipSample();
        const readme = find(data, LOCAL) + 30 + 10;
        expect(warningsOf((_v, d) => (d[readme] ^= 1))).toEqual(['1 file doesn’t match its CRC: damaged, or changed after the archive was made.']);
        const deflated = find(data, LOCAL, 2);
        expect(warningsOf((_v, d) => (d[deflated + 30 + 17] = 0xff))).toEqual(expect.arrayContaining([expect.stringMatching(/^data\/deflated\.txt can’t be unpacked: /)]));
        // Its size made smaller in the directory and its own header: it unpacks to more.
        const shrink = (v: DataView, d: Uint8Array, to: number) => (v.setUint32(deflated + 22, to, true), v.setUint32(find(d, CENTRAL, 2) + 24, to, true));
        expect(warningsOf((v, d) => shrink(v, d, 10))).toEqual(['data/deflated.txt unpacks to 120 bytes, not the 10 bytes it says.']);
        // Past the first 1 KB the unpacking is stopped at the size it says.
        const long = zipArchive([{ name: 'long.txt', data: text(line.repeat(100)), method: 8 }]);
        expect(warningsOf((v, d) => (v.setUint32(22, 2000, true), v.setUint32(find(d, CENTRAL) + 24, 2000, true)), long)).toEqual([
            'long.txt unpacks to more than the 2,000 bytes it says: it’s damaged, or made to exhaust memory.',
        ]);
        // What it unpacks to is the right data: its CRC still matches.
        expect(warningsOf((v, d) => shrink(v, d, 500))).toEqual(['data/deflated.txt unpacks to 120 bytes, not the 500 bytes it says.']);
        // A size past what the app unpacks for one file: it, and those after it, aren't unpacked.
        expect(warningsOf((v, d) => (v.setUint32(readme - 40 + 22, 0x30000000, true), v.setUint32(find(d, CENTRAL) + 24, 0x30000000, true)))).toEqual([
            'Its files would unpack to more than the app allows for one file: readme.txt and those after it aren’t taken out. Sizes like that mean a damaged archive, or one made to exhaust memory (a zip bomb).',
        ]);
    });

    it('says what a careless or a fooled program would do with it', () => {
        expect(parse(zipArchive([{ name: '../evil.txt', data: text('x') }])).warnings).toEqual([
            '../evil.txt: its name climbs out of the folder it’s extracted to: a program extracting it without care would write outside that folder.',
        ]);
        expect(parse(zipArchive([two[0], { ...two[1], name: 'A.TXT' }])).warnings).toEqual(['1 name is in it more than once (a.txt): which one a program takes out differs.']);
        // The second file's entry pointing at the first's header: they share it.
        const shared = zipArchive(two);
        new DataView(shared.buffer).setUint32(find(shared, CENTRAL, 1) + 42, 0, true);
        expect(parse(shared).warnings).toContain('1 file overlaps the one before: they share data, as a zip bomb’s do, or the archive is damaged.');
        // The second file left out of the directory: it's still there, for programs that read the headers in order.
        const both = zipArchive(two);
        const second = find(both, CENTRAL, 1);
        const end = find(both, END);
        const hidden = Uint8Array.from([...both.subarray(0, second), ...both.subarray(end)]);
        const v = new DataView(hidden.buffer);
        const e = hidden.length - 22;
        v.setUint16(e + 8, 1, true);
        v.setUint16(e + 10, 1, true);
        v.setUint32(e + 12, second - find(both, CENTRAL), true);
        expect(parse(hidden).warnings).toEqual(['1 file is in it that the directory doesn’t list, which programs going by the directory never show: "b.txt".']);
    });

    it('reads what’s left of one cut short, from its files’ own headers', () => {
        const data = zipSample();
        const cut = parse(data.subarray(0, find(data, CENTRAL)));
        expect(cut.warnings).toEqual(['It has no end record, so no directory: it’s been cut short, or was never finished. Its files are read from their own headers, in order.']);
        // The walk stops at the file whose sizes are in a descriptor: its header can't say where it ends.
        expect(files(cut)).toEqual(Object.fromEntries(Object.entries(SAMPLE).filter(([k]) => k !== 'later.txt')));
        const mid = parse(data.subarray(0, find(data, LOCAL) + 45));
        expect(mid.warnings).toContain('readme.txt’s data runs past the end of the file: it’s been cut short.');
    });

    it('refuses what isn’t one', () => {
        expect(() => parse(text('PK\x05\x06 not an archive at all'))).toThrow('This isn’t a ZIP archive: it doesn’t start with a file’s header, and has no end record.');
        // An end record at the end of something else, pointing nowhere.
        const fake = Uint8Array.from([...text('Not a ZIP. '), ...text('PK\x05\x06'), ...new Array(4).fill(0), 1, 0, 1, 0, 46, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        expect(detect(fake, null).id).not.toBe('zip');
        expect(() => parse(fake)).toThrow('This isn’t a ZIP archive: it has what looks like an end record, but no files where it says.');
    });
});

// Ground truth from outside: Python's zipfile, when Python is installed.
const python = spawnSync('python3', ['--version']).status === 0;
describe.skipIf(!python)('what Python’s zipfile makes and reads', () => {
    it('reads what it makes, Deflate by zlib, sizes in descriptors, ZIP64; and it reads the sample as Chimera does', () => {
        const dir = mkdtempSync(join(tmpdir(), 'chimera-zip-'));
        try {
            const made = join(dir, 'made.zip');
            const script = [
                'import zipfile, sys',
                'with zipfile.ZipFile(sys.argv[1], "w") as z:',
                '    z.writestr("plain.txt", "stored " * 50, compress_type=zipfile.ZIP_STORED)',
                '    z.writestr("deep/zlib.txt", "deflated by zlib " * 200, compress_type=zipfile.ZIP_DEFLATED)',
                '    with z.open("streamed.txt", "w", force_zip64=True) as f: f.write(b"zip64 " * 100)',
                '    z.comment = b"made by Python"',
                // An unseekable stream: Python writes descriptors after the data.
                'import io',
                'class W(io.RawIOBase):',
                '    def __init__(s, f): s.f = f',
                '    def writable(s): return True',
                '    def write(s, b): return s.f.write(b)',
                'with open(sys.argv[2], "wb") as raw, zipfile.ZipFile(W(raw), "w", zipfile.ZIP_DEFLATED) as z:',
                '    z.writestr("descriptor.txt", "after " * 80)',
            ].join('\n');
            const streamed = join(dir, 'streamed.zip');
            const r = spawnSync('python3', ['-I', '-c', script, made, streamed], { encoding: 'utf-8' });
            if (r.status !== 0) throw new Error(r.stderr);
            const a = parse(new Uint8Array(readFileSync(made)));
            expect(a.warnings).toEqual([]);
            expect(files(a)).toEqual({ 'plain.txt': 'stored '.repeat(50), 'deep/zlib.txt': 'deflated by zlib '.repeat(200), 'streamed.txt': 'zip64 '.repeat(100) });
            expect(Object.fromEntries(a.summary).Comment).toBe('made by Python');
            const b = parse(new Uint8Array(readFileSync(streamed)));
            expect([b.warnings, files(b)]).toEqual([[], { 'descriptor.txt': 'after '.repeat(80) }]);

            // The other way: Python reads the sample's files (but the imploded one, which it can't) as Chimera does.
            const sample = join(dir, 'sample.zip');
            writeFileSync(sample, zipSample());
            const read = spawnSync(
                'python3',
                [
                    '-I',
                    '-c',
                    'import zipfile, sys, json\nz = zipfile.ZipFile(sys.argv[1])\nprint(json.dumps({i.filename: z.read(i).decode() for i in z.infolist() if i.compress_type != 10 and not i.is_dir()}))',
                    sample,
                ],
                { encoding: 'utf-8' }
            );
            expect(JSON.parse(read.stdout)).toEqual(Object.fromEntries(Object.entries(SAMPLE).filter(([k]) => k !== 'data/imploded.txt')));
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

const CNC = gameDir('cncRemastered');
describe.skipIf(!CNC)('Internet Explorer 3’s Java classes, in Counterstrike’s INTERNET folder', () => {
    it('takes out all 572 of classes.zip, with no warnings', async () => {
        // IE301M95.EXE › its CABINET resource › Iexplore.cab › classes.zip.
        const open = async (data: Uint8Array, name: string | null) => (await inspect(data, { name, names: [] })).parsed;
        const ie = await open(new Uint8Array(readFileSync(join(CNC!, 'RED_ALERT/COUNTERSTRIKE/INTERNET/MSIE/IE301M95.EXE'))), 'IE301M95.EXE');
        const outer = await open(ie.entries!.find((e) => e.label === 'Raw data CABINET.bin')!.data, null);
        const inner = await open(outer.entries!.find((e) => e.name === 'Iexplore.cab')!.data, 'Iexplore.cab');
        const classes = await inspect(inner.entries!.find((e) => e.name === 'classes.zip')!.data, { name: 'classes.zip', names: [] });
        expect([classes.format.id, classes.parsed.warnings, classes.checks, classes.parsed.entries!.length]).toEqual(['zip', [], [], 572]);
        expect(classes.parsed.entries!.map((e) => e.name)).toContain('java/lang/Object.class');
    });
});
