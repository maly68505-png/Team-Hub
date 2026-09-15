/**
 * Person Replacer  -  After Effects ScriptUI panel
 * ------------------------------------------------
 * Reads an SRT-style timecode script, finds the video layer that is live at
 * each timecode, and replaces its footage source with another person's clip.
 *
 * The layer itself is never rebuilt: masks, effects, transforms and keyframes
 * all survive, exactly like an Alt+drag "replace footage".
 *
 * Install:  copy to
 *   Win  C:\Program Files\Adobe\Adobe After Effects <ver>\Support Files\Scripts\ScriptUI Panels\
 *   Mac  /Applications/Adobe After Effects <ver>/Scripts/ScriptUI Panels/
 * then restart AE and open  Window > PersonReplacer.jsx
 *
 * Requires: Preferences > Scripting & Expressions > "Allow Scripts to Write
 * Files and Access Network" (for the log file only).
 *
 * GENERATED FILE - do not edit directly.
 * Edit ae/lib/core.jsxinc or ae/lib/ui-*.jsxinc, then run: node ae/build.js
 */

(function personReplacer(thisObj) {

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

    /** The column carrying the quotes is simply the wordiest one. */
    function pickTextColumn(rows) {
        var widest = 0, c;
        for (var r = 0; r < rows.length; r++) { widest = Math.max(widest, rows[r].length); }
        var best = 0, bestScore = -1;
        for (c = 0; c < widest; c++) {
            var total = 0, n = 0;
            for (var i = 1; i < rows.length; i++) {          // skip a header row
                if (rows[i].length <= c) { continue; }
                total += trim(rows[i][c]).length;
                n++;
            }
            var score = n ? total / n : 0;
            if (score > bestScore) { bestScore = score; best = c; }
        }
        return best;
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
            var col = pickTextColumn(rows);
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
            var speakerCol = -1, roleCol = -1;
            if (start === 1) {                               // only a real header can name them
                speakerCol = pickLabelledColumn(rows, SPEAKER_HINTS, col);
                roleCol = pickLabelledColumn(rows, ROLE_HINTS, col);
                if (roleCol === speakerCol) { roleCol = -1; }
                if (speakerCol >= 0) { speakerHeader = trim(rows[0][speakerCol]); }
            }
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

    function build(thisObj) {
        var win = (thisObj instanceof Panel)
            ? thisObj
            : new Window("palette", SCRIPT_NAME, undefined, { resizeable: true });

        win.orientation = "column";
        win.alignChildren = ["fill", "top"];
        win.spacing = 8;
        win.margins = 12;

        function pathRow(labelText, buttonText, isFolder) {
            var g = win.add("group");
            g.orientation = "row";
            g.alignChildren = ["left", "center"];
            var lbl = g.add("statictext", undefined, labelText);
            lbl.preferredSize.width = 92;
            var txt = g.add("edittext", undefined, "");
            txt.alignment = ["fill", "center"];
            txt.preferredSize.width = 320;
            var btn = g.add("button", undefined, buttonText);
            btn.preferredSize.width = 70;
            btn.onClick = function () {
                var picked = isFolder
                    ? Folder.selectDialog("Choose the folder with the person videos")
                    : File.openDialog("Choose the timecode script (.srt / .txt)");
                if (!picked) { return; }
                txt.text = picked.fsName;
                maybeScan();          // setting .text from code fires no onChange
            };
            txt.onChange = function () { maybeScan(); };
            return txt;
        }

        var videosTxt = pathRow("Videos folder:", "Browse", true);
        var scriptTxt = pathRow("Script file:", "Browse", false);

        var compGroup = win.add("group");
        compGroup.orientation = "row";
        compGroup.alignChildren = ["left", "center"];
        var compLbl = compGroup.add("statictext", undefined, "Target comp:");
        compLbl.preferredSize.width = 92;
        var compDrop = compGroup.add("dropdownlist", undefined, []);
        compDrop.alignment = ["fill", "center"];
        compDrop.preferredSize.width = 320;
        var refreshBtn = compGroup.add("button", undefined, "Refresh");
        refreshBtn.preferredSize.width = 70;

        var compList = [];
        function refreshComps() {
            compList = listComps();
            compDrop.removeAll();
            var activeIdx = 0;
            var active = app.project.activeItem;
            for (var i = 0; i < compList.length; i++) {
                compDrop.add("item", compList[i].name);
                if (active && active === compList[i]) { activeIdx = i; }
            }
            if (compList.length > 0) { compDrop.selection = activeIdx; }
        }
        /** Everything needed is filled in, so show the plan without being asked. */
        function maybeScan() {
            if (!currentComp()) { return; }
            if (trim(videosTxt.text) === "" || trim(scriptTxt.text) === "") { return; }
            doScan();
        }

        refreshBtn.onClick = function () { refreshComps(); maybeScan(); };
        compDrop.onChange = function () { maybeScan(); };

        var opts = win.add("panel", undefined, "Options");
        opts.orientation = "column";
        opts.alignChildren = ["left", "top"];
        opts.margins = [12, 16, 12, 12];
        opts.spacing = 4;

        var cbSplit = opts.add("checkbox", undefined,
            "Split the layer to the timecode range (isolate each segment)");
        cbSplit.value = true;
        var cbMatte = opts.add("checkbox", undefined,
            "Build refine-ready matte (duplicate above as [MATTE] + alpha track matte)");
        cbMatte.value = true;
        var cbScale = opts.add("checkbox", undefined,
            "Compensate scale when the new clip has different dimensions");
        cbScale.value = false;
        var cbLog = opts.add("checkbox", undefined,
            "Write a log file next to the script file");
        cbLog.value = true;

        var listGroup = win.add("group");
        listGroup.orientation = "column";
        listGroup.alignChildren = ["fill", "fill"];
        listGroup.alignment = ["fill", "fill"];
        var list = listGroup.add("listbox", undefined, [], {
            numberOfColumns: 6,
            showHeaders: true,
            columnTitles: ["#", "In", "Out", "Person", "Source file", "Target layer"],
            columnWidths: [30, 86, 86, 110, 190, 150]
        });
        list.preferredSize.height = 200;
        list.alignment = ["fill", "fill"];

        var status = win.add("statictext", undefined,
            "Pick a videos folder and a script file - the plan below fills in by itself.");
        status.alignment = ["fill", "top"];

        var buttons = win.add("group");
        buttons.orientation = "row";
        buttons.alignment = ["fill", "bottom"];
        var scanBtn = buttons.add("button", undefined, "Scan");
        var applyBtn = buttons.add("button", undefined, "Apply");
        var helpBtn = buttons.add("button", undefined, "Help");
        applyBtn.enabled = false;

        // ------------------------------------------------------- state + run

        var plan = [];
        var planWarnings = [];

        function setStatus(msg) {
            status.text = msg;
            win.update && win.update();
        }

        function currentComp() {
            if (!compDrop.selection) { return null; }
            return compList[compDrop.selection.index];
        }

        function saveSettings() {
            try {
                app.settings.saveSetting(SETTINGS_SECTION, "videos", videosTxt.text);
                app.settings.saveSetting(SETTINGS_SECTION, "script", scriptTxt.text);
            } catch (e) {}
        }

        function loadSettings() {
            try {
                if (app.settings.haveSetting(SETTINGS_SECTION, "videos")) {
                    videosTxt.text = app.settings.getSetting(SETTINGS_SECTION, "videos");
                }
                if (app.settings.haveSetting(SETTINGS_SECTION, "script")) {
                    scriptTxt.text = app.settings.getSetting(SETTINGS_SECTION, "script");
                }
            } catch (e) {}
        }

        function doScan() {
            list.removeAll();
            plan = [];
            planWarnings = [];
            applyBtn.enabled = false;

            var comp = currentComp();
            if (!comp) { setStatus("No comp selected. Hit Refresh."); return; }

            var vf = trim(videosTxt.text);
            var sf = trim(scriptTxt.text);
            if (vf === "") { setStatus("Pick the videos folder."); return; }
            if (sf === "") { setStatus("Pick the timecode script file."); return; }

            var folder = new Folder(vf);
            if (!folder.exists) { setStatus("Videos folder not found: " + vf); return; }
            var scriptFile = new File(sf);
            if (!scriptFile.exists) { setStatus("Script file not found: " + sf); return; }

            var problem = scriptFileProblem(scriptFile);
            if (problem) {
                setStatus("Wrong kind of file - see the message.");
                alert(problem);
                return;
            }

            var files = [];
            scanVideos(folder, files, 0);
            if (files.length === 0) {
                setStatus("No video files found under " + folder.fsName);
                return;
            }

            var segments = parseScript(scriptFile, comp.frameRate, planWarnings);
            if (segments.length === 0) {
                setStatus("No timecode lines found in \"" + scriptFile.name +
                          "\". It must be plain text - press Help for the format.");
                return;
            }

            var ready = 0;
            for (var i = 0; i < segments.length; i++) {
                var seg = segments[i];
                var file = pickFile(seg.person, seg.explicitFile, files);
                var mid = (seg.inSec + seg.outSec) / 2;
                var layer = layerAtTime(comp, mid, true);

                var row = {
                    index: i + 1,
                    seg: seg,
                    file: file,
                    layer: layer,
                    ok: !!(file && layer)
                };
                if (!file) {
                    planWarnings.push("No video file matched \"" + seg.person + "\" at " +
                                      secondsToTC(seg.inSec, comp.frameRate));
                }
                if (!layer) {
                    planWarnings.push("No footage layer live at " +
                                      secondsToTC(mid, comp.frameRate) +
                                      " (for \"" + seg.person + "\")");
                }
                if (row.ok) { ready++; }
                plan.push(row);

                var item = list.add("item", String(row.index));
                item.subItems[0].text = secondsToTC(seg.inSec, comp.frameRate);
                item.subItems[1].text = secondsToTC(seg.outSec, comp.frameRate);
                item.subItems[2].text = seg.person;
                item.subItems[3].text = file ? file.name : "-- no match --";
                item.subItems[4].text = layer ? (layer.index + ": " + layer.name) : "-- no layer --";
            }

            applyBtn.enabled = ready > 0;
            setStatus(ready + " of " + plan.length + " segments ready" +
                      (planWarnings.length ? "  |  " + planWarnings.length + " warning(s), see log" : "") +
                      "  |  " + files.length + " clips in folder");
            saveSettings();
        }

        function doApply() {
            var comp = currentComp();
            if (!comp) { setStatus("No comp selected."); return; }
            if (plan.length === 0) { setStatus("Scan first."); return; }

            var log = [];
            log.push(SCRIPT_NAME + " - " + new Date().toString());
            log.push("Comp: " + comp.name + "  (" + comp.frameRate + " fps)");
            log.push("Videos: " + videosTxt.text);
            log.push("Script: " + scriptTxt.text);
            log.push("");

            var cache = {};
            var warnings = [];
            var applied = 0, skipped = 0;

            app.beginUndoGroup(SCRIPT_NAME + " - replace people");
            try {
                // Apply latest-first so that splitting earlier segments cannot
                // shift the layers we already resolved for later ones.
                for (var i = plan.length - 1; i >= 0; i--) {
                    var row = plan[i];
                    var seg = row.seg;
                    var tag = "[" + row.index + "] " + secondsToTC(seg.inSec, comp.frameRate) +
                              " -> " + secondsToTC(seg.outSec, comp.frameRate) +
                              "  " + seg.person;

                    if (!row.ok) {
                        log.push(tag + "  SKIPPED (" +
                                 (!row.file ? "no matching video file" : "no layer at that timecode") + ")");
                        skipped++;
                        continue;
                    }

                    var footage = importFootage(row.file, cache, warnings);
                    if (!footage) {
                        log.push(tag + "  SKIPPED (import failed)");
                        skipped++;
                        continue;
                    }

                    // Re-resolve the layer against the live comp: an earlier
                    // split may have replaced the object we cached at scan time.
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

                    if (cbSplit.value) {
                        target = isolateRange(target, seg.inSec, seg.outSec);
                    }

                    target.replaceSource(footage, false);
                    log.push(tag);
                    log.push("    layer " + target.index + ": " + oldName +
                             "   " + oldSrcName + "  ->  " + row.file.name);
                    log.push("    masks preserved: " + maskCount);

                    if (cbScale.value) {
                        compensateScale(target, oldW, oldH, log);
                    }
                    if (cbMatte.value) {
                        if (maskCount === 0) {
                            log.push("    note: no masks on this layer, matte layer built empty - " +
                                     "draw the cut-out on the [MATTE] layer");
                        }
                        var matte = buildMatteSetup(target, log);
                        log.push("    matte layer created: " + matte.name +
                                 " (alpha matte, Simple Choker + blur for edge refine)");
                    }
                    applied++;
                }
            } catch (e) {
                warnings.push("Aborted: " + e.toString() + (e.line ? " (line " + e.line + ")" : ""));
            }
            app.endUndoGroup();

            log.push("");
            log.push("Applied: " + applied + "   Skipped: " + skipped);
            var allWarnings = planWarnings.concat(warnings);
            if (allWarnings.length) {
                log.push("");
                log.push("Warnings:");
                for (var w = 0; w < allWarnings.length; w++) { log.push("  - " + allWarnings[w]); }
            }

            var logPath = "";
            if (cbLog.value) {
                try {
                    var sFile = new File(trim(scriptTxt.text));
                    var out = new File(sFile.parent.fsName + "/" + baseName(sFile.name) + "_replace_log.txt");
                    if (out.open("w")) {
                        out.write(log.join("\n"));
                        out.close();
                        logPath = out.fsName;
                    }
                } catch (e2) { /* scripting file access probably off */ }
            }

            setStatus("Applied " + applied + ", skipped " + skipped +
                      (allWarnings.length ? ", " + allWarnings.length + " warning(s)" : "") +
                      (logPath ? "  |  log: " + logPath : ""));
            doScan();
        }

        scanBtn.onClick = doScan;
        applyBtn.onClick = doApply;
        helpBtn.onClick = function () {
            alert(
                SCRIPT_NAME + "\n\n" +
                "1. Videos folder - the folder holding each person's clips.\n" +
                "   A clip is matched when its filename contains the person\n" +
                "   name from the script, e.g. PERSON_B_take3.mp4 matches PERSON_B.\n" +
                "   Subfolders are scanned too.\n\n" +
                "2. Script file - SRT style timecodes:\n\n" +
                "   1\n" +
                "   00:00:12:00 --> 00:00:18:00\n" +
                "   PERSON_B\n\n" +
                "   Also accepted: 00:00:12,500 (milliseconds), one-line form\n" +
                "   \"00:00:12:00 --> 00:00:18:00  PERSON_B\", \"PERSON_B: dialogue\",\n" +
                "   \"[PERSON_B]\", and \"PERSON_B | exact_clip.mp4\" to force a file.\n" +
                "   Lines starting with # or // are comments.\n\n" +
                "3. Scan shows exactly what will happen. Nothing is touched yet.\n\n" +
                "4. Apply swaps the footage source on whichever video layer is\n" +
                "   live at each timecode. Masks, effects, transforms and\n" +
                "   keyframes stay on the layer.\n\n" +
                "Split: isolates the timecode range so one long layer can carry\n" +
                "several different people.\n\n" +
                "Matte: duplicates the swapped layer above itself as [MATTE],\n" +
                "sets it as an alpha track matte, and adds Simple Choker + blur\n" +
                "for edge refining. The lower layer keeps its masks but their\n" +
                "mode is set to None so the [MATTE] layer is the only cut-out.\n" +
                "Roto Brush cannot be scripted - apply it on the [MATTE] layer.\n\n" +
                "Everything runs in one undo group: Ctrl/Cmd+Z reverts it all."
            );
        };

        loadSettings();
        refreshComps();

        win.onResizing = win.onResize = function () { this.layout.resize(); };

        if (win instanceof Window) {
            win.center();
            win.show();
        } else {
            win.layout.layout(true);
            win.layout.resize();
        }
        return win;
    }

    build(thisObj);

})(this);
