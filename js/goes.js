// goes.js — list and load NOAA GOES-R ABI Level-2 imagery from the open AWS
// buckets, and decode it with our pure-JS HDF5/NetCDF-4 reader (hdf5.js).
//
// Buckets (NOAA Open Data Dissemination, CORS-enabled like the radar bucket):
//   noaa-goes19  GOES-East   (operational East, replaced GOES-16 in 2025)
//   noaa-goes18  GOES-West
//   noaa-goes16  GOES-East legacy archive
//
// We use the multi-band cloud/moisture product (ABI-L2-MCMIP*) because a single
// file carries all 16 ABI channels (CMI_C01…CMI_C16) — so every channel *and*
// every RGB composite comes from one download. The trade-off is that MCMIP
// resamples each channel to the common 2 km fixed grid; native 0.5/1 km detail
// would need the single-band CMIP products (larger, one file per channel).
//
// Object keys are  PRODUCT/YYYY/DOY/HH/OR_ABI-L2-<sector>-...<start>_..._c....nc

import { HDF5File } from './hdf5.js';
import { decodeBzip2 } from './bzip2.js';

export const SATELLITES = {
  'goes19': { bucket: 'https://noaa-goes19.s3.amazonaws.com', label: 'GOES-19 (East)', lon0: -75.2, family: 'goes' },
  'goes18': { bucket: 'https://noaa-goes18.s3.amazonaws.com', label: 'GOES-18 (West)', lon0: -137.0, family: 'goes' },
  'goes16': { bucket: 'https://noaa-goes16.s3.amazonaws.com', label: 'GOES-16 (East, legacy)', lon0: -75.0, family: 'goes' },
  // Himawari-9 (operational since Dec 2022) lives in its own bucket; the
  // noaa-himawari8 bucket is the retired Himawari-8 archive and no longer
  // updates. Imagery is the L1b Full Disk product (Himawari Standard Data).
  'himawari9': { bucket: 'https://noaa-himawari9.s3.amazonaws.com', label: 'Himawari-9', lon0: 140.7, family: 'himawari' },
};

// Sectors. `product` is the S3 product prefix; `match` filters the sector token
// in the filename (mesoscale M1/M2 share the MCMIPM prefix). `fast` flags the
// rapid-refresh sectors (≈1 min meso, 5 min CONUS, 10 min full disk).
export const SECTORS = {
  conus: { label: 'CONUS', product: 'ABI-L2-MCMIPC', match: 'MCMIPC', refresh: 'every ~5 min' },
  full: { label: 'Full Disk', product: 'ABI-L2-MCMIPF', match: 'MCMIPF', refresh: 'every ~10 min' },
  meso1: { label: 'Mesoscale 1', product: 'ABI-L2-MCMIPM', match: 'MCMIPM1', refresh: 'every ~1 min' },
  meso2: { label: 'Mesoscale 2', product: 'ABI-L2-MCMIPM', match: 'MCMIPM2', refresh: 'every ~1 min' },
  hfd: { label: 'Full Disk', product: 'AHI-L1b-FLDK', match: 'FLDK', refresh: 'every ~10 min', family: 'himawari' },
};

export function sectorsForSatellite(satKey) {
  const fam = SATELLITES[satKey]?.family || 'goes';
  return Object.fromEntries(Object.entries(SECTORS).filter(([, s]) => (s.family || 'goes') === fam));
}


// "Common CONUS sectors" — familiar regional crops the forecasters use. These
// reuse the single CONUS download and just frame the map (the imagery is the
// full CONUS fixed grid behind them). [west, south, east, north].
export const CONUS_VIEWS = [
  ['Full CONUS', [-125.5, 23.5, -66.5, 50.5]],
  ['Northern Plains', [-106, 41, -89, 49.5]],
  ['Southern Plains', [-105, 28, -90, 38]],
  ['Midwest', [-97, 37, -80, 47]],
  ['Southeast', [-92, 28, -75, 37]],
  ['Northeast', [-82, 38, -66.5, 48]],
  ['Mid-Atlantic', [-83, 35, -73, 41]],
  ['Southwest', [-122, 31, -103, 42]],
  ['Pacific NW', [-125, 41, -110, 49.5]],
  ['Gulf Coast', [-98, 25.5, -81, 32]],
];

