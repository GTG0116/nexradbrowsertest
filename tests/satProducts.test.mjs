import assert from 'node:assert/strict';
import { buildRGBA, bandsFor } from '../js/satProducts.js';
import { scanToLonLat } from '../js/goes.js';

// A flat scene on a GOES-East fixed grid, big enough to span several cells of
// the GeoColor solar lattice.
function makeScene(W, H, channels, time = new Date(Date.UTC(2026, 5, 21, 18, 0, 0))) {
  return {
    width: W, height: H, channels, time,
    xScale: 56e-6, xOffset: -0.101332,
    yScale: -56e-6, yOffset: 0.128212,
    proj: {
      lon0: (-75.2 * Math.PI) / 180,
      H: 35786023 + 6378137,
      rEq: 6378137,
      rPol: 6356752.31414,
      sweep: 'x',
    },
  };
}

const fill = (n, f) => Float32Array.from({ length: n }, (_, i) => f(i));

// ---- single IR channel: the baked ramp must reproduce the knot colours ------
// The enhancement is a lookup table rather than a walk over the knot list. At a
// knot temperature the table must land on that knot's colour. The tolerance is
// the table's own resolution: the ramp's coldest knots swing 255 levels over
// 3 K, so a step of ~0.035 K shows up as a couple of levels there and as nothing
// at all across the gentler ones.
{
  const W = 6, H = 1;
  const K = (c) => c + 273.15;
  const temps = [K(50), K(30), K(0), K(-40), K(-60), K(-90)];
  const expect = [[0, 0, 0], [105, 105, 105], [225, 225, 225], [10, 10, 120], [240, 240, 0], [255, 0, 255]];
  const scene = makeScene(W, H, { 13: Float32Array.from(temps) });
  const rgba = buildRGBA(scene, 'C13', { enhanceIR: true });
  for (let i = 0; i < W; i++) {
    for (let k = 0; k < 3; k++) {
      assert.ok(Math.abs(rgba[i * 4 + k] - expect[i][k]) <= 3,
        `pixel ${i} channel ${k}: got ${rgba[i * 4 + k]}, want ~${expect[i][k]}`);
    }
    assert.equal(rgba[i * 4 + 3], 255);
  }

  // Warmer and colder than the ramp's ends clamp to its end colours.
  const ends = makeScene(2, 1, { 13: Float32Array.from([400, 100]) });
  const clamped = buildRGBA(ends, 'C13', { enhanceIR: true });
  assert.deepEqual(Array.from(clamped.slice(0, 3)), [0, 0, 0]);
  assert.deepEqual(Array.from(clamped.slice(4, 7)), [150, 0, 180]);
}

// NaN (off-disk / no data) stays fully transparent through the table path.
{
  const scene = makeScene(2, 1, { 13: Float32Array.from([NaN, 250]) });
  const rgba = buildRGBA(scene, 'C13', { enhanceIR: true });
  assert.equal(rgba[3], 0, 'a NaN sample must stay transparent');
  assert.equal(rgba[7], 255);
}

// ---- gamma: the LUT must match Math.pow to within a quantisation step -------
// True Color stretches band 2 (red) and band 1 (blue) with gamma 2.2 over 0..1,
// so the red channel of a ramp of reflectances is a direct read of the curve.
{
  const N = 256;
  const refl = fill(N, (i) => i / (N - 1));
  const scene = makeScene(N, 1, { 1: refl, 2: refl, 3: refl });
  const rgba = buildRGBA(scene, 'RGB_TRUECOLOR', {});
  for (let i = 0; i < N; i++) {
    const want = (Math.pow(i / (N - 1), 1 / 2.2) * 255) | 0;
    assert.ok(Math.abs(rgba[i * 4] - want) <= 1,
      `gamma at ${i}: got ${rgba[i * 4]}, want ~${want}`);
  }
}

