# .chimera

A universal file inspector that runs in the browser. Open a file to see how it's put together: every field, what it means, and the bytes behind it, in a structure tree linked to a hex view (in the spirit of 010 Editor templates). Archives open up so you can look inside each file they hold, preview it, and pull any of it out. Nothing is uploaded.

## Todo
- .t1 font
- .afm font
- .sol shared objects
- .flv Flash Video
- bink2 https://github.com/mrtnmtth/FFmpeg-bink2
- swf preview with ruffle
- test dune 2
- test dune 2k

## Formats

| Format | Read | Preview | Extract |
| --- | --- | --- | --- |
| Westwood MIX (TD, RA, TS, RA2, and RA2's .mmx/.yro maps), plain or Blowfish-encrypted | full structure, names from hashes | — | single files, all as ZIP, nested MIX |
| Petroglyph MEG archives (versions 1–3: Empire at War, the C&C Remastered Collection's music, sound, textures and config) | header, names, records | — | single files, all as ZIP |
| SHP sprites (TD/RA, TS/RA2, and the Dune II-style cursors) | headers, frame table | all frames, animation, any palette | PNG frame, sheet, all frames |
| AUD audio (IMA and Westwood ADPCM) | headers, chunks | player | WAV |
| CPS and PCX pictures (256-color and 24-bit) | headers | image | PNG |
| WSA animations | headers, frame offsets | all frames, animation | PNG frame, sheet, all frames |
| Terrain tile sets (.tem, .des, .win, .sno, .int, .icn) | header, tiles, cell map | the template assembled, each tile | PNG |
| VQA video (TD/RA version 2; TS's high-color version 3) | chunk map, VQHD | player with sound | PNG frame, all frames, WAV |
| Isometric tiles (TS/RA2 .tem, .sno, .urb, .des, .lun, .ubn) | header, every cell | assembled, each cell | PNG |
| Voxel models (.vxl) and animations (.hva) | headers, limbs, matrices | 3D viewer (turn, zoom, animate; turret and barrel placed by art.ini; lit by each voxel's normal), each limb from four sides | PNG |
| Voxel lighting tables (voxels.vpl) | header, tables | the palette at each light level | PNG |
| WAV sound (PCM, IMA ADPCM, and Microsoft ADPCM as the Remastered Collection's music uses) | chunks, format | player | WAV |
| RA2 sound banks (audio.idx with audio.bag) | every sound | each sound as a WAV | WAV |
| CSF string tables (RA2) | every label | text | — |
| LOC string tables (the Remastered Collection's text and credits, in Config.meg) | header, every record, value and key | text | — |
| Petroglyph chunk files (the Remastered Collection's .bui UI layouts, .cfx, .bfd, .gtl, .gpd, .cpd, .sob; undocumented, so most ids are unnamed) | header; once uncompressed, every chunk and property | outline of a layout's widgets, or the file's strings | the uncompressed file |
| Bink video (RA2's movies) and Bink 2 (the Remastered Collection's) | header, frame index | player with sound, decoded by FFmpeg's Bink decoders compiled to WebAssembly; Bink 2's sound only, each track (FFmpeg has no Bink 2 video decoder) | PNG frame, all frames, WAV |
| Maps (TD .bin with its mission INI, RA [MapPack] in mission INIs) | every cell, every object | drawn with the game's tiles, ore, walls, trees, craters, buildings, units and infantry (in each side's color) once the theater archive is open; terrain kinds with a key | PNG |
| TS and RA2 maps (.map, .mpr, .yrm; inside .mmx/.yro) | sections, cells, overlays, objects | drawn with the game's tiles, ore, walls, bridges, trees, buildings (with their animated parts, defense turrets and damage), infantry and lit voxel vehicles (in each side's color) once the main archive is open (otherwise by height); the map's own preview | PNG |
| Fonts (.fnt: TD/RA 4-bit, TS 8-bit, TS/RA2 1-bit and Unicode) | header, each character | every character | PNG |
| PAL palettes | each color | swatches, use for sprites | — |
| String tables (.eng, .ger, .fre) | offsets, each string | numbered list | — |
| Color remap tables (TD .mrf) | each table | the palette through each table | PNG |
| Chronal vortex frames (RA .lut) | every pixel | warp and shading | PNG |
| VQP palette blending tables | tables | first table | — |
| INI files | sections and entries | text; for rules.ini, a table of every unit and building (name, cost, strength, art) linking to its sprite or voxel model | — |
| XCC local mix database | names | list | — |
| JPEG pictures (baseline, extended, progressive; JFIF, EXIF, XMP, ICC, Adobe and other APPn segments) | every segment to the T.81 parameters, EXIF tags | image | PNG, EXIF and JFIF thumbnails |
| TIFF pictures (strips and tiles; none, PackBits, LZW, Deflate, JPEG, CCITT fax; bilevel to CMYK, YCbCr and L\*a\*b\*; DNG, NEF and CR2 previews) | header, every IFD and tag | every page | PNG, embedded JPEGs |
| PNG pictures (every color type and depth, Adam7) | every chunk, text | image | PNG |
| GIF pictures and animations (87a, 89a; interlaced, transparency, local color tables, every disposal) | header, screen, color tables, every extension and frame | image; animations play with their own timing | PNG frame, all frames |
| MP3 and other MPEG audio | ID3 tags, frames | player | MP3 |
| Ogg (Vorbis, Opus, FLAC; Speex and Theora described, not played) | every page, codec headers, tags | player | Ogg |
| Flash movies (SWF, plain or zlib-compressed) | header and every tag by frame, to the SWF 19 fields | metadata | bitmaps (JPEG, PNG), sounds (MP3; PCM, ADPCM and Nellymoser as WAV), streamed sound, video as FLV, binary data, fonts, ABC bytecode, the uncompressed movie |
| Pixel Bender kernels (.pbj) | every record and instruction | disassembly | — |
| TrueType and OpenType fonts (TrueType and CFF outlines, CID-keyed; collections) | table directory, head, hhea, maxp, name, OS/2, post, cmap, CFF | every glyph, the names | PNG |
| Other text | — | text | — |

Sprites and voxels have a **Team color** picker: the games recolor 16 palette entries for the owner (176–191 in TD, 80–95 in RA, 16–31 in TS and RA2); the shades here are close to the games', not exact.

Voxels are lit by each voxel's normal, against the light the TS/RA2 mission editor uses; the normal tables are from that editor's source, which EA released under the GPL 3. The brightness range is gentler than the editor's, which washes colors out here.

Template names, TD template sizes, overlay and tree names, how ore and walls pick their frames, and the remap table and vortex layouts come from the GPL source of the Remastered Collection (`DEFINES.H`, `CDATA.CPP`, `ODATA.CPP`, `TDATA.CPP`, `CELL.CPP`, `DISPLAY.CPP`, `VORTEX.CPP`).

Anything else opens in the hex view. The only files in the TD and RA Remastered data that still do are `record.bin` (a recorded game: TD writes its in-memory structures straight to disk, so the layout depends on the build) and two empty files; in TS and RA2's archives, nothing.

Some files need others: a map needs its theater's tiles and palette, and a TD map's `.bin` and `.ini` need each other. Every file opened or added in a session (and the archives inside it) stays available, and files find their companions there by name. **Files in use** (top right) lists them, with what each brought, and removes or adds them; they're kept until removed or the tab closes. A file's **Linked files** tab shows which files it used, from which archive and what for, and which it looked for but couldn't find, with **Add files…** to fix that. Drop several files at once to open the first with the rest alongside it. For TD, that's GENERAL.MIX with TEMPERAT.MIX (or DESERT.MIX, WINTER.MIX) and CONQUER.MIX for walls; for RA, MAIN.MIX with REDALERT.MIX for the palettes; for TS and RA2, the maps' archive with TIBSUN.MIX or RA2.MIX (and RA2MD.MIX for Yuri's Revenge). Voxel models find their animation, turret and barrel the same way.

MIX archives store a hash of each file name, not the name. Names come from the archive's own `local mix database.dat` (if XCC added one), a built-in list of common C&C names, the INIs in the archives you open (TS and RA2 keep no names, but `rules.ini`, `art.ini` and the theater INIs name nearly every asset; opening RA2's `ra2.mix` names 90–99% of most archives inside it), and any list you load with **Add names…**: XCC's `global mix database.dat`, a text file with one name per line, or the game's executable (TS's `Game.exe`, RA2's `gamemd.exe`), whose file names and name patterns (`E%02dSC%02d.MIX`) are read out of it. TS's speech files aren't named anywhere in the game, so they need XCC's list.

## Adding a format

Each format is a plain TypeScript module that turns bytes into data. It never renders anything, so the UI stays generic:

1. Write a parser in `src/formats/` that exports a `FormatParser` (`src/core/types.ts`). `parse()` returns:
   - `fields`: a tree of `{ name, offset, length, value, note }`. This drives the structure tree and the hex coloring.
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
npm test         # also checks the files in samples/ (westwood, flash, images, fonts) when they exist

# Every MIX in a game install, every archive nested in those, and every file inside them:
CHIMERA_GAME_DATA=/path/to/CnCRemastered/Data/CNCDATA npx vitest run src/formats/gamedata.test.ts
# Several installs at once, separated by ":" (";" on Windows), e.g. adding TS's and RA2's folders.
npm run build    # static site in build/
```

The original webpack/JPG/SWF attempt is kept in `legacy/`.

## Bink (WebAssembly)

Bink is decoded by FFmpeg's Bink video and audio decoders, compiled to WebAssembly into `src/formats/westwood/bink-wasm/bink.mjs` (about 670 kB, loaded only when a `.bik` is opened). To rebuild it, with Docker running:

```sh
./wasm/bink/build.sh   # downloads FFmpeg (the release named in the script), builds in Emscripten's image
```

Only libavcodec's Bink decoders are built; the container is read in TypeScript (`src/formats/westwood/bink.ts`), and `wasm/bink/wrapper.c` is the small C API between them. RA2's movies have a single keyframe, so while a movie plays the decoder's reference frame is kept every 100 frames, and a jump decodes only from the nearest one. To reach that frame, the build appends one accessor to FFmpeg's `bink.c` (`wasm/bink/bink-reference.c`). FFmpeg is LGPL 2.1+ (see `bink-wasm/LICENSE.ffmpeg.md`).

## References

- [MIX format](https://xhp.xwis.net/documents/MIX_Format.html), Olaf van der Spek. The Blowfish key derivation here is the spec's bignum code reduced to `BigInt` RSA; the tests check it against the spec's C++ compiled as-is.
