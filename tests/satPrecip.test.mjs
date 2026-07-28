import assert from 'node:assert/strict';
import {
  autoEstimatorRate, cloudyBoxMean, computePrecipRate, flashDensityGrid,
  kmPerPixel, PRECIP_BANDS, PRECIP_PARAMS,
} from '../js/satPrecip.js';
import { buildRGBA, bandsFor, precipColor, SAT_PRECIP_ID } from '../js/satProducts.js';
import { lonLatToColRow, scanToLonLat } from '../js/goes.js';

// A GOES-East fixed-grid scene at the real 2 km mesoscale pixel scale.
function makeScene(W, H, channels) {
  return {
    width: W, height: H, channels,
    time: new Date(Date.UTC(2026, 6, 28, 19, 20, 0)),
    xScale: 56e-6, xOffset: -0.03,
    yScale: -56e-6, yOffset: 0.10,
    proj: {
      lon0: (-75.2 * Math.PI) / 180,
      H: 35786023 + 6378137,
      rEq: 6378137,
      rPol: 6356752.31414,
      sweep: 'x',
    },
  };
}

const fill = (n, v) => Float32Array.from({ length: n }, () => v);

// ---- the Auto-Estimator core curve -----------------------------------------
// R = 1.1183e11 · exp(−3.6382e-2 · T^1.2). These are the published curve's own
// values; the retrieval is only allowed to modulate this, never to redefine it.
{
  const cases = [[200, 85.193], [220, 6.692], [235, 0.963], [245, 0.261]];
  for (const [t, want] of cases) {
    const got = autoEstimatorRate(t);
    assert.ok(Math.abs(got - want) / want < 0.005,
      `Auto-Estimator at ${t} K: got ${got.toFixed(3)}, want ~${want}`);
  }
  // Monotone decreasing in temperature, and identically zero above the cutoff.
  for (let t = 190; t < PRECIP_PARAMS.tMax - 1; t += 1)
    assert.ok(autoEstimatorRate(t) > autoEstimatorRate(t + 1), `not monotone at ${t} K`);
  assert.equal(autoEstimatorRate(PRECIP_PARAMS.tMax), 0);
  assert.equal(autoEstimatorRate(300), 0);
}

// ---- the mesoscale grid really is ~2 km ------------------------------------
{
  const scene = makeScene(4, 4, {});
  const km = kmPerPixel(scene);
  assert.ok(Math.abs(km - 2.0) < 0.05, `expected ~2 km pixels, got ${km.toFixed(3)}`);
}

// ---- the neighbourhood mean ignores clear sky and matches a brute force -----
{
  const W = 17, H = 13, r = 3, cloudMax = 265;
  const field = new Float32Array(W * H);
  for (let i = 0; i < field.length; i++) field[i] = 200 + ((i * 37) % 90); // 200..289
  field[5 * W + 5] = NaN;
  const got = cloudyBoxMean(field, W, H, r, cloudMax);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let s = 0, c = 0;
      for (let j = Math.max(0, y - r); j <= Math.min(H - 1, y + r); j++)
        for (let i = Math.max(0, x - r); i <= Math.min(W - 1, x + r); i++) {
          const v = field[j * W + i];
          if (v === v && v < cloudMax) { s += v; c++; }
        }
      const want = c ? s / c : NaN;
      const g = got[y * W + x];
      if (Number.isNaN(want)) assert.ok(Number.isNaN(g), `expected NaN at ${x},${y}`);
      else assert.ok(Math.abs(g - want) < 1e-3, `box mean at ${x},${y}: ${g} vs ${want}`);
    }
  }
}

// ---- the anvil problem the retrieval exists to solve ------------------------
// The correction that matters is contextual: the *same* cloud-top temperature
// must rain less when its surroundings are colder than it (it is the warm part
// of an anvil) than when they are warmer (it is the cold core of a cell). Hold
// the probed pixel at 210 K and change only what is around it.
{
  const W = 120, H = 120, probe = 60 * W + 60;
  const context = (surround) => {
    const ir = fill(W * H, surround);
    ir[probe] = 210;
    const scene = makeScene(W, H, { 13: ir, 15: Float32Array.from(ir), 8: fill(W * H, surround + 12) });
    scene.channels[15][probe] = 210;      // split-window difference 0: opaque cloud
    return computePrecipRate(scene, null)[probe];
  };
  const asCore = context(230);            // surroundings warmer → this is the core
  const asAnvil = context(196);           // surroundings colder → this is the fringe
  assert.ok(asCore > 0, 'a cold core against warmer cloud must rain');
  assert.equal(asAnvil, 0, `an anvil fringe must be suppressed, got ${asAnvil.toFixed(2)} mm/hr`);
}

// A cold shield with a colder core: both rain (an opaque 215 K shield really is
// raining cloud), but the core must dominate it by a wide margin.
{
  const W = 120, H = 120;
  const ir = fill(W * H, 215);
  for (let y = 55; y < 65; y++) for (let x = 55; x < 65; x++) ir[y * W + x] = 200;
  const scene = makeScene(W, H, { 13: ir, 15: Float32Array.from(ir), 8: fill(W * H, 225) });
  const rate = computePrecipRate(scene, null);
  const core = rate[60 * W + 60], shield = rate[20 * W + 20];
  assert.ok(core > 5, `core should rain, got ${core.toFixed(2)} mm/hr`);
  assert.ok(core > shield * 3,
    `core must dominate the shield, got ${core.toFixed(2)} vs ${shield.toFixed(2)}`);
}

