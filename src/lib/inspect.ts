import { useEffect, useState } from 'react';
import type { Entry, FormatDescriptor, Parsed } from '../core/types';
import { detect, extensionOf } from '../formats';

/** A file being looked at: opened from disk, or pulled out of another file. */
export interface OpenFile {
    /** The name to show and save under. */
    name: string;
    /** The real file name, when known (an archive may only store a hash). */
    knownName: string | null;
    data: Uint8Array;
}

export type ParseState =
    | { status: 'loading'; format: FormatDescriptor }
    | { status: 'ready'; format: FormatDescriptor; parsed: Parsed }
    | { status: 'error'; format: FormatDescriptor; error: string };

/** Detects the file's format, loads that parser, and parses. Re-parses when `names` changes. */
export function useParsed(file: OpenFile, names: readonly string[]): ParseState {
    const [state, setState] = useState<ParseState>(() => ({ status: 'loading', format: detect(file.data, file.knownName ?? file.name) }));

    useEffect(() => {
        let cancelled = false;
        const format = detect(file.data, file.knownName ?? file.name);
        setState((s) => (s.status === 'ready' && s.format.id === format.id ? s : { status: 'loading', format }));
        format
            .load()
            .then((parser) => {
                // Give the browser a frame to show the spinner before a long parse.
                return new Promise<Parsed>((resolve, reject) =>
                    setTimeout(() => {
                        try {
                            resolve(parser.parse(file.data, { name: file.knownName, names }));
                        } catch (e) {
                            reject(e);
                        }
                    }, 0),
                );
            })
            .then(
                (parsed) => !cancelled && setState({ status: 'ready', format, parsed }),
                (e: unknown) => {
                    if (cancelled) return;
                    console.error(e);
                    setState({ status: 'error', format, error: e instanceof Error ? e.message : String(e) });
                },
            );
        return () => {
            cancelled = true;
        };
    }, [file, names]);

    return state;
}

export interface TypedEntry {
    entry: Entry;
    format: FormatDescriptor;
    /** The name to save under: the real one, or the label plus the detected extension. */
    fileName: string;
}

export function typeEntries(entries: Entry[]): TypedEntry[] {
    return entries.map((entry) => {
        const format = detect(entry.data, entry.name);
        return { entry, format, fileName: entry.name ?? `${entry.label}.${extensionOf(format)}` };
    });
}

export function openEntry({ entry, fileName }: TypedEntry): OpenFile {
    return { name: fileName, knownName: entry.name, data: entry.data };
}
