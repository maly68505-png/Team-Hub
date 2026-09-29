"""pyannote code path with fake pyannote/torch modules (the real model needs a HF token)."""
import sys
import types

import numpy as np
import pytest
from scipy.io import wavfile

from autocut.config import DEFAULTS
from autocut.diarize import DiarizationError, Segment, diarize, pick_samples

CALLS = []
LOADED = []


class Turn:
    def __init__(self, s, e):
        self.start, self.end = s, e


class Annotation:
    def __init__(self, dur):
        self.dur = dur

    def itertracks(self, yield_label=True):
        yield Turn(0.5, self.dur / 2), None, "SPEAKER_00"
        yield Turn(self.dur / 2, self.dur - 0.5), None, "SPEAKER_01"


def install_fakes(monkeypatch, api):
    torch = types.ModuleType("torch")
    torch.from_numpy = lambda a: FakeTensor(a)
    torch.cuda = types.SimpleNamespace(is_available=lambda: False)
    torch.backends = types.SimpleNamespace(mps=types.SimpleNamespace(is_available=lambda: False))
    torch.device = lambda name: name

    class Pipe:
        def __call__(self, audio, hook=None, **kw):
            assert callable(hook)
            hook("segmentation", None, total=10, completed=5)
            CALLS.append((audio["waveform"].shape, kw))
            dur = audio["waveform"].shape[1] / audio["sample_rate"]
            ann = Annotation(dur)
            return types.SimpleNamespace(speaker_diarization=ann) if api == 4 else ann

    class Pipeline:
        @staticmethod
        def from_pretrained(model, **kw):
            LOADED.append((model, kw))
            if api == "local":
                return Pipe()
            if api == 4 and "token" not in kw:
                raise TypeError
            if api == 3 and "use_auth_token" not in kw:
                raise TypeError("unexpected keyword 'token'")
            return Pipe()

    pa = types.ModuleType("pyannote.audio")
    pa.Pipeline = Pipeline
    monkeypatch.setitem(sys.modules, "torch", torch)
    monkeypatch.setitem(sys.modules, "pyannote", types.ModuleType("pyannote"))
    monkeypatch.setitem(sys.modules, "pyannote.audio", pa)
    monkeypatch.setitem(sys.modules, "pyannote.audio.pipelines.utils.hook", None)  # -> ImportError


class FakeTensor:
    def __init__(self, a):
        self.a = a

    def __getitem__(self, idx):
        return FakeTensor(self.a[idx])

    @property
    def shape(self):
        return self.a.shape


@pytest.fixture(autouse=True)
def isolated_home(tmp_path, monkeypatch):
    monkeypatch.setenv("AUTOCUT_HOME", str(tmp_path / "home"))
    monkeypatch.delenv("HF_HUB_OFFLINE", raising=False)
    monkeypatch.delenv("PYANNOTE_METRICS_ENABLED", raising=False)


HF_ID = "pyannote/speaker-diarization-3.1"


@pytest.fixture
def wav(tmp_path):
    p = tmp_path / "ref.wav"
    wavfile.write(p, 16000, np.zeros(16000 * 100, np.int16))
    return p


@pytest.mark.parametrize("api", [3, 4])
def test_pyannote_api_versions_and_cache(monkeypatch, tmp_path, wav, api):
    install_fakes(monkeypatch, api)
    monkeypatch.setenv("HF_TOKEN", "hf_x")
    CALLS.clear()
    dcfg = dict(DEFAULTS["diarization"], num_speakers=2, model=HF_ID)
    segs = diarize(wav, "fp", 100.0, (0.0, 100.0), dcfg, tmp_path)
    assert [s.speaker for s in segs] == ["SPEAKER_00", "SPEAKER_01"]
    assert CALLS[0][1] == {"num_speakers": 2}
    # cached: no second call, and a test window reuses the full result
    segs2 = diarize(wav, "fp", 100.0, (10.0, 40.0), dcfg, tmp_path)
    assert len(CALLS) == 1 and len(segs2) == 2


def test_segment_only_is_offset_to_reference_time(monkeypatch, tmp_path, wav):
    install_fakes(monkeypatch, 4)
    monkeypatch.setenv("HF_TOKEN", "hf_x")
    CALLS.clear()
    segs = diarize(wav, "fp2", 100.0, (60.0, 90.0), dict(DEFAULTS["diarization"], model=HF_ID), tmp_path)
    assert CALLS[0][0] == (1, 30 * 16000)
    assert segs[0].start == pytest.approx(60.5) and segs[-1].end == pytest.approx(89.5)


def test_missing_token_is_a_clear_error(monkeypatch, tmp_path, wav):
    install_fakes(monkeypatch, 4)
    monkeypatch.delenv("HF_TOKEN", raising=False)
    with pytest.raises(DiarizationError, match="HF_TOKEN"):
        diarize(wav, "fp3", 100.0, (0.0, 100.0), dict(DEFAULTS["diarization"], model=HF_ID), tmp_path)


def test_offline_local_model_no_token_no_telemetry(monkeypatch, tmp_path, wav):
    import os
    from autocut import models
    install_fakes(monkeypatch, "local")
    monkeypatch.delenv("HF_TOKEN", raising=False)
    models.local_pipeline().mkdir(parents=True)
    (models.local_pipeline() / "config.yaml").write_text("pipeline: {}\n")
    LOADED.clear()
    segs = diarize(wav, "fp4", 100.0, (0.0, 100.0), DEFAULTS["diarization"], tmp_path)
    assert LOADED == [(str(models.local_pipeline()), {})]   # a folder, no token
    assert os.environ["HF_HUB_OFFLINE"] == "1"
    assert os.environ["PYANNOTE_METRICS_ENABLED"] == "false"
    assert len(segs) == 2


def test_missing_offline_model_explains_how_to_get_it(monkeypatch, tmp_path, wav):
    install_fakes(monkeypatch, "local")
    with pytest.raises(DiarizationError, match="autocut-models.zip"):
        diarize(wav, "fp5", 100.0, (0.0, 100.0), DEFAULTS["diarization"], tmp_path)


def test_samples_spread_and_solo():
    segs = [Segment(0, 10, "A"), Segment(5, 8, "B"), Segment(40, 50, "A"), Segment(80, 95, "A"),
            Segment(20, 30, "B")]
    picks = pick_samples(segs, "A")
    assert len(picks) == 3
    assert picks[0].end <= 5.0  # overlap with B cut out
    assert picks[-1].start >= 80
