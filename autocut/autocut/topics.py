"""Topic markers from the transcript, offline (no language model).

TextTiling: the words of the minute before each sentence are compared with the
words of the minute after it (cosine of word counts, Arabic normalised, common
words left out). Where the two sides share few words, the conversation moved
on. The deepest valleys of that similarity, at least `min_minutes` apart, are
the topic changes; a long pause just before helps. Each marker is named after
the first sentence of its topic.
"""
from __future__ import annotations

import math
import re
from collections import Counter

import numpy as np

from .transcribe import Sentence

WIN_S = 60.0          # words compared on each side of a candidate boundary
PAUSE_BONUS = 0.08    # per second of pause before the sentence (up to 2 s)
TITLE_CHARS = 60

_DIAC = re.compile(r"[ؗ-ًؚ-ْٰـ]")  # harakat, tatweel
_NON_WORD = re.compile(r"[^\w\s]", re.UNICODE)

STOP = set("""
في من على الى إلى عن مع ده دي دا دى ان إن أن انا أنا انت إنت انتي احنا إحنا هو هي هما هم
اللي الذي التي الذين و او أو ثم بس لكن يعني كده كدا كدة طب طيب ايه إيه ليه إزاي ازاي فين
امتى إمتى مش مو ما لا لم لن ولا كان كانت يكون تكون هيكون عشان علشان لان لأن زي مثل كل
بعض اي أي حاجة حاجه شوية شويه جدا جداً اوي أوي خالص برضه برضو كمان يا اه آه ايوه أيوه لأ
اللى عند عندي عندك لما لو اذا إذا هنا هناك دلوقتي الان الآن قوي قد لقد هذا هذه ذلك تلك
بتاع بتاعت بتاعه بتاعي فيه فيها فيهم ليه ليها ليهم له لها لهم منه منها منهم عليه عليها
the a an and or but of to in on at for is are was were be it this that i you he she we they
""".split())


def normalize(text: str) -> list[str]:
    t = _DIAC.sub("", text)
    t = re.sub("[إأآا]", "ا", t)
    t = t.replace("ى", "ي").replace("ة", "ه").replace("ؤ", "و").replace("ئ", "ي")
    t = _NON_WORD.sub(" ", t.lower())
    out = []
    for w in t.split():
        if w in STOP or w.isdigit():
            continue
        if len(w) > 4 and w.startswith(("وال", "بال", "فال", "كال")):
            w = w[3:]
        elif len(w) > 3 and w.startswith("ال"):
            w = w[2:]
        if len(w) < 3 or w in STOP:
            continue
        out.append(w)
    return out


def _cos(a: Counter, b: Counter) -> float:
    if not a or not b:
        return 0.0
    dot = sum(v * b.get(k, 0) for k, v in a.items())
    na = math.sqrt(sum(v * v for v in a.values()))
    nb = math.sqrt(sum(v * v for v in b.values()))
    return dot / (na * nb)


def title(s: Sentence, chars: int = TITLE_CHARS) -> str:
    t = s.text.strip()
    if len(t) <= chars:
        return t
    cut = t[:chars].rsplit(" ", 1)[0]
    return (cut or t[:chars]) + "…"


def find_topics(sentences: list[Sentence], min_minutes: float = 3.0, win_s: float = WIN_S) -> list[tuple[float, str]]:
    """[(start seconds, title)], the first one at the first sentence."""
    if not sentences:
        return []
    out = [(sentences[0].start, title(sentences[0]))]
    if len(sentences) < 6:
        return out
    toks = [Counter(normalize(s.text)) for s in sentences]
    starts = np.array([s.start for s in sentences])
    scores = np.full(len(sentences), np.nan)
    for i in range(1, len(sentences)):
        t = sentences[i].start
        if t - sentences[0].start < win_s / 2 or sentences[-1].end - t < win_s / 2:
            continue
        lo = int(np.searchsorted(starts, t - win_s))
        hi = int(np.searchsorted(starts, t + win_s))
        left = sum(toks[lo:i], Counter())
        right = sum(toks[i:hi], Counter())
        scores[i] = _cos(left, right)
    ok = np.isfinite(scores)
    if ok.sum() < 3:
        return out
    # depth of each valley: how far it sits below the peaks on either side
    depth = np.full(len(sentences), -np.inf)
    idx = np.flatnonzero(ok)
    for j, i in enumerate(idx):
        lpk = scores[idx[:j + 1]].max()
        rpk = scores[idx[j:]].max()
        # local peaks only (within the window), not the global ones
        lw = idx[(idx <= i) & (starts[idx] >= starts[i] - 2 * win_s)]
        rw = idx[(idx >= i) & (starts[idx] <= starts[i] + 2 * win_s)]
        lpk = scores[lw].max() if len(lw) else lpk
        rpk = scores[rw].max() if len(rw) else rpk
        pause = min(2.0, max(0.0, sentences[i].start - sentences[i - 1].end))
        depth[i] = (lpk - scores[i]) + (rpk - scores[i]) + PAUSE_BONUS * pause
    vals = depth[np.isfinite(depth)]
    cut = float(vals.mean() + 0.5 * vals.std()) if len(vals) else np.inf
    picked: list[int] = []
    gap = min_minutes * 60.0
    for i in np.argsort(-depth):
        if not np.isfinite(depth[i]) or depth[i] < cut:
            break
        t = sentences[i].start
        if t - sentences[0].start < gap or sentences[-1].end - t < gap / 2:
            continue
        if all(abs(t - sentences[j].start) >= gap for j in picked):
            picked.append(int(i))
    out += [(sentences[i].start, title(sentences[i])) for i in sorted(picked)]
    return out
