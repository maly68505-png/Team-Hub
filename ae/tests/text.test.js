/**
 * Two things went wrong with the quote text on the real cards:
 *   - it was written onto the speaker-name line instead of the quote body
 *   - at the template's type size a real quote overflowed its box
 */
var fs = require('fs');
var path = require('path');
var AE = path.join(__dirname, '..');

var core = fs.readFileSync(path.join(AE, 'lib', 'core.jsxinc'), 'utf8');
var block = core.slice(core.indexOf('    function trim(s)'),
                       core.indexOf('    // ------------------------------------------------------------------- UI'));

// ---------------------------------------------------------------- stubs
function TextDoc(text, fontSize, boxText, boxW, boxH) {
  this.text = text; this.fontSize = fontSize;
  this.boxText = boxText; this.boxTextSize = [boxW, boxH];
}
TextDoc.prototype.copy = function () {
  return new TextDoc(this.text, this.fontSize, this.boxText, this.boxTextSize[0], this.boxTextSize[1]);
};

function DocProp(doc) { this._doc = doc; this.numKeys = 0; }
Object.defineProperty(DocProp.prototype, 'value', { get: function () { return this._doc.copy(); } });
DocProp.prototype.setValue = function (d) { this._doc = d.copy(); };

function TextLayer(name, doc) {
  this.name = name; this.index = 1; this.inPoint = 0; this.outPoint = 10;
  this._prop = new DocProp(doc);
  var groups = { "ADBE Text Document": this._prop };
  this._groups = { "ADBE Text Properties": { property: function (n) { return groups[n]; } } };
}
TextLayer.prototype.property = function (n) { return this._groups[n]; };
// a crude but monotonic stand-in for AE's own text measurement
TextLayer.prototype.sourceRectAtTime = function () {
  var d = this._prop._doc;
  var perLine = Math.max(1, Math.floor(d.boxTextSize[0] / (d.fontSize * 0.55)));
  var lines = Math.ceil(d.text.length / perLine);
  return { width: d.boxTextSize[0], height: lines * d.fontSize * 1.25 };
};

var sb = new Function('VIDEO_EXT', 'MIN_MATCH_SCORE', 'TOL',
  block + '\nreturn { fitTextToBox: fitTextToBox, layerTextValue: layerTextValue };'
)("mp4,mov", 2, 0.0005);

var uiSrc = fs.readFileSync(path.join(AE, 'lib', 'ui-quotecards.jsxinc'), 'utf8');
var guessSrc = uiSrc.slice(uiSrc.indexOf('        function bestTextGuess('),
                           uiSrc.indexOf('        tplDrop.onChange'));
var bestTextGuess = new Function(guessSrc + '\nreturn bestTextGuess;')();

var pass = 0, fail = 0;
function eq(label, got, want) {
  var ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + '\n         got  ' + JSON.stringify(got) + '\n         want ' + JSON.stringify(want)); }
}

console.log('\n-- the quote body is chosen, not the name line --');
// the real card, in the order the layers appear
var cardLayers = [
  { sample: 'د. أحمد الغانم' },                                   // speaker name
  { sample: 'أستاذ الاجتماع السياسي' },                            // job title
  { sample: 'أول ضحايا الطائفية هم أبناء الطائفة نفسها' }          // the quote body
];
eq('picks the wordiest layer', bestTextGuess(cardLayers), 2);
eq('a single candidate is chosen', bestTextGuess([{ sample: 'x' }]), 0);
eq('all empty falls back to the first', bestTextGuess([{ sample: '' }, { sample: '' }]), 0);
eq('missing samples do not crash', bestTextGuess([{}, { sample: 'longer text here' }]), 1);

console.log('\n-- reading a layer\'s current words --');
eq('reads the text', sb.layerTextValue(new TextLayer('quote', new TextDoc('hello there', 40, true, 400, 200))), 'hello there');
eq('a non-text layer gives ""', sb.layerTextValue({ name: 'x' }), '');

