import { bytesLabel, field, hex } from '../core/bytes';
import type { Entry, Field, Preview, TableRow } from '../core/types';
import { decodeDib } from './dib';
import { pictureFinder, readDialog } from './win-dialogs';
import { readAccelerators } from './win-accelerators';
import { readMenu, type MenuItem } from './win-menus';
import {
    bitmapFile,
    iconGroupFile,
    languageName,
    readMessageTable,
    readStringTable,
    readVersionInfo,
    RESOURCE_TYPES,
    resourceFile,
    versionText,
    type ResourceString,
    type VersionInfo,
} from './win-resources';

/**
 * What a 32-bit module's resources show, wherever they're kept: in a program (pe.ts) or a resource file (res.ts). Each
 * resource read is broken into fields; bitmaps, strings and messages, version information, dialogs and the manifest
 * are shown; and each is in Contents as the file it would be saved as: bitmaps as .bmp, icon and cursor groups as .ico
 * and .cur, dialogs as .res files that carry the pictures they show, and the rest as they're stored.
 */

/** A resource: its type, name and language, and where its bytes are. */
export interface WinResource {
    type: number;
    typeName: string;
    /** Its number, or -1 when it has a name. */
    id: number;
    /** "#5", or its name. */
    name: string;
    lang: number;
    at: number;
    length: number;
}

export interface ResourceView {
    /** What's shown, in order. */
    items: { title: string; preview: Preview }[];
    /** For each resource read, what it is in a few words and its fields. */
    inside: Map<WinResource, { value: string; fields?: Field[] }>;
    entries: Entry[];
    version: VersionInfo | null;
    /** Bitmaps compressed in a way not drawn here. */
    undrawn: number;
    /** A resource's name as shown: its type and name, and its language when there are several. */
    nameOf(r: WinResource): string;
}

/** Resources with no signature of their own, and the readers that read them once saved. */
/** Extensions for resource types a program names itself, when the name says what they hold. */
const NAMED_TYPES: Record<string, string> = { AVI: 'avi', CERT: 'cer', SPC: 'spc' };
const SAVED_AS: Record<number, string> = { 4: 'win-menu', 9: 'win-accelerators', 6: 'win-strings', 11: 'win-messages' };

const plural = (n: number, word: string) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;

/**
 * Reads what a module's resources hold. `repeat` says something wrong with one of them (said once, with how many more
 * there are, by `kind`); `warn` says something said once anyway. `stem` names the .ico and .cur files; `owner` is what
 * holds them, for the warnings ("program", "file").
 */
