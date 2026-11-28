import { Bytes } from '../../core/bytes';

/**
 * Word documents' text, from a compound file's "WordDocument" stream. The stream starts with the File Information
 * Block (FIB): a signature (0xA5DC for Word 6.0 and 95, 0xA5EC for Word 97 and later), the version of the format
 * (101 to 105 for Word 6.0 and 95, 193 and up after), flags (a template; fast-saved; password protected; which of the
 * two table streams Word 97 used), then where the text is and how many characters each part has: the main text first,
 * then footnotes, headers, macros' text, comments, endnotes and text boxes.
 *
 * Word 6.0 and 95 keep the text in one stretch of the stream, from fcMin, unless the file was fast-saved; then, and
 * always from Word 97 on, the text is in pieces, listed in a piece table (the CLX, in the table stream for Word 97):
 * the character positions each piece covers, and where it is, in Windows' code page 1252 (a bit set and the place
 * doubled) or UTF-16. Word marks paragraphs with a carriage return, table cells with 7, page breaks with 12, and
 * fields with 19, 20 and 21 around their code and their result. Word 97 keeps a character picked from a symbol font
 * (Wingdings' arrows) as "(" in the text, the real one in its formatting, which isn't read here: it shows as "(".
 * List bullets and numbers are formatting too, not text, and aren't shown.
 *
 * See [MS-DOC], "Word (.doc) Binary File Format" (https://learn.microsoft.com/openspecs/office_file_formats/ms-doc),
 * for Word 97 on. Word 6.0's and 95's FIB, which [MS-DOC] doesn't cover, is as LibreOffice's Word importer reads it
 * (sw/source/filter/ww8/ww8scan.cxx, WW8Fib; facts only).
 */

export interface WordText {
    /** "Word 6.0", "Word 95", "Word 97 or later". */
    version: string;
    template: boolean;
    /** The main text, or null when it can't be shown, and why. */
    text: string | null;
    why?: string;
    /** Characters in each part, by the FIB. */
    counts: { text: number; footnotes: number; headers: number; comments: number; endnotes: number; textBoxes: number };
    problems: string[];
}

const DOT = 0x0001;
const COMPLEX = 0x0004;
const ENCRYPTED = 0x0100;
const TABLE_1 = 0x0200;
const EXT_CHAR = 0x1000;

function versionName(ident: number, nFib: number): string {
    if (ident === 0xa5dc) return nFib === 101 ? 'Word 6.0' : nFib === 104 ? 'Word 95' : 'Word 6.0 or 95';
    return 'Word 97 or later';
}

/** The document's text, as far as it can be read; `stream` gives the compound file's other streams by name. */
export function readWordText(word: Uint8Array, stream: (name: string) => Uint8Array | null): WordText | null {
    const b = new Bytes(word);
    const ident = b.u16(0);
    const nFib = b.u16(2);
    if (word.length < 0x60 || (ident !== 0xa5dc && ident !== 0xa5ec)) return null;
    const flags = b.u16(0x0a);
    const problems: string[] = [];
    const version = versionName(ident, nFib);
    const template = !!(flags & DOT);
    const old = ident === 0xa5dc;
    if (old && (nFib < 101 || nFib > 105)) problems.push(`Its Word header says it’s version ${nFib} of the format, but Word 6.0’s and 95’s are 101 to 105.`);
    if (!old && nFib < 106) problems.push(`Its Word header says it’s version ${nFib} of the format, but Word 97’s and later’s are 106 and up.`);

    // Where the counts are: right after the fixed part for Word 6.0 and 95; for Word 97, after two lists that say their own lengths.
    let counts: number;
    let pieces: { at: number; size: number; table: Uint8Array } | null = null;
    if (old) counts = 0x34;
    else {
        const csw = b.u16(32);
        const lw = 34 + csw * 2 + 2;
        const cslw = b.u16(34 + csw * 2);
        counts = lw + 12;
        const fcLcb = lw + cslw * 4 + 2;
        const pairs = b.u16(lw + cslw * 4);
        if (cslw < 11 || fcLcb > word.length || pairs < 34 || fcLcb + 34 * 8 > word.length) {
            problems.push('Its Word header is too short to say where its text is.');
            counts = -1;
        } else {
            const name = flags & TABLE_1 ? '1Table' : '0Table';
            const table = stream(name);
            if (!table) problems.push(`Its Word header says its tables are in the ${name} stream, but it has none.`);
            else pieces = { at: b.u32(fcLcb + 33 * 8), size: b.u32(fcLcb + 33 * 8 + 4), table };
        }
    }
    const count = (i: number) => (counts < 0 ? 0 : Math.max(0, b.i32(counts + i * 4)));
    const parts = { text: count(0), footnotes: count(1), headers: count(2), comments: count(4), endnotes: count(5), textBoxes: count(6) };
    const result = (text: string | null, why?: string): WordText => ({ version, template, text, why, counts: parts, problems });

    if (flags & ENCRYPTED) return result(null, 'it’s password protected: its text is encrypted');
    if (counts < 0) return result(null, 'its header doesn’t say where its text is');
    if (old) {
        if (flags & COMPLEX) return result(null, 'it was fast-saved, which leaves Word 6.0’s and 95’s text in pieces, not read here');
        const fcMin = b.u32(0x18);
        const fcMac = b.u32(0x1c);
        const wide = !!(flags & EXT_CHAR);
        if (fcMin > fcMac || fcMac > word.length) {
            problems.push(
                `Its Word header says its text is bytes ${fcMin.toLocaleString('en-US')} to ${fcMac.toLocaleString('en-US')}, but the stream is ${word.length.toLocaleString('en-US')} bytes.`
            );
            return result(null, 'its text is said to be outside the stream');
        }
        const all = Object.values(parts).reduce((n, c) => n + c, 0) + count(3) + count(7);
        if (all * (wide ? 2 : 1) > fcMac - fcMin)
            problems.push(`Its Word header counts ${all.toLocaleString('en-US')} characters, more than the ${(fcMac - fcMin).toLocaleString('en-US')} bytes it says its text takes.`);
        const end = Math.min(fcMac, fcMin + parts.text * (wide ? 2 : 1));
        return result(clean(new TextDecoder(wide ? 'utf-16le' : 'windows-1252').decode(word.subarray(fcMin, end))));
    }
    if (!pieces) return result(null, 'the stream its piece table is in isn’t there');
    return result(...piecesText(pieces, word, parts.text, problems));
}

