# Person Replacer — After Effects

Swap the person in a talking-head layer for a different person, driven by an
SRT-style timecode script, without rebuilding the layer.

The layer is never recreated. Its masks, effects, transforms and keyframes all
survive — this is an automated "replace footage", not a re-comp.

```
ae/PersonReplacer.jsx        the panel (this is the tool)
ae/tests/parse.test.js       logic tests for the parser and matcher
examples/example_script.srt  a sample timecode script
docs/WORKFLOW.md             folder layout + step-by-step
```

## Install

Copy `ae/PersonReplacer.jsx` into the AE **ScriptUI Panels** folder:

| OS  | Path |
| --- | --- |
| Windows | `C:\Program Files\Adobe\Adobe After Effects <ver>\Support Files\Scripts\ScriptUI Panels\` |
| macOS | `/Applications/Adobe After Effects <ver>/Scripts/ScriptUI Panels/` |

Restart After Effects, then open **Window → PersonReplacer.jsx** and dock it.

Enable **Preferences → Scripting & Expressions → Allow Scripts to Write Files
and Access Network** if you want the log file written.

> You can also run it without installing: **File → Scripts → Run Script File…**
> and pick the `.jsx`. It opens as a floating palette.

## How it works

1. **Videos folder** — the folder holding each person's clips. A clip is picked
   when its filename contains the person name from the script, so
   `PERSON_B_take3.mp4` matches `PERSON_B`. Subfolders are scanned too (5 deep).
2. **Script file** — SRT-style timecodes saying who should be on screen when.
3. **Scan** — resolves every segment and shows the full plan in the table:
   timecode in/out, person, the clip it matched, and the layer it will hit.
   Nothing in your project is touched yet.
4. **Apply** — for each segment it finds the topmost video layer live at that
   timecode, optionally splits it to the segment range, and replaces its
   footage source.

Everything runs inside a single undo group — one Ctrl/Cmd+Z reverts the lot.

## Script format

```
1
00:00:12:00 --> 00:00:18:00
PERSON_B
```

Accepted timecodes: `00:00:12:00` (frames, uses the comp frame rate),
`00:00:12,500` and `00:00:12.500` (milliseconds), `00:00:12;15` (drop-frame
flavour), `00:01:05` (whole seconds), `12.5` (bare seconds).

Accepted separators: `-->`, `->`, `=>`, ` - `, ` to `.

Accepted person lines:

| Line | Meaning |
| --- | --- |
| `PERSON_B` | match `PERSON_B` against the filenames |
| `PERSON_B: dialogue here` | same — everything after the colon is ignored |
| `[PERSON_B]` | same |
| `PERSON_B \| take4.mp4` | force this exact clip, skip the matcher |
| `00:00:12:00 --> 00:00:18:00  PERSON_B` | one-line form |

Lines starting with `#`, `;` or `//` are comments.

See `examples/example_script.srt`.

## Options

**Split the layer to the timecode range** *(on)*
One long talking-head layer can carry several different people. The script
duplicates the layer to isolate `[in, out]`, so the head and tail keep the
original person and only the middle gets swapped.

**Build refine-ready matte** *(on)*
After the swap it duplicates the layer directly above itself as
`<name> [MATTE]`, sets that as an **alpha track matte**, and adds a
**Simple Choker** and a **blur** for edge refining. The masks you already had
are duplicated onto the matte layer; on the lower layer they are kept but set
to mask mode **None**, so the `[MATTE]` layer is the single place you refine
the cut-out.

Roto Brush cannot be driven from a script — apply it by hand on the `[MATTE]`
layer and the rest of the setup is already wired.

**Compensate scale** *(off)*
If the replacement clip has different pixel dimensions, multiply the layer
scale so the new person fills the same frame area. Skipped if scale is
keyframed.

**Write a log file** *(on)*
Writes `<scriptname>_replace_log.txt` next to your script file: every swap,
every mask count, every skipped segment and why.

## Safety

- Scan is read-only. The plan table is the full preview.
- Apply is one undo group.
- Segments are applied last-to-first so splitting an earlier segment cannot
  shift a layer already resolved for a later one; each target is re-resolved
  against the live comp right before it is touched.
- A segment with no matching clip, or no layer live at that timecode, is
  skipped and logged — it never guesses.
- Layers created by the tool are tagged in their comment and excluded from
  future targeting, so re-running is safe.

## Tests

```
node ae/tests/parse.test.js
```

Covers timecode parsing across all accepted formats, range and person-line
extraction, filename matching, full-script parsing, and malformed input
handling. The AE-API parts (layer targeting, source replacement, matte setup)
need After Effects and are not covered here.
