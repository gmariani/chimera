# Sources

Chimera's readers and decoders are written here, but not from nothing. This is everything they were made from: the code taken from other projects, which stays under its authors' notices, and the specifications, wikis and programs the rest was written from. Each reader's opening comment says the same for that reader; this gathers it in one place.

Chimera is licensed under the GNU GPL, version 3. Code is only taken from a project whose license allows it in a GPL 3 program. Where a license doesn't (a project under the GPL 2 only, one with no license, one whose terms forbid it), only facts about the format are taken from it, never code.

## Code from other projects

Each of these files carries its source's notice word for word and says what was changed.

| In Chimera | Taken from | By | License | Changed |
| --- | --- | --- | --- | --- |
| `src/core/explode.ts` | blast.c 1.3 (zlib's contrib/blast) | Mark Adler | zlib | Translated to TypeScript; writes into the whole output rather than a 4 KB window; size checks added |
| `src/core/implode.test-util.ts` (its code tables only; the encoder is Chimera's) | blast.c 1.3 | Mark Adler | zlib | The tables copied as they are |
| `src/core/opl2.ts` | DBOPL (dbopl.cpp), as kept in ScummVM | The DOSBox Team | GPL 2 or later | Translated to TypeScript; the OPL2 half only |
| `src/formats/westwood/adl-player.ts` | The Kyrandia AdLib driver (engines/kyra/sound/drivers/adlib.cpp), as AdPlug carries it (src/adl.cpp) | Torbjorn Andersson and Johannes Schickel (ScummVM); adapted by Simon Peter (AdPlug) | GPL 2 or later, or LGPL 2.1 or later (ScummVM's own copy: GPL 3 or later, or LGPL 2.1 or later) | Translated to TypeScript; versions 2 and 3 only; an instrument missing from the file's table is set up as ALFX.DRV does |
| `src/formats/voc.ts` (`expand`, Creative ADPCM's step, only) | FFmpeg's adpcm_sbpro_expand_nibble (libavcodec/adpcm.c) | The FFmpeg project | LGPL 2.1 or later | Translated to TypeScript |
| `src/formats/swf/nellymoser.ts` | FFmpeg's nellymoser.c and nellymoserdec.c | Loic Minier, Benjamin Larsson and three authors named by hash | MIT | Translated to TypeScript |
| `wasm/bink/` (the Bink WebAssembly module) | FFmpeg 7.1's Bink decoders; the Bink 2 video decoder from https://github.com/mrtnmtth/FFmpeg-bink2 | The FFmpeg developers; Paul B Mahol, on Konstantin Shishkov's work | LGPL 2.1 or later | Built into one module; five patches in `wasm/bink/`, described in the README |

## Data from other projects

| In Chimera | Taken from | License |
| --- | --- | --- |
| `src/formats/westwood/voxel-normals.ts` | voxel_normal_tables.bin, from the source of the FinalSun / FinalAlert 2 mission editor Electronic Arts released | GPL 3 |
| `src/formats/westwood/templates.ts`, `td-types.ts`, and the layouts in `recording-td.ts`, `blend-table.ts`, `mrf.ts`, `sos.ts` | The Tiberian Dawn and Red Alert source Electronic Arts released with the Remastered Collection (https://github.com/electronicarts/CnC_Remastered_Collection): DEFINES.H, CDATA.CPP, BDATA.CPP, UDATA.CPP, IDATA.CPP, AADATA.CPP, CONQUER.CPP, QUEUE.CPP, INTERPAL.CPP, DISPLAY.CPP, SOS.H | GPL 3 |
| `src/formats/mix/key.ts` | Westwood's public RSA key, as XHP's MIX format document gives it | A fact of the games |

## Libraries Chimera runs on

React and React DOM, React-Bootstrap, Bootstrap, Bootstrap Icons: all MIT, installed from npm with their own license files.

## What the readers were written from

No code is taken from any of these: the readers were written from what they say about the formats, or checked against them. Where a reader was written first, from what was known of a format, and checked against a source afterward, its opening comment says so.

### Westwood and Command & Conquer

- **ModdingWiki** (https://moddingwiki.shikadi.net/): Westwood's AUD, CMP, CPS, WSA, PAK, BitFont and Unicode BitFont formats, and its RLE and LZW-12 compression; its MIX page, for the MIX checksum and the bytes no entry covers. Checked against afterward: its pages on TS SHP sprites, PCX and RA's vortex tables (`lut.ts`).
- **XHP's MIX format document** (https://xhp.xwis.net/documents/MIX_Format.html): MIX archives, their Blowfish-encrypted headers and the key calculation.
- **The Multimedia Wiki's VQA page** (https://wiki.multimedia.cx/index.php/VQA): VQA video.
- **Electronic Arts' released source** (GPL 3): the Tiberian Dawn and Red Alert source, and the TS/RA2 mission editor's, for maps, recordings, palettes, how objects are drawn, and the layouts listed above.
- **OpenRA** (https://github.com/OpenRA/OpenRA, GPL 3): how its importer treats bad map cells, and its TS turret offsets. Checked against afterward: its VXL and HVA readers (`VxlReader.cs`, `HvaReader.cs`).
- **XCC** (Olaf van der Spek, https://github.com/OlafvdSpek/xcc, GPL 3): the formats of its file name databases. Checked against afterward: its RA2 audio index structures (`gaba.ts`).
- **ccmaps-net** (zzattack's CNCMaps renderer, https://github.com/zzattack/ccmaps-net, GPL 3): how RA2 limits map lighting, the extra light units get, and colors 240 to 254 left unlit (`map-iso.ts`).
- **The TS/RA2 mission editor's FAData.ini and FSData.ini** (in Electronic Arts' released source): turret and barrel offsets, superweapon animations left off, and which palettes objects use.
- **ModEnc** (https://modenc.renegadeprojects.com/), checked against afterward: its pages on CSF, TMP, VPL and PAL files, which agree with the readers. Its VXL and HVA pages describe what the files hold but not their layout.
- **OpenDUNE** (https://github.com/OpenDUNE/OpenDUNE, GPL 2 only, so facts only): Dune II's scripts (EMC), tiles (ICN, ICON.MAP), mentat screens, gray remap table, text compression, DUNE.CFG, credits, and which music plays where.
- **libeastwood** (https://github.com/libeastwood/libeastwood, LGPL 2.1): its notes on XMIDI (doc/xmidi.txt) for `xmi.ts`; its readers compared with OpenDUNE's for ICON.MAP, the string tables and EMC, where OpenDUNE is followed.
- **ScummVM** (https://github.com/scummvm/scummvm): the names of the AdLib driver's commands and calls (`adl.ts`, `drv.ts`) and its XMIDI parser (`xmi.ts`).
- **AdPlug** (https://github.com/adplug/adplug): how an ADL file's track table is told apart from its offsets (`adl-layout.ts`).
- **The games' own programs**: DUNE2.EXE and ALFX.DRV, read directly, where their behavior differs from the above.

### Installers

- **unshieldv3** (Wolfgang Frisch, https://github.com/wfr/unshieldv3, Apache 2.0), from Veit Kannegieser's stix: InstallShield 3 archives (.z).
- **Deark** (Jason Summers, https://github.com/jsummers/deark, MIT): InstallShield's setup files (_INST32I.EX_).
- **isDcc 1.22** (Andrew de Quincey, https://github.com/incognitte/isDcc; its terms forbid reusing its code, so facts only): InstallShield scripts (SETUP.INS).
- **The Just Solve the File Format Problem wiki** (http://justsolve.archiveteam.org/): InstallShield's PKG and installer archive pages.
- **Sample files** collected for that wiki (https://sembiance.com/fileFormatSamples/): SETUP.PKG and SETUP.INS from other programs' installers, used to check the readers. They aren't in this repository.

### Programs and drivers

- **Microsoft's MS-DOS Programmer's Reference** and **Ralf Brown's Interrupt List** (INT 21h function 4Bh): DOS programs (MZ).
- **Borland's run-time library** (SE.ASM), as GeReV's LoadBorlandOverlays.java reads it (https://github.com/GeReV/ghidra_scripts): Borland's overlays.
- **Microsoft's "Executable-File Header Format"** (the NE spec in the Windows 3.1 SDK, mirrored at https://wiki.osdev.org/NE): 16-bit Windows modules.
- **Microsoft's "Visual C++ 5.0 Symbolic Debug Information Specification"** (CodeView): debug info after programs.
- **The AIL 2 source John Miles released in 2000** (public domain, https://github.com/Tronix286/AIL2): Miles sound drivers.
- **Wikipedia's "Program information file"** (https://en.wikipedia.org/wiki/Program_information_file): PIF files.

### Pictures, fonts, sound and others

- **ITU T.81**, **JFIF** and **Exif 2.31** (JEITA CP-3451): JPEG; libjpeg's jdphuff.c for progressive refinement.
- **ISO/IEC 15948** (the W3C PNG spec): PNG. **RFC 1950** and **RFC 1951**: zlib and Deflate.
- **TIFF 6.0**, with **ITU T.4** and **T.6** for its fax compression.
- **Microsoft's documentation** of BITMAPFILEHEADER, BITMAPINFOHEADER and icons: BMP, DIB, ICO and CUR.
- **OpenType 1.9**, and **Adobe's Technical Notes 5176 and 5177**: TrueType and OpenType fonts, CFF outlines.
- **The Standard MIDI File 1.0 specification** (MIDI Manufacturers Association, 1996) and the General MIDI program numbers: MIDI.
- **The XMIDI specification** (Miles Design, release 1.02, 1992): XMIDI.
- **The SWF 19 specification**: Flash movies.
- **Flashbug** (Gabriel Mariani, https://github.com/gmariani/flashbug, GPL 3), the owner's earlier project, kept in this repository as `legacy/` until November 2026: the SWF work, and the kernel header reading `pbj.ts` started from. Checked against afterward: the Haxe format library's PBJ reader (Nicolas Cannasse, https://github.com/HaxeFoundation/format, BSD 2-Clause).
- **The GIF89a specification** (CompuServe, 1990): checked against afterward, with ImageMagick's decoding to compare frames.
- **RFC 3533**: Ogg, checked against afterward.
- **FFmpeg's MPEG audio tables** (libavcodec/mpegaudiotabs.h): MP3's bit rates, sample rates and frame sizes, checked against afterward.
- **The IMA's Recommended Practices for Enhancing Digital Audio Compatibility in Multimedia Systems** (1992): IMA ADPCM. Westwood's 8-bit ADPCM agrees with FFmpeg's decoder for it (libavcodec/ws-snd1.c, Konstantin Shishkov).
- **Petroglyph's MEG archives**: most likely from Mike Lankamp's documentation (https://modtools.petrolution.net/docs/MegFileFormat), which couldn't be reached to check; version 1 checked against the Reverse Engineering Wiki (https://rewiki.miraheze.org/wiki/Petroglyph_MEG, CC BY-SA 4.0); the versions' games from the petro_meg crate's documentation (https://docs.rs/petro-meg).
- **minilzo's LZO1X**: the format of TS and RA2's map cells.
- **Sun Microsystems' g711.c** (provided for unrestricted use): the A-law and µ-law conversions in `voc.ts`.
- **FFmpeg**: the ground truth some decoders are tested against (sound samples decoded by FFmpeg).

### Worked out here

Some formats have no public description. Their readers say so, and what they know comes from the files themselves: Petroglyph's chunk files and the Remastered Collection's string tables (LOC), RA's VQA palette tables (VQP), and parts of InstallShield's PKG, setup files and scripts (each reader says which parts).

## Looked at, and not used

For completeness, what earlier work looked at and took nothing from:

- **Dune-II-Decomp** (https://github.com/VideogameSources/Dune-II-Decomp): a 2019 copy of OpenDUNE, older than the one followed.
- **westwood-formats** (https://github.com/jassoncasey/westwood-formats, Apache 2.0): its own README says it was written with an AI by someone new to the formats, so it was only a lead, and it added nothing the readers didn't have from stronger sources.
- **Dune Legacy**'s ICN reader, a C&C fandom file formats guide, smsoft.ru's PIF document and Henrik Haftmann's THEPIF.PAS: each failed to load when tried, so nothing came from them.
- **Phobos** and **YRpp**: read while working out RA2's lighting, which came from ccmaps-net in the end.

## Adding to this list

- A reader names what it was written from in its opening comment, and the same goes here.
- Code taken from another project keeps its notice word for word, says what was changed, and goes in the first table. Before taking any, check that its license allows it in a GPL 3 program.
- From a project whose license doesn't allow that, take only facts about the format, and say so here.
