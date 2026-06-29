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
// Echo-top height (km) ramp — short/warm storms blue, tall (severe) tops red→magenta.
const ETOP = [
  s(2, [40, 60, 120]), s(5, [0, 150, 210]), s(8, [0, 200, 120]),
  s(10, [230, 220, 0]), s(12, [255, 150, 0]), s(15, [220, 0, 0]), s(18, [255, 0, 255]),
];
// Vertically Integrated Liquid (kg/m²) ramp — high VIL flags hail cores.
const VILR = [
  s(1, [40, 60, 120]), s(5, [0, 150, 210]), s(10, [0, 200, 120]),
  s(20, [230, 220, 0]), s(35, [255, 150, 0]), s(50, [220, 0, 0]), s(70, [255, 0, 255]),
];
// Instantaneous precipitation rate (mm/hr) ramp.
const PRATE = [
  s(0.5, [120, 200, 255]), s(2, [0, 120, 240]), s(5, [0, 200, 120]),
  s(10, [230, 220, 0]), s(25, [255, 120, 0]), s(50, [220, 0, 0]), s(100, [255, 0, 255]),
];
// Cloud-to-ground lightning density (flashes / km² / min) ramp.
const LDEN = [
  s(0.05, [40, 40, 70]), s(0.2, [0, 120, 220]), s(0.5, [0, 200, 120]),
  s(1, [230, 220, 0]), s(2, [255, 120, 0]), s(5, [220, 0, 0]), s(10, [255, 0, 255]),
];
// FLASH average-recurrence-interval (years) ramp — how rare the observed rainfall
// is; longer recurrence (rarer event) shades toward red/magenta.
const ARI = [
  s(0.5, [40, 60, 120]), s(1, [0, 150, 210]), s(2, [0, 200, 120]),
  s(5, [230, 220, 0]), s(10, [255, 150, 0]), s(25, [220, 0, 0]), s(100, [255, 0, 255]),
];
// FLASH QPE-to-flash-flood-guidance ratio (unitless) ramp — values ≥1 mean the
// observed rainfall has met/exceeded guidance, the flash-flood threshold.
const FFG = [
  s(0.25, [40, 60, 120]), s(0.5, [0, 150, 210]), s(0.75, [0, 200, 120]),
  s(1, [230, 220, 0]), s(1.5, [255, 120, 0]), s(2, [220, 0, 0]), s(3, [255, 0, 255]),
];

const MM_TO_IN = 0.0393700787;
const KM_TO_KFT = 3.2808399; // km → thousands of feet

// `disp` { unit, factor } gives an imperial display conversion for legend ticks
// and the inspect readout, leaving the native values/colors untouched.
function product(id, folder, name, unit, lo, hi, floor, stops, disp) {
  const scale = makeScale(stops);
  const dispUnit = (disp && disp.unit) || unit;
  const dispFactor = (disp && disp.factor) || 1;
  return { id, folder, name, unit, lo, hi, floor, scale, dispUnit, dispFactor, dispOffset: 0 };
}

