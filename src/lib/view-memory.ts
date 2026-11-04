import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';

/**
 * What the user had set on a file's page (the contents filter, the sort, the
 * tab, how far down they'd scrolled), kept while they look inside one of its
 * files and put back when they return to it.
 */
export type ViewMemory = Map<string, unknown>;

/** useState that starts from, and keeps itself in, a file's view memory. */
export function useRemembered<T>(memory: ViewMemory | undefined, key: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
    const [value, setValue] = useState<T>(() => (memory?.has(key) ? (memory.get(key) as T) : initial));
    useEffect(() => {
        memory?.set(key, value);
    }, [memory, key, value]);
    return [value, setValue];
}
