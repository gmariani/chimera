import { Bytes } from '../../core/bytes';
import { templateFileNames } from '../westwood/templates';

/**
 * File names to try against a MIX file's IDs. A name that isn't in the archive
 * simply never matches, so guesses are cheap. For complete coverage, load XCC's
 * "global mix database.dat".
 */

const ARCHIVES = [
    'local mix database.dat',
    'main.mix', 'redalert.mix', 'conquer.mix', 'general.mix', 'local.mix', 'hires.mix', 'hires1.mix', 'lores.mix', 'lores1.mix',
    'sounds.mix', 'speech.mix', 'allies.mix', 'russian.mix', 'scores.mix', 'movies.mix', 'movies1.mix', 'movies2.mix',
    'transit.mix', 'update.mix', 'updatec.mix', 'expand.mix', 'expand2.mix', 'deseicnh.mix', 'tempicnh.mix', 'winticnh.mix',
    'temperat.mix', 'winter.mix', 'desert.mix', 'snow.mix', 'interior.mix', 'jungle.mix', 'nchires.mix',
    'cache.mix', 'conquer.mix', 'isosnow.mix', 'isotemp.mix', 'sidec01.mix', 'sidec02.mix', 'e01scd.mix', 'multi.mix',
    'tibsun.mix', 'ra2.mix', 'ra2md.mix', 'language.mix', 'langmd.mix', 'cameo.mix', 'cameomd.mix', 'audio.mix', 'audiomd.mix',
];

/**
 * TS and RA2 archives the games open by name: theater archives (tiles in iso*.mix,
 * sprites in the theater's own and in its three-letter one), and the rest, each
 * also with Yuri's Revenge's "md" suffix.
 */
const THEATER_STEMS = [
    ['temperat', 'tem'], ['snow', 'sno'], ['urban', 'urb'], ['desert', 'des'], ['lunar', 'lun'], ['urbann', 'ubn'], ['generic', 'gen'],
];
const TS_RA2_ARCHIVES = [
    'local', 'cache', 'conquer', 'cameo', 'neutral', 'audio', 'sidec01', 'sidec02', 'sidenc01', 'sidenc02', 'ecache01', 'ecache02', 'conqmd',
    'sounds01', 'speech01', 'speech02', 'scores01', 'movies01', 'movies02', 'movies03', 'maps01', 'maps02', 'maps03', 'multi', 'theme', 'tibsun',
    'patch', 'wdt', 'wdtvox', 'gmenu', 'e01sc01', 'e01sc02', 'e01vox01', 'e01vox02', 'e01scd01', 'e01scd02', 'sidecd01', 'sidecd02', 'expand01',
    'expand02', 'expand03', 'expandmd01', 'ra2', 'ra2md', 'language', 'langmd', 'mapsmd03', 'movmd03', 'multimd', 'thememd', 'firestrm', 'fsmovies',
];
function tsRa2ArchiveNames(): string[] {
    const stems = [...TS_RA2_ARCHIVES];
    for (const [long, short] of THEATER_STEMS) stems.push(long, short, `iso${short}`, `iso${long.slice(0, 4)}`);
    const names = stems.flatMap((stem) => [`${stem}.mix`, `${stem}md.mix`]);
    // Each theater's tile set INI and palettes: tiles (iso), objects, units.
    for (const [long, short] of THEATER_STEMS) {
        for (const md of ['', 'md']) names.push(`${long}${md}.ini`, `${long}${md}.pal`, `iso${short}${md}.pal`, `unit${short}${md}.pal`, `${short}${md}.pal`);
    }
    return names;
}

