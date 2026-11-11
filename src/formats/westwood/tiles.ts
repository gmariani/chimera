import { Bytes, bytesLabel, field } from '../../core/bytes';
import type { Field, FormatParser, IndexedImage } from '../../core/types';
import { templateOf } from './templates';
import { EMPTY_CELL as EMPTY, readTileSet } from './tileset';

/**
 * Terrain tile sets (.tem, .des, .win, .sno, .int, and .icn). One file is one
 * template: a block of cells, say a 3×3 piece of shore. The file holds each
 * distinct 24×24 tile once, then a map saying which tile goes in each cell
 * (0xFF: the cell is empty). Templates of 1×1 cells with several tiles, like
 * CLEAR1, are variants the game picks between.
 *
 * TD's header is 32 bytes; RA's is 40, adding the template's width and height
 * (TD keeps those in the game's code, so they come from a table here).
 */

const parser: FormatParser = {
    parse(data, context) {
        const set = readTileSet(data);
        if (!set) throw new Error("This isn't a tile set the app understands.");
        const b = new Bytes(data);
        const { game, width, height, count, icons, map, trans, colorMap } = set.layout;
        const tileSize = width * height;
        const physical = set.tiles.length;
        const warnings: string[] = [];

        const tiles: IndexedImage[] = set.tiles.map((pixels) => ({ width, height, pixels }));
        const { cells } = set;
        const missing = cells.filter((c) => c !== EMPTY && c >= physical);
        if (missing.length) warnings.push(`${missing.length} cells name tiles that aren't in the file.`);

        // How many cells wide the template is: RA says; for TD, the table of templates does, when the name is known.
        const template = templateOf(context.name, game);
        const [columns, rows] = game === 'ra' ? [set.layout.mapWidth, set.layout.mapHeight] : [template?.width, template?.height];
        const sized = columns !== undefined && rows !== undefined;
        const variants = sized && columns * rows === 1 && count > 1;
        // Lay the cells out as the template looks in the game; otherwise just show each tile.
        const grid = sized && columns * rows === count && count > 1;
        const blank = new Uint8Array(tileSize);
        const frames = grid ? cells.map((c) => (c === EMPTY || c >= physical ? { width, height, pixels: blank } : tiles[c])) : tiles;

        const header: Field[] = [
            field('Tile width', 0, 2, width),
            field('Tile height', 2, 2, height),
            field('Cells', 4, 2, count, 'Entries in the map: cells of the template, or variants of a 1×1 one.'),
            field('Allocated', 6, 2, b.u16(6), 'Set by the game when it loads the file.'),
        ];
        let at = 8;
        if (game === 'ra') {
            header.push(field('Template width', 8, 2, set.layout.mapWidth, 'In cells.'), field('Template height', 10, 2, set.layout.mapHeight, 'In cells.'));
            at = 12;
        }
        header.push(
            field('File size', at, 4, bytesLabel(b.u32(at))),
            field('Tiles offset', at + 4, 4, icons),
            field('Palettes', at + 8, 4, b.u32(at + 8), 'Unused.'),
            field(
                'Remaps',
                at + 12,
                4,
                `0x${b
                    .u32(at + 12)
                    .toString(16)
                    .toUpperCase()}`,
                'A leftover pointer from the tool that wrote the file.'
            ),
            field('Transparency offset', at + 16, 4, trans)
        );
        if (game === 'ra') header.push(field('Land types offset', at + 20, 4, colorMap), field('Map offset', at + 24, 4, map));
        else header.push(field('Map offset', at + 20, 4, map));

        const fields: Field[] = [
            { name: 'Header', offset: 0, length: game === 'ra' ? 40 : 32, children: header },
            {
                name: `Tiles (${physical})`,
                offset: icons,
                length: physical * tileSize,
                note: 'Each distinct tile once, row by row, one palette index per pixel.',
                children: tiles.map((_, i) => field(`Tile ${i}`, icons + i * tileSize, tileSize, `${width} × ${height}`)),
            },
            {
                name: `Map (${count})`,
                offset: map,
                length: count,
                note: grid ? `Row by row, ${columns} cells wide.` : 'Which tile each entry uses.',
                children: cells.map((c, i) => field(grid ? `Cell ${i % columns!}, ${Math.floor(i / columns!)}` : `Entry ${i}`, map + i, 1, c === EMPTY ? 'Empty' : `Tile ${c}`)),
            },
            {
                name: 'Transparency',
                offset: trans,
                length: physical,
                note: "One byte per tile: 1 means color 0 shows what's underneath (for overlays like trans.icn).",
                children: tiles.map((_, i) => field(`Tile ${i}`, trans + i, 1, b.u8(trans + i))),
            },
        ];
        if (game === 'ra' && colorMap)
            fields.push(
                field(
                    'Land types',
                    colorMap,
                    data.length - colorMap,
                    Array.from(data.subarray(colorMap)).join(' '),
                    'The kind of ground in each tile (clear, water, rock…), which also sets its color on the radar.'
                )
            );

        return {
            title: `Tile set (${game === 'ra' ? 'RA' : 'TD'})`,
            summary: [
                ['Template', `${template ? `${template.name}, ` : ''}${sized ? `${columns} × ${rows} cells` : 'size unknown without the file name'}`],
                ['Tiles', `${physical} of ${width} × ${height}`],
                ['Cells', `${count}${cells.includes(EMPTY) ? `, ${cells.filter((c) => c === EMPTY).length} empty` : ''}`],
                ...(variants ? [['Variants', 'The game picks one of these tiles for each cell'] as [string, string]] : []),
            ],
            fields,
            preview: { kind: 'images', frames, transparentIndex: 0, columns: grid ? columns : undefined },
            warnings,
        };
    },
};

export default parser;
