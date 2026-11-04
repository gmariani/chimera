import { Bytes, bytesLabel, field, formatSize, hex } from '../../core/bytes';
import type { Entry, Field, FormatParser, Overlay, ParseContext, Parsed } from '../../core/types';
import { Blowfish } from './blowfish';
import { ID_SCHEMES, type IdScheme } from './ids';
import { KEY_SOURCE_SIZE, blowfishKey } from './key';
import { builtInNames, readLocalMixDatabase } from './names';
import { CHECKSUM_SIZE, FLAG_CHECKSUM, FLAG_ENCRYPTED, INDEX_ENTRY_SIZE } from './sniff';

/**
 * Westwood MIX archives (Command & Conquer: Tiberian Dawn, Red Alert, Tiberian
 * Sun, Red Alert 2). A header, an index of {id, offset, size}, then the files
 * stored back to back, uncompressed. See https://xhp.xwis.net/documents/MIX_Format.html
 */

const LOCAL_DATABASE = 'local mix database.dat';

export interface MixIndexEntry {
    id: number;
    offset: number;
    size: number;
}

export interface MixLayout {
    /** Tiberian Dawn's layout has no flags; later games start with a flags dword. */
    layout: 'td' | 'ra';
    flags: number;
    encrypted: boolean;
    checksum: boolean;
    count: number;
    bodySize: number;
    /** Where the file count is: 0 (TD), 4 (RA), or 84 (encrypted, after the key source). */
    headerStart: number;
    bodyStart: number;
    /** The header and index as plain bytes (decrypted if need be), starting with the file count. */
    header: Uint8Array;
    index: MixIndexEntry[];
    keySource?: Uint8Array;
    key?: Uint8Array;
    /** How many bytes of the file are encrypted, a whole number of 8-byte blocks. */
    encryptedSize?: number;
}

export class MixError extends Error {}

export function readLayout(data: Uint8Array): MixLayout {
    const bytes = new Bytes(data);
    if (data.length < 6) throw new MixError('Too short to be a MIX file.');

    let layout: MixLayout['layout'] = 'td';
    let flags = 0;
    let headerStart = 0;
    let header: Uint8Array;
    let keySource: Uint8Array | undefined;
    let key: Uint8Array | undefined;
    let encryptedSize: number | undefined;

    if (bytes.u16(0) === 0) {
        layout = 'ra';
        flags = bytes.u32(0);
        headerStart = 4;
    }
    const encrypted = (flags & FLAG_ENCRYPTED) !== 0;

    if (encrypted) {
        headerStart = 4 + KEY_SOURCE_SIZE;
        if (data.length < headerStart + 8) throw new MixError('The header is encrypted, but the file ends before it does.');
        keySource = data.slice(4, headerStart);
        key = blowfishKey(keySource);
        const blowfish = new Blowfish(key);
        const first = new Bytes(blowfish.decrypt(data.subarray(headerStart, headerStart + 8)));
        const count = first.u16(0);
        encryptedSize = Math.ceil((6 + count * INDEX_ENTRY_SIZE) / 8) * 8;
        if (headerStart + encryptedSize > data.length) throw new MixError(`The decrypted header lists ${count} files, which would run past the end of the file. Either the file is cut short, or it isn't a MIX file.`);
        header = blowfish.decrypt(data.subarray(headerStart, headerStart + encryptedSize));
    } else {
        const count = bytes.u16(headerStart);
        const length = 6 + count * INDEX_ENTRY_SIZE;
        if (headerStart + length > data.length) throw new MixError(`The header lists ${count} files, which would run past the end of the file. Either the file is cut short, or it isn't a MIX file.`);
        header = data.subarray(headerStart, headerStart + length);
    }

    const plain = new Bytes(header);
    const count = plain.u16(0);
    const index: MixIndexEntry[] = [];
    for (let i = 0; i < count; i++) {
        const at = 6 + i * INDEX_ENTRY_SIZE;
        index.push({ id: plain.u32(at), offset: plain.u32(at + 4), size: plain.u32(at + 8) });
    }

    return {
        layout,
        flags,
        encrypted,
        checksum: (flags & FLAG_CHECKSUM) !== 0,
        count,
        bodySize: plain.u32(2),
        headerStart,
        bodyStart: headerStart + (encryptedSize ?? 6 + count * INDEX_ENTRY_SIZE),
        header,
        index,
        keySource,
        key,
        encryptedSize,
    };
}

