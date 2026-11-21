import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DocumentPreview, Parsed, Preview } from '../../core/types';
import { gameDir } from '../../testing/game-data';
import { winHelp } from '../../testing/samples';
import { detect } from '../index';
import { inspect } from '../inspect';
import { contextHash } from './document';
import winhelp from './index';
import { unpackHelp, unpackRuns } from './lz77';

const parse = (data: Uint8Array) => winhelp.parse(data, { name: 'help.hlp', names: [] }) as Parsed;
const enc = new TextEncoder();
const summary = (r: Parsed) => Object.fromEntries(r.summary);
const TOPICS = '■ Welcome\r\n\r\nChimera’s sample help, in bold.\r\nName\tValue\r\nSee the second topic.\r\n[picture 0]\r\n\r\n\r\n■ Second topic\r\n\r\nLeft\tRight';

/** Where an internal file's bytes start in the sample, from its directory entry (the directory is last). */
const fileAt = (data: Uint8Array, name: string) => {
    const want = [...enc.encode(name), 0];
    for (let i = data.length - want.length; i >= 0; i--) if (want.every((v, k) => data[i + k] === v)) return new DataView(data.buffer).getUint32(i + want.length, true) + 9;
    throw new Error(`no ${name}`);
};
/** Where the directory names a file, to rename it. */
const nameAt = (data: Uint8Array, name: string) => {
    const want = [...enc.encode(name), 0];
    for (let i = data.length - want.length; i >= 0; i--) if (want.every((v, k) => data[i + k] === v)) return i;
    throw new Error(`no ${name}`);
};
/** The topic records, unpacked: the sample's LZ77 keeps every byte, after a flag byte before each 8. */
const topicByte = (data: Uint8Array, i: number) => fileAt(data, '|TOPIC') + 12 + 1 + i + Math.floor(i / 8);
const topicStream = (data: Uint8Array) => {
    const at = fileAt(data, '|TOPIC') + 12;
    const out: number[] = [];
    for (let i = at; i < data.length && out.length < 600; i++) if ((i - at) % 9) out.push(data[i]);
    return out;
};
const edited = (change: (v: DataView, d: Uint8Array) => void, data = winHelp()) => {
    change(new DataView(data.buffer), data);
    return data;
};
const warningsOf = (change: (v: DataView, d: Uint8Array) => void, data?: Uint8Array) => parse(edited(change, data)).warnings;
const itemsOf = (p: Preview | undefined) => (p?.kind === 'stack' ? p.items : []);
const documentOf = (r: Parsed) => {
    const p = itemsOf(r.preview).find((i) => i.title.startsWith('Topics'))?.preview;
    if (p?.kind !== 'document') throw new Error('no topics laid out');
    return p;
};
/** Every hotspot in a document's text: what it says, and where it leads. */
const linksOf = (doc: DocumentPreview) =>
    doc.pages.flatMap((page) =>
        [...page.fixed, ...page.body]
            .flatMap((b) => (b.kind === 'table' ? b.rows.flat(2) : [b]))
            .flatMap((p) => p.runs)
            .flatMap((r) => (r.kind === 'text' && r.link ? [{ text: r.text, ...r.link }] : []))
    );

