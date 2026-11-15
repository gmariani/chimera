import { bytesLabel, field } from '../../core/bytes';
import type { Field, FormatParser } from '../../core/types';
import { BLEND_TABLE } from './sniff';

/**
 * TD's palette blending tables (.pal, 64 KB, in UPDATE.MIX): Tiberian Dawn for Windows draws some 320 × 200 screens
 * (the intro's choice of side, the map between missions, the score screens, the ending) at twice the size, and fills
 * each pixel it adds with the palette color closest to halfway between its two neighbors. This is the answer for
 * every pair: 256 rows of 256 colors, row a, column b holding the blend of colors a and b.
 *
 * The file holds color numbers, not the palette: the game builds the table from the screen's palette brightened by
 * 30% (capped at 63), and saves it under this name so it needn't build it again (Create_Palette_Interpolation_Table,
 * Read_ and Write_Interpolation_Palette in INTERPAL.CPP, in the source EA released).
 */

/** Where the game uses each table, from the calls in its source. */
const USES: Record<string, string> = {
    'sides.pal': 'The intro, choosing a side (INTRO.CPP)',
    'map1.pal': 'The map between missions (MAPSEL.CPP)',
    'map_locl.pal': 'The map between missions (MAPSEL.CPP)',
    'map_gry2.pal': 'The map between missions (MAPSEL.CPP)',
    'map_prog.pal': 'The map between missions (MAPSEL.CPP)',
    'map_loc2.pal': 'The map between missions, with DARK_E.PAL (MAPSEL.CPP)',
    'map_loc3.pal': 'The map between missions, with DARK_B.PAL or DARK_SA.PAL (MAPSEL.CPP)',
    'lastscng.pal': 'The map before GDI’s last mission (MAPSEL.CPP)',
    'lastscnb.pal': 'The map before Nod’s last mission (MAPSEL.CPP)',
    'scorpal1.pal': 'The score screen after a GDI mission (SCORE.CPP)',
    'snodpal1.pal': 'The score screen after a Nod mission (SCORE.CPP)',
    'multscor.pal': 'The score screen after a multiplayer game (SCORE.CPP)',
    'satselin.pal': 'The ending (ENDING.CPP)',
    // In UPDATA.MIX, made like the others, but nothing in the source loads them.
    'map_loc4.pal': 'Nothing: the game’s source never loads it',
    'map_prob.pal': 'Nothing: the game’s source never loads it',
};

const parser: FormatParser = {
    parse(data, context) {
        if (data.length !== BLEND_TABLE) throw new Error(`Not a blending table: it's ${bytesLabel(data.length)}, not 256 × 256 (${bytesLabel(BLEND_TABLE)}).`);
        const at = (a: number, b: number) => data[a * 256 + b];

        // Blending is the same either way round. A pair that isn't would make the picture differ by which pixel is on the left.
        let lopsided = 0;
        let firstLopsided: [number, number] | null = null;
        for (let a = 0; a < 256; a++)
            for (let b = 0; b < a; b++)
                if (at(a, b) !== at(b, a)) {
                    lopsided++;
                    firstLopsided ??= [b, a];
                }
        // A color blended with itself is itself, unless an earlier color is the same: the game's search keeps the first.
        const copies: number[] = [];
        const above: number[] = [];
        for (let a = 0; a < 256; a++) {
            if (at(a, a) < a) copies.push(a);
            else if (at(a, a) > a) above.push(a);
        }
        const warnings: string[] = [];
        if (lopsided)
            warnings.push(
                `${lopsided.toLocaleString('en-US')} pair${lopsided === 1 ? '' : 's'} of colors blend differently by which is first (the first: ${firstLopsided![0]} and ${firstLopsided![1]} give ${at(...firstLopsided!)}, the other way round ${at(firstLopsided![1], firstLopsided![0])}). The game's own tables are the same either way round.`
            );
        if (above.length)
            warnings.push(
                `${above.length} color${above.length === 1 ? '' : 's'} blended with ${above.length === 1 ? 'itself gives' : 'themselves give'} a later color (the first: ${above[0]} gives ${at(above[0], above[0])}): the game's search keeps the first match, so a color can only give itself or an earlier one.`
            );

        const rows: Field[] = Array.from({ length: 256 }, (_, a) =>
            field(
                `Color ${a}`,
                a * 256,
                256,
                at(a, a) === a ? 'its blends with colors 0 to 255' : `the same as color ${at(a, a)}`,
                at(a, a) < a ? `Blended with itself it gives ${at(a, a)}: in the palette the table was made from, the two are the same color.` : undefined
            )
        );
        const use = USES[(context.name ?? '').toLowerCase()];
        const distinct = new Set(data).size;
        return {
            title: 'Palette blending table (TD)',
            summary: [
                ...(use ? [['Used for', use] as [string, string]] : []),
                ['Pairs', '256 × 256: the color halfway between each two'],
                ['Colors it gives', `${distinct} of the 256`],
                ...(copies.length
                    ? [
                          [
                              'Repeated colors',
                              `${copies.length}, the same as an earlier color in the palette it was made from: ${copies.slice(0, 24).join(', ')}${copies.length > 24 ? ', …' : ''}`,
                          ] as [string, string],
                      ]
                    : []),
            ],
            fields: [
                {
                    name: 'Table',
                    offset: 0,
                    length: BLEND_TABLE,
                    value: '256 rows of 256 colors',
                    note: 'Row a, column b: the color the game puts between a pixel of color a and one of color b.',
                    children: rows,
                },
            ],
            // Row a, column b, in the palette picked: colors fade from each row's own on the diagonal.
            preview: { kind: 'images', frames: [{ width: 256, height: 256, pixels: data.slice() }] },
            end: BLEND_TABLE,
            warnings,
        };
    },
};

export default parser;
