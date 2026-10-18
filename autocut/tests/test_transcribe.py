"""Speech to text around the model: chunking, caching, speakers, subtitles, topics.
The model itself (MLX, Apple GPU) is replaced by a fake that returns known text."""
import json
from fractions import Fraction

import numpy as np
import pytest
from scipy.io import wavfile

from autocut import topics, transcribe
from autocut.diarize import Segment
from autocut.timecode import Rate
from autocut.timeline import TimeMap
from autocut.transcribe import Sentence, Word

SR = transcribe.SR


def noise(seconds, level=0.1, seed=0):
    return (level * np.random.default_rng(seed).normal(0, 1, int(seconds * SR))).astype(np.float32)


def test_chunks_are_cut_in_pauses():
    x = noise(1000)
    for gap in (295.0, 607.0):  # 1-second pauses near the 300 s / 600 s boundaries
        x[int(gap * SR):int((gap + 1) * SR)] = 0
    b = np.array(transcribe.chunk_bounds(x)) / SR
    assert b[0] == 0 and b[-1] == pytest.approx(1000)
    assert 295.0 <= b[1] <= 296.0
    assert 607.0 <= b[2] <= 608.0
    assert all(np.diff(b) > 0)


@pytest.fixture
def fake_model(tmp_path, monkeypatch):
    model = tmp_path / "model"
    model.mkdir()
    (model / "config.json").write_text("{}")
    monkeypatch.setenv(transcribe.MODEL_ENV, str(model))
    calls = []

    def run_chunk(audio, model_dir, language):
        calls.append((len(audio) / SR, language))
        d = len(audio) / SR
        return [{"start": 1.0, "end": 3.0, "text": " مرحبا بكم ", "words": [
                    {"start": 1.0, "end": 1.6, "word": " مرحبا"}, {"start": 1.7, "end": 3.0, "word": " بكم"}]},
                {"start": d - 4, "end": d - 1, "text": "  ", "words": []}]  # empty text is dropped
    monkeypatch.setattr(transcribe, "_run_chunk", run_chunk)
    return calls


def test_transcribe_offsets_speakers_and_cache(tmp_path, fake_model):
    wav = tmp_path / "ref16k.wav"
    x = noise(700)
    x[int(320 * SR):int(321 * SR)] = 0
    wavfile.write(wav, SR, (x * 32767).astype(np.int16))
    segs = [Segment(0, 200, "SPEAKER_00"), Segment(200, 700, "SPEAKER_01")]
    out = transcribe.transcribe(wav, "fp1", (0.0, 700.0), {"language": "ar"}, tmp_path / "work", segs)
    n = len(fake_model)
    assert n == 2 and all(lang == "ar" for _, lang in fake_model)
    assert [s.text for s in out] == ["مرحبا بكم"] * 2
    assert out[0].start == pytest.approx(1.0) and out[0].speaker == "SPEAKER_00"
    assert 320 < out[1].start < 323 and out[1].speaker == "SPEAKER_01"   # second chunk, offset
    assert out[1].words[0].text == "مرحبا"
    again = transcribe.transcribe(wav, "fp1", (0.0, 700.0), {"language": "ar"}, tmp_path / "work", segs)
    assert len(fake_model) == n                       # every chunk came from the cache
    assert [s.start for s in again] == [s.start for s in out]


def test_silent_chunks_skip_the_model(tmp_path, fake_model):
    wav = tmp_path / "ref16k.wav"
    wavfile.write(wav, SR, np.zeros(60 * SR, np.int16))
    assert transcribe.transcribe(wav, "fp2", (0.0, 60.0), {}, tmp_path / "w") == []
    assert fake_model == []


def test_missing_model_never_stops_the_cut(tmp_path, monkeypatch):
    monkeypatch.setenv(transcribe.MODEL_ENV, str(tmp_path / "nothing"))
    monkeypatch.setenv("AUTOCUT_HOME", str(tmp_path / "home"))

    class Ref:
        wav16k, fp = tmp_path / "x.wav", "fp"
    assert transcribe.run_stage(Ref(), (0, 10), {"transcript": {"enabled": True}}, tmp_path, []) is None
    assert transcribe.run_stage(Ref(), (0, 10), {"transcript": {"enabled": False}}, tmp_path, []) is None


