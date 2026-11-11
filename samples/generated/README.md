# Generated samples

Small, valid files of formats Chimera reads, made from scratch by `src/testing/samples.ts` (no game files, so they're ours to commit). Each reads as its format with nothing to warn about; `src/testing/samples.test.ts` checks that, and that these files still match what the generator makes.

Don't edit them by hand: change the generator and run `npm run samples`.

The pictures are one 320 × 200 test card in 16 colors (bands, a checkerboard, a diagonal, a frame), so every compression can be checked against the same thing.

| File | What it is | Size |
| --- | --- | --- |
| `cps-none.cps` | CPS picture, uncompressed, with its palette | 64,778 bytes |
| `cps-lzw12.cps` | CPS picture, LZW with 12-bit codes | 5,409 bytes |
| `cps-lzw14.cps` | CPS picture, LZW with 14-bit codes | 6,181 bytes |
| `cps-rle.cps` | CPS picture, Westwood RLE | 39,138 bytes |
| `cps-lcw.cps` | CPS picture, LCW (as literal copies), using the game palette | 65,027 bytes |
| `cps-amiga.cps` | CPS picture as the Amiga stores it: five bit planes, a 32-color palette | 40,074 bytes |
| `cmp-type1.cmp` | CMP picture: 16 colors, RLE across the rows | 28,991 bytes |
| `cmp-type2.cmp` | CMP picture: 16 colors, RLE down each column | 28,677 bytes |
| `cmp-type3.cmp` | CMP picture: 256 colors, LZW with 12-bit codes | 4,636 bytes |
| `cmp-type4.cmp` | CMP picture: 256 colors, RLE | 38,363 bytes |
| `cmp-type6.cmp` | CMP picture: 256 colors, LZW with 14-bit codes | 5,408 bytes |
| `icn-dune2.icn` | Dune II map tiles: 8 tiles, two palettes (one with see-through edges) | 1,120 bytes |
| `wsa-cnc.wsa` | WSA animation, the C&C header: a square moving across | 2,158 bytes |
| `wsa-dune2-100.wsa` | WSA animation, Dune II 1.00’s header | 2,152 bytes |
| `wsa-dune2-107.wsa` | WSA animation, Dune II 1.07’s header | 2,154 bytes |
| `voc-pcm8.voc` | VOC sound: an 8-bit tone, a silence, a text block | 1,160 bytes |
| `voc-adpcm4.voc` | VOC sound: Creative 4-bit ADPCM | 98 bytes |
| `aud-pcm8.aud` | AUD sound: plain 8-bit PCM in two chunks | 1,052 bytes |
| `aud-ima.aud` | AUD sound: IMA ADPCM, 16-bit out | 84 bytes |
| `wav-pcm8.wav` | WAV sound: 8-bit PCM | 1,144 bytes |
| `fnt-ra2-map.fnt` | RA2 map editor font (FoNt), the letters of CHIMERA | 256 bytes |
| `fnt-nox.fnt` | Nox font (tNoF), the letters of CHIMERA | 244 bytes |
| `palette.pal` | VGA palette: the 16 EGA colors, then a gray ramp | 768 bytes |
| `png-rgb.png` | PNG picture: RGB, a color wheel of sorts | 12,420 bytes |
| `pak-v1.pak` | Westwood PAK, version 1 (Eye of the Beholder), holding three of these | 66,753 bytes |
| `pak-v2.pak` | Westwood PAK, version 2 (Dune II), holding three of these | 66,752 bytes |
| `pak-v3.pak` | Westwood PAK, version 3 (Kyrandia 2 and 3), holding three of these | 66,757 bytes |
