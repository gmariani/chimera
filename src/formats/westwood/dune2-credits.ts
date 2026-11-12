import { field } from '../../core/bytes';
import type { Field, FormatParser } from '../../core/types';
import { creditStrings, MOST, type CreditString } from './dune2-credits-layout';

/**
 * Dune II's credits, which scroll up the screen when the game is won (and
 * from the main menu): CREDITS.ENG, or .FRE or .GER, by the language. 1.07
 * ships them, in ENGLISH.PAK and loose; 1.00's ENGLISH.PAK has a C header of
 * the same name instead.
 *
 * Text in rows, each ending in a CR. A row is one string, or several sharing
 * it, split by 0x05 (a role, then its first name). A style byte at a string's
 * start says how it's drawn:
 *
 * - 0x01: centered, in the small 6-point font (the legal lines);
 * - 0x02: centered, in the 8-point font (the titles);
 * - 0x03: a role, ending just left of the middle (x = 157);
 * - 0x04: a name, starting just right of it (x = 161);
 * - none: centered.
 *
 * A NUL ends them. This follows OpenDUNE's GameCredits_Play (src/cutscene.c),
 * the game's own code: https://github.com/OpenDUNE/OpenDUNE
 */

const STYLES = ['Centered', 'Centered, small', 'Title', 'Role', 'Name'];
const STYLE_NOTES = [
    'No style byte: centered.',
    '0x01: centered, in the small 6-point font.',
    '0x02: centered, in the 8-point font.',
    '0x03: a role, drawn to end just left of the middle.',
    '0x04: a name, drawn from just right of the middle.',
];
/** What a row is called, by its first string's style. */
const ROWS = ['Centered line', 'Small print', 'Title', 'Role', 'Name'];
const quote = (s: string) => JSON.stringify(s);

const parser: FormatParser = {
    parse(data) {
        if (data.length > MOST) throw new Error(`This is ${data.length.toLocaleString('en-US')} bytes; Dune II reads its credits into a ${MOST.toLocaleString('en-US')}-byte buffer.`);
        const { strings, end } = creditStrings(data);
        if (!strings.some((s) => s.style)) throw new Error('This isn’t Dune II’s credits: no line starts with a style byte (0x01 to 0x04).');
        const warnings: string[] = [];
        if (end >= data.length) warnings.push('There’s no NUL to end the credits: the game would scroll on through whatever is in memory after them.');

        // Rows: the strings up to each CR.
        const rows: CreditString[][] = [[]];
        for (const s of strings) {
            rows[rows.length - 1].push(s);
            if (s.separator === 13) rows.push([]);
        }
        if (!rows[rows.length - 1].length) rows.pop();

        // Control bytes the game would draw as characters: style bytes past a string's start, and any others.
        rows.forEach((row, r) => {
            for (const s of row)
                for (let i = s.from; i < s.to; i++)
                    if (data[i] < 0x20) {
                        warnings.push(
                            `Row ${r + 1} has a 0x${data[i].toString(16).padStart(2, '0').toUpperCase()} inside ${quote(s.text)}${data[i] <= 4 ? ': the game reads a style byte only at a string’s start' : ''}, and draws it as a character.`
                        );
                        break;
                    }
        });

        // Each row as a field, its strings inside; a run of blank rows as one.
        const fields: Field[] = [];
        const blank = (row: CreditString[]) => row.length === 1 && !row[0].style && !row[0].text;
        for (let r = 0; r < rows.length; r++) {
            const row = rows[r];
            if (blank(row)) {
                let n = 1;
                while (r + n < rows.length && blank(rows[r + n])) n++;
                fields.push(field(n === 1 ? 'Blank row' : 'Blank rows', row[0].at, n, n === 1 ? undefined : `${n}`, 'A CR on its own: a gap as the credits scroll.'));
                r += n - 1;
                continue;
            }
            const last = row[row.length - 1];
            const to = last.separator === 5 || last.separator === 13 ? last.to + 1 : last.to;
            fields.push({
                name: ROWS[row[0].style],
                offset: row[0].at,
                length: to - row[0].at,
                value: row.map((s) => s.text.trim()).join(' · '),
                children: row.flatMap((s) => [
                    ...(s.style ? [field('Style', s.at, 1, STYLES[s.style], STYLE_NOTES[s.style])] : []),
                    field('Text', s.from, s.to - s.from, quote(s.text), s.style ? undefined : STYLE_NOTES[0]),
                    ...(s.separator === 5 ? [field('Same row', s.to, 1, '0x05', 'The next string shares this row.')] : []),
                    ...(s.separator === 13 ? [field('End of row', s.to, 1, 'CR')] : []),
                ]),
            });
        }
        if (end < data.length) fields.push(field('End', end, 1, 'NUL', 'Where the game stops reading.'));

        // As the game lays them out: roles ending at the middle, names starting there, everything else centered on it.
        const centered = strings.filter((s) => s.style < 3).map((s) => s.text.trim().length);
        const middle = Math.max(...strings.filter((s) => s.style === 3).map((s) => s.text.trim().length + 1), ...centered.map((n) => Math.ceil(n / 2)), 1);
        const lines = rows.map((row) =>
            row
                .reduce((line, s) => {
                    const text = s.text.trim();
                    const at = s.style === 3 ? middle - 1 - text.length : s.style === 4 ? middle + 1 : middle - Math.floor(text.length / 2);
                    return line.padEnd(at) + text;
                }, '')
                .trimEnd()
        );

        const roles = strings.filter((s) => s.style === 3 && s.text.trim());
        const names = strings.filter((s) => s.style === 4 && s.text.trim());
        const people = new Set(names.map((s) => s.text.trim()));
        return {
            title: 'Credits (Dune II)',
            summary: [
                ['Roles', roles.length.toLocaleString('en-US')],
                ['Names', `${names.length.toLocaleString('en-US')}${people.size !== names.length ? `, of ${people.size.toLocaleString('en-US')} people` : ''}`],
                ['Rows', rows.length.toLocaleString('en-US')],
            ],
            fields,
            // The blank rows at the end are a pause before the credits start again: left out here.
            preview: { kind: 'text', text: lines.join('\n').trimEnd() },
            end: Math.min(end + 1, data.length),
            warnings,
        };
    },
};

export default parser;
