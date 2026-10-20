"""Build the tone-only grade as a 33^3 .cube LUT (Rec.709 in / out).

It changes brightness and contrast only: every pixel keeps its hue and saturation
(RGB is scaled by the luma ratio), so colour is left to the per-project grade.

Measured on the references (luma, 0-255):
  1012.mov   p0.5 0-3   p50 21-37   p95 160-216   p99.5 216-249   -> true crushed blacks, bright small highlights
  warehouse  p0.5 11    p50 20      p95 105       p99.5 174       -> milky lifted black, rolled-off highlights
The curve sits between them: blacks just off zero, low-key mids, soft highlight shoulder.
"""
import sys
import numpy as np

N = 33
CURVE = [(0.00, 0.012), (0.05, 0.022), (0.15, 0.070), (0.30, 0.175), (0.50, 0.350),
         (0.70, 0.560), (0.85, 0.740), (0.95, 0.860), (1.00, 0.900)]

def tone(l):
    return float(np.interp(l, [p[0] for p in CURVE], [p[1] for p in CURVE]))

def grade(rgb):
    l = float(rgb @ np.array([0.2126, 0.7152, 0.0722]))
    lo = tone(l)
    if l < 1e-4:
        return np.full(3, lo)
    out = rgb * (lo / l)
    # anything pushed past white is pulled back toward its luma, not clipped per channel
    m = out.max()
    if m > 1.0:
        out = lo + (out - lo) * ((1.0 - lo) / (m - lo))
    return np.clip(out, 0, 1)

def write(path, title):
    with open(path, 'w') as f:
        f.write(f'TITLE "{title}"\nLUT_3D_SIZE {N}\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 1 1 1\n')
        for b in range(N):
            for g in range(N):
                for r in range(N):
                    o = grade(np.array([r, g, b], float) / (N - 1))
                    f.write(f'{o[0]:.6f} {o[1]:.6f} {o[2]:.6f}\n')

if __name__ == '__main__':
    write(sys.argv[1] if len(sys.argv) > 1 else 'tone_lowkey.cube', 'Tone Low-Key (no colour)')
