/*
 * A small API over the Bink decoders for the browser: FFmpeg's Bink video and
 * audio decoders, and the Bink 2 video decoder built into the same FFmpeg (see
 * build.sh). The container is read in TypeScript (src/formats/westwood/bink.ts);
 * this only decodes the packets it hands over: video to RGBA, audio to
 * interleaved 16-bit samples. Bink 2's sound is the same Bink audio as Bink 1's.
 *
 * Built with build.sh into src/formats/westwood/bink-wasm/bink.mjs.
 */
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <emscripten/emscripten.h>
#include "libavcodec/avcodec.h"
#include "libavutil/samplefmt.h"

/* From bink-reference.c and bink2-reference.c, appended to libavcodec/bink.c and bink2.c by build.sh. */
AVFrame *chimera_bink_reference(AVCodecContext *avctx);
AVFrame *chimera_bink2_reference(AVCodecContext *avctx);

typedef struct {
    AVCodecContext *codec;
    AVPacket *packet;
    AVFrame *frame;
} Decoder;

static Decoder *open_decoder(enum AVCodecID id, uint32_t tag, const uint8_t *extradata, int extradata_size, int width, int height, int sample_rate, int channels) {
    const AVCodec *codec = avcodec_find_decoder(id);
    if (!codec) return NULL;
    Decoder *d = calloc(1, sizeof(Decoder));
    d->codec = avcodec_alloc_context3(codec);
    d->codec->codec_tag = tag;
    d->codec->width = width;
    d->codec->height = height;
    if (sample_rate) {
        d->codec->sample_rate = sample_rate;
        av_channel_layout_default(&d->codec->ch_layout, channels);
    }
    if (extradata_size) {
        d->codec->extradata = av_mallocz(extradata_size + AV_INPUT_BUFFER_PADDING_SIZE);
        memcpy(d->codec->extradata, extradata, extradata_size);
        d->codec->extradata_size = extradata_size;
    }
    if (avcodec_open2(d->codec, codec, NULL) < 0) {
        avcodec_free_context(&d->codec);
        free(d);
        return NULL;
    }
    d->packet = av_packet_alloc();
    d->frame = av_frame_alloc();
    return d;
}

static int is_bink2(const Decoder *d) {
    return d->codec->codec_id == AV_CODEC_ID_BINKVIDEO2;
}

/**
 * Bink video, 1 or 2 by the file's 4-byte signature ("BIKi", "KB2j"), which is
 * also the tag (the decoders read its revision letter); the file's 4-byte video
 * flags are the extradata.
 */
EMSCRIPTEN_KEEPALIVE Decoder *video_open(uint32_t tag, uint32_t flags, int width, int height) {
    const enum AVCodecID id = (tag & 0xFFFFFF) == MKTAG('K', 'B', '2', 0) ? AV_CODEC_ID_BINKVIDEO2 : AV_CODEC_ID_BINKVIDEO;
    return open_decoder(id, tag, (const uint8_t *)&flags, 4, width, height, 0, 0);
}

