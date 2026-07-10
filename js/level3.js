// level3.js — NEXRAD Level III product decoder for the single-site viewer.
//
// Where Level II carries the raw polar moments (reflectivity, velocity, …),
// Level III products are the RPG's derived grids. We decode the four the viewer
// exposes — Enhanced Echo Tops and the dual-pol QPE accumulations (1-hr, 3-hr,
// storm-total) — straight from the open `unidata-nexrad-level3` AWS bucket.
//
// All four are "Digital Radial Data Array" products (packet 16): 360 one-degree
// radials of one byte per range bin, in a bzip2-compressed Product Symbology
// Block behind an uncompressed message header + product description block (and,
// in the bucket, a leading WMO/AWIPS text header). Each byte is a level code; the
// physical value is recovered with a per-product linear transform that — by
// design — matches the single-site radar shader's `(code - offset) / scale`, with
// code < 2 meaning "below threshold". So a decoded product slots straight into the
// existing GPU radar layer as a synthetic one-tilt sweep, no new renderer needed.
//
//   • EET (135) — Enhanced Echo Tops, kft. height = (code & 0x7F) − 2; the 0x80
//     bit flags a "topped" (≥) value. We mask the flag and use offset 2, scale 1.
//   • DAA (170) 1-hr · DU3 (173) 3-hr · DTA (172) storm-total — dual-pol QPE.
//     value = (code − offset) / scale, with offset/scale IEEE floats read from the
//     product description block. Critically, that quotient is in *hundredths of an
//     inch* (0.01 in), not mm — the PDB `scale` is per-0.01-inch, so a raw decode
//     overstates the depth ~3.94×. We fold a 0.01-in → mm factor into the stored
//     scale so the native value is true mm, matching the product's own reported
//     max accumulation (and keeping it in the same unit as the mm colour scale).

import { decodeBzip2 } from './bzip2.js';
import { makeScale } from './products.js';
import { loadMrmsFfgGrid } from './mrms.js';

const BUCKET = 'https://unidata-nexrad-level3.s3.amazonaws.com';
const M_PER_DEG_LAT = 111320; // matches the radar layer's flat-earth gate model

// Per-product decode + geometry. `code` is the Level III message code; `space` is
// the range-bin spacing in metres (EET is 1 km, the dual-pol QPE grids 0.25 km).
// The dual-pol QPE products store `scale` as levels per 0.01 inch, so dividing by
// the PDB scale yields hundredths of an inch. One mm is 0.03937 in = 3.937 of those
// hundredths, so multiplying the stored scale by that factor makes the shader's
// `(code − offset) / scale` land in mm — the unit the rest of the QPE pipeline
// (colour scale, mm→in display factor) already expects.
const HUNDREDTHS_IN_PER_MM = 100 / 25.4; // ≈ 3.937
const L3_DECODE = {
  135: { space: 1000, mask: 0x7f, offset: 2, scale: 1 }, // EET: height = (code&0x7f) - 2 kft
  134: { space: 1000 },                                  // DVL  — Digital VIL, kg/m² (offset/scale from the PDB)
  170: { space: 250, scaleMul: HUNDREDTHS_IN_PER_MM },  // DAA  — 1-hr QPE (offset/scale from the PDB)
  173: { space: 250, scaleMul: HUNDREDTHS_IN_PER_MM },  // DUA  — user-selectable accumulation (3-hr in the DU3 feed)
  172: { space: 250, scaleMul: HUNDREDTHS_IN_PER_MM },  // DTA  — storm-total QPE
};
// (Storm-relative velocity is NOT a Level III product here — it's derived from the
// full-resolution Level II velocity field; see js/dealias.js stormRelativeSweep.)

