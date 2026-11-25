import { Bytes, bytesLabel, field, fillGaps, hex } from '../core/bytes';
import { minOf } from '../core/math';
import type { Field, FormatParser, Preview, TableRow } from '../core/types';
import { entropy, signature } from './identify';
import { peOffset } from './pe-sniff';
import { viewResources } from './win-resource-view';
import { languageName, namesForResources, resourceCounts, RESOURCE_TYPES } from './win-resources';
import { readSignature, signedBy } from './pkcs7';

/**
 * Windows programs and libraries from Windows 95 and NT on, "Portable Executable" (PE): .exe, .dll, .sys, .ocx, .cpl,
 * .scr and the rest, 32-bit (PE32) and 64-bit (PE32+). An MZ header (and a DOS program that says it needs Windows),
 * then "PE", the file header, the optional header (which, despite its name, every program has) and the section table.
 * The sections follow: the code, the data, and the tables the optional header's data directories point to, each by
 * its address in memory once loaded (an RVA, from where the program is loaded), which the section table maps to the file:
 *
 * - imports: the libraries the program needs, and the functions it calls in each;
 * - exports: the functions a library offers;
 * - resources: icons, cursors, bitmaps, dialogs, menus, strings, version information and the rest, in a three-level
 *   tree (type, name, language);
 * - and the rest: base relocations (for when it can't be loaded where it asks), debug information (where the
 *   program's symbols were left, a PDB file's path), thread-local storage (TLS, whose callbacks run before the
 *   program does), the .NET runtime header, and the signatures, which aren't loaded and are found by file offset.
 *
 * What follows the sections, when nothing points to it, isn't the program's (an installer's payload, or something
 * hidden), and is left to the checks every file gets.
 *
 * See Microsoft's "PE Format" (https://learn.microsoft.com/windows/win32/debug/pe-format), which this follows, and
 * win-resources.ts for the resources. Microsoft's linker also leaves an undocumented record of the tools that made the
 * program in the DOS stub, the "Rich" header: its layout is from Daniel Pistelli's "Microsoft's Rich Signature
 * (undocumented)" (2008, https://ntcore.com/files/richsign.htm). How its checksum is made was worked out here from
 * real programs, and every one checked agrees: the offset of its start, plus each byte before it (except the four
 * at 0x3C, which say where the PE header is) rotated left by its offset, plus each record's tool rotated left by its count.
 */

const MACHINES: Record<number, string> = {
    0x0: 'any processor',
    0x14c: 'Intel 386 (x86)',
    0x166: 'MIPS (little-endian)',
    0x184: 'Alpha',
    0x1c0: 'ARM',
    0x1c2: 'ARM Thumb',
    0x1c4: 'ARM Thumb-2',
    0x1f0: 'PowerPC',
    0x200: 'Intel Itanium',
    0x5064: 'RISC-V 64-bit',
    0x8664: 'x64',
    0xaa64: 'ARM64',
    0xebc: 'EFI byte code',
};
const SUBSYSTEMS: Record<number, string> = {
    0: 'unknown',
    1: 'none (a driver, or a native Windows program)',
    2: 'Windows, with a window (GUI)',
    3: 'Windows, in a console',
    5: 'OS/2, in a console',
    7: 'POSIX, in a console',
    8: 'Windows 9x driver',
    9: 'Windows CE',
    10: 'EFI program',
    11: 'EFI boot service driver',
    12: 'EFI runtime driver',
    13: 'EFI ROM',
    14: 'Xbox',
    16: 'Windows boot program',
};
const FILE_FLAGS: [number, string][] = [
    [0x0001, 'no relocations'],
    [0x0002, 'can run'],
    [0x0004, 'no line numbers'],
    [0x0008, 'no local symbols'],
    [0x0010, 'trim working set'],
    [0x0020, 'large addresses'],
    [0x0080, 'bytes reversed (low)'],
    [0x0100, '32-bit'],
    [0x0200, 'no debug info'],
    [0x0400, 'copy to swap from removable media'],
    [0x0800, 'copy to swap from the network'],
    [0x1000, 'system file'],
    [0x2000, 'library (DLL)'],
    [0x4000, 'one processor only'],
    [0x8000, 'bytes reversed (high)'],
];
const DLL_FLAGS: [number, string][] = [
    [0x0020, '64-bit address randomization'],
    [0x0040, 'can be moved (ASLR)'],
    [0x0080, 'signature checked'],
    [0x0100, 'no running data (DEP)'],
    [0x0200, 'no isolation'],
    [0x0400, 'no structured exceptions'],
    [0x0800, 'don’t bind'],
    [0x1000, 'app container'],
    [0x2000, 'WDM driver'],
    [0x4000, 'control flow guard'],
    [0x8000, 'terminal server aware'],
];
const SECTION_FLAGS: [number, string][] = [
    [0x20, 'code'],
    [0x40, 'data'],
    [0x80, 'uninitialized data'],
    [0x02000000, 'discardable'],
    [0x04000000, 'not cached'],
    [0x08000000, 'not paged'],
    [0x10000000, 'shared'],
    [0x20000000, 'runs'],
    [0x40000000, 'read'],
    [0x80000000, 'written'],
];
const DIRECTORIES = [
    'export table',
    'import table',
    'resource table',
    'exception table',
    'signatures',
    'base relocations',
    'debug directory',
    'architecture entry',
    'global pointer',
    'TLS directory',
    'load configuration',
    'bound imports',
    'import address table',
    'delay-load imports',
    '.NET runtime header',
    'reserved entry',
];
const DEBUG_TYPES: Record<number, string> = {
    1: 'COFF',
    2: 'CodeView',
    3: 'frame pointer omission',
    4: 'DBG file',
    5: 'exception data',
    6: 'fixups',
    7: 'map to source',
    8: 'map from source',
    9: 'Borland',
    11: 'CLSID',
    12: 'Visual C++ features',
    13: 'profile-guided optimization',
    14: 'more DLL flags',
    16: 'reproducible build',
    17: 'embedded portable PDB',
    19: 'PDB checksum',
    20: 'more DLL flags',
};

/** Each named flag set in `value`, in words. */
const flagWords = (value: number, names: [number, string][]) =>
    names
        .filter(([bit]) => (value & bit) >>> 0 === bit)
        .map(([, n]) => n)
        .join(', ') || 'none';
/** "1 entry", "2 entries", "2 addresses". */
const plural = (n: number, word: string) => `${n.toLocaleString('en-US')} ${n === 1 ? word : /[^aeiou]y$/.test(word) ? `${word.slice(0, -1)}ies` : /s$/.test(word) ? `${word}es` : `${word}s`}`;
const date = (t: number) => (t ? `${new Date(t * 1000).toISOString().slice(0, 19).replace('T', ' ')} UTC` : 'Not set');
const rvaText = (rva: number) => `RVA 0x${hex(rva)}`;
/** Bytes with this many bits of entropy a byte, or more, look compressed or encrypted (inspect.ts says the same of a whole file). */
const RANDOM = 7.5;

interface Section {
    i: number;
    name: string;
    entryAt: number;
    va: number;
    /** How much memory it takes once loaded: its virtual size, or (Watcom's linker leaves that 0) its size in the file. */
    memSize: number;
    rawSize: number;
    /** Where its bytes are in the file, and how many of them are there; null when it has none in the file. */
    fileAt: number | null;
    fileLength: number;
    flags: number;
}

/** A function a program imports or a library exports, for the table. */
interface Imported {
    name: string;
    ordinal?: number;
    hint?: number;
}

