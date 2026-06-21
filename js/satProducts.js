// satProducts.js — GOES ABI channel definitions, single-channel enhancements,
// and multi-band RGB composite recipes. `buildRGBA` turns a decoded scene
// (physical units per band, from goes.js) into the W×H RGBA display texture the
// satellite GL layer samples; all the colour science lives here on the CPU so
// the shader only has to handle the geostationary projection.

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

export const SAT_RGB_ORDER = ['TRUECOLOR', 'NATCOLOR', 'DAYCLOUDPHASE', 'AIRMASS', 'NIGHTMICRO'];

// Which bands a product needs (so we only download/decode those channels).
export function bandsFor(productId) {
  if (productId.startsWith('C')) return [parseInt(productId.slice(1), 10)];
  const recipe = SAT_RGB[productId.replace(/^RGB_/, '')];
  if (!recipe) return [13];
  const set = new Set();
  for (const k of ['r', 'g', 'b', 'veg']) {
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

// A simple infrared colour enhancement for the clean-window channels: grey for
// warm scenes, then blue→green→yellow→red→white for progressively colder cloud
// tops (the classic “IR rainbow”, in Kelvin).
const IR_RAMP = [
  [330, 0, 0, 0], [243, 175, 175, 175], [242, 0, 0, 0], [220, 0, 0, 200],
  [210, 0, 180, 180], [200, 0, 200, 0], [190, 230, 230, 0], [180, 230, 120, 0],
  [170, 220, 0, 0], [160, 150, 0, 0], [150, 255, 255, 255], [120, 120, 120, 120],
];
function irColor(k) {
  if (Number.isNaN(k)) return null;
  if (k >= IR_RAMP[0][0]) { const c = IR_RAMP[0]; return [c[1], c[2], c[3]]; }
  for (let i = 0; i < IR_RAMP.length - 1; i++) {
    const a = IR_RAMP[i], b = IR_RAMP[i + 1];
    if (k <= a[0] && k >= b[0]) {
      const t = (a[0] - k) / (a[0] - b[0]);
      return [a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t];
    }
  }
  const c = IR_RAMP[IR_RAMP.length - 1];
  return [c[1], c[2], c[3]];
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
        const c = irColor(v);
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
