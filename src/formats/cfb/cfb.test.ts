import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Parsed } from '../../core/types';
import { gameDir, gameFile, gameFiles } from '../../testing/game-data';
import { compoundFile, summaryInformation, word6Document, word97Document } from '../../testing/samples';
import { detect } from '../index';
import { inspect } from '../inspect';
import cfb from './index';
import { readPropertySets } from './properties';

const parse = (data: Uint8Array, name = 'sample.doc') => cfb.parse(data, { name, names: [] }) as Parsed;
const summary = (r: Parsed, key: string) => r.summary.find(([k]) => k === key)?.[1];
const text = (r: Parsed) => {
    const p = r.preview;
    if (p?.kind !== 'stack' || p.items[0].preview.kind !== 'text') throw new Error('no text shown');
    return p.items[0].preview.text;
};
/** The sample's text as Word shows it: the field as its result, its marks as line breaks and a tab. */
const SHOWN = 'Chimera sample document.\nA field: 1, and a tab:\tdone.\nThe last paragraph.\n';

/** Where a directory entry is, by its name: they're 128 bytes each, in the sectors after the header. */
function entry(data: Uint8Array, name: string): number {
    const want = Array.from(name, (c) => [c.charCodeAt(0), 0]).flat();
    for (let o = 512; o + 128 <= data.length; o += 128) if (want.every((v, i) => data[o + i] === v) && data[o + want.length] === 0 && data[o + 64] === want.length + 2) return o;
    throw new Error(`no entry ${name}`);
}
const view = (data: Uint8Array) => new DataView(data.buffer, data.byteOffset, data.byteLength);
/** A copy of the sample, changed. */
const changed = (change: (d: Uint8Array, v: DataView) => void, data = word6Document()) => (change(data, view(data)), data);
/** The FAT's entry for sector `s` (the sample's FAT is sector 0). */
const fatAt = (s: number) => 512 + s * 4;
const firstSector = (d: Uint8Array, name: string) => view(d).getUint32(entry(d, name) + 116, true);

