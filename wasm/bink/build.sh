#!/usr/bin/env bash
# Builds the Bink decoders (and nothing else) to WebAssembly, with wrapper.c,
# into src/formats/westwood/bink-wasm/bink.mjs: one ES module with the .wasm
# inside it, loaded only when a Bink file is opened. It holds FFmpeg's Bink
# video and audio decoders, and a Bink 2 video decoder built into the same FFmpeg.
#
# FFmpeg has no Bink 2 decoder. This one is Paul B Mahol's (on Konstantin
# Shishkov's work), sent to FFmpeg in 2022 and never merged, as kept with fixes
# in the fork below. Its three files are taken from the fork at a pinned commit
# and built into the FFmpeg release below. All of it is LGPL 2.1+.
#
# The changes made to FFmpeg, in order: bink2-chroma-mc.patch (the Bink 2
# decoder's color fault), bink2-alpha.patch (frames without alpha data),
# bink2-inter-dc.patch (a residual's range), bink2-block-flags.patch (a write
# past an array, on a damaged file), bink2-ffmpeg-7.1.patch (the decoder's port
# to this release's internals, and its registration), and bink-reference.c and
# bink2-reference.c, appended to libavcodec/bink.c and bink2.c.
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
out="$repo/src/formats/westwood/bink-wasm"
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
fi

# The changes, made once (a source unpacked by an earlier version of this script has none of Bink 2's).
if [ ! -f "$src/libavcodec/bink2.c" ]; then
    for f in bink2.c bink2f.c bink2g.c; do
        curl -fsSL --retry 3 "$FORK/$COMMIT/libavcodec/$f" -o "$src/libavcodec/$f.download"
    done
    for f in bink2.c bink2f.c bink2g.c; do mv "$src/libavcodec/$f.download" "$src/libavcodec/$f"; done
    for p in chroma-mc alpha inter-dc block-flags ffmpeg-7.1; do
        patch -d "$src" -p1 < "$here/bink2-$p.patch"
    done
    cat "$here/bink2-reference.c" >> "$src/libavcodec/bink2.c"
fi
grep -q chimera_bink_reference "$src/libavcodec/bink.c" || cat "$here/bink-reference.c" >> "$src/libavcodec/bink.c"

inner=$(cat <<SCRIPT
set -euo pipefail
cd /src/build/ffmpeg-$FFMPEG_VERSION
# Configured afresh when the decoders asked for aren't all there (a tree configured before Bink 2 was added).
if ! grep -q '^CONFIG_BINK2_DECODER=yes' ffbuild/config.mak 2>/dev/null; then
    emconfigure ./configure \
        --cc=emcc --cxx=em++ --ar=emar --ranlib=emranlib --nm=emnm \
        --target-os=none --arch=x86_32 --enable-cross-compile \
        --disable-everything --disable-programs --disable-doc --disable-network \
        --disable-avdevice --disable-avformat --disable-avfilter --disable-swresample --disable-swscale \
        --disable-pthreads --disable-asm --disable-inline-asm --disable-x86asm \
        --disable-runtime-cpudetect --disable-autodetect --disable-debug \
        --enable-decoder=bink --enable-decoder=bink2 --enable-decoder=binkaudio_rdft --enable-decoder=binkaudio_dct \
        --extra-cflags='-O3'
fi
emmake make -j\$(nproc) libavcodec/libavcodec.a libavutil/libavutil.a
emcc -O3 -I. /src/wrapper.c libavcodec/libavcodec.a libavutil/libavutil.a \
    -s MODULARIZE=1 -s EXPORT_ES6=1 -s EXPORT_NAME=createBink -s SINGLE_FILE=1 \
    -s ENVIRONMENT=web,worker -s ALLOW_MEMORY_GROWTH=1 -s FILESYSTEM=0 \
    -s EXPORTED_FUNCTIONS=_malloc,_free,_video_open,_audio_open,_video_decode,_audio_decode,_decoder_flush,_decoder_close,_video_save,_video_restore,_video_forget \
    -s EXPORTED_RUNTIME_METHODS=HEAPU8,HEAP16 \
    -o /out/bink.mjs
SCRIPT
)

docker run --rm -u "$(id -u):$(id -g)" -v "$here:/src" -v "$out:/out" "$EMSDK_IMAGE" bash -c "$inner"
cp "$here/LICENSE.ffmpeg.md" "$out/"
echo "Built $out/bink.mjs ($(du -h "$out/bink.mjs" | cut -f1))"
