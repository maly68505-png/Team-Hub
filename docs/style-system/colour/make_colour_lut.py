"""Colour-only LUT (step 4 of the finishing stack): split-tone by luma, luma left untouched.

Preset "teal_ember", measured on the hooded-portrait reference:
  luma < 90/255   -> teal-blue, hue ~206 deg, strong saturation (56% of pixels)
  luma > 110/255  -> ember orange, hue ~15-30 deg (91-99% warm above 120)
  crossover around luma 0.40, highlights warm, deepest blacks still blue
"""
import colorsys, sys
import numpy as np

N = 33
PRESETS = {
    'teal_ember': dict(shadow_hue=204, shadow_sat=0.72, high_hue=24, high_sat=0.55,
                       cross=0.42, width=0.34, keep=0.35),
}
W709 = np.array([0.2126, 0.7152, 0.0722])

def hue_rgb(h_deg, s, l):
    """RGB with the given hue/saturation and Rec.709 luma l."""
    c = np.array(colorsys.hsv_to_rgb(h_deg / 360, s, 1.0))
    return c * (l / (c @ W709))

def grade(rgb, p):
    l = float(rgb @ W709)
    if l <= 1e-5:
        return rgb
    w = 1 / (1 + np.exp(-(l - p['cross']) / (p['width'] / 4)))          # 0 = shadow, 1 = highlight
    # blend the two tints (teal and orange mix to neutral at the crossover, no hard hue switch)
    target = (hue_rgb(p['shadow_hue'], p['shadow_sat'], l) * (1 - w)
              + hue_rgb(p['high_hue'], p['high_sat'], l) * w)
    # strongly coloured pixels (a red lamp, a screen) keep more of their own colour
    s_in = (rgb.max() - rgb.min()) / max(rgb.max(), 1e-6)
    keep = p['keep'] + (0.85 - p['keep']) * np.clip((s_in - 0.45) / 0.4, 0, 1)
    out = target * (1 - keep) + rgb * keep
    out *= l / max(out @ W709, 1e-6)                                   # exact luma preservation
    m = out.max()
    if m > 1:
        out = l + (out - l) * ((1 - l) / (m - l))
    return np.clip(out, 0, 1)

def write(path, preset):
    p = PRESETS[preset]
    with open(path, 'w') as f:
        f.write(f'TITLE "{preset} (colour only)"\nLUT_3D_SIZE {N}\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 1 1 1\n')
        for b in range(N):
            for g in range(N):
                for r in range(N):
                    o = grade(np.array([r, g, b], float) / (N - 1), p)
                    f.write(f'{o[0]:.6f} {o[1]:.6f} {o[2]:.6f}\n')

if __name__ == '__main__':
    preset = sys.argv[1] if len(sys.argv) > 1 else 'teal_ember'
    write(sys.argv[2] if len(sys.argv) > 2 else f'{preset}.cube', preset)
