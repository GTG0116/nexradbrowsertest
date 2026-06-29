# RadarNexus — browser-native NEXRAD scope

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
- **NEXRAD Level III products** (`js/level3.js`): the same single-site picker also
  offers four RPG-derived products from the open `unidata-nexrad-level3` bucket —
  **Echo Tops** (EET) and the dual-pol QPE accumulations **1-hr** (DAA), **3-hr**
  (DU3) and **Storm-Total** (DTA). They're "Digital Radial Data Array" products
  (one byte per bin, bzip2-compressed symbology); the byte→value transform is the
  RPG's own per-frame scale/offset, which lines up exactly with the radar shader's
  `(code − offset) / scale`, so each decodes into a synthetic one-tilt sweep and
  draws through the existing GPU polar layer with no new renderer.
- **GPU polar rendering** (`js/radarLayer.js`): a custom Mapbox WebGL layer
  samples the polar gate data per screen pixel with a nearest-neighbour lookup,
  every frame, over an **interactive Mapbox GL JS map**. Because nothing is
  rasterised to a fixed canvas, the NEXRAD gates stay pixel-exact at any zoom —
  no interpolation, no "auto smoothing", and pan/zoom cost no JavaScript. The
  radar is slotted *into* the basemap's own layer stack — just beneath the road
  network — so roads, highways, boundaries, place names and labels all draw on top
  of the reflectivity (the classic radar-overlay look), with meteorologically
  conventional color scales (`js/products.js`). Country, state and county outlines
  are redrawn from the basemap's own `admin` vector source (levels 0/1/2) with one
  high-contrast style, so they read the same above the radar on every basemap (not
  just Dark/Light, and including counties the stock styles never draw).
- **Map-layer customisation** (`js/mapStyle.js`, under *Map settings → Customize
  map layers*): the basemap's own town-label font and thickness, the colour and
  thickness of roads and rivers, and the colour and thickness of the
  country/state/county borders are all user-adjustable. Because a basemap switch
  resets every layer to its stock paint, the customisation is re-applied on every
  style load (and mirrored into the split-view pane), so it persists across map
  styles and reloads.
- **Per-alert-kind appearance** (*Map settings → Customize alert appearance*):
  each watch/warning type's fill colour, fill opacity, outline colour and outline
  thickness can be tuned individually; the overrides feed the GL alert layers via
  per-feature properties and are remembered between visits.
- A distinctive **radar-operations-console UI** over a dark basemap: range rings,
  a live cursor readout, opacity control, elevation-tilt selection, and a UTC
  clock. Pan/zoom the map freely. An **inspect** crosshair reads the value under
  it for *any* layer (radar, satellite or MRMS), and all readouts are in
  **imperial units** (mph, miles, inches, °F).
- **Velocity dealiasing** (optional): a continuity unfold that removes the false
  green-beside-red folds where Doppler velocity exceeds the Nyquist limit. A
  second, cross-radial pass then snaps any mis-folded single-radial "beam" back
  into azimuthal continuity, so a stuck radial no longer paints a coloured spoke
  across the sweep.
- **Forecast outlooks** (optional, `js/outlooks.js`): a single overlay that draws
  any of several official outlooks — pick the **product** then a **detail**:
  - **SPC Convective** — days 1–8, drawn straight from SPC's GeoJSON with the
    official risk colours. Days 1 & 2 offer **Categorical** plus probabilistic
    **Tornado / Wind / Hail**; day 3 **Categorical** + combined **Probability**;
    days 4–8 the extended **Probability**.
  - **SPC Fire Weather** — day 1 & 2 critical fire-weather areas and dry-thunderstorm
    areas.
  - **SPC Mesoscale Discussions** — the active MD polygons, labelled by number.
    Click one for a warning-style popup (the discussion's *Concerning* line, watch
    probability, and Most Probable Peak Tornado/Wind/Hail intensities with a
    Min→Max scale bar); "View full briefing" opens the same full-screen layout the
    NWS alerts use, with that probabilistic header in place of the alert tags and
    the parsed discussion text in place of the alert text (fetched and parsed from
    the SPC product page, `parseMdText` in `js/outlooks.js`).
  - **WPC Excessive Rainfall** — the day 1–5 Excessive Rainfall Outlook
    (Marginal / Slight / Moderate / High).
  - **CPC Temperature / Precipitation** — the 6–10 and 8–14 day probability outlooks.

  The SPC convective feed ships its own colours/labels; the others come from NOAA's
  ArcGIS map service as GeoJSON and carry only a code (a `dn` level, or a CPC
  `cat`+`prob`), which `outlooks.js` maps to the official colour/label before the
  shared fill/line layers read it. A legend is built from the areas in view; the
  translucent fill sits beneath the radar (live warnings still read on top) while
  the outline stays above it.

