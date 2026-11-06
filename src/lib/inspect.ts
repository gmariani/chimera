import { useEffect, useMemo, useState } from 'react';
import type { Companion, Entry, FormatDescriptor, Parsed } from '../core/types';
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

/** Other opened files, for formats that use companions; `version` changes when there are more. */
export interface Companions {
    find(name: string): Companion[];
    version: number;
}

/** Detects the file's format, loads that parser, and parses. Re-parses when `names` changes, or the companions do and the format uses them. */
export function useParsed(file: OpenFile, names: readonly string[], companions?: Companions): ParseState {
    const [state, setState] = useState<ParseState>(() => ({ status: 'loading', format: detect(file.data, file.knownName ?? file.name) }));

    const usesCompanions = useMemo(() => detect(file.data, file.knownName ?? file.name).companions === true, [file]);
    const find = usesCompanions ? companions?.find : undefined;
    const version = usesCompanions ? companions?.version : undefined;

    useEffect(() => {
        let canceled = false;
        const format = detect(file.data, file.knownName ?? file.name);
        setState((s) => (s.status === 'ready' && s.format.id === format.id ? s : { status: 'loading', format }));
        format
            .load()
            .then((parser) => {
                // Give the browser a frame to show the spinner before a long parse.
                return new Promise<Parsed>((resolve, reject) =>
                    setTimeout(() => {
                        try {
                            resolve(parser.parse(file.data, { name: file.knownName, names, find }));
                        } catch (e) {
                            reject(e);
                        }
                    }, 0),
                );
            })
            .then(
                (parsed) => !canceled && setState({ status: 'ready', format, parsed }),
                (e: unknown) => {
                    if (canceled) return;
                    console.error(e);
                    setState({ status: 'error', format, error: e instanceof Error ? e.message : String(e) });
                },
            );
        return () => {
            canceled = true;
        };
        // `version` isn't read here, but a new one means `find` has more to give.
    }, [file, names, find, version]);

    return state;
}

export interface TypedEntry {
    entry: Entry;
    format: FormatDescriptor;
    /** The name to save under: the real one, or the label plus the detected extension (a label that has its own, for a format the app doesn't read, keeps it). */
    fileName: string;
}

export function typeEntries(entries: Entry[]): TypedEntry[] {
    return entries.map((entry) => {
        const format = detect(entry.data, entry.name);
        const ownExtension = format.id === 'raw' && /\.[a-z0-9]{2,5}$/i.test(entry.label);
        return { entry, format, fileName: entry.name ?? (ownExtension ? entry.label : `${entry.label}.${extensionOf(format)}`) };
    });
}

export function openEntry({ entry, fileName }: TypedEntry): OpenFile {
    return { name: fileName, knownName: entry.name, data: entry.data };
}
