import { Bytes, field } from '../../core/bytes';
import type { Field, FormatParser } from '../../core/types';

/**
 * RA2's string tables (.csf): the game's text by label ("THEME:Intro"). A
 * header, then for each label " LBL", how many strings it has (always one in
 * practice), its name, and its strings: " RTS" (or "WRTS" with an extra ASCII
 * value after), the length in characters, and UTF-16 text with every bit
 * flipped.
 */

const LANGUAGES = ['US English', 'UK English', 'German', 'French', 'Spanish', 'Italian', 'Japanese', 'Jabberwockie', 'Korean', 'Chinese'];

const parser: FormatParser = {
    parse(data) {
        const b = new Bytes(data);
        if (b.ascii(0, 4) !== ' FSC') throw new Error('No " FSC" header.');
        const [version, labelCount, stringCount, language] = [b.u32(4), b.u32(8), b.u32(12), b.u32(20)];
        const warnings: string[] = [];
        const labels: Field[] = [];
        const lines: string[] = [];
        let at = 24;
        for (let i = 0; i < labelCount && at + 12 <= data.length; i++) {
            if (b.ascii(at, 4) !== ' LBL') {
                warnings.push(`Label ${i} at ${at} doesn't start with " LBL"; stopped there.`);
                break;
            }
            const start = at;
            const pairs = b.u32(at + 4);
            const name = b.ascii(at + 12, b.u32(at + 8));
            at += 12 + name.length;
            const values: string[] = [];
            for (let p = 0; p < pairs && at + 8 <= data.length; p++) {
                const wide = b.ascii(at, 4) === 'WRTS';
                const length = b.u32(at + 4);
                let text = '';
                for (let c = 0; c < length; c++) text += String.fromCharCode(~b.u16(at + 8 + c * 2) & 0xffff);
                at += 8 + length * 2;
                if (wide) {
                    const extra = b.ascii(at + 4, b.u32(at));
                    at += 4 + extra.length;
                    text += ` [${extra}]`;
                }
                values.push(text);
            }
            const shown = values.join(' | ');
            labels.push(field(name, start, at - start, JSON.stringify(shown.length > 80 ? `${shown.slice(0, 80)}…` : shown)));
            lines.push(`${name}\t${shown.replace(/\n/g, '\\n')}`);
        }

        return {
            title: 'String table (CSF)',
            summary: [
                ['Labels', String(labelCount)],
                ['Strings', String(stringCount)],
                ['Language', LANGUAGES[language] ?? String(language)],
            ],
            fields: [
                {
                    name: 'Header',
                    offset: 0,
                    length: 24,
                    children: [
                        field('ID', 0, 4, ' FSC'),
                        field('Version', 4, 4, version),
                        field('Labels', 8, 4, labelCount),
                        field('Strings', 12, 4, stringCount),
                        field('Unused', 16, 4),
                        field('Language', 20, 4, `${language} (${LANGUAGES[language] ?? 'unknown'})`),
                    ],
                },
                { name: `Labels (${labels.length})`, offset: 24, length: at - 24, children: labels },
            ],
            preview: { kind: 'text', text: lines.join('\n') },
            warnings,
        };
    },
};

export default parser;
