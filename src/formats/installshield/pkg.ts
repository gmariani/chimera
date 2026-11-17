import { bytesLabel, field } from '../../core/bytes';
import { checkCount } from '../../core/limits';
import type { Companion, Field, FormatParser, ParseContext, TableRow } from '../../core/types';
import { Links } from '../links';
import { PKG_HEADER, sniffInstallShieldPkg } from './sniff';
import { type ArchiveFile, archiveTables } from './tables';

/**
 * InstallShield 3's package lists (SETUP.PKG): which files each of an install's archives (.z) holds, in which of its
 * groups, and how big each is, so the installer can work out the space it needs before it unpacks anything. Red
 * Alert's Counterstrike has three, one for each of its Windows installers (the themes, Westwood Chat, and Internet
 * Explorer with a dial-up account).
 *
 * InstallShield never published the format. The Just Solve the File Format Problem wiki has only its signature
 * (http://justsolve.archiveteam.org/wiki/InstallShield_PKG). The rest is read from Counterstrike's three, checked
 * against the archives they describe, and from twelve other programs' installers collected for that wiki
 * (https://sembiance.com/fileFormatSamples/other/installShieldPackage/), all explained to the last byte: a 10-byte
 * header; a block for each archive, its length, its groups (each a name with a 16-bit length and a zero after it) and
 * its files (each its group, its size, and a name with an 8-bit length and a zero after it); then, for each disk, a
 * list of what's on it: the archives, each with where its block starts, and the files copied as they are, each with
 * its size. A file's size in a block is unpacked in Westwood Chat's list and packed in the other two, so it's whatever
 * the installer was told to count.
 *
 * Each block is a copy of its archive's own tables (the groups are its directories), so when the archive is open too,
 * the two are compared: a file one has and the other doesn't, in another directory, or of another size, is said.
 */

/** The bytes in a group entry around its name: its length, and the zero after it. */
const GROUP = 3;
/** The bytes in a file entry around its name: its group, its size, the name's length, the zero after it. */
const FILE = 8;
/** The bytes in a disk's entry around its name: its length, its kind, a byte not known, its block or its size. */
const ENTRY = 8;
/** Kinds of a disk's entry: an archive, its files listed in a block; a file copied as it is. */
const ARCHIVE = 1;
const COPIED = 2;

interface Block {
    at: number;
    groups: string[];
    files: { name: string; group: number; size: number }[];
}

/** How many differences with one archive are said, before the rest are counted. */
const MOST_SAID = 10;

/**
 * An archive the list names, among the files opened: by its name, or, for a set split across disks, as InstallShield
 * names the pieces (_SETUP.Z is _SETUP.1, _SETUP.2 and on). The pieces' tables together, or null when none is open.
 */
function openArchive(name: string, find: NonNullable<ParseContext['find']>, links: Links): { sources: string[]; files: ArchiveFile[]; unreadable: string[] } | null {
    const whole = find(name)[0];
    const stem = name.replace(/\.[^.]*$/, '');
    const pieces: { name: string; companion: Companion }[] = whole ? [{ name, companion: whole }] : [];
    for (let disk = 1; !whole && disk < 100; disk++) {
        const piece = find(`${stem}.${disk}`)[0];
        if (!piece) break;
        pieces.push({ name: `${stem}.${disk}`, companion: piece });
    }
    if (!pieces.length) return null;
    const files: ArchiveFile[] = [];
    const seen = new Set<string>();
    const unreadable: string[] = [];
    for (const p of pieces) {
        links.use(p.name, p.companion, 'Archive it lists');
        const tables = archiveTables(p.companion.data);
        if (!tables) {
            unreadable.push(p.companion.source);
            continue;
        }
        // A file split across two disks is in both pieces' tables.
        for (const f of tables.files) {
            const key = `${f.directory}\\${f.name}`.toLowerCase();
            if (!seen.has(key)) files.push(f);
            seen.add(key);
        }
    }
    return { sources: pieces.map((p) => p.companion.source), files, unreadable };
}