export function viewResources(
    data: Uint8Array,
    resources: WinResource[],
    { stem, owner, repeat, warn }: { stem: string; owner: string; repeat: (kind: string, text: string) => void; warn: (text: string) => void }
): ResourceView {
    const several = (r: WinResource) => resources.filter((x) => x.type === r.type && x.typeName === r.typeName && x.name === r.name).length > 1;
    const nameOf = (r: WinResource) => `${r.typeName} ${r.name}${several(r) ? ` (${languageName(r.lang)})` : ''}`;
    const items: { title: string; preview: Preview }[] = [];
    const dialogs: { title: string; preview: Preview }[] = [];
    const menus: { title: string; preview: Preview }[] = [];
    /** What each command does, by its ID, as the menus name it: for the shortcut keys that send it. */
    const commands = new Map<number, string>();
    const inside = new Map<WinResource, { value: string; fields?: Field[] }>();
    const pictures = pictureFinder(data, resources);
    const stringRows: TableRow[] = [];
    const languages = new Set(resources.filter((r) => r.type === 6 || r.type === 11).map((r) => r.lang));
    const listed = (r: WinResource, kind: string, found: ResourceString[]) => {
        const group = languages.size > 1 ? `${kind} (${languageName(r.lang)})` : kind;
        for (const s of found) stringRows.push({ group, cells: { id: String(s.id), text: s.text } });
    };
    /** What each dialog names, for the .res file it's saved as. */
    const named = new Map<WinResource, { kind: 'icon' | 'bitmap'; ref: number | string }[]>();
    // Bitmaps of a kind not drawn here (compressed) are no fault of the module's: they're said in the summary, not warned about.
    let undrawn = 0;
    let version: VersionInfo | null = null;
    for (const r of resources) {
        if (r.type === 2) {
            const dib = decodeDib(data, r.at, r.length, false);
            if ('problem' in dib) {
                if (dib.unsupported) undrawn++;
                else repeat('bitmap', `${nameOf(r)} can't be drawn: ${dib.problem}.`);
                continue;
            }
            const { width, height, bits, colors, headerSize, colorsAt, pixelsAt, length } = dib.info;
            const value = `${width} × ${height}, ${colors ? `${colors} colors` : `${bits}-bit`}`;
            items.push({ title: `${nameOf(r)}: ${value}`, preview: { kind: 'picture', width, height, rgba: dib.rgba } });
            inside.set(r, {
                value,
                fields: [
                    field('Header', r.at, headerSize, `${width} × ${height}, ${bits} bits a pixel`),
                    ...(pixelsAt > colorsAt ? [field('Colors', r.at + colorsAt, pixelsAt - colorsAt, plural(colors, 'color'))] : []),
                    field('Pixels', r.at + pixelsAt, length - pixelsAt, bytesLabel(length - pixelsAt), 'Row by row, the bottom row first, each padded to 4 bytes.'),
                ],
            });
        } else if (r.type === 16 && !version) {
            version = readVersionInfo(data, r.at, r.length);
            version.problems.forEach(warn);
            inside.set(r, { value: version.fileVersion ?? bytesLabel(r.length), fields: version.fields[0]?.children ?? [] });
        } else if (r.type === 6) {
            const t = readStringTable(data, r.at, r.length, r.id, true);
            t.problems.forEach((p) => repeat('strings', p));
            listed(r, 'Strings', t.strings);
            inside.set(r, { value: plural(t.strings.length, 'string'), fields: t.fields });
        } else if (r.type === 11) {
            const t = readMessageTable(data, r.at, r.length);
            t.problems.forEach((p) => repeat('messages', p));
            listed(r, 'Messages', t.strings);
            inside.set(r, { value: plural(t.strings.length, 'message'), fields: t.fields });
        } else if (r.type === 4) {
            const m = readMenu(data, r.at, r.length, true);
            m.problems.forEach((p) => repeat('menu', `${nameOf(r)}: ${p}`));
            inside.set(r, { value: m.items.map((i) => i.text.replace(/&(.)/g, '$1')).join(', ') || 'empty', fields: m.fields });
            if (m.text) menus.push({ title: `${nameOf(r)}${m.extended ? ' (extended)' : ''}`, preview: { kind: 'text', text: m.text } });
            const walk = (list: MenuItem[]) =>
                list.forEach((i) => (i.id !== null && i.text && !commands.has(i.id) && commands.set(i.id, i.text.split('\t')[0].replace(/&(.)/g, '$1')), i.items && walk(i.items)));
            walk(m.items);
        } else if (r.type === 5) {
            const d = readDialog(data, r.at, r.length, true, pictures);
            if (!d) {
                repeat('dialog', `${nameOf(r)} is too short for a dialog’s header.`);
                continue;
            }
            d.problems.forEach((p) => repeat('dialog', `${nameOf(r)}: ${p}`));
            named.set(r, d.pictures);
            inside.set(r, { value: d.preview.title ? `"${d.preview.title}"` : plural(d.preview.controls.length, 'control'), fields: d.fields });
            dialogs.push({ title: `${nameOf(r)}${d.preview.title ? `: ${d.preview.title}` : ''}`, preview: d.preview });
        }
    }
    // Shortcut keys, after the menus, which name what their commands do.
    const keyRows: TableRow[] = [];
    for (const r of resources) {
        if (r.type !== 9) continue;
        const a = readAccelerators(data, r.at, r.length, true);
        a.problems.forEach((p) => repeat('keys', `${nameOf(r)}: ${p}`));
        inside.set(r, { value: a.entries.map((e) => e.keys).join(', ') || 'none', fields: a.fields });
        for (const e of a.entries) keyRows.push({ group: nameOf(r), cells: { keys: e.keys, id: String(e.id), does: commands.get(e.id) ?? '' } });
    }
    if (keyRows.length)
        items.push({
            title: `Shortcut keys: ${keyRows.length.toLocaleString('en-US')}`,
            preview: {
                kind: 'table',
                columns: [
                    { key: 'keys', label: 'Keys' },
                    { key: 'id', label: 'Command', numeric: true },
                    { key: 'does', label: 'Its menu item' },
                ],
                groups: [...new Set(keyRows.map((r) => r.group))],
                rows: keyRows,
            },
        });
    if (stringRows.length)
        items.push({
            title: `Strings and messages: ${stringRows.length.toLocaleString('en-US')}`,
            preview: {
                kind: 'table',
                columns: [
                    { key: 'id', label: 'ID', numeric: true },
                    { key: 'text', label: 'Text' },
                ],
                groups: [...new Set(stringRows.map((r) => r.group))],
                rows: stringRows,
            },
        });
    const versionLines = version ? versionText(version) : '';
    if (versionLines) items.push({ title: 'Version information', preview: { kind: 'text', text: versionLines } });
    items.push(...menus, ...dialogs);
    const manifest = resources.find((r) => r.type === 24);
    if (manifest)
        items.push({
            title: `${nameOf(manifest)}: what Windows reads before running it`,
            preview: { kind: 'text', text: new TextDecoder().decode(data.subarray(manifest.at, manifest.at + Math.min(manifest.length, 1 << 16))), maxLines: 30 },
        });

    // Contents.
    const entries: Entry[] = [];
    const matching = (type: number, ref: number | string) =>
        resources.find((x) => x.type === type && (typeof ref === 'number' ? x.id === ref : x.id < 0 && x.name.toUpperCase() === ref.toUpperCase()));
    for (const r of resources) {
        if ([1, 3, 12, 14].includes(r.type)) continue;
        const meta = { Type: r.typeName, Language: languageName(r.lang) };
        if (r.type === 2) {
            const bmp = bitmapFile(data, r.at, r.length);
            entries.push({
                name: null,
                label: `${nameOf(r)}.${bmp ? 'bmp' : 'bin'}`,
                offset: r.at,
                size: bmp?.length ?? r.length,
                data: bmp ?? data.subarray(r.at, r.at + r.length),
                meta: bmp ? { ...meta, Type: 'Bitmap file, from the resource' } : meta,
            });
            continue;
        }
        if (r.type === 5 && named.has(r)) {
            // A dialog, with the icon groups, icons and bitmaps it shows: a resource file that draws as the program does.
            const carried: WinResource[] = [r];
            for (const { kind, ref } of named.get(r)!) {
                const found = matching(kind === 'icon' ? 14 : 2, ref);
                if (!found || carried.includes(found)) continue;
                carried.push(found);
                if (kind === 'icon') {
                    const b = new DataView(data.buffer, data.byteOffset, data.byteLength);
                    const count = found.at + 6 <= data.length ? Math.min(b.getUint16(found.at + 4, true), Math.floor((Math.min(found.length, data.length - found.at) - 6) / 14)) : 0;
                    for (let i = 0; i < count; i++) {
                        const icon = matching(3, b.getUint16(found.at + 6 + i * 14 + 12, true));
                        if (icon && !carried.includes(icon)) carried.push(icon);
                    }
                }
            }
            const file = resourceFile(carried.map((x) => ({ type: x.type, id: x.id, name: x.name, lang: x.lang, data: data.subarray(x.at, x.at + x.length) })));
            entries.push({
                name: null,
                label: `${nameOf(r)}.res`,
                offset: r.at,
                size: file.length,
                data: file,
                meta: { ...meta, Type: carried.length > 1 ? `Dialog, with the ${plural(carried.length - 1, 'picture resource')} it shows` : 'Dialog' },
            });
            continue;
        }
        entries.push({
            name: null,
            // Types of the program's own, named for what they hold: "AVI", what Windows' animation control plays its
            // movies from; "CERT" and "SPC", certificates and bags of them (Internet Explorer 3's DLLs).
            label: `${nameOf(r)}.${RESOURCE_TYPES[r.type]?.ext ?? NAMED_TYPES[r.typeName] ?? 'bin'}`,
            offset: r.at,
            size: r.length,
            data: data.subarray(r.at, r.at + r.length),
            meta,
            ...(SAVED_AS[r.type] ? { format: SAVED_AS[r.type] } : {}),
        });
    }
    for (const r of resources) {
        if (r.type !== 14 && r.type !== 12) continue;
        const cursor = r.type === 12;
        const kind = cursor ? 1 : 3;
        const find = (id: number) => resources.find((x) => x.type === kind && x.id === id && x.lang === r.lang) ?? resources.find((x) => x.type === kind && x.id === id) ?? null;
        const { file, images, missing } = iconGroupFile(data, r.at, r.length, cursor, find);
        if (missing.length)
            repeat('group', `${nameOf(r)} names ${cursor ? 'cursor' : 'icon'}${missing.length === 1 ? '' : 's'} ${missing.map((i) => `#${i}`).join(', ')}, which the ${owner} doesn't have.`);
        if (!file) continue;
        const ext = cursor ? 'cur' : 'ico';
        entries.push({
            name: `${stem}-${r.name.replace(/^#/, '')}${several(r) ? `-${hex(r.lang, 4)}` : ''}.${ext}`,
            label: `${cursor ? 'Cursor' : 'Icon'} ${r.name}.${ext}`,
            offset: r.at,
            size: file.length,
            data: file,
            meta: { Type: `${cursor ? 'Cursor' : 'Icon'} file, from the group and its ${images === 1 ? 'image' : `${images} images`}`, Language: languageName(r.lang) },
        });
    }
    return { items, inside, entries, version, undrawn, nameOf };
}
