/**
 * The template cuts its guest out with Roto Brush - "ADBE Samurai" in the
 * project file. Those strokes were painted on the template's own clip, so
 * they cannot follow a replacement and no script can repaint them. The tool
 * has to turn them off and switch the template to a ready-made cut-out.
 */
var fs = require('fs');
var path = require('path');
var AE = path.join(__dirname, '..');

var core = fs.readFileSync(path.join(AE, 'lib', 'core.jsxinc'), 'utf8');
var block = core.slice(core.indexOf('    function trim(s)'),
                       core.indexOf('    // ------------------------------------------------------------------- UI'));

// ------------------------------------------------------------- stubs
var NEXT = 1;
function Effect(name, matchName) { this.name = name; this.matchName = matchName; this.enabled = true; }
function Parade(list) { this._l = list; }
Object.defineProperty(Parade.prototype, 'numProperties', { get: function () { return this._l.length; } });
Parade.prototype.property = function (i) { return this._l[i - 1]; };

function AVLayer(name, source, effects) {
  this.name = name; this.source = source; this.enabled = true; this.index = 0;
  this._fx = new Parade(effects || []);
}
AVLayer.prototype.property = function (n) {
  if (n === "ADBE Effect Parade") { return this._fx; }
  throw new Error("no " + n);
};
function CompItem(name, layers) {
  this.id = NEXT++; this.name = name; this.layers = layers || [];
  this._renumber();
}
CompItem.prototype._renumber = function () {
  for (var i = 0; i < this.layers.length; i++) {
    this.layers[i].index = i + 1; this.layers[i]._comp = this;
  }
};
AVLayer.prototype.moveAfter = function (other) {
  var c = this._comp, from = c.layers.indexOf(this);
  c.layers.splice(from, 1);
  c.layers.splice(c.layers.indexOf(other) + 1, 0, this);
  c._renumber();
};
Object.defineProperty(CompItem.prototype, 'numLayers', { get: function () { return this.layers.length; } });
CompItem.prototype.layer = function (i) { return this.layers[i - 1]; };

var sb = new Function('VIDEO_EXT', 'MIN_MATCH_SCORE', 'TOL', 'CompItem', 'AVLayer',
  block + '\nreturn { rotoEffectName: rotoEffectName, enableLayersShowing: enableLayersShowing,'
        + ' moveMattesBehindBox: moveMattesBehindBox, layerShowing: layerShowing,'
        + ' compContains: compContains };'
)("mp4,mov", 2, 0.0005, CompItem, AVLayer);

var pass = 0, fail = 0;
function eq(l, g, w) {
  var ok = JSON.stringify(g) === JSON.stringify(w);
  if (ok) { pass++; console.log('  ok   ' + l); }
  else { fail++; console.log('  FAIL ' + l + '\n         got  ' + JSON.stringify(g) + '\n         want ' + JSON.stringify(w)); }
}

console.log('\n-- Roto Brush is recognised however it was renamed --');
var log = [];
var guest = new AVLayer('Opject MAtte on the guest', null, [
  new Effect('Motion Tile', 'ADBE Tile'),
  new Effect('Object Matte', 'ADBE Samurai')      // renamed Roto Brush, as in the real project
]);
eq('found by its renamed label', sb.rotoEffectName(guest), 'Object Matte');
eq('a layer with none reports none',
   sb.rotoEffectName(new AVLayer('plain', null, [new Effect('Tint', 'ADBE Tint')])), '');
eq('matched on matchName too',
   sb.rotoEffectName(new AVLayer('x', null, [new Effect('Whatever', 'ADBE Samurai')])), 'Whatever');
eq('and on the plain english name',
   sb.rotoEffectName(new AVLayer('x', null, [new Effect('Roto Brush & Refine Matte', 'ADBE Zzz')])),
   'Roto Brush & Refine Matte');
var offAlready = new AVLayer('x', null, [new Effect('Object Matte', 'ADBE Samurai')]);
offAlready._fx.property(1).enabled = false;
eq('an effect already off is not reported', sb.rotoEffectName(offAlready), '');

eq('a layer with no effects does not crash',
   sb.rotoEffectName({ name: 'null', property: function () { throw new Error('none'); } }), '');

console.log('\n-- the alpha route gets switched on --');
var alphaComp = new CompItem('REPLACE-ALPHA-FOOTAGE 01', []);
var inner = new CompItem('G - 2 01', [new AVLayer('alpha again', alphaComp)]);
var card = new CompItem('RENDER-LEFT 01', [
  new AVLayer('alpha slot', alphaComp),
  new AVLayer('guest', new CompItem('REPLACE- FOOTAGE 01', [])),
  new AVLayer('nested', inner)
]);
card.layer(1).enabled = false;      // the template ships them off
inner.layer(1).enabled = false;

log = [];
eq('both layers switched on', sb.enableLayersShowing(card, alphaComp, log), 2);
eq('top level on', card.layer(1).enabled, true);
eq('the nested one too', inner.layer(1).enabled, true);
eq('the guest layer is not touched', card.layer(2).enabled, true);
eq('reported', /switched on 2 layer\(s\)/.test(log[0]), true);

