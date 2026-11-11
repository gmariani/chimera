/**
 * Nellymoser Asao, the speech codec Flash used for microphones and "Speech"
 * sound compression. 64-byte blocks of 256 samples: a gain for each of 23
 * frequency bands (6 bits, then 5-bit steps), from which both ends work out
 * how many bits each of 124 coefficients gets; then two sets of coefficients,
 * each run through an inverse MDCT and overlapped with the last.
 *
 * Ported from FFmpeg's nellymoser.c and nellymoserdec.c, which carry this notice:
 *
 * Copyright (c) 2007 a840bda5870ba11f19698ff6eb9581dfb0f95fa5,
 *                    539459aeb7d425140b62a3ec7dbf6dc8e408a306, and
 *                    520e17cd55896441042b14df2566a6eb610ed444
 * Copyright (c) 2007 Loic Minier <lool at dooz.org>
 *                    Benjamin Larsson
 *
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"),
 * to deal in the Software without restriction, including without limitation
 * the rights to use, copy, modify, merge, publish, distribute, sublicense,
 * and/or sell copies of the Software, and to permit persons to whom the
 * Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
 * THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
 * DEALINGS IN THE SOFTWARE.
 */

const BANDS = 23;
const BLOCK = 64;
const HEADER_BITS = 116;
const DETAIL_BITS = 198;
const BUF_LEN = 128;
const FILL_LEN = 124;
const BIT_CAP = 6;
const BASE_OFF = 4228;
const BASE_SHIFT = 19;
const SAMPLES = 2 * BUF_LEN;

const DEQUANTIZATION = [
    0.0, -0.8472560048, 0.7224709988, -1.5247479677, -0.4531480074, 0.3753609955, 1.4717899561, -1.9822579622, -1.1929379702, -0.5829370022, -0.0693780035, 0.3909569979, 0.9069200158, 1.486274004, 2.2215409279,
    -2.3887870312, -1.806753993, -1.4105420113, -1.0773609877, -0.7995010018, -0.5558109879, -0.3334020078, -0.1324490011, 0.0568020009, 0.254877001, 0.4773550034, 0.7386850119, 1.0443060398, 1.3954459429, 1.8098750114, 2.3918759823,
    -2.3893830776, -1.988468051, -1.751404047, -1.5643119812, -1.3922129869, -1.2164649963, -1.0469499826, -0.8905100226, -0.7645580173, -0.645457983, -0.5259280205, -0.4059549868, -0.3029719889, -0.2096900046, -0.1239869967, -0.0479229987,
    0.025773, 0.1001340002, 0.1737180054, 0.2585540116, 0.3522900045, 0.4569880068, 0.5767750144, 0.7003160119, 0.8425520062, 1.00938797, 1.1821349859, 1.3534560204, 1.5320819616, 1.7332619429, 1.9722349644, 2.3978140354,
    -2.5756309032, -2.0573320389, -1.8984919786, -1.7727810144, -1.666260004, -1.5742180347, -1.4993319511, -1.43166399, -1.3652280569, -1.3000990152, -1.2280930281, -1.1588579416, -1.0921250582, -1.0135740042, -0.9202849865, -0.8287050128,
    -0.7374889851, -0.6447759867, -0.5590940118, -0.4857139885, -0.4110319912, -0.3459700048, -0.2851159871, -0.2341620028, -0.1870580018, -0.1442500055, -0.1107169986, -0.0739680007, -0.0365610011, -0.0073290002, 0.0203610007, 0.0479039997,
    0.0751969963, 0.0980999991, 0.1220389977, 0.1458999962, 0.1694349945, 0.1970459968, 0.2252430022, 0.2556869984, 0.2870100141, 0.3197099864, 0.3525829911, 0.3889069855, 0.4334920049, 0.4769459963, 0.5204820037, 0.5644530058,
    0.6122040153, 0.6685929894, 0.7341650128, 0.8032159805, 0.8784040213, 0.9566209912, 1.0397069454, 1.1293770075, 1.2211159468, 1.3080279827, 1.4024800062, 1.5056819916, 1.6227730513, 1.772495985, 1.9430880547, 2.2903931141,
]; // prettier-ignore
const BAND_SIZES = [2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 3, 4, 4, 5, 6, 6, 7, 8, 9, 10, 12, 14, 15];
const INIT = [
    3134, 5342, 6870, 7792, 8569, 9185, 9744, 10191, 10631, 11061, 11434, 11770, 12116, 12513, 12925, 13300, 13674, 14027, 14352, 14716, 15117, 15477, 15824, 16157, 16513, 16804, 17090, 17401, 17679, 17948, 18238, 18520,
    18764, 19078, 19381, 19640, 19921, 20205, 20500, 20813, 21162, 21465, 21794, 22137, 22453, 22756, 23067, 23350, 23636, 23926, 24227, 24521, 24819, 25107, 25414, 25730, 26120, 26497, 26895, 27344, 27877, 28463, 29426, 31355,
]; // prettier-ignore
const DELTA = [
    -11725, -9420, -7910, -6801, -5948, -5233, -4599, -4039, -3507, -3030, -2596, -2170, -1774, -1383, -1016, -660, -329, -1, 337, 696, 1085, 1512, 1962, 2433, 2968, 3569, 4314, 5279, 6622, 8154,
    10076, 12975,
];

