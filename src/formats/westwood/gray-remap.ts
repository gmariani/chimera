import { bytesLabel, field } from '../../core/bytes';
import type { Companion, FormatParser } from '../../core/types';
import { swatches } from './mrf';
import { sniffPal } from './sniff';
import { expandPalette } from './vga';

/**
 * Dune II's GRAYRMAP.TBL: 256 bytes, the color to draw in place of each
 * color of the game palette (IBM.PAL). The factory and starport windows draw
 * what can't be had yet (it needs an upgrade, or the starport is out of
 * stock) through it, so its picture turns gray: each pixel's color is looked
 * up here. The game reads exactly 256 bytes, and there's nothing else in the
 * file: no header, no signature, so it's recognized only by its name.
 *
 * ModdingWiki has no page for it; this follows OpenDUNE (src/gui/gui.c,
 * GUI_FactoryWindow_LoadGraymapTbl and its use with GUI_DrawSprite and
 * GUI_Palette_RemapScreen): https://github.com/OpenDUNE/OpenDUNE.
 */

const SIZE = 256;
/** How far apart a color's red, green and blue can be (of 63) for it to count as gray: the game's own grays are a little blue, up to 8. */
const GRAY_SPREAD = 8;

/** IBM.PAL's 6-bit colors, from the first copy in the session that is a palette, and where it's from. */
function findPalette(find: ((name: string) => Companion[]) | undefined): { colors: Uint8Array; source: string } | null {
    const found = find?.('IBM.PAL').find((c) => sniffPal(c.data));
    return found ? { colors: found.data, source: found.source } : null;
}

const parser: FormatParser = {
    parse(data, context) {
        if (data.length !== SIZE) throw new Error(`A Dune II color remap table is ${SIZE} bytes, one for each color; this is ${bytesLabel(data.length)}, so it's something else named like one.`);
        const palette = findPalette(context.find);
        const rgb = (c: number) => (palette ? `${palette.colors[c * 3]}, ${palette.colors[c * 3 + 1]}, ${palette.colors[c * 3 + 2]}` : '');
        const isGray = (c: number) => {
            const [r, g, b] = palette!.colors.subarray(c * 3, c * 3 + 3);
            return Math.max(r, g, b) - Math.min(r, g, b) <= GRAY_SPREAD;
        };

        const kept = data.filter((v, i) => v === i).length;
        const targets = [...new Set(data)].sort((a, b) => a - b);
        const notGray = palette ? targets.filter((c) => !isGray(c)) : [];

        const own = /^GRAYRMAP\.TBL$/i.test(context.name ?? '');
        const summary: [string, string][] = [
            ['For', own ? 'Graying out what the factory or starport can’t offer yet' : 'Unknown: the only .tbl Dune II reads is GRAYRMAP.TBL, which grays out what can’t be had yet'],
            ['Colors', `${SIZE - kept} replaced, ${kept} kept as they are`],
            ['Drawn with', `${targets.length} color${targets.length === 1 ? '' : 's'}: ${targets.join(', ')}`],
        ];
        if (palette)
            summary.push(
                ['Palette', `IBM.PAL (${palette.source})`],
                [
                    'Grays',
                    notGray.length
                        ? `${notGray.length} of the colors it draws with ${notGray.length === 1 ? "isn't" : "aren't"} gray in IBM.PAL: ${notGray.join(', ')}`
                        : 'Every color it draws with is a gray in IBM.PAL',
                ]
            );
        summary.push(['Preview', palette ? 'The palette, then the palette through the table' : 'The palette, then the palette through the table; open IBM.PAL (in DUNE.PAK) to see the game’s colors']);

        const identity = Array.from({ length: SIZE }, (_, i) => i);
        return {
            title: 'Color remap table (Dune II GRAYRMAP.TBL)',
            summary,
            fields: [
                {
                    name: 'Remap',
                    offset: 0,
                    length: SIZE,
                    value: `${SIZE - kept} colors replaced`,
                    note: 'For each color of the game palette, the one drawn in its place.',
                    children: identity.map((i) => field(palette ? `Color ${i} (${rgb(i)})` : `Color ${i}`, i, 1, data[i] === i ? `${i}: kept` : palette ? `${data[i]} (${rgb(data[i])})` : data[i])),
                },
            ],
            preview: { kind: 'images', frames: [swatches(identity), swatches(data)], ...(palette ? { palette: expandPalette(palette.colors) } : {}) },
            end: SIZE,
            warnings: [],
        };
    },
};

export default parser;
