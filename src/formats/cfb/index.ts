import { Bytes, bytesLabel, field, fileTime, hex } from '../../core/bytes';
import { checkBytes } from '../../core/limits';
import type { Entry, Field, FormatParser, Preview } from '../../core/types';
import { readPropertySets } from './properties';
import { sniffCfb } from './sniff';
import { readWordText, type WordText } from './word';

/**
 * Compound files (OLE structured storage, "compound documents"): a file system in a file, of storages (folders) and
 * streams (files). Word, Excel and PowerPoint's documents up to 2003 (.doc, .xls, .ppt), Windows Installer packages
 * (.msi), Outlook messages (.msg), Thumbs.db, and Tiberian Sun's and Red Alert 2's saved games are compound files.
 *
 * A 512-byte header (the signature D0 CF 11 E0 A1 B1 1A E1, version 3 or 4, the sector size, where the directory
 * starts, how many sectors the FAT takes and where its first 109 are), then sectors of 512 bytes (4,096 for version 4),
 * the header being sector -1. The FAT (file allocation table) gives each sector the next one of its chain, or the end
 * of it; the DIFAT lists the FAT's own sectors past the 109 the header has room for. The directory is a chain of
 * 128-byte entries: a name, a type (storage, stream, or the root), a red-black tree of siblings and each storage's
 * first child, a class ID, times, the first sector and the size. Streams under 4,096 bytes are kept in 64-byte mini
 * sectors inside one stream (the root's), chained by the mini FAT.
 *
 * Every chain is followed only as far as the file goes, and a sector claimed twice ends the chain that comes second:
 * a file can loop its chains, or point two streams at one place, to hide one.
 *
 * See [MS-CFB], "Compound File Binary File Format" (https://learn.microsoft.com/openspecs/windows_protocols/ms-cfb).
 */

const FREE = 0xffffffff;
const END = 0xfffffffe;
const FAT_SECTOR = 0xfffffffd;
const DIFAT_SECTOR = 0xfffffffc;
/** The highest number a sector can have: past it, the numbers mean the markers above. */
const LAST_SECTOR = 0xfffffffa;
const NO_STREAM = 0xffffffff;
const TYPES = ['unused', 'storage', 'stream', 'lock bytes', 'property', 'root'];
/** Stretches of sectors past this many aren't listed one by one. */
const MOST_FIELDS = 2000;
/** Directory entries past this many aren't broken into their parts. */
const MOST_DETAILED = 500;

interface DirEntry {
    index: number;
    /** Where it is in the file. */
    at: number;
    name: string;
    type: number;
    left: number;
    right: number;
    child: number;
    clsid: string;
    start: number;
    size: number;
    path: string;
    reached: boolean;
}

/** Control characters at the start of a name (\x01CompObj, \x05SummaryInformation) as 7-Zip shows them: [1]CompObj. */
const shown = (name: string) => Array.from(name, (c) => (c < ' ' ? `[${c.charCodeAt(0)}]` : c)).join('');

const guidText = (data: Uint8Array, at: number) => {
    const b = new Bytes(data);
    const h = (v: number, n: number) => hex(v, n);
    const tail = Array.from(data.subarray(at + 8, at + 16), (v) => v.toString(16).padStart(2, '0').toUpperCase()).join('');
    return `{${h(b.u32(at), 8)}-${h(b.u16(at + 4), 4)}-${h(b.u16(at + 6), 4)}-${tail.slice(0, 4)}-${tail.slice(4)}}`;
};
const NO_CLASS = '{00000000-0000-0000-0000-000000000000}';
/** Class IDs some programs give the root, saying what the file is. */
const CLASSES: Record<string, string> = {
    '{000C1084-0000-0000-C000-000000000046}': 'Windows Installer package (MSI)',
    '{000C1086-0000-0000-C000-000000000046}': 'Windows Installer patch (MSP)',
    '{000C1082-0000-0000-C000-000000000046}': 'Windows Installer transform (MST)',
    '{00020906-0000-0000-C000-000000000046}': 'Word document',
    '{00020820-0000-0000-C000-000000000046}': 'Excel workbook',
    '{64818D10-4F9B-11CF-86EA-00AA00B929E8}': 'PowerPoint presentation',
};