- **Data smoothing** (optional, off by default): a **Smoothing** slider with four
  stops — **None · Low · Medium · High** — that controls an in-shader Gaussian
  low-pass on the per-pixel lookup in the radar, satellite and model/MRMS shaders.
  At *None* every source keeps its crisp, native-resolution pixels (nearest-
  neighbour, no auto smoothing); *Low → High* widen the Gaussian's σ so neighbouring
  gates/cells blend into an increasingly soft, high-res wash that dissolves even the
  coarse ~3 km model / ~2 km GOES ABI blocks. It never rasterises, so it stays
  resolution-independent at any zoom, and the chosen level is remembered.
- **Split-cut aware product selection**: modern VCPs split the Doppler moments
  (VEL/SW) and dual-pol moments (ρHV/ZDR/φDP) into separate sweeps at nearly the
  same elevation. For the chosen product the viewer renders whichever sweep
  actually carries that moment closest to the selected tilt — so every product,
  including the dual-pol ones, displays correctly.
- Heavy decode runs in a **Web Worker** (`js/decoder.worker.js`) so the UI never
  freezes, even on 7 MB+ volumes.
- **Full radar network** (`js/s3.js`): the complete WSR-88D network plus the FAA's
  **TDWR** terminal radars (the `T###` sites guarding major airports). TDWR shares
  the same realtime feed and Archive-II message format — AWS keys just end `_V08`
  instead of `_V06`, handled transparently — so its tighter ~90 nmi, finer-beam
  view of the near-airport environment loads through the identical path. TDWR
  towers are drawn as **yellow** dots (NEXRAD is blue), and since they scan only to
  Doppler, the dual-pol products (ρHV/ZDR/φDP) are hidden when a TDWR site is
  active. Right-click / long-press snaps to the nearest **WSR-88D** only; pick a
  TDWR explicitly from the dropdown or by clicking its dot.

## Beyond radar: Satellite and MRMS

The same browser-native, decode-it-yourself approach now drives two more data
sources, selectable from the **RADAR / SAT / MRMS** switch in the Source panel.

### Satellite — GOES-R ABI and Himawari AHI (`noaa-goes18/19`, `noaa-himawari9`)

- **GOES ABI Level-2** multi-band cloud/moisture imagery, read straight from the
  open GOES buckets. A single `MCMIP` file carries all 16 ABI channels, so every
  channel *and* every RGB composite comes from one download.
- **Himawari-9 AHI** full-disk imagery from NOAA's `noaa-himawari9` bucket. These
  are the raw **Himawari Standard Data (HSD)** L1b files — a custom binary format,
  bzip2-compressed, with each band split into 10 vertical segments. We decompress
  them (`js/bzip2.js`), parse the HSD header, calibrate counts to physical units
  (albedo for the visible bands, brightness temperature via the inverse Planck law
  for the IR bands), and resample every band onto the common 2 km fixed grid so
  RGB recipes line up. The visible AHI bands are renumbered to the matching GOES
  ABI channels (AHI has no 1.37 µm cirrus band).
