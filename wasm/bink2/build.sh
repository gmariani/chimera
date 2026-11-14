#!/usr/bin/env bash
# Builds a Bink 2 video decoder (and nothing else) to WebAssembly, with
# wrapper.c, into src/formats/westwood/bink2-wasm/bink2.mjs: one ES module with
# the .wasm inside it, loaded only when a .bk2 file is opened.
#
# FFmpeg has no Bink 2 decoder. This one is Paul B Mahol's (on Konstantin
# Shishkov's work), sent to FFmpeg in 2022 and never merged, as kept with fixes
# in the fork below. Its three files are taken from the fork at a pinned commit
# and built into FFmpeg 7.1, the same release as the Bink 1 module (wasm/bink).
# It's LGPL 2.1+, as FFmpeg is. The changes made here, in order: chroma-mc.patch
# (its color fault), alpha.patch (frames without alpha data), inter-dc.patch
# (a residual's range), block-flags.patch (a write past an array, on a damaged
# file), ffmpeg-7.1.patch (the port to 7.1's internals, and the decoder's
# registration) and bink2-reference.c, appended to libavcodec/bink2.c.
#
# Needs Docker: it runs Emscripten's official image.
set -euo pipefail

FFMPEG_VERSION=7.1
FORK=https://raw.githubusercontent.com/mrtnmtth/FFmpeg-bink2
COMMIT=f4904840e820bfd0fb8fbc22179b39dfdbd3a9e0
EMSDK_IMAGE=emscripten/emsdk:3.1.74

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
build="$here/build"
src="$build/ffmpeg-$FFMPEG_VERSION"
out="$repo/src/formats/westwood/bink2-wasm"
mkdir -p "$build" "$out"

if [ ! -d "$src" ]; then
    # ffmpeg.org's release, or the same tag from its GitHub mirror.
    if curl -fsSL --retry 3 "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz" -o "$build/ffmpeg.tar.xz"; then
        tar -xJf "$build/ffmpeg.tar.xz" -C "$build"
    else
        curl -fsSL --retry 3 "https://github.com/FFmpeg/FFmpeg/archive/refs/tags/n$FFMPEG_VERSION.tar.gz" -o "$build/ffmpeg.tar.gz"
        tar -xzf "$build/ffmpeg.tar.gz" -C "$build"
        mv "$build/FFmpeg-n$FFMPEG_VERSION" "$src"
    fi
    for f in bink2.c bink2f.c bink2g.c; do
        curl -fsSL --retry 3 "$FORK/$COMMIT/libavcodec/$f" -o "$src/libavcodec/$f"
    done
    # The changes, made once, when the source is unpacked.
    for p in chroma-mc alpha inter-dc block-flags ffmpeg-7.1; do
        patch -d "$src" -p1 < "$here/$p.patch"
    done
    cat "$here/bink2-reference.c" >> "$src/libavcodec/bink2.c"
fi

inner=$(cat <<SCRIPT
set -euo pipefail
cd /src/build/ffmpeg-$FFMPEG_VERSION
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
