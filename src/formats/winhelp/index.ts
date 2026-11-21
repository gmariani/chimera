import { Bytes, bytesLabel, field, fillGaps } from '../../core/bytes';
import type { Entry, Field, FormatParser, Preview, TableRow } from '../../core/types';
import { readBtree, stringAt } from './btree';
import { buildDocument } from './document';
import { readFonts, type HelpFonts } from './font';
import { readHallPhrases, readPhrases, type Phrases } from './phrases';
import { readPictures, type HelpPicture } from './pictures';
import { sniffWinHelp } from './sniff';
import { compilerOf, readSystem, type HelpSystem } from './system';
import { readTopics, type Topic } from './topics';

/**
 * Windows Help files (.hlp, WinHelp, 1990–2006): the help of Windows 3.x and 95 programs, Westwood Chat's and Internet
 * Explorer 3's among them. A small file system: a 16-byte header (0x00035F3F, where the directory is, the first free
 * block, the file's size), then internal files, each a 9-byte header (the space it has, the space it uses, flags) and
 * its bytes, found by name in the directory, a B+ tree. |SYSTEM says what it is; |TOPIC holds the topics, |Phrases or
 * |PhrIndex and |PhrImage the phrases their text is shortened with; |TTLBTREE, |CONTEXT and |KWBTREE index the
 * titles, the context names (by hash) and the keywords; |bm0, |bm1... are its pictures. Annotations (.ann) and the
 * index WinHelp builds (.gid) are the same file system with other files in it.
 *
 * Microsoft never published it. This follows helpdeco's helpfile.txt (Manfred Winterhoff, 1997, after Pete Davis's
 * "The Windows Help File Format", Dr. Dobb's Journal, 1993: https://github.com/joncampbell123/helpdeco), and
 * helpdeco's source (GPL 2 or later) where the description leaves a doubt; helpdeco, built from it, is what the
 * topics and pictures were checked against.
 */

interface InternalFile {
    name: string;
    /** Where its 9-byte header is, and its bytes. */
    at: number;
    contentAt: number;
    end: number;
    reserved: number;
}