/** Bink audio: DCT or RDFT, with the file's signature as extradata (the decoder reads its version letter). */
EMSCRIPTEN_KEEPALIVE Decoder *audio_open(int dct, uint32_t tag, int sample_rate, int channels) {
    return open_decoder(dct ? AV_CODEC_ID_BINKAUDIO_DCT : AV_CODEC_ID_BINKAUDIO_RDFT, 0, (const uint8_t *)&tag, 4, 0, 0, sample_rate, channels);
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

static int send(Decoder *d, const uint8_t *data, int size, int key) {
    av_packet_unref(d->packet);
    if (av_new_packet(d->packet, size) < 0) return -1;
    memcpy(d->packet->data, data, size);
    if (key) d->packet->flags |= AV_PKT_FLAG_KEY;
    return avcodec_send_packet(d->codec, d->packet);
}

static uint8_t clamp(int v) {
    return v < 0 ? 0 : v > 255 ? 255 : v;
}

/** Bink 1's YUV to RGB: BT.601 at studio range (Y from 16 to 235), each chroma sample used for its 2 × 2 pixels. */
static void bink1_rgba(const AVFrame *f, uint8_t *rgba) {
    const int alpha = f->format == AV_PIX_FMT_YUVA420P;
    for (int y = 0; y < f->height; y++) {
        const uint8_t *ys = f->data[0] + y * f->linesize[0];
        const uint8_t *us = f->data[1] + (y >> 1) * f->linesize[1];
        const uint8_t *vs = f->data[2] + (y >> 1) * f->linesize[2];
        const uint8_t *as = alpha ? f->data[3] + y * f->linesize[3] : NULL;
        uint8_t *out = rgba + (size_t)y * f->width * 4;
        for (int x = 0; x < f->width; x++) {
            const int c = (ys[x] - 16) * 298;
            const int u = us[x >> 1] - 128;
            const int v = vs[x >> 1] - 128;
            out[x * 4] = clamp((c + 409 * v + 128) >> 8);
            out[x * 4 + 1] = clamp((c - 100 * u - 208 * v + 128) >> 8);
            out[x * 4 + 2] = clamp((c + 516 * u + 128) >> 8);
            out[x * 4 + 3] = as ? as[x] : 255;
        }
    }
}

/*
 * Bink 2's YUV to RGB (measured against Bink's own player): BT.601 at full
 * range (Y as it is, no studio-range stretch), the chroma upsampled bilinearly
 * with each sample centered between four pixels. Fixed point: the chroma comes
 * out in sixteenths, so each coefficient is scaled by 2^16 / 16.
 */
#define CR_R 91881  /* 1.402 */
#define CB_G 22554  /* 0.344136 */
#define CR_G 46802  /* 0.714136 */
#define CB_B 116130 /* 1.772 */

static void bink2_rgba(const AVFrame *f, uint8_t *rgba) {
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

/** Bink 2's, smaller: every 2^shift-th pixel each way, for playing large movies; quick, and good enough while it moves. */
static void bink2_rgba_small(const AVFrame *f, uint8_t *rgba, int shift) {
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
 * 0; Bink 2's decoder reads nothing else to tell, Bink 1's doesn't need it).
 * When rgba isn't null the picture is written there, full size when shift is 0,
 * else (Bink 2 only) 2^shift times smaller each way, rounded up. When yuv isn't
 * null the decoded planes are written there too, Y then U then V, each packed
 * (for checking against FFmpeg's own decode). Returns 1 for a frame, 0 for
 * none, negative on error (and for a shift on Bink 1).
 */
EMSCRIPTEN_KEEPALIVE int video_decode(Decoder *d, const uint8_t *data, int size, int key, uint8_t *rgba, int shift, uint8_t *yuv) {
    if (shift && !is_bink2(d)) return AVERROR(EINVAL);
    int err = send(d, data, size, key);
    if (err < 0) return err;
    err = avcodec_receive_frame(d->codec, d->frame);
    if (err == AVERROR(EAGAIN)) return 0;
    if (err < 0) return err;
    const AVFrame *f = d->frame;
    if (rgba) {
        if (!is_bink2(d)) bink1_rgba(f, rgba);
        else if (shift > 0) bink2_rgba_small(f, rgba, shift);
        else bink2_rgba(f, rgba);
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

static AVFrame *reference(Decoder *d) {
    return is_bink2(d) ? chimera_bink2_reference(d->codec) : chimera_bink_reference(d->codec);
}

/**
 * Keeps the decoder's reference frame (the last picture decoded) so decoding
 * can carry on from here later. Both decoders write each frame into a new
 * buffer, so keeping a reference costs nothing and the picture is never written over.
 */
EMSCRIPTEN_KEEPALIVE AVFrame *video_save(Decoder *d) {
    AVFrame *last = reference(d);
    return last && last->data[0] ? av_frame_clone(last) : NULL;
}

/** Makes a saved frame the decoder's reference again: the next packet decodes as if it followed that frame. */
EMSCRIPTEN_KEEPALIVE int video_restore(Decoder *d, AVFrame *saved) {
    return av_frame_replace(reference(d), saved);
}

EMSCRIPTEN_KEEPALIVE void video_forget(AVFrame *saved) {
    av_frame_free(&saved);
}

/**
 * Decodes one audio packet into out as interleaved 16-bit samples (at most
 * max of them). Returns how many were written, or negative on error.
 */
EMSCRIPTEN_KEEPALIVE int audio_decode(Decoder *d, const uint8_t *data, int size, int16_t *out, int max) {
    int err = send(d, data, size, 0);
    if (err < 0) return err;
    int written = 0;
    while ((err = avcodec_receive_frame(d->codec, d->frame)) >= 0) {
        const AVFrame *f = d->frame;
        const int channels = f->ch_layout.nb_channels;
        // The DCT decoder gives a plane per channel; the RDFT one, interleaved samples.
        const int planar = av_sample_fmt_is_planar(f->format);
        for (int i = 0; i < f->nb_samples; i++) {
            for (int c = 0; c < channels && written < max; c++) {
                const float v = planar ? ((const float *)f->extended_data[c])[i] : ((const float *)f->data[0])[i * channels + c];
                // As FFmpeg converts float to 16-bit: scaled by 2^15 and rounded.
                const long s = lrintf(v * 32768.0f);
                out[written++] = s > 32767 ? 32767 : s < -32768 ? -32768 : (int16_t)s;
            }
        }
        av_frame_unref(d->frame);
    }
    return err == AVERROR(EAGAIN) || err == AVERROR_EOF ? written : err;
}
