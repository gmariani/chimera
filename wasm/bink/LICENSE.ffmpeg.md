# FFmpeg

`bink.mjs` contains FFmpeg's Bink video and audio decoders (libavcodec and
libavutil), compiled to WebAssembly by `wasm/bink/build.sh` from the FFmpeg
release named in that script, unmodified, with `wasm/bink/wrapper.c`.

FFmpeg is licensed under the GNU Lesser General Public License, version 2.1 or
later: https://ffmpeg.org/legal.html. Its source is at https://ffmpeg.org/releases/.
