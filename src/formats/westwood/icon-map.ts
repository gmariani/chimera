import { field } from '../../core/bytes';
import { pixelBuffer } from '../../core/limits';
import { maxOf, minOf } from '../../core/math';
import type { Companion, Field, FormatParser, IndexedImage } from '../../core/types';
import icn from './icn-d2';
import { iconMapIndex } from './sniff';

/**
 * Dune II's ICON.MAP: which of ICON.ICN's tiles make up each thing on the
 * map. It's all 16-bit words: first the number of index entries (27 in the
 * game's: 26 groups and an end marker of 0), then where each group starts, in
 * words from the start of the file, then the groups, each a list of tile
 * numbers running to the next group (the last, to the end of the file).
 *
 * The groups are in a fixed order the game knows by number: craters, tracks,
 * walls, fog of war, the landscape, then each building. A building's group
 * is its tiles for each of its states (being built, standing, its animation),
 * a whole footprint at a time, row by row.
 *
 * ModdingWiki has no page for it; this follows OpenDUNE (src/sprites.h,
 * IconMapEntries, and its use of g_iconMap): https://github.com/OpenDUNE/OpenDUNE.
 */

/** The groups, in the order the game reads them; a building's footprint in tiles, across and down (OpenDUNE's structure layouts). */
const GROUPS: { name: string; size?: [number, number] }[] = [
    { name: 'Rock craters' },
    { name: 'Sand craters' },
    { name: 'Crashed carryalls and ornithopters' },
    { name: 'Bodies in the sand' },
    { name: 'Tracks in the sand' },
    { name: 'Walls' },
    { name: 'Fog of war (the edges of what’s been seen)' },
    { name: 'Concrete slabs' },
    { name: 'Landscape: sand, rock, dunes, mountains and spice' },
    { name: 'Spice blooms' },
    { name: 'Palace', size: [3, 3] },
    { name: 'Light factory', size: [2, 2] },
    { name: 'Heavy factory', size: [3, 2] },
    { name: 'High-tech factory', size: [3, 2] },
    { name: 'IX research', size: [2, 2] },
    { name: 'WOR trooper facility', size: [2, 2] },
    { name: 'Construction yard', size: [2, 2] },
    { name: 'Barracks', size: [2, 2] },
    { name: 'Wind trap', size: [2, 2] },
    { name: 'Starport', size: [3, 3] },
    { name: 'Refinery', size: [3, 2] },
    { name: 'Repair facility', size: [3, 2] },
    { name: 'Gun turret', size: [1, 1] },
    { name: 'Rocket turret', size: [1, 1] },
    { name: 'Spice silo', size: [2, 2] },
    { name: 'Radar outpost', size: [2, 2] },
];

const TILE = 16;
/** At most this many tiles are drawn, over all the groups (ICON.ICN's 399 are drawn about twice over). */
const MAX_DRAWN = 4096;
/** Tiles to a row, for a group that isn't a building. */
const ROW = 16;
/** Pixels between a building's states. */
const GAP = 4;

/** Tile numbers as runs: "1–6, 9, 12–14". */
function runs(tiles: number[]): string {
    const out: string[] = [];
    for (let i = 0; i < tiles.length;) {
        let j = i;
        while (j + 1 < tiles.length && tiles[j + 1] === tiles[j] + 1) j++;
        out.push(j > i ? `${tiles[i]}–${tiles[j]}` : `${tiles[i]}`);
        i = j + 1;
    }
    return out.join(', ');
}

/** ICON.ICN's tiles, from the first copy in the session that reads, and where it's from. */
function findTiles(find: ((name: string) => Companion[]) | undefined): { tiles: IndexedImage[]; source: string } | null {
    for (const c of find?.('ICON.ICN') ?? []) {
        try {
            const r = icn.parse(c.data, { name: 'ICON.ICN', names: [] });
            if (r.preview?.kind === 'images') return { tiles: r.preview.frames, source: c.source };
        } catch {
            // Not a tile file after all; try the next.
        }
    }
    return null;
}

