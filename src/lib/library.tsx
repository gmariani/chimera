import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { engine, Stopped } from '../engine';
import type { SessionFile } from '../engine/library';

export type { SessionFile };

/**
 * The session's files, as the page sees them: which files are in use and
 * what each brought. The files themselves, and everything inside them that
 * other files find by name, are kept in the parsing worker (src/engine), so
 * reading them happens there too.
 */

interface LibraryState {
    /** The user's names plus those learned from the INIs in the session's archives. */
    names: readonly string[];
    /** Changes whenever files are added or removed, so formats that use them can look again. */
    version: number;
    files: SessionFile[];
    /** Adds a file and what's inside it; resolves to how many files it brought. */
    add(name: string, data: Uint8Array, how?: SessionFile['how']): Promise<number>;
    remove(id: string): void;
    /** The id of the file in the session with these bytes, if it's there. */
    idOf(data: Uint8Array): string | undefined;
}

const LibraryContext = createContext<LibraryState | null>(null);

export function LibraryProvider({ names: userNames, children }: { names: readonly string[]; children: ReactNode }) {
    const ids = useRef(new Map<Uint8Array, string>());
    const [session, setSession] = useState<SessionFile[]>([]);
    const [learned, setLearned] = useState<string[]>([]);
    const [version, setVersion] = useState(0);

    useEffect(() => engine.setNames(userNames), [userNames]);

    // One array for as long as neither list changes.
    const names = useMemo(() => (learned.length ? [...userNames, ...learned] : userNames), [userNames, learned]);

    const add = useCallback(async (name: string, data: Uint8Array, how: SessionFile['how'] = 'added') => {
        let result;
        try {
            result = await engine.add(name, data, how);
        } catch (e) {
            // Stopped (it hung): the engine has said so; the file just isn't in the session.
            if (e instanceof Stopped) return 0;
            throw e;
        }
        setLearned((l) => (sameList(l, result.learned) ? l : result.learned));
        if (!result.file) {
            // Opening a file that was added for others makes it an opened one.
            if (how === 'opened' && result.existing) setSession((s) => s.map((f) => (f.id === result.existing ? { ...f, how } : f)));
            return 0;
        }
        ids.current.set(data, result.file.id);
        setSession((s) => [...s, result.file!]);
        setVersion((v) => v + 1);
        return result.brought;
    }, []);

    const remove = useCallback((id: string) => {
        for (const [data, owner] of ids.current) if (owner === id) ids.current.delete(data);
        setSession((s) => s.filter((f) => f.id !== id));
        setVersion((v) => v + 1);
        void engine.remove(id).then((r) => setLearned((l) => (sameList(l, r.learned) ? l : r.learned)));
    }, []);

    const idOf = useCallback((data: Uint8Array) => ids.current.get(data), []);

    const value = useMemo(() => ({ names, version, files: session, add, remove, idOf }), [names, version, session, add, remove, idOf]);
    return <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>;
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i]);

export function useLibrary(): LibraryState {
    const state = useContext(LibraryContext);
    if (!state) throw new Error('useLibrary needs a LibraryProvider.');
    return state;
}
