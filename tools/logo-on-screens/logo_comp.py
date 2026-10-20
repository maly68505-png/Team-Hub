"""Put a logo on the gallery screen wall in the last seconds of the teaser.

usage: python3 logo_comp.py video.mp4 logo.png out.mp4 [--tail 4]

The screen wall is found on every frame (bright, low-saturation pixels in the upper part of the
frame), so the logo follows the camera push-in. Once the screens are lit, their content dissolves
into a dark warm background with the logo glowing on it; the bezels stay dark because only the
screen pixels are replaced.
"""
import argparse, os, subprocess, tempfile
import cv2, numpy as np

ap = argparse.ArgumentParser()
ap.add_argument('video'); ap.add_argument('logo'); ap.add_argument('out')
ap.add_argument('--tail', type=float, default=4.0, help='seconds kept from the end')
ap.add_argument('--delay', type=float, default=0.35, help='logo starts this long after the screens light up')
ap.add_argument('--fade', type=float, default=0.7)
ap.add_argument('--scale', type=float, default=0.86, help='logo height / wall height')
a = ap.parse_args()

cap = cv2.VideoCapture(a.video)
fps = cap.get(cv2.CAP_PROP_FPS)
n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
start = max(0, n - int(round(a.tail * fps)))
cap.set(cv2.CAP_PROP_POS_FRAMES, start)
frames = []
while True:
    ok, f = cap.read()
    if not ok:
        break
    frames.append(f)
H, W = frames[0].shape[:2]

logo = cv2.imread(a.logo, cv2.IMREAD_UNCHANGED)
if logo.shape[2] == 3:                      # no alpha: key out a light or dark background
    g = cv2.cvtColor(logo, cv2.COLOR_BGR2GRAY)
    bg = np.median(np.concatenate([g[0], g[-1], g[:, 0], g[:, -1]]))
    alpha = np.clip(np.abs(g.astype(np.float32) - bg) * 3, 0, 255).astype(np.uint8)
    logo = np.dstack([logo, alpha])
ys, xs = np.where(logo[..., 3] > 8)
logo = logo[ys.min():ys.max() + 1, xs.min():xs.max() + 1]

def screen_mask(f):
    hsv = cv2.cvtColor(f, cv2.COLOR_BGR2HSV)
    m = ((hsv[..., 2] > 165) & (hsv[..., 1] < 140)).astype(np.uint8)
    m[int(H * 0.62):] = 0                    # switcher buttons live below this
    m[:int(H * 0.18)] = 0                    # ON AIR sign / ceiling
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
    cnt, lab, st, _ = cv2.connectedComponentsWithStats(m)
    keep = np.zeros_like(m)
    screens = 0
    for i in range(1, cnt):
        if st[i, cv2.CC_STAT_AREA] > W * H * 0.004:      # each screen is a big blob
            cs, _ = cv2.findContours((lab == i).astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            # the screens' corners are darker than the threshold: fill the whole screen rectangle
            box = cv2.boxPoints(cv2.minAreaRect(max(cs, key=cv2.contourArea)))
            cv2.fillConvexPoly(keep, box.astype(np.int32), 1)
            screens += 1
    return keep, screens

found = [screen_mask(f) for f in frames]
masks = [m for m, _ in found]
# lit = most of the wall's screens are bright at once (one glowing screen or the studio flare is not)
on = next((i for i, (m, c) in enumerate(found) if c >= 8), None)
if on is None:
    raise SystemExit('screens never light up in the kept range')

# wall rectangle per frame (from the lit frames), smoothed over time
boxes = np.zeros((len(frames), 4), np.float32)
for i, m in enumerate(masks):
    ys, xs = np.where(m > 0)
    boxes[i] = (xs.min(), ys.min(), xs.max(), ys.max()) if len(xs) and i >= on else np.nan
for i in range(len(frames)):
    if np.isnan(boxes[i, 0]):
        boxes[i] = boxes[on]
k = 7
pad = np.pad(boxes, ((k, k), (0, 0)), mode='edge')
boxes = np.stack([np.convolve(pad[:, j], np.ones(2 * k + 1) / (2 * k + 1), 'valid') for j in range(4)], 1)

def ease(x):
    x = min(max(x, 0.0), 1.0)
    return x * x * (3 - 2 * x)

BG = np.array([6, 10, 18], np.float32)            # near-black warm (BGR)
out_frames = []
for i, f in enumerate(frames):
    t = (i - on) / fps - a.delay
    k_in = ease(t / a.fade)
    img = f.astype(np.float32)
    if k_in > 0:
        x0, y0, x1, y1 = boxes[i]
        wh, ww = y1 - y0, x1 - x0
        lh = wh * a.scale
        lw = lh * logo.shape[1] / logo.shape[0]
        lg = cv2.resize(logo, (int(lw), int(lh)), interpolation=cv2.INTER_AREA).astype(np.float32)
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        ox, oy = int(cx - lw / 2), int(cy - lh / 2)
        layer = np.zeros((H, W, 3), np.float32)
        alpha = np.zeros((H, W), np.float32)
        layer[oy:oy + lg.shape[0], ox:ox + lg.shape[1]] = lg[..., :3]
        alpha[oy:oy + lg.shape[0], ox:ox + lg.shape[1]] = lg[..., 3] / 255
        m = cv2.GaussianBlur(masks[i].astype(np.float32), (0, 0), 1.2)[..., None]
        # screen content: original glow pattern dimmed toward the dark background, logo on top
        lum = img.mean(2, keepdims=True) / 255
        screen = BG * (0.8 + 0.4 * lum)
        glow = cv2.GaussianBlur(alpha, (0, 0), W * 0.006)[..., None]
        screen = screen + glow * np.array([40, 120, 230], np.float32) * 0.9
        screen = screen * (1 - alpha[..., None]) + layer * 1.08 * alpha[..., None]
        img = img * (1 - m * k_in) + screen * m * k_in
        # a little of the logo's light spills into the room
        spill = cv2.GaussianBlur(alpha, (0, 0), W * 0.03)[..., None] * np.array([20, 70, 140], np.float32)
        img = img + spill * 0.5 * k_in
    out_frames.append(np.clip(img, 0, 255).astype(np.uint8))

with tempfile.TemporaryDirectory() as d:
    for i, f in enumerate(out_frames):
        cv2.imwrite(os.path.join(d, f'{i:04d}.png'), f)
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-framerate', str(fps), '-i', os.path.join(d, '%04d.png'),
                    '-c:v', 'libx264', '-crf', '14', '-preset', 'slow', '-pix_fmt', 'yuv420p', a.out], check=True)
print(f'ok: {len(out_frames)} frames, screens lit at frame {on} ({(start + on) / fps:.2f}s)')
