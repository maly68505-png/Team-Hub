/**
 * Turns audio samples into a loudness envelope.
 *
 * Nothing downstream needs the audio itself. Sync only needs to know WHEN it
 * got loud, and who-is-speaking only needs to know WHICH mic is loudest - both
 * of those live in the envelope. Throwing the waveform away early makes the
 * whole engine about a thousand times smaller and, more to the point, lets
 * every test run on a few hundred numbers instead of a media file.
 */

var FRAME_HZ = 100;          // one envelope value per 10 ms

/**
 * RMS per frame. `samples` is mono PCM in any numeric array; the result is one
 * value per 1/frameHz of a second.
 */
function envelope(samples, sampleRate, frameHz) {
    frameHz = frameHz || FRAME_HZ;
    var per = Math.max(1, Math.round(sampleRate / frameHz));
    var count = Math.floor(samples.length / per);
    var out = new Float64Array(count);
    for (var f = 0; f < count; f++) {
        var sum = 0, base = f * per;
        for (var i = 0; i < per; i++) {
            var v = samples[base + i];
            sum += v * v;
        }
        out[f] = Math.sqrt(sum / per);
    }
    return out;
}

/** Envelope in dB relative to full scale, floored so silence is a number. */
function toDb(env, floorDb) {
    floorDb = (floorDb === undefined) ? -90 : floorDb;
    var out = new Float64Array(env.length);
    var floorLin = Math.pow(10, floorDb / 20);
    for (var i = 0; i < env.length; i++) {
        out[i] = 20 * Math.log10(Math.max(env[i], floorLin));
    }
    return out;
}

/**
 * Subtracts the mean and scales to unit energy.
 *
 * Correlation without this is dominated by how loud a camera's scratch mic
 * happens to be: a camera at the back of the room would score lower than one
 * next to the table no matter how well it actually lined up, and the loudest
 * camera would win a tie it had not earned.
 */
function normalize(env) {
    var n = env.length, i, mean = 0;
    if (n === 0) { return new Float64Array(0); }
    for (i = 0; i < n; i++) { mean += env[i]; }
    mean /= n;
    var out = new Float64Array(n), energy = 0;
    for (i = 0; i < n; i++) {
        out[i] = env[i] - mean;
        energy += out[i] * out[i];
    }
    if (energy > 0) {
        var scale = 1 / Math.sqrt(energy);
        for (i = 0; i < n; i++) { out[i] *= scale; }
    }
    return out;
}

/** Frames <-> seconds, so callers never divide by the frame rate by hand. */
function framesToSeconds(frames, frameHz) { return frames / (frameHz || FRAME_HZ); }
function secondsToFrames(seconds, frameHz) { return Math.round(seconds * (frameHz || FRAME_HZ)); }

module.exports = {
    FRAME_HZ: FRAME_HZ,
    envelope: envelope,
    toDb: toDb,
    normalize: normalize,
    framesToSeconds: framesToSeconds,
    secondsToFrames: secondsToFrames
};