// Decode one Level III file into a synthetic single-tilt "sweep" the radar layer
// can draw, plus the site location and the value transform. Returns null if the
// product isn't one we render.
export function decodeLevel3(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.length);

  // The bucket objects carry a WMO header (`SDUS.. KOUN ..\r\r\n NNNXXX\r\r\n`)
  // before the binary message; skip to just past the second CR-CR-LF.
  let start = 0;
  if (u8[0] >= 32 && u8[0] < 127) {
    let nl = 0;
    for (let i = 0; i < u8.length - 2; i++) {
      if (u8[i] === 13 && u8[i + 1] === 13 && u8[i + 2] === 10) { nl++; i += 2; if (nl === 2) { start = i + 1; break; } }
    }
  }
  const i16 = (o) => dv.getInt16(start + o, false);
  const i32 = (o) => dv.getInt32(start + o, false);
  const f32 = (o) => dv.getFloat32(start + o, false);

  const code = i16(0);
  const dec = L3_DECODE[code];
  if (!dec) return null;

  // Product Description Block follows the 18-byte message header. ICD halfword H
  // is at byte (H-1)*2 from the message start (the numbering spans both blocks).
  const hb = (H) => (H - 1) * 2;
  const lat = i32(hb(11)) / 1000;
  const lon = i32(hb(13)) / 1000;

  // Symbology block sits right after the 102-byte PDB and is bzip2-compressed.
  const symStart = start + 18 + 102;
  const sym = (u8[symStart] === 0x42 && u8[symStart + 1] === 0x5a && u8[symStart + 2] === 0x68)
    ? decodeBzip2(u8.subarray(symStart))
    : u8.subarray(symStart);
  const sd = new DataView(sym.buffer, sym.byteOffset, sym.length);
  const s16 = (o) => sd.getInt16(o, false);

  const offset = dec.offset != null ? dec.offset : f32(hb(33));
  const scale = (dec.scale != null ? dec.scale : f32(hb(31))) * (dec.scaleMul || 1);

  // Symbology header (10 B) + one layer header (6 B) → first packet at byte 16.
  // Packet 16 header: code, firstBin, numBins, iCenter, jCenter, scale, nRadials.
  let p = 16;
  if (s16(p) !== 16) throw new Error(`Level III: unexpected packet ${s16(p)}`);
  const numBins = s16(p + 4);
  const numRadials = s16(p + 12);
  let o = p + 14;
  const mask = dec.mask || 0xff;
  const radials = new Array(numRadials);
  for (let r = 0; r < numRadials; r++) {
    const nbytes = s16(o);
    const azimuth = s16(o + 2) / 10; // start angle, 0.1° → degrees
    o += 6;
    // One byte per bin → a 16-bit code array the radar grid builder consumes.
    const codes = new Uint16Array(numBins);
    const n = Math.min(nbytes, numBins);
    for (let b = 0; b < n; b++) codes[b] = sym[o + b] & mask;
    o += nbytes;
    radials[r] = { azimuth, moments: { L3: {
      raw: codes, gateCount: numBins, firstGate: 0, gateSpacing: dec.space, offset, scale,
    } } };
  }
  return { code, lat, lon, numBins, gateSpacing: dec.space, offset, scale, sweep: { radials } };
}

// ---- colour scales ----------------------------------------------------------
const seg = (stops) => makeScale(stops.map(([v, c]) => ({ v, c1: [c[0], c[1], c[2], 255], c2: null })));

// Echo-top height (kft): low tops blue, towering tops red→magenta.
const ETOPS_SCALE = seg([
  [5, [90, 100, 170]], [10, [40, 130, 205]], [20, [40, 180, 150]], [30, [120, 200, 80]],
  [40, [235, 220, 60]], [50, [240, 150, 50]], [60, [220, 60, 50]], [70, [205, 40, 165]],
]);
// Precipitation accumulation (mm), shared by the QPE products.
const QPE_SCALE = seg([
  [0.2, [120, 200, 255]], [5, [0, 120, 240]], [15, [0, 200, 120]], [30, [230, 220, 0]],
  [60, [255, 120, 0]], [100, [220, 0, 0]], [150, [180, 0, 90]], [250, [255, 0, 255]],
]);
// Vertically integrated liquid (kg/m²): light blue/green at low VIL through
// yellow/orange/red to magenta at the high values that flag hail potential.
const VIL_SCALE = seg([
  [0.1, [120, 200, 255]], [5, [0, 150, 230]], [10, [0, 200, 130]], [20, [120, 215, 70]],
  [30, [235, 225, 60]], [40, [240, 160, 50]], [50, [225, 70, 50]], [65, [180, 30, 90]],
  [80, [240, 90, 240]],
]);
// Flash-flood-guidance exceedance (mm over guidance) — only positive overages are
// ever coloured (sub-guidance gates go transparent), graduating pale-yellow →
// magenta with the depth of the overage. Mirrors the MRMS exceedance ramp.
const EXCEED_SCALE = seg([
  [1, [255, 245, 140]], [5, [255, 210, 0]], [12, [255, 150, 0]], [25, [255, 70, 0]],
  [50, [210, 0, 0]], [90, [150, 0, 90]], [127, [255, 0, 255]],
]);
const MM_TO_IN = 0.0393700787;

