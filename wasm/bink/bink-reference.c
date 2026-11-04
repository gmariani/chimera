
/*
 * Appended to libavcodec/bink.c by chimera's wasm/bink/build.sh: lets the
 * wrapper reach the decoder's reference frame (the previous picture), so it
 * can be saved and put back to seek without decoding from the start.
 */
AVFrame *chimera_bink_reference(AVCodecContext *avctx);
AVFrame *chimera_bink_reference(AVCodecContext *avctx)
{
    return ((BinkContext *)avctx->priv_data)->last;
}
