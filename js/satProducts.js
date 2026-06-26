// satProducts.js — GOES ABI channel definitions, single-channel enhancements,
// and multi-band RGB composite recipes. `buildRGBA` turns a decoded scene
// (physical units per band, from goes.js) into the W×H RGBA display texture the
// satellite GL layer samples; all the colour science lives here on the CPU so
// the shader only has to handle the geostationary projection.

import { scanToLonLat } from './goes.js';

// ---- the 16 ABI channels ----------------------------------------------------
// type: 'vis' (reflectance factor 0..~1) or 'ir' (brightness temperature, K).
export const SAT_CHANNELS = [
  { band: 1, name: 'Blue', um: 0.47, type: 'vis' },
  { band: 2, name: 'Red', um: 0.64, type: 'vis' },
  { band: 3, name: 'Veggie', um: 0.86, type: 'vis' },
  { band: 4, name: 'Cirrus', um: 1.37, type: 'vis' },
  { band: 5, name: 'Snow/Ice', um: 1.6, type: 'vis' },
  { band: 6, name: 'Cloud Particle', um: 2.2, type: 'vis' },
  { band: 7, name: 'Shortwave IR', um: 3.9, type: 'ir' },
  { band: 8, name: 'Upper WV', um: 6.2, type: 'ir' },
  { band: 9, name: 'Mid WV', um: 6.9, type: 'ir' },
  { band: 10, name: 'Lower WV', um: 7.3, type: 'ir' },
  { band: 11, name: 'Cloud-Top Phase', um: 8.4, type: 'ir' },
  { band: 12, name: 'Ozone', um: 9.6, type: 'ir' },
  { band: 13, name: 'Clean IR', um: 10.3, type: 'ir' },
  { band: 14, name: 'IR Longwave', um: 11.2, type: 'ir' },
  { band: 15, name: 'Dirty IR', um: 12.3, type: 'ir' },
  { band: 16, name: 'CO₂ IR', um: 13.3, type: 'ir' },
];

// RGB composites — each component is a band (or band difference) stretched over
// a physical range with a gamma, following the CIRA / EUMETSAT quick guides.
// `green: 'synthetic'` flags the GOES true-colour green synthesis.
export const SAT_RGB = {
  // GeoColor blends daytime true colour with a night-time IR cloud rendering,
  // crossfading across the terminator by solar elevation — so one product reads
  // naturally at any local time (the headline product of most modern viewers).
  GEOCOLOR: {
    name: 'GeoColor', short: 'GeoColor', day: false, geocolor: true,
    green: 'synthetic',
    r: { band: 2, lo: 0, hi: 1, gamma: 2.2 },
    b: { band: 1, lo: 0, hi: 1, gamma: 2.2 },
    veg: { band: 3, lo: 0, hi: 1, gamma: 2.2 },
    ir: { band: 13 },
  },
  TRUECOLOR: {
    name: 'True Color', short: 'TrueColor', day: true,
    green: 'synthetic',
    r: { band: 2, lo: 0, hi: 1, gamma: 2.2 },
    b: { band: 1, lo: 0, hi: 1, gamma: 2.2 },
    veg: { band: 3, lo: 0, hi: 1, gamma: 2.2 },
  },
  NATCOLOR: {
    name: 'Natural Color', short: 'NatColor', day: true,
    r: { band: 5, lo: 0, hi: 1, gamma: 1 },
    g: { band: 3, lo: 0, hi: 1, gamma: 1 },
    b: { band: 2, lo: 0, hi: 1, gamma: 1 },
  },
  DAYCLOUDPHASE: {
    name: 'Day Cloud Phase', short: 'DayCloud', day: true,
    r: { band: 13, lo: 280.65, hi: 219.65, gamma: 1 }, // cold → bright (inverted via lo>hi)
    g: { band: 2, lo: 0, hi: 0.78, gamma: 1 },
    b: { band: 5, lo: 0.01, hi: 0.59, gamma: 1 },
  },
  AIRMASS: {
    name: 'Air Mass', short: 'AirMass', day: false,
    r: { diff: [8, 10], lo: -26.2, hi: 0.6, gamma: 1 },
    g: { diff: [12, 13], lo: -43.2, hi: 6.7, gamma: 1 },
    b: { band: 8, lo: 243.9, hi: 208.5, gamma: 1 },          // inverted (lo>hi)
  },
  NIGHTMICRO: {
    name: 'Night Microphysics', short: 'NightMicro', day: false,
    r: { diff: [15, 13], lo: -6.7, hi: 2.6, gamma: 1 },
    g: { diff: [13, 7], lo: -3.1, hi: 5.2, gamma: 1 },
    b: { band: 13, lo: 243.6, hi: 292.6, gamma: 1 },
  },
};

