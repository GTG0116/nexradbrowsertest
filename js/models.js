// models.js — list and load NWP model output from the open NODD AWS buckets,
// decoded with grib2.js. It exposes a range of HRRR surface fields —
// reflectivity, temperature, wind, humidity, cloud cover and precipitation.
//
// HRRR posts a full GRIB2 file per cycle plus a sidecar `.idx` index that lists
// every field and its byte offset. We read the tiny index, find the composite
// reflectivity record, and issue a single HTTP Range request for just that
// message — so loading one field costs a few hundred KB, not the ~150 MB file.
//
// HRRR is on a Lambert Conformal grid, so after decoding we resample it onto a
// plain lat/lon grid (resampleLambert) — that lets it ride the exact same GPU
// grid layer and inspect path as the lat/lon MRMS products.

import { decodeGrib2 } from './grib2.js';
import { makeScale } from './products.js';

// Available models (only HRRR for now). `bucket` is CORS-enabled for listing,
// GET and Range requests, like the other NODD buckets used here.
export const MODELS = {
  hrrr: {
    id: 'hrrr',
    label: 'HRRR (3 km CONUS)',
    bucket: 'https://noaa-hrrr-bdp-pds.s3.amazonaws.com',
    // Build the grib + index keys for a UTC day, cycle hour and forecast hour.
    keysFor(dayStr, cycle, fhour) {
      const grib = `hrrr.${dayStr}/conus/hrrr.t${pad(cycle)}z.wrfsfcf${pad(fhour)}.grib2`;
      return { grib, idx: grib + '.idx' };
    },
    // Synoptic cycles (00/06/12/18z) run out to F48; the rest to F18.
    maxForecastHour(cycle) {
      return cycle % 6 === 0 ? 48 : 18;
    },
  },
};

export const MODEL_ORDER = [
  'REFC', 'TMP', 'WIND', 'GUST', 'RH', 'DPT', 'TCDC',
  'QPF1', 'QPF6', 'QPF24', 'QPF',
];

// Display conversions applied only to legend ticks / cursor readouts — the
// physical values and color scales stay native (see products.js `disp`).
const MS_TO_MPH = 2.2369363; // m/s → mph
const K_TO_F = { factor: 1.8, offset: -459.67 }; // kelvin → °F
const MM_TO_IN = 1 / 25.4; // kg/m² (mm) → inches

// Build a smooth color scale from [value, [r,g,b]] stops.
const rampScale = (stops) =>
  makeScale(stops.map(([v, c]) => ({ v, c1: [c[0], c[1], c[2], 255], c2: null })));

// 2 m temperature (K). Purple/blue (cold) → green/yellow → red (hot); stops are
// placed at round °F values converted to kelvin.
const TMP_SCALE = rampScale([
  [233.15, [145, 0, 160]], [244.26, [110, 40, 200]], [255.37, [60, 60, 220]],
  [266.48, [40, 130, 230]], [273.15, [70, 200, 230]], [277.59, [60, 200, 150]],
  [283.15, [70, 200, 80]], [288.71, [150, 210, 60]], [294.26, [230, 220, 60]],
  [299.82, [240, 170, 50]], [305.37, [235, 110, 40]], [310.93, [220, 50, 40]],
  [316.48, [150, 25, 35]],
]);

// 2 m dew point (K). Brown/tan (dry) → green → teal/blue (humid).
const DPT_SCALE = rampScale([
  [249.82, [120, 90, 60]], [260.93, [150, 130, 90]], [266.48, [175, 160, 110]],
  [272.04, [205, 200, 150]], [277.59, [150, 200, 150]], [283.15, [90, 185, 110]],
  [285.93, [60, 165, 95]], [288.71, [40, 145, 95]], [291.48, [30, 130, 115]],
  [294.26, [30, 120, 135]], [297.04, [40, 110, 155]], [299.82, [60, 100, 175]],
]);

// 10 m wind speed (m/s). Stops placed at round mph values converted to m/s.
const WIND_SCALE = rampScale([
  [2.24, [180, 200, 230]], [4.47, [120, 190, 230]], [8.94, [80, 200, 160]],
  [13.41, [120, 210, 80]], [17.88, [220, 220, 70]], [22.35, [240, 160, 50]],
  [26.82, [230, 90, 50]], [31.29, [200, 40, 60]], [35.76, [150, 30, 110]],
]);

