import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Companion, Entry } from '../core/types';
import { detect } from '../formats';
import { namesFromText } from '../formats/mix/names';
import { sniffText } from '../formats/westwood/sniff';
import { typeEntries } from './inspect';

/**
 * Every file opened this session, and every named file inside those archives,
 * so a format can draw on its companions: a map finds its theater's tiles, a
 * TD map its mission INI. Like palettes, they stay until the page closes.
 *
 * Their INIs also give file names: TS and RA2 archives keep none, but rules.ini
 * and the rest name nearly every asset (see namesFromText).
 */

/** How deep to look inside archives within archives (RA keeps theaters a level down in MAIN.MIX). */
const MAX_DEPTH = 3;

interface LibraryState {
    /** The user's names plus those learned from the INIs in opened archives: what to parse archives with. */
    names: readonly string[];
    /** Changes whenever files are added, so formats that use them can look again. */
    version: number;
    /** Everything under this name, those in `near` (an archive path) first. */
    find(name: string, near?: string): Companion[];
    /** Adds a file and what's inside it; resolves to how many files it brought. */
    add(name: string, data: Uint8Array): Promise<number>;
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

async function collect(name: string, data: Uint8Array, source: string, names: readonly string[], into: Map<string, Companion[]>, depth = 0): Promise<number> {
    const format = detect(data, name);
    if (format.id !== 'mix' || depth >= MAX_DEPTH) return 0;
    let entries: Entry[];
    try {
        entries = (await format.load()).parse(data, { name, names }).entries ?? [];
    } catch {
        return 0;
    }
    const path = depth === 0 ? name : `${source} › ${name}`;
    let added = 0;
    for (const typed of typeEntries(entries)) {
        if (typed.entry.name) {
            const key = typed.entry.name.toLowerCase();
            const list = into.get(key) ?? [];
            if (!list.some((c) => c.data === typed.entry.data)) {
                list.push({ data: typed.entry.data, source: path });
                into.set(key, list);
                added++;
            }
        }
        if (typed.format.id === 'mix') added += await collect(typed.fileName, typed.entry.data, path, names, into, depth + 1);
    }
    return added;
}

export function LibraryProvider({ names: userNames, children }: { names: readonly string[]; children: ReactNode }) {
    const files = useRef(new Map<string, Companion[]>());
    const seen = useRef(new Set<Uint8Array>());
    const allTexts = useRef(new Set<string>());
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

    const add = useCallback(
        async (name: string, data: Uint8Array) => {
            if (seen.current.has(data)) return 0;
            seen.current.add(data);
            const key = name.toLowerCase();
            const list = files.current.get(key) ?? [];
            files.current.set(key, [...list, { data, source: name }]);
            // Learn names from its INIs first, so what's indexed below is found by name.
            let current = names;
            const before = allTexts.current.size;
            for (const text of await texts(name, data, names)) allTexts.current.add(text);
            if (allTexts.current.size > before) {
                const more = namesFromText(allTexts.current);
                setLearned(more);
                current = combine(userNames, more);
            }
            const added = 1 + (await collect(name, data, name, current, files.current));
            setVersion((v) => v + 1);
            return added;
        },
        [names, userNames, combine],
    );

    const find = useCallback((name: string, near?: string) => {
        const list = files.current.get(name.toLowerCase()) ?? [];
        if (!near) return list;
        // The same archive first, then others under the same file opened from disk, then the rest.
        const root = near.split(' › ')[0];
        const rank = (c: Companion) => (c.source === near ? 0 : c.source.split(' › ')[0] === root ? 1 : 2);
        return [...list].sort((a, b) => rank(a) - rank(b));
    }, []);

    const value = useMemo(() => ({ names, version, find, add }), [names, version, find, add]);
    return <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>;
}

export function useLibrary(): LibraryState {
    const state = useContext(LibraryContext);
    if (!state) throw new Error('useLibrary needs a LibraryProvider.');
    return state;
}
