"""Draw an accurate Lebanon map overlay (Natural Earth borders) in the parchment style."""
import json, math, os
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageChops
from shapely.geometry import shape, box, LineString, Polygon, MultiPolygon
from shapely.ops import unary_union

HERE = os.path.dirname(os.path.abspath(__file__))
FW, FH = 1300, 790          # flat map canvas, later warped onto the paper
OUT_W, OUT_H = 1920, 1080
W, H = FW, FH
SS = 2  # supersampling
# Paper corners in the plate (TL, TR, BR, BL)
QUAD = [(338, 166), (1578, 176), (1632, 952), (298, 946)]

# Map frame: true proportions (lon degrees shrunk by cos(lat))
LAT1 = 34.95
PXDEG = 250.0                                   # pixels per degree of latitude
LAT0 = LAT1 - FH / PXDEG
LONDEG = PXDEG * math.cos(math.radians(33.3))
LON0 = 35.95 - 690 / LONDEG
LON1 = LON0 + FW / LONDEG
PX0, PY0, PX1, PY1 = 0, 0, FW, FH

def load(name):
    return json.load(open(os.path.join(HERE, name + '.geojson')))['features']

BB = box(LON0 - 1, LAT0 - 1, LON1 + 1, LAT1 + 1)
countries = {f['properties']['ADMIN']: shape(f['geometry']).intersection(BB)
             for f in load('ne_10m_admin_0_countries')
             if shape(f['geometry']).intersects(BB)}
disputed = {f['properties']['NAME']: shape(f['geometry']) for f in load('ne_10m_admin_0_disputed_areas')
            if f['properties']['NAME'] in ('Golan Heights', 'West Bank', 'Gaza', 'Shebaa Farms', 'UNDOF Zone')}
lakes = [shape(f['geometry']) for f in load('ne_10m_lakes')
         if f['properties']['name'] in ('Sea of Galilee', 'Dead Sea')]
jordan_river = [shape(f['geometry']) for f in load('ne_10m_rivers_lake_centerlines')
                if f['properties']['name'] == 'Jordan']

# Litani river course (lon, lat): source near Baalbek, south through the Bekaa,
# Qaraoun lake, sharp westward bend below Beaufort castle, mouth at Qasmiyeh north of Tyre.
LITANI = [(36.155, 34.020), (36.100, 33.975), (36.040, 33.920), (35.985, 33.870), (35.935, 33.820),
          (35.895, 33.760), (35.850, 33.700), (35.800, 33.640), (35.755, 33.600), (35.705, 33.565),
          (35.680, 33.520), (35.655, 33.475), (35.625, 33.420), (35.598, 33.375), (35.565, 33.340),
          (35.540, 33.325), (35.500, 33.318), (35.455, 33.330), (35.410, 33.340), (35.360, 33.345),
          (35.310, 33.338), (35.270, 33.336), (35.247, 33.338)]

sx = (PX1 - PX0) / (LON1 - LON0)
sy = (PY1 - PY0) / (LAT1 - LAT0)

def P(lon, lat):
    return ((PX0 + (lon - LON0) * sx) * SS, (PY0 + (LAT1 - lat) * sy) * SS)

def rings(g):
    if g.is_empty:
        return []
    polys = [g] if isinstance(g, Polygon) else [p for p in getattr(g, 'geoms', []) if isinstance(p, Polygon)]
    return polys

def poly_pts(ring):
    return [P(x, y) for x, y in ring.coords]

def fill(d, g, color):
    for p in rings(g):
        d.polygon(poly_pts(p.exterior), fill=color)
        for i in p.interiors:
            d.polygon(poly_pts(i), fill=(0, 0, 0, 0))

def line_pts(line):
    return [P(x, y) for x, y in line.coords]

def dashed(d, pts, color, width, dash=14, gap=9, offset=0.0, progress=1.0):
    """Dotted/dashed polyline. progress 0..1 draws only the first part."""
    seglens = [math.dist(pts[i], pts[i + 1]) for i in range(len(pts) - 1)]
    total = sum(seglens) * progress
    dash, gap = dash * SS, gap * SS
    period = dash + gap
    pos = -offset * period
    walked = 0.0
    for (a, b), L in zip(zip(pts, pts[1:]), seglens):
        if walked >= total:
            break
        L_use = min(L, total - walked)
        t = 0.0
        while t < L_use:
            phase = (walked + t - pos) % period
            if phase < dash:
                run = min(dash - phase, L_use - t)
                t0, t1 = t / L, (t + run) / L
                d.line([(a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0),
                        (a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1)], fill=color, width=width * SS)
                t += run
            else:
                t += period - phase
        walked += L

