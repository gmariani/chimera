# Plan: playing Westwood AdLib music (.adl)

Status: **done**. The ADL reader's preview plays the music: the tracks Dune II plays as music, or in another game's file the tracks that start the conductor, each on a timeline of its notes.

## What was built

- **The chip:** `src/core/opl2.ts`, a port of DOSBox's DBOPL (as ScummVM keeps it), its OPL2 half only. Chosen for being fast and proven in DOSBox. It reproduces DBOPL exactly: `opl2.test.ts` holds fingerprints of DBOPL's own samples, built from `dbopl.cpp` with g++, for a script that reaches every waveform, FM and AM, feedback, the envelopes, vibrato, tremolo and the drums, at 22,050 Hz and at the chip's 49,716 Hz.
- **The player:** `src/formats/westwood/adl-player.ts`, a port of ScummVM's driver as AdPlug carries it (`src/adl.cpp`). It writes the same registers, in the same order, on the same ticks as AdPlug's player for every one of the 806 tracks in Dune II's 21 files: `adl-player.test.ts` holds a fingerprint of AdPlug's logs, built from source with a chip that prints each write.
- **Rendering:** `src/formats/westwood/adl-render.ts`. 72 ticks a second into the chip at 22,050 Hz; the notes for the timeline are read back from the register writes (the drums of rhythm mode on MIDI's drum channel). A track plays until every voice has stopped (then a second of release) or come round (then four seconds fading out), at most 6 minutes, and 15 minutes a file in all. All of Dune II's music, 50 minutes of it, renders in about 5 seconds; a file in at most 0.6.

## Decisions

- **The chip:** DBOPL (fast, proven), not Nuked OPL3 or a core after ymfm.
- **The preview:** up front, like XMI's: the game's music in a stack under the tracks' outline.
- **Missing instruments:** as Dune II does. ALFX.DRV adds an instrument's offset to the data's start in a 16-bit register with no check (`lds si,[cs:0x39E]; add si,[bx+si+0x1F4]` at 0x0F27), so 0 is the program table and 0xFFFF the byte before the data: the track table's last byte, the game keeping the file whole. ScummVM skips such instruments; `AdlDriver`'s `missing: 'skip'` does too, for the comparison with AdPlug. Only one music track uses one: DUNE17's track 4 (instrument 181, offset 0xFFFF). DUNE7's and DUNE16's instrument 62 is in track 63, a sound effect.

## What turned up

- DBOPL's set-up clears every register twice (as an OPL3, then an OPL2), and the first pass leaves each operator's phase where a sine starts, which the drums keep. The port does the same.
- DBOPL checks whether a channel is silent only at the start of each call, so its output depends on how many samples are asked for at once. The comparison asks in 512s, as the harness did; the renderer asks a tick's worth at a time.
- DUNE0's short repeats landing on their counts, which then play as notes, are the shipped file's fault and play as the game would play them.

## The references, if this is picked up again

- Built in the session's scratchpad, never in the repo: DBOPL with a stand-in for ScummVM's `common/scummsys.h` and a harness reading "w reg val" / "g count" lines; AdPlug's `adl.cpp` with stand-ins for its `player.h` (a chip that prints "tick reg val") and `debug.h`.
- ScummVM, `audio/softsynth/opl/dbopl.cpp` and `engines/kyra/sound/drivers/adlib.cpp`: https://github.com/scummvm/scummvm
- AdPlug, `src/adl.cpp`: https://github.com/adplug/adplug
- OpenDUNE, `src/table/sound.c` (`g_table_musics`): https://github.com/OpenDUNE/OpenDUNE
