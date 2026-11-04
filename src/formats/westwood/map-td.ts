import { field } from '../../core/bytes';
import type { FormatParser } from '../../core/types';
import { Ini } from '../ini-sections';
import { missionPreviews, tdMission, TD_SIZE } from './map';
import { TD_TEMPLATES } from './templates';

/**
 * TD map terrain (.bin, next to the mission's .ini): 64 × 64 cells, row by
 * row, two bytes each: the template, then which of its tiles. 0xFF is clear
 * ground. The INI says which part of the grid is playable, the theater, and
 * where the Tiberium, walls and trees are; it's used when the user has opened
 * the archive it's in.
 */
const parser: FormatParser = {
    parse(data, context) {
        if (data.length !== TD_SIZE * TD_SIZE * 2) throw new Error(`A TD map is ${TD_SIZE * TD_SIZE * 2} bytes; this is ${data.length}.`);
        const iniName = context.name ? `${context.name.replace(/\.[^.]+$/, '')}.ini` : null;
        // RA has missions of the same names; TD's are the ones without a packed map.
        const companion = iniName ? context.find?.(iniName).map((c) => Ini.of(c.data)).find((ini) => !ini.section('MapPack') && ini.section('Map')) : undefined;
        const mission = tdMission(data, companion ?? null);
        const map = missionPreviews(mission, companion ? context.find : undefined);
        const used = new Set(Array.from(mission.templates).filter((t) => t !== 0xff));

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
                    return field(`Cell ${x}, ${y}`, at, 2, id === 0xff ? 'Clear' : `${TD_TEMPLATES[id]?.name ?? `Template ${id}`}, tile ${data[at + 1]}`);
                }),
            })),
            preview: map.items.length === 1 ? map.items[0].preview : { kind: 'stack', items: map.items },
            wanted: companion
                ? map.wanted
                : `${iniName ? iniName.toUpperCase() : 'The mission\'s INI'} says which part of the map is playable, its theater, and where the Tiberium and trees are. Open the archive it's in to see them here.`,
            warnings: map.warnings,
        };
    },
};

export default parser;
