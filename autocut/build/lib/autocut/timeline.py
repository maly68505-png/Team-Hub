"""Where every camera clip lands on the sequence, frame by frame.

Sequence frame F shows reference time  t = window_start + F / fps.
A synced clip maps reference time to its own video time with
    v = (t - offset) / (1 + drift)
and the source frame is round(v * fps).

Drift correction: a clip with measured drift is cut into pieces short enough
that the drift inside one piece stays under half a frame, and each piece gets
its own in-point (a re-slip every few minutes instead of a speed change —
Premiere imports speed changes from XML unreliably, re-slips are exact).
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from .log import log
from .scan import Clip, Project
from .sync import SyncResult


@dataclass
class Piece:
    clip: Clip
    start: int      # sequence frame (inclusive)
    end: int        # sequence frame (exclusive)
    src_in: int     # source frame shown at `start`
    low: bool       # clip has low sync confidence


class Timeline:
    def __init__(self, project: Project, syncs: dict[str, SyncResult],
                 window: tuple[float, float], use_low: bool):
        self.project = project
        self.rate = project.rate
        self.fps = project.rate.float
        self.t0, self.t1 = window
        self.n = self.rate.frames(self.t1 - self.t0)
        self.syncs = syncs
        self.src_frames: dict[str, int] = {}
        # per camera: clip index covering each frame (-1 = none), for all placed clips
        self.owner: dict[str, np.ndarray] = {}
        # per camera: frames usable on V1 (confident sync only)
        self.coverage: dict[str, np.ndarray] = {}
        for name, cam in project.cameras.items():
            owner = np.full(self.n, -1, np.int32)
            usable = np.zeros(self.n, bool)
            for i, clip in enumerate(cam.clips):
                r = syncs[clip.rel]
                if r.method == "failed" or (r.low and not use_low):
                    continue
                a, b = self._clip_range(clip, r)
                if b <= a:
                    continue
                if (owner[a:b] >= 0).any():
                    log.warning("%s overlaps another clip of %s on the timeline; the later "
                                "clip wins there", clip.rel, name)
                owner[a:b] = i
                usable[a:b] = not r.low
            self.owner[name] = owner
            self.coverage[name] = usable & (owner >= 0)

    def total_src_frames(self, clip: Clip) -> int:
        if clip.rel not in self.src_frames:
            i = clip.info
            n = int(math.floor(i.duration * self.fps + 1e-6))
            if i.nb_frames and i.fps == self.rate.fps:
                n = min(n, i.nb_frames) if n > 0 else i.nb_frames
            self.src_frames[clip.rel] = max(n, 0)
        return self.src_frames[clip.rel]

    def src_frame(self, r: SyncResult, seq_frame: int) -> int:
        t = self.t0 + seq_frame / self.fps
        return int(round(r.video_time(t) * self.fps))

    def _clip_range(self, clip: Clip, r: SyncResult) -> tuple[int, int]:
        total = self.total_src_frames(clip)
        a = int(math.floor((r.ref_start - self.t0) * self.fps)) - 1
        b = int(math.ceil((r.ref_end - self.t0) * self.fps)) + 1
        while self.src_frame(r, a) < 0:
            a += 1
        while b > a and self.src_frame(r, b - 1) > total - 1:
            b -= 1
        return max(a, 0), min(b, self.n)

    def _segment_len(self, r: SyncResult) -> int:
        if not r.drift:
            return 1 << 40
        return max(int(30 * self.fps), int(0.5 / abs(r.drift)))

    def pieces(self, camera: str, a: int, b: int) -> list[Piece]:
        """Source pieces showing `camera` over sequence frames [a, b)."""
        owner = self.owner[camera]
        clips = self.project.cameras[camera].clips
        out: list[Piece] = []
        f = a
        while f < b:
            idx = int(owner[f])
            g = f + 1
            while g < b and owner[g] == idx:
                g += 1
            if idx >= 0:
                clip = clips[idx]
                r = self.syncs[clip.rel]
                seg = self._segment_len(r)
                s = f
                while s < g:
                    e = min(g, s + seg)
                    # in-point taken at the piece's middle: drift error is +-1/4 frame at the ends
                    mid = (s + e) // 2 if r.drift else s
                    src = max(0, self.src_frame(r, mid) - (mid - s))
                    # never read past the last source frame
                    e = min(e, s + self.total_src_frames(clip) - src)
                    if e <= s:
                        break
                    out.append(Piece(clip, s, e, src, r.low))
                    s = e
            f = g
        return out
