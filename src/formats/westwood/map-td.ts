import { field } from '../../core/bytes';
import type { FormatParser } from '../../core/types';
import { Ini } from '../ini-sections';
import { Links } from '../links';
import { missionPreviews, tdMission, TD_SIZE } from './map';
import { TD_TEMPLATES } from './templates';

/**
 * TD map terrain (.bin, next to the mission's .ini): 64 × 64 cells, row by
 * row, two bytes each: the template, then which of its tiles. 0xFF is clear
 * ground. The INI says which part of the grid is playable, the theater, and
 * where the Tiberium, walls and trees are; it's used when the user has opened
 * the archive it's in.
 *
 * A cell naming a tile its template doesn't have is said, and drawn as clear
 * ground, as OpenRA's importer does (its ReplaceInvalidTerrainTiles). One map
 * the game ships has three: SCB07EC.BIN, where the text "0,,Mar" is written over
 * cells outside the playable area.
 */

/** How many tiles a template has, from its size; template 0 (clear) has 16, the game picking one by the cell's place. */
function tileCount(id: number): number | null {
    if (id === 0) return 16;
    const t = TD_TEMPLATES[id];
    return t?.width && t.height ? t.width * t.height : null;
}

/** The cells that name a template TD doesn't have, or a tile their template doesn't have. */
function badCells(data: Uint8Array): number[] {
    const bad: number[] = [];
    for (let cell = 0; cell < TD_SIZE * TD_SIZE; cell++) {
        const id = data[cell * 2];
        if (id === 0xff) continue;
        const count = tileCount(id);
        if (count === null || data[cell * 2 + 1] >= count) bad.push(cell);
    }
    return bad;
}

/** A cell's template and tile, as a person reads them. */
function describe(id: number, tile: number): string {
    const count = tileCount(id);
    const name = TD_TEMPLATES[id]?.name ?? `Template ${id}`;
    if (count === null) return `${name} (not a template TD has), tile ${tile}`;
    return tile >= count ? `${name}, tile ${tile}: not one of its ${count} tiles` : `${name}, tile ${tile}`;
}

/** What's wrong with the bad cells, where they are, and what their bytes say when they read as text. */
function badCellWarning(data: Uint8Array, bad: number[], area: { x: number; y: number; width: number; height: number } | undefined): string | null {
    if (!bad.length) return null;
    const at = (cell: number) => `(${cell % TD_SIZE}, ${Math.floor(cell / TD_SIZE)})`;
    const listed = bad.slice(0, 6).map((cell) => `${at(cell)} ${describe(data[cell * 2], data[cell * 2 + 1])}`);
    const more = bad.length > listed.length ? `, and ${(bad.length - listed.length).toLocaleString('en-US')} more` : '';
    const inside = area
        ? bad.filter((cell) => {
              const [x, y] = [cell % TD_SIZE, Math.floor(cell / TD_SIZE)];
              return x >= area.x && x < area.x + area.width && y >= area.y && y < area.y + area.height;
          }).length
        : null;
    const where =
        inside === null
            ? ''
            : inside === 0
              ? ' All are outside the playable area, so the game never shows them.'
              : inside === bad.length
                ? ' All are inside the playable area.'
                : ` ${inside.toLocaleString('en-US')} are inside the playable area.`;
    // Stray bytes are often text from somewhere else (an editor's buffer): when the cells run on and read as text, say what it says.
    const run = bad.every((cell, i) => i === 0 || cell === bad[i - 1] + 1);
    const bytes = run ? data.subarray(bad[0] * 2, bad[bad.length - 1] * 2 + 2) : null;
    const text = bytes && bytes.length <= 64 && bytes.every((b) => b >= 0x20 && b < 0x7f) ? ` Their bytes read as the text "${new TextDecoder('latin1').decode(bytes)}".` : '';
    const count = bad.length === 1 ? 'A cell names' : `${bad.length.toLocaleString('en-US')} cells name`;
    return `${count} a tile its template doesn't have: ${listed.join('; ')}${more}.${where}${text} They're drawn as clear ground.`;
}
const parser: FormatParser = {
    parse(data, context) {
        if (data.length !== TD_SIZE * TD_SIZE * 2) throw new Error(`A TD map is ${TD_SIZE * TD_SIZE * 2} bytes; this is ${data.length}.`);
        const iniName = context.name ? `${context.name.replace(/\.[^.]+$/, '')}.ini` : null;
        // RA has missions of the same names; TD's are the ones without a packed map.
        const links = new Links();
        const found = iniName ? context.find?.(iniName).find((c) => ((ini) => !ini.section('MapPack') && ini.section('Map'))(Ini.of(c.data))) : undefined;
        const companion = found ? Ini.of(found.data) : undefined;
        if (found) links.use(iniName!, found, 'Mission (playable area, theater, Tiberium, trees)');
        else if (iniName) links.miss(iniName, 'Mission (next to this file)');
        const mission = tdMission(data, companion ?? null);
        const map = missionPreviews(mission, companion ? context.find : undefined, links);
        const used = new Set(Array.from(mission.templates).filter((t) => t !== 0xff));
        const bad = badCells(data);
        const badWarning = badCellWarning(data, bad, mission.area);

        return {
            title: 'Map terrain (TD)',
            summary: [['Templates used', String(used.size)], ...map.summary],
            fields: Array.from({ length: TD_SIZE }, (_, y) => ({
                name: `Row ${y}`,
                offset: y * TD_SIZE * 2,
                length: TD_SIZE * 2,
                children: Array.from({ length: TD_SIZE }, (_, x) => {
                    const at = (y * TD_SIZE + x) * 2;
                    const id = data[at];
                    return field(`Cell ${x}, ${y}`, at, 2, id === 0xff ? 'Clear' : describe(id, data[at + 1]));
                }),
            })),
            preview: map.items.length === 1 ? map.items[0].preview : { kind: 'stack', items: map.items },
            wanted: companion
                ? map.wanted
                : `${iniName ? iniName.toUpperCase() : "The mission's INI"} says which part of the map is playable, its theater, and where the Tiberium and trees are. Open the archive it's in to see them here.`,
            links: links.list,
            warnings: badWarning ? [badWarning, ...map.warnings] : map.warnings,
        };
    },
};

export default parser;
