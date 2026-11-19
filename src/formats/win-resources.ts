import { Bytes, bytesLabel, field, hex } from '../core/bytes';
import type { Field } from '../core/types';

/**
 * What Windows programs of both kinds (16-bit NE, ne.ts; 32- and 64-bit PE, pe.ts) keep as resources, and how those
 * are read: the types Windows defines, icon and cursor groups made into the .ico and .cur files they'd be saved as,
 * and version information.
 *
 * The types are Microsoft's "Resource Types" (https://learn.microsoft.com/windows/win32/menurc/resource-types). Icon
 * and cursor groups are its GRPICONDIR and GRPICONDIRENTRY ("Resource File Formats",
 * https://learn.microsoft.com/windows/win32/menurc/resource-file-formats), and the .ico and .cur files they make are
 * laid out as ico.ts reads them. Version information is VS_VERSIONINFO, with its VS_FIXEDFILEINFO, StringFileInfo and
 * VarFileInfo (https://learn.microsoft.com/windows/win32/menurc/vs-versioninfo), and what each string is for from
 * the VERSIONINFO resource (https://learn.microsoft.com/windows/win32/menurc/versioninfo-resource). String tables are
 * laid out as Raymond Chen's "The format of string resources" (The Old New Thing, 2004,
 * https://devblogs.microsoft.com/oldnewthing/20040130-00/?p=40813) describes them; message tables are
 * MESSAGE_RESOURCE_DATA (see readMessageTable). A 16-bit module's version information and strings, in the code page
 * rather than UTF-16, were checked against real Windows 3 modules.
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

/**
 * A bitmap resource as the .bmp file it would be saved as: the 14-byte file header Windows leaves off resources ("BM",
 * the file's size, two reserved words, where the pixels start), then the resource as it's stored. The pixels follow the
 * header, the color masks of a 40-byte header with bit fields (3 masks; 4 with alpha), and the colors (3 bytes each
 * after a 12-byte header, 4 after the others): as many as the header says it uses, or all 2^bits for 8 bits or fewer.
 * Null when it doesn't start with a bitmap header at all.
 */
export function bitmapFile(data: Uint8Array, at: number, length: number): Uint8Array | null {
    const b = new Bytes(data);
    const size = b.u32(at);
    length = Math.min(length, data.length - at);
    if (![12, 40, 52, 56, 108, 124].includes(size) || length < size) return null;
    const core = size === 12;
    const bits = b.u16(at + (core ? 10 : 14));
    const compression = core ? 0 : b.u32(at + 16);
    const used = core ? 0 : b.u32(at + 32);
    const colors = bits <= 8 ? (used && used <= 1 << bits ? used : 2 ** bits) : used;
    const masks = size === 40 && (compression === 3 || compression === 6) ? (compression === 3 ? 12 : 16) : 0;
    const pixels = Math.min(length, size + masks + colors * (core ? 3 : 4));
    const file = new Uint8Array(14 + length);
    const v = new DataView(file.buffer);
    file.set([0x42, 0x4d]);
    v.setUint32(2, file.length, true);
    v.setUint32(10, 14 + pixels, true);
    file.set(data.subarray(at, at + length), 14);
    return file;
}

/** Common languages, by Windows' language IDs ([MS-LCID], https://learn.microsoft.com/openspecs/windows_protocols/ms-lcid). */
const LANGUAGES: Record<number, string> = {
    0: 'neutral',
    0x400: 'the user’s language',
    0x401: 'Arabic',
    0x404: 'Chinese (Traditional)',
    0x405: 'Czech',
    0x406: 'Danish',
    0x407: 'German',
    0x408: 'Greek',
    0x409: 'English (US)',
    0x40a: 'Spanish (traditional sort)',
    0x40b: 'Finnish',
    0x40c: 'French',
    0x40d: 'Hebrew',
    0x40e: 'Hungarian',
    0x410: 'Italian',
    0x411: 'Japanese',
    0x412: 'Korean',
    0x413: 'Dutch',
    0x414: 'Norwegian',
    0x415: 'Polish',
    0x416: 'Portuguese (Brazil)',
    0x419: 'Russian',
    0x41d: 'Swedish',
    0x41f: 'Turkish',
    0x804: 'Chinese (Simplified)',
    0x809: 'English (UK)',
    0x816: 'Portuguese',
    0xc0a: 'Spanish',
};