describe('Windows Help files', () => {
    for (const hall of [false, true])
        it(`reads ${hall ? 'Windows 95’s, Hall-compressed' : 'Windows 3.1’s, phrase-compressed'}: its topics, index, window, picture, every byte marked`, async () => {
            const data = winHelp({ hall });
            expect(detect(data, 'help.hlp').id).toBe('winhelp');
            expect(detect(data, null).id).toBe('winhelp');
            const inspected = await inspect(data, { name: 'help.hlp', names: [] });
            expect(inspected.checks).toEqual([]);
            const r = inspected.parsed;
            expect(r.warnings).toEqual([]);
            expect(r.title).toBe(`Windows Help file (${hall ? 'Windows 95, HCW 4.0' : 'Windows 3.1, HC31'})`);
            expect(summary(r)).toMatchObject({
                Title: 'Chimera Sample Help',
                Copyright: 'Chimera, 1997',
                Made: '1997-01-01 00:00:00 UTC',
                Topics: '2, opening at “Welcome”',
                Index: '2 keywords',
                Pictures: '1',
                Compression: `${hall ? 'Hall' : 'phrases'} (3 phrases), LZ77`,
                Windows: 'main',
                'Macros on opening': 'BrowseButtons()',
                'Context names': '2 (as hashes), 1 map number',
            });
            expect(r.fields.reduce((n, f) => n + f.length, 0)).toBe(data.length);
            const text = r.entries!.find((e) => e.label === 'help-topics.txt')!;
            expect(new TextDecoder().decode(text.data)).toBe(TOPICS);
            const index = itemsOf(r.preview).find((i) => i.title.startsWith('Index'))!.preview;
            expect(index.kind === 'table' && index.rows.map((row) => [row.cells.keyword, row.cells.topics])).toEqual([
                ['chimera', 'Welcome, Second topic'],
                ['table', 'Second topic'],
            ]);
            // bm0: 1 bit a pixel, its rows bottom first: F0 at the bottom, 0F at the top.
            const picture = itemsOf(r.preview).find((i) => i.title.startsWith('bm0'))!;
            expect(picture.title).toBe('bm0: 8 × 2, 2 colors, 1 hotspot');
            const p = picture.preview;
            if (p.kind !== 'picture') throw new Error('not a picture');
            const shade = (x: number, y: number) => p.rgba[(y * 8 + x) * 4];
            expect([0, 3, 4, 7].map((x) => shade(x, 0))).toEqual([0, 0, 255, 255]);
            expect([0, 3, 4, 7].map((x) => shade(x, 1))).toEqual([255, 255, 0, 0]);
            expect(r.entries!.map((e) => e.label)).toEqual(expect.arrayContaining(['help-bm0.bmp', 'SYSTEM.bin', 'TOPIC.bin', 'FONT.bin']));
        });

    it('lays its topics out as WinHelp did: fonts, paragraphs, hotspots, pictures, tables, the non-scrolling band', () => {
        const doc = documentOf(parse(winHelp()));
        expect([doc.title, doc.start, doc.pages.map((p) => p.title)]).toEqual(['Chimera Sample Help', 0, ['Welcome', 'Second topic']]);
        // |FONT's two fonts, and the second again as a jump shows it: green and underlined.
        expect(doc.styles).toMatchObject([
            { face: 'MS Sans Serif', family: 'sans-serif', size: 10, bold: false, color: undefined },
            { face: 'Arial', size: 12, bold: true, color: '#008000' },
            { face: 'Arial', size: 12, bold: true, color: '#008000', underline: 'single' },
        ]);
        const toSecond = { page: 1, popup: false, about: 'Opens “Second topic”' };
        const [first, second] = doc.pages;
        expect(first.fixed).toEqual([]);
        expect(first.body).toEqual([
            {
                kind: 'paragraph',
                spaceBefore: 2.5,
                runs: [
                    { kind: 'text', text: 'Chimera’s sample help, ', style: 0 },
                    { kind: 'text', text: 'in bold.', style: 1 },
                ],
            },
            {
                kind: 'paragraph',
                spaceBefore: 2.5,
                runs: [
                    { kind: 'text', text: 'Name', style: 1 },
                    { kind: 'tab' },
                    { kind: 'text', text: 'Value', style: 1 },
                    { kind: 'break' },
                    { kind: 'text', text: 'See ', style: 1 },
                    { kind: 'text', text: 'the second topic', style: 2, link: toSecond },
                    { kind: 'text', text: '.', style: 1 },
                ],
            },
            { kind: 'paragraph', spaceBefore: 2.5, runs: [{ kind: 'picture', picture: 0, place: 'inline' }] },
        ]);
        // The picture's hotspot leads where the text's jump does: by its context name's hash.
        expect(doc.pictures[0]).toMatchObject({ width: 8, height: 2, hotspots: [{ x: 0, y: 0, width: 8, height: 2, link: toSecond }] });
        // The second topic is all in its non-scrolling band: a table of two 2-inch columns.
        const paragraph = (text: string) => ({ kind: 'paragraph', runs: [{ kind: 'text', text, style: 1 }] });
        expect(second.body).toEqual([]);
        expect(second.fixed).toEqual([
            {
                kind: 'table',
                relative: false,
                columns: [
                    { width: 144, gap: 0 },
                    { width: 144, gap: 5.5 },
                ],
                rows: [[[paragraph('Left')], [paragraph('Right')]]],
            },
        ]);
    });

    it('hashes context names as WinHelp does', () => {
        // The sample's, which helpdeco names; and names helpdeco gave to hashes in Microsoft's PSS help (psspos.hlp).
        expect(contextHash('second')).toBe(0x370e6d04);
        expect(contextHash('SECOND')).toBe(0x370e6d04);
        expect(contextHash('136HWYD')).toBe(0x94691a2e);
        expect(contextHash('O_L5IY')).toBe(0x126a972f);
        expect(contextHash('')).toBe(1);
    });

    it('reads its fonts, and says what’s wrong with them', () => {
        const r = parse(winHelp());
        const font = r.fields.find((f) => f.name === '|FONT')!;
        const fonts = font.children!.find((f) => f.name === 'Fonts')!;
        expect(fonts.children!.map((f) => f.value)).toEqual(['MS Sans Serif, 10 points', 'Arial, 12 points, bold, #008000']);
        expect(fonts.children![0].children!.map((f) => [f.name, f.value])).toEqual([
            ['Attributes', 'none'],
            ['Size', '10 points'],
            ['Family', 'swiss (sans serif)'],
            ['Face', 'MS Sans Serif'],
            ['Color', 'the window’s own'],
            ['Background', 'the window’s own'],
        ]);
        const at = (d: Uint8Array) => fileAt(d, '|FONT');
        expect(warningsOf((v, d) => v.setUint32(at(d) - 5, 4, true))).toEqual(['Its |FONT file is too short for its header.']);
        expect(warningsOf((v, d) => v.setUint16(at(d) + 2, 50, true))).toEqual(['Its |FONT file says it has 50 fonts, more than fit in it: those past its end aren’t read.']);
        expect(warningsOf((v, d) => v.setUint16(at(d) + 6, 2000, true))).toEqual([
            'Its |FONT file’s 2 face names don’t fit where it says they are.',
            'Its |FONT file says it has 2 fonts, more than fit in it: those past its end aren’t read.',
        ]);
        expect(warningsOf((v, d) => v.setUint16(at(d) + 48 + 11 + 3, 7, true))).toEqual(['Font 1 of its |FONT file names face 7, which it doesn’t have.']);
    });

    it('opens its pictures on their own, with their hotspots', async () => {
        const bm0 = parse(winHelp()).entries!.find((e) => e.label === 'bm0.bin')!;
        const r = await inspect(bm0.data, { name: null, names: [] });
        expect([r.format.id, r.parsed.warnings, r.checks]).toEqual(['shg', [], []]);
        const hotspots = itemsOf(r.parsed.preview).find((i) => i.title === 'Hotspots')!.preview;
        expect(hotspots.kind === 'table' && hotspots.rows.map((row) => row.cells)).toEqual([{ kind: 'jump', name: 'arrow', target: 'second', place: '0, 0, 8 × 2' }]);
    });

    it('unpacks LZ77 as the description has it, and runs', () => {
        // "a", "b", then 6 bytes from 2 back: they overlap what they make.
        expect(new TextDecoder().decode(unpackHelp(Uint8Array.of(0b100, 0x61, 0x62, 0x01, 0x30), 100).data)).toBe('abababab');
        // A copy from before the start is said, and comes out as 0.
        const before = unpackHelp(Uint8Array.of(0b1, 0x05, 0x00), 100);
        expect([[...before.data], before.beforeStart]).toEqual([[0, 0, 0], true]);
        // Two bytes as they are, then 3 of the next.
        expect([...unpackRuns(Uint8Array.of(0x82, 1, 2, 3, 9), 100)]).toEqual([1, 2, 9, 9, 9]);
    });

    it('takes RoboHELP’s stamp after the file quietly, and says who it was registered to', async () => {
        const help = winHelp();
        const invert = (s: string) => [...s].map((c) => c.charCodeAt(0) ^ 0xff);
        const stamp = [0x2e, 0xa7, 0, 0, ...invert('Authorized User')];
        stamp.push(...new Array(36 - stamp.length).fill(0xff), ...invert('RoboHELP'));
        stamp.push(...new Array(68 - stamp.length).fill(0xff), 0x2e, 0xa7, 0, 0);
        const data = Uint8Array.from([...help, ...stamp]);
        const r = await inspect(data, { name: 'help.hlp', names: [] });
        expect([r.parsed.warnings, r.checks]).toEqual([[], []]);
        expect(summary(r.parsed).Made).toBe('1997-01-01 00:00:00 UTC, with RoboHELP (registered to “Authorized User”)');
        // Without "RoboHELP" in it, it's 72 bytes the header doesn't count.
        data[help.length + 36] ^= 1;
        expect(parse(data).warnings).toEqual([`It says it’s ${help.length.toLocaleString('en-US')} bytes, less than the file’s ${data.length.toLocaleString('en-US')} bytes.`]);
    });

    it('says what’s wrong with its file system', () => {
        const size = winHelp().length;
        expect(warningsOf((v) => v.setUint32(12, size + 100, true))).toEqual([
            `It says it’s ${(size + 100).toLocaleString('en-US')} bytes, but the file is ${size.toLocaleString('en-US')} bytes: it’s been cut short.`,
        ]);
        expect(warningsOf((v, d) => v.setUint32(nameAt(d, '|KWDATA') + 8, 0x7fffff, true))).toEqual(['Its directory says |KWDATA is at 8,388,607, outside the file.']);
        expect(warningsOf((v, d) => v.setUint32(fileAt(d, '|CTXOMAP') - 5, 400, true))).toEqual(['|CTXOMAP is said to use 400 bytes, more than the 19 bytes it has.']);
        expect(warningsOf((v, d) => v.setUint16(fileAt(d, '|TTLBTREE'), 0x1234, true))).toEqual(['|TTLBTREE isn’t a B+ tree: it doesn’t start with 0x293B.']);
        expect(warningsOf((v, d) => v.setUint16(fileAt(d, '|CONTEXT') + 30, 50, true))).toEqual(['|CONTEXT’s pages run past the end of the file it’s in.']);
        expect(warningsOf((v, d) => v.setUint32(fileAt(d, '|KWBTREE') + 34, 5, true))).toEqual(['|KWBTREE’s header says it has 5 entries, but its leaves hold 2.']);
        expect(warningsOf((v, d) => v.setInt16(fileAt(d, '|CONTEXT') + 38 + 6, 0, true))).toEqual(['|CONTEXT’s leaf pages lead to one already read: what’s past it isn’t read.']);
        expect(warningsOf((v, d) => v.setInt16(fileAt(d, '|CONTEXT') + 38 + 2, 200, true))).toEqual([
            'An entry of |CONTEXT runs past the end of its page.',
            '|CONTEXT’s header says it has 2 entries, but its leaves hold 127.',
        ]);
        expect(warningsOf((v, d) => v.setUint16(fileAt(d, '|CONTEXT') + 32, 2, true))).toEqual(['|CONTEXT’s index pages lead to a page it doesn’t have (-1).']);
    });

    it('says what’s wrong with |SYSTEM and the phrases', () => {
        expect(warningsOf((v, d) => v.setUint16(fileAt(d, '|SYSTEM'), 0x1234, true))).toEqual(['Its |SYSTEM file doesn’t start with 0x036C, as one does.']);
        expect(warningsOf((v, d) => v.setUint16(fileAt(d, '|SYSTEM') + 14, 5000, true))).toEqual(['A record of its |SYSTEM file (type 1) runs past the file’s end.']);
        expect(warningsOf((v, d) => v.setUint16(fileAt(d, '|SYSTEM') + 2, 15, true))).toContain('It’s a Windows 3.0 help file, whose topics are laid out differently: they aren’t read here.');
        expect(warningsOf((v, d) => v.setUint32(fileAt(d, '|Phrases') + 4, 99, true))).toEqual(['Its phrases unpack to 17 bytes, not the 99 bytes it says.']);
        expect(warningsOf((v, d) => v.setUint16(fileAt(d, '|Phrases') + 10, 0x7fff, true))).toEqual(['2 of its phrases are said to be outside the phrase text.']);
        expect(warningsOf((v, d) => v.setUint16(fileAt(d, '|Phrases'), 1, true))).toEqual(['Its topics use phrases its phrase table doesn’t have, 2 times: they’re left out.']);
        expect(warningsOf((_v, d) => (d[nameAt(d, '|Phrases') + 7] = 0x7a))).toEqual(['1 of its topic records is phrase-compressed, but it has no phrase table: its text can’t be read.']);
        const hall = winHelp({ hall: true });
        expect(warningsOf((v, d) => v.setUint32(fileAt(d, '|PhrIndex') + 4, 1000, true), hall)).toEqual(
            expect.arrayContaining([expect.stringMatching(/^Its phrase lengths run out after \d+ of the 1000 phrases\.$/)])
        );
    });

    it('says what’s wrong with its topics', () => {
        const stream = topicStream(winHelp());
        const tab = stream.findIndex((v, i) => v === 0x82 && stream[i + 1] === 0x83 && stream[i + 2] === 0x81) + 1;
        expect(warningsOf((_v, d) => (d[topicByte(d, tab)] = 0x99))).toEqual(['1 code or record in its topics is of a kind this reader doesn’t know: it was skipped.']);
        expect(warningsOf((_v, d) => (d[topicByte(d, 16)] = 0xff))).toEqual([
            'A record of its topics at 0xc gives sizes that don’t fit together (67 in all, 255 in its first part): the topics after it aren’t read.',
        ]);
        expect(warningsOf((_v, d) => (d[topicByte(d, 1)] = 0xff))).toContain('A record of its topics runs past the end of the topic file: it’s been cut short.');
        // A record that says it's nearly 2 GB: said, and nothing that size made.
        expect(warningsOf((_v, d) => [0xff, 0xff, 0xff, 0x7f].forEach((v, k) => (d[topicByte(d, k)] = v)))).toContain(
            'A record of its topics runs past the end of the topic file: it’s been cut short.'
        );
        // The first block's LZ77 starting with a copy: from before its start.
        expect(warningsOf((_v, d) => (d[fileAt(d, '|TOPIC') + 12] = 1))).toContain('Some of its topic blocks reach back before their start as they unpack: what they copy isn’t there.');
        expect(warningsOf((_v, d) => (d[nameAt(d, '|SYSTEM') + 1] = 0x73))).toContain('It has topics but no |SYSTEM file to say how they’re packed: they aren’t read.');
        // The second topic's title said to be somewhere else.
        expect(warningsOf((v, d) => v.setUint32(fileAt(d, '|TTLBTREE') + 38 + 8 + 4 + 8, 0x77, true))).toEqual(['1 title in its title index points where no topic starts.']);
    });

    it('says what’s wrong with its pictures', () => {
        const at = (d: Uint8Array) => fileAt(d, '|bm0');
        expect(warningsOf((_v, d) => (d[at(d)] = 0))).toEqual(['bm0 isn’t a picture: it doesn’t start with "lP" or "lp".']);
        expect(warningsOf((v, d) => v.setUint16(at(d) + 2, 200, true))).toEqual(['bm0 says it has 200 pictures, more than fit in it.']);
        expect(warningsOf((_v, d) => (d[at(d) + 8] = 7))).toEqual(['bm0 is of kind 7, packed by method 1, which Windows Help doesn’t have.']);
        expect(warningsOf((_v, d) => (d[at(d) + 15] = 6))).toEqual(['bm0 says it’s 8 × 2 at 3 bits a pixel, which can’t be drawn.']);
        expect(warningsOf((v, d) => (v.setUint16(at(d) + 16, 0xfffe, true), v.setUint16(at(d) + 18, 0xfffe, true)))).toEqual(['bm0 says it’s 32,767 × 32,767: more than is drawn here.']);
        expect(warningsOf((v, d) => v.setUint16(at(d) + 24, 4, true))).toEqual(['bm0 unpacks to 1 byte, short of the 8 bytes its pixels take: the rest is drawn black.']);
        expect(warningsOf((v, d) => v.setUint16(at(d) + 24, 30000, true))).toContain('bm0’s data runs past the end of what holds it.');
        const hotspots = (d: Uint8Array) => at(d) + new DataView(d.buffer).getUint32(at(d) + 32, true) + 8;
        expect(warningsOf((v, d) => v.setUint16(hotspots(d) + 1, 50, true))).toEqual(['bm0’s hotspots run past the end of where they are.']);
        // Its picture renamed bm7: the topic that shows bm0 shows one it doesn't have.
        expect(warningsOf((_v, d) => (d[nameAt(d, '|bm0') + 3] = 0x37))).toEqual(['Its topics show a picture it doesn’t have.']);
    });

    it('refuses what isn’t one', () => {
        expect(() => parse(new Uint8Array(100))).toThrow('This isn’t a Windows Help file: it doesn’t start with 0x00035F3F and a directory that fits in it.');
        const empty = edited((v, d) => {
            const directory = v.getUint32(4, true) + 9;
            v.setUint16(directory + 38 + 2, 0, true);
            v.setUint32(directory + 34, 0, true);
            d.fill(0, directory + 38 + 8, directory + 38 + 200);
        });
        expect(() => parse(empty)).toThrow('This isn’t a Windows Help file: its directory lists no files.');
    });
});

