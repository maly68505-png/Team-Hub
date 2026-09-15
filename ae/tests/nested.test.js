/**
 * Exercises nested-comp handling against a miniature After Effects object
 * model shaped like the real IQTEBAS template: a render comp that pulls the
 * guest from a REPLACE-FOOTAGE precomp and the quote from REPLACE-PARAGRAPH.
 *
 * The assertion that matters: each card must get its OWN copy of those
 * precomps, or editing one card silently rewrites the others.
 */
var fs = require('fs');
var path = require('path');
var AE = path.join(__dirname, '..');

var core = fs.readFileSync(path.join(AE, 'lib', 'core.jsxinc'), 'utf8');
var block = core.slice(core.indexOf('    function trim(s)'), core.indexOf('    // ------------------------------------------------------------------- UI'));

// ------------------------------------------------- miniature AE object model
var NEXT_ID = 1;

function FileSource(name) { this.file = { name: name }; }
function FootageItem(name) { this.id = NEXT_ID++; this.name = name; this.mainSource = new FileSource(name); this.width = 1920; this.height = 1080; }

function AVLayer(name, source) {
  this.name = name; this.source = source; this.index = 0;
  this.enabled = true; this.hasVideo = true;
  this.nullLayer = false; this.adjustmentLayer = false; this.guideLayer = false;
}
AVLayer.prototype.replaceSource = function (s) { this.source = s; };
AVLayer.prototype.clone = function () { return new AVLayer(this.name, this.source); };

function TextLayer(name, text) { this.name = name; this.index = 0; this._text = text || ''; }
TextLayer.prototype.clone = function () { return new TextLayer(this.name, this._text); };

function CompItem(name, layers) {
  this.id = NEXT_ID++; this.name = name;
  this.layers = layers || [];
  for (var i = 0; i < this.layers.length; i++) { this.layers[i].index = i + 1; }
}
Object.defineProperty(CompItem.prototype, 'numLayers', { get: function () { return this.layers.length; } });
CompItem.prototype.layer = function (i) { return this.layers[i - 1]; };
CompItem.prototype.duplicate = function () {
  var copies = [];
  for (var i = 0; i < this.layers.length; i++) { copies.push(this.layers[i].clone()); }
  return new CompItem(this.name + ' 2', copies);
};

var sb = new Function('VIDEO_EXT','MIN_MATCH_SCORE','TOL','AVLayer','TextLayer','CompItem','FootageItem','FileSource',
  block + '\nreturn { collectTargets: collectTargets, compsLeadingTo: compsLeadingTo,' +
  ' deepDuplicate: deepDuplicate, mappedClones: mappedClones, isSwappableLayer: isSwappableLayer };'
)("mp4,mov,m4v,avi,mkv,mxf,webm,mpg,mpeg,wmv,mts,m2ts,r3d,braw,dv,3gp", 2, 0.0005,
  AVLayer, TextLayer, CompItem, FootageItem, FileSource);

// bestGuess lives in the panel, but it is what auto-picks the right layer
var uiSrc = fs.readFileSync(path.join(AE, 'lib', 'ui-quotecards.jsxinc'), 'utf8');
var guessSrc = uiSrc.slice(uiSrc.indexOf('        function guessIndex('), uiSrc.indexOf('        tplDrop.onChange'));
var normSrc = core.slice(core.indexOf('    function normalize('), core.indexOf('    function pad('));
var guessed = new Function(normSrc + guessSrc + '\nreturn { bestGuess: bestGuess, guessIndex: guessIndex };')();
var bestGuess = guessed.bestGuess;
var guessIndex = guessed.guessIndex;

var pass = 0, fail = 0;
function eq(label, got, want) {
  var ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + '\n         got  ' + JSON.stringify(got) + '\n         want ' + JSON.stringify(want)); }
}

// ------------------------------------------------------- the template shape
function buildProject() {
  var guest = new AVLayer('guest', new FootageItem('SAMPLE-OTHMAN.mov'));
  var replaceFootage = new CompItem('REPLACE-FOOTAGE', [guest]);

  var quote = new TextLayer('quote', 'original template text');
  var replacePara = new CompItem('REPLACE-PARAGRAPH', [quote]);

  var glow = new AVLayer('glow', new FootageItem('shutterstock_3611565563.mov'));
  var elements = new CompItem('ELEMENTS', [glow]);

  var render = new CompItem('RENDER-LEFT', [
    new AVLayer('bg', new FootageItem('screen grid-01.mov')),
    new AVLayer('FOOTAGE slot', replaceFootage),
    new AVLayer('PARAGRAPH slot', replacePara),
    new AVLayer('shared elements', elements)
  ]);
  return { render: render, replaceFootage: replaceFootage, replacePara: replacePara, elements: elements };
}

var P = buildProject();

console.log('\n-- layers are found inside nested comps --');
var vids = sb.collectTargets(P.render, false);
eq('3 footage layers across the tree', vids.length, 3);
eq('guest found inside REPLACE-FOOTAGE',
   vids[1].label, 'RENDER-LEFT  >  REPLACE-FOOTAGE  >  1: guest');
