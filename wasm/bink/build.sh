#!/usr/bin/env bash
# Builds FFmpeg's Bink video and audio decoders (and nothing else) to WebAssembly,
# with wrapper.c, into src/formats/westwood/bink-wasm/bink.mjs: one ES module with
# the .wasm inside it, loaded only when a .bik file is opened.
#
# Needs Docker: it runs Emscripten's official image. FFmpeg is LGPL 2.1+; the
# exact source used is the release below, downloaded into build/.
set -euo pipefail

FFMPEG_VERSION=7.1
EMSDK_IMAGE=emscripten/emsdk:3.1.74

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
build="$here/build"
out="$repo/src/formats/westwood/bink-wasm"
mkdir -p "$build" "$out"

if [ ! -d "$build/ffmpeg-$FFMPEG_VERSION" ]; then
    # ffmpeg.org's release, or the same tag from its GitHub mirror.
    if curl -fsSL --retry 3 "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz" -o "$build/ffmpeg.tar.xz"; then
        tar -xJf "$build/ffmpeg.tar.xz" -C "$build"
    else
        curl -fsSL --retry 3 "https://github.com/FFmpeg/FFmpeg/archive/refs/tags/n$FFMPEG_VERSION.tar.gz" -o "$build/ffmpeg.tar.gz"
        tar -xzf "$build/ffmpeg.tar.gz" -C "$build"
        mv "$build/FFmpeg-n$FFMPEG_VERSION" "$build/ffmpeg-$FFMPEG_VERSION"
    fi
fi

inner=$(cat <<SCRIPT
set -euo pipefail
cd /src/build/ffmpeg-$FFMPEG_VERSION
if [ ! -f libavcodec/libavcodec.a ]; then
    emconfigure ./configure \
        --cc=emcc --cxx=em++ --ar=emar --ranlib=emranlib --nm=emnm \
        --target-os=none --arch=x86_32 --enable-cross-compile \
        --disable-everything --disable-programs --disable-doc --disable-network \
        --disable-avdevice --disable-avformat --disable-avfilter --disable-swresample --disable-swscale \
        --disable-pthreads --disable-asm --disable-inline-asm --disable-x86asm \
        --disable-runtime-cpudetect --disable-autodetect --disable-debug \
        --enable-decoder=bink --enable-decoder=binkaudio_rdft --enable-decoder=binkaudio_dct \
        --extra-cflags='-O3'
    emmake make -j\$(nproc) libavcodec/libavcodec.a libavutil/libavutil.a
fi
emcc -O3 -I. /src/wrapper.c libavcodec/libavcodec.a libavutil/libavutil.a \
    -s MODULARIZE=1 -s EXPORT_ES6=1 -s EXPORT_NAME=createBink -s SINGLE_FILE=1 \
    -s ENVIRONMENT=web,worker -s ALLOW_MEMORY_GROWTH=1 -s FILESYSTEM=0 \
    -s EXPORTED_FUNCTIONS=_malloc,_free,_video_open,_audio_open,_video_decode,_audio_decode,_decoder_flush,_decoder_close \
    -s EXPORTED_RUNTIME_METHODS=HEAPU8,HEAP16 \
    -o /out/bink.mjs
SCRIPT
)

docker run --rm -u "$(id -u):$(id -g)" -v "$here:/src" -v "$out:/out" "$EMSDK_IMAGE" bash -c "$inner"
cp "$here/LICENSE.ffmpeg.md" "$out/"
echo "Built $out/bink.mjs ($(du -h "$out/bink.mjs" | cut -f1))"
