/*
 * A small API over FFmpeg's Bink decoders for the browser. The container is
 * read in TypeScript (src/formats/westwood/bink.ts); this only decodes the
 * packets it hands over: video to RGBA, audio to interleaved 16-bit samples.
 *
 * Built with build.sh into src/formats/westwood/bink-wasm/bink.mjs.
 */
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <emscripten/emscripten.h>
#include "libavcodec/avcodec.h"
#include "libavutil/imgutils.h"

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

/** Bink video: the file's 4-byte signature ("BIKi") as the tag, its 4-byte flags as extradata. */
EMSCRIPTEN_KEEPALIVE Decoder *video_open(uint32_t tag, uint32_t flags, int width, int height) {
    return open_decoder(AV_CODEC_ID_BINKVIDEO, tag, (const uint8_t *)&flags, 4, width, height, 0, 0);
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

static int send(Decoder *d, const uint8_t *data, int size) {
    av_packet_unref(d->packet);
    if (av_new_packet(d->packet, size) < 0) return -1;
    memcpy(d->packet->data, data, size);
    return avcodec_send_packet(d->codec, d->packet);
}

static uint8_t clamp(int v) {
    return v < 0 ? 0 : v > 255 ? 255 : v;
}

/**
 * Decodes one video packet. When rgba isn't null, the picture is written there
 * as width × height RGBA (BT.601, as Bink uses). Returns 1 for a frame, 0 for
 * none, negative on error.
 */
EMSCRIPTEN_KEEPALIVE int video_decode(Decoder *d, const uint8_t *data, int size, uint8_t *rgba) {
    int err = send(d, data, size);
    if (err < 0) return err;
    err = avcodec_receive_frame(d->codec, d->frame);
    if (err == AVERROR(EAGAIN)) return 0;
    if (err < 0) return err;
    if (rgba) {
        const AVFrame *f = d->frame;
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
    av_frame_unref(d->frame);
    return 1;
}

/**
 * Decodes one audio packet into out as interleaved 16-bit samples (at most
 * max of them). Returns how many were written, or negative on error.
 */
EMSCRIPTEN_KEEPALIVE int audio_decode(Decoder *d, const uint8_t *data, int size, int16_t *out, int max) {
    int err = send(d, data, size);
    if (err < 0) return err;
    int written = 0;
    while ((err = avcodec_receive_frame(d->codec, d->frame)) >= 0) {
        const AVFrame *f = d->frame;
        const int channels = f->ch_layout.nb_channels;
        for (int i = 0; i < f->nb_samples; i++) {
            for (int c = 0; c < channels && written < max; c++) {
                // Bink audio decodes to planar float.
                float s = ((const float *)f->extended_data[c])[i] * 32767.0f;
                out[written++] = s > 32767 ? 32767 : s < -32768 ? -32768 : (int16_t)s;
            }
        }
        av_frame_unref(d->frame);
    }
    return err == AVERROR(EAGAIN) || err == AVERROR_EOF ? written : err;
}