const parser: FormatParser = {
    parse(data, context) {
        if (!sniffCfb(data)) throw new Error('This isn’t a compound file: it doesn’t start with D0 CF 11 E0 A1 B1 1A E1 and a header for version 3 or 4, with 512- or 4,096-byte sectors.');
        const b = new Bytes(data);
        const warnings: string[] = [];
        const minor = b.u16(24);
        const major = b.u16(26);
        const shift = b.u16(30);
        const ss = 1 << shift;
        const miniShift = b.u16(32);
        const dirSectors = b.u32(40);
        const fatCount = b.u32(44);
        const dirStart = b.u32(48);
        const cutoffSaid = b.u32(56);
        const miniFatStart = b.u32(60);
        const miniFatCount = b.u32(64);
        const difatStart = b.u32(68);
        const difatCount = b.u32(72);
        const clsid = guidText(data, 8);
        if (shift !== (major === 3 ? 9 : 12))
            warnings.push(`It’s version ${major}, whose sectors are ${major === 3 ? 512 : '4,096'} bytes, but it says its sectors are ${ss.toLocaleString('en-US')}.`);
        if (clsid !== NO_CLASS) warnings.push(`Its header has a class ID (${clsid}) where a compound file has zeros.`);
        if (miniShift !== 6) warnings.push(`It says its mini sectors are ${2 ** Math.min(miniShift, 31)} bytes; they’re always 64, and are read so here.`);
        if (data.subarray(34, 40).some((v) => v)) warnings.push('The 6 reserved bytes of its header aren’t zeros.');
        if (major === 3 && dirSectors) warnings.push(`It says its directory takes ${dirSectors.toLocaleString('en-US')} sectors, but version 3 leaves that 0.`);
        if (cutoffSaid !== 4096) warnings.push(`It says streams under ${cutoffSaid.toLocaleString('en-US')} bytes are kept in mini sectors; it’s always 4,096, and is read so here.`);
        if (major === 4 && data.subarray(512, Math.min(data.length, 4096)).some((v) => v)) warnings.push('The rest of its 4,096-byte header, after the first 512 bytes, isn’t zeros.');
        const cutoff = 4096;
        const MINI = 64;

        // The sectors in the file, counting one cut short at the end.
        const total = data.length > ss ? Math.ceil((data.length - ss) / ss) : 0;
        const at = (s: number) => (s + 1) * ss;
        /** What each sector is, by number: an index into `owners`, or -1. */
        const owner = new Int32Array(total).fill(-1);
        const owners: string[] = [];
        const ownerOf = (label: string) => {
            const i = owners.indexOf(label);
            return i >= 0 ? i : owners.push(label) - 1;
        };
        let cut = 0;
        /** A sector's bytes, or as many as the file has; `need` is how many of them have to be there. */
        const sector = (s: number, need = ss) => {
            if (at(s) + need > data.length) cut++;
            return data.subarray(at(s), Math.min(data.length, at(s) + ss));
        };
        const claimed = (s: number, label: string): string | null => {
            if (owner[s] >= 0) return owners[owner[s]];
            owner[s] = ownerOf(label);
            return null;
        };

        // The FAT's sectors: the first 109 in the header, the rest in the DIFAT's chain.
        const fatSectors: number[] = [];
        for (let i = 0; i < 109; i++) {
            const s = b.u32(76 + i * 4);
            if (s === FREE) continue;
            fatSectors.push(s);
        }
        const difatSectors: number[] = [];
        for (let s = difatStart, i = 0; s <= LAST_SECTOR && i < difatCount; i++) {
            if (s >= total) {
                warnings.push(`Its DIFAT goes on to sector ${s.toLocaleString('en-US')}, past the end of the file.`);
                break;
            }
            const twice = claimed(s, 'DIFAT');
            if (twice) {
                warnings.push(`Its DIFAT runs into sector ${s.toLocaleString('en-US')}, which is ${twice === 'DIFAT' ? 'already in it: it loops' : `part of ${twice}`}.`);
                break;
            }
            difatSectors.push(s);
            const d = new Bytes(sector(s));
            for (let j = 0; j < ss / 4 - 1; j++) {
                const f = d.u32(j * 4);
                if (f !== FREE) fatSectors.push(f);
            }
            s = d.u32(ss - 4);
        }
        if (difatSectors.length !== difatCount)
            warnings.push(`Its header says its DIFAT takes ${difatCount.toLocaleString('en-US')} sectors, but ${difatSectors.length.toLocaleString('en-US')} were found.`);
        const fatHere: number[] = [];
        for (const s of fatSectors) {
            if (s > LAST_SECTOR || s >= total) {
                warnings.push(`Its FAT is said to have a sector at ${s > LAST_SECTOR ? `0x${hex(s)}, which isn’t a sector` : `${s.toLocaleString('en-US')}, past the end of the file`}.`);
                continue;
            }
            const twice = claimed(s, 'FAT');
            if (twice) {
                warnings.push(`Sector ${s.toLocaleString('en-US')} is listed as part of the FAT, but it’s ${twice === 'FAT' ? 'listed twice' : `part of ${twice}`}.`);
                continue;
            }
            fatHere.push(s);
        }
        if (fatSectors.length !== fatCount) warnings.push(`Its header says its FAT takes ${fatCount.toLocaleString('en-US')} sectors, but it lists ${fatSectors.length.toLocaleString('en-US')}.`);
        const fat = new Uint32Array(fatHere.length * (ss / 4)).fill(FREE);
        fatHere.forEach((s, i) => {
            const d = new Bytes(sector(s));
            for (let j = 0; j < ss / 4 && j * 4 + 4 <= d.length; j++) fat[i * (ss / 4) + j] = d.u32(j * 4);
        });
        const unmarked = [...fatHere.filter((s) => s < fat.length && fat[s] !== FAT_SECTOR), ...difatSectors.filter((s) => s < fat.length && fat[s] !== DIFAT_SECTOR)];
        if (unmarked.length) warnings.push(`${unmarked.length.toLocaleString('en-US')} of the FAT’s and DIFAT’s own sectors aren’t marked as theirs in the FAT.`);

        /** A chain of sectors from `start`, for `label`: as far as it goes inside the file and doesn't run into another. */
        const follow = (start: number, label: string, table: Uint32Array, owned: Int32Array, small: boolean): number[] => {
            const chain: number[] = [];
            const what = small ? 'mini sector' : 'sector';
            let s = start;
            while (s <= LAST_SECTOR) {
                if (s >= owned.length || s >= table.length) {
                    warnings.push(`${label} goes on to ${what} ${s.toLocaleString('en-US')}, past the end of ${small ? 'the mini stream' : 'the file'}: what’s past it is lost.`);
                    return chain;
                }
                if (owned[s] >= 0) {
                    const other = owners[owned[s]];
                    warnings.push(`${label} runs into ${what} ${s.toLocaleString('en-US')}, which is ${other === label ? 'already part of it: its chain loops' : `part of ${other}`}.`);
                    return chain;
                }
                owned[s] = ownerOf(label);
                chain.push(s);
                s = table[s];
            }
            if (s !== END) warnings.push(`${label}’s chain ends with 0x${hex(s)}, not the end-of-chain mark.`);
            return chain;
        };

        // The directory.
        const dirChain = follow(dirStart, 'The directory', fat, owner, false);
        const dirBytes = dirChain.length * (ss / 128);
        const entries: DirEntry[] = [];
        for (let i = 0; i < dirBytes; i++) {
            const s = dirChain[Math.floor((i * 128) / ss)];
            const e = at(s) + ((i * 128) % ss);
            if (e + 128 > data.length) break;
            const nameLength = b.u16(e + 64);
            const type = data[e + 66];
            const name = new TextDecoder('utf-16le').decode(data.subarray(e, e + Math.min(64, nameLength))).replace(/\0.*$/s, '');
            entries.push({
                index: i,
                at: e,
                name,
                type,
                left: b.u32(e + 68),
                right: b.u32(e + 72),
                child: b.u32(e + 76),
                clsid: guidText(data, e + 80),
                start: b.u32(e + 116),
                // Version 3 has only the low 32 bits of the size: Windows' own code once wrote anything in the high ones.
                size: major === 3 ? b.u32(e + 120) : b.u32(e + 120) + b.u32(e + 124) * 2 ** 32,
                path: shown(name),
                reached: false,
            });
            if (type > 5 || type === 3 || type === 4) warnings.push(`Directory entry ${i} is of type ${type}, which isn’t a storage, a stream or the root.`);
            else if (type && (nameLength > 64 || nameLength % 2 || !nameLength))
                warnings.push(`Directory entry ${i} (“${shown(name)}”) says its name is ${nameLength} bytes, which isn’t an even number from 2 to 64.`);
        }
        const root = entries[0];
        if (!root || root.type !== 5) throw new Error('This isn’t a compound file that can be read: its directory doesn’t start with the root.');

        // The tree, from the root: each storage's children, and their siblings to the left and right.
        const visit = (index: number, parent: string, depth: number) => {
            const stack = [index];
            while (stack.length) {
                const i = stack.pop()!;
                if (i === NO_STREAM) continue;
                const e = entries[i];
                if (!e || !e.type) {
                    warnings.push(`The directory’s tree points to entry ${i.toLocaleString('en-US')}, which ${e ? 'is unused' : 'isn’t there'}.`);
                    continue;
                }
                if (e.reached || e === root) {
                    warnings.push(`The directory’s tree reaches entry ${i.toLocaleString('en-US')} (“${shown(e.name)}”) twice: it loops.`);
                    continue;
                }
                e.reached = true;
                e.path = parent ? `${parent}/${shown(e.name)}` : shown(e.name);
                stack.push(e.right, e.left);
                if (e.type === 1) {
                    if (depth > 32) warnings.push(`The storages go more than 32 deep, at “${e.path}”: what’s inside it isn’t listed.`);
                    else visit(e.child, e.path, depth + 1);
                } else if (e.child !== NO_STREAM) warnings.push(`The stream “${e.path}” says it has a child; only storages do.`);
            }
        };
        visit(root.child, '', 0);
        const unreached = entries.filter((e) => e.type && e !== root && !e.reached);
        if (unreached.length)
            warnings.push(
                `${unreached.length.toLocaleString('en-US')} of its directory’s entries aren’t in its tree, so Windows doesn’t show them: ${unreached
                    .slice(0, 5)
                    .map((e) => `“${shown(e.name)}”`)
                    .join(', ')}${unreached.length > 5 ? '…' : ''}. They’re listed under Contents.`
            );

        // The mini stream (the root's data) and the mini FAT.
        const miniStreamChain = follow(root.start, 'The mini stream', fat, owner, false);
        const miniStream = new Uint8Array(Math.min(root.size, miniStreamChain.length * ss));
        miniStreamChain.forEach((s, i) => {
            const want = Math.min(ss, miniStream.length - i * ss);
            if (want > 0) miniStream.set(sector(s, want).subarray(0, want), i * ss);
        });
        if (root.size > miniStreamChain.length * ss) warnings.push(`The mini stream says it’s ${bytesLabel(root.size)}, but its sectors hold ${bytesLabel(miniStreamChain.length * ss)}.`);
        const miniFatChain = follow(miniFatStart, 'The mini FAT', fat, owner, false);
        if (miniFatChain.length !== miniFatCount)
            warnings.push(`Its header says its mini FAT takes ${miniFatCount.toLocaleString('en-US')} sectors, but its chain has ${miniFatChain.length.toLocaleString('en-US')}.`);
        const miniFat = new Uint32Array(miniFatChain.length * (ss / 4)).fill(FREE);
        miniFatChain.forEach((s, i) => {
            const d = new Bytes(sector(s));
            for (let j = 0; j < ss / 4 && j * 4 + 4 <= d.length; j++) miniFat[i * (ss / 4) + j] = d.u32(j * 4);
        });
        const miniOwner = new Int32Array(Math.floor(miniStream.length / MINI)).fill(-1);

        // Each stream's bytes.
        const streams = new Map<DirEntry, { data: Uint8Array; offset: number }>();
        for (const e of entries) {
            if (e.type !== 2) continue;
            const label = `“${e.path}”`;
            const small = e.size < cutoff;
            const unit = small ? MINI : ss;
            const chain = e.size ? follow(e.start, label, small ? miniFat : fat, small ? miniOwner : owner, small) : [];
            const room = chain.length * unit;
            if (room < e.size) warnings.push(`${label} says it’s ${bytesLabel(e.size)}, but its ${small ? 'mini sectors' : 'sectors'} hold ${bytesLabel(room)}: the rest is lost.`);
            else if (room - e.size >= unit)
                warnings.push(`${label} has ${Math.floor((room - e.size) / unit).toLocaleString('en-US')} more ${small ? 'mini sectors' : 'sectors'} than its ${bytesLabel(e.size)} take.`);
            const out = new Uint8Array(checkBytes(Math.min(e.size, room), `The stream ${label}`));
            chain.forEach((s, i) => {
                const want = Math.min(unit, out.length - i * unit);
                if (want <= 0) return;
                const from = small ? miniStream.subarray(s * MINI, s * MINI + want) : sector(s, want).subarray(0, want);
                out.set(from, i * unit);
            });
            const first = chain[0];
            const offset = first === undefined ? 0 : small ? miniOffset(first * MINI) : at(first);
            streams.set(e, { data: out, offset });
        }
        /** Where a place in the mini stream is in the file. */
        function miniOffset(p: number) {
            const s = miniStreamChain[Math.floor(p / ss)];
            return s === undefined ? 0 : at(s) + (p % ss);
        }
        // A file cut short partway through its last sector is fine if nothing in it is lost: Tiberian Sun's and Red
        // Alert 2's saved games end right after their last stream's last byte, short of a whole sector.
        if (cut) warnings.push('The file ends partway through a sector that has to be there whole: what’s in it is lost.');

        // What each sector is, in stretches.
        let lastUsed = -1;
        for (let s = 0; s < Math.min(total, fat.length); s++) if (fat[s] !== FREE || owner[s] >= 0) lastUsed = s;
        for (let s = fat.length; s < total; s++) if (owner[s] >= 0) lastUsed = s;
        const end = Math.min(data.length, at(lastUsed + 1));
        let stray = 0;
        const runs: { label: string; from: number; to: number }[] = [];
        for (let s = 0; s <= lastUsed; s++) {
            let label = owner[s] >= 0 ? owners[owner[s]] : s < fat.length && fat[s] !== FREE ? 'Not used' : 'Free';
            if (label === 'Not used') stray++;
            if (label.startsWith('“')) label = `Stream ${label}`;
            const last = runs[runs.length - 1];
            if (last && last.label === label && last.to === s - 1) last.to = s;
            else runs.push({ label, from: s, to: s });
        }
        if (stray)
            warnings.push(
                `${stray.toLocaleString('en-US')} sector${stray === 1 ? ' is' : 's are'} marked in use in the FAT, but ${stray === 1 ? 'isn’t' : 'aren’t'} part of anything its directory lists.`
            );

        const headerFields: Field[] = [
            field('Signature', 0, 8, 'D0 CF 11 E0 A1 B1 1A E1'),
            field('Class ID', 8, 16, clsid === NO_CLASS ? 'none' : clsid, 'Always zeros.'),
            field('Minor version', 24, 2, `0x${hex(minor, 4)}`, minor === 0x3e ? undefined : 'Usually 0x003E.'),
            field('Version', 26, 2, major, major === 3 ? '512-byte sectors.' : '4,096-byte sectors.'),
            field('Byte order', 28, 2, '0xFFFE', 'Always 0xFFFE: the numbers are little-endian.'),
            field('Sector size', 30, 2, `${ss.toLocaleString('en-US')} bytes`, `As a power of 2: ${shift}.`),
            field('Mini sector size', 32, 2, `${2 ** Math.min(miniShift, 31)} bytes`, `As a power of 2: ${miniShift}.`),
            field('Reserved', 34, 6, bytesLabel(6)),
            field('Directory sectors', 40, 4, dirSectors, major === 3 ? 'Always 0 for version 3.' : undefined),
            field('FAT sectors', 44, 4, fatCount),
            field('Directory starts', 48, 4, sectorName(dirStart)),
            field('Transaction number', 52, 4, b.u32(52), 'For saving with transactions; usually 0.'),
            field('Mini stream cutoff', 56, 4, bytesLabel(cutoffSaid), 'Streams smaller than this are kept in mini sectors.'),
            field('Mini FAT starts', 60, 4, sectorName(miniFatStart)),
            field('Mini FAT sectors', 64, 4, miniFatCount),
            field('DIFAT starts', 68, 4, sectorName(difatStart)),
            field('DIFAT sectors', 72, 4, difatCount),
            field('FAT sectors (first 109)', 76, 436, fatSectors.slice(0, 109).join(', ') || 'none'),
        ];
        const fields: Field[] = [{ name: 'Header', offset: 0, length: Math.min(ss, data.length), value: `version ${major}`, children: headerFields }];
        const detailed = entries.length <= MOST_DETAILED;
        for (const [i, r] of runs.entries()) {
            if (i === MOST_FIELDS - 1) {
                const rest = runs.slice(i);
                const from = at(rest[0].from);
                fields.push(
                    field(
                        'The rest',
                        from,
                        end - from,
                        `sectors ${rest[0].from.toLocaleString('en-US')} to ${lastUsed.toLocaleString('en-US')}`,
                        `In ${rest.length.toLocaleString('en-US')} stretches, too many to list.`
                    )
                );
                break;
            }
            const from = at(r.from);
            const to = Math.min(end, at(r.to + 1));
            const f: Field = {
                name: r.label,
                offset: from,
                length: to - from,
                value: r.from === r.to ? `sector ${r.from.toLocaleString('en-US')}` : `sectors ${r.from.toLocaleString('en-US')} to ${r.to.toLocaleString('en-US')}`,
            };
            if (r.label === 'The directory' && detailed) f.children = entries.filter((e) => e.at >= from && e.at < to).map((e) => dirField(data, e));
            if (r.label === 'Free') f.note = 'Not in use: the FAT marks them free.';
            if (r.label === 'Not used') f.note = 'The FAT marks them in use, but nothing the directory lists is in them.';
            if (r.label === 'The mini stream') f.note = 'Where the streams under 4,096 bytes are, in 64-byte mini sectors.';
            fields.push(f);
        }

        // What the file holds.
        const byPath = new Map([...streams].map(([e, s]) => [e.path, s.data]));
        const list: Entry[] = [];
        for (const [e, s] of streams) {
            const label = e.reached ? e.path : `(not in the tree) ${shown(e.name)}`;
            const properties = e.name === '\x05SummaryInformation' || e.name === '\x05DocumentSummaryInformation';
            list.push({ name: label, label, offset: s.offset, size: s.data.length, data: s.data, ...(properties ? { format: 'ole-properties' } : {}) });
        }

        const summary: [string, string][] = [];
        const info: Record<string, string> = {};
        for (const name of ['[5]SummaryInformation', '[5]DocumentSummaryInformation']) {
            const stream = byPath.get(name);
            if (!stream) continue;
            try {
                const sets = readPropertySets(stream);
                for (const p of sets.properties) if (p.value && !(p.name in info)) info[p.name] = p.value;
                for (const w of sets.problems) warnings.push(`In ${name}: ${w}`);
            } catch (e) {
                warnings.push(`${name} can’t be read: ${e instanceof Error ? e.message : e}`);
            }
        }
        for (const key of ['Title', 'Subject', 'Author', 'Last saved by', 'Company', 'Created', 'Last saved', 'Program', 'Template', 'Security']) if (info[key]) summary.push([key, info[key]]);

        const ext = context.name?.includes('.') ? context.name.split('.').pop()!.toLowerCase() : '';
        const wordStream = byPath.get('WordDocument');
        let word: WordText | null = null;
        if (wordStream) {
            word = readWordText(wordStream, (n) => byPath.get(n) ?? null);
            if (word) {
                warnings.push(...word.problems);
                const c = word.counts;
                const parts = [
                    [c.footnotes, 'in footnotes'],
                    [c.headers, 'in headers and footers'],
                    [c.comments, 'in comments'],
                    [c.endnotes, 'in endnotes'],
                    [c.textBoxes, 'in text boxes'],
                ].filter(([n]) => n) as [number, string][];
                summary.unshift(['Word', `${word.version}${word.template ? ', a template' : ''}`]);
                summary.push(['Characters', [`${c.text.toLocaleString('en-US')} in the text`, ...parts.map(([n, w]) => `${n.toLocaleString('en-US')} ${w}`)].join(', ')]);
                if (word.text === null) summary.push(['Text', `not shown: ${word.why}`]);
                // Word 6.0's macro viruses (Concept, 1995, the first) save the documents they infect as templates, which can hold macros, under the document's own name.
                if (word.template && ext === 'doc') warnings.push('It’s a template, named .doc: Word 6.0’s and 95’s macro viruses save the documents they infect that way, to carry their macros.');
            }
        }
        if (ext === 'wri' && wordStream) summary.push(['Named', '.wri, as Windows Write’s documents are, but it’s a Word document']);

        const macros = entries.filter((e) => e.type === 1 && /^(Macros|_VBA_PROJECT_CUR|_VBA_PROJECT|VBA)$/.test(e.name));
        if (macros.length) warnings.push(`It holds macros (in ${macros.map((e) => `“${e.path}”`).join(', ')}): the program that opens it may run them, if it’s allowed to.`);
        const objects = entries.filter((e) => e.type === 1 && e.name === 'ObjectPool');
        const embedded = objects.reduce((n, o) => n + entries.filter((e) => e.type === 1 && e.reached && e.path.startsWith(`${o.path}/`) && !e.path.slice(o.path.length + 1).includes('/')).length, 0);
        if (embedded) summary.push(['Embedded objects', embedded.toLocaleString('en-US')]);

        const counted = [...streams.keys()];
        summary.push(['Streams', `${counted.length.toLocaleString('en-US')}, ${bytesLabel(counted.reduce((n, e) => n + streams.get(e)!.data.length, 0))}`]);
        summary.push(['Layout', `version ${major}, ${ss.toLocaleString('en-US')}-byte sectors`]);

        const save = byPath.has('Scenario Description') && byPath.has('CONTENTS');
        const title = word
            ? `Word ${word.template ? 'template' : 'document'} (${word.version})`
            : save
              ? 'Saved game (Tiberian Sun, Red Alert 2)'
              : (CLASSES[root.clsid] ??
                (byPath.has('Workbook') || byPath.has('Book')
                    ? 'Excel workbook'
                    : byPath.has('PowerPoint Document')
                      ? 'PowerPoint presentation'
                      : [...byPath.keys()].some((p) => p.startsWith('__substg1.0_'))
                        ? 'Outlook message'
                        : 'Compound file (OLE)'));

        const table: Preview = {
            kind: 'table',
            columns: [
                { key: 'name', label: 'Stream' },
                { key: 'size', label: 'Size', numeric: true },
            ],
            groups: ['Streams'],
            rows: list.map((e) => ({ group: 'Streams', cells: { name: e.label, size: e.size.toLocaleString('en-US') } })),
        };
        const preview: Preview =
            word && word.text !== null
                ? {
                      kind: 'stack',
                      items: [
                          { title: 'Text', preview: { kind: 'text', text: word.text } },
                          { title: 'Streams', preview: table },
                      ],
                  }
                : table;
        return { title, summary, fields, preview, entries: list, end, warnings };
    },
};

