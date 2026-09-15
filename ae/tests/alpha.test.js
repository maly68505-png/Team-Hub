/**
 * After Effects can import a clip that carries an alpha channel with the alpha
 * set to Ignore, depending on the user's import preference. The clip then
 * renders as an opaque rectangle - or, with the template's own matte applied
 * on top, as nothing at all.
 */
var fs = require('fs');
var path = require('path');
var AE = path.join(__dirname, '..');

var core = fs.readFileSync(path.join(AE, 'lib', 'core.jsxinc'), 'utf8');
var block = core.slice(core.indexOf('    function trim(s)'),
                       core.indexOf('    // ------------------------------------------------------------------- UI'));

var AlphaMode = { IGNORE: 'ignore', STRAIGHT: 'straight', PREMULTIPLIED: 'premul' };

function Source(hasAlpha, mode) { this.hasAlpha = hasAlpha; this.alphaMode = mode; this.invertAlpha = false; }
function Item(name, src) { this.name = name; this.mainSource = src; }

var sb = new Function('VIDEO_EXT', 'MIN_MATCH_SCORE', 'TOL', 'AlphaMode',
  block + '\nreturn { honourAlpha: honourAlpha, alphaModeName: alphaModeName };'
)("mp4,mov", 2, 0.0005, AlphaMode);

var pass = 0, fail = 0;
function eq(label, got, want) {
  var ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + '\n         got  ' + JSON.stringify(got) + '\n         want ' + JSON.stringify(want)); }
}

console.log('\n-- an alpha clip imported as Ignore is corrected --');
var log = [];
var ignored = new Item('Aktbas_001.mov', new Source(true, AlphaMode.IGNORE));
eq('reports a change', sb.honourAlpha(ignored, log), true);
eq('alpha now counts', ignored.mainSource.alphaMode, AlphaMode.STRAIGHT);
eq('and says so', /set to IGNORE on import - switched to STRAIGHT/.test(log[0]), true);

console.log('\n-- an already correct clip is left alone --');
log = [];
var straight = new Item('a.mov', new Source(true, AlphaMode.STRAIGHT));
eq('no change', sb.honourAlpha(straight, log), false);
eq('mode untouched', straight.mainSource.alphaMode, AlphaMode.STRAIGHT);
eq('nothing logged', log.length, 0);

log = [];
var premul = new Item('b.mov', new Source(true, AlphaMode.PREMULTIPLIED));
eq('premultiplied is respected', sb.honourAlpha(premul, log), false);
eq('mode untouched', premul.mainSource.alphaMode, AlphaMode.PREMULTIPLIED);

console.log('\n-- a clip with no alpha is never touched --');
log = [];
var opaque = new Item('c.mov', new Source(false, AlphaMode.IGNORE));
eq('no change', sb.honourAlpha(opaque, log), false);
eq('mode untouched', opaque.mainSource.alphaMode, AlphaMode.IGNORE);

console.log('\n-- a source that cannot report alpha does not crash --');
eq('handled', sb.honourAlpha({ name: 'solid' }, []), false);

console.log('\n-- modes read back in plain words --');
eq('ignore', sb.alphaModeName(AlphaMode.IGNORE), 'IGNORE (alpha thrown away)');
eq('straight', sb.alphaModeName(AlphaMode.STRAIGHT), 'STRAIGHT');
eq('premultiplied', sb.alphaModeName(AlphaMode.PREMULTIPLIED), 'PREMULTIPLIED');
eq('anything else', sb.alphaModeName('nonsense'), 'unknown');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
