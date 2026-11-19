import { Bytes, bytesLabel, field, fillGaps } from '../core/bytes';
import type { Field, FormatParser } from '../core/types';
import { sniffRes } from './res-sniff';
import { viewResources, type WinResource } from './win-resource-view';
import { languageName, resourceCounts, RESOURCE_TYPES } from './win-resources';

/**
 * Resource files (.res): what a resource compiler (Microsoft's rc.exe, Wine's wrc, windres) makes of a program's .rc
 * script, for the linker to put into the program; Chimera saves a program's dialogs as them too, with the pictures
 * they show. An empty entry first, then each resource: a header (the data's size, the header's own, the type and the
 * name, each a number or UTF-16 text, then the data's version, memory flags, language, version and characteristics)
 * and its data, each on a 4-byte boundary. What the resources hold is read as a program's are (win-resource-view.ts).
 * See Microsoft's "Resource File Formats" and RESOURCEHEADER (https://learn.microsoft.com/windows/win32/menurc/resourceheader);
 * the empty entry is what rc.exe and wrc write, as Warcraft II Remastered's .res files and wrc's own show.
 */

const MEMORY_FLAGS: [number, string][] = [
    [0x10, 'moveable'],
    [0x20, 'pure'],
    [0x40, 'preload'],
    [0x1000, 'discardable'],
];

const parser: FormatParser = {
    parse(data, context) {
        if (!sniffRes(data)) throw new Error('This isn’t a 32-bit resource file: it doesn’t start with the empty entry rc.exe writes.');
        const b = new Bytes(data);
        const warnings: string[] = [];
        const repeated = new Map<string, { text: string; more: number }>();
        const repeat = (kind: string, text: string) => {
            const seen = repeated.get(kind);
            if (seen) seen.more++;
            else repeated.set(kind, { text, more: 0 });
        };
        const resources: WinResource[] = [];
        const headers = new Map<WinResource, Field[]>();
        const fields: Field[] = [];
        // A name or a number: 0xFFFF and the number, or UTF-16 text to its NUL, within the header.
        const nameOrNumber = (p: number, to: number): { id: number; text: string; next: number } => {
            if (b.u16(p) === 0xffff) return { id: b.u16(p + 2), text: '', next: p + 4 };
            let s = '';
            for (; p + 2 <= to && b.u16(p); p += 2) s += String.fromCharCode(b.u16(p));
            return { id: -1, text: s, next: Math.min(to, p + 2) };
        };
        let p = 0;
        let end = 0;
        // Each entry is 32 bytes at least, so there can't be more than fit.
        for (let n = 0; p + 8 <= data.length && n <= data.length / 32; n++) {
            const size = b.u32(p);
            const headerSize = b.u32(p + 4);
            if (headerSize < 32 || p + headerSize > data.length) {
                warnings.push(
                    `The resource at ${p.toLocaleString('en-US')} says its header is ${bytesLabel(headerSize)}, ${headerSize < 32 ? 'less than the 32 every header takes' : 'past the end of the file'}: what follows wasn’t read.`
                );
                break;
            }
            const h = p + headerSize;
            const type = nameOrNumber(p + 8, h - 16);
            const name = nameOrNumber(type.next, h - 16);
            const lang = b.u16(h - 10);
            const flags = b.u16(h - 12);
            const typeName = type.id >= 0 ? (RESOURCE_TYPES[type.id]?.name ?? `Type ${type.id}`) : type.text;
            const shownName = name.id >= 0 ? `#${name.id}` : name.text;
            const length = Math.min(size, data.length - h);
            if (length < size) warnings.push(`${typeName} ${shownName} says it’s ${bytesLabel(size)}, past the end of the file: it’s cut short.`);
            const head = [
                field('Data size', p, 4, bytesLabel(size)),
                field('Header size', p + 4, 4, bytesLabel(headerSize)),
                field('Type', p + 8, type.next - p - 8, type.id >= 0 ? `${typeName} (${type.id})` : type.text),
                field('Name', type.next, name.next - type.next, shownName),
                field('Data version', h - 16, 4, b.u32(h - 16)),
                field(
                    'Memory flags',
                    h - 12,
                    2,
                    MEMORY_FLAGS.filter(([bit]) => flags & bit)
                        .map(([, w]) => w)
                        .join(', ') || 'none',
                    'Left from 16-bit Windows: Windows ignores them now.'
                ),
                field('Language', h - 10, 2, languageName(lang)),
                field('Version', h - 8, 4, b.u32(h - 8)),
                field('Characteristics', h - 4, 4, b.u32(h - 4)),
            ];
            const next = Math.min(data.length, h + length + ((4 - ((h + length) % 4)) % 4));
            if (p === 0) {
                fields.push({ ...field('Empty entry', 0, 32, 'marks a 32-bit resource file', 'No data, type 0, name 0: 16-bit tools stop here.'), children: head });
            } else {
                const r: WinResource = { type: type.id >= 0 ? type.id : -1, typeName, id: name.id, name: shownName, lang, at: h, length };
                resources.push(r);
                headers.set(r, fillGaps(data, head, p, h, 'Not read'));
            }
            end = h + length;
            // Up to 3 zeros to the next 4-byte boundary.
            if (next > end) {
                const pad = data.subarray(end, next);
                if (pad.every((v) => v === 0)) end = next;
            }
            p = next;
        }
        const view = viewResources(data, resources, { stem: (context.name ?? context.label ?? 'resources').replace(/\.[^.]*$/, ''), owner: 'file', repeat, warn: (t) => warnings.push(t) });
        for (const r of resources) {
            const known = view.inside.get(r);
            const head = headers.get(r)!;
            const children: Field[] = [{ ...field('Header', head[0].offset, r.at - head[0].offset, `${view.nameOf(r)}, ${languageName(r.lang)}`), children: head }];
            if (r.length)
                children.push({
                    ...field('Data', r.at, r.length, known?.value ?? bytesLabel(r.length)),
                    ...(known?.fields ? { children: fillGaps(data, known.fields, r.at, r.at + r.length, 'Not read') } : {}),
                });
            const to = Math.min(data.length, r.at + r.length + ((4 - ((r.at + r.length) % 4)) % 4));
            if (to > r.at + r.length && data.subarray(r.at + r.length, to).every((v) => v === 0))
                children.push(field('Padding', r.at + r.length, to - r.at - r.length, bytesLabel(to - r.at - r.length)));
            fields.push({
                ...field(
                    view.nameOf(r),
                    head[0].offset,
                    children.reduce((n, c) => n + c.length, 0),
                    known?.value ?? bytesLabel(r.length)
                ),
                children,
            });
        }
        for (const { text, more } of repeated.values()) warnings.push(more ? `${text} There ${more === 1 ? 'is 1 more' : `are ${more} more`} like it.` : text);
        const { items, entries, undrawn } = view;
        const languages = [...new Set(resources.map((r) => languageName(r.lang)))];
        return {
            title: 'Resource file (.res, 32-bit)',
            summary: [
                ['Resources', resourceCounts(resources)],
                ...(languages.length ? [['Languages', languages.join(', ')] as [string, string]] : []),
                ...(undrawn ? [['Not drawn', `${undrawn} bitmap${undrawn === 1 ? '' : 's'}, compressed in a way not drawn here (under Contents)`] as [string, string]] : []),
            ],
            fields,
            entries,
            preview: items.length ? (items.length === 1 ? items[0].preview : { kind: 'stack', items }) : undefined,
            end,
            warnings,
        };
    },
};

export default parser;