describe('compound files', () => {
    it('reads a Word 6.0 document: every sector, its streams and storages, its summary and its text', async () => {
        const data = word6Document();
        expect(detect(data, 'sample.doc').id).toBe('cfb');
        expect(detect(data, null).id).toBe('cfb');
        const inspected = await inspect(data, { name: 'sample.doc', names: [] });
        expect(inspected.checks).toEqual([]);
        const r = inspected.parsed;
        expect(r.warnings).toEqual([]);
        expect(r.title).toBe('Word document (Word 6.0)');
        expect(text(r)).toBe(SHOWN);
        expect(r.summary).toEqual([
            ['Word', 'Word 6.0'],
            ['Title', 'Chimera sample'],
            ['Author', 'Chimera'],
            ['Created', '1997-04-23 14:02:10 UTC'],
            ['Program', 'Microsoft Word 6.0'],
            ['Characters', '83 in the text'],
            ['Embedded objects', '1'],
            ['Streams', `4, ${(4608 + 56 + summaryInformation('Chimera sample', 'Chimera', 'Microsoft Word 6.0').length + 4).toLocaleString('en-US')} bytes`],
            ['Layout', 'version 3, 512-byte sectors'],
        ]);
        expect(r.end).toBe(data.length);
        expect(r.fields.reduce((n, f) => n + f.length, 0)).toBe(data.length);
        expect(r.fields.map((f) => f.name)).toEqual(['Header', 'FAT', 'The directory', 'The mini FAT', 'The mini stream', 'Stream “WordDocument”']);
        expect(r.fields.find((f) => f.name === 'The directory')!.children!.map((f) => [f.name, f.value])).toEqual([
            ['Entry 0: Root Entry', 'root'],
            ['Entry 1: WordDocument', 'stream'],
            ['Entry 2: [1]CompObj', 'stream'],
            ['Entry 3: [5]SummaryInformation', 'stream'],
            ['Entry 4: ObjectPool', 'storage'],
            ['Entry 5: _1234', 'storage'],
            ['Entry 6: [1]Ole', 'stream'],
            ['Entry 7: unused', 'unused'],
        ]);
        expect(r.entries!.map((e) => [e.label, e.size, e.format])).toEqual([
            ['WordDocument', 4608, undefined],
            ['[1]CompObj', 56, undefined],
            ['[5]SummaryInformation', summaryInformation('Chimera sample', 'Chimera', 'Microsoft Word 6.0').length, 'ole-properties'],
            ['ObjectPool/_1234/[1]Ole', 4, undefined],
        ]);
        // Each stream's bytes, at the place its first sector is.
        const word = r.entries![0];
        expect([...word.data.subarray(0, 4)]).toEqual([0xdc, 0xa5, 101, 0]);
        expect([...data.subarray(word.offset, word.offset + 4)]).toEqual([0xdc, 0xa5, 101, 0]);
        const props = r.entries![2];
        expect([...data.subarray(props.offset, props.offset + 4)]).toEqual([0xfe, 0xff, 0, 0]);
    });

    it('opens its summary information as a property set', async () => {
        const stream = parse(word6Document()).entries!.find((e) => e.format === 'ole-properties')!;
        const opened = await inspect(stream.data, { name: null, names: [] }, { hint: stream.format, shownName: stream.label });
        expect(opened.format.id).toBe('ole-properties');
        expect(opened.checks).toEqual([]);
        expect(opened.parsed.warnings).toEqual([]);
        expect(opened.parsed.summary).toEqual([
            ['Title', 'Chimera sample'],
            ['Author', 'Chimera'],
            ['Created', '1997-04-23 14:02:10 UTC'],
            ['Program', 'Microsoft Word 6.0'],
        ]);
        expect(opened.parsed.end).toBe(stream.data.length);
        const set = opened.parsed.fields[1];
        expect(set.children!.filter((f) => !['Size', 'Properties', 'Where each is'].includes(f.name)).map((f) => [f.name, f.value])).toEqual([
            ['Code page', 'Windows Western (1252)'],
            ['Title', 'Chimera sample'],
            ['Author', 'Chimera'],
            ['Created', '1997-04-23 14:02:10 UTC'],
            ['Program', 'Microsoft Word 6.0'],
        ]);
    });

    it('reads a Word 97 document’s text from its piece table, in code page 1252 and in UTF-16', () => {
        const r = parse(word97Document());
        expect(r.warnings).toEqual([]);
        expect(r.title).toBe('Word document (Word 97 or later)');
        expect(text(r)).toBe(SHOWN);
    });

    it('refuses what isn’t one', () => {
        expect(() => parse(new Uint8Array(1024))).toThrow('This isn’t a compound file: it doesn’t start with D0 CF 11 E0');
        const noRoot = changed((d) => (d[entry(d, 'Root Entry') + 66] = 1));
        expect(() => parse(noRoot)).toThrow('This isn’t a compound file that can be read: its directory doesn’t start with the root.');
    });

    it('says what’s wrong with its header', () => {
        expect(parse(changed((d) => (d[8] = 1))).warnings).toEqual(['Its header has a class ID ({00000001-0000-0000-0000-000000000000}) where a compound file has zeros.']);
        expect(parse(changed((_, v) => v.setUint32(56, 8192, true))).warnings).toEqual(['It says streams under 8,192 bytes are kept in mini sectors; it’s always 4,096, and is read so here.']);
        expect(parse(changed((d) => (d[36] = 1))).warnings).toEqual(['The 6 reserved bytes of its header aren’t zeros.']);
        expect(parse(changed((_, v) => v.setUint32(40, 2, true))).warnings).toEqual(['It says its directory takes 2 sectors, but version 3 leaves that 0.']);
        expect(parse(changed((_, v) => v.setUint32(44, 3, true))).warnings).toEqual(['Its header says its FAT takes 3 sectors, but it lists 1.']);
        expect(parse(changed((_, v) => v.setUint32(fatAt(0), 0xffffffff, true))).warnings).toEqual(['1 of the FAT’s and DIFAT’s own sectors aren’t marked as theirs in the FAT.']);
    });

    it('stops a chain that loops, or runs into another, and says what’s lost', () => {
        const loop = changed((d, v) => {
            const first = firstSector(d, 'WordDocument');
            v.setUint32(fatAt(first + 8), first, true);
        });
        expect(parse(loop).warnings).toEqual([`“WordDocument” runs into sector ${firstSector(loop, 'WordDocument')}, which is already part of it: its chain loops.`]);

        const shared = changed((d, v) => v.setUint32(entry(d, '\x05SummaryInformation') + 116, firstSector(d, '\x01CompObj'), true));
        const size = summaryInformation('Chimera sample', 'Chimera', 'Microsoft Word 6.0').length;
        expect(parse(shared).warnings).toEqual([
            '“[5]SummaryInformation” runs into mini sector 0, which is part of “[1]CompObj”.',
            `“[5]SummaryInformation” says it’s ${size} bytes, but its mini sectors hold 0 bytes: the rest is lost.`,
            '[5]SummaryInformation can’t be read: This isn’t a property set: it doesn’t start with 0xFFFE.',
        ]);

        const longer = changed((d, v) => v.setUint32(entry(d, 'WordDocument') + 120, 6000, true));
        expect(parse(longer).warnings).toEqual(['“WordDocument” says it’s 6,000 bytes, but its sectors hold 4,608 bytes: the rest is lost.']);

        // The chain ends a sector early: the last is left marked in use, part of nothing.
        const early = changed((d, v) => v.setUint32(fatAt(firstSector(d, 'WordDocument') + 7), 0xfffffffe, true));
        expect(parse(early).warnings).toEqual([
            '“WordDocument” says it’s 4,608 bytes, but its sectors hold 4,096 bytes: the rest is lost.',
            '1 sector is marked in use in the FAT, but isn’t part of anything its directory lists.',
        ]);

        const past = changed((d, v) => v.setUint32(fatAt(firstSector(d, 'WordDocument') + 8), 500, true));
        expect(parse(past).warnings).toEqual(['“WordDocument” goes on to sector 500, past the end of the file: what’s past it is lost.']);
    });

    it('lists the streams its tree doesn’t reach, and stops a tree that loops', () => {
        const hidden = changed((d, v) => v.setUint32(entry(d, '\x01CompObj') + 72, 0xffffffff, true));
        const r = parse(hidden);
        expect(r.warnings).toEqual([
            '4 of its directory’s entries aren’t in its tree, so Windows doesn’t show them: “[5]SummaryInformation”, “ObjectPool”, “_1234”, “[1]Ole”. They’re listed under Contents.',
        ]);
        expect(r.entries!.map((e) => e.label)).toEqual(['WordDocument', '[1]CompObj', '(not in the tree) [5]SummaryInformation', '(not in the tree) [1]Ole']);

        const loop = changed((d, v) => v.setUint32(entry(d, '\x01Ole') + 72, 1, true));
        expect(parse(loop).warnings).toEqual(['The directory’s tree reaches entry 1 (“WordDocument”) twice: it loops.']);
    });

    it('takes a file cut short after its last stream’s last byte, as TS’s and RA2’s saved games are, but not one that loses data', () => {
        // The Word stream said to be 100 bytes short of its sectors, and the file ending where it does.
        const saved = changed((d, v) => v.setUint32(entry(d, 'WordDocument') + 120, 4508, true));
        expect(parse(saved.subarray(0, saved.length - 100)).warnings).toEqual([]);
        expect(parse(word6Document().subarray(0, -100)).warnings).toEqual(['The file ends partway through a sector that has to be there whole: what’s in it is lost.']);
    });

    it('says when it holds macros, and when a Word 6.0 template is named .doc', () => {
        const macros = changed((d, v) => {
            const e = entry(d, 'ObjectPool');
            d.fill(0, e, e + 64);
            Array.from('Macros').forEach((c, i) => v.setUint16(e + i * 2, c.charCodeAt(0), true));
            v.setUint16(e + 64, 14, true);
        });
        expect(parse(macros).warnings).toEqual(['It holds macros (in “Macros”): the program that opens it may run them, if it’s allowed to.']);

        const template = changed((d) => (d[firstSector(d, 'WordDocument') * 512 + 512 + 0x0a] = 1));
        expect(parse(template).warnings).toEqual(['It’s a template, named .doc: Word 6.0’s and 95’s macro viruses save the documents they infect that way, to carry their macros.']);
        expect(parse(template, 'sample.dot').warnings).toEqual([]);
        expect(parse(template, 'sample.dot').title).toBe('Word template (Word 6.0)');
    });

    it('says when Word’s text can’t be shown, and why', () => {
        const word = (d: Uint8Array) => firstSector(d, 'WordDocument') * 512 + 512;
        const encrypted = parse(changed((d) => (d[word(d) + 0x0b] = 1)));
        expect(encrypted.preview?.kind).toBe('table');
        expect(summary(encrypted, 'Text')).toBe('not shown: it’s password protected: its text is encrypted');
        expect(summary(parse(changed((d) => (d[word(d) + 0x0a] = 4))), 'Text')).toBe('not shown: it was fast-saved, which leaves Word 6.0’s and 95’s text in pieces, not read here');
        expect(parse(changed((d, v) => v.setUint32(word(d) + 0x1c, 9999, true))).warnings).toEqual(['Its Word header says its text is bytes 384 to 9,999, but the stream is 4,608 bytes.']);
        expect(parse(changed((d, v) => v.setInt32(word(d) + 0x34, 900, true))).warnings).toEqual(['Its Word header counts 900 characters, more than the 83 bytes it says its text takes.']);

        // Word 97's: its tables said to be in 0Table, which it hasn't got, and a piece table that isn't whole pieces.
        const w97 = (change: (d: Uint8Array, v: DataView, at: number) => void) => parse(changed((d, v) => change(d, v, word(d)), word97Document())).warnings;
        expect(w97((d, _, at) => (d[at + 0x0b] = 0))).toEqual(['Its Word header says its tables are in the 0Table stream, but it has none.']);
        const pieces = (length: number) =>
            w97((d, v) => {
                const table = firstSector(d, '1Table') * 64;
                const mini = firstSector(d, 'Root Entry') * 512 + 512;
                v.setUint32(mini + table + 1, length, true);
            });
        expect(pieces(21)).toEqual(['Its list of pieces says it’s 21 bytes, which isn’t a whole number of pieces.']);
        expect(pieces(9999)).toEqual(['Its list of pieces says it’s 9,999 bytes, which runs past its piece table.']);
    });
});

