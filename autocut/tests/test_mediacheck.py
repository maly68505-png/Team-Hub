"""Picture check: problems found in real decoded video and judged per camera."""
import av
import numpy as np

from autocut import mediacheck
from autocut.sync import SyncResult


def write_video(path, parts, fps=25, size=(160, 96), seed=0):
    """parts: [(seconds, kind)] with kind moving | black | frozen | burnt | soft."""
    rng = np.random.default_rng(seed)
    w, h = size
    tex = rng.uniform(0, 255, (h * 2, w * 2)).astype(np.uint8)
    with av.open(str(path), "w") as out:
        st = out.add_stream("mpeg4", rate=fps)
        st.width, st.height, st.pix_fmt = w, h, "yuv420p"
        st.bit_rate = 4_000_000
        x = y = 0
        frozen = None
        for secs, kind in parts:
            for _ in range(int(secs * fps)):
                x = int(np.clip(x + rng.integers(-4, 5), 0, w))
                y = int(np.clip(y + rng.integers(-4, 5), 0, h))
                img = tex[y:y + h, x:x + w].astype(np.float32)
                if kind == "black":
                    img = np.zeros_like(img)
                elif kind == "frozen":
                    frozen = img if frozen is None else frozen
                    img = frozen
                elif kind == "burnt":
                    img = np.clip(img * 4 + 120, 0, 255)
                elif kind == "soft":  # heavy box blur
                    k = 9
                    pad = np.pad(img, k, mode="edge")
                    c = np.cumsum(np.cumsum(pad, 0), 1)
                    img = (c[2 * k:, 2 * k:] - c[:-2 * k, 2 * k:] - c[2 * k:, :-2 * k] + c[:-2 * k, :-2 * k])[:h, :w] / (4 * k * k)
                fr = av.VideoFrame.from_ndarray(np.stack([img.astype(np.uint8)] * 3, -1), format="rgb24")
                for p in st.encode(fr):
                    out.mux(p)
        for p in st.encode(None):
            out.mux(p)


def test_black_and_frozen_found_in_a_real_file(tmp_path):
    f = tmp_path / "C0001.MP4"
    write_video(f, [(10, "moving"), (10, "black"), (10, "moving"), (10, "frozen"), (10, "moving")])
    r = mediacheck.sample_clip(f, 50.0, 10.0, tmp_path / "cache")
    assert len(r["samples"]) == 5 and all(s["frames"] >= 40 for s in r["samples"])
    issues = mediacheck.camera_issues([("CAM/C0001.MP4", r)], 10.0)
    kinds = {(i["kind"], round(i["t"])) for i in issues}
    assert ("black", 15) in kinds
    assert ("frozen", 35) in kinds
    assert not any(i["kind"] in ("soft", "burnt", "dropped") for i in issues), issues
    # cached: the same answer without reading the file
    assert mediacheck.sample_clip(f, 50.0, 10.0, tmp_path / "cache") == r


def test_soft_and_burnt_judged_against_the_camera(tmp_path):
    f = tmp_path / "A.MP4"
    write_video(f, [(10, "moving"), (10, "soft"), (10, "moving"), (10, "burnt"), (10, "moving")])
    r = mediacheck.sample_clip(f, 50.0, 10.0, tmp_path / "cache")
    kinds = {(i["kind"], round(i["t"])) for i in mediacheck.camera_issues([("CAM/A.MP4", r)], 10.0)}
    assert ("soft", 15) in kinds
    assert ("burnt", 35) in kinds


def sample(t, luma=100.0, burnt=0.0, sharp=500.0, motion=2.0, dropped=0):
    return {"t": t, "frames": 50, "luma": luma, "burnt": burnt, "sharp": sharp, "motion": motion,
            "dropped": dropped}


def test_neighbouring_windows_merge_and_dropped_frames():
    s = [sample(5), sample(125, sharp=50), sample(245, sharp=60), sample(365), sample(485, dropped=3)]
    issues = mediacheck.camera_issues([("CAM/X.MXF", {"samples": s})], 120.0)
    soft = [i for i in issues if i["kind"] == "soft"]
    assert len(soft) == 1 and soft[0]["t"] == 125 and soft[0]["dur"] == 122.0
    assert [i["t"] for i in issues if i["kind"] == "dropped"] == [485]
    assert all(i["ar"] for i in issues)


def test_a_dark_set_is_not_reported_everywhere():
    s = [sample(t, luma=30, sharp=40) for t in (5, 125, 245, 365)]
    assert mediacheck.camera_issues([("CAM/D.MXF", {"samples": s})], 120.0) == []


def test_unreadable_clip_is_reported():
    issues = mediacheck.camera_issues([("CAM/BAD.MXF", {"samples": [], "error": "Invalid data"})], 120.0)
    assert issues[0]["kind"] == "error" and "Invalid data" in issues[0]["en"]


def test_camera_that_stopped_recording():
    class Clip:
        def __init__(self, rel):
            self.rel = rel

    class Cam:
        clips = [Clip("CAM_A/1.MXF"), Clip("CAM_A/2.MXF"), Clip("CAM_A/3.MXF")]

    class P:
        cameras = {"CAM_A": Cam()}
    syncs = {"CAM_A/1.MXF": SyncResult("CAM_A/1.MXF", 600, offset=0, low=False),
             "CAM_A/2.MXF": SyncResult("CAM_A/2.MXF", 600, offset=602, low=False),   # 2 s: normal
             "CAM_A/3.MXF": SyncResult("CAM_A/3.MXF", 600, offset=1240, low=False)}  # 38 s gap
    gaps = mediacheck.stopped_gaps(P(), syncs)
    assert len(gaps) == 1 and gaps[0]["ref_t"] == 1202.0 and gaps[0]["dur"] == 38.0
    assert gaps[0]["camera"] == "CAM_A"
    m = mediacheck.markers({"cameras": [{"name": "CAM_A", "issues": gaps}]})
    assert m[0][0] == 1202.0 and "CAM_A" in m[0][1]
