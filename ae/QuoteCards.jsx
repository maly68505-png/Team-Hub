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
     * Reads the quote list. Accepts:
     *   .csv  - the wordiest column is taken as the quote text
     *   .srt  - the "# ..." comment carried under each timecode block
     *   .txt  - one quote per paragraph, or per line when there are no blanks
     * Returns [{ index, text }].
     */
    function parseQuotesFile(file, warnings) {
        if (!file.open("r")) {
            warnings.push("Could not open the quotes file: " + file.fsName);
            return [];
        }
        var raw = file.read();
        file.close();
        raw = raw.replace(/^\uFEFF/, "");

        var texts = [], i;
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
            for (i = start; i < rows.length; i++) {
                if (rows[i].length > col) {
                    var v = trim(rows[i][col]);
                    if (v !== "") { texts.push(v); }
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
            quotes.push({ index: i + 1, text: texts[i] });
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
        var out = [], seen = {};
        walk(root, root.name, 0);
        return out;

        function walk(comp, path, depth) {
            if (!comp || seen[comp.id] || depth > 8) { return; }
            seen[comp.id] = true;
            for (var i = 1; i <= comp.numLayers; i++) {
                var L = comp.layer(i);
                var isText = (L instanceof TextLayer);
                if (wantText ? isText : isSwappableLayer(L)) {
                    var where = (comp === root ? "" : path + "  >  ") + L.index + ": " + L.name;
                    var sample = isText ? layerTextValue(L) : "";
                    out.push({
                        comp: comp, layer: L, index: L.index, sample: sample,
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

    /** Makes an imported clip's alpha actually count when it has one. */
    function honourAlpha(item, log) {
        try {
            var ms = item.mainSource;
            if (!ms.hasAlpha) { return false; }
            if (ms.alphaMode === AlphaMode.IGNORE) {
                ms.alphaMode = AlphaMode.STRAIGHT;
                log.push("    alpha was set to IGNORE on import - switched to STRAIGHT");
                return true;
            }
        } catch (e) {}
        return false;
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
                maybeScan();          // setting .text from code fires no onChange
            };
            txt.onChange = function () { maybeScan(); };
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
        var cbAlphaMode = opts.add("checkbox", undefined,
            "Use a clip's alpha channel when it has one (AE sometimes imports it as Ignore)");
        cbAlphaMode.value = true;
        var cbFitText = opts.add("checkbox", undefined,
            "Shrink the type until the quote fits its text box");
        cbFitText.value = true;
        var cbFolder = opts.add("checkbox", undefined,
            "Collect the finished cards in one Project panel folder");
        cbFolder.value = true;

        var list = win.add("listbox", undefined, [], {
            numberOfColumns: 4, showHeaders: true,
            columnTitles: ["#", "Clip", "Alpha", "Quote"],
            columnWidths: [30, 170, 170, 300]
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
            if (videoTargets.length) { videoDrop.selection = bestGuess(videoTargets, "footage,video,guest,person,clip"); }
            else { videoDrop.add("item", "-- no footage layer anywhere in this comp --"); videoDrop.selection = 0; }

            alphaDrop.removeAll();
            alphaDrop.add("item", videoTargets.length
                ? "(no separate alpha layer)"
                : "-- no footage layer anywhere in this comp --");
            for (var a = 0; a < videoTargets.length; a++) {
                alphaDrop.add("item", videoTargets[a].label);
            }
            var alphaHit = videoTargets.length
                ? guessIndex(videoTargets, "alpha,matte,luma,cutout,key") : -1;
            alphaDrop.selection = (alphaHit >= 0) ? alphaHit + 1 : 0;

            textTargets = collectTargets(comp, true);
            textDrop.add("item", textTargets.length
                ? "(leave the text alone)"
                : "-- no text layer anywhere in this comp --");
            for (var k = 0; k < textTargets.length; k++) {
                textDrop.add("item", textTargets[k].label);
            }
            textDrop.selection = textTargets.length ? bestTextGuess(textTargets) + 1 : 0;
        }

        /** Everything needed is filled in, so show the plan without being asked. */
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
        function guessIndex(targets, hintCSV) {
            var hints = hintCSV.split(",");
            for (var h = 0; h < hints.length; h++) {
                var want = normalize(hints[h]);
                for (var i = 0; i < targets.length; i++) {
                    if (normalize(targets[i].label).indexOf(want) !== -1) { return i; }
                }
            }
            return -1;
        }

        /** Same, but falls back to the first layer when nothing is named. */
        function bestGuess(targets, hintCSV) {
            var i = guessIndex(targets, hintCSV);
            return i < 0 ? 0 : i;
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

            for (var i = 0; i < quotes.length; i++) {
                var clip = (i < files.length) ? files[i] : null;
                if (!clip) {
                    planWarnings.push("Quote " + (i + 1) + " has no clip: the folder holds only " +
                                      files.length + " clip(s).");
                }
                var alphaClip = (i < alphaFiles.length) ? alphaFiles[i] : null;
                plan.push({ index: i + 1, quote: quotes[i], file: clip, alpha: alphaClip, ok: !!clip });

                var it = list.add("item", String(i + 1));
                it.subItems[0].text = clip ? clip.name : "-- no clip --";
                it.subItems[1].text = alphaClip ? alphaClip.name
                    : (aTarget && af !== "" ? "-- none --" : "");
                it.subItems[2].text = quotes[i].text.length > 80
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
                    break;
                }
            }

            var note = "";
            if (alphaSlot !== "" && !aTarget) {
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
            if (slot !== "" && (!aTarget || alphaFiles.length === 0)) {
                var why = !aTarget
                    ? "no layer is chosen under \"Alpha layer\""
                    : "the \"Alpha clips\" folder has no clips in it";
                if (!confirm("The cut-out will NOT be replaced.\n\n" +
                             "This template has a cut-out slot:\n    " + slot + "\n\n" +
                             "but " + why + ", so every card will keep the guest's own\n" +
                             "background instead of being cut out.\n\n" +
                             "Build the cards anyway?", true)) {
                    setStatus("Stopped: fill in \"Alpha layer\" and \"Alpha clips\", then try again.");
                    return;
                }
            }

            var targetIds = {};
            targetIds[vTarget.comp.id] = true;
            if (tTarget) { targetIds[tTarget.comp.id] = true; }
            if (aTarget) { targetIds[aTarget.comp.id] = true; }
            var cloneIds = compsLeadingTo(comp, targetIds);

            var log = [];
            log.push("Quote Cards - " + new Date().toString());
            log.push("Template: " + comp.name);
            log.push("Video layer: " + vTarget.label + "   (in comp \"" + vTarget.comp.name + "\")");
            log.push("Alpha layer: " + (aTarget ? aTarget.label + "   (in comp \"" + aTarget.comp.name + "\")" : "none"));
            log.push("Text layer:  " + (tTarget ? tTarget.label + "   (in comp \"" + tTarget.comp.name + "\")" : "none"));
            var cloneNames = [];
            for (var ci = 1; ci <= app.project.numItems; ci++) {
                var it = app.project.item(ci);
                if (it instanceof CompItem && cloneIds[it.id]) { cloneNames.push(it.name); }
            }
            log.push("Comps copied per card: " + cloneNames.join(", "));
            log.push("");

            var cache = {}, made = 0, skipped = 0, created = [];

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
                    if (cbAlphaMode.value) { honourAlpha(footage, log); }

                    var suffix = pad(row.index, 2);
                    var mapping = {};
                    var card = deepDuplicate(comp, cloneIds, mapping, suffix);
                    var clones = mappedClones(mapping);
                    if (folderItem) {
                        for (var c = 0; c < clones.length; c++) { clones[c].parentFolder = folderItem; }
                    }

                    var target = mapping[vTarget.comp.id].layer(vTarget.index);
                    var maskCount = countMasks(target);

                    target.replaceSource(footage, false);
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
                            if (cbAlphaMode.value) { honourAlpha(alphaFootage, log); }
                            var aLayer = mapping[aTarget.comp.id].layer(aTarget.index);
                            aLayer.replaceSource(alphaFootage, false);
                            log.push("    alpha: " + row.alpha.name);
                            if (cbReset.value) { resetClipTiming(aLayer, mapping[aTarget.comp.id], log); }
                            if (cbFit.value) { fitToComp(aLayer, mapping[aTarget.comp.id], log); }
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

            var logPath = "";
            try {
                var qf2 = new File(trim(quotesTxt.text));
                var out = new File(qf2.parent.fsName + "/" + baseName(qf2.name) + "_cards_log.txt");
                if (out.open("w")) { out.write(log.join("\n")); out.close(); logPath = out.fsName; }
            } catch (e2) {}

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
                  "Text    -> " + (tTarget ? tTarget.comp.name + " / " + tTarget.layer.name : "not touched") +
                  (planWarnings.length ? "\n\nWarnings: " + planWarnings.length : "") +
                  (logPath ? "\n\nDetails:\n" + logPath : "") +
                  "\n\nOne Ctrl/Cmd+Z undoes all of it.");
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
                if (!target.open("w")) { target = null; }
            } catch (e) { target = null; }

            if (target) {
                target.write(out.join("\n"));
                target.close();
                setStatus("Report written: " + target.fsName);
                alert("Template report written to:\n\n" + target.fsName +
                      "\n\nSend this file on - it says exactly what the tool sees.");
            } else {
                setStatus("Could not write the report file.");
                alert("Could not write the report.\n\nTurn on Preferences > Scripting & " +
                      "Expressions > Allow Scripts to Write Files and Access Network, " +
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
                "5. Scan shows each quote next to the clip it will get.\n" +
                "   Nothing is created yet.\n\n" +
                "6. Create cards duplicates the template once per quote, swaps\n" +
                "   the clip, and sets the text - keeping the font, size, colour\n" +
                "   and alignment you already set, shrinking the type if the quote\n" +
                "   is longer than the box it lands in.\n\n" +
                "Masks and effects survive: the layer is reused, not rebuilt.\n\n" +
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
        win.onResizing = win.onResize = function () { this.layout.resize(); };

        if (win instanceof Window) { win.center(); win.show(); }
        else { win.layout.layout(true); win.layout.resize(); }
        return win;
    }

    build(thisObj);

})(this);