def sent(s, e, text, spk=""):
    words = text.split()
    step = (e - s) / len(words)
    return Sentence(s, e, text, spk, [Word(s + i * step, s + (i + 1) * step, w) for i, w in enumerate(words)])


def test_srt_follows_the_sequence_and_removed_silence(tmp_path):
    rate = Rate(Fraction(25))
    # frames 0-100 kept, 100-200 removed, 200-500 kept
    tm = TimeMap(500, [(0, 100), (200, 500)])
    sents = [sent(10.0, 12.0, "أول جملة"), sent(19.0, 21.0, "تاني جملة"), sent(5.0, 6.0, "قبل البداية")]
    n = transcribe.write_srt(tmp_path / "t.srt", sents[:2], 10.0, rate, tm)
    text = (tmp_path / "t.srt").read_text(encoding="utf-8")
    assert n == 2
    assert "00:00:00,000 --> 00:00:02,000" in text           # 10-12 s -> sequence 0-2 s
    assert "00:00:05,000 --> 00:00:07,000" in text           # 19-21 s: 4 s (14-18 s) removed before it
    assert "أول جملة" in text
    # a sentence before the window is left out
    assert transcribe.write_srt(tmp_path / "u.srt", sents[2:], 10.0, rate, tm) == 0


def test_long_sentences_split_into_short_cues():
    s = sent(0.0, 20.0, " ".join(f"كلمة{i}" for i in range(40)))
    cs = transcribe.cues([s], max_chars=42, max_s=6.0)
    assert len(cs) >= 4
    assert all(e - a <= 6.01 for a, e, _ in cs)
    assert all(len(t) <= 84 for _, _, t in cs)


def test_txt_groups_turns_with_names(tmp_path):
    rate = Rate(Fraction(25))
    sents = [sent(0, 2, "سلام", "SPEAKER_00"), sent(2, 4, "عليكم", "SPEAKER_00"), sent(4, 6, "أهلاً", "SPEAKER_01")]
    transcribe.write_txt(tmp_path / "t.txt", sents, 0.0, rate, 25 * 3600, None,
                         {"SPEAKER_00": "CAM_A", "SPEAKER_01": "CAM_B"})
    lines = (tmp_path / "t.txt").read_text(encoding="utf-8").strip().split("\n\n")
    assert lines == ["[01:00:00:00] CAM_A: سلام عليكم", "[01:00:04:00] CAM_B: أهلاً"]


def test_json_roundtrip(tmp_path):
    s = [sent(1, 2, "نص تجربة", "SPEAKER_00")]
    transcribe.save_json(tmp_path / "t.json", s)
    assert transcribe.load_json(tmp_path / "t.json") == s
    assert json.loads((tmp_path / "t.json").read_text(encoding="utf-8"))[0]["text"] == "نص تجربة"


TOPIC_WORDS = [
    "الكورة الماتش الدوري اللاعب الجول المدرب الفريق الملعب الهدف التشكيلة".split(),
    "الأكل الطبخ المطبخ الوصفة الفرن الطماطم البصل الملح الطبق المكرونة".split(),
    "السفر الطيارة المطار الفندق الشنطة الرحلة التذكرة الشاطئ البحر الجواز".split(),
]


def test_topics_found_where_the_subject_changes():
    rng = np.random.default_rng(3)
    sents, t = [], 0.0
    for k, words in enumerate(TOPIC_WORDS):
        for _ in range(60):  # 60 sentences x 6 s = 6 minutes per topic
            text = "يعني " + " ".join(rng.choice(words, 4)) + " كده"
            sents.append(Sentence(t, t + 5.5, text))
            t += 6.0
    found = topics.find_topics(sents, min_minutes=3.0)
    starts = [a for a, _ in found]
    assert len(found) == 3, found
    assert starts[0] == 0.0
    assert abs(starts[1] - 360) <= 30 and abs(starts[2] - 720) <= 30
    assert all(title for _, title in found)


def test_topics_need_min_gap_and_titles_are_short():
    s = [Sentence(i * 5.0, i * 5.0 + 4, "كلام " * 40) for i in range(10)]
    found = topics.find_topics(s, min_minutes=3.0)
    assert len(found) == 1 and len(found[0][1]) <= topics.TITLE_CHARS + 1


def test_normalize_arabic():
    assert topics.normalize("والكُرة في الملعبِ") == ["كره", "ملعب"]
