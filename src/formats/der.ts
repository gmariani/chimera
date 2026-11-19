/**
 * DER, the strict form of ASN.1's Basic Encoding Rules that certificates and signatures are written in: each value is
 * a tag (its class, whether it holds other values, and its number), its length, and its contents. A length under 128
 * is one byte; above, the first byte's low bits say how many bytes of length follow. DER always gives the length (BER
 * may say "indefinite" and end with two zeros), and nothing here reads that.
 * See ITU-T X.690 (https://www.itu.int/rec/T-REC-X.690), section 8 and 10.
 */

export interface Tlv {
    /** The tag's first byte, e.g. 0x30 for a SEQUENCE, 0xA0 for [0]. */
    tag: number;
    /** Where it starts, and where its contents start and end. */
    at: number;
    contentAt: number;
    end: number;
    /** What it holds, when it's constructed. */
    children?: Tlv[];
}

export const SEQUENCE = 0x30;
export const SET = 0x31;
export const INTEGER = 0x02;
export const BIT_STRING = 0x03;
export const OCTET_STRING = 0x04;
export const OID = 0x06;

/** The universal types' names, by tag number. */
const UNIVERSAL: Record<number, string> = {
    1: 'BOOLEAN',
    2: 'INTEGER',
    3: 'BIT STRING',
    4: 'OCTET STRING',
    5: 'NULL',
    6: 'OBJECT IDENTIFIER',
    10: 'ENUMERATED',
    12: 'UTF8String',
    16: 'SEQUENCE',
    17: 'SET',
    19: 'PrintableString',
    20: 'T61String',
    22: 'IA5String',
    23: 'UTCTime',
    24: 'GeneralizedTime',
    26: 'VisibleString',
    30: 'BMPString',
};

/** A tag in words: "SEQUENCE", "[0]". */
export function tagName(tag: number): string {
    const cls = tag >> 6;
    const n = tag & 0x1f;
    if (cls === 0) return UNIVERSAL[n] ?? `type ${n}`;
    if (cls === 2) return `[${n}]`;
    return `${cls === 1 ? 'application' : 'private'} ${n}`;
}

/**
 * Reads the value at `at`, and what it holds, within `end`. Throws when it isn't DER: a length that runs past what
 * holds it, an indefinite length, a tag number too big for one byte (none of what's read here has one), or nesting
 * deeper than any certificate's. `budget` counts the values read, so a file of tiny values can't make it read forever.
 */
export function readTlv(data: Uint8Array, at: number, end: number, depth = 0, budget = { left: Math.max(16, data.length) }): Tlv {
    if (at + 2 > end) throw new Error(`a value at ${at.toLocaleString('en-US')} runs past what holds it`);
    if (--budget.left < 0) throw new Error('it holds more values than it has bytes for');
    if (depth > 40) throw new Error('its values nest deeper than any certificate’s');
    const tag = data[at];
    if ((tag & 0x1f) === 0x1f) throw new Error(`the value at ${at.toLocaleString('en-US')} has a tag number in more than one byte`);
    let length = data[at + 1];
    let contentAt = at + 2;
    if (length === 0x80) throw new Error(`the value at ${at.toLocaleString('en-US')} has an indefinite length, which DER doesn’t allow`);
    if (length > 0x80) {
        const n = length & 0x7f;
        if (n > 4 || contentAt + n > end) throw new Error(`the value at ${at.toLocaleString('en-US')} has a length of ${n} bytes`);
        length = 0;
        for (let i = 0; i < n; i++) length = length * 256 + data[contentAt + i];
        contentAt += n;
    }
    const valueEnd = contentAt + length;
    if (valueEnd > end) throw new Error(`the value at ${at.toLocaleString('en-US')} says it’s ${length.toLocaleString('en-US')} bytes, past what holds it`);
    const tlv: Tlv = { tag, at, contentAt, end: valueEnd };
    if (tag & 0x20) {
        tlv.children = [];
        for (let p = contentAt; p < valueEnd;) {
            const child = readTlv(data, p, valueEnd, depth + 1, budget);
            tlv.children.push(child);
            p = child.end;
        }
    }
    return tlv;
}

/** An OBJECT IDENTIFIER's contents, as dotted numbers. */
export function oidText(data: Uint8Array, t: Tlv): string {
    const parts: number[] = [];
    let v = 0;
    for (let p = t.contentAt; p < t.end; p++) {
        v = v * 128 + (data[p] & 0x7f);
        if (!(data[p] & 0x80)) {
            if (!parts.length) parts.push(v < 80 ? Math.floor(v / 40) : 2, v < 80 ? v % 40 : v - 80);
            else parts.push(v);
            v = 0;
        }
    }
    return parts.join('.');
}

/** A string's contents as text: BMPString in UTF-16 (most significant byte first), UTF8String in UTF-8, the rest as Latin-1. */
export function stringText(data: Uint8Array, t: Tlv): string {
    const bytes = data.subarray(t.contentAt, t.end);
    if ((t.tag & 0x1f) === 30) {
        let s = '';
        for (let i = 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
        return s;
    }
    return new TextDecoder((t.tag & 0x1f) === 12 ? 'utf-8' : 'latin1').decode(bytes);
}

/** A UTCTime or GeneralizedTime, as "2023-07-14 00:00:00 UTC"; UTCTime's two-digit years are 1950 to 2049. */
export function timeText(data: Uint8Array, t: Tlv): string {
    const s = stringText(data, t);
    const m = (t.tag & 0x1f) === 23 ? s.match(/^(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)?Z$/) : s.match(/^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)?(?:\.\d+)?Z$/);
    if (!m) return s;
    const year = (t.tag & 0x1f) === 23 ? (Number(m[1]) < 50 ? 2000 : 1900) + Number(m[1]) : Number(m[1]);
    return `${year}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6] ?? '00'} UTC`;
}

/** Bytes as hex, separated by spaces when `spaced`. */
export function hexText(data: Uint8Array, from: number, to: number, spaced = false): string {
    return Array.from(data.subarray(from, to), (v) => v.toString(16).padStart(2, '0').toUpperCase()).join(spaced ? ' ' : '');
}
