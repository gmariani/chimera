import { bytesLabel, field, fillGaps } from '../core/bytes';
import type { FormatParser } from '../core/types';
import { leOffset } from './le-sniff';
import { readLinear } from './linear';

/**
 * Linear Executables on their own (LE, LX): a DOS header and a DOS program that says it can't run (the stub), then the
 * linear header and what it points to (see linear.ts). DOS/4GW programs saved from the file they were bound into are
 * these, and so are Windows 3 and 95 drivers (VxDs) and OS/2 2.0's programs.
 */
/** DOS extenders that run linear programs, as they name themselves in their own code: DOS/32A (the BIOS flasher Gigabyte ships), DOS/4G (Westwood's installers). */
const EXTENDERS = ['DOS/32A', 'DOS/4G'];

const parser: FormatParser = {
    parse(data, context) {
        const at = leOffset(data);
        if (at === null) throw new Error('This isn’t a Linear Executable: it doesn’t have a DOS header pointing to "LE" or "LX".');
        const stem = (context.name ?? context.label ?? 'program').replace(/\.[^.]*$/, '');
        // A stub big enough to be more than a message is a DOS extender, which runs the program itself: named when it names itself.
        const stub = new TextDecoder('latin1').decode(data.subarray(0x40, at));
        const extender = EXTENDERS.find((e) => stub.includes(e)) ?? '';
        const lin = readLinear(data, 0, at, stem, extender);
        const parts = [
            {
                ...field('DOS header', 0, 0x40, '"MZ"'),
                children: [
                    field('Signature', 0, 2, '"MZ"'),
                    field('DOS header fields', 2, 0x3a, bytesLabel(0x3a), 'For the stub, which DOS runs.'),
                    field('Newer header at', 0x3c, 4, at.toLocaleString('en-US'), 'Where the linear header is.'),
                ],
            },
            ...(at > 0x40
                ? [
                      field(
                          extender ? `DOS extender (${extender})` : 'DOS stub',
                          0x40,
                          at - 0x40,
                          bytesLabel(at - 0x40),
                          extender ? 'What DOS runs: it loads the 32-bit program after it.' : 'What runs when it’s started where it can’t be.'
                      ),
                  ]
                : []),
        ];
        const end = Math.max(lin.end, ...lin.fields.map((f) => f.offset + f.length));
        return {
            title: `${lin.what} (${lin.kind})`,
            summary: lin.summary,
            fields: fillGaps(data, [...parts, ...lin.fields], 0, Math.min(end, data.length), 'Not pointed to'),
            entries: lin.entries.length ? lin.entries : undefined,
            preview: lin.rows.length
                ? {
                      kind: 'table',
                      columns: [
                          { key: 'object', label: 'Object', numeric: true },
                          { key: 'size', label: 'Size in memory', numeric: true },
                          { key: 'address', label: 'Address' },
                          { key: 'flags', label: 'Flags' },
                          { key: 'pages', label: 'Pages', numeric: true },
                      ],
                      groups: [...new Set(lin.rows.map((r) => r.group))],
                      rows: lin.rows,
                  }
                : undefined,
            end: Math.min(end, data.length),
            warnings: lin.problems,
        };
    },
};

export default parser;
