/* ExtendScript side of the Autocut panel: import the rough-cut XML. */
function autocutImport(p) {
    try {
        var f = new File(p);
        if (!f.exists) { return "ERR:file not found: " + p; }
        var before = app.project.sequences.numSequences;
        var ok = app.project.importFiles([f.fsName], true, app.project.getInsertionBin(), false);
        if (!ok) { return "ERR:Premiere refused the import"; }
        var n = app.project.sequences.numSequences;
        if (n > before) {
            try { app.project.openSequence(app.project.sequences[n - 1].sequenceID); } catch (e2) {}
        }
        return "OK";
    } catch (e) {
        return "ERR:" + e.toString();
    }
}
