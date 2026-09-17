/**
 * Finding where each camera sits on the reference track's clock.
 *
 * Every test here builds its own recordings, so the answer is known before the
 * code runs: a shape is generated, copied, delayed by an exact number of
 * frames, roughed up with noise and a different gain, and the engine has to
 * name the delay back. That is the whole reason the engine takes envelopes
 * rather than files - a wrong frame is visible here in milliseconds instead of
 * an hour into a real cut.
 */
var fftmod = require('../lib/fft');
var env = require('../lib/envelope');
var sync = require('../lib/sync');

var pass = 0, fail = 0;
function ok(label, cond) {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label); }
}
function eq(label, got, want) {
  var good = JSON.stringify(got) === JSON.stringify(want);
  if (good) { pass++; console.log('  ok   ' + label); }
  else {
    fail++;
    console.log('  FAIL ' + label + '\n         got  ' + JSON.stringify(got) +
                '\n         want ' + JSON.stringify(want));
  }
}

// ------------------------------------------------------------------ the FFT
console.log('\n-- the FFT, before anything is built on it --');
function dftMag(re) {
  // a slow, obviously-correct DFT to check the fast one against
  var n = re.length, out = [];
  for (var k = 0; k < n; k++) {
    var sr = 0, si = 0;
    for (var t = 0; t < n; t++) {
      var a = -2 * Math.PI * k * t / n;
      sr += re[t] * Math.cos(a);
      si += re[t] * Math.sin(a);
    }
    out.push(Math.sqrt(sr * sr + si * si));
  }
  return out;
}
var probe = [1, 5, -2, 3, 0, 7, -1, 2];
var pr = Float64Array.from(probe), pi = new Float64Array(8);
fftmod.fft(pr, pi, false);
var slow = dftMag(probe), worst = 0;
for (var i = 0; i < 8; i++) {
  worst = Math.max(worst, Math.abs(Math.sqrt(pr[i] * pr[i] + pi[i] * pi[i]) - slow[i]));
}
ok('matches a plain DFT', worst < 1e-9);

fftmod.fft(pr, pi, true);
var back = 0;
for (i = 0; i < 8; i++) { back = Math.max(back, Math.abs(pr[i] - probe[i])); }
ok('inverse returns the original', back < 1e-9);
eq('a non power of two is refused', (function () {
  try { fftmod.fft(new Float64Array(3), new Float64Array(3), false); return 'no error'; }
  catch (e) { return 'refused'; }
})(), 'refused');
eq('next power of two', [1, 2, 3, 5, 1024, 1025].map(fftmod.nextPowerOfTwo),
   [1, 2, 4, 8, 1024, 2048]);

// -------------------------------------------------------------- envelopes
console.log('\n-- the envelope --');
var sr = 48000;
var tone = new Float64Array(sr);                 // one second, half of it silent
for (i = 0; i < sr / 2; i++) { tone[i] = Math.sin(i * 0.05); }
var e = env.envelope(tone, sr, 100);
eq('one value per 10 ms', e.length, 100);
ok('loud where the sound is', e[10] > 0.5);
ok('silent where it is not', e[80] < 1e-12);
ok('dB floors instead of returning -Infinity', env.toDb(e)[80] === -90);

var norm = env.normalize(Float64Array.from([1, 2, 3, 4]));
var sum = 0, energy = 0;
for (i = 0; i < 4; i++) { sum += norm[i]; energy += norm[i] * norm[i]; }
ok('normalise removes the mean', Math.abs(sum) < 1e-12);
ok('and scales to unit energy', Math.abs(energy - 1) < 1e-12);
eq('seconds and frames agree', env.secondsToFrames(env.framesToSeconds(250, 100), 100), 250);

// ------------------------------------------------------------ the real job
console.log('\n-- a camera that started late --');

// Something with the shape of speech: bursts of talking with gaps between,
// the level inside a burst wandering rather than repeating.
//
// The first version of this drew a sine inside each burst, which made the test
// material far more repetitive than speech - every true match scored a
// peak-to-sidelobe ratio of 1.7 against a threshold of 1.6, so the tests
// passed while proving almost nothing. A generator has to be at least as
// awkward as the real thing or it grades its own homework.
function speechLike(frames, seed) {
  var out = new Float64Array(frames), s = seed || 1;
  function rnd() { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; }
  var t = 0;
  while (t < frames) {
    var talk = 40 + Math.floor(rnd() * 160);     // 0.4 - 2.0 s of speech
    var quiet = 20 + Math.floor(rnd() * 120);
    var level = 0.3 + rnd() * 0.7, cur = level;
    for (var k = 0; k < talk && t < frames; k++, t++) {
      cur = cur * 0.7 + level * (0.3 + 0.7 * rnd()) * 0.3;
      out[t] = cur;
    }
    t += quiet;
  }
  return out;
}

