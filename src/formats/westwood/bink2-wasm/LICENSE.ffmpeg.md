# FFmpeg, with a Bink 2 decoder

`bink2.mjs` contains a Bink 2 video decoder (with the parts of libavcodec and
libavutil it needs), compiled to WebAssembly by `wasm/bink2/build.sh` with
`wasm/bink2/wrapper.c`. The decoder is Paul B Mahol's, built on Konstantin
Shishkov's work, sent to FFmpeg in 2022 (https://patchwork.ffmpeg.org/series/6673/)
and not merged. The source is the fork https://github.com/mrtnmtth/FFmpeg-bink2,
at the commit named in that script: FFmpeg as of May 2022 with the decoder and
fixes to it.

Five changes are made to it: `wasm/bink2/chroma-mc.patch` (how the decoder
rounds chroma motion compensation, which made colors drift),
`wasm/bink2/alpha.patch` (frames without alpha data, which made movies with
alpha fail), `wasm/bink2/inter-dc.patch` (the range of a residual's DC, which
cut bright cuts short), `wasm/bink2/block-flags.patch` (a write past an array on a damaged file) and
`wasm/bink2/bink2-reference.c`, appended to `libavcodec/bink2.c`, adding a
function that returns the decoder's reference frame.

FFmpeg, the decoder and the fork are licensed under the GNU Lesser General
Public License, version 2.1 or later: https://ffmpeg.org/legal.html.
