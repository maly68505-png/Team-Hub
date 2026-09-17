/**
 * The setup that travels with the episode folder.
 *
 * The mistake this team made most was picking the wrong Video layer - the
 * cards build, they just show a background element instead of the guest. It
 * is not a mistake a warning can catch, because both choices are valid layers.
 * So the choices are written beside the quote list and read back on the next
 * machine, and nobody picks them a second time.
 *
 * Paths are deliberately not stored in that file: they differ on every
 * machine, the layers do not.
 */
var fs = require('fs');
var path = require('path');
var AE = path.join(__dirname, '..');

var core = fs.readFileSync(path.join(AE, 'lib', 'core.jsxinc'), 'utf8');
var block = core.slice(core.indexOf('    var SCRIPT_NAME'), core.indexOf('AE helpers'));

var sb = new Function(
  block + '\nreturn { setupToText: setupToText, parseSetupText: parseSetupText,' +
  ' sameTargetLabel: sameTargetLabel, SETUP_FILE: SETUP_FILE };'
)();

var pass = 0, fail = 0;
function eq(label, got, want) {
  var ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else {
    fail++;
    console.log('  FAIL ' + label + '\n         got  ' + JSON.stringify(got) +
                '\n         want ' + JSON.stringify(want));
  }
}

var REAL = [
  ['template', 'RENDER-LEFT'],
  ['video', 'RENDER-LEFT  >  REPLACE- FOOTAGE  >  1: 01_AKTBAS_EP27.mov'],
  ['alpha', 'RENDER-LEFT  >  REPLACE-ALPHA-FOOTAGE   (EMPTY comp - the clip gets added here)'],
  ['text', 'RENDER-LEFT  >  G - 2  >  REPLACE-PARAGRAPH  >  3: PARAGRAPH'],
  ['name', 'RENDER-LEFT  >  G - 2  >  REPLACE-PARAGRAPH  >  1: Name'],
  ['title', 'RENDER-LEFT  >  G - 2  >  REPLACE-PARAGRAPH  >  2: TITLE'],
  ['sort', 'on'],
  ['matte', 'off'],
  ['alphamode', 'premul-white']
];

console.log('\n-- written out and read back unchanged --');
var text = sb.setupToText(REAL);
var map = sb.parseSetupText(text);
for (var i = 0; i < REAL.length; i++) {
  eq(REAL[i][0] + ' survives the round trip', map[REAL[i][0]], REAL[i][1]);
}

console.log('\n-- the file reads like the guide says it does --');
eq('a comment names the file', text.indexOf('# ' + sb.SETUP_FILE), 0);
eq('one key per line, padded',
   text.indexOf('\ntemplate    RENDER-LEFT\n') > 0, true);
eq('the double-space arrows in a path are not split',
   map.video.indexOf('  >  ') > 0, true);
eq('a layer name with its own spaces survives',
   map.text.indexOf('G - 2') > 0, true);

console.log('\n-- no paths, ever: they belong to a machine, not an episode --');
// checked against the panel itself, not against a fixture - the fixture would
// keep passing after someone added a path to what gets written
var ui = fs.readFileSync(path.join(AE, 'lib', 'ui-quotecards.jsxinc'), 'utf8');
var body = ui.slice(ui.indexOf('function currentSetup()'),
                    ui.indexOf('function labelOf('));
eq('currentSetup() is where the setup file comes from', body.length > 0, true);
eq('it does not write the clips folder', body.indexOf('videosTxt') === -1, true);
eq('nor the quote list path', body.indexOf('quotesTxt') === -1, true);
eq('nor the alpha folder', body.indexOf('alphaTxt') === -1, true);
eq('and the paths it skips are the ones the machine settings keep',
   ui.indexOf('app.settings.saveSetting(QC_SETTINGS, "clips", videosTxt.text)') > 0, true);

console.log('\n-- a hand-edited file still reads --');
var hand = sb.parseSetupText(
  '# someone opened this in TextEdit\n' +
  '\n' +
  'template\tRENDER-RIGHT\n' +
  '   video      RENDER-RIGHT  >  1: guest   \n' +
  'TEXT        RENDER-RIGHT  >  2: quote\n' +
  'rubbish-with-no-value\n');
eq('a tab separates as well as spaces', hand.template, 'RENDER-RIGHT');
eq('leading and trailing space is trimmed', hand.video, 'RENDER-RIGHT  >  1: guest');
eq('the key is case-insensitive', hand.text, 'RENDER-RIGHT  >  2: quote');
eq('a line with no value is skipped', hand['rubbish-with-no-value'], undefined);
eq('blank lines and comments are skipped', hand['#'], undefined);

console.log('\n-- empty values are left out rather than stored blank --');
var sparse = sb.parseSetupText(sb.setupToText([
  ['template', 'A'], ['video', ''], ['name', null], ['title', 'A  >  1: t']]));
eq('the empty one is absent', sparse.video, undefined);
eq('the null one is absent', sparse.name, undefined);
eq('the real ones are there', [sparse.template, sparse.title], ['A', 'A  >  1: t']);

console.log('\n-- matching a stored label back to a layer --');
eq('identical labels match',
   sb.sameTargetLabel('RENDER  >  1: guest', 'RENDER  >  1: guest'), true);
eq('different layers do not',
   sb.sameTargetLabel('RENDER  >  1: guest', 'RENDER  >  2: bg'), false);
eq('odd spacing does not break it',
   sb.sameTargetLabel('RENDER  >  1: guest', 'RENDER > 1: guest'), true);
eq('case does not break it',
   sb.sameTargetLabel('RENDER  >  1: Guest', 'render  >  1: guest'), true);

console.log('\n-- the template re-worded between episodes, same layer --');
// a text layer's label carries a sample of what it currently says, and the
// template is re-worded every week - the layer is still the same layer
eq('the sample is ignored',
   sb.sameTargetLabel('R  >  3: PARAGRAPH   -   "last week\'s wording..."',
                      'R  >  3: PARAGRAPH   -   "this week says something else"'), true);
eq('with and without a sample still match',
   sb.sameTargetLabel('R  >  3: PARAGRAPH   -   "some words"', 'R  >  3: PARAGRAPH'), true);
eq('but a different layer with the same sample does not',
   sb.sameTargetLabel('R  >  3: PARAGRAPH   -   "same"', 'R  >  1: Name   -   "same"'), false);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