export const SAT_RGB_ORDER = ['GEOCOLOR', 'TRUECOLOR', 'NATCOLOR', 'DAYCLOUDPHASE', 'AIRMASS', 'NIGHTMICRO'];

// Which bands a product needs (so we only download/decode those channels).
export function bandsFor(productId) {
  if (productId.startsWith('C')) return [parseInt(productId.slice(1), 10)];
  const recipe = SAT_RGB[productId.replace(/^RGB_/, '')];
  if (!recipe) return [13];
  const set = new Set();
  for (const k of ['r', 'g', 'b', 'veg', 'ir']) {
    const c = recipe[k];
    if (!c) continue;
    if (c.band) set.add(c.band);
    if (c.diff) { set.add(c.diff[0]); set.add(c.diff[1]); }
  }
  return [...set].sort((a, b) => a - b);
}

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

// Stretch a physical value to 0..1 across [lo,hi] (lo>hi inverts), with gamma.
function stretch(v, lo, hi, gamma) {
  if (Number.isNaN(v)) return NaN;
  let t = (v - lo) / (hi - lo);
  t = clamp01(t);
  if (gamma && gamma !== 1) t = Math.pow(t, 1 / gamma);
  return t;
}

// Colour enhancements for the IR channels, defined as [Kelvin, r, g, b] knots,
// warmest first, linearly interpolated. The data are brightness temperatures, so
// these reproduce the familiar enhancement curves used by satellite imagery.
const C2K = (c) => c + 273.15;

// Infrared "rainbow" window enhancement (screenshot 1): grey for warm scenes,
// then cyan→blue→green→yellow→orange→red for progressively colder cloud tops,
// a grey band in the deep cold, and magenta at the very coldest overshooting
// tops. Knots given in °C and converted to Kelvin.
const IR_RAMP = [
  [C2K(50), 0, 0, 0], [C2K(30), 105, 105, 105], [C2K(20), 160, 160, 160],
  [C2K(0), 225, 225, 225], [C2K(-20), 0, 230, 240], [C2K(-25), 0, 150, 230],
  [C2K(-32), 0, 40, 200], [C2K(-40), 10, 10, 120], [C2K(-42), 0, 90, 40],
  [C2K(-50), 0, 210, 0], [C2K(-55), 180, 230, 0], [C2K(-60), 240, 240, 0],
  [C2K(-63), 250, 150, 0], [C2K(-68), 240, 0, 0], [C2K(-72), 120, 0, 0],
  [C2K(-75), 10, 10, 10], [C2K(-78), 90, 90, 90], [C2K(-83), 180, 180, 180],
  [C2K(-87), 240, 240, 240], [C2K(-90), 255, 0, 255], [C2K(-95), 150, 0, 180],
];

// Water-vapour enhancement (screenshot 2): warm (dry, low-level) scenes in
// red→orange→yellow, a sharp step to blue through the mid range, then white and
// the green family deepening into bright cyan for the coldest (highest, moistest)
// cloud tops.
const WV_RAMP = [
  [C2K(0), 120, 0, 0], [C2K(-10), 230, 0, 0], [C2K(-14), 255, 120, 0],
  [C2K(-18), 255, 200, 0], [C2K(-20), 255, 255, 0], [C2K(-24), 150, 140, 0],
  [C2K(-28), 40, 40, 180], [C2K(-34), 0, 60, 200], [C2K(-40), 10, 10, 90],
  [C2K(-44), 120, 90, 180], [C2K(-48), 220, 210, 235], [C2K(-52), 255, 255, 255],
  [C2K(-58), 200, 235, 200], [C2K(-62), 80, 200, 90], [C2K(-70), 0, 160, 70],
  [C2K(-78), 0, 120, 60], [C2K(-82), 0, 180, 160], [C2K(-88), 0, 230, 220],
  [C2K(-95), 0, 255, 255],
];

