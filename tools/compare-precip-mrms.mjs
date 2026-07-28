// compare-precip-mrms.mjs — score the satellite precipitation retrieval
// (js/satPrecip.js) against MRMS PrecipRate, the radar/gauge multi-sensor field
// that is as close to ground truth as CONUS gets.
//
// The satellite estimate is an inference from cloud tops (see satPrecip.js), so
// it will never match MRMS pixel for pixel. What this checks is that it is not
// *significantly* off: that it rains in roughly the right places, at roughly the
// right rates, and that the total water it puts down is the same order as the
// radar's.
//
// Usage:
//   node tools/compare-precip-mrms.mjs [--sector meso1|meso2] [--frames N]
//                                      [--sat goes19|goes18] [--no-glm]
//                                      [--at 2026-07-28T21:00Z] [--set key=value ...]
//
// Everything is downloaded live from the NOAA open buckets; nothing is cached
// between runs. Requires network access.

import { loadScene, listScenes, lonLatToColRow, sceneBBox, SATELLITES } from '../js/goes.js';
import { loadFlashes } from '../js/glm.js';
import { computePrecipRate, flashDensityGrid, PRECIP_BANDS, PRECIP_PARAMS } from '../js/satPrecip.js';
import { listMrms, loadMrms } from '../js/mrms.js';

const argv = process.argv.slice(2);
const flag = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const has = (name) => argv.includes(`--${name}`);

const SECTOR = flag('sector', 'meso1');
const SATKEY = flag('sat', 'goes19');
const FRAMES = Number(flag('frames', 3));
const USE_GLM = !has('no-glm');
const OVERRIDES = {};
for (let i = 0; i < argv.length; i++) {
  if (argv[i] !== '--set') continue;
  const [k, v] = String(argv[i + 1] || '').split('=');
  if (k) OVERRIDES[k] = Number(v);
}

// MRMS covers CONUS only; a mesoscale sector parked over the ocean or Mexico has
// nothing to score against.
const CONUS = [-125, 25, -66.5, 49];
const GLM_WINDOW_MIN = 5;
const RAIN = 0.2;              // mm/hr — the threshold for "it is raining here"
const THRESHOLDS = [0.5, 2.5, 10];

function overlapFraction(bbox) {
  const w = Math.max(bbox[0], CONUS[0]), s = Math.max(bbox[1], CONUS[1]);
  const e = Math.min(bbox[2], CONUS[2]), n = Math.min(bbox[3], CONUS[3]);
  if (e <= w || n <= s) return 0;
  return ((e - w) * (n - s)) / ((bbox[2] - bbox[0]) * (bbox[3] - bbox[1]));
}

// Pair every MRMS cell inside the satellite scene's footprint with the satellite
// rate at the same place. MRMS is ~1 km and the mesoscale sector 2 km, so the
// satellite field is sampled (nearest neighbour) at the radar's cells rather
// than the other way round — that keeps the comparison on an equal-area grid.
function pairCells(scene, rate, mrms, bbox) {
  const sat = [], rad = [];
  const w = Math.max(bbox[0], CONUS[0]), s = Math.max(bbox[1], CONUS[1]);
  const e = Math.min(bbox[2], CONUS[2]), n = Math.min(bbox[3], CONUS[3]);
  const i0 = Math.max(0, Math.floor((w - mrms.lon1) / mrms.di));
  const i1 = Math.min(mrms.ni - 1, Math.ceil((e - mrms.lon1) / mrms.di));
  const j0 = Math.max(0, Math.floor((mrms.lat1 - n) / mrms.dj));
  const j1 = Math.min(mrms.nj - 1, Math.ceil((mrms.lat1 - s) / mrms.dj));
  for (let j = j0; j <= j1; j++) {
    const lat = mrms.lat1 - j * mrms.dj;
    for (let i = i0; i <= i1; i++) {
      const lon = mrms.lon1 + i * mrms.di;
      const v = mrms.values[j * mrms.ni + i];
      if (!Number.isFinite(v) || v < 0) continue;    // outside radar coverage
      const cr = lonLatToColRow(scene, lat, lon);
      if (!cr) continue;
      const r = rate[Math.round(cr.row) * scene.width + Math.round(cr.col)];
      if (!Number.isFinite(r)) continue;
      sat.push(r); rad.push(v);
    }
  }
  return { sat, rad };
}

