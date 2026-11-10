import { bytesLabel } from '../core/bytes';
import type { FormatParser } from '../core/types';

/** Plain text: INI files, mission scripts. DOS-era games used code page 437, which latin1 approximates. */
const parser: FormatParser = {
    parse(data) {
        const utf16 = (data[0] === 0xff && data[1] === 0xfe) || (data[0] === 0xfe && data[1] === 0xff);
        if (!utf16) {
            const control = controlShare(data);
            if (control > 0.05) throw new Error(`This isn't text: ${Math.round(control * 100)}% of its first ${bytesLabel(Math.min(data.length, SAMPLE))} are control bytes.`);
        }
        const text = new TextDecoder(utf16 ? (data[0] === 0xff ? 'utf-16le' : 'utf-16be') : isUtf8(data) ? 'utf-8' : 'latin1').decode(data);
        const lines = text.split(/\r?\n/);
        return {
            title: 'Text',
            summary: [
                ['Lines', lines.length.toLocaleString('en-US')],
                ['Line endings', text.includes('\r\n') ? 'CRLF (DOS)' : 'LF'],
            ],
            fields: [{ name: 'Text', offset: 0, length: data.length, value: bytesLabel(data.length) }],
            preview: { kind: 'text', text },
            warnings: [],
        };
    },
};

const SAMPLE = 1 << 16;

/** How much of the start isn't text: control bytes other than tab, line breaks and form feed (DOS text ends in Ctrl-Z, so that's allowed too). */
function controlShare(data: Uint8Array): number {
    // Zeros at the very end are padding (C strings written whole), not part of the text.
    let length = data.length;
    while (length > 0 && data[length - 1] === 0) length--;
    const n = Math.min(length, SAMPLE);
    if (!n) return 0;
    let control = 0;
    for (let i = 0; i < n; i++) {
        const c = data[i];
        if (c < 32 && c !== 9 && c !== 10 && c !== 13 && c !== 12 && c !== 26) control++;
        else if (c === 127) control++;
    }
    return control / n;
}

function isUtf8(data: Uint8Array): boolean {
    try {
        new TextDecoder('utf-8', { fatal: true }).decode(data);
        return true;
    } catch {
        return false;
    }
}

export default parser;
