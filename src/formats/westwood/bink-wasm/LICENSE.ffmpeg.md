# FFmpeg, with a Bink 2 decoder

`bink.mjs` contains FFmpeg's Bink video and audio decoders and a Bink 2 video
decoder (with the parts of libavcodec and libavutil they need), compiled to
WebAssembly by `wasm/bink/build.sh` from the FFmpeg release named in that
script, with `wasm/bink/wrapper.c`.

The Bink 2 decoder is Paul B Mahol's, built on Konstantin Shishkov's work, sent
to FFmpeg in 2022 (https://patchwork.ffmpeg.org/series/6673/) and not merged.
Its three files (`libavcodec/bink2.c`, `bink2f.c`, `bink2g.c`) come from the
fork https://github.com/mrtnmtth/FFmpeg-bink2, at the commit named in that
script.

These changes are made to FFmpeg, all in `wasm/bink/`: `bink2-chroma-mc.patch`
(how the Bink 2 decoder rounds chroma motion compensation, which made colors
drift), `bink2-alpha.patch` (frames without alpha data, which made movies with
alpha fail), `bink2-inter-dc.patch` (the range of a residual's DC, which cut
bright cuts short), `bink2-block-flags.patch` (a write past an array on a
damaged file), `bink2-ffmpeg-7.1.patch` (the Bink 2 decoder's registration in
FFmpeg, and its port to this release's internals), and `bink-reference.c` and
`bink2-reference.c`, appended to `libavcodec/bink.c` and `libavcodec/bink2.c`,
each adding a function that returns the video decoder's reference frame.

FFmpeg, the decoder and the fork are licensed under the GNU Lesser General
Public License, version 2.1 or later: https://ffmpeg.org/legal.html. FFmpeg's
source is at https://ffmpeg.org/releases/.
