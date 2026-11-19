import { Bytes, bytesLabel, field, fillGaps, hex } from '../core/bytes';
import { checkCount } from '../core/limits';
import { minOf } from '../core/math';
import type { Entry, Field, FormatParser, Preview, TableRow } from '../core/types';
import { debugInfo } from './debug-info';
import { decodeDib } from './dib';
import { neOffset } from './ne-sniff';
import { bitmapFile, iconGroupFile, readStringTable, readVersionInfo, versionText, resourceCounts, RESOURCE_TYPES as TYPES, type VersionInfo } from './win-resources';

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

        // What's inside the resources this reads (bitmaps, version information, strings), field by field, and what's shown of
        // them. Icons and cursors are in Contents, as the .ico and .cur files their groups make, which open as files of their own.
        const items: { title: string; preview: Preview }[] = [];
        const inside = new Map<Resource, { value: string; fields: Field[] }>();
        const stringRows: TableRow[] = [];
        let version: VersionInfo | null = null;
        for (const r of resources) {
            if (!fits(r.at, r.length)) continue;
            if (r.type === 2) {
                const dib = decodeDib(data, r.at, r.length, false);
                if ('problem' in dib) {
                    warnings.push(`${r.typeName} ${r.name} can't be drawn: ${dib.problem}.`);
                    continue;
                }
                const { width, height, bits, colors, headerSize, colorsAt, pixelsAt, length } = dib.info;
                const value = `${width} × ${height}, ${colors ? `${colors} colors` : `${bits}-bit`}`;
                items.push({ title: `${r.typeName} ${r.name}: ${value}`, preview: { kind: 'picture', width, height, rgba: dib.rgba } });
                inside.set(r, {
                    value,
                    fields: [
                        field('Header', r.at, headerSize, `${width} × ${height}, ${bits} bits a pixel`),
                        ...(pixelsAt > colorsAt ? [field('Colors', r.at + colorsAt, pixelsAt - colorsAt, `${colors} colors`)] : []),
                        field('Pixels', r.at + pixelsAt, length - pixelsAt, bytesLabel(length - pixelsAt), 'Row by row, the bottom row first, each padded to 4 bytes.'),
                    ],
                });
            } else if (r.type === 16 && !version) {
                version = readVersionInfo(data, r.at, r.length);
                warnings.push(...version.problems);
                inside.set(r, { value: version.fileVersion ?? bytesLabel(r.length), fields: version.fields[0]?.children ?? [] });
            } else if (r.type === 6) {
                const t = readStringTable(data, r.at, r.length, r.id, false);
                warnings.push(...t.problems);
                for (const x of t.strings) stringRows.push({ group: 'Strings', cells: { id: String(x.id), text: x.text } });
                inside.set(r, { value: `${t.strings.length} string${t.strings.length === 1 ? '' : 's'}`, fields: t.fields });
            }
        }
        if (stringRows.length)
            items.push({
                title: `Strings: ${stringRows.length.toLocaleString('en-US')}`,
                preview: {
                    kind: 'table',
                    columns: [
                        { key: 'id', label: 'ID', numeric: true },
                        { key: 'text', label: 'Text' },
                    ],
                    groups: ['Strings'],
                    rows: stringRows,
                },
            });
        const versionLines = version ? versionText(version) : '';
        if (versionLines) items.push({ title: 'Version information', preview: { kind: 'text', text: versionLines } });

        // Each resource to save as it's stored (bitmaps as .bmp files), except icons and cursors and their groups: those come together, below.
        const entries: Entry[] = [];
        const stem = (context.name ?? 'module').replace(/\.[^.]*$/, '');
        for (const r of resources) {
            if ([1, 3, 12, 14].includes(r.type) || !fits(r.at, r.length)) continue;
            const bmp = r.type === 2 ? bitmapFile(data, r.at, r.length) : null;
            entries.push({
                name: null,
                label: `${r.typeName} ${r.name}.${bmp ? 'bmp' : r.type === 2 ? 'bin' : (TYPES[r.type]?.ext ?? 'bin')}`,
                offset: r.at,
                size: bmp?.length ?? r.length,
                data: bmp ?? data.subarray(r.at, r.at + r.length),
                meta: { Type: bmp ? 'Bitmap file, from the resource' : r.typeName },
            });
        }

        // Each icon or cursor group as the file Windows would save it as (see win-resources.ts).
        for (const r of resources) {
            if ((r.type !== 14 && r.type !== 12) || !fits(r.at, 6)) continue;
            const cursor = r.type === 12;
            const { file, images, missing } = iconGroupFile(data, r.at, r.length, cursor, (id) => resources.find((x) => x.type === (cursor ? 1 : 3) && x.id === id) ?? null);
            if (missing.length)
                warnings.push(
                    `${r.typeName} ${r.name} names ${cursor ? 'cursor' : 'icon'}${missing.length === 1 ? '' : 's'} ${missing.map((i) => `#${i}`).join(', ')}, which the module doesn't have.`
                );
            if (!file) continue;
            const ext = cursor ? 'cur' : 'ico';
            entries.push({
                name: `${stem}-${r.name.replace(/^#/, '')}.${ext}`,
                label: `${cursor ? 'Cursor' : 'Icon'} ${r.name}.${ext}`,
                offset: r.at,
                size: file.length,
                data: file,
                meta: { Type: `${cursor ? 'Cursor' : 'Icon'} file, from the group and its ${images === 1 ? 'image' : `${images} images`}` },
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
        for (const r of resources) {
            if (!fits(r.at, 1)) continue;
            const known = inside.get(r);
            const children = known && fillGaps(data, known.fields, r.at, Math.min(data.length, r.at + r.length), 'Not read');
            tableField(`${r.typeName} ${r.name}`, r.at, r.at + r.length, known?.value ?? bytesLabel(r.length), children?.length ? children : undefined);
        }

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

        // Past everything the module points to is nothing it has (installers append their payload there), except the linker's debug info.
        let end = Math.min(data.length, Math.max(covered, lastEnd));
        const debug = debugInfo(data, end);
        if (debug && 'problem' in debug) warnings.push(debug.problem);
        else if (debug) {
            filled.push(...debug.fields);
            end = debug.end;
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
                ...(debug && !('problem' in debug) ? [['Debug info', debug.summary] as [string, string]] : []),
                ...(stray ? [['Not pointed to', `${bytesLabel(stray)} between the parts aren’t padding, and nothing in the module points to them`] as [string, string]] : []),
                ['Resources', resourceCounts(resources)],
            ],
            fields: filled,
            entries,
            preview: items.length ? (items.length === 1 ? items[0].preview : { kind: 'stack', items }) : undefined,
            // Anything after is the usual checks' to look at.
            end,
            warnings,
        };
    },
};

export default parser;
