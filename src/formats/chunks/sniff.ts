/** Deeper than any real file nests, so a bad count can't run the stack out. */
const MAX_DEPTH = 64;

/** The wrapper: "CH", and a compressed size that fills the file with a zlib stream. */
export function sniffCompressedChunks(data: Uint8Array): boolean {
    if (data.length < 38 || data[0] !== 0x43 || data[1] !== 0x48) return false;
    const size = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(16, true);
    return size === data.length - 36 && (data[36] & 0x0f) === 8 && ((data[36] << 8) | data[37]) % 31 === 0;
}

/** Unpacked chunks: no signature, so they must use up the file exactly and nest at least once. */
export function sniffChunks(data: Uint8Array): boolean {
    if (data.length < 16) return false;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let containers = 0;
    const walk = (start: number, count: number | null, depth: number): number => {
        let at = start;
        for (let i = 0; count === null ? at < data.length : i < count; i++) {
            if (at + 8 > data.length || depth > MAX_DEPTH) return -1;
            const size = view.getUint32(at + 4, true);
            at += 8;
            if (size >= 0x80000000) {
                containers++;
                at = walk(at, size - 0x80000000, depth + 1);
                if (at < 0) return -1;
            } else {
                at += size;
                if (at > data.length) return -1;
            }
        }
        return at;
    };
    return walk(0, null, 0) === data.length && containers > 0;
}

export function sniffChunkFile(data: Uint8Array): boolean {
    return sniffCompressedChunks(data) || sniffChunks(data);
}
