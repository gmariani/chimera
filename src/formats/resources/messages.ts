import { maxOf, minOf } from '../../core/math';
import type { FormatParser, TableRow } from '../../core/types';
import { readMessageTable } from '../win-resources';

/**
 * A message table saved from a Windows program's resources: blocks of numbered messages, the text Windows' own
 * FormatMessage looks up (event log entries, error messages). It has no signature: a program says what its resources
 * are, so it's read this way when it comes from one. See win-resources.ts.
 */
const parser: FormatParser = {
    parse(data) {
        const t = readMessageTable(data, 0, data.length);
        if (!t.strings.length) throw new Error(`This isn’t a message table: ${t.problems[0] ?? 'it has no messages.'}`);
        const rows: TableRow[] = t.strings.map((s) => ({ group: 'Messages', cells: { id: String(s.id), text: s.text } }));
        const ids = t.strings.map((s) => s.id);
        return {
            title: 'Message table (Windows resource)',
            summary: [
                ['Messages', t.strings.length.toLocaleString('en-US')],
                ['IDs', `${minOf(ids)} to ${maxOf(ids)}`],
            ],
            fields: t.fields,
            preview: {
                kind: 'table',
                columns: [
                    { key: 'id', label: 'ID', numeric: true },
                    { key: 'text', label: 'Text' },
                ],
                groups: ['Messages'],
                rows,
            },
            end: t.fields.reduce((n, f) => Math.max(n, f.offset + f.length), 0),
            warnings: t.problems,
        };
    },
};

export default parser;
