/**
 * The black-card bug: a placeholder trimmed out of a two-hour recording leaves
 * the layer reading more than an hour into its source. Swap the source and the
 * new clip is read past its own end, so the card renders black.
 */
var fs = require('fs');
var path = require('path');
var AE = path.join(__dirname, '..');

var core = fs.readFileSync(path.join(AE, 'lib', 'core.jsxinc'), 'utf8');
var block = core.slice(core.indexOf('    function trim(s)'),
                       core.indexOf('    // ------------------------------------------------------------------- UI'));

// ------------------------------------------------------ stubs
function Prop(value) { this.value = value; this.numKeys = 0; }
Prop.prototype.setValue = function (v) { this.value = v; };

function Group(props) { this._p = props; }
Group.prototype.property = function (name) { return this._p[name]; };

function Source(w, h, duration) { this.width = w; this.height = h; this.duration = duration; }

function Layer(source, opts) {
  opts = opts || {};
  this.source = source;
  this.startTime = opts.startTime || 0;
  this.inPoint = opts.inPoint || 0;
  this.outPoint = opts.outPoint !== undefined ? opts.outPoint : 10;
  this.timeRemapEnabled = !!opts.timeRemap;
  this.scale = new Prop([100, 100]);
  if (opts.scaleKeys) { this.scale.numKeys = opts.scaleKeys; }
  this._groups = { "ADBE Transform Group": new Group({ "ADBE Scale": this.scale }) };
}
Layer.prototype.property = function (n) { return this._groups[n]; };

function Comp(w, h, duration) { this.width = w; this.height = h; this.duration = duration; }

var sb = new Function('VIDEO_EXT', 'MIN_MATCH_SCORE', 'TOL',
  block + '\nreturn { resetClipTiming: resetClipTiming, fitToComp: fitToComp };'
)("mp4,mov", 2, 0.0005);

var pass = 0, fail = 0;
function eq(label, got, want) {
  var ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + '\n         got  ' + JSON.stringify(got) + '\n         want ' + JSON.stringify(want)); }
}

console.log('\n-- the black card --');
// placeholder trimmed 80 minutes into a 2h22m recording; new clip is 10 min
var log = [];
var comp = new Comp(3840, 2160, 101.12);
var layer = new Layer(new Source(1920, 1080, 600), { startTime: -4800, inPoint: 0, outPoint: 18 });
eq('reset reports success', sb.resetClipTiming(layer, comp, log), true);
eq('startTime pulled back to 0', layer.startTime, 0);
eq('inPoint at 0', layer.inPoint, 0);
eq('outPoint clamped to the comp, not the clip', layer.outPoint, 101.12);
eq('log names the old offset', /startTime -4800\.00s -> 0/.test(log[0]), true);

console.log('\n-- a clip shorter than the comp --');
log = [];
var shortLayer = new Layer(new Source(1920, 1080, 42), { startTime: -3600 });
sb.resetClipTiming(shortLayer, new Comp(1920, 1080, 300), log);
eq('outPoint clamped to the clip', shortLayer.outPoint, 42);

console.log('\n-- time remapping is left alone --');
log = [];
var remapped = new Layer(new Source(1920, 1080, 600), { startTime: -4800, timeRemap: true });
eq('returns false', sb.resetClipTiming(remapped, comp, log), false);
eq('startTime untouched', remapped.startTime, -4800);
eq('and says why', /time remapping is on/.test(log[0]), true);

console.log('\n-- fitting the frame --');
log = [];
var hd = new Layer(new Source(1920, 1080, 600));
eq('1080p into 4K fits', sb.fitToComp(hd, new Comp(3840, 2160, 60), log), true);
eq('scaled to 200%', hd.scale.value, [200, 200]);

log = [];
var vertical = new Layer(new Source(1920, 1080, 600));
sb.fitToComp(vertical, new Comp(1080, 1920, 60), log);
eq('covers a vertical frame (no letterbox)',
   Math.round(vertical.scale.value[0] * 10) / 10, 177.8);

log = [];
var exact = new Layer(new Source(1920, 1080, 600));
eq('same size needs no change', sb.fitToComp(exact, new Comp(1920, 1080, 60), log), false);
eq('scale untouched', exact.scale.value, [100, 100]);

log = [];
var animated = new Layer(new Source(1920, 1080, 600), { scaleKeys: 4 });
eq('keyframed scale is respected', sb.fitToComp(animated, new Comp(3840, 2160, 60), log), false);
eq('and says why', /scale is keyframed/.test(log[0]), true);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
