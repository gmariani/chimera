/** The WebAssembly build of FFmpeg's Bink decoders (wasm/bink/build.sh). Pointers are offsets into HEAPU8. */
export interface BinkWasm {
    HEAPU8: Uint8Array;
    HEAP16: Int16Array;
    _malloc(size: number): number;
    _free(pointer: number): void;
    _video_open(tag: number, flags: number, width: number, height: number): number;
    _audio_open(dct: number, tag: number, sampleRate: number, channels: number): number;
    /** 1 for a frame (written to rgba when it isn't 0), 0 for none, negative on error. */
    _video_decode(decoder: number, data: number, size: number, rgba: number): number;
    /** How many 16-bit samples were written, or negative on error. */
    _audio_decode(decoder: number, data: number, size: number, out: number, max: number): number;
    _decoder_flush(decoder: number): void;
    /** Keeps the decoder's reference frame, to carry on from later (0 if there's none yet). */
    _video_save(decoder: number): number;
    /** Makes a kept frame the reference again; negative on error. */
    _video_restore(decoder: number, saved: number): number;
    _video_forget(saved: number): void;
    _decoder_close(decoder: number): void;
}

export default function createBink(): Promise<BinkWasm>;