log = [];
eq('running again changes nothing', sb.enableLayersShowing(card, alphaComp, log), 0);
eq('and stays quiet', log.length, 0);

console.log('\n-- the stale matte goes behind the box, not off --');
// Switching the layer off was worse than the bleed it fixed: the template
// draws the guest twice, and this is the copy carrying his real colours,
// sitting above the red circle. Behind the box it can no longer bleed, and
// it keeps both of those.
log = [];
var swappedClip = new AVLayer('Aktbas_004.mov', null, []);
var footageComp = new CompItem('REPLACE- FOOTAGE 04', [swappedClip]);
var paraComp = new CompItem('REPLACE-PARAGRAPH 04', [new AVLayer('PARAGRAPH', null, [])]);
var boxComp = new CompItem('G - 2 04', [new AVLayer('REPLACE-PARAGRAPH', paraComp, [])]);

var matte = new AVLayer('Opject MAtte on the guest', footageComp, [
  new Effect('Motion Tile', 'ADBE Tile'),
  new Effect('Object Matte', 'ADBE Samurai')
]);
var boxLayer = new AVLayer('G - 2', boxComp, []);
var circle = new AVLayer('Big-circle', new CompItem('RED CIRCLE', []), []);
var mainClip = new AVLayer('MAIN CLIP', footageComp, []);
var cardComp = new CompItem('RENDER-LEFT 04', [matte, boxLayer, circle, mainClip]);

eq('the box layer is found through its nested comps',
   sb.layerShowing(cardComp, paraComp) === boxLayer, true);
eq('a comp that is not in there is not claimed',
   sb.compContains(footageComp, paraComp, 0), false);

eq('the matte starts in front of the box', matte.index < boxLayer.index, true);
eq('one layer moved', sb.moveMattesBehindBox(cardComp, boxLayer, footageComp, log), 1);
eq('now behind the box', matte.index > boxLayer.index, true);
eq('but still in front of the red circle', matte.index < circle.index, true);
eq('the layer is still switched on', matte.enabled, true);
eq('and its matte is untouched', matte._fx.property(2).enabled, true);
eq('said why', /can bleed over the box/.test(log[0]), true);

log = [];
eq('running it again moves nothing',
   sb.moveMattesBehindBox(cardComp, boxLayer, footageComp, log), 0);

console.log('\n-- a locked layer is unlocked, moved, and locked again --');
// After Effects refuses to move a locked layer and the refusal looks like
// nothing happened - which is what one card out of nine failing looks like.
log = [];
var lockedMatte = new AVLayer('Opject MAtte on the guest', footageComp, []);
lockedMatte.locked = true;
var lockedBox = new AVLayer('G - 2', boxComp, []);
var lockedCard = new CompItem('RENDER-LEFT 04', [lockedMatte, lockedBox]);
var baseMove = AVLayer.prototype.moveAfter;
AVLayer.prototype.moveAfter = function (other) {
  if (this.locked) { throw new Error('layer is locked'); }
  baseMove.call(this, other);
};
var probs = [];
eq('it still moves', sb.moveMattesBehindBox(lockedCard, lockedBox, footageComp, log, probs), 1);
eq('behind the box now', lockedMatte.index > lockedBox.index, true);
eq('its lock is put back', lockedMatte.locked, true);
eq('and the log says it was locked', /was LOCKED/.test(log[0]), true);
eq('no problem reported', probs.length, 0);

// a failure that is not the lock still reaches the caller verbatim
AVLayer.prototype.moveAfter = function () { throw new Error('some other refusal'); };
var probs2 = [], log2 = [];
var m2 = new AVLayer('Opject MAtte on the guest', footageComp, []);
var b2 = new AVLayer('G - 2', boxComp, []);
var c2 = new CompItem('RENDER-LEFT 07', [m2, b2]);
eq('nothing moved', sb.moveMattesBehindBox(c2, b2, footageComp, log2, probs2), 0);
eq('and the reason is handed back, not swallowed',
   probs2.length === 1 && /some other refusal/.test(probs2[0]), true);
AVLayer.prototype.moveAfter = baseMove;

console.log('\n-- a matte the effect scan cannot see still gets moved --');
// One card moved and another did not on the same run. Recognising the effect
// is not a dependable test; drawing the guest's footage in front of the box
// is, and that is the thing that can cover it.
log = [];
var hidden = new AVLayer('guest, effect unreadable', footageComp, []);
var box2 = new AVLayer('G - 2', boxComp, []);
var card2 = new CompItem('RENDER-LEFT 04', [hidden, box2, mainClip]);
eq('no effect is detected on it', sb.rotoEffectName(hidden), '');
eq('it moves anyway, because it shows the footage',
   sb.moveMattesBehindBox(card2, box2, footageComp, log), 1);
eq('and it is now behind the box', hidden.index > box2.index, true);

log = [];
var unrelated = new AVLayer('logo', new CompItem('LOGO', []), []);
var box3 = new AVLayer('G - 2', boxComp, []);
var card3 = new CompItem('RENDER-LEFT 05', [unrelated, box3]);
eq('a layer that draws neither is left where it is',
   sb.moveMattesBehindBox(card3, box3, footageComp, log), 0);
eq('still in front', unrelated.index < box3.index, true);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
