/**
 * Which tracks of which files Dune II plays as its music: OpenDUNE's g_table_musics (src/table/sound.c), by file name
 * without its extension. The same track numbers pick the sequence in every kind of music file the game has (.ADL for the
 * AdLib, .XMI for the MT-32, .C55 for the Sound Canvas, .PCS for the PC speaker, .TAN for the Tandy): OpenDUNE's
 * MPU_FindSoundStart counts an XMIDI file's sequences from 0, as the ADL player counts its tracks.
 */
export const DUNE2_MUSIC: Record<string, number[]> = {
    DUNE0: [2, 3, 4, 5],
    DUNE1: [2, 3, 4, 5, 6, 8],
    DUNE2: [6],
    DUNE3: [6],
    DUNE4: [6],
    DUNE5: [6],
    DUNE6: [6],
    DUNE7: [2, 3, 4, 6],
    DUNE8: [2, 3],
    DUNE9: [4, 5],
    DUNE10: [7],
    DUNE11: [7],
    DUNE12: [7],
    DUNE13: [7],
    DUNE14: [7],
    DUNE15: [7],
    DUNE16: [7, 8],
    DUNE17: [4],
    DUNE18: [6],
    DUNE19: [2, 3, 4],
    DUNE20: [2],
};