- **Off-thread decode** (`js/satellite.worker.js`, driven by `js/satClient.js`):
  the whole GOES/Himawari fetch + decompress + resample runs in a Web Worker and
  transfers the finished channel buffers back, so loading a frame never freezes
  the page — the pure-JS bzip2 of a Himawari full disk's ten segments would
  otherwise stall the UI for seconds. The worker keeps the few most-recent scenes
  (with their decode source) so a product switch adds a band without re-downloading,
  and a Himawari scene reconstructs its metadata straight from the frame key.
- **A from-scratch HDF5 / NetCDF-4 reader** (`js/hdf5.js`): superblock v2/v3,
  object-header v2 with continuation blocks, dense link/attribute storage via
  **fractal heaps**, chunked data indexed by a v1 B-tree, and the **shuffle +
  deflate** filter pipeline (deflate via the platform `DecompressionStream`). No
  HDF5 library — just the bytes.
- **Sectors**: GOES full-disk, CONUS, and both mesoscale floaters, plus a set of
  familiar **regional CONUS framings** (Southern Plains, Midwest, Northeast …).
  Himawari offers the Full Disk plus the higher-resolution **Japan** and
  **Target** sectors — 1 km regional crops scanned every ~2.5 min (four rapid-scan
  frames per 10-minute slot), resampled to a 1 km grid derived from the file
  headers (the Target sector is steerable and moves).
