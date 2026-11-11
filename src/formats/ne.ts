import { Bytes, bytesLabel, field, hex } from '../core/bytes';
import { checkCount } from '../core/limits';
import { minOf } from '../core/math';
import type { Entry, Field, FormatParser, Preview } from '../core/types';
import { decodeDib } from './dib';
import { neOffset } from './ne-sniff';

/**
 * 16-bit Windows (and OS/2) modules, "New Executable": Windows 3's programs,
 * libraries and drivers, its bitmap fonts (.fon), and icon libraries (.icl,
 * and Dune II's DUNE2.ICO). An MZ header (and the DOS program that says it
 * needs Windows), then the NE header, which says where its tables are:
 *
 * - segments: the code and data, each where it is and how long;
 * - resources: icons, cursors, bitmaps, fonts, menus, strings and the rest;
 * - names: the module's own name and description, the modules it imports
 *   from (KERNEL, USER, GDI), and its exported entry points.
 *
 * A module with no segments and no entry points has nothing to run: it only
 * carries resources. Icons, cursors and bitmaps are device-independent bitmaps
 * (a BITMAPINFOHEADER, the colors, the pixels bottom row first, and for icons
 * and cursors a 1-bit mask of what's see-through).
 * See Microsoft's "Executable-File Header Format" (the NE spec in the Windows
 * 3.1 SDK), mirrored at https://wiki.osdev.org/NE.
 */

/** Resource types Windows defines (the high bit set means a number, not a name). */
const TYPES: Record<number, { name: string; ext: string }> = {
    // Saved as they're stored: a bare bitmap (DIB), not yet an .ico, .cur or .bmp file.
    1: { name: 'Cursor', ext: 'dib' },
    2: { name: 'Bitmap', ext: 'dib' },
    3: { name: 'Icon', ext: 'dib' },
    4: { name: 'Menu', ext: 'bin' },
    5: { name: 'Dialog', ext: 'bin' },
    6: { name: 'Strings', ext: 'bin' },
    7: { name: 'Font directory', ext: 'bin' },
    8: { name: 'Font', ext: 'fnt' },
    9: { name: 'Shortcut keys', ext: 'bin' },
    10: { name: 'Data', ext: 'bin' },
    11: { name: 'Message table', ext: 'bin' },
    12: { name: 'Cursor group', ext: 'bin' },
    14: { name: 'Icon group', ext: 'bin' },
    16: { name: 'Version', ext: 'bin' },
};
const OS: Record<number, string> = { 0: 'unknown', 1: 'OS/2', 2: 'Windows', 3: 'European MS-DOS 4', 4: 'Windows 386', 5: 'Borland Operating System Services' };

interface Resource {
    type: number;
    typeName: string;
    id: number;
    name: string;
    /** Where its entry is in the resource table. */
    entryAt: number;
    at: number;
    length: number;
}

