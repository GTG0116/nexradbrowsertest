// mrms.js — list and load NOAA MRMS (Multi-Radar Multi-Sensor) gridded products
// from the open `noaa-mrms-pds` AWS bucket, decoded with grib2.js.
//
// Keys look like:
//   CONUS/<ProductFolder>/<YYYYMMDD>/MRMS_<Product>_<YYYYMMDD>-<HHMMSS>.grib2.gz
// The bucket is CORS-enabled for listing and GET, like the radar/satellite ones.

import { decodeGrib2 } from './grib2.js';
import { makeScale } from './products.js';

const BUCKET = 'https://noaa-mrms-pds.s3.amazonaws.com';

const s = (v, c) => ({ v, c1: [...c, 255], c2: null });

// Reflectivity ramp (matches the radar REF look) for the composite product.
const REFL = [
  s(5, [4, 233, 231]), s(15, [3, 0, 244]), s(25, [1, 197, 1]), s(35, [253, 248, 2]),
  s(45, [253, 149, 0]), s(55, [212, 0, 0]), s(65, [248, 0, 253]), s(75, [253, 253, 253]),
];
// Rotation / shear ramp (blue→yellow→red→magenta) for AzShear & rotation tracks.
// MRMS packs azimuthal shear in native units of 10⁻³ s⁻¹ (so a decoded value of
// 20 ≈ 0.020 s⁻¹, a strong mesocyclone), on the 0.005° super-res grid. We colour
// in those native units and label the legend accordingly.
const ROT = [
  s(2, [40, 40, 70]), s(4, [0, 120, 220]), s(8, [0, 200, 120]),
  s(12, [230, 220, 0]), s(16, [255, 120, 0]), s(24, [220, 0, 0]), s(40, [255, 0, 255]),
];
// Hail size (mm) ramp.
const HAIL = [
  s(0, [90, 150, 255]), s(20, [0, 200, 120]), s(30, [230, 220, 0]),
  s(45, [255, 120, 0]), s(60, [220, 0, 0]), s(100, [255, 0, 255]),
];
// Probability (%) ramp.
const PROB = [
  s(0, [40, 40, 70]), s(20, [0, 120, 220]), s(40, [0, 200, 120]),
  s(60, [230, 220, 0]), s(80, [255, 120, 0]), s(100, [220, 0, 0]),
];
// Precipitation accumulation (mm) ramp.
const QPE = [
  s(0.2, [120, 200, 255]), s(5, [0, 120, 240]), s(15, [0, 200, 120]),
  s(30, [230, 220, 0]), s(60, [255, 120, 0]), s(100, [220, 0, 0]),
  s(150, [180, 0, 90]), s(250, [255, 0, 255]),
];

const MM_TO_IN = 0.0393700787;

// `disp` { unit, factor } gives an imperial display conversion for legend ticks
// and the inspect readout, leaving the native values/colors untouched.
function product(id, folder, name, unit, lo, hi, floor, stops, disp) {
  const scale = makeScale(stops);
  const dispUnit = (disp && disp.unit) || unit;
  const dispFactor = (disp && disp.factor) || 1;
  return { id, folder, name, unit, lo, hi, floor, scale, dispUnit, dispFactor, dispOffset: 0 };
}

export const MRMS_PRODUCTS = {
  REFC: product('REFC', 'MergedReflectivityQCComposite_00.50', 'Composite Reflectivity', 'dBZ', 5, 75, 5, REFL),
  AZSHEAR: product('AZSHEAR', 'MergedAzShear_0-2kmAGL_00.50', 'AzShear 0–2 km (Instant Rotation)', '10⁻³ s⁻¹', 2, 40, 2, ROT),
  ROT1H: product('ROT1H', 'RotationTrack60min_00.50', '1-hr Rotation Track', '10⁻³ s⁻¹', 2, 40, 2, ROT),
  ROT6H: product('ROT6H', 'RotationTrack360min_00.50', '6-hr Rotation Track', '10⁻³ s⁻¹', 2, 40, 2, ROT),
  ROT24H: product('ROT24H', 'RotationTrack1440min_00.50', '24-hr Rotation Track', '10⁻³ s⁻¹', 2, 40, 2, ROT),
  MESH: product('MESH', 'MESH_00.50', 'Max Estimated Hail Size', 'mm', 0, 100, 0.5, HAIL, { unit: 'in', factor: MM_TO_IN }),
  POSH: product('POSH', 'POSH_00.50', 'Prob. of Severe Hail', '%', 0, 100, 1, PROB),
  LTG30: product('LTG30', 'LightningProbabilityNext30minGrid_scale_1', '30-min CG Lightning Prob.', '%', 0, 100, 1, PROB),
  QPE1H: product('QPE1H', 'MultiSensor_QPE_01H_Pass2_00.00', '1-hr Precip Total', 'mm', 0, 50, 0.2, QPE, { unit: 'in', factor: MM_TO_IN }),
  QPE6H: product('QPE6H', 'MultiSensor_QPE_06H_Pass2_00.00', '6-hr Precip Total', 'mm', 0, 100, 0.2, QPE, { unit: 'in', factor: MM_TO_IN }),
  QPE24H: product('QPE24H', 'MultiSensor_QPE_24H_Pass2_00.00', '24-hr Precip Total', 'mm', 0, 200, 0.2, QPE, { unit: 'in', factor: MM_TO_IN }),
};

// Composite reflectivity shares the single-site radar reflectivity color table
// (resolved at render time in app.js), so all reflectivity looks the same and a
// user-loaded reflectivity .pal applies here too.
MRMS_PRODUCTS.REFC.reflectivity = true;

export const MRMS_ORDER = [
  'REFC', 'AZSHEAR', 'ROT1H', 'ROT6H', 'ROT24H',
  'MESH', 'POSH', 'LTG30', 'QPE1H', 'QPE6H', 'QPE24H',
];

const pad = (n, w = 2) => String(n).padStart(w, '0');

function timeForKey(key) {
  const m = key.match(/_(\d{8})-(\d{6})\./);
  if (!m) return null;
  const d = m[1], t = m[2];
  return new Date(Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8),
    +t.slice(0, 2), +t.slice(2, 4), +t.slice(4, 6)));
}

function labelForKey(key) {
  const t = timeForKey(key);
  return t ? `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}Z` : key.split('/').pop();
}

// List the available frames for a product on a UTC day, newest last.
export async function listMrms(productId, date) {
  const prod = MRMS_PRODUCTS[productId];
  if (!prod) throw new Error('unknown MRMS product');
  const ymd = `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`;
  const prefix = `CONUS/${prod.folder}/${ymd}/`;
  const url = `${BUCKET}/?list-type=2&prefix=${encodeURIComponent(prefix)}&max-keys=1000`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`MRMS list failed: ${res.status}`);
  const xml = await res.text();
  const keys = [];
  const re = /<Key>([^<]+)<\/Key>/g;
  let m;
  while ((m = re.exec(xml)) !== null) keys.push(m[1]);
  keys.sort();
  return keys.map((key) => ({ key, label: labelForKey(key), time: timeForKey(key) }));
}

export async function fetchMrms(key, onProgress) {
  const res = await fetch(`${BUCKET}/${key}`);
  if (!res.ok) throw new Error(`MRMS download failed: ${res.status}`);
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

// Download + decode one MRMS frame into a lat/lon grid of physical values.
export async function loadMrms(productId, key, onProgress) {
  const bytes = await fetchMrms(key, onProgress);
  const grid = await decodeGrib2(bytes);
  grid.product = MRMS_PRODUCTS[productId];
  grid.time = timeForKey(key);
  grid.key = key;
  return grid;
}
