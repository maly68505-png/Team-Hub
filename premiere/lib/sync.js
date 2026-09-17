/**
 * Where each camera sits on the reference track's clock.
 *
 * Every camera in the room records the same sound from a different distance,
 * so their scratch audio all carries the same shape - the same pauses, the same
 * laugh, the same door. Sliding one against the other until those shapes line
 * up is the whole of syncing, and it is a calculation, not a judgement: given
 * the same two recordings it lands on the same frame every time.
 *
 * Nothing in here opens a file. It takes envelopes and returns offsets, so the
 * part of the tool most likely to be wrong is also the part that can be tested
 * without Premiere, without media, and in milliseconds.
 */

var fftmod = require('./fft');
var env = require('./envelope');

/**
 * Circular cross-correlation of two equal-length, zero-padded signals, via
 * FFT: corr = IFFT( FFT(a) * conj(FFT(b)) ).
 */
function correlate(a, b, size) {
    var ar = new Float64Array(size), ai = new Float64Array(size);
    var br = new Float64Array(size), bi = new Float64Array(size);
    var i;
    for (i = 0; i < a.length; i++) { ar[i] = a[i]; }
    for (i = 0; i < b.length; i++) { br[i] = b[i]; }

    fftmod.fft(ar, ai, false);
    fftmod.fft(br, bi, false);

    var cr = new Float64Array(size), ci = new Float64Array(size);
    for (i = 0; i < size; i++) {
        // a * conj(b)
        cr[i] = ar[i] * br[i] + ai[i] * bi[i];
        ci[i] = ai[i] * br[i] - ar[i] * bi[i];
    }
    fftmod.fft(cr, ci, true);
    return cr;
}

/**
 * How far `sig` sits behind `ref`, in envelope frames.
 *
 * A POSITIVE lag means the camera started LATER than the reference: its
 * material has to move left, or be placed that far in, to line up.
 *
 * Returns { lag, score, ratio, ok }:
 *   score  the normalised correlation at the peak, 0..1 - how alike the two
 *          recordings are once lined up
 *   ratio  the peak divided by the best peak somewhere else entirely. A real
 *          lock towers over everything; a camera that recorded a different
 *          take, or silence, produces a field of near-equal bumps and a ratio
 *          close to 1. This is what catches the case a score alone misses.
 *   ok     both are above their thresholds
 */
function findOffset(ref, sig, opts) {
    opts = opts || {};
    var minScore = (opts.minScore === undefined) ? 0.25 : opts.minScore;
    var minRatio = (opts.minRatio === undefined) ? 1.6 : opts.minRatio;
    var maxLag = opts.maxLagFrames || 0;          // 0 = no limit

    var a = env.normalize(ref), b = env.normalize(sig);
    if (a.length === 0 || b.length === 0) {
        return { lag: 0, score: 0, ratio: 0, ok: false, why: 'one of the recordings is empty' };
    }

    var size = fftmod.nextPowerOfTwo(a.length + b.length);
    var corr = correlate(a, b, size);

    // index m means lag -m; wrap the top half round to negative lags
    var best = -Infinity, bestIdx = 0, i, lag;
    for (i = 0; i < size; i++) {
        lag = (i <= size / 2) ? -i : size - i;
        if (maxLag && Math.abs(lag) > maxLag) { continue; }
        if (corr[i] > best) { best = corr[i]; bestIdx = i; }
    }
    var bestLag = (bestIdx <= size / 2) ? -bestIdx : size - bestIdx;

    // the best peak that is not part of this one, for the ratio
    var guard = Math.max(3, Math.round((opts.guardFrames === undefined ? 25 : opts.guardFrames)));
    var second = 0;
    for (i = 0; i < size; i++) {
        var d = Math.abs(i - bestIdx);
        if (d > size / 2) { d = size - d; }
        if (d <= guard) { continue; }
        lag = (i <= size / 2) ? -i : size - i;
        if (maxLag && Math.abs(lag) > maxLag) { continue; }
        if (corr[i] > second) { second = corr[i]; }
    }

    var score = best > 0 ? best : 0;
    var ratio = second > 0 ? (best / second) : (best > 0 ? Infinity : 0);
    var ok = score >= minScore && ratio >= minRatio;
    var why = ok ? ''
        : (score < minScore
            ? 'the two recordings do not sound alike enough to place (score ' +
              score.toFixed(2) + ')'
            : 'several places line up about as well as each other (ratio ' +
              ratio.toFixed(2) + ') - this is what a camera that recorded a ' +
              'different take, or nothing but room tone, looks like');

    return { lag: bestLag, score: score, ratio: ratio, ok: ok, why: why };
}

/**
 * Places a whole folder's worth of recordings on one clock.
 *
 * `items` is [{ name, env }]; `refEnv` is the track everything is measured
 * against. Returns one row per item, in the same order, carrying the offset in
 * frames and in seconds - and never silently dropping one that failed to lock,
 * because a camera placed at a confident-looking zero is worse than a camera
 * the tool admits it could not place.
 */
function syncAll(refEnv, items, opts) {
    opts = opts || {};
    var frameHz = opts.frameHz || env.FRAME_HZ;
    var out = [];
    for (var i = 0; i < items.length; i++) {
        var r = findOffset(refEnv, items[i].env, opts);
        out.push({
            name: items[i].name,
            lagFrames: r.lag,
            seconds: env.framesToSeconds(r.lag, frameHz),
            score: r.score,
            ratio: r.ratio,
            ok: r.ok,
            why: r.why
        });
    }
    return out;
}

module.exports = { correlate: correlate, findOffset: findOffset, syncAll: syncAll };
