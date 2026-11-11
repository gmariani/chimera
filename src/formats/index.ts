import type { FormatDescriptor, FormatParser } from '../core/types';
import { sniffChunkFile } from './chunks/sniff';
import { sniffGif } from './gif/sniff';
import { sniffJpeg } from './jpeg/sniff';
import { sniffLoc, sniffMeg } from './meg/sniff';
import { sniffMix, sniffXccDatabase } from './mix/sniff';
import { sniffOgg } from './ogg/sniff';
import { sniffIco } from './ico-sniff';
import { sniffNe } from './ne-sniff';
import { sniffPif } from './pif-sniff';
import { sniffAil } from './ail-sniff';
import { sniffAdl } from './westwood/adl-layout';
import { sniffVoc } from './voc-sniff';
import { sniffTiff } from './tiff/sniff';
import { sniffPng } from './png/sniff';
import { sniffFont as sniffSfnt } from './font/sniff';
import { sniffMp3, sniffPbj, sniffSwf } from './swf/sniff';
import {
    sniffAud,
    sniffBink,
    sniffCsf,
    sniffGaba,
    sniffUnicodeFont,
    sniffCmp,
    sniffCps,
    sniffFont,
    sniffIcnD2,
    sniffIconMap,
    sniffEmc,
    sniffDuneCfg,
    sniffDuneOptions,
    sniffMentat,
    sniffIni,
    sniffMapTd,
    sniffPak,
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
/** The games name a theater's sprites (trees, ore, bibs) for the theater, as they do its tiles. */
const THEATERS = ['tem', 'sno', 'des', 'win', 'int', 'jun', 'urb', 'lun', 'ubn'];

const parserOf = (load: () => Promise<{ default: FormatParser }>) => () => load().then((m) => m.default);

/** In order of how sure a successful sniff is: text matches almost anything, so it's last. */
export const FORMATS: FormatDescriptor[] = [
    { id: 'mix', name: 'Westwood MIX archive', extensions: ['mix'], sniff: sniffMix, load: parserOf(() => import('./mix')) },
    { id: 'meg', name: 'Petroglyph MEG archive', extensions: ['meg'], sniff: sniffMeg, load: parserOf(() => import('./meg')) },
    // Chrome, Quake and others use .pak too, so the name alone says nothing.
    { id: 'pak', name: 'Westwood PAK archive', extensions: ['pak'], sniff: sniffPak, byNameAlone: false, load: parserOf(() => import('./westwood/pak')) },
    { id: 'shp-td', name: 'Sprite (TD/RA SHP)', extensions: ['shp'], alsoNamed: THEATERS, sniff: sniffShpTd, load: parserOf(() => import('./westwood/shp-td')) },
    { id: 'shp-ts', name: 'Sprite (TS/RA2 SHP)', extensions: ['shp'], alsoNamed: THEATERS, sniff: sniffShpTs, load: parserOf(() => import('./westwood/shp-ts')) },
    { id: 'shp-d2', name: 'Sprite (Dune II-style SHP)', extensions: ['shp'], sniff: sniffShpD2, load: parserOf(() => import('./westwood/shp-d2')) },
    { id: 'aud', name: 'Westwood audio', extensions: ['aud', 'juv', 'v00', 'v01', 'v02', 'v03', 'r00', 'r01', 'r02', 'r03'], sniff: sniffAud, load: parserOf(() => import('./westwood/aud')) },
    // Before CPS: an old CMP's RLE could look like a CPS header, but only a CMP decodes to exactly a picture.
    { id: 'cmp', name: 'Picture (CMP)', extensions: ['cmp'], sniff: sniffCmp, load: parserOf(() => import('./westwood/cmp')) },
    // Lands of Lore's .cmp sprites are CPS-style packed files.
    { id: 'cps', name: 'Picture or packed file (CPS)', extensions: ['cps', 'cmp'], sniff: sniffCps, load: parserOf(() => import('./westwood/cps')) },
    { id: 'vqa', name: 'Video (VQA)', extensions: ['vqa'], sniff: sniffVqa, load: parserOf(() => import('./westwood/vqa')) },
    { id: 'tmp', name: 'Isometric tiles (TS/RA2)', extensions: ['tmp', 'tem', 'sno', 'urb', 'des', 'lun', 'ubn'], sniff: sniffTmp, load: parserOf(() => import('./westwood/tmp')) },
    { id: 'vxl', name: 'Voxel model (TS/RA2)', extensions: ['vxl'], sniff: sniffVxl, companions: true, load: parserOf(() => import('./westwood/vxl')) },
    { id: 'vpl', name: 'Voxel lighting tables (VPL)', extensions: ['vpl'], sniff: sniffVpl, load: parserOf(() => import('./westwood/vpl')) },
    { id: 'hva', name: 'Voxel animation (HVA)', extensions: ['hva'], sniff: sniffHva, load: parserOf(() => import('./westwood/hva')) },
    { id: 'wav', name: 'Sound (WAV)', extensions: ['wav'], sniff: sniffWav, load: parserOf(() => import('./wav')) },
    { id: 'csf', name: 'String table (CSF)', extensions: ['csf'], sniff: sniffCsf, load: parserOf(() => import('./westwood/csf')) },
    { id: 'loc', name: 'Petroglyph string table (LOC)', extensions: ['loc'], sniff: sniffLoc, load: parserOf(() => import('./meg/loc')) },
    { id: 'gaba', name: 'Sound bank index (GABA)', extensions: ['idx'], sniff: sniffGaba, companions: true, load: parserOf(() => import('./westwood/gaba')) },
    { id: 'bag', name: 'Sound bank data (RA2)', extensions: ['bag'], sniff: () => false, load: parserOf(() => import('./westwood/bag')) },
    {
        id: 'bink',
        name: 'Bink video',
        extensions: ['bik', 'bk2'],
        sniff: sniffBink,
        // The decoders (WebAssembly) load with the parser.
        load: parserOf(() => import('./westwood/bink').then(async (m) => (await m.ready(), m))),
    },
    { id: 'fnt-ts', name: 'Font (1-bit: TS, RA2, Nox)', extensions: ['fnt'], sniff: sniffUnicodeFont, byNameAlone: false, load: parserOf(() => import('./westwood/font-ts')) },
    { id: 'icn-d2', name: 'Map tiles (Dune II ICN)', extensions: ['icn'], sniff: sniffIcnD2, load: parserOf(() => import('./westwood/icn-d2')) },
    { id: 'tiles', name: 'Tile set', extensions: ['tem', 'des', 'win', 'sno', 'int', 'jun', 'icn'], sniff: sniffTiles, load: parserOf(() => import('./westwood/tiles')) },
    // Coktel Vision's AdLib music is .adl too, so the name alone says nothing.
    { id: 'adl', name: 'AdLib music (Westwood ADL)', extensions: ['adl'], sniff: sniffAdl, byNameAlone: false, load: parserOf(() => import('./westwood/adl')) },
    { id: 'wsa', name: 'Animation (WSA)', extensions: ['wsa'], sniff: sniffWsa, load: parserOf(() => import('./westwood/wsa')) },
    { id: 'fnt', name: 'Font', extensions: ['fnt'], sniff: sniffFont, load: parserOf(() => import('./westwood/font')) },
    { id: 'jpeg', name: 'Picture (JPEG)', extensions: ['jpg', 'jpeg', 'jpe', 'jfif'], sniff: sniffJpeg, load: parserOf(() => import('./jpeg')) },
    { id: 'tiff', name: 'Picture (TIFF)', extensions: ['tif', 'tiff', 'dng', 'nef', 'cr2', 'arw', 'orf', 'pef', 'rw2'], sniff: sniffTiff, load: parserOf(() => import('./tiff')) },
    { id: 'gif', name: 'Picture (GIF)', extensions: ['gif'], sniff: sniffGif, load: parserOf(() => import('./gif')) },
    { id: 'png', name: 'Picture (PNG)', extensions: ['png', 'apng'], sniff: sniffPng, load: parserOf(() => import('./png')) },
    { id: 'swf', name: 'Flash movie (SWF)', extensions: ['swf'], sniff: sniffSwf, load: parserOf(() => import('./swf')) },
    { id: 'sfnt', name: 'Font (TrueType, OpenType)', extensions: ['ttf', 'otf', 'ttc', 'otc'], sniff: sniffSfnt, load: parserOf(() => import('./font')) },
    { id: 'pbj', name: 'Pixel Bender kernel (PBJ)', extensions: ['pbj'], sniff: sniffPbj, load: parserOf(() => import('./pbj')) },
    { id: 'mp3', name: 'Sound (MP3)', extensions: ['mp3', 'mp2'], sniff: sniffMp3, load: parserOf(() => import('./mp3')) },
    { id: 'ail', name: 'Sound driver (Miles AIL 2)', extensions: ['adv'], sniff: sniffAil, load: parserOf(() => import('./ail')) },
    { id: 'pif', name: 'Program information file (PIF)', extensions: ['pif'], sniff: sniffPif, load: parserOf(() => import('./pif')) },
    { id: 'ico', name: 'Icon or cursor (ICO, CUR)', extensions: ['ico', 'cur'], sniff: sniffIco, load: parserOf(() => import('./ico')) },
    // Other programs (PE, DOS) are named .exe and .dll too, so the name alone says nothing.
    {
        id: 'ne',
        name: '16-bit Windows module (NE)',
        extensions: ['exe', 'dll', 'drv', 'fon', 'icl', 'mod', 'cpl', 'scr'],
        sniff: sniffNe,
        byNameAlone: false,
        load: parserOf(() => import('./ne')),
    },
    { id: 'voc', name: 'Sound (VOC)', extensions: ['voc'], sniff: sniffVoc, load: parserOf(() => import('./voc')) },
    { id: 'ogg', name: 'Sound or video (Ogg)', extensions: ['ogg', 'oga', 'ogv', 'ogx', 'opus', 'spx'], sniff: sniffOgg, load: parserOf(() => import('./ogg')) },
    { id: 'pcx', name: 'Picture (PCX)', extensions: ['pcx'], sniff: sniffPcx, load: parserOf(() => import('./pcx')) },
    { id: 'vqp', name: 'Palette blending tables (VQP)', extensions: ['vqp'], sniff: sniffVqp, load: parserOf(() => import('./westwood/vqp')) },
    { id: 'chunks', name: 'Petroglyph chunk file', extensions: ['bui', 'cfx', 'bfd', 'gtl', 'gpd', 'cpd', 'sob', 'chunks'], sniff: sniffChunkFile, load: parserOf(() => import('./chunks')) },
    { id: 'xcc-names', name: 'File names (XCC)', extensions: ['dat'], sniff: sniffXccDatabase, byNameAlone: false, load: parserOf(() => import('./mix/database')) },
    { id: 'emc', name: 'Script (Dune II EMC)', extensions: ['emc'], sniff: sniffEmc, load: parserOf(() => import('./westwood/emc')) },
    { id: 'mentat', name: 'Mentat encyclopedia (Dune II)', extensions: ['eng', 'fre', 'ger', 'ita', 'spa'], sniff: sniffMentat, load: parserOf(() => import('./westwood/mentat')) },
    { id: 'strings', name: 'String table', extensions: ['eng', 'ger', 'fre', 'ita', 'spa'], sniff: sniffStrings, load: parserOf(() => import('./westwood/strings')) },
    { id: 'lut', name: 'Chronal vortex frame (RA)', extensions: ['lut'], sniff: sniffVortex, load: parserOf(() => import('./westwood/lut')) },
    // 256 bytes of anything: there's nothing to recognize it by but its name.
    { id: 'gray-remap', name: 'Color remap table (Dune II TBL)', extensions: ['tbl'], sniff: () => false, companions: true, load: parserOf(() => import('./westwood/gray-remap')) },
    { id: 'mrf', name: 'Color remap tables', extensions: ['mrf'], sniff: () => false, load: parserOf(() => import('./westwood/mrf')) },
    { id: 'pal', name: 'Palette', extensions: ['pal'], sniff: sniffPal, load: parserOf(() => import('./westwood/pal')) },
    // Dune 2000's missions are .map too, so the name alone says nothing.
    { id: 'icon-map', name: 'Map tile groups (Dune II ICON.MAP)', extensions: ['map'], sniff: sniffIconMap, byNameAlone: false, companions: true, load: parserOf(() => import('./westwood/icon-map')) },
    // Settings files are .cfg in many games, so the name alone says nothing; both of Dune II's are read by one parser.
    { id: 'dune2-cfg', name: 'Settings (Dune II DUNE.CFG)', extensions: ['cfg'], sniff: sniffDuneCfg, byNameAlone: false, load: parserOf(() => import('./westwood/dune2-cfg')) },
    { id: 'dune2-options', name: 'Game options (Dune II OPTIONS.CFG)', extensions: ['cfg'], sniff: sniffDuneOptions, byNameAlone: false, load: parserOf(() => import('./westwood/dune2-cfg')) },
    { id: 'map-td', name: 'Map terrain (TD)', extensions: ['bin'], sniff: sniffMapTd, byNameAlone: false, companions: true, load: parserOf(() => import('./westwood/map-td')) },
    { id: 'ini', name: 'Settings (INI)', extensions: ['ini'], sniff: sniffIni, companions: true, load: parserOf(() => import('./ini')) },
    { id: 'text', name: 'Text', extensions: ['txt', 'ini', 'eng', 'ger', 'fre', 'csv'], sniff: sniffText, load: parserOf(() => import('./text')) },
];

export const RAW: FormatDescriptor = { id: 'raw', name: 'Unrecognized', extensions: ['bin'], sniff: () => true, load: parserOf(() => import('./raw')) };

/** The default extension to save a file of this format under. */
export function extensionOf(format: FormatDescriptor): string {
    return format.extensions[0];
}

export function extension(name: string | null): string | null {
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