describe('property sets', () => {
    const sample = () => summaryInformation('Chimera sample', 'Chimera', 'Microsoft Word 6.0');
    it('says what doesn’t fit', () => {
        const problems = (change: (d: Uint8Array, v: DataView) => void) => readPropertySets(changed(change, sample())).problems;
        // The set is at 48: its size, its count, then each property's ID and offset (the title is the second).
        expect(problems((_, v) => v.setUint32(48, 9999, true))).toEqual([`Its summary information says it’s 9,999 bytes, but only ${sample().length - 48} bytes are left in the stream.`]);
        expect(problems((_, v) => v.setUint32(52, 900, true))).toEqual(['Its summary information says it has 900 properties, but only 5 are listed before its values start.']);
        expect(problems((_, v) => v.setUint32(48 + 8 + 8 + 4, 9999, true))).toEqual(['Property 2 of its summary information is said to be at 9,999, past the set’s end.']);
        const title = 48 + new DataView(sample().buffer).getUint32(48 + 8 + 8 + 4, true);
        expect(problems((_, v) => v.setUint32(title + 4, 999, true))).toEqual(['Title, in its summary information: it says it’s 999 bytes, past the set’s end.']);
        expect(problems((_, v) => v.setUint32(44, 4, true))).toEqual(['Its summary information is said to start at 4, inside the header.']);
        expect(() => readPropertySets(changed((d) => (d[0] = 0), sample()))).toThrow('This isn’t a property set: it doesn’t start with 0xFFFE.');
        expect(() => readPropertySets(changed((_, v) => v.setUint32(24, 7, true), sample()))).toThrow('it says it holds 7 sets, and a property set stream holds 1 or 2.');
    });
});

