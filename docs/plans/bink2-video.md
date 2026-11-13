# Plan: Bink 2 video in the preview

Status: built (2026-11-12). A Bink 2 file (`.bk2`, "KB2") plays, with a choice of sound track and its alpha plane, decoded by a second WebAssembly module (`wasm/bink2`) next to the Bink 1 decoders (`wasm/bink`). What's left is in "Still to do" at the end.

## What there is to play

Every Bink 2 file in the C&C Remastered Collection, from its `MOVIES*.MEG` archives (read from the archives' tables and each movie's first 64 KB, not opened whole):

- **438 movies, 14.9 GB, all revision `KB2j`.** One revision covers the whole Collection.
- **Sizes:** from 224 × 32 interface pieces to two 3840 × 2160 movies; 1920 × 1080 is common, and so are 704 × 396, 720 × 396 and 654 × 480 (the old cutscenes).
- **80 have an alpha plane** (video flag 0x100000): mostly interface animations without sound. The fork couldn't decode any of them (see step 6).
- **Sound:** 0, 1 or 3 tracks each. The three are the dialogue in English, German and French, in that order (heard, 2026-11-12). Nothing in the file says so: the track IDs are 0, 1 and 2 (one movie: 1, 2, 0), so the player only numbers them, offered one at a time.
- **Length:** up to 47,589 frames (about 26 minutes, in the bonus footage). Most have a single keyframe, at the start, as RA2's movies do.
- **File size:** median 13.7 MB; five are over 256 MB, and one is 559 MB, over Chimera's 512 MB limit (`MAX_BYTES`).

## The decoder

Paul B Mahol's Bink 2 video decoder (on Konstantin Shishkov's work), sent to FFmpeg in May 2022 and never merged, as kept in the fork https://github.com/mrtnmtth/FFmpeg-bink2 (commit `f490484`, 2026-08-28). The fork is FFmpeg as of 2022-05-07 plus that decoder, two fixes to it (out-of-bounds reads in motion compensation; reading the column flags for the 32-aligned width, without which inter frames lose sync at widths like 720), and a Bink Audio 2 backport. It's LGPL-2.1-or-later, as FFmpeg is. Its author tested it on 136 files of revision `KB2n` only.

The decoder is three files, `libavcodec/bink2.c`, `bink2f.c` and `bink2g.c` (3,242 lines of plain C): revisions up to `f` take the `bink2f` path, `g` and later the `bink2g` one, with the frame cut into 2, 3, 4 or 8 slices by the video flags' low bits. It takes what Bink 1's does: the file's 4-byte signature as the codec tag, the 4-byte video flags as extradata, and a frame's video packet. Unlike Bink 1's, it reads the keyframe mark from the packet (`AV_PKT_FLAG_KEY`), and keeps the previous picture in `c->last`.

### Tried already (the fork built natively in the scratchpad, Bink 2 decoders only)

- **`KB2j` decodes.** Both samples (`GDI01_INTRO_02.BK2`, 311 frames; `GDI13.BK2`, 1,213 frames, 3 sound tracks) decode every frame with no error or warning, and frames late in the single-keyframe chain (300 of 311, 1,212 of 1,213) are whole: no drift builds up.
- **The pictures look right:** the GDI landing craft at night, the boat at sunset, General Sheppard's briefing, and the briefing's own "end of transmission" break-up at the end.
- **Speed:** the 1,213 frames at 704 × 396 decode in 0.9 s natively, about 1,350 frames a second.
- **Color was wrong.** Faces and highlights came out strongly magenta, growing through each movie. Traced against Bink's own player to the wrong YUV range and a rounding fault in chroma motion compensation; both fixed in the native build (step 6), with a small drift left to find.

## Approach

