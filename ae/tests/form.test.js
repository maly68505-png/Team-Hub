/**
 * Reading the producer's weekly form. The shape here is the elections form as
 * it actually arrives: quotes numbered "( N )" with the timecode in its own
 * column, and the guests listed further down as "Name، Title".
 *
 * The form never says who said which quote. That is the one thing nobody can
 * read off the paper, and the only thing left for a person to supply.
 */
var fs = require('fs');
var path = require('path');
var AE = path.join(__dirname, '..');

var core = fs.readFileSync(path.join(AE, 'lib', 'core.jsxinc'), 'utf8');
var block = core.slice(core.indexOf('    function trim(s)'), core.indexOf('AE helpers'));
var sb = new Function('VIDEO_EXT', 'MIN_MATCH_SCORE', 'TOL',
  block + '\nreturn { parseFormQuotes: parseFormQuotes, parseGuestList: parseGuestList,' +
  ' buildQuotesCSV: buildQuotesCSV, buildGuestsText: buildGuestsText,' +
  ' csvField: csvField, digitsToInt: digitsToInt, parseCSVText: parseCSVText,' +
  ' parseQuotesFile: parseQuotesFile };'
)("mp4,mov", 2, 0.0005);

var pass = 0, fail = 0;
function eq(l, g, w) {
  var ok = JSON.stringify(g) === JSON.stringify(w);
  if (ok) { pass++; console.log('  ok   ' + l); }
  else { fail++; console.log('  FAIL ' + l + '\n         got  ' + JSON.stringify(g) + '\n         want ' + JSON.stringify(w)); }
}

// the form, pasted the way it comes out of the producer's document
var FORM = [
  'أبرز الاقتباسات التي ستظهر مكتوبة',
  '',
  '( 1 ) السلطة تُريد من خلال الانتخابات أن تجدد شرعيتها السياسية وأن تؤهل مؤسساتها\t11:06',
  '( 2 ) من المحتمل تأجيل الانتخابات في ظل الواقع الذي تعيشه الأراضي الفلسطينية\t29:35',
  '( 3 ) هذه الانتخابات إن لم تتم فإن المشروع الوطني الفلسطيني سيواجه نكسة جديدة\t31:22',
  '( 7 ) الحوار الوطني في ضوء المواقف المعلنة من مختلف الأطراف كفيل بتحقيق توافقات\t01:16:43',
  '',
  '- الضيوف:',
  '- الدكتورة دلال عريقات، عضو المجلس الثوري لحركة فتح وأستاذة الدبلوماسية وحل الصراعات',
  '- محمد مشينش، محلل سياسي وعضو الأمانة العامة للمؤتمر الشعبي لفلسطينيي الخارج',
  '- الدكتور إيهاب محارمة، باحث في المركز العربي للأبحاث ودراسة السياسات'
].join('\n');

console.log('\n-- the quotes come out, the scaffolding does not --');
var q = sb.parseFormQuotes(FORM);
eq('four quotes, and only the quotes', q.length, 4);
eq('the numbering is stripped', q[0].text.indexOf('('), -1);
eq('the text starts at the first word', q[0].text.indexOf('السلطة تُريد'), 0);
eq('the timecode is taken off the end and kept aside',
   [q[0].timecode, q[0].text.indexOf('11:06')], ['11:06', -1]);
eq('an hour-long timecode too', q[3].timecode, '01:16:43');
eq('rows are renumbered in order, not by the form\'s own numbering',
   [q[0].index, q[3].index], [1, 4]);
eq('the heading above the table is not a quote', q[0].text.indexOf('أبرز'), -1);
eq('and the three guests are not quotes',
   q.filter(function (x) { return x.text.indexOf('مشينش') >= 0; }).length, 0);

console.log('\n-- the guests come out of the same paste --');
var g = sb.parseGuestList(FORM);
eq('three guests', g.length, 3);
eq('split on the comma when there is no dash',
   [g[0].name, g[0].role.indexOf('عضو المجلس الثوري')], ['الدكتورة دلال عريقات', 0]);
eq('the others', [g[1].name, g[2].name], ['محمد مشينش', 'الدكتور إيهاب محارمة']);

console.log('\n-- what gets written --');
var csv = sb.buildQuotesCSV(q, '2,1,3,3');
var rows = sb.parseCSVText(csv.replace(/^﻿/, ''));
eq('a header and a row per quote', rows.length, 5);
eq('the columns QuoteCards reads',
   [rows[0][2], rows[0][4]], ['المتحدث', 'نص الاقتباس']);
