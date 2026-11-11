import { Bytes } from '../../core/bytes';

/**
 * Westwood PAK archives (1991–1994: Eye of the Beholder, Dune II, the Legend
 * of Kyrandia, Lands of Lore). No signature and no count: just entries of a
 * 32-bit offset and a NUL-terminated 8.3 name, one after another, until:
 *
 * - version 1 (Eye of the Beholder): the header reaches the first file's
 *   offset; the last entry's offset is the end of the file (often garbage:
 *   the game kept its own table of sizes);
 * - version 2 (Dune II, Kyrandia 1): an offset of 0, and the last file runs to
 *   the end of the archive;
 * - version 3 (Kyrandia 2 and 3, Lands of Lore): an entry with an empty name
 *   whose offset is where the last file ends, then an offset of 0.
 *
 * A file's size is the next offset less its own. Nothing is compressed.
 * See https://moddingwiki.shikadi.net/wiki/PAK_Format_(Westwood).
 */

/** Characters a DOS 8.3 name can have. */
const NAME = /^[A-Za-z0-9_\-!#$%&'(){}@^`~]{1,8}(\.[A-Za-z0-9_\-!#$%&'(){}@^`~]{1,3})?$/;
/** The longest a name can be: 8, a dot, 3. */
const NAME_MAX = 12;

/** One entry in the header: a file, the end marker (versions 1 and 3), or the 0 that ends the list (versions 2 and 3). */
export interface PakHeaderEntry {
    at: number;
    /** Bytes it takes, its name's NUL included. */
    length: number;
    offset: number;
    name: string;
    kind: 'file' | 'end' | 'zero';
}

export interface PakLayout {
    version: 1 | 2 | 3;
    /** Where the header ends (and the first file starts). */
    headerEnd: number;
    header: PakHeaderEntry[];
    files: PakHeaderEntry[];
    /** Where the last file ends: the end marker (versions 1 and 3) or the end of the archive (version 2). */
    end: number;
    /** Version 1's end offset as stored, when it couldn't be right (past the archive, or before the last file). */
    badEnd: number | null;
}

/**
 * The archive's layout, or null if the bytes don't make a PAK: every name a
 * DOS name, the files starting right where the header ends, and every offset
 * in order and inside the archive.
 */
export function pakLayout(data: Uint8Array): PakLayout | null {
    const b = new Bytes(data);
    if (data.length < 6) return null;
    const header: PakHeaderEntry[] = [];
    let at = 0;
    let first = -1;
    let zero = false;
    for (;;) {
        // Version 1: the header stops where the first file starts.
        if (first >= 0 && at === first) break;
        if (at + 4 > data.length || (first >= 0 && at > first)) return null;
        const offset = b.u32(at);
        // Versions 2 and 3: an offset of 0 ends the list.
        if (offset === 0) {
            if (!header.length) return null;
            header.push({ at, length: 4, offset: 0, name: '', kind: 'zero' });
            at += 4;
            zero = true;
            break;
        }
        let nameEnd = at + 4;
        while (nameEnd < data.length && nameEnd - (at + 4) <= NAME_MAX && data[nameEnd] !== 0) nameEnd++;
        if (nameEnd >= data.length || data[nameEnd] !== 0) return null;
        const name = String.fromCharCode(...data.subarray(at + 4, nameEnd));
        // Only an end marker has no name; any other name has to be a DOS name.
        if (name !== '' && !NAME.test(name)) return null;
        if (first < 0) {
            if (name === '') return null;
            first = offset;
        }
        header.push({ at, length: nameEnd + 1 - at, offset, name, kind: 'file' });
        at = nameEnd + 1;
    }
    // The files start right where the header ends.
    if (first !== at) return null;

    const listed = header.filter((e) => e.kind === 'file');
    // Version 1 ends on the end marker; version 3 has one before its 0; version 2 has none.
    const version: PakLayout['version'] = !zero ? 1 : listed[listed.length - 1].name === '' ? 3 : 2;
    if (version !== 2) listed[listed.length - 1].kind = 'end';
    const files = listed.filter((e) => e.kind === 'file');
    if (!files.length || files.some((f) => f.name === '')) return null;
    for (let i = 0; i < files.length; i++) {
        if (files[i].offset > data.length || (i > 0 && files[i].offset < files[i - 1].offset)) return null;
    }
    const last = files[files.length - 1].offset;
    let end = version === 2 ? data.length : listed[listed.length - 1].offset;
    let badEnd: number | null = null;
    if (end > data.length || end < last) {
        // Version 1's end offset is often garbage (the game didn't use it); version 3's has to be right.
        if (version === 3) return null;
        badEnd = end;
        end = data.length;
    }
    return { version, headerEnd: at, header, files, end, badEnd };
}
