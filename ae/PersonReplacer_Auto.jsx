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

        var quotes = [];
        for (i = 0; i < texts.length; i++) {
            quotes.push({
                index: i + 1,
                text: texts[i],
                speaker: speakers[i] || "",
                role: roles[i] || "",
                speakerColumn: speakerHeader
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
    function moveMattesBehindBox(card, boxLayer, log) {
        if (!card || !boxLayer) { return 0; }
        var pending = [], i;
        for (i = 1; i <= card.numLayers; i++) {
            var L = card.layer(i);
            if (L === boxLayer) { continue; }
            if (L.index > boxLayer.index) { continue; }     // already behind it
            if (rotoEffectName(L) === "") { continue; }
            pending.push(L);
        }
        for (i = 0; i < pending.length; i++) {
            var name = pending[i].name, fx = rotoEffectName(pending[i]);
            try {
                pending[i].moveAfter(boxLayer);
                log.push("    moved \"" + name + "\" behind \"" + boxLayer.name + "\" - its \"" +
                         fx + "\" was painted on the template's own clip, so it can bleed over " +
                         "the box. Behind it, the box always wins; the guest keeps his colours " +
                         "and stays in front of the circle.");
            } catch (e) {
                log.push("    note: could not move \"" + name + "\" behind the box: " + e.toString());
                return i;
            }
        }
        return pending.length;
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