/** The same room, heard from somewhere else: delayed, quieter, noisier. */
function asHeardBy(source, delayFrames, gain, noise, seed) {
  var s = seed || 7;
  function rnd() { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; }
  var n = source.length + Math.abs(delayFrames);
  var out = new Float64Array(n);
  for (var i = 0; i < n; i++) {
    var src = i - delayFrames;
    var v = (src >= 0 && src < source.length) ? source[src] : 0;
    out[i] = v * gain + (rnd() - 0.5) * noise;
  }
  return out;
}

var reference = speechLike(6000, 42);            // one minute of reference
var cases = [0, 1, 17, 250, 1337, -400];
for (var c = 0; c < cases.length; c++) {
  var delay = cases[c];
  var cam = asHeardBy(reference, delay, 0.4, 0.05, 100 + c);
  var r = sync.findOffset(reference, cam);
  eq('a delay of ' + delay + ' frames comes back exactly', r.lag, delay);
  ok('  and it says it is sure (score ' + r.score.toFixed(2) +
     ', ratio ' + (r.ratio === Infinity ? 'inf' : r.ratio.toFixed(1)) + ')', r.ok);
}

console.log('\n-- heard from the back of the room --');
var faint = asHeardBy(reference, 333, 0.02, 0.01, 9);
var rf = sync.findOffset(reference, faint);
eq('a much quieter camera lands on the same frame', rf.lag, 333);
ok('loudness does not decide it', rf.ok);

var noisy = asHeardBy(reference, 91, 0.5, 0.35, 11);
var rn = sync.findOffset(reference, noisy);
eq('and so does a noisy one', rn.lag, 91);

console.log('\n-- when it should refuse --');
var elsewhere = speechLike(6000, 777);           // a different take entirely
var re2 = sync.findOffset(reference, elsewhere);
ok('a camera from another take is not placed', !re2.ok);
ok('and it says why', /do not sound alike|line up about as well/.test(re2.why));

var roomTone = new Float64Array(6000);
for (i = 0; i < 6000; i++) { roomTone[i] = 0.01 * Math.sin(i * 0.01); }
ok('a camera that recorded nothing but hum is not placed',
   !sync.findOffset(reference, roomTone).ok);
ok('an empty recording is not placed',
   !sync.findOffset(reference, new Float64Array(0)).ok);

console.log('\n-- a whole folder at once --');
var rows = sync.syncAll(reference, [
  { name: 'CAM_A.mp4', env: asHeardBy(reference, 0, 0.4, 0.05, 1) },
  { name: 'CAM_B.mp4', env: asHeardBy(reference, 612, 0.3, 0.06, 2) },
  { name: 'CAM_C.mp4', env: asHeardBy(reference, -150, 0.5, 0.04, 3) },
  { name: 'CAM_D.mp4', env: speechLike(6000, 999) }
]);
eq('one row per file, in order', rows.map(function (x) { return x.name; }),
   ['CAM_A.mp4', 'CAM_B.mp4', 'CAM_C.mp4', 'CAM_D.mp4']);
eq('the offsets', rows.slice(0, 3).map(function (x) { return x.lagFrames; }), [0, 612, -150]);
eq('in seconds too', rows[1].seconds, 6.12);
eq('the odd one out is flagged, not placed', rows[3].ok, false);
ok('the three good ones are not', rows[0].ok && rows[1].ok && rows[2].ok);

console.log('\n-- a match and a mismatch have to be far apart --');
// A threshold is only worth having if the two cases land either side of it
// with room to spare. These numbers are what the thresholds in sync.js were
// chosen against, so if a change narrows the gap, this is where it shows.
var matched = sync.findOffset(reference, asHeardBy(reference, 250, 0.4, 0.05, 3));
var mismatched = sync.findOffset(reference, speechLike(6000, 777));
ok('a true match scores well over the bar (' + matched.ratio.toFixed(2) + ' vs 1.6)',
   matched.ratio > 2.0);
ok('a mismatch sits well under it (' + mismatched.ratio.toFixed(2) + ')',
   mismatched.ratio < 1.35);
ok('and their scores are nowhere near each other (' +
   matched.score.toFixed(2) + ' vs ' + mismatched.score.toFixed(2) + ')',
   matched.score - mismatched.score > 0.5);

console.log('\n-- a search window keeps it honest --');
var far = asHeardBy(reference, 2000, 0.4, 0.05, 5);
eq('inside the window it is found', sync.findOffset(reference, far, { maxLagFrames: 3000 }).lag, 2000);
ok('outside it, it is not claimed',
   sync.findOffset(reference, far, { maxLagFrames: 500 }).lag !== 2000);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