const SINGLES = [
    'rules.ini', 'art.ini', 'sound.ini', 'theme.ini', 'tutorial.ini', 'mission.ini', 'ai.ini', 'battle.ini', 'conquer.eng',
    'rulesmd.ini', 'artmd.ini', 'aimd.ini', 'soundmd.ini', 'thememd.ini', 'ra2.csf', 'ra2md.csf',
    'palette.cps', 'title.cps', 'htitle.pcx', 'title.pcx', 'choose.cps', 'alipaper.pcx', 'sovpaper.pcx', 'options.shp', 'mouse.shp',
    'font.fnt', '8point.fnt', '6point.fnt', '3point.fnt', 'grad6fnt.fnt', 'scorefnt.fnt', 'vcr.fnt', 'led.fnt', 'help.fnt',
    'strip.shp', 'tabs.shp', 'clock.shp', 'power.shp', 'pips.shp', 'pips2.shp', 'radar.shp', 'side1na.shp', 'side2na.shp',
    'sidebar.shp', 'side1us.shp', 'side2us.shp', 'side3.shp', 'stripna.shp', 'stripus.shp', 'mpwrdown.shp', 'pwrbar.shp',
    'shadow.shp', 'select.shp', 'trans.icn', 'credits.shp', 'repair.shp', 'sell.shp', 'map.shp', 'pumpkin.pal',
    'temperat.pal', 'snow.pal', 'interior.pal', 'desert.pal', 'winter.pal', 'jungle.pal', 'unittem.pal', 'unitsno.pal',
    'isotem.pal', 'isosno.pal', 'anim.pal', 'cameo.pal', 'mousepal.pal', 'sidebar.pal', 'unittem.pal', 'unitdes.pal',
    'aftrmath.ini', 'mplayer.ini', 'scg01ea.ini', 'scu01ea.ini', 'scg01ea.bin', 'scu01ea.bin',
    'conquer.eng', 'conquer.ger', 'conquer.fre', 'editor.eng', 'editor.ger', 'editor.fre', 'debug.eng', 'credits.eng', 'record.bin', 'expand.dat',
    'temp_vtx.pal', 'snow_vtx.pal', 'intr_vtx.pal',
    'audio.idx', 'audio.bag', 'audiomd.idx', 'audiomd.bag', 'game.fnt', 'gamemd.fnt', 'ra2.csf', 'ra2md.csf', 'keyboard.ini', 'keyboardmd.ini', 'voxels.vpl',
];

/** TD's colour remap tables: the theater's first letter, then what the table is for (DISPLAY.CPP). */
const REMAP_TABLES = ['green', 'yellow', 'red', 'mouse', 'trans', 'white', 'shadow', 'units', 'shade', 'light', 'clock'];
const THEATER_LETTERS = ['t', 'd', 'w', 'j'];

/** RA's chronal vortex: 16 frames each of growing, spinning and shrinking. */
const VORTEX_FRAMES = 48;

