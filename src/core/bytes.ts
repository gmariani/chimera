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
