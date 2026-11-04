/**
 * The contract between the app and a file format. A format turns bytes into
 * plain data: a tree of labelled byte ranges (what each part of the file is),
 * the files stored inside it (if it's an archive), and a preview of what it
 * holds. Formats never render anything, so the same parser can sit behind any
 * UI, or be loaded at runtime from elsewhere. (Video is the one exception to
 * plain data: its preview decodes frames when asked.)
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

/** Decoded sound, as a WAV file. */
export interface AudioClip {
    wav: Uint8Array;
    sampleRate: number;
    channels: number;
    bits: number;
    seconds: number;
}

/** One frame of video: palette indexes, and the 768-byte 8-bit RGB palette in force for it. */
export interface VideoFrame {
    pixels: Uint8Array;
    palette: Uint8Array;
}

export type Preview =
    | {
          kind: 'images';
          frames: IndexedImage[];
          /** 768 bytes of 8-bit RGB, when the file brings its own. */
          palette?: Uint8Array;
          transparentIndex?: number;
          /** An index the game draws as darkening rather than as its palette colour. */
          shadowIndex?: number;
          /** Lay the frames out this many to a row with no gaps, when together they make one picture (a tile set's template). */
          columns?: number;
          /** What some of the colours stand for, e.g. the terrain kinds on a map. */
          legend?: { label: string; index: number }[];
      }
    | { kind: 'palette'; /** 256 colours as 8-bit RGB. */ colors: Uint8Array }
    | ({ kind: 'audio' } & AudioClip)
    | {
          kind: 'video';
          width: number;
          height: number;
          frameCount: number;
          fps: number;
          /** Decodes a frame on demand (movies are too big to decode up front). Fastest in order. */
          frame(index: number): VideoFrame;
          audio?: AudioClip;
      }
    | { kind: 'text'; text: string }
    /** Several previews of the same file, e.g. a mission's map and its text. */
    | { kind: 'stack'; items: { title: string; preview: Preview }[] };

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
    /** Other files that would let this one show more, and what they'd add, e.g. "Open TEMPERAT.MIX as well to draw the real tiles." */
    wanted?: string;
    warnings: string[];
}

export interface ParseContext {
    /** The file's name, when known. */
    name: string | null;
    /** Extra file names the user supplied, for archives that store hashes instead of names. */
    names: readonly string[];
    /**
     * Files the user has opened (and those inside them) under this name, the
     * nearest to this file first. For formats that need a companion file: a
     * map's tiles, or the mission INI next to a map.
     */
    find?(name: string): Companion[];
}

export interface Companion {
    data: Uint8Array;
    /** The archive it's in, as a path (e.g. "MAIN.MIX › temperat.mix"), or its own name if opened alone. */
    source: string;
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
    /** False when the extension is shared by other files too (.dat, .bin), so it only counts alongside a sniff. */
    byNameAlone?: boolean;
    /** The parser uses `find`, so its result can change when the user opens more files. */
    companions?: boolean;
    load(): Promise<FormatParser>;
}
