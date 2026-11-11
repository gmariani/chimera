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

/** What a file was last read as, and what with: kept while the file is (in the trail of files opened), so going back to it shows it at once. */
interface Kept {
    names: readonly string[];
    near?: string;
    generation: number;
    version: number;
    inspection: UiInspection;
}
const kept = new WeakMap<OpenFile, Kept>();

/** The kept reading of a file, if it was read with the same names, from the same place, in the same worker, and (if it uses other files) the same session. */
function keptFor(file: OpenFile, names: readonly string[], near: string | undefined, generation: number, version: number): UiInspection | null {
    const k = kept.get(file);
    if (!k || k.names !== names || k.near !== near || k.generation !== generation) return null;
    return k.inspection.companions && k.version !== version ? null : k.inspection;
}

/**
 * Reads the file in the parsing worker, with the checks every file gets.
 * Reads again when `names` changes, when the session's files do (if the
 * format uses them), and when the worker was restarted. A file already read
 * with all of those the same (coming back to it from a file inside it) isn't
 * read again: its reading is kept while the file is.
 */
export function useParsed(file: OpenFile, names: readonly string[], { version, near }: { version: number; near?: string }): ParseState {
    const generation = useEngineGeneration();
    const [state, setState] = useState<ParseState>(() => {
        const inspection = keptFor(file, names, near, generation, version);
        return inspection ? { status: 'ready', ...inspection } : { status: 'loading', since: Date.now() };
    });
    // More files in the session only matter to a format that uses them: for the rest, the version the last read saw
    // stays the key, so a new file in the session doesn't read this one again.
    const [read, setRead] = useState<{ file: OpenFile; version: number; companions: boolean }>(() => {
        const k = kept.get(file);
        return { file, version: k?.version ?? version, companions: k?.inspection.companions ?? false };
    });
    const watched = read.file === file && !read.companions ? read.version : version;

    useEffect(() => {
        const already = keptFor(file, names, near, generation, watched);
        if (already) {
            setState((s) => (s.status === 'ready' && s.parsed === already.parsed ? s : { status: 'ready', ...already }));
            return;
        }
        // Each read is dropped only by its own cleanup (the file or what it's read with changing, or the page going).
        let canceled = false;
        setState((s) => (s.status === 'ready' && read.file === file ? s : { status: 'loading', since: Date.now() }));
        engine.inspect(file.data, { name: file.knownName, shownName: file.name, as: file.as, near }).then(
            (inspection) => {
                if (canceled) return;
                kept.set(file, { names, near, generation, version: watched, inspection });
                setRead({ file, version: watched, companions: inspection.companions });
                setState({ status: 'ready', ...inspection });
            },
            (e: unknown) => {
                if (canceled) return;
                // The page shows the message; the stack, the one clue to where a reader broke, goes to the developer console.
                // oxlint-disable-next-line no-console
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
