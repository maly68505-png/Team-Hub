---
name: look-style-system
description: The user's approved look and quality system for AI video and editing (Depth, Edge, Grade, Detail) plus their production rules - colours only from the project's colour reference, no dissolves (match cut or wipe only), never a plastic AI look, camera moves matched to a reference video, and no music (scene sound effects only). Use whenever writing image/video generation prompts, planning shots or transitions, giving edit/grade/finishing settings (After Effects, Premiere, Lumetri, DaVinci), reviewing generated shots for quality, or planning sound for a scene.
---

# Look Style System

The full measured system, written by the user in Arabic, is in
[STYLE-SYSTEM.md](STYLE-SYSTEM.md). Read it before giving prompt words, AE/Lumetri
settings or a finishing stack: it holds the exact numbers. This file adds the
user's production rules and how to apply everything.

Reply to the user in their language (Egyptian Arabic in chat); keep prompt
text for generators in English.

## The four pillars (summary - numbers are in STYLE-SYSTEM.md)

- **Depth** - extreme shallow depth of field, one sharp subject, three layers
  (dark out-of-focus foreground, sharp subject, soft glowing background), light haze, creamy bokeh.
- **Edge** - strong vignette (edges ~45-50% darker), soft bloom around
  highlights, zero chromatic aberration, no sharpening halos, frame edges sink into black.
- **Grade** - low-key tone: blacks ~3, mids 20-35, highlights 150-200, top ~230
  with a soft shoulder, 55-70% of the frame dark. Tone only - never colour.
- **Detail** - real macro textures, very fine grain (breaks the AI plastic look),
  4K generation, 25/30 fps with 180° shutter, no banding.

## Rule 1 - Colours come from the project's colour reference

- The system has **no colours**. Never impose a hue, tint or palette.
- The user sends a **colour reference** for each project. Extract the palette
  from it and use only that.
- No colour reference yet → ask for it before writing colour into prompts or a grade.
- `tone_lowkey.cube` is applied first (tone), the project colours after it.

## Rule 2 - No dissolves, ever

Never suggest a dissolve, crossfade, fade-through or any blend between shots. Only:

1. **Match cut** - cut on something shared by the last frame of shot A and the
   first frame of shot B:
   - shape (circle → circle), motion (movement continues in the same direction),
   - action (door opens → enters elsewhere), position (subject stays on the same spot in frame).
2. **Wipe by a passing element** - something crosses the lens and covers the
   frame (person, pillar, door, foreground object, darkness) and the cut hides
   inside it; or a **whip pan** with 720° motion blur, cutting inside the blur.

For every shot pair, write **how the last frame of A and the first frame of B
must look** so the transition is built into the generation, not patched in the edit.

## Rule 3 - No plastic AI look (top priority)

A shot that looks plastic is rejected, however good the rest is.

- **Prompt**: ask for real texture and imperfection (skin pores, fine hair, dust,
  scratches, fibres, wear) and add a negative/avoid line:
  `CGI, 3D render, plastic, waxy skin, airbrushed, over-smoothed, glossy, doll-like, uncanny`.
- **Edit**: no denoise, no skin smoothing, no beauty filters. Fine grain,
  light unsharp mask on the focus area only (values in STYLE-SYSTEM.md §4).
- **Review**: reject shots with waxy shine, over-smooth skin, drawn-looking
  edges, melted details or RGB split; regenerate instead of fixing in post.

## Rule 4 - Camera movement follows the user's reference video

- The user sends a **reference video** for camera movement each time. Wait for
  it; do not invent a move.
- Break it down: move type (push in, pull out, pan, tilt, orbit, crane, handheld, whip),
  direction, speed and easing, start and end framing, lens feel, duration.
- Translate it into precise prompt wording for the generator, or into After
  Effects camera keyframes when the move is done in the edit.

## Rule 5 - No music

- **Never** add, suggest or prompt music, score or soundtrack.
- Sound is **scene sound effects only** - what exists in the scene: ambience
  (room tone, wind, street, rain) plus action sounds (steps, door, paper, cloth, objects).
- With each scene, give a short SFX list: ambience bed + each action sound with its timing.

## Finishing stack (in order)

1. Shot (AI or real)
2. Clean-up: remove RGB split, sharpening halos, flicker
3. `tone_lowkey.cube` - tone
4. Project colours (from the colour reference)
5. Haze / fog, if layers are needed
6. Bloom / glow
7. Vignette
8. Light unsharp mask on the focus area
9. Fine grain
10. Logo and text on top (no heavy grain on them)

## Files

- [STYLE-SYSTEM.md](STYLE-SYSTEM.md) - the full system with measured values,
  AE/Lumetri settings, prompt words and the quality checklist.
- `tone_lowkey.cube` - 33-point tone-only LUT. Hue and saturation are unchanged
  (verified: 0° hue shift, 0 saturation shift). Premiere: Lumetri → Basic
  Correction → Input LUT. After Effects: Effect → Utility → Apply Color LUT.
- `make_lut.py` - rebuilds the LUT. `--gamma` (darker/lighter mids), `--cap`
  (brightest point), `--check` prints the curve and tests colour preservation.
  Example: `python3 make_lut.py --gamma 2.4 -o tone_lowkey_darker.cube`.

## Quality checklist (run on every shot)

- [ ] **No plastic look** - real texture, nothing waxy or over-smooth
- [ ] One sharp subject, the rest melts away (3 layers)
- [ ] 55-70% of the frame dark, blacks are black not grey
- [ ] Soft highlights, no large clipped areas
- [ ] Clear vignette (~45%)
- [ ] Light bloom around light sources
- [ ] No chromatic aberration, no sharpening halos
- [ ] Fine grain, no banding
- [ ] Colours only from the project's colour reference
- [ ] Transition in/out is a match cut or wipe - no dissolve
- [ ] Camera move matches the reference video
- [ ] No music - scene SFX only
