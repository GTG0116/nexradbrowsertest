// observations.js -- live analysis grids from NOAA RTMA on AWS, decoded with the
// same browser-side GRIB2 reader used by MRMS and models.

import { decodeGrib2 } from './grib2.js';
import { makeScale } from './products.js';
import { resampleLambert } from './models.js';

const BUCKET = 'https://noaa-rtma-pds.s3.amazonaws.com';
const PRODUCT_SUFFIX = '.2dvarges_ndfd.grb2';

const MS_TO_MPH = 2.2369363;
const M_TO_MI = 0.000621371192;
const K_TO_F = { unit: '°F', factor: 1.8, offset: -459.67 };

const pad = (n, w = 2) => String(n).padStart(w, '0');
const stop = (v, c) => ({ v, c1: [c[0], c[1], c[2], 255], c2: null });
const rampScale = (stops) => makeScale(stops.map(([v, c]) => stop(v, c)));

const TMP_SCALE = rampScale([
  [233.15, [145, 0, 160]], [244.26, [110, 40, 200]], [255.37, [60, 60, 220]],
  [266.48, [40, 130, 230]], [273.15, [70, 200, 230]], [277.59, [60, 200, 150]],
  [283.15, [70, 200, 80]], [288.71, [150, 210, 60]], [294.26, [230, 220, 60]],
  [299.82, [240, 170, 50]], [305.37, [235, 110, 40]], [310.93, [220, 50, 40]],
  [316.48, [150, 25, 35]],
]);

const DPT_SCALE = rampScale([
  [249.82, [120, 90, 60]], [260.93, [150, 130, 90]], [266.48, [175, 160, 110]],
  [272.04, [205, 200, 150]], [277.59, [150, 200, 150]], [283.15, [90, 185, 110]],
  [285.93, [60, 165, 95]], [288.71, [40, 145, 95]], [291.48, [30, 130, 115]],
  [294.26, [30, 120, 135]], [297.04, [40, 110, 155]], [299.82, [60, 100, 175]],
]);

const RH_SCALE = rampScale([
  [0, [120, 70, 20]], [20, [170, 130, 60]], [40, [220, 200, 130]],
  [50, [230, 230, 200]], [60, [170, 210, 150]], [70, [90, 190, 130]],
  [80, [40, 160, 140]], [90, [30, 120, 160]], [100, [20, 70, 150]],
]);

const CLOUD_SCALE = rampScale([
  [0, [40, 60, 90]], [25, [90, 110, 130]], [50, [150, 160, 170]],
  [75, [200, 205, 210]], [100, [242, 246, 250]],
]);

const WIND_SCALE = rampScale([
  [2.24, [180, 200, 230]], [4.47, [120, 190, 230]], [8.94, [80, 200, 160]],
  [13.41, [120, 210, 80]], [17.88, [220, 220, 70]], [22.35, [240, 160, 50]],
  [26.82, [230, 90, 50]], [31.29, [200, 40, 60]], [35.76, [150, 30, 110]],
]);

const GUST_SCALE = rampScale([
  [4.47, [180, 200, 230]], [8.94, [120, 190, 230]], [13.41, [80, 200, 160]],
  [17.88, [120, 210, 80]], [22.35, [220, 220, 70]], [26.82, [240, 160, 50]],
  [31.29, [230, 90, 50]], [35.76, [200, 40, 60]], [40.23, [160, 30, 110]],
  [44.70, [110, 20, 130]],
]);

const VIS_SCALE = rampScale([
  [0, [120, 0, 0]], [400, [190, 45, 45]], [800, [230, 120, 45]],
  [1600, [230, 210, 80]], [3200, [140, 200, 90]], [8000, [70, 170, 160]],
  [16093, [90, 150, 235]], [24140, [175, 205, 250]],
]);

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

const src = (varName, level, record) => ({ varName, level, record });

const TMP_SRC = src('TMP', '2 m above ground', 3);
const DPT_SRC = src('DPT', '2 m above ground', 4);

function relativeHumidity(arrays, i) {
  const t = arrays[0][i];
  const td = arrays[1][i];
  if (!Number.isFinite(t) || !Number.isFinite(td)) return NaN;
  const tc = t - 273.15;
  const tdc = td - 273.15;
  const es = Math.exp((17.625 * tc) / (243.04 + tc));
  const e = Math.exp((17.625 * tdc) / (243.04 + tdc));
  const rh = (e / es) * 100;
  return rh < 0 ? 0 : rh > 100 ? 100 : rh;
}

export const OBS_PRODUCTS = {
  TMP: { ...gridProduct('TMP', 'Temperature', TMP_SCALE, TMP_SCALE.lo, 'K', K_TO_F), ...TMP_SRC },
  DPT: { ...gridProduct('DPT', 'Dew Point', DPT_SCALE, DPT_SCALE.lo, 'K', K_TO_F), ...DPT_SRC },
  RH: {
    ...gridProduct('RH', 'Relative Humidity', RH_SCALE, 0, '%'),
    sources: () => [TMP_SRC, DPT_SRC],
    combine: relativeHumidity,
  },
  TCDC: {
    ...gridProduct('TCDC', 'Total Cloud Cover', CLOUD_SCALE, 1, '%'),
    ...src('TCDC', 'entire atmosphere', 13),
  },
  WIND: {
    ...gridProduct('WIND', 'Wind Speed', WIND_SCALE, 0.5, 'm/s', { unit: 'mph', factor: MS_TO_MPH }),
    ...src('WIND', '10 m above ground', 9),
  },
  GUST: {
    ...gridProduct('GUST', 'Wind Gusts', GUST_SCALE, 0.5, 'm/s', { unit: 'mph', factor: MS_TO_MPH }),
    ...src('GUST', '10 m above ground', 10),
  },
  VIS: {
    ...gridProduct('VIS', 'Visibility', VIS_SCALE, 0, 'm', { unit: 'mi', factor: M_TO_MI }),
    ...src('VIS', 'surface', 11),
  },
};

