"""One mono WAV per channel of a multichannel recorder file, for Premiere.

Premiere decides on import how a multichannel WAV is laid out (one adaptive
track, several mono tracks, ... — depending on its preferences and on the
file's channel mask), and an FCP7 XML can only point at "source track N" of
that layout: channels it did not lay out as separate tracks play silent. Mono
files have one layout only, so the XML always plays every channel.

The copies are bit-exact (same codec / bit depth / rate), keep the BWF
timecode, and are written once to <work>/audio/ (RF64 above 4 GB).
"""
from __future__ import annotations

import json
from pathlib import Path

import av
import numpy as np

from .audio import fingerprint
from .log import log
from .probe import MediaInfo, ToolError, probe


def needs_split(info: MediaInfo) -> bool:
    return info.audio_channels > 2


def split_channels(info: MediaInfo, out_dir: Path, only: list[int] | None = None) -> dict[int, MediaInfo]:
    """{channel (1-based): mono copy}. `only`: just these channels."""
    out_dir.mkdir(parents=True, exist_ok=True)
    chans = [c for c in (only or range(1, info.audio_channels + 1)) if 1 <= c <= info.audio_channels]
    dst = {c: out_dir / f"{info.path.stem}_ch{c}.wav" for c in chans}
    meta_p = out_dir / f".{info.path.stem}.split.json"
    fp = fingerprint([info.path], "split-v1")
    try:
        done = json.loads(meta_p.read_text()).get(fp, [])
    except (OSError, ValueError):
        done = []
    todo = [c for c in chans if c not in done or not dst[c].exists()]
    if todo:
        log.info("Splitting %s into mono files: channel(s) %s ...", info.path.name, ", ".join(map(str, todo)))
        _write(info, {c: dst[c] for c in todo})
        meta_p.write_text(json.dumps({fp: sorted(set(done) | set(todo))}))
    return {c: probe(dst[c]) for c in chans}


def _write(info: MediaInfo, dst: dict[int, Path]) -> None:
    tmp = {c: p.with_name(p.stem + ".part.wav") for c, p in dst.items()}
    outs = {}
    try:
        with av.open(str(info.path)) as src:
            st = src.streams.audio[0]
            cc = st.codec_context
            codec = cc.name if cc.name.startswith("pcm_") else "pcm_s24le"
            planar = cc.format.name if cc.format.is_planar else cc.format.name + "p"
            packed = planar[:-1]
            tc = src.metadata.get("time_reference")
            for c, p in tmp.items():
                o = av.open(str(p), "w", format="wav", options={"rf64": "auto", "write_bext": "1"})
                if tc:
                    o.metadata["time_reference"] = tc
                outs[c] = (o, o.add_stream(codec, rate=cc.sample_rate, layout="mono"))
            conv = av.AudioResampler(format=planar)
            for frame in src.decode(st):
                for f in conv.resample(frame):
                    a = f.to_ndarray()
                    for c, (o, s) in outs.items():
                        nf = av.AudioFrame.from_ndarray(np.ascontiguousarray(a[c - 1:c]), format=packed, layout="mono")
                        nf.sample_rate = cc.sample_rate
                        for pkt in s.encode(nf):
                            o.mux(pkt)
            for o, s in outs.values():
                for pkt in s.encode(None):
                    o.mux(pkt)
    except (av.error.FFmpegError, IndexError, ValueError) as e:
        for o, _ in outs.values():
            o.close()
        for p in tmp.values():
            p.unlink(missing_ok=True)
        raise ToolError(f"could not split {info.path.name} into mono files: {e}") from e
    for o, _ in outs.values():
        o.close()
    for c, p in tmp.items():
        p.replace(dst[c])