const pad = (n, w = 2) => String(n).padStart(w, '0');

function dayOfYear(d) {
  const start = Date.UTC(d.getUTCFullYear(), 0, 0);
  return Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - start) / 86400000);
}

// Parse the scan-start time out of a key: ..._sYYYYDOYHHMMSSs_...
function timeForKey(key) {
  const name = key.split('/').pop();
  const m = name.match(/_s(\d{4})(\d{3})(\d{2})(\d{2})(\d{2})/);
  if (!m) return null;
  const [, yr, doy, hh, mm, ss] = m;
  const d = new Date(Date.UTC(+yr, 0, 1, +hh, +mm, +ss));
  d.setUTCDate(+doy);
  return d;
}

function labelForKey(key) {
  const t = timeForKey(key);
  return t ? `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}Z` : key.split('/').pop();
}


// --- Himawari-9 AHI (Himawari Standard Data, L1b Full Disk) -----------------
//
// Unlike GOES (one self-describing NetCDF per scan), Himawari publishes the raw
// "Himawari Standard Data" (HSD): a custom binary format, bzip2-compressed, with
// each band split into 10 vertical segments (S0110…S1010). Files live under
//   AHI-L1b-FLDK/YYYY/MM/DD/HHMM/HS_H09_<date>_<time>_B##_FLDK_R##_S##10.DAT.bz2
//
// We decode the HSD ourselves (no NetCDF here) and resample every band onto the
// common 2 km full-disk fixed grid (5500×5500) so multi-band RGB recipes line up
// and memory stays bounded — visible bands are higher native resolution.
const HIMAWARI_SCENE_FILES = new Map();

const HIMAWARI_W = 5500, HIMAWARI_H = 5500; // 2 km full-disk grid
const HIMAWARI_CFAC = 20466275, HIMAWARI_COFF = 2750.5; // CGMS nav for that grid
const HIMAWARI_SEGMENTS = 10;

// The app addresses channels by GOES ABI number; AHI numbers the visible bands
// differently (and has no 1.37 µm cirrus band). Map ABI → AHI for file naming;
// null means the channel has no Himawari equivalent.
const ABI_TO_AHI = {
  1: 1, 2: 3, 3: 4, 4: null, 5: 5, 6: 6, 7: 7, 8: 8,
  9: 9, 10: 10, 11: 11, 12: 12, 13: 13, 14: 14, 15: 15, 16: 16,
};
// Native resolution code per AHI band (0.5/1/2 km); the resample ratio is read
// back from each segment's actual width.
const ahiRes = (b) => (b === 3 ? 'R05' : (b === 1 || b === 2 || b === 4) ? 'R10' : 'R20');

function himawariSegKey(meta, ahiBand, seg) {
  const stamp = `${meta.y}${meta.mm}${meta.dd}_${meta.hhmm}`;
  return `AHI-L1b-FLDK/${meta.y}/${meta.mm}/${meta.dd}/${meta.hhmm}/` +
    `HS_H09_${stamp}_B${pad(ahiBand)}_FLDK_${ahiRes(ahiBand)}_S${pad(seg)}10.DAT.bz2`;
}