def partial_line(pts, progress):
    seglens = [math.dist(pts[i], pts[i + 1]) for i in range(len(pts) - 1)]
    total = sum(seglens) * progress
    out = [pts[0]]
    acc = 0
    for (a, b), L in zip(zip(pts, pts[1:]), seglens):
        if acc + L >= total:
            t = (total - acc) / L if L else 0
            out.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
            break
        out.append(b)
        acc += L
    return out

def shared_borders(a, b):
    inter = a.boundary.intersection(b.buffer(0.01))
    lines = []
    for g in getattr(inter, 'geoms', [inter]):
        if isinstance(g, LineString) and g.length > 0.02:
            lines.append(g)
    return lines

def hatch(size, g, color, spacing=16, width=3):
    """Diagonal hatch clipped to polygon g."""
    lay = Image.new('RGBA', size, (0, 0, 0, 0))
    hd = ImageDraw.Draw(lay)
    s = spacing * SS
    for k in range(-size[1], size[0], s):
        hd.line([(k, size[1]), (k + size[1], 0)], fill=color, width=width * SS)
    mask = Image.new('L', size, 0)
    fill(ImageDraw.Draw(mask), g, 255)
    out = Image.new('RGBA', size, (0, 0, 0, 0))
    out.paste(lay, (0, 0), mask)
    return out

FONT = os.path.join(HERE, 'Cairo.ttf')

def font(sz, weight=b'Bold'):
    f = ImageFont.truetype(FONT, sz * SS)
    f.set_variation_by_name(weight)
    return f

# colours sampled from the reference clip
SEA = (140, 175, 190, 130)
LEB = (196, 152, 82, 235)
LEB_EDGE = (110, 72, 30, 255)
BORDER = (95, 72, 50, 220)
RIVER = (60, 170, 185, 255)
LAKE = (140, 175, 180, 200)
INK = (255, 248, 235, 255)

lebanon = countries['Lebanon']
syria = countries['Syria']
israel = countries['Israel']
palestine = countries['Palestine']
jordan = countries['Jordan']
egypt = countries['Egypt']
saudi = countries['Saudi Arabia']
land = unary_union([g for g in countries.values()])
sea = box(LON0 - 1, LAT0 - 1, LON1 + 1, LAT1 + 1).difference(land)