// ---- band differences and missing bands ------------------------------------
// Air Mass builds two of its components from band differences; a band that never
// decoded must render transparent rather than throw.
{
  const scene = makeScene(2, 1, {
    8: Float32Array.from([230, 230]),
    10: Float32Array.from([245, 245]),
    12: Float32Array.from([250, 250]),
    13: Float32Array.from([260, 260]),
  });
  const rgba = buildRGBA(scene, 'RGB_AIRMASS', {});
  assert.equal(rgba[3], 255, 'a complete recipe renders opaque');
  // r = stretch(T8 - T10 = -15, lo -26.2, hi 0.6) → (−15 + 26.2)/26.8
  assert.equal(rgba[0], ((11.2 / 26.8) * 255) | 0);

  const missing = makeScene(2, 1, { 8: Float32Array.from([230, 230]) });
  const partial = buildRGBA(missing, 'RGB_AIRMASS', {});
  assert.equal(partial[3], 0, 'a recipe missing a band renders transparent, not an exception');
  assert.deepEqual(bandsFor('RGB_AIRMASS'), [8, 10, 12, 13]);
}

// ---- GeoColor: the coarse solar lattice must track the exact solve ----------
// The day/night weight is sampled every 8 px and interpolated between nodes.
// Rebuild the exact per-pixel weight here and require the rendered image to
// agree with the one the approximation produces — this is the error budget the
// optimisation is allowed, and 8-bit output leaves no room for it to drift.
{
  // Wide enough, at the real 2 km pixel scale, to run from full day through the
  // terminator into full night: on 2026-06-21 22:30Z GOES-East sees it around
  // 60°W, ~0.045 rad of scan angle east of the sub-satellite point.
  const W = 960, H = 24;
  const time = new Date(Date.UTC(2026, 5, 21, 22, 30, 0));
  const vis = fill(W * H, () => 0.55);
  const veg = fill(W * H, () => 0.40);
  const scene = makeScene(W, H, { 1: vis, 2: vis, 3: veg, 13: fill(W * H, () => 245) }, time);
  scene.xOffset = 0;
  scene.yOffset = 6e-4;

  // Subsolar point, the same NOAA-almanac approximation satProducts uses.
  const start = Date.UTC(time.getUTCFullYear(), 0, 0);
  const doy = (Date.UTC(time.getUTCFullYear(), time.getUTCMonth(), time.getUTCDate()) - start) / 86400000;
  const frac = (time.getUTCHours() + time.getUTCMinutes() / 60 + time.getUTCSeconds() / 3600) / 24;
  const g = ((2 * Math.PI) / 365) * (doy - 1 + (frac - 0.5));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g)
    - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g)
    - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const eqt = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g)
    - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const subLon = -((frac * 1440 + eqt) / 4 - 180);
  const sinDecl = Math.sin(decl), cosDecl = Math.cos(decl);
  const D2R = Math.PI / 180;
  const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

  const exactWeight = (col, row) => {
    const ll = scanToLonLat(scene.xOffset + col * scene.xScale,
      scene.yOffset + row * scene.yScale, scene.proj);
    if (!ll) return 1;
    const latR = ll[1] * D2R;
    const mu = Math.sin(latR) * sinDecl + Math.cos(latR) * cosDecl * Math.cos((ll[0] - subLon) * D2R);
    return clamp01((mu + 0.1) / 0.2);
  };

  const rgba = buildRGBA(scene, 'RGB_GEOCOLOR', {});
  const gamma = (v) => Math.pow(v, 1 / 2.2);
  const dr = gamma(0.55), db = gamma(0.55);
  const dg = 0.45 * dr + 0.45 * db + 0.1 * gamma(0.40);
  const cloud = clamp01((290 - 245) / (290 - 220));
  const night = [6 + cloud * 224, 14 + cloud * 226, 38 + cloud * 200];

  let terminatorSeen = false;
  let worst = 0;
  for (let row = 0; row < H; row++) {
    for (let col = 0; col < W; col++) {
      const w = exactWeight(col, row);
      if (w > 0.02 && w < 0.98) terminatorSeen = true;
      const want = [dr, dg, db].map((d, k) => (clamp01(d * w + (night[k] / 255) * (1 - w)) * 255) | 0);
      const o = (row * W + col) * 4;
      for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(rgba[o + k] - want[k]));
    }
  }
  assert.ok(terminatorSeen, 'the test scene must actually straddle the terminator');
  assert.ok(worst <= 2, `lattice interpolation drifted ${worst} levels from the exact solve`);
}

console.log('satProducts tests passed');