describe('the compound file sample writer', () => {
    it('lays out a big and a small stream as compound files do', () => {
        const data = compoundFile([
            { name: 'Big', data: new Uint8Array(5000).fill(7) },
            { name: 'Small', data: Uint8Array.of(1, 2, 3) },
        ]);
        const r = parse(data, 'sample.bin');
        expect(r.warnings).toEqual([]);
        expect(r.title).toBe('Compound file (OLE)');
        expect(r.entries!.map((e) => [e.label, e.size, e.data.every((v, i) => v === (e.label === 'Big' ? 7 : i + 1))])).toEqual([
            ['Big', 5000, true],
            ['Small', 3, true],
        ]);
    });
});

const CNC = gameDir('cncRemastered');
describe.skipIf(!CNC)('Counterstrike’s README.WRI', () => {
    it('is a Word 6.0 document under Windows Write’s name, its text and every byte read', async () => {
        const data = new Uint8Array(readFileSync(join(CNC!, 'RED_ALERT/COUNTERSTRIKE/INTERNET/README.WRI')));
        const inspected = await inspect(data, { name: 'README.WRI', names: [] });
        expect(inspected.checks).toEqual([]);
        const r = inspected.parsed;
        expect(r.warnings).toEqual([]);
        expect(r.title).toBe('Word document (Word 6.0)');
        expect(summary(r, 'Named')).toBe('.wri, as Windows Write’s documents are, but it’s a Word document');
        expect(summary(r, 'Characters')).toBe('3,668 in the text');
        expect(text(r)).toContain('INTERNET SERVICES README FILE');
        expect(text(r)).toContain('1.5. Westwood Chat');
        expect(r.fields.reduce((n, f) => n + f.length, 0)).toBe(data.length);
    });
});

