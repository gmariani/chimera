import { bytesLabel, fillGaps } from '../../core/bytes';
import { maxOf } from '../../core/math';
import type { Entry, FormatParser, Preview } from '../../core/types';
import { readPictures } from './pictures';
import { sniffShg } from './sniff';

/**
 * Windows Help's pictures on their own: SHG files (made by the Hotspot Editor, SHED: a picture with hotspots) and MRB
 * files (made by MRBC: one picture at several resolutions), and pictures saved from a help file. See pictures.ts.
 */
const parser: FormatParser = {
    parse(data, context) {
        if (!sniffShg(data)) throw new Error('This isn’t a Windows Help picture: it doesn’t start with "lP" or "lp" and a picture that fits.');
        const r = readPictures(data, 0, data.length, 'The picture');
        if (!r.pictures.length) throw new Error(`This isn’t a Windows Help picture: ${r.problems[0] ?? 'it holds none'}`);
        const stem = (context.name ?? context.label ?? 'picture').replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '');
        const several = r.pictures.length > 1;
        const items: { title: string; preview: Preview }[] = r.pictures
            .filter((p) => p.rgba)
            .map((p) => ({
                title: `${p.width} × ${p.height}, ${p.about}${p.hotspots.length ? `, ${p.hotspots.length} hotspot${p.hotspots.length === 1 ? '' : 's'}` : ''}`,
                preview: { kind: 'picture', width: p.width, height: p.height, rgba: p.rgba! },
            }));
        const hotspots = r.pictures.flatMap((p, i) =>
            p.hotspots.map((h) => ({ group: several ? `Picture ${i + 1}` : 'Hotspots', cells: { kind: h.kind, name: h.name, target: h.target, place: `${h.x}, ${h.y}, ${h.width} × ${h.height}` } }))
        );
        if (hotspots.length)
            items.push({
                title: 'Hotspots',
                preview: {
                    kind: 'table',
                    columns: [
                        { key: 'kind', label: 'Kind' },
                        { key: 'name', label: 'Name' },
                        { key: 'target', label: 'Leads to' },
                        { key: 'place', label: 'Where' },
                    ],
                    groups: [...new Set(hotspots.map((h) => h.group))],
                    rows: hotspots,
                },
            });
        const entries: Entry[] = r.pictures.flatMap((p, i) =>
            p.file ? [{ name: null, label: `${stem}${several ? `-${i + 1}` : ''}.${p.kind === 'bitmap' ? 'bmp' : 'wmf'}`, offset: 0, size: p.file.length, data: p.file }] : []
        );
        const end = maxOf(r.fields.map((f) => f.offset + f.length));
        return {
            title: several ? 'Windows Help picture at several resolutions (MRB)' : 'Windows Help picture (SHG)',
            summary: [
                ['Pictures', r.pictures.map((p) => `${p.width} × ${p.height}, ${p.about}`).join('; ')],
                ...(hotspots.length ? [['Hotspots', `${hotspots.length}`] as [string, string]] : []),
                ['Size', bytesLabel(data.length)],
            ],
            fields: fillGaps(data, r.fields, 0, end, 'Not pointed to'),
            preview: items.length === 1 ? items[0].preview : items.length ? { kind: 'stack', items } : undefined,
            entries,
            end,
            warnings: r.problems,
        };
    },
};

export default parser;
