/**
 * Dune II's music: which track of which file each of its 38 pieces is, and
 * where the game plays it. The game names none of them: its files are DUNE0
 * to DUNE20, and its table only numbers them. The tracks are OpenDUNE's
 * g_table_musics (src/table/sound.c); where each plays is from its calls to
 * Music_Play (src/opendune.c, src/cutscene.c, src/gui/gui.c, src/gui/mentat.c)
 * and the houses' table (src/table/houseinfo.c).
 *
 * The same track numbers pick the sequence in every kind of music file the
 * game has (.ADL for the AdLib, .XMI for the MT-32, .C55 for the Sound Canvas,
 * .PCS for the PC speaker, .TAN for the Tandy): OpenDUNE's MPU_FindSoundStart
 * counts an XMIDI file's sequences from 0, as the ADL player counts its
 * tracks. https://github.com/OpenDUNE/OpenDUNE
 */

const FIELD = 'in the field, one of nine at random';
const BATTLE = 'in battle and on the score screen, one of six at random';
const NEVER = 'listed, but never played';

/** The game's music by its number (1 to 37; 0 is silence): the file, the track, and where it plays. */
const MUSIC: [file: string, track: number, plays: string][] = [
    ['DUNE1', 2, NEVER],
    ['DUNE1', 3, 'an Ordos defeat'],
    ['DUNE1', 4, 'a Harkonnen defeat'],
    ['DUNE1', 5, 'an Atreides defeat'],
    ['DUNE17', 4, 'an Ordos victory'],
    ['DUNE8', 3, 'a Harkonnen victory'],
    ['DUNE8', 2, 'an Atreides victory'],
    ['DUNE1', 6, FIELD],
    ['DUNE2', 6, FIELD],
    ['DUNE3', 6, FIELD],
    ['DUNE4', 6, FIELD],
    ['DUNE5', 6, FIELD],
    ['DUNE6', 6, FIELD],
    ['DUNE9', 4, FIELD],
    ['DUNE9', 5, FIELD],
    ['DUNE18', 6, FIELD],
    ['DUNE10', 7, BATTLE],
    ['DUNE11', 7, BATTLE],
    ['DUNE12', 7, BATTLE],
    ['DUNE13', 7, BATTLE],
    ['DUNE14', 7, BATTLE],
    ['DUNE15', 7, BATTLE],
    ['DUNE1', 8, NEVER],
    ['DUNE7', 2, 'the Harkonnen briefings'],
    ['DUNE7', 3, 'the Atreides briefings'],
    ['DUNE7', 4, 'the Ordos briefings'],
    ['DUNE0', 2, 'the intro'],
    ['DUNE7', 6, 'the main menu, and choosing a house'],
    ['DUNE16', 7, 'the map of Arrakis, choosing where to fight next'],
    ['DUNE19', 4, 'the Harkonnen ending'],
    ['DUNE19', 2, 'the Atreides ending'],
    ['DUNE19', 3, 'the Ordos ending'],
    ['DUNE20', 2, 'the credits'],
    ['DUNE16', 8, 'the cutscenes after levels 4 and 8'],
    ['DUNE0', 3, NEVER],
    ['DUNE0', 4, 'the Westwood logo'],
    ['DUNE0', 5, NEVER],
];

/** Which tracks of each file (by name without its extension) are the game's music. */
export const DUNE2_MUSIC: Record<string, number[]> = {};
for (const [file, track] of MUSIC) (DUNE2_MUSIC[file] ??= []).push(track);
for (const tracks of Object.values(DUNE2_MUSIC)) tracks.sort((a, b) => a - b);

/** Where the game plays a file's track, e.g. "the intro"; undefined when it isn't the game's music. */
export function dune2MusicPlays(file: string, track: number): string | undefined {
    return MUSIC.find(([f, t]) => f === file && t === track)?.[2];
}