const parser: FormatParser = {
    parse(data, context) {
        const ne = neOffset(data);
        if (ne === null) throw new Error('This isn\'t a 16-bit Windows module: its MZ header doesn\'t point to an "NE" header that fits the file.');
        const b = new Bytes(data);
        const warnings: string[] = [];
        const at = (rel: number) => ne + b.u16(ne + rel);
        const table = { entry: at(0x04), segments: at(0x22), resources: at(0x24), resident: at(0x26), modules: at(0x28), imports: at(0x2a) };
        const entryLength = b.u16(ne + 0x06);
        const segmentCount = b.u16(ne + 0x1c);
        const moduleCount = b.u16(ne + 0x1e);
        const nonresidentSize = b.u16(ne + 0x20);
        const nonresidentAt = b.u32(ne + 0x2c);
        const shift = b.u16(ne + 0x32);
        const os = data[ne + 0x36];
        const fits = (from: number, length: number) => from >= 0 && from + length <= data.length;

        // The tables come one after another, in this order; each one's end is where the next starts.
        const order: [string, number][] = [
            ['segments', table.segments],
            ['resources', table.resources],
            ['resident', table.resident],
            ['modules', table.modules],
            ['imports', table.imports],
            ['entry', table.entry],
        ];
        for (const [name, offset] of order) if (offset > data.length) warnings.push(`The ${name} table is said to be at ${offset.toLocaleString('en-US')}, past the end of the file.`);
        if (shift > 16) throw new Error(`The segments are aligned to 2^${shift} bytes, which no module uses.`);

        // Pascal strings (a length, then that many characters), until a length of 0.
        const pascal = (from: number) => (from < data.length ? b.ascii(from + 1, data[from]) : '');
        /** A names table: each name with its ordinal, and where the table ends (after its closing 0). */
        const names = (from: number, to: number) => {
            const out: { name: string; ordinal: number; at: number }[] = [];
            let p = from;
            for (; p < Math.min(to, data.length) && data[p]; p += 1 + data[p] + 2) out.push({ name: pascal(p), ordinal: b.u16(p + 1 + data[p]), at: p });
            return Object.assign(out, { end: Math.min(data.length, p + 1) });
        };
        const resident = names(table.resident, data.length);
        const nonresident = fits(nonresidentAt, nonresidentSize) ? names(nonresidentAt, nonresidentAt + nonresidentSize) : [];
        if (nonresidentSize && !fits(nonresidentAt, nonresidentSize)) warnings.push('The table of names not kept in memory runs past the end of the file.');
        checkCount(moduleCount, 2, data.length - table.modules, 'Imported modules');
        const imports = Array.from({ length: moduleCount }, (_, i) => pascal(table.imports + b.u16(table.modules + i * 2)));

        // The segments: where each is (in units of 2^shift), how long (0 means 64 KB), and its flags.
        checkCount(segmentCount, 8, data.length - table.segments, 'Segments');
        const segments = Array.from({ length: segmentCount }, (_, i) => {
            const e = table.segments + i * 8;
            const sector = b.u16(e);
            const length = b.u16(e + 2) || (sector ? 0x10000 : 0);
            const flags = b.u16(e + 4);
            const start = sector * 2 ** shift;
            // Relocations follow the segment's bytes when bit 8 is set: a count, then 8 bytes each.
            const relocations = flags & 0x100 && fits(start + length, 2) ? b.u16(start + length) : 0;
            return { i, entryAt: e, start, length, flags, data: !!(flags & 1), relocations };
        });
        for (const s of segments)
            if (s.length && !fits(s.start, s.length)) warnings.push(`Segment ${s.i + 1} is said to be ${bytesLabel(s.length)} at ${s.start.toLocaleString('en-US')}, past the end of the file.`);

        // The resources: an alignment shift, then for each type its ID, a count and 4 unused bytes, then that many 12-byte
        // entries (where, how long, flags, ID), until a type of 0. Names (for IDs without the high bit) follow, as Pascal strings.
        const resources: Resource[] = [];
        let resourcesEnd = table.resources;
        let resShift = 0;
        if (table.resources !== table.resident) {
            resShift = b.u16(table.resources);
            if (resShift > 16) throw new Error(`The resources are aligned to 2^${resShift} bytes, which no module uses.`);
            let p = table.resources + 2;
            // A type or ID without the high bit is a name: where it is in this table. Each name read is marked, wherever it is.
            const named: { at: number; length: number }[] = [];
            const label = (v: number) => {
                if (v & 0x8000) return null;
                const at = table.resources + v;
                named.push({ at, length: at < data.length ? 1 + data[at] : 0 });
                return pascal(at);
            };
            for (let guard = 0; p + 2 <= data.length && b.u16(p) !== 0; guard++) {
                if (guard > 256) throw new Error('The resource table never ends: it lists more than 256 types.');
                const type = b.u16(p);
                const count = checkCount(b.u16(p + 2), 12, data.length - p - 8, 'Resources');
                const typeName = label(type) ?? TYPES[type & 0x7fff]?.name ?? `Type ${type & 0x7fff}`;
                for (let i = 0; i < count; i++) {
                    const e = p + 8 + i * 12;
                    const id = b.u16(e + 6);
                    resources.push({
                        type: type & 0x8000 ? type & 0x7fff : -1,
                        typeName,
                        id: id & 0x8000 ? id & 0x7fff : -1,
                        name: label(id) ?? `#${id & 0x7fff}`,
                        entryAt: e,
                        at: b.u16(e) * 2 ** resShift,
                        length: b.u16(e + 2) * 2 ** resShift,
                    });
                }
                p += 8 + count * 12;
            }
            // The types end with a 0, and the names follow: as far as the last one read, and the 0 that ends them after it.
            let q = p + 2;
            for (const n of named) q = Math.max(q, n.at + n.length);
            if (q < data.length && data[q] === 0) q++;
            resourcesEnd = Math.min(data.length, q);
        }
        // Where the segments' and resources' bytes start: the tables all come before. A names table said to be past here is
        // missing in all but name (Dune II's DUNE2.ICO, from an icon editor, points its into an icon, and has no names).
        const dataStart = minOf([data.length, ...segments.filter((x) => x.length).map((x) => x.start), ...resources.map((r) => r.at)]);
        const residentLost = table.resident >= dataStart && dataStart > table.resources;
        if (residentLost) resident.splice(0, resident.length);
        for (const r of resources)
            if (!fits(r.at, r.length)) warnings.push(`${r.typeName} ${r.name} is said to be ${bytesLabel(r.length)} at ${r.at.toLocaleString('en-US')}, past the end of the file.`);

        // What's drawn here: the bitmaps. Icons and cursors are in Contents, as the .ico and .cur files their groups make,
        // which open (and draw) as files of their own.
        const items: { title: string; preview: Preview }[] = [];
        for (const r of resources) {
            if (r.type !== 2 || !fits(r.at, r.length)) continue;
            const dib = decodeDib(data, r.at, r.length, false);
            if ('problem' in dib) {
                warnings.push(`${r.typeName} ${r.name} can't be drawn: ${dib.problem}.`);
                continue;
            }
            const { width, height, bits, colors } = dib.info;
            items.push({ title: `${r.typeName} ${r.name}: ${width} × ${height}, ${colors ? `${colors} colors` : `${bits}-bit`}`, preview: { kind: 'picture', width, height, rgba: dib.rgba } });
        }

        // Each resource to save as it's stored, except icons and cursors and their groups: those come together, below.
        const entries: Entry[] = [];
        const stem = (context.name ?? 'module').replace(/\.[^.]*$/, '');
        for (const r of resources)
            if (![1, 3, 12, 14].includes(r.type) && fits(r.at, r.length))
                entries.push({
                    name: null,
                    label: `${r.typeName} ${r.name}.${TYPES[r.type]?.ext ?? 'bin'}`,
                    offset: r.at,
                    size: r.length,
                    data: data.subarray(r.at, r.at + r.length),
                    meta: { Type: r.typeName },
                });

        /**
         * Each icon or cursor group as the file Windows would save it as: a 6-byte header (0, 1 for icons or 2 for cursors, the
         * count), a 16-byte entry for each image, then the images. A group's entries are 14 bytes (an icon's: width, height,
         * colors, reserved, planes, bits, size, ID; a cursor's: width, height doubled, planes, bits, size, ID), and a cursor's
         * image starts with its hot spot, which goes into its file entry instead.
         */
        for (const r of resources) {
            if ((r.type !== 14 && r.type !== 12) || !fits(r.at, 6)) continue;
            const cursor = r.type === 12;
            const count = Math.min(b.u16(r.at + 4), Math.floor((r.length - 6) / 14));
            const listed = Array.from({ length: count }, (_, i) => {
                const e = r.at + 6 + i * 14;
                return { e, id: b.u16(e + 12), size: b.u32(e + 8), res: resources.find((x) => x.type === (cursor ? 1 : 3) && x.id === b.u16(e + 12)) };
            });
            const missing = listed.filter((i) => !i.res || !fits(i.res.at, i.res.length));
            if (missing.length)
                warnings.push(
                    `${r.typeName} ${r.name} names ${cursor ? 'cursor' : 'icon'}${missing.length === 1 ? '' : 's'} ${missing.map((i) => `#${i.id}`).join(', ')}, which the module doesn't have.`
                );
            const present = listed.filter((i) => i.res && fits(i.res.at, i.res.length));
            if (!present.length) continue;
            // The image itself: the group's size for it (the resource is rounded up to the alignment), less a cursor's hot spot.
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
            let at = header;
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
                v.setUint32(e + 12, at, true);
                file.set(x.bytes, at);
                at += x.bytes.length;
            });
            const ext = cursor ? 'cur' : 'ico';
            entries.push({
                name: `${stem}-${r.name.replace(/^#/, '')}.${ext}`,
                label: `${cursor ? 'Cursor' : 'Icon'} ${r.name}.${ext}`,
                offset: r.at,
                size: file.length,
                data: file,
                meta: { Type: `${cursor ? 'Cursor' : 'Icon'} file, from the group and its ${images.length === 1 ? 'image' : `${images.length} images`}` },
            });
        }

        // Fields, marking every byte: what the headers and tables say is where, and anything left over.
        const fields: Field[] = [];
        const mz: Field = {
            name: 'MZ header',
            offset: 0,
            length: 64,
            value: 'DOS’s header',
            children: [
                field('Signature', 0, 2, '"MZ"'),
                field('Bytes in the last page', 2, 2, b.u16(2)),
                field('Pages', 4, 2, b.u16(4), 'Of 512 bytes: how much DOS loads.'),
                field('Relocations', 6, 2, b.u16(6)),
                field('Header size', 8, 2, `${b.u16(8)} paragraphs`, 'In 16-byte steps.'),
                field('DOS header rest', 10, 50, 'Memory, stack, entry point, checksum, reserved'),
                field('NE header at', 0x3c, 4, ne, 'Where the Windows module starts.'),
            ],
        };
        fields.push(mz);
        if (ne > 64) fields.push(field('DOS stub', 64, ne - 64, bytesLabel(ne - 64), 'What runs under DOS: usually a message that the program needs Windows.'));
        fields.push({
            name: 'NE header',
            offset: ne,
            length: 64,
            value: `for ${OS[os] ?? `system ${os}`}`,
            children: [
                field('Signature', ne, 2, '"NE"'),
                field('Linker version', ne + 2, 2, `${data[ne + 2]}.${data[ne + 3]}`),
                field('Entry table at', ne + 4, 2, b.u16(ne + 4), 'From the NE header.'),
                field('Entry table length', ne + 6, 2, entryLength),
                field('Checksum', ne + 8, 4, hex(b.u32(ne + 8))),
                field('Flags', ne + 0x0c, 2, hex(b.u16(ne + 0x0c), 4), 'Bit 15: a library. Bits 0–1: how its data is shared.'),
                field('Data segment', ne + 0x0e, 2, b.u16(ne + 0x0e)),
                field('Heap and stack', ne + 0x10, 4, `${b.u16(ne + 0x10)} and ${b.u16(ne + 0x12)} bytes`),
                field('Entry point (CS:IP)', ne + 0x14, 4, `${b.u16(ne + 0x16)}:${hex(b.u16(ne + 0x14), 4)}`, 'Segment, then where in it.'),
                field('Stack (SS:SP)', ne + 0x18, 4, `${b.u16(ne + 0x1a)}:${hex(b.u16(ne + 0x18), 4)}`),
                field('Segments', ne + 0x1c, 2, segmentCount),
                field('Imported modules', ne + 0x1e, 2, moduleCount),
                field('Non-resident names size', ne + 0x20, 2, nonresidentSize),
                field('Table offsets', ne + 0x22, 10, 'segments, resources, resident names, modules, imported names', 'Each from the NE header.'),
                field('Non-resident names at', ne + 0x2c, 4, nonresidentAt, 'From the start of the file.'),
                field('Movable entry points', ne + 0x30, 2, b.u16(ne + 0x30)),
                field('Segment alignment', ne + 0x32, 2, `2^${shift} = ${2 ** shift} bytes`),
                field('Resource segments', ne + 0x34, 2, b.u16(ne + 0x34)),
                field('Target system', ne + 0x36, 1, OS[os] ?? os),
                field('Other flags', ne + 0x37, 1, hex(data[ne + 0x37], 2)),
                field('Fast-load area', ne + 0x38, 4, `${b.u16(ne + 0x38)}, ${b.u16(ne + 0x3a)}`),
                field('Code swap area', ne + 0x3c, 2, b.u16(ne + 0x3c)),
                field('Windows version', ne + 0x3e, 2, `${data[ne + 0x3f]}.${data[ne + 0x3e].toString().padStart(2, '0')}`, 'The Windows it expects.'),
            ],
        });
        const tableField = (name: string, from: number, to: number, value: string, children?: Field[]) => {
            if (to > from && from < data.length) fields.push({ name, offset: from, length: Math.min(to, data.length) - from, value, children });
        };
        tableField(
            'Segment table',
            table.segments,
            table.segments + segmentCount * 8,
            `${segmentCount} segment${segmentCount === 1 ? '' : 's'}`,
            segments.map((s) => field(`Segment ${s.i + 1}`, s.entryAt, 8, `${s.data ? 'data' : 'code'}, ${bytesLabel(s.length)}`))
        );
        tableField(
            'Resource table',
            table.resources,
            resourcesEnd,
            `${resources.length} resource${resources.length === 1 ? '' : 's'}`,
            resources.map((r) => field(`${r.typeName} ${r.name}`, r.entryAt, 12, bytesLabel(r.length)))
        );
        if (!residentLost)
            tableField(
                'Resident names',
                table.resident,
                resident.end,
                resident.map((n) => n.name || '(empty)').join(', ') || 'none',
                resident.map((n) => field(n.name || '(empty)', n.at, 1 + n.name.length + 2, `ordinal ${n.ordinal}`))
            );
        tableField('Module references', table.modules, table.modules + moduleCount * 2, imports.join(', ') || 'none');
        // Its size isn't given: it runs to the entry table, which follows it.
        if (table.entry > table.imports) tableField('Imported names', table.imports, table.entry, imports.join(', ') || 'none');
        tableField('Entry table', table.entry, table.entry + entryLength, `${bytesLabel(entryLength)}`);
        if (nonresidentSize && fits(nonresidentAt, nonresidentSize)) tableField('Non-resident names', nonresidentAt, nonresidentAt + nonresidentSize, nonresident[0]?.name ?? '');
        for (const s of segments)
            if (s.length && fits(s.start, 1)) {
                tableField(`Segment ${s.i + 1}`, s.start, s.start + s.length, `${s.data ? 'Data' : 'Code'}, ${bytesLabel(s.length)}`);
                if (s.relocations) tableField(`Segment ${s.i + 1} relocations`, s.start + s.length, s.start + s.length + 2 + s.relocations * 8, `${s.relocations}`);
            }
        for (const r of resources) if (fits(r.at, 1)) tableField(`${r.typeName} ${r.name}`, r.at, r.at + r.length, bytesLabel(r.length));

        // Overlaps aside, what nothing above points to: zeros are padding to the alignment; anything else is worth a look.
        fields.sort((x, y) => x.offset - y.offset || y.length - x.length);
        const filled: Field[] = [];
        let covered = 0;
        let stray = 0;
        const lastEnd = fields.reduce((n, f) => Math.max(n, f.offset + f.length), 0);
        for (const f of fields) {
            if (f.offset > covered) {
                const gap = data.subarray(covered, f.offset);
                const zeros = gap.every((v) => v === 0);
                if (!zeros) stray += gap.length;
                filled.push(
                    field(zeros ? 'Padding' : 'Not pointed to', covered, gap.length, bytesLabel(gap.length), zeros ? 'Zeros, to the next alignment.' : 'Nothing in the headers or tables points here.')
                );
            }
            filled.push(f);
            covered = Math.max(covered, f.offset + f.length);
        }
        // Real modules have these (DUNE2.ICO keeps a stale copy of a resource entry behind its table), so they're said, not warned
        // about; they're in the structure as "Not pointed to", where anything hidden in them can be seen.

        // Windows' own types read in lower case ("2 icons"); a module's named types keep theirs ("1 OEMBIN").
        const counts = new Map<string, number>();
        for (const r of resources) {
            const t = r.type >= 0 && TYPES[r.type] ? r.typeName.toLowerCase() : r.typeName;
            counts.set(t, (counts.get(t) ?? 0) + 1);
        }
        const codeless = segmentCount === 0 && entryLength === 0;
        // What a module with no code is for, as its resources say (icons: an icon library; fonts: a .fon), in the words identify.ts uses.
        const HELD: Record<number, string> = { 1: 'cursors', 2: 'bitmaps', 3: 'icons', 4: 'menus', 5: 'dialogs', 6: 'strings', 8: 'fonts' };
        const held = [...new Set(resources.map((r) => HELD[r.type]).filter(Boolean))].join(' and ') || 'resources';
        return {
            title: codeless
                ? `16-bit ${OS[os] === 'OS/2' ? 'OS/2' : 'Windows'} module with no code (NE), holding ${held}`
                : `16-bit ${OS[os] === 'OS/2' ? 'OS/2' : 'Windows'} ${b.u16(ne + 0x0c) & 0x8000 ? 'library' : 'program'} (NE)`,
            summary: [
                ['Module', residentLost ? 'No names: the table of them is said to be inside the module’s data' : resident[0]?.name || '(no name)'],
                ...(nonresident[0]?.name ? [['Description', nonresident[0].name] as [string, string]] : []),
                ['For', `${OS[os] ?? `system ${os}`}${os === 2 ? (data[ne + 0x3f] ? ` ${data[ne + 0x3f]}.${data[ne + 0x3e].toString().padStart(2, '0')}` : ' (no version given)') : ''}`],
                ['Code', codeless ? 'None: it holds only resources, and can’t run' : `${segments.filter((s) => !s.data).length} code and ${segments.filter((s) => s.data).length} data segments`],
                ...(imports.length ? [['Imports from', imports.join(', ')] as [string, string]] : []),
                ...(stray ? [['Not pointed to', `${bytesLabel(stray)} between the parts aren’t padding, and nothing in the module points to them`] as [string, string]] : []),
                ['Resources', [...counts].map(([t, n]) => `${n} ${t}${n === 1 || t !== t.toLowerCase() ? '' : 's'}`).join(', ') || 'none'],
            ],
            fields: filled,
            entries,
            preview: items.length ? (items.length === 1 ? items[0].preview : { kind: 'stack', items }) : undefined,
            // Past everything the module points to is nothing it has (installers append their payload there); the usual checks look at it.
            end: Math.min(data.length, Math.max(covered, lastEnd)),
            warnings,
        };
    },
};

export default parser;
