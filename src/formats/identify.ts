/**
 * Working out what bytes are without a parser: the signatures file types
 * start with (ours and others, such as programs and documents), and how
 * random the bytes look. Used to say what a file really is when it isn't
 * what it claims, and what's hidden after one.
 */

export interface Signature {
    /** What it is, e.g. "Windows program (PE)". */
    name: string;
    /** The extension to save such files under. */
    ext: string;
    /** Every extension such files go by, when there are others. */
    exts?: string[];
    /** The format here that reads it, when there is one. */
    format?: string;
    /** How many bytes the signature takes. */
    length: number;
    /** Programs, scripts and other things that run. */
    runs?: boolean;
    /** A program's container with no code in it (a 16-bit Windows module holding only icons or fonts): nothing to run, but it isn't what another name says either. */
    codeless?: boolean;
}

/** What DOS and Windows programs and libraries are named. */
const PROGRAMS = ['exe', 'dll', 'com', 'scr', 'sys', 'ocx', 'cpl', 'drv', 'mod', 'efi', 'mui', 'ax', 'vxd', '386', 'ovl', 'acm', 'tsp', 'ime'];

/** Whether a file with this signature is named as such files are. */
export function namedAs(sig: Signature, ext: string | null): boolean {
    return ext !== null && (sig.exts ?? [sig.ext]).includes(ext);
}

/** The resource types a 16-bit Windows module names, for saying what one holds. */
const NE_RESOURCES: Record<number, string> = { 0x8001: 'cursors', 0x8002: 'bitmaps', 0x8003: 'icons', 0x8004: 'menus', 0x8005: 'dialogs', 0x8006: 'strings', 0x8008: 'fonts', 0x8009: 'shortcut keys' };

/**
 * A 16-bit Windows (or OS/2) module: "NE" where the MZ header points. One with
 * no code segments and no entry points can't run: it only holds resources,
 * as icon libraries (.icl) and Windows' bitmap fonts (.fon) do.
 */
function newExecutable(data: Uint8Array, ne: number): Signature | null {
    if (ne < 64 || ne + 64 > data.length || !(data[ne] === 0x4e && data[ne + 1] === 0x45)) return null;
    const os = data[ne + 0x36] === 1 ? 'OS/2' : 'Windows';
    const segments = u16le(data, ne + 0x1c);
    const entries = u16le(data, ne + 0x06);
    if (segments || entries) return { name: `16-bit ${os} program or library (NE)`, ext: 'exe', exts: PROGRAMS, format: 'ne', length: 2, runs: true };
    // What it holds, from its resource table: a shift, then for each type an ID, a count and a word, then that many 12-byte entries.
    const held = new Set<string>();
    let at = ne + u16le(data, ne + 0x24) + 2;
    for (let guard = 0; guard < 64 && at + 8 <= data.length; guard++) {
        const type = u16le(data, at);
        if (type === 0) break;
        const name = NE_RESOURCES[type & 0xffff];
        if (name) held.add(name);
        at += 8 + u16le(data, at + 2) * 12;
    }
    const kinds = [...held].filter((k) => k !== 'shortcut keys');
    const what = kinds.length ? kinds.join(' and ') : 'resources';
    const ext = held.has('fonts') ? 'fon' : held.has('icons') ? 'icl' : 'dll';
    return { name: `16-bit ${os} module with no code (NE), holding ${what}`, ext, exts: ['icl', 'fon', 'dll', 'exe'], format: 'ne', length: 2, codeless: true };
}

const ascii = (data: Uint8Array, at: number, text: string) => {
    if (at + text.length > data.length) return false;
    for (let i = 0; i < text.length; i++) if (data[at + i] !== text.charCodeAt(i)) return false;
    return true;
};
const bytes = (data: Uint8Array, at: number, values: number[]) => at + values.length <= data.length && values.every((v, i) => data[at + i] === v);
const u16le = (data: Uint8Array, at: number) => (at + 2 <= data.length ? data[at] | (data[at + 1] << 8) : 0);
const u32le = (data: Uint8Array, at: number) => (data[at] | (data[at + 1] << 8) | (data[at + 2] << 16) | (data[at + 3] << 24)) >>> 0;

/** Text-based signatures may follow a byte order mark and blank space. */
function textStart(data: Uint8Array): number {
    let at = bytes(data, 0, [0xef, 0xbb, 0xbf]) ? 3 : 0;
    while (at < Math.min(data.length, 256) && (data[at] === 0x20 || data[at] === 0x09 || data[at] === 0x0a || data[at] === 0x0d)) at++;
    return at;
}

function lower(data: Uint8Array, at: number, text: string): boolean {
    if (at + text.length > data.length) return false;
    for (let i = 0; i < text.length; i++) if ((data[at + i] | 0x20) !== text.charCodeAt(i)) return false;
    return true;
}

/**
 * The signature the data starts with, if any. Loose on purpose for the
 * formats read here (a GIF is "GIF", not the full "GIF89a"), since a file
 * that only starts like one is exactly what's worth catching.
 */
