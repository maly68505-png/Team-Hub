# autocut — multicam rough cut for Premiere Pro

Point it at a shoot folder (4–7 cameras + clean audio). It syncs every camera clip
to the clean audio, finds who is speaking when (pyannote), and writes a Premiere
sequence (FCP7 XML):

| track | content |
|---|---|
| **V1** | the rough cut — cuts to whoever is talking, the wide shot on crosstalk |
| **V2..Vn** | every camera, fully synced, one track each (locked + disabled) |
| **A1..An** | the clean audio, one track per channel |

It also writes `cuts.csv` (timecode, camera, speaker, reason) and
`sync_report.csv`.

```
autocut/
  config.example.yaml     copy to <project>/config.yaml
  autocut/
    cli.py                command line (scan / sync / diarize / run)
    pipeline.py           runs the stages in order, stops where it must
    scan.py               1  folders, ffprobe fps/duration/timecode, clip order
    audio.py              2  clean tracks -> one mono reference (16 kHz wav + 8 kHz array)
    sync.py               3  FFT cross-correlation, confidence, drift
    diarize.py            4  pyannote, cache, speakers.json + WAV samples
    cutlogic.py           5  the cutting rules, frame-snapped
    timeline.py              clip -> sequence frame mapping, drift re-slips
    xmeml.py              6  FCP7 XML writer
    report.py                cuts.csv
  tests/                  synthetic 4-camera shoot + tests for every stage
```

---

## 1. Setup

### ffmpeg

- **macOS:** `brew install ffmpeg`
- **Windows:** `winget install Gyan.FFmpeg` (then open a new terminal)
- **Linux:** `sudo apt install ffmpeg`

Check: `ffmpeg -version` and `ffprobe -version` both work.

### Python (3.10+)

```bash
cd autocut
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -e ".[diarize]"        # core + pyannote.audio (pulls in PyTorch)
```

Core only (sync + cut from an RTTM you made elsewhere): `pip install -e .`

