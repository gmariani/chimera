import { P_INIT, S_INIT } from './blowfish-tables';

/**
 * Blowfish in ECB mode, as Westwood used it on MIX headers. Each 8-byte block is
 * two big-endian 32-bit halves (the spec's code byte-swaps x86 dwords to get there).
 */
export class Blowfish {
    private readonly p = new Uint32Array(P_INIT);
    private readonly s = new Uint32Array(S_INIT);

    constructor(key: Uint8Array) {
        let j = 0;
        for (let i = 0; i < 18; i++) {
            let word = 0;
            for (let k = 0; k < 4; k++) {
                word = (word << 8) | key[j];
                j = (j + 1) % key.length;
            }
            this.p[i] ^= word;
        }
        const block = new Uint32Array(2);
        for (let i = 0; i < 18; i += 2) {
            this.encryptBlock(block);
            this.p[i] = block[0];
            this.p[i + 1] = block[1];
        }
        for (let i = 0; i < 1024; i += 2) {
            this.encryptBlock(block);
            this.s[i] = block[0];
            this.s[i + 1] = block[1];
        }
    }

    private f(x: number): number {
        const s = this.s;
        return (((s[x >>> 24] + s[256 + ((x >>> 16) & 0xff)]) ^ s[512 + ((x >>> 8) & 0xff)]) + s[768 + (x & 0xff)]) >>> 0;
    }

    /** Encrypts [left, right] in place. */
    encryptBlock(block: Uint32Array): void {
        let l = block[0];
        let r = block[1];
        for (let i = 0; i < 16; i += 2) {
            l = (l ^ this.p[i]) >>> 0;
            r = (r ^ this.f(l)) >>> 0;
            r = (r ^ this.p[i + 1]) >>> 0;
            l = (l ^ this.f(r)) >>> 0;
        }
        block[0] = (r ^ this.p[17]) >>> 0;
        block[1] = (l ^ this.p[16]) >>> 0;
    }

    /** Decrypts [left, right] in place. */
    decryptBlock(block: Uint32Array): void {
        let l = block[0];
        let r = block[1];
        for (let i = 17; i > 1; i -= 2) {
            l = (l ^ this.p[i]) >>> 0;
            r = (r ^ this.f(l)) >>> 0;
            r = (r ^ this.p[i - 1]) >>> 0;
            l = (l ^ this.f(r)) >>> 0;
        }
        block[0] = (r ^ this.p[0]) >>> 0;
        block[1] = (l ^ this.p[1]) >>> 0;
    }

    encrypt(data: Uint8Array): Uint8Array {
        return this.run(data, (block) => this.encryptBlock(block));
    }

    decrypt(data: Uint8Array): Uint8Array {
        return this.run(data, (block) => this.decryptBlock(block));
    }

    /** Whole 8-byte blocks only; a trailing partial block is left out. */
    private run(data: Uint8Array, step: (block: Uint32Array) => void): Uint8Array {
        const out = new Uint8Array(data.length & ~7);
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const outView = new DataView(out.buffer);
        const block = new Uint32Array(2);
        for (let i = 0; i < out.length; i += 8) {
            block[0] = view.getUint32(i);
            block[1] = view.getUint32(i + 4);
            step(block);
            outView.setUint32(i, block[0]);
            outView.setUint32(i + 4, block[1]);
        }
        return out;
    }
}
