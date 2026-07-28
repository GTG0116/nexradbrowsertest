// glm.js — GOES Geostationary Lightning Mapper (GLM) Level-2 flash data, read
// straight out of the same NOAA buckets the ABI imagery comes from and gridded
// onto a satellite scene.
//
// Keys look like
//   GLM-L2-LCFA/YYYY/DOY/HH/OR_GLM-L2-LCFA_G19_s<start>_e<end>_c<created>.nc
// with one ~280 KB NetCDF-4 granule every 20 seconds covering the whole disk.
// Each granule carries the flashes detected in that window as flat arrays
// (`flash_lat`, `flash_lon`, `flash_energy`, `flash_quality_flag`), which the
// project's own HDF5 reader handles without any special casing.
//
// The satellite precipitation retrieval (satPrecip.js) uses flash density as its
// convective signal: infrared alone cannot tell a raining convective core from
// the cold cirrus anvil streaming off it, and lightning can.

import { HDF5File } from './hdf5.js';
import { SATELLITES } from './goes.js';

const pad = (n, w = 2) => String(n).padStart(w, '0');

function dayOfYear(d) {
  const start = Date.UTC(d.getUTCFullYear(), 0, 0);
  return Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - start) / 86400000);
}

// Scan-start time of a granule key: ..._sYYYYDOYHHMMSSs_...
export function glmTimeForKey(key) {
  const m = String(key).match(/_s(\d{4})(\d{3})(\d{2})(\d{2})(\d{2})/);
  if (!m) return null;
  const [, yr, doy, hh, mm, ss] = m;
  const d = new Date(Date.UTC(+yr, 0, 1, +hh, +mm, +ss));
  d.setUTCDate(+doy);
  return d;
}

async function listHour(bucket, dateUTC, hour) {
  const prefix = `GLM-L2-LCFA/${dateUTC.getUTCFullYear()}/${pad(dayOfYear(dateUTC), 3)}/${pad(hour)}/`;
  const url = `${bucket}/?list-type=2&prefix=${encodeURIComponent(prefix)}&max-keys=1000`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GLM list failed: ${res.status}`);
  const xml = await res.text();
  const keys = [];
  const re = /<Key>([^<]+)<\/Key>/g;
  let m;
  while ((m = re.exec(xml)) !== null) keys.push(m[1]);
  return keys;
}

// Granule keys whose start time falls in [from, to). The window can straddle an
// hour boundary, so both hour folders are listed (they are cached below, so a
// minute-by-minute meso loop lists each folder once).
const hourCache = new Map();
async function cachedHour(bucket, date, hour) {
  const ck = `${bucket}|${date.getUTCFullYear()}|${dayOfYear(date)}|${hour}`;
  if (!hourCache.has(ck)) {
    hourCache.set(ck, listHour(bucket, date, hour).catch(() => []));
    if (hourCache.size > 8) hourCache.delete(hourCache.keys().next().value);
  }
  return hourCache.get(ck);
}

export async function listGlmGranules(satKey, from, to) {
  const sat = SATELLITES[satKey];
  if (!sat || (sat.family || 'goes') !== 'goes') return [];
  const hours = new Set();
  for (let t = Math.floor(from.getTime() / 3600000) * 3600000; t <= to.getTime(); t += 3600000)
    hours.add(t);
  const lists = await Promise.all([...hours].map((t) => {
    const d = new Date(t);
    return cachedHour(sat.bucket, d, d.getUTCHours());
  }));
  const out = [];
  for (const keys of lists) {
    for (const key of keys) {
      const t = glmTimeForKey(key);
      if (t && t >= from && t < to) out.push({ key, time: t });
    }
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

// Flash positions from one granule. Granules are small and read whole (a ranged
// read's header probe alone would cost more than the file). Only good-quality
// flashes are kept — the quality flag is 0 for a clean detection.
//
// A decoded granule is cached by key: consecutive mesoscale frames are one
// minute apart but sample a five-minute window, so most granules are shared
// between neighbouring frames and would otherwise be re-downloaded each time.
const granuleCache = new Map();
const GRANULE_CACHE_MAX = 48;

async function readGranule(bucket, key) {
  if (granuleCache.has(key)) return granuleCache.get(key);
  const load = (async () => {
    const res = await fetch(`${bucket}/${key}`);
    if (!res.ok) throw new Error(`GLM download failed: ${res.status}`);
    const h5 = new HDF5File(new Uint8Array(await res.arrayBuffer()));
    const lat = await h5.readVariable('flash_lat');
    const lon = await h5.readVariable('flash_lon');
    let flag = null;
    try { flag = await h5.readVariable('flash_quality_flag'); } catch (_) { /* optional */ }
    const n = Math.min(lat.data.length, lon.data.length);
    const outLat = new Float32Array(n);
    const outLon = new Float32Array(n);
    let k = 0;
    for (let i = 0; i < n; i++) {
      const la = lat.data[i], lo = lon.data[i];
      if (!Number.isFinite(la) || !Number.isFinite(lo)) continue;
      if (Math.abs(la) > 90 || Math.abs(lo) > 180) continue;   // fill / unnavigated
      if (flag && flag.data[i] !== 0 && flag.data[i] !== flag.fill) continue;
      outLat[k] = la; outLon[k] = lo; k++;
    }
    return { lat: outLat.subarray(0, k), lon: outLon.subarray(0, k) };
  })();
  granuleCache.set(key, load);
  load.catch(() => granuleCache.delete(key));
  while (granuleCache.size > GRANULE_CACHE_MAX) granuleCache.delete(granuleCache.keys().next().value);
  return load;
}

// Every good flash detected in [from, to). A granule that fails to load is
// skipped rather than failing the retrieval — lightning is an enhancement to the
// infrared estimate, not a requirement for it.
export async function loadFlashes(satKey, from, to, { concurrency = 6 } = {}) {
  const sat = SATELLITES[satKey];
  if (!sat) return { lat: new Float32Array(0), lon: new Float32Array(0), granules: 0 };
  const granules = await listGlmGranules(satKey, from, to);
  const parts = [];
  let next = 0;
  const lane = async () => {
    for (;;) {
      const i = next++;
      if (i >= granules.length) return;
      try { parts.push(await readGranule(sat.bucket, granules[i].key)); } catch (_) { /* skip */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, granules.length) }, lane));
  let total = 0;
  for (const p of parts) total += p.lat.length;
  const lat = new Float32Array(total), lon = new Float32Array(total);
  let off = 0;
  for (const p of parts) { lat.set(p.lat, off); lon.set(p.lon, off); off += p.lat.length; }
  return { lat, lon, granules: granules.length, loaded: parts.length };
}
