"""Build a clean desk + blank-parchment plate from a frame of the reference clip."""
import sys
import numpy as np, cv2

src, out = sys.argv[1], sys.argv[2]
img = cv2.imread(src).astype(np.float32)
H, W = img.shape[:2]

# Paper quad (TL, TR, BR, BL) measured on the reference frame
QUAD = np.array([[338, 166], [1578, 176], [1632, 952], [298, 946]], np.float32)
paper = np.zeros((H, W), np.uint8)
cv2.fillPoly(paper, [QUAD.astype(np.int32)], 255)
inner = cv2.erode(paper, np.ones((31, 31), np.uint8))

# Ink = anything that is not plain parchment (blue sea, gold/brown fills, lines, icons)
hsv = cv2.cvtColor(img.astype(np.uint8), cv2.COLOR_BGR2HSV).astype(np.float32)
b, g, r = cv2.split(img)
blue = (b > r - 55)                       # sea tint is bluish/grey vs warm paper
fill = (hsv[..., 1] > 95)                 # saturated gold / brown
dark = (hsv[..., 2] < 175)
ink = ((blue | fill | dark) & (inner > 0)).astype(np.uint8) * 255
# old Golan hatch is light and escapes the colour test: mask it by hand
cv2.fillPoly(ink, [np.array([[905, 520], [1000, 520], [1000, 700], [905, 700]], np.int32)], 255)
ink = cv2.dilate(ink, np.ones((25, 25), np.uint8))

# Low-frequency lighting of the paper: inpaint the ink at low resolution
# Lighting: per-channel smooth surface fitted to plain paper plus the sea area with its
# blue tint removed (gain measured paper vs sea); gold/brown fills are left out.
s = 8
small = cv2.resize(img, (W // s, H // s), interpolation=cv2.INTER_AREA)
hs = cv2.resize(hsv, (W // s, H // s), interpolation=cv2.INTER_AREA)
inns = cv2.resize(cv2.erode(inner, np.ones((15, 15), np.uint8)), (W // s, H // s), interpolation=cv2.INTER_NEAREST)
fillm = cv2.dilate(((hs[..., 1] > 125) | (hs[..., 2] < 150)).astype(np.uint8), np.ones((9, 9), np.uint8)) > 0
bs, gs, rs = cv2.split(small)
seam = (bs > rs - 55) & ~fillm & (inns > 0)
papm = ~(bs > rs - 55) & ~fillm & (inns > 0)
gain = np.median(small[papm], 0) / np.median(small[seam], 0)
fixed = small.copy()
fixed[seam] *= gain
yy, xx = np.mgrid[0:H // s, 0:W // s].astype(np.float32)
xn, yn = xx / (W // s), yy / (H // s)
def basis(x, y, deg=3):
    return np.stack([x ** i * y ** j for i in range(deg + 1) for j in range(deg + 1 - i)], -1)
A = basis(xn, yn)
sel = seam | papm
fit = np.zeros_like(small)
for c in range(3):
    coef, *_ = np.linalg.lstsq(A[sel], fixed[..., c][sel], rcond=None)
    fit[..., c] = A @ coef
# use the real (blurred) paper where it is clean, the fit elsewhere
blur_orig = cv2.GaussianBlur(small, (0, 0), 3)
m = cv2.GaussianBlur(papm.astype(np.float32), (0, 0), 4)
m = cv2.erode(m, np.ones((5, 5), np.uint8))[..., None]
lowf = blur_orig * m + fit * (1 - m)
lowf = cv2.resize(lowf.astype(np.float32), (W, H), interpolation=cv2.INTER_CUBIC)

# Grain: original texture where there was no ink, soft synthetic grain elsewhere
rng = np.random.default_rng(3)
noise = cv2.GaussianBlur(rng.normal(0, 7, (H, W)).astype(np.float32), (0, 0), 1.2)
blot = cv2.GaussianBlur(rng.normal(0, 40, (H, W)).astype(np.float32), (0, 0), 25)
syn = (noise + blot)[..., None] * np.array([1.0, 1.05, 1.15], np.float32)
orig_hp = img - cv2.GaussianBlur(img, (0, 0), 12)
inkf = cv2.GaussianBlur(cv2.dilate(ink, np.ones((41, 41), np.uint8)).astype(np.float32) / 255, (0, 0), 10)[..., None]
grain = orig_hp * (1 - inkf) + syn * inkf

clean_paper = lowf + grain
pm = cv2.GaussianBlur(inner.astype(np.float32) / 255, (0, 0), 3)[..., None]
res = img * (1 - pm) + clean_paper * pm
cv2.imwrite(out, np.clip(res, 0, 255).astype(np.uint8))
cv2.imwrite(out.replace('.png', '_ink.png'), ink)
print('ok')
