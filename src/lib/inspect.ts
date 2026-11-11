import { useEffect, useState } from 'react';
import { bytesLabel } from '../core/bytes';
import type { Entry, FormatDescriptor } from '../core/types';
import { detect, extensionOf, FORMATS, RAW } from '../formats';
import { engine, Stopped, type UiInspection } from '../engine';

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

export type ParseState =
    | {
          status: 'loading';
          /** Since when, so the page can offer to stop a read that's taking long. */
          since: number;
      }
    | ({ status: 'ready' } & UiInspection);

/** What's shown for a file whose reading was stopped: its bytes, and why. Made here, without parsing anything. */
function stoppedInspection(data: Uint8Array, reason: string): UiInspection {
    return {
        format: RAW,
        companions: false,
        parsed: {
            title: 'Not read',
            summary: [['Size', bytesLabel(data.length)]],
            fields: [{ name: 'Data', offset: 0, length: data.length, note: 'Reading this file was stopped, so only its bytes are shown.' }],
            warnings: [],
        },
        entryFormats: [],
        checks: [{ level: 'danger', text: `${reason} Its bytes are still here to look at.` }],
        alternatives: [],
    };
}

/** Counts restarts of the parsing worker, so what was read in the old one is read again. */
function useEngineGeneration(): number {
    const [generation, setGeneration] = useState(engine.generation);
    useEffect(() => engine.on((e) => e.kind === 'restarted' && setGeneration(e.generation)), []);
    return generation;
}

/**
 * Reads the file in the parsing worker, with the checks every file gets.
 * Reads again when `names` changes, when the session's files do (if the
 * format uses them), and when the worker was restarted.
 */
export function useParsed(file: OpenFile, names: readonly string[], { version, near }: { version: number; near?: string }): ParseState {
    const [state, setState] = useState<ParseState>(() => ({ status: 'loading', since: Date.now() }));
    const generation = useEngineGeneration();
    // More files in the session only matter to a format that uses them: for the rest, the version the last read saw
    // stays the key, so a new file in the session doesn't read this one again.
    const [read, setRead] = useState<{ file: OpenFile; version: number; companions: boolean }>({ file, version, companions: false });
    const watched = read.file === file && !read.companions ? read.version : version;

    useEffect(() => {
        // Each read is dropped only by its own cleanup (the file or what it's read with changing, or the page going).
        let canceled = false;
        setState((s) => (s.status === 'ready' && read.file === file ? s : { status: 'loading', since: Date.now() }));
        engine.inspect(file.data, { name: file.knownName, shownName: file.name, as: file.as, near }).then(
            (inspection) => {
                if (canceled) return;
                setRead({ file, version: watched, companions: inspection.companions });
                setState({ status: 'ready', ...inspection });
            },
            (e: unknown) => {
                if (canceled) return;
                if (!(e instanceof Stopped)) console.error(e);
                setState({ status: 'ready', ...stoppedInspection(file.data, e instanceof Error ? e.message : String(e)) });
            }
        );
        return () => {
            canceled = true;
        };
        // `read` is only consulted to keep the old result on screen while the same file is read again.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [file, names, near, watched, generation]);

    return state;
}

export interface TypedEntry {
    entry: Entry;
    format: FormatDescriptor;
    /** The name to save under: the real one, or the label plus the detected extension (a label with its own extension keeps it, when it fits the format or the app doesn't read the format). */
    fileName: string;
}

/**
 * The entries with their formats: those the worker detected them as (by id,
 * in the same order), which is what the page uses, since detecting runs a
 * file's bytes through the sniffers; or, without them (tests), detected here.
 */
export function typeEntries(entries: Entry[], formats?: string[]): TypedEntry[] {
    return entries.map((entry, i) => {
        const format = formats ? (FORMATS.find((f) => f.id === formats[i]) ?? RAW) : detect(entry.data, entry.name);
        const ext = entry.label.match(/\.([a-z0-9]{2,5})$/i)?.[1].toLowerCase();
        const ownExtension = ext !== undefined && (format.id === 'raw' || format.extensions.includes(ext));
        return { entry, format, fileName: entry.name ?? (ownExtension ? entry.label : `${entry.label}.${extensionOf(format)}`) };
    });
}

export function openEntry({ entry, fileName }: TypedEntry): OpenFile {
    return { name: fileName, knownName: entry.name, data: entry.data };
}
