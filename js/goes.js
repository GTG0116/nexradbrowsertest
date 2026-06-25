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

export const SATELLITES = {
  'goes19': { bucket: 'https://noaa-goes19.s3.amazonaws.com', label: 'GOES-19 (East)', lon0: -75.2, family: 'goes' },
  'goes18': { bucket: 'https://noaa-goes18.s3.amazonaws.com', label: 'GOES-18 (West)', lon0: -137.0, family: 'goes' },
  'goes16': { bucket: 'https://noaa-goes16.s3.amazonaws.com', label: 'GOES-16 (East, legacy)', lon0: -75.0, family: 'goes' },
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
  japan: { label: 'Japan (higher res)', product: 'AHI-L1b-Japan', match: 'Japan', refresh: 'every ~2.5 min', family: 'himawari' },
  target: { label: 'Target Sector', product: 'AHI-L1b-Target', match: 'Target', refresh: 'every ~2.5 min', family: 'himawari' },
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


const HIMAWARI_SCENE_FILES = new Map();

function himawariBandForKey(key) {
  const m = key.match(/(?:-|_)B(\d{2})(?:-|_)/);
  return m ? +m[1] : null;
}

async function listHimawariHour(bucket, product, dateUTC, hour) {
  const y = dateUTC.getUTCFullYear();
  const mm = pad(dateUTC.getUTCMonth() + 1);
  const dd = pad(dateUTC.getUTCDate());
  const doy = pad(dayOfYear(dateUTC), 3);
  const hh = pad(hour);
  const prefixes = [
    `${product}/${y}/${mm}/${dd}/${hh}`,
    `${product}/${y}/${doy}/${hh}`,
  ];
  const out = [];
  for (const prefix of prefixes) {
    const url = `${bucket}/?list-type=2&prefix=${encodeURIComponent(prefix)}&max-keys=1000`;
    const res = await fetch(url);
    if (!res.ok) continue;
    const xml = await res.text();
    const re = /<Key>([^<]+)<\/Key>/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
      const k = m[1];
      if (k.includes('_GH9_') && (k.includes(`_s${y}${doy}${hh}`) || k.includes(`_${y}${mm}${dd}_${hh}`))) out.push(k);
    }
    if (out.length) break;
  }
  return out;
}

