// satPrecip.js — a satellite-only precipitation-rate retrieval.
//
// Geostationary imagers do not see rain. They see cloud tops, so any rain rate
// derived from them is an inference: cold tops usually mean deep convection,
// deep convection usually means rain. Every published IR estimator is built on
// that chain, and so is this one. It follows the lineage of NESDIS's
// Auto-Estimator (Vicente et al. 1998) and its successor the Hydro-Estimator
// (Scofield & Kuligowski 2003):
//
//   1. A core rate from the 10.3 µm clean-IR brightness temperature, using the
//      Auto-Estimator's power-law regression against radar rain rates.
//   2. The Hydro-Estimator's central correction: compare each pixel with the
//      mean temperature of the cloud around it. Raining cores are colder than
//      their surroundings; the cirrus anvil spreading downwind is not. Without
//      this the whole anvil rains, which is the classic failure of IR-only QPE.
//   3. A split-window (10.3 − 12.3 µm) thin-cirrus screen, which removes
//      semi-transparent cloud the anomaly test alone leaves behind.
//   4. A 6.2 µm water-vapour / clean-IR overshooting-top boost: where the WV
//      channel is as warm as or warmer than the window channel, the top has
//      punched into the stratosphere and the updraught is intense.
//   5. A GLM lightning enhancement. Lightning is the one direct observation of
//      convective intensity a geostationary platform has, and it is what lets
//      the retrieval keep raining in a core that the anomaly test would have
//      damped — see glm.js.
//
// What it cannot do, and no IR retrieval can: warm-rain processes (shallow
// tropical showers, orographic rain, drizzle) have warm tops and read as no
// rain, and cold non-precipitating cirrus can still read as light rain. The
// Hydro-Estimator's operational form also scales its rates by NWP precipitable
// water and relative humidity, correcting for how much of what leaves the cloud
// base reaches the ground; this runs on satellite data alone and does not, so
// it is biased in very dry and very moist environments. Treat the field as a
// convective-intensity estimate, not as a QPE product. `tools/compare-precip-mrms.mjs`
// scores it against MRMS PrecipRate, which is what the constants below are
// tuned against.

// The channels the retrieval reads: 6.2 µm upper-level water vapour, 10.3 µm
// "clean" IR window, 12.3 µm "dirty" IR window.
export const PRECIP_BANDS = [8, 13, 15];

// How far back from the scan time GLM flashes are accumulated. Long enough for a
// stable density in a sector that is rescanned every minute, short enough that
// the lightning still describes the convection in the picture.
export const PRECIP_GLM_MINUTES = 5;

export const PRECIP_PARAMS = {
  // Auto-Estimator power law, R = A·exp(−B·T^1.2) mm/hr for T in K.
  A: 1.1183e11,
  B: 3.6382e-2,
  // No rain is inferred above this cloud-top temperature at all.
  tMax: 250,
  // Radius of the neighbourhood the local cloud-top mean is taken over, and the
  // temperature below which a pixel counts as cloud for that mean.
  meanRadiusKm: 60,
  cloudMaxK: 265,
  // The pixel-versus-surroundings correction. Rain is fully suppressed when the
  // pixel is `anomWarm` K warmer than the local cloud mean and fully allowed
  // when it is `anomCold` K colder.
  anomWarm: -1.5,
  anomCold: 3,
  // Split-window thin-cirrus screen on (T10.3 − T12.3): optically thick cloud
  // sits at or below zero, semi-transparent cirrus spreads positive. This is the
  // sharpest control the retrieval has — widening it past ~2 K lets the anvil
  // rain and roughly halves the categorical skill (see tools/compare-precip-mrms.mjs).
  thinLo: -1,
  thinHi: 1.5,
  // Overshooting-top boost from (T6.2 − T10.3): ≥ 0 means the top is above the
  // tropopause. Ramped in from `otLo`.
  otLo: -3,
  otHi: 0,
  otGain: 0.9,
  // Lightning. Density is flashes per minute within `ltgRadiusKm` of the pixel;
  // `ltgSat` is the density at which the enhancement saturates.
  ltgRadiusKm: 15,
  ltgSat: 1.5,
  ltgGain: 1.2,
  // The Auto-Estimator curve is very steep at the cold end — a few kelvin of
  // cloud top is a factor of two in rate — so the heaviest cells it produces
  // swing far more from day to day than the radar's do. Compressing the rate
  // about `compressRef` mm/hr pulls that tail in: it barely touches light rain
  // and keeps a cold-topped, lightly-raining night-time anvil from reading as a
  // 100 mm/hr core. Set `compress` to 1 to recover the raw power law.
  compress: 0.5,
  compressRef: 4,
  // Overall calibration against MRMS.
  gain: 1.1,
  maxRate: 150,
  floor: 0.2,
};

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