- **All 16 ABI channels** (visible/near-IR as reflectance, IR as brightness
  temperature). A colour enhancement (on by default, toggleable) gives the
  infrared window channels the classic rainbow cloud-top scale and the
  water-vapour channels a dedicated WV enhancement. Plus **RGB composites**:
  GeoColor (daytime true colour crossfaded with a night-time IR cloud rendering
  across the solar terminator, shaded per pixel from the scene's scan time), True
  Color (with synthetic green), Natural Color, Day Cloud Phase, Air Mass and Night
  Microphysics.
- **GPU geostationary projection** (`js/satelliteLayer.js`): a fragment shader
  inverts web-mercator to lon/lat and runs the geostationary fixed-grid navigation
  *backwards* per pixel, so the imagery stays crisp at any zoom.

### MRMS (`noaa-mrms-pds`)

- **GRIB2 decoded in pure JS** (`js/grib2.js`): gunzip via `DecompressionStream`,
  GRIB2 section parsing, and an in-house PNG reader for the PNG-packed values
  (DRT 5.41) so the full precision survives (a `<canvas>` would clamp it) —
  grayscale 8/16-bit *and* the RGB-packed 24-bit fields (e.g. lightning
  probability). Super-res products (AzShear, rotation tracks) on the 0.005° grid
  are coloured in their native 10⁻³ s⁻¹ units.
- **Products**: Composite / low-level / lowest-altitude reflectivity and
  reflectivity at the 0 °C and −20 °C isotherms; enhanced & 18/50 dBZ echo tops;
  vertically integrated liquid, VIL density and vertically integrated ice; AzShear
  (0-2 km instant rotation and 3-6 km mid-level), 1/6/24-hr rotation tracks; MESH
  (instant and 24-hr max hail size), POSH (severe-hail probability), Severe Hail
  Index; 30/60-min CG-lightning probability; precip rate and 1/3/6/12/24/48/72-hr
  and storm-total (since 12Z) precip accumulations.
- **GPU plate-carrée layer** (`js/gridLayer.js`) draws the 7000×3500 CONUS grid
  (max-pooled to a GPU-friendly texture) with per-product colour tables.

### Weather models — HRRR, NAM, NAM Nest, RAP, GFS, AI GFS, HRRRCast

- **Seven models** read straight from their NODD GRIB2 buckets on S3 and picked
  from the **Model** dropdown:
  - **HRRR** (3 km CONUS, `noaa-hrrr-bdp-pds`) — hourly cycles.
  - **NAM** (12 km CONUS, `noaa-nam-pds`) — 00/06/12/18z, hourly to F36 then
    3-hourly to F84.
  - **NAM Nest** (3 km CONUS, `noaa-nam-pds`) — 00/06/12/18z, hourly to F60.
  - **RAP** (13 km CONUS, `noaa-rap-pds`) — hourly cycles, extended to F51 at
    03/09/15/21z. JPEG2000-packed (see below).
  - **GFS** (0.25° global, `noaa-gfs-bdp-pds`) — 00/06/12/18z, hourly to F120
    then 3-hourly to F384; a true lat/lon grid, recentered to −180…180 for the
    CONUS-focused map.
  - **AI GFS / GraphCast** (0.25° global, `noaa-nws-graphcastgfs-pds`) —
    00/06/12/18z, 6-hourly to F384. NOAA's GraphCast run posts pressure-level
    mass/wind fields only, so it offers just the upper-air winds and
    temperatures (and no point sounding).
  - **HRRRCast** (3 km CONUS, AI, `noaa-gsl-experimental-pds`) — GSL's
    experimental ML model on the HRRR grid; hourly cycles to F48. Carries the
    surface staples, upper-air winds/temps and a surface-based severe subset
    (no point sounding).
- **Per-model product menus**: each model advertises only the fields its GRIB2
  output actually carries (`MODEL_PRODUCT_SUPPORT` in `js/models.js`), so the
  picker hides products a model can't supply — e.g. NAM drops the 90/255 mb-layer
  CAPE parcels and the composites built on them, RAP keeps only 500 mb vorticity,
  GFS has no sub-storm-scale shear, and the NAM Nest's reset-every-3-hours precip
  buckets leave it without the run-total QPF fields.
- **Field categories**, read straight from the operational GRIB2 and grouped in
  the product picker:
  - *Surface & Precip* — composite reflectivity, 2 m temperature and dew point,
    apparent temperature, 10 m wind speed and gusts, relative humidity, total
    cloud cover, and 1/6/24-hr and run-total precipitation. Reflectivity,
    temperature, apparent temperature, dew point, wind speed and gusts include
    mean-sea-level pressure contours when the selected model provides them; wind
    speed and gusts also add labelled wind-speed contours.
  - *Upper Air* — 200/300/500/700/850/925 mb isotachs, plus 500/700/850 mb
    absolute vorticity and 500/700/850/925 mb temperature, each drawn with wind
    barbs and geopotential-height contours overlaid (see below). These pull from
    the `wrfprs` pressure-level file.
  - *Severe* — SB/ML/MU/0-3 km CAPE, SB/ML CIN, 700-500 mb lapse rate, SB LCL,
    0-1/0-3 km storm-relative helicity, 0-1/0-6 km bulk shear, storm motion,
    significant-tornado / supercell / 0-1 & 0-3 km energy-helicity composites,
    and lightning flash density.
  - *Winter* — 6/12/24-hr and total snowfall at a fixed 10:1 ratio and at the
    temperature-dependent Kuchera ratio (from accumulated snow water equivalent
    and the column's warmest low/mid-level temperature), plus total frozen-precip
    ("ice") and total freezing-rain accretion. HRRR and RAP carry the full set;
    NAM has the snow products only (no frozen-precip / freezing-rain fields).
  - Rather than pull the ~150–400 MB cycle file, the viewer reads the tiny
    sidecar `.idx` byte index, finds the requested record(s), and issues a single
    HTTP **Range** request for just that message (a few hundred KB).
- **Derived fields** (`js/models.js`): one product can combine several GRIB
  messages after decoding — wind speed/shear/storm-motion from U/V magnitudes,
  6/24-hr precip from run-total differences, 700-500 mb lapse rate from layer
  temperatures and thicknesses, LCL height AGL, the STP/SCP/EHI composites
  from CAPE, helicity, shear, LCL and CIN (standard SPC fixed-layer formulas),
  and 10:1 / Kuchera snowfall from accumulated snow water equivalent times a fixed
  or temperature-dependent snow-to-liquid ratio.
- **Model overlays** (`js/modelOverlays.js`): upper-air charts add a Mapbox
  symbol layer of canvas-rendered wind barbs (rotated to the wind, kept at a
  constant screen size and decluttered as you zoom) and geopotential-height
  contours generated by marching squares — stitched into polylines with
  decameter labels along the lines. Selected surface charts add mean-sea-level
  pressure contours labelled in hPa, pressure-center markers (red H / blue L),
  and wind-speed contours for the wind and gust products.
- **GRIB2 complex packing** decoded in pure JS (`js/grib2.js`): NCEP's complex
  packing with 2nd-order **spatial differencing** (Data Representation Template
  5.3) — group references/widths/lengths and the integrated spatial differences
  — which is how HRRR, NAM and GFS store their fields. Sign-magnitude integers
  throughout, as the GRIB2 standard requires.
- **JPEG2000 decode** (`js/jpx.js`): RAP packs its GRIB2 with JPEG2000 (Data
  Representation Template 5.40), so a standalone J2K codestream decoder (MQ
  arithmetic coder, EBCOT, 5/3 & 9/7 inverse wavelets — adapted from Mozilla
  PDF.js, Apache-2.0) reconstructs the raw integer samples before the same
  reference/scale formula is applied.
- **Level-string normalization** (`js/models.js`): models label the same physical
  level differently — NAM tags reflectivity "(considered as a single layer)",
  layer spans appear as both "0-6000 m" and "6000-0 m", and NAM/RAP store
  lightning at `surface` — so the `.idx` matcher normalizes the suffix and sorts
  span endpoints, with a small per-model override map for the rest.
- **Native grid → lat/lon** (`js/models.js`): the CONUS models ride Lambert
  Conformal Conic grids (3–13 km), so each field is resampled onto a plain
  lat/lon grid via a forward LCC projection; GFS is already lat/lon and just gets
  recentered. Either way it's drawn through the **same GPU grid layer**
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
- **Point soundings** (`js/sounding.js`): in models mode, **right-click** (desktop)
  or **long-press** (mobile) anywhere on the map to open a full-screen, mobile-first
  briefing for the column under that point:
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

  The profile source depends on the selected model:
  - **HRRR / GFS** come from the CORS-enabled **Open-Meteo point API**
    (`gfs_hrrr` / `gfs_global`) — one small JSON request per column.
  - **NAM / NAM Nest / RAP**, which Open-Meteo doesn't serve a browser-reachable
    column for, are built straight from the model's **own GRIB2** (`loadModelColumn`
    in `js/models.js`): each pressure-level field (T, RH, height, U/V) is pulled
    with an `.idx`-guided byte-range request and **point-sampled** at the map
    centre — projecting the tap into the model's native Lambert grid rather than
    resampling the whole field — so the sounding reflects the actual model. (A full
    grid column avoids downloading the ~130 MB file: the fields are fetched
    concurrently and a progress percentage is shown while they load.)

  Either way the column is pinned to the displayed run's valid hour, and every
  diagram and derived parameter is then computed locally (parcel theory, Bunkers
  motion, helicity and the SPC composites), in the same spirit as the rest of the app.

## Source switching, overlay and playback

- The **RADAR / SAT / MRMS / MODELS** switch picks the active source. The
  single-site radar is hidden in the satellite, MRMS and model modes unless the
  **Radar overlay** toggle is switched on — then the live radar is drawn on top
  of the other source.
- **Playback** works for every source: it loops recent radar volumes, MRMS
  frames or satellite scenes, and steps through a model run's **forecast hours** —
  for models the scrubber spans the **entire selected run** (every forecast hour
  out to its max lead time), not just a fixed window. Each frame is loaded into a
  compact GPU-ready payload and cached, so a loop scrubs instantly without holding
  the (often >100 MB) raw decoded fields.
- **Progressive loading**: the scrubber appears immediately and frames stream in
  with bounded concurrency rather than blocking on the whole loop. The track shows
  a **green progress bar** — each frame's slice turns green as it finishes loading
  (grey = still loading) — and you can play or scrub across the already-loaded
  frames while the rest arrive. For radar/MRMS/satellite the loop length is the
  **Playback frames** slider (default 5); models always cover the full run.

## Map tools

A compact toolbar on the top-right of the map adds analysis and annotation tools
that draw straight onto the scope:

- **METAR station plots** (`js/metars.js`) — live surface observations from the
  public `aviationweather.gov` data API, drawn as classic WMO station models:
  a sky-cover circle with temperature (°F, upper-left), dewpoint (°F, lower-left),
  the coded sea-level-pressure group (upper-right) and a wind barb. Plots are
  fetched for the current view (debounced on pan/zoom) and refreshed on a slow
  timer; toggled off by default.
- **Draw** — freehand annotation paths (drag to sketch).
- **Measure** — click vertices to read great-circle distance and, once a shape
  closes, its area (miles and kilometres).
- **Storm track** (`js/maptools.js`) — mark a storm's position and heading,
  project its path forward at an adjustable speed/time, and label the **towns in
  its path with ETAs** (town names from the `api.weather.gov` point endpoint).
- **Split screen** (`js/splitview.js`) — a second, camera-synced pane showing a
  **different product** over the exact same view: side-by-side on desktop,
  stacked (chosen product on top) on mobile. For radar, any moment from the
  loaded volume renders for free; satellite shows any channel/RGB; MRMS/models
  fetch the chosen product on demand. Annotations drawn with the tools above are
  mirrored into the second pane.
- **Export / share** (`js/export.js`) — snapshot the live scope to a PNG. The
  basemap, radar/satellite WebGL layers and any drawings all render into the
  map's single canvas (created with `preserveDrawingBuffer`), so the capture is
  composited onto a captioned banner — site/product/scan-time header plus the
  color legend reconstructed from the live DOM — entirely client-side, no
  libraries. A preview modal then offers native **Share** (Web Share API, for
  AirDrop / messaging / social on supported devices), **Copy** to the clipboard,
  and **Download**. Split view exports both panes side by side.

The first time an alert is clicked it now opens a compact **preview card that
floats over the map** rather than taking over the screen, so the map stays fully
interactive; its "view full briefing" button still opens the full NWS-style panel.
Clicking a **radar dot that sits inside an alert polygon** selects that radar
without also popping the alert briefing — the dot wins the tap.

## Mobile control surface

On phones the controls collapse into a bottom dock that expands into a
**swipeable settings sheet**. The sheet is a horizontal carousel you swipe left
and right between (or jump with the tabs at the top):

1. **Controls** — the current product's picker and display controls (always the
   first page shown).