/** id → name for each scheme, for a list of candidate names. */
function hashNames(names: Iterable<string>): Record<IdScheme, Map<number, string>> {
    const maps = { classic: new Map<number, string>(), crc: new Map<number, string>() };
    for (const name of names) {
        for (const scheme of ['classic', 'crc'] as const) {
            const id = ID_SCHEMES[scheme].id(name);
            if (!maps[scheme].has(id)) maps[scheme].set(id, name);
        }
    }
    return maps;
}

let builtInHashes: Record<IdScheme, Map<number, string>> | null = null;
/** The same list of extra names comes with every archive opened (and those inside it), so hash it once. */
const extraHashCache = new WeakMap<readonly string[], Record<IdScheme, Map<number, string>>>();

/** Picks the ID scheme that names the most files, and those names. */
function resolveNames(mix: MixLayout, data: Uint8Array, extra: readonly string[]): { scheme: IdScheme; names: Map<number, string>; fromDatabase: number } {
    builtInHashes ??= hashNames(builtInNames());
    let extraHashes = extraHashCache.get(extra);
    if (!extraHashes) extraHashCache.set(extra, (extraHashes = hashNames(extra)));
    const ids = new Set(mix.index.map((e) => e.id));

    // The archive's own name list, if XCC (or Westwood, in TS and later) left one.
    let database: string[] = [];
    let databaseScheme: IdScheme | null = null;
    for (const scheme of ['classic', 'crc'] as const) {
        const entry = mix.index.find((e) => e.id === ID_SCHEMES[scheme].id(LOCAL_DATABASE));
        const found = entry && readLocalMixDatabase(data.subarray(mix.bodyStart + entry.offset, mix.bodyStart + entry.offset + entry.size));
        if (found) {
            database = found;
            databaseScheme = scheme;
            break;
        }
    }
    const databaseHashes = hashNames(database);

    const pick = (scheme: IdScheme) => {
        const names = new Map<number, string>();
        let fromDatabase = 0;
        for (const source of [databaseHashes, extraHashes!, builtInHashes!]) {
            for (const id of ids) {
                const name = source[scheme].get(id);
                if (name !== undefined && !names.has(id)) {
                    names.set(id, name);
                    if (source === databaseHashes) fromDatabase++;
                }
            }
        }
        if (ids.has(ID_SCHEMES[scheme].id(LOCAL_DATABASE))) names.set(ID_SCHEMES[scheme].id(LOCAL_DATABASE), LOCAL_DATABASE);
        return { scheme, names, fromDatabase };
    };

    // Tiberian Dawn's layout (no flags) is also what TS and RA2 write when they don't encrypt, with their own IDs; so pick whichever names more.
    if (databaseScheme) return pick(databaseScheme);
    const classic = pick('classic');
    const crc = pick('crc');
    return crc.names.size > classic.names.size ? crc : classic;
}

function gameName(mix: MixLayout, scheme: IdScheme): string {
    if (scheme === 'crc') return 'Tiberian Sun / Red Alert 2';
    return mix.layout === 'td' ? 'Tiberian Dawn' : 'Red Alert';
}

function flagNames(flags: number): string {
    const set = [flags & FLAG_CHECKSUM && 'checksum', flags & FLAG_ENCRYPTED && 'encrypted'].filter(Boolean);
    return set.length ? set.join(', ') : 'none';
}

