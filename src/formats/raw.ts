import { bytesLabel } from '../core/bytes';
import type { FormatParser } from '../core/types';

/** The fallback: no format recognised, so just the bytes. */
const parser: FormatParser = {
    parse(data) {
        if (data.length === 0) return { title: 'Empty file', summary: [['Size', '0 bytes']], fields: [], warnings: [] };
        return {
            title: 'Unrecognised data',
            summary: [['Size', bytesLabel(data.length)]],
            fields: [{ name: 'Data', offset: 0, length: data.length, note: 'No parser recognised this. The hex view still shows every byte.' }],
            warnings: [],
        };
    },
};

export default parser;