const CNC = gameDir('cncRemastered');
describe.skipIf(!CNC)('the help files in Counterstrike’s folders', () => {
    const open = async (data: Uint8Array, name: string | null) => (await inspect(data, { name, names: [] })).parsed;
    it('reads Westwood Chat’s, phrase-compressed, with RoboHELP’s stamp', async () => {
        const z = await open(new Uint8Array(readFileSync(join(CNC!, 'RED_ALERT/COUNTERSTRIKE/PLANETWW/PLANETWW.Z'))), 'PLANETWW.Z');
        const help = await inspect(z.entries!.find((e) => e.name === 'WCHAT.HLP')!.data, { name: 'WCHAT.HLP', names: [] });
        expect([help.format.id, help.parsed.warnings, help.checks]).toEqual(['winhelp', [], []]);
        expect(summary(help.parsed)).toMatchObject({
            Title: 'Westwood Chat Help',
            Made: '1996-11-08 18:18:07 UTC, with RoboHELP (registered to “Authorized User”)',
            Topics: '17, opening at “Contents”',
        });
        const text = new TextDecoder().decode(help.parsed.entries!.find((e) => e.label === 'WCHAT-topics.txt')!.data);
        expect(text).toContain('■ What is Wchat?\r\n\r\nWhat is Westwood Chat?\r\n');
        expect(text).toContain('The Westwood Chat program allows you to connect to the Westwood chat server');
        // Its contents page: a heading, then a jump to each topic, every one leading to a topic it has.
        const doc = documentOf(help.parsed);
        const links = linksOf(doc);
        expect(links.length).toBe(20);
        expect(links.every((l) => l.page !== undefined)).toBe(true);
        expect(links[0]).toEqual({ text: 'What is Westwood Chat?', page: 1, popup: false, about: 'Opens “What is Wchat?”' });
    });

    it('reads Internet Explorer 3’s, Hall-compressed, with its pictures', async () => {
        const ie = await open(new Uint8Array(readFileSync(join(CNC!, 'RED_ALERT/COUNTERSTRIKE/INTERNET/MSIE/IE301M95.EXE'))), 'IE301M95.EXE');
        const outer = await open(ie.entries!.find((e) => e.label === 'Raw data CABINET.bin')!.data, null);
        const inner = await open(outer.entries!.find((e) => e.name === 'Iexplore.cab')!.data, 'Iexplore.cab');
        const help = await inspect(inner.entries!.find((e) => e.name === 'iexplore.hlp')!.data, { name: 'iexplore.hlp', names: [] });
        expect([help.format.id, help.parsed.warnings, help.checks]).toEqual(['winhelp', [], []]);
        expect(summary(help.parsed)).toMatchObject({ Title: 'Internet Explorer Help', Topics: '161, opening at “Welcome to Internet Explorer”', Index: '571 keywords', Pictures: '12' });
        const text = new TextDecoder().decode(help.parsed.entries!.find((e) => e.label === 'iexplore-topics.txt')!.data);
        expect(text.startsWith('■ Welcome to Internet Explorer\r\n\r\nWelcome to Microsoft Internet Explorer\r\n\r\nThe Internet is a collection of computer networks')).toBe(true);
    });
});