export function signature(data: Uint8Array): Signature | null {
    // Formats read here.
    if (ascii(data, 0, 'GIF')) return { name: 'GIF picture', ext: 'gif', format: 'gif', length: ascii(data, 3, '87a') || ascii(data, 3, '89a') ? 6 : 3 };
    if (bytes(data, 0, [0x89, 0x50, 0x4e, 0x47])) return { name: 'PNG picture', ext: 'png', format: 'png', length: 4 };
    if (bytes(data, 0, [0xff, 0xd8, 0xff])) return { name: 'JPEG picture', ext: 'jpg', exts: ['jpg', 'jpeg', 'jpe', 'jfif'], format: 'jpeg', length: 3 };
    if (ascii(data, 0, 'II*\0') || ascii(data, 0, 'MM\0*')) return { name: 'TIFF picture', ext: 'tif', format: 'tiff', length: 4 };
    if (ascii(data, 0, 'FWS') || ascii(data, 0, 'CWS') || ascii(data, 0, 'ZWS')) return { name: 'Flash movie', ext: 'swf', format: 'swf', length: 3 };
    if (ascii(data, 0, 'OggS')) return { name: 'Ogg', ext: 'ogg', format: 'ogg', length: 4 };
    if (ascii(data, 0, 'MThd') && data[7] >= 6) return { name: 'MIDI music', ext: 'mid', format: 'midi', length: 8 };
    if (ascii(data, 0, 'RIFF') && ascii(data, 8, 'WAVE')) return { name: 'WAV sound', ext: 'wav', format: 'wav', length: 12 };
    if (ascii(data, 0, 'Creative Voice')) return { name: 'Creative Voice sound', ext: 'voc', format: 'voc', length: ascii(data, 14, ' File\x1a') ? 20 : 14 };
    if (ascii(data, 0, 'ID3')) return { name: 'MP3 sound', ext: 'mp3', format: 'mp3', length: 3 };
    if (ascii(data, 0, 'OTTO') || ascii(data, 0, 'ttcf')) return { name: 'OpenType font', ext: 'otf', exts: ['otf', 'ttc', 'otc', 'ttf'], format: 'sfnt', length: 4 };
    if (ascii(data, 0, 'BIK') || ascii(data, 0, 'KB2')) return { name: 'Bink video', ext: 'bik', format: 'bink', length: 3 };

    // Programs.
    if (ascii(data, 0, 'MZ') && data.length >= 64) {
        const pe = u32le(data, 0x3c);
        if (pe + 24 <= data.length && ascii(data, pe, 'PE\0\0')) {
            const machine = data[pe + 4] | (data[pe + 5] << 8);
            const dll = (data[pe + 22] | (data[pe + 23] << 8)) & 0x2000;
            const bits = machine === 0x8664 || machine === 0xaa64 ? '64-bit' : machine === 0x14c ? '32-bit' : `machine ${machine.toString(16).toUpperCase()}`;
            return { name: `Windows ${dll ? 'library (DLL' : 'program (PE'}, ${bits})`, ext: dll ? 'dll' : 'exe', exts: PROGRAMS, length: 2, runs: true };
        }
        const ne = newExecutable(data, pe);
        if (ne) return ne;
        if (pe + 4 <= data.length && (ascii(data, pe, 'LE') || ascii(data, pe, 'LX')))
            return { name: `${ascii(data, pe, 'LE') ? 'Windows driver or OS/2' : 'OS/2'} program (${ascii(data, pe, 'LE') ? 'LE' : 'LX'})`, ext: 'exe', exts: PROGRAMS, length: 2, runs: true };
        return { name: 'DOS or Windows program (MZ)', ext: 'exe', exts: PROGRAMS, length: 2, runs: true };
    }
    if (bytes(data, 0, [0x7f, 0x45, 0x4c, 0x46])) return { name: 'Linux or Unix program (ELF)', ext: 'elf', length: 4, runs: true };
    if (
        [
            [0xfe, 0xed, 0xfa, 0xce],
            [0xce, 0xfa, 0xed, 0xfe],
            [0xfe, 0xed, 0xfa, 0xcf],
            [0xcf, 0xfa, 0xed, 0xfe],
        ].some((m) => bytes(data, 0, m))
    )
        return { name: 'Mac program (Mach-O)', ext: 'macho', length: 4, runs: true };
    if (bytes(data, 0, [0xca, 0xfe, 0xba, 0xbe])) return { name: 'Java class or Mac universal program', ext: 'class', length: 4, runs: true };
    if (ascii(data, 0, 'dex\n')) return { name: 'Android program (DEX)', ext: 'dex', length: 4, runs: true };
    if (bytes(data, 0, [0x00, 0x61, 0x73, 0x6d])) return { name: 'WebAssembly module', ext: 'wasm', length: 4, runs: true };
    if (bytes(data, 0, [0x4c, 0, 0, 0, 0x01, 0x14, 0x02, 0, 0, 0, 0, 0, 0xc0, 0, 0, 0, 0, 0, 0, 0x46])) return { name: 'Windows shortcut (.lnk)', ext: 'lnk', length: 20, runs: true };
    if (ascii(data, 0, '#!')) return { name: 'Script (#! line)', ext: 'sh', length: 2, runs: true };

    // Archives and compressed data.
    if (ascii(data, 0, 'PK\x03\x04') || ascii(data, 0, 'PK\x05\x06') || ascii(data, 0, 'PK\x07\x08'))
        return {
            name: 'ZIP archive (or a .docx, .xlsx, .jar, .apk)',
            ext: 'zip',
            exts: ['zip', 'docx', 'xlsx', 'pptx', 'jar', 'apk', 'odt', 'ods', 'odp', 'epub', 'xpi', 'crx', 'nupkg', 'whl', 'vsix', 'ipa', 'appx', 'msix', 'kmz', '3mf', 'pk3', 'pk4'],
            length: 4,
        };
    if (ascii(data, 0, 'Rar!\x1a\x07')) return { name: 'RAR archive', ext: 'rar', length: 6 };
    if (bytes(data, 0, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return { name: '7-Zip archive', ext: '7z', length: 6 };
    if (bytes(data, 0, [0x1f, 0x8b, 0x08])) return { name: 'gzip-compressed data', ext: 'gz', length: 3 };
    if (ascii(data, 0, 'BZh') && data[3] >= 0x31 && data[3] <= 0x39) return { name: 'bzip2-compressed data', ext: 'bz2', length: 4 };
    if (bytes(data, 0, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])) return { name: 'xz-compressed data', ext: 'xz', length: 6 };
    if (bytes(data, 0, [0x28, 0xb5, 0x2f, 0xfd])) return { name: 'Zstandard-compressed data', ext: 'zst', length: 4 };
    if (ascii(data, 0, 'MSCF')) return { name: 'Windows cabinet archive', ext: 'cab', length: 4 };
    if (data.length > 0x8006 && ascii(data, 0x8001, 'CD001')) return { name: 'Disc image (ISO 9660)', ext: 'iso', length: 0 };

    // Documents.
    if (ascii(data, 0, '%PDF-')) return { name: 'PDF document', ext: 'pdf', length: 5 };
    if (bytes(data, 0, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))
        return {
            name: 'Compound file (old Office document, MSI installer, Outlook message)',
            ext: 'doc',
            exts: ['doc', 'xls', 'ppt', 'msi', 'msg', 'dot', 'xlt', 'pot', 'mpp', 'vsd', 'pub', 'db'],
            length: 8,
        };
    if (ascii(data, 0, '{\\rtf')) return { name: 'RTF document', ext: 'rtf', length: 5 };
    if (ascii(data, 0, 'ITSF')) return { name: 'Compiled help (CHM)', ext: 'chm', length: 4, runs: true };
    if (ascii(data, 0, 'SQLite format 3\0')) return { name: 'SQLite database', ext: 'sqlite', length: 16 };
    if (ascii(data, 0, 'BM') && data.length >= 26 && u32le(data, 2) === data.length) return { name: 'BMP picture', ext: 'bmp', length: 2 };
    if (ascii(data, 0, 'RIFF') && ascii(data, 8, 'WEBP')) return { name: 'WebP picture', ext: 'webp', length: 12 };
    if (ascii(data, 0, 'RIFF') && ascii(data, 8, 'AVI ')) return { name: 'AVI video', ext: 'avi', length: 12 };
    if (ascii(data, 0, 'FLV\x01')) return { name: 'Flash video (FLV)', ext: 'flv', length: 4 };

    // Text.
    const t = textStart(data);
    if (ascii(data, t, '-----BEGIN ')) return { name: 'PEM key or certificate', ext: 'pem', length: t + 11 };
    if (lower(data, t, '<!doctype html') || lower(data, t, '<html')) return { name: 'Web page (HTML)', ext: 'html', exts: ['html', 'htm', 'xhtml', 'shtml'], length: t + 5 };
    if (lower(data, t, '<?php')) return { name: 'PHP script', ext: 'php', length: t + 5, runs: true };
    if (lower(data, t, '<?xml')) return { name: 'XML', ext: 'xml', length: t + 5 };
    return null;
}

/** Bits of information per byte, 0 (all the same) to 8 (as random as bytes get). */
export function entropy(data: Uint8Array): number {
    // A sample is enough to tell, and keeps huge files quick.
    const sample = data.length > 1 << 24 ? data.subarray(0, 1 << 24) : data;
    if (!sample.length) return 0;
    const counts = new Uint32Array(256);
    for (let i = 0; i < sample.length; i++) counts[sample[i]]++;
    let bits = 0;
    for (const c of counts) {
        if (!c) continue;
        const p = c / sample.length;
        bits -= p * Math.log2(p);
    }
    return bits;
}
