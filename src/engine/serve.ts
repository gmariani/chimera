import type { Entry, Preview } from '../core/types';
import { detect } from '../formats';
import { inspect } from '../formats/inspect';
import { readNameList } from '../formats/mix/names';
import { expandPalette } from '../formats/westwood/vga';
import type { NamedPalette } from '../lib/palettes';
import { ARCHIVES, Library } from './library';
import type { DataRef, FromPage, FromWorker, Request, Results, WireEntry, WireInspection, WirePreview } from './protocol';

/**
 * The worker's side: it holds the bytes it's been sent, the session's files,
 * and the functions previews call later, and answers the page's requests one
 * at a time (so the page can tell which one a hang belongs to: the one
 * started and not done). Separate from the worker itself so it can be tested
 * in-process.
 */
export function serve(post: (message: FromWorker, transfer?: Transferable[]) => void): (message: FromPage) => void {
    const store = new Map<number, Uint8Array>();
    const handles = new Map<number, (...args: number[]) => unknown>();
    const library = new Library();
    let nextHandle = 1;
    // Keys the worker makes are negative, so they never meet the page's.
    let nextKey = -1;

    const resolve = (ref: DataRef): Uint8Array => {
        const known = store.get(ref.key);
        if (known) return known;
        let data: Uint8Array;
        if ('data' in ref) data = ref.data;
        else if ('parent' in ref) data = resolve(ref.parent).subarray(ref.offset, ref.offset + ref.length);
        else throw new Error(`The worker doesn't have buffer ${ref.key}.`);
        store.set(ref.key, data);
        return data;
    };

    /** Bytes of the worker's own, to send with a key so the page can send them back as one. */
    const own = (bytes: Uint8Array) => {
        const key = nextKey--;
        store.set(key, bytes);
        return { key, bytes };
    };

    const handle = (fn: (...args: number[]) => unknown) => {
        const id = nextHandle++;
        handles.set(id, fn);
        return id;
    };

    const wirePreview = (p: Preview): WirePreview => {
        switch (p.kind) {
            case 'images':
            case 'picture': {
                const { toggle, ...rest } = p;
                return toggle ? ({ ...rest, toggle: { label: toggle.label, off: handle(() => toggle.off()) } } as WirePreview) : (rest as WirePreview);
            }
            case 'video': {
                const { frame, ...rest } = p;
                return { ...rest, frame: handle((i) => frame(i)) };
            }
            case 'stack':
                return { kind: 'stack', items: p.items.map((item) => ({ title: item.title, preview: wirePreview(item.preview) })) };
            default:
                return p;
        }
    };

    const wireEntries = (entries: Entry[], parent: Uint8Array): WireEntry[] =>
        entries.map((e) => {
            const { data, ...rest } = e;
            // A part of the file itself goes back as its place; the page has the bytes.
            const inside = data.buffer === parent.buffer && data.byteOffset >= parent.byteOffset && data.byteOffset + data.length <= parent.byteOffset + parent.length;
            return { ...rest, format: detect(data, e.name).id, data: inside ? { offset: data.byteOffset - parent.byteOffset, length: data.length } : own(data) };
        });

    async function run<R extends Request>(request: R): Promise<Results[R['op']]> {
        const r = request as Request;
        switch (r.op) {
            case 'names':
                library.setUserNames(r.names);
                return undefined as Results[R['op']];
            case 'add': {
                const result = await library.add(r.name, resolve(r.data), r.how);
                return { ...result, learned: library.learned } as Results[R['op']];
            }
            case 'remove':
                library.remove(r.id);
                return { learned: library.learned } as Results[R['op']];
            case 'inspect': {
                const data = resolve(r.data);
                const found = await inspect(data, { name: r.name, names: library.names, find: (name) => library.find(name, r.near) }, { as: r.as, shownName: r.shownName });
                const { entries, preview, ...parsed } = found.parsed;
                const result: WireInspection = {
                    ...parsed,
                    format: found.format.id,
                    companions: found.format.companions === true,
                    entries: entries && wireEntries(entries, data),
                    preview: preview && wirePreview(preview),
                    checks: found.checks,
                    alternatives: found.alternatives.map((f) => f.id),
                };
                return result as Results[R['op']];
            }
            case 'call': {
                const fn = handles.get(r.handle);
                if (!fn) throw new Error('That preview is out of date; open the file again.');
                return fn(...r.args) as Results[R['op']];
            }
            case 'palettes':
                return (await palettesIn(r.name, resolve(r.data), library.names)) as Results[R['op']];
            case 'find': {
                for (const name of r.names) {
                    const hit = library.find(name, r.near)[0];
                    if (hit) return { name, data: own(hit.data) } as Results[R['op']];
                }
                return null as Results[R['op']];
            }
            case 'readNames':
                return readNameList(resolve(r.data)) as Results[R['op']];
            case 'release':
                for (const key of r.keys) store.delete(key);
                for (const h of r.handles) handles.delete(h);
                return undefined as Results[R['op']];
        }
    }

    // One request at a time, in order.
    let queue = Promise.resolve();
    return ({ id, request }) => {
        queue = queue.then(async () => {
            post({ id, type: 'start' });
            try {
                post({ id, type: 'done', result: await run(request) });
            } catch (e) {
                post({ id, type: 'error', name: e instanceof Error ? e.name : 'Error', message: e instanceof Error ? e.message : String(e) });
            }
        });
    };
}

/** How deep to look inside archives within archives (Red Alert keeps palettes two levels down). */
const PALETTE_DEPTH = 3;

/** Every palette in a file: the file itself, or any palette inside it or the archives it holds. */
export async function palettesIn(name: string, data: Uint8Array, names: readonly string[], depth = 0): Promise<NamedPalette[]> {
    const format = detect(data, name);
    if (format.id === 'pal') return data.length >= 768 ? [{ id: `${name}:${data.length}:${data[0]}${data[1]}${data[2]}`, label: name, colors: expandPalette(data) }] : [];
    if (!ARCHIVES.has(format.id) || depth >= PALETTE_DEPTH) return [];
    let entries: Entry[];
    try {
        entries = (await format.load()).parse(data, { name, names }).entries ?? [];
    } catch {
        return [];
    }
    const found: NamedPalette[] = [];
    for (const e of entries) {
        const id = detect(e.data, e.name).id;
        if (id !== 'pal' && !ARCHIVES.has(id)) continue;
        const inner = await palettesIn(e.name ?? `${e.label}.${id}`, e.data, names, depth + 1);
        for (const p of inner) found.push({ ...p, id: `${name}/${p.id}`, label: `${name} › ${p.label}` });
    }
    return found;
}