GPU: if you have an NVIDIA card, install the CUDA build of PyTorch first
(<https://pytorch.org/get-started/locally/>). On CPU, diarizing 2 hours can take
an hour or more; on a GPU it's minutes. Either way the result is cached, so it
only happens once. Apple Silicon uses `mps` automatically.

### Hugging Face token (for pyannote)

1. Make an account at <https://huggingface.co> and create a **read** token
   (Settings → Access Tokens).
2. Open <https://huggingface.co/pyannote/speaker-diarization-3.1> and
   <https://huggingface.co/pyannote/segmentation-3.0> and accept the user
   conditions on both (same account). With pyannote 4.x you can set
   `diarization.model: pyannote/speaker-diarization-community-1` instead and
   accept that page.
3. Put the token in the environment:

```bash
export HF_TOKEN=hf_xxxxxxxxxxxxxxxx          # macOS / Linux
setx HF_TOKEN hf_xxxxxxxxxxxxxxxx            # Windows (new terminal after)
```

The model downloads once and is cached by Hugging Face.

---

## 2. Project folder

```
MyShoot/
  config.yaml
  audio/              clean audio: TR1.WAV, TR2.WAV ... (or one poly-WAV)
  CAM_WIDE/           C0001.MP4, C0002.MP4 ...
  CAM_A/
  CAM_B/
  CAM_C/
```

- One folder per camera. Folder names are the camera names.
- Several clips per camera are fine (card splits, stop/start). They are ordered
  by start timecode when every clip has one, otherwise by filename (natural
  sort: `C2` before `C10`). Each clip is synced on its own, so gaps between
  clips are handled.
- The clean tracks may mix several speakers each — they are summed into one
  mono reference. **They must all start at the same moment** (one recorder).
- `autocut` writes everything into `MyShoot/_autocut/`; your media is never
  modified or re-encoded. The XML points at the original files.

## 3. config.yaml

Copy `config.example.yaml` to `MyShoot/config.yaml`. The minimum:

```yaml
fps: 25
long_camera: CAM_WIDE
speakers:            # empty on the first run
```

Every threshold (sync confidence, drift, the cutting rules) is in there with a
comment. The cutting rules:

```yaml
cut:
  min_segment: 0.7     # turns shorter than this are ignored (backchannels: "نعم", "اها")
  overlap_min: 0.5     # 2+ people talking for longer than this -> long camera
  min_shot: 2.0        # no shot on V1 shorter than this
  cut_lead: 0.0        # cut this much before a speaker starts (try 0.2)
  opening_camera: long # silence before the first word
```

## 4. Workflow

**a. Check the material**

```bash
autocut scan MyShoot
```

Lists every clip with fps, duration, timecode, audio. The sequence uses the
cameras' frame rate; any clip at a different rate, or a config `fps` that does
not match, is a loud warning.

**b. First run — sync + diarization, stops for the speaker mapping**

```bash
autocut run MyShoot --start 00:30:00 --duration 5:00 --diarize-full
```

- Syncs all clips and prints a table: where each clip starts in the clean
  audio, drift, confidence. Cached — later runs reuse it.
- Diarizes, then writes `_autocut/speakers.json`: every speaker label with
  total talk time and 3 sample timestamps spread across the recording. The
  same moments are saved as short WAVs in `_autocut/speaker_samples/`
  (`SPEAKER_00_1.wav` ...). Listen to them.
- Stops (exit code 2) and prints a ready-to-paste block:

```yaml
speakers:
  SPEAKER_00: CAM_A
  SPEAKER_01: CAM_B
  SPEAKER_02: long      # "long" = the wide camera
```

Labels with less than `min_speaker_seconds` of speech don't need a mapping
(they go to the long camera).

> **Why `--diarize-full`?** Labels like `SPEAKER_01` are only stable within one
> diarization run. With `--diarize-full` the whole recording is diarized once
> and cached, so the mapping you write now is valid for the full run. Without
> it, only the 5 test minutes are diarized (fast) and you'll be warned that the
> labels may be numbered differently when you run the full length.

**c. Test segment (5 minutes)**

```bash
autocut run MyShoot --start 00:30:00 --duration 5:00
```

→ `_autocut/output/roughcut_003000_300s.xml` and `cuts_003000_300s.csv`.
Import into Premiere and check it. The sequence timecode starts at 00:30:00:00
so it matches the clean-audio time.

**d. Full run**

```bash
autocut run MyShoot
```

→ `_autocut/output/roughcut.xml`, `cuts.csv`, `sync_report.csv`, and the full
log `_autocut/autocut.log`.

Stage commands, if you want to stop early: `autocut sync MyShoot`,
`autocut diarize MyShoot`. `-v` shows debug detail on screen (the log file
always has it).

### Exit codes

| code | meaning |
|---|---|
| 0 | done |
| 1 | error (message says what) |
| 2 | speaker mapping missing — fill in `speakers:` |
| 3 | a clip has low sync confidence — see below |

## 5. Sync, confidence and drift

For each clip, a 60 s window of the camera's scratch audio is searched across the
**whole** clean mix at 1 kHz (so any offset is found), then refined at 8 kHz in
5 s sub-windows with sub-sample interpolation. Clips longer than
`long_clip_minutes` (20) are measured near the start, middle and end:

- start → end difference = **drift**. If it adds up to more than
  `drift_correct_frames` (0.5 frame) over the clip, it is **corrected**: the
  clip is placed in pieces of a few minutes, each with its own in-point, so the
  error never exceeds ¼ frame plus the unavoidable ½-frame snap. (Re-slips
  instead of a speed change — Premiere imports speed changes from XML
  unreliably; re-slips are exact.)
- the middle measurement must sit on the start–end line, otherwise the clip is
  flagged (dropped frames, or a wrong match).

**Confidence** (0–1) is how much the best match stands out from the best match
more than 1 s away (`peak ratio`; 2.0 or more = 1.0). A clip is **LOW** when
confidence < `min_confidence` or the correlation at the peak is below
`min_ncc`, when its measurements disagree, or when it has no audio.

autocut never places a low-confidence clip silently. The run stops with
exit code 3 and tells you which clips. Either:

- give the offset yourself — the time in the clean audio where the clip's first
  frame lands (find it by eye in Premiere once), then run again:

  ```yaml
  sync:
    overrides:
      CAM_B/C0007.MP4: 1834.52
  ```

- or run with `--allow-low-confidence`: those clips go on their camera track
  named `LOW-SYNC …` with a red label, and are **not** used on V1 (the cut
  falls back to the long camera there). Clips with no audio at all can only be
  placed with an override.

## 6. How V1 is cut

Everything happens on the frame grid, so every cut lands on a frame boundary.

1. Speech turns shorter than `min_segment` are dropped.
2. Per frame: one speaker → that speaker's camera. Two or more for longer than
   `overlap_min` → long camera. Silence, or a shorter overlap → hold the
   current camera.
3. If the wanted camera has no footage at that moment (not rolling, between
   clips, low-sync clip) → long camera → any camera that has footage → gap.
4. Shots shorter than `min_shot` are absorbed by a neighbour — the previous
   shot where possible (the cut comes a bit late rather than early).

`cuts.csv` gives each shot's reason: `speaker`, `overlap`, `opening`,
`hold (silence)`, `unmapped speaker -> long`, `no footage on CAM_A -> CAM_WIDE` ...

## 7. In Premiere

**File → Import → roughcut.xml**. You get a bin with the sequence and all the
media.

- V2..Vn sit **above** V1, which is why they are disabled — otherwise the top
  camera would hide the cut. To pull a shot from another angle, unlock that
  camera track, enable the clip, and blade/lift as usual — it is already in
  sync. Set `output.disable_camera_tracks: false` if you'd rather toggle track
  visibility yourself.
- Clips on V1 carry a colour label per camera.
- If the media moved since the XML was written, Premiere asks to relink — point
  at the first file and the rest follow.

## 8. Tests

```bash
pip install -e ".[test]"
python -m pytest
```

The tests build a synthetic 3-minute, 4-camera shoot with ffmpeg: known offsets
(including sub-frame and negative ones), a wide camera with 250 ppm drift, a
camera split into two clips with a gap, two clean tracks mixing three
speakers, backchannels and overlaps, and a ground-truth RTTM. The end-to-end
test then decodes the camera audio at **every clip's in-point in the XML** and
cross-correlates it with the clean audio at that timeline position. It fails
if any clip is off by more than the frame-snap error the ground truth predicts
(±3 ms).

pyannote itself isn't exercised by the tests (it needs the token and model
download). `--rttm FILE` feeds any diarization in the standard RTTM format
through the same path.

## 9. Limits and notes

- Arabic: pyannote diarization is acoustic, not language-based, so MSA or
  dialect doesn't matter. Setting `diarization.num_speakers` when you know it
  helps the most.
- Only the first audio stream of each camera file is used for sync (all its
  channels summed).
- Clips at a different frame rate from the sequence are placed at the sequence
  rate and conformed by Premiere — you get a warning for each.
- Drop-frame timecode (29.97 DF) is displayed as non-drop in `cuts.csv`.
- Memory: about 1.5 GB for a 2-hour shoot. Sync of a 40-minute clip takes a few
  seconds after its audio is decoded.
