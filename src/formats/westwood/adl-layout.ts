/**
 * The tables at the start of a Westwood AdLib music file (.adl), which has no
 * signature: which program each track starts, then where each program and
 * each instrument is. Their sizes depend on the version, which the file
 * doesn't give either; it's told apart from the offsets, as AdPlug does
 * (src/adl.cpp, CadlPlayer::load):
 *
 * - version 1 (Eye of the Beholder): 120 track bytes, 150 programs, 150 instruments; data from byte 720.
 * - versions 2 and 3 (Eye of the Beholder II, Kyrandia, Dune II): 120 track bytes, 250 and 250; data from 1120.
 * - version 4 (Kyrandia 2 and 3, Lands of Lore): 250 track words, 500 and 500; data from 2500.
 *
 * The offsets count from the end of the track table. Kept apart from the
 * reader so the sniffers don't load it.
 */

export interface AdlLayout {
    /** 1, 2 (for 2 or 3: the same tables) or 4. */
    version: 1 | 2 | 4;
    /** Where the offsets count from: the end of the track table. */
    base: number;
    /** Bytes a track entry takes. */
    trackBytes: 1 | 2;
    /** For each track, the program it starts, or null for none. */
    tracks: (number | null)[];
    /** For each program and each instrument, where it is in the file, or null for none. */
    programs: (number | null)[];
    instruments: (number | null)[];
    /** Where the data starts, after the tables. */
    dataStart: number;
}

/** Both 0xFFFF and 0 mean "none" in the offset tables: 0 would be the table itself, and Westwood's files use both. */
const none = (v: number) => v === 0xffff || v === 0;

/** The tables, or what doesn't fit. */
export function adlLayout(data: Uint8Array): AdlLayout | string {
    const word = (i: number) => data[i] | (data[i + 1] << 8);
    if (data.length < 720) return `It's ${data.length.toLocaleString('en-US')} bytes; the smallest version's tables alone take 720.`;
    // Version 4's track table is 250 words, each a program below 500 (or none); in the others those bytes are offsets of 600 and up.
    let v4 = data.length >= 2500;
    for (let i = 0; v4 && i < 500; i += 2) if (word(i) >= 500 && word(i) !== 0xffff) v4 = false;
    let version: AdlLayout['version'];
    if (v4) version = 4;
    else {
        // Version 1's offsets start from 600, the others' from 1000.
        version = 2;
        for (let i = 0; i < 150; i++) {
            const v = word(120 + i * 2);
            if (!none(v) && v < 1000) version = 1;
        }
        if (version === 2 && data.length < 1120) return `It's ${data.length.toLocaleString('en-US')} bytes; its version's tables alone take 1,120.`;
    }
    const base = version === 4 ? 500 : 120;
    const count = version === 1 ? 150 : version === 2 ? 250 : 500;
    const trackBytes = version === 4 ? 2 : 1;
    const tracks = Array.from({ length: base / trackBytes }, (_, i) => {
        const v = trackBytes === 2 ? word(i * 2) : data[i];
        return v === (trackBytes === 2 ? 0xffff : 0xff) ? null : v;
    });
    const offsets = (from: number) =>
        Array.from({ length: count }, (_, i) => {
            const v = word(from + i * 2);
            return none(v) ? null : base + v;
        });
    return { version, base, trackBytes, tracks, programs: offsets(base), instruments: offsets(base + count * 2), dataStart: base + count * 4 };
}

/** How much of the data the player can reach: its offsets are 16 bits, and it reads through one 16-bit register (ALFX.DRV's si). */
export const ADL_REACH = 0x10000;

/**
 * By content: no longer than the player can reach, the tables, at least one track and program, every track a program
 * number there can be, every offset inside the data, each program starting with a voice (0 to 9) and each instrument whole.
 * (Not that each track's program is there: some of Westwood's own files have tracks for programs they lack.)
 */
export function sniffAdl(data: Uint8Array): boolean {
    if (data.length > 2500 + ADL_REACH) return false;
    const layout = adlLayout(data);
    if (typeof layout === 'string') return false;
    const inData = (at: number | null, size: number) => at === null || (at >= layout.dataStart && at + size <= data.length);
    return (
        layout.tracks.some((t) => t !== null) &&
        layout.programs.some((p) => p !== null) &&
        layout.tracks.every((t) => t === null || t < layout.programs.length) &&
        layout.programs.every((at) => inData(at, 2) && (at === null || data[at] <= 9)) &&
        layout.instruments.every((at) => inData(at, 11))
    );
}
