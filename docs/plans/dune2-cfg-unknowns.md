# Plan: what's still unknown in Dune II's DUNE.CFG

Status: not started. The reader (`src/formats/westwood/dune2-cfg.ts`) decodes every byte, but three things in DUNE.CFG are only partly understood. The answers are in DUNE2.EXE's start-up code. The way in is a DOS MZ reader in Chimera, which is on the list anyway for `DUNE2.EXE` and `SETUP.EXE`.

## The unknowns

1. **Graphics (byte 0).** DUNE2.EXE accepts 7 to 12 and stops at anything else with "Unrecognized graphic mode!". What each value means isn't known. The installed game's file has 12; OpenDUNE's default is 1, and OpenDUNE doesn't read the field.
2. **Bytes 6 and 7.** OpenDUNE names them `variable_0006` and `variable_0007` ("??"), and nothing it decompiled reads them. Both are 0 in the installed file.
3. **Music drivers 8 to 12.** These are Miles's FM drivers (ADLIB.ADV, ADLIBG.ADV, PASFM.ADV, SBFM.ADV, SBP1FM.ADV). DUNE2.EXE's start-up code has a `switch` over exactly these, and one case sets the music driver to 1, Westwood's own player (ALFX.DRV). Which cases do that, and whether 13 (SBP2FM.ADV) is left alone on purpose, isn't traced. The reader leaves this out until it is.

## Where the code is (the installed DUNE2.EXE, version 1.00)

- DUNE.CFG is read into the data segment at 0x8FBB, in order:

  | Address | Setting |
  |---|---|
  | 0x8FBB | Graphics |
  | 0x8FBC | Music driver |
  | 0x8FBD | Sound-effects driver |
  | 0x8FBE | Voice driver |
  | 0x8FBF | Use the mouse |
  | 0x8FC0 | Use XMS (none sets the voice driver to 0) |

- The data segment is 0x332F. libeastwood's `GlobalDataOffset` gives the same for version 1.00, and the driver tables' far pointers use it.
- **The graphics switch:** at file offset 0x3C748 (MZ header 0x4C00 bytes), `sub ax,7; cmp bx,5; ja error; jmp [cs:bx+0x3BA]`. The error branch, at 0x3C766, pushes "Unrecognized graphic mode!" (data offset 0x114). The case at 0x3C75E sets `[0x6360] = 3`.
- **The music switch:** right after it, `sub ax,8; cmp bx,4; ja; jmp [cs:bx+0x3B0]`. A case at 0x3C797 sets `[0x8FBC] = 1`.
- **What stopped this:** the jump tables are at CS:0x3BA and CS:0x3B0, but the code segment's base in the file wasn't found. `ndisasm` truncates jump targets to 16 bits, so its addresses don't give the base. Working it out needs the MZ relocation table, or a disassembler that's given the right origin.

## Steps

1. **A DOS MZ reader** (`src/formats/mz.ts`, beside `ne.ts`): the header, the relocation table, the load image, and the entry point. Pointers in the image are segment and offset, so it should give each relocated segment's place in the file.
2. **Identify Dune II's versions.** libeastwood's `src/Dune2File.cpp` has signatures (`VersionOffset`) for the demo, 1.00 and three 1.07 builds, and where each one's tables are (units, structures, houses, files, driver data).
3. **Find the code segment** holding 0x3C748. Read both jump tables, and disassemble each case: what `[0x6360]` (the graphics) is set to for 7 to 12, and which music drivers get swapped for ALFX.DRV.
4. **Look for reads of 0x8FC1 and 0x8FC2** (bytes 6 and 7) anywhere in the code.
5. **Update the reader:** name the graphics values; describe what the game does with drivers 8 to 12; name bytes 6 and 7, or say nothing reads them. Add a test for each, against the installed DUNE2.EXE (`gameFile('dune2', 'DUNE2.EXE')`).

## Also known, for the MZ reader

- DUNE2.EXE's driver lists are at file offsets 0x3D984 (7 voice drivers, 4-byte far pointers to the file name), 0x3D9A0 (14 music drivers, 12 bytes each: file name, extension, two words), and 0x3DA48 (14 sound-effect drivers, the same layout). Entry 0 of each is empty ("none"). Music driver 1 (ALFX.DRV) carries 0x48, the AdLib player's 72 calls a second.
- SETUP.EXE's menus name the cards (none, Sound Blaster, Sound Blaster Pro, AdLib Gold, MT-32/LAPC-1, Sound Canvas, AdLib, Tandy, PC speaker). How a menu choice becomes a driver number is in SETUP.EXE's code, not traced.

## References

- OpenDUNE, `src/config.c` and `src/config.h`. In its history, revision `090f0751` and those before `3b61b700` have the driver tables (`MSDriver`, `DSDriver` in `src/global.h`) and the start-up checks (`Main()` in `src/opendune.c`): https://github.com/OpenDUNE/OpenDUNE
- libeastwood, `src/Dune2File.cpp` and `src/ExeFile.cpp`: https://github.com/libeastwood/libeastwood