// Single-site Level III products, keyed by the id used in the radar product
// picker. `bucketCode` is the three-letter product token in the S3 key.
// `moment: 'L3'` + `dispOffset` let these stand in for a single-site radar product
// anywhere the app reads one (legend, cursor readout, the GPU layer's `(code -
// offset) / scale`). The per-frame offset/scale live on the decoded sweep's moment.
const l3 = (id, name, bucketCode, msgCode, unit, scale, disp) =>
  ({ id, name, bucketCode, msgCode, unit, scale, moment: 'L3', dispUnit: disp.unit, dispFactor: disp.factor, dispOffset: 0 });

// A custom FFG-exceedance product: it lists/decodes the single-site QPE frames of
// `bucketCode` (DAA 1-hr / DUA 3-hr), then subtracts the MRMS-derived guidance grid
// (recovered from radar QPE ÷ FLASH ratio for `qpeFolder`/`ffgFolder`) sampled at
// each polar gate. `custom: 'ffgx'` routes loadLevel3() to the exceedance path.
function ffgx(id, name, bucketCode, msgCode, qpeFolder, ffgFolder) {
  const p = l3(id, name, bucketCode, msgCode, 'mm', EXCEED_SCALE, { unit: 'in', factor: MM_TO_IN });
  p.custom = 'ffgx';
  p.qpeFolder = qpeFolder;
  p.ffgFolder = ffgFolder;
  return p;
}

export const L3_PRODUCTS = {
  ET: l3('ET', 'Echo Tops', 'EET', 135, 'kft', ETOPS_SCALE, { unit: 'kft', factor: 1 }),
  VIL: l3('VIL', 'Vert. Int. Liquid', 'DVL', 134, 'kg/m²', VIL_SCALE, { unit: 'kg/m²', factor: 1 }),
  PR1: l3('PR1', '1-hr Precip', 'DAA', 170, 'mm', QPE_SCALE, { unit: 'in', factor: MM_TO_IN }),
  PR3: l3('PR3', '3-hr Precip', 'DU3', 173, 'mm', QPE_SCALE, { unit: 'in', factor: MM_TO_IN }),
  PRT: l3('PRT', 'Storm Total Precip', 'DTA', 172, 'mm', QPE_SCALE, { unit: 'in', factor: MM_TO_IN }),
  FFX1: ffgx('FFX1', '1-hr FFG Exceedance', 'DAA', 170, 'RadarOnly_QPE_01H_00.00', 'FLASH_QPE_FFG01H_00.00'),
  FFX3: ffgx('FFX3', '3-hr FFG Exceedance', 'DU3', 173, 'RadarOnly_QPE_03H_00.00', 'FLASH_QPE_FFG03H_00.00'),
};
export const L3_ORDER = ['ET', 'VIL', 'PR1', 'PR3', 'PRT', 'FFX1', 'FFX3'];

const ENC_SCALE = 10;         // exceedance gate code → mm (0.1 mm per step)
const EXCEED_FLOOR_MM = 0.25; // ignore sub-quarter-mm overage (radar QPE resolution)

export function isL3Product(id) {
  return Object.prototype.hasOwnProperty.call(L3_PRODUCTS, id);
}

// The Level III site token is the ICAO without its leading region letter
// (KTLX→TLX, TJUA→JUA).
function siteToken(icao) {
  return (icao || '').toUpperCase().slice(1);
}

const pad = (n) => String(n).padStart(2, '0');