export const MRMS_PRODUCTS = {
  // ---- Reflectivity variants ----
  REFC: product('REFC', 'MergedReflectivityQCComposite_00.50', 'Composite Reflectivity', 'dBZ', 5, 75, 5, REFL),
  LLREF: product('LLREF', 'LowLevelCompositeReflectivity_00.50', 'Low-Level Composite Refl.', 'dBZ', 5, 75, 5, REFL),
  RALA: product('RALA', 'MergedReflectivityAtLowestAltitude_00.50', 'Refl. at Lowest Altitude', 'dBZ', 5, 75, 5, REFL),
  REF0C: product('REF0C', 'Reflectivity_0C_00.50', 'Reflectivity at 0°C', 'dBZ', 5, 75, 5, REFL),
  REFM20C: product('REFM20C', 'Reflectivity_-20C_00.50', 'Reflectivity at −20°C', 'dBZ', 5, 75, 5, REFL),
  // ---- Echo tops ----
  HREET: product('HREET', 'LVL3_HREET_00.50', 'Enhanced Echo Top (18 dBZ)', 'km', 0, 18, 0.5, ETOP, { unit: 'kft', factor: KM_TO_KFT }),
  ET18: product('ET18', 'EchoTop_18_00.50', '18 dBZ Echo Top', 'km', 0, 18, 0.5, ETOP, { unit: 'kft', factor: KM_TO_KFT }),
  ET30: product('ET30', 'EchoTop_30_00.50', '30 dBZ Echo Top', 'km', 0, 18, 0.5, ETOP, { unit: 'kft', factor: KM_TO_KFT }),
  ET50: product('ET50', 'EchoTop_50_00.50', '50 dBZ Echo Top', 'km', 0, 18, 0.5, ETOP, { unit: 'kft', factor: KM_TO_KFT }),
  ET60: product('ET60', 'EchoTop_60_00.50', '60 dBZ Echo Top', 'km', 0, 18, 0.5, ETOP, { unit: 'kft', factor: KM_TO_KFT }),
  // ---- Vertically integrated liquid / ice ----
  VIL: product('VIL', 'VIL_00.50', 'Vert. Integrated Liquid', 'kg/m²', 0, 70, 0.5, VILR),
  VILD: product('VILD', 'VIL_Density_00.50', 'VIL Density', 'g/m³', 0, 6, 0.1, VILR.map((k) => ({ ...k, v: k.v / 11.7 }))),
  VIL2H: product('VIL2H', 'VIL_Max_120min_00.50', '2-hr Max VIL', 'kg/m²', 0, 70, 0.5, VILR),
  VIL24H: product('VIL24H', 'VIL_Max_1440min_00.50', '24-hr Max VIL', 'kg/m²', 0, 70, 0.5, VILR),
  VII: product('VII', 'VII_00.50', 'Vert. Integrated Ice', 'kg/m²', 0, 40, 0.5, VILR.map((k) => ({ ...k, v: k.v * 0.57 }))),
  // ---- Rotation (low-level 0–2 km AGL and mid-level 3–6 km AGL) ----
  AZSHEAR: product('AZSHEAR', 'MergedAzShear_0-2kmAGL_00.50', 'AzShear 0–2 km (Instant Rotation)', '10⁻³ s⁻¹', 2, 40, 2, ROT),
  AZSHEAR36: product('AZSHEAR36', 'MergedAzShear_3-6kmAGL_00.50', 'AzShear 3–6 km (Mid-Level)', '10⁻³ s⁻¹', 2, 40, 2, ROT),
  ROT1H: product('ROT1H', 'RotationTrack60min_00.50', '1-hr Rotation Track 0–2 km', '10⁻³ s⁻¹', 2, 40, 2, ROT),
  ROT6H: product('ROT6H', 'RotationTrack360min_00.50', '6-hr Rotation Track 0–2 km', '10⁻³ s⁻¹', 2, 40, 2, ROT),
  ROT24H: product('ROT24H', 'RotationTrack1440min_00.50', '24-hr Rotation Track 0–2 km', '10⁻³ s⁻¹', 2, 40, 2, ROT),
  ROTML1H: product('ROTML1H', 'RotationTrackML60min_00.50', '1-hr Rotation Track 3–6 km', '10⁻³ s⁻¹', 2, 40, 2, ROT),
  ROTML6H: product('ROTML6H', 'RotationTrackML360min_00.50', '6-hr Rotation Track 3–6 km', '10⁻³ s⁻¹', 2, 40, 2, ROT),
  ROTML24H: product('ROTML24H', 'RotationTrackML1440min_00.50', '24-hr Rotation Track 3–6 km', '10⁻³ s⁻¹', 2, 40, 2, ROT),
  // ---- Hail ----
  MESH: product('MESH', 'MESH_00.50', 'Max Estimated Hail Size', 'mm', 0, 100, 0.5, HAIL, { unit: 'in', factor: MM_TO_IN }),
  MESH1H: product('MESH1H', 'MESH_Max_60min_00.50', '1-hr Max Hail Size', 'mm', 0, 100, 0.5, HAIL, { unit: 'in', factor: MM_TO_IN }),
  MESH6H: product('MESH6H', 'MESH_Max_360min_00.50', '6-hr Max Hail Size', 'mm', 0, 100, 0.5, HAIL, { unit: 'in', factor: MM_TO_IN }),
  MESH24H: product('MESH24H', 'MESH_Max_1440min_00.50', '24-hr Max Hail Size', 'mm', 0, 100, 0.5, HAIL, { unit: 'in', factor: MM_TO_IN }),
  POSH: product('POSH', 'POSH_00.50', 'Prob. of Severe Hail', '%', 0, 100, 1, PROB),
  SHI: product('SHI', 'SHI_00.50', 'Severe Hail Index', '', 0, 200, 1, HAIL.map((k) => ({ ...k, v: k.v * 2 }))),
  // ---- Lightning ----
  LTG30: product('LTG30', 'LightningProbabilityNext30minGrid_scale_1', '30-min CG Lightning Prob.', '%', 0, 100, 1, PROB),
  LTG60: product('LTG60', 'LightningProbabilityNext60minGrid_scale_1', '60-min CG Lightning Prob.', '%', 0, 100, 1, PROB),
  CGD1: product('CGD1', 'NLDN_CG_001min_AvgDensity_00.00', '1-min CG Lightning Density', 'fl/km²/min', 0, 10, 0.05, LDEN),
  CGD5: product('CGD5', 'NLDN_CG_005min_AvgDensity_00.00', '5-min CG Lightning Density', 'fl/km²/min', 0, 10, 0.05, LDEN),
  CGD15: product('CGD15', 'NLDN_CG_015min_AvgDensity_00.00', '15-min CG Lightning Density', 'fl/km²/min', 0, 10, 0.05, LDEN),
  CGD30: product('CGD30', 'NLDN_CG_030min_AvgDensity_00.00', '30-min CG Lightning Density', 'fl/km²/min', 0, 10, 0.05, LDEN),
  // ---- Flooding (FLASH average recurrence interval + QPE-to-FFG ratio) ----
  ARI1H: product('ARI1H', 'FLASH_QPE_ARI01H_00.00', '1-hr Avg. Recurrence Interval', 'yr', 0, 100, 0.25, ARI),
  ARI3H: product('ARI3H', 'FLASH_QPE_ARI03H_00.00', '3-hr Avg. Recurrence Interval', 'yr', 0, 100, 0.25, ARI),
  ARI6H: product('ARI6H', 'FLASH_QPE_ARI06H_00.00', '6-hr Avg. Recurrence Interval', 'yr', 0, 100, 0.25, ARI),
  ARI24H: product('ARI24H', 'FLASH_QPE_ARI24H_00.00', '24-hr Avg. Recurrence Interval', 'yr', 0, 100, 0.25, ARI),
  ARIMAX: product('ARIMAX', 'FLASH_QPE_ARIMAX_00.00', 'Max Avg. Recurrence Interval', 'yr', 0, 100, 0.25, ARI),
  FFG1H: product('FFG1H', 'FLASH_QPE_FFG01H_00.00', '1-hr QPE/FFG Ratio', '', 0, 3, 0.1, FFG),
  FFG3H: product('FFG3H', 'FLASH_QPE_FFG03H_00.00', '3-hr QPE/FFG Ratio', '', 0, 3, 0.1, FFG),
  FFG6H: product('FFG6H', 'FLASH_QPE_FFG06H_00.00', '6-hr QPE/FFG Ratio', '', 0, 3, 0.1, FFG),
  FFGMAX: product('FFGMAX', 'FLASH_QPE_FFGMAX_00.00', 'Max QPE/FFG Ratio', '', 0, 3, 0.1, FFG),
  // ---- Precipitation accumulation (rate + multi-sensor QPE accumulations) ----
  PRATE: product('PRATE', 'PrecipRate_00.00', 'Precip Rate', 'mm/hr', 0, 100, 0.2, PRATE, { unit: 'in/hr', factor: MM_TO_IN }),
  QPE1H: product('QPE1H', 'MultiSensor_QPE_01H_Pass2_00.00', '1-hr Precip Total', 'mm', 0, 50, 0.2, QPE, { unit: 'in', factor: MM_TO_IN }),
  QPE3H: product('QPE3H', 'MultiSensor_QPE_03H_Pass2_00.00', '3-hr Precip Total', 'mm', 0, 75, 0.2, QPE, { unit: 'in', factor: MM_TO_IN }),
  QPE6H: product('QPE6H', 'MultiSensor_QPE_06H_Pass2_00.00', '6-hr Precip Total', 'mm', 0, 100, 0.2, QPE, { unit: 'in', factor: MM_TO_IN }),
  QPE12H: product('QPE12H', 'MultiSensor_QPE_12H_Pass2_00.00', '12-hr Precip Total', 'mm', 0, 150, 0.2, QPE, { unit: 'in', factor: MM_TO_IN }),
  QPE24H: product('QPE24H', 'MultiSensor_QPE_24H_Pass2_00.00', '24-hr Precip Total', 'mm', 0, 200, 0.2, QPE, { unit: 'in', factor: MM_TO_IN }),
  QPE48H: product('QPE48H', 'MultiSensor_QPE_48H_Pass2_00.00', '48-hr Precip Total', 'mm', 0, 250, 0.2, QPE, { unit: 'in', factor: MM_TO_IN }),
  QPE72H: product('QPE72H', 'MultiSensor_QPE_72H_Pass2_00.00', '72-hr Precip Total', 'mm', 0, 300, 0.2, QPE, { unit: 'in', factor: MM_TO_IN }),
  QPEST: product('QPEST', 'RadarOnly_QPE_Since12Z_00.00', 'Storm Total (since 12Z)', 'mm', 0, 250, 0.2, QPE, { unit: 'in', factor: MM_TO_IN }),
};