// The water-vapour channels (upper/mid/lower-level WV) get the WV enhancement;
// every other IR channel gets the IR rainbow.
export const WV_BANDS = new Set([8, 9, 10]);

// Sample a [K,r,g,b] knot ramp (warmest first) at brightness temperature `k`.
function rampColor(ramp, k) {
  if (Number.isNaN(k)) return null;
  if (k >= ramp[0][0]) { const c = ramp[0]; return [c[1], c[2], c[3]]; }
  for (let i = 0; i < ramp.length - 1; i++) {
    const a = ramp[i], b = ramp[i + 1];
    if (k <= a[0] && k >= b[0]) {
      const t = (a[0] - k) / (a[0] - b[0]);
      return [a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t];
    }
  }
  const c = ramp[ramp.length - 1];
  return [c[1], c[2], c[3]];
}

// Pick the right enhancement ramp for an ABI band.
const rampForBand = (band) => (WV_BANDS.has(band) ? WV_RAMP : IR_RAMP);

// Build a CSS linear-gradient (warm → cold, left → right) for a band's
// enhancement, so the legend bar matches the imagery.
export function enhancementGradientCSS(band) {
  const ramp = rampForBand(band);
  const warm = ramp[0][0], cold = ramp[ramp.length - 1][0];
  const span = warm - cold || 1;
  const stops = ramp.map((c) => {
    const pct = ((warm - c[0]) / span) * 100;
    return `rgb(${c[1] | 0},${c[2] | 0},${c[3] | 0}) ${pct.toFixed(1)}%`;
  });
  return `linear-gradient(90deg,${stops.join(',')})`;
}

// Subsolar point (solar declination + subsolar longitude, radians/degrees) for a
// UTC instant — a NOAA-almanac approximation good to a fraction of a degree, ample
// for shading the GeoColor terminator.
function subsolarPoint(date) {
  const d = date || new Date();
  const start = Date.UTC(d.getUTCFullYear(), 0, 0);
  const doy = (Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - start) / 86400000;
  const frac = (d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600) / 24;
  const g = (2 * Math.PI / 365) * (doy - 1 + (frac - 0.5));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g)
    - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g)
    - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const eqt = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g)
    - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const subLon = -((frac * 1440 + eqt) / 4 - 180); // degrees
  return { decl, sinDecl: Math.sin(decl), cosDecl: Math.cos(decl), subLon };
}

// Render GeoColor: daytime true colour crossfaded with a night-time IR cloud
// rendering by solar elevation, evaluated per pixel from the scene's geostationary
// navigation and scan time.
function buildGeoColor(scene, recipe, out) {
  const W = scene.width, H = scene.height, ch = scene.channels;
  const ir = ch[recipe.ir.band];
  const sun = subsolarPoint(scene.time);
  const D2R = Math.PI / 180;
  const comp = (spec, i) => stretch(ch[spec.band][i], spec.lo, spec.hi, spec.gamma);
  for (let row = 0; row < H; row++) {
    const yy = scene.yOffset + row * scene.yScale;
    for (let col = 0; col < W; col++) {
      const i = row * W + col, o = i * 4;
      const r0 = comp(recipe.r, i), b0 = comp(recipe.b, i);
      const bt = ir ? ir[i] : NaN;
      if (Number.isNaN(r0) && Number.isNaN(b0) && Number.isNaN(bt)) { out[o + 3] = 0; continue; }

      // Day true colour (CIMSS synthetic green), reused from the true-colour path.
      // Kept 0 where the visible bands are missing (night side) so a NaN can't
      // poison the blend through the wDay=0 weighting below.
      let dr = 0, dg = 0, db = 0;
      if (!Number.isNaN(r0)) { dr = r0; db = b0; dg = 0.45 * r0 + 0.45 * b0 + 0.1 * comp(recipe.veg, i); }

      // Night IR: clear scenes a deep navy "earth", cold cloud tops brightening to
      // white, so storms stand out against the dark side.
      const cloud = clamp01((290 - bt) / (290 - 220));
      const nr = 6 + cloud * 224, ng = 14 + cloud * 226, nb = 38 + cloud * 200;

      // Crossfade by solar elevation: full day a few degrees above the horizon,
      // full night a few below, a soft band across the terminator.
      let wDay = 1;
      const ll = scanToLonLat(scene.xOffset + col * scene.xScale, yy, scene.proj);
      if (ll) {
        const latR = ll[1] * D2R;
        const mu = Math.sin(latR) * sun.sinDecl
          + Math.cos(latR) * sun.cosDecl * Math.cos((ll[0] - sun.subLon) * D2R);
        wDay = clamp01((mu + 0.10) / 0.20);
      }
      if (Number.isNaN(r0)) wDay = 0;        // no daytime data here — show night
      if (Number.isNaN(bt)) wDay = 1;        // no IR — fall back to day colour

      out[o] = (clamp01(dr * wDay + nr / 255 * (1 - wDay)) * 255) | 0;
      out[o + 1] = (clamp01(dg * wDay + ng / 255 * (1 - wDay)) * 255) | 0;
      out[o + 2] = (clamp01(db * wDay + nb / 255 * (1 - wDay)) * 255) | 0;
      out[o + 3] = 255;
    }
  }
  return out;
}