def render(fill_a=1.0, river_p=1.0, borders_p=1.0, dash_off=0.0, labels_a=1.0, golan_a=1.0, strikes=()):
    """Return RGBA overlay. strikes: list of (lon, lat, intensity 0..1)."""
    S = (W * SS, H * SS)
    base = Image.new('RGBA', S, (0, 0, 0, 0))
    d = ImageDraw.Draw(base)
    fill(d, sea, SEA)
    for lk in lakes:
        fill(d, lk, LAKE)

    # Lebanon fill
    if fill_a > 0:
        lay = Image.new('RGBA', S, (0, 0, 0, 0))
        fill(ImageDraw.Draw(lay), lebanon, LEB[:3] + (int(LEB[3] * fill_a),))
        base = Image.alpha_composite(base, lay)
    # Golan hatch (occupied, UN-recognised Syrian territory)
    if golan_a > 0:
        golan = disputed['Golan Heights']
        base = Image.alpha_composite(base, hatch(S, golan, (120, 90, 60, int(170 * golan_a))))
    d = ImageDraw.Draw(base)

    # Coastline (solid, thin)
    for p in rings(land):
        d.line(poly_pts(p.exterior), fill=(110, 95, 75, 160), width=2 * SS)

    # Dotted international borders
    pairs = [(lebanon, syria), (lebanon, israel), (syria, israel), (syria, jordan), (israel, jordan),
             (israel, egypt), (jordan, saudi), (israel, palestine), (palestine, jordan), (syria, countries.get('Iraq', Polygon()))]
    for a, b in pairs:
        if a.is_empty or b.is_empty:
            continue
        for ln in shared_borders(a, b):
            dashed(d, line_pts(ln), BORDER, 2, dash=7, gap=6, offset=dash_off, progress=borders_p)
    for name in ('Golan Heights', 'West Bank', 'Gaza'):
        for p in rings(disputed[name]):
            dashed(d, poly_pts(p.exterior), BORDER, 2, dash=7, gap=6, offset=dash_off, progress=borders_p)

    # Lebanon outline: solid edge + bold dotted line on top
    for p in rings(lebanon):
        pts = poly_pts(p.exterior)
        d.line(pts, fill=LEB_EDGE[:3] + (int(200 * fill_a),), width=2 * SS, joint='curve')
    for a in (syria, israel):
        for ln in shared_borders(lebanon, a):
            dashed(d, line_pts(ln), (70, 40, 15, 255), 4, dash=10, gap=8, offset=dash_off, progress=borders_p)

    # Litani
    if river_p > 0:
        pts = partial_line([P(*c) for c in LITANI], river_p)
        glow = Image.new('RGBA', S, (0, 0, 0, 0))
        ImageDraw.Draw(glow).line(pts, fill=(120, 220, 230, 160), width=9 * SS, joint='curve')
        glow = glow.filter(ImageFilter.GaussianBlur(5 * SS))
        base = Image.alpha_composite(base, glow)
        d = ImageDraw.Draw(base)
        d.line(pts, fill=RIVER, width=4 * SS, joint='curve')

    # Strike markers
    for lon, lat, k in strikes:
        if k <= 0:
            continue
        x, y = P(lon, lat)
        gl = Image.new('RGBA', S, (0, 0, 0, 0))
        gd = ImageDraw.Draw(gl)
        r = (10 + 18 * k) * SS
        gd.ellipse([x - r, y - r, x + r, y + r], fill=(255, 120, 30, int(150 * k)))
        gl = gl.filter(ImageFilter.GaussianBlur(10 * SS))
        base = Image.alpha_composite(base, gl)
        d = ImageDraw.Draw(base)
        r2 = 6 * SS
        d.ellipse([x - r2, y - r2, x + r2, y + r2], fill=(200, 40, 20, 255), outline=(255, 230, 200, 255), width=2 * SS)
        rr = (8 + 30 * (1 - k)) * SS
        d.ellipse([x - rr, y - rr, x + rr, y + rr], outline=(220, 60, 20, int(220 * k)), width=3 * SS)

    # Labels
    if labels_a > 0:
        a = int(255 * labels_a)
        lab = Image.new('RGBA', S, (0, 0, 0, 0))
        ld = ImageDraw.Draw(lab)
        def text(xy, s, f, col, anchor='mm', shadow=True):
            if shadow:
                ld.text((xy[0] + 2 * SS, xy[1] + 2 * SS), s, font=f, fill=(60, 35, 10, int(a * .5)), anchor=anchor, direction='rtl', language='ar')
            ld.text(xy, s, font=f, fill=col[:3] + (a,), anchor=anchor, direction='rtl', language='ar')
        text(P(35.95, 34.22), 'لبنان', font(44), INK)
        # Litani label with leader line
        lx, ly = P(35.62, 33.48)
        tx, ty = P(35.30, 33.60)
        ld.line([(lx, ly), (tx + 40 * SS, ty + 14 * SS)], fill=(255, 248, 235, int(a * .8)), width=2 * SS)
        text((tx, ty), 'نهر الليطاني', font(22, b'SemiBold'), INK)
        text(P(37.3, 34.3), 'سوريا', font(30, b'SemiBold'), (120, 95, 70, 255), shadow=False)
        text(P(36.9, 32.25), 'الأردن', font(30, b'SemiBold'), (120, 95, 70, 255), shadow=False)
        text(P(33.9, 33.0), 'البحر المتوسط', font(30, b'SemiBold'), (90, 115, 120, 255), shadow=False)
        base = Image.alpha_composite(base, lab)

    return base.resize((W, H), Image.LANCZOS)

def warp(ov):
    """Perspective-warp the flat map onto the paper quad."""
    import numpy as np, cv2
    a = np.array(ov)
    src = np.float32([[0, 0], [FW, 0], [FW, FH], [0, FH]])
    M = cv2.getPerspectiveTransform(src, np.float32(QUAD))
    w = cv2.warpPerspective(a, M, (OUT_W, OUT_H), flags=cv2.INTER_LINEAR, borderValue=(0, 0, 0, 0))
    return Image.fromarray(w, 'RGBA')

def composite(bg, overlay):
    """Multiply-ish blend so the paper texture shows through the ink."""
    W, H = OUT_W, OUT_H
    bg = bg.convert('RGBA')
    ov = warp(overlay)
    mult = ImageChops.multiply(bg.convert('RGB'), Image.alpha_composite(Image.new('RGBA', (W, H), (255, 255, 255, 255)), ov).convert('RGB'))
    normal = Image.alpha_composite(bg, ov).convert('RGB')
    mixed = Image.blend(mult, normal, 0.55)
    # keep areas without ink as the original paper
    m = ov.split()[3]
    return Image.composite(mixed, bg.convert('RGB'), m)

if __name__ == '__main__':
    import sys
    bgp = sys.argv[1] if len(sys.argv) > 1 else None
    ov = render(strikes=[(35.60, 33.39, 1.0), (35.30, 33.34, 1.0)])
    if bgp:
        out = composite(Image.open(bgp), ov)
    else:
        out = Image.alpha_composite(Image.new('RGBA', (W, H), (232, 214, 182, 255)), ov).convert('RGB')
    out.save(os.path.join(HERE, 'preview.png'))
    ov.save(os.path.join(HERE, 'overlay.png'))
    print('saved')
