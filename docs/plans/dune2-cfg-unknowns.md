# Plan: what's still unknown in Dune II's DUNE.CFG

Status: **done**, for DUNE2.EXE 1.00 and 1.07. The reader (`src/formats/westwood/dune2-cfg.ts`) says what the game does with each setting, and `dune2-cfg.test.ts` checks it against both EXEs, finding the switches by their instructions.

## What was found

The settings code isn't in the part of DUNE2.EXE that DOS loads. It's in the first of the program's 36 Borland overlays: code the overlay manager loads from the file when it's called. The MZ reader (`src/formats/mz.ts`) found it there. The overlay's code starts at file offset 266,672 (0x411B0), and it's 966 bytes. Offsets below are within it, which is also its code segment's offsets, since an overlay loads at offset 0 of its own segment.

The plan's first try put the switches at "file offset 0x3C748". That was an offset in the program's image, without the 19,456-byte header: in the file, 0x3C748 is a list of sound file names. The code is at 0x41348, 408 bytes into overlay 1.

| Offset in overlay 1 | Code | What it does |
|---|---|---|
| 0x07E | `push ds; push 0x8FBB; push ds; push 0xE0 ("DUNE.CFG"); call 0x178:0x68` | Reads the file into DS:0x8FBB. If that fails: "The setup program must be run first." (DS:0xE9), and exit. The only place the settings' address is used as a whole. |
| 0x192 | `mov word [0x6360],3` | Sets the graphics mode variable to 3, before looking at the setting. |
| 0x198 | `mov al,[0x8FBB]; sub ax,7; cmp bx,5; ja 0x1B6; jmp [cs:bx+0x3BA]` | The graphics switch. Its table (0x3BA): 7, 8, 10, 11, 12 → 0x1AE, which sets `[0x6360]` to 3 again. **9** → 0x1B6, the error: "Unrecognized graphic mode!" (DS:0x114), and exit. So every value it takes means the same. |
| 0x1D1 | `mov al,[0x8FBC]; sub ax,8; cmp bx,4; ja 0x1EE; jmp [cs:bx+0x3B0]` | The music switch. Its table (0x3B0): 8 to 12 → 0x1E7, `mov byte [0x8FBC],1`. Miles's FM drivers (ADLIB, ADLIBG, PASFM, SBFM, SBP1FM) become ALFX.DRV, Westwood's AdLib player. 13 (SBP2FM.ADV) is outside the switch and stays. The effects driver isn't switched on. |

The two jump tables are the overlay's last 22 bytes (0x3B0 to 0x3C5).

**Bytes 6 and 7** (DS:0x8FC1 and 0x8FC2): no two bytes anywhere in DUNE2.EXE spell either address. Every other setting is addressed directly (0x8FBB to 0x8FC0). They're read and counted in the checksum, and nothing else touches them.

**Also seen, not used yet:** right after reading the file, the game works out how much memory it needs from the settings. Voices add 6,000 bytes. ALFX.DRV as the music driver adds 24,000; any other music driver adds 30,000. With XMS on, it checks the total against what's free ("Insufficient memory by %ld bytes.").

## 1.07

DUNE2.EXE 1.07 (367,760 bytes, 40 overlays, data segment 0x32F0) does exactly the same, with the addresses moved: the settings are at DS:0x90C1, and in overlay 1 the graphics switch is at 0x1AA (table at 0x3CC) and the music switch at 0x1E3 (table at 0x3C2). 9 is refused, 8 to 12 become ALFX.DRV, and DS:0x90C7 and 0x90C8 (bytes 6 and 7) appear nowhere in the file. The 1.07 patch (PKZIP's self-extractor holding PATCH.EXE and an RTPatch PATCH.RTP) doesn't hold the EXE itself.

What graphics mode 3 is, in the game's terms, is still open, but no setting changes it, so it doesn't matter for reading the file.

## References

- OpenDUNE, `src/config.c` and `src/config.h`. In its history, revision `090f0751` and those before `3b61b700` have the driver tables (`MSDriver`, `DSDriver` in `src/global.h`) and the start-up checks (`Main()` in `src/opendune.c`): https://github.com/OpenDUNE/OpenDUNE
- libeastwood, `src/Dune2File.cpp` and `src/ExeFile.cpp`: https://github.com/libeastwood/libeastwood
- Borland's overlays, as LoadBorlandOverlays.java reads them: https://github.com/GeReV/ghidra_scripts/blob/main/LoadBorlandOverlays.java
