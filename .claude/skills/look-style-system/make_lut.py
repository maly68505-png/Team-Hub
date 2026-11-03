#!/usr/bin/env python3
"""Build tone_lowkey.cube: a tone-only low-key 3D LUT.

The curve is applied to luminance (Rec.709) and every RGB triplet is scaled by
the same factor, so hue and saturation are never changed - only brightness.
Colours are set per project, after this LUT.

Defaults follow STYLE-SYSTEM.md (0-255 scale): blacks ~3, low-key mids,
highlights 150-200, top ~235 with a soft shoulder (no clipping).

    python3 make_lut.py                    # writes tone_lowkey.cube next to this file
    python3 make_lut.py --gamma 2.4 -o darker.cube
    python3 make_lut.py --check            # print the curve and run the colour test
"""
import argparse
import colorsys
import math
import os
import random

REC709 = (0.2126, 0.7152, 0.0722)


def curve(y, gamma, toe, knee, cap):
    """Map input luminance 0-1 to output luminance 0-1."""
    v = (1 - toe) * y ** gamma + toe * y  # low-key power curve, small linear toe keeps blacks ~3
    if v > knee:  # soft shoulder: highlights roll off towards `cap`, never clip
        v = knee + (cap - knee) * math.tanh((v - knee) / (cap - knee))
    return v


def apply(rgb, p):
    y = sum(c * w for c, w in zip(rgb, REC709))
    if y <= 0:
        return (0.0, 0.0, 0.0)
    k = curve(y, p.gamma, p.toe, p.knee, p.cap) / y
    k = min(k, 1 / max(rgb))  # same factor on R, G and B: hue and saturation stay the same
    return tuple(c * k for c in rgb)


def write_cube(path, p):
    n = p.size
    with open(path, "w") as f:
        f.write('TITLE "tone_lowkey - tone only, no colour change"\n')
        f.write(f"# gamma={p.gamma} toe={p.toe} knee={p.knee} cap={p.cap}\n")
        f.write(f"LUT_3D_SIZE {n}\nDOMAIN_MIN 0.0 0.0 0.0\nDOMAIN_MAX 1.0 1.0 1.0\n")
        for b in range(n):  # .cube order: red changes fastest
            for g in range(n):
                for r in range(n):
                    out = apply((r / (n - 1), g / (n - 1), b / (n - 1)), p)
                    f.write("%.6f %.6f %.6f\n" % out)


def check(p):
    print("input -> output (0-255 luminance)")
    for x in (0, 13, 25, 51, 77, 102, 128, 153, 179, 204, 230, 255):
        print(f"  {x:3d} -> {255 * curve(x / 255, p.gamma, p.toe, p.knee, p.cap):6.1f}")
    rnd = random.Random(1)
    worst_h = worst_s = 0.0
    for _ in range(20000):
        rgb = tuple(rnd.random() for _ in range(3))
        h1, s1, _ = colorsys.rgb_to_hsv(*rgb)
        h2, s2, _ = colorsys.rgb_to_hsv(*apply(rgb, p))
        if s1 > 0.02:
            worst_h = max(worst_h, min(abs(h1 - h2), 1 - abs(h1 - h2)) * 360)
        worst_s = max(worst_s, abs(s1 - s2))
    print(f"max hue shift: {worst_h:.6f} deg   max saturation shift: {worst_s:.6f}")


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--gamma", type=float, default=2.2, help="higher = darker mids (default 2.2)")
    ap.add_argument("--toe", type=float, default=0.03, help="linear toe, keeps blacks from crushing to 0")
    ap.add_argument("--knee", type=float, default=0.65, help="where the highlight shoulder starts (0-1)")
    ap.add_argument("--cap", type=float, default=0.92, help="brightest output (0.92 = ~235)")
    ap.add_argument("--size", type=int, default=33, help="LUT grid size (33 or 65)")
    ap.add_argument("-o", "--out", default=os.path.join(here, "tone_lowkey.cube"))
    ap.add_argument("--check", action="store_true", help="print the curve and test colour preservation")
    p = ap.parse_args()
    if p.check:
        check(p)
        return
    write_cube(p.out, p)
    print("wrote", p.out)


if __name__ == "__main__":
    main()