/** Languages by their primary ID, the low 10 bits of a language ID ([MS-LCID] again), for those not above. */
const PRIMARY: Record<number, string> = {
    0x01: 'Arabic',
    0x02: 'Bulgarian',
    0x03: 'Catalan',
    0x04: 'Chinese',
    0x05: 'Czech',
    0x06: 'Danish',
    0x07: 'German',
    0x08: 'Greek',
    0x09: 'English',
    0x0a: 'Spanish',
    0x0b: 'Finnish',
    0x0c: 'French',
    0x0d: 'Hebrew',
    0x0e: 'Hungarian',
    0x0f: 'Icelandic',
    0x10: 'Italian',
    0x11: 'Japanese',
    0x12: 'Korean',
    0x13: 'Dutch',
    0x14: 'Norwegian',
    0x15: 'Polish',
    0x16: 'Portuguese',
    0x18: 'Romanian',
    0x19: 'Russian',
    0x1a: 'Croatian or Serbian',
    0x1b: 'Slovak',
    0x1c: 'Albanian',
    0x1d: 'Swedish',
    0x1e: 'Thai',
    0x1f: 'Turkish',
    0x20: 'Urdu',
    0x21: 'Indonesian',
    0x22: 'Ukrainian',
    0x23: 'Belarusian',
    0x24: 'Slovenian',
    0x25: 'Estonian',
    0x26: 'Latvian',
    0x27: 'Lithuanian',
    0x29: 'Persian',
    0x2a: 'Vietnamese',
    0x2b: 'Armenian',
    0x2d: 'Basque',
    0x2f: 'Macedonian',
    0x36: 'Afrikaans',
    0x37: 'Georgian',
    0x38: 'Faroese',
    0x39: 'Hindi',
    0x3e: 'Malay',
    0x3f: 'Kazakh',
    0x41: 'Swahili',
    0x56: 'Galician',
    0x5b: 'Sinhala',
};

/** A language by its Windows ID, in words: by the whole ID when it's a common one, otherwise by its primary language and which form of it. */
export const languageName = (id: number) => {
    if (LANGUAGES[id]) return LANGUAGES[id];
    const primary = PRIMARY[id & 0x3ff];
    if (!primary) return `language ${hex(id, 4)}`;
    return id >> 10 ? `${primary} (form ${id >> 10})` : primary;
};

/** Common code pages, by number (Microsoft's "Code Page Identifiers", https://learn.microsoft.com/windows/win32/intl/code-page-identifiers). */
const CODE_PAGES: Record<number, string> = {
    0: 'no code page',
    437: 'DOS (US)',
    850: 'DOS (Western Europe)',
    932: 'Japanese (Shift JIS)',
    936: 'Chinese Simplified (GBK)',
    949: 'Korean',
    950: 'Chinese Traditional (Big5)',
    1200: 'Unicode',
    1250: 'Windows Central European',
    1251: 'Windows Cyrillic',
    1252: 'Windows Western',
    1253: 'Windows Greek',
    1254: 'Windows Turkish',
    1255: 'Windows Hebrew',
    1256: 'Windows Arabic',
    1257: 'Windows Baltic',
    1258: 'Windows Vietnamese',
};

/** A language and code page, as a version resource pairs them: "English (US), Unicode". */
const languageAndCodePage = (lang: number, codePage: number) => `${languageName(lang)}, ${CODE_PAGES[codePage] ?? `code page ${codePage}`}`;

/** What each of the names Windows defines for a version resource's strings is for, by "Version Information" (VERSIONINFO, https://learn.microsoft.com/windows/win32/menurc/versioninfo-resource). */
const VERSION_STRINGS: Record<string, string> = {
    Comments: 'Anything the makers wanted to add.',
    CompanyName: 'Who made it.',
    FileDescription: 'What it is, as Windows shows it to people.',
    FileVersion: 'Its version, as text: it needn’t match the numbers Windows compares.',
    InternalName: 'The name it was made under, without its extension.',
    LegalCopyright: 'Its copyright notice.',
    LegalTrademarks: 'The trademarks it names.',
    OriginalFilename: 'What the file was named when it was made: a file renamed since is under another name.',
    PrivateBuild: 'Who it was built for, when it isn’t the usual release.',
    ProductName: 'The product it’s part of.',
    ProductVersion: 'The product’s version, as text.',
    SpecialBuild: 'How it differs from the usual release.',
};