const parser: FormatParser = {
    parse(data, context) {
        const pe = peOffset(data);
        if (pe === null) throw new Error('This isn’t a Windows program or library: its MZ header doesn’t point to a "PE" header that fits the file.');
        const b = new Bytes(data);
        const warnings: string[] = [];
        // What's wrong with each of a table's entries (each library, resource, list) is said once, with how many more there
        // are like it: a broken table can make thousands.
        const repeated = new Map<string, { text: string; more: number }>();
        const repeat = (kind: string, text: string) => {
            const r = repeated.get(kind);
            if (r) r.more++;
            else repeated.set(kind, { text, more: 0 });
        };
        const u64 = (at: number) => b.u32(at) + b.u32(at + 4) * 2 ** 32;
        const hex64 = (v: number) => (v > 0xffffffff ? hex(Math.floor(v / 2 ** 32)) + hex(v % 2 ** 32) : hex(v));

        // The file header, then the optional header, which must be big enough for its own fields.
        const machine = b.u16(pe + 4);
        const sectionCount = b.u16(pe + 6);
        const stamp = b.u32(pe + 8);
        const symbolsAt = b.u32(pe + 12);
        const symbolCount = b.u32(pe + 16);
        const optSize = b.u16(pe + 20);
        const characteristics = b.u16(pe + 22);
        const opt = pe + 24;
        const magic = b.u16(opt);
        if (magic === 0x107) throw new Error('It’s a ROM image (its optional header says 0x107), which isn’t read here.');
        // Win32s 1.30's own system DLLs (COMDLG32, LZ32, W32SKRNL and the rest built on 31 January and 1 February 1996,
        // linker 2.5) have 0 here, and an OS version of 0: Win32s's loader doesn't look. Their optional header is the
        // 32-bit one's size, and read as that; seen in the copy of Win32s that Counterstrike's Planet Westwood installs.
        const win32s = magic === 0 && optSize === 0xe0;
        if (magic !== 0x10b && magic !== 0x20b && !win32s)
            throw new Error(`Its optional header starts with ${hex(magic, 4)}, not 0x10B (32-bit) or 0x20B (64-bit): it isn’t a program Windows could load.`);
        const wide = magic === 0x20b;
        const fixed = wide ? 112 : 96;
        if (optSize < fixed) throw new Error(`Its optional header is said to be ${optSize} bytes, too short for the ${fixed} a ${wide ? '64' : '32'}-bit one needs before its data directories.`);
        if (opt + fixed > data.length) throw new Error('The file ends inside its optional header.');

        const entry = b.u32(opt + 16);
        const imageBase = wide ? u64(opt + 24) : b.u32(opt + 28);
        const sa = b.u32(opt + 32);
        const fa = b.u32(opt + 36);
        const sizeOfImage = b.u32(opt + 56);
        const sizeOfHeaders = b.u32(opt + 60);
        const checksum = b.u32(opt + 64);
        const subsystem = b.u16(opt + 68);
        const dllFlags = b.u16(opt + 70);
        const dirCountAt = opt + (wide ? 108 : 92);
        const dirsAt = opt + fixed;
        const dirsClaimed = b.u32(dirCountAt);
        const dirRoom = Math.floor((opt + optSize - dirsAt) / 8);
        if (dirsClaimed > dirRoom) warnings.push(`The optional header says it has ${plural(dirsClaimed, 'data directory')}, but its size leaves room for ${dirRoom}.`);
        const dirCount = Math.min(dirsClaimed, dirRoom, 16, Math.max(0, Math.floor((data.length - dirsAt) / 8)));
        const dirs = Array.from({ length: dirCount }, (_, i) => ({ i, name: DIRECTORIES[i], at: dirsAt + i * 8, rva: b.u32(dirsAt + i * 8), size: b.u32(dirsAt + i * 8 + 4) }));
        const dir = (i: number) => (dirs[i] && dirs[i].rva && dirs[i].size ? dirs[i] : null);

        const pow2 = (n: number) => n > 0 && (n & (n - 1)) === 0;
        // A file alignment under 512 is allowed when it's the same as the section alignment (programs smaller than a page).
        if (!pow2(fa) || fa > 0x10000 || (fa < 512 && fa !== sa))
            warnings.push(`Its sections are aligned to ${fa.toLocaleString('en-US')} bytes in the file; the spec allows a power of 2 from 512 to 65,536 (or less, when the same as in memory).`);
        if (sa < fa) warnings.push(`Its sections are aligned to ${sa.toLocaleString('en-US')} bytes in memory, less than the ${fa.toLocaleString('en-US')} they are in the file.`);
        // The same Win32s DLLs (W32SCOMB, W32SKRNL) round it only to the file's alignment.
        if (sa && sizeOfImage % sa && !(win32s && fa && sizeOfImage % fa === 0))
            warnings.push(`It says it takes ${bytesLabel(sizeOfImage)} in memory, which isn’t a multiple of its section alignment (${sa.toLocaleString('en-US')}).`);
        const alignUp = (n: number, to: number) => (to ? Math.ceil(n / to) * to : n);

        // The section table, after the optional header.
        const tableAt = opt + optSize;
        const tableRoom = Math.max(0, Math.floor((data.length - tableAt) / 40));
        if (sectionCount > tableRoom) warnings.push(`It says it has ${plural(sectionCount, 'section')}, but the file ends after ${tableRoom} of their headers.`);
        if (sectionCount > 96) warnings.push(`It has ${sectionCount} sections; Windows loads programs with at most 96.`);
        const headersEnd = tableAt + sectionCount * 40;
        if (sizeOfHeaders < headersEnd) warnings.push(`Its headers are said to be ${bytesLabel(sizeOfHeaders)}, but they take ${bytesLabel(headersEnd)}.`);
        else if (fa && sizeOfHeaders % fa) warnings.push(`Its headers are said to be ${bytesLabel(sizeOfHeaders)}, which isn’t a multiple of its file alignment (${fa.toLocaleString('en-US')}).`);
        // The COFF string table, which only MinGW's linker uses in programs: section names longer than 8 characters are "/" and where they are in it.
        const stringsAt = symbolsAt && symbolCount < 2 ** 26 ? symbolsAt + symbolCount * 18 : 0;
        const sections: Section[] = Array.from({ length: Math.min(sectionCount, tableRoom) }, (_, i) => {
            const e = tableAt + i * 40;
            let name = b.asciiz(e).text.slice(0, 8);
            const long = /^\/(\d+)$/.exec(name);
            if (long && stringsAt && stringsAt + Number(long[1]) < data.length) name = b.asciiz(stringsAt + Number(long[1])).text.slice(0, 256);
            const vs = b.u32(e + 8);
            const rawSize = b.u32(e + 16);
            const ptr = b.u32(e + 20);
            // A section with no bytes in the file says where they'd be as 0 (Watcom's linker gives its .bss a size there anyway: PREVIEW.EXE).
            const fileAt = ptr && rawSize ? ptr : null;
            const fileLength = fileAt === null ? 0 : Math.max(0, Math.min(rawSize, data.length - fileAt));
            return { i, name, entryAt: e, va: b.u32(e + 12), memSize: vs || rawSize, rawSize, fileAt, fileLength, flags: b.u32(e + 36) };
        });

        const misaligned = sections.filter((s) => s.fileAt !== null && fa && s.fileAt % fa);
        if (misaligned.length)
            warnings.push(`${list(misaligned.map((s) => s.name))} ${misaligned.length === 1 ? 'starts' : 'start'} in the file where its alignment (${fa.toLocaleString('en-US')}) doesn’t allow.`);
        const cut = sections.filter((s) => s.fileAt !== null && s.fileAt + s.rawSize > data.length);
        if (cut.length) warnings.push(`${list(cut.map((s) => s.name))} ${cut.length === 1 ? 'runs' : 'run'} past the end of the file: it’s been cut short.`);
        const inHeaders = sections.filter((s) => s.fileAt !== null && s.fileAt < Math.min(headersEnd, sizeOfHeaders));
        if (inHeaders.length) warnings.push(`${list(inHeaders.map((s) => s.name))} ${inHeaders.length === 1 ? 'is' : 'are'} said to start inside the headers.`);
        // In memory, each section must start where the one before ends, rounded up to the alignment.
        for (let i = 1; i < sections.length; i++) {
            const prev = sections[i - 1];
            if (sections[i].va !== prev.va + alignUp(prev.memSize, sa)) {
                warnings.push(`${sections[i].name} isn’t where ${prev.name} ends in memory, as the spec has sections one after another: it’s at ${rvaText(sections[i].va)}.`);
                break;
            }
        }
        const last = sections.at(-1);
        if (last && last.va + last.memSize > sizeOfImage)
            warnings.push(`It says it takes ${bytesLabel(sizeOfImage)} in memory, but ${last.name} runs to ${bytesLabel(last.va + last.memSize)}: Windows won’t load it.`);

        // From an address in memory to the file: inside the headers, or a section's bytes (not the zeros after them).
        const firstVa = sections.length ? minOf(sections.map((s) => s.va)) : sizeOfImage;
        const sectionOf = (rva: number) => sections.find((s) => rva >= s.va && rva < s.va + s.memSize) ?? null;
        const fileOf = (rva: number): { at: number; room: number } | null => {
            // An address worked out from the file (a pointer less the image base) can be anything: only those in the image count.
            if (!Number.isInteger(rva) || rva < 0 || rva > 0xffffffff) return null;
            if (rva < Math.min(sizeOfHeaders, firstVa)) return rva < data.length ? { at: rva, room: Math.min(sizeOfHeaders, firstVa, data.length) - rva } : null;
            const s = sectionOf(rva);
            if (!s || s.fileAt === null) return null;
            const d = rva - s.va;
            const backed = Math.min(s.fileLength, s.memSize);
            return d < backed ? { at: s.fileAt + d, room: backed - d } : null;
        };
        /** A NUL-terminated string at an address, at most `max` characters; null when it isn't in the file. */
        const stringAt = (rva: number, max = 1024) => {
            const f = fileOf(rva);
            if (!f) return null;
            let end = f.at;
            const stop = f.at + Math.min(f.room, max);
            while (end < stop && data[end]) end++;
            return { text: b.ascii(f.at, end - f.at), at: f.at, length: Math.min(end + 1, f.at + f.room) - f.at };
        };

        // What the tables take in the file: each is placed in the section it's in, below.
        const parts: Field[] = [];
        const part = (name: string, at: number, length: number, value?: string | number, note?: string, children?: Field[]) => {
            if (length > 0 && at < data.length) parts.push({ ...field(name, at, Math.min(length, data.length - at), value, note), ...(children ? { children } : {}) });
        };
        /** Short runs one after another (names), made one field each run. */
        const runs = (name: string, items: Field[]) => {
            items.sort((x, y) => x.offset - y.offset);
            let run: Field[] = [];
            const flush = () => {
                if (!run.length) return;
                const from = run[0].offset;
                const to = run.at(-1)!.offset + run.at(-1)!.length;
                part(name, from, to - from, plural(run.length, 'name'), undefined, run);
                run = [];
            };
            for (const it of items) {
                // Names are padded to an even offset, so one byte between them is still the same run.
                if (run.length && it.offset > run.at(-1)!.offset + run.at(-1)!.length + 1) flush();
                run.push(it);
            }
            flush();
        };
        const missing = (what: string, rva: number, kind?: string) => {
            const text = `The ${what} is said to be at ${rvaText(rva)}, which isn’t in the file.`;
            if (kind) repeat(kind, text);
            else warnings.push(text);
        };
        /** A count from a table, cut to what fits where it is (and said, when it doesn't). */
        const fitting = (count: number, size: number, room: number, what: string) => {
            const most = Math.floor(Math.max(0, room) / size);
            if (count <= most) return count;
            repeat(`fit ${what}`, `${what}: the table says ${count.toLocaleString('en-US')}, but only ${most.toLocaleString('en-US')} fit before the end of its section.`);
            return most;
        };
        for (const d of dirs) {
            if (d.i === 4 || !d.rva || !d.size) continue;
            if (!fileOf(d.rva)) missing(d.name, d.rva);
        }
        if (dirs[7] && (dirs[7].rva || dirs[7].size)) warnings.push('The architecture entry of the data directories is set; the spec has it 0.');
        if (dirs[15] && (dirs[15].rva || dirs[15].size)) warnings.push('The last entry of the data directories, which is reserved, is set; the spec has it 0.');

        // Reading the imports' lists of functions: each 4 or 8 bytes, until 0. Each is an ordinal (the top bit set) or where a
        // hint and a name are. The lists may share their entries, so every list read takes from what the file could hold.
        const width = wide ? 8 : 4;
        let thunksLeft = Math.max(64, Math.floor(data.length / 2));
        const names: Field[] = [];
        const readThunks = (rva: number, what: string, toRva = (v: number) => v) => {
            const out: Imported[] = [];
            const f = fileOf(rva);
            if (!f) {
                missing(`list of functions ${what}`, rva, 'thunks');
                return { out, at: 0, length: 0 };
            }
            let p = f.at;
            const stop = f.at + f.room - width + 1;
            for (; p < stop; p += width) {
                const lo = b.u32(p);
                const hi = wide ? b.u32(p + 4) : 0;
                if (!lo && !hi) break;
                if (--thunksLeft < 0) throw new Error('The imports name more functions than the file has room for: their lists point into one another, over and over.');
                if ((wide ? hi : lo) & 0x80000000) {
                    out.push({ name: `#${lo & 0xffff}`, ordinal: lo & 0xffff });
                    continue;
                }
                const hn = fileOf(toRva(lo & 0x7fffffff));
                if (!hn || hn.room < 3) {
                    out.push({ name: `(at ${rvaText(lo & 0x7fffffff)}, not in the file)` });
                    continue;
                }
                const s = stringAt(toRva(lo & 0x7fffffff) + 2, 512)!;
                out.push({ name: s.text, hint: b.u16(hn.at) });
                names.push(field(s.text || '(no name)', hn.at, 2 + s.length, `hint ${b.u16(hn.at)}`));
            }
            const ended = p < f.at + f.room && b.u32(p) === 0 && (!wide || b.u32(p + 4) === 0);
            if (!ended) repeat('unended', `The list of functions ${what} runs to the end of its section without the 0 that ends it.`);
            return { out, at: f.at, length: p - f.at + (ended ? width : 0) };
        };

        // Imports: 20 bytes a library (where its lists are, and its name), until 20 zeros.
        const rows: TableRow[] = [];
        const libraries: { name: string; functions: Imported[]; delayed: boolean }[] = [];
        const imports = dir(1);
        if (imports && fileOf(imports.rva)) {
            const f = fileOf(imports.rva)!;
            const children: Field[] = [];
            let p = f.at;
            let ended = false;
            for (let i = 0; i < Math.floor(f.room / 20); i++, p += 20) {
                if (data.subarray(p, p + 20).every((v) => v === 0)) {
                    children.push(field('End', p, 20, 'Zeros: the end of the list'));
                    ended = true;
                    break;
                }
                const lookup = b.u32(p);
                const nameRva = b.u32(p + 12);
                const iat = b.u32(p + 16);
                const name = stringAt(nameRva, 256);
                if (!name) missing(`name of imported library ${i + 1}`, nameRva, 'library name');
                else part('Library name', name.at, name.length, name.text);
                const dll = name?.text || `library ${i + 1}`;
                // Borland's linker leaves the lookup table out (0): the address table names the functions until Windows fills it in.
                const listed = readThunks(lookup || iat, `imported from ${dll}`);
                if (listed.length) part(`Functions from ${dll}`, listed.at, listed.length, plural(listed.out.length, 'function'), lookup ? 'What it imports, as the linker wrote it.' : undefined);
                if (lookup && iat && iat !== lookup) {
                    const a = fileOf(iat);
                    if (a)
                        part(
                            `Addresses from ${dll}`,
                            a.at,
                            listed.out.length * width + width,
                            plural(listed.out.length, 'address'),
                            'Filled in by Windows with where each function is, when it loads the program.'
                        );
                }
                libraries.push({ name: dll, functions: listed.out, delayed: false });
                children.push(
                    field(dll, p, 20, plural(listed.out.length, 'function'), b.u32(p + 4) ? `Bound: the addresses are filled in already, for the library of ${date(b.u32(p + 4))}.` : undefined)
                );
            }
            if (!ended) warnings.push('The list of imported libraries runs to the end of its section without the 20 zeros that end it.');
            part('Imports', f.at, p + (ended ? 20 : 0) - f.at, plural(libraries.length, 'library'), 'One entry for each library the program needs.', children);
        }
        // Delay-loaded imports: 32 bytes a library, loaded when first called. Since Visual C++ 7 their addresses are RVAs (bit 0
        // of the first field); before, addresses in memory, from the image base.
        const delayed = dir(13);
        if (delayed && fileOf(delayed.rva)) {
            const f = fileOf(delayed.rva)!;
            let p = f.at;
            const children: Field[] = [];
            for (let i = 0; i < Math.floor(f.room / 32); i++, p += 32) {
                if (data.subarray(p, p + 32).every((v) => v === 0)) {
                    children.push(field('End', p, 32, 'Zeros: the end of the list'));
                    p += 32;
                    break;
                }
                const toRva = b.u32(p) & 1 ? (v: number) => v : (v: number) => v - (imageBase % 2 ** 32);
                const name = stringAt(toRva(b.u32(p + 4)), 256);
                if (name) part('Library name', name.at, name.length, name.text);
                const dll = name?.text || `library ${i + 1}`;
                const listed = readThunks(toRva(b.u32(p + 16)), `loaded later from ${dll}`, toRva);
                if (listed.length) part(`Functions from ${dll}`, listed.at, listed.length, plural(listed.out.length, 'function'));
                libraries.push({ name: dll, functions: listed.out, delayed: true });
                children.push(field(dll, p, 32, plural(listed.out.length, 'function'), 'Loaded the first time one of them is called.'));
            }
            part('Delay-loaded imports', f.at, p - f.at, plural(libraries.filter((l) => l.delayed).length, 'library'), undefined, children);
        }
        runs('Imported names', names);
        for (const lib of libraries)
            for (const fn of lib.functions)
                rows.push({ group: lib.delayed ? `${lib.name} (when needed)` : lib.name, cells: { name: fn.name, ordinal: fn.ordinal?.toString() ?? '', hint: fn.hint?.toString() ?? '', where: '' } });
        const importAddresses = dir(12);
        if (importAddresses && !libraries.length && fileOf(importAddresses.rva)) part('Import addresses', fileOf(importAddresses.rva)!.at, importAddresses.size, bytesLabel(importAddresses.size));

        // Exports: a 40-byte directory, then the functions' addresses, their names and which address each name is. An address
        // inside the export table is a forwarder: the name of a function in another library to use instead.
        const exportsDir = dir(0);
        let exportName = '';
        let exportCount = 0;
        if (exportsDir && fileOf(exportsDir.rva)) {
            const f = fileOf(exportsDir.rva)!;
            if (f.room < 40) warnings.push('The export table is cut short by the end of its section.');
            else {
                const e = f.at;
                const name = stringAt(b.u32(e + 12), 256);
                exportName = name?.text ?? '';
                if (name) part('Library name', name.at, name.length, name.text, 'The name the library was linked as.');
                const base = b.u32(e + 16);
                let fnCount = b.u32(e + 20);
                let nameCount = b.u32(e + 24);
                const fnAt = fileOf(b.u32(e + 28));
                const namesAt = fileOf(b.u32(e + 32));
                const ordsAt = fileOf(b.u32(e + 36));
                part('Export directory', e, 40, exportName || 'no name', undefined, [
                    field('Flags', e, 4, b.u32(e)),
                    field('Made', e + 4, 4, date(b.u32(e + 4))),
                    field('Version', e + 8, 4, `${b.u16(e + 8)}.${b.u16(e + 10)}`),
                    field('Name at', e + 12, 4, rvaText(b.u32(e + 12))),
                    field('First ordinal', e + 16, 4, base),
                    field('Functions', e + 20, 4, fnCount),
                    field('Names', e + 24, 4, nameCount),
                    field('Addresses at', e + 28, 4, rvaText(b.u32(e + 28))),
                    field('Names at', e + 32, 4, rvaText(b.u32(e + 32))),
                    field('Name ordinals at', e + 36, 4, rvaText(b.u32(e + 36))),
                ]);
                if (fnCount && !fnAt) missing('list of exported functions', b.u32(e + 28));
                if (nameCount && (!namesAt || !ordsAt)) missing(namesAt ? 'list of exported names’ ordinals' : 'list of exported names', b.u32(namesAt ? e + 36 : e + 32));
                if (fnAt) {
                    fnCount = fitting(fnCount, 4, fnAt.room, 'Exported functions');
                    part('Export addresses', fnAt.at, fnCount * 4, plural(fnCount, 'function'));
                    const named = new Map<number, string[]>();
                    if (namesAt && ordsAt) {
                        nameCount = fitting(fitting(nameCount, 4, namesAt.room, 'Exported names'), 2, ordsAt.room, 'Exported names’ ordinals');
                        part('Export names', namesAt.at, nameCount * 4, plural(nameCount, 'name'));
                        part('Export name ordinals', ordsAt.at, nameCount * 2, plural(nameCount, 'name'), 'For each name, which of the addresses it is.');
                        const strings: Field[] = [];
                        let wrong = 0;
                        for (let i = 0; i < nameCount; i++) {
                            const k = b.u16(ordsAt.at + i * 2);
                            const s = stringAt(b.u32(namesAt.at + i * 4), 512);
                            if (!s || k >= fnCount) {
                                wrong++;
                                continue;
                            }
                            strings.push(field(s.text, s.at, s.length));
                            named.set(k, [...(named.get(k) ?? []), s.text]);
                        }
                        if (wrong)
                            warnings.push(
                                `${plural(wrong, 'exported name')} ${wrong === 1 ? 'isn’t' : 'aren’t'} in the file, or ${wrong === 1 ? 'names' : 'name'} a function past the end of the list.`
                            );
                        runs('Exported names', strings);
                    }
                    const forwards: Field[] = [];
                    for (let k = 0; k < fnCount; k++) {
                        const rva = b.u32(fnAt.at + k * 4);
                        if (!rva) continue;
                        exportCount++;
                        const forwarded = rva >= exportsDir.rva && rva < exportsDir.rva + exportsDir.size ? stringAt(rva, 512) : null;
                        if (forwarded) forwards.push(field(forwarded.text, forwarded.at, forwarded.length, 'Forwarded'));
                        for (const n of named.get(k) ?? [''])
                            rows.push({
                                group: 'Exports',
                                cells: { name: n || `#${base + k}`, ordinal: String(base + k), hint: '', where: forwarded ? `forwarded to ${forwarded.text}` : rvaText(rva) },
                            });
                    }
                    runs('Forwarded to', forwards);
                }
            }
        }

        // Resources: a tree of directories, each 16 bytes and then 8 for each entry (a name or an ID, then where the next
        // level is, or, with the top bit clear, a 16-byte leaf). Offsets are from the resource table's start; the leaves'
        // addresses are RVAs. Three levels: type, name, language.
        interface Resource {
            type: number;
            typeName: string;
            id: number;
            name: string;
            lang: number;
            at: number;
            length: number;
            rva: number;
        }
        const resources: Resource[] = [];
        const resourceDir = dir(2);
        const resourceBase = resourceDir ? fileOf(resourceDir.rva) : null;
        if (resourceDir && resourceBase) {
            const base = resourceBase.at;
            const room = resourceBase.room;
            const seen = new Set<number>();
            const nameFields: Field[] = [];
            const label = (v: number) => {
                const at = base + (v & 0x7fffffff);
                if ((v & 0x7fffffff) + 2 > room) return '(name not in the file)';
                const n = Math.min(b.u16(at), Math.floor((room - (v & 0x7fffffff) - 2) / 2));
                let s = '';
                for (let i = 0; i < n; i++) s += String.fromCharCode(b.u16(at + 2 + i * 2));
                nameFields.push(field(s, at, 2 + n * 2));
                return s;
            };
            let deep = false;
            let looped = false;
            let crowded = false;
            let entriesLeft = Math.floor(room / 8);
            const walk = (offset: number, level: number, path: { id: number; name: string }[]) => {
                if (offset + 16 > room) {
                    repeat('directory', `A resource directory is said to be at ${offset.toLocaleString('en-US')} into the resource table, past its end.`);
                    return;
                }
                if (seen.has(offset)) {
                    looped = true;
                    return;
                }
                seen.add(offset);
                const at = base + offset;
                const count = fitting(b.u16(at + 12) + b.u16(at + 14), 8, room - offset - 16, 'Resource directory entries');
                // Directories may overlap, so every entry read takes from what the table could hold, all told.
                entriesLeft -= count;
                if (entriesLeft < 0) {
                    crowded = true;
                    return;
                }
                const what = ['Types', `${path[0]?.name}: names`, `${path[0]?.name} ${path[1]?.name}: languages`][level] ?? 'Deeper';
                part('Resource directory', at, 16 + count * 8, what, undefined, [
                    field('Header', at, 16, `${b.u16(at + 12)} named, ${b.u16(at + 14)} numbered`),
                    ...(count ? [field('Entries', at + 16, count * 8, plural(count, 'entry'))] : []),
                ]);
                for (let i = 0; i < count; i++) {
                    const e = at + 16 + i * 8;
                    const key = b.u32(e);
                    const target = b.u32(e + 4);
                    const id = key & 0x80000000 ? -1 : key & 0xffff;
                    const name = key & 0x80000000 ? label(key) : level === 0 ? (RESOURCE_TYPES[id]?.name ?? `Type ${id}`) : level === 1 ? `#${id}` : languageName(id);
                    const here = [...path, { id, name }];
                    if (target & 0x80000000) {
                        if (level >= 2) deep = true;
                        else walk(target & 0x7fffffff, level + 1, here);
                        continue;
                    }
                    const leaf = target;
                    if (leaf + 16 > room) {
                        repeat('leaf', `The entry for resource ${here.map((x) => x.name).join(' › ')} is past the end of the resource table.`);
                        continue;
                    }
                    const rva = b.u32(base + leaf);
                    const size = b.u32(base + leaf + 4);
                    part('Resource entry', base + leaf, 16, `${here.map((x) => x.name).join(' › ')}`, `Where it is (${rvaText(rva)}), its size, and its code page (${b.u32(base + leaf + 8)}).`);
                    // Two levels where three belong (a resource with no language): it's still read, as language-neutral.
                    const [t, n, l] = [here[0], here[1] ?? { id: -1, name: '' }, here[2] ?? { id: 0, name: 'neutral' }];
                    const f = fileOf(rva);
                    if (!f || f.room < size) {
                        repeat('resource', `${t.name} ${n.name} is said to be ${bytesLabel(size)} at ${rvaText(rva)}, which ${f ? 'runs past the end of its section' : 'isn’t in the file'}.`);
                        continue;
                    }
                    resources.push({ type: t.id, typeName: t.name, id: n.id, name: n.name, lang: l.id, at: f.at, length: size, rva });
                }
            };
            walk(0, 0, []);
            if (deep) warnings.push('The resource tree goes deeper than its three levels (type, name, language); Windows doesn’t look there.');
            if (looped) warnings.push('The resource tree points back to one of its own directories, which a reader that trusts it would follow forever.');
            if (crowded) warnings.push('The resource tree lists more entries than its table could hold: its directories overlap, so the rest weren’t read.');
            runs('Resource names', nameFields);
        }
        // What the resources hold, shown and in Contents (see win-resource-view.ts), and broken into fields where they're read.
        const stem = (context.name ?? 'program').replace(/\.[^.]*$/, '');
        const view = viewResources(data, resources, { stem, owner: 'program', repeat, warn: (t: string) => warnings.push(t) });
        const { items, entries, version, undrawn, nameOf: resName } = view;
        for (const r of resources) {
            const known = view.inside.get(r);
            part(resName(r), r.at, r.length, known?.value ?? bytesLabel(r.length), undefined, known?.fields && fillGaps(data, known.fields, r.at, r.at + r.length, 'Not read'));
        }

        // Base relocations: blocks of a page's address, the block's size, then a 2-byte entry for each place (4 bits of type, 12 of offset).
        const relocs = dir(5);
        if (relocs && fileOf(relocs.rva)) {
            const f = fileOf(relocs.rva)!;
            const end = f.at + Math.min(relocs.size, f.room);
            const blocks: Field[] = [];
            let places = 0;
            let p = f.at;
            while (p + 8 <= end) {
                const size = b.u32(p + 4);
                // Wine's linker ends the table with a block of zeros (Proton's steam.exe): nothing to relocate, and nothing wrong.
                if (!size && data.subarray(p, end).every((v) => v === 0)) {
                    blocks.push(field('Zeros', p, end - p, bytesLabel(end - p), 'The end of the table.'));
                    p = end;
                    break;
                }
                if (size < 8 || p + size > end) {
                    warnings.push(
                        `A block of base relocations (at ${p.toLocaleString('en-US')}) says it’s ${size.toLocaleString('en-US')} bytes, ${size < 8 ? 'too short for its own header' : 'past the end of the table'}.`
                    );
                    break;
                }
                let n = 0;
                for (let q = p + 8; q + 2 <= p + size; q += 2) if (b.u16(q) >> 12) n++;
                places += n;
                blocks.push(field(`Page ${rvaText(b.u32(p))}`, p, size, plural(n, 'place')));
                p += size;
            }
            part(
                'Base relocations',
                f.at,
                p - f.at,
                `${plural(places, 'place')} in ${plural(blocks.length, 'page')}`,
                'Where addresses are, to change if Windows loads it somewhere else than it asks.',
                blocks
            );
        }

        // Debug directory: 28 bytes an entry, each saying where its data is (in the file: it needn't be loaded).
        const debugDir = dir(6);
        const appended: Field[] = [];
        let pdb = '';
        if (debugDir && fileOf(debugDir.rva)) {
            const f = fileOf(debugDir.rva)!;
            const count = Math.floor(Math.min(debugDir.size, f.room) / 28);
            const children: Field[] = [];
            for (let i = 0; i < count; i++) {
                const e = f.at + i * 28;
                const type = b.u32(e + 12);
                const size = b.u32(e + 16);
                const at = b.u32(e + 24);
                const kind = DEBUG_TYPES[type] ?? `type ${type}`;
                children.push(field(kind, e, 28, bytesLabel(size)));
                if (!size || !at) continue;
                // Signing appends the signatures where the linker's debug data was, and leaves the entry pointing there
                // (Tiberian Sun's Game.exe, as Steam has it): what it points to now is the signature.
                const signatures = dirs[4];
                if (signatures?.size && at < signatures.rva + signatures.size && at + size > signatures.rva) {
                    children[children.length - 1].note = 'Points into the signatures, which were written over it when the program was signed.';
                    continue;
                }
                if (at + size > data.length) {
                    repeat('debug', `The ${kind} debug information is said to be ${bytesLabel(size)} at ${at.toLocaleString('en-US')}, past the end of the file.`);
                    continue;
                }
                let value = bytesLabel(size);
                // CodeView: "RSDS", the PDB's GUID and age, then its path; or (older) "NB10", an offset, a date and age, then the path.
                const cv = b.ascii(at, 4);
                if (type === 2 && (cv === 'RSDS' || cv === 'NB10')) {
                    const from = at + (cv === 'RSDS' ? 24 : 16);
                    pdb = b.ascii(from, Math.max(0, size - (from - at))).replace(/\0[\s\S]*$/, '');
                    value = pdb;
                }
                const debugField = field(`Debug info (${kind})`, at, size, value, type === 2 ? 'Where the debugger finds the program’s symbols: the PDB file the linker wrote.' : undefined);
                // Data no section holds is after them, where a linker can append it.
                if (sections.some((s) => s.fileAt !== null && at >= s.fileAt && at < s.fileAt + s.fileLength) || at < sizeOfHeaders) part(debugField.name, at, size, value, debugField.note);
                else appended.push(debugField);
            }
            part('Debug directory', f.at, count * 28, plural(count, 'entry'), undefined, children);
        }

        // Thread-local storage: the data each thread gets a copy of, and the callbacks, which Windows runs before the entry point.
        const tls = dir(9);
        let callbacks = 0;
        if (tls && fileOf(tls.rva)) {
            const f = fileOf(tls.rva)!;
            const size = wide ? 40 : 24;
            part('TLS directory', f.at, size, 'Thread-local storage');
            const listVa = wide ? u64(f.at + 24) : b.u32(f.at + 12);
            const list = listVa ? fileOf(listVa - imageBase) : null;
            if (list) {
                let p = list.at;
                for (; p + width <= list.at + list.room && (wide ? u64(p) : b.u32(p)) && callbacks < 4096; p += width) callbacks++;
                part('TLS callbacks', list.at, p - list.at + width, plural(callbacks, 'function'), 'Windows runs each before the program’s own entry point.');
            }
        }

        // The .NET runtime header (72 bytes), and the metadata it points to, which starts with "BSJB" and the runtime's version.
        const clr = dir(14);
        let dotnet = '';
        if (clr && fileOf(clr.rva)) {
            const f = fileOf(clr.rva)!;
            part('.NET runtime header', f.at, 72, `version ${b.u16(f.at + 4)}.${b.u16(f.at + 6)}`);
            const meta = fileOf(b.u32(f.at + 8));
            if (meta && b.u32(meta.at) === 0x424a5342) {
                dotnet = b.asciiz(meta.at + 16).text.slice(0, Math.min(255, b.u32(meta.at + 12)));
                part('.NET metadata', meta.at, Math.min(b.u32(f.at + 12), meta.room), `for runtime ${dotnet}`, 'The program’s types and methods, which the .NET runtime reads.');
            } else dotnet = 'unknown';
        }
        for (const [i, name] of [
            [3, 'Exception table'],
            [10, 'Load configuration'],
            [11, 'Bound imports'],
        ] as const) {
            const d = dir(i);
            const f = d ? fileOf(d.rva) : null;
            if (d && f) part(name, f.at, Math.min(d.size, f.room), bytesLabel(d.size));
        }

        // The signatures, which aren't loaded: by file offset, each a length, a revision and a type, on 8-byte boundaries.
        const sig = dirs[4] && dirs[4].rva && dirs[4].size ? dirs[4] : null;
        let signed = '';
        if (sig) {
            if (sig.rva % 8) warnings.push('The signatures don’t start on an 8-byte boundary, as the spec has them.');
            if (sig.rva + sig.size > data.length) warnings.push(`The signatures are said to be ${bytesLabel(sig.size)} at ${sig.rva.toLocaleString('en-US')}, past the end of the file.`);
            const end = Math.min(data.length, sig.rva + sig.size);
            const children: Field[] = [];
            let p = sig.rva;
            while (p + 8 <= end) {
                const length = b.u32(p);
                if (length < 8 || p + length > end) {
                    warnings.push(
                        `Signature ${children.length + 1} says it’s ${length.toLocaleString('en-US')} bytes, ${length < 8 ? 'too short for its own header' : 'past the end of the signatures'}.`
                    );
                    break;
                }
                const type = b.u16(p + 6);
                const kind = type === 2 ? 'Authenticode (PKCS #7)' : type === 1 ? 'X.509 certificate' : `type ${type}`;
                // What it says: who signed it, and the hash of the program it vouches for (see pkcs7.ts).
                const inside: Field[] = [field('Length', p, 4, bytesLabel(length)), field('Revision', p + 4, 2, `0x${hex(b.u16(p + 4), 4)}`), field('Type', p + 6, 2, kind)];
                let said = '';
                if (type === 2) {
                    try {
                        const info = readSignature(data, p + 8, p + length);
                        inside.push(...info.fields);
                        info.problems.forEach((t) => repeat('signature', `Signature ${children.length + 1}: ${t}`));
                        said = `${signedBy(info)}${info.digest ? `; the program’s ${info.digest.algorithm} hash` : ''}${info.signers[0]?.timestamp ? `; timestamped ${info.signers[0].timestamp.at.slice(0, 10)}` : ''}`;
                    } catch (e) {
                        repeat('signature', `Signature ${children.length + 1} isn’t a signature Windows could read: ${e instanceof Error ? e.message : String(e)}.`);
                    }
                }
                children.push({ ...field(`Signature ${children.length + 1}`, p, length, said || kind), children: fillGaps(data, inside, p, p + length, 'Not read') });
                entries.push({
                    name: `${stem}-signature-${children.length}.${type === 2 ? 'p7s' : 'bin'}`,
                    label: `Signature ${children.length}`,
                    offset: p + 8,
                    size: length - 8,
                    data: data.subarray(p + 8, p + length),
                    meta: { Type: kind },
                });
                signed ||= said ? `${said} (Authenticode)` : kind;
                p += Math.ceil(length / 8) * 8;
            }
            if (sig.rva < data.length)
                appended.push({
                    ...field('Signatures', sig.rva, end - sig.rva, signed || 'none read', 'Not loaded with the program, so found by where they are in the file. Not checked here.'),
                    children,
                });
        }
        // The COFF symbols (18 bytes each) and their string table (its size first), which MinGW's linker leaves in programs,
        // sometimes with no symbols at all: only the table, for the long section names (DXVK's libraries).
        if (symbolsAt) {
            const strings = symbolsAt + symbolCount * 18;
            if (strings > data.length) warnings.push(`The symbol table is said to be ${plural(symbolCount, 'symbol')} at ${symbolsAt.toLocaleString('en-US')}, past the end of the file.`);
            else {
                const stringsSize = strings + 4 <= data.length ? b.u32(strings) : 0;
                if (strings + stringsSize > data.length) warnings.push('The symbols’ string table runs past the end of the file.');
                appended.push({
                    ...field(
                        'Symbols',
                        symbolsAt,
                        Math.min(data.length, strings + Math.max(4, stringsSize)) - symbolsAt,
                        plural(symbolCount, 'symbol'),
                        'The linker’s names for the program’s parts, for a debugger.'
                    ),
                    children: [
                        ...(symbolCount ? [field('Symbol table', symbolsAt, symbolCount * 18, plural(symbolCount, 'symbol'))] : []),
                        field('String table', strings, Math.min(data.length - strings, Math.max(4, stringsSize)), bytesLabel(stringsSize)),
                    ],
                });
            }
        }

        // The Rich header, in the DOS stub: "DanS", three zeros and a record for each tool, all XORed with a key, then "Rich" and the key.
        const fields: Field[] = [];
        const mzEnd = Math.min(64, pe);
        fields.push({
            name: 'MZ header',
            offset: 0,
            length: mzEnd,
            value: 'DOS’s header',
            children: [
                field('Signature', 0, 2, '"MZ"'),
                field('DOS header', 2, Math.min(mzEnd, 0x3c) - 2, 'Sizes, memory, registers, relocations'),
                ...(pe >= 64 ? [field('PE header at', 0x3c, 4, pe, 'Where the Windows program starts.')] : []),
            ],
        });
        let stubEnd = pe;
        let rich = false;
        const richAt = pe > 64 ? findRich(data, 64, pe) : -1;
        if (richAt >= 0) {
            const key = b.u32(richAt + 4);
            let dans = richAt - 4;
            while (dans >= 64 && (b.u32(dans) ^ key) >>> 0 !== 0x536e6144) dans -= 4;
            if (dans >= 64) {
                const records: Field[] = [];
                let sum = dans;
                for (let i = 0; i < dans; i++) if (i < 0x3c || i > 0x3f) sum = (sum + rotl(data[i], i)) >>> 0;
                for (let p = dans + 16; p + 8 <= richAt; p += 8) {
                    const tool = (b.u32(p) ^ key) >>> 0;
                    const count = (b.u32(p + 4) ^ key) >>> 0;
                    sum = (sum + rotl(tool, count)) >>> 0;
                    records.push(field(`Tool ${hex(tool >>> 16, 4)}, build ${tool & 0xffff}`, p, 8, `used ${plural(count, 'time')}`));
                }
                if (sum !== key) warnings.push('The Rich header’s checksum doesn’t match it or the DOS header: one of them was changed after the program was linked.');
                stubEnd = dans;
                rich = true;
                fields.push({
                    ...field(
                        'Rich header',
                        dans,
                        richAt + 8 - dans,
                        plural(records.length, 'tool'),
                        'Left by Microsoft’s linker: the tools that made each part of the program, and how often. Undocumented.'
                    ),
                    children: [
                        field('"DanS" and padding', dans, 16, 'XORed with the key'),
                        ...records,
                        field('"Rich" and the key', richAt, 8, hex(key), sum === key ? 'The key is a checksum, and it matches.' : 'The key is a checksum, and it doesn’t match.'),
                    ],
                });
            }
        }
        if (stubEnd > 64) fields.push(field('DOS stub', 64, stubEnd - 64, bytesLabel(stubEnd - 64), 'What runs under DOS: usually a message that the program needs Windows.'));

        const fileFlags = flagWords(characteristics, FILE_FLAGS);
        fields.push({
            name: 'PE header',
            offset: pe,
            length: 24,
            value: MACHINES[machine] ?? `machine ${hex(machine, 4)}`,
            children: [
                field('Signature', pe, 4, '"PE"'),
                field('Machine', pe + 4, 2, MACHINES[machine] ?? hex(machine, 4), 'The processor it’s for.'),
                field('Sections', pe + 6, 2, sectionCount),
                field('Linked', pe + 8, 4, date(stamp), 'When the linker made it (some linkers write something else, or nothing).'),
                field('Symbols at', pe + 12, 4, symbolsAt, symbolsAt ? undefined : 'None.'),
                field('Symbols', pe + 16, 4, symbolCount),
                field('Optional header size', pe + 20, 2, optSize),
                field('Flags', pe + 22, 2, hex(characteristics, 4), fileFlags),
            ],
        });
        const sizeField = (name: string, k32: number, k64: number, note?: string) =>
            wide ? field(name, opt + k64, 8, bytesLabel(u64(opt + k64)), note) : field(name, opt + k32, 4, bytesLabel(b.u32(opt + k32)), note);
        const entrySection = sectionOf(entry);
        fields.push({
            name: 'Optional header',
            offset: opt,
            length: Math.min(optSize, data.length - opt),
            value: wide ? 'PE32+ (64-bit)' : 'PE32 (32-bit)',
            children: [
                field(
                    'Magic',
                    opt,
                    2,
                    hex(magic, 4),
                    wide ? '0x20B: 64-bit.' : win32s ? 'Should be 0x10B (32-bit). 0 is what Win32s’s own DLLs of 1996 have: Win32s loads them, Windows NT wouldn’t.' : '0x10B: 32-bit.'
                ),
                field('Linker version', opt + 2, 2, `${data[opt + 2]}.${data[opt + 3]}`),
                field('Code size', opt + 4, 4, bytesLabel(b.u32(opt + 4))),
                field('Data size', opt + 8, 4, bytesLabel(b.u32(opt + 8))),
                field('Uninitialized data size', opt + 12, 4, bytesLabel(b.u32(opt + 12))),
                field(
                    'Entry point',
                    opt + 16,
                    4,
                    entry ? rvaText(entry) : 'None',
                    entry ? `Where it starts running${entrySection ? `, in ${entrySection.name}` : ''}.` : 'A library needn’t have one.'
                ),
                field('Code starts at', opt + 20, 4, rvaText(b.u32(opt + 20))),
                ...(wide ? [] : [field('Data starts at', opt + 24, 4, rvaText(b.u32(opt + 24)))]),
                field('Image base', opt + (wide ? 24 : 28), wide ? 8 : 4, `0x${hex64(imageBase)}`, 'Where in memory it asks to be loaded.'),
                field('Section alignment', opt + 32, 4, sa.toLocaleString('en-US'), 'In memory.'),
                field('File alignment', opt + 36, 4, fa.toLocaleString('en-US'), 'In the file.'),
                field('Windows version', opt + 40, 4, `${b.u16(opt + 40)}.${b.u16(opt + 42)}`, 'The version of Windows it was made for.'),
                field('Image version', opt + 44, 4, `${b.u16(opt + 44)}.${b.u16(opt + 46)}`),
                field('Subsystem version', opt + 48, 4, `${b.u16(opt + 48)}.${b.u16(opt + 50)}`, 'The oldest Windows it runs on.'),
                field('Win32 version', opt + 52, 4, b.u32(opt + 52), b.u32(opt + 52) ? 'Reserved: should be 0.' : undefined),
                field('Size in memory', opt + 56, 4, bytesLabel(sizeOfImage)),
                field('Headers size', opt + 60, 4, bytesLabel(sizeOfHeaders)),
                field('Checksum', opt + 64, 4, checksum ? hex(checksum) : 'Not set', 'Windows checks it only for drivers and the libraries it loads at startup.'),
                field('Subsystem', opt + 68, 2, SUBSYSTEMS[subsystem] ?? subsystem, 'What it runs under.'),
                field('DLL flags', opt + 70, 2, hex(dllFlags, 4), flagWords(dllFlags, DLL_FLAGS)),
                sizeField('Stack reserved', 72, 72),
                sizeField('Stack committed', 76, 80),
                sizeField('Heap reserved', 80, 88),
                sizeField('Heap committed', 84, 96),
                field('Loader flags', opt + (wide ? 104 : 88), 4, b.u32(opt + (wide ? 104 : 88))),
                field('Data directories', dirCountAt, 4, dirsClaimed),
                ...(dirs.length
                    ? [
                          {
                              ...field('Directories', dirsAt, dirs.length * 8, `${dirs.filter((d) => d.rva || d.size).length} used`),
                              children: dirs.map((d) =>
                                  field(
                                      d.name[0].toUpperCase() + d.name.slice(1),
                                      d.at,
                                      8,
                                      d.rva || d.size ? `${d.i === 4 ? `at ${d.rva.toLocaleString('en-US')}` : rvaText(d.rva)}, ${bytesLabel(d.size)}` : 'None'
                                  )
                              ),
                          },
                      ]
                    : []),
            ],
        });
        if (sections.length)
            fields.push({
                ...field('Section table', tableAt, sections.length * 40, sections.map((s) => s.name).join(', ')),
                children: sections.map((s) =>
                    field(
                        s.name || `Section ${s.i + 1}`,
                        s.entryAt,
                        40,
                        `${rvaText(s.va)}, ${bytesLabel(s.memSize)} in memory, ${bytesLabel(s.rawSize)} in the file`,
                        `${flagWords(s.flags, SECTION_FLAGS)}.${s.fileAt === null && s.rawSize ? ' Its bytes are said to be at 0: none are in the file.' : ''}`
                    )
                ),
            });

        // Each section's bytes, and the tables in each.
        const placed = new Set<Field>();
        for (const s of sections) {
            if (s.fileAt === null || !s.fileLength) continue;
            const from = s.fileAt;
            const to = s.fileAt + s.fileLength;
            const inside = parts.filter((p) => !placed.has(p) && p.offset >= from && p.offset < to);
            for (const p of inside) placed.add(p);
            const code = !!(s.flags & 0x20000020);
            const bits = s.fileLength >= 1024 ? entropy(data.subarray(from, to)) : 0;
            fields.push({
                ...field(
                    `Section ${s.name}`,
                    from,
                    to - from,
                    `${code ? 'Code' : 'Data'}, ${bytesLabel(to - from)}`,
                    bits > RANDOM ? `Its bytes look random (${bits.toFixed(2)} bits a byte, of 8): compressed or encrypted, to be unpacked when it runs.` : undefined
                ),
                children: fillGaps(data, inside, from, to, code ? 'Code' : 'Data'),
            });
        }
        // The tables outside every section: in the headers (bound imports), or appended.
        for (const p of parts) if (!placed.has(p)) fields.push(p);
        fields.push(...appended);

        // Between the parts: zeros are padding; anything else, nothing points to.
        fields.sort((x, y) => x.offset - y.offset || y.length - x.length);
        const filled: Field[] = [];
        let covered = 0;
        let stray = 0;
        for (const f of fields) {
            if (f.offset > covered) {
                const gap = data.subarray(covered, f.offset);
                const zeros = gap.every((v) => v === 0);
                if (zeros) filled.push(field('Padding', covered, gap.length, bytesLabel(gap.length), 'Zeros, to the next alignment.'));
                else {
                    // What it looks like, and (when there's enough of it to be something) the bytes to open on their own.
                    stray += gap.length;
                    const sig = gap.length >= 64 ? signature(gap) : null;
                    const looks = sig?.name ?? (gap.length >= 1024 && entropy(gap) > RANDOM ? 'random-looking bytes (compressed or encrypted)' : '');
                    filled.push(field('Not pointed to', covered, gap.length, `${bytesLabel(gap.length)}${looks ? `: ${looks}` : ''}`, 'Nothing in the headers or tables points here.'));
                    if (gap.length >= 64)
                        entries.push({
                            name: null,
                            label: `not pointed to at ${covered}.${sig?.ext ?? 'bin'}`,
                            offset: covered,
                            size: gap.length,
                            data: gap,
                            meta: { Type: looks || 'Not pointed to' },
                        });
                }
            }
            filled.push(f);
            covered = Math.max(covered, f.offset + f.length);
        }

        // What it is, in a line, and the summary.
        const dll = !!(characteristics & 0x2000);
        const bitsLabel = wide ? '64-bit' : '32-bit';
        const kind = dotnet
            ? `.NET ${dll ? 'library' : 'program'}`
            : subsystem >= 10 && subsystem <= 13
              ? 'EFI program'
              : subsystem === 1 || subsystem === 8
                ? 'Windows driver or native program'
                : `Windows ${dll ? 'library' : 'program'}`;
        const strings = new Map(version?.strings ?? []);
        const said = (key: string, label: string): [string, string][] => (strings.get(key) ? [[label, strings.get(key)!]] : []);
        const imported = libraries.reduce((n, l) => n + l.functions.length, 0);
        if (entry && !entrySection && entry >= Math.min(sizeOfHeaders, firstVa)) warnings.push(`It starts running at ${rvaText(entry)}, which isn’t in any of its sections.`);
        const entryNote = !entry
            ? dll
                ? 'None: nothing runs when it’s loaded'
                : 'None: it would start at its own headers'
            : entrySection
              ? `${rvaText(entry)}, in ${entrySection.name}${entrySection.flags & 0x20000020 ? '' : ', which isn’t marked as code'}`
              : entry < Math.min(sizeOfHeaders, firstVa)
                ? `${rvaText(entry)}, in its headers`
                : `${rvaText(entry)}, outside its sections`;
        return {
            title: `${kind} (${dll ? 'DLL' : 'PE'}, ${bitsLabel})`,
            summary: [
                ...said('FileDescription', 'Description'),
                ...said('CompanyName', 'Company'),
                ...said('ProductName', 'Product'),
                ...(strings.get('FileVersion') || version?.fileVersion ? [['Version', strings.get('FileVersion') || version!.fileVersion!] as [string, string]] : []),
                ...said('OriginalFilename', 'Original name'),
                ...(exportName ? [['Linked as', exportName] as [string, string]] : []),
                ['For', `${MACHINES[machine] ?? `machine ${hex(machine, 4)}`}, ${SUBSYSTEMS[subsystem] ?? `subsystem ${subsystem}`}, Windows ${b.u16(opt + 48)}.${b.u16(opt + 50)} or later`],
                ['Linked', `${date(stamp)}, linker ${data[opt + 2]}.${data[opt + 3]}${rich ? ' (Microsoft’s: it left a Rich header)' : ''}`],
                ['Starts', entryNote],
                ...(callbacks ? [['Runs first', `${plural(callbacks, 'TLS callback')}, before the entry point`] as [string, string]] : []),
                ...(dotnet ? [['.NET', `runtime ${dotnet}`] as [string, string]] : []),
                ['Sections', sections.map((s) => s.name).join(', ') || 'none'],
                ...(libraries.length
                    ? [
                          [
                              'Imports',
                              `${plural(imported, 'function')} from ${libraries.length === 1 ? libraries[0].name : `${libraries.length} libraries: ${libraries.map((l) => l.name).join(', ')}`}`,
                          ] as [string, string],
                      ]
                    : []),
                ...(exportCount ? [['Exports', plural(exportCount, 'function')] as [string, string]] : []),
                ['Resources', resourceCounts(resources)],
                ...(undrawn ? [['Not drawn', `${plural(undrawn, 'bitmap')}, compressed in a way not drawn here (under Contents)`] as [string, string]] : []),
                ...(pdb ? [['Debug info', pdb] as [string, string]] : []),
                ...(signed ? [['Signed', `${signed}, not checked here`] as [string, string]] : []),
                ...(stray ? [['Not pointed to', `${bytesLabel(stray)} between the parts aren’t padding, and nothing in the program points to them (under Contents)`] as [string, string]] : []),
            ],
            fields: filled,
            entries,
            preview: (() => {
                const table: Preview | null = rows.length
                    ? {
                          kind: 'table',
                          columns: [
                              { key: 'name', label: 'Function' },
                              { key: 'ordinal', label: 'Ordinal', numeric: true },
                              { key: 'hint', label: 'Hint', numeric: true },
                              { key: 'where', label: 'Address' },
                          ],
                          groups: [...new Set(rows.map((r) => r.group))],
                          rows,
                      }
                    : null;
                const all = [...(table ? [{ title: 'Imports and exports', preview: table }] : []), ...items];
                return all.length ? (all.length === 1 ? all[0].preview : { kind: 'stack', items: all }) : undefined;
            })(),
            alsoNamed: namesForResources(resources),
            warnings: [...warnings, ...[...repeated.values()].map((r) => (r.more ? `${r.text} There ${r.more === 1 ? 'is 1 more' : `are ${r.more.toLocaleString('en-US')} more`} like it.` : r.text))],
        };
    },
};

/** A list of names in a sentence. */
function list(names: string[]): string {
    return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

function rotl(v: number, n: number): number {
    const k = n & 31;
    return k ? ((v << k) | (v >>> (32 - k))) >>> 0 : v >>> 0;
}

/** Where "Rich" is in the DOS stub, on a 4-byte boundary, or -1. */
function findRich(data: Uint8Array, from: number, to: number): number {
    for (let p = from; p + 8 <= to; p += 4) if (data[p] === 0x52 && data[p + 1] === 0x69 && data[p + 2] === 0x63 && data[p + 3] === 0x68) return p;
    return -1;
}

export default parser;