/** A topic's title, or for one without (a popup, often), its first line. */
const nameOf = (t: Topic) => t.title || `untitled: ${(t.text.split('\n').find((l) => l.trim()) ?? '').trim().slice(0, 60) || 'empty'}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
/** What each internal file holds, in words. */
const ABOUT: Record<string, string> = {
    '|SYSTEM': 'What the help file is: its title, copyright, windows, macros',
    '|TOPIC': 'The topics',
    '|Phrases': 'Phrases the topics’ text is shortened with',
    '|PhrIndex': 'Where each phrase is (Hall compression)',
    '|PhrImage': 'The phrases (Hall compression)',
    '|FONT': 'The fonts the topics use',
    '|CONTEXT': 'Context names (by hash) and the topics they lead to',
    '|CTXOMAP': 'Numbers programs ask for help by, and their topics',
    '|TTLBTREE': 'Topic titles',
    '|KWBTREE': 'Keywords (the index)',
    '|KWDATA': 'The topics each keyword leads to',
    '|KWMAP': 'Where each keyword is, for scrolling the index',
    '|TOMAP': 'Where each topic is (Windows 3.0)',
    '|VIOLA': 'The window each topic opens in',
    '|Petra': 'The source files each topic was compiled from',
    '|TopicId': 'Each topic’s context name',
    '|Rose': 'Keywords that run macros',
};

/**
 * RoboHELP's stamp (Blue Sky Software's help-writing tool): 72 bytes after the help file, past the size its header
 * says, from 0xA72E to 0xA72E again, holding who the copy was registered to and "RoboHELP", each byte inverted. Worked
 * out from Westwood Chat's help files and RealAudio's, which have it; nothing describes it. The name, or null.
 */
function roboHelp(data: Uint8Array, at: number): string | null {
    const tag = (p: number) => data[p] === 0x2e && data[p + 1] === 0xa7 && data[p + 2] === 0 && data[p + 3] === 0;
    if (at + 72 !== data.length || !tag(at) || !tag(at + 68)) return null;
    const inverted = (from: number, to: number) => String.fromCharCode(...[...data.subarray(from, to)].map((v) => v ^ 0xff));
    if (inverted(at + 36, at + 44) !== 'RoboHELP') return null;
    const stop = data.indexOf(0xff, at + 4);
    return new TextDecoder('windows-1252').decode(Uint8Array.from([...data.subarray(at + 4, stop < 0 || stop > at + 36 ? at + 36 : stop)].map((v) => v ^ 0xff)));
}

const parser: FormatParser = {
    parse(data, context) {
        if (!sniffWinHelp(data)) throw new Error('This isn’t a Windows Help file: it doesn’t start with 0x00035F3F and a directory that fits in it.');
        const b = new Bytes(data);
        const warnings: string[] = [];
        const say = (list: string[]) => warnings.push(...list);
        const directoryAt = b.u32(4);
        const freeAt = b.i32(8);
        const size = b.u32(12);
        const stamp = roboHelp(data, size);
        if (size !== data.length && !stamp)
            warnings.push(
                size > data.length
                    ? `It says it’s ${bytesLabel(size)}, but the file is ${bytesLabel(data.length)}: it’s been cut short.`
                    : `It says it’s ${bytesLabel(size)}, less than the file’s ${bytesLabel(data.length)}.`
            );
        const end = stamp ? data.length : Math.min(size, data.length);
        const fields: Field[] = [
            {
                name: 'Header',
                offset: 0,
                length: 16,
                children: [
                    field('Signature', 0, 4, '0x00035F3F'),
                    field('Directory at', 4, 4, directoryAt),
                    field('First free block', 8, 4, freeAt === -1 ? 'none' : freeAt),
                    field('Size', 12, 4, bytesLabel(size)),
                ],
            },
        ];

        /** An internal file's 9-byte header at `at`: its space, its bytes, and the field for it. */
        const internal = (name: string, at: number, about: string, inside: (contentAt: number, end: number) => Field[] = () => []): InternalFile | null => {
            if (at < 16 || at + 9 > end) {
                warnings.push(`Its directory says ${name} is at ${at.toLocaleString('en-US')}, outside the file.`);
                return null;
            }
            const reserved = b.u32(at);
            const used = b.u32(at + 4);
            const contentAt = at + 9;
            let stop = contentAt + used;
            if (stop > end || used + 9 > reserved) {
                warnings.push(`${name} is said to use ${bytesLabel(used)}${stop > end ? ', past the end of the file' : `, more than the ${bytesLabel(reserved)} it has`}.`);
                stop = Math.min(stop, end);
            }
            const kept = Math.min(at + Math.max(reserved, 9 + used), end);
            const children: Field[] = [
                field('Space', at, 4, bytesLabel(reserved), 'Its header included.'),
                field('Used', at + 4, 4, bytesLabel(used)),
                field('Flags', at + 8, 1, data[at + 8]),
                ...fillGaps(data, inside(contentAt, stop), contentAt, stop, 'Data'),
            ];
            if (children.length === 3) children.push(field('Data', contentAt, stop - contentAt, bytesLabel(stop - contentAt)));
            if (kept > stop) children.push(field('Free space', stop, kept - stop, bytesLabel(kept - stop), 'Space it has and doesn’t use.'));
            fields.push({ name, offset: at, length: kept - at, value: about, children });
            return { name, at, contentAt, end: stop, reserved };
        };

        // The directory: each internal file's name and where its header is.
        const files = new Map<string, InternalFile>();
        const listed: { name: string; at: number }[] = [];
        internal('Directory', directoryAt, 'Each internal file’s name and where it is', (from, to) => {
            const tree = readBtree(data, from, to, 'Its directory', (p, stop) => {
                const name = stringAt(data, p, stop);
                if (!name || name.next + 4 > stop) return null;
                listed.push({ name: name.text, at: b.u32(name.next) });
                return { value: name.text, next: name.next + 4, field: field(name.text, p, name.next + 4 - p, b.u32(name.next)) };
            });
            say(tree.problems);
            return tree.fields;
        });
        if (!listed.length) throw new Error('This isn’t a Windows Help file: its directory lists no files.');

        // Each internal file, read for what it holds.
        let system: HelpSystem | null = null;
        const raw = new Map(listed.map((f) => [f.name, f.at]));
        for (const { name, at } of listed) {
            if (name === '|SYSTEM') {
                const f = internal(name, at, ABOUT[name], (from, to) => {
                    system = readSystem(data, from, to);
                    say(system.problems);
                    return system.fields;
                });
                if (f) files.set(name, f);
            }
        }
        const sys = system as HelpSystem | null;
        let fonts: HelpFonts | null = null;
        if (raw.has('|FONT')) {
            const f = internal('|FONT', raw.get('|FONT')!, ABOUT['|FONT'], (from, to) => {
                fonts = readFonts(data, from, to);
                say(fonts.problems);
                return fonts.fields;
            });
            if (f) files.set('|FONT', f);
        }
        const fontList = fonts as HelpFonts | null;
        let phrases: Phrases | null = null;
        if (raw.has('|Phrases')) {
            const f = internal('|Phrases', raw.get('|Phrases')!, ABOUT['|Phrases'], (from, to) => {
                phrases = readPhrases(data, from, to, (sys?.minor ?? 21) > 16);
                say(phrases.problems);
                return phrases.fields;
            });
            if (f) files.set('|Phrases', f);
        } else if (raw.has('|PhrIndex') && raw.has('|PhrImage')) {
            const image = internal('|PhrImage', raw.get('|PhrImage')!, ABOUT['|PhrImage']);
            if (image) {
                files.set('|PhrImage', image);
                const f = internal('|PhrIndex', raw.get('|PhrIndex')!, ABOUT['|PhrIndex'], (from, to) => {
                    phrases = readHallPhrases(data, from, to, image.contentAt, image.end);
                    say(phrases.problems);
                    return phrases.fields;
                });
                if (f) files.set('|PhrIndex', f);
            }
        }

        let topics: Topic[] = [];
        let endOffset = -1;
        const embedded: { topic: string; data: Uint8Array }[] = [];
        const titles = new Map<number, string>();
        const contexts: { hash: number; offset: number }[] = [];
        const keywords: { index: string; keyword: string; offsets: number[] }[] = [];
        const maps: { id: number; offset: number }[] = [];
        const macros: string[] = [];
        const pictures: { name: string; picture: HelpPicture }[] = [];
        const extra: { name: string; values: { offset: number; text: string }[] }[] = [];
        const keywordData = new Map<string, InternalFile>();
        for (const { name, at } of listed) {
            if (files.has(name) || name === '|PhrImage' || name === '|PhrIndex') continue;
            let f: InternalFile | null = null;
            if (name === '|TOPIC') {
                f = internal(name, at, ABOUT[name], (from, to) => {
                    if (!sys) {
                        warnings.push('It has topics but no |SYSTEM file to say how they’re packed: they aren’t read.');
                        return [];
                    }
                    const t = readTopics(data, from, to, sys.minor, sys.flags, phrases, fontList?.unit);
                    topics = t.topics;
                    endOffset = t.endOffset;
                    embedded.push(...t.embedded);
                    say(t.problems);
                    return t.fields;
                });
            } else if (name === '|TTLBTREE' || name === '|TopicId' || name === '|Petra') {
                f = internal(name, at, ABOUT[name], (from, to) => {
                    const values: { offset: number; text: string }[] = [];
                    const tree = readBtree(data, from, to, name, (p, stop) => {
                        const text = p + 4 <= stop ? stringAt(data, p + 4, stop) : null;
                        if (!text) return null;
                        values.push({ offset: b.u32(p), text: text.text });
                        return { value: null, next: text.next, field: field(text.text || '(no title)', p, text.next - p, `0x${b.u32(p).toString(16)}`) };
                    });
                    say(tree.problems);
                    if (name === '|TTLBTREE') for (const v of values) titles.set(v.offset, v.text);
                    else extra.push({ name, values });
                    return tree.fields;
                });
            } else if (name === '|CONTEXT') {
                f = internal(name, at, ABOUT[name], (from, to) => {
                    const tree = readBtree(data, from, to, name, (p, stop) => {
                        if (p + 8 > stop) return null;
                        contexts.push({ hash: b.u32(p), offset: b.u32(p + 4) });
                        return { value: null, next: p + 8 };
                    });
                    say(tree.problems);
                    return tree.fields;
                });
            } else if (/^\|[A-Za-z0-9]K?WBTREE$/.test(name)) {
                f = internal(name, at, name === '|KWBTREE' ? ABOUT[name] : `Keywords of the index ${name[1]}`, (from, to) => {
                    const tree = readBtree(data, from, to, name, (p, stop) => {
                        const word = stringAt(data, p, stop);
                        if (!word || word.next + 6 > stop) return null;
                        keywords.push({ index: name.slice(1, -6), keyword: word.text, offsets: [b.u16(word.next), b.u32(word.next + 2)] });
                        return { value: null, next: word.next + 6, field: field(word.text, p, word.next + 6 - p, `${b.u16(word.next)} topic${b.u16(word.next) === 1 ? '' : 's'}`) };
                    });
                    say(tree.problems);
                    return tree.fields;
                });
            } else if (/^\|[A-Za-z0-9]K?WDATA$/.test(name)) {
                f = internal(name, at, name === '|KWDATA' ? ABOUT[name] : `The topics each keyword of the index ${name[1]} leads to`);
                // |KWDATA for |KWBTREE's keywords: both by the index's letter, "K" (or "A", or a multimedia file's "0K").
                if (f) keywordData.set(name.slice(1, -5), f);
            } else if (name === '|CTXOMAP') {
                f = internal(name, at, ABOUT[name], (from, to) => {
                    const n = Math.min(b.u16(from), Math.floor((to - from - 2) / 8));
                    for (let i = 0; i < n; i++) maps.push({ id: b.u32(from + 2 + i * 8), offset: b.u32(from + 6 + i * 8) });
                    return [field('Entries', from, 2, b.u16(from)), field('Numbers and topics', from + 2, n * 8, `${n}`)];
                });
            } else if (/^\|CF\d+$/.test(name)) {
                f = internal(name, at, `Macros of a [CONFIG:${name.slice(3)}] section`, (from, to) => {
                    const list = new TextDecoder('windows-1252').decode(data.subarray(from, to)).split('\0').filter(Boolean);
                    macros.push(...list);
                    return [field('Macros', from, to - from, list.join('; ').slice(0, 200))];
                });
            } else if (/^\|?bm\d+$/.test(name)) {
                f = internal(name, at, 'A picture', (from, to) => {
                    const r = readPictures(data, from, to, name.replace('|', ''));
                    say(r.problems);
                    for (const picture of r.pictures) pictures.push({ name: name.replace('|', ''), picture });
                    return r.fields;
                });
            } else f = internal(name, at, ABOUT[name] ?? (name.startsWith('|') ? 'An internal file this reader doesn’t know' : 'A file kept in it (baggage)'));
            if (f) files.set(name, f);
        }

        if (stamp)
            fields.push({
                name: 'RoboHELP’s stamp',
                offset: size,
                length: 72,
                value: `registered to “${stamp}”`,
                note: 'Added after the help file by RoboHELP, the tool it was written with: who the copy was registered to, and its name, each byte inverted.',
            });

        // The free list: blocks the compiler left unused, each saying how big it is and where the next is.
        const freeSeen = new Set<number>();
        for (let p = freeAt; p !== -1 && p >= 16 && p + 8 <= end && !freeSeen.has(p) && freeSeen.size < 100000;) {
            freeSeen.add(p);
            const space = b.u32(p);
            fields.push({
                name: 'Free block',
                offset: p,
                length: Math.min(Math.max(8, space), end - p),
                value: bytesLabel(space),
                children: [field('Size', p, 4, bytesLabel(space)), field('Next', p + 4, 4, b.i32(p + 4))],
            });
            p = b.i32(p + 4);
        }

        // What leads where: topics in order of where they start, and the topic an offset is in.
        const sorted = [...topics].sort((x, y) => x.offset - y.offset);
        const topicAt = (offset: number) => {
            let lo = 0;
            let hi = sorted.length - 1;
            let hit: Topic | null = null;
            while (lo <= hi) {
                const mid = (lo + hi) >> 1;
                if (sorted[mid].offset <= offset) {
                    hit = sorted[mid];
                    lo = mid + 1;
                } else hi = mid - 1;
            }
            return hit;
        };
        if (topics.length) {
            // The title index has one more, empty, where the chain of records ends.
            const starts = new Set(topics.map((t) => t.offset));
            const lost = [...titles].filter(([o, text]) => !starts.has(o) && !(o === endOffset && !text)).length;
            if (lost) warnings.push(`${plural(lost, 'title')} in its title index ${lost === 1 ? 'points' : 'point'} where no topic starts.`);
            for (const t of topics) if (!t.title && titles.has(t.offset)) t.title = titles.get(t.offset)!;
        }
        // Each keyword's topics, from its data file.
        const keywordRows: TableRow[] = [];
        for (const k of keywords) {
            const file = keywordData.get(k.index);
            const [count, at] = k.offsets;
            const leads: string[] = [];
            if (file) for (let i = 0; i < count && file.contentAt + at + i * 4 + 4 <= file.end; i++) leads.push(((t) => (t ? nameOf(t) : '?'))(topicAt(b.u32(file.contentAt + at + i * 4))));
            keywordRows.push({ group: k.index === 'K' ? 'Keywords' : `Index ${k.index}`, cells: { keyword: k.keyword, topics: leads.join(', ') || `${count}` } });
        }

        // What to show: the topics as WinHelp laid them out, the keywords, the pictures.
        const items: { title: string; preview: Preview }[] = [];
        const contents = sys?.contents !== undefined ? topicAt(sys.contents) : null;
        if (topics.length) {
            const doc = buildDocument({
                title: sys?.title || (context.name ?? 'Help').replace(/^.*[\\/]/, ''),
                topics,
                start: contents ? topics.indexOf(contents) : 0,
                nameOf,
                topicAt,
                contexts,
                styles: fontList?.styles ?? [],
                pictures,
                bmFiles: new Set(listed.filter((l) => /^\|?bm\d+$/.test(l.name)).map((l) => Number(l.name.replace(/^\D+/, '')))),
                embedded,
                window: sys?.windows.find((w) => w.name.toLowerCase() === 'main') ?? sys?.windows.find((w) => !w.name),
            });
            say(doc.problems);
            items.push({ title: `Topics (${topics.length.toLocaleString('en-US')})`, preview: doc.preview });
        }
        if (keywordRows.length)
            items.push({
                title: `Index (${keywordRows.length.toLocaleString('en-US')} keywords)`,
                preview: {
                    kind: 'table',
                    columns: [
                        { key: 'keyword', label: 'Keyword' },
                        { key: 'topics', label: 'Topics' },
                    ],
                    groups: [...new Set(keywordRows.map((r) => r.group))],
                    rows: keywordRows,
                },
            });
        for (const { name, picture } of pictures)
            if (picture.rgba)
                items.push({
                    title: `${name}: ${picture.width} × ${picture.height}, ${picture.about}${picture.hotspots.length ? `, ${plural(picture.hotspots.length, 'hotspot')}` : ''}`,
                    preview: { kind: 'picture', width: picture.width, height: picture.height, rgba: picture.rgba },
                });

        const stem = (context.name ?? context.label ?? 'help').replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '');
        const entries: Entry[] = [];
        if (topics.length) {
            const text = new TextEncoder().encode(topics.map((t) => `■ ${nameOf(t)}\r\n\r\n${t.text.replace(/\n/g, '\r\n')}`).join('\r\n\r\n\r\n'));
            entries.push({ name: null, label: `${stem}-topics.txt`, offset: files.get('|TOPIC')?.contentAt ?? 0, size: text.length, data: text, meta: { Type: 'The topics, as text' } });
        }
        for (const { name, picture } of pictures)
            if (picture.file)
                entries.push({
                    name: null,
                    label: `${stem}-${name}.${picture.kind === 'bitmap' ? 'bmp' : 'wmf'}`,
                    offset: files.get(`|${name}`)?.contentAt ?? files.get(name)?.contentAt ?? 0,
                    size: picture.file.length,
                    data: picture.file,
                    meta: { Type: `Picture ${name}` },
                });
        if (sys?.icon) entries.push({ name: null, label: `${stem}-icon.ico`, offset: 0, size: sys.icon.length, data: sys.icon, format: 'ico' });
        embedded.forEach((e, i) => entries.push({ name: null, label: `${stem}-picture-${i + 1}.shg`, offset: 0, size: e.data.length, data: e.data, meta: { Type: `In the topic “${e.topic}”` } }));
        for (const f of files.values())
            if (f.name !== 'Directory')
                entries.push({
                    name: null,
                    label: `${f.name.replace(/^\|/, '')}.bin`,
                    offset: f.contentAt,
                    size: f.end - f.contentAt,
                    data: data.subarray(f.contentAt, f.end),
                    meta: { Type: f.name.startsWith('|') ? 'Internal file' : 'Baggage' },
                });

        const title = sys ? `Windows Help file (${compilerOf(sys.minor)})` : 'Windows Help file system (annotations, or WinHelp’s index)';
        return {
            title,
            summary: [
                ...(sys?.title ? [['Title', sys.title] as [string, string]] : []),
                ...(sys?.copyright ? [['Copyright', sys.copyright] as [string, string]] : []),
                ...(sys?.made ? [['Made', `${sys.made}${stamp ? `, with RoboHELP (registered to “${stamp}”)` : ''}`] as [string, string]] : []),
                ...(topics.length ? [['Topics', `${topics.length.toLocaleString('en-US')}${contents ? `, opening at “${nameOf(contents)}”` : ''}`] as [string, string]] : []),
                ...(keywordRows.length ? [['Index', plural(keywordRows.length, 'keyword')] as [string, string]] : []),
                ...(pictures.length ? [['Pictures', `${pictures.length}`] as [string, string]] : []),
                ...(phrases
                    ? [
                          [
                              'Compression',
                              `${(phrases as Phrases).hall ? 'Hall' : 'phrases'} (${plural((phrases as Phrases).list.length, 'phrase')})${sys && (sys.flags === 4 || sys.flags === 8) ? ', LZ77' : ''}`,
                          ] as [string, string],
                      ]
                    : sys && (sys.flags === 4 || sys.flags === 8)
                      ? [['Compression', 'LZ77'] as [string, string]]
                      : []),
                ...(sys?.windows.length ? [['Windows', sys.windows.map((w) => w.name || 'main').join(', ')] as [string, string]] : []),
                ...(sys?.macros.length || macros.length ? [['Macros on opening', [...(sys?.macros ?? []), ...macros].join('; ')] as [string, string]] : []),
                ...(contexts.length
                    ? [['Context names', `${contexts.length.toLocaleString('en-US')} (as hashes)${maps.length ? `, ${plural(maps.length, 'map number')}` : ''}`] as [string, string]]
                    : []),
                ['Internal files', `${files.size}`],
            ],
            fields: fillGaps(data, fields, 0, end, 'Not in any internal file'),
            preview: items.length === 1 ? items[0].preview : items.length ? { kind: 'stack', items } : undefined,
            entries,
            end,
            warnings,
        };
    },
};

export default parser;