/** What a version resource says. */
export interface VersionInfo {
    /** The numbers Windows compares (VS_FIXEDFILEINFO), as "1.2.3.4"; absent when it has none. */
    fileVersion?: string;
    productVersion?: string;
    /** What the program says about itself, in its own words: CompanyName, FileDescription and the rest, from its first string table. */
    strings: [string, string][];
    /** Every string table: its language and code page in words, and its names and values. */
    tables: { language: string; strings: [string, string][] }[];
    /** The languages and code pages VarFileInfo lists, in words. */
    translations: string[];
    /** Its bytes, as fields; empty when it isn't a version resource at all. */
    fields: Field[];
    /** 16-bit (Windows 3: text in the code page, no type) or 32-bit (UTF-16). */
    wide: boolean;
    /** Where it ends, by its own length. */
    end: number;
    /** What doesn't fit, for warnings. */
    problems: string[];
}

/** What VS_FIXEDFILEINFO starts with. */
const VERSION_SIGNATURE = 0xfeef04bd;
const VERSION_FLAGS: [number, string][] = [
    [0x01, 'a debug build'],
    [0x02, 'a prerelease'],
    [0x04, 'patched'],
    [0x08, 'a private build'],
    [0x10, 'made by a tool, not written'],
    [0x20, 'a special build'],
];
const VERSION_OS: Record<number, string> = {
    0: 'not said',
    1: '16-bit Windows',
    4: '32-bit Windows',
    0x10000: 'DOS',
    0x10001: '16-bit Windows on DOS',
    0x10004: '32-bit Windows on DOS (Windows 95, 98, Me)',
    0x20000: '16-bit OS/2',
    0x20002: '16-bit Presentation Manager on 16-bit OS/2',
    0x30000: '32-bit OS/2',
    0x30003: '32-bit Presentation Manager on 32-bit OS/2',
    0x40000: 'Windows NT',
    0x40004: '32-bit Windows on Windows NT',
};
const VERSION_TYPES = ['not said', 'a program', 'a library (DLL)', 'a driver', 'a font', 'a virtual device (VxD)', 'type 6', 'a static library'];
const DRIVER_TYPES = ['', 'printer', 'keyboard', 'language', 'display', 'mouse', 'network', 'system', 'installable', 'sound', 'communications', 'input method', 'printer (versioned)'];
const FONT_TYPES = ['', 'raster', 'vector', 'TrueType'];

/**
 * Reads a version resource, 16- or 32-bit. Each node is its length, the length of its value, (32-bit only) its type
 * (1: text, its length counted in characters; 0: binary, in bytes), its key (UTF-16, or in the code page for 16-bit),
 * then its value and its children, each on a 4-byte boundary from the resource's start. The root is VS_VERSION_INFO,
 * its value the fixed numbers (VS_FIXEDFILEINFO); its children are StringFileInfo (string tables, one for each language
 * and code page, of names and values) and VarFileInfo (a Translation list of the languages and code pages there are).
 */
