import { useEffect, useMemo, useState } from 'react';
import type { Companion, Entry, FormatDescriptor } from '../core/types';
import { detect, extensionOf, FORMATS } from '../formats';
import { inspect, type Inspection } from '../formats/inspect';

/** A file being looked at: opened from disk, or pulled out of another file. */
export interface OpenFile {
    /** The name to show and save under. */
    name: string;
    /** The real file name, when known (an archive may only store a hash). */
    knownName: string | null;
    data: Uint8Array;
    /** Open as this format (an id) rather than the one detected. */
    as?: string;
}

export type ParseState = { status: 'loading'; format: FormatDescriptor } | ({ status: 'ready' } & Inspection);

/** Other opened files, for formats that use companions; `version` changes when there are more. */
export interface Companions {
    find(name: string): Companion[];
    version: number;
}

/** The format a file is opened as at first: the one asked for, or the one detected. */
function firstFormat(file: OpenFile): FormatDescriptor {
    return (file.as && FORMATS.find((f) => f.id === file.as)) || detect(file.data, file.knownName ?? file.name);
}

/** Detects the file's format, loads that parser, parses, and checks the file is what it claims. Re-parses when `names` changes, or the companions do and the format uses them. */
export function useParsed(file: OpenFile, names: readonly string[], companions?: Companions): ParseState {
    const [state, setState] = useState<ParseState>(() => ({ status: 'loading', format: firstFormat(file) }));

    const usesCompanions = useMemo(() => firstFormat(file).companions === true, [file]);
    const find = usesCompanions ? companions?.find : undefined;
    const version = usesCompanions ? companions?.version : undefined;

    useEffect(() => {
        let canceled = false;
        const format = firstFormat(file);
        setState((s) => (s.status === 'ready' && s.format.id === format.id ? s : { status: 'loading', format }));
        // Give the browser a frame to show the spinner before a long parse.
        const timer = setTimeout(() => {
            inspect(file.data, { name: file.knownName, names, find }, { as: file.as, shownName: file.name }).then(
                (inspection) => !canceled && setState({ status: 'ready', ...inspection }),
                (e: unknown) => console.error(e),
            );
        }, 0);
        return () => {
            canceled = true;
            clearTimeout(timer);
        };
        // `version` isn't read here, but a new one means `find` has more to give.
    }, [file, names, find, version]);

    return state;
}

export interface TypedEntry {
    entry: Entry;
    format: FormatDescriptor;
    /** The name to save under: the real one, or the label plus the detected extension (a label with its own extension keeps it, when it fits the format or the app doesn't read the format). */
    fileName: string;
}

export function typeEntries(entries: Entry[]): TypedEntry[] {
    return entries.map((entry) => {
        const format = detect(entry.data, entry.name);
        const ext = entry.label.match(/\.([a-z0-9]{2,5})$/i)?.[1].toLowerCase();
        const ownExtension = ext !== undefined && (format.id === 'raw' || format.extensions.includes(ext));
        return { entry, format, fileName: entry.name ?? (ownExtension ? entry.label : `${entry.label}.${extensionOf(format)}`) };
    });
}

export function openEntry({ entry, fileName }: TypedEntry): OpenFile {
    return { name: fileName, knownName: entry.name, data: entry.data };
}
