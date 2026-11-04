import type { Field, FormatParser, Preview } from '../core/types';
import { Ini } from './ini-sections';
import { missionPreviews, raMission, tdMission, TD_SIZE, type Mission } from './westwood/map';

/**
 * INI files: sections of key=value lines. Red Alert missions also pack the
 * map into two sections, [MapPack] and [OverlayPack], which are decoded here.
 * Tiberian Dawn missions keep their map in a .bin file of the same name, which
 * is used when it's in an archive the user has opened.
 */

const parser: FormatParser = {
    parse(data, context) {
        const text = new TextDecoder('latin1').decode(data);
        const ini = new Ini(text);
        const found = ini.sections;
        const warnings: string[] = [];

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
        let wanted: string | undefined;

        let mission: Mission | null = null;
        let title = 'Settings (INI)';
        if (ini.section('MapPack')) {
            title = 'Mission (RA INI with map)';
            try {
                mission = raMission(ini);
            } catch (e) {
                warnings.push(`The [MapPack] section couldn't be decoded: ${e instanceof Error ? e.message : e}`);
            }
        } else if (ini.get('Map', 'Theater') && context.name) {
            title = 'Mission (TD INI)';
            const bin = `${context.name.replace(/\.[^.]+$/, '')}.bin`;
            const map = context.find?.(bin).find((c) => c.data.length === TD_SIZE * TD_SIZE * 2);
            if (map) mission = tdMission(map.data, ini);
            else wanted = `The map is in ${bin.toUpperCase()}, next to this file. Open the archive that has it to see the map here.`;
        }
        if (mission) {
            const map = missionPreviews(mission, context.find);
            summary.push(...map.summary);
            warnings.push(...map.warnings);
            previews.push(...map.items);
            wanted = map.wanted;
        }
        previews.push({ title: 'Text', preview: { kind: 'text', text } });

        return {
            title,
            summary,
            fields,
            preview: previews.length === 1 ? previews[0].preview : { kind: 'stack', items: previews },
            wanted,
            warnings,
        };
    },
};

export default parser;