const SINE = Float64Array.from({ length: BUF_LEN }, (_, i) => Math.sin(((i + 0.5) * Math.PI) / (2 * BUF_LEN)));
/** The half inverse MDCT of 256 points: 128 coefficients to the middle 128 samples (negated, as FFmpeg's transform has it). */
const COS = (() => {
    const t = new Float64Array(BUF_LEN * BUF_LEN);
    for (let n = 0; n < BUF_LEN; n++) for (let k = 0; k < BUF_LEN; k++) t[n * BUF_LEN + k] = -Math.cos((Math.PI / BUF_LEN) * (n + BUF_LEN / 2 + 0.5 + BUF_LEN / 2) * (k + 0.5));
    return t;
})();

const clip = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
/** Integer log2, of a value above 0. */
const log2 = (v: number) => 31 - Math.clz32(v);
const shifted = (v: number, shift: number) => (shift > 0 ? v << shift : v >> -shift);
/** C's 16-bit short. */
const short = (v: number) => (v << 16) >> 16;

function sumBits(buf: Int16Array, shift: number, off: number): number {
    let total = 0;
    for (let i = 0; i < FILL_LEN; i++) total += clip((((buf[i] - off) >> (shift - 1)) + 1) >> 1, 0, BIT_CAP);
    return total;
}

/** How far a value can shift left in 31 bits; shifts it there. */
function headroom(box: { v: number }): number {
    if (box.v === 0) return 31;
    const l = 30 - log2(Math.abs(box.v));
    box.v = box.v * 2 ** l;
    return l;
}

/** The bits each coefficient gets, from the band gains: the same sum both ends do, so it's integer math as in the original. */
function sampleBits(buf: Float32Array): Int32Array {
    const bits = new Int32Array(BUF_LEN);
    const sbuf = new Int16Array(BUF_LEN);
    let max = 0;
    for (let i = 0; i < FILL_LEN; i++) max = Math.max(max, Math.trunc(buf[i]));
    const maxBox = { v: max };
    let shift = -16 + headroom(maxBox);
    let sum = 0;
    for (let i = 0; i < FILL_LEN; i++) {
        sbuf[i] = short(shifted(Math.trunc(buf[i]), shift));
        sbuf[i] = short((3 * sbuf[i]) >> 2);
        sum += sbuf[i];
    }
    shift += 11;
    const saved = shift;
    sum -= DETAIL_BITS << shift;
    const sumBox = { v: sum | 0 };
    shift += headroom(sumBox);
    sum = sumBox.v | 0;
    let smallOff = (BASE_OFF * (sum >> 16)) >> 15;
    shift = saved - (BASE_SHIFT + shift - 31);
    smallOff = shifted(smallOff, shift);
    let bitsum = sumBits(sbuf, saved, smallOff);

    if (bitsum !== DETAIL_BITS) {
        let off = bitsum - DETAIL_BITS;
        for (shift = 0; Math.abs(off) <= 16383; shift++) off *= 2;
        off = (off * BASE_OFF) >> 15;
        shift = saved - (BASE_SHIFT + shift - 15);
        off = shifted(off, shift);
        let lastOff = 0;
        let lastBitsum = 0;
        let j = 1;
        for (; j < 20; j++) {
            lastOff = smallOff;
            smallOff += off;
            lastBitsum = bitsum;
            bitsum = sumBits(sbuf, saved, smallOff);
            if ((bitsum - DETAIL_BITS) * (lastBitsum - DETAIL_BITS) <= 0) break;
        }
        let bigOff: number, bigBitsum: number, smallBitsum: number;
        if (bitsum > DETAIL_BITS) {
            bigOff = smallOff;
            smallOff = lastOff;
            bigBitsum = bitsum;
            smallBitsum = lastBitsum;
        } else {
            bigOff = lastOff;
            bigBitsum = lastBitsum;
            smallBitsum = bitsum;
        }
        while (bitsum !== DETAIL_BITS && j <= 19) {
            off = (bigOff + smallOff) >> 1;
            bitsum = sumBits(sbuf, saved, off);
            if (bitsum > DETAIL_BITS) ((bigOff = off), (bigBitsum = bitsum));
            else ((smallOff = off), (smallBitsum = bitsum));
            j++;
        }
        if (Math.abs(bigBitsum - DETAIL_BITS) >= Math.abs(smallBitsum - DETAIL_BITS)) bitsum = smallBitsum;
        else ((smallOff = bigOff), (bitsum = bigBitsum));
    }

    for (let i = 0; i < FILL_LEN; i++) bits[i] = clip((((sbuf[i] - smallOff) >> (saved - 1)) + 1) >> 1, 0, BIT_CAP);
    if (bitsum > DETAIL_BITS) {
        let total = 0;
        let i = 0;
        while (total < DETAIL_BITS) total += bits[i++];
        bits[i - 1] -= total - DETAIL_BITS;
        for (; i < FILL_LEN; i++) bits[i] = 0;
    }
    return bits;
}

