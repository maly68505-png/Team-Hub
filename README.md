# Person Replacer — After Effects

Swap the person in a talking-head layer for a different person, driven by an
SRT-style timecode script, without rebuilding the layer.

The layer is never recreated. Its masks, effects, transforms and keyframes all
survive — this is an automated "replace footage", not a re-comp.

```
ae/QuoteCards.jsx            builds one card per quote from a template comp
ae/PersonReplacer_Auto.jsx   zero-setup swap - finds everything itself
ae/PersonReplacer.jsx        full swap panel - browse for folder, comp and script
ae/lib/                      shared source both are built from
ae/build.js                  rebuilds both .jsx files from ae/lib
ae/tests/                    logic tests (parser, matcher, auto-discovery)
examples/example_script.srt  a sample timecode script
examples/episode-template/   the weekly episode folder, ready to copy
docs/WORKFLOW.md             folder layout + step-by-step
docs/QUICKSTART-AR.md        دليل التشغيل السريع بالعربي
docs/QUOTECARDS-AR.md        دليل مولّد كروت الاقتباسات بالعربي
docs/EPISODEFORM-AR.md       من استمارة البروديوسر لكروت الاقتباسات
```

## Which file do I use?

**`QuoteCards.jsx`** — you have one card design and a list of quotes, and you
want a card per quote. It duplicates your template comp once per quote, swaps
in the speaker clip and sets the quote text, keeping the masks, effects and
type styling. Templates that hide the guest and the quote inside precomps
(`REPLACE-FOOTAGE`, `REPLACE-PARAGRAPH`) work: layers are found through the
whole comp tree, and those precomps are copied per card so the cards stay
independent of each other. Clip order decides who appears: 1st clip to quote 1, 2nd to
quote 2, and so on. The other two tools swap footage along a timeline instead —
pick between them below.

**`PersonReplacer_Auto.jsx`** — nothing to configure. Save your project, open
your comp, then **File → Scripts → Run Script File…** and pick it. It finds the
comp, the videos folder and the timecode script on its own, shows you exactly
what it found and what it plans to do, and changes nothing until you press
**Replace now**. If it cannot find something, one button lets you point at it.

**`PersonReplacer.jsx`** — the full dockable panel, for when you want to choose
the folder, the comp and the script by hand (different comps in one project,
media stored far from the .aep, and so on).

Both share the same engine, so they behave identically once running.

> **Neither file is imported.** `File → Import` is for footage only — it will
> reject a `.jsx` and a `.srt` alike. Scripts run from `File → Scripts`.

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

The file must be **plain text** — a `.srt` or `.txt`. A PDF, a Word document
or a spreadsheet cannot be read; open it and save the timecodes as text first.
The tool now says so by name instead of reporting an empty result.

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

## Building

The two `.jsx` files are generated so their shared logic cannot drift apart:

```
node ae/build.js
```

Edit `ae/lib/core.jsxinc` (engine) or `ae/lib/ui-panel.jsxinc` /
`ae/lib/ui-auto.jsxinc` (interfaces), then rebuild. Do not edit the generated
`.jsx` files directly. Each output stays a single self-contained file — the
user copies one file and nothing else.

## Tests

```
node ae/tests/parse.test.js       # 46 assertions
node ae/tests/discovery.test.js   # 11 assertions
node ae/tests/quotes.test.js      # 19 assertions
node ae/tests/nested.test.js      # 48 assertions
node ae/tests/timing.test.js      # 16 assertions
node ae/tests/text.test.js        # 20 assertions
node ae/tests/alpha.test.js       # 26 assertions
node ae/tests/write.test.js       # 10 assertions
node ae/tests/roto.test.js        # 16 assertions
```

`parse.test.js` covers timecode parsing across every accepted format, range and
person-line extraction, filename matching, full-script parsing, malformed
input, and that both built files still embed the shared core verbatim.

`discovery.test.js` stubs the ExtendScript `File`/`Folder` API and runs the
auto-discovery against simulated project trees: the expected layout, nested and
oddly-named folders, decoy `.txt` files, loose clips, an empty project, and the
tool's own log file.

`quotes.test.js` covers natural clip ordering, the CSV reader (quoted commas,
header detection, headerless files), and reading quotes out of `.csv`, `.txt`
and `.srt` — including against the real generated `examples/episode-elections`
files, asserting both formats yield the same nine quotes.

`nested.test.js` builds a miniature AE object model shaped like a real
template — a render comp pulling its guest from a `REPLACE-FOOTAGE` precomp and
its quote from `REPLACE-PARAGRAPH` — and asserts that layers are found through
the tree, that only comps on the path to them are copied, and above all that
each card ends up with its own precomps: editing card 1 must not rewrite
card 2, and neither may touch the template. It also covers a template slot
left as an empty comp — offered once however many layers reference it, and
filled by adding a layer rather than replacing one that isn't there.

`timing.test.js` covers the black-card case: a placeholder trimmed deep into a
long recording leaves the layer reading past the end of the new clip, so the
swap must pull it back to the clip's own start. It also covers clamping to
whichever of the clip and the comp is shorter, leaving time-remapped and
keyframed layers alone, and scaling a clip to cover its frame.

`text.test.js` covers choosing the quote body over the speaker-name line, and
shrinking the type until a real quote fits its box — leaving point text and
animated type alone, and never going below 6pt.

`roto.test.js` covers the one thing a script fundamentally cannot do: a
template that cuts its subject out with Roto Brush holds strokes painted on
one particular clip, which cannot follow a replacement and cannot be
repainted from script. It asserts those effects are recognised by match name
or by whatever they were renamed to, that ordinary effects are left alone,
and that the template's disabled alpha route gets switched back on once a
cut-out clip is supplied.

The AE-API parts — layer targeting, `replaceSource`, layer splitting, matte
setup — need a running After Effects and are **not** covered by these tests.