// Wind gust (m/s) — same ramp as wind, extended to higher speeds.
const GUST_SCALE = rampScale([
  [4.47, [180, 200, 230]], [8.94, [120, 190, 230]], [13.41, [80, 200, 160]],
  [17.88, [120, 210, 80]], [22.35, [220, 220, 70]], [26.82, [240, 160, 50]],
  [31.29, [230, 90, 50]], [35.76, [200, 40, 60]], [40.23, [160, 30, 110]],
  [44.70, [110, 20, 130]],
]);

// Relative humidity (%). Brown (dry) → green → blue (saturated).
const RH_SCALE = rampScale([
  [0, [120, 70, 20]], [20, [170, 130, 60]], [40, [220, 200, 130]],
  [50, [230, 230, 200]], [60, [170, 210, 150]], [70, [90, 190, 130]],
  [80, [40, 160, 140]], [90, [30, 120, 160]], [100, [20, 70, 150]],
]);

// Total cloud cover (%) — dark→light grey.
const CLOUD_SCALE = rampScale([
  [0, [40, 60, 90]], [25, [90, 110, 130]], [50, [150, 160, 170]],
  [75, [200, 205, 210]], [100, [242, 246, 250]],
]);

// Precipitation accumulation, as fractions of the product's full-scale value
// (kg/m² ≈ mm). One palette reused at several depth ranges.
const PRECIP_STOPS = [
  [0.00, [200, 240, 200]], [0.05, [110, 200, 110]], [0.10, [70, 170, 70]],
  [0.20, [60, 150, 220]], [0.35, [40, 80, 200]], [0.50, [220, 220, 80]],
  [0.65, [230, 160, 50]], [0.80, [220, 80, 40]], [0.90, [170, 30, 40]],
  [1.00, [150, 40, 130]],
];
const precipScale = (hiMM) => rampScale(PRECIP_STOPS.map(([f, c]) => [f * hiMM, c]));

// Helper for a standard (non-reflectivity) model product: the color scale's
// range *is* the product range, so GPU encoding and colors line up.
function gridProduct(id, name, scale, floor, unit, disp) {
  return {
    id, name, unit,
    lo: scale.lo, hi: scale.hi, floor,
    scale,
    dispUnit: (disp && disp.unit) || unit,
    dispFactor: (disp && disp.factor) || 1,
    dispOffset: (disp && disp.offset) || 0,
  };
}

// A model product names the GRIB field(s) to pull. The simplest form sets
// `varName`/`level`, matched against the `.idx`. Products may instead define
// `sources(fhour)` returning one or more index matchers plus a `combine` rule
// ('mag' = magnitude of two fields, 'diff' = first minus second) — used for
// wind speed (from U/V) and multi-hour precip (from run-total differences).
// `acc` further constrains a match by the accumulation/forecast field, needed
// where one varName/level appears at several accumulation periods (e.g. APCP).
// `reflectivity:true` borrows the shared reflectivity color table. `floor` is
// the lowest value drawn; everything below is left transparent. `minFhour`
// products draw nothing before that forecast hour (e.g. 1 hr precip at F00).
const TMP_PROD = gridProduct('TMP', 'Temperature', TMP_SCALE, TMP_SCALE.lo, 'K', { unit: '°F', ...K_TO_F });
const DPT_PROD = gridProduct('DPT', 'Dew Point', DPT_SCALE, DPT_SCALE.lo, 'K', { unit: '°F', ...K_TO_F });
const RH_PROD = gridProduct('RH', 'Relative Humidity', RH_SCALE, 0, '%');
const WIND_PROD = gridProduct('WIND', 'Wind Speed', WIND_SCALE, 0.5, 'm/s', { unit: 'mph', factor: MS_TO_MPH });
const GUST_PROD = gridProduct('GUST', 'Wind Gusts', GUST_SCALE, 0.5, 'm/s', { unit: 'mph', factor: MS_TO_MPH });
const CLOUD_PROD = gridProduct('TCDC', 'Total Cloud Cover', CLOUD_SCALE, 1, '%');

