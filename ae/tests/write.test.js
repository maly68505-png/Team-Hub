/**
 * With "Allow Scripts to Write Files" off, After Effects opens the file, drops
 * the write, and closes it - leaving an empty file that reads as success. The
 * user sent exactly such a zero-byte log.
 */
var fs = require('fs');
var path = require('path');
var AE = path.join(__dirname, '..');
var core = fs.readFileSync(path.join(AE, 'lib', 'core.jsxinc'), 'utf8');
var block = core.slice(core.indexOf('    function trim(s)'),
                       core.indexOf('    // ------------------------------------------------------------------- UI'));

function FakeFile(name, mode) {
  this.name = name; this.fsName = '/tmp/' + name;
  this._mode = mode || 'ok'; this.length = 0; this.encoding = '';
}
FakeFile.prototype.open = function () { return this._mode !== 'cannot-open'; };
FakeFile.prototype.write = function (t) { if (this._mode !== 'silent-drop') { this.length = t.length; } };
FakeFile.prototype.close = function () {};

var sb = new Function('VIDEO_EXT', 'MIN_MATCH_SCORE', 'TOL',
  block + '\nreturn { writeTextFile: writeTextFile };')("mp4,mov", 2, 0.0005);

var pass = 0, fail = 0;
function eq(l, g, w) {
  var ok = JSON.stringify(g) === JSON.stringify(w);
  if (ok) { pass++; console.log('  ok   ' + l); }
  else { fail++; console.log('  FAIL ' + l + '\n         got  ' + JSON.stringify(g) + '\n         want ' + JSON.stringify(w)); }
}

console.log('\n-- a normal write --');
var problems = [];
var good = new FakeFile('log.txt');
eq('returns the path', sb.writeTextFile(good, 'hello', problems), '/tmp/log.txt');
eq('no complaints', problems.length, 0);
eq('encoding set to UTF-8', good.encoding, 'UTF-8');

console.log('\n-- the permission is off: file created, nothing written --');
problems = [];
var silent = new FakeFile('log.txt', 'silent-drop');
eq('returns no path', sb.writeTextFile(silent, 'a lot of detail', problems), '');
eq('one problem reported', problems.length, 1);
eq('names the preference', /Allow Scripts to Write Files/.test(problems[0]), true);

console.log('\n-- the file cannot be opened at all --');
problems = [];
eq('returns no path', sb.writeTextFile(new FakeFile('x.txt', 'cannot-open'), 'data', problems), '');
eq('says so', /Could not create/.test(problems[0]), true);

console.log('\n-- an empty file for empty content is fine --');
problems = [];
eq('no false alarm', sb.writeTextFile(new FakeFile('e.txt', 'silent-drop'), '', problems), '/tmp/e.txt');
eq('nothing reported', problems.length, 0);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