eq('who said what lands in the speaker column',
   [rows[1][2], rows[2][2], rows[3][2], rows[4][2]], ['2', '1', '3', '3']);
eq('the quote text survives the round trip', rows[1][4], q[0].text);
eq('it starts with a BOM so Excel opens the Arabic correctly',
   csv.charCodeAt(0), 0xFEFF);

var withComma = sb.buildQuotesCSV([{ text: 'قال: نعم, ثم لا', timecode: '' }], '');
eq('a quote containing a comma is quoted, not split',
   sb.parseCSVText(withComma.replace(/^﻿/, ''))[1][4], 'قال: نعم, ثم لا');
eq('and one containing a double quote survives',
   sb.parseCSVText(sb.buildQuotesCSV([{ text: 'قال "نعم" له', timecode: '' }], '')
     .replace(/^﻿/, ''))[1][4], 'قال "نعم" له');

console.log('\n-- an unanswered "who said what" leaves the column empty --');
var blank = sb.parseCSVText(sb.buildQuotesCSV(q, '').replace(/^﻿/, ''));
eq('no guess is made', [blank[1][2], blank[4][2]], ['', '']);
var partial = sb.parseCSVText(sb.buildQuotesCSV(q, '2,1').replace(/^﻿/, ''));
eq('a partial answer fills only what was given',
   [partial[1][2], partial[2][2], partial[3][2]], ['2', '1', '']);

console.log('\n-- the guest file reads back into the card tool --');
var info = sb.buildGuestsText(g, 'الانتخابات الفلسطينية', 'عثمان آي فرح');
eq('what was written is what comes back', sb.parseGuestList(info), g);
eq('the title line is there', info.indexOf('عنوان الحلقة: الانتخابات الفلسطينية') >= 0, true);

console.log('\n-- forms that are shaped a bit differently --');
eq('"1) ..." works', sb.parseFormQuotes('1) اقتباس طويل بما يكفي هنا').length, 1);
eq('"1- ..." works', sb.parseFormQuotes('1- اقتباس طويل بما يكفي هنا').length, 1);
eq('"[2] ..." works', sb.parseFormQuotes('[2] اقتباس طويل بما يكفي هنا').length, 1);
eq('arabic numbering works', sb.parseFormQuotes('( ١ ) اقتباس طويل بما يكفي هنا').length, 1);
eq('an unnumbered line is still taken', sb.parseFormQuotes('اقتباس طويل بما يكفي هنا').length, 1);
eq('a bare page number is not a quote', sb.parseFormQuotes('12\n2026\n').length, 0);
eq('a short heading is not a quote', sb.parseFormQuotes('المحاور').length, 0);
eq('nothing pasted, nothing found', sb.parseFormQuotes('').length, 0);

console.log('\n-- a form copied out of a PDF, which comes apart --');
// This is the real paste: the table lost its structure, so every cell is on
// its own line, "( 19 )" split into three, and the visuals table's Drive
// links broke across four lines each. It reported 53 quotes.
var BROKEN = [
  'me=large',
  'دلال',
  '02:04:05',
  ')',
  '19',
  '(',
  'نتيامو',
  'https://drive.google.com/file/d/',
  'Bot13/view?usp=drive',
  'link_',
  '02:04:23',
  'https://drive.google.com/file/d/1iDUcr9culjmqxx-9R6AB1TsNnmT',
  'VpoKP/view?usp=drive',
  'w7H1l1/view?usp=drive_link'
].join('\n');

var broken = sb.parseFormQuotes(BROKEN);
eq('not one link is taken as a quote',
   broken.filter(function (q) { return /https?:|drive\.google|usp=/.test(q.text); }).length, 0);
eq('and it says the paste came apart', broken.looksFragmented, true);
eq('counting what it threw away', broken.droppedFragments >= 3, true);

console.log('\n-- a form that copied cleanly is not accused of it --');
eq('the good paste is not flagged', sb.parseFormQuotes(FORM).looksFragmented, false);
eq('and nothing was thrown away from it', sb.parseFormQuotes(FORM).droppedFragments, 0);
eq('a real quote holding a colon and digits still comes through',
   sb.parseFormQuotes('( 1 ) قال في 2021: إن الانتخابات تأجلت مرتين').length, 1);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
