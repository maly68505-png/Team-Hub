---
name: historical-accuracy-check
description: Verify every factual reference - maps, places, real people, historical events, dates and period details - before it goes into a script, voice-over, image/video prompt or on-screen text, and check generated shots for historical mistakes. Use whenever content mentions a real place, person, event, era, map, flag, uniform or date, or when reviewing visuals that depict them.
---

# Historical Accuracy Check

The user's content must contain **no factual mistakes**. Maps, places, people
and events are verified before they are written or generated - never guessed.

Reply to the user in their language (Egyptian Arabic in chat).

## What to verify

| Type | Check |
|---|---|
| **Maps** | Borders, names and capitals **as they were at that date**, not today's. Correct spelling of every label. Right projection and orientation. |
| **Places** | How the place looked **at the time of the event**: which buildings existed, materials, architecture style, streets, landscape. |
| **People** | Correct name and spelling (Arabic and English), age at the time, known appearance, period clothing, rank, insignia. |
| **Events** | Date, order of events, location, numbers (casualties, troops, votes), who was present. |
| **Period details** | Weapons, uniforms, flags, money, vehicles, tools, signage, technology - nothing from a later era (no wristwatch in 1800). |

## Process

1. **List every factual claim** in the script/brief: names, dates, places,
   numbers, events, and every visual period detail the shots will show.
2. **Verify each one** against reliable sources: academic works, established
   encyclopedias, official archives, museums, primary documents. Use web search.
   Prefer two independent sources for anything important.
3. **Write prompts with period-correct detail spelled out** (uniform, architecture,
   objects, flag version) so the generator does not invent them.
4. **Flag, don't guess.** If sources disagree or something cannot be confirmed,
   tell the user what is uncertain and the options - never fill the gap silently.
5. **Review generated shots** for anachronisms and errors: wrong flag or map
   borders, buildings from another era, misspelled or garbled text on signs and
   maps, wrong uniforms, modern objects. Report them before the shot reaches the edit.
6. **Give a short source list** for the episode/project so the user can check.

## Output format

For each item checked:

- ✅ **Verified** - fact + source
- ⚠️ **Uncertain** - what is disputed, what the sources say, recommendation
- ❌ **Wrong** - what is wrong in the script/shot and the correct version + source

## Watch-outs

- AI generators often garble text on maps, signs and documents - check every
  visible word, or plan to add text in the edit instead.
- Modern borders on historical maps are the most common map error.
- Flags change over time - match the version to the date.
- Real people: do not invent quotes; attribute only quotes that are verified.
