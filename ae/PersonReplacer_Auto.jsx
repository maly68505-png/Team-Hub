/**
 * Person Replacer AUTO  -  After Effects
 * --------------------------------------
 * The zero-setup version. Nothing to configure, nothing to browse.
 *
 * HOW TO RUN IT:
 *   1. Save your After Effects project.
 *   2. Open the composition you want to work on.
 *   3. File > Scripts > Run Script File...   and pick this file.
 *
 * It then finds, on its own:
 *   - the composition   (whichever one is open)
 *   - the videos folder (a folder with clips near your .aep)
 *   - the timecode script (.srt or .txt near your .aep)
 *
 * It shows you exactly what it found and what it will do, and touches
 * nothing until you press "Replace now". One Ctrl/Cmd+Z undoes everything.
 *
 * If it cannot find the folder or the script, two buttons let you point at
 * them once - it remembers nothing, it just re-scans.
 *
 * GENERATED FILE - do not edit directly.
 * Edit ae/lib/core.jsxinc or ae/lib/ui-*.jsxinc, then run: node ae/build.js
 */

(function personReplacerAuto(thisObj) {

    var SCRIPT_NAME = "Person Replacer";
    var SETTINGS_SECTION = "PersonReplacer";
    var VIDEO_EXT = "mp4,mov,m4v,avi,mkv,mxf,webm,mpg,mpeg,wmv,mts,m2ts,r3d,braw,dv,3gp";

    // Which CSV headings name the speaker and their job title. The column is
    // recognised by its HEADING only - never by what is in it, because a wrong
    // guess writes a row number or a timecode onto a real person's card.
    var SPEAKER_HEADS = "\u0627\u0644\u0645\u062a\u062d\u062f\u062b,\u0627\u0644\u0636\u064a\u0641,\u0627\u0644\u0645\u062a\u0643\u0644\u0645,\u0627\u0644\u0642\u0627\u0626\u0644,\u0627\u0644\u0627\u0633\u0645,speaker,name,guest,who";
    var TITLE_HEADS = "\u0627\u0644\u0635\u0641\u0629,\u0627\u0644\u0648\u0638\u064a\u0641\u0629,\u0627\u0644\u0645\u0646\u0635\u0628,\u0627\u0644\u062a\u0639\u0631\u064a\u0641,title,role,job,position";
    var GUEST_HEADS = "\u0627\u0644\u0636\u064a\u0648\u0641,\u0636\u064a\u0648\u0641,guests,panel";
    var GUEST_FILES = "episode-info.txt,episode-info.md,episode_info.txt,guests.txt,guests.md";
    // what an exporter tacks onto a cut-out's filename
    var ALPHA_MARKERS = "alpha,matte,cutout,cut,key,keyed,rgba,transparent,nobg,noback";
    var MIN_MATCH_SCORE = 2;
    var TOL = 0.0005; // seconds, float-compare tolerance

    // ---------------------------------------------------------------- utils

    function trim(s) {
        return String(s).replace(/^[\s\u00a0]+/, "").replace(/[\s\u00a0]+$/, "");
    }

    function normalize(s) {
        return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "");
    }

    /** Arabic-Indic and Persian digits written the way parseInt reads them. */
    function toWesternDigits(s) {
        return String(s)
            .replace(/[\u0660-\u0669]/g, function (d) {
                return String(d.charCodeAt(0) - 0x0660);
            })
            .replace(/[\u06F0-\u06F9]/g, function (d) {
                return String(d.charCodeAt(0) - 0x06F0);
            });
    }

    /**
     * normalize() throws away every non-Latin letter, which turns any Arabic
     * heading or guest name into an empty string - so it could never be
     * compared against anything. This keeps Arabic letters and folds the
     * spellings that differ only on screen: the alef forms, the taa marbuta,
     * the alef maqsura, harakat and tatweel.
     */
    function foldText(s) {
        s = toWesternDigits(String(s)).toLowerCase();
        s = s.replace(/[\u064B-\u0652\u0640\u0670]/g, "");
        s = s.replace(/[\u0622\u0623\u0625\u0671]/g, "\u0627");
        s = s.replace(/\u0629/g, "\u0647");
        s = s.replace(/[\u0649\u06CC]/g, "\u064A");
        s = s.replace(/[^0-9a-z\u0621-\u064A]+/g, "");
        return s;
    }

    function pad(n, w) {
        var s = String(Math.floor(n));
        while (s.length < w) { s = "0" + s; }
        return s;
    }

    function secondsToTC(sec, fps) {
        if (sec < 0) { sec = 0; }
        var f = Math.round(sec * fps);
        var frames = f % Math.round(fps);
        var total = (f - frames) / Math.round(fps);
        var s = total % 60;
        var m = Math.floor(total / 60) % 60;
        var h = Math.floor(total / 3600);
        return pad(h, 2) + ":" + pad(m, 2) + ":" + pad(s, 2) + ":" + pad(frames, 2);
    }

    function extOf(name) {
        var i = String(name).lastIndexOf(".");
        return i < 0 ? "" : String(name).substring(i + 1).toLowerCase();
    }

    /**
     * The timecode script has to be plain text. Picking a PDF or a Word file
     * is an easy mistake to make, and "no segments parsed" does not explain
     * it - so name the real problem and say what to do about it.
     */
    var BINARY_DOC_EXT = "pdf,doc,docx,rtf,pages,odt,xls,xlsx,numbers,key,ppt,pptx";

    function scriptFileProblem(file) {
        var ext = extOf(file.name);
        if ((","+ BINARY_DOC_EXT + ",").indexOf("," + ext + ",") !== -1) {
            return "\"" + file.name + "\" is a " + ext.toUpperCase() + " file, which cannot be " +
                   "read as text.\n\nOpen it, then save or export the timecodes as a plain " +
                   "text file (.txt) or a subtitle file (.srt), and pick that instead.";
        }
        if ((","+ VIDEO_EXT + ",").indexOf("," + ext + ",") !== -1) {
            return "\"" + file.name + "\" is a video file, not the timecode script.\n\n" +
                   "The script file is the text file that says who should appear when.";
        }
        return null;
    }

    function isVideoFile(f) {
        return (","+ VIDEO_EXT + ",").indexOf("," + extOf(f.name) + ",") !== -1;
    }

    function baseName(name) {
        var i = String(name).lastIndexOf(".");
        return i < 0 ? String(name) : String(name).substring(0, i);
    }

    // -------------------------------------------------------- timecode parse

    /**
     * Accepts, per field:
     *   00:00:12,500   SRT milliseconds
     *   00:00:12.500   milliseconds
     *   00:00:12:15    frames (uses the comp frame rate)
     *   00:00:12;15    drop-frame flavour, treated as frames
     *   00:00:12       whole seconds
     * Returns seconds, or null when the string is not a timecode.
     */
    function tcToSeconds(str, fps) {
        var s = trim(str);
        var m = s.match(/^(\d{1,3}):(\d{1,2}):(\d{1,2})(?:([,.:;])(\d{1,3}))?$/);
        if (!m) {
            // bare seconds, e.g. "12.5"
            if (/^\d+(\.\d+)?$/.test(s)) { return parseFloat(s); }
            return null;
        }
        var sec = parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
        if (m[4] !== undefined && m[5] !== undefined) {
            if (m[4] === "," || m[4] === ".") {
                var frac = m[5];
                while (frac.length < 3) { frac += "0"; }
                sec += parseInt(frac, 10) / 1000;
            } else {
                sec += parseInt(m[5], 10) / fps;
            }
        }
        return sec;
    }

    var RANGE_SPLIT = /\s*-->\s*|\s*=>\s*|\s*->\s*|\s+-\s+|\s+to\s+/i;

    function parseRangeLine(line, fps) {
        var parts = String(line).split(RANGE_SPLIT);
        if (parts.length < 2) { return null; }
        var inSec = tcToSeconds(parts[0], fps);
        if (inSec === null) { return null; }
        // the second half may carry trailing text: "00:00:18:00  PERSON_B"
        var rest = trim(parts.slice(1).join(" "));
        var tok = rest.match(/^(\d{1,3}:\d{1,2}:\d{1,2}(?:[,.:;]\d{1,3})?|\d+(?:\.\d+)?)/);
        if (!tok) { return null; }
        var outSec = tcToSeconds(tok[1], fps);
        if (outSec === null) { return null; }
        return { inSec: inSec, outSec: outSec, trailing: trim(rest.substring(tok[1].length)) };
    }

    /**
     * Pulls the person name (and an optional explicit file) out of a text line.
     *   [PERSON_B]                -> PERSON_B
     *   PERSON_B: hello there     -> PERSON_B
     *   PERSON_B | take3.mp4      -> PERSON_B + explicit file
     *   PERSON_B                  -> PERSON_B
     */
    function parsePersonText(text) {
        var t = trim(text);
        if (t === "") { return null; }
        var file = "";
        var bar = t.split(/\s*\|\s*|\s*=>\s*|\s*->\s*/);
        if (bar.length > 1) {
            var last = trim(bar[bar.length - 1]);
            if (extOf(last) !== "") {
                file = last;
                t = trim(bar.slice(0, bar.length - 1).join(" "));
            }
        }
        t = t.replace(/^[\[\(\{<]+/, "").replace(/[\]\)\}>]+$/, "");
        var colon = t.indexOf(":");
        if (colon > 0 && !/^\d{1,3}:\d{2}/.test(t)) { t = t.substring(0, colon); }
        t = trim(t);
        if (t === "") { return null; }
        return { person: t, file: file };
    }

    /** Parses the whole script file into segments. */
    function parseScript(fileObj, fps, warnings) {
        var segments = [];
        if (!fileObj.open("r")) {
            warnings.push("Could not open script file: " + fileObj.fsName);
            return segments;
        }
        var raw = fileObj.read();
        fileObj.close();
        raw = raw.replace(/^\uFEFF/, "");
        var lines = raw.split(/\r\n|\r|\n/);

        var pending = null;   // range waiting for its text
        var textParts = [];

        function flush() {
            if (!pending) { return; }
            var info = null;
            if (pending.trailing !== "") {
                info = parsePersonText(pending.trailing);
            }
            if (!info) {
                info = parsePersonText(textParts.join(" "));
            }
            if (!info) {
                warnings.push("No person name found for " + secondsToTC(pending.inSec, fps) +
                              " - block skipped.");
            } else if (pending.outSec <= pending.inSec + TOL) {
                warnings.push("Out point is not after in point at " +
                              secondsToTC(pending.inSec, fps) + " - block skipped.");
            } else {
                segments.push({
                    inSec: pending.inSec,
                    outSec: pending.outSec,
                    person: info.person,
                    explicitFile: info.file
                });
            }
            pending = null;
            textParts = [];
        }

        for (var i = 0; i < lines.length; i++) {
            var line = trim(lines[i]);
            if (line === "") { flush(); continue; }
            if (/^\d+$/.test(line) && !pending) { continue; }   // SRT index line
            if (/^[#;]/.test(line) || /^\/\//.test(line)) { continue; }  // comment
            var range = parseRangeLine(line, fps);
            if (range) {
                flush();
                pending = range;
                if (range.trailing !== "") { flush(); }
                continue;
            }
            if (pending) { textParts.push(line); }
        }
        flush();

        segments.sort(function (a, b) { return a.inSec - b.inSec; });
        return segments;
    }

    // ------------------------------------------------------- video discovery

    function scanVideos(folder, out, depth) {
        if (!folder || !folder.exists || depth > 5) { return; }
        var items = folder.getFiles();
        if (!items) { return; }
        for (var i = 0; i < items.length; i++) {
            var it = items[i];
            if (it instanceof Folder) {
                scanVideos(it, out, depth + 1);
            } else if (isVideoFile(it)) {
                out.push(it);
            }
        }
    }

    /**
     * Scores a candidate file against a person name. Higher is better.
     * A straight containment of the normalized person name wins; otherwise we
     * fall back to counting shared word tokens.
     */
    function matchScore(person, file) {
        var p = normalize(person);
        if (p === "") { return 0; }
        var stem = normalize(baseName(file.name));
        var full = normalize(file.fsName);
        if (stem === p) { return p.length + 100; }
        if (stem.indexOf(p) !== -1) { return p.length + 50; }
        if (full.indexOf(p) !== -1) { return p.length + 20; }

        var tokens = String(person).toLowerCase().split(/[^a-z0-9]+/);
        var score = 0;
        for (var i = 0; i < tokens.length; i++) {
            if (tokens[i].length < 2) { continue; }
            if (stem.indexOf(tokens[i]) !== -1) { score += tokens[i].length; }
        }
        return score;
    }

    function pickFile(person, explicitFile, files) {
        if (explicitFile !== "") {
            var wantedNorm = normalize(explicitFile);
            for (var k = 0; k < files.length; k++) {
                if (normalize(files[k].name) === wantedNorm) { return files[k]; }
            }
            var direct = new File(explicitFile);
            if (direct.exists) { return direct; }
        }
        var best = null, bestScore = 0, tied = false;
        for (var i = 0; i < files.length; i++) {
            var s = matchScore(person, files[i]);
            if (s > bestScore) { bestScore = s; best = files[i]; tied = false; }
            else if (s === bestScore && s > 0) { tied = true; }
        }
        if (bestScore < MIN_MATCH_SCORE) { return null; }
        return best;
    }


    // ----------------------------------------------------- quote-card inputs

    /** Natural order: clip2 sorts before clip10, the way a person expects. */
    function naturalCompare(a, b) {
        var ra = String(a).toLowerCase().match(/(\d+|\D+)/g) || [];
        var rb = String(b).toLowerCase().match(/(\d+|\D+)/g) || [];
        for (var i = 0; i < Math.max(ra.length, rb.length); i++) {
            var x = ra[i], y = rb[i];
            if (x === undefined) { return -1; }
            if (y === undefined) { return 1; }
            var nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
            if (nx && ny) {
                var d = parseInt(x, 10) - parseInt(y, 10);
                if (d !== 0) { return d; }
            } else if (x !== y) {
                return x < y ? -1 : 1;
            }
        }
        return 0;
    }

    function sortFilesNaturally(files) {
        files.sort(function (a, b) { return naturalCompare(a.name, b.name); });
        return files;
    }

    /**
     * Pairs each clip with its cut-out version BY NAME, falling back to folder
     * order only when the names say nothing.
     *
     * Order alone was the whole rule, and it quietly broke the moment the
     * cut-outs came back from an external keyer named 8f3a2b1c.webm: one
     * guest's cut-out lands on another guest's card, and nobody notices until
     * they look at the face.
     *
     * Returns an array parallel to `clips` of { file, how }, how being
     * "name", "number" or "order".
     */
    function pairAlphaClips(clips, alphas) {
        var used = {}, pairs = [], i;
        var cBase = [], aBase = [];
        for (i = 0; i < clips.length; i++) { cBase.push(baseName(clips[i].name)); }
        for (i = 0; i < alphas.length; i++) {
            aBase.push(stripAlphaMarker(baseName(alphas[i].name)));
        }
        for (i = 0; i < clips.length; i++) { pairs.push({ file: null, how: "" }); }

        // the same name, give or take the _alpha on the end
        matchPass(function (c, a) {
            var fc = foldText(c);
            return fc !== "" && fc === foldText(a);
        }, "name");

        // one name inside the other - but clip1 is NOT clip10, so a trailing
        // number that disagrees vetoes the match however well the rest reads
        matchPass(function (c, a) {
            var fc = foldText(c), fa = foldText(a);
            if (fc === "" || fa === "") { return false; }
            if (fc.indexOf(fa) === -1 && fa.indexOf(fc) === -1) { return false; }
            var tc = trailingNumber(c), ta = trailingNumber(a);
            return !(tc && ta && tc.n !== ta.n);
        }, "name");

        // the number that ENDS the name: Aktbas_002 is Aktbas_2
        matchPass(function (c, a) {
            var tc = trailingNumber(c), ta = trailingNumber(a);
            if (!tc || !ta || tc.n !== ta.n) { return false; }
            var pc = foldText(tc.prefix), pa = foldText(ta.prefix);
            return pc === pa || pc === "" || pa === "";
        }, "number");

        // whatever is left falls back on order, which is what the warning is for
        var next = 0;
        for (i = 0; i < clips.length; i++) {
            if (pairs[i].file) { continue; }
            while (next < alphas.length && used[next]) { next++; }
            if (next >= alphas.length) { break; }
            used[next] = true;
            pairs[i] = { file: alphas[next], how: "order" };
        }
        return pairs;

        /** Takes a match only when exactly one unused cut-out fits. */
        function matchPass(fits, how) {
            for (var c = 0; c < clips.length; c++) {
                if (pairs[c].file) { continue; }
                var hit = -1, n = 0;
                for (var a = 0; a < alphas.length; a++) {
                    if (used[a]) { continue; }
                    if (fits(cBase[c], aBase[a])) { hit = a; n++; }
                }
                if (n === 1) { used[hit] = true; pairs[c] = { file: alphas[hit], how: how }; }
            }
        }
    }

    /** "Aktbas_001_alpha" -> "Aktbas_001". A marker needs a separator before
     *  it, so a name that merely ends in "key" is left whole. */
    function stripAlphaMarker(base) {
        var marks = ALPHA_MARKERS.split(","), out = base, changed = true;
        while (changed) {
            changed = false;
            for (var i = 0; i < marks.length; i++) {
                var re = new RegExp("[\\s_\\-\\.]+" + marks[i] + "$", "i");
                if (re.test(out)) { out = out.replace(re, ""); changed = true; }
            }
        }
        return out;
    }

    /** The number at the very end of a name, with whatever came before it. */
    function trailingNumber(s) {
        var w = toWesternDigits(String(s));
        var m = /([0-9]+)\s*$/.exec(w);
        if (!m) { return null; }
        return { n: parseInt(m[1], 10), prefix: w.substring(0, m.index) };
    }

    /** Minimal RFC4180 reader: quoted fields, doubled quotes, embedded newlines. */
    function parseCSVText(text) {
        var rows = [], row = [], field = "", inQuotes = false, i = 0;
        text = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        while (i < text.length) {
            var c = text.charAt(i);
            if (inQuotes) {
                if (c === '"') {
                    if (text.charAt(i + 1) === '"') { field += '"'; i += 2; continue; }
                    inQuotes = false; i++; continue;
                }
                field += c; i++; continue;
            }
            if (c === '"') { inQuotes = true; i++; continue; }
            if (c === ",") { row.push(field); field = ""; i++; continue; }
            if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
            field += c; i++;
        }
        if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
        var out = [];
        for (var r = 0; r < rows.length; r++) {
            var any = false;
            for (var k = 0; k < rows[r].length; k++) {
                if (trim(rows[r][k]) !== "") { any = true; break; }
            }
            if (any) { out.push(rows[r]); }
        }
        return out;
    }

    /**
     * The column carrying the quotes is simply the wordiest one - but an
     * Arabic job title runs longer than some quotes, so any column already
     * claimed by name or heading is kept out of the contest.
     */
    function pickTextColumn(rows, exclude) {
        var widest = 0, c, x;
        for (var r = 0; r < rows.length; r++) { widest = Math.max(widest, rows[r].length); }
        var best = -1, bestScore = -1;
        for (c = 0; c < widest; c++) {
            var skip = false;
            if (exclude) {
                for (x = 0; x < exclude.length; x++) {
                    if (exclude[x] === c) { skip = true; break; }
                }
            }
            if (skip) { continue; }
            var total = 0, n = 0;
            for (var i = 1; i < rows.length; i++) {          // skip a header row
                if (rows[i].length <= c) { continue; }
                total += trim(rows[i][c]).length;
                n++;
            }
            var score = n ? total / n : 0;
            if (score > bestScore) { bestScore = score; best = c; }
        }
        return best < 0 ? 0 : best;
    }

    /**
     * Which column carries what, decided by the HEADING alone. Guessing from
     * the contents is how a row number or a timecode ends up printed under a
     * real person's face, so a column that is not named is simply not used.
     * Returns -1 when no heading matches.
     */
    function headerColumn(rows, headsCSV, taken) {
        if (!rows.length) { return -1; }
        var head = rows[0], hints = headsCSV.split(","), pass, h, c;
        var folded = [];
        for (c = 0; c < head.length; c++) { folded.push(foldText(head[c])); }

        for (pass = 0; pass < 3; pass++) {
            for (h = 0; h < hints.length; h++) {
                var want = foldText(hints[h]);
                if (want === "") { continue; }
                if (pass === 2 && want.length < 4) { continue; }
                for (c = 0; c < folded.length; c++) {
                    if (c === taken || folded[c] === "") { continue; }
                    var hit = (pass === 0) ? folded[c] === want
                            : (pass === 1) ? folded[c].substring(0, want.length) === want
                            : folded[c].indexOf(want) !== -1;
                    if (hit) { return c; }
                }
            }
        }
        return -1;
    }

    /**
     * Reads the guest roster - the list under a line saying "الضيوف" - out of
     * an episode-info.txt sitting next to the quote list. Name and title are
     * split on a dash, because the title itself carries commas.
     * Returns [{ name, title }].
     */
    function parseGuestList(text) {
        var lines = String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
        var start = -1, i;
        for (i = 0; i < lines.length; i++) {
            var f = foldText(lines[i]);
            if (f === "") { continue; }
            var heads = GUEST_HEADS.split(","), hit = false;
            for (var h = 0; h < heads.length; h++) {
                if (f.indexOf(foldText(heads[h])) !== -1) { hit = true; break; }
            }
            // a heading names the list; a line that already IS a guest does not
            if (hit && f.length < 40) { start = i + 1; break; }
        }

        var loose = (start < 0);
        var out = [];
        for (i = loose ? 0 : start; i < lines.length; i++) {
            var raw = trim(lines[i]);
            if (raw === "") {
                if (out.length && !loose) { break; }
                continue;
            }
            if (!loose && isSectionOrQuoteLine(raw, out.length)) { break; }

            var line = raw.replace(/^[\-\u2022\u00b7\*\u25cf\u25aa\s]+/, "");
            line = line.replace(/^[0-9\u0660-\u0669]+\s*[\.\)\-]\s*/, "");
            line = trim(line);
            if (line === "") { continue; }

            var split = splitNameAndTitle(line);
            if (loose) {
                // With no heading to anchor on, only take lines that are
                // plainly a guest: "name - title", or a short bare name.
                if (!split.title && (line.length > 60 || line.indexOf(":") !== -1)) { continue; }
            }
            if (split.name === "") { continue; }
            out.push(split);
        }
        return out;
    }

    function isSectionOrQuoteLine(raw, have) {
        if (raw.length > 200) { return have > 0; }
        var western = toWesternDigits(raw);
        if (/^\s*[\(\[]?\s*[0-9]+\s*[\)\]\-\.]/.test(western)) { return true; }
        if (/:\s*$/.test(raw)) { return true; }
        return false;
    }

    function splitNameAndTitle(line) {
        var m = line.split(/\s*[\u2014\u2013\u2012]\s*/);
        if (m.length < 2) { m = line.split(/\s+-\s+/); }
        if (m.length < 2) { m = line.split(/\s*[\u060c,]\s*/); }
        var name = trim(m[0]);
        var title = (m.length > 1) ? trim(m.slice(1).join(" - ")) : "";
        return { name: name, title: title };
    }

    /**
     * Turns whatever the "المتحدث" column holds - a guest number, an Arabic
     * numeral, part of a name, or the whole name - into the name and title
     * that go on the card.
     *
     * It never guesses: a value matching two guests, or a bare number with no
     * roster to read it against, comes back with an empty name and a reason.
     * A wrong name under a real person's face is worse than no name.
     */
    function resolveSpeaker(raw, guests) {
        raw = trim(raw == null ? "" : raw);
        if (raw === "") { return null; }
        var have = guests && guests.length ? guests.length : 0;
        var western = trim(toWesternDigits(raw));

        if (/^[0-9]+$/.test(western)) {
            var n = parseInt(western, 10);
            if (have && n >= 1 && n <= have) {
                return { name: guests[n - 1].name, title: guests[n - 1].title, from: "number" };
            }
            return { name: "", title: "", from: "number", why: have
                ? "\"" + raw + "\" is not one of the " + have + " guests in the guest list"
                : "\"" + raw + "\" is a guest number, but there is no guest list " +
                  "(episode-info.txt) next to the quote list to read it against" };
        }

        if (have) {
            var needle = foldText(raw), hits = [];
            for (var i = 0; i < have; i++) {
                var hay = foldText(guests[i].name);
                if (hay === "" || needle === "") { continue; }
                if (hay === needle || hay.indexOf(needle) !== -1 || needle.indexOf(hay) !== -1) {
                    hits.push(i);
                }
            }
            if (hits.length === 1) {
                return { name: guests[hits[0]].name, title: guests[hits[0]].title, from: "roster" };
            }
            if (hits.length > 1) {
                var who = [];
                for (var k = 0; k < hits.length; k++) { who.push(guests[hits[k]].name); }
                return { name: "", title: "", from: "ambiguous",
                         why: "\"" + raw + "\" fits more than one guest (" + who.join(" / ") +
                              ") - left blank rather than guessed" };
            }
        }
        return { name: raw, title: "", from: "literal" };
    }

    /** The guest roster sitting next to the quote list, or null. */
    function findGuestFile(quotesFile) {
        var names = GUEST_FILES.split(",");
        try {
            var dir = quotesFile.parent;
            if (!dir) { return null; }
            for (var i = 0; i < names.length; i++) {
                var f = new File(dir.fsName + "/" + names[i]);
                if (f.exists) { return f; }
            }
        } catch (e) {}
        return null;
    }

    function readGuestFile(file, warnings) {
        try {
            if (!file.open("r")) {
                warnings.push("Could not open the guest list: " + file.fsName);
                return [];
            }
            var raw = file.read();
            file.close();
            return parseGuestList(raw.replace(/^\uFEFF/, ""));
        } catch (e) {
            warnings.push("Could not read the guest list: " + e.toString());
            return [];
        }
    }

    /**
     * Reads the quote list. Accepts:
     *   .csv  - the wordiest column is taken as the quote text, and a column
     *           HEADED with a speaker or title name supplies who said it
     *   .srt  - the "# ..." comment carried under each timecode block
     *   .txt  - one quote per paragraph, or per line when there are no blanks
     *
     * Returns [{ index, text, speaker, title, speakerRaw }]. `meta` is filled
     * in with what was found, so the panel can say "the column is there but
     * empty" rather than the useless "no names".
     */
    function parseQuotesFile(file, warnings, meta, guests) {
        meta = meta || {};
        meta.speakerColumn = -1;
        meta.titleColumn = -1;
        meta.speakerHeader = "";
        meta.titleHeader = "";
        meta.named = 0;
        meta.guests = guests || [];
        meta.guestFile = "";
        meta.unresolved = [];
        return parseQuotesBody(file, warnings, meta, guests);
    }

    function parseQuotesBody(file, warnings, meta, guests) {
        if (!file.open("r")) {
            warnings.push("Could not open the quotes file: " + file.fsName);
            return [];
        }
        var raw = file.read();
        file.close();
        raw = raw.replace(/^\uFEFF/, "");

        var texts = [], speakers = [], titles = [], i;
        var ext = extOf(file.name);

        if (ext === "csv" || ext === "tsv") {
            var rows = parseCSVText(ext === "tsv" ? raw.replace(/\t/g, ",") : raw);
            if (rows.length === 0) { return []; }

            var sCol = headerColumn(rows, SPEAKER_HEADS, -1);
            var tCol = headerColumn(rows, TITLE_HEADS, sCol);
            meta.speakerColumn = sCol;
            meta.titleColumn = tCol;
            if (sCol >= 0) { meta.speakerHeader = trim(rows[0][sCol]); }
            if (tCol >= 0) { meta.titleHeader = trim(rows[0][tCol]); }

            var col = pickTextColumn(rows, [sCol, tCol]);
            var start = 1;
            var head = rows[0].length > col ? trim(rows[0][col]) : "";
            var bodyLen = 0, bodyN = 0;
            for (i = 1; i < rows.length; i++) {
                if (rows[i].length > col) { bodyLen += trim(rows[i][col]).length; bodyN++; }
            }
            var avg = bodyN ? bodyLen / bodyN : 0;
            if (head !== "" && avg > 0 && head.length >= avg * 0.6) {
                start = 0;                                   // no header after all
            }
            // a recognised heading settles it: row 0 IS the header
            if (sCol >= 0 || tCol >= 0) { start = 1; }

            for (i = start; i < rows.length; i++) {
                if (rows[i].length > col) {
                    var v = trim(rows[i][col]);
                    if (v !== "") {
                        texts.push(v);
                        speakers.push(sCol >= 0 && rows[i].length > sCol ? trim(rows[i][sCol]) : "");
                        titles.push(tCol >= 0 && rows[i].length > tCol ? trim(rows[i][tCol]) : "");
                    }
                }
            }
        } else if (ext === "srt") {
            // only the "# ..." lines sitting inside a timecode block count -
            // a header comment at the top of the file is not a quote
            var lines = raw.split(/\n/);
            var inBlock = false;
            for (i = 0; i < lines.length; i++) {
                var L = trim(lines[i]);
                if (L === "") { inBlock = false; continue; }
                if (RANGE_SPLIT.test(L) && /\d{1,3}:\d{1,2}/.test(L)) { inBlock = true; continue; }
                if (!inBlock || L.charAt(0) !== "#") { continue; }
                var body = trim(L.substring(1));
                if (body !== "") { texts.push(body); }
            }
            if (texts.length === 0) {
                warnings.push("No \"# quote text\" lines found inside the timecode blocks of " +
                              file.name + ".");
            }
        } else {
            var paras = raw.split(/\n\s*\n/);
            if (paras.length < 2) { paras = raw.split(/\n/); }
            for (i = 0; i < paras.length; i++) {
                var p = trim(paras[i].replace(/\n/g, " "));
                if (p === "" || p.charAt(0) === "#") { continue; }
                texts.push(p);
            }
        }

        // The roster turns "2" into a name and a title, so nobody retypes a
        // long Arabic name and job description nine times over.
        if (!guests) {
            var gFile = findGuestFile(file);
            if (gFile) {
                guests = readGuestFile(gFile, warnings);
                meta.guestFile = gFile.name;
            } else {
                guests = [];
            }
        }
        meta.guests = guests;

        var quotes = [];
        for (i = 0; i < texts.length; i++) {
            var rawSpeaker = (i < speakers.length) ? speakers[i] : "";
            var rawTitle = (i < titles.length) ? titles[i] : "";
            var who = resolveSpeaker(rawSpeaker, guests);
            var name = who ? who.name : "";
            var title = rawTitle !== "" ? rawTitle : (who ? who.title : "");
            if (who && who.why) {
                meta.unresolved.push("Quote " + (i + 1) + ": " + who.why);
            }
            if (name !== "") { meta.named++; }
            quotes.push({
                index: i + 1, text: texts[i],
                speaker: name, title: title, speakerRaw: rawSpeaker
            });
        }
        return quotes;
    }

    // --------------------------------------------------- template inspection

    function listFootageLayers(comp) {
        var out = [];
        for (var i = 1; i <= comp.numLayers; i++) {
            if (isSwappableLayer(comp.layer(i))) { out.push(comp.layer(i)); }
        }
        return out;
    }

    function listTextLayers(comp) {
        var out = [];
        for (var i = 1; i <= comp.numLayers; i++) {
            if (comp.layer(i) instanceof TextLayer) { out.push(comp.layer(i)); }
        }
        return out;
    }

    /** The words currently on a text layer, or "" - used to tell them apart. */
    function layerTextValue(layer) {
        try {
            return String(layer.property("ADBE Text Properties")
                               .property("ADBE Text Document").value.text);
        } catch (e) {
            return "";
        }
    }

    /**
     * Shrinks the type until it stops overflowing its box. A quote is longer
     * than whatever the template was mocked up with, so at the template's size
     * it spills past the card. Point text has no box to fit, so it is left
     * alone and said so.
     */
    function fitTextToBox(layer, log) {
        try {
            var prop = layer.property("ADBE Text Properties").property("ADBE Text Document");
            if (prop.numKeys > 0) { return false; }
            var doc = prop.value;
            if (!doc.boxText) {
                log.push("    note: this is point text, not a text box - the line cannot " +
                         "be auto-fitted and may run long");
                return false;
            }
            var boxH = doc.boxTextSize[1];
            var startSize = doc.fontSize;
            var t = (layer.inPoint + layer.outPoint) / 2;

            for (var i = 0; i < 60; i++) {
                var rect = layer.sourceRectAtTime(t, false);
                if (rect.height <= boxH) { break; }
                var next = prop.value;
                var size = next.fontSize * 0.96;
                if (size < 6) { break; }
                next.fontSize = size;
                prop.setValue(next);
            }

            var finalSize = prop.value.fontSize;
            if (Math.abs(finalSize - startSize) > 0.01) {
                log.push("    type shrunk " + startSize.toFixed(1) + " -> " +
                         finalSize.toFixed(1) + " to fit the box");
                return true;
            }
            return false;
        } catch (e) {
            log.push("    note: could not fit the text: " + e.toString());
            return false;
        }
    }

    /** Replaces the words but keeps the font, size, colour and alignment. */
    function setLayerText(layer, str, log) {
        try {
            var prop = layer.property("ADBE Text Properties").property("ADBE Text Document");
            if (prop.numKeys > 0) {
                log.push("    note: text is keyframed, left untouched");
                return false;
            }
            var doc = prop.value;
            doc.text = str;
            prop.setValue(doc);
            return true;
        } catch (e) {
            log.push("    note: could not set text: " + e.toString());
            return false;
        }
    }


    // ------------------------------------------------- nested comp handling

    /** A layer's source, or null - text and shape layers have none. */
    function layerSource(layer) {
        try { return layer.source || null; } catch (e) { return null; }
    }

    /**
     * Walks the whole comp tree and lists every layer worth targeting, so a
     * template built out of REPLACE-FOOTAGE / REPLACE-PARAGRAPH precomps can
     * be driven from the comp you actually render.
     * Returns [{ comp, layer, index, label }] with label like "RENDER > REPLACE-FOOTAGE > guest".
     */
    function collectTargets(root, wantText) {
        var out = [], seen = {}, offered = {};
        walk(root, root.name, 0);
        return out;

        function walk(comp, path, depth) {
            if (!comp || seen[comp.id] || depth > 8) { return; }
            seen[comp.id] = true;
            for (var i = 1; i <= comp.numLayers; i++) {
                var L = comp.layer(i);
                var isText = (L instanceof TextLayer);

                // A template can leave a slot as an EMPTY comp waiting to be
                // filled - REPLACE-ALPHA-FOOTAGE is exactly that. There is no
                // layer to replace, so offer the comp itself and add one.
                var nested = layerSource(L);
                if (!wantText && nested instanceof CompItem &&
                    nested.numLayers === 0 && !offered[nested.id]) {
                    offered[nested.id] = true;
                    out.push({
                        comp: nested, layer: null, index: 0, sample: "", isEmpty: true,
                        name: nested.name,
                        label: path + "  >  " + nested.name +
                               "   (EMPTY comp - the clip gets added here)"
                    });
                }

                if (wantText ? isText : isSwappableLayer(L)) {
                    var where = (comp === root ? "" : path + "  >  ") + L.index + ": " + L.name;
                    var sample = isText ? layerTextValue(L) : "";
                    out.push({
                        comp: comp, layer: L, index: L.index, sample: sample, isEmpty: false,
                        name: L.name,
                        label: where + (sample !== ""
                            ? "   -   \"" + (sample.length > 42
                                ? sample.substring(0, 42) + "..." : sample) + "\""
                            : "")
                    });
                }
                var src = layerSource(L);
                if (src instanceof CompItem) { walk(src, path + "  >  " + src.name, depth + 1); }
            }
        }
    }

    /**
     * Which comps in root's tree lead to one of the targets. Only these need a
     * private copy per card; everything else can stay shared, which keeps the
     * Project panel from exploding.
     */
    function compsLeadingTo(root, targetIds) {
        var verdict = {};
        visit(root);
        return verdict;

        function visit(comp) {
            if (verdict[comp.id] !== undefined) { return verdict[comp.id]; }
            verdict[comp.id] = false;                      // also guards re-entry
            var hit = targetIds[comp.id] === true;
            for (var i = 1; i <= comp.numLayers; i++) {
                var src = layerSource(comp.layer(i));
                if (src instanceof CompItem && visit(src)) { hit = true; }
            }
            verdict[comp.id] = hit;
            return hit;
        }
    }

    /**
     * Duplicates a comp AND the nested comps named in cloneIds, relinking each
     * copy to its own children. Without this, duplicating the outer comp leaves
     * every card sharing the same precomps - change one card, change them all.
     * `mapping` comes back filled in as original item id -> its clone.
     */
    function deepDuplicate(comp, cloneIds, mapping, suffix) {
        if (mapping[comp.id]) { return mapping[comp.id]; }
        var clone = comp.duplicate();
        if (suffix) { clone.name = comp.name + " " + suffix; }
        mapping[comp.id] = clone;
        for (var i = 1; i <= clone.numLayers; i++) {
            var L = clone.layer(i);
            var src = layerSource(L);
            if (!(src instanceof CompItem) || !cloneIds[src.id]) { continue; }
            L.replaceSource(deepDuplicate(src, cloneIds, mapping, suffix), false);
        }
        return clone;
    }

    /** Every comp clone made during one deepDuplicate pass. */
    function mappedClones(mapping) {
        var out = [];
        for (var k in mapping) {
            if (mapping.hasOwnProperty(k)) { out.push(mapping[k]); }
        }
        return out;
    }


    // ------------------------------------------- landing a clip in its slot

    /**
     * A placeholder trimmed deep into a long clip leaves the layer reading far
     * into its source - often more than an hour in. Swapping the source keeps
     * that offset, so the new clip is read past its own end and the card
     * renders BLACK. Point the layer back at the clip's beginning.
     */
    function resetClipTiming(layer, comp, log) {
        try {
            if (layer.timeRemapEnabled) {
                log.push("    note: time remapping is on, timing left alone");
                return false;
            }
            var wasStart = layer.startTime;
            var wasIn = layer.inPoint;
            layer.startTime = 0;
            layer.inPoint = 0;
            var srcDur = (layer.source && layer.source.duration) ? layer.source.duration : comp.duration;
            layer.outPoint = Math.min(srcDur, comp.duration);
            log.push("    timing reset: startTime " + wasStart.toFixed(2) + "s -> 0, " +
                     "in " + wasIn.toFixed(2) + "s -> 0, showing 0 - " + layer.outPoint.toFixed(2) + "s");
            return true;
        } catch (e) {
            log.push("    note: could not reset timing: " + e.toString());
            return false;
        }
    }

    /** Scales the clip to cover its comp, so a 1080p clip fills a 4K slot. */
    function fitToComp(layer, comp, log) {
        try {
            var scale = layer.property("ADBE Transform Group").property("ADBE Scale");
            if (scale.numKeys > 0) {
                log.push("    note: scale is keyframed, framing left alone");
                return false;
            }
            var src = layer.source;
            if (!src || !src.width || !src.height) { return false; }
            if (src.width === comp.width && src.height === comp.height) { return false; }
            var f = Math.max(comp.width / src.width, comp.height / src.height) * 100;
            scale.setValue([f, f]);
            log.push("    fitted " + src.width + "x" + src.height + " into " +
                     comp.width + "x" + comp.height + " at " + f.toFixed(1) + "%");
            return true;
        } catch (e) {
            log.push("    note: could not fit the clip: " + e.toString());
            return false;
        }
    }


    // ---------------------------------------------------------- diagnostics

    function alphaModeName(mode) {
        try {
            if (mode === AlphaMode.IGNORE) { return "IGNORE (alpha thrown away)"; }
            if (mode === AlphaMode.STRAIGHT) { return "STRAIGHT"; }
            if (mode === AlphaMode.PREMULTIPLIED) { return "PREMULTIPLIED"; }
        } catch (e) {}
        return "unknown";
    }

    function layerKind(L) {
        try {
            if (L instanceof TextLayer) { return "TEXT"; }
            if (L instanceof ShapeLayer) { return "SHAPE"; }
            if (L instanceof CameraLayer) { return "CAMERA"; }
            if (L instanceof LightLayer) { return "LIGHT"; }
            if (L.nullLayer) { return "NULL"; }
            if (L.adjustmentLayer) { return "ADJUSTMENT"; }
            if (L instanceof AVLayer) { return "AV"; }
        } catch (e) {}
        return "?";
    }

    function propText(layer, groupName, propName) {
        try {
            var p = layer.property(groupName).property(propName);
            var v = p.value;
            var txt = (v instanceof Array) ? "[" + v.join(", ") + "]" : String(v);
            return txt + (p.numKeys > 0 ? "  (" + p.numKeys + " keys)" : "");
        } catch (e) {
            return "-";
        }
    }

    function effectNames(layer) {
        try {
            var fx = layer.property("ADBE Effect Parade"), names = [];
            for (var i = 1; i <= fx.numProperties; i++) { names.push(fx.property(i).name); }
            return names.length ? names.join(", ") : "none";
        } catch (e) {
            return "none";
        }
    }

    function matteName(layer) {
        try {
            if (!layer.trackMatteType || layer.trackMatteType === TrackMatteType.NO_TRACK_MATTE) {
                return "none";
            }
            var t = layer.trackMatteType;
            if (t === TrackMatteType.ALPHA) { return "ALPHA"; }
            if (t === TrackMatteType.ALPHA_INVERTED) { return "ALPHA INVERTED"; }
            if (t === TrackMatteType.LUMA) { return "LUMA"; }
            if (t === TrackMatteType.LUMA_INVERTED) { return "LUMA INVERTED"; }
            return "set";
        } catch (e) {
            return "none";
        }
    }

    /**
     * Writes out everything about a comp tree that could explain a card coming
     * out black or uncut: layer timing, source dimensions, how each clip's
     * alpha is interpreted, masks, effects and track mattes.
     */
    function describeTree(root, out, depth, seen) {
        var pad4 = "";
        for (var d = 0; d < depth; d++) { pad4 += "    "; }
        if (seen[root.id]) {
            out.push(pad4 + "COMP \"" + root.name + "\"  (already described above)");
            return;
        }
        seen[root.id] = true;

        out.push(pad4 + "COMP \"" + root.name + "\"   " + root.width + "x" + root.height +
                 "   " + root.duration.toFixed(2) + "s @ " + root.frameRate + "fps   " +
                 root.numLayers + " layers");

        for (var i = 1; i <= root.numLayers; i++) {
            var L = root.layer(i);
            var kind = layerKind(L);
            var head = pad4 + "  [" + L.index + "] " + kind + "  \"" + L.name + "\"" +
                       (L.enabled ? "" : "   (EYE OFF)");
            out.push(head);

            var src = layerSource(L);
            if (src instanceof CompItem) {
                out.push(pad4 + "      source: comp \"" + src.name + "\"");
            } else if (src) {
                var line = pad4 + "      source: " + src.name + "   " + src.width + "x" + src.height;
                try { line += "   " + src.duration.toFixed(2) + "s"; } catch (e) {}
                out.push(line);
                try {
                    var ms = src.mainSource;
                    out.push(pad4 + "      alpha:  hasAlpha=" + ms.hasAlpha +
                             "   mode=" + alphaModeName(ms.alphaMode) +
                             "   inverted=" + ms.invertAlpha);
                } catch (e2) {
                    out.push(pad4 + "      alpha:  (not a file source)");
                }
            }

            if (kind === "AV" || kind === "TEXT" || kind === "SHAPE" || kind === "ADJUSTMENT") {
                try {
                    out.push(pad4 + "      time:   start=" + L.startTime.toFixed(2) +
                             "  in=" + L.inPoint.toFixed(2) + "  out=" + L.outPoint.toFixed(2) +
                             "  remap=" + (L.timeRemapEnabled ? "ON" : "off"));
                } catch (e3) {}
                out.push(pad4 + "      xform:  pos=" + propText(L, "ADBE Transform Group", "ADBE Position") +
                         "  scale=" + propText(L, "ADBE Transform Group", "ADBE Scale") +
                         "  opacity=" + propText(L, "ADBE Transform Group", "ADBE Opacity"));
                out.push(pad4 + "      masks=" + countMasks(L) +
                         "   trackMatte=" + matteName(L) +
                         "   effects: " + effectNames(L));
                if (kind === "TEXT") {
                    var words = layerTextValue(L);
                    var boxInfo = "";
                    try {
                        var doc = L.property("ADBE Text Properties").property("ADBE Text Document").value;
                        boxInfo = "   " + (doc.boxText
                            ? "BOX " + doc.boxTextSize[0] + "x" + doc.boxTextSize[1]
                            : "POINT TEXT (cannot auto-fit)") + "   size=" + doc.fontSize;
                    } catch (e4) {}
                    out.push(pad4 + "      text:   \"" +
                             (words.length > 60 ? words.substring(0, 60) + "..." : words) +
                             "\"" + boxInfo);
                }
            }
            try { if (L.parent) { out.push(pad4 + "      parent: " + L.parent.index + " " + L.parent.name); } } catch (e5) {}

            if (src instanceof CompItem && depth < 6) { describeTree(src, out, depth + 2, seen); }
        }
    }

    /**
     * How a clip's alpha channel is read. Forcing STRAIGHT on a clip that was
     * exported premultiplied is what puts a white fringe around the guest, so
     * the default is to let After Effects work it out.
     *
     *   "auto"          - AE guesses (only touched when it imported as Ignore)
     *   "straight"      - unmatted alpha
     *   "premul-white"  - matted with white  (a white halo means this one)
     *   "premul-black"  - matted with black  (a dark halo means this one)
     */
    function applyAlphaMode(item, choice, log) {
        try {
            var ms = item.mainSource;
            if (!ms.hasAlpha) { return false; }
            var before = alphaModeName(ms.alphaMode);

            if (choice === "straight") {
                ms.alphaMode = AlphaMode.STRAIGHT;
            } else if (choice === "premul-white") {
                ms.alphaMode = AlphaMode.PREMULTIPLIED;
                ms.premulColor = [1, 1, 1];
            } else if (choice === "premul-black") {
                ms.alphaMode = AlphaMode.PREMULTIPLIED;
                ms.premulColor = [0, 0, 0];
            } else {
                if (ms.alphaMode !== AlphaMode.IGNORE) { return false; }
                try { ms.guessAlphaMode(); }
                catch (eg) { ms.alphaMode = AlphaMode.STRAIGHT; }
            }

            var after = alphaModeName(ms.alphaMode);
            if (after !== before) {
                log.push("    alpha interpretation: " + before + "  ->  " + after);
                return true;
            }
            return false;
        } catch (e) {
            log.push("    note: could not set the alpha interpretation: " + e.toString());
            return false;
        }
    }


    /**
     * Writes a text file and confirms something actually landed in it. With
     * "Allow Scripts to Write Files" off, After Effects creates the file and
     * then writes nothing - handing back an empty file that looks like a
     * successful run. Returns the path, or "" with the reason pushed onto
     * `problems`.
     */
    function writeTextFile(file, text, problems) {
        try {
            if (!file.open("w")) {
                problems.push("Could not create " + file.fsName);
                return "";
            }
            file.encoding = "UTF-8";
            file.write(text);
            file.close();
            if (file.length === 0 && text.length > 0) {
                problems.push("Nothing could be written to " + file.name + ". Turn on " +
                              "Preferences (Settings) > Scripting & Expressions > " +
                              "\"Allow Scripts to Write Files and Access Network\", then run again.");
                return "";
            }
            return file.fsName;
        } catch (e) {
            problems.push("Could not write " + file.name + ": " + e.toString());
            return "";
        }
    }


    /**
     * Puts a clip where the chosen target says. A normal target swaps the
     * layer's source; an empty-comp target gets a new layer added, because
     * that is how a template hands you a slot with nothing in it yet.
     */
    function placeClip(target, destComp, footage, log) {
        if (target.isEmpty) {
            var added = destComp.layers.add(footage);
            log.push("    added \"" + footage.name + "\" into the empty comp \"" +
                     destComp.name + "\"");
            return added;
        }
        var layer = destComp.layer(target.index);
        layer.replaceSource(footage, false);
        return layer;
    }


    // ------------------------------------------- switching to the alpha path

    /**
     * Roto Brush (internally "Samurai") holds strokes painted onto one
     * specific clip. Swap the footage and the strokes are meaningless, so a
     * template that cuts its guest out this way cannot follow a new clip.
     * Nothing can script that - the strokes have to be turned off and a
     * ready-made cut-out used instead.
     */
    var ROTO_HINTS = "samurai,roto";

    function disableRotoEffects(layer, log) {
        var n = 0;
        try {
            var fx = layer.property("ADBE Effect Parade");
            for (var i = 1; i <= fx.numProperties; i++) {
                var e = fx.property(i);
                var mn = "", nm = "";
                try { mn = normalize(e.matchName); } catch (x1) {}
                try { nm = normalize(e.name); } catch (x2) {}
                var hits = ROTO_HINTS.split(",");
                var match = false;
                for (var h = 0; h < hits.length; h++) {
                    var want = normalize(hits[h]);
                    if (mn.indexOf(want) !== -1 || nm.indexOf(want) !== -1) { match = true; break; }
                }
                if (!match && nm.indexOf("objectmatte") !== -1) { match = true; }
                if (match && e.enabled) {
                    e.enabled = false;
                    n++;
                    log.push("    turned off \"" + e.name + "\" - its Roto Brush strokes were " +
                             "painted on the template's own clip and mean nothing on yours");
                }
            }
        } catch (e2) {
            log.push("    note: could not check for Roto Brush: " + e2.toString());
        }
        return n;
    }

    /**
     * A template usually ships its alpha route switched off. Once a cut-out
     * clip is dropped in, the layers showing it have to be turned back on or
     * nothing changes on screen.
     */
    function enableLayersShowing(root, targetComp, log) {
        var count = 0, seen = {};
        walk(root, 0);
        if (count > 0) {
            log.push("    switched on " + count + " layer(s) showing \"" + targetComp.name + "\"");
        }
        return count;

        function walk(comp, depth) {
            if (!comp || seen[comp.id] || depth > 8) { return; }
            seen[comp.id] = true;
            for (var i = 1; i <= comp.numLayers; i++) {
                var L = comp.layer(i);
                var src = layerSource(L);
                if (src === targetComp && !L.enabled) { L.enabled = true; count++; }
                if (src instanceof CompItem) { walk(src, depth + 1); }
            }
        }
    }

    // ------------------------------------------------------------ AE helpers

    function listComps() {
        var comps = [];
        for (var i = 1; i <= app.project.numItems; i++) {
            var it = app.project.item(i);
            if (it instanceof CompItem) { comps.push(it); }
        }
        return comps;
    }

    function findExistingFootage(file) {
        for (var i = 1; i <= app.project.numItems; i++) {
            var it = app.project.item(i);
            if (!(it instanceof FootageItem)) { continue; }
            var src = it.mainSource;
            if (src instanceof FileSource && src.file && src.file.fsName === file.fsName) {
                return it;
            }
        }
        return null;
    }

    function importFootage(file, cache, warnings) {
        var key = file.fsName;
        if (cache[key]) { return cache[key]; }
        var existing = findExistingFootage(file);
        if (existing) { cache[key] = existing; return existing; }
        try {
            var io = new ImportOptions(file);
            if (io.canImportAs(ImportAsType.FOOTAGE)) { io.importAs = ImportAsType.FOOTAGE; }
            var item = app.project.importFile(io);
            cache[key] = item;
            return item;
        } catch (e) {
            warnings.push("Could not import " + file.name + ": " + e.toString());
            return null;
        }
    }

    /** Is this a real footage layer we are allowed to swap? */
    function isSwappableLayer(layer) {
        if (!(layer instanceof AVLayer)) { return false; }
        if (layer.nullLayer || layer.adjustmentLayer || layer.guideLayer) { return false; }
        if (!layer.hasVideo) { return false; }
        var src = layer.source;
        if (!(src instanceof FootageItem)) { return false; }
        if (!(src.mainSource instanceof FileSource)) { return false; }
        if (src.mainSource.file && !isVideoFile(src.mainSource.file)) {
            // still images are valid targets, but a video swap onto a stills
            // layer is almost always a mistake - allow it, just note it.
            return true;
        }
        return true;
    }

    /** Topmost swappable layer that is live at time t. */
    function layerAtTime(comp, t, skipMattes) {
        for (var i = 1; i <= comp.numLayers; i++) {
            var L = comp.layer(i);
            if (!L.enabled) { continue; }
            if (skipMattes && L.comment && L.comment.indexOf("PersonReplacer:matte") === 0) { continue; }
            if (!isSwappableLayer(L)) { continue; }
            if (t >= L.inPoint - TOL && t < L.outPoint - TOL) { return L; }
        }
        return null;
    }

    function addEffect(layer, matchName) {
        try {
            return layer.property("ADBE Effect Parade").addProperty(matchName);
        } catch (e) {
            return null;
        }
    }

    function disableMasks(layer) {
        try {
            var masks = layer.property("ADBE Mask Parade");
            for (var i = 1; i <= masks.numProperties; i++) {
                masks.property(i).maskMode = MaskMode.NONE;
            }
        } catch (e) { /* no masks */ }
    }

    function countMasks(layer) {
        try { return layer.property("ADBE Mask Parade").numProperties; }
        catch (e) { return 0; }
    }

    /**
     * Splits a layer so that only [inSec, outSec] is isolated, returning the
     * middle piece. The head and tail keep the original footage, so a single
     * long layer can carry several different people.
     */
    function isolateRange(layer, inSec, outSec) {
        var mid = layer;
        if (mid.inPoint < inSec - TOL) {
            var head = mid.duplicate();
            head.outPoint = inSec;
            mid.inPoint = inSec;
        }
        if (mid.outPoint > outSec + TOL) {
            var tail = mid.duplicate();
            tail.inPoint = outSec;
            mid.outPoint = outSec;
        }
        return mid;
    }

    /**
     * Builds the refine-ready matte: duplicates the swapped layer directly
     * above itself as a dedicated matte layer (masks intact, plus a Simple
     * Choker and a blur for edge feathering) and alpha-mattes the layer below.
     * The lower layer keeps its masks but their mode is set to None, so the
     * matte layer is the single place you refine the cut-out.
     */
    function buildMatteSetup(layer, log) {
        var matte = layer.duplicate();           // lands directly above `layer`
        matte.name = layer.name + " [MATTE]";
        matte.comment = "PersonReplacer:matte - refine the cut-out here (masks / Roto Brush). " +
                        "It alpha-mattes the layer below.";
        try { matte.label = 11; } catch (e) {}

        try {
            var fx = matte.property("ADBE Effect Parade");
            while (fx.numProperties > 0) { fx.property(1).remove(); }
        } catch (e) {}

        if (!addEffect(matte, "ADBE Simple Choker")) {
            log.push("    note: could not add Simple Choker (effect unavailable)");
        }
        if (!addEffect(matte, "ADBE Box Blur2")) {
            addEffect(matte, "ADBE Fast Blur");
        }

        disableMasks(layer);
        try {
            if (typeof layer.setTrackMatte === "function") {
                layer.setTrackMatte(matte, TrackMatteType.ALPHA);   // AE 2023+
            } else {
                layer.trackMatteType = TrackMatteType.ALPHA;        // legacy
            }
        } catch (e) {
            try { layer.trackMatteType = TrackMatteType.ALPHA; }
            catch (e2) { log.push("    note: could not set alpha track matte: " + e2.toString()); }
        }
        return matte;
    }

    function compensateScale(layer, oldW, oldH, log) {
        try {
            var scale = layer.property("ADBE Transform Group").property("ADBE Scale");
            if (scale.numKeys > 0) {
                log.push("    note: scale is keyframed, left untouched");
                return;
            }
            var newW = layer.source.width, newH = layer.source.height;
            if (!newW || !newH || (newW === oldW && newH === oldH)) { return; }
            var v = scale.value;
            v[0] = v[0] * (oldW / newW);
            v[1] = v[1] * (oldH / newH);
            scale.setValue(v);
            log.push("    scale compensated " + oldW + "x" + oldH + " -> " + newW + "x" + newH);
        } catch (e) {
            log.push("    note: scale compensation failed: " + e.toString());
        }
    }

    // ------------------------------------------------------------- discovery

    var FOLDER_HINTS = "videos,video,footage,persons,people,person,clips,talent,media,source,sources";
    var SCRIPT_EXT = "srt,txt";

    function isHintFolder(folder) {
        var n = normalize(folder.name);
        var hints = FOLDER_HINTS.split(",");
        for (var i = 0; i < hints.length; i++) {
            if (n === normalize(hints[i])) { return true; }
        }
        return false;
    }

    function folderHasVideos(folder) {
        var items = folder.getFiles();
        if (!items) { return false; }
        for (var i = 0; i < items.length; i++) {
            if (!(items[i] instanceof Folder) && isVideoFile(items[i])) { return true; }
        }
        return false;
    }

    /** Folders we are willing to start looking from, best guess first. */
    function startFolders() {
        var roots = [], seen = {};
        function push(f) {
            if (!f || !f.exists) { return; }
            if (seen[f.fsName]) { return; }
            seen[f.fsName] = true;
            roots.push(f);
        }
        try { if (app.project.file) { push(app.project.file.parent); } } catch (e) {}
        try { push(new File($.fileName).parent); } catch (e) {}
        try { if (app.project.file) { push(app.project.file.parent.parent); } } catch (e) {}
        return roots;
    }

    /** Depth-limited hunt for the folder holding the person clips. */
    function findVideosFolder(roots) {
        var i, best = null;
        // pass 1: a subfolder named like a videos folder that actually has clips
        for (i = 0; i < roots.length; i++) {
            best = hunt(roots[i], 0, true);
            if (best) { return best; }
        }
        // pass 2: any folder with clips in it
        for (i = 0; i < roots.length; i++) {
            best = hunt(roots[i], 0, false);
            if (best) { return best; }
        }
        return null;

        function hunt(folder, depth, requireHint) {
            if (!folder || !folder.exists || depth > 3) { return null; }
            if (depth > 0 && folderHasVideos(folder)) {
                if (!requireHint || isHintFolder(folder)) { return folder; }
            }
            if (depth === 0 && !requireHint && folderHasVideos(folder)) { return folder; }
            var items = folder.getFiles();
            if (!items) { return null; }
            for (var k = 0; k < items.length; k++) {
                if (!(items[k] instanceof Folder)) { continue; }
                if (items[k].name.charAt(0) === ".") { continue; }
                var hit = hunt(items[k], depth + 1, requireHint);
                if (hit) { return hit; }
            }
            return null;
        }
    }

    /**
     * Finds the timecode script. When several candidates exist the one that
     * parses into the most usable segments wins, so a stray readme.txt loses
     * to a real script every time.
     */
    function findScriptFile(roots, fps) {
        var candidates = [], seen = {};
        for (var i = 0; i < roots.length; i++) { collect(roots[i], 0); }

        var best = null, bestCount = 0;
        for (var c = 0; c < candidates.length; c++) {
            var warn = [];
            var segs = parseScript(candidates[c], fps, warn);
            var score = segs.length;
            if (extOf(candidates[c].name) === "srt") { score += 0.5; }
            if (score > bestCount) { bestCount = score; best = candidates[c]; }
        }
        return bestCount >= 1 ? best : null;

        function collect(folder, depth) {
            if (!folder || !folder.exists || depth > 3) { return; }
            var items = folder.getFiles();
            if (!items) { return; }
            for (var k = 0; k < items.length; k++) {
                var it = items[k];
                if (it instanceof Folder) {
                    if (it.name.charAt(0) !== ".") { collect(it, depth + 1); }
                    continue;
                }
                if ((","+ SCRIPT_EXT + ",").indexOf("," + extOf(it.name) + ",") === -1) { continue; }
                if (/_replace_log\.txt$/i.test(it.name)) { continue; }   // our own log
                if (seen[it.fsName]) { continue; }
                seen[it.fsName] = true;
                candidates.push(it);
            }
        }
    }

    /** Active comp, else the busiest comp in the project. */
    function pickComp() {
        var active = app.project.activeItem;
        if (active instanceof CompItem) { return active; }
        var comps = listComps(), best = null;
        for (var i = 0; i < comps.length; i++) {
            if (!best || comps[i].numLayers > best.numLayers) { best = comps[i]; }
        }
        return best;
    }

    // ------------------------------------------------------------------- run

    function discover() {
        var ctx = { comp: null, folder: null, script: null, plan: [], warnings: [], files: [] };

        ctx.comp = pickComp();
        if (!ctx.comp) {
            ctx.warnings.push("No composition in this project. Open your comp first.");
            return ctx;
        }

        var roots = startFolders();
        if (roots.length === 0) {
            ctx.warnings.push("Save your After Effects project first, so the script knows where to look.");
            return ctx;
        }

        ctx.folder = findVideosFolder(roots);
        ctx.script = findScriptFile(roots, ctx.comp.frameRate);
        if (ctx.folder) { scanVideos(ctx.folder, ctx.files, 0); }
        if (ctx.folder && ctx.script) { buildPlan(ctx); }
        return ctx;
    }

    function buildPlan(ctx) {
        ctx.plan = [];
        var segments = parseScript(ctx.script, ctx.comp.frameRate, ctx.warnings);
        for (var i = 0; i < segments.length; i++) {
            var seg = segments[i];
            var file = pickFile(seg.person, seg.explicitFile, ctx.files);
            var mid = (seg.inSec + seg.outSec) / 2;
            var layer = layerAtTime(ctx.comp, mid, true);
            ctx.plan.push({
                index: i + 1, seg: seg, file: file, layer: layer,
                ok: !!(file && layer)
            });
            if (!file) {
                ctx.warnings.push("No clip matched \"" + seg.person + "\" at " +
                                  secondsToTC(seg.inSec, ctx.comp.frameRate));
            } else if (!layer) {
                ctx.warnings.push("No footage layer live at " +
                                  secondsToTC(mid, ctx.comp.frameRate) +
                                  " for \"" + seg.person + "\"");
            }
        }
    }

    function readyCount(plan) {
        var n = 0;
        for (var i = 0; i < plan.length; i++) { if (plan[i].ok) { n++; } }
        return n;
    }

    function applyPlan(ctx, options) {
        var comp = ctx.comp;
        var log = [];
        log.push(SCRIPT_NAME + " (auto) - " + new Date().toString());
        log.push("Comp: " + comp.name + "  (" + comp.frameRate + " fps)");
        log.push("Videos: " + ctx.folder.fsName);
        log.push("Script: " + ctx.script.fsName);
        log.push("");

        var cache = {}, applied = 0, skipped = 0;

        app.beginUndoGroup(SCRIPT_NAME + " - replace people");
        try {
            // last-to-first, so splitting an earlier segment cannot shift a
            // layer we already resolved for a later one
            for (var i = ctx.plan.length - 1; i >= 0; i--) {
                var row = ctx.plan[i], seg = row.seg;
                var tag = "[" + row.index + "] " + secondsToTC(seg.inSec, comp.frameRate) +
                          " -> " + secondsToTC(seg.outSec, comp.frameRate) + "  " + seg.person;

                if (!row.ok) {
                    log.push(tag + "  SKIPPED (" +
                             (!row.file ? "no matching clip" : "no layer at that timecode") + ")");
                    skipped++;
                    continue;
                }
                var footage = importFootage(row.file, cache, ctx.warnings);
                if (!footage) { log.push(tag + "  SKIPPED (import failed)"); skipped++; continue; }

                var mid = (seg.inSec + seg.outSec) / 2;
                var target = layerAtTime(comp, mid, true);
                if (!target) {
                    log.push(tag + "  SKIPPED (layer no longer live at that timecode)");
                    skipped++;
                    continue;
                }

                var oldName = target.name;
                var oldSrcName = target.source ? target.source.name : "?";
                var oldW = target.source ? target.source.width : 0;
                var oldH = target.source ? target.source.height : 0;
                var maskCount = countMasks(target);

                if (options.split) { target = isolateRange(target, seg.inSec, seg.outSec); }
                target.replaceSource(footage, false);

                log.push(tag);
                log.push("    layer " + target.index + ": " + oldName + "   " +
                         oldSrcName + "  ->  " + row.file.name);
                log.push("    masks preserved: " + maskCount);

                if (options.scale) { compensateScale(target, oldW, oldH, log); }
                if (options.matte) {
                    if (maskCount === 0) {
                        log.push("    note: no masks here - draw the cut-out on the [MATTE] layer");
                    }
                    var matte = buildMatteSetup(target, log);
                    log.push("    matte layer created: " + matte.name);
                }
                applied++;
            }
        } catch (e) {
            ctx.warnings.push("Aborted: " + e.toString() + (e.line ? " (line " + e.line + ")" : ""));
        }
        app.endUndoGroup();

        log.push("");
        log.push("Applied: " + applied + "   Skipped: " + skipped);
        if (ctx.warnings.length) {
            log.push("");
            log.push("Warnings:");
            for (var w = 0; w < ctx.warnings.length; w++) { log.push("  - " + ctx.warnings[w]); }
        }

        var logPath = "";
        try {
            var out = new File(ctx.script.parent.fsName + "/" +
                               baseName(ctx.script.name) + "_replace_log.txt");
            if (out.open("w")) { out.write(log.join("\n")); out.close(); logPath = out.fsName; }
        } catch (e2) {}

        return { applied: applied, skipped: skipped, logPath: logPath };
    }

    // -------------------------------------------------------------------- UI

    function showReport(ctx) {
        var dlg = new Window("dialog", SCRIPT_NAME, undefined, { resizeable: true });
        dlg.orientation = "column";
        dlg.alignChildren = ["fill", "top"];
        dlg.margins = 16;
        dlg.spacing = 10;

        var head = dlg.add("statictext", undefined, "What I found");
        try { head.graphics.font = ScriptUI.newFont(head.graphics.font.name, "BOLD", 15); } catch (e) {}

        var info = dlg.add("panel");
        info.orientation = "column";
        info.alignChildren = ["left", "top"];
        info.margins = [14, 14, 14, 12];
        info.spacing = 3;

        function line(label, value, ok) {
            var g = info.add("group");
            g.orientation = "row";
            g.spacing = 6;
            var mark = g.add("statictext", undefined, ok ? "OK" : "--");
            mark.preferredSize.width = 26;
            var l = g.add("statictext", undefined, label);
            l.preferredSize.width = 96;
            g.add("statictext", undefined, value);
        }

        line("Comp:", ctx.comp ? (ctx.comp.name + "   (" + ctx.comp.frameRate + " fps)") : "not found", !!ctx.comp);
        line("Videos folder:", ctx.folder ? (ctx.folder.fsName + "   (" + ctx.files.length + " clips)") : "not found", !!ctx.folder);
        line("Script file:", ctx.script ? ctx.script.fsName : "not found", !!ctx.script);

        var ready = readyCount(ctx.plan);

        var list = dlg.add("listbox", undefined, [], {
            numberOfColumns: 6, showHeaders: true,
            columnTitles: ["#", "In", "Out", "Person", "Clip", "Target layer"],
            columnWidths: [28, 84, 84, 110, 180, 150]
        });
        list.preferredSize.height = 190;
        list.alignment = ["fill", "fill"];

        for (var i = 0; i < ctx.plan.length; i++) {
            var row = ctx.plan[i];
            var it = list.add("item", String(row.index));
            it.subItems[0].text = secondsToTC(row.seg.inSec, ctx.comp.frameRate);
            it.subItems[1].text = secondsToTC(row.seg.outSec, ctx.comp.frameRate);
            it.subItems[2].text = row.seg.person;
            it.subItems[3].text = row.file ? row.file.name : "-- no match --";
            it.subItems[4].text = row.layer ? (row.layer.index + ": " + row.layer.name) : "-- no layer --";
        }

        var optRow = dlg.add("group");
        optRow.orientation = "row";
        optRow.alignChildren = ["left", "center"];
        var cbSplit = optRow.add("checkbox", undefined, "Split to range");
        cbSplit.value = true;
        var cbMatte = optRow.add("checkbox", undefined, "Build matte");
        cbMatte.value = true;
        var cbScale = optRow.add("checkbox", undefined, "Fit scale");
        cbScale.value = false;

        var msg = dlg.add("statictext", undefined, "", { multiline: true });
        msg.preferredSize.height = 30;
        msg.alignment = ["fill", "top"];
        if (!ctx.comp) {
            msg.text = "Open the composition you want to work on, then run the script again.";
        } else if (!ctx.folder || !ctx.script) {
            msg.text = "Could not find " +
                (!ctx.folder && !ctx.script ? "the videos folder or the timecode script" :
                 (!ctx.folder ? "the videos folder" : "the timecode script")) +
                " near your project. Use the buttons below to point at them once.";
        } else {
            msg.text = (ctx.plan.length === 0
                ? "No timecode lines found in \"" + ctx.script.name + "\". Press \"Script file...\" " +
                  "and pick the plain-text (.txt / .srt) file with your timecodes."
                : ready + " of " + ctx.plan.length + " segments are ready to replace.") +
                (ready < ctx.plan.length ? "  The rest will be skipped and listed in the log." : "");
        }

        var btns = dlg.add("group");
        btns.orientation = "row";
        btns.alignment = ["fill", "bottom"];
        var pickFolderBtn = btns.add("button", undefined, "Videos folder...");
        var pickScriptBtn = btns.add("button", undefined, "Script file...");
        btns.add("statictext", undefined, "  ");
        var cancelBtn = btns.add("button", undefined, "Cancel", { name: "cancel" });
        var goBtn = btns.add("button", undefined, "Replace now", { name: "ok" });
        goBtn.enabled = ready > 0;

        function refresh() {
            ctx.files = [];
            ctx.warnings = [];
            if (ctx.folder) { scanVideos(ctx.folder, ctx.files, 0); }
            if (ctx.folder && ctx.script && ctx.comp) { buildPlan(ctx); }
            dlg.close(2);   // reopened by the caller with fresh contents
        }

        pickFolderBtn.onClick = function () {
            var f = Folder.selectDialog("Where are the person videos?");
            if (f) { ctx.folder = f; refresh(); }
        };
        pickScriptBtn.onClick = function () {
            var f = File.openDialog("Where is the timecode script?");
            if (!f) { return; }
            var problem = scriptFileProblem(f);
            if (problem) { alert(problem); return; }
            ctx.script = f;
            refresh();
        };
        goBtn.onClick = function () {
            ctx.options = { split: cbSplit.value, matte: cbMatte.value, scale: cbScale.value };
            dlg.close(1);
        };
        cancelBtn.onClick = function () { dlg.close(0); };

        dlg.onResizing = dlg.onResize = function () { this.layout.resize(); };
        dlg.center();
        return dlg.show();
    }

    function runAuto() {
        var ctx = discover();
        var result = showReport(ctx);
        while (result === 2) { result = showReport(ctx); }   // user re-pointed a path
        if (result !== 1) { return; }

        var r = applyPlan(ctx, ctx.options);
        alert(SCRIPT_NAME + "\n\n" +
              "Replaced: " + r.applied + "\n" +
              "Skipped:  " + r.skipped +
              (ctx.warnings.length ? "\nWarnings: " + ctx.warnings.length : "") +
              (r.logPath ? "\n\nDetails written to:\n" + r.logPath : "") +
              "\n\nOne Ctrl/Cmd+Z undoes all of it.");
    }

    function build(thisObj) {
        if (thisObj instanceof Panel) {
            // installed as a dockable panel - wait for a click, never auto-run
            thisObj.orientation = "column";
            thisObj.alignChildren = ["fill", "top"];
            thisObj.margins = 14;
            thisObj.spacing = 8;
            var t = thisObj.add("statictext", undefined,
                "Finds your videos folder and timecode script automatically.",
                { multiline: true });
            t.preferredSize.height = 32;
            var b = thisObj.add("button", undefined, "Find and replace");
            b.onClick = runAuto;
            thisObj.layout.layout(true);
            return thisObj;
        }
        runAuto();
        return null;
    }

    build(thisObj);

})(this);