function groupHimawariKeys(keys) {
  const groups = new Map();
  for (const k of keys) {
    const sm = k.match(/_s(\d{4})(\d{3})(\d{2})(\d{2})(\d{2})/);
    const band = himawariBandForKey(k);
    if (!sm || !band) continue;
    const id = `HIMAWARI:${sm[1]}${sm[2]}${sm[3]}${sm[4]}${sm[5]}`;
    if (!groups.has(id)) groups.set(id, { files: {}, time: timeForKey(k) });
    groups.get(id).files[band] = k;
  }
  const out = [];
  for (const [id, g] of groups) {
    HIMAWARI_SCENE_FILES.set(id, g.files);
    out.push({ key: id, label: g.time ? `${pad(g.time.getUTCHours())}:${pad(g.time.getUTCMinutes())}Z` : id, time: g.time });
  }
  out.sort((a, b) => (a.time || 0) - (b.time || 0));
  return out;
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
    const baseH = date || new Date();
    let hkeys = [];
    for (let back = 0; back < 3 && hkeys.length < 16; back++) {
      const d = new Date(baseH.getTime() - back * 3600000);
      try { hkeys = (await listHimawariHour(sat.bucket, sector.product, d, d.getUTCHours())).concat(hkeys); }
      catch (_) { /* hour folder may not exist yet */ }
    }
    return groupHimawariKeys(hkeys).slice(-12);
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


function firstAttr(h5, names) {
  for (const n of names) {
    try { const a = h5.readAttributes(n); if (a && Object.keys(a).length) return { name: n, attrs: a }; } catch (_) {}
  }
  return { name: '', attrs: {} };
}

async function readHimawariChannel(h5, band) {
  const names = [`CMI_C${pad(band)}`, `Sectorized_CMI`, `CMI`, `Rad`, `B${pad(band)}`];
  let v = null, name = null;
  for (const n of names) {
    try { v = await h5.readVariable(n); name = n; break; } catch (_) {}
  }
  if (!v) throw new Error(`Himawari band ${pad(band)} variable not found`);
  const a = h5.readAttributes(name);
  const scale = a.scale_factor != null ? a.scale_factor : 1;
  const offset = a.add_offset != null ? a.add_offset : 0;
  const fill = v.fill != null ? v.fill : a._FillValue;
  const out = new Float32Array(v.data.length);
  for (let i = 0; i < v.data.length; i++) {
    const raw = v.data[i];
    out[i] = raw === fill ? NaN : raw * scale + offset;
  }
  return { data: out, dims: v.dims };
}

async function loadHimawariScene(sat, sector, key, bands, onProgress) {
  const files = HIMAWARI_SCENE_FILES.get(key);
  if (!files) throw new Error('Himawari scene index expired; refresh scenes');
  const channels = {};
  let geom = null, h5First = null;
  for (let i = 0; i < bands.length; i++) {
    const b = bands[i];
    const fkey = files[b] || files[14] || Object.values(files)[0];
    const bytes = await fetchBytes(sat.bucket, fkey, onProgress ? (p) => onProgress((i + p) / bands.length) : null);
    const h5 = new HDF5File(bytes);
    const ch = await readHimawariChannel(h5, b);
    channels[b] = ch.data;
    if (!geom) { geom = ch.dims; h5First = h5; }
  }
  const [H, W] = geom;
  const projInfo = firstAttr(h5First, ['goes_imager_projection', 'fixedgrid_projection', 'imager_projection', 'projection']);
  const xa = firstAttr(h5First, ['x', 'x_image', 'x_image_bounds']).attrs;
  const ya = firstAttr(h5First, ['y', 'y_image', 'y_image_bounds']).attrs;
  const full = sector.product.includes('FLDK');
  const xSpan = full ? 0.3037 : 0.08;
  const ySpan = full ? 0.3037 : 0.08;
  const p = projInfo.attrs;
  return {
    width: W, height: H,
    xScale: xa.scale_factor || (xSpan / W), xOffset: xa.add_offset != null ? xa.add_offset : -xSpan / 2,
    yScale: ya.scale_factor || (-ySpan / H), yOffset: ya.add_offset != null ? ya.add_offset : ySpan / 2,
    proj: {
      lon0: (p.longitude_of_projection_origin != null ? p.longitude_of_projection_origin : sat.lon0) * Math.PI / 180,
      H: (p.perspective_point_height || p.nominal_satellite_height || 35785831) + (p.semi_major_axis || 6378137),
      rEq: p.semi_major_axis || 6378137,
      rPol: p.semi_minor_axis || 6356752.31414,
      sweep: p.sweep_angle_axis || 'y',
    },
    channels, time: timeForKey(Object.values(files)[0]), key,
    _himawariFiles: files, _satBucket: sat.bucket,
  };
}

// Download + decode a scene, reading only the channels requested. Returns the
// grid geometry, the geostationary projection constants, and the per-band
// physical arrays — everything satProducts.buildRGBA / satelliteLayer need.
export async function loadScene(satKey, sectorKey, key, bands, onProgress) {
  const sat = SATELLITES[satKey];
  const sector = SECTORS[sectorKey];
  if ((sat.family || 'goes') === 'himawari') return loadHimawariScene(sat, sector, key, bands, onProgress);
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
  if (scene._himawariFiles) {
    for (const b of bands) {
      if (scene.channels[b]) continue;
      const fkey = scene._himawariFiles[b] || scene._himawariFiles[14] || Object.values(scene._himawariFiles)[0];
      const bytes = await fetchBytes(scene._satBucket, fkey);
      const h5 = new HDF5File(bytes);
      scene.channels[b] = (await readHimawariChannel(h5, b)).data;
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
