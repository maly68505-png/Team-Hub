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
                    out.push({
                        comp: comp, layer: L, index: L.index,
                        label: (comp === root ? "" : path + "  >  ") + L.index + ": " + L.name
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