export function readVersionInfo(data: Uint8Array, at: number, length: number): VersionInfo {
    const b = new Bytes(data);
    const end = Math.min(data.length, at + length);
    const problems: string[] = [];
    const empty: VersionInfo = { strings: [], tables: [], translations: [], fields: [], wide: true, end: at, problems };
    const isKey = (p: number, step: number) => [...'VS_VERSION_INFO\0'].every((c, i) => p + i * step < end && data[p + i * step] === c.charCodeAt(0) && (step === 1 || data[p + i * step + 1] === 0));
    const wide = isKey(at + 6, 2);
    if (!wide && !isKey(at + 4, 1)) {
        problems.push('Its version resource isn’t laid out as Windows lays them out: it doesn’t start with VS_VERSION_INFO.');
        return empty;
    }
    const head = wide ? 6 : 4;
    const align = (p: number) => at + Math.ceil((p - at) / 4) * 4;
    const text = (p: number, to: number) => {
        let s = '';
        if (wide) for (; p + 2 <= to && b.u16(p); p += 2) s += String.fromCharCode(b.u16(p));
        else for (; p < to && data[p]; p++) s += String.fromCharCode(data[p]);
        return { text: s, next: Math.min(to, p + (wide ? 2 : 1)) };
    };
    const info: VersionInfo = { ...empty, wide, end: at + Math.min(b.u16(at), end - at) };
    const four = (hi: number, lo: number) => `${hi >>> 16}.${hi & 0xffff}.${lo >>> 16}.${lo & 0xffff}`;
    let cut = 0;
    let stray = 0;
    let deep = false;
    let badTable = '';

    /** The fixed numbers, field by field. */
    const fixed = (f: number): Field[] => {
        const u = (o: number) => b.u32(f + o);
        const flags = u(28) & u(24);
        const os = VERSION_OS[u(32)] ?? `0x${hex(u(32))}`;
        const type = u(36);
        const sub = u(40);
        const subtype = type === 3 ? DRIVER_TYPES[sub] || `type ${sub}` : type === 4 ? FONT_TYPES[sub] || `type ${sub}` : type === 5 ? `device ID ${sub}` : sub ? String(sub) : 'none';
        const stamp = u(44) * 2 ** 32 + u(48);
        // A FILETIME: 100-nanosecond steps from 1601.
        const date = stamp ? new Date(stamp / 10000 - 11644473600000) : null;
        return [
            field('Signature', f, 4, `0x${hex(u(0))}`, 'Always 0xFEEF04BD.'),
            field('Layout version', f + 4, 4, `${u(4) >>> 16}.${u(4) & 0xffff}`),
            field('File version', f + 8, 8, four(u(8), u(12)), 'The numbers Windows compares, to tell a newer file from an older one.'),
            field('Product version', f + 16, 8, four(u(16), u(20))),
            field('Flags that count', f + 24, 4, `0x${hex(u(24), 2)}`, 'Which of the flags after it mean anything.'),
            field(
                'Flags',
                f + 28,
                4,
                flags
                    ? VERSION_FLAGS.filter(([bit]) => flags & bit)
                          .map(([, w]) => w)
                          .join(', ')
                    : 'none'
            ),
            field('Made for', f + 32, 4, os),
            field('Kind', f + 36, 4, VERSION_TYPES[type] ?? `type ${type}`),
            field('Subkind', f + 40, 4, subtype),
            field('Date', f + 44, 8, date && !Number.isNaN(date.getTime()) ? date.toISOString().slice(0, 10) : 'none', 'Almost always left at 0.'),
        ];
    };

    /** A node (`depth` below the root), its children within it, and everything between them; `path` is the keys above it, from the root's children down. */
    const node = (p: number, to: number, path: string[], depth: number): Field | null => {
        const said = b.u16(p);
        if (said < head) return null;
        if (p + said > to) cut++;
        const own = Math.min(p + said, to);
        const valueSaid = b.u16(p + 2);
        const type = wide ? b.u16(p + 4) : 0;
        const key = text(p + head, own);
        const valueAt = Math.min(own, align(key.next));
        const isText = wide ? type === 1 : path.length >= 2 && path[0] === 'StringFileInfo';
        const valueBytes = Math.min(wide && type === 1 ? valueSaid * 2 : valueSaid, own - valueAt);
        const inside: Field[] = [
            field('Length', p, 2, bytesLabel(said)),
            field('Value length', p + 2, 2, wide && type === 1 ? `${valueSaid.toLocaleString('en-US')} characters` : bytesLabel(valueSaid)),
            ...(wide ? [field('Type', p + 4, 2, type === 1 ? 'text' : type === 0 ? 'binary' : String(type))] : []),
            field('Name', p + head, key.next - p - head, key.text),
        ];
        let value = '';
        let label = key.text;
        let note: string | undefined;
        if (depth === 0 && valueBytes >= 52 && b.u32(valueAt) === VERSION_SIGNATURE) {
            info.fileVersion = four(b.u32(valueAt + 8), b.u32(valueAt + 12));
            info.productVersion = four(b.u32(valueAt + 16), b.u32(valueAt + 20));
            inside.push({ ...field('Fixed numbers', valueAt, 52, info.fileVersion, 'VS_FIXEDFILEINFO: what Windows itself reads.'), children: fixed(valueAt) });
            if (valueBytes > 52) inside.push(field('More', valueAt + 52, valueBytes - 52, bytesLabel(valueBytes - 52)));
            label = 'Version information';
            value = info.fileVersion;
        } else if (depth === 0 && valueBytes) {
            problems.push('Its version numbers don’t start with the signature Windows looks for (0xFEEF04BD), so Windows ignores them.');
            inside.push(field('Fixed numbers', valueAt, valueBytes, bytesLabel(valueBytes)));
        } else if (path[0] === 'VarFileInfo' && key.text === 'Translation') {
            const pairs = Array.from({ length: Math.floor(valueBytes / 4) }, (_, i) => languageAndCodePage(b.u16(valueAt + i * 4), b.u16(valueAt + i * 4 + 2)));
            info.translations.push(...pairs);
            pairs.forEach((t, i) => inside.push(field('Language and code page', valueAt + i * 4, 4, t)));
            if (valueBytes % 4) inside.push(field('Left over', valueAt + valueBytes - (valueBytes % 4), valueBytes % 4, bytesLabel(valueBytes % 4)));
            label = 'Languages';
            value = pairs.join('; ');
            note = 'The languages and code pages the strings are in.';
        } else if (valueBytes) {
            value = isText ? text(valueAt, valueAt + valueBytes).text.trim() : bytesLabel(valueBytes);
            inside.push(field('Value', valueAt, valueBytes, value));
        }
        if (key.text === 'StringFileInfo' && depth === 1) label = 'Strings';
        if (key.text === 'VarFileInfo' && depth === 1) label = 'Languages';
        if (path[0] === 'StringFileInfo' && depth === 2) {
            const ok = /^[0-9a-f]{8}$/i.test(key.text);
            if (!ok) badTable ||= key.text;
            label = ok ? `Strings in ${languageAndCodePage(parseInt(key.text.slice(0, 4), 16), parseInt(key.text.slice(4), 16))}` : `Strings under "${key.text}"`;
            note = 'Named for its language and code page, as 8 hex digits.';
        }
        if (path[0] === 'StringFileInfo' && depth === 3) note = VERSION_STRINGS[key.text];
        // The children, as deep as Windows reads (a string is 4 below the root) and a little more.
        const kids: Field[] = [];
        let c = align(valueAt + valueBytes);
        if (depth < 5) {
            for (; c + head <= own;) {
                const child = node(c, own, depth === 0 ? [] : [...path, key.text], depth + 1);
                if (!child) break;
                kids.push(child);
                c = align(c + Math.max(head, b.u16(c)));
            }
        } else if (c < own) {
            deep = true;
            inside.push(field('Deeper', c, own - c, bytesLabel(own - c), 'Parts deeper than Windows reads; not read.'));
        }
        if (path[0] === 'StringFileInfo' && depth === 2) {
            const strings = kids.map((k) => [k.name, k.value ?? ''] as [string, string]);
            info.tables.push({ language: label.replace(/^Strings (in|under) /, ''), strings });
            if (info.tables.length === 1) info.strings = strings;
        }
        if (depth === 1 && key.text === 'StringFileInfo') value = `${kids.length} table${kids.length === 1 ? '' : 's'}`;
        if (path[0] === 'StringFileInfo' && depth === 2) value = `${kids.length} string${kids.length === 1 ? '' : 's'}`;
        // What lies between and after the parts: zeros to the 4-byte boundaries, or something nothing accounts for.
        const children: Field[] = [];
        let covered = p;
        const gap = (to: number) => {
            if (to <= covered) return;
            const zeros = data.subarray(covered, to).every((v) => v === 0);
            if (!zeros) stray++;
            children.push(field(zeros ? 'Padding' : 'Not read', covered, to - covered, bytesLabel(to - covered), zeros ? undefined : 'Nothing in the version information accounts for it.'));
        };
        for (const f of [...inside, ...kids].sort((x, y) => x.offset - y.offset)) {
            if (f.length <= 0) continue;
            gap(f.offset);
            children.push(f);
            covered = Math.max(covered, f.offset + f.length);
        }
        gap(own);
        return { ...field(label, p, own - p, value, note), children };
    };

    const root = node(at, end, [], 0);
    if (root) info.fields = [root];
    if (cut)
        problems.push(
            `${cut === 1 ? 'One part' : `${cut} parts`} of the version information ${cut === 1 ? 'says it’s' : 'say they’re'} longer than what holds ${cut === 1 ? 'it' : 'them'}: ${cut === 1 ? 'it was' : 'they were'} read only that far.`
        );
    if (stray) problems.push(`The version information has bytes nothing in it accounts for, in ${stray === 1 ? 'one place' : `${stray} places`}.`);
    if (deep) problems.push('The version information goes deeper than Windows reads; what’s below wasn’t read.');
    if (badTable) problems.push(`A string table in the version information is named "${badTable}", not a language and code page as 8 hex digits, so Windows won’t find its strings.`);
    return info;
}

