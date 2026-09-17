/**
 * A radix-2 FFT, written out here so the sync engine has no dependencies.
 *
 * Syncing eight cameras against a two-hour reference by comparing every
 * possible offset directly is hundreds of billions of multiplications - minutes
 * of waiting per camera. The same answer comes out of three FFTs, in about a
 * second, which is the difference between a tool somebody uses and one they
 * stop opening.
 */

/** In-place complex FFT. `re` and `im` must be the same power-of-two length. */
function fft(re, im, inverse) {
    var n = re.length, i, j, bit, len, k;
    if (n !== im.length) { throw new Error('fft: re and im differ in length'); }
    if (n === 0 || (n & (n - 1)) !== 0) { throw new Error('fft: length must be a power of 2'); }

    // bit-reversal permutation
    for (i = 1, j = 0; i < n; i++) {
        bit = n >> 1;
        for (; j & bit; bit >>= 1) { j ^= bit; }
        j ^= bit;
        if (i < j) {
            var tr = re[i]; re[i] = re[j]; re[j] = tr;
            var ti = im[i]; im[i] = im[j]; im[j] = ti;
        }
    }

    for (len = 2; len <= n; len <<= 1) {
        var ang = 2 * Math.PI / len * (inverse ? 1 : -1);
        var wr = Math.cos(ang), wi = Math.sin(ang);
        var half = len >> 1;
        for (i = 0; i < n; i += len) {
            var cr = 1, ci = 0;
            for (k = 0; k < half; k++) {
                var ar = re[i + k], ai = im[i + k];
                var br = re[i + k + half], bi = im[i + k + half];
                var vr = br * cr - bi * ci;
                var vi = br * ci + bi * cr;
                re[i + k] = ar + vr; im[i + k] = ai + vi;
                re[i + k + half] = ar - vr; im[i + k + half] = ai - vi;
                var ncr = cr * wr - ci * wi;
                ci = cr * wi + ci * wr;
                cr = ncr;
            }
        }
    }

    if (inverse) {
        for (i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
    }
}

function nextPowerOfTwo(n) {
    var p = 1;
    while (p < n) { p <<= 1; }
    return p;
}

module.exports = { fft: fft, nextPowerOfTwo: nextPowerOfTwo };
