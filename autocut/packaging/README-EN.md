# Autocut — team guide

An **offline** tool for Apple Silicon Macs (M1 / M2 / M3 / M4). It:
1. syncs every camera to the clean audio,
2. works out who speaks when,
3. builds a rough-cut sequence in Premiere Pro that cuts to the right camera.

The interface is in English; the **عربي** button at the top switches it to Arabic.

## Install (once per Mac)

1. Unzip `Autocut-mac-arm64.zip`.
2. Open **Terminal**, type `bash` and a space, drag **Install Autocut.command** into the Terminal window, press Enter.
   > This avoids the "unidentified developer" message macOS shows when you double-click the file.
3. Wait for "Installed ✓". Autocut then opens by itself.
4. If Premiere is open, quit and reopen it.

The installer puts in place:
- **Autocut.app** in Applications,
- a **Premiere panel**: Window → Extensions → Autocut,
- the **model**, automatically, if `autocut-models.zip` sits next to the installer.

## The model: once for the whole team

Speaker detection needs a model file (tens of MB). **One person** downloads it, then shares it offline.

**First person (internet, once):**
1. Create an account on huggingface.co.
2. Open `huggingface.co/pyannote/speaker-diarization-community-1` and accept the terms.
3. Settings → Access Tokens → create a **Read** token.
4. In Autocut click the "Model not installed" badge at the top, paste the token, click **Download**.
5. Click **Export the model to a folder…**. This saves `autocut-models.zip`.
6. Put that file next to **Install Autocut.command** in the folder you send to the team.

**Everyone else:** nothing to do — the installer imports the model.
Manual import: badge → **Import autocut-models.zip…**.

## Using it

Open **Autocut** from Applications, or inside Premiere: Window → Extensions → Autocut.

1. **Shoot folder**: pick the episode folder. Either layout works:
   ```
   Episode/                   or      0000/
     audio/  (or 2_AUDIO…)              2_AUDIO/
     CAM 01/  CAM 02/ …                 3_Proxy/
                                          CAM 01/  CAM 02/ …
   ```
   - The audio folder is found by name (AUDIO, Sound…) inside or next to the chosen folder. If not, pick it in Settings → Clean audio folder.
   - Video: MP4, MOV, MXF, MTS, AVI, MKV… Audio: WAV/BWF, MP3, AIFF, FLAC, M4A…
   - Every camera file needs some audio (even the camera mic) — that is what it syncs on.
   - **Audio in separate takes** (TAKE1, TAKE2…) is detected and each take placed at its real time.
2. **Settings**: pick the wide camera. If you know the number of speakers, enter it.
3. **Analysis**: click "Start analysis". Runs once per episode; the result is saved.
   - Weakly synced files show in red. Type the second in the clean audio where each one starts, then "Save fixes".
4. **Who is speaking?**: play the samples (▶), tick the **cameras** for each speaker, click "Save".
   - **One camera**: cut to it whenever that speaker talks.
   - **Several cameras** (single presenter): switch between them at pauses, a shot every 4–9 s (change under "Cut rules (advanced)").
5. **Cut**:
   - **Test** cuts **5 minutes** for a quick check. **Full cut** does the whole episode (sequence name ends in FULL and the time of the cut).
   - **Remove silences**: tick before cutting and set the longest pause allowed (e.g. 0.6 s). Longer pauses are shortened **on all tracks together**, so everything stays in sync. File ends in `_tight`.
   - After each cut, **"What happened in the last cut"** shows each camera's share, the reasons, and tips.
   - In the panel: **Import into Premiere**. From the app: in Premiere File → Import → the XML.

## The sequence

| Track | Content |
|---|---|
| V1 | the rough cut |
| V2 and up | each camera, complete and synced (locked, disabled) |
| A1 and up | clean audio |

To swap a shot: unlock the camera track, enable the clip you want and use it — it is already in sync.

## Common problems

| Problem | Fix |
|---|---|
| Premiere panel empty or missing | Restart Premiere after installing; check Autocut.app is in Applications |
| "Model not installed" | Import `autocut-models.zip` from the badge at the top |
| Weakly synced file | Type a manual fix, or tick "Continue despite weakly synced files" (marked red, left out of the cut) |
| Still looking at an old cut | Every import makes a new sequence; use the one whose name ends with the latest time |
| Anything else | Click "Log" and send the last lines, or `~/Library/Logs/Autocut.log` |

Nothing leaves the Mac: Autocut does not use the internet while working.
