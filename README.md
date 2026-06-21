# AETHER — browser-native NEXRAD scope

A live WSR-88D **NEXRAD Level II** weather-radar viewer that does **all** of its
work in the browser. There is no backend: the page lists scans, downloads the
raw radar volume, decompresses it, parses the binary message format, and renders
the radar imagery — entirely client-side.

![products](https://img.shields.io/badge/products-REF%20VEL%20SW%20%CF%81HV%20ZDR%20%CF%86DP-36e0c8)

## What it does

- **Live data** from the open `unidata-nexrad-level2` AWS S3 bucket (NOAA Open
  Data Dissemination). The bucket is CORS-enabled (`Access-Control-Allow-Origin: *`)
  for both listing and download, so the browser talks to it directly.
- **Client-side bzip2** decompression of the LDM records (`js/bzip2.js`), a
  self-contained, dependency-free implementation (Huffman + MTF + RLE2 + inverse
  BWT + RLE1).
- **WSR-88D Level II decoding** of Message 31 (`js/level2.js`): base reflectivity
  (REF), velocity (VEL), spectrum width (SW), correlation coefficient (ρHV),
  differential reflectivity (ZDR) and differential phase (φDP).
- **GPU polar rendering** (`js/radarLayer.js`): a custom Mapbox WebGL layer
  samples the polar gate data per screen pixel with a nearest-neighbour lookup,
  every frame, over an **interactive Mapbox GL JS map**. Because nothing is
  rasterised to a fixed canvas, the NEXRAD gates stay pixel-exact at any zoom —
  no interpolation, no "auto smoothing", and pan/zoom cost no JavaScript. The
  radar is slotted *into* the basemap's own layer stack — beneath the town-name
  and boundary layers — so place names and borders always draw on top of the
  reflectivity, with meteorologically conventional color scales
  (`js/products.js`).
- A distinctive **radar-operations-console UI** over a dark basemap: range rings,
  a live cursor readout, opacity control, elevation-tilt selection, and a UTC
  clock. Pan/zoom the map freely.
- **Split-cut aware product selection**: modern VCPs split the Doppler moments
  (VEL/SW) and dual-pol moments (ρHV/ZDR/φDP) into separate sweeps at nearly the
  same elevation. For the chosen product the viewer renders whichever sweep
  actually carries that moment closest to the selected tilt — so every product,
  including the dual-pol ones, displays correctly.
- Heavy decode runs in a **Web Worker** (`js/decoder.worker.js`) so the UI never
  freezes, even on 7 MB+ volumes.

## Architecture

```
index.html ─ css/style.css        UI shell + console styling
js/app.js                         controller: UI, state, interaction
 ├─ js/s3.js                      list/download volumes from S3 (CORS)
 ├─ js/products.js                color scales + LUTs per product
 ├─ js/radarLayer.js              custom WebGL layer: polar gates → GPU, per pixel
 ├─ js/renderer.js                sweep range + point-sample helpers
 ├─ Mapbox GL JS (CDN)            vector basemap; radar/alerts inserted below labels
 └─ js/decoder.worker.js          off-thread decode
     └─ js/level2.js              Archive II / Message 31 parser
         └─ js/bzip2.js           pure-JS bzip2 decompressor
```

## Running it

It is a static site — serve the folder over HTTP (ES modules and module workers
require `http(s)://`, not `file://`):

```bash
python3 -m http.server 8080
# then open http://localhost:8080/
```

Pick a radar site, choose a product, and scrub through the day's volume scans.
Toggle **LIVE** to auto-load the newest scan as it arrives. Scroll to zoom, drag
to pan, hover to read the value at any gate.

## Data source notes

The Unidata feed carries a rolling window of the most recent scans — exactly
what a live viewer needs. NOAA's deep archive bucket `noaa-nexrad-level2` holds
data back to 1991 but disables anonymous bucket listing, so it cannot be browsed
from the client; the Unidata realtime mirror is used instead.

## Validation

The bzip2 decoder is verified byte-exact against reference `bzip2 -9`/`-1`
output (single- and multi-block). The Level II parser has been validated against
live KTLX volumes (correct site geolocation, super-resolution 250 m gate
spacing, and physically sensible moment values).
