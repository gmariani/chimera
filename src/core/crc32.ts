/** The CRC-32 used by ZIP (and by Tiberian Sun for MIX file IDs). */
const TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[i] = c >>> 0;
    }
    return table;
})();

export function crc32(data: Uint8Array, crc = 0): number {
    crc = ~crc;
    for (let i = 0; i < data.length; i++) crc = (crc >>> 8) ^ TABLE[(data[i] ^ crc) & 0xff];
    return ~crc >>> 0;
}
