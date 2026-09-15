/**
 * Forcing STRAIGHT on a clip that was exported premultiplied is what put a
 * white fringe around the guest. The log from the real run showed
 * "hasAlpha=true alphaMode=STRAIGHT" on every card - set by the tool itself.
 */
var fs = require('fs');
var path = require('path');
var AE = path.join(__dirname, '..');

var core = fs.readFileSync(path.join(AE, 'lib', 'core.jsxinc'), 'utf8');
var block = core.slice(core.indexOf('    function trim(s)'),
                       core.indexOf('    // ------------------------------------------------------------------- UI'));

var AlphaMode = { IGNORE: 'ignore', STRAIGHT: 'straight', PREMULTIPLIED: 'premul' };

function Source(hasAlpha, mode, guessTo) {
  this.hasAlpha = hasAlpha;
  this.alphaMode = mode;
  this.invertAlpha = false;
  this.premulColor = null;
  this._guessTo = guessTo || AlphaMode.PREMULTIPLIED;
}
Source.prototype.guessAlphaMode = function () { this.alphaMode = this._guessTo; };
function Item(name, src) { this.name = name; this.mainSource = src; }

var sb = new Function('VIDEO_EXT', 'MIN_MATCH_SCORE', 'TOL', 'AlphaMode',
  block + '\nreturn { applyAlphaMode: applyAlphaMode, alphaModeName: alphaModeName };'
)("mp4,mov", 2, 0.0005, AlphaMode);

var pass = 0, fail = 0;
function eq(l, g, w) {
  var ok = JSON.stringify(g) === JSON.stringify(w);
  if (ok) { pass++; console.log('  ok   ' + l); }
  else { fail++; console.log('  FAIL ' + l + '\n         got  ' + JSON.stringify(g) + '\n         want ' + JSON.stringify(w)); }
}

console.log('\n-- "let AE decide" only steps in when the alpha was thrown away --');
var log = [];
var ignored = new Item('Aktbas_001.mov', new Source(true, AlphaMode.IGNORE, AlphaMode.PREMULTIPLIED));
eq('reports a change', sb.applyAlphaMode(ignored, 'auto', log), true);
eq('AE\'s own guess is used', ignored.mainSource.alphaMode, AlphaMode.PREMULTIPLIED);
eq('logged as a transition', /IGNORE .* ->  PREMULTIPLIED/.test(log[0]), true);

log = [];
var already = new Item('a.mov', new Source(true, AlphaMode.PREMULTIPLIED));
eq('an interpretation AE already made is left alone', sb.applyAlphaMode(already, 'auto', log), false);
eq('mode untouched', already.mainSource.alphaMode, AlphaMode.PREMULTIPLIED);
eq('nothing logged', log.length, 0);

console.log('\n-- the white fringe fix --');
log = [];
var fringed = new Item('b.mov', new Source(true, AlphaMode.STRAIGHT));
eq('premul-white applies', sb.applyAlphaMode(fringed, 'premul-white', log), true);
eq('mode is premultiplied', fringed.mainSource.alphaMode, AlphaMode.PREMULTIPLIED);
eq('matted against white', fringed.mainSource.premulColor, [1, 1, 1]);

log = [];
var dark = new Item('c.mov', new Source(true, AlphaMode.STRAIGHT));
sb.applyAlphaMode(dark, 'premul-black', log);
eq('matted against black', dark.mainSource.premulColor, [0, 0, 0]);

console.log('\n-- straight can still be forced on purpose --');
log = [];
var toStraight = new Item('d.mov', new Source(true, AlphaMode.PREMULTIPLIED));
eq('applies', sb.applyAlphaMode(toStraight, 'straight', log), true);
eq('mode is straight', toStraight.mainSource.alphaMode, AlphaMode.STRAIGHT);

console.log('\n-- a clip with no alpha is never touched, whatever is asked --');
var modes = ['auto', 'straight', 'premul-white', 'premul-black'];
for (var m = 0; m < modes.length; m++) {
  var opaque = new Item('e.mov', new Source(false, AlphaMode.IGNORE));
  eq('no change for "' + modes[m] + '"', sb.applyAlphaMode(opaque, modes[m], []), false);
  eq('  mode untouched', opaque.mainSource.alphaMode, AlphaMode.IGNORE);
}

console.log('\n-- guessAlphaMode missing falls back rather than throwing --');
log = [];
var noGuess = new Item('f.mov', new Source(true, AlphaMode.IGNORE));
noGuess.mainSource.guessAlphaMode = function () { throw new Error('unsupported'); };
eq('still resolved', sb.applyAlphaMode(noGuess, 'auto', log), true);
eq('fell back to straight', noGuess.mainSource.alphaMode, AlphaMode.STRAIGHT);

console.log('\n-- a source that cannot report alpha does not crash --');
eq('handled', sb.applyAlphaMode({ name: 'solid' }, 'auto', []), false);

console.log('\n-- modes read back in plain words --');
eq('ignore', sb.alphaModeName(AlphaMode.IGNORE), 'IGNORE (alpha thrown away)');
eq('straight', sb.alphaModeName(AlphaMode.STRAIGHT), 'STRAIGHT');
eq('premultiplied', sb.alphaModeName(AlphaMode.PREMULTIPLIED), 'PREMULTIPLIED');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
