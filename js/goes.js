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
//
// Himawari sectors also carry the HSD layout: `segments` (vertical strips per
// band), `frames` (rapid-scan observations per 10-minute folder), `region(f)`
// (the filename area token for frame f), and either a fixed `grid` (full disk)
// or `commonCFAC` (the resample resolution for region sectors, whose grids are
// read from the file headers — the Target sector is steerable and moves).
export const SECTORS = {
  conus: { label: 'CONUS', product: 'ABI-L2-MCMIPC', match: 'MCMIPC', refresh: 'every ~5 min' },
  full: { label: 'Full Disk', product: 'ABI-L2-MCMIPF', match: 'MCMIPF', refresh: 'every ~10 min' },
  meso1: { label: 'Mesoscale 1', product: 'ABI-L2-MCMIPM', match: 'MCMIPM1', refresh: 'every ~1 min' },
  meso2: { label: 'Mesoscale 2', product: 'ABI-L2-MCMIPM', match: 'MCMIPM2', refresh: 'every ~1 min' },
  hfd: {
    label: 'Full Disk', product: 'AHI-L1b-FLDK', refresh: 'every ~10 min', family: 'himawari',
    segments: 10, frames: 1, region: () => 'FLDK',
    grid: { W: 5500, H: 5500, CFAC: 20466275, LFAC: 20466275, COFF: 2750.5, LOFF: 2750.5 },
  },
  japan: {
    label: 'Japan (higher res)', product: 'AHI-L1b-Japan', refresh: 'every ~2.5 min', family: 'himawari',
    segments: 1, frames: 4, region: (f) => `JP0${f}`, commonCFAC: 40932549,
  },
  target: {
    label: 'Target Sector', product: 'AHI-L1b-Target', refresh: 'every ~2.5 min', family: 'himawari',
    segments: 1, frames: 4, region: (f) => `R30${f}`, commonCFAC: 40932549,
  },
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


// --- Himawari-9 AHI (Himawari Standard Data, L1b) ---------------------------
//
// Unlike GOES (one self-describing NetCDF per scan), Himawari publishes the raw
// "Himawari Standard Data" (HSD): a custom binary format, bzip2-compressed.
//   <product>/YYYY/MM/DD/HHMM/HS_H09_<date>_<time>_B##_<region>_R##_S##<n>.DAT.bz2
// The Full Disk is split into 10 vertical segments (S0110…S1010), one frame per
// 10-minute folder. The Japan and Target sectors are smaller regions scanned
// every ~2.5 min, so each folder holds 4 single-segment frames (JP01…JP04 /
// R301…R304). We decode the HSD ourselves and resample every band onto a common
// fixed grid so multi-band RGB recipes line up: the 2 km grid for the full disk,
// 1 km for the higher-res regional sectors (their grids come from the headers —
// the Target sector is steerable and moves).
const HIMAWARI_SCENE_FILES = new Map();

// The app addresses channels by GOES ABI number; AHI numbers the visible bands
// differently (and has no 1.37 µm cirrus band). Map ABI → AHI for file naming;
// null means the channel has no Himawari equivalent.
const ABI_TO_AHI = {
  1: 1, 2: 3, 3: 4, 4: null, 5: 5, 6: 6, 7: 7, 8: 8,
  9: 9, 10: 10, 11: 11, 12: 12, 13: 13, 14: 14, 15: 15, 16: 16,
};
// Native resolution code per AHI band (0.5/1/2 km).
const ahiRes = (b) => (b === 3 ? 'R05' : (b === 1 || b === 2 || b === 4) ? 'R10' : 'R20');

function himawariSegKey(meta, sector, ahiBand, seg) {
  const stamp = `${meta.y}${meta.mm}${meta.dd}_${meta.hhmm}`;
  const segStr = `S${pad(seg)}${pad(sector.segments)}`;
  return `${sector.product}/${meta.y}/${meta.mm}/${meta.dd}/${meta.hhmm}/` +
    `HS_H09_${stamp}_B${pad(ahiBand)}_${sector.region(meta.frame)}_${ahiRes(ahiBand)}_${segStr}.DAT.bz2`;
}

// List the available scene times by walking the day folders for their 10-minute
// HHMM subfolders. Regional sectors expand each folder into its rapid-scan
// frames. Returns the most recent dozen, newest last.
async function listHimawariScenes(bucket, sector, sectorKey, baseDate) {
  const folders = [];
  for (let back = 0; back < 2 && folders.length < 24; back++) {
    const d = new Date(baseDate.getTime() - back * 86400000);
    const y = d.getUTCFullYear(), mm = pad(d.getUTCMonth() + 1), dd = pad(d.getUTCDate());
    const prefix = `${sector.product}/${y}/${mm}/${dd}/`;
    const url = `${bucket}/?list-type=2&prefix=${encodeURIComponent(prefix)}&delimiter=/&max-keys=1000`;
    let res;
    try { res = await fetch(url); } catch (_) { continue; }
    if (!res.ok) continue;
    const xml = await res.text();
    const re = /<Prefix>[^<]*\/(\d{4})\/<\/Prefix>/g;
    let m;
    while ((m = re.exec(xml)) !== null) folders.push({ y, mm, dd, hhmm: m[1] });
  }
  const scenes = new Map();
  for (const f of folders) {
    const base = Date.UTC(+f.y, +f.mm - 1, +f.dd, +f.hhmm.slice(0, 2), +f.hhmm.slice(2));
    for (let frame = 1; frame <= sector.frames; frame++) {
      const time = new Date(base + (frame - 1) * 150000); // ~2.5 min between frames
      const key = `HIMAWARI:${sectorKey}:${f.y}${f.mm}${f.dd}${f.hhmm}:${frame}`;
      scenes.set(key, { ...f, frame, time, key, sectorKey });
    }
  }
  const out = [...scenes.values()].sort((a, b) => a.time - b.time).slice(-12);
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
    return listHimawariScenes(sat.bucket, sector, sectorKey, date || new Date());
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


// Decompress one HSD segment and parse its header: grid size, calibration, CGMS
// navigation (block 3) and the segment's first line (block 7). The 11 fixed
// header blocks are each led by a 1-byte number and a 2-byte length.
function parseHsdHeader(bytes) {
  const raw = decodeBzip2(bytes);
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.length);
  const u16 = (o) => dv.getUint16(o, true);
  const u32 = (o) => dv.getUint32(o, true);
  const f32 = (o) => dv.getFloat32(o, true);
  const f64 = (o) => dv.getFloat64(o, true);

  let off = 0; const blk = {};
  for (let i = 0; i < 11; i++) { blk[raw[off]] = off; off += u16(off + 1); }
  const b2 = blk[2], b3 = blk[3], b5 = blk[5], b7 = blk[7];

  const band = u16(b5 + 3);
  const gain = f64(b5 + 19), cnst = f64(b5 + 27);     // count → radiance
  // Bands 1–6 are visible/near-IR (radiance → albedo via c′); bands 7–16 are
  // thermal IR (radiance → brightness temperature via the inverse Planck law and
  // a band-correction polynomial), matching the GOES path's physical units.
  let calibrate;
  if (band <= 6) {
    const cprime = f64(b5 + 35);
    calibrate = (dn) => cprime * (gain * dn + cnst);
  } else {
    const lam = f64(b5 + 5) * 1e-6;                    // central wavelength, m
    const c0 = f64(b5 + 35), c1 = f64(b5 + 43), c2 = f64(b5 + 51);
    const cL = f64(b5 + 83), hP = f64(b5 + 91), kB = f64(b5 + 99);
    const hck = (hP * cL) / (kB * lam);
    const planckA = (2 * hP * cL * cL) / Math.pow(lam, 5);
    calibrate = (dn) => {
      const I = (gain * dn + cnst) * 1e6;               // W/(m² sr m)
      if (I <= 0) return NaN;
      const Te = hck / Math.log(planckA / I + 1);
      return c0 + c1 * Te + c2 * Te * Te;
    };
  }

  return {
    dv, hdrLen: off, cols: u16(b2 + 5), lines: u16(b2 + 7), band, calibrate,
    errCnt: u16(b5 + 15), outCnt: u16(b5 + 17),         // error / off-scan fill DN
    CFAC: u32(b3 + 11), LFAC: u32(b3 + 15), COFF: f32(b3 + 19), LOFF: f32(b3 + 23),
    firstLine: u16(b7 + 5),
    nav: { subLon: f64(b3 + 3), Rs: f64(b3 + 27), Req: f64(b3 + 35), Rpol: f64(b3 + 43) },
  };
}

// Build the common output grid for a regional sector by scaling a band's native
// CGMS navigation to the chosen common resolution (`commonCFAC`).
function deriveGrid(hdr, commonCFAC) {
  const rC = commonCFAC / hdr.CFAC, rL = commonCFAC / hdr.LFAC;
  return {
    W: Math.round(hdr.cols * rC), H: Math.round(hdr.lines * rL),
    CFAC: commonCFAC, LFAC: commonCFAC,
    COFF: (hdr.COFF - 0.5) * rC + 0.5, LOFF: (hdr.LOFF - 0.5) * rL + 0.5,
  };
}

// Nearest-neighbour resample one segment onto the common grid `out` via the CGMS
// line/column ↔ scan-angle relations, so native grids of any resolution and the
// common grid stay co-registered. Fill / off-grid pixels are left untouched (the
// caller pre-fills NaN).
function resampleHsd(hdr, grid, out) {
  const { dv, hdrLen, cols, lines, errCnt, outCnt, calibrate } = hdr;
  const rC = hdr.CFAC / grid.CFAC, rL = hdr.LFAC / grid.LFAC; // native px per common px
  const segTop = hdr.firstLine - 1;
  for (let cr = 0; cr < grid.H; cr++) {
    const nr = Math.round(hdr.LOFF + (cr + 1 - grid.LOFF) * rL) - 1 - segTop;
    if (nr < 0 || nr >= lines) continue;
    const rowBase = hdrLen + nr * cols * 2;
    const outBase = cr * grid.W;
    for (let cc = 0; cc < grid.W; cc++) {
      const nc = Math.round(hdr.COFF + (cc + 1 - grid.COFF) * rC) - 1;
      if (nc < 0 || nc >= cols) continue;
      const dn = dv.getUint16(rowBase + nc * 2, true);
      if (dn !== errCnt && dn !== outCnt) out[outBase + cc] = calibrate(dn);
    }
  }
}

// Build one ABI channel by downloading and decoding the sector's HSD segments
// for this frame. `gridRef.grid` is established lazily from the first segment for
// regional sectors. Missing segments (a scene still uploading) leave NaN gaps.
async function himawariChannel(bucket, meta, sector, abiBand, gridRef, onProgress) {
  const ahi = ABI_TO_AHI[abiBand];
  const alloc = () => new Float32Array(gridRef.grid.W * gridRef.grid.H).fill(NaN);
  if (ahi == null) return { data: gridRef.grid ? alloc() : null, nav: null };
  let out = null, nav = null;
  for (let s = 1; s <= sector.segments; s++) {
    let bytes;
    try {
      bytes = await fetchBytes(bucket, himawariSegKey(meta, sector, ahi, s),
        onProgress ? (p) => onProgress((s - 1 + p) / sector.segments) : null);
    } catch (_) { continue; }
    const hdr = parseHsdHeader(bytes);
    if (!gridRef.grid) gridRef.grid = sector.grid || deriveGrid(hdr, sector.commonCFAC);
    if (!out) out = alloc();
    resampleHsd(hdr, gridRef.grid, out);
    if (!nav) nav = hdr.nav;
  }
  if (!out && gridRef.grid) out = alloc();
  return { data: out, nav };
}

function himawariScene(meta, channels, nav, grid, sat, key) {
  const g = grid || { W: 5500, H: 5500, CFAC: 20466275, LFAC: 20466275, COFF: 2750.5, LOFF: 2750.5 };
  const kx = (65536 / g.CFAC) * (Math.PI / 180); // scan-angle radians per column
  const ky = (65536 / g.LFAC) * (Math.PI / 180); // scan-angle radians per line
  const n = nav || { subLon: sat.lon0, Rs: 42164, Req: 6378.137, Rpol: 6356.7523 };
  return {
    width: g.W, height: g.H,
    xScale: -kx, xOffset: (g.COFF - 1) * kx,
    yScale: ky, yOffset: (1 - g.LOFF) * ky,
    proj: {
      lon0: (n.subLon || sat.lon0) * Math.PI / 180,
      H: (n.Rs || 42164) * 1000,
      rEq: (n.Req || 6378.137) * 1000,
      rPol: (n.Rpol || 6356.7523) * 1000,
      sweep: 'y',
    },
    channels, time: meta.time, key,
    _himawariMeta: meta, _himawariGrid: g, _satBucket: sat.bucket,
  };
}

async function loadHimawariScene(sat, sectorKey, key, bands, onProgress) {
  const meta = HIMAWARI_SCENE_FILES.get(key);
  if (!meta) throw new Error('Himawari scene index expired; refresh scenes');
  const sector = SECTORS[sectorKey];
  const gridRef = { grid: sector.grid || null };
  // Regional grids come from the headers; bootstrap one if every requested band
  // lacks a Himawari equivalent (e.g. a lone 1.37 µm cirrus channel).
  if (!gridRef.grid && bands.every((b) => ABI_TO_AHI[b] == null)) {
    try {
      const bytes = await fetchBytes(sat.bucket, himawariSegKey(meta, sector, 13, 1));
      gridRef.grid = deriveGrid(parseHsdHeader(bytes), sector.commonCFAC);
    } catch (_) { /* leave empty; the channel will be blank */ }
  }
  const channels = {};
  let nav = null;
  for (let i = 0; i < bands.length; i++) {
    const r = await himawariChannel(sat.bucket, meta, sector, bands[i], gridRef,
      onProgress ? (p) => onProgress((i + p) / bands.length) : null);
    if (r.data) channels[bands[i]] = r.data;
    if (r.nav && !nav) nav = r.nav;
  }
  return himawariScene(meta, channels, nav, gridRef.grid, sat, key);
}

// Download + decode a scene, reading only the channels requested. Returns the
// grid geometry, the geostationary projection constants, and the per-band
// physical arrays — everything satProducts.buildRGBA / satelliteLayer need.
export async function loadScene(satKey, sectorKey, key, bands, onProgress) {
  const sat = SATELLITES[satKey];
  const sector = SECTORS[sectorKey];
  if ((sat.family || 'goes') === 'himawari') return loadHimawariScene(sat, sectorKey, key, bands, onProgress);
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
    const sector = SECTORS[scene._himawariMeta.sectorKey];
    const gridRef = { grid: scene._himawariGrid };
    for (const b of bands) {
      if (scene.channels[b]) continue;
      const r = await himawariChannel(scene._satBucket, scene._himawariMeta, sector, b, gridRef);
      if (r.data) scene.channels[b] = r.data;
    }
    return scene;
  }
  if (!scene._h5) return scene;
  for (const b of bands) {
    if (!scene.channels[b]) scene.channels[b] = await readChannel(scene._h5, b);
  }
  return scene;
}

