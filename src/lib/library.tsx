import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Companion, Entry } from '../core/types';
import { detect } from '../formats';
import { namesFromText } from '../formats/mix/names';
import { sniffText } from '../formats/westwood/sniff';
import { typeEntries } from './inspect';

/**
 * The session's files: every file opened from disk or added for others to use,
 * and every named file inside those archives, so a format can draw on its
 * companions: a map finds its theater's tiles, a voxel model its animation.
 * They stay until the user removes them or closes the tab; nothing is uploaded.
 *
 * Their INIs also give file names: TS and RA2 archives keep none, but rules.ini
 * and the rest name nearly every asset (see namesFromText).
 */

/** How deep to look inside archives within archives (RA keeps theaters a level down in MAIN.MIX). */
const MAX_DEPTH = 3;

/** One file the user brought into the session, and what it holds. */
export interface SessionFile {
    /** Its name, made unique in the session: what companions' sources start with. */
    id: string;
    size: number;
    /** Opened to look at, or added for other files to use. */
    how: 'opened' | 'added';
    /** Named files inside it (and inside its archives), which others can find. */
    files: number;
    /** Archives inside it. */
    archives: number;
    /** Text files whose words are tried as file names. */
    texts: number;
}

interface LibraryState {
    /** The user's names plus those learned from the INIs in the session's archives: what to parse archives with. */
    names: readonly string[];
    /** Changes whenever files are added or removed, so formats that use them can look again. */
    version: number;
    files: SessionFile[];
    /** Everything under this name, those in `near` (an archive path) first. */
    find(name: string, near?: string): Companion[];
    /** Adds a file and what's inside it; resolves to how many files it brought. */
    add(name: string, data: Uint8Array, how?: SessionFile['how']): Promise<number>;
    remove(id: string): void;
}

const LibraryContext = createContext<LibraryState | null>(null);

/** The text files in an archive and the archives inside it. */
async function texts(name: string, data: Uint8Array, names: readonly string[], depth = 0): Promise<string[]> {
    const format = detect(data, name);
    if (format.id !== 'mix' || depth >= MAX_DEPTH) return [];
    let entries: Entry[];
    try {
        entries = (await format.load()).parse(data, { name, names }).entries ?? [];
    } catch {
        return [];
    }
    const found: string[] = [];
    for (const typed of typeEntries(entries)) {
        if (typed.format.id === 'mix') found.push(...(await texts(typed.fileName, typed.entry.data, names, depth + 1)));
        else if (sniffText(typed.entry.data)) found.push(new TextDecoder('latin1').decode(typed.entry.data));
    }
    return found;
}

/** Indexes every named file in an archive (and the archives inside it) under `source`; counts what it found. */
async function collect(name: string, data: Uint8Array, source: string, names: readonly string[], into: Map<string, Companion[]>, count: { files: number; archives: number }, depth = 0): Promise<void> {
    const format = detect(data, name);
    if (format.id !== 'mix' || depth >= MAX_DEPTH) return;
    let entries: Entry[];
    try {
        entries = (await format.load()).parse(data, { name, names }).entries ?? [];
    } catch {
        return;
    }
    if (depth > 0) count.archives++;
    const path = depth === 0 ? source : `${source} › ${name}`;
    for (const typed of typeEntries(entries)) {
        if (typed.entry.name) {
            const key = typed.entry.name.toLowerCase();
            const list = into.get(key) ?? [];
            if (!list.some((c) => c.data === typed.entry.data)) {
                list.push({ data: typed.entry.data, source: path });
                into.set(key, list);
                count.files++;
            }
        }
        if (typed.format.id === 'mix') await collect(typed.fileName, typed.entry.data, path, names, into, count, depth + 1);
    }
}

const rootOf = (source: string) => source.split(' › ')[0];

export function LibraryProvider({ names: userNames, children }: { names: readonly string[]; children: ReactNode }) {
    const files = useRef(new Map<string, Companion[]>());
    /** Each session file's data, so the same file isn't added twice. */
    const added = useRef(new Map<Uint8Array, string>());
    /** Each session file's texts, to learn names from (and forget them again on removal). */
    const textsOf = useRef(new Map<string, string[]>());
    const [session, setSession] = useState<SessionFile[]>([]);
    const [learned, setLearned] = useState<string[]>([]);
    const [version, setVersion] = useState(0);
    // One array for as long as neither list changes, so archives can cache its hashes.
    const combined = useRef<{ user: readonly string[]; learned: string[]; names: readonly string[] } | null>(null);
    const combine = useCallback((user: readonly string[], more: string[]) => {
        const c = combined.current;
        if (c?.user === user && c.learned === more) return c.names;
        combined.current = { user, learned: more, names: more.length ? [...user, ...more] : user };
        return combined.current.names;
    }, []);
    const names = combine(userNames, learned);
    const relearn = useCallback(() => {
        const all = new Set([...textsOf.current.values()].flat());
        const more = all.size ? namesFromText(all) : [];
        setLearned(more);
        return more;
    }, []);

    const add = useCallback(
        async (name: string, data: Uint8Array, how: SessionFile['how'] = 'added') => {
            const existing = added.current.get(data);
            if (existing) {
                // Opening a file that was added for others makes it an opened one.
                if (how === 'opened') setSession((s) => s.map((f) => (f.id === existing ? { ...f, how } : f)));
                return 0;
            }
            // A unique id: the name, numbered if another file of that name is already in.
            const taken = new Set(added.current.values());
            let id = name;
            for (let n = 2; taken.has(id); n++) id = `${name} (${n})`;
            added.current.set(data, id);

            const key = name.toLowerCase();
            files.current.set(key, [...(files.current.get(key) ?? []), { data, source: id }]);
            // Learn names from its INIs first, so what's indexed below is found by name.
            const own = await texts(name, data, names);
            textsOf.current.set(id, own);
            const current = own.length ? combine(userNames, relearn()) : names;
            const count = { files: 0, archives: 0 };
            await collect(name, data, id, current, files.current, count);
            setSession((s) => [...s, { id, size: data.length, how, files: count.files, archives: count.archives, texts: own.length }]);
            setVersion((v) => v + 1);
            return 1 + count.files;
        },
        [names, userNames, combine, relearn],
    );

    const remove = useCallback(
        (id: string) => {
            for (const [key, list] of files.current) {
                const kept = list.filter((c) => rootOf(c.source) !== id);
                if (kept.length) files.current.set(key, kept);
                else files.current.delete(key);
            }
            for (const [data, owner] of added.current) if (owner === id) added.current.delete(data);
            if (textsOf.current.delete(id)) relearn();
            setSession((s) => s.filter((f) => f.id !== id));
            setVersion((v) => v + 1);
        },
        [relearn],
    );

    const find = useCallback((name: string, near?: string) => {
        const list = files.current.get(name.toLowerCase()) ?? [];
        if (!near) return list;
        // The same archive first, then others under the same file opened from disk, then the rest.
        const root = rootOf(near);
        const rank = (c: Companion) => (c.source === near ? 0 : rootOf(c.source) === root ? 1 : 2);
        return [...list].sort((a, b) => rank(a) - rank(b));
    }, []);

    const value = useMemo(() => ({ names, version, files: session, find, add, remove }), [names, version, session, find, add, remove]);
    return <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>;
}

export function useLibrary(): LibraryState {
    const state = useContext(LibraryContext);
    if (!state) throw new Error('useLibrary needs a LibraryProvider.');
    return state;
}
