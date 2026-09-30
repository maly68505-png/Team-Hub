# Autocut — ملف التسليم لمحادثة جديدة / Handoff

## للمستخدم: كيف تكمل في محادثة جديدة
افتح محادثة جديدة على نفس المستودع واكتب:

> اقرأ `autocut/HANDOFF.md` في فرع `claude/fervent-maxwell-4yuya3` وكمّل من هناك.

رابط التحميل الثابت (يتحدّث تلقائياً مع كل نسخة):
https://github.com/maly68505-png/Team-Hub/releases/download/autocut-latest/Autocut-mac-arm64.zip

---

## For the next session (technical context)

**Always reply to the user in Arabic** (Egyptian/Gulf mix; the user is a video editor / AI
content creator, not a programmer). Give click-by-click steps; they send screenshots.

### Where things are
- Repo `maly68505-png/Team-Hub` (public), branch **`claude/fervent-maxwell-4yuya3`**. The tool
  lives in `autocut/` (the rest of the repo is an unrelated After Effects toolkit).
- CI: `.github/workflows/autocut-mac.yml` builds `Autocut.app` on `macos-14` (Apple Silicon),
  runs `packaging/smoke_test.sh` (full pytest suite with the bundled Python), uploads the
  artifact and refreshes the public release **`autocut-latest`** on every green push to this
  branch or the default branch. The user installs from that release link only.
- Local tests: `cd autocut && python -m pytest -q` (needs `ffmpeg` CLI for fixtures, numpy,
  scipy, av, pyyaml). 66 tests, ~2 min. Browser checks were done with Playwright scripts in
  the scratchpad (not in the repo).
- No `gh` CLI here; the GitHub API polling for run status used `curl` on the public API.

### What the product is
Offline Mac (Apple Silicon) tool that makes a multicam rough cut for Premiere Pro:
- **Engine** (`autocut/autocut/`): scan → reference audio → sync → diarization (pyannote
  `community-1`, offline model folder, telemetry off) → cut logic → FCP7 XML (`xmeml.py`) +
  `cuts.csv` + `summary.json`. CLI: `autocut scan|sync|diarize|run|serve|models`.
- **App**: `server.py` (127.0.0.1 + token, jobs as subprocesses) + Arabic RTL web UI
  `autocut/ui/`. `Autocut.app` opens it (Chromium app-window if available).
- **Premiere panel** (`premiere-panel/`, CEP): iframes the same UI, starts the engine,
  imports XML via ExtendScript (`host.jsx`), native dialogs via `window.cep.fs`.
- **Packaging** (`packaging/`): python-build-standalone + pip into the .app, installer
  `Install Autocut.command` (copies app + panel, PlayerDebugMode, imports
  `autocut-models.zip` if present, kills an old engine), Arabic guide `README-AR.md`.
- Model: one person downloads it once with an HF token (`community-1`, CC-BY-4.0) and exports
  `autocut-models.zip`; everyone else imports it offline. The user has done this (badge green).

### The user's real shoot (important)
- Folder `~/Desktop/Ashmawy/0000/` with `2_AUDIO/2_Fixed_Audio/Juzoor.TAKE1..TAKE12.260922.wav`
  and `3_Proxy/CAM 01..CAM 04/` (7/12/3/4 files, ~1 h each). 25 fps. One presenter talking to
  camera (show "Juzoor"). Longest take 35:14; full timeline ≈ 1:26:48.
- Clean audio = **sequential takes**, not simultaneous tracks → `takes.py` places takes and
  clips on one timeline (chunked matching + least-squares, drift only if measurements span
  ≥ 120 s). This fixed the "no sync / no audio / no cut" reports.
- Presenter mode: a speaker mapped to a **list** of cameras → angle changes at pauses
  (`rotate_min_shot` 4 s / `rotate_max_shot` 9 s), only to cameras rolling for the whole shot.
- Silence removal (`cut.remove_silence`, `silence_max`, `silence_pad`) through `TimeMap`
  applied to all tracks → `roughcut_tight.xml`.
- The proxies appear to have a baked-in "look"; the tool adds no colour. Suggested using the
  original camera folders instead of `3_Proxy` (user has not confirmed where originals are).

### Status at handoff
- Latest pushed: silence removal, rotation-to-rolling-cameras fix, `summary.json` + the
  "ماذا حدث في آخر قطع" box in the UI, FULL/TEST sequence names. CI green, release updated.
- Audio in Premiere: after the takes fix the user's screenshot showed clean audio on A1/A2 —
  works. The FCP7 audio layout (outputs group, no Premiere attrs) is in place.
- **Waiting on the user**: run the new full cut with silence removal and all 4 cameras ticked
  for the presenter; if one camera still dominates, ask for a screenshot of the summary box
  (it shows per-camera share and reasons: `fallback`, `unmapped`, `angle`, …).
- 3 CAM 02 clips had weak sync on the real shoot (C020007, C020011, C020012) — excluded from
  V1 when "allow low confidence" is ticked. Not yet investigated (possibly no matching take).

### Ideas not built yet (only if the user asks)
- Link XML to original media while syncing on proxies (same file names).
- Avoid very short shots after silence removal (re-merge below `min_shot`).
- Per-camera weighting in rotation (e.g. less wide shot).
- Signed/notarized app (needs a paid Apple Developer account); today users run the
  installer via `bash "Install Autocut.command"` or `xattr -dr com.apple.quarantine`.