/** Unit, building and effect sprite names from TD and RA. */
const SPRITES = [
    // Infantry
    'e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'medi', 'mech', 'spy', 'thf', 'dog', 'shok', 'rmbo', 'c1', 'c2', 'c3', 'c4', 'c5',
    'c6', 'c7', 'c8', 'c9', 'c10', 'chan', 'delphi', 'einstein', 'gnrl', 'moebius', 'civ1', 'civ2', 'civ3',
    // Vehicles, aircraft, ships
    '1tnk', '2tnk', '3tnk', '4tnk', 'ltnk', 'mtnk', 'htnk', 'stnk', 'ctnk', 'ttnk', 'qtnk', 'jeep', 'apc', 'arty', 'harv',
    'mcv', 'v2rl', 'mnly', 'mrj', 'mgg', 'ftrk', 'dtrk', 'truk', 'bggy', 'bike', 'ftnk', 'msam', 'mlrs', 'mhq', 'boat',
    'lst', 'ss', 'msub', 'dd', 'ca', 'pt', 'tran', 'heli', 'hind', 'mig', 'yak', 'badr', 'u2', 'orca', 'a10', 'c17',
    // Buildings
    'fact', 'powr', 'apwr', 'nuke', 'nuk2', 'barr', 'tent', 'pyle', 'hand', 'proc', 'weap', 'dome', 'hq', 'eye', 'tmpl',
    'gun', 'agun', 'sam', 'gap', 'ftur', 'tsla', 'pbox', 'hbox', 'gtwr', 'atwr', 'obli', 'fix', 'silo', 'hpad', 'afld',
    'spen', 'syrd', 'iron', 'pdox', 'atek', 'stek', 'kenn', 'mslo', 'fcom', 'hosp', 'bio', 'miss', 'brik', 'sbag', 'cycl',
    'barb', 'wood', 'fenc', 'mine', 'minv', 'minp', 'v01', 'v02', 'v03', 'v04', 'v05', 'v06', 'v07', 'v08', 'v09', 'v10',
    'v11', 'v12', 'v13', 'v14', 'v15', 'v16', 'v17', 'v18', 'v19', 'v20', 'v21', 'v22', 'v23', 'v24', 'v25', 'v26', 'v27',
    'v28', 'v29', 'v30', 'v31', 'v32', 'v33', 'v34', 'v35', 'v36', 'v37', 'arco', 'wcrate', 'scrate', 'barl', 'brl3',
    // Effects
    'fball1', 'frag1', 'veh-hit1', 'veh-hit2', 'veh-hit3', 'art-exp1', 'napalm1', 'napalm2', 'napalm3', 'smokey', 'smokland',
    'piff', 'piffpiff', 'fire1', 'fire2', 'fire3', 'fire4', 'burn-s', 'burn-m', 'burn-l', 'flak', 'h2o_exp1', 'h2o_exp2',
    'h2o_exp3', 'bomblet', 'litning', 'atomsfx', 'chronbox', 'electdog', 'minigun', 'gunfire', 'sputdoor', 'wake', 'rapid',
    'fb1', 'fb2', 'fb3', 'fb4', 'missile', 'dragon', '120mm', '50cal', 'bomb', 'parach', 'paradoor', 'dollar', 'earth',
    'empulse', 'invun', 'speed', 'sonarbox', 'stealth2', 'timequad', 'mpspawn', 'chrono', 'flagfly', 'tquake', 'countrya',
    'ore01', 'ore02', 'ore03', 'ore04', 'gem01', 'gem02', 'gem03', 'gem04', 'ti1', 'ti2', 'ti3', 'ti4', 'ti5', 'ti6',
    'ti7', 'ti8', 'ti9', 'ti10', 'ti11', 'ti12', 't01', 't02', 't03', 't05', 't06', 't07', 't08', 't10', 't11', 't12',
    't13', 't14', 't15', 't16', 't17', 'tc01', 'tc02', 'tc03', 'tc04', 'tc05', 'mine', 'boxes01', 'boxes02', 'ice01',
    // Map overlays and terrain objects (ODATA.CPP, TDATA.CPP)
    'gold01', 'gold02', 'gold03', 'gold04', 'gem01', 'gem02', 'gem03', 'gem04', 'fpls', 'wwcrate', 'squish', 'road', 'conc',
    't04', 't09', 't18', 'split2', 'split3', 'rock1', 'rock2', 'rock3', 'rock4', 'rock5', 'rock6', 'rock7', 'boxes03', 'boxes04',
    'boxes05', 'boxes06', 'boxes07', 'boxes08', 'boxes09', 'ice02', 'ice03', 'ice04', 'ice05',
];

/** Sidebar build icons are the sprite name plus "icon". */
const ICON_SUFFIXES = ['icon', 'icnh'];

