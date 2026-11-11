import { bytesLabel, field, hex } from '../../core/bytes';
import type { Entry, Field, FormatParser } from '../../core/types';
import { pakLayout } from './pak-layout';

/** Westwood PAK archives; the layout, and what makes bytes one, are in pak-layout.ts (which the sniffers use without loading this). */
const GAMES = { 1: 'Eye of the Beholder', 2: 'Dune II, Legend of Kyrandia', 3: 'Legend of Kyrandia 2 and 3, Lands of Lore' };

const parser: FormatParser = {
    parse(data) {
        const layout = pakLayout(data);
        if (!layout) throw new Error("This isn't a Westwood PAK: its offsets and names don't make a list of files that fits the archive.");
        const { version, headerEnd, header, files, end, badEnd } = layout;
        const warnings: string[] = [];
        if (badEnd !== null)
            warnings.push(
                `The end offset (${badEnd.toLocaleString('en-US')}) can't be where the last file ends, so the archive's own end is used. Eye of the Beholder's archives often have this: the game kept its own table of sizes.`
            );

        const entries: Entry[] = files.map((f, i) => {
            const next = i + 1 < files.length ? files[i + 1].offset : end;
            return { name: f.name, label: f.name, offset: f.offset, size: next - f.offset, data: data.subarray(f.offset, next), meta: { Offset: hex(f.offset, 8) } };
        });

        // A name listed twice: the game only finds the first. Copies that differ are worth a look (a second file hiding behind a name).
        const byName = new Map<string, Entry[]>();
        for (const e of entries) byName.set(e.name!.toLowerCase(), [...(byName.get(e.name!.toLowerCase()) ?? []), e]);
        for (const [, same] of byName) {
            if (same.length < 2) continue;
            const identical = same.every((e) => e.size === same[0].size && e.data.every((v, i) => v === same[0].data[i]));
            warnings.push(
                `${same[0].name} is listed ${same.length} times (at ${same.map((e) => e.offset.toLocaleString('en-US')).join(', ')}); the game only finds the first. ${identical ? 'The copies are identical.' : 'The copies differ, so the later ones are never used.'}`
            );
        }
        const empty = entries.filter((e) => e.size === 0).length;
        if (empty) warnings.push(`${empty} file${empty === 1 ? ' is' : 's are'} empty (0 bytes).`);

        const headerFields: Field[] = header.map((e, i) => {
            if (e.kind === 'zero') return field('End of the list', e.at, 4, '0');
            const isEnd = e.kind === 'end';
            return {
                name: isEnd ? 'End marker' : `Entry ${i + 1}`,
                offset: e.at,
                length: e.length,
                value: isEnd ? `the last file ends at ${e.offset.toLocaleString('en-US')}` : e.name,
                children: [
                    field('Offset', e.at, 4, e.offset, isEnd ? 'Where the last file ends.' : 'Where the file starts.'),
                    field('Name', e.at + 4, e.length - 4, isEnd ? '(empty)' : JSON.stringify(e.name), 'NUL-terminated.'),
                ],
            };
        });

        return {
            title: `Westwood PAK archive (version ${version})`,
            summary: [
                ['Version', `${version} (${GAMES[version]})`],
                ['Files', entries.length.toLocaleString('en-US')],
                ['Header', bytesLabel(headerEnd)],
            ],
            fields: [
                { name: 'Header', offset: 0, length: headerEnd, value: `${entries.length} file${entries.length === 1 ? '' : 's'}`, children: headerFields },
                { name: 'Files', offset: headerEnd, length: end - headerEnd, value: bytesLabel(end - headerEnd), children: entries.map((e) => field(e.label, e.offset, e.size, bytesLabel(e.size))) },
            ],
            entries,
            // Past the last file is nothing the archive lists (only versions 1 and 3 can have that); the usual checks look at it.
            end,
            warnings,
        };
    },
};

export default parser;
