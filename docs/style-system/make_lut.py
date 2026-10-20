"""Build the "Warehouse Night" grade as a 33^3 .cube LUT (Rec.709 in / out).

Measured on the warehouse reference still:
  blacks  ~72% of the frame, lifted a touch with a green-teal tint   RGB(16,20,15)
  shadows steel blue                                                RGB(40,48,55)
  mids    cool grey-blue                                            RGB(96,112,124)
  highs   compressed, cool white, rarely above ~0.75                RGB(172,185,192)
  accent  only warm orange/red survives in colour (<0.3% of pixels) RGB(97,52,40)
"""
import colorsys, sys
import numpy as np

N = 33
# (input luma, output luma, tint RGB) control points
CURVE = [(0.00, 0.035), (0.10, 0.060), (0.25, 0.150), (0.50, 0.330), (0.75, 0.560), (0.90, 0.700), (1.00, 0.780)]
TINT = [(0.00, (16, 20, 15)), (0.19, (40, 48, 55)), (0.44, (96, 112, 124)), (0.72, (172, 185, 192)), (1.00, (225, 232, 236))]
BASE_SAT = 0.30      # everything goes near-monochrome…
ACCENT_SAT = 0.95    # …except warm orange/red light
ACCENT_HUE = (0.0, 0.11)   # 0–40°, plus wrap-around reds

def interp(x, pts):
    xs = [p[0] for p in pts]
    return float(np.interp(x, xs, [p[1] for p in pts]))

def tint_at(l):
    xs = [p[0] for p in TINT]
    c = np.array([np.interp(l, xs, [p[1][k] for p in TINT]) for k in range(3)])
    return c / c.mean()

def grade(r, g, b):
    l = 0.2126 * r + 0.7152 * g + 0.0722 * b
    lo = interp(l, CURVE)
    h, s, v = colorsys.rgb_to_hsv(r, g, b)
    warm = (ACCENT_HUE[0] <= h <= ACCENT_HUE[1]) or h >= 0.96
    w = min(1.0, s * 2.0) if warm else 0.0          # only really saturated warm pixels keep colour
    sat = BASE_SAT + (ACCENT_SAT - BASE_SAT) * w
    chroma = (np.array([r, g, b]) - l) * sat
    if warm:
        chroma *= 1.15
    mono = lo * tint_at(lo) * (1 - 0.6 * w) + lo * 0.6 * w
    out = mono + chroma * (lo / max(l, 1e-4)) ** 0.5
    return np.clip(out, 0, 1)

def write(path, title):
    with open(path, 'w') as f:
        f.write(f'TITLE "{title}"\nLUT_3D_SIZE {N}\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 1 1 1\n')
        for bi in range(N):
            for gi in range(N):
                for ri in range(N):
                    o = grade(ri / (N - 1), gi / (N - 1), bi / (N - 1))
                    f.write(f'{o[0]:.6f} {o[1]:.6f} {o[2]:.6f}\n')

if __name__ == '__main__':
    write(sys.argv[1] if len(sys.argv) > 1 else 'warehouse_night.cube', 'Warehouse Night')
