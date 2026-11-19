import { Bytes } from '../core/bytes';

/**
 * What Windows programs of both kinds (16-bit NE, ne.ts; 32- and 64-bit PE, pe.ts) keep as resources, and how those
 * are read: the types Windows defines, icon and cursor groups made into the .ico and .cur files they'd be saved as,
 * and version information.
 *
 * The types are Microsoft's "Resource Types" (https://learn.microsoft.com/windows/win32/menurc/resource-types). Icon
 * and cursor groups are its GRPICONDIR and GRPICONDIRENTRY ("Resource File Formats",
 * https://learn.microsoft.com/windows/win32/menurc/resource-file-formats), and the .ico and .cur files they make are
 * laid out as ico.ts reads them. Version information is VS_VERSIONINFO, with its VS_FIXEDFILEINFO, StringFileInfo and
 * VarFileInfo (https://learn.microsoft.com/windows/win32/menurc/vs-versioninfo).
 */

/** Resource types Windows defines, by number: what each is, and what to save it as. */
export const RESOURCE_TYPES: Record<number, { name: string; ext: string }> = {
    // Saved as they're stored: a bare bitmap (DIB), not yet an .ico, .cur or .bmp file.
    1: { name: 'Cursor', ext: 'dib' },
    2: { name: 'Bitmap', ext: 'dib' },
    3: { name: 'Icon', ext: 'dib' },
    4: { name: 'Menu', ext: 'bin' },
    5: { name: 'Dialog', ext: 'bin' },
    6: { name: 'String table', ext: 'bin' },
    7: { name: 'Font directory', ext: 'bin' },
    8: { name: 'Font', ext: 'fnt' },
    9: { name: 'Shortcut keys', ext: 'bin' },
    10: { name: 'Raw data', ext: 'bin' },
    11: { name: 'Message table', ext: 'bin' },
    12: { name: 'Cursor group', ext: 'bin' },
    14: { name: 'Icon group', ext: 'bin' },
    16: { name: 'Version', ext: 'bin' },
    17: { name: 'Dialog include', ext: 'h' },
    19: { name: 'Plug and Play', ext: 'bin' },
    20: { name: 'VxD', ext: 'bin' },
    21: { name: 'Animated cursor', ext: 'ani' },
    22: { name: 'Animated icon', ext: 'ani' },
    23: { name: 'HTML', ext: 'htm' },
    24: { name: 'Manifest', ext: 'manifest' },
};

/**
 * How many resources of each type there are, in words ("2 icons, 1 string table"): Windows' own types in lower case,
 * a program's named ones ("1 AVI") as it names them, and without an s.
 */
