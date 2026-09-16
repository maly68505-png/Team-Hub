/**
 * The setup file is how a second editor, on a different machine, inherits the
 * template's layer choices instead of guessing them. It travels with the
 * episode folder, so it has to survive a round trip through a text file - and
 * it must never carry a path, because paths are the one thing that differs
 * between machines.
 */
var fs = require('fs');
var path = require('path');
var AE = path.join(__dirname, '..');

var ui = fs.readFileSync(path.join(AE, 'lib', 'ui-quotecards.jsxinc'), 'utf8');
var core = fs.readFileSync(path.join(AE, 'lib', 'core.jsxinc'), 'utf8');
var trimSrc = core.slice(core.indexOf('    function trim(s)'), core.indexOf('    function normalize('));
var block = ui.slice(ui.indexOf('        function setupToText('), ui.indexOf('        function applySetup('));

var sb = new Function(trimSrc + block +
  '\nreturn { setupToText: setupToText, textToSetup: textToSetup, selectByLabel: selectByLabel };')();

var pass = 0, fail = 0;
function eq(l, g, w) {
  var ok = JSON.stringify(g) === JSON.stringify(w);
  if (ok) { pass++; console.log('  ok   ' + l); }
  else { fail++; console.log('  FAIL ' + l + '\n         got  ' + JSON.stringify(g) + '\n         want ' + JSON.stringify(w)); }
}

console.log('\n-- the setup survives the trip to another machine --');
var setup = {
  template: 'RENDER-LEFT',
  video: 'RENDER-LEFT  >  REPLACE- FOOTAGE  >  1: 01_AKTBAS_EP27.mov',
  alpha: 'RENDER-LEFT  >  REPLACE-ALPHA-FOOTAGE   (EMPTY comp - the clip gets added here)',
  text: 'RENDER-LEFT  >  G - 2  >  REPLACE-PARAGRAPH  >  3: PARAGRAPH   -   "أول..."',
  name: 'RENDER-LEFT  >  G - 2  >  REPLACE-PARAGRAPH  >  1: Name',
  title: 'RENDER-LEFT  >  G - 2  >  REPLACE-PARAGRAPH  >  2: TITLE',
  sort: '1', matte: '0', reset: '1', fit: '1', alphaPath: '1', fitText: '1',
  folder: '1', alphaMode: '2'
};
var back = sb.textToSetup(sb.setupToText(setup));
eq('every field comes back unchanged', back, setup);

var labelWithSpaces = 'RENDER-LEFT  >  REPLACE- FOOTAGE  >  1: 01_AKTBAS_EP27.mov';
eq('the run of spaces inside a label is not trimmed away', back.video, labelWithSpaces);
eq('a quoted sample in a label survives',
   back.text.indexOf('"أول..."') > 0, true);

console.log('\n-- it carries choices, never paths --');
var text = sb.setupToText(setup);
eq('no drive or home path leaks in', /\/Users\/|[A-Z]:\\\\/.test(text), false);
eq('the comment says what it is for', /keep this next to the quote list/.test(text), true);

console.log('\n-- a hand-edited file does not break it --');
eq('comments and blank lines are skipped',
   sb.textToSetup('# a note\n\nvideo\tsome label\n'), { video: 'some label' });
eq('a line with no tab is ignored', sb.textToSetup('rubbish\nvideo\tx'), { video: 'x' });
eq('an empty file gives an empty setup', sb.textToSetup(''), {});

console.log('\n-- a layer is matched by its full path label --');
var targets = [{ label: 'a' }, { label: labelWithSpaces }, { label: 'c' }];
var drop = { selection: null };
eq('found at its index, with the dropdown offset applied',
   [sb.selectByLabel(drop, targets, labelWithSpaces, 1), drop.selection], [true, 2]);
drop.selection = 99;
eq('a label that is not there leaves the choice alone',
   [sb.selectByLabel(drop, targets, 'gone', 1), drop.selection], [false, 99]);
eq('an empty label changes nothing', sb.selectByLabel(drop, targets, '', 1), false);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