console.log('\n-- the type shrinks until the quote fits --');
var log = [];
var longQuote = 'السلطة تُريد من خلال الانتخابات أن تجدد شرعيتها السياسية وأن تؤهل مؤسساتها لتولي ترتيبات اليوم التالي في قطاع غزة';
var boxed = new TextLayer('quote', new TextDoc(longQuote, 48, true, 400, 260));
eq('overflows before the fit', boxed.sourceRectAtTime().height > 260, true);
eq('fit reports a change', sb.fitTextToBox(boxed, log), true);
eq('and now it fits', boxed.sourceRectAtTime().height <= 260, true);
eq('the size came down', boxed._prop._doc.fontSize < 48, true);
eq('the words are untouched', boxed._prop._doc.text, longQuote);
eq('the log says what happened', /type shrunk 48\.0 ->/.test(log[0]), true);

console.log('\n-- text that already fits is left alone --');
log = [];
var short = new TextLayer('quote', new TextDoc('قصير', 48, true, 400, 260));
eq('no change reported', sb.fitTextToBox(short, log), false);
eq('size untouched', short._prop._doc.fontSize, 48);

console.log('\n-- point text cannot be fitted, and says so --');
log = [];
var point = new TextLayer('name', new TextDoc(longQuote, 48, false, 0, 0));
eq('returns false', sb.fitTextToBox(point, log), false);
eq('explains why', /point text, not a text box/.test(log[0]), true);
eq('size untouched', point._prop._doc.fontSize, 48);

console.log('\n-- animated type is left alone --');
log = [];
var animated = new TextLayer('quote', new TextDoc(longQuote, 48, true, 400, 260));
animated._prop.numKeys = 3;
eq('returns false', sb.fitTextToBox(animated, log), false);
eq('size untouched', animated._prop._doc.fontSize, 48);

console.log('\n-- it never shrinks past legibility --');
log = [];
var huge = new TextLayer('quote', new TextDoc(new Array(4000).join('x'), 48, true, 200, 60));
sb.fitTextToBox(huge, log);
eq('stops at 6pt or above', huge._prop._doc.fontSize >= 6, true);

// ------------------------------------------------- the name and title lines
//
// A card built from a template carries the template's guest - a real person,
// named on screen. When the quote list does not say who said this quote, that
// name used to be left exactly where it was, so a real person's name and job
// sat under a different person's face on a card that looked finished.
console.log('\n-- a line with nothing to put in it is cleared, not left --');

var ui = fs.readFileSync(path.join(AE, 'lib', 'ui-quotecards.jsxinc'), 'utf8');
var fnSrc = ui.slice(ui.indexOf('function writeSideText('),
                     ui.indexOf('// ------------------------------------------------- remembering the setup'));
eq('the shipped function was found', /^function writeSideText\(/.test(fnSrc), true);

// run the real function body against recording stubs
var calls, fitted;
var side = new Function('trim', 'setLayerText', 'fitTextToBox', 'cbFitText',
                        fnSrc + '\nreturn writeSideText;')(
  function (x) { return String(x).replace(/^\s+|\s+$/g, ''); },
  function (layer, str) { calls.push([layer.name, str]); return true; },
  function (layer) { fitted.push(layer.name); return true; },
  { value: true });

function Layer(name) { this.name = name; }
function mappingFor(layer) { return { 7: { layer: function () { return layer; } } }; }
var nameLayer = new Layer('Name');
var TARGET = { comp: { id: 7 }, index: 1 };

calls = []; fitted = []; log = [];
var n1 = side(TARGET, 'name', 'محمد مشينش', mappingFor(nameLayer), log);
eq('a real name is written', calls, [['Name', 'محمد مشينش']]);
eq('and fitted to its box', fitted, ['Name']);
eq('nothing was cleared', n1, 0);

calls = []; fitted = []; log = [];
var n2 = side(TARGET, 'name', '', mappingFor(nameLayer), log);
eq('an empty name CLEARS the layer', calls, [['Name', '']]);
eq('it is counted as cleared', n2, 1);
eq('and an empty line is not squeezed to fit', fitted, []);
eq('the log says the template name belonged to someone else',
   /belongs to somebody else/.test(log.join(' ')), true);

calls = []; log = [];
eq('whitespace counts as empty too',
   side(TARGET, 'name', '   ', mappingFor(nameLayer), log), 1);
eq('cleared, not written through', calls, [['Name', '']]);

calls = []; log = [];
eq('"leave the name alone" touches nothing',
   side(null, 'name', '', mappingFor(nameLayer), log), 0);
eq('no write at all', calls, []);

calls = []; log = [];
side(TARGET, 'title', '', mappingFor(new Layer('TITLE')), log);
eq('the job title is cleared on the same rule', calls, [['TITLE', '']]);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
