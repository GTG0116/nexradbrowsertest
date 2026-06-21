# AETHER — browser-native NEXRAD scope

A live WSR-88D **NEXRAD Level II** weather-radar viewer that does **all** of its
work in the browser. There is no backend: the page lists scans, downloads the
raw radar volume, decompresses it, parses the binary message format, and renders
the radar imagery — entirely client-side.

![products](https://img.shields.io/badge/products-REF%20VEL%20SW%20%CF%81HV%20ZDR%20%CF%86DP-36e0c8)

## What it does

- **Live data**, primarily from the Iowa Environmental Mesonet (IEM) raw
  Level II feed (`mesonet-nexrad.agron.iastate.edu/level2/raw/`), which relays
  the NWS realtime feed and exposes volumes as they are ingested — so it carries
  the freshest scans. When IEM is unreachable or lacks data for the requested
  day (it keeps only a rolling window), the viewer transparently falls back to
  the open `unidata-nexrad-level2` AWS S3 bucket (NOAA Open Data Dissemination),
  which is CORS-enabled (`Access-Control-Allow-Origin: *`) and retains the recent
  archive for history browsing.
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
  clock. Pan/zoom the map freely. An **inspect** crosshair reads the value under
  it for *any* layer (radar, satellite or MRMS), and all readouts are in
  **imperial units** (mph, miles, inches, °F).
- **Velocity dealiasing** (optional): a continuity unfold that removes the false
  green-beside-red folds where Doppler velocity exceeds the Nyquist limit.
- **Split-cut aware product selection**: modern VCPs split the Doppler moments
  (VEL/SW) and dual-pol moments (ρHV/ZDR/φDP) into separate sweeps at nearly the
  same elevation. For the chosen product the viewer renders whichever sweep
  actually carries that moment closest to the selected tilt — so every product,
  including the dual-pol ones, displays correctly.
- Heavy decode runs in a **Web Worker** (`js/decoder.worker.js`) so the UI never
  freezes, even on 7 MB+ volumes.

## Beyond radar: Satellite and MRMS

The same browser-native, decode-it-yourself approach now drives two more data
sources, selectable from the **RADAR / SAT / MRMS** switch in the Source panel.

### Satellite — GOES-R ABI (`noaa-goes16/18/19`)

- **GOES ABI Level-2** multi-band cloud/moisture imagery, read straight from the
  open GOES buckets. A single `MCMIP` file carries all 16 ABI channels, so every
  channel *and* every RGB composite comes from one download.
- **A from-scratch HDF5 / NetCDF-4 reader** (`js/hdf5.js`): superblock v2/v3,
  object-header v2 with continuation blocks, dense link/attribute storage via
  **fractal heaps**, chunked data indexed by a v1 B-tree, and the **shuffle +
  deflate** filter pipeline (deflate via the platform `DecompressionStream`). No
  HDF5 library — just the bytes.
- **Sectors**: full-disk, CONUS, and both mesoscale floaters, plus a set of
  familiar **regional CONUS framings** (Southern Plains, Midwest, Northeast …).
- **All 16 ABI channels** (visible/near-IR as reflectance, IR as brightness
  temperature). A colour enhancement (on by default, toggleable) gives the
  infrared window channels the classic rainbow cloud-top scale and the
  water-vapour channels a dedicated WV enhancement. Plus **RGB composites**:
  True Color (with synthetic green), Natural Color, Day Cloud Phase, Air Mass and
  Night Microphysics.
- **GPU geostationary projection** (`js/satelliteLayer.js`): a fragment shader
  inverts web-mercator to lon/lat and runs the GOES fixed-grid navigation
  *backwards* per pixel, so the imagery stays crisp at any zoom.

### MRMS (`noaa-mrms-pds`)

- **GRIB2 decoded in pure JS** (`js/grib2.js`): gunzip via `DecompressionStream`,
  GRIB2 section parsing, and an in-house PNG reader for the PNG-packed values
  (DRT 5.41) so the full precision survives (a `<canvas>` would clamp it) —
  grayscale 8/16-bit *and* the RGB-packed 24-bit fields (e.g. lightning
  probability). Super-res products (AzShear, rotation tracks) on the 0.005° grid
  are coloured in their native 10⁻³ s⁻¹ units.
- **Products**: Composite Reflectivity, AzShear (instant rotation), 1/6/24-hr
  rotation tracks, MESH (max hail size), POSH (severe-hail probability), 30-min
  CG-lightning probability, and 1/6/24-hr precip totals.
- **GPU plate-carrée layer** (`js/gridLayer.js`) draws the 7000×3500 CONUS grid
  (max-pooled to a GPU-friendly texture) with per-product colour tables.

### Weather models — HRRR (`noaa-hrrr-bdp-pds`)

- **Dozens of HRRR fields in three categories**, read straight from the
  operational High-Resolution Rapid Refresh GRIB2 on S3 and grouped in the
  product picker:
  - *Surface & Precip* — composite reflectivity, 2 m temperature and dew point,
    10 m wind speed and gusts, relative humidity, total cloud cover, and
    1/6/24-hr and run-total precipitation.
  - *Upper Air* — 200/300/500/700/850/925 mb isotachs, plus 500/700/850 mb
    absolute vorticity and 500/700/850/925 mb temperature, each drawn with wind
    barbs and geopotential-height contours overlaid (see below). These pull from
    the `wrfprs` pressure-level file.
  - *Severe* — SB/ML/MU/0-3 km CAPE, SB/ML CIN, 700-500 mb lapse rate, SB LCL,
    0-1/0-3 km storm-relative helicity, 0-1/0-6 km bulk shear, storm motion,
    significant-tornado / supercell / 0-1 & 0-3 km energy-helicity composites,
    and lightning flash density.
  - Rather than pull the ~150–400 MB cycle file, the viewer reads the tiny
    sidecar `.idx` byte index, finds the requested record(s), and issues a single
    HTTP **Range** request for just that message (a few hundred KB).
- **Derived fields** (`js/models.js`): one product can combine several GRIB
  messages after decoding — wind speed/shear/storm-motion from U/V magnitudes,
  6/24-hr precip from run-total differences, 700-500 mb lapse rate from layer
  temperatures and thicknesses, LCL height AGL, and the STP/SCP/EHI composites
  from CAPE, helicity, shear, LCL and CIN (standard SPC fixed-layer formulas).
- **Wind-barb + height overlays** (`js/modelOverlays.js`): upper-air charts add a
  Mapbox symbol layer of canvas-rendered wind barbs (rotated to the wind, kept at
  a constant screen size and decluttered as you zoom) and geopotential-height
  contours generated by marching squares — stitched into polylines with
  decameter labels along the lines.
- **GRIB2 complex packing** decoded in pure JS (`js/grib2.js`): NCEP's complex
  packing with 2nd-order **spatial differencing** (Data Representation Template
  5.3) — group references/widths/lengths and the integrated spatial differences
  — which is how HRRR (and most model output) is stored. Sign-magnitude integers
  throughout, as the GRIB2 standard requires.
- **Lambert Conformal → lat/lon** (`js/models.js`): HRRR rides a 3 km Lambert
  Conformal Conic grid, so each field is resampled onto a plain lat/lon grid via
  a forward LCC projection and then drawn through the **same GPU grid layer**
  (`js/gridLayer.js`) and inspect path as the lat/lon MRMS products. Surface and
  pressure-level fields share the identical target grid, so multi-message
  products combine cell-for-cell after resampling.
- Composite reflectivity uses the **shared reflectivity color table** — the same
  one as MRMS and single-site radar — so a `.pal` loaded for single-site
  reflectivity recolours all three at once; the other fields carry their own
  meteorologically conventional color scales with imperial-unit readouts (°F,
  mph, inches).
- **Forecast-hour selection**: a run (cycle) exposes its full set of forecast
  hours (F00–F18, out to F48 for the synoptic 00/06/12/18z runs), pickable from
  the right rail like radar elevation tilts.
- **Point soundings** (`js/sounding.js`): in HRRR mode, **⊙ Sounding** (right
  rail, or the ⊙ tool on the mobile dock) opens a full-screen, mobile-first
  briefing for the column under the map center:
  - a proper **Skew-T / log-P** with dry & moist adiabats, mixing-ratio lines,
    skewed isotherms, temperature/dewpoint traces, a lifted surface-parcel path
    with **CAPE/CIN shading**, and wind barbs up the right margin;
  - a height-coloured **hodograph** in knots with range rings and **Bunkers
    right/left storm-motion** markers, the 0–6 km mean wind, and the 0–1 km
    storm-relative inflow;
  - a colour-tiered **severe parameter** grid — CAPE/CIN/LI, 700–500 lapse rate,
    PWAT, LCL, 0–1 & 0–6 km bulk shear, 0–1 & 0–3 km SRH (relative to the
    Bunkers right mover), and the STP/SCP/EHI composites — all computed in the
    browser from the profile.

  A *point* sounding is the one place the decode-it-yourself path can't reach:
  GRIB2 complex packing with spatial differencing can't be subset to a single
  grid cell, so reading one column from the wrfprs file would mean downloading
  the whole ~130 MB file per tap. Instead the profile comes from the
  CORS-enabled **Open-Meteo HRRR point API** (`models=gfs_hrrr`) — one small
  JSON request, pinned to the displayed run's valid hour — and every diagram and
  derived parameter is then computed locally (parcel theory, Bunkers motion,
  helicity and the SPC composites), in the same spirit as the rest of the app.

## Source switching, overlay and playback

- The **RADAR / SAT / MRMS / MODELS** switch picks the active source. The
  single-site radar is hidden in the satellite, MRMS and model modes unless the
  **Radar overlay** toggle is switched on — then the live radar is drawn on top
  of the other source.
- **Playback** works for every source: it loops recent radar volumes, MRMS
  frames or satellite scenes, and steps through a model run's **forecast hours**.
  Each frame is loaded into a compact GPU-ready payload and cached, so a loop
  scrubs instantly without holding the (often >100 MB) raw decoded fields. The
  number of frames a loop preloads is adjustable (the **Playback frames** slider,
  default 5).

## Architecture

```
index.html ─ css/style.css        UI shell + console styling
js/app.js                         controller: UI, state, interaction
 ├─ js/s3.js                      list/download volumes (IEM live → AWS S3 fallback)
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

The IEM raw feed (`mesonet-nexrad.agron.iastate.edu/level2/raw/<SITE>/`) is the
primary live source: it indexes each site's recent volumes in a `dir.list` file
and serves them as ordinary AR2V Archive II files (the `.bz2` extension
notwithstanding), often a scan or two ahead of the AWS mirror. It keeps only a
rolling window and does not advertise CORS, so the viewer falls back to the
Unidata AWS S3 mirror — which is CORS-enabled and retains a longer recent
archive — whenever IEM is blocked, errors, or has no data for the requested day
(as when browsing history). If a deployment's origin can't reach IEM directly
because of CORS, point `setProxy()` in `js/s3.js` at a CORS proxy.

NOAA's deep archive bucket `noaa-nexrad-level2` holds data back to 1991 but
disables anonymous bucket listing, so it cannot be browsed from the client.

## Validation

The bzip2 decoder is verified byte-exact against reference `bzip2 -9`/`-1`
output (single- and multi-block). The Level II parser has been validated against
live KTLX volumes (correct site geolocation, super-resolution 250 m gate
spacing, and physically sensible moment values).