// The MRMS reflectivity products all share the single-site radar reflectivity
// color table (resolved at render time in app.js), so every dBZ field looks the
// same and a user-loaded reflectivity .pal applies to all of them — not just the
// composite.
for (const id of ['REFC', 'LLREF', 'RALA', 'REF0C', 'REFM20C']) {
  MRMS_PRODUCTS[id].reflectivity = true;
}

// MRMS products grouped into the menu sections the picker renders, in the order
// they appear. MRMS_ORDER is derived from these so anything listed here is part
// of the catalogue.
export const MRMS_CATEGORIES = [
  { id: 'precip', name: 'Precip Accumulation', products: ['PRATE', 'QPE1H', 'QPE3H', 'QPE6H', 'QPE12H', 'QPE24H', 'QPE48H', 'QPE72H', 'QPEST'] },
  { id: 'hail', name: 'Hail', products: ['MESH', 'MESH1H', 'MESH6H', 'MESH24H', 'POSH', 'SHI'] },
  { id: 'rotation', name: 'Rotation', products: ['AZSHEAR', 'AZSHEAR36', 'ROT1H', 'ROT6H', 'ROT24H', 'ROTML1H', 'ROTML6H', 'ROTML24H'] },
  { id: 'lightning', name: 'Lightning', products: ['LTG30', 'LTG60', 'CGD1', 'CGD5', 'CGD15', 'CGD30'] },
  { id: 'flooding', name: 'Flooding', products: ['ARI1H', 'ARI3H', 'ARI6H', 'ARI24H', 'ARIMAX', 'FFG1H', 'FFG3H', 'FFG6H', 'FFGMAX'] },
  { id: 'echotops', name: 'Echo Tops', products: ['HREET', 'ET18', 'ET30', 'ET50', 'ET60'] },
  { id: 'vil', name: 'Vertically Integrated Liquid', products: ['VIL', 'VILD', 'VIL2H', 'VIL24H', 'VII'] },
  { id: 'reflectivity', name: 'Reflectivity', products: ['REFC', 'LLREF', 'RALA', 'REF0C', 'REFM20C'] },
];

export const MRMS_ORDER = MRMS_CATEGORIES.flatMap((c) => c.products);

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
