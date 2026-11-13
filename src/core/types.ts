/**
 * The contract between the app and a file format. A format turns bytes into
 * plain data: a tree of labeled byte ranges (what each part of the file is),
 * the files stored inside it (if it's an archive), and a preview of what it
 * holds. Formats never render anything, so the same parser can sit behind any
 * UI, or be loaded at runtime from elsewhere. (Video is the one exception to
 * plain data: its preview decodes frames when asked.)
 */

/** A labeled range of bytes, like one row of a 010 Editor template. */
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

/** Indexed-color pictures; the app supplies the palette unless the file carries one. */
export interface IndexedImage {
    width: number;
    height: number;
    /** One palette index per pixel, row by row. */
    pixels: Uint8Array;
}

/** Decoded sound, as a WAV file (or, with `mime`, another file the browser plays: MP3, Ogg). */
export interface AudioClip {
    wav: Uint8Array;
    mime?: string;
    sampleRate: number;
    channels: number;
    /** Bits per sample; 0 for codecs that have no such thing (Vorbis, Opus). */
    bits: number;
    seconds: number;
}

/**
 * One frame of video: palette indexes and the 768-byte 8-bit RGB palette in force for it, or (high-color movies) RGBA,
 * at the movie's size unless `width` and `height` say it's a smaller picture (a large movie, while it plays). `pixels`
 * and `rgba` must be new arrays of their own each time: they're handed over to the page, not copied, and so are gone
 * from the worker after.
 */
export type VideoFrame = { pixels: Uint8Array; palette: Uint8Array } | { rgba: Uint8Array; width?: number; height?: number };

/** One part of a voxel model (a limb: a body, a turret), placed in the model's space. */
export interface VoxelPart {
    /** Which file and limb it's from, e.g. "htnktur.vxl › DUMMY01". */
    name: string;
    size: [number, number, number];
    /** Palette index per voxel, x fastest, then y, then z; 0 is empty. */
    colors: Uint8Array;
    /** Which way each voxel faces, for lighting: x, y, z per voxel (all 0 where there's no normal). */
    normals?: Float32Array;
    /** Where the box's corners go: voxel (0, 0, 0) at min, voxel (size) at max. */
    min: [number, number, number];
    max: [number, number, number];
    /** For each animation frame, a 3 × 4 transform, row by row (none: it stays put). */
    frames: Float32Array[];
    /** Moves the part after its animation, in voxels: a turret's place on the hull (art.ini's TurretOffset). */
    offset?: [number, number, number];
}

export interface TableColumn {
    key: string;
    label: string;
    /** Sorts as numbers. */
    numeric?: boolean;
}

export interface TableRow {
    group: string;
    cells: Record<string, string>;
    /** For a column, the files its cell can open: the first one found among the files in use. */
    files?: Record<string, string[]>;
}

export type Preview =
    | {
          kind: 'images';
          frames: IndexedImage[];
          /** 768 bytes of 8-bit RGB, when the file brings its own. */
          palette?: Uint8Array;
          transparentIndex?: number;
          /** An index the game draws as darkening rather than as its palette color. */
          shadowIndex?: number;
          /** Lay the frames out this many to a row with no gaps, when together they make one picture (a tile set's template). */
          columns?: number;
          /** What some of the colors stand for, e.g. the terrain kinds on a map. */
          legend?: { label: string; index: number }[];
          /** The palette entries the game recolors for the owner's team, first and last. */
          remap?: [number, number];
          /** A switch for something drawn over the pictures, on in `frames` (a multiplayer map's start positions): the pictures without it are made when it's turned off. */
          toggle?: { label: string; off(): IndexedImage[] };
      }
    | { kind: 'palette'; /** 256 colors as 8-bit RGB. */ colors: Uint8Array }
    /** A true-color picture. */
    | {
          kind: 'picture';
          width: number;
          height: number;
          /** 8-bit RGBA, row by row. */
          rgba: Uint8Array;
          /** A switch for a way of drawing it, on in `rgba` (a map's lighting): the picture without it is drawn when it's turned off. */
          toggle?: { label: string; off(): Uint8Array };
      }
    | ({ kind: 'audio' } & AudioClip)
    | {
          kind: 'video';
          width: number;
          height: number;
          frameCount: number;
          fps: number;
          /**
           * Decodes a frame on demand (movies are too big to decode up front). Fastest in order. `playing` asks for
           * what keeps up while the movie plays: a large movie may answer with a smaller picture.
           */
          frame(index: number, playing?: boolean): VideoFrame;
          audio?: AudioClip;
          /** The movie's other sound tracks, to pick from instead of `audio`. */
          otherAudio?: { title: string; clip: AudioClip }[];
          /** What `audio` is called when there are others to pick from. */
          audioTitle?: string;
          /** The frames have an alpha plane: shown over a checkerboard. */
          transparent?: boolean;
      }
    | {
          kind: 'text';
          text: string;
          /** Show this many lines, the rest scrolling inside: for a long outline with more previews below it. */
          maxLines?: number;
      }
    /** Rows of values in groups, to filter and sort; a cell can name files to open. */
    | { kind: 'table'; columns: TableColumn[]; groups: string[]; rows: TableRow[] }
    /** A voxel model, to turn around in 3D. */
    | {
          kind: 'voxels';
          parts: VoxelPart[];
          frameCount: number;
          /** 8-bit RGB, when the file brings a usable one. */ palette?: Uint8Array;
          /** The owner's color range, first and last. */ remap?: [number, number];
      }
    /** Music as its notes on a timeline, played along with its sound. */
    | {
          kind: 'music';
          /** Each note: when it starts and ends (seconds), its channel (0 to 15) and pitch (a MIDI note number). */
          notes: MusicNote[];
          /** In seconds. */
          length: number;
          /** The music rendered, when it plays here; it may be shorter than the notes. */
          audio?: AudioClip;
          /** Said beneath it: how it's played, and what doesn't play. */
          note: string;
      }
    /** Several previews of the same file, e.g. a mission's map and its text. */
    | { kind: 'stack'; items: { title: string; preview: Preview }[] };

export interface MusicNote {
    start: number;
    end: number;
    channel: number;
    note: number;
}

/** Bytes to show in place of the file's own, e.g. a header after decryption. */
export interface Overlay {
    offset: number;
    bytes: Uint8Array;
    label: string;
}

/** Another file this one drew on (or looked for): a map's tile set, a model's animation. */
export interface Link {
    name: string;
    /** What it's for, e.g. "Tile set" or "Palette". */
    role: string;
    /** Where it was found (an archive path); absent when it wasn't. */
    source?: string;
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
    /** The other files it used, and those it looked for but didn't find. */
    links?: Link[];
    /**
     * Where the format's own data stops, when the parser marks bytes past it
     * in its fields (data after a GIF's trailer). Those bytes then get the
     * same checks as any found after the last field.
     */
    end?: number;
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
    /** Other extensions its files go by, which don't by themselves suggest it (TD's sprites named for a theater: .tem, .sno). Only used to tell a misnamed file from one named the way the games name them. */
    alsoNamed?: string[];
    /** The parser uses `find`, so its result can change when the user opens more files. */
    companions?: boolean;
    load(): Promise<FormatParser>;
}
