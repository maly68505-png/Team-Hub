---
name: scene-continuity
description: Keep characters, locations and time consistent across all shots of a project - locked character identity with no drift between generations, never the same character twice in one scene, and fixed place and time-of-day details. Use whenever writing a sequence of image/video generation prompts, planning a scene or storyboard, or reviewing generated shots for continuity.
---

# Scene Continuity

Every shot of a scene must look like it was filmed in one place, at one time,
with the same people. Reply to the user in their language (Egyptian Arabic in chat).

## Rule 1 - Lock each character

- Before writing prompts, make a **character card** for each character:
  name, age, face (shape, eyes, nose, beard/moustache, marks), hair, skin tone,
  body build, clothing (every item, colour, material), accessories.
- Copy the card's description **word for word** into every prompt with that
  character. Never paraphrase it between shots.
- If the generator supports a character/reference image, use the **same
  reference image** in every shot.
- Reject any shot where the character changed: different face, age, hair,
  clothes or accessories. Regenerate, don't patch.

## Rule 2 - No duplicate characters in a scene

- The same person must **never appear twice** in one frame or one scene.
- State it in the prompt when a scene has several people (e.g. "each person is
  a different individual, no duplicates, no twins").
- Extras and crowds must not share the main character's face, or each other's.
- Check every generated shot for duplicated faces before approving it.

## Rule 3 - Lock place and time

- **Location card**: architecture, layout, key props and their positions,
  surfaces and materials, weather.
- **Time card**: time of day, **light direction and quality**, season, era.
- Repeat both cards in every prompt of the scene. Keep the light coming from
  the same side across all shots of the scene.
- Reject shots where props moved, the room changed, the weather changed or the
  light flipped direction.

## Workflow

1. Write the character, location and time cards and show them to the user.
2. Build every shot prompt from those cards + the shot's own action and camera.
3. Review each generated shot against the cards before it goes to the edit.

## Continuity checklist (per shot)

- [ ] Each character matches their card (face, hair, clothes, accessories)
- [ ] No character appears twice in the scene
- [ ] Location matches its card (layout, props, materials)
- [ ] Time matches its card (time of day, light direction, season)

Works together with `look-style-system` (look, transitions, no plastic) and
`historical-accuracy-check` (period-correct characters, places and details).
