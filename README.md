# .chimera

A universal file inspector that runs in the browser. Open a file to see how it's put together: every field, what it means, and the bytes behind it, in a structure tree linked to a hex view (in the spirit of 010 Editor templates). Archives open up so you can look inside each file they hold, preview it, and pull any of it out. Nothing is uploaded.

## Formats

| Format | Read | Preview | Extract |
| --- | --- | --- | --- |
| Westwood MIX (TD, RA, TS, RA2, and RA2's .mmx/.yro maps), plain or Blowfish-encrypted | full structure, names from hashes | — | single files, all as ZIP, nested MIX |
| SHP sprites (TD/RA, TS/RA2, and the Dune II-style cursors) | headers, frame table | all frames, animation, any palette | PNG frame, sheet, all frames |
| AUD audio (IMA and Westwood ADPCM) | headers, chunks | player | WAV |
| CPS and PCX pictures (256-colour and 24-bit) | headers | image | PNG |
| WSA animations | headers, frame offsets | all frames, animation | PNG frame, sheet, all frames |
| Terrain tile sets (.tem, .des, .win, .sno, .int, .icn) | header, tiles, cell map | the template assembled, each tile | PNG |
| VQA video (TD/RA version 2; TS's high-colour version 3) | chunk map, VQHD | player with sound | PNG frame, all frames, WAV |
| Isometric tiles (TS/RA2 .tem, .sno, .urb, .des, .lun, .ubn) | header, every cell | assembled, each cell | PNG |
| Voxel models (.vxl) and animations (.hva) | headers, limbs, matrices | each limb from four sides | PNG |
| WAV sound (PCM and IMA ADPCM) | chunks, format | player | WAV |
| RA2 sound banks (audio.idx with audio.bag) | every sound | each sound as a WAV | WAV |
| CSF string tables (RA2) | every label | text | — |
| Bink video (RA2's movies) | header | — (the codec isn't public) | — |
| Maps (TD .bin with its mission INI, RA [MapPack] in mission INIs) | every cell | drawn with the game's tiles, ore, walls and trees once the theater archive is open; terrain kinds with a key | PNG |
| Fonts (.fnt: TD/RA 4-bit, TS 8-bit, TS/RA2 1-bit and Unicode) | header, each character | every character | PNG |
| PAL palettes | each colour | swatches, use for sprites | — |
| String tables (.eng, .ger, .fre) | offsets, each string | numbered list | — |
| Colour remap tables (TD .mrf) | each table | the palette through each table | PNG |
| Chronal vortex frames (RA .lut) | every pixel | warp and shading | PNG |
| VQP palette blending tables | tables | first table | — |
| INI files | sections and entries | text | — |
| XCC local mix database | names | list | — |
| Other text | — | text | — |

Template names, TD template sizes, overlay and tree names, how ore and walls pick their frames, and the remap table and vortex layouts come from the GPL source of the Remastered Collection (`DEFINES.H`, `CDATA.CPP`, `ODATA.CPP`, `TDATA.CPP`, `CELL.CPP`, `DISPLAY.CPP`, `VORTEX.CPP`).

Anything else opens in the hex view. The only files in the TD and RA Remastered data that still do are `record.bin` (a recorded game: TD writes its in-memory structures straight to disk, so the layout depends on the build) and two empty files; in TS and RA2's archives, a handful of small unidentified files.

Some files need others: a map needs its theater's tiles and palette, and a TD map's `.bin` and `.ini` need each other. Every archive opened in a session (and the archives inside it) is kept, so files can find their companions there. Drop several files at once to open the first with the rest alongside it, or use **Add files…** on the note a file shows when it's missing one. For TD, that's GENERAL.MIX with TEMPERAT.MIX (or DESERT.MIX, WINTER.MIX) and CONQUER.MIX for walls; for RA, MAIN.MIX with REDALERT.MIX for the palettes.

MIX archives store a hash of each file name, not the name. Names come from the archive's own `local mix database.dat` (if XCC added one), a built-in list of common C&C names, the INIs in the archives you open (TS and RA2 keep no names, but `rules.ini`, `art.ini` and the theater INIs name nearly every asset; opening RA2's `ra2.mix` names 90–99% of most archives inside it), and any list you load with **Add names…** (XCC's `global mix database.dat`, or a text file with one name per line). TS's speech files are only named in the game's executable, so they need XCC's list.

## Adding a format

Each format is a plain TypeScript module that turns bytes into data. It never renders anything, so the UI stays generic:

1. Write a parser in `src/formats/` that exports a `FormatParser` (`src/core/types.ts`). `parse()` returns:
   - `fields`: a tree of `{ name, offset, length, value, note }`. This drives the structure tree and the hex colouring.
   - `entries` (optional): files held inside, which can be opened and extracted.
   - `preview` (optional): `images` (indexed pixels), `palette`, `audio` (WAV bytes) or `text`.
   - `overlays` (optional): bytes to show in place of the file's own, such as a decrypted header.
   - `wanted` (optional): which other file would let it show more.

   A parser that needs other files uses `context.find(name)`, and sets `companions: true` in the registry so it runs again when more files are opened.
2. Add a cheap `sniff()` and register both in `src/formats/index.ts`. The parser is loaded on demand.

## Development

```sh
npm install
npm run dev      # http://localhost:5173
npm test         # also checks every file in "MIX Samples/" if that folder exists

# Every MIX in a game install, every archive nested in those, and every file inside them:
CHIMERA_GAME_DATA=/path/to/CnCRemastered/Data/CNCDATA npx vitest run src/formats/gamedata.test.ts
# Several installs at once, separated by ":" (";" on Windows), e.g. adding TS's and RA2's folders.
npm run build    # static site in build/
```

The original webpack/JPG/SWF attempt is kept in `legacy/`.

## References

- [MIX format](https://xhp.xwis.net/documents/MIX_Format.html), Olaf van der Spek. The Blowfish key derivation here is the spec's bignum code reduced to `BigInt` RSA; the tests check it against the spec's C++ compiled as-is.
