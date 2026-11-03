# .chimera

A universal file inspector that runs in the browser. Open a file to see how it's put together: every field, what it means, and the bytes behind it, in a structure tree linked to a hex view (in the spirit of 010 Editor templates). Archives open up so you can look inside each file they hold, preview it, and pull any of it out. Nothing is uploaded.

## Formats

| Format | Read | Preview | Extract |
| --- | --- | --- | --- |
| Westwood MIX (TD, RA, TS, RA2), plain or Blowfish-encrypted | full structure, names from hashes | — | single files, all as ZIP, nested MIX |
| SHP sprites (TD/RA, TS/RA2, and the Dune II-style cursors) | headers, frame table | all frames, animation, any palette | PNG frame, sheet, all frames |
| AUD audio (IMA and Westwood ADPCM) | headers, chunks | player | WAV |
| CPS and PCX pictures | headers | image | PNG |
| WSA animations | headers, frame offsets | all frames, animation | PNG frame, sheet, all frames |
| Terrain tile sets (.tem, .des, .win, .sno, .int, .icn) | header, tiles, cell map | the template assembled, each tile | PNG |
| VQA video (TD/RA, version 2) | chunk map, VQHD | player with sound | PNG frame, all frames, WAV |
| Map terrain (TD .bin, RA [MapPack] in mission INIs) | every cell | terrain kinds, ore and walls (RA) | PNG |
| Fonts (.fnt) | header, each character | every character | PNG |
| PAL palettes | each colour | swatches, use for sprites | — |
| VQP palette blending tables | tables | first table | — |
| INI files | sections and entries | text | — |
| XCC local mix database | names | list | — |
| Other text | — | text | — |

Template names, TD template sizes and RA overlay types come from the GPL source of the Remastered Collection (`DEFINES.H`, `CDATA.CPP`).

Anything else opens in the hex view.

MIX archives store a hash of each file name, not the name. Names come from the archive's own `local mix database.dat` (if XCC added one), a built-in list of common C&C names, and any list you load with **Add names…** (XCC's `global mix database.dat`, or a text file with one name per line).

## Adding a format

Each format is a plain TypeScript module that turns bytes into data. It never renders anything, so the UI stays generic:

1. Write a parser in `src/formats/` that exports a `FormatParser` (`src/core/types.ts`). `parse()` returns:
   - `fields`: a tree of `{ name, offset, length, value, note }`. This drives the structure tree and the hex colouring.
   - `entries` (optional): files held inside, which can be opened and extracted.
   - `preview` (optional): `images` (indexed pixels), `palette`, `audio` (WAV bytes) or `text`.
   - `overlays` (optional): bytes to show in place of the file's own, such as a decrypted header.
2. Add a cheap `sniff()` and register both in `src/formats/index.ts`. The parser is loaded on demand.

## Development

```sh
npm install
npm run dev      # http://localhost:5173
npm test         # also checks every file in "MIX Samples/" if that folder exists

# Every MIX in a game install, every archive nested in those, and every file inside them:
CHIMERA_GAME_DATA=/path/to/CnCRemastered/Data/CNCDATA npx vitest run src/formats/gamedata.test.ts
npm run build    # static site in build/
```

The original webpack/JPG/SWF attempt is kept in `legacy/`.

## References

- [MIX format](https://xhp.xwis.net/documents/MIX_Format.html), Olaf van der Spek. The Blowfish key derivation here is the spec's bignum code reduced to `BigInt` RSA; the tests check it against the spec's C++ compiled as-is.