/** RA unit voices and EVA lines. */
const SOUNDS = [
    'ackno', 'affirm1', 'await1', 'ready', 'report1', 'roger', 'ugotit', 'vehic1', 'yessir1', 'noprob', 'overout', 'ritaway',
    'abldgin1', 'aboard', 'airunit1', 'alaunch1', 'aprep1', 'atlnch1', 'baseatk1', 'bct1', 'bldging1', 'bldgprg1', 'chrochr1',
    'chroyes1', 'conscmp1', 'convyap1', 'cmdcntr1', 'credit1', 'enmyapp1', 'firstn1', 'flaren1', 'lopower1', 'mapsel1',
    'misnlst1', 'misnwon1', 'mslnch1', 'newopt1', 'nofunds1', 'nopowr1', 'objmet1', 'objnmet1', 'objrch1', 'ominous1',
    'onhold1', 'primary1', 'radaron1', 'radaroff', 'reinfor1', 'repair1', 'select1', 'silond1', 'slcttgt1', 'sovemp1',
    'sovfapp1', 'sovforc1', 'spypln1', 'strckin1', 'sudsmlr1', 'train1', 'unitlst1', 'unitrdy1', 'unitsld1', 'cancld1',
    'aamove1', 'appear1', 'beepy2', 'beepy3', 'beepslct', 'bleep9', 'buildng1', 'cashturn', 'chute1', 'clock1', 'country1',
    'dogg5p', 'dogw3px', 'dogw5', 'dogy1', 'explod1', 'kaboom1', 'kaboom12', 'kaboom15', 'kaboom22', 'kaboom25', 'kaboom30',
    'mgun2', 'mgun11', 'pillbox1', 'radar1', 'ramgun2', 'rocket1', 'rocket2', 'sabotage', 'scoldy1', 'smout1', 'sonpulse',
    'splash9', 'tank5', 'tank6', 'tesla1', 'teslchg2', 'tslachg2', 'toney4', 'toney7', 'toney10', 'trans1', 'uplace',
    'vehic1', 'vtoaq', 'water1', 'wateratk', 'whip', 'xplobig4', 'xplobig6', 'xplos', 'build5', 'cashup1', 'cashdn1',
    'hydrod1', 'minelay1', 'sellbldg1', 'ironcur9', 'nukexplo', 'gunboat', 'stavmov', 'chronote', 'chrono2', 'gasexpl',
];

/** Westwood stores each voice per side: .v00 to .v03 for Allies, .r00 to .r03 for Soviets. */
const SOUND_EXTENSIONS = ['aud', 'v00', 'v01', 'v02', 'v03', 'r00', 'r01', 'r02', 'r03', 'juv'];

const SPRITE_EXTENSIONS = ['shp', 'tem', 'sno', 'int', 'des', 'win', 'jun'];

const MUSIC = [
    'bigf226m', 'crus226m', 'fac1226m', 'fac2226m', 'hell226m', 'run1226m', 'smsh226m', 'tren226m', 'work226m', 'await',
    'dense_r', 'fogger1a', 'mud1a', 'radio2', 'rollout', 'snake', 'terminat', 'twin', 'vector1a', 'map', 'score', 'intro',
    'credits', 'aftr_hp', 'aftr_r', 'aftr_ve', 'beatfeel', 'bog', 'drill', 'fight', 'nproof', 'quake', 'search', 'sun',
    'aoi', 'ccthang', 'fwp', 'ind', 'ind2', 'justdoit', 'linefire', 'march', 'nomercy', 'otp', 'prp', 'raintro', 'stopthem',
    'trouble', 'warfare', 'befeared', 'heavyg', 'j1', 'jdi_v2', 'radio', 'rain', 'target', 'valkyrie',
];