function toHex(bytes: Uint8Array): string {
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

export function parseMix(data: Uint8Array, context: ParseContext): Parsed {
    const mix = readLayout(data);
    const warnings: string[] = [];
    const { scheme, names, fromDatabase } = resolveNames(mix, data, context.names);
    const game = gameName(mix, scheme);

    const entries: Entry[] = mix.index.map((e, i) => {
        const start = mix.bodyStart + e.offset;
        const name = names.get(e.id) ?? null;
        if (start + e.size > data.length) warnings.push(`${name ?? hex(e.id)} (entry ${i + 1}) runs ${bytesLabel(start + e.size - data.length)} past the end of the file; it has been cut short.`);
        return {
            name,
            label: name ?? hex(e.id),
            offset: start,
            size: e.size,
            data: data.subarray(Math.min(start, data.length), Math.min(start + e.size, data.length)),
            meta: { ID: hex(e.id) },
        };
    });

    // Sanity checks: the things a game (or another tool) would trip over.
    const expectedEnd = mix.bodyStart + mix.bodySize + (mix.checksum ? CHECKSUM_SIZE : 0);
    if (expectedEnd !== data.length) {
        warnings.push(`The header says the body is ${bytesLabel(mix.bodySize)}${mix.checksum ? ' plus a 20-byte checksum' : ''}, which would end the file at ${bytesLabel(expectedEnd)}, but the file is ${bytesLabel(data.length)}.`);
    }
    if (mix.flags & ~(FLAG_CHECKSUM | FLAG_ENCRYPTED)) warnings.push(`Unknown flag bits are set: 0x${hex(mix.flags & ~(FLAG_CHECKSUM | FLAG_ENCRYPTED))}.`);
    // Westwood's packer sometimes stored a file twice. Harmless if the copies match.
    const firstById = new Map<number, Entry>();
    const copies: Entry[] = [];
    entries.forEach((entry, i) => {
        const first = firstById.get(mix.index[i].id);
        if (!first) return void firstById.set(mix.index[i].id, entry);
        if (first.data.length === entry.data.length && first.data.every((b, j) => b === entry.data[j])) copies.push(entry);
        else warnings.push(`ID ${hex(mix.index[i].id)} appears more than once with different contents; the game will only ever find one of them.`);
    });
    // The games binary-search the index by ID, compared as signed numbers (every TS and RA2 archive is sorted that way too).
    if (mix.index.some((e, i) => i > 0 && (mix.index[i - 1].id | 0) > (e.id | 0))) {
        warnings.push('The index isn\'t sorted by ID (as signed numbers), so the game\'s binary search may not find some files.');
    }

    // The structure tree.
    const fields: Field[] = [];
    const hs = mix.headerStart;
    const indexFields = mix.index.map((e, i): Field => {
        const at = hs + 6 + i * INDEX_ENTRY_SIZE;
        return {
            name: `Entry ${i + 1}: ${entries[i].label}`,
            offset: at,
            length: INDEX_ENTRY_SIZE,
            children: [
                field('ID', at, 4, `0x${hex(e.id)}`, entries[i].name ? `The ${ID_SCHEMES[scheme].label} hash of "${entries[i].name}".` : 'A hash of the file name. No known name matches it.'),
                field('Offset', at + 4, 4, `${e.offset} (file offset ${mix.bodyStart + e.offset})`, 'Where the file starts, counted from the start of the body.'),
                field('Size', at + 8, 4, bytesLabel(e.size)),
            ],
        };
    });
    const headerFields: Field[] = [
        field('File count', hs, 2, mix.count, 'How many files are in the index.'),
        field('Body size', hs + 2, 4, bytesLabel(mix.bodySize), 'The size of everything after the index, not counting a checksum.'),
        { name: `Index (${mix.count} entries)`, offset: hs + 6, length: mix.count * INDEX_ENTRY_SIZE, note: 'One 12-byte entry per file: ID, offset, size. The game finds a file by hashing its name and searching this list.', children: indexFields },
    ];

    if (mix.layout === 'ra') {
        fields.push(field('Flags', 0, 4, `0x${hex(mix.flags)} (${flagNames(mix.flags)})`, 'Red Alert and later. 0x00010000: a 20-byte SHA-1 checksum follows the body. 0x00020000: the header is encrypted. In Tiberian Dawn files this dword doesn\'t exist; the file count comes first.'));
    }
    if (mix.encrypted && mix.keySource && mix.key && mix.encryptedSize) {
        fields.push(field('Key source', 4, KEY_SOURCE_SIZE, `${toHex(mix.keySource.subarray(0, 8))}…`, `80 bytes that become the Blowfish key: two 40-byte numbers, each run through RSA with Westwood's public key. Here the key works out to ${toHex(mix.key)}.`));
        const padding = mix.encryptedSize - 6 - mix.count * INDEX_ENTRY_SIZE;
        fields.push({
            name: 'Encrypted header',
            offset: hs,
            length: mix.encryptedSize,
            value: `${mix.encryptedSize / 8} Blowfish blocks`,
            note: 'Encrypted with Blowfish (ECB) in 8-byte blocks; the values below are decrypted. Turn on "decrypted" in the hex view to see the plain bytes.',
            children: padding > 0 ? [...headerFields, field('Padding', hs + mix.encryptedSize - padding, padding, undefined, 'Fills out the last 8-byte block.')] : headerFields,
        });
    } else {
        fields.push({ name: 'Header', offset: hs, length: 6 + mix.count * INDEX_ENTRY_SIZE, children: headerFields });
    }

    const byOffset = entries.map((e, i) => ({ e, i })).sort((a, b) => a.e.offset - b.e.offset);
    fields.push({
        name: 'Body',
        offset: mix.bodyStart,
        length: Math.min(mix.bodySize, data.length - mix.bodyStart),
        note: 'The files, stored back to back with no compression or encryption.',
        children: byOffset.map(({ e, i }) => ({ name: e.label, offset: e.offset, length: e.data.length, value: formatSize(e.size), note: `Index entry ${i + 1}.` })),
    });
    if (mix.checksum) {
        const at = mix.bodyStart + mix.bodySize;
        fields.push(field('Checksum', at, CHECKSUM_SIZE, toHex(data.subarray(at, at + CHECKSUM_SIZE)), 'A SHA-1 digest of the body. The games don\'t check it; it can be removed along with the flag.'));
    }

    const overlays: Overlay[] = mix.encrypted ? [{ offset: hs, bytes: mix.header, label: 'decrypted' }] : [];

    const layoutLabel = mix.layout === 'td' ? 'Tiberian Dawn layout (no flags)' : `Red Alert layout, ${mix.encrypted ? 'encrypted header' : 'plain header'}${mix.checksum ? ', with checksum' : ''}`;
    return {
        title: `${game} MIX archive`,
        summary: [
            ['Game', game],
            ['Layout', layoutLabel],
            ['Files', mix.count.toLocaleString('en-US')],
            ['Body', `${formatSize(mix.bodySize)}, starting at offset ${mix.bodyStart}`],
            ['Names', `${names.size} of ${mix.count} known${fromDatabase ? ` (${fromDatabase} from the archive's own name list)` : ''}`],
            ['File IDs', `${ID_SCHEMES[scheme].label} hashes`],
            ...(copies.length ? [['Duplicates', `${copies.length} file${copies.length === 1 ? ' is' : 's are'} stored twice, as identical copies (${formatSize(copies.reduce((n, e) => n + e.size, 0))} wasted)`] as [string, string]] : []),
            ...(mix.key ? [['Blowfish key', toHex(mix.key)] as [string, string]] : []),
        ],
        fields,
        entries,
        overlays,
        warnings,
    };
}

const parser: FormatParser = { parse: parseMix };
export default parser;
