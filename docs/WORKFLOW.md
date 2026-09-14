# Workflow

## Folder layout

The tool does not require a fixed layout — you point it at a folder and it
scans down into subfolders. Both of these work:

Flat, names in the filename:

```
Project AE/
  MyProject.aep
  script.srt
  videos/
    PERSON_A_take1.mp4
    PERSON_B_take3.mp4
    PERSON_B_take4.mp4
    sarah_studio.mov
```

One subfolder per person (the folder name is part of the path, but the
**filename** is what scores highest, so keep the name in the file too):

```
Project AE/
  videos/
    PERSON_A/
      PERSON_A_take1.mp4
    PERSON_B/
      PERSON_B_take3.mp4
```

Matching is case-insensitive and ignores spaces, dashes and underscores, so
`person b`, `Person-B` and `PERSON_B` all find `PERSON_B_take3.mp4`.

If two clips score the same, use the explicit form in the script
(`PERSON_B | PERSON_B_take4.mp4`) to remove the ambiguity.

## Step by step

1. Open your comp. The layer with the person you want to replace should be a
   normal footage layer (not precomposed, not an adjustment layer).
2. Open **Window → PersonReplacer.jsx**.
3. **Videos folder** → browse to your `videos/` folder.
4. **Script file** → browse to your `.srt` / `.txt`.
5. **Target comp** → pick it from the dropdown (defaults to the active comp;
   hit **Refresh** if you just made a new one).
6. Hit **Scan**. Read the table:
   - `Source file` column says `-- no match --` → the person name in your
     script does not appear in any filename. Rename the clip or use the
     explicit `|` form.
   - `Target layer` column says `-- no layer --` → no footage layer is live at
     that timecode in this comp. Check you picked the right comp, and that the
     layer is enabled and its in/out actually covers that time.
7. Hit **Apply**.
8. Refine the `[MATTE]` layers — that is where the cut-out lives. Simple Choker
   tightens or loosens the edge, the blur feathers it. Add Roto Brush there if
   the mask alone is not enough.

## Notes and limits

- **Precomposed layers.** The tool swaps footage sources. If your person is
  inside a precomp, open that precomp and target it instead.
- **Track mattes already in the comp.** The tool inserts its `[MATTE]` layer
  directly above the layer it swapped. If that layer was already the matte for
  something else, check the stack afterwards.
- **Roto Brush** has no scripting API in After Effects. The tool builds
  everything around it, but the stroke is yours.
- **Audio.** Replacing the source replaces the audio too. If you are keeping
  the original voice, mute the swapped layer's audio and keep the original
  audio on its own layer.
- **Time remapping / speed changes** on the target layer are left alone, which
  means a replacement clip of a different length may not fill the range. Check
  the out point after applying.