/** Tiberian Dawn's cutscenes. Mission briefings follow gdiN/nodN plus a suffix. */
const MOVIES = [
    'intro2', 'logo', 'trailer', 'banner', 'bkground', 'choppers', 'cc2tease', 'credits', 'airstrk', 'akira', 'bcanyon',
    'blackout', 'bombaway', 'bombflee', 'burdet1', 'burdet2', 'consyard', 'desflees', 'deskill', 'dessweep', 'dino', 'flag',
    'flyy', 'forestkl', 'gameover', 'gdiend1', 'gdiend2', 'gdifinb', 'gdifina', 'gdilose', 'generic', 'gunboat', 'hellvaly',
    'insites', 'kanepre', 'landing', 'napalm', 'nitejump', 'nodend1', 'nodend2', 'nodend3', 'nodend4', 'nodfinal', 'nodflees',
    'nodlose', 'nodsweep', 'nuke', 'obel', 'paratrop', 'podium', 'refint', 'retro', 'sabotage', 'samdie', 'samsite', 'seige',
    'shorbomb', 'spycrash', 'stealth', 'sundial', 'tanya1', 'tanya2', 'tbrinfo1', 'tbrinfo2', 'tbrinfo3', 'tiberfx', 'trtkil_d',
    'turtkill', 'visor', 'tankgo', 'tankkill', 'trophy', 'eva', 'ally1', 'ally2', 'ally4', 'ally5', 'ally6', 'ally8', 'ally9',
    'ally10', 'ally11', 'ally12', 'ally14', 'soviet1', 'soviet2', 'soviet3', 'soviet4', 'soviet5', 'soviet6', 'soviet7',
    'soviet8', 'soviet9', 'soviet10', 'soviet11', 'soviet12', 'soviet13', 'soviet14', 'prolog', 'redintro', 'english',
];
const BRIEFING_SUFFIXES = ['', 'a', 'b', 'c', 'pre', 'win', 'lose', 'end'];

/** Tiberian Dawn's EVA lines (RA's are in SOUNDS). */
const TD_SPEECH = [
    'accom1', 'aircraft', 'airstrk1', 'baseatk1', 'batlcon1', 'bldg1', 'bldging1', 'bldgprg1', 'construc', 'deploy1', 'enemya',
    'gdiwin1', 'gdicapt1', 'gdiprot1', 'ionchrg1', 'ionredy1', 'lopower1', 'mislost1', 'misslos1', 'misswon1', 'newopt1',
    'nobuild1', 'nocash1', 'nodcapt1', 'nodwin1', 'nodprot1', 'nukatk1', 'nuclaun1', 'onhold1', 'primary1', 'reinfor1',
    'repair1', 'restate1', 'select1', 'sectstrk', 'struclst', 'trans1', 'unitlost', 'unitredy', 'unitrepr', 'unitsell',
    'unitsld1', 'xploposi', 'bldgcap1', 'cancel1', 'ionrdy1', 'nodstruc', 'gdistruc', 'nodunit', 'gdiunit', 'nounit1',
    'pwrmd', 'radaon1', 'radaof1', 'silos1', 'stucdes1', 'unitreinf', 'upgrade1',
];

/**
 * Missions are sc, the side (g GDI, b Nod, u USSR, m multiplayer, j the funpark), the number,
 * the direction on the campaign map (e, w, x) and the variant; each is an INI, and in TD a .bin map too.
 */
const MISSION_SIDES = ['g', 'b', 'u', 'm', 'j'];
const MISSION_DIRECTIONS = ['e', 'w', 'x'];
const MISSION_VARIANTS = ['a', 'b', 'c', 'd'];

let cached: string[] | null = null;

export function builtInNames(): string[] {
    if (cached) return cached;
    const names = new Set<string>([...ARCHIVES, ...tsRa2ArchiveNames(), ...SINGLES, ...templateFileNames()]);
    for (const side of MISSION_SIDES) {
        for (let n = 1; n <= 99; n++) {
            for (const direction of MISSION_DIRECTIONS) {
                for (const variant of MISSION_VARIANTS) {
                    const base = `sc${side}${String(n).padStart(2, '0')}${direction}${variant}`;
                    names.add(`${base}.ini`);
                    names.add(`${base}.bin`);
                }
            }
        }
    }
    for (const base of SPRITES) {
        for (const ext of SPRITE_EXTENSIONS) names.add(`${base}.${ext}`);
        for (const suffix of ICON_SUFFIXES) names.add(`${base}${suffix}.shp`);
    }
    for (const base of SOUNDS) for (const ext of SOUND_EXTENSIONS) names.add(`${base}.${ext}`);
    for (const base of [...MUSIC, ...TD_SPEECH]) names.add(`${base}.aud`);
    for (const base of MOVIES) names.add(`${base}.vqa`);
    for (const letter of THEATER_LETTERS) for (const table of REMAP_TABLES) names.add(`${letter}${table}.mrf`);
    for (let i = 0; i < VORTEX_FRAMES; i++) names.add(`hole${String(i).padStart(4, '0')}.lut`);
    for (const side of ['gdi', 'nod']) {
        for (let mission = 1; mission <= 15; mission++) for (const suffix of BRIEFING_SUFFIXES) names.add(`${side}${mission}${suffix}.vqa`);
    }
    return (cached = [...names]);
}