/** The list's block for an archive against the archive's own tables: what differs, and whether its sizes are packed or not. */
function compare(archive: string, block: Block, files: ArchiveFile[]): { problems: string[]; sizes: string } {
    const problems: string[] = [];
    const matched = new Set<ArchiveFile>();
    let [unpacked, packed] = [0, 0];
    const byName = new Map<string, ArchiveFile[]>();
    for (const a of files) byName.set(a.name.toLowerCase(), [...(byName.get(a.name.toLowerCase()) ?? []), a]);
    for (const f of block.files) {
        const group = block.groups[f.group];
        const named = (byName.get(f.name.toLowerCase()) ?? []).filter((a) => !matched.has(a));
        const same = named.find((a) => group !== undefined && a.directory.toLowerCase() === group.toLowerCase());
        const a = same ?? named[0];
        if (!a) {
            problems.push(`${f.name} is listed in ${archive}, which doesn't hold it.`);
            continue;
        }
        matched.add(a);
        if (!same && group !== undefined)
            problems.push(`${f.name} is in the group "${group}" here, but in ${archive} it's in ${a.directory ? `the directory "${a.directory}"` : 'the top directory'}.`);
        if (f.size === a.size && f.size !== a.packed) unpacked++;
        else if (f.size === a.packed && f.size !== a.size) packed++;
        else if (f.size !== a.size) problems.push(`${f.name} is ${bytesLabel(f.size)} here, but ${archive} has it as ${bytesLabel(a.size)} unpacked and ${bytesLabel(a.packed)} packed.`);
    }
    for (const a of files) if (!matched.has(a)) problems.push(`${archive} holds ${a.directory ? `${a.directory}\\` : ''}${a.name}, which this list doesn't name.`);
    // Every list seen gives one or the other throughout; both would add up to neither.
    if (unpacked && packed) problems.push(`${unpacked.toLocaleString('en-US')} of the sizes for ${archive} are its files unpacked, and ${packed.toLocaleString('en-US')} are them packed.`);
    return { problems, sizes: packed && !unpacked ? 'packed' : 'unpacked' };
}

