var fs = require('fs');
var path = require('path');
var AE = path.join(__dirname, '..');
var src = fs.readFileSync(path.join(AE, 'lib', 'core.jsxinc'), 'utf8');

// slice out the pure-logic block (utils -> end of parseScript / matchScore)
var start = src.indexOf('    function trim(s)');
var end   = src.indexOf('    // ------------------------------------------------------------ AE helpers');
var block = src.slice(start, end);

var VIDEO_EXT = "mp4,mov,m4v,avi,mkv,mxf,webm,mpg,mpeg,wmv,mts,m2ts,r3d,braw,dv,3gp";
var MIN_MATCH_SCORE = 2;
var TOL = 0.0005;
function Folder(){}
var sandbox = new Function('VIDEO_EXT','MIN_MATCH_SCORE','TOL','Folder',
  block + '\nreturn {tcToSeconds:tcToSeconds, parseRangeLine:parseRangeLine, parsePersonText:parsePersonText, parseScript:parseScript, matchScore:matchScore, pickFile:pickFile, secondsToTC:secondsToTC, normalize:normalize};'
)(VIDEO_EXT, MIN_MATCH_SCORE, TOL, Folder);

var pass = 0, fail = 0;
function eq(label, got, want) {
  var ok = (typeof want === 'number') ? Math.abs(got - want) < 1e-6 : JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + '\n         got  ' + JSON.stringify(got) + '\n         want ' + JSON.stringify(want)); }
}

console.log('\n-- timecode parsing (25 fps) --');
eq('frames  00:00:12:00', sandbox.tcToSeconds('00:00:12:00', 25), 12);
eq('frames  00:00:12:15', sandbox.tcToSeconds('00:00:12:15', 25), 12.6);
eq('ms      00:00:12,500', sandbox.tcToSeconds('00:00:12,500', 25), 12.5);
eq('ms      00:00:12.250', sandbox.tcToSeconds('00:00:12.250', 25), 12.25);
eq('drop    00:00:12;10', sandbox.tcToSeconds('00:00:12;10', 25), 12.4);
eq('no frac 00:01:05', sandbox.tcToSeconds('00:01:05', 25), 65);
eq('bare    12.5', sandbox.tcToSeconds('12.5', 25), 12.5);
eq('garbage', sandbox.tcToSeconds('hello', 25), null);

console.log('\n-- range lines --');
var r;
r = sandbox.parseRangeLine('00:00:12:00 --> 00:00:18:00', 25);
eq('srt arrow in',  r.inSec, 12); eq('srt arrow out', r.outSec, 18);
r = sandbox.parseRangeLine('00:00:12,000 --> 00:00:18,500  PERSON_B', 25);
eq('one-line trailing', r.trailing, 'PERSON_B');
eq('one-line out', r.outSec, 18.5);
r = sandbox.parseRangeLine('00:00:01:00 - 00:00:04:00 PERSON_A', 25);
eq('dash form in', r.inSec, 1);
eq('dash form trailing', r.trailing, 'PERSON_A');
eq('not a range', sandbox.parseRangeLine('PERSON_B', 25), null);

console.log('\n-- person / file extraction --');
eq('[PERSON_B]',            sandbox.parsePersonText('[PERSON_B]').person, 'PERSON_B');
eq('PERSON_B: dialogue',    sandbox.parsePersonText('PERSON_B: hello there').person, 'PERSON_B');
eq('bare name',             sandbox.parsePersonText('PERSON_B').person, 'PERSON_B');
eq('explicit file person',  sandbox.parsePersonText('PERSON_B | take3.mp4').person, 'PERSON_B');
eq('explicit file path',    sandbox.parsePersonText('PERSON_B | take3.mp4').file, 'take3.mp4');
eq('arrow file',            sandbox.parsePersonText('Sarah -> sarah_final.mov').file, 'sarah_final.mov');
eq('empty',                 sandbox.parsePersonText('   '), null);

console.log('\n-- file matching --');
function F(name) { return { name: name, fsName: '/videos/' + name }; }
var files = [F('PERSON_A_take1.mp4'), F('PERSON_B_take3.mp4'), F('PERSON_B_take4.mp4'), F('sarah_studio.mov'), F('random.mp4')];
eq('exact-ish PERSON_B', sandbox.pickFile('PERSON_B', '', files).name, 'PERSON_B_take3.mp4');
eq('PERSON_A',           sandbox.pickFile('PERSON_A', '', files).name, 'PERSON_A_take1.mp4');
eq('case insensitive',   sandbox.pickFile('sarah', '', files).name, 'sarah_studio.mov');
eq('explicit wins',      sandbox.pickFile('PERSON_B', 'PERSON_B_take4.mp4', files).name, 'PERSON_B_take4.mp4');
eq('no match -> null',   sandbox.pickFile('Zoltan', '', files), null);

console.log('\n-- full script parse --');
var srt = [
 '# comment line, ignored','',
 '1','00:00:00:00 --> 00:00:05:00','[PERSON_A]','',
 '2','00:00:05:00 --> 00:00:12:12','PERSON_B: and then I said something','',
 '3','00:00:12:12 --> 00:00:20:00','PERSON_A | PERSON_A_take1.mp4','',
 '00:00:20:00 --> 00:00:25:00  sarah',''
].join('\n');
var stub = { _open:false, open: function(){ this._open=true; return true; }, read: function(){ return srt; }, close: function(){} };
var warn = [];
var segs = sandbox.parseScript(stub, 25, warn);
eq('segment count', segs.length, 4);
eq('seg1 person', segs[0].person, 'PERSON_A');
eq('seg2 person', segs[1].person, 'PERSON_B');
eq('seg2 out',    segs[1].outSec, 12 + 12/25);
eq('seg3 explicit file', segs[2].explicitFile, 'PERSON_A_take1.mp4');
eq('seg4 one-line person', segs[3].person, 'sarah');
eq('seg4 in', segs[3].inSec, 20);
eq('no warnings', warn.length, 0);

console.log('\n-- bad input is reported, not crashed --');
var bad = '1\n00:00:10:00 --> 00:00:05:00\nPERSON_A\n\n2\n00:00:30:00 --> 00:00:35:00\n\n';
var stub2 = { open: function(){return true;}, read: function(){ return bad; }, close: function(){} };
var warn2 = [];
var segs2 = sandbox.parseScript(stub2, 25, warn2);
eq('both bad blocks dropped', segs2.length, 0);
eq('two warnings raised', warn2.length, 2);

console.log('\n-- timecode formatting round-trip --');
eq('fmt 12.6s @25', sandbox.secondsToTC(12.6, 25), '00:00:12:15');
eq('fmt 3661s @24', sandbox.secondsToTC(3661, 24), '01:01:01:00');


console.log('\n-- build outputs carry the shared core verbatim --');
var coreRaw = fs.readFileSync(path.join(AE, 'lib', 'core.jsxinc'), 'utf8').replace(/\s+$/, '');
['PersonReplacer.jsx', 'PersonReplacer_Auto.jsx'].forEach(function (name) {
  var built = fs.readFileSync(path.join(AE, name), 'utf8');
  eq('core embedded in ' + name, built.indexOf(coreRaw) !== -1, true);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
