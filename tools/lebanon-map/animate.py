"""Render the corrected map animation as PNG frames + an alpha-free MP4 (23.976 fps, 8 s)."""
import os, sys, math
from multiprocessing import Pool
from PIL import Image
import mapdraw as M

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'frames_out')
FPS = 24000 / 1001
DUR = 8.0
N = int(round(DUR * FPS))
PLATE = Image.open(os.path.join(HERE, 'plate.png')).convert('RGB')
STRIKES = [(35.565, 33.340, 3.6), (35.262, 33.337, 4.1)]   # Khardali bend, Qasmiyeh mouth

def clamp(x):
    return max(0.0, min(1.0, x))

def ease(x):
    x = clamp(x)
    return x * x * (3 - 2 * x)

def frame(i):
    t = i / FPS
    strikes = []
    for lon, lat, t0 in STRIKES:
        if t >= t0:
            k = (t - t0) % 1.4 / 1.4          # repeating pulse
            first = clamp((t - t0) / 0.25)
            strikes.append((lon, lat, first * (1 - k * 0.6)))
    ov = M.render(fill_a=ease((t - 0.7) / 0.9),
                  river_p=ease((t - 1.8) / 1.5),
                  borders_p=ease(t / 1.6),
                  dash_off=t * 0.6,
                  labels_a=ease((t - 1.2) / 0.6),
                  golan_a=ease((t - 4.8) / 0.8),
                  strikes=strikes)
    img = M.composite(PLATE, ov)
    # slow push-in toward Lebanon + gentle light breathing
    z = 1.0 + 0.07 * ease(t / DUR)
    cx, cy = 1000, 470
    w, h = 1920 / z, 1080 / z
    box = (cx - w * (cx / 1920), cy - h * (cy / 1080), 0, 0)
    box = (max(0.0, box[0]), max(0.0, box[1]), min(1920.0, box[0] + w), min(1080.0, box[1] + h))
    img = img.resize((1920, 1080), Image.BICUBIC, box=box)
    flick = 1.0 + 0.012 * math.sin(t * 2.1) + 0.006 * math.sin(t * 5.3)
    img = img.point(lambda v: min(255, int(v * flick)))
    img.save(os.path.join(OUT, f'f_{i:04d}.png'))
    return i

if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    only = [int(a) for a in sys.argv[1:]]
    with Pool(4) as p:
        for _ in p.imap_unordered(frame, only or range(N)):
            pass
    print('frames', len(only) or N)