const parser: FormatParser = {
    parse(data, context) {
        const index = iconMapIndex(data);
        if (typeof index === 'string') throw new Error(`This isn't Dune II's ICON.MAP. ${index}`);
        const { count, starts } = index;
        const words = data.length >> 1;
        const word = (i: number) => data[i * 2] | (data[i * 2 + 1] << 8);
        const warnings: string[] = [];

        const groupCount = count - 1;
        if (word(count) !== 0) warnings.push(`The index should end with 0, at word ${count}, but has ${word(count)} there.`);
        if (groupCount < GROUPS.length)
            warnings.push(
                `There are ${groupCount} groups; the game reads ${GROUPS.length}. For ${GROUPS[groupCount].name.toLowerCase()} and those after, it would take its tile numbers from whatever is there.`
            );
        else if (groupCount > GROUPS.length) warnings.push(`There are ${groupCount} groups; the game reads only the first ${GROUPS.length}, and never shows the others.`);
        if (data.length & 1) warnings.push('The file is an odd number of bytes; the game reads it as 16-bit words, so the last byte is never read.');

        const found = findTiles(context.find);
        const groups = starts.map((start, g) => {
            const end = g + 1 < starts.length ? starts[g + 1] : words;
            const tiles = Array.from({ length: end - start }, (_, i) => word(start + i));
            const known = GROUPS[g];
            return { number: g + 1, start, end, tiles, name: known?.name ?? `Group ${g + 1}, which the game doesn't use`, size: known?.size };
        });

        for (const g of groups) {
            if (!g.tiles.length && g.number <= GROUPS.length) warnings.push(`${g.name} has no tiles; the game would draw the next group's in its place.`);
            if (g.size && g.tiles.length % (g.size[0] * g.size[1]))
                warnings.push(
                    `${g.name} has ${g.tiles.length} tiles, which isn't a whole number of its ${g.size[0]} × ${g.size[1]} footprint: one of its states is cut short, and the game would draw the next group's tiles in it.`
                );
        }
        if (found) {
            let past = 0;
            for (const g of groups) for (const t of g.tiles) if (t >= found.tiles.length) past++;
            if (past)
                warnings.push(
                    `${past.toLocaleString('en-US')} tile number${past === 1 ? ' is' : 's are'} past the ${found.tiles.length.toLocaleString('en-US')} tiles of ICON.ICN: the game would draw from memory past them.`
                );
        }

        // Each group as a picture: a building's states side by side, anything else in rows.
        const frames: IndexedImage[] = [];
        let drawn = 0;
        if (found) {
            for (const g of groups) {
                if (!g.tiles.length || drawn >= MAX_DRAWN) continue;
                const tiles = g.tiles.slice(0, MAX_DRAWN - drawn);
                drawn += tiles.length;
                const [across, down] = g.size ?? [Math.min(ROW, tiles.length), Math.ceil(tiles.length / ROW)];
                const perState = g.size ? across * down : tiles.length;
                const states = Math.ceil(tiles.length / perState);
                const width = states * across * TILE + (states - 1) * GAP;
                const height = down * TILE;
                const pixels = pixelBuffer(width, height, 1, `The picture of ${g.name.toLowerCase()}`);
                tiles.forEach((t, i) => {
                    const tile = found.tiles[t];
                    if (!tile || tile.width !== TILE || tile.height !== TILE) return;
                    const state = Math.floor(i / perState);
                    const x0 = state * (across * TILE + GAP) + ((i % perState) % across) * TILE;
                    const y0 = Math.floor((i % perState) / across) * TILE;
                    for (let y = 0; y < TILE; y++) pixels.set(tile.pixels.subarray(y * TILE, y * TILE + TILE), (y0 + y) * width + x0);
                });
                frames.push({ width, height, pixels });
            }
        }

        // The index, then each group, word by word.
        const indexField: Field = {
            name: 'Index',
            offset: 0,
            length: (count + 1) * 2,
            value: `${groupCount} groups`,
            children: [
                field('Entries', 0, 2, count, `The groups and the end marker after them.`),
                ...groups.map((g) => field(`Group ${g.number}: ${g.name}`, g.number * 2, 2, `word ${g.start.toLocaleString('en-US')}`, `Byte ${(g.start * 2).toLocaleString('en-US')}.`)),
                field('End marker', count * 2, 2, word(count), 'Always 0. The game doesn’t read it.'),
            ],
        };
        const groupFields: Field[] = groups
            .filter((g) => g.tiles.length)
            .map((g) => {
                const perState = g.size ? g.size[0] * g.size[1] : 0;
                const children: Field[] = [];
                if (perState)
                    for (let s = 0; s * perState < g.tiles.length; s++) {
                        const tiles = g.tiles.slice(s * perState, (s + 1) * perState);
                        children.push(field(`State ${s + 1}`, (g.start + s * perState) * 2, tiles.length * 2, tiles.join(' '), `Its ${g.size![0]} × ${g.size![1]} tiles, row by row.`));
                    }
                return {
                    name: `Group ${g.number}: ${g.name}`,
                    offset: g.start * 2,
                    length: (g.end - g.start) * 2,
                    value: perState
                        ? `${Math.ceil(g.tiles.length / perState)} state${g.tiles.length > perState ? 's' : ''} of ${g.size![0]} × ${g.size![1]} tiles`
                        : `${g.tiles.length} tile${g.tiles.length === 1 ? '' : 's'}`,
                    note: `Tiles ${runs(g.tiles)}.`,
                    children,
                };
            });
        const fields = [indexField, ...groupFields];
        if (data.length & 1) fields.push(field('Unread byte', data.length - 1, 1, data[data.length - 1], 'Half a word.'));

        const all = groups.flatMap((g) => g.tiles);
        const pictures = found
            ? `${frames.length} group${frames.length === 1 ? '' : 's'} drawn from ICON.ICN (${found.source})${drawn >= MAX_DRAWN ? `, the first ${MAX_DRAWN.toLocaleString('en-US')} tiles` : ''}`
            : 'Open ICON.ICN too (it’s in DUNE.PAK) to see each group drawn';
        return {
            title: 'Map tile groups (Dune II ICON.MAP)',
            summary: [
                ['Groups', groupCount.toLocaleString('en-US')],
                ['Tiles', all.length ? `${all.length.toLocaleString('en-US')} listed, numbers ${minOf(all)} to ${maxOf(all)}` : 'None'],
                ['Pictures', pictures],
            ],
            fields,
            ...(frames.length ? { preview: { kind: 'images' as const, frames, transparentIndex: 0 } } : {}),
            // An odd last byte is marked and warned about above; past that is nothing the file has.
            end: data.length,
            warnings,
        };
    },
};

export default parser;