/** What a version resource says, as lines of text: its numbers, each string table, and its languages. */
export function versionText(v: VersionInfo): string {
    return [
        ...(v.fileVersion ? [`File version: ${v.fileVersion}`, `Product version: ${v.productVersion}`] : []),
        ...v.tables.flatMap((t, i) => [...(v.tables.length > 1 || i ? ['', `In ${t.language}:`] : []), ...t.strings.map(([k, x]) => `${k}: ${x}`)]),
        ...(v.translations.length ? ['', `Languages: ${v.translations.join('; ')}`] : []),
    ]
        .join('\n')
        .trim();
}

/** A string or message, and where it is. */
export interface ResourceString {
    id: number;
    text: string;
    at: number;
    length: number;
}

/**
 * The strings in a string table resource. Windows keeps them 16 to a resource: the resource numbered n holds strings
 * (n − 1) × 16 to (n − 1) × 16 + 15, each its length (in UTF-16 characters, 2 bytes; for a 16-bit module, in bytes, 1
 * byte) and then its text, with no end marker. Empty strings are only their length. `block` is the resource's number,
 * or -1 when it has a name instead (the IDs are then counted from 0). Fields cover every byte.
 */
export function readStringTable(data: Uint8Array, at: number, length: number, block: number, wide: boolean): { strings: ResourceString[]; fields: Field[]; problems: string[] } {
    const b = new Bytes(data);
    const end = Math.min(data.length, at + length);
    const first = block > 0 ? (block - 1) * 16 : 0;
    const strings: ResourceString[] = [];
    const fields: Field[] = [];
    const problems: string[] = [];
    const size = wide ? 2 : 1;
    let p = at;
    let empty = 0;
    let i = 0;
    const flushEmpty = () => {
        const from = first + i - empty;
        if (empty)
            fields.push(field('Not used', p - empty * size, empty * size, empty === 1 ? `String ${from}` : `Strings ${from}–${from + empty - 1}`, 'A length of 0: there’s no string with this ID.'));
        empty = 0;
    };
    for (; i < 16 && p + size <= end; i++) {
        const n = wide ? b.u16(p) : data[p];
        if (!n) {
            empty++;
            p += size;
            continue;
        }
        flushEmpty();
        const room = Math.floor((end - p - size) / size);
        if (n > room) problems.push(`String ${first + i} says it’s ${n.toLocaleString('en-US')} characters long, past the end of its table.`);
        const count = Math.min(n, room);
        let s = '';
        for (let k = 0; k < count; k++) s += String.fromCharCode(wide ? b.u16(p + size + k * 2) : data[p + 1 + k]);
        strings.push({ id: first + i, text: s, at: p, length: size + count * size });
        fields.push(field(`String ${first + i}`, p, size + count * size, s));
        p += size + count * size;
    }
    flushEmpty();
    if (p < end) {
        const zeros = data.subarray(p, end).every((v) => v === 0);
        fields.push(field(zeros ? 'Padding' : 'Not read', p, end - p, bytesLabel(end - p), zeros ? undefined : 'Past its 16 strings.'));
        if (!zeros) problems.push(`A string table has ${bytesLabel(end - p)} after its 16 strings that aren’t any of them.`);
    }
    return { strings, fields, problems };
}

