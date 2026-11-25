import { Bytes, bytesLabel, field, fillGaps, hex } from '../core/bytes';
import type { Entry, Field, TableRow } from '../core/types';

/**
 * Linear Executables: 32-bit programs in pages, "LE" for those DOS extenders run (DOS/4GW, and the games built with
 * Watcom C that ship with it) and for Windows 3 and 95 drivers (VxDs), "LX" for OS/2 2.0 and later. Behind a DOS
 * header, the linear header says where its tables are:
 *
 * - objects: the program's pieces as they're laid out in memory (code, data, the stack), each made of pages;
 * - the page table: where each page's bytes are in the file;
 * - the entry table: the functions it offers others, and its own entry points; the resident and non-resident names
 *   tables name them;
 * - fixups: for each page, the places in it that hold an address, which the loader corrects once it knows where each
 *   object went, and the modules and functions it imports;
 * - then the pages themselves.
 *
 * LE and LX differ in two places: LE's page table gives each page's number (3 bytes, most significant first) and a
 * flags byte, its pages are all the header's page size but the last, whose size is in the header where LX keeps a
 * shift; LX's gives each page's offset (shifted), size and flags. Offsets "from the file" count from the program's own
 * DOS header, which, for a program bound after a DOS extender, isn't the start of the file it's in.
 *
 * See IBM's "LX - Linear eXecutable Module Format Description" (1992; reprinted at
 * http://www.edm2.com/index.php/LX_-_Linear_eXecutable_Module_Format_Description; IBM's copyright, so facts only) for
 * the tables, and Open Watcom's exeflat.h (https://github.com/open-watcom/open-watcom-v2, bld/watcom/h; Sybase Open
 * Watcom Public License, facts only) for where LE differs. The byte order of LE's page numbers was worked out from
 * DOS/4GW programs (TD's and Counterstrike's README.EXE and installers).
 */

const CPUS: Record<number, string> = { 1: '80286', 2: '80386', 3: '80486' };
const SYSTEMS: Record<number, string> = { 0: 'not said', 1: 'OS/2', 2: 'Windows', 3: 'DOS 4', 4: 'Windows 386 (a driver)' };
const OBJECT_FLAGS: [number, string][] = [
    [0x0001, 'readable'],
    [0x0002, 'writable'],
    [0x0004, 'executable'],
    [0x0008, 'resources'],
    [0x0010, 'discardable'],
    [0x0020, 'shared'],
    [0x0040, 'preloaded'],
    [0x0080, 'has invalid pages'],
    [0x2000, '32-bit'],
    [0x4000, 'conforming'],
    [0x8000, 'I/O privilege'],
];
const PAGE_KINDS = ['in the file', 'iterated (compressed)', 'invalid', 'zeros', 'a range'];
const TARGETS = ['inside the program', 'imported by number', 'imported by name', 'an entry point'];

const words = (value: number, names: [number, string][]) =>
    names
        .filter(([bit]) => value & bit)
        .map(([, w]) => w)
        .join(', ') || 'none';
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

export interface Linear {
    kind: 'LE' | 'LX';
    /** Its fields: the header, the tables and the pages, by where they are in the file. */
    fields: Field[];
    entries: Entry[];
    summary: [string, string][];
    /** The objects, for a table. */
    rows: TableRow[];
    /** The module's name, from its resident names. */
    name: string;
    /** Where its pages end. */
    end: number;
    problems: string[];
    /** OS/2's, a Windows driver, or a DOS extender's. */
    what: string;
}

/**
 * Reads a linear executable whose header is at `at`, its own file (its DOS header) starting at `base`: offsets "from
 * the header" count from `at`, those "from the file" from `base`. `stem` names the objects saved from it.
 */
