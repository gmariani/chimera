import type { FormatDescriptor, FormatParser } from '../core/types';
import { sniffMix, sniffXccDatabase } from './mix/sniff';
import {
    sniffAud,
    sniffCps,
    sniffFont,
    sniffIni,
    sniffMapTd,
    sniffPal,
    sniffPcx,
    sniffShpD2,
    sniffShpTd,
    sniffShpTs,
    sniffText,
    sniffTiles,
    sniffVqa,
    sniffVqp,
    sniffWsa,
} from './westwood/sniff';

/**
 * Every format the app knows. The sniffers are small and always loaded; each
 * parser loads the first time a file of its type is opened. To add a format,
 * add an entry here.
 */
const parserOf = (load: () => Promise<{ default: FormatParser }>) => () => load().then((m) => m.default);

/** In order of how sure a successful sniff is: text matches almost anything, so it's last. */
export const FORMATS: FormatDescriptor[] = [
    { id: 'mix', name: 'Westwood MIX archive', extensions: ['mix'], sniff: sniffMix, load: parserOf(() => import('./mix')) },
    { id: 'shp-td', name: 'Sprite (TD/RA SHP)', extensions: ['shp'], sniff: sniffShpTd, load: parserOf(() => import('./westwood/shp-td')) },
    { id: 'shp-ts', name: 'Sprite (TS/RA2 SHP)', extensions: ['shp'], sniff: sniffShpTs, load: parserOf(() => import('./westwood/shp-ts')) },
    { id: 'shp-d2', name: 'Sprite (Dune II-style SHP)', extensions: ['shp'], sniff: sniffShpD2, load: parserOf(() => import('./westwood/shp-d2')) },
    { id: 'aud', name: 'Westwood audio', extensions: ['aud', 'juv', 'v00', 'v01', 'v02', 'v03', 'r00', 'r01', 'r02', 'r03'], sniff: sniffAud, load: parserOf(() => import('./westwood/aud')) },
    { id: 'cps', name: 'Picture (CPS)', extensions: ['cps'], sniff: sniffCps, load: parserOf(() => import('./westwood/cps')) },
    { id: 'vqa', name: 'Video (VQA)', extensions: ['vqa'], sniff: sniffVqa, load: parserOf(() => import('./westwood/vqa')) },
    { id: 'tiles', name: 'Tile set', extensions: ['tem', 'des', 'win', 'sno', 'int', 'jun', 'icn'], sniff: sniffTiles, load: parserOf(() => import('./westwood/tiles')) },
    { id: 'wsa', name: 'Animation (WSA)', extensions: ['wsa'], sniff: sniffWsa, load: parserOf(() => import('./westwood/wsa')) },
    { id: 'fnt', name: 'Font', extensions: ['fnt'], sniff: sniffFont, load: parserOf(() => import('./westwood/font')) },
    { id: 'pcx', name: 'Picture (PCX)', extensions: ['pcx'], sniff: sniffPcx, load: parserOf(() => import('./pcx')) },
    { id: 'vqp', name: 'Palette blending tables (VQP)', extensions: ['vqp'], sniff: sniffVqp, load: parserOf(() => import('./westwood/vqp')) },
    { id: 'xcc-names', name: 'File names (XCC)', extensions: ['dat'], sniff: sniffXccDatabase, byNameAlone: false, load: parserOf(() => import('./mix/database')) },
    { id: 'pal', name: 'Palette', extensions: ['pal'], sniff: sniffPal, load: parserOf(() => import('./westwood/pal')) },
    { id: 'map-td', name: 'Map terrain (TD)', extensions: ['bin'], sniff: sniffMapTd, byNameAlone: false, load: parserOf(() => import('./westwood/map-td')) },
    { id: 'ini', name: 'Settings (INI)', extensions: ['ini'], sniff: sniffIni, load: parserOf(() => import('./ini')) },
    { id: 'text', name: 'Text', extensions: ['txt', 'ini', 'eng', 'ger', 'fre', 'csv'], sniff: sniffText, load: parserOf(() => import('./text')) },
];

export const RAW: FormatDescriptor = { id: 'raw', name: 'Unrecognised', extensions: ['bin'], sniff: () => true, load: parserOf(() => import('./raw')) };

/** The default extension to save a file of this format under. */
export function extensionOf(format: FormatDescriptor): string {
    return format.extensions[0];
}

function extension(name: string | null): string | null {
    const match = name?.match(/\.([^./\\]+)$/);
    return match ? match[1].toLowerCase() : null;
}

/**
 * Picks a format by content, using the name to choose between formats that
 * both match (or when none do).
 */
export function detect(data: Uint8Array, name: string | null): FormatDescriptor {
    const ext = extension(name);
    const byName = (f: FormatDescriptor) => ext !== null && f.extensions.includes(ext);
    const sniffed = FORMATS.filter((f) => {
        try {
            return f.sniff(data);
        } catch {
            return false;
        }
    });
    return sniffed.find(byName) ?? sniffed[0] ?? FORMATS.find((f) => f.byNameAlone !== false && byName(f)) ?? RAW;
}
