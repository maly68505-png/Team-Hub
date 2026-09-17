/**
 * Covers the quote-card inputs: natural clip ordering and reading the quote
 * list out of a .csv, a .srt or a plain .txt.
 */
var fs = require('fs');
var path = require('path');
var AE = path.join(__dirname, '..');
var ROOT = path.join(AE, '..');

var core = fs.readFileSync(path.join(AE, 'lib', 'core.jsxinc'), 'utf8');
// from the constants, not from trim(): the CSV reader needs the heading
// names, and a test that declares its own copy would stop testing the real one
var a = core.indexOf('    var SCRIPT_NAME');
var b = core.indexOf('AE helpers');
var block = core.slice(a, b);

function FileStub(name, content) { this.name = name; this._c = content; }
FileStub.prototype.open = function () { return true; };
FileStub.prototype.read = function () { return this._c; };
FileStub.prototype.close = function () {};

var sb = new Function('VIDEO_EXT', 'MIN_MATCH_SCORE', 'TOL',
  block + '\nreturn { naturalCompare: naturalCompare, sortFilesNaturally: sortFilesNaturally,' +
  ' parseCSVText: parseCSVText, pickTextColumn: pickTextColumn, parseQuotesFile: parseQuotesFile };'
)("mp4,mov,m4v,avi,mkv,mxf,webm,mpg,mpeg,wmv,mts,m2ts,r3d,braw,dv,3gp", 2, 0.0005);

var pass = 0, fail = 0;
function eq(label, got, want) {
  var ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + '\n         got  ' + JSON.stringify(got) + '\n         want ' + JSON.stringify(want)); }
}

console.log('\n-- clip order is what a person expects --');
function names(list) { return list.map(function (f) { return f.name; }); }
eq('clip2 before clip10', names(sb.sortFilesNaturally(
  [{name:'clip10.mp4'},{name:'clip2.mp4'},{name:'clip1.mp4'}])),
  ['clip1.mp4', 'clip2.mp4', 'clip10.mp4']);
eq('zero padded still fine', names(sb.sortFilesNaturally(
  [{name:'A_03.mov'},{name:'A_01.mov'},{name:'A_20.mov'}])),
  ['A_01.mov', 'A_03.mov', 'A_20.mov']);
eq('case insensitive', names(sb.sortFilesNaturally(
  [{name:'beta.mp4'},{name:'Alpha.mp4'}])), ['Alpha.mp4', 'beta.mp4']);

console.log('\n-- CSV reading --');
var csv = '#,when,speaker,quote\n1,11:06,,"He said, plainly, that it matters"\n2,29:35,,Second quote here which is longer\n';
var rows = sb.parseCSVText(csv);
eq('row count (header + 2)', rows.length, 3);
eq('quoted comma survives', rows[1][3], 'He said, plainly, that it matters');
eq('wordiest column found', sb.pickTextColumn(rows), 3);

var q = sb.parseQuotesFile(new FileStub('q.csv', csv), []);
eq('csv -> 2 quotes', q.length, 2);
eq('csv header dropped', q[0].text, 'He said, plainly, that it matters');
eq('csv numbering', q[1].index, 2);

console.log('\n-- CSV with no header row --');
var noHead = 'This is already a real quote and quite long indeed\nAnother genuine quote of similar length here\n';
eq('headerless csv keeps row 1',
   sb.parseQuotesFile(new FileStub('q.csv', noHead), []).length, 2);

console.log('\n-- plain text --');
eq('paragraphs', sb.parseQuotesFile(new FileStub('q.txt', 'One quote.\n\nTwo quote.\n\nThree.'), []).length, 3);
eq('lines when no blanks', sb.parseQuotesFile(new FileStub('q.txt', 'One\nTwo\nThree'), []).length, 3);
eq('# lines ignored', sb.parseQuotesFile(new FileStub('q.txt', '# note\n\nReal quote'), []).length, 1);

console.log('\n-- the real generated files --');
var realCsv = fs.readFileSync(path.join(ROOT, 'examples/episode-elections/quotes.csv'), 'utf8');
var rq = sb.parseQuotesFile(new FileStub('quotes.csv', realCsv), []);
eq('quotes.csv -> 9 quotes', rq.length, 9);
eq('first quote intact', rq[0].text.indexOf('السلطة تُريد') === 0, true);
eq('last quote intact', rq[8].text.indexOf('2021') > 0, true);

var realSrt = fs.readFileSync(path.join(ROOT, 'examples/episode-elections/quotes.srt'), 'utf8');
var sq = sb.parseQuotesFile(new FileStub('quotes.srt', realSrt), []);
eq('quotes.srt -> 9 quotes (header comments excluded)', sq.length, 9);
eq('srt and csv agree', sq[0].text, rq[0].text);
eq('srt quote 5 matches', sq[4].text, rq[4].text);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
