/**
 * Westwood's key calculation: turns a MIX file's 80-byte key_source into the
 * 56-byte Blowfish key for its header.
 *
 * The spec gives this as ~400 lines of hand-rolled big-integer code. It is plain
 * RSA with Westwood's public key (e = 65537): the key_source is two 40-byte
 * little-endian numbers, each raised to e mod n, giving 39 bytes apiece. The
 * first 56 of those 78 bytes are the key.
 */

/** Westwood's public modulus, as the spec gives it: base64 of a DER INTEGER. */
const PUBLIC_KEY = 'AihRvNoIbTn85FZRYNZRcT+i6KpU+maCsEqr3Q5q+LDB5tH7Tz2qQ38V';
const EXPONENT = 0x10001n;

export const KEY_SOURCE_SIZE = 80;
export const KEY_SIZE = 56;

const { modulus, blockSize } = (() => {
    const der = Uint8Array.from(atob(PUBLIC_KEY), (c) => c.charCodeAt(0));
    // 0x02 (INTEGER), length, then the number big-endian.
    const digits = der.subarray(2, 2 + der[1]);
    const n = BigInt(`0x${Array.from(digits, (b) => b.toString(16).padStart(2, '0')).join('')}`);
    // The spec's pubkey.len is bitlen - 1; each block carries (len - 1) / 8 bytes out.
    const bits = n.toString(2).length;
    return { modulus: n, blockSize: Math.floor((bits - 2) / 8) };
})();

function modPow(base: bigint, exponent: bigint, mod: bigint): bigint {
    let result = 1n;
    base %= mod;
    while (exponent > 0n) {
        if (exponent & 1n) result = (result * base) % mod;
        base = (base * base) % mod;
        exponent >>= 1n;
    }
    return result;
}

function fromLittleEndian(bytes: Uint8Array): bigint {
    let n = 0n;
    for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]);
    return n;
}

export function blowfishKey(keySource: Uint8Array): Uint8Array {
    const out = new Uint8Array(Math.floor(KEY_SOURCE_SIZE / (blockSize + 1)) * blockSize);
    let written = 0;
    for (let read = 0; read + blockSize + 1 <= KEY_SOURCE_SIZE; read += blockSize + 1) {
        let n = modPow(fromLittleEndian(keySource.subarray(read, read + blockSize + 1)), EXPONENT, modulus);
        for (let i = 0; i < blockSize; i++, n >>= 8n) out[written++] = Number(n & 0xffn);
    }
    return out.slice(0, KEY_SIZE);
}