/**
 * XCC's "local mix database.dat", stored inside a MIX: an XCC header, then the
 * NUL-terminated names of the files in that MIX.
 */
export const XCC_SIGNATURE = 'XCC by Olaf van der Spek';

export function readLocalMixDatabase(data: Uint8Array): string[] | null {
    const bytes = new Bytes(data);
    if (bytes.ascii(0, XCC_SIGNATURE.length) !== XCC_SIGNATURE) return null;
    const count = bytes.u32(48);
    const names: string[] = [];
    let offset = 52;
    for (let i = 0; i < count && offset < data.length; i++) {
        const { text, next } = bytes.asciiz(offset);
        names.push(text);
        offset = next;
    }
    return names;
}

/**
 * Names from a file the user loads: XCC's "global mix database.dat" (for each
 * game, a count then name/description pairs), an XCC local database, a plain
 * text list with one name per line, or any other binary file (the game's
 * executable), for the file names written in it.
 */
export function readNameList(data: Uint8Array): string[] {
    const local = readLocalMixDatabase(data);
    if (local) return local;

    const bytes = new Bytes(data);
    const names: string[] = [];
    let offset = 0;
    let looksBinary = data.length >= 4;
    while (looksBinary && offset + 4 <= data.length) {
        const count = bytes.u32(offset);
        offset += 4;
        if (count > data.length) {
            looksBinary = false;
            break;
        }
        for (let i = 0; i < count; i++) {
            if (offset >= data.length) {
                looksBinary = false;
                break;
            }
            const name = bytes.asciiz(offset);
            const description = bytes.asciiz(name.next);
            names.push(name.text);
            offset = description.next;
        }
    }
    if (looksBinary && names.length) return names;
    // Any other binary file, such as the game's executable: the file names written in it.
    if (data.subarray(0, 4096).includes(0)) return namesFromBinary(data);

    return new TextDecoder('latin1')
        .decode(data)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith(';') && !line.startsWith('#'));
}

/** Extensions TS and RA2 give their assets, for names found in their INIs. */
const ASSET_EXTENSIONS = [
    'shp', 'vxl', 'hva', 'tmp', 'pcx', 'pal', 'wav', 'aud', 'ini', 'mix', 'csf', 'fnt', 'vqa', 'bik', 'map', 'mpr', 'txt', 'cps', 'pkt', 'mmx',
    'tem', 'sno', 'urb', 'des', 'lun', 'ubn', 'int', 'win', 'jun',
];
/** TS and RA2 theater tile set extensions: temperate, snow, urban, desert, lunar, new urban. */
const TILE_EXTENSIONS = ['tem', 'sno', 'urb', 'des', 'lun', 'ubn'];
/** In TS and RA2, the second letter of a building's image picks its theater: Generic, Temperate, Arctic (snow), Urban, Desert, Lunar, New urban. */
const THEATER_IMAGE_LETTERS = 'GTAUDLN';

/**
 * File names from the text of a game's INIs. TS and RA2 archives keep no names,
 * but rules.ini, art.ini, sound.ini and the theater INIs name nearly every asset:
 * each word is tried with each asset extension, buildings in each theater, and
 * each tile set's numbered files.
 */