export function readLinear(data: Uint8Array, base: number, at: number, stem: string, extender = ''): Linear {
    const b = new Bytes(data);
    const kind = b.ascii(at, 2) === 'LX' ? 'LX' : 'LE';
    const problems: string[] = [];
    const repeated = new Map<string, { text: string; more: number }>();
    const repeat = (key: string, text: string) => {
        const seen = repeated.get(key);
        if (seen) seen.more++;
        else repeated.set(key, { text, more: 0 });
    };
    const u = (o: number) => b.u32(at + o);
    const fields: Field[] = [];
    const entries: Entry[] = [];
    /** A table "from the header", when it's there and inside the file. */
    const fromHeader = (o: number) => (u(o) ? at + u(o) : 0);
    const inFile = (p: number, length = 1) => p > 0 && p + length <= data.length;

    // The header: 0xB0 bytes in LX's description, 196 in Watcom's (20 more, which a Windows driver uses).
    const os = b.u16(at + 0x0a);
    const pageSize = u(0x28);
    const flags = u(0x10);
    const objectCount = u(0x44);
    const pageCount = u(0x14);
    const objectTable = fromHeader(0x40);
    const headerEnd = Math.min(data.length, at + (objectTable && objectTable - at >= 0xc4 ? 0xc4 : 0xb0));
    const offset = (o: number, label: string, from: 'header' | 'file', note?: string) =>
        field(
            label,
            at + o,
            4,
            u(o) ? `${u(o).toLocaleString('en-US')}${from === 'file' ? ` (at ${(base + u(o)).toLocaleString('en-US')})` : ''}` : 'none',
            note ?? `From the ${from === 'header' ? 'linear header' : 'program’s own DOS header'}.`
        );
    const header: Field[] = [
        field('Signature', at, 2, `"${kind}"`),
        field('Byte order', at + 2, 1, data[at + 2] ? 'most significant first' : 'least significant first'),
        field('Word order', at + 3, 1, data[at + 3] ? 'most significant first' : 'least significant first'),
        field('Format level', at + 4, 4, u(4)),
        field('Processor', at + 8, 2, CPUS[b.u16(at + 8)] ?? `type ${b.u16(at + 8)}`, 'The least it needs.'),
        field('System', at + 0x0a, 2, SYSTEMS[os] ?? `type ${os}`),
        field('Module version', at + 0x0c, 4, u(0x0c)),
        field(
            'Flags',
            at + 0x10,
            4,
            `${flags & 0x8000 ? 'a library' : flags & 0x20000 ? 'a device driver' : 'a program'}${flags & 0x10 ? ', its own addresses fixed' : ''}${flags & 0x20 ? ', imports fixed' : ''}`,
            'What kind of module it is, and how it’s loaded.'
        ),
        field('Pages', at + 0x14, 4, pageCount),
        field('Starts in object', at + 0x18, 4, u(0x18) || 'none'),
        field('Starts at', at + 0x1c, 4, `0x${hex(u(0x1c))}`, 'From the start of that object.'),
        field('Stack in object', at + 0x20, 4, u(0x20) || 'none'),
        field('Stack at', at + 0x24, 4, `0x${hex(u(0x24))}`, u(0x24) ? 'From the start of that object.' : 'The top of the object.'),
        field('Page size', at + 0x28, 4, bytesLabel(pageSize)),
        kind === 'LE'
            ? field('Last page', at + 0x2c, 4, bytesLabel(u(0x2c)), 'How much of the last page is in the file.')
            : field('Page offset shift', at + 0x2c, 4, u(0x2c), 'Each page’s offset in the page table is shifted left by this.'),
        field('Fixups', at + 0x30, 4, bytesLabel(u(0x30)), 'The fixup tables’ size.'),
        field('Fixups checksum', at + 0x34, 4, `0x${hex(u(0x34))}`),
        field('Loader tables', at + 0x38, 4, bytesLabel(u(0x38)), 'What the loader keeps in memory: from the object table to the checksums.'),
        field('Loader checksum', at + 0x3c, 4, `0x${hex(u(0x3c))}`),
        offset(0x40, 'Object table at', 'header'),
        field('Objects', at + 0x44, 4, objectCount),
        offset(0x48, 'Page table at', 'header'),
        offset(0x4c, 'Iterated pages at', 'file'),
        offset(0x50, 'Resource table at', 'header'),
        field('Resources', at + 0x54, 4, u(0x54)),
        offset(0x58, 'Resident names at', 'header'),
        offset(0x5c, 'Entry table at', 'header'),
        offset(0x60, 'Module directives at', 'header'),
        field('Module directives', at + 0x64, 4, u(0x64)),
        offset(0x68, 'Fixup page table at', 'header'),
        offset(0x6c, 'Fixup records at', 'header'),
        offset(0x70, 'Imported modules at', 'header'),
        field('Imported modules', at + 0x74, 4, u(0x74)),
        offset(0x78, 'Imported names at', 'header'),
        offset(0x7c, 'Page checksums at', 'header'),
        offset(0x80, 'Pages at', 'file'),
        field('Preloaded pages', at + 0x84, 4, u(0x84)),
        offset(0x88, 'Non-resident names at', 'file'),
        field('Non-resident names', at + 0x8c, 4, bytesLabel(u(0x8c))),
        field('Non-resident names checksum', at + 0x90, 4, `0x${hex(u(0x90))}`),
        field('Automatic data object', at + 0x94, 4, u(0x94) || 'none', 'For 16-bit code.'),
        offset(0x98, 'Debug info at', 'file'),
        field('Debug info', at + 0x9c, 4, bytesLabel(u(0x9c))),
        field('Instance pages, preloaded', at + 0xa0, 4, u(0xa0)),
        field('Instance pages, on demand', at + 0xa4, 4, u(0xa4)),
        field('Heap', at + 0xa8, 4, bytesLabel(u(0xa8)), 'For 16-bit code.'),
        field('Stack', at + 0xac, 4, bytesLabel(u(0xac))),
    ];
    if (headerEnd - at === 0xc4) {
        if (os === 4)
            header.push(
                field('Reserved', at + 0xb0, 8, bytesLabel(8)),
                field('Version resource at', at + 0xb8, 4, u(0xb8) || 'none', 'A Windows driver’s version information.'),
                field('Version resource', at + 0xbc, 4, bytesLabel(u(0xbc))),
                field('Device ID', at + 0xc0, 2, `0x${hex(b.u16(at + 0xc0), 4)}`, 'Which driver it is, to Windows.'),
                field('DDK version', at + 0xc2, 2, `${data[at + 0xc3]}.${data[at + 0xc2].toString(16).padStart(2, '0')}`, 'The driver kit it was built with.')
            );
        else header.push(field('Reserved', at + 0xb0, 0x14, bytesLabel(0x14)));
    }
    fields.push({ ...field(`${kind} header`, at, headerEnd - at, plural(objectCount, 'object')), children: header });

    // Sizes the header gives, checked before anything is read by them.
    if (kind === 'LE' && pageSize !== 4096) problems.push(`It says its pages are ${bytesLabel(pageSize)}: every LE program’s are 4,096.`);
    const pageShift = kind === 'LX' ? u(0x2c) : 0;
    if (kind === 'LX' && pageShift > 16) problems.push(`Its page offsets are said to be shifted by ${pageShift} bits, more than any page could need.`);
    const objects = objectTable && inFile(objectTable) ? Math.min(objectCount, Math.floor((data.length - objectTable) / 24)) : 0;
    if (objects < objectCount) problems.push(`It says it has ${plural(objectCount, 'object')}, but the object table ${objectTable ? 'has room for' : 'isn’t there, so it has'} ${objects}.`);
    const mapEntry = kind === 'LE' ? 4 : 8;
    const pageTable = fromHeader(0x48);
    const pages = pageTable && inFile(pageTable) ? Math.min(pageCount, Math.floor((data.length - pageTable) / mapEntry)) : 0;
    if (pages < pageCount) problems.push(`It says it has ${plural(pageCount, 'page')}, but the page table has room for ${pages}.`);

    // The objects.
    interface Obj {
        n: number;
        size: number;
        address: number;
        flags: number;
        first: number;
        count: number;
    }
    const objectList: Obj[] = [];
    const objectFields: Field[] = [];
    for (let i = 0; i < objects; i++) {
        const e = objectTable + i * 24;
        const o: Obj = { n: i + 1, size: b.u32(e), address: b.u32(e + 4), flags: b.u32(e + 8), first: b.u32(e + 12), count: b.u32(e + 16) };
        objectList.push(o);
        if (o.count && (o.first < 1 || o.first + o.count - 1 > pageCount))
            repeat('object pages', `Object ${o.n} is said to be pages ${o.first} to ${o.first + o.count - 1}, but there are ${plural(pageCount, 'page')}.`);
        objectFields.push({
            ...field(`Object ${o.n}`, e, 24, `${bytesLabel(o.size)}, ${words(o.flags, OBJECT_FLAGS)}`),
            children: [
                field('Size in memory', e, 4, bytesLabel(o.size)),
                field('Address', e + 4, 4, `0x${hex(o.address)}`, 'Where it’s meant to be loaded.'),
                field('Flags', e + 8, 4, words(o.flags, OBJECT_FLAGS)),
                field('First page', e + 12, 4, o.first),
                field('Pages', e + 16, 4, o.count),
                field('Reserved', e + 20, 4, b.u32(e + 20)),
            ],
        });
    }
    if (objects) fields.push({ ...field('Object table', objectTable, objects * 24, plural(objects, 'object')), children: objectFields });
    const eipObject = u(0x18);
    if (eipObject && eipObject > objectList.length) problems.push(`It says it starts in object ${eipObject}, but it has ${plural(objectList.length, 'object')}.`);
    else if (eipObject && u(0x1c) >= objectList[eipObject - 1].size) problems.push(`It says it starts ${u(0x1c).toLocaleString('en-US')} bytes into object ${eipObject}, past its end.`);

    // The page table, and where each page is in the file.
    const pagesAt = base + u(0x80);
    interface Page {
        n: number;
        at: number;
        size: number;
        kind: number;
    }
    const pageList: Page[] = [];
    const pageFields: Field[] = [];
    for (let i = 0; i < pages; i++) {
        const e = pageTable + i * mapEntry;
        let page: Page;
        if (kind === 'LE') {
            const number = (data[e] << 16) | (data[e + 1] << 8) | data[e + 2];
            const flag = data[e + 3];
            page = { n: i + 1, at: pagesAt + (number - 1) * pageSize, size: number === pageCount ? u(0x2c) : pageSize, kind: flag };
            if (flag === 0 && (number < 1 || number > pageCount)) repeat('page number', `Page ${i + 1} is said to be page ${number} in the file, which has ${plural(pageCount, 'page')}.`);
            pageFields.push(field(`Page ${i + 1}`, e, 4, flag === 0 ? `page ${number} in the file` : (PAGE_KINDS[flag] ?? `kind ${flag}`)));
        } else {
            const off = b.u32(e) * 2 ** pageShift;
            const flag = b.u16(e + 6);
            page = { n: i + 1, at: flag === 1 ? base + u(0x4c) + off : pagesAt + off, size: b.u16(e + 4), kind: flag };
            pageFields.push(field(`Page ${i + 1}`, e, 8, `${PAGE_KINDS[flag] ?? `kind ${flag}`}, ${bytesLabel(page.size)}`));
        }
        pageList.push(page);
    }
    if (pages) fields.push({ ...field('Page table', pageTable, pages * mapEntry, plural(pages, 'page')), children: pageFields });

    // Names: each a length, the name, and its number in the entry table, to a 0. The first is the module's own name.
    const names = (from: number, to: number, what: string): { name: string; ordinal: number; at: number }[] => {
        const out: { name: string; ordinal: number; at: number }[] = [];
        let p = from;
        while (p < to && data[p]) {
            const n = data[p];
            if (p + 1 + n + 2 > to) {
                problems.push(`The ${what} run past where they can be.`);
                break;
            }
            out.push({ name: b.ascii(p + 1, n), ordinal: b.u16(p + 1 + n), at: p });
            p += 1 + n + 2;
        }
        return out;
    };
    const resident = fromHeader(0x58);
    let moduleName = '';
    const exported = new Map<number, string>();
    if (inFile(resident)) {
        const limit = Math.min(data.length, fromHeader(0x5c) > resident ? fromHeader(0x5c) : data.length);
        const list = names(resident, limit, 'resident names');
        moduleName = list[0]?.name ?? '';
        for (const x of list.slice(1)) exported.set(x.ordinal, x.name);
        const end = list.length ? list.at(-1)!.at + 1 + list.at(-1)!.name.length + 2 + 1 : resident + 1;
        fields.push({
            ...field('Resident names', resident, Math.min(data.length, end) - resident, moduleName || '(none)', 'The module’s own name first, then the entry points it names, each with its number.'),
            children: [
                ...list.map((x, i) => field(i ? x.name : 'Module name', x.at, 1 + x.name.length + 2, i ? `entry ${x.ordinal}` : x.name)),
                ...(end <= data.length ? [field('End', end - 1, 1, 0)] : []),
            ],
        });
    }
    const nonResident = u(0x88) ? base + u(0x88) : 0;
    if (inFile(nonResident) && u(0x8c)) {
        const len = Math.min(u(0x8c), data.length - nonResident);
        const list = names(nonResident, nonResident + len, 'non-resident names');
        for (const x of list.slice(1)) exported.set(x.ordinal, x.name);
        fields.push({ ...field('Non-resident names', nonResident, len, list[0]?.name ?? ''), children: list.map((x) => field(x.name, x.at, 1 + x.name.length + 2, `entry ${x.ordinal}`)) });
    }

    // The entry table: bundles of entries in one object, each a count, a type, and (but for empty ones) the object.
    const entryTable = fromHeader(0x5c);
    const entryPoints: { ordinal: number; object: number; offset: number; forward?: string }[] = [];
    if (inFile(entryTable)) {
        let p = entryTable;
        let ordinal = 1;
        const bundles: Field[] = [];
        const sizes = [0, 3, 5, 5, 7];
        // Each bundle takes 2 bytes at least, so there can't be more than fit.
        for (let guard = 0; p < data.length && data[p] && guard < data.length; guard++) {
            const count = data[p];
            const type = data[p + 1] & 0x7f;
            if (type === 0) {
                bundles.push(field(`Unused ${ordinal}–${ordinal + count - 1}`, p, 2, `${count} numbers skipped`));
                ordinal += count;
                p += 2;
                continue;
            }
            if (type > 4) {
                problems.push(`The entry table has a bundle of type ${type}, which isn’t one: the rest of it wasn’t read.`);
                break;
            }
            const size = 4 + count * sizes[type];
            if (p + size > data.length) {
                problems.push('The entry table runs past the end of the file.');
                break;
            }
            const object = b.u16(p + 2);
            for (let i = 0; i < count; i++) {
                const e = p + 4 + i * sizes[type];
                const offsetIn = type === 3 ? b.u32(e + 1) : b.u16(e + 1);
                entryPoints.push(
                    type === 4
                        ? { ordinal: ordinal + i, object: 0, offset: 0, forward: `module ${b.u16(e + 1)}, ${data[e] & 1 ? `number ${b.u32(e + 3)}` : 'by name'}` }
                        : { ordinal: ordinal + i, object, offset: offsetIn }
                );
            }
            bundles.push(field(`Entries ${ordinal}–${ordinal + count - 1}`, p, size, `${['', '16-bit', '286 call gates', '32-bit', 'forwarded'][type]}${type < 4 ? `, in object ${object}` : ''}`));
            ordinal += count;
            p += size;
        }
        fields.push({ ...field('Entry table', entryTable, Math.min(data.length, p + 1) - entryTable, plural(entryPoints.length, 'entry point')), children: bundles });
    }

    // Fixups: for each page, where its records start in the record table (one more, where the last ends), then the records.
    const fixupPages = fromHeader(0x68);
    const fixupRecords = fromHeader(0x6c);
    let fixups = 0;
    const targetCounts = [0, 0, 0, 0];
    if (inFile(fixupPages, (pageCount + 1) * 4) && inFile(fixupRecords)) {
        const starts = Array.from({ length: pageCount + 1 }, (_, i) => b.u32(fixupPages + i * 4));
        fields.push({ ...field('Fixup page table', fixupPages, (pageCount + 1) * 4, plural(pageCount, 'page'), 'Where each page’s fixups start in the records, and where the last ends.') });
        const records: Field[] = [];
        for (let i = 0; i < pageCount; i++) {
            const from = fixupRecords + starts[i];
            const to = fixupRecords + starts[i + 1];
            if (starts[i + 1] < starts[i] || to > data.length) {
                repeat(
                    'fixup page',
                    `The fixups for page ${i + 1} are said to run from ${starts[i].toLocaleString('en-US')} to ${starts[i + 1].toLocaleString('en-US')} in the records, which can’t be.`
                );
                continue;
            }
            if (to === from) continue;
            let p = from;
            let count = 0;
            while (p < to) {
                const src = data[p];
                const tf = data[p + 1];
                const list = src & 0x20;
                let q = p + 2 + (list ? 1 : 2);
                const wide = tf & 0x40 ? 2 : 1;
                const target = tf & 3;
                if (target === 0) q += wide + ((src & 0xf) === 2 ? 0 : tf & 0x10 ? 4 : 2);
                else if (target === 1) q += wide + (tf & 0x80 ? 1 : tf & 0x10 ? 4 : 2);
                else if (target === 2) q += wide + (tf & 0x10 ? 4 : 2);
                else q += wide;
                if (tf & 4) q += tf & 0x20 ? 4 : 2;
                if (list) q += data[p + 2] * 2;
                if (q > to) break;
                targetCounts[target] += list ? data[p + 2] : 1;
                count += list ? data[p + 2] : 1;
                p = q;
            }
            if (p !== to) repeat('fixup records', `Page ${i + 1}'s fixup records don’t end where the fixup page table says: they can’t all be read.`);
            fixups += count;
            records.push(field(`Page ${i + 1}`, from, to - from, plural(count, 'fixup'), 'Where in the page an address is, and what it points to.'));
        }
        const end = fixupRecords + starts[pageCount];
        if (end > fixupRecords && end <= data.length) fields.push({ ...field('Fixup records', fixupRecords, end - fixupRecords, plural(fixups, 'fixup')), children: records });
    } else if (u(0x30) && pageCount) problems.push('The fixup tables aren’t where the header says.');

    // Imported modules and procedure names: lengths and names.
    const imports: string[] = [];
    const importTable = fromHeader(0x70);
    if (inFile(importTable) && u(0x74)) {
        let p = importTable;
        const list: Field[] = [];
        for (let i = 0; i < u(0x74) && p < data.length; i++) {
            const n = data[p];
            imports.push(b.ascii(p + 1, n));
            list.push(field(imports.at(-1)!, p, 1 + n));
            p += 1 + n;
        }
        fields.push({ ...field('Imported modules', importTable, Math.min(p, data.length) - importTable, imports.join(', ')), children: list });
    }
    // The names of the functions it imports by name: lengths and names, which the fixups point into.
    const procTable = fromHeader(0x78);
    if (imports.length && inFile(procTable)) {
        const ends = [fromHeader(0x7c), pagesAt, base + u(0x88), data.length].filter((x) => x > procTable);
        // To the last name: what's after it, to the next table, is padding (or not), for the caller's checks.
        let to = Math.min(...ends);
        while (to > procTable && data[to - 1] === 0) to--;
        if (to > procTable) fields.push(field('Imported names', procTable, to - procTable, bytesLabel(to - procTable), 'The names of the functions it imports by name.'));
    }

    // The pages, under the object each belongs to.
    const contents: Field[] = [];
    let dataEnd = pagesAt;
    for (const o of objectList) {
        const parts: Field[] = [];
        let first = -1;
        let last = -1;
        // Only the pages the page table has: an object may claim billions.
        const count = o.first >= 1 ? Math.max(0, Math.min(o.count, pageList.length - (o.first - 1))) : 0;
        for (let k = 0; k < count; k++) {
            const page = pageList[o.first - 1 + k];
            if (!page || page.kind === 2 || page.kind === 3 || page.size === 0) continue;
            if (page.at < 0 || page.at + page.size > data.length) {
                repeat('page past', `Page ${page.n} (object ${o.n}) is said to be ${bytesLabel(page.size)} at ${page.at.toLocaleString('en-US')}, past the end of the file.`);
                continue;
            }
            parts.push(field(`Page ${page.n}`, page.at, page.size, `${bytesLabel(page.size)}${page.kind === 1 ? ', iterated' : ''}`));
            if (first < 0 || page.at < first) first = page.at;
            last = Math.max(last, page.at + page.size);
            dataEnd = Math.max(dataEnd, page.at + page.size);
        }
        if (first < 0) continue;
        const what = o.flags & 4 ? 'code' : 'data';
        contents.push({ ...field(`Object ${o.n}`, first, last - first, `${what}, ${bytesLabel(last - first)} in the file`), children: fillGaps(data, parts, first, last, 'Not read') });
        entries.push({
            name: null,
            label: `${stem}-object-${o.n}-${what}.bin`,
            offset: first,
            size: last - first,
            data: data.subarray(first, last),
            meta: { Type: `Object ${o.n}: ${words(o.flags, OBJECT_FLAGS)}`, Address: `0x${hex(o.address)}` },
        });
    }
    fields.push(...contents);
    const debugAt = u(0x98) ? base + u(0x98) : 0;
    if (inFile(debugAt, u(0x9c)) && u(0x9c)) {
        fields.push(field('Debug info', debugAt, u(0x9c), bytesLabel(u(0x9c))));
        dataEnd = Math.max(dataEnd, debugAt + u(0x9c));
    }
    // A Windows driver's version information, after everything else: a resource as a 16-bit resource file holds one
    // (0xFF and its type, 16 for version; 0xFF and its number; memory flags; the size), then VS_VERSION_INFO in the code
    // page, as 16-bit programs keep it. Worked out from Windows 95 drivers: Internet Explorer 3's javasup.vxd,
    // ActiveMovie's quartz.vxd and NetMeeting's MNMVDD.386, whose header gives exactly the bytes to the end of the file.
    const versionAt = os === 4 && headerEnd - at === 0xc4 && u(0xb8) ? base + u(0xb8) : 0;
    const versionLength = versionAt ? u(0xbc) : 0;
    if (versionAt && versionLength) {
        if (!inFile(versionAt, versionLength)) problems.push(`Its version information is said to be ${bytesLabel(versionLength)} at ${versionAt.toLocaleString('en-US')}, past the end of the file.`);
        else {
            const shaped = versionLength >= 12 && data[versionAt] === 0xff && data[versionAt + 3] === 0xff;
            const type = shaped ? b.u16(versionAt + 1) : 0;
            const size = shaped ? b.u32(versionAt + 8) : 0;
            const info = shaped ? Math.min(size, versionLength - 12) : 0;
            const parts: Field[] = shaped
                ? [
                      field('Type', versionAt, 3, type === 16 ? '16 (version)' : type, 'Each 0xFF, then a number: a resource’s type and name given as numbers.'),
                      field('Number', versionAt + 3, 3, b.u16(versionAt + 4)),
                      field('Memory flags', versionAt + 6, 2, `0x${hex(b.u16(versionAt + 6), 4)}`),
                      field('Size', versionAt + 8, 4, bytesLabel(size)),
                      ...(info ? [field('Version information', versionAt + 12, info, bytesLabel(info), 'Under Contents, to open.')] : []),
                  ]
                : [];
            fields.push({
                ...field('Version resource', versionAt, versionLength, bytesLabel(versionLength), 'What Windows shows on the driver’s Details tab.'),
                children: fillGaps(data, parts, versionAt, versionAt + versionLength, 'Not read'),
            });
            if (!shaped) problems.push('Its version information doesn’t start with a resource’s header, as Windows drivers’ do.');
            else if (type !== 16) problems.push(`Its version information is said to be a resource of type ${type}, not 16, Windows’ type for version information.`);
            else if (size + 12 !== versionLength)
                problems.push(`Its version information says it’s ${bytesLabel(size)}, but the header gives it ${bytesLabel(versionLength - 12)} after the resource’s header.`);
            if (info)
                entries.push({
                    name: null,
                    label: `${stem}-version.bin`,
                    offset: versionAt + 12,
                    size: info,
                    data: data.subarray(versionAt + 12, versionAt + 12 + info),
                    meta: { Type: 'Version information' },
                    format: 'version',
                });
            dataEnd = Math.max(dataEnd, versionAt + versionLength);
        }
    }
    for (const { text, more } of repeated.values()) problems.push(more ? `${text} There ${more === 1 ? 'is 1 more' : `are ${more} more`} like it.` : text);

    // A DOS extender's program, when the caller found one (bound before it, or as its stub), whatever system it names: Watcom's
    // linker marks DOS/4GW programs as for OS/2, as TD's and Counterstrike's show, and DOS/32A's are LX. Otherwise OS/2 2.0
    // and later run LX, and an LE that isn't a Windows driver is a DOS extender's.
    const what = extender ? `32-bit DOS program, for ${extender}` : os === 4 ? 'Windows driver (VxD)' : kind === 'LX' ? 'OS/2 program' : '32-bit DOS program, for a DOS extender';
    const rows: TableRow[] = objectList.map((o) => ({
        group: o.flags & 4 ? 'Code' : 'Data',
        cells: { object: String(o.n), size: String(o.size), address: `0x${hex(o.address)}`, flags: words(o.flags, OBJECT_FLAGS), pages: String(o.count) },
    }));
    const targets = targetCounts
        .map((n, i) => [n, TARGETS[i]] as const)
        .filter(([n]) => n)
        .map(([n, t]) => `${n.toLocaleString('en-US')} ${t}`)
        .join(', ');
    return {
        kind,
        fields,
        entries,
        summary: [
            ...(moduleName ? [['Module', moduleName] as [string, string]] : []),
            [
                'For',
                `${(extender || (kind === 'LE' && os !== 4)) && os === 1 ? `${extender || 'a DOS extender'} (the header says OS/2, as DOS extenders’ linkers mark them)` : (SYSTEMS[os] ?? `system ${os}`)}, ${CPUS[b.u16(at + 8)] ?? 'a processor'} or later`,
            ],
            ['Objects', objectList.map((o) => `${o.flags & 4 ? 'code' : 'data'} (${bytesLabel(o.size)})`).join(', ') || 'none'],
            ['Starts', eipObject ? `object ${eipObject} + 0x${hex(u(0x1c))}` : 'nowhere: it’s a library'],
            ...(entryPoints.length ? [['Entry points', `${entryPoints.length.toLocaleString('en-US')}${exported.size ? `, ${exported.size} named` : ''}`] as [string, string]] : []),
            ...(imports.length ? [['Imports from', imports.join(', ')] as [string, string]] : []),
            [
                'Fixups',
                fixups
                    ? targetCounts.filter((n) => n).length === 1
                        ? `${fixups.toLocaleString('en-US')}, all ${TARGETS[targetCounts.findIndex((n) => n)]}`
                        : `${fixups.toLocaleString('en-US')}: ${targets}`
                    : 'none',
            ],
        ],
        rows,
        name: moduleName,
        end: dataEnd,
        problems,
        what,
    };
}