export function resourceCounts(resources: { type: number; typeName: string }[]): string {
    const counts = new Map<string, number>();
    for (const r of resources) {
        const t = r.type >= 0 && RESOURCE_TYPES[r.type] ? r.typeName.toLowerCase() : r.typeName;
        counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return [...counts].map(([t, n]) => `${n} ${t}${n === 1 || t !== t.toLowerCase() || t.endsWith('data') ? '' : 's'}`).join(', ') || 'none';
}

/** Where a resource's bytes are in the file. */
export interface Located {
    at: number;
    length: number;
}

/**
 * An icon or cursor group (at `at`, `length` bytes long) as the file Windows would save it as. `find` gives where the
 * icon (or cursor) with an ID is, or null when the module hasn't one. The group is a 6-byte header (0, 1 for icons or 2
 * for cursors, the count), then 14 bytes for each image: an icon's width, height, colors, reserved, planes, bits, size
 * and ID; a cursor's width, height doubled, planes, bits, size and ID. The file has a 16-byte entry for each image
 * instead, then the images. A cursor's image starts with its hot spot, which goes into its file entry.
 */
export function iconGroupFile(data: Uint8Array, at: number, length: number, cursor: boolean, find: (id: number) => Located | null): { file: Uint8Array | null; images: number; missing: number[] } {
    const b = new Bytes(data);
    const count = Math.max(0, Math.min(b.u16(at + 4), Math.floor((Math.min(length, data.length - at) - 6) / 14)));
    const listed = Array.from({ length: count }, (_, i) => {
        const e = at + 6 + i * 14;
        const id = b.u16(e + 12);
        const res = find(id);
        return { e, id, size: b.u32(e + 8), res: res && res.at >= 0 && res.at + res.length <= data.length && res.length >= (cursor ? 4 : 0) ? res : null };
    });
    const missing = listed.filter((i) => !i.res).map((i) => i.id);
    const present = listed.filter((i) => i.res);
    if (!present.length) return { file: null, images: 0, missing };
    // The image itself: the group's size for it (a 16-bit module rounds the resource up to its alignment), less a cursor's hot spot.
    const images = present.map((i) => {
        const res = i.res!;
        const skip = cursor ? 4 : 0;
        const size = Math.min(i.size || res.length, res.length) - skip;
        return { i, bytes: data.subarray(res.at + skip, res.at + skip + size), hotX: cursor ? b.u16(res.at) : 0, hotY: cursor ? b.u16(res.at + 2) : 0 };
    });
    const header = 6 + images.length * 16;
    const file = new Uint8Array(header + images.reduce((n, x) => n + x.bytes.length, 0));
    const v = new DataView(file.buffer);
    v.setUint16(2, cursor ? 2 : 1, true);
    v.setUint16(4, images.length, true);
    let to = header;
    images.forEach((x, k) => {
        const e = 6 + k * 16;
        if (cursor) {
            file[e] = b.u16(x.i.e) & 0xff;
            file[e + 1] = (b.u16(x.i.e + 2) / 2) & 0xff;
            v.setUint16(e + 4, x.hotX, true);
            v.setUint16(e + 6, x.hotY, true);
        } else {
            file.set(data.subarray(x.i.e, x.i.e + 8), e);
        }
        v.setUint32(e + 8, x.bytes.length, true);
        v.setUint32(e + 12, to, true);
        file.set(x.bytes, to);
        to += x.bytes.length;
    });
    return { file, images: images.length, missing };
}

/** What a version resource says. */
export interface VersionInfo {
    /** The numbers Windows compares (VS_FIXEDFILEINFO), as "1.2.3.4"; absent when it has none. */
    fileVersion?: string;
    productVersion?: string;
    /** What the program says about itself, in its own words: CompanyName, FileDescription and the rest, from its first string table. */
    strings: [string, string][];
    /** What doesn't fit, for warnings. */
    problems: string[];
}

/** What VS_FIXEDFILEINFO starts with. */
const VERSION_SIGNATURE = 0xfeef04bd;

/**
 * Reads a 32-bit version resource (UTF-16 keys and strings). Each node is its length, the length of its value, its
 * type (1: text, counted in characters; 0: binary, in bytes), its key, then its value and its children, each on a
 * 4-byte boundary from the resource's start. The root is VS_VERSION_INFO, its value the fixed numbers; its children
 * are StringFileInfo (string tables, one for each language, of name and value pairs) and VarFileInfo.
 */
export function readVersionInfo(data: Uint8Array, at: number, length: number): VersionInfo {
    const b = new Bytes(data);
    const end = Math.min(data.length, at + length);
    const problems: string[] = [];
    const align = (p: number) => at + Math.ceil((p - at) / 4) * 4;
    const utf16z = (p: number, to: number) => {
        let s = '';
        for (; p + 2 <= to && b.u16(p); p += 2) s += String.fromCharCode(b.u16(p));
        return { text: s, next: p + 2 };
    };
    interface Node {
        key: string;
        type: number;
        valueAt: number;
        valueLength: number;
        children: Node[];
    }
    // Each node is read within its parent, and only so deep: the tree is four levels at most (the root, StringFileInfo, a table, a string).
    const node = (p: number, to: number, depth: number): Node | null => {
        const size = b.u16(p);
        if (size < 6 || p + size > to) return null;
        const own = p + size;
        const valueLength = b.u16(p + 2);
        const type = b.u16(p + 4);
        const key = utf16z(p + 6, own);
        const valueAt = align(key.next);
        const valueBytes = type === 1 ? valueLength * 2 : valueLength;
        const children: Node[] = [];
        if (depth < 4) {
            for (let c = align(valueAt + valueBytes); c + 6 <= own;) {
                const child = node(c, own, depth + 1);
                if (!child) break;
                children.push(child);
                c = align(c + b.u16(c));
            }
        }
        return { key: key.text, type, valueAt, valueLength: Math.min(valueBytes, Math.max(0, own - valueAt)), children };
    };
    const root = node(at, end, 0);
    if (!root || root.key !== 'VS_VERSION_INFO') {
        problems.push('Its version resource isn’t laid out as Windows lays them out: it doesn’t start with VS_VERSION_INFO.');
        return { strings: [], problems };
    }
    const info: VersionInfo = { strings: [], problems };
    const four = (hi: number, lo: number) => `${hi >>> 16}.${hi & 0xffff}.${lo >>> 16}.${lo & 0xffff}`;
    if (root.valueLength >= 52) {
        const f = root.valueAt;
        if (b.u32(f) === VERSION_SIGNATURE) {
            info.fileVersion = four(b.u32(f + 8), b.u32(f + 12));
            info.productVersion = four(b.u32(f + 16), b.u32(f + 20));
        } else problems.push('Its version numbers don’t start with the signature Windows looks for (0xFEEF04BD), so Windows ignores them.');
    }
    // The first string table's names and values (a program usually has one, in the language it was made in).
    const table = root.children.find((c) => c.key === 'StringFileInfo')?.children[0];
    for (const s of table?.children ?? []) {
        const value = s.type === 1 || s.valueLength ? utf16z(s.valueAt, s.valueAt + s.valueLength).text : '';
        info.strings.push([s.key, value.trim()]);
    }
    return info;
}
