// mirs.js — JPSS passive-microwave imagery. The MIRS (Microwave Integrated
// Retrieval System) 33-minute granules on the NODD JPSS buckets carry the ATMS
// sounder's calibrated brightness temperatures plus the retrieved precipitation
// and surface products (rain rate, TPW, cloud/ice water, snowfall rate, snow
// water equivalent, sea ice, skin temperature) as NetCDF-4 — which our existing
// pure-JS HDF5 reader decodes directly in the browser.
//
// A granule is a swath (scanlines × 96 fields of view) with per-pixel lat/lon
// rather than a fixed projection, so instead of the geostationary satellite
// shader it rides the same lat/lon GPU grid layer as MRMS/models: each granule
// is rasterised onto a regular lat/lon grid (swathToGrid) with a small
// distance-weighted splat that closes the gaps between neighbouring footprints.

import { HDF5File } from './hdf5.js';
import { makeScale } from './products.js';

// Download one bucket object with progress. Kept local (rather than reusing the
// GOES helper) so this module stays a leaf — goes.js imports MIRS_SOURCES from
// here to list the microwave "satellites", and a two-way import would put the
// modules in a load-order-dependent cycle.
async function fetchGranule(bucket, key, onProgress, retries = 2) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${bucket}/${key}`);
      if (!res.ok) throw new Error(`granule fetch failed: ${res.status}`);
      const total = Number(res.headers.get('content-length')) || 0;
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
    } catch (err) {
      lastErr = err;
      if (attempt >= retries) break;
      await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
    }
  }
  throw lastErr;
}

// The three JPSS satellites publishing MIRS ATMS products, newest first. All
// three buckets are CORS-enabled.
export const MIRS_SOURCES = {
  'mirs-n21': { bucket: 'https://noaa-nesdis-n21-pds.s3.amazonaws.com', label: 'NOAA-21 Microwave (MIRS)', short: 'NOAA-21' },
  'mirs-n20': { bucket: 'https://noaa-nesdis-n20-pds.s3.amazonaws.com', label: 'NOAA-20 Microwave (MIRS)', short: 'NOAA-20' },
  'mirs-snpp': { bucket: 'https://noaa-nesdis-snpp-pds.s3.amazonaws.com', label: 'Suomi NPP Microwave (MIRS)', short: 'S-NPP' },
};

const PRODUCT_PREFIX = 'NPR_MIRS_IMG_33min';

const rampScale = (stops) =>
  makeScale(stops.map(([v, c]) => ({ v, c1: [c[0], c[1], c[2], 255], c2: null })));

// 89 GHz brightness temperature: ice scattering in strong convection depresses
// the BT far below the surrounding surface emission, so the ramp runs warm
// greys down into the cyan→blue→purple family for the deep cold end.
const BT_SCALE = rampScale([
  [140, [255, 255, 255]], [170, [200, 120, 220]], [190, [140, 40, 170]],
  [210, [60, 40, 200]], [230, [40, 120, 230]], [250, [70, 200, 220]],
  [265, [120, 200, 130]], [280, [200, 210, 120]], [295, [170, 140, 90]],
  [305, [120, 90, 60]],
]);

// 183 GHz (water vapour) brightness temperature.
const BT_WV_SCALE = rampScale([
  [180, [255, 255, 255]], [200, [200, 120, 220]], [215, [110, 40, 180]],
  [230, [40, 80, 220]], [245, [60, 180, 220]], [255, [90, 200, 140]],
  [265, [220, 220, 90]], [275, [235, 140, 50]], [285, [200, 50, 40]],
]);

// Rain rate (mm/h) — the familiar green→yellow→red precipitation family.
const RR_SCALE = rampScale([
  [0.1, [140, 210, 140]], [0.5, [70, 170, 70]], [1, [50, 140, 220]],
  [2, [40, 80, 200]], [4, [220, 220, 80]], [8, [240, 160, 50]],
  [12, [230, 80, 40]], [20, [180, 30, 40]], [30, [150, 40, 130]],
]);

// Total precipitable water (mm). Brown (dry) → green → blue → purple (moist).
const TPW_SCALE = rampScale([
  [2, [120, 85, 50]], [8, [170, 130, 75]], [16, [215, 195, 130]],
  [24, [150, 200, 140]], [32, [70, 180, 110]], [40, [40, 150, 160]],
  [48, [40, 110, 190]], [56, [70, 70, 200]], [66, [140, 50, 180]],
  [75, [200, 60, 160]],
]);

// Cloud liquid water (mm).
const CLW_SCALE = rampScale([
  [0.05, [170, 200, 230]], [0.15, [110, 170, 225]], [0.3, [60, 130, 215]],
  [0.5, [60, 190, 170]], [0.8, [120, 210, 90]], [1.2, [230, 220, 80]],
  [1.8, [240, 150, 50]], [2.5, [225, 70, 45]],
]);

// Graupel/ice water path (mm) — convective ice loading.
const IWP_SCALE = rampScale([
  [0.05, [180, 200, 225]], [0.15, [110, 180, 220]], [0.3, [70, 200, 180]],
  [0.6, [120, 210, 90]], [1.0, [230, 220, 80]], [1.6, [240, 150, 50]],
  [2.4, [230, 80, 45]], [3.5, [170, 30, 110]],
]);

// Snowfall rate (mm/h liquid equivalent).
const SFR_SCALE = rampScale([
  [0.05, [200, 225, 250]], [0.2, [140, 190, 240]], [0.5, [80, 140, 225]],
  [1.0, [50, 85, 205]], [1.5, [95, 60, 200]], [2.2, [150, 50, 190]],
  [3.0, [190, 40, 150]],
]);

// Snow water equivalent (cm).
const SWE_SCALE = rampScale([
  [0.2, [210, 230, 250]], [1, [150, 200, 245]], [3, [80, 150, 230]],
  [6, [40, 80, 205]], [10, [95, 60, 200]], [16, [150, 50, 190]],
  [24, [190, 40, 150]], [30, [240, 225, 240]],
]);

// Sea-ice concentration (%).
const SICE_SCALE = rampScale([
  [10, [60, 110, 170]], [30, [90, 150, 200]], [50, [140, 190, 225]],
  [70, [190, 220, 240]], [90, [230, 240, 250]], [100, [255, 255, 255]],
]);

// Skin temperature (K), same family as the model 2 m temperature ramp.
const TSKIN_SCALE = rampScale([
  [233.15, [145, 0, 160]], [244.26, [110, 40, 200]], [255.37, [60, 60, 220]],
  [266.48, [40, 130, 230]], [273.15, [70, 200, 230]], [277.59, [60, 200, 150]],
  [283.15, [70, 200, 80]], [288.71, [150, 210, 60]], [294.26, [230, 220, 60]],
  [299.82, [240, 170, 50]], [305.37, [235, 110, 40]], [310.93, [220, 50, 40]],
  [316.48, [150, 25, 35]],
]);

const K_TO_F = { unit: '°F', factor: 1.8, offset: -459.67 };
const MM_TO_IN = { unit: 'in', factor: 1 / 25.4 };
const CM_TO_IN = { unit: 'in', factor: 1 / 2.54 };

// MIRS products. `varName` is the NetCDF variable; `channel` picks a plane of
// the (scan, fov, 22) brightness-temperature stack. `floor` is the lowest drawn
// value (below it stays transparent); the temperature products use a token
// floor of 1 K so every real sample draws but missing cells stay empty.
export const MIRS_PRODUCTS = {
  BT89: {
    id: 'BT89', name: '88.2 GHz Brightness Temp', varName: 'BT', channel: 15,
    unit: 'K', lo: BT_SCALE.lo, hi: BT_SCALE.hi, floor: 1, scale: BT_SCALE,
    dispUnit: K_TO_F.unit, dispFactor: K_TO_F.factor, dispOffset: K_TO_F.offset,
  },
  BT183: {
    id: 'BT183', name: '183 GHz Brightness Temp', varName: 'BT', channel: 21,
    unit: 'K', lo: BT_WV_SCALE.lo, hi: BT_WV_SCALE.hi, floor: 1, scale: BT_WV_SCALE,
    dispUnit: K_TO_F.unit, dispFactor: K_TO_F.factor, dispOffset: K_TO_F.offset,
  },
  RR: {
    id: 'RR', name: 'Rain Rate', varName: 'RR',
    unit: 'mm/h', lo: RR_SCALE.lo, hi: RR_SCALE.hi, floor: 0.1, scale: RR_SCALE,
    dispUnit: 'in/h', dispFactor: MM_TO_IN.factor, dispOffset: 0,
  },
  TPW: {
    id: 'TPW', name: 'Total Precipitable Water', varName: 'TPW',
    unit: 'mm', lo: TPW_SCALE.lo, hi: TPW_SCALE.hi, floor: 0.5, scale: TPW_SCALE,
    dispUnit: MM_TO_IN.unit, dispFactor: MM_TO_IN.factor, dispOffset: 0,
  },
  CLW: {
    id: 'CLW', name: 'Cloud Liquid Water', varName: 'CLW',
    unit: 'mm', lo: CLW_SCALE.lo, hi: CLW_SCALE.hi, floor: 0.05, scale: CLW_SCALE,
    dispUnit: 'mm', dispFactor: 1, dispOffset: 0,
  },
  IWP: {
    id: 'IWP', name: 'Ice Water Path', varName: 'IWP',
    unit: 'mm', lo: IWP_SCALE.lo, hi: IWP_SCALE.hi, floor: 0.05, scale: IWP_SCALE,
    dispUnit: 'mm', dispFactor: 1, dispOffset: 0,
  },
  SFR: {
    id: 'SFR', name: 'Snowfall Rate', varName: 'SFR',
    unit: 'mm/h', lo: SFR_SCALE.lo, hi: SFR_SCALE.hi, floor: 0.05, scale: SFR_SCALE,
    dispUnit: 'in/h', dispFactor: MM_TO_IN.factor, dispOffset: 0,
  },
  SWE: {
    id: 'SWE', name: 'Snow Water Equivalent', varName: 'SWE',
    unit: 'cm', lo: SWE_SCALE.lo, hi: SWE_SCALE.hi, floor: 0.1, scale: SWE_SCALE,
    dispUnit: CM_TO_IN.unit, dispFactor: CM_TO_IN.factor, dispOffset: 0,
  },
  SICE: {
    id: 'SICE', name: 'Sea Ice Concentration', varName: 'SIce',
    unit: '%', lo: SICE_SCALE.lo, hi: SICE_SCALE.hi, floor: 5, scale: SICE_SCALE,
    dispUnit: '%', dispFactor: 1, dispOffset: 0,
  },
  TSKIN: {
    id: 'TSKIN', name: 'Skin Temperature', varName: 'TSkin',
    unit: 'K', lo: TSKIN_SCALE.lo, hi: TSKIN_SCALE.hi, floor: 1, scale: TSKIN_SCALE,
    dispUnit: K_TO_F.unit, dispFactor: K_TO_F.factor, dispOffset: K_TO_F.offset,
  },
};

export const MIRS_ORDER = ['BT89', 'BT183', 'RR', 'TPW', 'CLW', 'IWP', 'SFR', 'SWE', 'SICE', 'TSKIN'];

export function isMirsSat(satKey) {
  return !!MIRS_SOURCES[satKey];
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

// Parse the start timestamp out of a granule filename
// (…_s202607070301284_e202607070335360_c….nc → a Date).
function granuleTime(name) {
  const m = /_s(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(name);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
}

async function listDay(source, date) {
  const prefix = `${PRODUCT_PREFIX}/${date.getUTCFullYear()}/${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())}/`;
  const url = `${source.bucket}/?list-type=2&max-keys=1000&prefix=${encodeURIComponent(prefix)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`MIRS list failed: ${res.status}`);
  const xml = await res.text();
  const out = [];
  for (const m of xml.matchAll(/<Key>([^<]+\.nc)<\/Key>/g)) {
    const key = m[1];
    const time = granuleTime(key);
    if (!time) continue;
    out.push({ key, time, label: `${pad(time.getUTCHours())}:${pad(time.getUTCMinutes())}Z` });
  }
  return out;
}

