import { Bytes, field, hex } from '../../core/bytes';
import { crc32 } from '../../core/crc32';
import type { Field, FormatParser } from '../../core/types';

/**
 * Petroglyph's string tables (MasterTextFile_EN-US.loc in the Remastered
 * Collection's Config.meg): the game's text by key ("TEXT_MUSIC_TDR_MUS_RECON").
 * A count, then for each string a record of the key's CRC-32, the value's length
 * in characters and the key's length in bytes; then all the values (UTF-16) and
 * all the keys (ASCII), in the same order. The master tables are sorted by CRC
 * with each key once; the credits (CreditsText_EN-US.dat) are the same layout in
 * reading order, with style names like "CENTER" as keys, repeated.
 */

const RECORD = 12;
/** Past this many, strings are in the preview but not the field tree. */
const MAX_FIELDS = 5000;

const parser: FormatParser = {
    parse(data) {
        const b = new Bytes(data);
        const count = b.u32(0);
        const valuesStart = 4 + count * RECORD;
        if (valuesStart > data.length) throw new Error('The string count is too big for this file.');

        const warnings: string[] = [];
        const utf16 = new TextDecoder('utf-16le');
        const records: Field[] = [];
        const valueFields: Field[] = [];
        const keyFields: Field[] = [];
        const lines: string[] = [];
        const keys = new Set<string>();
        let badCrcs = 0;
        let sorted = true;

        let valuesLength = 0;
        for (let i = 0; i < count; i++) valuesLength += b.u32(4 + i * RECORD + 4) * 2;
        const keysStart = valuesStart + valuesLength;

        let valueAt = valuesStart;
        let keyAt = keysStart;
        let read = 0;
        for (let i = 0; i < count; i++) {
            const r = 4 + i * RECORD;
            const [crc, valueChars, keyLength] = [b.u32(r), b.u32(r + 4), b.u32(r + 8)];
            if (keyAt + keyLength > data.length) {
                warnings.push(`String ${i} runs past the end of the file; stopped there.`);
                break;
            }
            const value = utf16.decode(data.subarray(valueAt, valueAt + valueChars * 2));
            const key = b.ascii(keyAt, keyLength);
            if (crc32(data.subarray(keyAt, keyAt + keyLength)) !== crc) badCrcs++;
            if (i > 0 && b.u32(r - RECORD) > crc) sorted = false;
            keys.add(key);
            lines.push(`${key}\t${value.replace(/\r/g, '\\r').replace(/\n/g, '\\n')}`);
            if (i < MAX_FIELDS) {
                const shown = JSON.stringify(value.length > 80 ? `${value.slice(0, 80)}…` : value);
                records.push({
                    name: key,
                    offset: r,
                    length: RECORD,
                    value: shown,
                    children: [field('Key CRC', r, 4, hex(crc), 'CRC-32 of the key.'), field('Value length', r + 4, 4, `${valueChars} characters`), field('Key length', r + 8, 4, `${keyLength} bytes`)],
                });
                valueFields.push(field(key, valueAt, valueChars * 2, shown));
                keyFields.push(field(`${i}`, keyAt, keyLength, key));
            }
            valueAt += valueChars * 2;
            keyAt += keyLength;
            read++;
        }

        if (read === count && keyAt !== data.length) warnings.push(`${data.length - keyAt} bytes are left over after the last key.`);
        if (badCrcs) warnings.push(badCrcs === 1 ? "1 key doesn't match its CRC." : `${badCrcs} keys don't match their CRCs.`);
        if (count > MAX_FIELDS) warnings.push(`The first ${MAX_FIELDS.toLocaleString('en-US')} strings are in the fields; the preview has them all.`);

        return {
            title: 'Petroglyph string table (LOC)',
            summary: [
                ['Strings', String(read)],
                ['Different keys', String(keys.size)],
                ['Order', sorted ? 'By key CRC' : 'As written (for reading in order)'],
            ],
            fields: [
                { name: 'Header', offset: 0, length: 4, children: [field('String count', 0, 4, count)] },
                { name: `Records (${count})`, offset: 4, length: count * RECORD, children: records },
                { name: 'Values', offset: valuesStart, length: valuesLength, value: 'UTF-16', children: valueFields },
                { name: 'Keys', offset: keysStart, length: keyAt - keysStart, value: 'ASCII', children: keyFields },
            ],
            preview: { kind: 'text', text: lines.join('\n') },
            warnings,
        };
    },
};

export default parser;
