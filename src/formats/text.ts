import { bytesLabel } from '../core/bytes';
import type { FormatParser } from '../core/types';

/** Plain text: INI files, mission scripts. DOS-era games used code page 437, which latin1 approximates. */
const parser: FormatParser = {
    parse(data) {
        const text = new TextDecoder(isUtf8(data) ? 'utf-8' : 'latin1').decode(data);
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

function isUtf8(data: Uint8Array): boolean {
    try {
        new TextDecoder('utf-8', { fatal: true }).decode(data);
        return true;
    } catch {
        return false;
    }
}

export default parser;