// Build the W×H RGBA texture for a product. `enhance` (IR colour) only affects
// single IR channels.
export function buildRGBA(scene, productId, opts = {}) {
  const W = scene.width, H = scene.height;
  const out = new Uint8Array(W * H * 4);
  const ch = scene.channels;

  // ---- single channel ----
  if (productId.startsWith('C')) {
    const band = parseInt(productId.slice(1), 10);
    const meta = SAT_CHANNELS[band - 1];
    const data = ch[band];
    const isVis = meta.type === 'vis';
    const enhanceIR = opts.enhanceIR && !isVis;
    for (let i = 0; i < W * H; i++) {
      const v = data[i];
      const o = i * 4;
      if (Number.isNaN(v)) { out[o + 3] = 0; continue; }
      if (isVis) {
        const t = clamp01(Math.sqrt(clamp01(v))); // sqrt gamma for the eye
        const g = (t * 255) | 0;
        out[o] = g; out[o + 1] = g; out[o + 2] = g; out[o + 3] = 255;
      } else if (enhanceIR) {
        const c = rampColor(rampForBand(band), v);
        out[o] = c[0] | 0; out[o + 1] = c[1] | 0; out[o + 2] = c[2] | 0; out[o + 3] = 255;
      } else {
        // IR brightness temperature: invert so cold cloud tops are white.
        const t = stretch(v, 313, 183, 1);
        const g = (clamp01(t) * 255) | 0;
        out[o] = g; out[o + 1] = g; out[o + 2] = g; out[o + 3] = 255;
      }
    }
    return out;
  }

  // ---- RGB composite ----
  const recipe = SAT_RGB[productId.replace(/^RGB_/, '')];
  if (!recipe) return out;
  if (recipe.geocolor) return buildGeoColor(scene, recipe, out);
  const comp = (spec, i) => {
    if (!spec) return 0;
    if (spec.diff) {
      const a = ch[spec.diff[0]][i], b = ch[spec.diff[1]][i];
      return stretch(a - b, spec.lo, spec.hi, spec.gamma);
    }
    return stretch(ch[spec.band][i], spec.lo, spec.hi, spec.gamma);
  };
  for (let i = 0; i < W * H; i++) {
    const o = i * 4;
    let r, g, b;
    if (recipe.green === 'synthetic') {
      r = comp(recipe.r, i);
      b = comp(recipe.b, i);
      const veg = comp(recipe.veg, i);
      // CIMSS true-colour synthetic green.
      g = 0.45 * r + 0.45 * b + 0.1 * veg;
    } else {
      r = comp(recipe.r, i);
      g = comp(recipe.g, i);
      b = comp(recipe.b, i);
    }
    if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) { out[o + 3] = 0; continue; }
    out[o] = (clamp01(r) * 255) | 0;
    out[o + 1] = (clamp01(g) * 255) | 0;
    out[o + 2] = (clamp01(b) * 255) | 0;
    out[o + 3] = 255;
  }
  return out;
}