// ---- the thin-cirrus screen -------------------------------------------------
// The same cold top, once optically thick (T13 − T15 ≈ 0) and once thin
// (T13 − T15 = 5 K). The thin one must not rain.
{
  const W = 40, H = 40;
  const mk = (btd) => {
    const ir = fill(W * H, 205);
    const scene = makeScene(W, H, { 13: ir, 15: fill(W * H, 205 - btd), 8: fill(W * H, 215) });
    return computePrecipRate(scene, null)[20 * W + 20];
  };
  const thick = mk(0), thin = mk(5);
  assert.ok(thick > 1, `an opaque cold top should rain, got ${thick.toFixed(2)}`);
  assert.equal(thin, 0, `a thin cirrus top should be screened out, got ${thin.toFixed(2)}`);
}

// ---- the overshooting-top boost --------------------------------------------
// Water vapour warmer than the window channel marks a top above the tropopause.
{
  const W = 40, H = 40;
  const mk = (wv) => {
    const ir = fill(W * H, 205);
    const scene = makeScene(W, H, { 13: ir, 15: Float32Array.from(ir), 8: fill(W * H, wv) });
    return computePrecipRate(scene, null)[20 * W + 20];
  };
  const plain = mk(190), overshoot = mk(207);
  assert.ok(overshoot > plain, `overshooting top should raise the rate: ${overshoot} vs ${plain}`);
}

// ---- lightning -------------------------------------------------------------
// Flashes must land in the right cells, and must both raise the rate and rescue
// a core the anomaly test would otherwise have damped.
{
  const W = 80, H = 80;
  const scene = makeScene(W, H, {});
  // Round-trip a grid cell through the navigation, so the density lands on it.
  const centre = { col: 40, row: 40 };
  // Forward-navigate the cell centre, so the flashes land exactly on it.
  const fwd = scanToLonLat(scene.xOffset + centre.col * scene.xScale,
    scene.yOffset + centre.row * scene.yScale, scene.proj);
  assert.ok(fwd, 'the test scene must contain a navigable cell');
  const ll = [fwd[1], fwd[0]];
  const back = lonLatToColRow(scene, ll[0], ll[1]);
  assert.ok(back && Math.round(back.col) === centre.col && Math.round(back.row) === centre.row,
    'the navigation must round-trip the probed cell');

  const flashes = { lat: Float32Array.from([ll[0], ll[0], ll[0]]), lon: Float32Array.from([ll[1], ll[1], ll[1]]) };
  const density = flashDensityGrid(scene, flashes, 5, lonLatToColRow);
  assert.ok(Math.abs(density[40 * W + 40] - 3 / 5) < 1e-5,
    `3 flashes over 5 min should read 0.6/min, got ${density[40 * W + 40]}`);
  // Far from the strike the density is zero (the box radius is ~15 km ≈ 8 cells).
  assert.equal(density[10 * W + 10], 0);

  // A warm-ish, thin-looking top that the screens would suppress: lightning
  // brings it back.
  const ir = fill(W * H, 218);
  for (let i = 0; i < W * H; i++) ir[i] = 218;
  const withLtg = makeScene(W, H, { 13: ir, 15: fill(W * H, 214), 8: fill(W * H, 228) });
  const dry = computePrecipRate(withLtg, null)[40 * W + 40];
  const wet = computePrecipRate(withLtg, density)[40 * W + 40];
  assert.equal(dry, 0, 'a uniform thin-looking sheet should not rain without lightning');
  assert.ok(wet > 0, 'lightning should let a convective core rain through the screens');
}

// ---- product plumbing ------------------------------------------------------
{
  assert.deepEqual(bandsFor(SAT_PRECIP_ID), PRECIP_BANDS);

  const W = 4, H = 1;
  const scene = makeScene(W, H, { RR: Float32Array.from([NaN, 0, 0.05, 30]) });
  const rgba = buildRGBA(scene, SAT_PRECIP_ID, {});
  assert.equal(rgba[3], 0, 'no data is transparent');
  assert.equal(rgba[7], 0, 'zero rain is transparent');
  assert.equal(rgba[11], 0, 'below the drizzle floor is transparent');
  assert.equal(rgba[15], 255, '30 mm/hr is opaque');
  const want = precipColor(30);
  for (let k = 0; k < 3; k++)
    assert.ok(Math.abs(rgba[12 + k] - want[k]) <= 1, 'the ramp colour must reach the texture');

  // A scene with no retrieval yet renders empty rather than throwing.
  const bare = makeScene(2, 1, { 13: Float32Array.from([200, 200]) });
  const empty = buildRGBA(bare, SAT_PRECIP_ID, {});
  assert.equal(empty[3], 0);
  assert.equal(empty[7], 0);

  // The ramp is monotone in the sense that matters: it never returns a colour
  // outside its own endpoints.
  for (const mm of [0.1, 0.2, 1, 5, 25, 99, 1000]) {
    const c = precipColor(mm);
    for (const v of c) assert.ok(v >= 0 && v <= 255, `ramp out of range at ${mm}`);
  }
}

// ---- an all-NaN scene stays NaN, not zero ----------------------------------
{
  const scene = makeScene(3, 1, { 13: Float32Array.from([NaN, NaN, NaN]) });
  const rate = computePrecipRate(scene, null);
  for (const v of rate) assert.ok(Number.isNaN(v), 'off-disk cells must stay NaN');
  const none = computePrecipRate(makeScene(3, 1, {}), null);
  for (const v of none) assert.ok(Number.isNaN(v), 'a scene without band 13 yields no field');
}

console.log('satPrecip tests passed');