eq('guest belongs to the precomp, not the render comp',
   vids[1].comp.name, 'REPLACE-FOOTAGE');
eq('top-level layer keeps a bare label', vids[0].label, '1: bg');

var texts = sb.collectTargets(P.render, true);
eq('1 text layer, inside REPLACE-PARAGRAPH', texts.length, 1);
eq('its comp', texts[0].comp.name, 'REPLACE-PARAGRAPH');

console.log('\n-- the right layer is pre-selected --');
eq('guest auto-picked over bg and glow',
   bestGuess(vids, 'footage,video,guest,person,clip'), 1);
eq('quote auto-picked', bestGuess(texts, 'paragraph,quote,text,body'), 0);

console.log('\n-- "found nothing" is not the same as "found the first one" --');
// this is what left the cut-out slot silently unfilled
eq('a real match reports its index', guessIndex(vids, 'footage'), 1);
eq('a match on the FIRST entry still reports 0', guessIndex(vids, 'bg'), 0);
eq('no match reports -1, not 0', guessIndex(vids, 'nothinglikethis'), -1);
eq('bestGuess still falls back to 0', bestGuess(vids, 'nothinglikethis'), 0);
eq('alpha hint finds nothing in this template', guessIndex(vids, 'alpha,matte,luma'), -1);

var withAlpha = [
  { label: 'RENDER > REPLACE-ALPHA-FOOTAGE > 1: guest alpha' },
  { label: 'RENDER > REPLACE-FOOTAGE > 1: guest' }
];
eq('an alpha slot at index 0 is detected', guessIndex(withAlpha, 'alpha,matte,luma'), 0);

console.log('\n-- only comps on the path get copied --');
var targetIds = {};
targetIds[P.replaceFootage.id] = true;
targetIds[P.replacePara.id] = true;
var cloneIds = sb.compsLeadingTo(P.render, targetIds);
eq('render comp is on the path', cloneIds[P.render.id], true);
eq('REPLACE-FOOTAGE is on the path', cloneIds[P.replaceFootage.id], true);
eq('REPLACE-PARAGRAPH is on the path', cloneIds[P.replacePara.id], true);
eq('ELEMENTS is left shared', cloneIds[P.elements.id], false);

console.log('\n-- each card gets its own precomps --');
var m1 = {}, card1 = sb.deepDuplicate(P.render, cloneIds, m1, '01');
var m2 = {}, card2 = sb.deepDuplicate(P.render, cloneIds, m2, '02');

eq('card 1 named from the suffix', card1.name, 'RENDER-LEFT 01');
eq('nested copy named too', m1[P.replaceFootage.id].name, 'REPLACE-FOOTAGE 01');
eq('3 comps copied per card', sb.mappedClones(m1).length, 3);

eq('card 1 points at its own REPLACE-FOOTAGE',
   card1.layer(2).source === m1[P.replaceFootage.id], true);
eq('card 2 points at a DIFFERENT one',
   card2.layer(2).source === m2[P.replaceFootage.id], true);
eq('the two cards do not share it',
   m1[P.replaceFootage.id] === m2[P.replaceFootage.id], false);
eq('neither touches the template',
   m1[P.replaceFootage.id] === P.replaceFootage, false);
eq('off-path comp stays shared with the template',
   card1.layer(4).source === P.elements, true);

console.log('\n-- editing one card leaves the others alone --');
var clipA = new FootageItem('Aktbas_001.mov');
var clipB = new FootageItem('Aktbas_002.mov');
m1[P.replaceFootage.id].layer(1).replaceSource(clipA);
m2[P.replaceFootage.id].layer(1).replaceSource(clipB);
eq('card 1 has clip 1', m1[P.replaceFootage.id].layer(1).source.name, 'Aktbas_001.mov');
eq('card 2 has clip 2', m2[P.replaceFootage.id].layer(1).source.name, 'Aktbas_002.mov');
eq('template untouched', P.replaceFootage.layer(1).source.name, 'SAMPLE-OTHMAN.mov');

m1[P.replacePara.id].layer(1)._text = 'quote one';
m2[P.replacePara.id].layer(1)._text = 'quote two';
eq('card 1 text', m1[P.replacePara.id].layer(1)._text, 'quote one');
eq('card 2 text', m2[P.replacePara.id].layer(1)._text, 'quote two');
eq('template text untouched', P.replacePara.layer(1)._text, 'original template text');

console.log('\n-- a flat template still works --');
var flat = new CompItem('flat', [new AVLayer('person', new FootageItem('a.mov'))]);
var flatIds = {}; flatIds[flat.id] = true;
var fm = {}, fc = sb.deepDuplicate(flat, sb.compsLeadingTo(flat, flatIds), fm, '01');
eq('one comp copied', sb.mappedClones(fm).length, 1);
eq('and it is the card', fm[flat.id] === fc, true);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
