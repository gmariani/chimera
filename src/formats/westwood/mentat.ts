import { Bytes, bytesLabel, field } from '../../core/bytes';
import type { Field, FormatParser } from '../../core/types';
import { dune2Text } from './dune2-text';

/**
 * Dune II's mentat encyclopedia (MENTATA.ENG, MENTATH.ENG, MENTATO.ENG: one a
 * house, in each language). An IFF file, "FORM" of type "MENT":
 *
 * - NAME: the topics as the mentat lists them. Each is its length, where its
 *   text is in the file (big-endian), the number of the heading it's under
 *   ("0" for Briefing, "1" for Houses...), "0" for a heading or "1" for a topic,
 *   the name (ending in a NUL), and the mission it's listed from.
 * - DESC: the texts, compressed (see dune2-text.ts), each ending in a NUL: the
 *   animation to show (a .WSA), "*" to loop it or "?" not to, a line of
 *   description, a form feed (0x0C), then the text.
 * - INFO: 8 bytes the game doesn't read, then how many bytes it reads for a text.
 *
 * ModdingWiki has no page for it; this follows OpenDUNE's mentat screen
 * (src/gui/mentat.c, GUI_Mentat_LoadHelpSubjects and GUI_Mentat_ShowHelp),
 * https://github.com/OpenDUNE/OpenDUNE.
 */

interface Chunk {
    id: string;
    at: number;
    size: number;
    start: number;
    end: number;
}

interface Topic {
    at: number;
    length: number;
    textAt: number;
    /** The heading it's under, as a digit ("0": the briefing's, whose topics take their picture and text from the mission). */
    section: string;
    heading: boolean;
    name: string;
    mission: number;
}