const parser: FormatParser = {
    parse(data, context) {
        if (!sniffInstallShieldPkg(data)) throw new Error("This isn't an InstallShield 3 package list: it doesn't start with 4A A3 and where its first disk's list is, with at least one entry there.");
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const u16 = (at: number) => view.getUint16(at, true);
        const u32 = (at: number) => view.getUint32(at, true);
        const latin1 = (at: number, length: number) => new TextDecoder('latin1').decode(data.subarray(at, at + length));
        const warnings: string[] = [];
        const listAt = u32(2);

        const fields: Field[] = [
            {
                name: 'Header',
                offset: 0,
                length: PKG_HEADER,
                children: [
                    field('Signature', 0, 2, '4A A3'),
                    field('Disks’ lists at', 2, 4, listAt.toLocaleString('en-US'), 'Where the lists of what’s on each disk are, after the blocks.'),
                    field('Not known', 6, 4, u32(6), '2 in every list seen.'),
                ],
            },
        ];

        // What's on each disk, at the end: read first, to name each block for its archive.
        const archives: { name: string; block: number }[] = [];
        const copied: { name: string; size: number; disk: number }[] = [];
        let at = listAt;
        let lastDisk = -1;
        let diskCount = 0;
        let cut = false;
        while (!cut && at + 6 <= data.length) {
            const [zero, disk, count] = [u16(at), u16(at + 2), u16(at + 4)];
            const room = data.length - at - 6;
            // Another disk's list starts with 0 and a later disk; anything else isn't one, and is left to the checks for what's after the end.
            if (at > listAt && (zero !== 0 || disk <= lastDisk || count === 0 || count * ENTRY > room)) break;
            checkCount(count, ENTRY, room, `Disk ${disk}'s entries`);
            const start = at;
            const children: Field[] = [field('Not known', at, 2, zero, '0 in every list seen.'), field('Disk', at + 2, 2, disk), field('Entries', at + 4, 2, count)];
            at += 6;
            for (let i = 0; i < count; i++) {
                const length = at + 2 <= data.length ? u16(at) : 0;
                if (at + ENTRY + length > data.length) {
                    warnings.push(`Disk ${disk}'s list ends after ${i} of its ${count} entries: entry ${i + 1} runs past the end of the file.`);
                    cut = true;
                    break;
                }
                const name = latin1(at + 2, length);
                const [kind, other, value] = [data[at + 2 + length], data[at + 3 + length], u32(at + 4 + length)];
                if (kind === ARCHIVE) archives.push({ name, block: value });
                else if (kind === COPIED) copied.push({ name, size: value, disk });
                else warnings.push(`${name || `Disk ${disk}'s entry ${i + 1}`} is of kind ${kind}, which isn't one known: 1 is an archive and 2 a file copied as it is.`);
                children.push({
                    name: name || '(no name)',
                    offset: at,
                    length: ENTRY + length,
                    value: kind === ARCHIVE ? `block at ${value.toLocaleString('en-US')}` : kind === COPIED ? bytesLabel(value) : `kind ${kind}`,
                    children: [
                        field('Name length', at, 2, length),
                        ...(length ? [field('Name', at + 2, length, name)] : []),
                        field('Kind', at + 2 + length, 1, kind, kind === ARCHIVE ? 'An archive, its files listed in a block.' : kind === COPIED ? 'A file copied as it is.' : 'Not one known.'),
                        field('Not known', at + 3 + length, 1, other, '1 for archives and 0 for files copied as they are, in every list seen.'),
                        kind === ARCHIVE
                            ? field('Block at', at + 4 + length, 4, value.toLocaleString('en-US'), 'Where this archive’s groups and files are listed.')
                            : kind === COPIED
                              ? field('Size', at + 4 + length, 4, bytesLabel(value))
                              : field('Not known', at + 4 + length, 4, value),
                    ],
                });
                at += ENTRY + length;
            }
            fields.push({ name: `Disk ${disk}`, offset: start, length: at - start, value: `${count} entr${count === 1 ? 'y' : 'ies'}`, children });
            lastDisk = disk;
            diskCount++;
        }
        const end = at;
        const archiveAt = new Map(archives.map((a) => [a.block, a.name]));

        // The blocks, one after another to the list of archives.
        const blocks: Block[] = [];
        at = PKG_HEADER;
        while (at < listAt) {
            const start = at;
            const archive = archiveAt.get(start);
            const title = archive ? `${archive}'s block` : `The block at ${start.toLocaleString('en-US')}`;
            if (at + 4 > listAt) {
                warnings.push(`${bytesLabel(listAt - at)} before the disks' lists are too few to be another block.`);
                fields.push(field('Not known', at, listAt - at, bytesLabel(listAt - at)));
                break;
            }
            const length = u32(at);
            let blockEnd = at + 4 + length;
            if (blockEnd > listAt) {
                warnings.push(`${title} is said to be ${bytesLabel(length)}, which runs into the disks' lists.`);
                blockEnd = listAt;
            }
            const block: Block = { at: start, groups: [], files: [] };
            const children: Field[] = [field('Length', at, 4, bytesLabel(length), 'Of the rest of the block.')];
            at += 4;
            /** Reads a count, then each entry until the count or the block runs out; false when it ran out. */
            const list = (what: string, size: number, read: (i: number) => number | null): boolean => {
                if (at + 2 > blockEnd) {
                    warnings.push(`${title} ends before it says how many ${what} it has.`);
                    return false;
                }
                const n = u16(at);
                children.push(field(what[0].toUpperCase() + what.slice(1), at, 2, n));
                at += 2;
                for (let i = 0; i < n; i++) {
                    const used = at + size <= blockEnd ? read(i) : null;
                    if (used === null || at + used > blockEnd) {
                        warnings.push(`${title} ends after ${i} of its ${n} ${what}.`);
                        return false;
                    }
                    at += used;
                }
                return true;
            };
            const ended = (name: string, zeroAt: number) => {
                if (data[zeroAt] !== 0) warnings.push(`In ${title.replace(/^The/, 'the')}, ${name} isn't followed by the zero that ends every other name.`);
                return field('End', zeroAt, 1, data[zeroAt], 'The zero after the name.');
            };
            const whole =
                list('groups', GROUP, () => {
                    const n = u16(at);
                    if (at + 2 + n + 1 > blockEnd) return null;
                    const name = latin1(at + 2, n);
                    block.groups.push(name);
                    children.push({
                        name: `Group: ${name}`,
                        offset: at,
                        length: GROUP + n,
                        children: [field('Name length', at, 2, n), ...(n ? [field('Name', at + 2, n, name)] : []), ended(`the group "${name}"`, at + 2 + n)],
                    });
                    return GROUP + n;
                }) &&
                list('files', FILE, () => {
                    const [group, size, n] = [u16(at), u32(at + 2), data[at + 6]];
                    if (at + FILE + n > blockEnd) return null;
                    const name = latin1(at + 7, n);
                    block.files.push({ name, group, size });
                    const groupName = block.groups[group];
                    if (groupName === undefined) warnings.push(`${name} is said to be in group ${group}, but ${title.replace(/^The/, 'the')} has only ${block.groups.length}.`);
                    children.push({
                        name,
                        offset: at,
                        length: FILE + n,
                        value: bytesLabel(size),
                        children: [
                            field('Group', at, 2, group, groupName),
                            field('Size', at + 2, 4, bytesLabel(size), 'What the installer counts for it: its size unpacked in some lists, packed in others.'),
                            field('Name length', at + 6, 1, n),
                            ...(n ? [field('Name', at + 7, n, name)] : []),
                            ended(name, at + 7 + n),
                        ],
                    });
                    return FILE + n;
                });
            if (at < blockEnd) {
                if (whole) warnings.push(`${title} has ${bytesLabel(blockEnd - at)} after its last file.`);
                children.push(field(whole ? 'Not known' : 'Not read', at, blockEnd - at, bytesLabel(blockEnd - at), whole ? undefined : 'After where the block stops making sense.'));
            }
            const total = block.files.reduce((n, f) => n + f.size, 0);
            fields.push({
                name: archive ? `Block: ${archive}` : 'Block',
                offset: start,
                length: blockEnd - start,
                value: `${block.files.length.toLocaleString('en-US')} file${block.files.length === 1 ? '' : 's'}, ${bytesLabel(total)}`,
                children,
            });
            blocks.push(block);
            // Past what was read, so a block cut short leaves its rest unread, not read again as another.
            at = blockEnd;
        }

        // Each archive should have one block, and each block an archive.
        const starts = new Set(blocks.map((b) => b.at));
        for (const a of archives) if (!starts.has(a.block)) warnings.push(`${a.name}'s files are said to be listed at ${a.block.toLocaleString('en-US')}, where no block starts.`);
        const claimed = new Set(archives.map((a) => a.block));
        for (const b of blocks) if (!claimed.has(b.at)) warnings.push(`The block at ${b.at.toLocaleString('en-US')} isn't any archive's: no archive in the disks' lists points to it.`);
        const names = [...archives, ...copied].map((a) => a.name.toLowerCase());
        if (new Set(names).size < names.length) warnings.push('A file is in the disks’ lists more than once.');

        // Each archive that's open, against what this list says it holds.
        const links = new Links();
        const checked: [string, string][] = [];
        const unopened: string[] = [];
        const blockAt = new Map(blocks.map((b) => [b.at, b]));
        for (const a of context.find ? archives : []) {
            const block = blockAt.get(a.block);
            if (!block) continue;
            const open = openArchive(a.name, context.find!, links);
            if (!open) {
                links.miss(a.name, 'Archive it lists');
                unopened.push(a.name);
                continue;
            }
            for (const source of open.unreadable) warnings.push(`${source}, opened for ${a.name}, isn't an InstallShield 3 archive whose tables can be read.`);
            if (open.unreadable.length === open.sources.length) continue;
            const { problems, sizes } = compare(a.name, block, open.files);
            warnings.push(...problems.slice(0, MOST_SAID));
            if (problems.length > MOST_SAID) warnings.push(`And ${(problems.length - MOST_SAID).toLocaleString('en-US')} more differences with ${a.name}.`);
            checked.push([
                `Checked against`,
                `${open.sources.join(', ')}: ${problems.length ? `${problems.length.toLocaleString('en-US')} difference${problems.length === 1 ? '' : 's'}` : 'the same files, in the same groups'}, sizes ${sizes}`,
            ]);
        }

        const rows: TableRow[] = [
            ...blocks.flatMap((b) => {
                const archive = archiveAt.get(b.at) ?? `Block at ${b.at.toLocaleString('en-US')}`;
                return b.files.map((f) => ({
                    group: archive,
                    cells: { file: f.name, group: b.groups[f.group] ?? `${f.group} (not one of its groups)`, size: String(f.size) },
                }));
            }),
            ...copied.map((f) => ({ group: 'Copied as they are', cells: { file: f.name, group: diskCount > 1 ? `Disk ${f.disk}` : '', size: String(f.size) } })),
        ];
        const files = blocks.reduce((n, b) => n + b.files.length, 0);
        const groups = blocks.reduce((n, b) => n + b.groups.length, 0);
        return {
            title: 'InstallShield 3 package list',
            summary: [
                ['Archives', archives.map((a) => a.name).join(', ') || 'none'],
                ['Files', `${files.toLocaleString('en-US')} in ${groups.toLocaleString('en-US')} group${groups === 1 ? '' : 's'}`],
                ['Size', `${bytesLabel(blocks.reduce((n, b) => n + b.files.reduce((m, f) => m + f.size, 0), 0))}, as the installer counts them`],
                ...(copied.length ? [['Copied as they are', copied.map((f) => f.name).join(', ')] as [string, string]] : []),
                ...(diskCount > 1 ? [['Disks', String(diskCount)] as [string, string]] : []),
                ...checked,
            ],
            links: context.find ? links.list : undefined,
            wanted: unopened.length
                ? `Open ${unopened.join(', ')} as well (or the folder it's in) to check this list against what ${unopened.length === 1 ? 'it really holds' : 'they really hold'}.`
                : undefined,
            fields: fields.sort((a, b) => a.offset - b.offset),
            preview: {
                kind: 'table',
                columns: [
                    { key: 'file', label: 'File' },
                    { key: 'group', label: 'Group' },
                    { key: 'size', label: 'Size', numeric: true },
                ],
                groups: [...new Set(rows.map((r) => r.group))],
                rows,
            },
            end,
            warnings,
        };
    },
};

export default parser;
