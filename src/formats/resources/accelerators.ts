import type { FormatParser } from '../../core/types';
import { readAccelerators } from '../win-accelerators';

/**
 * Shortcut keys (an accelerator table) saved from a Windows program's resources: each key and the command it sends
 * (see win-accelerators.ts). It has no signature: a program says what its resources are, so it's read this way when it
 * comes from one. On its own, what each command does isn't known: the program's menus name that.
 */
export function acceleratorsParser(wide: boolean): FormatParser {
    return {
        parse(data) {
            if (data.length < (wide ? 8 : 5)) throw new Error('This isn’t a table of shortcut keys: it’s too short for one.');
            const a = readAccelerators(data, 0, data.length, wide);
            return {
                title: `Shortcut keys (${wide ? '32-bit' : '16-bit'} Windows resource)`,
                summary: [['Keys', a.entries.map((e) => e.keys).join(', ') || 'none']],
                fields: a.fields,
                preview: {
                    kind: 'table',
                    columns: [
                        { key: 'keys', label: 'Keys' },
                        { key: 'id', label: 'Command', numeric: true },
                    ],
                    groups: ['Shortcut keys'],
                    rows: a.entries.map((e) => ({ group: 'Shortcut keys', cells: { keys: e.keys, id: String(e.id) } })),
                },
                end: a.end,
                warnings: a.problems,
            };
        },
    };
}

export default acceleratorsParser(true);