// List a UTC day's granules (each a ~33-minute swath), oldest→newest — the same
// shape the GOES scene list uses. Early in a UTC day the list is padded with
// the previous day's newest granules so playback always has frames.
export async function listMirsScenes(satKey, date) {
  const source = MIRS_SOURCES[satKey];
  if (!source) throw new Error('unknown MIRS source');
  let scenes = await listDay(source, date);
  if (scenes.length < 8) {
    try {
      const prev = await listDay(source, new Date(date.getTime() - 86400000));
      scenes = prev.slice(-(8 - scenes.length)).concat(scenes);
    } catch (_) { /* previous day is padding only */ }
  }
  scenes.sort((a, b) => a.time - b.time);
  return scenes;
}

// Read one variable into physical units (scale factor applied, fills → NaN).
// `channel` selects one plane of a (scan, fov, nchan) stack.
async function readVar(h5, name, channel) {
  const v = await h5.readVariable(name);
  const attrs = h5.readAttributes(name);
  const scale = attrs.scale_factor != null ? Number(attrs.scale_factor) : 1;
  const fill = v.fill != null ? Number(v.fill) : -999;
  const nchan = channel != null ? (v.dims && v.dims[2]) || 22 : 1;
  const n = v.data.length / nchan;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const raw = channel != null ? v.data[i * nchan + channel] : v.data[i];
    out[i] = raw === fill || raw <= -999 ? NaN : raw * scale;
  }
  return out;
}