// List the available full-disk scene times by walking the day folders for the
// 10-minute HHMM subfolders. Returns the most recent dozen, newest last.
async function listHimawariScenes(bucket, baseDate) {
  const found = new Map(); // hhmm-id -> meta
  for (let back = 0; back < 2 && found.size < 24; back++) {
    const d = new Date(baseDate.getTime() - back * 86400000);
    const y = d.getUTCFullYear(), mm = pad(d.getUTCMonth() + 1), dd = pad(d.getUTCDate());
    const prefix = `AHI-L1b-FLDK/${y}/${mm}/${dd}/`;
    const url = `${bucket}/?list-type=2&prefix=${encodeURIComponent(prefix)}&delimiter=/&max-keys=1000`;
    let res;
    try { res = await fetch(url); } catch (_) { continue; }
    if (!res.ok) continue;
    const xml = await res.text();
    const re = /<Prefix>[^<]*\/(\d{4})\/<\/Prefix>/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
      const hhmm = m[1];
      const id = `HIMAWARI:${y}${mm}${dd}${hhmm}`;
      if (found.has(id)) continue;
      const time = new Date(Date.UTC(+y, +mm - 1, +dd, +hhmm.slice(0, 2), +hhmm.slice(2)));
      found.set(id, { y, mm, dd, hhmm, time, key: id });
    }
  }
  const out = [...found.values()].sort((a, b) => a.time - b.time).slice(-12);
  for (const meta of out) HIMAWARI_SCENE_FILES.set(meta.key, meta);
  return out.map((meta) => ({
    key: meta.key, time: meta.time,
    label: `${pad(meta.time.getUTCHours())}:${pad(meta.time.getUTCMinutes())}Z`,
  }));
}

