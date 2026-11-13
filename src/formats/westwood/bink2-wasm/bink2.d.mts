/** The WebAssembly build of the Bink 2 video decoder (wasm/bink2/build.sh). Pointers are offsets into HEAPU8. */
export interface Bink2Wasm {
    HEAPU8: Uint8Array;
    _malloc(size: number): number;
    _free(pointer: number): void;
    _video_open(tag: number, flags: number, width: number, height: number): number;
    /**
     * 1 for a frame, 0 for none, negative on error. `key` is 1 for a keyframe. The picture is written to rgba unless
     * it's 0, 2^shift times smaller each way; the decoded planes (Y, U, V, packed) to yuv unless it's 0.
     */
    _video_decode(decoder: number, data: number, size: number, key: number, rgba: number, shift: number, yuv: number): number;
    _decoder_flush(decoder: number): void;
    /** Keeps the decoder's reference frame, to carry on from later (0 if there's none yet). */
    _video_save(decoder: number): number;
    /** Makes a kept frame the reference again; negative on error. */
    _video_restore(decoder: number, saved: number): number;
    _video_forget(saved: number): void;
    _decoder_close(decoder: number): void;
}

export default function createBink2(): Promise<Bink2Wasm>;
