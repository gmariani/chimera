import { bytesLabel } from '../../core/bytes';
import type { FormatParser, TableRow } from '../../core/types';
import { readStringTable } from '../win-resources';

/**
 * A string table saved from a Windows program's resources: 16 strings, each its length and then its text (UTF-16 for
 * a 32-bit program; a byte and the code page for a 16-bit one). It has no signature: a program says what its resources
 * are, so it's read this way when it comes from one. The strings' IDs come from the resource's number, which its name
 * carries ("String table #7" holds strings 96 to 111). See win-resources.ts.
 */
export function stringTableParser(wide: boolean): FormatParser {
    return {
        parse(data, context) {
            const block = Number((context.name ?? context.label ?? '').match(/#(\d+)/)?.[1] ?? -1);
            const t = readStringTable(data, 0, data.length, block > 0 && block <= 4096 ? block : -1, wide);
            // 16 strings at most, each its length at least: anything much longer isn't one.
            if (data.length < (wide ? 32 : 16) || (!t.strings.length && data.some((v) => v)))
                throw new Error('This isn’t a string table: it doesn’t start with 16 strings, each its length and then its text.');
            const rows: TableRow[] = t.strings.map((s) => ({ group: 'Strings', cells: { id: String(s.id), text: s.text } }));
            return {
                title: `String table (${wide ? '32-bit' : '16-bit'} Windows resource)`,
                summary: [
                    ['Strings', `${t.strings.length} of 16`],
                    ['IDs', block > 0 ? `${(block - 1) * 16} to ${(block - 1) * 16 + 15}, as resource #${block}` : 'counted from 0 here: its resource number, which says what they are, isn’t known'],
                    ['Size', bytesLabel(data.length)],
                ],
                fields: t.fields,
                preview: rows.length
                    ? {
                          kind: 'table',
                          columns: [
                              { key: 'id', label: 'ID', numeric: true },
                              { key: 'text', label: 'Text' },
                          ],
                          groups: ['Strings'],
                          rows,
                      }
                    : undefined,
                warnings: t.problems,
            };
        },
    };
}

export default stringTableParser(true);
