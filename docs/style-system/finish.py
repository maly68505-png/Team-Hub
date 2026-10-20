"""Preview the finishing stack on a still: tone LUT -> colour LUT -> bloom -> vignette -> grain.

usage: python3 finish.py in.png out.png [colour.cube]
"""
import os, subprocess, sys, tempfile
import cv2, numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))

def lut(src, cube, dst):
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', src, '-vf', f'lut3d={cube}', dst], check=True)

def finish(src, dst, colour=None):
    with tempfile.TemporaryDirectory() as t:
        cur = os.path.join(t, 'tone.png')
        lut(src, os.path.join(HERE, 'tone_lowkey.cube'), cur)
        if colour:
            nxt = os.path.join(t, 'colour.png')
            lut(cur, colour, nxt)
            cur = nxt
        x = cv2.imread(cur).astype(np.float32) / 255
    H, W = x.shape[:2]
    hi = np.clip((x - 0.75) / 0.25, 0, 1)                                   # bloom
    glow = cv2.GaussianBlur(hi, (0, 0), W * 0.02) * 0.6 + cv2.GaussianBlur(hi, (0, 0), W * 0.006) * 0.4
    x = 1 - (1 - x) * (1 - 0.30 * glow)
    yy, xx = np.mgrid[0:H, 0:W]                                              # vignette ~45%
    r = np.hypot((xx - W / 2) / (W / 2), (yy - H / 2) / (H / 2)) / 1.414
    x *= (1 - 0.45 * np.clip((r - 0.35) / 0.65, 0, 1) ** 1.6)[..., None]
    n = cv2.GaussianBlur(np.random.default_rng(1).normal(0, 0.012, (H, W)).astype(np.float32), (0, 0), 0.6)
    x = np.clip(x + n[..., None] * (0.4 + 0.6 * (1 - x.mean(2, keepdims=True))), 0, 1)   # grain
    cv2.imwrite(dst, (x * 255).astype(np.uint8))

if __name__ == '__main__':
    finish(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None)
