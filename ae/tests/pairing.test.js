/**
 * Which cut-out belongs to which clip.
 *
 * Handing the cut-outs out in folder order was the whole rule, and it held
 * only while both folders were named the same way. Send the clips through an
 * external keyer and they come back as 8f3a2b1c.webm in whatever order the
 * service finished them: one guest's cut-out lands on another guest's card,
 * and nothing on screen says so - you find out by looking at the face.
 */
var fs = require('fs');
var path = require('path');
var AE = path.join(__dirname, '..');

var core = fs.readFileSync(path.join(AE, 'lib', 'core.jsxinc'), 'utf8');
var block = core.slice(core.indexOf('    var SCRIPT_NAME'), core.indexOf('AE helpers'));

var sb = new Function(
  block + '\nreturn { pairAlphaClips: pairAlphaClips, stripAlphaMarker: stripAlphaMarker,' +
  ' trailingNumber: trailingNumber, sortFilesNaturally: sortFilesNaturally };'
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

function F(list) {
  var out = [];
  for (var i = 0; i < list.length; i++) { out.push({ name: list[i] }); }
  return out;
}
function paired(clips, alphas) {
  var p = sb.pairAlphaClips(F(clips), F(alphas)), out = [];
  for (var i = 0; i < p.length; i++) { out.push(p[i].file ? p[i].file.name : null); }
  return out;
}
function how(clips, alphas) {
  var p = sb.pairAlphaClips(F(clips), F(alphas)), out = [];
  for (var i = 0; i < p.length; i++) { out.push(p[i].how); }
  return out;
}

console.log('\n-- the marker on the end comes off --');
eq('_alpha', sb.stripAlphaMarker('Aktbas_001_alpha'), 'Aktbas_001');
eq('-matte', sb.stripAlphaMarker('guest-02-matte'), 'guest-02');
eq('.cutout', sb.stripAlphaMarker('shot.3.cutout'), 'shot.3');
eq('two of them stacked', sb.stripAlphaMarker('take_1_alpha_matte'), 'take_1');
eq('a name that merely ends in "key" is left whole', sb.stripAlphaMarker('mikey'), 'mikey');
eq('nothing to strip', sb.stripAlphaMarker('01_دلال'), '01_دلال');

console.log('\n-- the number at the end --');
eq('plain', sb.trailingNumber('Aktbas_002').n, 2);
eq('what came before it', sb.trailingNumber('Aktbas_002').prefix, 'Aktbas_');
eq('Arabic numerals count', sb.trailingNumber('لقطة_٧').n, 7);
eq('a number in the middle does not', sb.trailingNumber('01_دلال'), null);

console.log('\n-- matched by name, whatever the order in the folder --');
eq('the same name plus _alpha',
   paired(['01_دلال.mp4', '02_مشينش.mp4', '03_محارمة.mp4'],
          ['03_محارمة_alpha.mov', '01_دلال_alpha.mov', '02_مشينش_alpha.mov']),
   ['01_دلال_alpha.mov', '02_مشينش_alpha.mov', '03_محارمة_alpha.mov']);
eq('and it says so',
   how(['01_دلال.mp4', '02_مشينش.mp4'], ['02_مشينش_alpha.mov', '01_دلال_alpha.mov']),
   ['name', 'name']);

eq('a different extension changes nothing',
   paired(['guest1.mov'], ['guest1_alpha.webm']), ['guest1_alpha.webm']);

console.log('\n-- matched by the number that ends the name --');
eq('Aktbas_002 is Aktbas_2',
   paired(['Aktbas_001.mov', 'Aktbas_002.mov'],
          ['Aktbas_2_alpha.mov', 'Aktbas_1_alpha.mov']),
   ['Aktbas_1_alpha.mov', 'Aktbas_2_alpha.mov']);
eq('reported as a number match',
   how(['Aktbas_001.mov', 'Aktbas_002.mov'], ['Aktbas_2_alpha.mov', 'Aktbas_1_alpha.mov']),
   ['number', 'number']);

console.log('\n-- clip1 is not clip10 --');
var one = sb.pairAlphaClips(F(['clip1.mp4']), F(['clip10_alpha.mov']));
eq('the names are not taken as a match', one[0].how, 'order');
eq('so it is flagged as a guess, not a match', one[0].file.name, 'clip10_alpha.mov');
eq('with both present, each goes to its own',
   paired(['clip1.mp4', 'clip10.mp4'], ['clip10_alpha.mov', 'clip1_alpha.mov']),
   ['clip1_alpha.mov', 'clip10_alpha.mov']);

console.log('\n-- names that say nothing fall back on order, and admit it --');
eq('generated names keep the folder order',
   paired(['01_دلال.mp4', '02_مشينش.mp4'], ['8f3a2b1c.webm', 'd41d8cd9.webm']),
   ['8f3a2b1c.webm', 'd41d8cd9.webm']);
eq('every one of them is marked "order"',
   how(['01_دلال.mp4', '02_مشينش.mp4'], ['8f3a2b1c.webm', 'd41d8cd9.webm']),
   ['order', 'order']);

console.log('\n-- a mixture: the named ones are safe, the rest queue up --');
var mix = sb.pairAlphaClips(
  F(['01_دلال.mp4', '02_مشينش.mp4', '03_محارمة.mp4']),
  F(['8f3a2b1c.webm', '03_محارمة_alpha.mov', 'd41d8cd9.webm']));
eq('the named clip still gets its own cut-out', mix[2].file.name, '03_محارمة_alpha.mov');
eq('by name', mix[2].how, 'name');
eq('the unnamed two take what is left, in order',
   [mix[0].file.name, mix[1].file.name], ['8f3a2b1c.webm', 'd41d8cd9.webm']);
eq('and are marked as guesses', [mix[0].how, mix[1].how], ['order', 'order']);

console.log('\n-- nothing is used twice, nothing is invented --');
eq('fewer cut-outs than clips leaves the tail empty',
   paired(['a1.mp4', 'a2.mp4', 'a3.mp4'], ['a1_alpha.mov']),
   ['a1_alpha.mov', null, null]);
eq('no cut-outs at all', paired(['a1.mp4', 'a2.mp4'], []), [null, null]);
eq('spare cut-outs are simply unused',
   paired(['a2.mp4'], ['a1_alpha.mov', 'a2_alpha.mov']), ['a2_alpha.mov']);

var dupe = paired(['a1.mp4', 'a2.mp4'], ['a1_alpha.mov', 'a1_alpha.mov']);
eq('the same file cannot go to two clips', dupe[0] !== null && dupe[1] !== null, true);
eq('and the second clip got the other copy by order',
   how(['a1.mp4', 'a2.mp4'], ['a1_alpha.mov', 'a1_alpha.mov'])[1], 'order');

console.log('\n-- an ambiguous name is not a match --');
// "guest" is inside both cut-out names, so neither is chosen on name
var amb = sb.pairAlphaClips(F(['guest.mp4']), F(['guest_a_alpha.mov', 'guest_b_alpha.mov']));
eq('two candidates means no name match', amb[0].how, 'order');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
