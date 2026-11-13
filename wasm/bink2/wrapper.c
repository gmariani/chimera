/*
 * A small API over the Bink 2 video decoder for the browser. The container is
 * read in TypeScript (src/formats/westwood/bink.ts), and Bink 2's sound is the
 * same Bink audio as Bink 1's, which the other module (wasm/bink) decodes; this
 * only decodes video packets, to RGBA.
 *
 * Built with build.sh into src/formats/westwood/bink2-wasm/bink2.mjs.
 */
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <emscripten/emscripten.h>
#include "libavcodec/avcodec.h"

/* From bink2-reference.c, appended to libavcodec/bink2.c by build.sh. */
AVFrame *chimera_bink2_reference(AVCodecContext *avctx);

typedef struct {
    AVCodecContext *codec;
    AVPacket *packet;
    AVFrame *frame;
} Decoder;

/** The file's 4-byte signature ("KB2j") as the tag (the decoder reads its revision letter), its 4-byte video flags as extradata. */
EMSCRIPTEN_KEEPALIVE Decoder *video_open(uint32_t tag, uint32_t flags, int width, int height) {
    const AVCodec *codec = avcodec_find_decoder(AV_CODEC_ID_BINKVIDEO2);
    if (!codec) return NULL;
    Decoder *d = calloc(1, sizeof(Decoder));
    d->codec = avcodec_alloc_context3(codec);
    d->codec->codec_tag = tag;
    d->codec->width = width;
    d->codec->height = height;
    d->codec->extradata = av_mallocz(4 + AV_INPUT_BUFFER_PADDING_SIZE);
    memcpy(d->codec->extradata, &flags, 4);
    d->codec->extradata_size = 4;
    if (avcodec_open2(d->codec, codec, NULL) < 0) {
        avcodec_free_context(&d->codec);
        free(d);
        return NULL;
    }
    d->packet = av_packet_alloc();
    d->frame = av_frame_alloc();
    return d;
}

/** Forget the previous frame, before decoding from a keyframe. */
EMSCRIPTEN_KEEPALIVE void decoder_flush(Decoder *d) {
    avcodec_flush_buffers(d->codec);
}

EMSCRIPTEN_KEEPALIVE void decoder_close(Decoder *d) {
    if (!d) return;
    av_frame_free(&d->frame);
    av_packet_free(&d->packet);
    avcodec_free_context(&d->codec);
    free(d);
}

static uint8_t clamp(int v) {
    return v < 0 ? 0 : v > 255 ? 255 : v;
}

/*
 * YUV to RGB as Bink 2 does it (measured against Bink's own player): BT.601 at
 * full range (Y as it is, no studio-range stretch), the chroma upsampled
 * bilinearly with each sample centered between four pixels. Fixed point: the
 * chroma comes out in sixteenths, so each coefficient is scaled by 2^16 / 16.
 */
#define CR_R 91881  /* 1.402 */
#define CB_G 22554  /* 0.344136 */
#define CR_G 46802  /* 0.714136 */
#define CB_B 116130 /* 1.772 */

static void to_rgba(const AVFrame *f, uint8_t *rgba) {
    const int w = f->width, h = f->height, cw = (w + 1) >> 1, ch = (h + 1) >> 1;
    const int alpha = f->format == AV_PIX_FMT_YUVA420P;
    // One row of the chroma, interpolated down (in quarters), for each plane.
    int *uv = malloc(sizeof(int) * cw * 2);
    if (!uv) return;
    for (int y = 0; y < h; y++) {
        const int cy = y >> 1, ny = y & 1 ? (cy + 1 < ch ? cy + 1 : cy) : (cy > 0 ? cy - 1 : 0);
        const uint8_t *u0 = f->data[1] + cy * f->linesize[1], *u1 = f->data[1] + ny * f->linesize[1];
        const uint8_t *v0 = f->data[2] + cy * f->linesize[2], *v1 = f->data[2] + ny * f->linesize[2];
        for (int i = 0; i < cw; i++) {
            uv[i] = 3 * u0[i] + u1[i];
            uv[cw + i] = 3 * v0[i] + v1[i];
        }
        const uint8_t *ys = f->data[0] + y * f->linesize[0];
        const uint8_t *as = alpha ? f->data[3] + y * f->linesize[3] : NULL;
        uint8_t *out = rgba + (size_t)y * w * 4;
        for (int x = 0; x < w; x++) {
            const int cx = x >> 1, nx = x & 1 ? (cx + 1 < cw ? cx + 1 : cx) : (cx > 0 ? cx - 1 : 0);
            const int u = 3 * uv[cx] + uv[nx] - 128 * 16;
            const int v = 3 * uv[cw + cx] + uv[cw + nx] - 128 * 16;
            const int c = ys[x];
            out[x * 4] = clamp(c + ((CR_R * v + (1 << 19)) >> 20));
            out[x * 4 + 1] = clamp(c - ((CB_G * u + CR_G * v + (1 << 19)) >> 20));
            out[x * 4 + 2] = clamp(c + ((CB_B * u + (1 << 19)) >> 20));
            out[x * 4 + 3] = as ? as[x] : 255;
        }
    }
    free(uv);
}