export function namesFromText(texts: Iterable<string>): string[] {
    const words = new Set<string>();
    const out = new Set<string>();
    for (const text of texts) {
        // Maps only place what the rules define, and their packed sections are base64 noise.
        if (/^\[(IsoMapPack5|MapPack|OverlayPack|Preview)\]/im.test(text)) continue;
        for (const line of text.split(/\r?\n/)) {
            const content = line.replace(/;.*$/, '');
            const value = content.match(/^\s*\[([^\]]+)\]/)?.[1] ?? content.slice(content.indexOf('=') + 1);
            for (const word of value.match(/[A-Za-z0-9_\-]{2,32}/g) ?? []) if (!/^\d+$/.test(word)) words.add(word.toLowerCase());
        }
        // Theater INIs: [TileSetNNNN] with FileName=cliff and TilesInSet=12 gives cliff01 … cliff12, some with variants a, b, …
        for (const set of text.matchAll(/FileName\s*=\s*([A-Za-z0-9_\-]+)[^[]*?TilesInSet\s*=\s*(\d+)/gi)) {
            for (let i = 1; i <= Math.min(Number(set[2]), 99); i++) {
                for (const variant of ['', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
                    for (const ext of TILE_EXTENSIONS) out.add(`${set[1].toLowerCase()}${String(i).padStart(2, '0')}${variant}.${ext}`);
                }
            }
        }
    }
    for (const word of words) {
        for (const ext of ASSET_EXTENSIONS) out.add(`${word}.${ext}`);
        // Voxel units keep their turret and barrel in files of their own.
        for (const part of ['tur', 'barl', 'wo']) for (const ext of ['vxl', 'hva']) out.add(`${word}${part}.${ext}`);
        if (word.length >= 3 && THEATER_IMAGE_LETTERS.includes(word[1].toUpperCase())) {
            for (const letter of THEATER_IMAGE_LETTERS) out.add(`${word[0]}${letter.toLowerCase()}${word.slice(2)}.shp`);
        }
    }
    return [...out];
}

/** What %s stands for in the games' file name patterns ("ISO%s.PAL"): theater names, long and short. */
const PATTERN_WORDS = ['', 'md', ...THEATER_STEMS.flat()];
/** No pattern expands to more names than this. */
const PATTERN_LIMIT = 20_000;

/** Every name a printf-style pattern can produce: %d and %02d as numbers, %c as a letter or digit, %s as a theater name. */
function expandPattern(pattern: string): string[] {
    const parts = pattern.split(/(%0?\d?[dcs])/i);
    let out = [''];
    for (const part of parts) {
        const spec = part.match(/^%0?(\d?)([dcs])$/i);
        let options: string[];
        if (!spec) options = [part];
        else if (spec[2].toLowerCase() === 'c') options = [...'abcdefghijklmnopqrstuvwxyz0123456789'];
        else if (spec[2].toLowerCase() === 's') options = PATTERN_WORDS;
        else {
            const digits = Number(spec[1] || 1);
            const top = Math.min(10 ** Math.max(digits, 2), 10_000);
            options = Array.from({ length: top }, (_, n) => (spec[1] ? String(n).padStart(digits, '0') : String(n)));
        }
        if (out.length * options.length > PATTERN_LIMIT) return [];
        out = out.flatMap((prefix) => options.map((o) => prefix + o));
    }
    return out;
}

/**
 * File names in any file, such as the game's executable, which names what it
 * loads; patterns like "E%02dSC%02d.MIX" are expanded.
 */
export function namesFromBinary(data: Uint8Array): string[] {
    const out = new Set<string>();
    let run = '';
    const flush = () => {
        for (const m of run.matchAll(/[A-Za-z0-9_%\-]{1,40}\.[A-Za-z]{2,4}/g)) for (const name of m[0].includes('%') ? expandPattern(m[0]) : [m[0]]) out.add(name.toLowerCase());
        run = '';
    };
    for (const c of data) {
        if (c >= 0x20 && c < 0x7f) run += String.fromCharCode(c);
        else if (run) flush();
    }
    flush();
    return [...out];
}