// The Auto-Estimator core curve: cloud-top brightness temperature (K) → mm/hr.
export function autoEstimatorRate(tK, p = PRECIP_PARAMS) {
  if (!(tK > 0) || tK >= p.tMax) return 0;
  return p.A * Math.exp(-p.B * Math.pow(tK, 1.2));
}

// Ground sample distance of a fixed-grid scene, in km at the sub-satellite
// point. The scan-angle step times the satellite's altitude.
export function kmPerPixel(scene) {
  const alt = (scene.proj.H - scene.proj.rEq) / 1000;
  return Math.abs(scene.xScale) * alt;
}

// Mean of `field` over the cloudy pixels within a (2r+1)² box, computed as two
// separable running-window passes so the cost is independent of the radius.
// Cells with no cloudy neighbour come back NaN.
export function cloudyBoxMean(field, W, H, r, cloudMax) {
  const sumX = new Float64Array(W * H);
  const cntX = new Int32Array(W * H);
  for (let y = 0; y < H; y++) {
    const base = y * W;
    let s = 0, c = 0;
    // Prime the window on [0, r].
    for (let x = 0; x <= r && x < W; x++) {
      const v = field[base + x];
      if (v === v && v < cloudMax) { s += v; c++; }
    }
    for (let x = 0; x < W; x++) {
      sumX[base + x] = s; cntX[base + x] = c;
      const drop = x - r, add = x + r + 1;
      if (drop >= 0) { const v = field[base + drop]; if (v === v && v < cloudMax) { s -= v; c--; } }
      if (add < W) { const v = field[base + add]; if (v === v && v < cloudMax) { s += v; c++; } }
    }
  }
  const out = new Float32Array(W * H);
  for (let x = 0; x < W; x++) {
    let s = 0, c = 0;
    for (let y = 0; y <= r && y < H; y++) { s += sumX[y * W + x]; c += cntX[y * W + x]; }
    for (let y = 0; y < H; y++) {
      out[y * W + x] = c > 0 ? s / c : NaN;
      const drop = y - r, add = y + r + 1;
      if (drop >= 0) { s -= sumX[drop * W + x]; c -= cntX[drop * W + x]; }
      if (add < H) { s += sumX[add * W + x]; c += cntX[add * W + x]; }
    }
  }
  return out;
}

// Grid GLM flashes onto a scene as a density in flashes per minute within
// `radiusKm` of each pixel. Flashes are binned to their nearest cell and then
// summed over a box of that radius with the same separable pass as above.
export function flashDensityGrid(scene, flashes, minutes, lonLatToColRow, p = PRECIP_PARAMS) {
  const W = scene.width, H = scene.height;
  const counts = new Float32Array(W * H);
  if (!flashes || !flashes.lat || !flashes.lat.length) return counts;
  for (let i = 0; i < flashes.lat.length; i++) {
    const cr = lonLatToColRow(scene, flashes.lat[i], flashes.lon[i]);
    if (!cr) continue;
    const c = Math.round(cr.col), rr = Math.round(cr.row);
    if (c < 0 || c >= W || rr < 0 || rr >= H) continue;
    counts[rr * W + c] += 1;
  }
  const r = Math.max(1, Math.round(p.ltgRadiusKm / kmPerPixel(scene)));
  const box = boxSum(counts, W, H, r);
  const perMin = 1 / Math.max(1, minutes);
  for (let i = 0; i < box.length; i++) box[i] *= perMin;
  return box;
}

