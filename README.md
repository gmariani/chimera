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
| Westwood PAK archives (versions 1–3: Eye of the Beholder, Dune II, the Legend of Kyrandia, Lands of Lore) | header, every entry and end marker; duplicates and hidden data called out | — | single files, all as ZIP |
| Petroglyph MEG archives (versions 1–3: Empire at War, the C&C Remastered Collection's music, sound, textures and config) | header, names, records | — | single files, all as ZIP |
| SHP sprites (TD/RA, TS/RA2, Dune II, and TD/RA's Dune II-style cursors) | headers, frame table | all frames, animation, any palette | PNG frame, sheet, all frames |
| AUD audio (plain PCM, IMA and Westwood ADPCM) | header, every chunk; sizes that don't add up and hidden data called out | player | WAV |
| CPS pictures (PC and Amiga; uncompressed, LZW 12- and 14-bit, RLE, LCW) | header, palettes; damaged compressed data and hidden data called out | image (each palette, on the Amiga) | PNG |
| CMP pictures (CPS's predecessor: A Nightmare on Elm Street, DragonStrike; 4-bit RLE across or down, 8-bit RLE, LZW 12- and 14-bit) and Lands of Lore's packed .cmp files | header; damaged data and hidden data called out | image (EGA colors for 4-bit); the packed file inside | PNG |
| PCX pictures (256-color and 24-bit) | headers | image | PNG |
| WSA animations (C&C and Kyrandia; Dune II 1.00 and 1.07) | header, frame offsets, palette, every frame; buffer overruns and broken loops called out | all frames, animation | PNG frame, sheet, all frames |
| Terrain tile sets (.tem, .des, .win, .sno, .int, .icn) | header, tiles, cell map | the template assembled, each tile | PNG |
| Dune II mentat encyclopedia (MENTATA/H/O.ENG: an IFF of topics and their texts, compressed as the game does) | every topic and text; texts nothing points to called out | the encyclopedia as text, under its headings, with each topic's animation | — |
| Dune II map tiles (ICON.ICN: an IFF of 16-color tiles, their palettes, and which each uses) | every chunk; tiles, palettes and tables that don't agree called out | each tile, see-through edges as the game draws them | PNG |
| Dune II map tile groups (ICON.MAP: which of ICON.ICN's tiles make each crater, wall, landscape and building) | the index and each group by name, a building's states footprint by footprint; groups the game would misread called out | with ICON.ICN open, each group drawn, a building's states side by side | PNG |
| Dune II scripts (BUILD.EMC, UNIT.EMC, TEAM.EMC: an IFF of entry points and bytecode) | every chunk; each structure's, unit's or team's script, every instruction decoded, the game's routines named (from OpenDUNE); opcodes, operations and routines the game lacks, and jumps that land wrong, called out | the scripts as a listing, one instruction a line, jump targets marked | — |
| Dune II credits (CREDITS.ENG, .FRE, .GER: 1.07's, in ENGLISH.PAK and loose) | every row and the strings in it, each style byte named (title, role, name, small print), the separators and the NUL; style bytes where the game wouldn't read them, and a missing NUL, called out | the credits laid out as the game draws them, roles to the left of the middle and names to the right | — |
| Dune II settings (DUNE.CFG from its setup, decoded from its XOR; OPTIONS.CFG from the game's options screen) | each setting, the sound drivers named from the game's own lists, the language, the checksum; what DUNE2.EXE's own start-up code does with them (every graphics value it takes means the same; Miles's FM music drivers swapped for its own AdLib player); settings the game would refuse called out | — | — |
| Dune II gray remap (GRAYRMAP.TBL: 256 bytes, the color drawn in place of each, to gray out what the factory can't offer yet) | each color and what it becomes; with IBM.PAL open, their colors, and any that aren't gray | the palette before and after | PNG |
| VQA video (TD/RA version 2; TS's high-color version 3) | chunk map, VQHD | player with sound | PNG frame, all frames, WAV |
| Isometric tiles (TS/RA2 .tem, .sno, .urb, .des, .lun, .ubn) | header, every cell | assembled, each cell | PNG |
| Voxel models (.vxl) and animations (.hva) | headers, limbs, matrices | 3D viewer (turn, zoom, animate; turret and barrel placed by art.ini; lit by each voxel's normal), each limb from four sides | PNG |
| Voxel lighting tables (voxels.vpl) | header, tables | the palette at each light level | PNG |
| WAV sound (PCM, IMA ADPCM, and Microsoft ADPCM as the Remastered Collection's music uses) | chunks, format | player | WAV |
| Creative Voice (.voc: 8- and 16-bit PCM, A-law, µ-law, Creative ADPCM at 4, 2.6 and 2 bits; Dune II's sounds) | header, every block (sound, silence, markers, text, repeats) | player | WAV |
| RA2 sound banks (audio.idx with audio.bag) | every sound | each sound as a WAV | WAV |
| CSF string tables (RA2) | every label | text | — |
| LOC string tables (the Remastered Collection's text and credits, in Config.meg) | header, every record, value and key | text | — |
| Petroglyph chunk files (the Remastered Collection's .bui UI layouts, .cfx, .bfd, .gtl, .gpd, .cpd, .sob; undocumented, so most ids are unnamed) | header; once uncompressed, every chunk and property | outline of a layout's widgets, or the file's strings | the uncompressed file |
| Bink video (RA2's movies) and Bink 2 (the Remastered Collection's) | header, frame index | player with sound, a choice of sound track, alpha over a checkerboard; decoded by FFmpeg's Bink decoders and an unmerged Bink 2 decoder, compiled to WebAssembly | PNG frame, all frames, WAV |
| Maps (TD .bin with its mission INI, RA [MapPack] in mission INIs) | every cell, every object | drawn with the game's tiles, ore, walls, trees, craters, buildings, units and infantry (in each side's color) once the theater archive is open; terrain kinds with a key | PNG |
| TS and RA2 maps (.map, .mpr, .yrm; inside .mmx/.yro) | sections, cells, overlays, objects | drawn with the game's tiles, ore, walls, bridges, trees, buildings (with their animated parts, defense turrets and damage), infantry and lit voxel vehicles (in each side's color) once the main archive is open (otherwise by height); the map's own preview | PNG |
| Fonts (.fnt: TD/RA 4-bit, TS 8-bit; 1-bit BitFonts: TS/RA2 Unicode, RA2's map editor, Nox) | header, each character; pixels hidden past a glyph's width, unused glyphs and data after the end called out | every character | PNG |
| PAL palettes | each color | swatches, use for sprites | — |
| String tables (.eng, .ger, .fre; Dune II's compressed ones decompressed) | offsets, each string | numbered list, in DOS's characters (C&C's accents, box lines) | — |
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
| 16-bit Windows modules (NE: Windows 3 programs, libraries and drivers, .fon fonts, icon libraries such as Dune II's DUNE2.ICO) | MZ and NE headers, segments, resources, names, imports; bytes nothing points to called out; one with no code under another name is warned about, one with code is dangerous | bitmaps (icons and cursors open from Contents) | each resource; each icon and cursor group as an .ico or .cur, which opens and draws |
| DOS programs (MZ .exe: Dune II's DUNE2.EXE and SETUP.EXE, and other DOS games) | the header (sizes, memory, where it starts, the stack, the checksum checked), the relocations by segment, TLINK's, LZEXE's and PKLITE's marks; a self-extracting ZIP after the program, with the names of its files; Borland's overlays (FBOV): TLINK's table of segments, each overlay's stub, code and fixups; an image past the file's end, a start outside it, relocations and fixups pointing outside, called out, and what's after the image left to the usual checks | the segments, from TLINK's table: what each is, how big, where in the file | each overlay's code; a self-extractor's ZIP |
| XMIDI music (.xmi, and Dune II's .c55, .pcs, .tan: Miles's MIDI, in IFF) | the directory, each sequence's instruments, branch points, loops and events; which sequences Dune II plays as music; events a MIDI file can't hold, notes that run out, loops nested too deep, and counts that disagree called out | each sequence's piano roll, and up to 4 minutes of them played through Chimera's simple synthesizer (the game's music first) | each sequence as a standard MIDI file (.mid), its loops played out |
| MIDI music (.mid: standard MIDI files, formats 0 to 2) | the header and each track; times through the tempo map (or in frames); running status; tracks and events that break the specification called out | a piano roll, and the song played through Chimera's simple synthesizer | — |
| Westwood AdLib music (.adl: Eye of the Beholder, Dune II, Kyrandia, Lands of Lore; versions 1 to 4) | the track, program and instrument tables; every program's commands, named (notes, repeats, jumps, instruments, drums), and each instrument's chip registers; which tracks Dune II plays as music; repeats that land out of step, commands the player lacks, missing programs and instruments called out | each track, the program it starts, and the voices that one starts; the music played as the game plays it (Westwood's player on an emulated AdLib), each track on a timeline of its notes: the tracks Dune II plays as music, or in other games' files those that start the conductor | each played track as WAV |
| Westwood sound drivers (.drv: Dune II's ALFX.DRV for AdLib and PCSOUND.DRV for the PC speaker; Kyrandia's are built the same way) | the two entry points, the dispatcher, all 18 functions by name (from ScummVM's reimplementation) with what each takes and which do nothing, the version and size each reports, ALFX's table of .ADL music commands, PCSOUND's note pitches, and the timer rate Dune II gives each; functions outside the file or in the tables, and a size that doesn't match, called out | — | — |
| Miles sound drivers (AIL 2 .adv: Dune II, Kyrandia and other DOS games of 1992–93) | the copyright, every function by name and where its code is, the description (music or digital, port, IRQ, DMA, timer rate) and the devices it drives; functions AIL never calls, or whose code is outside the file or in the tables, called out | — | — |
| Windows program information files (.pif) | the basic section (title, memory, program, folder, parameters, screen) and every section header; the sections' own settings shown whole, with what they name | — | — |
| Windows icons and cursors (.ico, .cur) | header, every entry and image: bitmap header, colors, pixels, mask; sizes that don't agree, masks saved as text, bytes nothing points to called out | every size (1 to 32 bits a pixel, and PNG), see-through as drawn | — |
| Other text | — | text | — |

Sprites and voxels have a **Team color** picker: the games recolor 16 palette entries for the owner (176–191 in TD, 80–95 in RA, 16–31 in TS and RA2); the shades here are close to the games', not exact.

Voxels are lit by each voxel's normal, against the light the TS/RA2 mission editor uses; the normal tables are from that editor's source, which EA released under the GPL 3. The brightness range is gentler than the editor's, which washes colors out here.

Template names, TD template sizes, overlay and tree names, how ore and walls pick their frames, and the remap table and vortex layouts come from the GPL source of the Remastered Collection (`DEFINES.H`, `CDATA.CPP`, `ODATA.CPP`, `TDATA.CPP`, `CELL.CPP`, `DISPLAY.CPP`, `VORTEX.CPP`).

## Is it what it claims?

Every file gets the same checks, whatever its format, so a file that isn't what it's expected to be is called out, for looking into suspicious files as much as for learning formats:

- **Name and signature:** if the extension or the first bytes say one format (loosely: `GIF` is enough to claim a GIF) and the file doesn't read as it, that's flagged, with why it doesn't read as one and what it is instead. Each format that could fit is tried in turn, and **Open as** shows it as any of them.
- **After the end:** bytes past where the format ends (after a GIF's trailer, a PNG's IEND, a JPEG's last marker, or the last byte any field covers) are flagged and listed under Contents to open, unless they're a few zeros of padding.
- **What it really is:** files no parser reads are identified by signature (Windows, DOS, Linux and Mac programs, archives, PDFs, Office documents, shortcuts and more) and by how random their bytes are. Nothing is guessed beyond that: what a disguised file holds is for you to work out, in the hex view.

Anything else opens in the hex view. The only files in the TD and RA Remastered data that still do are `record.bin` (a recorded game: TD writes its in-memory structures straight to disk, so the layout depends on the build) and two empty files; in TS and RA2's archives, nothing.

Some files need others: a map needs its theater's tiles and palette, and a TD map's `.bin` and `.ini` need each other. Every file opened or added in a session (and the archives inside it) stays available, and files find their companions there by name. **Files in use** (top right) lists them, with what each brought, and removes or adds them; they're kept until removed or the tab closes. A file's **Linked files** tab shows which files it used, from which archive and what for, and which it looked for but couldn't find, with **Add files…** to fix that. Drop several files at once to open the first with the rest alongside it. For TD, that's GENERAL.MIX with TEMPERAT.MIX (or DESERT.MIX, WINTER.MIX) and CONQUER.MIX for walls; for RA, MAIN.MIX with REDALERT.MIX for the palettes; for TS and RA2, the maps' archive with TIBSUN.MIX or RA2.MIX (and RA2MD.MIX for Yuri's Revenge). Voxel models find their animation, turret and barrel the same way.

MIX archives store a hash of each file name, not the name. Names come from the archive's own `local mix database.dat` (if XCC added one), a built-in list of common C&C names, the INIs in the archives you open (TS and RA2 keep no names, but `rules.ini`, `art.ini` and the theater INIs name nearly every asset; opening RA2's `ra2.mix` names 90–99% of most archives inside it), and any list you load with **Add names…**: XCC's `global mix database.dat`, a text file with one name per line, or the game's executable (TS's `Game.exe`, RA2's `gamemd.exe`), whose file names and name patterns (`E%02dSC%02d.MIX`) are read out of it. TS's speech files aren't named anywhere in the game, so they need XCC's list.

## Where files are read

Every file is parsed in a Web Worker (`src/engine`), never on the page: the session's files and everything inside them live there too, and the page only draws what comes back (video frames and other on-demand drawing are requests to the worker). If the worker goes quiet for 30 seconds in the middle of reading something, the page stops it, starts a new one with the session's files, and says so; after 3 seconds of reading, **Stop** does the same at once. A read that was stopped isn't tried again in the same session, so a file made to hang a parser can't take the page down in a loop, and its bytes are still shown. Each part of the page is also guarded, so a preview that fails says why while the rest stays usable.

## Adding a format

Each format is a plain TypeScript module that turns bytes into data. It never renders anything, so the UI stays generic:

1. Write a parser in `src/formats/` that exports a `FormatParser` (`src/core/types.ts`). `parse()` returns:
   - `fields`: a tree of `{ name, offset, length, value, note }`. This drives the structure tree and the hex coloring.
   - `entries` (optional): files held inside, which can be opened and extracted.
   - `preview` (optional): `images` (indexed pixels), `palette`, `audio` (WAV bytes) or `text`.
   - `overlays` (optional): bytes to show in place of the file's own, such as a decrypted header.
   - `wanted` (optional): which other file would let it show more.

   A parser that needs other files uses `context.find(name)`, and sets `companions: true` in the registry so it runs again when more files are opened.

   Parsers run in the parsing worker, so they mustn't touch the DOM. A preview's functions (a video's `frame`, a toggle's `off`) are called through the worker, and anything else in a result must survive `postMessage` (plain data and typed arrays).

   Be strict, since a file isn't always what it claims to be:
   - **Throw** when the file isn't the format at all (its parts don't fit, a header field is impossible), with a message saying what's wrong. The next likely format is tried, and the message is shown.
   - **Warn** about anything else the spec doesn't allow: sizes that disagree, values out of range, a missing end marker.
   - **Don't trust sizes, counts or offsets from the file.** Files made to crash parsers claim billions. Check them before allocating or looping with them, using `src/core/limits.ts`: `checkCount` (records must fit in the bytes there are), `pixelBuffer`/`checkPixels` (at most 64 megapixels), `checkBytes` (at most 512 MB), and a `Budget` for what all of a file's frames add up to. A limit stopping a parser is reported as a sign of a crafted file.
   - **Bound every loop** by the data, not just by a marker the file may never have.
   - **Don't spread file-sized lists into arguments** (`Math.max(...list)`, `push(...list)`): past a hundred thousand or so it overflows the stack. Use `minOf`, `maxOf` and `append` from `src/core/math.ts`.
   - **Mark every byte** in `fields`, including padding, so whatever comes after the format's end is caught. If the parser marks bytes past the end itself, it sets `end`.
   - If the format's files also go by other extensions in practice (TD's theater sprites named `.tem`), list them in `alsoNamed` so they aren't called misnamed.

   `src/formats/inspect.test.ts` puts each sample's first 16 bytes in front of the rest in base64, and expects each parser to refuse or flag it. Then run `npm run fuzz` (below), with game data if the format comes from there: it should report no findings.
2. Add a cheap `sniff()` and register both in `src/formats/index.ts`. The parser is loaded on demand.

## Development

```sh
npm install
npm run dev      # http://localhost:5173
npm test         # also checks samples/generated/, any other files in samples/, and the installed games it can find
npm run build    # static site in build/

# The tests that read real game files read them where the games are installed, and skip the games
# they can't find. Each run starts by saying which it found. To say where they are:
npm run test:setup                                # asks for each game's folder, checks it, and saves the answer
npm run test:setup -- dune2=/path/to/DUNE2        # or say it outright
# (Saved to game-data.local.json, which isn't committed. CHIMERA_DUNE2, CHIMERA_CNC_REMASTERED,
# CHIMERA_TIBERIAN_SUN and CHIMERA_RED_ALERT_2 override it. Without either, the usual places are looked in:
# samples/westwood/, and Steam's libraries.)

# Every MIX in the installed games, every archive nested in those, and every file inside them:
npm run test:game-data
CHIMERA_GAME_DATA=/path/to/CnCRemastered/Data/CNCDATA npx vitest run src/formats/gamedata.test.ts   # or other folders
# Several at once, separated by ":" (";" on Windows). That reads every file in full (about 8 minutes).

# Only which format each of those files is taken for, archive by archive, against saved counts (about 30 s):
npm run test:formats:save   # the counts now become the baseline (before changing a sniffer, or to accept a change)
npm run test:formats        # the counts now against the baseline: any difference fails, listed
# (The baseline is format-counts.local.json, which isn't committed.)

# Sample files made from scratch, ours to commit: a small valid file of each format that can be made
# without the original tools (src/testing/samples.ts). After changing the generator:
npm run samples  # writes samples/generated/; the tests check the committed files still match

# Broken and crafted versions of every sample (cut short, extreme header values, flipped bytes)
# through every parser, each in a worker capped in memory (1.5 GB, no swap, via systemd on Linux)
# and time (10 s), to find inputs that crash, hang or allocate wildly. Those are saved to fuzz/findings/.
npm run fuzz
npm run fuzz -- /path/to/CnCRemastered/Data   # also small files of each format from the archives there
npm run fuzz -- --format pif,ico               # only these formats' seeds: seconds, while working on one
npm run fuzz:repro -- fuzz/findings/<file>     # one finding, run through everything the app does with it
```

The original webpack/JPG/SWF attempt is kept in `legacy/`.

## Bink (WebAssembly)

Bink is decoded by FFmpeg's Bink video and audio decoders, compiled to WebAssembly into `src/formats/westwood/bink-wasm/bink.mjs` (about 670 kB), and Bink 2 video by a second module, `src/formats/westwood/bink2-wasm/bink2.mjs` (about 480 kB); both load only when a Bink file is opened. To rebuild them, with Docker running:

```bash
./wasm/bink/build.sh    # downloads FFmpeg (the release named in the script), builds in Emscripten's image
./wasm/bink2/build.sh   # downloads the Bink 2 fork (the commit named in the script), builds the same way
```

Only libavcodec's Bink decoders are built; the container is read in TypeScript (`src/formats/westwood/bink.ts`), and `wasm/bink/wrapper.c` and `wasm/bink2/wrapper.c` are the small C APIs between them. RA2's and the Remastered Collection's movies have a single keyframe, so while a movie plays the decoder's reference frame is kept every 100 frames (further apart when that wouldn't fit in 256 MB), and a jump decodes only from the nearest one. To reach that frame, each build appends one accessor to the decoder (`bink-reference.c`, `bink2-reference.c`). Movies larger than 1080p play at half size, since converting a 4K frame and handing it to the page keeps up at 22 frames a second where half size manages 60; paused, and saved, a frame is full size.

FFmpeg has no Bink 2 video decoder. The one here is Paul B Mahol's, on Konstantin Shishkov's work, sent to FFmpeg in 2022 and never merged, as kept with fixes in the fork https://github.com/mrtnmtth/FFmpeg-bink2 (FFmpeg as of May 2022 plus the decoder). Four patches in `wasm/bink2/` fix what was found wrong with it on the Collection's movies, checked frame for frame against Bink's own player: the color drifted to magenta because chroma motion compensation rounded twice (`chroma-mc.patch`); movies with an alpha plane didn't decode at all, because a frame can carry no alpha data, its plane then one value from its flags (`alpha.patch`, checked against frames RAD Video Tools exported with alpha); a residual's DC was clamped to half its range, so a cut from dark to bright came out 62 levels short (`inter-dc.patch`); and a damaged file could write past an array, found with AddressSanitizer (`block-flags.patch`). Bink 2 also stores full-range color, where Bink 1's is studio range. FFmpeg, the decoder and the fork are LGPL 2.1+ (see each module's `LICENSE.ffmpeg.md`).

## References

- [MIX format](https://xhp.xwis.net/documents/MIX_Format.html), Olaf van der Spek. The Blowfish key derivation here is the spec's bignum code reduced to `BigInt` RSA; the tests check it against the spec's C++ compiled as-is.