export const OBS_CATEGORIES = [
  { id: 'surface', name: 'RTMA Surface Analysis', products: ['TMP', 'DPT', 'RH', 'TCDC', 'WIND', 'GUST', 'VIS'] },
];

function ymd(date) {
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`;
}

function timeForKey(key) {
  const m = key.match(/rtma2p5_ru\.(\d{8})\/rtma2p5_ru\.t(\d{2})(\d{2})z\./);
  if (!m) return null;
  const d = m[1];
  return new Date(Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), +m[2], +m[3]));
}

function labelForKey(key) {
  const t = timeForKey(key);
  return t ? `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}Z` : key.split('/').pop();
}

export async function listObservations(date) {
  const prefix = `rtma2p5_ru.${ymd(date)}/`;
  const url = `${BUCKET}/?list-type=2&prefix=${encodeURIComponent(prefix)}&max-keys=1000`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`RTMA list failed: ${res.status}`);
  const xml = await res.text();
  const keys = [];
  const re = /<Key>([^<]+)<\/Key>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const key = m[1];
    if (key.endsWith(PRODUCT_SUFFIX)) keys.push(key);
  }
  keys.sort();
  return keys.map((key) => ({ key, label: labelForKey(key), time: timeForKey(key) }));
}

function normLevel(s) {
  s = String(s || '').replace(' (considered as a single layer)', '');
  const m = /^(\d+)-(\d+)(\D.*)$/.exec(s);
  if (m) {
    const a = +m[1], b = +m[2];
    return `${Math.min(a, b)}-${Math.max(a, b)}${m[3]}`;
  }
  return s;
}

function rangeFromIdx(text, source) {
  const lines = text.split('\n').filter((l) => l.trim());
  const level = normLevel(source.level);
  for (let i = 0; i < lines.length; i++) {
    const f = lines[i].split(':');
    if (f[3] !== source.varName || normLevel(f[4]) !== level) continue;
    const start = parseInt(f[1], 10);
    let end = null;
    for (let j = i + 1; j < lines.length; j++) {
      const ns = parseInt(lines[j].split(':')[1], 10);
      if (ns !== start) { end = ns - 1; break; }
    }
    const dot = f[0].indexOf('.');
    const sub = dot >= 0 ? Math.max(0, parseInt(f[0].slice(dot + 1), 10) - 1) : 0;
    return { start, end, sub };
  }
  throw new Error(`field ${source.varName}/${source.level} not in RTMA index`);
}

async function fetchBytes(url, onProgress, range) {
  const headers = range ? { Range: `bytes=${range.start}-${range.end == null ? '' : range.end}` } : undefined;
  const res = await fetch(url, headers ? { headers } : undefined);
  if (!res.ok && !(range && res.status === 206)) throw new Error(`RTMA download failed: ${res.status}`);
  const total = range && range.end != null
    ? range.end - range.start + 1
    : Number(res.headers.get('content-length')) || 0;
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

async function idxTextFor(key) {
  const res = await fetch(`${BUCKET}/${key}.idx`);
  if (!res.ok) throw new Error(`RTMA index fetch failed: ${res.status}`);
  return res.text();
}

async function fetchDecodeSource(key, source, idxPromise, onProgress) {
  const url = `${BUCKET}/${key}`;
  try {
    const range = rangeFromIdx(await idxPromise, source);
    const bytes = await fetchBytes(url, onProgress, range);
    return decodeGrib2(bytes, range.sub);
  } catch (idxErr) {
    if (!Number.isFinite(source.record)) throw idxErr;
    const bytes = await fetchBytes(url, onProgress);
    return decodeGrib2(bytes, Math.max(0, source.record - 1));
  }
}

function sourcesFor(product) {
  return typeof product.sources === 'function'
    ? product.sources()
    : [{ varName: product.varName, level: product.level, record: product.record }];
}

function combineGrids(grids, combine) {
  if (!combine) return grids[0];
  const arrays = grids.map((g) => g.values);
  const n = arrays[0].length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = combine(arrays, i);
  return { ...grids[0], values: out };
}

function regularGrid(grid) {
  if (grid.proj === 'lambert') return resampleLambert(grid);
  return grid;
}

export async function loadObservation(productId, key, onProgress) {
  const product = OBS_PRODUCTS[productId];
  if (!product) throw new Error('unknown RTMA product');
  const idxPromise = idxTextFor(key);
  const sources = sourcesFor(product);
  const grids = [];
  for (let i = 0; i < sources.length; i++) {
    const grid = await fetchDecodeSource(
      key,
      sources[i],
      idxPromise,
      onProgress && ((p) => onProgress((i + p) / sources.length))
    );
    grids.push(regularGrid(grid));
  }
  const grid = combineGrids(grids, product.combine);
  grid.product = product;
  grid.time = timeForKey(key);
  grid.key = key;
  return grid;
}
