// models.js — list and load NWP model output from the open NODD AWS buckets,
// decoded with grib2.js. For now this carries one field, HRRR composite
// reflectivity, to prove the pipeline end to end.
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

// Available models (only HRRR for now). `bucket` is CORS-enabled for listing,
// GET and Range requests, like the other NODD buckets used here.
export const MODELS = {
  hrrr: {
    id: 'hrrr',
    label: 'HRRR (3 km CONUS)',
    bucket: 'https://noaa-hrrr-bdp-pds.s3.amazonaws.com',
    // Build the grib + index keys for a UTC day and cycle hour.
    keysFor(dayStr, hh) {
      const grib = `hrrr.${dayStr}/conus/hrrr.t${hh}z.wrfsfcf00.grib2`;
      return { grib, idx: grib + '.idx' };
    },
  },
};

export const MODEL_ORDER = ['REFC'];

// A model product names the GRIB field to pull (`varName`/`level`, matched
// against the `.idx`). `reflectivity:true` opts it into the shared reflectivity
// color table (so models, MRMS and single-site radar all draw dBZ the same way,
// and a user-loaded reflectivity .pal applies here too). `floor` is the lowest
// value drawn; everything below is left transparent.
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
};

const pad = (n, w = 2) => String(n).padStart(w, '0');
const dayStrOf = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;

// List the available model runs for a UTC day, newest last. HRRR runs every
// hour; we surface each cycle's f00 analysis as one frame. For the current day
// we stop at the most recent cycle that should already be posted (HRRR f00 lands
// ~50 min after the top of the hour).
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
  const frames = [];
  for (let h = 0; h <= maxH; h++) {
    const hh = pad(h);
    const { grib, idx } = model.keysFor(dayStr, hh);
    frames.push({
      key: grib,
      idxKey: idx,
      label: `${hh}z`,
      time: new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), h)),
    });
  }
  return frames;
}

// Parse a GRIB `.idx` file and return the [start, end] byte range of the message
// carrying the requested field. `end` is null for the file's last record (an
// open-ended Range covers it).
function rangeFromIdx(text, product) {
  const lines = text.split('\n').filter((l) => l.trim());
  for (let i = 0; i < lines.length; i++) {
    const f = lines[i].split(':');
    if (f[3] === product.varName && f[4] === product.level) {
      const start = parseInt(f[1], 10);
      const next = lines[i + 1] ? parseInt(lines[i + 1].split(':')[1], 10) : null;
      return { start, end: next == null ? null : next - 1 };
    }
  }
  throw new Error(`field ${product.varName}/${product.level} not in index`);
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

// Download + decode one model frame into a lat/lon grid of physical values.
export async function loadModel(modelKey, productId, frame, onProgress) {
  const model = MODELS[modelKey];
  const product = MODEL_PRODUCTS[productId];
  if (!model || !product) throw new Error('unknown model/product');

  const idxText = await (await fetch(`${model.bucket}/${frame.idxKey}`)).text();
  const range = rangeFromIdx(idxText, product);
  const bytes = await fetchRange(`${model.bucket}/${frame.key}`, range, onProgress);
  const lambert = await decodeGrib2(bytes);
  const grid = lambert.proj === 'lambert' ? resampleLambert(lambert) : lambert;
  grid.product = product;
  grid.model = model;
  grid.time = frame.time;
  grid.key = frame.key;
  return grid;
}