/**
 * The messages in a message table resource (32-bit only): how many blocks, then for each the first and last message
 * ID and where its messages start, from the resource's start. Each message is its length (the whole entry, a multiple
 * of 4), its flags (1: UTF-16, otherwise the code page) and its text, usually ending in a line break and padded with
 * NULs. See MESSAGE_RESOURCE_DATA (https://learn.microsoft.com/windows/win32/api/winnt/ns-winnt-message_resource_data).
 */
export function readMessageTable(data: Uint8Array, at: number, length: number): { strings: ResourceString[]; fields: Field[]; problems: string[] } {
    const b = new Bytes(data);
    const end = Math.min(data.length, at + length);
    const strings: ResourceString[] = [];
    const fields: Field[] = [];
    const problems: string[] = [];
    if (at + 4 > end) return { strings, fields, problems: ['A message table is too short to say how many blocks it has.'] };
    const said = b.u32(at);
    const blocks = Math.min(said, Math.floor((end - at - 4) / 12));
    if (blocks < said) problems.push(`A message table says it has ${said.toLocaleString('en-US')} blocks, but has room for ${blocks.toLocaleString('en-US')}.`);
    fields.push(field('Blocks', at, 4, blocks));
    if (blocks) fields.push(field('Block list', at + 4, blocks * 12, `${blocks} × 12 bytes`, 'For each block: its first and last message ID, and where its messages start.'));
    // Every message read takes from what the table could hold, so blocks that overlap can't make it read forever.
    let left = Math.floor((end - at) / 4);
    let short = 0;
    for (let k = 0; k < blocks; k++) {
        const e = at + 4 + k * 12;
        const low = b.u32(e);
        const high = b.u32(e + 4);
        let p = at + b.u32(e + 8);
        if (high < low || p >= end) {
            problems.push(high < low ? `Block ${k + 1} of a message table runs from message ${low} down to ${high}.` : `Block ${k + 1} of a message table is said to start past its end.`);
            continue;
        }
        const from = p;
        for (let id = low; id <= high && left > 0; id++, left--) {
            const n = b.u16(p);
            if (n < 4 || p + n > end) {
                short++;
                break;
            }
            const unicode = b.u16(p + 2) & 1;
            let s = unicode ? '' : new TextDecoder('latin1').decode(data.subarray(p + 4, p + n));
            if (unicode) for (let q = p + 4; q + 2 <= p + n; q += 2) s += String.fromCharCode(b.u16(q));
            s = s.replace(/\0+$/, '').replace(/\r?\n$/, '');
            strings.push({ id, text: s, at: p, length: n });
            p += n;
        }
        if (p > from)
            fields.push({
                ...field(low === high ? `Message ${low}` : `Messages ${low}–${high}`, from, p - from, `${(high - low + 1).toLocaleString('en-US')} message${low === high ? '' : 's'}`),
                children: strings.filter((s) => s.at >= from && s.at < p).map((s) => field(`Message ${s.id}`, s.at, s.length, s.text)),
            });
    }
    if (short) problems.push(`${short === 1 ? 'A block' : `${short} blocks`} of a message table ${short === 1 ? 'runs' : 'run'} out before ${short === 1 ? 'its' : 'their'} last message.`);
    return { strings, fields, problems };
}

