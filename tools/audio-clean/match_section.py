"""Make one section of a recording sound like a reference section (tone + level).

usage: python3 match_section.py in.wav out.wav --ref 0 5.9 --fix 6 8.4 [--fade 0.08]

Measures the average speech spectrum of both sections (only frames with speech), turns the
difference into a smoothed EQ curve (1/3-octave, clamped), applies it to the fix section with
zero-phase STFT filtering, matches the speech level, and crossfades in and out of the section.
Everything outside the section is left bit-identical.
"""
import argparse
import numpy as np, soundfile as sf
from scipy import signal

ap = argparse.ArgumentParser()
ap.add_argument('inp'); ap.add_argument('out')
ap.add_argument('--ref', nargs=2, type=float, required=True)
ap.add_argument('--fix', nargs=2, type=float, required=True)
ap.add_argument('--fade', type=float, default=0.08)
ap.add_argument('--max-db', type=float, default=10.0)
ap.add_argument('--smooth', type=float, default=1/3, help='EQ smoothing width in octaves')
a = ap.parse_args()

x, sr = sf.read(a.inp, always_2d=True)
info = sf.info(a.inp)
mono = x.mean(1)
N, H = 4096, 1024
win = signal.get_window('hann', N)

def active_spectrum(t0, t1):
    s = mono[int(t0 * sr):int(t1 * sr)]
    f, _, Z = signal.stft(s, sr, window=win, nperseg=N, noverlap=N - H)
    P = np.abs(Z) ** 2
    e = P.sum(0)
    keep = e > np.percentile(e, 40)            # speech frames only, not the gaps
    return f, P[:, keep].mean(1), s

f, Pref, sref = active_spectrum(*a.ref)
_, Pfix, sfix = active_spectrum(*a.fix)

# EQ curve = ref / fix, smoothed (1/3 octave by default), only where there is speech energy
diff = 10 * np.log10((Pref + 1e-20) / (Pfix + 1e-20))
smooth = np.zeros_like(diff)
for i, fc in enumerate(f):
    if fc < 20:
        continue
    band = (f >= fc / 2 ** (a.smooth / 2)) & (f <= fc * 2 ** (a.smooth / 2))
    smooth[i] = diff[band].mean()
smooth[f < 60] = smooth[np.argmin(abs(f - 60))]
smooth[f > 14000] = smooth[np.argmin(abs(f - 14000))]
# level is matched separately: take the broadband offset out of the curve
level = 10 * np.log10(Pref.sum() / Pfix.sum())
curve = np.clip(smooth - level, -a.max_db, a.max_db)
gain = 10 ** (curve / 20)

# apply the curve to the whole signal (zero-phase), blend it in only inside the section
proc = np.zeros_like(x)
for c in range(x.shape[1]):
    _, _, Z = signal.stft(x[:, c], sr, window=win, nperseg=N, noverlap=N - H)
    _, y = signal.istft(Z * gain[:, None], sr, window=win, nperseg=N, noverlap=N - H)
    proc[:, c] = y[:len(x)]

# speech-level match (RMS of active 50 ms frames)
def active_rms(s):
    w = int(sr * 0.05); n = len(s) // w
    e = np.sqrt((s[:n * w].reshape(n, w) ** 2).mean(1))
    return np.sqrt((e[e > np.percentile(e, 40)] ** 2).mean())

i0, i1 = int(a.fix[0] * sr), min(int(a.fix[1] * sr), len(x))
lvl = active_rms(sref) / active_rms(proc[i0:i1].mean(1))
proc *= lvl

w = np.zeros(len(x))
w[i0:i1] = 1.0
fl = int(a.fade * sr)
w[max(0, i0 - fl):i0] = np.linspace(0, 1, i0 - max(0, i0 - fl))   # fade in before the section
if i1 < len(x):
    w[i1:i1 + fl] = np.linspace(1, 0, len(w[i1:i1 + fl]))
out = x * (1 - w[:, None]) + proc * w[:, None]

peak = np.abs(out).max()
if peak > 0.98:                                   # never clip
    out[w > 0] *= 0.98 / peak
sf.write(a.out, out, sr, subtype=info.subtype)
print(f'level +{20 * np.log10(lvl):.1f} dB, EQ range {curve[(f > 80) & (f < 12000)].min():+.1f}..{curve[(f > 80) & (f < 12000)].max():+.1f} dB')
for hz in (100, 200, 400, 800, 1500, 2500, 4000, 6000, 10000):
    print(f'  {hz:>5} Hz {curve[np.argmin(abs(f - hz))]:+5.1f} dB')