// Forward fixed-grid navigation: scan angles (x,y in rad) → geodetic lon/lat
// (deg), per the GOES-R PUG. Returns null when the point is off the Earth's limb.
// Used to build the image's lon/lat bounding box for the GL quad. The look
// vector is parameterised by the sweep axis ('x' for GOES, 'y' for Himawari/
// Meteosat) to match the inverse the shader runs; the rest of the solve is the
// same ellipsoid intersection.
export function scanToLonLat(x, y, proj) {
  const { lon0, H, rEq, rPol } = proj;
  let Lx, Ly, Lz;
  if (proj.sweep === 'y') {
    const cy = Math.cos(y);
    Lx = cy * Math.cos(x); Ly = cy * Math.sin(x); Lz = -Math.sin(y);
  } else {
    const cx = Math.cos(x);
    Lx = cx * Math.cos(y); Ly = -Math.sin(x); Lz = cx * Math.sin(y);
  }
  const e = (rEq * rEq) / (rPol * rPol);
  const a = Lx * Lx + Ly * Ly + e * Lz * Lz;
  const b = -2 * H * Lx;
  const c = H * H - rEq * rEq;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const rs = (-b - Math.sqrt(disc)) / (2 * a);
  const sx = rs * Lx, sy = rs * Ly, sz = rs * Lz;
  const lat = Math.atan(e * (sz / Math.sqrt((H - sx) * (H - sx) + sy * sy)));
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
