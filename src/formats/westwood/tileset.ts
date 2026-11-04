import { tilesLayout, type TilesLayout } from './sniff';

/** A tile set's distinct tiles and which tile each cell uses; shared by the tile set parser and the map renderer. */

export const EMPTY_CELL = 0xff;

export interface TileSet {
    layout: TilesLayout;
    /** Each distinct tile's pixels. */
    tiles: Uint8Array[];
    /** The tile in each cell of the template, or EMPTY_CELL. */
    cells: number[];
}

export function readTileSet(data: Uint8Array): TileSet | null {
    const layout = tilesLayout(data);
    if (!layout) return null;
    const { width, height, count, icons, map } = layout;
    const size = width * height;
    const tiles = Array.from({ length: Math.floor((map - icons) / size) }, (_, i) => data.subarray(icons + i * size, icons + (i + 1) * size));
    return { layout, tiles, cells: Array.from(data.subarray(map, map + count)) };
}
