/** SHA-1 (FIPS 180-4), synchronous, unlike the browser's crypto.subtle, so a parser can use it. */
export function sha1(data: Uint8Array): Uint8Array {
    let h0 = 0x67452301;
    let h1 = 0xefcdab89;
    let h2 = 0x98badcfe;
    let h3 = 0x10325476;
    let h4 = 0xc3d2e1f0;
    const w = new Int32Array(80);

    // The last block or two: the message's end, a 1 bit, zeros, and the length in bits as 64 bits.
    const length = data.length;
    const whole = Math.floor(length / 64) * 64;
    const tail = new Uint8Array(length - whole < 56 ? 64 : 128);
    tail.set(data.subarray(whole));
    tail[length - whole] = 0x80;
    const bits = length * 8;
    const tailView = new DataView(tail.buffer);
    tailView.setUint32(tail.length - 8, Math.floor(bits / 0x100000000));
    tailView.setUint32(tail.length - 4, bits >>> 0);

    const run = (bytes: Uint8Array, start: number) => {
        for (let i = 0; i < 16; i++) {
            const at = start + i * 4;
            w[i] = (bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3];
        }
        for (let i = 16; i < 80; i++) {
            const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
            w[i] = (x << 1) | (x >>> 31);
        }
        let a = h0;
        let b = h1;
        let c = h2;
        let d = h3;
        let e = h4;
        let t: number;
        for (let i = 0; i < 20; i++) {
            t = (((a << 5) | (a >>> 27)) + ((b & c) | (~b & d)) + e + 0x5a827999 + w[i]) | 0;
            e = d;
            d = c;
            c = (b << 30) | (b >>> 2);
            b = a;
            a = t;
        }
        for (let i = 20; i < 40; i++) {
            t = (((a << 5) | (a >>> 27)) + (b ^ c ^ d) + e + 0x6ed9eba1 + w[i]) | 0;
            e = d;
            d = c;
            c = (b << 30) | (b >>> 2);
            b = a;
            a = t;
        }
        for (let i = 40; i < 60; i++) {
            t = (((a << 5) | (a >>> 27)) + ((b & c) | (b & d) | (c & d)) + e + 0x8f1bbcdc + w[i]) | 0;
            e = d;
            d = c;
            c = (b << 30) | (b >>> 2);
            b = a;
            a = t;
        }
        for (let i = 60; i < 80; i++) {
            t = (((a << 5) | (a >>> 27)) + (b ^ c ^ d) + e + 0xca62c1d6 + w[i]) | 0;
            e = d;
            d = c;
            c = (b << 30) | (b >>> 2);
            b = a;
            a = t;
        }
        h0 = (h0 + a) | 0;
        h1 = (h1 + b) | 0;
        h2 = (h2 + c) | 0;
        h3 = (h3 + d) | 0;
        h4 = (h4 + e) | 0;
    };
    for (let at = 0; at < whole; at += 64) run(data, at);
    for (let at = 0; at < tail.length; at += 64) run(tail, at);

    const out = new Uint8Array(20);
    const view = new DataView(out.buffer);
    [h0, h1, h2, h3, h4].forEach((v, i) => view.setUint32(i * 4, v >>> 0));
    return out;
}
