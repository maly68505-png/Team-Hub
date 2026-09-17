/**
 * Quote Cards  -  After Effects
 * ------------------------------
 * Turns ONE template comp into a card per quote.
 *
 * Your template is a comp holding a footage layer for the speaker (masked
 * however you like) and a text layer for the quote. This builds a copy of it
 * for every quote in your list, swapping in the right clip and setting the
 * text, while keeping the masks, effects and type styling you already have.
 *
 * Clip order decides who appears: the 1st clip in the folder goes to quote 1,
 * the 2nd to quote 2, and so on.
 *
 * HOW TO RUN IT:
 *   File > Scripts > Run Script File...   and pick this file.
 *
 * Arabic text needs the Middle Eastern text engine:
 *   Preferences > Type > Text Engine > South Asian and Middle Eastern
 *
 * GENERATED FILE - do not edit directly.
 * Edit ae/lib/core.jsxinc or ae/lib/ui-*.jsxinc, then run: node ae/build.js
 */

(function quoteCards(thisObj) {

    var SCRIPT_NAME = "Person Replacer";
    var SETTINGS_SECTION = "PersonReplacer";
    var QC_SETTINGS = "QuoteCards";
    var VIDEO_EXT = "mp4,mov,m4v,avi,mkv,mxf,webm,mpg,mpeg,wmv,mts,m2ts,r3d,braw,dv,3gp";
    var MIN_MATCH_SCORE = 2;
    var TOL = 0.0005; // seconds, float-compare tolerance

    // ---------------------------------------------------------------- utils

    function trim(s) {
        return String(s).replace(/^[\s\u00a0]+/, "").replace(/[\s\u00a0]+$/, "");
    }

    function normalize(s) {
        return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "");
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

    /** Every run of digits in a file's stem, as numbers: "Aktbas_002" -> "2". */
    function digitsOf(name) {
        var m = String(baseName(name)).match(/\d+/g);
        if (!m) { return ""; }
        var out = [];
        for (var i = 0; i < m.length; i++) { out.push(String(parseInt(m[i], 10))); }
        return out.join("-");
    }

    /**
     * Does `longS` start with `whole` at a stem boundary? A plain indexOf===0
     * lets "clip1" claim "clip10_alpha", which is the clip2-before-clip10 trap
     * wearing a different hat: the number has to end where the stem ends.
     */
    function startsWithStem(longS, whole) {
        if (whole === "" || longS.indexOf(whole) !== 0) { return false; }
        if (!/\d$/.test(whole)) { return true; }
        return !/^\d/.test(longS.charAt(whole.length));
    }

    /**
     * How well a cut-out file answers to a clip file. normalize() is no use
     * here - it strips an Arabic file name to "" and then everything matches
     * everything - so this compares the stems as they are.
     */
    function alphaMatchScore(clip, alphaFile) {
        var a = trim(baseName(clip.name)).toLowerCase();
        var b = trim(baseName(alphaFile.name)).toLowerCase();
        if (a === "" || b === "") { return 0; }
        if (a === b) { return 100; }
        // "01_dalal.mp4" -> "01_dalal_alpha.mov": one stem starts the other.
        if (startsWithStem(b, a) || startsWithStem(a, b)) { return 90; }
        // Numbering is what survives a trip through an outside keying tool.
        var da = digitsOf(clip.name), db = digitsOf(alphaFile.name);
        if (da !== "" && da === db) { return 70; }
        return 0;
    }

    /**
     * Pairs each clip with its cut-out. Position alone is how this worked, and
     * position is exactly what a trip through an external keyer destroys - the
     * files come back named after a job id, in whatever order they finished.
     * A cut-out on the wrong card is invisible until someone recognises the
     * face, so match on the name first and say plainly when that failed.
     */
    function pairAlphaClips(files, alphaFiles, warnings) {
        var used = {}, out = [], byName = 0, i, j;
        for (i = 0; i < files.length; i++) {
            var best = -1, bestScore = 0;
            for (j = 0; j < alphaFiles.length; j++) {
                if (used[j]) { continue; }
                var sc = alphaMatchScore(files[i], alphaFiles[j]);
                if (sc > bestScore) { bestScore = sc; best = j; }
            }
            if (best >= 0) { used[best] = true; out.push(alphaFiles[best]); byName++; }
            else { out.push(null); }
        }
        var spare = [];
        for (j = 0; j < alphaFiles.length; j++) { if (!used[j]) { spare.push(alphaFiles[j]); } }
        var next = 0, byPosition = 0;
        for (i = 0; i < out.length; i++) {
            if (out[i] === null && next < spare.length) { out[i] = spare[next++]; byPosition++; }
        }
        if (alphaFiles.length > 0 && byName === 0) {
            warnings.push("No cut-out file name answers to a clip name, so they were paired by " +
                          "POSITION. Check the Alpha column row by row before building - a " +
                          "cut-out on the wrong card is not obvious once it is rendered.");
        } else if (byPosition > 0) {
            warnings.push(byName + " cut-out(s) matched by name, " + byPosition + " placed by " +
                          "position because nothing answered to the clip name. Check those rows " +
                          "in the Alpha column.");
        }
        return out;
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

    /** Every filled cell in this column is just a number. */
    function isNumericColumn(rows, c) {
        var seen = 0;
        for (var r = 1; r < rows.length; r++) {
            if (rows[r].length <= c) { continue; }
            var v = trim(rows[r][c]);
            if (v === "") { continue; }
            seen++;
            if (!/^[0-9\u0660-\u0669]+$/.test(v)) { return false; }
        }
        return seen > 0;
    }

    /**
     * The column carrying the quotes is the wordiest one, ignoring any column
     * in `skip`. A guest's job title can easily run longer than the quote it
     * sits under - "member of the Revolutionary Council of Fatah and professor
     * of diplomacy..." beats most quotes - and then the wordiest-column rule
     * writes the title across the card as though it were the quote. Columns a
     * header has already claimed are taken out of the running.
     */
    function pickTextColumn(rows, skip) {
        var widest = 0, c;
        for (var r = 0; r < rows.length; r++) { widest = Math.max(widest, rows[r].length); }
        var best = -1, bestScore = -1;
        for (c = 0; c < widest; c++) {
            if (skip && skip[c]) { continue; }
            // A column of bare row numbers is not a column of quotes. On a
            // blank sheet it is the only one with anything in it, and it used
            // to win - nine cards reading "1", "2", "3" and nothing to say so.
            if (isNumericColumn(rows, c)) { continue; }
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
     * normalize() keeps only a-z0-9, so it flattens any Arabic string to "" -
     * and indexOf("") matches everything. Header and layer names here are
     * routinely Arabic, so they get a plain case-insensitive substring test.
     */
    function looseHas(text, needle) {
        needle = trim(needle);
        if (needle === "") { return false; }
        return String(text).toLowerCase().indexOf(needle.toLowerCase()) !== -1;
    }

    var SPEAKER_HINTS = "المتحدث,متحدث,الضيف,ضيف,الاسم,اسم,speaker,name,guest,person";
    var ROLE_HINTS = "الصفة,صفة,الوظيفة,وظيفة,المنصب,منصب,title,role,job,position,subtitle";

    /**
     * The column holding the speaker's name (or their job title), identified
     * by its HEADER only. Guessing from the values instead would cheerfully
     * write a timecode or a row number across the card, so an unlabelled
     * column is left alone and the panel says the names were not touched.
     * Returns -1 when no header names one.
     */
    function pickLabelledColumn(rows, hintCSV, skip) {
        if (rows.length < 2) { return -1; }
        var hints = hintCSV.split(",");
        for (var h = 0; h < hints.length; h++) {
            for (var c = 0; c < rows[0].length; c++) {
                if (c === skip) { continue; }
                if (looseHas(trim(rows[0][c]), hints[h])) { return c; }
            }
        }
        return -1;
    }

    /**
     * The guests, read out of the producer's own form.
     *
     * A form lists them once, under a heading, as "Name - Title". The quote
     * table in the same form does NOT say who said what - that is the one
     * thing nobody can read off the paper - so the speaker column still has
     * to be filled in by someone who watched the episode. What it should not
     * take is typing a name and an eighty-nine character title nine times:
     * with the guests known, "2" or a surname in that column is enough.
     *
     * Returns [{ name, role }].
     */
    var GUEST_HEADINGS = "الضيوف,الضيف,المتحدثون,guests,speakers,panel";

    function parseGuestList(text) {
        var lines = String(text || "").split(/\r\n|\r|\n/);
        var out = [], inBlock = false, i;
        for (i = 0; i < lines.length; i++) {
            var raw = lines[i];
            var L = trim(raw);
            if (L === "") { continue; }

            var heads = GUEST_HEADINGS.split(","), isHead = false;
            for (var h = 0; h < heads.length; h++) {
                if (looseHas(L, heads[h]) && L.length < 40) { isHead = true; break; }
            }
            if (isHead) { inBlock = true; continue; }
            if (!inBlock) { continue; }

            // a bullet keeps us in the block; anything else ends it
            var bullet = L.replace(/^[\-\u2013\u2014\u2022\*\u00b7]+\s*/, "");
            if (bullet === L) { inBlock = false; continue; }
            if (trim(bullet) === "") { continue; }

            // "Name - Title" wins over "Name, Title": a title can hold commas
            // of its own, and this one does.
            var name = trim(bullet), role = "";
            var dash = bullet.search(/\s[\u2013\u2014-]\s/);
            if (dash > 0) {
                name = trim(bullet.substring(0, dash));
                role = trim(bullet.substring(dash).replace(/^\s[\u2013\u2014-]\s/, ""));
            } else {
                var comma = bullet.indexOf("،");
                if (comma < 0) { comma = bullet.indexOf(","); }
                if (comma > 0) {
                    name = trim(bullet.substring(0, comma));
                    role = trim(bullet.substring(comma + 1));
                }
            }
            if (name !== "") { out.push({ name: name, role: role }); }
        }
        return out;
    }

    /**
     * Turns what someone typed in the speaker column into a guest. Accepts the
     * guest's number in the list, any part of their name, or the whole name.
     * Returns null when it matches nobody - a wrong name is worse than none.
     */
    function resolveGuest(value, guests) {
        var v = trim(value || "");
        if (v === "" || !guests || guests.length === 0) { return null; }

        var n = parseInt(v.replace(/[\u0660-\u0669]/g, function (d) {
            return String(d.charCodeAt(0) - 0x0660);
        }), 10);
        if (!isNaN(n) && String(n) === v.replace(/[\u0660-\u0669]/g, function (d) {
            return String(d.charCodeAt(0) - 0x0660);
        }) && n >= 1 && n <= guests.length) {
            return guests[n - 1];
        }

        var i, hit = null, hits = 0;
        for (i = 0; i < guests.length; i++) {
            if (guests[i].name === v) { return guests[i]; }
        }
        for (i = 0; i < guests.length; i++) {
            if (looseHas(guests[i].name, v) || looseHas(v, guests[i].name)) {
                hit = guests[i]; hits++;
            }
        }
        return hits === 1 ? hit : null;      // ambiguous is not a match
    }

    // --------------------------------------------- reading a producer's form

    /** Latin or Arabic-Indic digits as a number, or NaN. */
    function digitsToInt(str) {
        var t = trim(str).replace(/[\u0660-\u0669]/g, function (d) {
            return String(d.charCodeAt(0) - 0x0660);
        });
        return /^[0-9]+$/.test(t) ? parseInt(t, 10) : NaN;
    }

    /**
     * Pulls the quotes out of a producer's form pasted in as plain text.
     *
     * A form numbers them - "( 1 ) ...", "(1) ...", "1) ...", "1- ..." - and
     * carries the timecode alongside, in its own column or at the end of the
     * line. Both the numbering and the timecode are stripped: the numbering is
     * the row number, and the timecode is for the editor, not for the card.
     *
     * The guests are listed in the same document, so anything under a guests
     * heading is left out - otherwise three names come through as quotes.
     *
     * Returns [{ index, text, timecode }].
     */
    var NUM_HEAD = /^[\(\[\{]?\s*([0-9\u0660-\u0669]{1,3})\s*[\)\]\}\.\-:\u2013\u2014]\s+/;
    var TC_TAIL = /[\s\t]+\(?((?:[0-9\u0660-\u0669]{1,2}:)?[0-9\u0660-\u0669]{1,2}:[0-9\u0660-\u0669]{2})\)?\s*$/;
    var MIN_QUOTE = 12;

    function parseFormQuotes(text) {
        var lines = String(text || "").split(/\r\n|\r|\n/);
        var out = [], inGuests = false, i, h;
        var heads = GUEST_HEADINGS.split(",");

        // A form numbers its quotes. Where it does, an unnumbered line is the
        // table's own heading or a stray caption - taking those too is how
        // "أبرز الاقتباسات" ended up as quote 1 and pushed every card along by
        // one. Only fall back to unnumbered lines when nothing is numbered.
        var numbered = false;
        for (i = 0; i < lines.length; i++) {
            var probe = trim(lines[i]).replace(TC_TAIL, "");
            var ph = probe.match(NUM_HEAD);
            if (ph && trim(probe.substring(ph[0].length)).length >= MIN_QUOTE) {
                numbered = true;
                break;
            }
        }

        for (i = 0; i < lines.length; i++) {
            var L = trim(lines[i]);
            if (L === "") { inGuests = false; continue; }

            var isHead = false;
            for (h = 0; h < heads.length; h++) {
                if (looseHas(L, heads[h]) && L.length < 40) { isHead = true; break; }
            }
            if (isHead) { inGuests = true; continue; }

            var bulleted = /^[\-\u2013\u2014\u2022\*\u00b7]/.test(L);
            if (inGuests && bulleted) { continue; }
            if (inGuests && !bulleted) { inGuests = false; }

            var tc = "";
            var tcHit = L.match(TC_TAIL);
            if (tcHit) { tc = trim(tcHit[1]); L = trim(L.substring(0, L.length - tcHit[0].length)); }

            var numHit = L.match(NUM_HEAD);
            if (numHit) { L = trim(L.substring(numHit[0].length)); }
            else if (numbered) { continue; }        // scaffolding, not a quote

            // A bare number with nothing after it is a row marker, not a quote,
            // and a stray heading is shorter than any real quote.
            if (L.length < MIN_QUOTE) { continue; }
            if (!isNaN(digitsToInt(L))) { continue; }

            out.push({ index: out.length + 1, text: L, timecode: tc });
        }
        return out;
    }

    /** One CSV field, quoted only when it has to be. */
    function csvField(v) {
        var t = String(v === undefined || v === null ? "" : v);
        return /[",\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
    }

    /**
     * The quote sheet the card tool reads. `order` is the guests' numbers in
     * quote order - "2,1,3,3" - which is the one thing the form cannot say.
     */
    function buildQuotesCSV(quotes, order) {
        var keys = String(order || "").split(/[\s,;\-]+/);
        var rows = ["\ufeff" + ["#", "التوقيت", "المتحدث", "الصفة", "نص الاقتباس"].join(",")];
        for (var i = 0; i < quotes.length; i++) {
            var who = trim(keys[i] || "");
            rows.push([
                csvField(i + 1),
                csvField(quotes[i].timecode || ""),
                csvField(who),
                "",
                csvField(quotes[i].text)
            ].join(","));
        }
        return rows.join("\n") + "\n";
    }

    /** The guest list, in the shape the card tool reads back. */
    function buildGuestsText(guests, title, host) {
        var out = [];
        out.push("عنوان الحلقة: " + trim(title || ""));
        out.push("المقدم: " + trim(host || ""));
        out.push("");
        out.push("الضيوف:");
        for (var i = 0; i < guests.length; i++) {
            out.push("  - " + guests[i].name +
                     (trim(guests[i].role) !== "" ? " — " + guests[i].role : ""));
        }
        return out.join("\n") + "\n";
    }

    /** The producer's form sitting next to the quote list, if there is one. */
    var GUEST_FILES = "episode-info.txt,guests.txt,الضيوف.txt";

    function guestListBeside(file) {
        try {
            if (!file || !file.parent) { return ""; }
            var names = GUEST_FILES.split(",");
            for (var i = 0; i < names.length; i++) {
                var f = new File(file.parent.fsName + "/" + trim(names[i]));
                if (f.exists && f.open("r")) {
                    var raw = f.read();
                    f.close();
                    return raw;
                }
            }
        } catch (e) {}
        return "";
    }

    /**
     * Reads the quote list. Accepts:
     *   .csv  - the wordiest column is taken as the quote text
     *   .srt  - the "# ..." comment carried under each timecode block
     *   .txt  - one quote per paragraph, or per line when there are no blanks
     * A .csv can also carry the speaker's name and job title in their own
     * labelled columns; without them every card keeps the name the template
     * was mocked up with.
     * Returns [{ index, text, speaker, role, speakerColumn }].
     */
    function parseQuotesFile(file, warnings) {
        if (!file.open("r")) {
            warnings.push("Could not open the quotes file: " + file.fsName);
            return [];
        }
        var raw = file.read();
        file.close();
        raw = raw.replace(/^\uFEFF/, "");

        var texts = [], speakers = [], roles = [], speakerHeader = "", i;
        var ext = extOf(file.name);

        if (ext === "csv" || ext === "tsv") {
            var rows = parseCSVText(ext === "tsv" ? raw.replace(/\t/g, ",") : raw);
            if (rows.length === 0) { return []; }

            // Claim the named columns first, then pick the quote from what is
            // left. Done the other way round, a long job title wins the
            // "wordiest column" contest and lands on the quote layer.
            var speakerCol = pickLabelledColumn(rows, SPEAKER_HINTS, -1);
            var roleCol = pickLabelledColumn(rows, ROLE_HINTS, -1);
            if (roleCol === speakerCol) { roleCol = -1; }
            var skip = {};
            if (speakerCol >= 0) { skip[speakerCol] = true; }
            if (roleCol >= 0) { skip[roleCol] = true; }

            var col = pickTextColumn(rows, skip);
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
            // A header that names a column IS a header, whatever the length
            // heuristic above decided about the quote column.
            if (speakerCol >= 0 || roleCol >= 0) { start = 1; }
            if (speakerCol >= 0) { speakerHeader = trim(rows[0][speakerCol]); }

            for (i = start; i < rows.length; i++) {
                if (rows[i].length > col) {
                    var v = trim(rows[i][col]);
                    if (v !== "") {
                        texts.push(v);
                        speakers.push(speakerCol >= 0 && rows[i].length > speakerCol
                            ? trim(rows[i][speakerCol]) : "");
                        roles.push(roleCol >= 0 && rows[i].length > roleCol
                            ? trim(rows[i][roleCol]) : "");
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

        // "3" or a surname in the speaker column becomes the guest's full name
        // and title, taken from the producer's own form.
        var guests = parseGuestList(guestListBeside(file));
        var resolved = 0;

        var quotes = [];
        for (i = 0; i < texts.length; i++) {
            var sp = speakers[i] || "", ro = roles[i] || "";
            if (guests.length) {
                var g = resolveGuest(sp, guests);
                if (g) {
                    if (g.name !== sp) { resolved++; }
                    sp = g.name;
                    if (ro === "") { ro = g.role; }
                }
            }
            quotes.push({
                index: i + 1,
                text: texts[i],
                speaker: sp,
                role: ro,
                speakerColumn: speakerHeader
            });
        }
        if (resolved > 0) {
            warnings.push(resolved + " speaker(s) filled in from the guest list beside the " +
                          "quote file - check the Name column before building.");
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
                        label: path + "  >  " + nested.name +
                               "   (EMPTY comp - the clip gets added here)"
                    });
                }

                if (wantText ? isText : isSwappableLayer(L)) {
                    var where = (comp === root ? "" : path + "  >  ") + L.index + ": " + L.name;
                    var sample = isText ? layerTextValue(L) : "";
                    out.push({
                        comp: comp, layer: L, index: L.index, sample: sample, isEmpty: false,
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
    function deepDuplicate(comp, cloneIds, mapping, suffix, log) {
        if (mapping[comp.id]) { return mapping[comp.id]; }
        var clone = comp.duplicate();
        if (suffix) { clone.name = comp.name + " " + suffix; }
        mapping[comp.id] = clone;
        for (var i = 1; i <= clone.numLayers; i++) {
            var L = clone.layer(i);
            var src = layerSource(L);
            if (!(src instanceof CompItem) || !cloneIds[src.id]) { continue; }
            var remap = captureTimeRemap(L);
            L.replaceSource(deepDuplicate(src, cloneIds, mapping, suffix, log), false);
            restoreTimeRemap(L, remap, clone.name + " / " + L.name, log);
        }
        return clone;
    }

    /**
     * A template animates its quote box by TIME REMAPPING the comp that holds
     * it, not by keyframing it in place. Replacing that layer's source is
     * allowed to rewrite the remap keyframes, and a card whose remap has been
     * rewritten opens at the wrong moment - or looks like it never opens at
     * all. Copy them off before the swap.
     */
    function captureTimeRemap(layer) {
        try {
            if (!layer.timeRemapEnabled) { return null; }
            var p = layer.property("ADBE Time Remapping");
            if (!p || p.numKeys === 0) { return null; }
            var keys = [];
            for (var i = 1; i <= p.numKeys; i++) {
                keys.push({
                    t: p.keyTime(i),
                    v: p.keyValue(i),
                    inType: p.keyInInterpolationType(i),
                    outType: p.keyOutInterpolationType(i)
                });
            }
            return {
                keys: keys,
                startTime: layer.startTime,
                inPoint: layer.inPoint,
                outPoint: layer.outPoint
            };
        } catch (e) { return null; }
    }

    /** Puts back what captureTimeRemap took, and says so when it was needed. */
    function restoreTimeRemap(layer, saved, where, log) {
        if (!saved) { return false; }
        try {
            var p = layer.property("ADBE Time Remapping");
            if (!p) { return false; }
            var disturbed = (p.numKeys !== saved.keys.length);
            if (!disturbed) {
                for (var c = 1; c <= p.numKeys; c++) {
                    if (Math.abs(p.keyTime(c) - saved.keys[c - 1].t) > TOL ||
                        Math.abs(p.keyValue(c) - saved.keys[c - 1].v) > TOL) {
                        disturbed = true;
                        break;
                    }
                }
            }
            if (!disturbed && Math.abs(layer.inPoint - saved.inPoint) <= TOL &&
                Math.abs(layer.outPoint - saved.outPoint) <= TOL) {
                return false;
            }

            while (p.numKeys > 0) { p.removeKey(1); }
            var i;
            for (i = 0; i < saved.keys.length; i++) {
                p.setValueAtTime(saved.keys[i].t, saved.keys[i].v);
            }
            for (i = 1; i <= p.numKeys; i++) {
                try {
                    p.setInterpolationTypeAtKey(i, saved.keys[i - 1].inType,
                                                   saved.keys[i - 1].outType);
                } catch (eI) {}
            }
            layer.startTime = saved.startTime;
            layer.inPoint = saved.inPoint;
            layer.outPoint = saved.outPoint;
            if (log) {
                log.push("    time remap on \"" + where + "\" was rewritten by the source " +
                         "swap - put back (" + saved.keys.length + " key(s), in " +
                         saved.inPoint.toFixed(2) + "s out " + saved.outPoint.toFixed(2) + "s)");
            }
            return true;
        } catch (e) {
            if (log) { log.push("    note: could not restore the time remap: " + e.toString()); }
            return false;
        }
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
            var extra = (p.numKeys > 0 ? "  (" + p.numKeys + " keys)" : "");
            // An expression reading another layer's inPoint/outPoint retimes
            // itself per card, because each clip is a different length. That
            // is invisible in the comp and has to show up here.
            try {
                if (p.expressionEnabled && trim(p.expression) !== "") {
                    var ex = trim(p.expression).replace(/[\r\n]+/g, " ");
                    extra += "  (expr: " + (ex.length > 90 ? ex.substring(0, 90) + "..." : ex) + ")";
                }
            } catch (eEx) {}
            return txt + extra;
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
                            : "POINT TEXT (cannot auto-fit)") + "   size=" + doc.fontSize +
                            "   font=" + doc.font;
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

    /** The name of the first live Roto Brush / Object Matte on a layer, or "". */
    function rotoEffectName(layer) {
        try {
            var fx = layer.property("ADBE Effect Parade");
            var hits = ROTO_HINTS.split(",");
            for (var i = 1; i <= fx.numProperties; i++) {
                var e = fx.property(i);
                if (!e.enabled) { continue; }
                var mn = "", nm = "";
                try { mn = normalize(e.matchName); } catch (x1) {}
                try { nm = normalize(e.name); } catch (x2) {}
                for (var h = 0; h < hits.length; h++) {
                    var want = normalize(hits[h]);
                    if (want !== "" && (mn.indexOf(want) !== -1 || nm.indexOf(want) !== -1)) {
                        return e.name;
                    }
                }
                if (nm.indexOf("objectmatte") !== -1) { return e.name; }
            }
        } catch (e2) {}
        return "";
    }

    /** Is `want` this comp, or anywhere inside it? */
    function compContains(comp, want, depth) {
        if (!(comp instanceof CompItem) || depth > 8) { return false; }
        if (comp === want) { return true; }
        for (var i = 1; i <= comp.numLayers; i++) {
            if (compContains(layerSource(comp.layer(i)), want, depth + 1)) { return true; }
        }
        return false;
    }

    /** The layer in `card` that shows `wantComp`, directly or nested. */
    function layerShowing(card, wantComp) {
        if (!card || !wantComp) { return null; }
        for (var i = 1; i <= card.numLayers; i++) {
            if (compContains(layerSource(card.layer(i)), wantComp, 0)) { return card.layer(i); }
        }
        return null;
    }

    /**
     * Moves the guest's cut-out layer BEHIND the quote box, instead of
     * switching it off.
     *
     * Switching it off cost far more than it fixed. The template draws the
     * guest twice: a desaturated copy at the bottom of the stack, tinted by an
     * adjustment layer, which is the background - and this one, in full
     * colour, above the red circle. Turn this one off and every card loses the
     * guest's real colours and drops him behind the circle, to fix a bleed on
     * one card.
     *
     * The strokes are still stale, so this layer can still let a piece of the
     * clip through where it should not. Below the box it no longer matters:
     * the box is drawn after it and covers it. Above the red circle it still
     * sits, so the guest keeps his colours and stays in front - which is the
     * whole point of that layer.
     */
    function moveMattesBehindBox(card, boxLayer, footageComp, log, moveProblems) {
        if (!card || !boxLayer) { return 0; }
        moveProblems = moveProblems || [];
        var pending = [], i;
        for (i = 1; i <= card.numLayers; i++) {
            var L = card.layer(i);
            if (L === boxLayer) { continue; }
            if (L.index > boxLayer.index) { continue; }     // already behind it

            // Any layer in front of the box that draws the guest's footage can
            // cover the box. Whether a Roto Brush can be SEEN on it is beside
            // the point - one card moved and another did not, on the same run,
            // because the effect went unrecognised there. Showing the footage
            // is the property that matters.
            var shows = footageComp && compContains(layerSource(L), footageComp, 0);
            var fx = rotoEffectName(L);
            if (!shows && fx === "") { continue; }
            pending.push({ layer: L, name: L.name, why: fx !== "" ? "its \"" + fx + "\"" : "it" });
        }
        var done = 0;
        for (i = 0; i < pending.length; i++) {
            var L = pending[i].layer, wasLocked = false;
            try {
                // After Effects refuses to move a locked layer, and the refusal
                // reads like nothing happened. One card out of nine behaving
                // differently is what a stray lock looks like from outside.
                try { wasLocked = L.locked; L.locked = false; } catch (eL) {}
                L.moveAfter(boxLayer);
                done++;
                log.push("    moved \"" + pending[i].name + "\" behind \"" + boxLayer.name +
                         "\" - " + pending[i].why + " was painted on the template's own clip, so " +
                         "it can bleed over the box. Behind it, the box always wins; the guest " +
                         "keeps his colours and stays in front of the circle." +
                         (wasLocked ? "  (the layer was LOCKED - unlocked to move it)" : ""));
            } catch (e) {
                moveProblems.push("\"" + pending[i].name + "\": " + e.toString());
                log.push("    *** could not move \"" + pending[i].name + "\" behind the box: " +
                         e.toString());
            }
            try { L.locked = wasLocked; } catch (eR) {}
        }
        return done;
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

    // ------------------------------------------------------------------- UI

    function build(thisObj) {
        var win = (thisObj instanceof Panel)
            ? thisObj
            : new Window("palette", "Quote Cards", undefined, { resizeable: true });

        win.orientation = "column";
        win.alignChildren = ["fill", "top"];
        win.spacing = 7;
        win.margins = 12;

        function row(labelText) {
            var g = win.add("group");
            g.orientation = "row";
            g.alignChildren = ["left", "center"];
            var l = g.add("statictext", undefined, labelText);
            l.preferredSize.width = 100;
            return g;
        }

        function pathRow(labelText, isFolder, prompt) {
            var g = row(labelText);
            var txt = g.add("edittext", undefined, "");
            txt.alignment = ["fill", "center"];
            txt.preferredSize.width = 300;
            var btn = g.add("button", undefined, "Browse");
            btn.preferredSize.width = 70;
            btn.onClick = function () {
                var picked = isFolder ? Folder.selectDialog(prompt) : File.openDialog(prompt);
                if (!picked) { return; }
                txt.text = picked.fsName;
                adoptThenScan();      // setting .text from code fires no onChange
            };
            txt.onChange = function () { adoptThenScan(); };
            return txt;
        }

        // ---- template -------------------------------------------------------
        var tplGroup = row("Template comp:");
        var tplDrop = tplGroup.add("dropdownlist", undefined, []);
        tplDrop.alignment = ["fill", "center"];
        tplDrop.preferredSize.width = 300;
        var refreshBtn = tplGroup.add("button", undefined, "Refresh");
        refreshBtn.preferredSize.width = 70;

        var videosTxt = pathRow("Clips folder:", true, "Where are the speaker clips?");
        var quotesTxt = pathRow("Quotes file:", false, "The quote list (.csv / .txt / .srt)");
        var alphaTxt = pathRow("Alpha clips:", true,
            "Optional: the pre-keyed / cut-out version of each clip");

        // ---- which layers ---------------------------------------------------
        var layerGroup = row("Video layer:");
        var videoDrop = layerGroup.add("dropdownlist", undefined, []);
        videoDrop.alignment = ["fill", "center"];

        var alphaGroup = row("Alpha layer:");
        var alphaDrop = alphaGroup.add("dropdownlist", undefined, []);
        alphaDrop.alignment = ["fill", "center"];

        var textGroup = row("Text layer:");
        var textDrop = textGroup.add("dropdownlist", undefined, []);
        textDrop.alignment = ["fill", "center"];

        var nameGroup = row("Name layer:");
        var nameDrop = nameGroup.add("dropdownlist", undefined, []);
        nameDrop.alignment = ["fill", "center"];

        var roleGroup = row("Title layer:");
        var roleDrop = roleGroup.add("dropdownlist", undefined, []);
        roleDrop.alignment = ["fill", "center"];

        var opts = win.add("panel", undefined, "Options");
        opts.orientation = "column";
        opts.alignChildren = ["left", "top"];
        opts.margins = [12, 16, 12, 12];
        opts.spacing = 3;
        var cbSort = opts.add("checkbox", undefined,
            "Clip order decides who appears: 1st clip -> 1st quote, 2nd -> 2nd ...");
        cbSort.value = true;
        var cbMatte = opts.add("checkbox", undefined,
            "Build refine-ready matte on each card ([MATTE] + alpha track matte) - " +
            "leave OFF if the template already mattes the guest");
        cbMatte.value = false;
        var cbReset = opts.add("checkbox", undefined,
            "Start each clip at its own beginning (fixes a black card when the " +
            "placeholder was trimmed out of a long recording)");
        cbReset.value = true;
        var cbFit = opts.add("checkbox", undefined,
            "Fit the clip to its comp frame (a 1080p clip fills a 4K slot)");
        cbFit.value = true;
        var alphaModeRow = opts.add("group");
        alphaModeRow.orientation = "row";
        alphaModeRow.alignChildren = ["left", "center"];
        alphaModeRow.add("statictext", undefined, "Read a clip's alpha as:");
        var alphaModeDrop = alphaModeRow.add("dropdownlist", undefined, [
            "let After Effects decide",
            "Straight",
            "Premultiplied - matted with WHITE  (pick this if you see a white halo)",
            "Premultiplied - matted with BLACK  (pick this if you see a dark halo)"
        ]);
        alphaModeDrop.selection = 0;

        function alphaChoice() {
            var i = alphaModeDrop.selection ? alphaModeDrop.selection.index : 0;
            return ["auto", "straight", "premul-white", "premul-black"][i];
        }
        var cbAlphaPath = opts.add("checkbox", undefined,
            "Keep the template's Roto Brush / Object Matte behind the quote box - it was painted " +
            "on the template's own clip, so it can bleed over the box - and switch on the " +
            "cut-out layers if you supplied cut-outs");
        cbAlphaPath.value = true;
        var cbFitText = opts.add("checkbox", undefined,
            "Shrink the type until the quote fits its text box");
        cbFitText.value = true;
        var cbFolder = opts.add("checkbox", undefined,
            "Collect the finished cards in one Project panel folder");
        cbFolder.value = true;

        var list = win.add("listbox", undefined, [], {
            numberOfColumns: 5, showHeaders: true,
            columnTitles: ["#", "Clip", "Alpha", "Name", "Quote"],
            columnWidths: [30, 150, 150, 130, 240]
        });
        list.preferredSize.height = 190;
        list.alignment = ["fill", "fill"];

        var status = win.add("statictext", undefined,
            "Pick the template comp, the clips folder and the quote list - " +
            "the plan below fills in by itself.");
        status.alignment = ["fill", "top"];

        var buttons = win.add("group");
        buttons.orientation = "row";
        buttons.alignment = ["fill", "bottom"];
        var scanBtn = buttons.add("button", undefined, "Scan");
        var goBtn = buttons.add("button", undefined, "Create cards");
        var reportBtn = buttons.add("button", undefined, "Report");
        var helpBtn = buttons.add("button", undefined, "Help");
        goBtn.enabled = false;

        // ---- state ----------------------------------------------------------

        var compList = [], videoTargets = [], textTargets = [], plan = [], planWarnings = [];
        var alphaFiles = [];

        function setStatus(m) { status.text = m; }

        function template() {
            return (tplDrop.selection && compList.length) ? compList[tplDrop.selection.index] : null;
        }

        function refreshComps() {
            compList = listComps();
            tplDrop.removeAll();
            var activeIdx = 0, active = app.project.activeItem;
            for (var i = 0; i < compList.length; i++) {
                tplDrop.add("item", compList[i].name);
                if (active && active === compList[i]) { activeIdx = i; }
            }
            if (compList.length) { tplDrop.selection = activeIdx; }
            refreshLayers();
        }

        function refreshLayers() {
            videoDrop.removeAll();
            textDrop.removeAll();
            videoLayers = [];
            textLayers = [];
            var comp = template();
            if (!comp) { return; }

            // look through nested comps too: templates usually hide the guest
            // and the quote inside REPLACE-FOOTAGE / REPLACE-PARAGRAPH precomps
            videoTargets = collectTargets(comp, false);
            for (var i = 0; i < videoTargets.length; i++) {
                videoDrop.add("item", videoTargets[i].label);
            }
            // The empty cut-out slot is usually called REPLACE-ALPHA-FOOTAGE,
            // so it answers to "footage" and, sitting above the real clip in
            // the tree, it used to win. The template's own guest was then
            // never swapped and the clip was dropped into a comp whose layers
            // are switched off - the guest stays put and nothing says why.
            var videoIdx = videoTargets.length
                ? bestGuess(videoTargets, "footage,video,guest,person,clip", true) : -1;
            if (videoTargets.length) { videoDrop.selection = videoIdx; }
            else { videoDrop.add("item", "-- no footage layer anywhere in this comp --"); videoDrop.selection = 0; }

            alphaDrop.removeAll();
            alphaDrop.add("item", videoTargets.length
                ? "(no separate alpha layer)"
                : "-- no footage layer anywhere in this comp --");
            for (var a = 0; a < videoTargets.length; a++) {
                alphaDrop.add("item", videoTargets[a].label);
            }
            // ...and the same target must never be both, or the clip is
            // written twice into one place and the other slot stays empty.
            var alphaHit = videoTargets.length
                ? guessIndex(videoTargets, "alpha,matte,luma,cutout,key", false, videoIdx) : -1;
            alphaDrop.selection = (alphaHit >= 0) ? alphaHit + 1 : 0;

            textTargets = collectTargets(comp, true);
            textDrop.add("item", textTargets.length
                ? "(leave the text alone)"
                : "-- no text layer anywhere in this comp --");
            for (var k = 0; k < textTargets.length; k++) {
                textDrop.add("item", textTargets[k].label);
            }
            var quoteIdx = textTargets.length ? bestTextGuess(textTargets) : -1;
            textDrop.selection = textTargets.length ? quoteIdx + 1 : 0;

            // The name and the title are only auto-picked when a layer is
            // actually named for them. Guessing by length would land the
            // speaker's name on the job title as often as not, and writing
            // over the wrong line of a template is worse than doing nothing.
            fillSideDrop(nameDrop, "(leave the name alone)", NAME_LAYER_HINTS, quoteIdx);
            fillSideDrop(roleDrop, "(leave the title alone)", ROLE_LAYER_HINTS, quoteIdx);
        }

        var NAME_LAYER_HINTS = "المتحدث,متحدث,الضيف,ضيف,الاسم,اسم,speaker,name,guest";
        var ROLE_LAYER_HINTS = "الصفة,صفة,الوظيفة,وظيفة,المنصب,منصب,title,role,job,position,subtitle";

        function fillSideDrop(drop, leaveLabel, hintCSV, skipIndex) {
            drop.removeAll();
            drop.add("item", textTargets.length
                ? leaveLabel
                : "-- no text layer anywhere in this comp --");
            for (var i = 0; i < textTargets.length; i++) {
                drop.add("item", textTargets[i].label);
            }
            var hit = textTargets.length ? looseGuessIndex(textTargets, hintCSV, skipIndex) : -1;
            drop.selection = (hit >= 0) ? hit + 1 : 0;
        }

        /**
         * Matches on the LAYER NAME with a plain substring test, so an Arabic
         * layer name still matches - normalize() would flatten it to "" and
         * then match the first layer in the list.
         */
        function looseGuessIndex(targets, hintCSV, skipIndex) {
            var hints = hintCSV.split(",");
            for (var h = 0; h < hints.length; h++) {
                for (var i = 0; i < targets.length; i++) {
                    if (i === skipIndex || !targets[i].layer) { continue; }
                    if (looseHas(targets[i].layer.name, hints[h])) { return i; }
                }
            }
            return -1;
        }

        /**
         * A setup file next to the quote list is how a second editor, on a
         * different machine, inherits the layer choices instead of guessing
         * them. Only the choices are taken - the paths in it are somebody
         * else's.
         */
        var lastPresetTried = "";
        function maybeAdoptPreset() {
            var qp = trim(quotesTxt.text);
            if (qp === "" || qp === lastPresetTried) { return ""; }
            lastPresetTried = qp;
            var pf = presetBeside(qp);
            if (!pf) { return ""; }
            try {
                if (!pf.open("r")) { return ""; }
                var raw = pf.read();
                pf.close();
                var hits = applySetup(textToSetup(raw));
                return hits > 0
                    ? "  |  setup adopted from " + PRESET_NAME + " next to the quote list (" +
                      hits + " choice(s))"
                    : "";
            } catch (e) { return ""; }
        }

        /** Everything needed is filled in, so show the plan without being asked. */
        function adoptThenScan() {
            presetNote = maybeAdoptPreset();
            maybeScan();
        }

        var presetNote = "";

        function maybeScan() {
            if (!template()) { return; }
            if (trim(videosTxt.text) === "" || trim(quotesTxt.text) === "") { return; }
            doScan();
        }

        /**
         * Index of the first layer whose path names it, or -1 for no match.
         * Returning 0 as the miss value made "found nothing" indistinguishable
         * from "matched the very first layer", which quietly left the alpha
         * slot unfilled.
         */
        function guessIndex(targets, hintCSV, realOnly, skipIndex) {
            var hints = hintCSV.split(",");
            for (var h = 0; h < hints.length; h++) {
                var want = normalize(hints[h]);
                if (want === "") { continue; }        // "" matches every label
                for (var i = 0; i < targets.length; i++) {
                    if (i === skipIndex) { continue; }
                    if (realOnly && targets[i].isEmpty) { continue; }
                    if (normalize(targets[i].label).indexOf(want) !== -1) { return i; }
                }
            }
            return -1;
        }

        /**
         * Same, but falls back to a layer that really exists before settling
         * for an empty slot, and only then for the first thing in the list.
         */
        function bestGuess(targets, hintCSV, realOnly) {
            var i = guessIndex(targets, hintCSV, realOnly);
            if (i >= 0) { return i; }
            if (realOnly) {
                i = guessIndex(targets, hintCSV, false);
                if (i >= 0) { return i; }
                for (var k = 0; k < targets.length; k++) {
                    if (!targets[k].isEmpty) { return k; }
                }
            }
            return 0;
        }

        /**
         * The quote body is the text layer already carrying the most words -
         * a speaker name or a job title is always shorter. Matching on the
         * layer name alone picked the name line and cropped the quote.
         */
        function bestTextGuess(targets) {
            var best = 0, bestLen = -1;
            for (var i = 0; i < targets.length; i++) {
                var len = targets[i].sample ? targets[i].sample.length : 0;
                if (len > bestLen) { bestLen = len; best = i; }
            }
            return best;
        }

        tplDrop.onChange = function () { refreshLayers(); maybeScan(); };
        videoDrop.onChange = function () { maybeScan(); };
        alphaDrop.onChange = function () { maybeScan(); };
        textDrop.onChange = function () { maybeScan(); };
        nameDrop.onChange = function () { maybeScan(); };
        roleDrop.onChange = function () { maybeScan(); };
        refreshBtn.onClick = function () { refreshComps(); maybeScan(); };

        function selectedVideoTarget() {
            if (!videoTargets.length || !videoDrop.selection) { return null; }
            return videoTargets[videoDrop.selection.index] || null;
        }

        function selectedAlphaTarget() {
            if (!alphaDrop.selection || alphaDrop.selection.index === 0) { return null; }
            return videoTargets[alphaDrop.selection.index - 1] || null;
        }

        function selectedTextTarget() {
            if (!textDrop.selection || textDrop.selection.index === 0) { return null; }
            return textTargets[textDrop.selection.index - 1] || null;
        }

        function selectedNameTarget() {
            if (!nameDrop.selection || nameDrop.selection.index === 0) { return null; }
            return textTargets[nameDrop.selection.index - 1] || null;
        }

        function selectedRoleTarget() {
            if (!roleDrop.selection || roleDrop.selection.index === 0) { return null; }
            return textTargets[roleDrop.selection.index - 1] || null;
        }

        function doScan() {
            list.removeAll();
            plan = [];
            planWarnings = [];
            goBtn.enabled = false;

            var comp = template();
            if (!comp) { setStatus("No comp selected. Press Refresh."); return; }

            var vf = trim(videosTxt.text), qf = trim(quotesTxt.text);
            if (vf === "") { setStatus("Pick the folder holding the speaker clips."); return; }
            if (qf === "") { setStatus("Pick the quote list file."); return; }

            var folder = new Folder(vf);
            if (!folder.exists) { setStatus("Clips folder not found: " + vf); return; }
            var qFile = new File(qf);
            if (!qFile.exists) { setStatus("Quotes file not found: " + qf); return; }

            var problem = scriptFileProblem(qFile);
            if (problem) { setStatus("Wrong kind of file - see the message."); alert(problem); return; }

            var files = [];
            scanVideos(folder, files, 0);
            if (files.length === 0) { setStatus("No clips found under " + folder.fsName); return; }
            if (cbSort.value) { sortFilesNaturally(files); }

            alphaFiles = [];
            var sameFolderNote = "";
            var aTarget = selectedAlphaTarget();
            var af = trim(alphaTxt.text);
            if (aTarget && af !== "") {
                var aFolder = new Folder(af);
                if (!aFolder.exists) { setStatus("Alpha clips folder not found: " + af); return; }
                scanVideos(aFolder, alphaFiles, 0);
                if (cbSort.value) { sortFilesNaturally(alphaFiles); }
                if (alphaFiles.length === 0) {
                    planWarnings.push("No clips found in the alpha folder - the cut-out will " +
                                      "keep the template's own alpha.");
                }
                // Pointing "Alpha clips" at the ordinary clips is not a cut-out
                // route, it is the same video twice - and every card then warns
                // about a missing alpha channel with no hint as to why.
                if (aFolder.fsName === folder.fsName) {
                    sameFolderNote = "  |  \"Alpha clips\" is the SAME folder as \"Clips " +
                        "folder\" - those are the original videos, not cut-outs, so they carry " +
                        "no transparency. Clear \"Alpha clips\" and set \"Alpha layer\" to " +
                        "\"(no separate alpha layer)\" until you have real cut-outs.";
                }
            }

            var quotes = parseQuotesFile(qFile, planWarnings);
            if (quotes.length === 0) {
                setStatus("No quotes read from \"" + qFile.name + "\" - press Help for the formats.");
                return;
            }

            if (!selectedVideoTarget()) {
                setStatus("No footage layer found in \"" + comp.name + "\" or any comp inside it.");
                return;
            }

            // Named first, position only as a last resort: files coming back
            // from an outside keyer carry job ids, not the clip's name.
            var warnBefore = planWarnings.length;
            var alphaPairs = alphaFiles.length
                ? pairAlphaClips(files, alphaFiles, planWarnings) : [];
            // A pairing warning is useless in the log afterwards - it has to
            // be on screen while the Alpha column is still there to check.
            var pairNote = planWarnings.length > warnBefore
                ? "  |  " + planWarnings[planWarnings.length - 1] : "";

            for (var i = 0; i < quotes.length; i++) {
                var clip = (i < files.length) ? files[i] : null;
                if (!clip) {
                    planWarnings.push("Quote " + (i + 1) + " has no clip: the folder holds only " +
                                      files.length + " clip(s).");
                }
                var alphaClip = alphaPairs[i] || null;
                plan.push({ index: i + 1, quote: quotes[i], file: clip, alpha: alphaClip, ok: !!clip });

                var it = list.add("item", String(i + 1));
                it.subItems[0].text = clip ? clip.name : "-- no clip --";
                it.subItems[1].text = alphaClip ? alphaClip.name
                    : (aTarget && af !== "" ? "-- none --" : "");
                it.subItems[2].text = trim(quotes[i].speaker) !== ""
                    ? quotes[i].speaker
                    : (selectedNameTarget() ? "-- no name --" : "");
                it.subItems[3].text = quotes[i].text.length > 80
                    ? quotes[i].text.substring(0, 80) + "..."
                    : quotes[i].text;
            }

            var ready = 0;
            for (var r = 0; r < plan.length; r++) { if (plan[r].ok) { ready++; } }
            goBtn.enabled = ready > 0;

            // A template with an ALPHA / MATTE comp in it expects a cut-out clip.
            // Saying nothing here is how the guest ends up with their whole
            // studio behind them.
            var alphaSlot = "";
            for (var q = 0; q < videoTargets.length; q++) {
                var lbl = normalize(videoTargets[q].label);
                if (lbl.indexOf("alpha") !== -1 || lbl.indexOf("matte") !== -1) {
                    alphaSlot = videoTargets[q].label;
                    if (videoTargets[q].isEmpty) { break; }   // an empty slot is the likeliest
                }
            }

            var note = "";
            if (af !== "" && !aTarget) {
                note += "  |  you gave an Alpha clips folder but \"Alpha layer\" is still " +
                        "\"(no separate alpha layer)\" - those clips will NOT be used. Open that " +
                        "list and pick the cut-out layer.";
            } else if (alphaSlot !== "" && !aTarget) {
                note += "  |  THIS TEMPLATE HAS A CUT-OUT SLOT that is not being filled: \"" +
                        alphaSlot + "\". Pick it under \"Alpha layer\" and give it a folder of " +
                        "pre-keyed clips, or the guest keeps their background.";
            } else if (aTarget && alphaFiles.length === 0) {
                note += "  |  an alpha layer is chosen but its folder is empty - " +
                        "the cut-out will stay as the template had it";
            }
            if (textTargets.length === 0) {
                note = "  |  NO TEXT LAYER found in \"" + comp.name + "\" or any comp inside it - " +
                       "the quotes will NOT be written. Is it a shape layer rather than a text layer?";
            } else if (!selectedTextTarget()) {
                note = "  |  text layer set to \"leave alone\" - the quotes will not be written";
            }

            // One guest's name sitting on all nine cards is the quietest way
            // for this to go wrong: the quote body changes, so the cards look
            // built, and only the name gives it away.
            var withSpeaker = 0;
            for (var sp = 0; sp < quotes.length; sp++) {
                if (trim(quotes[sp].speaker) !== "") { withSpeaker++; }
            }
            var nTarget = selectedNameTarget();

            // Two slots aimed at one layer means the second write silently
            // wipes the first - the quote replaced by a name, say.
            var rTarget = selectedRoleTarget();
            var quoteTarget = selectedTextTarget();
            var clash = "";
            if (nTarget && nTarget === quoteTarget) { clash = "\"Name layer\" and \"Text layer\""; }
            else if (rTarget && rTarget === quoteTarget) { clash = "\"Title layer\" and \"Text layer\""; }
            else if (nTarget && rTarget && nTarget === rTarget) { clash = "\"Name layer\" and \"Title layer\""; }
            if (clash !== "") {
                note += "  |  " + clash + " are the SAME layer - one would overwrite the " +
                        "other. Point them at different layers.";
            }

            note += pairNote + sameFolderNote + presetNote;

            if (nTarget && withSpeaker === 0) {
                note += "  |  THE NAMES WILL NOT CHANGE: " +
                        (trim(quotes[0].speakerColumn) !== ""
                            ? "the column \"" + quotes[0].speakerColumn + "\" in your quote " +
                              "file is empty - type a name into every row"
                            : "your quote file has no speaker column - add one headed " +
                              "\"المتحدث\" or \"Speaker\"") +
                        ", so every card keeps the template's name.";
            } else if (!nTarget && withSpeaker > 0) {
                note += "  |  your file has " + withSpeaker + " speaker name(s) but \"Name layer\" " +
                        "is \"(leave the name alone)\" - pick the name layer, or every card keeps " +
                        "the template's name.";
            }

            setStatus(ready + " card(s) ready out of " + plan.length + " quote(s)  |  " +
                      files.length + " clip(s) in the folder" +
                      (files.length > quotes.length
                        ? "  |  " + (files.length - quotes.length) + " clip(s) unused"
                        : "") + note);
        }

        function doCreate() {
            var comp = template();
            if (!comp || plan.length === 0) { setStatus("Scan first."); return; }

            var vTarget = selectedVideoTarget();
            var tTarget = selectedTextTarget();
            var nTarget = selectedNameTarget();
            var rTarget = selectedRoleTarget();
            if (!vTarget) { setStatus("No footage layer to swap."); return; }

            // Only the comps on the way down to the guest and the quote get a
            // private copy per card. Duplicating the outer comp alone would
            // leave all nine cards sharing one REPLACE-FOOTAGE precomp.
            var aTarget = selectedAlphaTarget();

            // This has now failed silently several times running: the cards
            // come out with the guest's whole studio behind them and nothing
            // stops to say the cut-out slot was never filled.
            var slot = "";
            for (var q = 0; q < videoTargets.length; q++) {
                var lbl = normalize(videoTargets[q].label);
                if (lbl.indexOf("alpha") !== -1 || lbl.indexOf("matte") !== -1) {
                    slot = videoTargets[q].label;
                    break;
                }
            }
            if (aTarget && aTarget === vTarget) {
                // Saying "this is wrong" and stopping leaves the user to guess
                // which of twenty entries is right. Name it.
                var suggest = -1;
                for (var sg = 0; sg < videoTargets.length; sg++) {
                    if (!videoTargets[sg].isEmpty) { suggest = sg; break; }
                }
                var realHit = guessIndex(videoTargets, "footage,video,guest,person,clip", true);
                if (realHit >= 0) { suggest = realHit; }

                setStatus("\"Video layer\" and \"Alpha layer\" are the SAME slot" +
                          (suggest >= 0 ? " - set Video layer to: " + videoTargets[suggest].label
                                        : " - pick different ones") + ".");
                alert("Video layer and Alpha layer both point at:\n\n    " + vTarget.label +
                      "\n\nThat slot is empty, so the clip would be written into it twice and " +
                      "the guest never swapped.\n\n" +
                      (suggest >= 0
                        ? "Set \"Video layer\" to:\n\n    " + videoTargets[suggest].label +
                          "\n\nand leave \"Alpha layer\" where it is."
                        : "This comp has no real footage layer - check you picked the comp you " +
                          "actually render.") +
                      "\n\nNo cut-out clips? Clear \"Alpha clips\" and set \"Alpha layer\" " +
                      "to \"(no separate alpha layer)\" - the cards still build.");
                return;
            }

            var gaveAlphaFolder = trim(alphaTxt.text) !== "";
            if ((slot !== "" || gaveAlphaFolder) && (!aTarget || alphaFiles.length === 0)) {
                var why = !aTarget
                    ? "no layer is chosen under \"Alpha layer\""
                    : "the \"Alpha clips\" folder has no clips in it";
                if (!confirm("The cut-out will NOT be replaced.\n\n" +
                             (slot !== "" ? "This template has a cut-out slot:\n    " + slot + "\n\n"
                                          : "You gave a folder of cut-out clips.\n\n") +
                             "but " + why + ", so every card will keep the guest's own\n" +
                             "background instead of being cut out.\n\n" +
                             "Build the cards anyway?", true)) {
                    setStatus("Stopped: pick the cut-out layer under \"Alpha layer\", then try again.");
                    return;
                }
            }

            var targetIds = {};
            targetIds[vTarget.comp.id] = true;
            if (tTarget) { targetIds[tTarget.comp.id] = true; }
            if (aTarget) { targetIds[aTarget.comp.id] = true; }
            if (nTarget) { targetIds[nTarget.comp.id] = true; }
            if (rTarget) { targetIds[rTarget.comp.id] = true; }
            var cloneIds = compsLeadingTo(comp, targetIds);

            var log = [];
            log.push("Quote Cards - " + new Date().toString());
            log.push("Template: " + comp.name);
            log.push("Video layer: " + vTarget.label + "   (in comp \"" + vTarget.comp.name + "\")");
            log.push("Alpha layer: " + (aTarget ? aTarget.label + "   (in comp \"" + aTarget.comp.name + "\")" : "none"));
            log.push("Text layer:  " + (tTarget ? tTarget.label + "   (in comp \"" + tTarget.comp.name + "\")" : "none"));
            log.push("Name layer:  " + (nTarget ? nTarget.label + "   (in comp \"" + nTarget.comp.name + "\")" : "none"));
            log.push("Title layer: " + (rTarget ? rTarget.label + "   (in comp \"" + rTarget.comp.name + "\")" : "none"));
            var cloneNames = [];
            for (var ci = 1; ci <= app.project.numItems; ci++) {
                var it = app.project.item(ci);
                if (it instanceof CompItem && cloneIds[it.id]) { cloneNames.push(it.name); }
            }
            log.push("Comps copied per card: " + cloneNames.join(", "));
            log.push("");

            var cache = {}, made = 0, skipped = 0, created = [], rotoOff = 0, mattePending = [];

            app.beginUndoGroup("Quote Cards - build " + plan.length + " cards");
            try {
                var folderItem = null;
                if (cbFolder.value) {
                    folderItem = app.project.items.addFolder(comp.name + " - cards");
                }

                for (var i = 0; i < plan.length; i++) {
                    var row = plan[i];
                    var tag = "[" + pad(row.index, 2) + "]";
                    if (!row.ok) { log.push(tag + " SKIPPED (no clip for this quote)"); skipped++; continue; }

                    var footage = importFootage(row.file, cache, planWarnings);
                    if (!footage) { log.push(tag + " SKIPPED (import failed)"); skipped++; continue; }
                    applyAlphaMode(footage, alphaChoice(), log);

                    var suffix = pad(row.index, 2);
                    var mapping = {};
                    var card = deepDuplicate(comp, cloneIds, mapping, suffix, log);
                    var clones = mappedClones(mapping);
                    if (folderItem) {
                        for (var c = 0; c < clones.length; c++) { clones[c].parentFolder = folderItem; }
                    }

                    var target = placeClip(vTarget, mapping[vTarget.comp.id], footage, log);
                    var maskCount = countMasks(target);
                    try {
                        log.push("    clip is " + footage.width + "x" + footage.height +
                                 "  " + footage.duration.toFixed(2) + "s" +
                                 "  hasAlpha=" + footage.mainSource.hasAlpha +
                                 "  alphaMode=" + alphaModeName(footage.mainSource.alphaMode));
                    } catch (eLog) {}
                    log.push(tag + " " + card.name + "   clip: " + row.file.name +
                             "   masks kept: " + maskCount +
                             "   comps copied: " + clones.length);

                    if (cbReset.value) { resetClipTiming(target, mapping[vTarget.comp.id], log); }
                    if (cbFit.value) { fitToComp(target, mapping[vTarget.comp.id], log); }

                    if (aTarget && row.alpha) {
                        var alphaFootage = importFootage(row.alpha, cache, planWarnings);
                        if (alphaFootage) {
                            applyAlphaMode(alphaFootage, alphaChoice(), log);
                            var aLayer = placeClip(aTarget, mapping[aTarget.comp.id],
                                                   alphaFootage, log);
                            var aHasAlpha = false, aDesc = "";
                            try {
                                aHasAlpha = alphaFootage.mainSource.hasAlpha;
                                aDesc = alphaFootage.width + "x" + alphaFootage.height +
                                        "  " + alphaFootage.duration.toFixed(2) + "s" +
                                        "  hasAlpha=" + aHasAlpha +
                                        "  alphaMode=" + alphaModeName(alphaFootage.mainSource.alphaMode);
                            } catch (eA) {}
                            log.push("    alpha: " + row.alpha.name + "   " + aDesc);

                            // A cut-out clip with no alpha channel is just the
                            // original again - the guest keeps their background
                            // and nothing on screen explains why.
                            if (!aHasAlpha) {
                                var msg = "Card " + pad(row.index, 2) + ": the cut-out clip \"" +
                                          row.alpha.name + "\" has NO alpha channel, so this " +
                                          "guest keeps their background. Re-export it with " +
                                          "transparency (ProRes 4444 or similar).";
                                planWarnings.push(msg);
                                log.push("    *** " + msg);
                            }
                            if (cbReset.value) { resetClipTiming(aLayer, mapping[aTarget.comp.id], log); }
                            if (cbFit.value) { fitToComp(aLayer, mapping[aTarget.comp.id], log); }
                            if (cbAlphaPath.value) {
                                enableLayersShowing(card, mapping[aTarget.comp.id], log);
                            }
                        }
                    } else if (aTarget && !row.alpha) {
                        log.push("    note: no alpha clip for this card, template alpha kept");
                    } else if (!aTarget) {
                        log.push("    note: NO ALPHA LAYER CHOSEN - this card uses the original " +
                                 "clip only, so the guest keeps their background");
                    }

                    if (tTarget) {
                        var textLayer = mapping[tTarget.comp.id].layer(tTarget.index);
                        if (setLayerText(textLayer, row.quote.text, log)) {
                            log.push("    text set (" + row.quote.text.length + " chars) on " +
                                     textLayer.name);
                            if (cbFitText.value) { fitTextToBox(textLayer, log); }
                        }
                    }
                    // Not conditional on having a cut-out: the strokes belong to
                    // the clip that WAS there either way, and leaving them on is
                    // what paints a piece of this clip over the quote box.
                    if (cbAlphaPath.value) {
                        var box = tTarget ? layerShowing(card, mapping[tTarget.comp.id]) : null;
                        if (box) {
                            var probs = [];
                            var moved = moveMattesBehindBox(card, box,
                                                            mapping[vTarget.comp.id], log, probs);
                            rotoOff += moved;
                            if (probs.length) {
                                mattePending.push(suffix + " -> " + probs.join("; "));
                            } else if (moved === 0) {
                                log.push("    nothing in front of the box draws the guest");
                                mattePending.push(suffix + " (nothing found in front of the box)");
                            }
                        } else {
                            log.push("    note: could not find the layer holding the quote box, " +
                                     "so the template's matte was left exactly as it was");
                            mattePending.push(suffix + " (quote box not found)");
                        }
                    }

                    writeSideText(nTarget, "name", row.quote.speaker, mapping, log);
                    writeSideText(rTarget, "title", row.quote.role, mapping, log);

                    if (cbMatte.value) {
                        var matte = buildMatteSetup(target, log);
                        log.push("    matte layer: " + matte.name);
                    }
                    created.push(card);
                    made++;
                }
            } catch (e) {
                planWarnings.push("Aborted: " + e.toString() + (e.line ? " (line " + e.line + ")" : ""));
            }
            app.endUndoGroup();

            log.push("");
            log.push("Cards created: " + made + "   Skipped: " + skipped);
            if (planWarnings.length) {
                log.push("");
                log.push("Warnings:");
                for (var w = 0; w < planWarnings.length; w++) { log.push("  - " + planWarnings[w]); }
            }

            // The setup is worth more than the log to the next person who opens
            // this episode folder on another machine.
            saveToMachine();
            var presetPath = writePreset(trim(quotesTxt.text), planWarnings);

            var logPath = "";
            try {
                var qf2 = new File(trim(quotesTxt.text));
                var out = new File(qf2.parent.fsName + "/" + baseName(qf2.name) + "_cards_log.txt");
                logPath = writeTextFile(out, log.join("\n"), planWarnings);
            } catch (e2) { planWarnings.push("Could not write the log: " + e2.toString()); }

            if (created.length) { created[0].openInViewer(); }

            setStatus("Created " + made + " card(s), skipped " + skipped +
                      (planWarnings.length ? ", " + planWarnings.length + " warning(s)" : "") +
                      (logPath ? "  |  log: " + logPath : ""));
            alert("Quote Cards\n\n" +
                  "Created: " + made + "     Skipped: " + skipped + "\n\n" +
                  "Footage -> " + vTarget.comp.name + " / " + vTarget.layer.name + "\n" +
                  "Alpha   -> " + (aTarget
                        ? aTarget.comp.name + " / " + aTarget.layer.name +
                          "   (" + alphaFiles.length + " clip(s))"
                        : "NOT SWAPPED - no alpha layer chosen, so the cut-out is " +
                          "whatever the template already had") + "\n" +
                  "Text    -> " + (tTarget ? tTarget.comp.name + " / " + tTarget.layer.name : "not touched") + "\n" +
                  "Name    -> " + (nTarget ? nTarget.comp.name + " / " + nTarget.layer.name : "not touched") +
                  "\n" +
                  "Title   -> " + (rTarget ? rTarget.comp.name + " / " + rTarget.layer.name : "not touched") +
                  (rotoOff > 0
                        ? "\n\nMoved " + rotoOff + " layer(s) behind the quote box. Their Roto " +
                          "Brush / Object Matte was painted on the template's own clip, so it " +
                          "could bleed over the box. The guest keeps his colours and stays in " +
                          "front of the red circle - he just cannot overlap the box any more."
                        : "") +
                  (mattePending.length
                        ? "\n\nCOULD NOT DO THAT ON CARD(S): " + mattePending.join(", ") +
                          "\nThose cards can still have a piece of the clip drawn over the box. " +
                          "Send the log file and it will say why."
                        : "") +
                  (planWarnings.length
                        ? "\n\nWarnings: " + planWarnings.length + "\n" +
                          planWarnings.slice(0, 4).join("\n") +
                          (planWarnings.length > 4 ? "\n..." : "")
                        : "") +
                  (presetPath ? "\n\nSetup saved to " + PRESET_NAME + " next to the quote " +
                                "list. Send that file with the episode and the next machine " +
                                "picks up these same layer choices." : "") +
                  (logPath ? "\n\nDetails:\n" + logPath : "") +
                  "\n\nOne Ctrl/Cmd+Z undoes all of it.");
        }

        /**
         * Writes the speaker's name, or their job title, onto its own layer.
         * The quote body is not the only text on one of these cards - leaving
         * these two alone is exactly what puts one guest's name on all nine.
         */
        function writeSideText(target, what, value, mapping, log) {
            if (!target) { return; }
            if (trim(value || "") === "") {
                log.push("    note: no " + what + " for this card, the template's " +
                         what + " is kept as it was");
                return;
            }
            var layer = mapping[target.comp.id].layer(target.index);
            if (setLayerText(layer, value, log)) {
                log.push("    " + what + " set: \"" + value + "\" on " + layer.name);
                if (cbFitText.value) { fitTextToBox(layer, log); }
            }
        }

        // ------------------------------------------------- remembering the setup
        //
        // The layer choices belong to the TEMPLATE, not to the machine or the
        // episode, so an editor should pick them once and never again - and a
        // second editor on another machine should not have to guess them at
        // all. They are stored by their full path label, which is the same
        // wherever the project is opened.

        var PRESET_NAME = "QuoteCards_setup.txt";

        function currentSetup() {
            var v = selectedVideoTarget(), a = selectedAlphaTarget();
            var t = selectedTextTarget(), n = selectedNameTarget(), r = selectedRoleTarget();
            return {
                template: template() ? template().name : "",
                video: v ? v.label : "",
                alpha: a ? a.label : "",
                text: t ? t.label : "",
                name: n ? n.label : "",
                title: r ? r.label : "",
                sort: cbSort.value ? "1" : "0",
                matte: cbMatte.value ? "1" : "0",
                reset: cbReset.value ? "1" : "0",
                fit: cbFit.value ? "1" : "0",
                alphaPath: cbAlphaPath.value ? "1" : "0",
                fitText: cbFitText.value ? "1" : "0",
                folder: cbFolder.value ? "1" : "0",
                alphaMode: String(alphaModeDrop.selection ? alphaModeDrop.selection.index : 0)
            };
        }

        function setupToText(o) {
            var out = [], k;
            out.push("# Quote Cards setup - keep this next to the quote list.");
            out.push("# It carries the layer choices, not any file path: paths differ");
            out.push("# per machine, the template's layers do not.");
            for (k in o) { if (o.hasOwnProperty(k)) { out.push(k + "\t" + o[k]); } }
            return out.join("\n");
        }

        function textToSetup(txt) {
            var o = {}, lines = String(txt).split(/\r\n|\r|\n/);
            for (var i = 0; i < lines.length; i++) {
                if (trim(lines[i]) === "" || lines[i].charAt(0) === "#") { continue; }
                var tab = lines[i].indexOf("\t");
                if (tab > 0) { o[trim(lines[i].substring(0, tab))] = lines[i].substring(tab + 1); }
            }
            return o;
        }

        /** Points a dropdown at the entry whose label matches, or leaves it be. */
        function selectByLabel(drop, targets, label, offset) {
            if (trim(label || "") === "") { return false; }
            for (var i = 0; i < targets.length; i++) {
                if (targets[i].label === label) { drop.selection = i + offset; return true; }
            }
            return false;
        }

        function applySetup(o) {
            if (!o) { return 0; }
            var hits = 0, i;
            if (trim(o.template || "") !== "") {
                for (i = 0; i < compList.length; i++) {
                    if (compList[i].name === o.template) { tplDrop.selection = i; hits++; break; }
                }
                refreshLayers();                       // the lists belong to that comp
            }
            if (selectByLabel(videoDrop, videoTargets, o.video, 0)) { hits++; }
            if (selectByLabel(alphaDrop, videoTargets, o.alpha, 1)) { hits++; }
            if (selectByLabel(textDrop, textTargets, o.text, 1)) { hits++; }
            if (selectByLabel(nameDrop, textTargets, o.name, 1)) { hits++; }
            if (selectByLabel(roleDrop, textTargets, o.title, 1)) { hits++; }

            function bool(v, cb) { if (v === "0" || v === "1") { cb.value = (v === "1"); } }
            bool(o.sort, cbSort); bool(o.matte, cbMatte); bool(o.reset, cbReset);
            bool(o.fit, cbFit); bool(o.alphaPath, cbAlphaPath); bool(o.fitText, cbFitText);
            bool(o.folder, cbFolder);
            var am = parseInt(o.alphaMode, 10);
            if (!isNaN(am) && am >= 0 && am < 4) { alphaModeDrop.selection = am; }
            return hits;
        }

        function presetBeside(quotesPath) {
            try {
                var qf = new File(trim(quotesPath));
                if (!qf.parent) { return null; }
                var pf = new File(qf.parent.fsName + "/" + PRESET_NAME);
                return pf.exists ? pf : null;
            } catch (e) { return null; }
        }

        /** Writes the setup next to the quote list, so it travels with the episode. */
        function writePreset(quotesPath, problems) {
            try {
                var qf = new File(trim(quotesPath));
                if (!qf.parent) { return ""; }
                return writeTextFile(new File(qf.parent.fsName + "/" + PRESET_NAME),
                                     setupToText(currentSetup()), problems);
            } catch (e) { return ""; }
        }

        function saveToMachine() {
            try {
                var o = currentSetup(), k;
                o.videosFolder = trim(videosTxt.text);
                o.alphaFolder = trim(alphaTxt.text);
                o.quotesFile = trim(quotesTxt.text);
                for (k in o) {
                    if (o.hasOwnProperty(k)) {
                        app.settings.saveSetting(QC_SETTINGS, k, String(o[k]));
                    }
                }
            } catch (e) {}
        }

        function loadFromMachine() {
            try {
                var o = {}, keys = ["template", "video", "alpha", "text", "name", "title",
                    "sort", "matte", "reset", "fit", "alphaPath", "fitText", "folder",
                    "alphaMode", "videosFolder", "alphaFolder", "quotesFile"];
                var any = false;
                for (var i = 0; i < keys.length; i++) {
                    if (app.settings.haveSetting(QC_SETTINGS, keys[i])) {
                        o[keys[i]] = app.settings.getSetting(QC_SETTINGS, keys[i]);
                        any = true;
                    }
                }
                if (!any) { return; }
                if (trim(o.videosFolder || "") !== "") { videosTxt.text = o.videosFolder; }
                if (trim(o.alphaFolder || "") !== "") { alphaTxt.text = o.alphaFolder; }
                if (trim(o.quotesFile || "") !== "") { quotesTxt.text = o.quotesFile; }
                applySetup(o);
            } catch (e) {}
        }

        function doReport() {
            var comp = template();
            if (!comp) { setStatus("Pick a template comp first."); return; }

            var out = [];
            out.push("Quote Cards - template report");
            out.push(new Date().toString());
            out.push("After Effects " + app.version);
            out.push("Project: " + (app.project.file ? app.project.file.fsName : "(unsaved)"));
            out.push("");
            out.push("Chosen video layer: " + (selectedVideoTarget() ? selectedVideoTarget().label : "none"));
            out.push("Chosen alpha layer: " + (selectedAlphaTarget() ? selectedAlphaTarget().label : "none"));
            out.push("Chosen text layer:  " + (selectedTextTarget() ? selectedTextTarget().label : "none"));
            out.push("Chosen name layer:  " + (selectedNameTarget() ? selectedNameTarget().label : "none"));
            out.push("Chosen title layer: " + (selectedRoleTarget() ? selectedRoleTarget().label : "none"));
            out.push("");
            out.push("Clips folder: " + trim(videosTxt.text));
            out.push("Alpha folder: " + (trim(alphaTxt.text) || "(none)"));
            out.push("Quotes file:  " + trim(quotesTxt.text));
            out.push("");

            var files = [];
            var vf = trim(videosTxt.text);
            if (vf !== "") {
                var folder = new Folder(vf);
                if (folder.exists) {
                    scanVideos(folder, files, 0);
                    sortFilesNaturally(files);
                    out.push("Clips found, in the order they will be used:");
                    for (var i = 0; i < files.length; i++) {
                        out.push("  " + (i + 1) + ". " + files[i].name);
                    }
                    out.push("");
                }
            }

            out.push(new Array(70).join("="));
            out.push("");
            describeTree(comp, out, 0, {});

            var target = null;
            try {
                var base = app.project.file ? app.project.file.parent
                                            : new File(trim(quotesTxt.text)).parent;
                target = new File(base.fsName + "/QuoteCards_report.txt");
            } catch (e) { target = null; }

            var problems = [];
            var written = target ? writeTextFile(target, out.join("\n"), problems) : "";
            if (written !== "") {
                setStatus("Report written: " + written);
                alert("Template report written to:\n\n" + written +
                      "\n\nSend this file on - it says exactly what the tool sees.");
            } else {
                setStatus("Could not write the report - see the message.");
                alert("Could not write the report.\n\n" +
                      (problems.length ? problems.join("\n\n") + "\n\n" : "") +
                      "In After Effects: Settings (or Preferences) > Scripting & Expressions >\n" +
                      "tick \"Allow Scripts to Write Files and Access Network\",\n" +
                      "then press Report again.");
            }
        }

        scanBtn.onClick = doScan;
        reportBtn.onClick = doReport;
        goBtn.onClick = doCreate;
        helpBtn.onClick = function () {
            alert(
                "Quote Cards\n\n" +
                "Turns ONE template comp into a card per quote.\n\n" +
                "1. Template comp - the comp you actually RENDER. Its layers and\n" +
                "   the layers of every comp inside it are searched, so a template\n" +
                "   built around REPLACE-FOOTAGE / REPLACE-PARAGRAPH precomps works:\n" +
                "   pick the guest layer and the quote layer wherever they live.\n" +
                "   The template is never modified - each card is a copy.\n\n" +
                "   Those precomps are copied per card as well, so editing card 3\n" +
                "   cannot change cards 1 and 2.\n\n" +
                "2. Clips folder - the speaker clips. Their order decides who\n" +
                "   appears: 1st clip goes to quote 1, 2nd to quote 2, and so on,\n" +
                "   sorted naturally so clip2 comes before clip10.\n\n" +
                "3. Alpha clips (optional) - if your template keeps a separate\n" +
                "   cut-out layer (REPLACE-ALPHA-FOOTAGE and the like), point this\n" +
                "   at a folder of pre-keyed clips in the SAME order. A script\n" +
                "   cannot rotoscope a person, so the cut-outs have to be made\n" +
                "   first - in Roto Brush, a keyer, or an external tool - and this\n" +
                "   just drops the right one into each card.\n\n" +
                "4. Quotes file - one of:\n" +
                "     .csv  the wordiest column is taken as the quote text\n" +
                "     .txt  one quote per paragraph (or per line)\n" +
                "     .srt  the \"# ...\" comment under each timecode block\n\n" +
                "   A .csv can also name the guest. Head one column \"Speaker\"\n" +
                "   (or \"المتحدث\") and another \"Title\" (or \"الصفة\"), then point\n" +
                "   \"Name layer\" and \"Title layer\" at the lines on the card. Leave\n" +
                "   either on \"leave alone\" and that line keeps whatever the\n" +
                "   template said - which is how one guest's name ends up on\n" +
                "   every card while the quotes all change correctly.\n\n" +
                "5. Scan shows each quote next to the clip it will get.\n" +
                "   Nothing is created yet.\n\n" +
                "6. Create cards duplicates the template once per quote, swaps\n" +
                "   the clip, and sets the text - keeping the font, size, colour\n" +
                "   and alignment you already set, shrinking the type if the quote\n" +
                "   is longer than the box it lands in.\n\n" +
                "Masks and effects survive: the layer is reused, not rebuilt.\n\n" +
                "If your template cuts the guest out with Roto Brush, those strokes\n" +
                "belong to the clip they were painted on and cannot follow a new one -\n" +
                "no script can repaint them. Supply cut-out clips instead and let the\n" +
                "last option switch the template over to them.\n\n" +
                "If a card comes out BLACK, the placeholder it replaced was trimmed\n" +
                "out of a long recording, so the layer was reading past the end of\n" +
                "your clip. \"Start each clip at its own beginning\" fixes that.\n\n" +
                "The matte option adds a [MATTE] layer above each swapped clip,\n" +
                "wired as an alpha track matte with Simple Choker and a blur.\n\n" +
                "Arabic text needs After Effects' Middle Eastern text engine:\n" +
                "Preferences > Type > Text Engine > South Asian and Middle Eastern.\n\n" +
                "Everything runs in one undo group: Ctrl/Cmd+Z reverts it all."
            );
        };

        refreshComps();
        loadFromMachine();          // pick up where this machine left off
        maybeScan();
        win.onResizing = win.onResize = function () { this.layout.resize(); };

        if (win instanceof Window) { win.center(); win.show(); }
        else { win.layout.layout(true); win.layout.resize(); }
        return win;
    }

    build(thisObj);

})(this);
