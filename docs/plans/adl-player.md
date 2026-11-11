# Plan: playing Westwood AdLib music (.adl)

Status: not started. The reader (`src/formats/westwood/adl.ts`) already decodes every program's commands and every instrument; this plan turns that into sound.

## What it takes

### 1. An OPL2 (Yamaha YM3812) emulator, in TypeScript

- 9 voices of 2 operators; 4 waveforms; envelopes (attack, decay, sustain, release) with key scaling; tremolo and vibrato; feedback; FM or additive connection; rhythm mode (5 drums: Dune II uses it).
- Runs at the chip's own rate, 49,716 Hz (14.318 MHz / 288), resampled for the browser.
- Reference cores, all compatible with Chimera's GPL-3.0 (credit the source in the file's comment):
  - **Nuked OPL3** (LGPL-2.1+): cycle-accurate, slower. Port its OPL2 subset.
  - **ymfm** (BSD-3, Aaron Giles): accurate and cleaner to read.
  - **DOSBox DBOPL** (GPL-2+): fast, less exact.
- Decision needed: port Nuked (exact, so tests can compare closely) or write a leaner core from ymfm.
- About 800 to 1,200 lines. Lives in `src/core/` (it's a shared decoder, like `inflate`), since Kyrandia's and Lands of Lore's music and other AdLib formats would use it.

### 2. Westwood's player

- Port of ScummVM's driver, `engines/kyra/sound/drivers/adlib.cpp` (GPL-2+), about 1,500 lines of C++, to roughly 800 to 1,000 lines of TypeScript.
- 72 callbacks a second. Each voice has a tempo and timer, a duration, note spacing, the primary effects (slide, vibrato), a secondary effect, three volume levels, priorities, a subroutine stack, and the rhythm section.
- Note to frequency: ScummVM's tables (`_freqTable`, `_unkTable2`), note and octave from the raw note plus base note and octave.
- Where Dune II's own player might differ, check `ALFX.DRV` (in `SOUND.PAK`), which is Dune II's ADL player:
  - The command table is at 0x18DF: 75 near offsets, indexed by `(byte & 0x7F)`, clipped to 0x4A.
  - The dispatcher is at 0x0AB9: `lodsw` takes the command and its first value byte together, a routine with no values gives one back with `dec si`, and a note is always 2 bytes.
  - Already verified: every command's value count matches ScummVM's table; repeats and jumps land at "after the command, plus the offset", as ScummVM's do.
  - Disassemble with `ndisasm -b16 -o0 ALFX.DRV`. It's installed; write the output to the scratchpad.
- Sound-effect volume (`adjustSfxData`) differs below version 3; Dune II is version 3.

### 3. Rendering, and the preview

- A track never ends by itself (loops, jumps back), so render until every voice has stopped, or until the conductor's jump has come round once, then fade. Cap at a few minutes.
- The audio preview today is one finished WAV (`AudioClip`). Two ways to offer tracks:
  - **On demand:** each track an entry, rendered when it's opened, like the video preview's frame decoding. Cleaner; needs the page to ask the worker for an entry's preview lazily.
  - **Up front:** only the tracks Dune II plays as music (the reader already knows them from OpenDUNE's table: one to six a file). Fits the current preview as it is.
- Render in the worker. Estimate: well over real time, but 40 tracks up front would still be wasteful.

### 4. Tests worth writing

- **The player, exactly:** log the chip-register writes for a file and track, compare with AdPlug's player for the same. This needs AdPlug's `adplay` (not installed: ask before installing it), or AdPlug built from source in the scratchpad, never in the repo.
- **The chip:** a single note's pitch by FFT against the OPL2 frequency formula (`f = fnum × 49716 × 2^(block − 20)`), and envelopes and waveforms against the reference core's output, within a tolerance (exact only if Nuked is ported).
- **Round trips:** small programs from `adlMusic()` in `src/testing/samples.ts` (a note, a slide, a drum hit, the 0xBB loop) through player and chip.
- **Real files:** every track Dune II plays as music (`DUNE2_MUSIC` in `adl.ts`) renders without a player fault, from `gameFile('dune2', 'SOUND.PAK')`.

## Order and size

About three sessions:

1. The chip and its tests.
2. The player and the register-log comparison.
3. Rendering, the preview, and listening to the real music.

## What the reader already found (so it isn't rediscovered)

- Dune II's files are version 2/3; none use subroutine calls, so 2 and 3 read alike.
- Westwood's tools loop long passages back onto the repeat count's own byte, set to 0xBB, which as a command is "Nothing". The player must run it as such.
- DUNE0's short loops (counts 4 and 7) land on their counts too, which the player reads as notes. That's a real fault of the shipped file; the player should reproduce it, not fix it.
- DUNE7, DUNE16 and DUNE17 use instruments their tables lack. Dune II's player sets the voice up from the bytes the empty entry points to (0 or 0xFFFF from the end of the track table); ScummVM skips it. Pick one and say which.
- The game asks for tracks some files don't have: DUNE1's track 8, DUNE0's 3 and 5.

## References

- ScummVM, `engines/kyra/sound/drivers/adlib.cpp` and `engines/kyra/sound/sound_pc_v1.cpp`: https://github.com/scummvm/scummvm
- AdPlug, `src/adl.cpp`: https://github.com/adplug/adplug
- OpenDUNE, `src/table/sound.c` (`g_table_musics`): https://github.com/OpenDUNE/OpenDUNE
- Nuked OPL3: https://github.com/nukeykt/Nuked-OPL3
- ymfm: https://github.com/aaronsgiles/ymfm