2. **Settings** — the source selection bar (single-site radar / SAT / MRMS /
   models) plus that source's selectors, scan list and active alerts.
3. **Map** — basemap style, range rings, the map-layer and alert-appearance
   customisers, and the *Remember view & settings* toggle.

**Everything is remembered between visits** (`localStorage`): the last source and
product, the map position (center + zoom), the basemap, the map-layer and
alert-appearance customisations, and every display toggle
— so a reload reopens exactly where you left off and reloads the last product's
live data. If the requested **UTC day has no scans yet** (e.g. just after 00z),
the viewer falls back a day at a time until it finds data, and LIVE snaps forward
to the current day as soon as its first scan lands.

## Architecture

```
index.html ─ css/style.css        UI shell + console styling
js/app.js                         controller: UI, state, interaction
 ├─ js/s3.js                      list/download volumes (IEM live → AWS S3 fallback)
 ├─ js/products.js                color scales + LUTs per product
 ├─ js/radarLayer.js              custom WebGL layer: polar gates → GPU, per pixel
 ├─ js/renderer.js                sweep range + point-sample helpers
 ├─ js/metars.js                  METAR station-plot markers (aviationweather.gov)
 ├─ js/maptools.js                draw / measure / storm-track tools
 ├─ js/splitview.js               second synced pane: compare products
 ├─ Mapbox GL JS (CDN)            vector basemap; radar/alerts inserted below labels
 └─ js/decoder.worker.js          off-thread decode
     └─ js/level2.js              Archive II / Message 31 parser
         └─ js/bzip2.js           pure-JS bzip2 decompressor
```

## Running it

Serve the folder over HTTP (ES modules and module workers require `http(s)://`,
not `file://`). Any static file server works:

```bash
python3 -m http.server 8000
# then open http://localhost:8000/
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