function score(sat, rad) {
  const n = sat.length;
  let sumS = 0, sumR = 0, sumSS = 0, sumRR = 0, sumSR = 0, mae = 0, se = 0;
  for (let i = 0; i < n; i++) {
    const a = sat[i], b = rad[i];
    sumS += a; sumR += b; sumSS += a * a; sumRR += b * b; sumSR += a * b;
    mae += Math.abs(a - b); se += (a - b) * (a - b);
  }
  const mS = sumS / n, mR = sumR / n;
  const cov = sumSR / n - mS * mR;
  const sd = Math.sqrt(Math.max(0, sumSS / n - mS * mS)) * Math.sqrt(Math.max(0, sumRR / n - mR * mR));
  const cats = THRESHOLDS.map((t) => {
    let hit = 0, miss = 0, fa = 0;
    for (let i = 0; i < n; i++) {
      const a = sat[i] >= t, b = rad[i] >= t;
      if (a && b) hit++; else if (b) miss++; else if (a) fa++;
    }
    return {
      t,
      pod: hit + miss ? hit / (hit + miss) : NaN,
      far: hit + fa ? fa / (hit + fa) : NaN,
      csi: hit + miss + fa ? hit / (hit + miss + fa) : NaN,
      hit, miss, fa,
    };
  });
  // Rain-area and rain-volume comparisons: the two numbers that say whether the
  // field is "significantly off" at the scale a forecaster reads it at.
  let areaS = 0, areaR = 0;
  for (let i = 0; i < n; i++) { if (sat[i] >= RAIN) areaS++; if (rad[i] >= RAIN) areaR++; }
  return {
    n, meanSat: mS, meanMrms: mR,
    bias: mR > 0 ? mS / mR : NaN,
    mae: mae / n, rmse: Math.sqrt(se / n),
    corr: sd > 0 ? cov / sd : NaN,
    rainAreaSat: areaS / n, rainAreaMrms: areaR / n,
    cats,
  };
}

async function nearestMrmsFrame(when) {
  let frames = await listMrms('PRATE', when);
  let best = null;
  for (const f of frames) {
    if (!f.time) continue;
    if (Math.abs(f.time - when) < 12 * 60000 && (!best || Math.abs(f.time - when) < Math.abs(best.time - when)))
      best = f;
  }
  return best;
}

const params = { ...PRECIP_PARAMS, ...OVERRIDES };
console.log(`satellite: ${SATELLITES[SATKEY].label}  sector: ${SECTOR}  GLM: ${USE_GLM ? 'on' : 'off'}`);
if (Object.keys(OVERRIDES).length) console.log('overrides:', OVERRIDES);

const AT = flag('at', null);
const WHEN = AT ? new Date(AT) : new Date();
if (Number.isNaN(WHEN.getTime())) { console.error(`bad --at value: ${AT}`); process.exit(1); }

const scenes = await listScenes(SATKEY, SECTOR, WHEN);
if (!scenes.length) { console.error('no scenes listed'); process.exit(1); }

// Space the frames out so they are not three views of the same minute.
const picked = [];
for (let i = 0; i < FRAMES && i * 4 + 1 <= scenes.length; i++)
  picked.push(scenes[scenes.length - 1 - i * 4]);

const all = { sat: [], rad: [] };
for (const s of picked) {
  const scene = await loadScene(SATKEY, SECTOR, s.key, PRECIP_BANDS, null, 0, null);
  const bbox = sceneBBox(scene);
  const ov = overlapFraction(bbox);
  if (ov < 0.25) {
    console.log(`${s.label}: sector at [${bbox.map((v) => v.toFixed(1))}] — only ${(ov * 100) | 0}% over CONUS, skipping`);
    continue;
  }
  let density = null, flashInfo = '';
  if (USE_GLM) {
    const end = scene.time || new Date();
    const flashes = await loadFlashes(SATKEY, new Date(end.getTime() - GLM_WINDOW_MIN * 60000), end);
    density = flashDensityGrid(scene, flashes, GLM_WINDOW_MIN, lonLatToColRow, params);
    flashInfo = `, ${flashes.lat.length} flashes / ${flashes.loaded} granules`;
  }
  const rate = computePrecipRate(scene, density, params);

  const frame = await nearestMrmsFrame(scene.time);
  if (!frame) { console.log(`${s.label}: no MRMS PrecipRate frame within 12 min`); continue; }
  const mrms = await loadMrms('PRATE', frame.key);

  const { sat, rad } = pairCells(scene, rate, mrms, bbox);
  if (!sat.length) { console.log(`${s.label}: no overlapping cells`); continue; }
  for (let i = 0; i < sat.length; i++) { all.sat.push(sat[i]); all.rad.push(rad[i]); }
  const r = score(sat, rad);
  console.log(`\n${s.label}  (MRMS ${frame.label}, ${((scene.time - frame.time) / 60000).toFixed(1)} min offset${flashInfo})`);
  report(r, '  ');
}

if (all.sat.length) {
  console.log('\n================ all frames pooled ================');
  report(score(all.sat, all.rad), '  ');
}

function report(r, ind) {
  console.log(`${ind}cells ${r.n}`);
  console.log(`${ind}mean rate    sat ${r.meanSat.toFixed(3)} mm/hr   MRMS ${r.meanMrms.toFixed(3)} mm/hr   bias ${r.bias.toFixed(2)}×`);
  console.log(`${ind}rain area    sat ${(r.rainAreaSat * 100).toFixed(1)}%        MRMS ${(r.rainAreaMrms * 100).toFixed(1)}%`);
  console.log(`${ind}MAE ${r.mae.toFixed(3)}  RMSE ${r.rmse.toFixed(3)}  corr ${r.corr.toFixed(3)}`);
  for (const c of r.cats)
    console.log(`${ind}≥${String(c.t).padStart(4)} mm/hr   POD ${c.pod.toFixed(2)}  FAR ${c.far.toFixed(2)}  CSI ${c.csi.toFixed(2)}`);
}