// APCP appears twice per file: the run total ("0-…") and the latest 1 hr bucket
// ("(f-1)-f hour acc fcst"). Multi-hour totals are the difference of two run
// totals (now minus `hours` earlier); at short lead times that earlier total is
// before the run start, so we just use the run total so far.
const apcpTotal = { varName: 'APCP', level: 'surface', acc: /^0-/ };
function precipWindow(hours) {
  return (fhour) => fhour > hours
    ? [apcpTotal, { ...apcpTotal, fhourDelta: -hours }]
    : [apcpTotal];
}

export const MODEL_PRODUCTS = {
  REFC: {
    id: 'REFC',
    name: 'Composite Reflectivity',
    unit: 'dBZ',
    lo: -10, hi: 75, floor: 5,
    varName: 'REFC', level: 'entire atmosphere',
    reflectivity: true,
    dispUnit: 'dBZ', dispFactor: 1, dispOffset: 0,
  },
  TMP: { ...TMP_PROD, varName: 'TMP', level: '2 m above ground' },
  WIND: {
    ...WIND_PROD, combine: 'mag',
    sources: () => [
      { varName: 'UGRD', level: '10 m above ground' },
      { varName: 'VGRD', level: '10 m above ground' },
    ],
  },
  GUST: { ...GUST_PROD, varName: 'GUST', level: 'surface' },
  RH: { ...RH_PROD, varName: 'RH', level: '2 m above ground' },
  DPT: { ...DPT_PROD, varName: 'DPT', level: '2 m above ground' },
  TCDC: { ...CLOUD_PROD, varName: 'TCDC', level: 'entire atmosphere' },
  QPF1: {
    ...gridProduct('QPF1', '1 hr Precip', precipScale(50), 0.1, 'mm', { unit: 'in', factor: MM_TO_IN }),
    minFhour: 1,
    sources: (fhour) => [{ varName: 'APCP', level: 'surface', acc: new RegExp(`^${fhour - 1}-${fhour} hour acc`) }],
  },
  QPF6: {
    ...gridProduct('QPF6', '6 hr Precip', precipScale(75), 0.1, 'mm', { unit: 'in', factor: MM_TO_IN }),
    combine: 'diff', sources: precipWindow(6),
  },
  QPF24: {
    ...gridProduct('QPF24', '24 hr Precip', precipScale(150), 0.1, 'mm', { unit: 'in', factor: MM_TO_IN }),
    combine: 'diff', sources: precipWindow(24),
  },
  QPF: {
    ...gridProduct('QPF', 'Total Precip', precipScale(150), 0.1, 'mm', { unit: 'in', factor: MM_TO_IN }),
    sources: () => [apcpTotal],
  },
};

const pad = (n, w = 2) => String(n).padStart(w, '0');
const dayStrOf = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;

// List the available model runs (cycles) for a UTC day, newest last. HRRR runs
// every hour. For the current day we stop at the most recent cycle that should
// already be posted (HRRR f00 lands ~50 min after the top of the hour).
export async function listModels(modelKey, productId, date) {
  const model = MODELS[modelKey];
  if (!model) throw new Error('unknown model');
  const dayStr = dayStrOf(date);
  const now = new Date();
  const isToday = dayStrOf(now) === dayStr;
  let maxH = 23;
  if (isToday) {
    maxH = now.getUTCMinutes() >= 55 ? now.getUTCHours() : now.getUTCHours() - 1;
  }
  const runs = [];
  for (let h = 0; h <= maxH; h++) {
    runs.push({
      key: `${dayStr}t${pad(h)}`,
      dayStr,
      cycle: h,
      label: `${pad(h)}z`,
      time: new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), h)),
      maxFhour: model.maxForecastHour ? model.maxForecastHour(h) : 0,
    });
  }
  return runs;
}

// The forecast hours available for a run, as integers [0 … maxFhour].
export function forecastHours(run) {
  const out = [];
  for (let f = 0; f <= (run.maxFhour || 0); f++) out.push(f);
  return out;
}

