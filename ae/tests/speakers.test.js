/**
 * Who said the quote.
 *
 * Every card used to carry the same guest name - whoever the template was
 * mocked up with - because the tool wrote one text layer and read one column.
 * These cover the three steps that fixed it: finding the speaker column by its
 * heading, reading the guest roster beside the quote list, and turning "2"
 * into a real name and job title without ever guessing.
 */
var fs = require('fs');
var path = require('path');
var AE = path.join(__dirname, '..');
var ROOT = path.join(AE, '..');

var core = fs.readFileSync(path.join(AE, 'lib', 'core.jsxinc'), 'utf8');
var block = core.slice(core.indexOf('    var SCRIPT_NAME'), core.indexOf('AE helpers'));

function FileStub(name, content) { this.name = name; this._c = content; }
FileStub.prototype.open = function () { return true; };
FileStub.prototype.read = function () { return this._c; };
FileStub.prototype.close = function () {};

var sb = new Function(
  block + '\nreturn { foldText: foldText, toWesternDigits: toWesternDigits,' +
  ' headerColumn: headerColumn, pickTextColumn: pickTextColumn, parseCSVText: parseCSVText,' +
  ' parseGuestList: parseGuestList, resolveSpeaker: resolveSpeaker,' +
  ' parseQuotesFile: parseQuotesFile,' +
  ' SPEAKER_HEADS: SPEAKER_HEADS, TITLE_HEADS: TITLE_HEADS };'
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

// ------------------------------------------------------------------ folding
console.log('\n-- Arabic survives the fold (normalize() deleted it entirely) --');
eq('Arabic is not emptied', sb.foldText('المتحدث').length > 0, true);
eq('alef forms fold together', sb.foldText('أحمد') === sb.foldText('احمد'), true);
eq('taa marbuta folds to haa', sb.foldText('الصفة') === sb.foldText('الصفه'), true);
eq('harakat are dropped', sb.foldText('تُريد') === sb.foldText('تريد'), true);
eq('spaces and punctuation go', sb.foldText('المتحدث (يتملى يدوياً)').indexOf('المتحدث'), 0);
eq('Arabic-Indic digits become digits', sb.toWesternDigits('٣'), '3');
eq('Persian digits too', sb.toWesternDigits('۷'), '7');
eq('Latin still folds', sb.foldText('Speaker Name'), 'speakername');

// ------------------------------------------------------------ the heading
console.log('\n-- the speaker column is found by its HEADING, never its contents --');
var head = [['#', 'التوقيت', 'المتحدث', 'الصفة', 'نص الاقتباس']];
eq('exact Arabic heading', sb.headerColumn(head, sb.SPEAKER_HEADS, -1), 2);
eq('title heading, speaker taken', sb.headerColumn(head, sb.TITLE_HEADS, 2), 3);
eq('heading with a note after it',
   sb.headerColumn([['#', 'التوقيت', 'المتحدث (يتملى يدوياً)', 'نص الاقتباس']], sb.SPEAKER_HEADS, -1), 2);
eq('English heading', sb.headerColumn([['#', 'Speaker', 'Quote']], sb.SPEAKER_HEADS, -1), 1);
eq('no heading names one', sb.headerColumn([['#', 'when', 'quote']], sb.SPEAKER_HEADS, -1), -1);
eq('the quote column is not mistaken for a name',
   sb.headerColumn([['نص الاقتباس', 'التوقيت']], sb.SPEAKER_HEADS, -1), -1);

console.log('\n-- a long job title must not win the quote column --');
var rows = sb.parseCSVText(
  '#,المتحدث,الصفة,نص الاقتباس\n' +
  '1,2,عضو المجلس الثوري لحركة فتح وأستاذة الدبلوماسية وحل الصراعات في الجامعة العربية الأمريكية,قصير\n' +
  '2,1,محلل سياسي وعضو الأمانة العامة للمؤتمر الشعبي لفلسطينيي الخارج وباحث في الشأن الفلسطيني,أقصر\n');
eq('wordiest column is the title', sb.pickTextColumn(rows), 2);
eq('excluding it leaves the quote', sb.pickTextColumn(rows, [1, 2]), 3);

// ------------------------------------------------------------- the roster
console.log('\n-- the guest roster beside the quote list --');
var realInfo = fs.readFileSync(
  path.join(ROOT, 'examples/episode-elections/episode-info.txt'), 'utf8');
var guests = sb.parseGuestList(realInfo);
eq('three guests', guests.length, 3);
eq('the episode title is not a guest', guests[0].name.indexOf('عنوان') === -1, true);
eq('the host is not a guest', guests[0].name.indexOf('عثمان') === -1, true);
eq('first guest name', guests[0].name, 'الدكتورة دلال عريقات');
eq('the bullet is stripped', guests[1].name, 'محمد مشينش');
eq('a comma inside a title survives the split',
   guests[0].title.indexOf('عضو المجلس الثوري لحركة فتح، وأستاذة') , 0);
eq('third guest title', guests[2].title, 'باحث في المركز العربي للأبحاث ودراسة السياسات');

console.log('\n-- the dash is optional, Word eats bullets --');
eq('no bullet, still a guest',
   sb.parseGuestList('الضيوف:\nليلى حمدان — محللة سياسية\n')[0].name, 'ليلى حمدان');
eq('comma instead of a dash',
   sb.parseGuestList('الضيوف:\nليلى حمدان، محللة سياسية\n')[0].title, 'محللة سياسية');
eq('the list stops at the next section',
   sb.parseGuestList('الضيوف:\nليلى حمدان — محللة\nالمحاور:\nشيء آخر — تاني\n').length, 1);
eq('the list stops at a numbered quote',
   sb.parseGuestList('الضيوف:\nليلى حمدان — محللة\n( 1 ) اقتباس طويل هنا\n').length, 1);

// ------------------------------------------------------------- resolution
console.log('\n-- "2" becomes a name and a title --');
var R = [{ name: 'دلال عريقات', title: 'أستاذة الدبلوماسية' },
         { name: 'محمد مشينش', title: 'محلل سياسي' },
         { name: 'إيهاب محارمة', title: 'باحث' }];

eq('a number picks the guest', sb.resolveSpeaker('2', R).name, 'محمد مشينش');
eq('and brings the title along', sb.resolveSpeaker('2', R).title, 'محلل سياسي');
eq('an Arabic numeral works the same', sb.resolveSpeaker('٣', R).name, 'إيهاب محارمة');
eq('part of a name is enough', sb.resolveSpeaker('مشينش', R).name, 'محمد مشينش');
eq('the whole name works too', sb.resolveSpeaker('إيهاب محارمة', R).name, 'إيهاب محارمة');
eq('an empty cell is nothing at all', sb.resolveSpeaker('', R), null);

console.log('\n-- and it never guesses --');
var over = sb.resolveSpeaker('5', R);
eq('a number past the roster is blank', over.name, '');
eq('and says the roster only has 3', over.why.indexOf('3 guests') > 0, true);

var amb = sb.resolveSpeaker('محمد', [{ name: 'محمد مشينش', title: 'أ' },
                                      { name: 'محمد علي', title: 'ب' }]);
eq('a value fitting two guests is blank', amb.name, '');
eq('and both are named in the reason', amb.why.indexOf('محمد علي') > 0, true);

var bare = sb.resolveSpeaker('2', []);
eq('a bare number with no roster is blank', bare.name, '');
eq('and points at episode-info.txt', bare.why.indexOf('episode-info.txt') > 0, true);
eq('a real name with no roster is taken as written',
   sb.resolveSpeaker('ليلى حمدان', []).name, 'ليلى حمدان');

// ---------------------------------------------------------------- the CSV
console.log('\n-- end to end: numbers in the CSV, names on the cards --');
var csv = '#,التوقيت,المتحدث,الصفة,نص الاقتباس\n' +
          '1,11:06,2,,السلطة تريد من خلال الانتخابات أن تجدد شرعيتها\n' +
          '2,29:35,1,,من المحتمل تأجيل الانتخابات في ظل الواقع\n' +
          '3,31:22,٣,,هذه الانتخابات إن لم تتم فإن المشروع الوطني\n';
var meta = {};
var q = sb.parseQuotesFile(new FileStub('quotes.csv', csv), [], meta, R);
eq('three quotes', q.length, 3);
eq('quote 1 is the guest number 2', q[0].speaker, 'محمد مشينش');
eq('quote 2 is guest 1', q[1].speaker, 'دلال عريقات');
eq('an Arabic numeral resolves too', q[2].speaker, 'إيهاب محارمة');
eq('the title comes from the roster', q[0].title, 'محلل سياسي');
eq('the quote body is untouched', q[0].text.indexOf('السلطة تريد'), 0);
eq('the raw cell is kept for the log', q[0].speakerRaw, '2');
eq('all three named', meta.named, 3);
eq('speaker column reported', meta.speakerColumn, 2);
eq('by its heading', meta.speakerHeader, 'المتحدث');

console.log('\n-- a title written in the CSV beats the roster --');
var csv2 = 'المتحدث,الصفة,نص الاقتباس\n' +
           '2,ضيف الحلقة,اقتباس طويل بما فيه الكفاية ليكون نصا\n';
var q2 = sb.parseQuotesFile(new FileStub('q.csv', csv2), [], {}, R);
eq('name still from the roster', q2[0].speaker, 'محمد مشينش');
eq('title from the CSV', q2[0].title, 'ضيف الحلقة');

console.log('\n-- missing column and empty column are different problems --');
var mNone = {};
sb.parseQuotesFile(new FileStub('q.csv',
  '#,التوقيت,نص الاقتباس\n1,11:06,اقتباس طويل بما فيه الكفاية هنا\n'), [], mNone, R);
eq('no speaker column at all', mNone.speakerColumn, -1);
eq('so nothing is named', mNone.named, 0);

var mEmpty = {};
sb.parseQuotesFile(new FileStub('q.csv',
  '#,المتحدث,نص الاقتباس\n1,,اقتباس طويل بما فيه الكفاية هنا\n'), [], mEmpty, R);
eq('the column is there', mEmpty.speakerColumn, 1);
eq('and its heading is quoted back', mEmpty.speakerHeader, 'المتحدث');
eq('but still nothing named', mEmpty.named, 0);

var mBad = {};
sb.parseQuotesFile(new FileStub('q.csv',
  '#,المتحدث,نص الاقتباس\n1,9,اقتباس طويل بما فيه الكفاية هنا\n'), [], mBad, R);
eq('an out-of-range number is reported', mBad.unresolved.length, 1);
eq('naming the quote', mBad.unresolved[0].indexOf('Quote 1'), 0);

console.log('\n-- the real episode file still reads as it did --');
var realCsv = fs.readFileSync(path.join(ROOT, 'examples/episode-elections/quotes.csv'), 'utf8');
var mReal = {};
var rq = sb.parseQuotesFile(new FileStub('quotes.csv', realCsv), [], mReal);
eq('nine quotes', rq.length, 9);
eq('its speaker column is recognised despite the note in the heading',
   mReal.speakerHeader, 'المتحدث (يتملى يدوياً)');
eq('it is empty, so no names', mReal.named, 0);
eq('and the quote text is not the timecode column', rq[0].text.indexOf('السلطة تُريد'), 0);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