// Rasterise a swath onto a regular lat/lon grid. The ATMS footprint spacing is
// very non-uniform across the scan — ~16 km at nadir but ~67 km at the swath
// edges (where the slant view spreads the fields of view apart) — so a fixed
// splat radius either blurs the nadir or leaves wide empty stripes at the edges
// (the "streaks" through the imagery). Instead every footprint is splatted with
// a radius sized to its *own* neighbour spacing, so the disks always overlap
// their neighbours no matter where in the scan they sit, and a Gaussian weight
// blends the overlaps smoothly.
const GRID_STEP = 0.1; // degrees ≈ 11 km, finer than the ~16 km nadir footprint
const MERC_LAT = 85.05;

function swathToGrid(lats, lons, vals, S, F) {
  // Latitude range of the valid samples (longitude always spans the full circle
  // — a 33-minute segment of a polar orbit crosses most longitudes).
  let latMin = Infinity, latMax = -Infinity;
  for (let i = 0; i < vals.length; i++) {
    if (Number.isNaN(vals[i]) || Number.isNaN(lats[i])) continue;
    if (lats[i] < latMin) latMin = lats[i];
    if (lats[i] > latMax) latMax = lats[i];
  }
  // Some retrievals (e.g. snowfall rate) can be missing across a whole granule;
  // draw nothing rather than erroring the scene.
  if (latMin > latMax) {
    return {
      proj: 'latlon', ni: 2, nj: 2, lon1: -180, lat1: 1, di: 1, dj: 1, scanMode: 0,
      values: new Float32Array([NaN, NaN, NaN, NaN]),
    };
  }
  latMin = Math.max(-MERC_LAT, latMin - 0.5);
  latMax = Math.min(MERC_LAT, latMax + 0.5);

  const ni = Math.round(360 / GRID_STEP);
  const nj = Math.max(1, Math.ceil((latMax - latMin) / GRID_STEP));
  const lat1 = latMax;
  const lon1 = -180;
  const wsum = new Float64Array(ni * nj);
  const vsum = new Float64Array(ni * nj);

  // Neighbour spacing in grid cells between two swath samples, longitude scaled
  // by latitude so a degree of longitude counts for what it's physically worth.
  const cellGap = (idxA, idxB) => {
    const dLat = (lats[idxA] - lats[idxB]) / GRID_STEP;
    let dLon = lons[idxA] - lons[idxB];
    if (dLon > 180) dLon -= 360; else if (dLon < -180) dLon += 360;
    dLon = (dLon * Math.cos(lats[idxA] * Math.PI / 180)) / GRID_STEP;
    return Math.hypot(dLat, dLon);
  };

  for (let s = 0; s < S; s++) {
    for (let f = 0; f < F; f++) {
      const idx = s * F + f;
      const v = vals[idx];
      if (Number.isNaN(v)) continue;
      const la = lats[idx], lo = lons[idx];
      if (Number.isNaN(la) || Number.isNaN(lo)) continue;

      // Radius = a bit over half the larger neighbour gap, so each footprint's
      // disk reaches its across- and along-track neighbours and the union has no
      // holes (clamped so a lone/edge sample still paints, and capped so a bad
      // geolocation can't splat a huge blob).
      const across = f + 1 < F ? cellGap(idx, idx + 1) : cellGap(idx, idx - 1);
      const along = s + 1 < S ? cellGap(idx, idx + F) : cellGap(idx, idx - F);
      // `rad` is a *physical* radius in cells (cellGap already scaled longitude
      // by cos lat). The disk is a circle on the ground, so in grid space it is
      // an ellipse — stretched in longitude by 1/cos(lat), since a longitude
      // cell shrinks toward the poles. Splatting in raw grid cells instead left
      // the footprints as disconnected dots at high latitude (the "streaks").
      let rad = 0.72 * Math.max(across, along);
      if (!(rad >= 1)) rad = 1;
      if (rad > 9) rad = 9;
      const rad2 = rad * rad;
      const cosLat = Math.max(0.05, Math.cos(la * Math.PI / 180));
      const Rj = Math.ceil(rad);
      const Ri = Math.min(ni >> 1, Math.ceil(rad / cosLat)); // wider longitude reach near poles

      const cj = (lat1 - la) / GRID_STEP;
      const ci = ((((lo - lon1) % 360) + 360) % 360) / GRID_STEP;
      const j0 = Math.round(cj), i0 = Math.round(ci);
      for (let dj = -Rj; dj <= Rj; dj++) {
        const j = j0 + dj;
        if (j < 0 || j >= nj) continue;
        const ddj = cj - j;
        for (let di = -Ri; di <= Ri; di++) {
          const ddi = (ci - (i0 + di)) * cosLat; // longitude distance in physical cells
          const d2 = ddi * ddi + ddj * ddj;
          if (d2 > rad2) continue; // outside this footprint's disk
          const i = (i0 + di + ni) % ni; // longitude wraps
          const w = Math.exp(-2.3 * d2 / rad2); // ~0.1 at the disk edge
          const o = j * ni + i;
          wsum[o] += w;
          vsum[o] += v * w;
        }
      }
    }
  }

  const values = new Float32Array(ni * nj);
  // A cell needs a real footprint contribution to draw; the threshold keeps the
  // fill from bleeding more than a fraction of a footprint past the swath edge.
  const MIN_W = 0.10;
  for (let o = 0; o < values.length; o++)
    values[o] = wsum[o] >= MIN_W ? vsum[o] / wsum[o] : NaN;
  return { proj: 'latlon', ni, nj, lon1, lat1, di: GRID_STEP, dj: GRID_STEP, scanMode: 0, values };
}

