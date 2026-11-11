import type { Companion, Preview, TableColumn, TableRow } from '../core/types';
import { Ini } from './ini-sections';
import type { Links } from './links';
import { readCsf } from './westwood/csf-strings';

/**
 * The units and buildings a rules.ini defines, as a table: what each is called,
 * costs and takes to destroy, and its art, linked to the sprite or voxel model.
 *
 * TS and RA2 list every object in [InfantryTypes], [VehicleTypes],
 * [AircraftTypes] and [BuildingTypes]; RA's rules.ini has no lists, so there
 * any section with a Strength and a Cost or TechLevel counts. Art comes from
 * art.ini (Image=, Voxel=yes, NewTheater=yes, Cameo=), names from the string
 * table (UIName=, in RA2) or Name=.
 */

const LISTS: [string, string][] = [
    ['InfantryTypes', 'Infantry'],
    ['VehicleTypes', 'Vehicles'],
    ['AircraftTypes', 'Aircraft'],
    ['BuildingTypes', 'Buildings'],
];

const COLUMNS: TableColumn[] = [
    { key: 'id', label: 'ID' },
    { key: 'name', label: 'Name' },
    { key: 'cost', label: 'Cost', numeric: true },
    { key: 'strength', label: 'Strength', numeric: true },
    { key: 'speed', label: 'Speed', numeric: true },
    { key: 'tech', label: 'Tech level', numeric: true },
    { key: 'owner', label: 'Owner' },
    { key: 'primary', label: 'Weapon' },
    { key: 'art', label: 'Art' },
    { key: 'cameo', label: 'Sidebar icon' },
];

/** Theater letters NewTheater art swaps into the second letter of its name. */
const THEATER_LETTERS = ['t', 'a', 'u', 'd', 'l', 'n', 'g'];
const THEATER_EXTENSIONS = ['tem', 'sno', 'urb', 'des', 'lun', 'ubn'];

type Finder = (name: string) => Companion[];

export function rulesTable(ini: Ini, fileName: string | null, find: Finder | undefined, links: Links): { preview: Preview; summary: [string, string][] } | null {
    const yuri = /md\.ini$/i.test(fileName ?? '');
    const groups: [string, string[]][] = LISTS.map(([list, group]) => [
        group,
        [
            ...new Set(
                ini
                    .entries(list)
                    .map(([, v]) => v.trim())
                    .filter(Boolean)
            ),
        ],
    ]);
    let listed = groups.some(([, ids]) => ids.length);
    if (!listed) {
        const objects = ini.sections.filter((s) => {
            const keys = new Set(s.entries.map((e) => e.key.toLowerCase()));
            return keys.has('strength') && (keys.has('cost') || keys.has('techlevel'));
        });
        if (!objects.length) return null;
        groups.length = 0;
        groups.push(['Objects', objects.map((s) => s.name)]);
    }

    /** The first of these companions in the session, recorded under the role. */
    const pick = (names: string[], role: string) => {
        for (const n of names) {
            const found = find?.(n)[0];
            if (found) {
                links.use(n, found, role);
                return found;
            }
        }
        if (find) links.miss(names[0], role);
        return undefined;
    };
    const artFile = listed ? pick(yuri ? ['artmd.ini', 'art.ini'] : ['art.ini', 'artmd.ini'], 'Art (which picture each object uses)') : undefined;
    const art = artFile ? Ini.of(artFile.data) : null;
    const csfFile = listed ? (yuri ? (find?.('ra2md.csf')[0] ?? find?.('ra2.csf')[0]) : find?.('ra2.csf')[0]) : undefined;
    if (csfFile) links.use(yuri ? 'ra2md.csf' : 'ra2.csf', csfFile, 'Names (UIName=)');
    const strings = csfFile ? readCsf(csfFile.data) : null;
    const exists = (name: string) => (find?.(name).length ?? 0) > 0;

    const rows: TableRow[] = [];
    for (const [group, ids] of groups) {
        for (const id of ids) {
            const get = (key: string) => ini.get(id, key);
            const image = (get('Image') ?? art?.get(id, 'Image') ?? id).trim();
            const lower = image.toLowerCase();
            const voxel = /^(yes|true|1)$/i.test(art?.get(image, 'Voxel') ?? get('Voxel') ?? '');
            // RA has no art.ini: each object's sprite is named after it.
            const artFiles = !listed
                ? [`${lower}.shp`, ...THEATER_EXTENSIONS.map((e) => `${lower}.${e}`)]
                : voxel
                  ? [`${lower}.vxl`]
                  : [`${lower}.shp`, ...(lower.length > 2 ? THEATER_LETTERS.map((t) => `${lower[0]}${t}${lower.slice(2)}.shp`) : []), ...THEATER_EXTENSIONS.map((e) => `${lower}.${e}`)];
            const cameo = art?.get(image, 'Cameo') ?? art?.get(id, 'Cameo');
            const cameoFiles = cameo ? [`${cameo.toLowerCase()}.shp`, `${cameo.toLowerCase()}.pcx`] : !listed ? [`${lower}icon.shp`] : [];
            const label = (files: string[]) => files.find(exists) ?? (files[0] ? `${files[0]} (not in the files in use)` : '');
            const uiName = get('UIName');
            const name = (uiName && strings?.get(uiName.toLowerCase())) ?? get('Name') ?? '';
            rows.push({
                group,
                cells: {
                    id,
                    name,
                    cost: get('Cost') ?? '',
                    strength: get('Strength') ?? '',
                    speed: get('Speed') ?? '',
                    tech: get('TechLevel') ?? '',
                    owner: get('Owner') ?? '',
                    primary: get('Primary') ?? '',
                    art: label(artFiles),
                    cameo: cameoFiles.length ? label(cameoFiles) : '',
                },
                files: { art: artFiles, cameo: cameoFiles },
            });
        }
    }
    const counts = groups.map(([group, ids]) => [group, String(ids.length)] as [string, string]).filter(([, n]) => n !== '0');
    return {
        preview: { kind: 'table', columns: COLUMNS, groups: groups.map(([g]) => g).filter((g) => rows.some((r) => r.group === g)), rows },
        summary: counts,
    };
}
