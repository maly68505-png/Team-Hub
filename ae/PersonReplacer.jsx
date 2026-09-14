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
                if (picked) { txt.text = picked.fsName; }
            };
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
        refreshBtn.onClick = refreshComps;

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

        var status = win.add("statictext", undefined, "Pick a videos folder and a script file, then Scan.");
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

            var files = [];
            scanVideos(folder, files, 0);
            if (files.length === 0) {
                setStatus("No video files found under " + folder.fsName);
                return;
            }

            var segments = parseScript(scriptFile, comp.frameRate, planWarnings);
            if (segments.length === 0) {
                setStatus("No timecode segments parsed. Check the script format (Help).");
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