/** A smaller picture, every 2^shift-th pixel each way, for playing large movies: quick, and good enough while it moves. */
static void to_rgba_small(const AVFrame *f, uint8_t *rgba, int shift) {
    const int step = 1 << shift, w = (f->width + step - 1) >> shift, h = (f->height + step - 1) >> shift;
    const int alpha = f->format == AV_PIX_FMT_YUVA420P;
    for (int y = 0; y < h; y++) {
        const int sy = y << shift;
        const uint8_t *ys = f->data[0] + sy * f->linesize[0];
        const uint8_t *us = f->data[1] + (sy >> 1) * f->linesize[1];
        const uint8_t *vs = f->data[2] + (sy >> 1) * f->linesize[2];
        const uint8_t *as = alpha ? f->data[3] + sy * f->linesize[3] : NULL;
        uint8_t *out = rgba + (size_t)y * w * 4;
        for (int x = 0; x < w; x++) {
            const int sx = x << shift, c = ys[sx], u = (us[sx >> 1] - 128) * 16, v = (vs[sx >> 1] - 128) * 16;
            out[x * 4] = clamp(c + ((CR_R * v + (1 << 19)) >> 20));
            out[x * 4 + 1] = clamp(c - ((CB_G * u + CR_G * v + (1 << 19)) >> 20));
            out[x * 4 + 2] = clamp(c + ((CB_B * u + (1 << 19)) >> 20));
            out[x * 4 + 3] = as ? as[sx] : 255;
        }
    }
}

/**
 * Decodes one video packet. `key` marks a keyframe (from the frame index's bit
 * 0; the decoder reads nothing else to tell). When rgba isn't null the picture
 * is written there, full size when shift is 0, else 2^shift times smaller each
 * way (rounded up). When yuv isn't null the decoded planes are written there
 * too, Y then U then V, each packed (for checking against FFmpeg's own decode).
 * Returns 1 for a frame, 0 for none, negative on error.
 */
EMSCRIPTEN_KEEPALIVE int video_decode(Decoder *d, const uint8_t *data, int size, int key, uint8_t *rgba, int shift, uint8_t *yuv) {
    av_packet_unref(d->packet);
    if (av_new_packet(d->packet, size) < 0) return -1;
    memcpy(d->packet->data, data, size);
    if (key) d->packet->flags |= AV_PKT_FLAG_KEY;
    int err = avcodec_send_packet(d->codec, d->packet);
    if (err < 0) return err;
    err = avcodec_receive_frame(d->codec, d->frame);
    if (err == AVERROR(EAGAIN)) return 0;
    if (err < 0) return err;
    const AVFrame *f = d->frame;
    if (rgba) {
        if (shift > 0) to_rgba_small(f, rgba, shift);
        else to_rgba(f, rgba);
    }
    if (yuv) {
        const int cw = (f->width + 1) >> 1, ch = (f->height + 1) >> 1;
        for (int y = 0; y < f->height; y++) memcpy(yuv + (size_t)y * f->width, f->data[0] + y * f->linesize[0], f->width);
        uint8_t *u = yuv + (size_t)f->width * f->height, *v = u + (size_t)cw * ch;
        for (int y = 0; y < ch; y++) {
            memcpy(u + (size_t)y * cw, f->data[1] + y * f->linesize[1], cw);
            memcpy(v + (size_t)y * cw, f->data[2] + y * f->linesize[2], cw);
        }
    }
    av_frame_unref(d->frame);
    return 1;
}

/**
 * Keeps the decoder's reference frame (the last picture decoded) so decoding
 * can carry on from here later. The decoder writes each frame into a new
 * buffer, so keeping a reference costs nothing and the picture is never written over.
 */
EMSCRIPTEN_KEEPALIVE AVFrame *video_save(Decoder *d) {
    AVFrame *last = chimera_bink2_reference(d->codec);
    return last && last->data[0] ? av_frame_clone(last) : NULL;
}

/** Makes a saved frame the decoder's reference again: the next packet decodes as if it followed that frame. */
EMSCRIPTEN_KEEPALIVE int video_restore(Decoder *d, AVFrame *saved) {
    AVFrame *last = chimera_bink2_reference(d->codec);
    av_frame_unref(last);
    return av_frame_ref(last, saved);
}

EMSCRIPTEN_KEEPALIVE void video_forget(AVFrame *saved) {
    av_frame_free(&saved);
}
