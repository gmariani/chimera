import type { Entry, Field, IndexedImage, Link, Overlay, Preview, VideoFrame } from '../core/types';
import type { Check } from '../formats/inspect';
import type { NamedPalette } from '../lib/palettes';
import type { SessionFile } from './library';

/**
 * What the page and the parsing worker say to each other. Every file's bytes
 * are parsed in the worker, so a file made to hang or exhaust a parser can be
 * stopped without the page; the page only draws what comes back.
 *
 * Bytes cross once: each buffer the page sends gets a key, and after that the
 * key stands for it. Files inside another come back as a place in their
 * parent (no copy) when they're a part of it, or as bytes of their own (an
 * unpacked or decrypted file) with a key the worker made. Functions a preview
 * calls later (a video's frames) stay in the worker, as handles.
 */

/** Bytes, as the worker will know them: by key once it has them. */
export type DataRef =
    | { key: number }
    | { key: number; data: Uint8Array }
    /** Part of another buffer. */
    | { key: number; parent: DataRef; offset: number; length: number };

export type Request =
    /** The names the user gave, for archives that store only hashes. */
    | { op: 'names'; names: readonly string[] }
    | { op: 'add'; name: string; data: DataRef; how: SessionFile['how'] }
    | { op: 'remove'; id: string }
    | { op: 'inspect'; data: DataRef; name: string | null; shownName: string; as?: string; near?: string }
    | { op: 'call'; handle: number; args: (number | boolean | undefined)[] }
    | { op: 'palettes'; name: string; data: DataRef }
    /** The first of these files found in the session. */
    | { op: 'find'; names: string[]; near?: string }
    /** A list of file names: XCC's database, a text file, a game's executable. */
    | { op: 'readNames'; data: DataRef }
    /** Buffers and handles the page no longer holds. */
    | { op: 'release'; keys: number[]; handles: number[] };

export type FromPage = { id: number; request: Request };
export type FromWorker = { id: number; type: 'start' } | { id: number; type: 'done'; result: unknown } | { id: number; type: 'error'; name: string; message: string };

/** A file inside another: a part of it (by place), or bytes of its own (by a key the worker made). */
export type WireEntry = Omit<Entry, 'data'> & { data: { offset: number; length: number } | { key: number; bytes: Uint8Array }; format: string };

/** A preview, with each function it has replaced by a handle. */
export type WirePreview =
    | Exclude<Preview, { kind: 'images' | 'picture' | 'video' | 'stack' }>
    | (Omit<Extract<Preview, { kind: 'images' }>, 'toggle'> & { toggle?: { label: string; off: number } })
    | (Omit<Extract<Preview, { kind: 'picture' }>, 'toggle'> & { toggle?: { label: string; off: number } })
    | (Omit<Extract<Preview, { kind: 'video' }>, 'frame'> & { frame: number })
    | { kind: 'stack'; items: { title: string; preview: WirePreview }[] };

export interface WireInspection {
    format: string;
    /** It uses other files, so it's worth reading again when there are more. */
    companions: boolean;
    title: string;
    summary: [string, string][];
    fields: Field[];
    entries?: WireEntry[];
    preview?: WirePreview;
    overlays?: Overlay[];
    wanted?: string;
    links?: Link[];
    warnings: string[];
    checks: Check[];
    alternatives: string[];
}

export interface Results {
    names: void;
    add: { file: SessionFile | null; existing?: string; brought: number; learned: string[] };
    remove: { learned: string[] };
    inspect: WireInspection;
    call: VideoFrame | IndexedImage[] | Uint8Array;
    palettes: NamedPalette[];
    find: { name: string; data: { key: number; bytes: Uint8Array } } | null;
    readNames: string[];
    release: void;
}
