import { bytesLabel, field } from '../../core/bytes';
import type { Field } from '../../core/types';

/**
 * Reads a SWF's values in order, noting each as a field: little-endian
 * integers, NUL-terminated strings (UTF-8 from SWF 6, the system's code page
 * before), and the bit-packed records (RECT, MATRIX, CXFORM), whose values are
 * bits read most significant first, starting on a byte.
 */
export class SwfReader {
    readonly fields: Field[] = [];
    private readonly view: DataView;

    constructor(
        readonly data: Uint8Array,
        public at: number,
        readonly end: number,
        readonly version: number,
    ) {
        this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    }

    get left(): number {
        return this.end - this.at;
    }

    private take(n: number): number {
        if (this.at + n > this.end) throw new Error('The tag ends early.');
        const at = this.at;
        this.at += n;
        return at;
    }

    u8(name: string, note?: string, show?: (v: number) => string): number {
        const at = this.take(1);
        const v = this.data[at];
        this.fields.push(field(name, at, 1, show ? show(v) : v, note));
        return v;
    }

    u16(name: string, note?: string, show?: (v: number) => string): number {
        const at = this.take(2);
        const v = this.view.getUint16(at, true);
        this.fields.push(field(name, at, 2, show ? show(v) : v, note));
        return v;
    }

    s16(name: string, note?: string): number {
        const at = this.take(2);
        const v = this.view.getInt16(at, true);
        this.fields.push(field(name, at, 2, v, note));
        return v;
    }

    u32(name: string, note?: string, show?: (v: number) => string): number {
        const at = this.take(4);
        const v = this.view.getUint32(at, true);
        this.fields.push(field(name, at, 4, show ? show(v) : v, note));
        return v;
    }

    f32(name: string, note?: string): number {
        const at = this.take(4);
        const v = this.view.getFloat32(at, true);
        this.fields.push(field(name, at, 4, +v.toPrecision(6), note));
        return v;
    }

    /** 8.8 fixed point. */
    fixed8(name: string, note?: string): number {
        const at = this.take(2);
        const v = this.view.getInt16(at, true) / 256;
        this.fields.push(field(name, at, 2, v, note));
        return v;
    }

    /** EncodedU32: 7 bits a byte, low first, while the top bit is set (up to 5 bytes). */
    encodedU32(name: string, note?: string): number {
        const start = this.at;
        let v = 0;
        for (let i = 0; i < 5; i++) {
            const b = this.data[this.take(1)];
            v += (b & 0x7f) * 2 ** (7 * i);
            if (!(b & 0x80)) break;
        }
        this.fields.push(field(name, start, this.at - start, v, note));
        return v;
    }

    string(name: string, note?: string): string {
        let stop = this.at;
        while (stop < this.end && this.data[stop] !== 0) stop++;
        const text = new TextDecoder(this.version >= 6 ? 'utf-8' : 'windows-1252').decode(this.data.subarray(this.at, stop));
        this.fields.push(field(name, this.at, Math.min(stop + 1, this.end) - this.at, text, note));
        this.at = Math.min(stop + 1, this.end);
        return text;
    }

    /** A string with its length in front (a byte), as DefineFont2's name. */
    shortString(name: string): string {
        const length = this.data[this.take(1)];
        const at = this.take(Math.min(length, this.left));
        const text = new TextDecoder(this.version >= 6 ? 'utf-8' : 'windows-1252').decode(this.data.subarray(at, at + length)).replace(/\0+$/, '');
        this.fields.push(field(name, at - 1, length + 1, text, 'A length byte, then the characters.'));
        return text;
    }

    bytes(name: string, length = this.left, note?: string, value?: string): Uint8Array {
        const n = Math.max(0, Math.min(length, this.left));
        const at = this.take(n);
        this.fields.push(field(name, at, n, value ?? bytesLabel(n), note));
        return this.data.subarray(at, at + n);
    }

    rgb(name: string): string {
        const at = this.take(3);
        const v = `#${Array.from(this.data.subarray(at, at + 3), (b) => b.toString(16).padStart(2, '0')).join('')}`;
        this.fields.push(field(name, at, 3, v));
        return v;
    }

