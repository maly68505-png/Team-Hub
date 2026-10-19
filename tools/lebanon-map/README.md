# Lebanon map – corrected

Redraws the "old map on a desk" shot with real borders instead of AI-drawn ones.

- Borders, Golan, West Bank, Gaza, Sea of Galilee, Dead Sea: Natural Earth 10m (public domain)
- Litani: hand-traced course (source near Baalbek → Qaraoun → westward bend below Beaufort → mouth at Qasmiyeh)
- Lebanon border is drawn as a bold dotted line; other land borders as fine dotted lines

## Run

```sh
pip install pillow shapely numpy opencv-python-headless
B=https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson
for f in ne_10m_admin_0_countries ne_10m_rivers_lake_centerlines ne_10m_lakes ne_10m_admin_0_disputed_areas; do
  curl -sSO $B/$f.geojson; done
curl -sS -o Cairo.ttf "https://raw.githubusercontent.com/google/fonts/main/ofl/cairo/Cairo%5Bslnt%2Cwght%5D.ttf"

python3 cleanplate.py reference_frame.jpg plate.png   # strip the old map off the paper
python3 mapdraw.py plate.png                          # still: preview.png
python3 animate.py                                    # frames_out/ (8 s @ 23.976)
ffmpeg -framerate 24000/1001 -i frames_out/f_%04d.png -c:v libx264 -crf 16 -pix_fmt yuv420p out.mp4
```

Strike points and timings are at the top of `animate.py`; colours and label positions in `mapdraw.py`.
`QUAD` (paper corners) is measured on the reference frame — re-measure it if you use a different plate.
