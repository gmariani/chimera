import type { Field, FormatParser, Preview } from '../core/types';
import { renderMap, terrainPalette, unpackSection } from './westwood/map';

/**
 * INI files: sections of key=value lines. Red Alert missions also pack the
 * map into two sections, [MapPack] and [OverlayPack], which are decoded here.
 */

interface Section {
    name: string;
    offset: number;
    length: number;
    entries: { key: string; value: string; offset: number; length: number }[];
}

/** Byte offsets assume one byte per character, which holds for these Latin-1 files. */
function sections(text: string): Section[] {
    const out: Section[] = [];
    let offset = 0;
    for (const raw of text.split('\n')) {
        const line = raw.replace(/\r$/, '');
        const content = line.replace(/;.*$/, '').trim();
        const header = content.match(/^\[(.+)\]$/);
        if (header) {
            out.push({ name: header[1], offset, length: 0, entries: [] });
        } else if (content && out.length) {
            const eq = content.indexOf('=');
            if (eq > 0) out.at(-1)!.entries.push({ key: content.slice(0, eq).trim(), value: content.slice(eq + 1).trim(), offset, length: line.length });
        }
        offset += raw.length + 1;
        if (out.length) out.at(-1)!.length = Math.min(offset, text.length) - out.at(-1)!.offset;
    }
    return out;
}

const RA_SIZE = 128;

const parser: FormatParser = {
    parse(data) {
        const text = new TextDecoder('latin1').decode(data);
        const found = sections(text);
        const warnings: string[] = [];
        const byName = (name: string) => found.find((s) => s.name.toLowerCase() === name.toLowerCase());
        const joined = (s: Section) => s.entries.map((e) => e.value).join('');

        const fields: Field[] = found.map((s) => ({
            name: `[${s.name}]`,
            offset: s.offset,
            length: s.length,
            value: `${s.entries.length} entr${s.entries.length === 1 ? 'y' : 'ies'}`,
            children: s.entries.slice(0, 2000).map((e) => ({ name: e.key, offset: e.offset, length: e.length, value: e.value.length > 80 ? `${e.value.slice(0, 80)}…` : e.value })),
        }));

        const summary: [string, string][] = [
            ['Sections', String(found.length)],
            ['Entries', String(found.reduce((n, s) => n + s.entries.length, 0))],
        ];
        const previews: { title: string; preview: Preview }[] = [];

        const mapPack = byName('MapPack');
        if (mapPack) {
            try {
                const cells = RA_SIZE * RA_SIZE;
                const raw = unpackSection(joined(mapPack), cells * 3);
                const templates = new Uint16Array(cells);
                for (let i = 0; i < cells; i++) templates[i] = raw[i * 2] | (raw[i * 2 + 1] << 8);
                const overlayPack = byName('OverlayPack');
                const overlays = overlayPack ? unpackSection(joined(overlayPack), cells) : undefined;
                // The preview shows the playable part, which [Map] gives in cells.
                const mapSection = byName('Map');
                const [x, y, width, height] = ['X', 'Y', 'Width', 'Height'].map((k) => Number(mapSection?.entries.find((e) => e.key.toLowerCase() === k.toLowerCase())?.value));
                const playable = width > 0 && height > 0 && x + width <= RA_SIZE && y + height <= RA_SIZE;
                const area = playable ? { x, y, width, height } : undefined;
                const { image, counts, unknown } = renderMap({ game: 'ra', size: RA_SIZE, templates, overlays, area });
                if (unknown) warnings.push(`${unknown} map cells use templates the game doesn't define.`);
                summary.push(['Map', `${RA_SIZE} × ${RA_SIZE} cells${playable ? `, playable ${width} × ${height} at ${x}, ${y} (shown)` : ''}`]);
                const theater = mapSection?.entries.find((e) => e.key.toLowerCase() === 'theater')?.value;
                if (theater) summary.push(['Theater', theater]);
                summary.push(...counts.map(([label, n]) => [label, `${n} cells`] as [string, string]));
                previews.push({ title: 'Map', preview: { kind: 'images', frames: [image], palette: terrainPalette() } });
            } catch (e) {
                warnings.push(`The [MapPack] section couldn't be decoded: ${e instanceof Error ? e.message : e}`);
            }
        }
        previews.push({ title: 'Text', preview: { kind: 'text', text } });

        return {
            title: mapPack ? 'Mission (RA INI with map)' : 'Settings (INI)',
            summary,
            fields,
            preview: previews.length === 1 ? previews[0].preview : { kind: 'stack', items: previews },
            warnings,
        };
    },
};

export default parser;