// Separable box sum — the density counterpart of cloudyBoxMean.
function boxSum(field, W, H, r) {
  const tmp = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const base = y * W;
    let s = 0;
    for (let x = 0; x <= r && x < W; x++) s += field[base + x];
    for (let x = 0; x < W; x++) {
      tmp[base + x] = s;
      if (x - r >= 0) s -= field[base + x - r];
      if (x + r + 1 < W) s += field[base + x + r + 1];
    }
  }
  const out = new Float32Array(W * H);
  for (let x = 0; x < W; x++) {
    let s = 0;
    for (let y = 0; y <= r && y < H; y++) s += tmp[y * W + x];
    for (let y = 0; y < H; y++) {
      out[y * W + x] = s;
      if (y - r >= 0) s -= tmp[(y - r) * W + x];
      if (y + r + 1 < H) s += tmp[(y + r + 1) * W + x];
    }
  }
  return out;
}

// Build the rain-rate field (mm/hr) for a decoded scene. `density` is the
// optional GLM flash-density grid from flashDensityGrid, aligned to the scene;
// without it the retrieval runs on the imagery alone. Cells with no usable
// infrared read NaN (transparent); cells below the drizzle floor read 0.
export function computePrecipRate(scene, density = null, params = {}) {
  const p = { ...PRECIP_PARAMS, ...params };
  const W = scene.width, H = scene.height;
  const ir = scene.channels[13];
  const out = new Float32Array(W * H);
  if (!ir) { out.fill(NaN); return out; }
  const wv = scene.channels[8] || null;
  const dirty = scene.channels[15] || null;

  const r = Math.max(1, Math.round(p.meanRadiusKm / kmPerPixel(scene)));
  const mean = cloudyBoxMean(ir, W, H, r, p.cloudMaxK);

  const anomSpan = p.anomCold - p.anomWarm;
  const thinSpan = p.thinHi - p.thinLo;
  const otSpan = p.otHi - p.otLo;

  for (let i = 0; i < out.length; i++) {
    const t = ir[i];
    if (!(t === t)) { out[i] = NaN; continue; }
    if (t >= p.tMax) { out[i] = 0; continue; }

    let rate = p.A * Math.exp(-p.B * Math.pow(t, 1.2));

    // Lightning first: it is a direct observation of a convective core, and is
    // allowed to overrule the screens below, which are proxies for one.
    let convective = 0;
    if (density) convective = clamp01(density[i] / p.ltgSat);

    // Cold relative to the surrounding cloud → core; warm → anvil.
    const m = mean[i];
    let fAnom = 1;
    if (m === m) fAnom = clamp01((m - t - p.anomWarm) / anomSpan);
    fAnom = Math.max(fAnom, convective);

    // Semi-transparent cirrus: the two window channels diverge.
    let fThin = 1;
    if (dirty) {
      const btd = t - dirty[i];
      if (btd === btd) fThin = Math.max(clamp01(1 - (btd - p.thinLo) / thinSpan), convective);
    }

    // Overshooting top: water vapour at or above the window temperature.
    let fOT = 1;
    if (wv) {
      const d = wv[i] - t;
      if (d === d) fOT = 1 + p.otGain * clamp01((d - p.otLo) / otSpan);
    }

    rate *= fAnom * fThin * fOT * (1 + p.ltgGain * convective);
    if (p.compress !== 1 && rate > 0) rate = p.compressRef * Math.pow(rate / p.compressRef, p.compress);
    rate *= p.gain;
    if (rate > p.maxRate) rate = p.maxRate;
    out[i] = rate < p.floor ? 0 : rate;
  }
  return out;
}
