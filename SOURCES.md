# Sources

Chimera's readers and decoders are written here, but not from nothing. This is everything they were made from: the code taken from other projects, which stays under its authors' notices, and the specifications, wikis and programs the rest was written from. Each reader's opening comment says the same for that reader; this gathers it in one place. The app shows this list, with the licenses, under Credits.

Chimera is licensed under the GNU GPL, version 3. Code is only taken from a project whose license allows it in a GPL 3 program. Where a license doesn't (a project under the GPL 2 only, one with no license, one whose terms forbid it), only facts about the format are taken from it, never code.

Much of Chimera was written with an AI assistant. Some readers were first written from its general knowledge of a format, then checked field by field against the published sources cited for them, and their code compared with the best-known open implementations of those formats, to be sure none was reproduced. Only one was: Westwood's ADPCM decoder, which follows FFmpeg's and is listed with the code taken from other projects.

## Code from other projects

Each of these files carries its source's notice word for word and says what was changed.

| In Chimera | Taken from | By | License | Changed |
| --- | --- | --- | --- | --- |
| `src/core/explode.ts` | blast.c 1.3 (zlib's contrib/blast) | Mark Adler | zlib | Translated to TypeScript; writes into the whole output rather than a 4 KB window; size checks added |
| `src/core/implode.test-util.ts` | blast.c 1.3 (its code tables only; the encoder is Chimera's) | Mark Adler | zlib | The tables copied as they are |
| `src/core/opl2.ts` | DBOPL (dbopl.cpp), as kept in ScummVM | The DOSBox Team | GPL 2 or later | Translated to TypeScript; the OPL2 half only |
| `src/formats/westwood/adl-player.ts` | The Kyrandia AdLib driver (engines/kyra/sound/drivers/adlib.cpp), as AdPlug carries it (src/adl.cpp) | Torbjorn Andersson and Johannes Schickel (ScummVM); adapted by Simon Peter (AdPlug) | GPL 2 or later, or LGPL 2.1 or later | Translated to TypeScript; versions 2 and 3 only; an instrument missing from the file's table is set up as ALFX.DRV does |
| `src/formats/westwood/adpcm.ts` | FFmpeg's Westwood SND1 decoder (libavcodec/ws-snd1.c; `decodeWestwood` only) | Konstantin Shishkov | LGPL 2.1 or later | Translated to TypeScript |
| `src/formats/voc.ts` | FFmpeg's adpcm_sbpro_expand_nibble (libavcodec/adpcm.c; `expand` only) | The FFmpeg project | LGPL 2.1 or later | Translated to TypeScript |
| `src/formats/swf/nellymoser.ts` | FFmpeg's nellymoser.c and nellymoserdec.c | Loic Minier, Benjamin Larsson and three authors named by hash | MIT | Translated to TypeScript |
| `wasm/bink/` (the Bink WebAssembly module) | FFmpeg 7.1's Bink decoders; the Bink 2 video decoder from https://github.com/mrtnmtth/FFmpeg-bink2 | The FFmpeg developers; Paul B Mahol, on Konstantin Shishkov's work | LGPL 2.1 or later | Built into one module; five patches in `wasm/bink/`, described in its LICENSE.ffmpeg.md and the README |

## Data from other projects

| In Chimera | Taken from | License |
| --- | --- | --- |
| `src/formats/westwood/voxel-normals.ts` | voxel_normal_tables.bin, from the source of the FinalSun / FinalAlert 2 mission editor Electronic Arts released | GPL 3 |
| `src/formats/westwood/templates.ts`, `td-types.ts`, and the layouts in `recording-td.ts`, `blend-table.ts`, `mrf.ts`, `sos.ts` | The Tiberian Dawn and Red Alert source Electronic Arts released with the Remastered Collection (https://github.com/electronicarts/CnC_Remastered_Collection): DEFINES.H, CDATA.CPP, BDATA.CPP, UDATA.CPP, IDATA.CPP, AADATA.CPP, CONQUER.CPP, QUEUE.CPP, INTERPAL.CPP, DISPLAY.CPP, SOS.H | GPL 3 |
| `src/formats/mix/key.ts` | Westwood's public RSA key, as XHP's MIX format document gives it | A fact of the games |

## Libraries Chimera runs on

React, React-Bootstrap, Bootstrap and the packages they bring with them. Which ones end up in the built site, with each one's license, is worked out when the site is built (`scripts/licenses.ts`) and shown under Credits.

## What the readers were written from

No code is taken from any of these: they're where the facts about each format come from.

### Westwood and Command & Conquer

- **ModdingWiki** (https://moddingwiki.shikadi.net/): Westwood's AUD, CMP, CPS, WSA, PAK, BitFont and Unicode BitFont formats, its RLE and LZW-12 compression, TS and RA2's sprites (SHP), RA's vortex tables (LUT) and PCX pictures; its MIX page, for the MIX checksum and the bytes no entry covers.
- **XHP's MIX format document** (https://xhp.xwis.net/documents/MIX_Format.html): MIX archives, their Blowfish-encrypted headers and the key calculation.
- **The Multimedia Wiki's VQA page** (https://wiki.multimedia.cx/index.php/VQA): VQA video.
- **Electronic Arts' released source** (GPL 3): the Tiberian Dawn and Red Alert source, and the TS/RA2 mission editor's, for maps, recordings, palettes, the vortex (VORTEX.CPP), how objects are drawn, and the layouts listed above; the editor's FAData.ini and FSData.ini for turret and barrel offsets, superweapon animations left off, and which palettes objects use.
- **ModEnc** (https://modenc.renegadeprojects.com/): RA2's string tables (CSF), TS and RA2's isometric tiles (TMP), voxel lighting tables (VPL) and palettes (PAL); what voxels and their animations hold (VXL, HVA).
- **OpenRA** (https://github.com/OpenRA/OpenRA, GPL 3): the layouts of voxel models and animations (VxlReader.cs, HvaReader.cs), how TS sprite frames and tiles are stored (ShpTSLoader.cs, TmpTSLoader.cs), how its importer treats bad map cells, and its TS turret offsets.
- **XCC** (Olaf van der Spek, https://github.com/OlafvdSpek/xcc, GPL 3): the formats of its file name databases, and RA2's sound bank index (cc_structures.h).
- **ccmaps-net** (zzattack's CNCMaps renderer, https://github.com/zzattack/ccmaps-net, GPL 3): how RA2 limits map lighting, the extra light units get, and colors 240 to 254 left unlit (`map-iso.ts`).
- **OpenDUNE** (https://github.com/OpenDUNE/OpenDUNE, GPL 2 only, so facts only): Dune II's scripts (EMC), tiles (ICN, ICON.MAP), mentat screens, gray remap table, text compression, DUNE.CFG, credits, and which music plays where.
- **libeastwood** (https://github.com/libeastwood/libeastwood, LGPL 2.1): its notes on XMIDI (doc/xmidi.txt); its readers compared with OpenDUNE's for ICON.MAP, the string tables and EMC, where OpenDUNE is followed.
- **ScummVM** (https://github.com/scummvm/scummvm): the names of the AdLib driver's commands and calls (`adl.ts`, `drv.ts`) and its XMIDI parser (`xmi.ts`).
- **AdPlug** (https://github.com/adplug/adplug): how an ADL file's track table is told apart from its offsets (`adl-layout.ts`).
- **The games' own programs**: DUNE2.EXE and ALFX.DRV, read directly, where their behavior differs from the above.

### Petroglyph

- **Mike Lankamp's MEG documentation** (https://modtools.petrolution.net/docs/MegFileFormat), most likely what the MEG reader's details come from; it couldn't be reached to check. Version 1 is checked against the Reverse Engineering Wiki's page (https://rewiki.miraheze.org/wiki/Petroglyph_MEG, CC BY-SA 4.0), and which games use which version is from the petro_meg crate's documentation (https://docs.rs/petro-meg).

### Installers

- **unshieldv3** (Wolfgang Frisch, https://github.com/wfr/unshieldv3, Apache 2.0), from Veit Kannegieser's stix: InstallShield 3 archives (.z).
- **Deark** (Jason Summers, https://github.com/jsummers/deark, MIT): InstallShield's setup files (_INST32I.EX_).
- **isDcc 1.22** (Andrew de Quincey, https://github.com/incognitte/isDcc; its terms forbid reusing its code, so facts only): InstallShield scripts (SETUP.INS).
- **The Just Solve the File Format Problem wiki** (http://justsolve.archiveteam.org/): InstallShield's PKG and installer archive pages.
- **Sample files** collected for that wiki (https://sembiance.com/fileFormatSamples/): SETUP.PKG and SETUP.INS from other programs' installers, used to check the readers. They aren't in this repository.

### Programs and drivers

- **Microsoft's MS-DOS Programmer's Reference** and **Ralf Brown's Interrupt List** (INT 21h function 4Bh): DOS programs (MZ).
- **Open Watcom's exe16m.h** (https://github.com/open-watcom/open-watcom-v2, bld/watcom/h; Sybase Open Watcom Public License, so facts only): the DOS/16M module header ("BW") that DOS/4GW's modules have. How the modules chain, and the program bound after them, was worked out from TD's and Counterstrike's files.
- **Borland's run-time library** (SE.ASM), as GeReV's LoadBorlandOverlays.java reads it (https://github.com/GeReV/ghidra_scripts): Borland's overlays.
- **Microsoft's "Executable-File Header Format"** (the NE spec in the Windows 3.1 SDK, mirrored at https://wiki.osdev.org/NE): 16-bit Windows modules.
- **Microsoft's "Visual C++ 5.0 Symbolic Debug Information Specification"** (CodeView): debug info after programs.
- **Microsoft's "PE Format"** (https://learn.microsoft.com/windows/win32/debug/pe-format): Windows programs and libraries (PE). Its **"Resource Types"**, **"Resource File Formats"** and **VS_VERSIONINFO** pages (https://learn.microsoft.com/windows/win32/menurc/): their resources, icon groups and version information; the **VERSIONINFO resource** page for what each version string is for; **MESSAGE_RESOURCE_DATA** (https://learn.microsoft.com/windows/win32/api/winnt/ns-winnt-message_resource_data) for message tables; **[MS-LCID]** for the language names and **"Code Page Identifiers"** (https://learn.microsoft.com/windows/win32/intl/code-page-identifiers) for the code pages.
- Microsoft's **DLGTEMPLATE**, **DLGITEMTEMPLATE**, **DLGTEMPLATEEX** and **DLGITEMTEMPLATEEX** pages (https://learn.microsoft.com/windows/win32/dlgbox/dlgtemplateex and those beside it): dialogs in 32-bit programs.
- **Raymond Chen's "The evolution of dialog templates"** (The Old New Thing, 2004: https://devblogs.microsoft.com/oldnewthing/20040618-00/?p=38803, ?p=38773 and https://devblogs.microsoft.com/oldnewthing/20040621-00/?p=38793; facts only): dialogs in 16-bit modules, and the 32-bit layouts again. How dialog units become pixels for 8-point MS Sans Serif and Tahoma (6 × 13) is taken from what those fonts measure.
- Microsoft's **RESOURCEHEADER** page (https://learn.microsoft.com/windows/win32/menurc/resourceheader): resource files (.res). The empty entry they start with was taken from files: those Wine's resource compiler (wrc) makes, which a test compares the reader against when it's installed, and Warcraft II Remastered's.
- **Raymond Chen's "The format of string resources"** (The Old New Thing, 2004, https://devblogs.microsoft.com/oldnewthing/20040130-00/?p=40813; facts only): string tables, 16 strings to a resource, each its length and then its text.
- **Daniel Pistelli's "Microsoft's Rich Signature (undocumented)"** (2008, https://ntcore.com/files/richsign.htm; no license given, so facts only): the Rich header Microsoft's linker leaves. How its checksum is made was worked out from real programs.
- **The AIL 2 source John Miles released in 2000** (public domain, https://github.com/Tronix286/AIL2): Miles sound drivers.
- **Wikipedia's "Program information file"** (https://en.wikipedia.org/wiki/Program_information_file): PIF files.

### Pictures

- **ITU T.81**, **JFIF** and **Exif 2.31** (JEITA CP-3451): JPEG; libjpeg's jdphuff.c for progressive refinement.
- **ISO/IEC 15948** (the W3C PNG spec): PNG. **RFC 1950** and **RFC 1951**: zlib and Deflate.
- **The GIF89a specification** (CompuServe, 1990: https://www.w3.org/Graphics/GIF/spec-gif89a.txt): GIF; Netscape's looping extension as "What's In A GIF" (https://giflib.sourceforge.net/whatsinagif/bits_and_bytes.html) and Vurdalakov's notes (http://www.vurdalakov.net/misc/gif/netscape-looping-application-extension) describe it; frame timing as browsers do it, from Nullsleep's study (2012: https://www.tumblr.com/nullsleep/16524517190/animated-gif-minimum-frame-delay-browser) and Mozilla's bug 125137 (https://bugzilla.mozilla.org/show_bug.cgi?id=125137). ImageMagick's decoding to compare frames.
- **TIFF 6.0**, with **ITU T.4** and **T.6** for its fax compression.
- **Microsoft's documentation** of BITMAPFILEHEADER, BITMAPINFOHEADER and icons: BMP, DIB, ICO and CUR.

### Sound

- **MPEG audio** (ISO/IEC 11172-3 and 13818-3, and the unofficial MPEG 2.5), as DataVoyage's "MPEG Audio Frame Header" lays out the frame header (1998, 1999: http://www.mpgedit.org/mpgedit/mpeg_format/mpeghdr.htm); FFmpeg's tables (libavcodec/mpegaudiotabs.h) to check the bit rates, sample rates and frame lengths against; the **ID3v2.4.0 specification** (https://mutagen-specs.readthedocs.io/en/latest/id3/id3v2.4.0-structure.html) for its tags.
- **RFC 3533**: Ogg. **The Vorbis I specification** (https://xiph.org/vorbis/doc/Vorbis_I_spec.html), **RFC 7845** (Opus in Ogg), **Xiph's FLAC-in-Ogg mapping** (https://xiph.org/flac/ogg_mapping.html) with **RFC 9639** (FLAC), **Speex's SpeexHeader** (speex_header.h, https://github.com/xiph/speex) and **the Theora specification** (https://www.theora.org/doc/Theora.pdf): what's in each stream's first packets.
- **The IMA's Recommended Practices for Enhancing Digital Audio Compatibility in Multimedia Systems** (1992), and the Multimedia Wiki's page on decoding it (https://wiki.multimedia.cx/index.php/IMA_ADPCM): IMA ADPCM.
- **Sun Microsystems' g711.c** (provided for unrestricted use): the A-law and µ-law conversions in `voc.ts`.
- **The Standard MIDI File 1.0 specification** (MIDI Manufacturers Association, 1996) and the General MIDI program numbers: MIDI.
- **The XMIDI specification** (Miles Design, release 1.02, 1992): XMIDI.
- **FFmpeg**: the ground truth some decoders are tested against (sound samples decoded by FFmpeg).

### Fonts, Flash and others

- **OpenType 1.9**, and **Adobe's Technical Notes 5176 and 5177**: TrueType and OpenType fonts, CFF outlines.
- **The SWF 19 specification**: Flash movies.
- **Flashbug** (Gabriel Mariani, https://github.com/gmariani/flashbug, GPL 3), the owner's earlier project, kept in this repository as `legacy/` until November 2026: the SWF work, and the kernel header reading `pbj.ts` started from; the **Haxe format library's PBJ reader** (Nicolas Cannasse, https://github.com/HaxeFoundation/format, BSD 2-Clause) for Pixel Bender's records, types and opcodes.
- **minilzo's LZO1X**: the format of TS and RA2's map cells.

### Worked out here

Some formats have no public description. Their readers say so, and what they know comes from the files themselves: Petroglyph's chunk files and the Remastered Collection's string tables (LOC), RA's VQA palette tables (VQP), parts of InstallShield's PKG, setup files and scripts (each reader says which parts), and the Rich header's checksum in Windows programs.

## Looked at, and not used

For completeness, what earlier work looked at and took nothing from:

- **Dune-II-Decomp** (https://github.com/VideogameSources/Dune-II-Decomp): a 2019 copy of OpenDUNE, older than the one followed.
- **westwood-formats** (https://github.com/jassoncasey/westwood-formats, Apache 2.0): its own README says it was written with an AI by someone new to the formats, so it was only a lead, and it added nothing the readers didn't have from stronger sources.
- **Dune Legacy**'s ICN reader, a C&C fandom file formats guide, smsoft.ru's PIF document and Henrik Haftmann's THEPIF.PAS: each failed to load when tried, so nothing came from them.
- **Phobos** and **YRpp**: read while working out RA2's lighting, which came from ccmaps-net in the end.

## Adding to this list

- A reader names what it was written from in its opening comment, and the same goes here.
- Code taken from another project keeps its notice word for word, indented under a line that introduces it and ends in a colon ("That file's notice:"; the Credits page shows it from there), says what was changed, and goes in the first table. Before taking any, check that its license allows it in a GPL 3 program.
- From a project whose license doesn't allow that, take only facts about the format, and say so here.
