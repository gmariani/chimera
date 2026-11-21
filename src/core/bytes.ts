import type { Field } from './types';

/** Little-endian reads over a byte array that never throw past the end: they return 0. */
export class Bytes {
    readonly view: DataView;

    constructor(readonly data: Uint8Array) {
        this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    }

    get length(): number {
        return this.data.length;
    }

    u8(offset: number): number {
        return offset < this.data.length ? this.data[offset] : 0;
    }

    u16(offset: number): number {
        return offset + 2 <= this.data.length ? this.view.getUint16(offset, true) : 0;
    }

    u32(offset: number): number {
        return offset + 4 <= this.data.length ? this.view.getUint32(offset, true) : 0;
    }

    /** Big-endian, for the formats that use it (IFF chunk sizes). */
    u16be(offset: number): number {
        return offset + 2 <= this.data.length ? this.view.getUint16(offset, false) : 0;
    }

    u32be(offset: number): number {
        return offset + 4 <= this.data.length ? this.view.getUint32(offset, false) : 0;
    }

    i16(offset: number): number {
        return offset + 2 <= this.data.length ? this.view.getInt16(offset, true) : 0;
    }

    i32(offset: number): number {
        return offset + 4 <= this.data.length ? this.view.getInt32(offset, true) : 0;
    }

    f32(offset: number): number {
        return offset + 4 <= this.data.length ? this.view.getFloat32(offset, true) : 0;
    }

    ascii(offset: number, length: number): string {
        let text = '';
        for (let i = offset; i < Math.min(offset + length, this.data.length); i++) text += String.fromCharCode(this.data[i]);
        return text;
    }

    /** A NUL-terminated string starting at offset, and the offset just past its NUL. */
    asciiz(offset: number): { text: string; next: number } {
        let end = offset;
        while (end < this.data.length && this.data[end] !== 0) end++;
        return { text: this.ascii(offset, end - offset), next: end + 1 };
    }
}

export function hex(value: number, digits = 8): string {
    return (value >>> 0).toString(16).toUpperCase().padStart(digits, '0');
}

export function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB'];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${value.toFixed(value < 10 ? 2 : 1)} ${units[unit]}`;
}

/** "1,234 bytes", for exact sizes. */
export function bytesLabel(bytes: number): string {
    return `${bytes.toLocaleString('en-US')} byte${bytes === 1 ? '' : 's'}`;
}

/** Shorthand for a field. */
export function field(name: string, offset: number, length: number, value?: string | number, note?: string): Field {
    return { name, offset, length, value: value === undefined ? undefined : String(value), note };
}

/**
 * The fields inside `from` to `to`, in order, with what lies between them made fields too: zeros as "Zeros", anything
 * else named `between`. A field running past `to` is cut there. Empty when nothing's inside but one stretch of `between`.
 */
export function fillGaps(data: Uint8Array, inside: Field[], from: number, to: number, between: string): Field[] {
    inside.sort((x, y) => x.offset - y.offset || y.length - x.length);
    const out: Field[] = [];
    let covered = from;
    const gap = (end: number) => {
        if (end <= covered) return;
        const zeros = data.subarray(covered, end).every((v) => v === 0);
        out.push(field(zeros ? 'Zeros' : between, covered, end - covered, bytesLabel(end - covered)));
    };
    for (const f of inside) {
        const clipped = f.offset + f.length > to ? { ...f, length: to - f.offset } : f;
        gap(clipped.offset);
        out.push(clipped);
        covered = Math.max(covered, clipped.offset + clipped.length);
    }
    gap(to);
    return out.length === 1 && out[0].name === between ? [] : out;
}

/** An MS-DOS date and time, as ZIP and cabinets store a file's (local time, 2-second steps): "1997-04-23 14:02:10". */
export function dosDateTime(date: number, time: number): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${1980 + (date >> 9)}-${pad((date >> 5) & 15)}-${pad(date & 31)} ${pad(time >> 11)}:${pad((time >> 5) & 63)}:${pad((time & 31) * 2)}`;
}