// Parse a GRIB `.idx` file and return the [start, end] byte range of the message
// matching a source descriptor (`varName`/`level`, and optional `acc` matched
// against the accumulation/forecast field). `end` is null for the file's last
// record (an open-ended Range covers it).
function rangeFromIdx(text, src) {
  const lines = text.split('\n').filter((l) => l.trim());
  for (let i = 0; i < lines.length; i++) {
    const f = lines[i].split(':');
    if (f[3] !== src.varName || f[4] !== src.level) continue;
    if (src.acc != null) {
      const fc = f[5] || '';
      if (src.acc instanceof RegExp ? !src.acc.test(fc) : fc !== src.acc) continue;
    }
    const start = parseInt(f[1], 10);
    const next = lines[i + 1] ? parseInt(lines[i + 1].split(':')[1], 10) : null;
    return { start, end: next == null ? null : next - 1 };
  }
  throw new Error(`field ${src.varName}/${src.level} not in index`);
}

// The index source(s) a product pulls for a given forecast hour.
function sourcesFor(product, fhour) {
  return typeof product.sources === 'function'
    ? product.sources(fhour)
    : [{ varName: product.varName, level: product.level }];
}

// Combine the values of multiple resampled grids into one. 'mag' = vector
// magnitude (e.g. wind from U/V); 'diff' = first minus second, floored at zero
// (e.g. multi-hour precip from run-total accumulations). A single grid (or no
// rule) passes through unchanged.
function combineGrids(grids, mode) {
  if (grids.length === 1 || !mode) return grids[0];
  const a = grids[0].values, b = grids[1].values;
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) {
    if (mode === 'mag') out[i] = Math.hypot(a[i], b[i]);
    else { const d = a[i] - b[i]; out[i] = Number.isNaN(a[i]) ? NaN : d > 0 ? d : 0; }
  }
  return { ...grids[0], values: out };
}

// A tiny all-missing grid, so accumulation products draw nothing (rather than
// erroring) before their accumulation window exists — e.g. 1 hr precip at F00.
function emptyGrid() {
  return {
    proj: 'latlon', ni: 2, nj: 2, lon1: -130, lat1: 50,
    di: 0.1, dj: 0.1, scanMode: 0, values: new Float32Array([NaN, NaN, NaN, NaN]),
  };
}

async function fetchRange(url, range, onProgress) {
  const headers = { Range: `bytes=${range.start}-${range.end == null ? '' : range.end}` };
  const res = await fetch(url, { headers });
  if (!res.ok && res.status !== 206) throw new Error(`download failed: ${res.status}`);
  const total = range.end == null ? 0 : range.end - range.start + 1;
  if (!res.body || !total) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (onProgress) onProgress(received / total);
  }
  const out = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