const parser: FormatParser = {
    parse(data) {
        const b = new Bytes(data);
        if (data.length < 12 || b.ascii(0, 4) !== 'FORM' || b.ascii(8, 4) !== 'MENT')
            throw new Error('This isn\'t Dune II\'s mentat encyclopedia: it doesn\'t start with an IFF "FORM" of type "MENT".');
        const warnings: string[] = [];
        const formSize = b.u32be(4);
        const formEnd = Math.min(data.length, 8 + formSize);
        if (8 + formSize > data.length) warnings.push(`The FORM says it's ${bytesLabel(8 + formSize)}, but the file is ${bytesLabel(data.length)}.`);

        // The chunks: four characters, a big-endian size, the data, padded to an even length.
        const chunks: Chunk[] = [];
        let at = 12;
        while (at + 8 <= formEnd && /^[\x20-\x7e]{4}$/.test(b.ascii(at, 4))) {
            const size = b.u32be(at + 4);
            chunks.push({ id: b.ascii(at, 4), at, size, start: at + 8, end: Math.min(at + 8 + size, data.length) });
            if (at + 8 + size > data.length) warnings.push(`The ${b.ascii(at, 4)} chunk says it's ${bytesLabel(size)}, but only ${bytesLabel(data.length - at - 8)} are left.`);
            at += 8 + size + (size & 1);
        }
        const chunksEnd = Math.min(at, formEnd);
        const byId = new Map<string, Chunk>();
        for (const c of chunks) {
            if (!['NAME', 'DESC', 'INFO'].includes(c.id)) warnings.push(`There's a ${c.id} chunk, which the mentat files don't have; the game skips it.`);
            else if (byId.has(c.id)) warnings.push(`There are two ${c.id} chunks; the game reads only the first.`);
            else byId.set(c.id, c);
        }
        const name = byId.get('NAME');
        const desc = byId.get('DESC');
        const info = byId.get('INFO');
        if (!name || !desc) throw new Error(`This mentat file has no ${!name ? 'NAME' : 'DESC'} chunk, which the game needs.`);
        const readLength = info && info.end - info.start >= 12 ? b.u32be(info.start + 8) : 0;
        if (!info) warnings.push('There is no INFO chunk, which says how much of each text the game reads.');

        // The topics: each entry gives its own length; the name ends in a NUL; the last byte is the mission.
        const topics: Topic[] = [];
        for (let p = name.start; p < name.end;) {
            const length = data[p];
            if (length < 9 || p + length > name.end) {
                warnings.push(`The topic at ${p.toLocaleString('en-US')} says it's ${length} bytes, which ${length < 9 ? "can't hold a topic" : 'runs past the NAME chunk'}; the list stops there.`);
                break;
            }
            const nul = data.indexOf(0, p + 7);
            const text = nul >= 0 && nul < p + length - 1 ? b.ascii(p + 7, nul - p - 7) : b.ascii(p + 7, length - 8);
            topics.push({ at: p, length, textAt: b.u32be(p + 1), section: String.fromCharCode(data[p + 5]), heading: data[p + 6] === 0x30, name: text, mission: data[p + length - 1] });
            p += length;
        }

        // Each topic's text: from where it says, to its NUL, inside DESC.
        const sections: string[] = [];
        const textFields: Field[] = [];
        let pairs = 0;
        for (const t of topics) {
            if (t.textAt < desc.start || t.textAt >= desc.end) {
                warnings.push(`“${t.name}” says its text is at ${t.textAt.toLocaleString('en-US')}, outside the DESC chunk.`);
                continue;
            }
            const nul = data.indexOf(0, t.textAt);
            const stop = nul < 0 || nul >= desc.end ? desc.end : nul;
            if (stop === desc.end) warnings.push(`“${t.name}”’s text runs to the end of the DESC chunk without its NUL.`);
            if (readLength && stop - t.textAt > readLength)
                warnings.push(`“${t.name}”’s text is ${bytesLabel(stop - t.textAt)}, more than the ${bytesLabel(readLength)} the game reads; it would be cut off.`);
            const decoded = dune2Text(data.subarray(t.textAt, stop));
            pairs += decoded.pairs;
            // The picture (or, for the briefing, a number the game turns into the scenario's), then * or ?, the description, a form feed, the text.
            const mark = decoded.text.search(/[*?]/);
            const picture = mark >= 0 ? decoded.text.slice(0, mark) : '';
            const rest = mark >= 0 ? decoded.text.slice(mark + 1) : decoded.text;
            const loops = decoded.text[mark] === '*';
            const feed = rest.indexOf('\f');
            // The briefing's topics (section 0) show the mission's picture, and text the game takes from its strings: here they
            // only hold a number (which of the mission's texts) and "No desc". Headings' texts are never shown.
            const briefing = t.section === '0';
            const description = !briefing && feed >= 0 ? rest.slice(0, feed) : '';
            const body = (!briefing && feed >= 0 ? rest.slice(feed + 1) : rest).replace(/\r/g, '\n').trim();
            if (mark < 0 && !t.heading) warnings.push(`“${t.name}”’s text doesn't say what picture to show (no * or ?).`);
            if (t.heading) sections.push(`== ${t.name.toUpperCase()} ==`);
            else if (briefing) sections.push(`-- ${t.name} --\n(from mission ${Math.max(1, t.mission)}: the mission's own briefing picture and text, its text number ${picture || '?'})`);
            else {
                const lines = [`-- ${t.name} --`, `(from mission ${Math.max(1, t.mission)}; animation ${picture || '(none)'}${picture ? (loops ? ', looping' : ', once') : ''})`];
                if (description) lines.push(description.replace(/\r/g, '\n').trim());
                lines.push('', body);
                sections.push(lines.join('\n'));
            }
            textFields.push(
                field(
                    t.name,
                    t.textAt,
                    Math.min(stop + 1, desc.end) - t.textAt,
                    `${bytesLabel(stop - t.textAt)}, compressed`,
                    t.section === '0' ? 'For the briefing: a number, then a placeholder.' : `Animation ${picture || '(none)'}.`
                )
            );
        }

        // What's in DESC that no topic points to.
        textFields.sort((x, y) => x.offset - y.offset);
        const descFields: Field[] = [];
        let covered = desc.start;
        let stray = 0;
        for (const f of textFields) {
            if (f.offset > covered) {
                const gap = data.subarray(covered, f.offset);
                if (gap.some((v) => v)) stray += gap.length;
                descFields.push(field(gap.some((v) => v) ? 'Not pointed to' : 'Padding', covered, gap.length, bytesLabel(gap.length)));
            }
            descFields.push(f);
            covered = Math.max(covered, f.offset + f.length);
        }
        if (covered < desc.end) {
            const gap = data.subarray(covered, desc.end);
            if (gap.some((v) => v)) stray += gap.length;
            descFields.push(field(gap.some((v) => v) ? 'Not pointed to' : 'Padding', covered, gap.length, bytesLabel(gap.length)));
        }
        if (stray) warnings.push(`${bytesLabel(stray)} of the texts aren't pointed to by any topic, so the game never shows them.`);

        const chunkField = (c: Chunk, value: string, children: Field[]): Field => ({
            name: `${c.id} chunk`,
            offset: c.at,
            length: Math.min(8 + c.size + (c.size & 1), data.length - c.at),
            value,
            children: [field('ID', c.at, 4, JSON.stringify(c.id)), field('Size', c.at + 4, 4, bytesLabel(c.size), 'Big-endian.'), ...children],
        });
        const fields: Field[] = [
            {
                name: 'FORM header',
                offset: 0,
                length: 12,
                children: [field('ID', 0, 4, '"FORM"', 'An IFF file.'), field('Size', 4, 4, bytesLabel(formSize), 'Big-endian. Everything after these 8 bytes.'), field('Type', 8, 4, '"MENT"')],
            },
            ...chunks.map((c) => {
                if (c === name)
                    return chunkField(
                        c,
                        `${topics.length} topics`,
                        topics.map((t) => ({
                            name: t.name,
                            offset: t.at,
                            length: t.length,
                            value: t.heading ? 'heading' : `topic, from mission ${Math.max(1, t.mission)}`,
                            children: [
                                field('Length', t.at, 1, t.length),
                                field('Text at', t.at + 1, 4, t.textAt, 'Big-endian, from the start of the file.'),
                                field('Heading', t.at + 5, 1, JSON.stringify(t.section), 'Which heading it’s under. "0" is the briefing’s: its topics show the mission’s own picture and text.'),
                                field('Kind', t.at + 6, 1, t.heading ? '0: a heading' : '1: a topic'),
                                field('Name', t.at + 7, t.length - 8, JSON.stringify(t.name), 'Ending in a NUL.'),
                                field('Mission', t.at + t.length - 1, 1, t.mission, 'Listed from this mission on.'),
                            ],
                        }))
                    );
                if (c === desc) return chunkField(c, `${textFields.length} texts`, descFields);
                if (c === info)
                    return chunkField(c, `texts up to ${bytesLabel(readLength)}`, [
                        field('Unknown', c.start, 8, 'The game doesn’t read these.'),
                        field('Text length', c.start + 8, 4, bytesLabel(readLength), 'How much the game reads for a topic’s text. Big-endian.'),
                    ]);
                return chunkField(c, 'Not one the game reads', c.end > c.start ? [field('Data', c.start, c.end - c.start, bytesLabel(c.end - c.start))] : []);
            }),
        ];

        return {
            title: 'Mentat encyclopedia (Dune II)',
            summary: [
                ['Topics', `${topics.filter((t) => !t.heading).length} under ${topics.filter((t) => t.heading).length} headings`],
                ['Text', `${bytesLabel(desc.end - desc.start)}, compressed (${pairs.toLocaleString('en-US')} letter pairs)`],
            ],
            fields,
            preview: { kind: 'text', text: sections.join('\n\n') },
            // Past the FORM is nothing the file has; the usual checks look at it.
            end: Math.max(chunksEnd, formEnd),
            warnings,
        };
    },
};

export default parser;