/**
 * A 32-bit resource file (.res), as a resource compiler writes one: an empty entry first (32 bytes: no data, a
 * 32-byte header, type 0 and name 0), which tells it from a 16-bit one, then each resource, a header and its data, each
 * on a 4-byte boundary. A header is the data's size, its own size, the type and the name (each 0xFFFF and a number, or
 * UTF-16 text), then on a 4-byte boundary the data's version, memory flags, language, version and characteristics.
 * See Microsoft's RESOURCEHEADER (https://learn.microsoft.com/windows/win32/menurc/resourceheader).
 */
export function resourceFile(resources: { type: number; id: number; name: string; lang: number; data: Uint8Array }[]): Uint8Array {
    const parts: number[][] = [];
    const u16 = (v: number) => [v & 0xff, (v >> 8) & 0xff];
    const u32 = (v: number) => [...u16(v & 0xffff), ...u16(v >>> 16)];
    const pad4 = (b: number[]) => [...b, ...new Array((4 - (b.length % 4)) % 4).fill(0)];
    const id = (n: number, name: string) => (n >= 0 ? [...u16(0xffff), ...u16(n)] : [...[...name].flatMap((c) => u16(c.charCodeAt(0))), 0, 0]);
    const header = (size: number, type: number[], name: number[], lang: number, flags: number) => {
        const h = pad4([...type, ...name]);
        const rest = [...u32(0), ...u16(flags), ...u16(lang), ...u32(0), ...u32(0)];
        return [...u32(size), ...u32(8 + h.length + rest.length), ...h, ...rest];
    };
    parts.push(header(0, [...u16(0xffff), ...u16(0)], [...u16(0xffff), ...u16(0)], 0, 0));
    for (const r of resources) {
        // MOVEABLE, PURE and DISCARDABLE, as resource compilers mark them.
        parts.push(header(r.data.length, [...u16(0xffff), ...u16(r.type)], id(r.id, r.name), r.lang, 0x1030));
        parts.push(pad4([...r.data]));
    }
    return Uint8Array.from(parts.flat());
}