1. **Build.** `wasm/bink2/build.sh`, as `wasm/bink/build.sh` is: in Emscripten's Docker image, the fork's tarball at the pinned commit, configured with `--disable-everything --enable-decoder=bink2`, linked with a wrapper into `src/formats/westwood/bink2-wasm/bink2.mjs`, which loads only when a `.bk2` is opened. Bink 1 and the sound (the Bink 2 files' sound is Bink audio, which today's FFmpeg 7.1 module already decodes) stay as they are. Docker has to be running for the build.
2. **The wrapper.** The Bink 1 wrapper with two changes: `video_decode` takes the keyframe mark (from the frame index's bit 0) and sets `AV_PKT_FLAG_KEY`; and an accessor for `c->last`, appended to `bink2.c` as `bink-reference.c` is to `bink.c`, so the decoder's state can be kept and restored (jumping in a single-keyframe movie). The YUV to RGBA conversion as Bink 1's (BT.601, studio range), with the alpha plane when there is one.
3. **The reader.** `bink.ts` sends `KB2` files to the new module: the same `Player`, given the module and the keyframe marks. Two things it doesn't need for RA2's movies:
   - **Kept states within a memory budget.** Keeping one every 100 frames is 3 MB a time at 1080p: 1.5 GB for the 26-minute movie. Space them so all of them fit a budget (say 256 MB): every 100 frames, or more apart in long, large movies.
   - **Frames handed over, not copied.** A 1080p frame is 8 MB of RGBA, 4K's 33 MB; at 30 frames a second, copying each from the WebAssembly memory and then again to the page is the bottleneck. Copy once and transfer the buffer.
4. **The preview.** The video player as it is, plus an alpha plane shown over a checkerboard, a smaller picture while large movies play (full size when paused or saved), and the sound tracks (see the decisions).
5. **Tests worth writing.**
   - **Ground truth:** for both samples, the native build's per-frame checksums of the decoded YUV (`ffmpeg -f framemd5 -pix_fmt yuv420p`, recorded in the test) against the WebAssembly module's, for a spread of frames: the first, several after jumps (through kept states and a restore), and the last. The wrapper exports a call that gives the decoded planes for this.
   - **Every Remastered movie decodes without error,** frame by frame, opt-in like `test:game-data` (it reads 14.9 GB), with the movies read from the MEG archives a piece at a time.
   - **Warnings and refusals:** a damaged packet, a frame index that lies, and a keyframe mark on a frame that isn't one.
6. **The color fault: found, mostly fixed** (2026-11-12). The references are Epic's own Linux player (`BinkPlayer64`, Bink 2026.10, kept by the user in `samples/bink/`, not committed). It converts each frame to BGRA itself and uploads it to OpenGL once a frame, so a small preload library that wraps `glTexSubImage2D` (through the player's `dlsym`) saves Bink's exact pictures, frame for frame; uploads line up one to one with the fork's frames. Two faults, measured over both samples:
   - **Bink 2 is full range.** Its YUV to RGB is BT.601 full range (JPEG's: Y unscaled, 1.402 / 0.344 / 0.714 / 1.772), with the chroma upsampled bilinearly, centered, and the output dithered in a 2 × 2 pattern. Bink 1's studio-range conversion made every frame about 8 levels off. The Bink 2 wrapper converts full range.
   - **Chroma motion compensation rounded twice.** For a quarter-pel vector in both directions the fork filtered across, rounded, then down, and rounded again, about +0.4 a time; over a single-keyframe movie that piled up into the magenta faces. Bink filters once: `(Σ wx·wy·src + 32) >> 6`, weights in eighths. Against Bink's own frames (its previous frame as the source) that matches 99.0–99.6% of pixels in every mode, as plain copies do; the fork's way, 94–96% and biased up. The patch replaces `bink2g_c_mc`'s 16 cases with that one filter (`bink2-chroma-mc.patch` in the scratchpad, to go into `wasm/bink2/` with the build).
   - **Result:** mean difference from Bink, before → after: `GDI13` frame 1,000, 24.2 → 3.1; the intro's frame 300, 10.5 → 4.1; keyframes 9–10 → 0.9 (rounding and dither).
   - **Alpha frames without alpha data failed.** Frame flag `0x80000` means the frame carries no alpha data, and its whole alpha plane is then one value: the frame flags' top byte (0 where an interface piece starts blank, 255 through most of the intro, 17, 34 … 238 in one movie's fade; every frame with alpha data has 0 there). The fork read a plane anyway, so each such frame failed and was dropped: 15 of the 80 alpha movies set the flag, six of them gave no frames, and `INTRO2.BK2` gave 762 of 3,283 (measured with a native build of the fork). With the flag, the plane is filled, not read or motion-compensated (`alpha.patch`); all 80 alpha movies decode, each slice ending on its offset. Ground truth: frames exported with alpha by RAD Video Tools on Windows (the user's; Bink's Linux player draws alpha opaque, so it can't show this): 305 frames of `INTRO2.BK2` and `SCORE_TOPSCORES_ON.BK2`, no pixel's alpha more than 9 levels off. A first reading, "the plane is unchanged", fit the interface pieces but left holes in the intro (frames 679 to 1153 and on), which RAD's frames showed to be wrong.
   - **A residual's DC was clamped to half its range.** The fork clamped an inter block's DC to ±1023 (±128 as pixels), where a residual can span the plane: a cut from dark to bright in `GDI13` (frame 926) came out 62 levels short of Bink's frame, 1.5 with the clamp at ±2047 (`inter-dc.patch`).
   - **Showing alpha.** The player has a switch, "Show the alpha plane", on by default; off, a movie is drawn opaque, as Bink's own player draws it. The intro uses its alpha for its fade-out at the end.
   - **Still to find: a small drift from intra blocks.** Intra blocks in inter frames come out +0.07 a frame too high on average (luma too), so a long or busy movie still drifts a little (the intro's sea goes slightly red by frame 300). It's in blocks with only a DC, whose DC falls exactly on half a level (dc mod 8 = 4): the fork always rounds up, Bink rounds about 60% of them down, with no rule yet found (not position, plane, value, q or neighbors). Blocks with AC coefficients are exact, and the DC prediction, its averaging of non-intra neighbors and the AC dequantization all tested right. The luma motion filter wasn't checked exactly (the dither makes luma hard to recover); it showed no bias.
7. **Hostile files: done.** The native build under AddressSanitizer, on damaged copies of the samples (bit flips, cut packets, overwritten runs, keyframe marks flipped, slice-count bits flipped), each run capped at 1.5 GB and 10 s: one fault in 136 runs, a write past the row and column flag arrays when a run of flags claims more than are left (`block-flags.patch`); 232 runs after the fix, none. Chimera's own fuzzer on the `.bk2` samples: no findings.
8. **Docs.** The README's Bink row (Bink 2 video), the Development section's Bink paragraph (where the decoder comes from, its authors, the fork's fixes), and the fork's LGPL notice beside the module, as `LICENSE.ffmpeg.md` is.

## Decided

1. **The decoder comes from the fork, as a second module** at its pinned commit: what runs is what was tested, with no other change while the decoder itself is being tested and its color fixed.
2. **Large movies play smaller.** While a movie plays, the page is handed a scaled-down picture (so 4K keeps up); paused, and when a frame is saved, the full picture. Where the line falls (likely above 1080p, or wherever the decoder can't keep 30 frames a second) is set by measuring the module.

## Decisions still to make

1. **The three sound tracks** are languages (heard), offered one at a time, switchable while playing. Decided.
2. **The 559 MB movie, and the MEG archives.** Raising `MAX_BYTES` for one file is easy; opening the 2 to 4 GB `MOVIES*.MEG` archives in the browser isn't, since a file is read into memory whole. That's a plan of its own (reading big archives a piece at a time), not this one: here, movies are opened as files taken out of the archives.

## Done (2026-11-12)

Steps 1 to 5, 7 and 8, and most of 6: the build (`wasm/bink2/build.sh`, three patches), the wrapper (keyframe mark, full-range conversion with centered bilinear chroma, half-size pictures, the planes for checking), the reader (one `Player` for both decoders, snapshots within a 256 MB budget, frames handed over to the page, every sound track, the first frame decoded up front so a damaged movie says so), the preview (a sound track picker, alpha over the stage's checkerboard, half size while a movie above 1080p plays: measured, 4K converts at 22 frames a second full size and 60 at half, 1080p at 82 full), the tests (every frame of both samples against the native build's checksums, jumps against playing through, the alpha movie against the native build, warnings, and an opt-in pass over every Remastered movie with `CHIMERA_ALL_MOVIES=1`), and the docs.

## Still to do

1. The intra-block drift (step 6, last point).

### Later, once it's tested

3. **Move the decoder onto FFmpeg 7.1,** the Bink 1 module's base, so one module and one FFmpeg serve Bink 1 and 2 (and the newer Bink audio fixes come with it). Only after the second module has played the Remastered movies right and passed the hostile-file pass, so the port changes nothing else at the same time: the checksums from the native build (step 5) must come out the same after it. The work is the API between 2022 and 7.1: how a decoder is registered (`FFCodec`), its VLC tables' set-up, and frame handling.

## References

- The fork: https://github.com/mrtnmtth/FFmpeg-bink2 (decoder: ffmpeg-devel patch series 6673, https://patchwork.ffmpeg.org/series/6673/).
- FFmpeg's Bink demuxer (`libavformat/bink.c`), for the container, which `bink.ts` already reads.
- `wasm/bink/` and `src/formats/westwood/bink.ts`, for how Bink 1 is built and played.