function sectorName(s: number): string {
    if (s === END) return 'none (end of chain)';
    if (s === FREE) return 'none';
    return s > LAST_SECTOR ? `0x${hex(s)}` : `sector ${s.toLocaleString('en-US')}`;
}

/** A directory entry's parts. */
function dirField(data: Uint8Array, e: DirEntry): Field {
    const b = new Bytes(data);
    const o = e.at;
    const link = (v: number) => (v === NO_STREAM ? 'none' : `entry ${v.toLocaleString('en-US')}`);
    const time = (p: number) => fileTime(b.u32(p), b.u32(p + 4)) ?? (b.u32(p) || b.u32(p + 4) ? 'not a date' : 'none');
    return {
        name: e.type ? `Entry ${e.index}: ${shown(e.name) || '(no name)'}` : `Entry ${e.index}: unused`,
        offset: o,
        length: 128,
        value: TYPES[e.type] ?? `type ${e.type}`,
        children: e.type
            ? [
                  field('Name', o, 64, shown(e.name), 'UTF-16, ending in a zero.'),
                  field('Name length', o + 64, 2, bytesLabel(b.u16(o + 64)), 'With the zero at its end.'),
                  field('Type', o + 66, 1, TYPES[e.type] ?? String(e.type)),
                  field('Color', o + 67, 1, data[o + 67] ? 'black' : 'red', 'For the red-black tree its siblings are in.'),
                  field('Left sibling', o + 68, 4, link(e.left)),
                  field('Right sibling', o + 72, 4, link(e.right)),
                  field('First child', o + 76, 4, link(e.child)),
                  field('Class ID', o + 80, 16, e.clsid === NO_CLASS ? 'none' : (CLASSES[e.clsid] ?? e.clsid)),
                  field('State', o + 96, 4, `0x${hex(b.u32(o + 96))}`),
                  field('Created', o + 100, 8, time(o + 100)),
                  field('Changed', o + 108, 8, time(o + 108)),
                  field('First sector', o + 116, 4, e.type === 2 && e.size < 4096 && e.size ? `mini sector ${e.start.toLocaleString('en-US')}` : sectorName(e.start)),
                  field('Size', o + 120, 8, bytesLabel(e.size)),
              ]
            : undefined,
    };
}

export default parser;
