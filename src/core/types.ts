/**
 * The contract between the app and a file format. A format turns bytes into
 * plain data: a tree of labelled byte ranges (what each part of the file is),
 * the files stored inside it (if it's an archive), and a preview of what it
 * holds. Formats never render anything, so the same parser can sit behind any
 * UI, or be loaded at runtime from elsewhere.
 */

/** A labelled range of bytes, like one row of a 010 Editor template. */
export interface Field {
    name: string;
    offset: number;
    length: number;
    /** The value as a person would read it. */
    value?: string;
    /** What the value means, or why it's there. */
    note?: string;
    children?: Field[];
}

/** A file stored inside another one. */
export interface Entry {
    /** The real file name, when it's known. */
    name: string | null;
    /** A name to show and save under when the real one isn't known. */
    label: string;
    offset: number;
    size: number;
    data: Uint8Array;
    /** Extra columns for the contents table, e.g. a MIX entry's ID. */
    meta?: Record<string, string>;
}

/** Indexed-colour pictures; the app supplies the palette unless the file carries one. */
export interface IndexedImage {
    width: number;
    height: number;
    /** One palette index per pixel, row by row. */
    pixels: Uint8Array;
}

export type Preview =
    | { kind: 'images'; frames: IndexedImage[]; /** 768 bytes of 8-bit RGB, when the file brings its own. */ palette?: Uint8Array; transparentIndex?: number }
    | { kind: 'palette'; /** 256 colours as 8-bit RGB. */ colors: Uint8Array }
    | { kind: 'audio'; wav: Uint8Array; sampleRate: number; channels: number; bits: number; seconds: number }
    | { kind: 'text'; text: string };

/** Bytes to show in place of the file's own, e.g. a header after decryption. */
export interface Overlay {
    offset: number;
    bytes: Uint8Array;
    label: string;
}

export interface Parsed {
    /** A short description of what was found, e.g. "Red Alert MIX, encrypted header". */
    title: string;
    /** Headline facts, label then value. */
    summary: [string, string][];
    fields: Field[];
    entries?: Entry[];
    preview?: Preview;
    overlays?: Overlay[];
    warnings: string[];
}

export interface ParseContext {
    /** The file's name, when known. */
    name: string | null;
    /** Extra file names the user supplied, for archives that store hashes instead of names. */
    names: readonly string[];
}

/** The part of a format that loads on demand. */
export interface FormatParser {
    parse(data: Uint8Array, context: ParseContext): Parsed;
}

/** What the registry knows about a format before loading it. */
export interface FormatDescriptor {
    id: string;
    name: string;
    extensions: string[];
    /** A cheap check of the first bytes. Must not throw. */
    sniff(data: Uint8Array): boolean;
    load(): Promise<FormatParser>;
}