/**
 * Decodes Nellymoser blocks to 16-bit samples. Bands given no bits are filled
 * with noise; `random` picks its signs (FFmpeg's own generator can be given,
 * to match it exactly).
 */
export function decodeNellymoser(data: Uint8Array, random: () => number = lcg()): Int16Array {
    const blocks = Math.floor(data.length / BLOCK);
    const out = new Int16Array(blocks * SAMPLES);
    let prev = new Float64Array(BUF_LEN);
    let next = new Float64Array(BUF_LEN);
    const scaleBias = 1 / (32768 * 8);
    const buf = new Float32Array(FILL_LEN);
    const pows = new Float64Array(FILL_LEN);
    const audio = new Float64Array(BUF_LEN);

    for (let b = 0; b < blocks; b++) {
        const block = data.subarray(b * BLOCK, (b + 1) * BLOCK);
        // Bits least significant first.
        let bit = 0;
        const read = (n: number) => {
            let v = 0;
            for (let i = 0; i < n; i++, bit++) v |= ((block[bit >> 3] >> (bit & 7)) & 1) << i;
            return v;
        };
        let val = INIT[read(6)];
        let p = 0;
        for (let band = 0; band < BANDS; band++) {
            if (band > 0) val += DELTA[read(5)];
            const pval = -(2 ** (val / 2048)) * scaleBias;
            for (let k = 0; k < BAND_SIZES[band]; k++, p++) ((buf[p] = val), (pows[p] = pval));
        }
        const bits = sampleBits(buf);

        for (let half = 0; half < 2; half++) {
            bit = HEADER_BITS + half * DETAIL_BITS;
            for (let j = 0; j < FILL_LEN; j++) {
                if (bits[j] <= 0) {
                    audio[j] = Math.SQRT1_2 * pows[j];
                    if (random() & 1) audio[j] = -audio[j];
                } else {
                    audio[j] = DEQUANTIZATION[(1 << bits[j]) - 1 + read(bits[j])] * pows[j];
                }
            }
            audio.fill(0, FILL_LEN);
            for (let n = 0; n < BUF_LEN; n++) {
                let s = 0;
                for (let k = 0; k < BUF_LEN; k++) s += audio[k] * COS[n * BUF_LEN + k];
                next[n] = s;
            }
            // Overlap: the last transform's second half with this one's first, through the sine window.
            const o = b * SAMPLES + half * BUF_LEN;
            const len = BUF_LEN / 2;
            for (let i = 0; i < len; i++) {
                const s0 = prev[len + i];
                const s1 = next[len - 1 - i];
                const wi = SINE[i];
                const wj = SINE[BUF_LEN - 1 - i];
                out[o + i] = clip(Math.round((s0 * wj - s1 * wi) * 32768), -32768, 32767);
                out[o + BUF_LEN - 1 - i] = clip(Math.round((s0 * wi + s1 * wj) * 32768), -32768, 32767);
            }
            [prev, next] = [next, prev];
        }
    }
    return out;
}

/** A small random generator for the noise's signs. */
function lcg(): () => number {
    let state = 1;
    return () => (state = (Math.imul(state, 1103515245) + 12345) >>> 0) >>> 16;
}