    rgba(name: string): string {
        const at = this.take(4);
        const v = `#${Array.from(this.data.subarray(at, at + 3), (b) => b.toString(16).padStart(2, '0')).join('')}, alpha ${this.data[at + 3]}`;
        this.fields.push(field(name, at, 4, v));
        return v;
    }

    /** RECT: 5 bits saying how many bits each of Xmin, Xmax, Ymin and Ymax has, in twips (1/20 pixel). */
    rect(name: string): { xMin: number; xMax: number; yMin: number; yMax: number } {
        const start = this.at;
        const bits = new Bits(this.data, this.at);
        const n = bits.ub(5);
        const [xMin, xMax, yMin, yMax] = [bits.sb(n), bits.sb(n), bits.sb(n), bits.sb(n)];
        this.at = bits.byteEnd();
        const px = (t: number) => +(t / 20).toFixed(2);
        this.fields.push(field(name, start, this.at - start, `${px(xMax - xMin)} × ${px(yMax - yMin)} px at (${px(xMin)}, ${px(yMin)})`, `Bit-packed: ${n} bits a value, in twips (1/20 pixel): x ${xMin} to ${xMax}, y ${yMin} to ${yMax}.`));
        return { xMin, xMax, yMin, yMax };
    }

    /** MATRIX: optional scale and rotate/skew (16.16 fixed point), then the translation in twips. */
    matrix(name: string): void {
        const start = this.at;
        const bits = new Bits(this.data, this.at);
        const parts: string[] = [];
        if (bits.ub(1)) {
            const n = bits.ub(5);
            parts.push(`scale ${+bits.fb(n).toFixed(4)}, ${+bits.fb(n).toFixed(4)}`);
        }
        if (bits.ub(1)) {
            const n = bits.ub(5);
            parts.push(`rotate/skew ${+bits.fb(n).toFixed(4)}, ${+bits.fb(n).toFixed(4)}`);
        }
        const n = bits.ub(5);
        parts.unshift(`move ${+(bits.sb(n) / 20).toFixed(2)}, ${+(bits.sb(n) / 20).toFixed(2)} px`);
        this.at = bits.byteEnd();
        this.fields.push(field(name, start, this.at - start, parts.join('; '), 'Bit-packed: has-scale, has-rotate, then the translation in twips.'));
    }

    /** CXFORM: multiply terms (8.8, as 256ths) and add terms, each optional, with alpha for CXFORMWITHALPHA. */
    cxform(name: string, alpha: boolean): void {
        const start = this.at;
        const bits = new Bits(this.data, this.at);
        const hasAdd = bits.ub(1);
        const hasMult = bits.ub(1);
        const n = bits.ub(4);
        const count = alpha ? 4 : 3;
        const parts: string[] = [];
        if (hasMult) parts.push(`multiply ${Array.from({ length: count }, () => +(bits.sb(n) / 256).toFixed(3)).join(', ')}`);
        if (hasAdd) parts.push(`add ${Array.from({ length: count }, () => bits.sb(n)).join(', ')}`);
        this.at = bits.byteEnd();
        this.fields.push(field(name, start, this.at - start, parts.join('; ') || 'None', `Bit-packed color transform, ${alpha ? 'RGBA' : 'RGB'}.`));
    }

    /** Groups the fields read since `from` under one field. */
    group(name: string, from: number, start: number, value?: string): void {
        const children = this.fields.splice(from);
        this.fields.push({ name, offset: start, length: this.at - start, value, children });
    }
}

/** Bits, most significant first. */
export class Bits {
    private bit = 0;

    constructor(
        private readonly data: Uint8Array,
        private readonly start: number,
    ) {}

    ub(n: number): number {
        let v = 0;
        for (let i = 0; i < n; i++, this.bit++) v = v * 2 + ((this.data[this.start + (this.bit >> 3)] >> (7 - (this.bit & 7))) & 1);
        return v;
    }

    sb(n: number): number {
        const v = this.ub(n);
        return n && v >= 2 ** (n - 1) ? v - 2 ** n : v;
    }

    /** 16.16 fixed point. */
    fb(n: number): number {
        return this.sb(n) / 65536;
    }

    byteEnd(): number {
        return this.start + Math.ceil(this.bit / 8);
    }
}