const RA2 = gameDir('redAlert2');
describe.skipIf(!RA2)('Red Alert 2’s documents', () => {
    it('reads LICENSE.DOC (Word 95) and patch.doc (Word 97, in pieces), their summaries, and every byte', async () => {
        for (const [name, version, title, author] of [
            ['LICENSE.DOC', 'Word 95', 'YOU MUST READ THIS PRODUCT LICENSE (THIS "LICENSE") CAREFULLY', 'Maria_Legg'],
            ['patch.doc', 'Word 97 or later', "Command & Conquer™: Red Alert 2™ - Yuri's Revenge™ - V1.001", 'Frank Hsu'],
        ]) {
            const data = new Uint8Array(readFileSync(gameFile('redAlert2', name)!));
            const inspected = await inspect(data, { name, names: [] });
            expect(inspected.checks, name).toEqual([]);
            const r = inspected.parsed;
            expect(r.warnings, name).toEqual([]);
            expect(summary(r, 'Word'), name).toBe(version);
            expect(summary(r, 'Title'), name).toBe(title);
            expect(summary(r, 'Author'), name).toBe(author);
            expect(
                r.fields.reduce((n, f) => n + f.length, 0),
                name
            ).toBe(data.length);
        }
        const patch = parse(new Uint8Array(readFileSync(gameFile('redAlert2', 'patch.doc')!)), 'patch.doc');
        // The heading after README ARCHIVE SECTION, which catdoc loses part of; LibreOffice reads it so too.
        expect(text(patch)).toContain('README ARCHIVE SECTION\n\n\n\nCommand & Conquer™: Yuri’s Revenge™');
    });
});

const saves = [...gameFiles('tiberianSun', /\.sav$/i), ...gameFiles('redAlert2', /\.sav$/i)];
describe.skipIf(!saves.length)('Tiberian Sun’s and Red Alert 2’s saved games', () => {
    it('read with nothing to warn about, cut short in their last sector or not', () => {
        for (const path of saves) {
            const r = parse(new Uint8Array(readFileSync(path)), path);
            expect(r.warnings, path).toEqual([]);
            expect(r.title, path).toBe('Saved game (Tiberian Sun, Red Alert 2)');
            expect(
                r.entries!.some((e) => e.label === 'CONTENTS'),
                path
            ).toBe(true);
        }
    });
});