// Granule downloads and per-product rasterised grids, both small LRU caches so
// product switching and short loops don't refetch the ~7 MB files.
const fileCache = new Map(); // key → Promise<{h5, lats, lons}>
const gridCache = new Map(); // key#product → grid
const FILE_CACHE_MAX = 4;
const GRID_CACHE_MAX = 10; // rasterised grids are ~10 MB each

function lruTrim(map, max) {
  while (map.size > max) map.delete(map.keys().next().value);
}

async function openGranule(source, key, onProgress) {
  const ck = `${source.bucket}/${key}`;
  if (!fileCache.has(ck)) {
    fileCache.set(ck, (async () => {
      const bytes = await fetchGranule(source.bucket, key, onProgress);
      const h5 = new HDF5File(bytes);
      // Keep the swath shape (scanlines × fields of view) — the rasteriser needs
      // it to size each footprint's splat from its neighbours' spacing.
      const latVar = await h5.readVariable('Latitude');
      const lonVar = await h5.readVariable('Longitude');
      const toPhys = (v) => {
        const fill = v.fill != null ? Number(v.fill) : -999;
        const out = new Float32Array(v.data.length);
        for (let i = 0; i < out.length; i++) out[i] = v.data[i] <= -999 || v.data[i] === fill ? NaN : v.data[i];
        return out;
      };
      return { h5, lats: toPhys(latVar), lons: toPhys(lonVar), S: latVar.dims[0], F: latVar.dims[1] };
    })());
    lruTrim(fileCache, FILE_CACHE_MAX);
  }
  try {
    return await fileCache.get(ck);
  } catch (e) {
    fileCache.delete(ck);
    throw e;
  }
}