function timeForKey(key) {
  const m = key.match(/_(\d{4})_(\d{2})_(\d{2})_(\d{2})_(\d{2})_(\d{2})$/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
}

// List the available frames for a product at a site on a UTC day, newest last.
export async function listLevel3(site, productId, date) {
  const prod = L3_PRODUCTS[productId];
  if (!prod) throw new Error('unknown Level III product');
  const ymd = `${date.getUTCFullYear()}_${pad(date.getUTCMonth() + 1)}_${pad(date.getUTCDate())}`;
  const prefix = `${siteToken(site)}_${prod.bucketCode}_${ymd}`;
  const url = `${BUCKET}/?list-type=2&prefix=${encodeURIComponent(prefix)}&max-keys=1000`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Level III list failed: ${res.status}`);
  const xml = await res.text();
  const keys = [];
  const re = /<Key>([^<]+)<\/Key>/g;
  let m;
  while ((m = re.exec(xml)) !== null) keys.push(m[1]);
  keys.sort();
  return keys.map((key) => {
    const t = timeForKey(key);
    return { key, time: t, label: t ? `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}Z` : key };
  });
}

export async function fetchLevel3(key, onProgress) {
  const res = await fetch(`${BUCKET}/${key}`);
  if (!res.ok) throw new Error(`Level III download failed: ${res.status}`);
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

// Download + decode one frame into the sweep + product the radar layer draws.
export async function loadLevel3(site, productId, key, onProgress) {
  const prod = L3_PRODUCTS[productId];
  if (prod && prod.custom === 'ffgx') return loadLevel3Exceedance(site, productId, key, onProgress);
  const bytes = await fetchLevel3(key, onProgress);
  const decoded = decodeLevel3(bytes);
  if (!decoded) throw new Error('unsupported Level III product');
  return { decoded, product: prod, time: timeForKey(key), key };
}

// A nearest-cell sampler over an MRMS lat/lon grid, in guidance mm (NaN off-grid).
function ffgSampler(ffg) {
  const { ni, nj, lon1, lat1, di, dj, values } = ffg;
  return (lon, lat) => {
    const ci = Math.round((lon - lon1) / di);
    const cj = Math.round((lat1 - lat) / dj);
    if (ci < 0 || ci >= ni || cj < 0 || cj >= nj) return NaN;
    return values[cj * ni + ci];
  };
}

// Re-encode a decoded single-site QPE sweep in place as guidance exceedance: for
// each gate, project it to lon/lat (same flat-earth model the radar shader uses),
// look up the guidance there, and store the overage (QPE − FFG) as a 0.1-mm code.
// Gates with no rain, no guidance, or at/below guidance become code 0 → transparent.
function applyExceedance(decoded, ffg) {
  const siteLat = decoded.lat, siteLon = decoded.lon;
  const mPerDegLon = M_PER_DEG_LAT * Math.cos((siteLat * Math.PI) / 180);
  const sample = ffgSampler(ffg);
  for (const rad of decoded.sweep.radials) {
    const m = rad.moments.L3;
    const { raw, gateCount, firstGate, gateSpacing, offset, scale } = m;
    const out = new Uint16Array(gateCount);
    const azr = (rad.azimuth * Math.PI) / 180;
    const sinA = Math.sin(azr), cosA = Math.cos(azr);
    for (let g = 0; g < gateCount; g++) {
      const code = raw[g];
      if (code < 2) continue;                 // below threshold / no QPE
      const qpe = (code - offset) / scale;     // mm observed
      if (!(qpe > 0)) continue;
      const range = firstGate + g * gateSpacing;
      const lat = siteLat + (range * cosA) / M_PER_DEG_LAT;
      const lon = siteLon + (range * sinA) / mPerDegLon;
      const fg = sample(lon, lat);             // mm guidance
      if (!(fg >= 0)) continue;                // NaN / no guidance
      const exc = qpe - fg;
      if (exc >= EXCEED_FLOOR_MM)
        out[g] = Math.min(65535, Math.max(2, Math.round(exc * ENC_SCALE)));
    }
    rad.moments.L3 = { raw: out, gateCount, firstGate, gateSpacing, offset: 0, scale: ENC_SCALE };
  }
  decoded.offset = 0;
  decoded.scale = ENC_SCALE;
}

// Guidance grids change slowly (issued ~hourly), so cache the derived FFG field by
// UTC-hour bucket — stepping radar frames within an hour reuses one MRMS pull.
const ffgGridCache = new Map();
function cachedFfgGrid(qpeFolder, ffgFolder, when, onProgress) {
  const b = `${qpeFolder}|${ffgFolder}|${when.getUTCFullYear()}${pad(when.getUTCMonth() + 1)}${pad(when.getUTCDate())}${pad(when.getUTCHours())}`;
  if (!ffgGridCache.has(b)) {
    const job = loadMrmsFfgGrid(qpeFolder, ffgFolder, when, onProgress)
      .catch((e) => { ffgGridCache.delete(b); throw e; });
    ffgGridCache.set(b, job);
    if (ffgGridCache.size > 4) ffgGridCache.delete(ffgGridCache.keys().next().value);
  }
  return ffgGridCache.get(b);
}

// Load one custom exceedance frame: the site's QPE accumulation minus the MRMS-
// derived guidance grid, sampled onto the QPE sweep's gates.
async function loadLevel3Exceedance(site, productId, key, onProgress) {
  const prod = L3_PRODUCTS[productId];
  const bytes = await fetchLevel3(key, (p) => onProgress && onProgress(p * 0.4));
  const decoded = decodeLevel3(bytes);
  if (!decoded) throw new Error('unsupported Level III product');
  const time = timeForKey(key);
  const ffg = await cachedFfgGrid(prod.qpeFolder, prod.ffgFolder, time || new Date(),
    (p) => onProgress && onProgress(0.4 + p * 0.6));
  applyExceedance(decoded, ffg);
  return { decoded, product: prod, time, key };
}
