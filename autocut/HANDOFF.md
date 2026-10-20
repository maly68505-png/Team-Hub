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
  scipy, av, pyyaml). ~115 tests, ~10 min. Browser checks were done with Playwright scripts in
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

### Speed on big shoots (MXF on a network drive)
- A second shoot: ~1.5 TB of MXF on `/Volumes/editing/...` was far too slow because camera
  audio was decoded from whole files (MXF interleaves audio with video).
- Now `audio.decode_windows` SEEKS and reads `sync.window_seconds` (8) every
  `sync.sample_every` (90) seconds, min 6 windows per clip — ~9 % of an hour-long file.
  One path for everything (`takes.place_takes`; a single recording = one take). The old
  whole-file `Syncer`/`sync_all`/`build_reference` were removed. Sample-accurate in MP4/AAC,
  MOV/PCM and MXF/PCM (`tests/test_decode_timing.py`).
- That shoot's audio folder mixed a promo WAV and an "Audio Extracted" copy with the `_FIXED`
  takes — the user was told to keep only the `_FIXED` files in the clean-audio folder.
- Each new Mac needs the model once: export `autocut-models.zip` on a Mac that has it, import
  on the new one (or put it on the shared drive next to the installer).

### Sync only / cut from a synced XML (v0.4.0)
- `autocut sync PROJECT` (UI step 3 "مزامنة فقط") now also writes `output/synced.xml`: cameras on
  V1..Vn all enabled, clean audio, then one disabled camera-audio track per camera. No model needed.
