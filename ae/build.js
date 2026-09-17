#!/usr/bin/env node
/**
 * Builds the standalone After Effects scripts from the shared core.
 *
 * Both tools share ae/lib/core.jsxinc, so the parsing, matching and layer
 * logic can never drift between them. Each build output is a single
 * self-contained .jsx - the whole point is that the user copies one file.
 *
 *   node ae/build.js
 */
var fs = require('fs');
var path = require('path');

var LIB = path.join(__dirname, 'lib');

function read(name) {
    return fs.readFileSync(path.join(LIB, name), 'utf8').replace(/\s+$/, '');
}

var GENERATED = ' * GENERATED FILE - do not edit directly.\n' +
                ' * Edit ae/lib/core.jsxinc or ae/lib/ui-*.jsxinc, then run: node ae/build.js\n';

var TARGETS = [
    {
        out: 'PersonReplacer.jsx',
        ui: 'ui-panel.jsxinc',
        fn: 'personReplacer',
        header:
' * Person Replacer  -  After Effects ScriptUI panel\n' +
' * ------------------------------------------------\n' +
' * Reads an SRT-style timecode script, finds the video layer that is live at\n' +
' * each timecode, and replaces its footage source with another person\'s clip.\n' +
' *\n' +
' * The layer itself is never rebuilt: masks, effects, transforms and keyframes\n' +
' * all survive, exactly like an Alt+drag "replace footage".\n' +
' *\n' +
' * Install:  copy to\n' +
' *   Win  C:\\Program Files\\Adobe\\Adobe After Effects <ver>\\Support Files\\Scripts\\ScriptUI Panels\\\n' +
' *   Mac  /Applications/Adobe After Effects <ver>/Scripts/ScriptUI Panels/\n' +
' * then restart AE and open  Window > PersonReplacer.jsx\n' +
' *\n' +
' * Requires: Preferences > Scripting & Expressions > "Allow Scripts to Write\n' +
' * Files and Access Network" (for the log file only).\n'
    },
    {
        out: 'QuoteCards.jsx',
        ui: 'ui-quotecards.jsxinc',
        fn: 'quoteCards',
        header:
' * Quote Cards  -  After Effects\n' +
' * ------------------------------\n' +
' * Turns ONE template comp into a card per quote.\n' +
' *\n' +
' * Your template is a comp holding a footage layer for the speaker (masked\n' +
' * however you like) and a text layer for the quote. This builds a copy of it\n' +
' * for every quote in your list, swapping in the right clip and setting the\n' +
' * text, while keeping the masks, effects and type styling you already have.\n' +
' *\n' +
' * Clip order decides who appears: the 1st clip in the folder goes to quote 1,\n' +
' * the 2nd to quote 2, and so on.\n' +
' *\n' +
' * HOW TO RUN IT:\n' +
' *   File > Scripts > Run Script File...   and pick this file.\n' +
' *\n' +
' * Arabic text needs the Middle Eastern text engine:\n' +
' *   Preferences > Type > Text Engine > South Asian and Middle Eastern\n'
    },
    {
        out: 'EpisodeForm.jsx',
        ui: 'ui-episodeform.jsxinc',
        fn: 'episodeForm',
        header:
' * Episode Form  -  After Effects\n' +
' * -------------------------------\n' +
' * Turns the producer\'s weekly form into the two files QuoteCards.jsx reads,\n' +
' * so nobody retypes nine quotes and three job titles by hand.\n' +
' *\n' +
' * Paste the form in, press Read, say who said what, and save. You get\n' +
' * quotes.csv and episode-info.txt, written as UTF-8 - which is the step\n' +
' * that breaks when a spreadsheet exports them instead.\n' +
' *\n' +
' * HOW TO RUN IT:\n' +
' *   File > Scripts > Run Script File...   and pick this file.\n' +
' *\n' +
' * Requires: Preferences > Scripting & Expressions > "Allow Scripts to Write\n' +
' * Files and Access Network".\n'
    },
    {
        out: 'PersonReplacer_Auto.jsx',
        ui: 'ui-auto.jsxinc',
        fn: 'personReplacerAuto',
        header:
' * Person Replacer AUTO  -  After Effects\n' +
' * --------------------------------------\n' +
' * The zero-setup version. Nothing to configure, nothing to browse.\n' +
' *\n' +
' * HOW TO RUN IT:\n' +
' *   1. Save your After Effects project.\n' +
' *   2. Open the composition you want to work on.\n' +
' *   3. File > Scripts > Run Script File...   and pick this file.\n' +
' *\n' +
' * It then finds, on its own:\n' +
' *   - the composition   (whichever one is open)\n' +
' *   - the videos folder (a folder with clips near your .aep)\n' +
' *   - the timecode script (.srt or .txt near your .aep)\n' +
' *\n' +
' * It shows you exactly what it found and what it will do, and touches\n' +
' * nothing until you press "Replace now". One Ctrl/Cmd+Z undoes everything.\n' +
' *\n' +
' * If it cannot find the folder or the script, two buttons let you point at\n' +
' * them once - it remembers nothing, it just re-scans.\n'
    }
];

var core = read('core.jsxinc');

TARGETS.forEach(function (t) {
    var body = [
        '/**',
        t.header + ' */',
        '',
        '(function ' + t.fn + '(thisObj) {',
        '',
        core,
        '',
        read(t.ui),
        '',
        '    build(thisObj);',
        '',
        '})(this);',
        ''
    ].join('\n');

    // the generated-file notice goes right after the descriptive header
    body = body.replace(' */\n\n(function', ' *\n' + GENERATED + ' */\n\n(function');

    var outPath = path.join(__dirname, t.out);
    fs.writeFileSync(outPath, body);
    console.log('built  ' + t.out + '  (' + body.split('\n').length + ' lines)');
});