// Load one granule + product into a display-ready lat/lon grid (same shape the
// MRMS/model loaders return, so it rides the shared GPU grid layer, legend and
// inspect paths).
export async function loadMirsGrid(satKey, key, productId, onProgress) {
  const source = MIRS_SOURCES[satKey];
  const product = MIRS_PRODUCTS[productId] || MIRS_PRODUCTS.BT89;
  if (!source) throw new Error('unknown MIRS source');
  const ck = `${source.bucket}/${key}#${product.id}`;
  if (gridCache.has(ck)) return gridCache.get(ck);
  const { h5, lats, lons, S, F } = await openGranule(source, key, onProgress);
  const vals = await readVar(h5, product.varName, product.channel);
  const grid = swathToGrid(lats, lons, vals, S, F);
  grid.product = product;
  grid.time = granuleTime(key);
  grid.key = key;
  gridCache.set(ck, grid);
  lruTrim(gridCache, GRID_CACHE_MAX);
  return grid;
}

// Geographic bbox of a granule's data — [w, s, e, n] for a fit-to-swath.
export function mirsGridBBox(grid) {
  let iMin = Infinity, iMax = -Infinity, jMin = Infinity, jMax = -Infinity;
  const { ni, nj, values } = grid;
  for (let j = 0; j < nj; j++) {
    for (let i = 0; i < ni; i++) {
      if (Number.isNaN(values[j * ni + i])) continue;
      if (i < iMin) iMin = i;
      if (i > iMax) iMax = i;
      if (j < jMin) jMin = j;
      if (j > jMax) jMax = j;
    }
  }
  if (iMin > iMax) return null;
  return [
    grid.lon1 + iMin * grid.di,
    grid.lat1 - (jMax + 1) * grid.dj,
    grid.lon1 + (iMax + 1) * grid.di,
    grid.lat1 - jMin * grid.dj,
  ];
}
