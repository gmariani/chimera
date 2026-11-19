import type { FormatParser, TableRow } from '../core/types';
import { sniffVersion } from './version-sniff';
import { readVersionInfo } from './win-resources';

/**
 * A Windows program's version information, saved from it on its own (the VERSIONINFO resource, which Windows shows on
 * a file's Details tab): the numbers Windows compares to tell a newer file from an older one (VS_FIXEDFILEINFO), the
 * names and values the program says about itself (its company, description, product, copyright), one table for each
 * language and code page, and the list of those languages. 32-bit programs (PE) keep it in UTF-16; 16-bit ones (NE),
 * in the code page, with no type in each node. The layout is read in win-resources.ts, which has the sources.
 */

/** What the summary calls the strings it shows, in the order it shows them. */
const SHOWN: [string, string][] = [
    ['FileDescription', 'Description'],
    ['CompanyName', 'Company'],
    ['ProductName', 'Product'],
    ['FileVersion', 'Version, as text'],
    ['OriginalFilename', 'Original name'],
    ['LegalCopyright', 'Copyright'],
];

const parser: FormatParser = {
    parse(data) {
        if (!sniffVersion(data)) throw new Error('This isn’t a Windows version resource: it doesn’t start with VS_VERSION_INFO.');
        const v = readVersionInfo(data, 0, data.length);
        const strings = new Map(v.strings);
        const rows: TableRow[] = v.tables.flatMap((t) => t.strings.map(([name, value]) => ({ group: t.language, cells: { name, value } })));
        return {
            title: `Version information (${v.wide ? '32-bit' : '16-bit'} Windows resource)`,
            summary: [
                ...SHOWN.filter(([k]) => strings.get(k)).map(([k, label]) => [label, strings.get(k)!] as [string, string]),
                ['File version', v.fileVersion ?? 'none: it has no numbers Windows compares'],
                ...(v.productVersion ? [['Product version', v.productVersion] as [string, string]] : []),
                ['Strings', v.tables.length ? v.tables.map((t) => `${t.strings.length} in ${t.language}`).join('; ') : 'none'],
                ...(v.translations.length ? [['Languages', v.translations.join('; ')] as [string, string]] : []),
            ],
            fields: v.fields,
            preview: rows.length
                ? {
                      kind: 'table',
                      columns: [
                          { key: 'name', label: 'Name' },
                          { key: 'value', label: 'Value' },
                      ],
                      groups: [...new Set(rows.map((r) => r.group))],
                      rows,
                  }
                : undefined,
            end: v.end,
            warnings: v.problems,
        };
    },
};

export default parser;