/** The first `chars` characters, from the piece table at `at` in the table stream. */
function piecesText({ at, size, table }: { at: number; size: number; table: Uint8Array }, word: Uint8Array, chars: number, problems: string[]): [string | null, string?] {
    const t = new Bytes(table);
    if (at + size > table.length) {
        problems.push(`Its piece table is said to be ${size.toLocaleString('en-US')} bytes at ${at.toLocaleString('en-US')}, past the end of its table stream.`);
        return [null, 'its piece table isn’t there'];
    }
    // Formatting the pieces share (type 1) comes first, then the table of pieces (type 2).
    let p = at;
    const end = at + size;
    while (p < end && table[p] === 1) p += 3 + Math.max(0, t.i16(p + 1));
    if (p >= end || table[p] !== 2) {
        problems.push('Its piece table doesn’t hold the list of pieces where its text is.');
        return [null, 'its piece table has no pieces'];
    }
    const length = t.u32(p + 1);
    const list = p + 5;
    if (list + length > end || (length - 4) % 12) {
        problems.push(`Its list of pieces says it’s ${length.toLocaleString('en-US')} bytes, which ${list + length > end ? 'runs past its piece table' : 'isn’t a whole number of pieces'}.`);
        return [null, 'its list of pieces is broken'];
    }
    const n = (length - 4) / 12;
    let text = '';
    let cut = 0;
    for (let i = 0; i < n; i++) {
        const from = t.u32(list + i * 4);
        const to = Math.min(t.u32(list + (i + 1) * 4), chars);
        if (from >= chars) break;
        if (to <= from) continue;
        const raw = t.u32(list + (n + 1) * 4 + i * 8 + 2);
        const compressed = !!(raw & 0x40000000);
        const fc = raw & 0x3fffffff;
        const start = compressed ? fc >>> 1 : fc;
        const bytes = (to - from) * (compressed ? 1 : 2);
        if (start + bytes > word.length) cut++;
        text += new TextDecoder(compressed ? 'windows-1252' : 'utf-16le').decode(word.subarray(start, Math.min(word.length, start + bytes)));
    }
    if (cut) problems.push(`${cut.toLocaleString('en-US')} of its text’s pieces ${cut === 1 ? 'runs' : 'run'} past the end of its WordDocument stream.`);
    return [clean(text)];
}

/** Word's text as plain text: its marks as line breaks and tabs, each field as its result, without its code. */
function clean(text: string): string {
    let out = '';
    // For each field open: whether its result has started (after 20), when its code isn't shown.
    const fields: boolean[] = [];
    for (const c of text) {
        const code = c.charCodeAt(0);
        if (code === 19) fields.push(false);
        else if (code === 20) {
            if (fields.length) fields[fields.length - 1] = true;
        } else if (code === 21) fields.pop();
        else if (fields.length && !fields[fields.length - 1]) continue;
        else if (code === 13 || code === 11 || code === 12 || code === 14) out += '\n';
        else if (code === 7) out += '\t';
        else if (code === 30) out += '-';
        else if (code >= 32 || code === 9) out += c;
    }
    return out.replace(/\n+$/, '\n');
}
