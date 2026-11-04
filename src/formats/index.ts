import type { FormatDescriptor, FormatParser } from '../core/types';
import { sniffMix, sniffXccDatabase } from './mix/sniff';
import {
    sniffAud,
    sniffBink,
    sniffCsf,
    sniffGaba,
    sniffUnicodeFont,
    sniffCps,
    sniffFont,
    sniffIni,
    sniffMapTd,
    sniffPal,
    sniffPcx,
    sniffShpD2,
    sniffShpTd,
    sniffShpTs,
    sniffStrings,
    sniffText,
    sniffTiles,
    sniffTmp,
    sniffVqa,
    sniffHva,
    sniffVortex,
    sniffVpl,
    sniffVxl,
    sniffWav,
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
    { id: 'tmp', name: 'Isometric tiles (TS/RA2)', extensions: ['tmp', 'tem', 'sno', 'urb', 'des', 'lun', 'ubn'], sniff: sniffTmp, load: parserOf(() => import('./westwood/tmp')) },
    { id: 'vxl', name: 'Voxel model (TS/RA2)', extensions: ['vxl'], sniff: sniffVxl, companions: true, load: parserOf(() => import('./westwood/vxl')) },
    { id: 'vpl', name: 'Voxel lighting tables (VPL)', extensions: ['vpl'], sniff: sniffVpl, load: parserOf(() => import('./westwood/vpl')) },
    { id: 'hva', name: 'Voxel animation (HVA)', extensions: ['hva'], sniff: sniffHva, load: parserOf(() => import('./westwood/hva')) },
    { id: 'wav', name: 'Sound (WAV)', extensions: ['wav'], sniff: sniffWav, load: parserOf(() => import('./wav')) },
    { id: 'csf', name: 'String table (CSF)', extensions: ['csf'], sniff: sniffCsf, load: parserOf(() => import('./westwood/csf')) },
    { id: 'gaba', name: 'Sound bank index (GABA)', extensions: ['idx'], sniff: sniffGaba, companions: true, load: parserOf(() => import('./westwood/gaba')) },
    { id: 'bag', name: 'Sound bank data (RA2)', extensions: ['bag'], sniff: () => false, load: parserOf(() => import('./westwood/bag')) },
    {
        id: 'bink',
        name: 'Bink video',
        extensions: ['bik'],
        sniff: sniffBink,
        // The decoders (WebAssembly) load with the parser.
        load: parserOf(() => import('./westwood/bink').then(async (m) => (await m.ready(), m))),
    },
    { id: 'fnt-ts', name: 'Font (TS/RA2, 1-bit)', extensions: ['fnt'], sniff: sniffUnicodeFont, byNameAlone: false, load: parserOf(() => import('./westwood/font-ts')) },
    { id: 'tiles', name: 'Tile set', extensions: ['tem', 'des', 'win', 'sno', 'int', 'jun', 'icn'], sniff: sniffTiles, load: parserOf(() => import('./westwood/tiles')) },
    { id: 'wsa', name: 'Animation (WSA)', extensions: ['wsa'], sniff: sniffWsa, load: parserOf(() => import('./westwood/wsa')) },
    { id: 'fnt', name: 'Font', extensions: ['fnt'], sniff: sniffFont, load: parserOf(() => import('./westwood/font')) },
    { id: 'pcx', name: 'Picture (PCX)', extensions: ['pcx'], sniff: sniffPcx, load: parserOf(() => import('./pcx')) },
    { id: 'vqp', name: 'Palette blending tables (VQP)', extensions: ['vqp'], sniff: sniffVqp, load: parserOf(() => import('./westwood/vqp')) },
    { id: 'xcc-names', name: 'File names (XCC)', extensions: ['dat'], sniff: sniffXccDatabase, byNameAlone: false, load: parserOf(() => import('./mix/database')) },
    { id: 'strings', name: 'String table', extensions: ['eng', 'ger', 'fre', 'ita', 'spa'], sniff: sniffStrings, load: parserOf(() => import('./westwood/strings')) },
    { id: 'lut', name: 'Chronal vortex frame (RA)', extensions: ['lut'], sniff: sniffVortex, load: parserOf(() => import('./westwood/lut')) },
    { id: 'mrf', name: 'Colour remap tables', extensions: ['mrf'], sniff: () => false, load: parserOf(() => import('./westwood/mrf')) },
    { id: 'pal', name: 'Palette', extensions: ['pal'], sniff: sniffPal, load: parserOf(() => import('./westwood/pal')) },
    { id: 'map-td', name: 'Map terrain (TD)', extensions: ['bin'], sniff: sniffMapTd, byNameAlone: false, companions: true, load: parserOf(() => import('./westwood/map-td')) },
    { id: 'ini', name: 'Settings (INI)', extensions: ['ini'], sniff: sniffIni, companions: true, load: parserOf(() => import('./ini')) },
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
