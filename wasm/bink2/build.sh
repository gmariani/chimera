#!/usr/bin/env bash
# Builds a Bink 2 video decoder (and nothing else) to WebAssembly, with
# wrapper.c, into src/formats/westwood/bink2-wasm/bink2.mjs: one ES module with
# the .wasm inside it, loaded only when a .bk2 file is opened.
#
# FFmpeg has no Bink 2 decoder. This one is Paul B Mahol's (on Konstantin
# Shishkov's work), sent to FFmpeg in 2022 and never merged, as kept with fixes
# in the fork below, at a pinned commit: FFmpeg as of May 2022 plus the decoder.
# It's LGPL 2.1+, as FFmpeg is. Five changes are made to it here: chroma-mc.patch
# (its color fault), alpha.patch (movies with alpha didn't decode), inter-dc.patch
# (a residual's range), block-flags.patch (a write past an array, on a damaged
# file) and bink2-reference.c, appended to libavcodec/bink2.c.
#
# Needs Docker: it runs Emscripten's official image.
set -euo pipefail

FORK=https://github.com/mrtnmtth/FFmpeg-bink2
COMMIT=f4904840e820bfd0fb8fbc22179b39dfdbd3a9e0
EMSDK_IMAGE=emscripten/emsdk:3.1.74

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
build="$here/build"
src="$build/FFmpeg-bink2-$COMMIT"
out="$repo/src/formats/westwood/bink2-wasm"
mkdir -p "$build" "$out"

if [ ! -d "$src" ]; then
    curl -fsSL --retry 3 "$FORK/archive/$COMMIT.tar.gz" -o "$build/fork.tar.gz"
    tar -xzf "$build/fork.tar.gz" -C "$build"
    # The changes, made once, when the source is unpacked.
    patch -d "$src" -p1 < "$here/chroma-mc.patch"
    patch -d "$src" -p1 < "$here/alpha.patch"
    patch -d "$src" -p1 < "$here/inter-dc.patch"
    patch -d "$src" -p1 < "$here/block-flags.patch"
    cat "$here/bink2-reference.c" >> "$src/libavcodec/bink2.c"
fi

inner=$(cat <<SCRIPT
set -euo pipefail
cd /src/build/FFmpeg-bink2-$COMMIT
if [ ! -f ffbuild/config.mak ]; then
    emconfigure ./configure \
        --cc=emcc --cxx=em++ --ar=emar --ranlib=emranlib --nm=emnm \
        --target-os=none --arch=x86_32 --enable-cross-compile \
        --disable-everything --disable-programs --disable-doc --disable-network \
        --disable-avdevice --disable-avformat --disable-avfilter --disable-swresample --disable-swscale \
        --disable-pthreads --disable-asm --disable-inline-asm --disable-x86asm \
        --disable-runtime-cpudetect --disable-autodetect --disable-debug \
        --enable-decoder=bink2 \
        --extra-cflags='-O3'
fi
emmake make -j\$(nproc) libavcodec/libavcodec.a libavutil/libavutil.a
emcc -O3 -I. /src/wrapper.c libavcodec/libavcodec.a libavutil/libavutil.a \
    -s MODULARIZE=1 -s EXPORT_ES6=1 -s EXPORT_NAME=createBink2 -s SINGLE_FILE=1 \
    -s ENVIRONMENT=web,worker -s ALLOW_MEMORY_GROWTH=1 -s FILESYSTEM=0 \
    -s EXPORTED_FUNCTIONS=_malloc,_free,_video_open,_video_decode,_decoder_flush,_decoder_close,_video_save,_video_restore,_video_forget \
    -s EXPORTED_RUNTIME_METHODS=HEAPU8 \
    -o /out/bink2.mjs
SCRIPT
)

docker run --rm -u "$(id -u):$(id -g)" -v "$here:/src" -v "$out:/out" "$EMSDK_IMAGE" bash -c "$inner"
cp "$here/LICENSE.ffmpeg.md" "$out/"
echo "Built $out/bink2.mjs ($(du -h "$out/bink2.mjs" | cut -f1))"