async function listHour(bucket, product, dateUTC, hour, match) {
  const y = dateUTC.getUTCFullYear();
  const doy = pad(dayOfYear(dateUTC), 3);
  const prefix = `${product}/${y}/${doy}/${pad(hour)}/`;
  const url = `${bucket}/?list-type=2&prefix=${encodeURIComponent(prefix)}&max-keys=1000`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GOES list failed: ${res.status}`);
  const xml = await res.text();
  const keys = [];
  const re = /<Key>([^<]+)<\/Key>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    if (!match || m[1].includes(match)) keys.push(m[1]);
  }
  return keys;
}

// List recent scans for a sector, newest last. Walks back from `date` across a
// couple of hours so the list isn't empty right at the top of the hour.
export async function listScenes(satKey, sectorKey, date) {
  const sat = SATELLITES[satKey];
  const sector = SECTORS[sectorKey];
  if (!sat || !sector) throw new Error('bad satellite/sector');
  if ((sat.family || 'goes') === 'himawari') {
    return listHimawariScenes(sat.bucket, date || new Date());
  }
  const base = date || new Date();
  let keys = [];
  for (let back = 0; back < 3 && keys.length < 6; back++) {
    const d = new Date(base.getTime() - back * 3600000);
    try {
      const hk = await listHour(sat.bucket, sector.product, d, d.getUTCHours(), sector.match);
      keys = hk.concat(keys);
    } catch (_) { /* hour folder may not exist yet */ }
  }
  // De-dupe and sort by time.
  const seen = new Set();
  const out = [];
  for (const k of keys) {
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ key: k, label: labelForKey(k), time: timeForKey(k) });
  }
  out.sort((a, b) => (a.time || 0) - (b.time || 0));
  return out;
}

export async function fetchBytes(bucket, key, onProgress) {
  const res = await fetch(`${bucket}/${key}`);
  if (!res.ok) throw new Error(`GOES download failed: ${res.status}`);
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
}

// Read one ABI channel into physical units (reflectance factor for the visible/
// near-IR bands, brightness temperature K for the IR bands). Fill → NaN.
async function readChannel(h5, band) {
  const name = `CMI_C${pad(band)}`;
  const v = await h5.readVariable(name);
  const a = h5.readAttributes(name);
  const scale = a.scale_factor != null ? a.scale_factor : 1;
  const offset = a.add_offset != null ? a.add_offset : 0;
  const fill = v.fill;
  const n = v.data.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const raw = v.data[i];
    out[i] = raw === fill ? NaN : raw * scale + offset;
  }
  return out;
}


// Decode one HSD segment and resample it onto the common 2 km grid `out`
// (NaN for fill / off-disk pixels). `seg` is the 1-based segment number. Returns
// the navigation constants from the projection block (block 3).
function decodeHimawariSegment(bytes, seg, out) {
  const raw = decodeBzip2(bytes);
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.length);
  const u16 = (o) => dv.getUint16(o, true);
  const f64 = (o) => dv.getFloat64(o, true);

  // The HSD header is 11 fixed blocks, each led by a 1-byte number and 2-byte
  // length. Walk them to find their offsets.
  let off = 0; const blk = {};
  for (let i = 0; i < 11; i++) { blk[raw[off]] = off; off += u16(off + 1); }
  const hdrLen = off;
  const b2 = blk[2], b3 = blk[3], b5 = blk[5];

  const cols = u16(b2 + 5), lines = u16(b2 + 7);
  const band = u16(b5 + 3);
  const gain = f64(b5 + 19), cnst = f64(b5 + 27);   // count → radiance
  const errCnt = u16(b5 + 15), outCnt = u16(b5 + 17); // error / off-scan fill DN

  // Bands 1–6 are visible/near-IR (radiance → albedo via c′); bands 7–16 are
  // thermal IR (radiance → brightness temperature via the inverse Planck law and
  // a band-correction polynomial), matching the GOES path's physical units.
  let calibrate;
  if (band <= 6) {
    const cprime = f64(b5 + 35);
    calibrate = (dn) => cprime * (gain * dn + cnst);
  } else {
    const lam = f64(b5 + 5) * 1e-6;                  // central wavelength, m
    const c0 = f64(b5 + 35), c1 = f64(b5 + 43), c2 = f64(b5 + 51);
    const cL = f64(b5 + 83), hP = f64(b5 + 91), kB = f64(b5 + 99);
    const hck = (hP * cL) / (kB * lam);
    const planckA = (2 * hP * cL * cL) / Math.pow(lam, 5);
    calibrate = (dn) => {
      const I = (gain * dn + cnst) * 1e6;             // W/(m² sr m)
      if (I <= 0) return NaN;
      const Te = hck / Math.log(planckA / I + 1);
      return c0 + c1 * Te + c2 * Te * Te;
    };
  }

  // Nearest-neighbour resample from the band's native grid to the 2 km grid.
  const ratio = Math.max(1, Math.round(cols / HIMAWARI_W));
  const nativeRowStart = (seg - 1) * lines;
  for (let cr = 0; cr < HIMAWARI_H; cr++) {
    const nr = Math.floor((cr + 0.5) * ratio);
    if (nr < nativeRowStart || nr >= nativeRowStart + lines) continue;
    const rowBase = hdrLen + (nr - nativeRowStart) * cols * 2;
    const outBase = cr * HIMAWARI_W;
    for (let cc = 0; cc < HIMAWARI_W; cc++) {
      const dn = u16(rowBase + Math.floor((cc + 0.5) * ratio) * 2);
      out[outBase + cc] = (dn === errCnt || dn === outCnt) ? NaN : calibrate(dn);
    }
  }

  return { subLon: f64(b3 + 3), Rs: f64(b3 + 27), Req: f64(b3 + 35), Rpol: f64(b3 + 43) };
}

// Build one ABI channel for a scene by downloading and decoding its 10 HSD
// segments. Missing segments (a scene still uploading) leave NaN gaps.
async function himawariChannel(bucket, meta, abiBand, onProgress) {
  const out = new Float32Array(HIMAWARI_W * HIMAWARI_H).fill(NaN);
  const ahi = ABI_TO_AHI[abiBand];
  if (ahi == null) return { data: out, nav: null }; // no Himawari equivalent
  let nav = null;
  for (let s = 1; s <= HIMAWARI_SEGMENTS; s++) {
    let bytes;
    try {
      bytes = await fetchBytes(bucket, himawariSegKey(meta, ahi, s),
        onProgress ? (p) => onProgress((s - 1 + p) / HIMAWARI_SEGMENTS) : null);
    } catch (_) { continue; }
    const n = decodeHimawariSegment(bytes, s, out);
    if (n && !nav) nav = n;
  }
  return { data: out, nav };
}

function himawariScene(meta, channels, nav, sat, key) {
  const k = (65536 / HIMAWARI_CFAC) * (Math.PI / 180); // scan-angle radians/column
  const n = nav || { subLon: sat.lon0, Rs: 42164, Req: 6378.137, Rpol: 6356.7523 };
  return {
    width: HIMAWARI_W, height: HIMAWARI_H,
    xScale: -k, xOffset: (HIMAWARI_COFF - 1) * k,
    yScale: k, yOffset: (1 - HIMAWARI_COFF) * k,
    proj: {
      lon0: (n.subLon || sat.lon0) * Math.PI / 180,
      H: (n.Rs || 42164) * 1000,
      rEq: (n.Req || 6378.137) * 1000,
      rPol: (n.Rpol || 6356.7523) * 1000,
      sweep: 'y',
    },
    channels, time: meta.time, key,
    _himawariMeta: meta, _satBucket: sat.bucket,
  };
}

async function loadHimawariScene(sat, key, bands, onProgress) {
  const meta = HIMAWARI_SCENE_FILES.get(key);
  if (!meta) throw new Error('Himawari scene index expired; refresh scenes');
  const channels = {};
  let nav = null;
  for (let i = 0; i < bands.length; i++) {
    const r = await himawariChannel(sat.bucket, meta, bands[i],
      onProgress ? (p) => onProgress((i + p) / bands.length) : null);
    channels[bands[i]] = r.data;
    if (r.nav && !nav) nav = r.nav;
  }
  return himawariScene(meta, channels, nav, sat, key);
}

// Download + decode a scene, reading only the channels requested. Returns the
// grid geometry, the geostationary projection constants, and the per-band
// physical arrays — everything satProducts.buildRGBA / satelliteLayer need.
export async function loadScene(satKey, sectorKey, key, bands, onProgress) {
  const sat = SATELLITES[satKey];
  const sector = SECTORS[sectorKey];
  if ((sat.family || 'goes') === 'himawari') return loadHimawariScene(sat, key, bands, onProgress);
  const bytes = await fetchBytes(sat.bucket, key, onProgress);
  const h5 = new HDF5File(bytes);

  const proj = h5.readAttributes('goes_imager_projection');
  const xa = h5.readAttributes('x');
  const ya = h5.readAttributes('y');

  // Grid geometry comes from the first band we read.
  const first = await h5.readVariable(`CMI_C${pad(bands[0])}`);
  const [H, W] = first.dims;

  const channels = {};
  for (const b of bands) channels[b] = await readChannel(h5, b);

  const t = timeForKey(key);
  return {
    width: W,
    height: H,
    xScale: xa.scale_factor, xOffset: xa.add_offset,
    yScale: ya.scale_factor, yOffset: ya.add_offset,
    proj: {
      lon0: (proj.longitude_of_projection_origin || sat.lon0) * Math.PI / 180,
      H: (proj.perspective_point_height || 35786023) + (proj.semi_major_axis || 6378137),
      rEq: proj.semi_major_axis || 6378137,
      rPol: proj.semi_minor_axis || 6356752.31414,
      sweep: proj.sweep_angle_axis || 'x',
    },
    channels,
    time: t,
    key,
    _h5: h5, // kept so more bands can be decoded later without re-downloading
  };
}

// Decode any of the requested bands not already present on the scene, reusing
// the already-downloaded file. Lets product switches add channels (e.g. for an
// RGB recipe) without re-fetching — and keeps memory to only what's displayed.
export async function ensureBands(scene, bands) {
  if (scene._himawariMeta) {
    for (const b of bands) {
      if (scene.channels[b]) continue;
      scene.channels[b] = (await himawariChannel(scene._satBucket, scene._himawariMeta, b)).data;
    }
    return scene;
  }
  if (!scene._h5) return scene;
  for (const b of bands) {
    if (!scene.channels[b]) scene.channels[b] = await readChannel(scene._h5, b);
  }
  return scene;
}

// Forward GOES fixed-grid navigation: scan angles (x,y in rad) → geodetic
// lon/lat (deg), per the GOES-R PUG. Returns null when the point is off the
// Earth's limb. Used to build the image's lon/lat bounding box for the GL quad.
export function scanToLonLat(x, y, proj) {
  const { lon0, H, rEq, rPol } = proj;
  const sinx = Math.sin(x), cosx = Math.cos(x);
  const siny = Math.sin(y), cosy = Math.cos(y);
  const a = sinx * sinx + cosx * cosx * (cosy * cosy + (rEq * rEq) / (rPol * rPol) * siny * siny);
  const b = -2 * H * cosx * cosy;
  const c = H * H - rEq * rEq;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const rs = (-b - Math.sqrt(disc)) / (2 * a);
  const sx = rs * cosx * cosy;
  const sy = -rs * sinx;
  const sz = rs * cosx * siny;
  const lat = Math.atan((rEq * rEq) / (rPol * rPol) * (sz / Math.sqrt((H - sx) * (H - sx) + sy * sy)));
  const lon = lon0 - Math.atan(sy / (H - sx));
  return [lon * 180 / Math.PI, lat * 180 / Math.PI];
}

// Inverse of scanToLonLat: geodetic lon/lat (deg) → fractional grid column/row,
// the same math the satellite shader runs per pixel. Returns null when the point
// is off the visible Earth disk or outside the scene grid. Used by the inspect
// tool / cursor readout to read the channel value under a point.
export function lonLatToColRow(scene, lat, lon) {
  const { proj, xOffset, xScale, yOffset, yScale, width: W, height: H } = scene;
  const latR = (lat * Math.PI) / 180;
  const lonR = (lon * Math.PI) / 180;
  const req2 = proj.rEq * proj.rEq;
  const rpol2 = proj.rPol * proj.rPol;
  const phic = Math.atan((rpol2 / req2) * Math.tan(latR)); // geocentric latitude
  const cphic = Math.cos(phic);
  const e2 = 1 - rpol2 / req2;
  const rc = proj.rPol / Math.sqrt(1 - e2 * cphic * cphic);
  const dlon = lonR - proj.lon0;
  const sx = proj.H - rc * cphic * Math.cos(dlon);
  const sy = -rc * cphic * Math.sin(dlon);
  const sz = rc * Math.sin(phic);
  // Visibility: the point must be on the Earth face toward the satellite.
  if (proj.H * (proj.H - sx) < sy * sy + (req2 / rpol2) * sz * sz) return null;
  const sxyz = Math.sqrt(sx * sx + sy * sy + sz * sz);
  let scanX, scanY;
  if (proj.sweep === 'y') {
    scanX = Math.atan(sy / sx);
    scanY = Math.asin(-sz / sxyz);
  } else {
    scanY = Math.atan(sz / sx);
    scanX = Math.asin(-sy / sxyz);
  }
  const col = (scanX - xOffset) / xScale;
  const row = (scanY - yOffset) / yScale;
  if (col < 0 || col >= W || row < 0 || row >= H) return null;
  return { col, row };
}

// Bounding box [w, s, e, n] of a scene by forward-projecting a coarse sample of
// its scan-angle grid (skipping off-limb points, e.g. full-disk corners).
export function sceneBBox(scene) {
  const { width: W, height: Hh, xScale, xOffset, yScale, yOffset, proj } = scene;
  let w = 180, s = 90, e = -180, n = -90;
  const step = 24;
  for (let r = 0; r <= Hh; r += Math.max(1, (Hh / step) | 0)) {
    const yy = yOffset + Math.min(r, Hh - 1) * yScale;
    for (let cc = 0; cc <= W; cc += Math.max(1, (W / step) | 0)) {
      const xx = xOffset + Math.min(cc, W - 1) * xScale;
      const ll = scanToLonLat(xx, yy, proj);
      if (!ll) continue;
      const [lon, lat] = ll;
      if (!isFinite(lon) || !isFinite(lat)) continue;
      if (lon < w) w = lon; if (lon > e) e = lon;
      if (lat < s) s = lat; if (lat > n) n = lat;
    }
  }
  return [w, s, e, n];
}
