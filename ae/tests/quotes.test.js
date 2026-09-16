/**
 * Covers the quote-card inputs: natural clip ordering and reading the quote
 * list out of a .csv, a .srt or a plain .txt.
 */
var fs = require('fs');
var path = require('path');
var AE = path.join(__dirname, '..');
var ROOT = path.join(AE, '..');

var core = fs.readFileSync(path.join(AE, 'lib', 'core.jsxinc'), 'utf8');
var a = core.indexOf('    function trim(s)');
var b = core.indexOf('AE helpers');
var block = core.slice(a, b);

function FileStub(name, content) { this.name = name; this._c = content; }
FileStub.prototype.open = function () { return true; };
FileStub.prototype.read = function () { return this._c; };
FileStub.prototype.close = function () {};

var sb = new Function('VIDEO_EXT', 'MIN_MATCH_SCORE', 'TOL',
  block + '\nreturn { naturalCompare: naturalCompare, sortFilesNaturally: sortFilesNaturally,' +
  ' parseCSVText: parseCSVText, pickTextColumn: pickTextColumn, parseQuotesFile: parseQuotesFile,' +
  ' pickLabelledColumn: pickLabelledColumn, looseHas: looseHas,' +
  ' digitsOf: digitsOf, alphaMatchScore: alphaMatchScore, pairAlphaClips: pairAlphaClips,' +
  ' SPEAKER_HINTS: SPEAKER_HINTS, ROLE_HINTS: ROLE_HINTS };'
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

console.log('\n-- the speaker name gets its own column --');
// normalize() strips Arabic to "", and indexOf("") matches everything, so the
// header match has to be a plain substring test or every hint hits column 0.
eq('normalize would have flattened this', /[a-z0-9]/.test('المتحدث'), false);
eq('arabic header matches its hint', sb.looseHas('المتحدث (يتملى يدوياً)', 'متحدث'), true);
eq('an unrelated header does not', sb.looseHas('التوقيت الكامل', 'متحدث'), false);
eq('an empty hint never matches', sb.looseHas('anything at all', ''), false);

var named = '#,when,Speaker,Title,quote\n' +
            '1,11:06,Dr Bashar,Politics professor,First quote long enough to win the column\n' +
            '2,29:35,Layla Hamdan,Analyst,Second quote also nice and wordy here\n';
var nrows = sb.parseCSVText(named);
eq('speaker column by header', sb.pickLabelledColumn(nrows, sb.SPEAKER_HINTS, 4), 2);
eq('title column by header', sb.pickLabelledColumn(nrows, sb.ROLE_HINTS, 4), 3);
var nq = sb.parseQuotesFile(new FileStub('q.csv', named), []);
eq('speaker read per row', [nq[0].speaker, nq[1].speaker], ['Dr Bashar', 'Layla Hamdan']);
eq('title read per row', [nq[0].role, nq[1].role], ['Politics professor', 'Analyst']);
eq('column header reported back', nq[0].speakerColumn, 'Speaker');

console.log('\n-- a job title longer than the quote it sits under --');
// Dalal Erekat's real title runs 89 characters against a 93-character quote.
// Four characters decided which one got written across the card.
var longTitle = 'عضو المجلس الثوري لحركة فتح وأستاذة الدبلوماسية وحل الصراعات في الجامعة العربية الأمريكية';
var titled = '#,Speaker,Title,quote\n' +
             '1,د. دلال عريقات,' + longTitle + ',اقتباس قصير\n' +
             '2,د. دلال عريقات,' + longTitle + ',اقتباس قصير تاني\n';
var tq = sb.parseQuotesFile(new FileStub('q.csv', titled), []);
eq('the quote is still the quote, not the title', tq[0].text, 'اقتباس قصير');
eq('and the title went to its own field', tq[0].role, longTitle);
eq('a named column is out of the wordiest-column running',
   sb.pickTextColumn(sb.parseCSVText(titled), { 1: true, 2: true }), 3);
eq('without the skip it would have won', sb.pickTextColumn(sb.parseCSVText(titled)), 2);

console.log('\n-- a file that names nobody --');
// A headed but blank column is not the same as no column: the panel says
// "fill this in" for the first and "add one" for the second.
eq('headed but blank column is reported as such',
   [q[0].speaker, q[0].role, q[0].speakerColumn], ['', '', 'speaker']);
var anon = 'n,when,quote\n1,11:06,A quote that is comfortably the wordiest field\n' +
           '2,29:35,Another quote of a similar generous length\n';
eq('no speaker column at all -> nothing reported',
   sb.parseQuotesFile(new FileStub('q.csv', anon), [])[0].speakerColumn, '');
eq('and no name is invented from the other columns',
   sb.parseQuotesFile(new FileStub('q.csv', anon), [])[0].speaker, '');
eq('txt carries no speaker either',
   sb.parseQuotesFile(new FileStub('q.txt', 'One quote.\n\nTwo quote.'), [])[0].speaker, '');

// This is the live file, and its speaker column is headed but blank - the
// panel has to tell the user that rather than silently reusing one name.
eq('real quotes.csv names its speaker column', rq[0].speakerColumn, 'المتحدث');
eq('real quotes.csv has a job-title column beside it',
   sb.pickLabelledColumn(sb.parseCSVText(realCsv), sb.ROLE_HINTS, -1) >= 0, true);
eq('and the wordiest column is still the quote, not one of those two',
   rq[0].text.indexOf('السلطة تُريد'), 0);
// Card 2 is filled in; the other eight are not, and the panel has to say so
// rather than let one name stand in for everybody the way it used to.
eq('the one guest we know is on her own quote', rq[1].speaker, 'الدكتورة دلال عريقات');
eq('her title came through whole', rq[1].role.indexOf('المجلس الثوري') > 0, true);
eq('the other eight are still waiting for a name',
   rq.filter(function (r) { return r.speaker === ''; }).length, 8);

console.log('\n-- pairing a clip with its cut-out --');
function F(n) { return { name: n, fsName: '/clips/' + n }; }
function nm(list) { return list.map(function (f) { return f ? f.name : null; }); }

eq('digits normalise across padding', [sb.digitsOf('Aktbas_002.mov'), sb.digitsOf('clip2.mp4')],
   ['2', '2']);
eq('a suffixed cut-out matches its clip',
   sb.alphaMatchScore(F('01_dalal.mp4'), F('01_dalal_alpha.mov')) > 0, true);
eq('clip1 does not grab clip10\'s cut-out',
   sb.alphaMatchScore(F('clip1.mp4'), F('clip10_alpha.mov')), 0);

var w1 = [];
eq('matched by name even when the folder order differs',
   nm(sb.pairAlphaClips([F('Aktbas_001.mov'), F('Aktbas_002.mov'), F('Aktbas_003.mov')],
                        [F('Aktbas_003_alpha.mov'), F('Aktbas_001_alpha.mov'),
                         F('Aktbas_002_alpha.mov')], w1)),
   ['Aktbas_001_alpha.mov', 'Aktbas_002_alpha.mov', 'Aktbas_003_alpha.mov']);
eq('a clean name match says nothing', w1.length, 0);

// What actually comes back from an outside keyer: job ids, any order.
var w2 = [];
eq('unrecognisable names still pair, by position',
   nm(sb.pairAlphaClips([F('a.mov'), F('b.mov')], [F('8f3a2b1c.webm'), F('1c9d4e7a.webm')], w2)),
   ['8f3a2b1c.webm', '1c9d4e7a.webm']);
eq('and that fallback is called out', w2.length === 1 && /POSITION/.test(w2[0]), true);

var w3 = [];
eq('the one cut-out goes to the clip it is named after, not to card 1',
   nm(sb.pairAlphaClips([F('01_a.mov'), F('02_b.mov')], [F('02_b_alpha.mov')], w3)),
   [null, '02_b_alpha.mov']);
eq('and nothing was shuffled into the gap', w3.length, 0);

var w4 = [];
eq('arabic names match, where normalize() would flatten them to nothing',
   nm(sb.pairAlphaClips([F('01_دلال.mp4')], [F('01_دلال_alpha.mov')], w4)),
   ['01_دلال_alpha.mov']);
eq('so no warning is raised for them', w4.length, 0);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