- `autocut run|diarize SEQ.xml` (UI step 1 "افتح ملف XML متزامن…"): `xmlcut.py` reads a Premiere FCP7
  export; video track = camera (named by the clips' folder); audio-only clips (else all audio) mixed
  for diarization. Output = a copy of the sequence: layered → camera tracks split/enabled in place;
  else a new TOP track with the cut, camera tracks disabled. Window + silence removal re-time every
  track; pproTicksIn/Out updated; transitions dropped; dangling links removed; each <file> defined
  once. Work folder `<xml dir>/_autocut/xml-<stem>/` (config.yaml, speakers, output).
- Not tested yet on a real Premiere export (only on synthetic XML that mimics one).

### Multitrack recorder, timecode sync, speakers from mics (v0.5.0)
- User's recorder files are 4-channel: ch1 = mix, ch2..4 = lavs. `audio_channel: 1` → reference,
  sync and the XML use ch1 only (one A track, sourcetrack trackindex 1). They heard "one channel only"
  before (we wrote one track per channel).
- `sync.method`: audio | timecode (no camera audio read; BWF `time_reference` / camera TC via
  `MediaInfo.tc_seconds`) | timecode+audio (audio placement, checked/filled by TC: `takes.check_timecode`).
  User's shoots are "not always" jammed → default stays audio.
- `diarization.method: mics` (`mics.py`): per-channel 20 ms levels (cached in `_autocut/mics/`), a mic
  talks when above its floor and within `mic_margin_db` (10) of the loudest, levels relative to each
  mic's speech level. Labels "MIC 2".. mapped in step 4. Also in XML mode. No model needed.
- The user asked to be consulted BEFORE changes are made — ask first, then build.

### Silent audio tracks in Premiere → mono copies (v0.6.0)
- Users reported some clean-audio channel tracks silent in Premiere (5ch and 4ch recorder WAVs, files
  complete per the audio check). Root cause not proven (Premiere's channel layout vs sourcetrack index);
  fix: `output.split_channels` (default on) writes bit-exact mono WAVs per channel to `_autocut/audio/`
  (`split.py`, BWF timecode kept, RF64 if needed) and the XML references them (trackindex 1).
- `autocut check` / UI "Check audio": per channel, per 5 min: talk/quiet/no signal/unreadable;
  flags WAVs bigger than their header (>4 GB plain WAV).

### Weak cameras, parking, camera suggestions (v0.7.0)
- Sync confidence also from consistency: >= 4 windows on one line (10 ms) over >= 60 s => confident;
  clips with no confident match are re-read every 30 s (`DENSE_EVERY_S`). TAKES_VERSION 6.
- synced.xml: clips still weak/unmatched are PARKED one after another after the end (red), not at a guess.
- `automap.py`: per close-up camera, picture motion during each speaker's solo moments (seeking, 96x54
  grey) -> z-scores -> Hungarian; `speakers.json` "suggested"; UI pre-checks it with an
  "auto-suggested" tag. Wide camera excluded. A guess the editor reviews.

### Camera MXF with several audio tracks (v0.7.1)
- 4 of 7 cameras matched NOTHING on the user's shoot: XDCAM MXF has several mono audio streams and
  `decode_windows` read only stream 0 (silent there). Now all audio streams are demuxed once and mixed.
  synced.xml camera audio uses the loudest stream (`audio.loudest_stream`) as trackindex.

### App is a handful of files (v0.7.2)
- The user could not copy the unzipped app between Macs (Finder stuck on "Preparing to copy" over
  ~46,800 files). build_mac.sh now packs `Resources/python` into ONE `runtime.tar` (+ `runtime.id`);
  `bin/autocut` unpacks it once per version into `~/Library/Application Support/Autocut/runtime/<id>`
  (override: AUTOCUT_RUNTIME_DIR), removes quarantine, deletes older runtimes. The installer pre-unpacks.
  smoke_test asserts < 200 files in the .app.

### 8-channel recorders (v0.7.4)
- "plane index 8 out of range for 8 planes" on 8-channel WAVs (segfault on Linux): PyAV's planar
  `to_ndarray` breaks at 8+ channels. Every audio read now resamples to a PACKED format and splits
  channels itself (`audio.as_channels`). Never use planar ("fltp", "s32p") frames.
- Unsynced clips no longer block Full cut (v0.7.3): left out with a warning.

### Folder ticks, cut cameras, per-person multicam, timecode-guided sync (v0.8.0)
- `exclude_cameras`: unticked camera folders (step 1 checkboxes) are ignored entirely (a promo folder
  the user cannot move). `cut.cameras`: the cut only goes to these (step 5 chips); others stay on their
  tracks. `cutlogic.restrict_cameras`.
- After a cut, `multicam_<speaker>.xml` per speaker mapped to 2+ cameras (their cameras stacked +
  clean audio) — nest + Enable Multi-Camera in Premiere.
- `sync.method: timecode+audio` with timecoded clean audio = `takes.place_tc_guided`: takes at their
  timecode, each camera window searched only ±2 s around its timecode position (retakes repeating the
  same lines no longer confuse it); no audio match -> placed by timecode. Clips without TC use the bank.
- UI `api()` retries network failures ("Load failed") 3 times.

### Phase 1 of the user's feature list: transcript, topics, picture check, queue (v0.9.0)
The user picked ideas 1, 4, 8, 11, 13, 15, 16, 20, 22, 23, 29 from a numbered list (see the chat).
Agreed phases: **1** = 1 transcript + 8 topic markers + 20 media check + 23 queue (this version);
**2** = 4 paper edit (Word file with highlights AND marking inside the app — user chose both) +
29 pre-delivery QC; **3** = through the Premiere panel: 13 lower thirds (MOGRT), 15 graphics videos
at times/keywords, 16 video box in a MOGRT (test media replacement first), 11 music auto-ducking —
needs the user's MOGRT files + Premiere version; **4** = 22 proxies.
- `transcribe.py`: MLX Whisper large-v3-turbo, **bundled in the app** (user chose bundled over
  download-on-first-use). `packaging/fetch_whisper.py` downloads `mlx-community/whisper-large-v3-turbo`
  at build time and stores it 8-bit (~850 MB; fp16 would push the zip near GitHub's 2 GB asset limit).
  Launcher sets AUTOCUT_WHISPER_MODEL. 5-min chunks cut in pauses, cached per chunk in
  `<work>/transcript/<key>/`; GPU failure -> CPU fallback. Never stops the cut (warning only).
  Outputs `transcript*.json/.srt/.txt` (SRT/TXT on the output sequence's time via TimeMap).
- `topics.py`: TextTiling (Arabic-normalised word counts, 60 s each side, valleys >= mean+0.5sd,
  `transcript.topic_min_minutes` apart). Names = first sentence (offline; user chose this over an
  online title).
- `mediacheck.py`: 2 s windows every `check.sample_every` s per clip at 320x180 (cached per clip):
  black / frozen / burnt / soft (vs the camera's own median) / dropped frames, plus `stopped`
  (gap >= 5 s between a camera's placed clips). `audiocheck` now reports clipping
  (`mics.channel_peaks`, cached next to the levels).
- Markers: `xmeml.add_markers` (sequence `<marker>`), used by both writers. Topic markers
  "1. title", picture markers "⚠ CAM: ...".
- A full run that stops for the speaker mapping (exit 2) still runs the picture check +
  transcription first (`pipeline.heavy_steps`), so a queued episode does the slow work overnight.
- Server `Queue` (`/api/queue`, `/api/queue/{add,remove,start,stop,clear}`): one job at a time
  through the normal Job; status from the exit code. UI: "Add to queue" in step 5, queue card.
- Smoke test transcribes a `say` sentence with the bundled model (asserts words + timings).

### timecode+audio when cameras and recorder are not jammed (v0.9.1)
- The user's episode: camera TCs fell outside every clean-audio take -> tc-guided gave up ("its timecode
  is outside every take"), all weak. Now: if fewer than half the clips with audio are confirmed by audio
  near their timecode, `place()` warns and re-syncs everything by audio (`place_takes`). The tc-guided pass
  caches in `takes_tc.json` (audio sync keeps `takes.json`).

### Audio in several sub-folders, proxies next to originals (v0.9.2)
- The user's episode audio is split over `2_Fixed_Audio/EP/1` and `EP/2` (takes in a row) and they want
  the tool to work it out whatever the folder count. `scan.clean_audio_files` now uses every sub-folder,
  leaving out promo/copy folders (`NOT_EPISODE`) and raw folders when a fixed/clean one exists
  (`PREFERRED`); order = folder then file name. Same file name in two parts -> take "1/T002".
- Sync went to Premiere proxies: they live in `CAMxx/Proxy/*_Proxy.mov` next to the originals and the
  camera scan is recursive. `scan.camera_files` drops proxies when originals exist; `discover_cameras`
  prefers `1_RAW_Footage` over a sibling `3_Proxy` tree (pointing at the proxy tree still works).
- UI: camera folder ticks show even when the clean audio folder has an error.

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