// Resample a Lambert Conformal Conic grid (e.g. HRRR) onto a regular lat/lon
// grid so it can reuse the lat/lon GPU layer. We forward-project each target
// lon/lat into the source grid and nearest-sample. Projection factors split
// cleanly — radius ρ depends only on latitude, the rotation θ only on longitude
// — so the per-cell cost is a couple of multiplies after a small precompute.
export function resampleLambert(grid, step = 0.025) {
  const D2R = Math.PI / 180, R2D = 180 / Math.PI;
  // Spherical earth (shape code 6 → radius 6371229 m) covers the HRRR case.
  const Re = 6371229;
  const phi1 = grid.latin1 * D2R, phi2 = grid.latin2 * D2R;
  const lam0 = grid.lov * D2R, phi0 = grid.lad * D2R;
  const n = Math.abs(phi1 - phi2) < 1e-9
    ? Math.sin(phi1)
    : Math.log(Math.cos(phi1) / Math.cos(phi2)) /
      Math.log(Math.tan(Math.PI / 4 + phi2 / 2) / Math.tan(Math.PI / 4 + phi1 / 2));
  const F = Math.cos(phi1) * Math.pow(Math.tan(Math.PI / 4 + phi1 / 2), n) / n;
  const rho0 = Re * F / Math.pow(Math.tan(Math.PI / 4 + phi0 / 2), n);
  const rhoOf = (latDeg) => Re * F / Math.pow(Math.tan(Math.PI / 4 + latDeg * D2R / 2), n);
  const fwd = (lonDeg, latDeg) => {
    const th = n * (lonDeg * D2R - lam0);
    const r = rhoOf(latDeg);
    return [r * Math.sin(th), rho0 - r * Math.cos(th)];
  };
  const inv = (x, y) => {
    const rv = Math.sign(n) * Math.sqrt(x * x + (rho0 - y) * (rho0 - y));
    const th = Math.atan2(x, rho0 - y);
    return [(lam0 + th / n) * R2D, (2 * Math.atan(Math.pow(Re * F / rv, 1 / n)) - Math.PI / 2) * R2D];
  };

  const { ni, nj, dx, dy, values } = grid;
  const [x0, y0] = fwd(grid.lo1, grid.la1); // grid origin (i=0,j=0), the SW corner

  // Geographic bounding box of the whole source grid (scan its border cells).
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  const see = (i, j) => {
    const [lo, la] = inv(x0 + i * dx, y0 + j * dy);
    if (lo < minLon) minLon = lo; if (lo > maxLon) maxLon = lo;
    if (la < minLat) minLat = la; if (la > maxLat) maxLat = la;
  };
  for (let i = 0; i < ni; i += 8) { see(i, 0); see(i, nj - 1); }
  for (let j = 0; j < nj; j += 8) { see(0, j); see(ni - 1, j); }

  const pad = 0.05;
  const lon1 = minLon - pad, lat1 = maxLat + pad; // lat1 is the northern edge
  const niT = Math.ceil((maxLon - minLon + 2 * pad) / step);
  const njT = Math.ceil((maxLat - minLat + 2 * pad) / step);

  // Precompute the per-column rotation and per-row radius, then nearest-sample.
  const sinT = new Float64Array(niT), cosT = new Float64Array(niT);
  for (let i = 0; i < niT; i++) {
    const th = n * ((lon1 + i * step) * D2R - lam0);
    sinT[i] = Math.sin(th); cosT[i] = Math.cos(th);
  }
  const out = new Float32Array(niT * njT);
  for (let j = 0; j < njT; j++) {
    const rj = rhoOf(lat1 - j * step);
    const rowBase = j * niT;
    for (let i = 0; i < niT; i++) {
      const x = rj * sinT[i], y = rho0 - rj * cosT[i];
      const si = Math.round((x - x0) / dx), sj = Math.round((y - y0) / dy);
      out[rowBase + i] = (si >= 0 && si < ni && sj >= 0 && sj < nj)
        ? values[sj * ni + si] : NaN;
    }
  }
  return { proj: 'latlon', ni: niT, nj: njT, lon1, lat1, di: step, dj: step, scanMode: 0, values: out };
}

// Download + decode one forecast hour of a model run into a lat/lon grid of
// physical values. `run` is an entry from listModels; `fhour` an integer.
export async function loadModel(modelKey, productId, run, fhour, onProgress) {
  const model = MODELS[modelKey];
  const product = MODEL_PRODUCTS[productId];
  if (!model || !product) throw new Error('unknown model/product');

  // Accumulation products with nothing to show yet draw an empty grid.
  let grid;
  if (product.minFhour && fhour < product.minFhour) {
    grid = emptyGrid();
  } else {
    const sources = sourcesFor(product, fhour);
    const grids = [];
    for (let s = 0; s < sources.length; s++) {
      const src = sources[s];
      const f = fhour + (src.fhourDelta || 0);
      const { grib, idx } = model.keysFor(run.dayStr, run.cycle, f);
      const idxText = await (await fetch(`${model.bucket}/${idx}`)).text();
      const range = rangeFromIdx(idxText, src);
      const bytes = await fetchRange(`${model.bucket}/${grib}`, range,
        onProgress && ((p) => onProgress((s + p) / sources.length)));
      const decoded = await decodeGrib2(bytes);
      grids.push(decoded.proj === 'lambert' ? resampleLambert(decoded) : decoded);
    }
    grid = combineGrids(grids, product.combine);
  }
  grid.product = product;
  grid.model = model;
  grid.fhour = fhour;
  grid.runTime = run.time;
  // Valid time = cycle time + forecast hour.
  grid.time = new Date(run.time.getTime() + fhour * 3600 * 1000);
  grid.key = model.keysFor(run.dayStr, run.cycle, fhour).grib;
  return grid;
}
