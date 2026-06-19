// products.js — radar product definitions and color scales.
//
// Each product maps a physical value to an RGB color via a set of control
// stops. Colors are interpolated in between so the rendered image is smooth.
// The palettes follow conventional NWS / radar-meteorology color schemes so
// the output reads correctly to anyone used to weather radar.

function buildLUT(stops, lo, hi, steps = 1024) {
  // Precompute a lookup table from value -> [r,g,b] for fast rendering.
  const lut = new Uint8Array(steps * 3);
  for (let i = 0; i < steps; i++) {
    const v = lo + ((hi - lo) * i) / (steps - 1);
    const c = sampleStops(stops, v);
    lut[i * 3] = c[0];
    lut[i * 3 + 1] = c[1];
    lut[i * 3 + 2] = c[2];
  }
  return { lut, lo, hi, steps };
}

function sampleStops(stops, v) {
  if (v <= stops[0].v) return stops[0].c;
  if (v >= stops[stops.length - 1].v) return stops[stops.length - 1].c;
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    if (v >= a.v && v <= b.v) {
      const t = (v - a.v) / (b.v - a.v);
      return [
        Math.round(a.c[0] + (b.c[0] - a.c[0]) * t),
        Math.round(a.c[1] + (b.c[1] - a.c[1]) * t),
        Math.round(a.c[2] + (b.c[2] - a.c[2]) * t),
      ];
    }
  }
  return stops[stops.length - 1].c;
}

const s = (v, c) => ({ v, c });

// Reflectivity (dBZ) — the classic NWS reflectivity ramp.
const REF_STOPS = [
  s(-30, [0, 0, 0]),
  s(5, [4, 233, 231]),
  s(10, [1, 159, 244]),
  s(15, [3, 0, 244]),
  s(20, [2, 253, 2]),
  s(25, [1, 197, 1]),
  s(30, [0, 142, 0]),
  s(35, [253, 248, 2]),
  s(40, [229, 188, 0]),
  s(45, [253, 149, 0]),
  s(50, [253, 0, 0]),
  s(55, [212, 0, 0]),
  s(60, [188, 0, 0]),
  s(65, [248, 0, 253]),
  s(70, [152, 84, 198]),
  s(75, [253, 253, 253]),
];

// Velocity (m/s) — green inbound, red outbound, grey near zero.
const VEL_STOPS = [
  s(-40, [0, 224, 0]),
  s(-30, [0, 160, 0]),
  s(-20, [0, 96, 0]),
  s(-10, [0, 200, 200]),
  s(-1, [80, 110, 110]),
  s(0, [110, 110, 110]),
  s(1, [110, 80, 80]),
  s(10, [200, 0, 0]),
  s(20, [160, 0, 0]),
  s(30, [128, 0, 0]),
  s(40, [255, 160, 0]),
];

// Spectrum width (m/s).
const SW_STOPS = [
  s(0, [0, 0, 60]),
  s(4, [0, 120, 255]),
  s(8, [0, 220, 120]),
  s(12, [230, 230, 0]),
  s(16, [255, 120, 0]),
  s(20, [255, 0, 0]),
];

// Correlation coefficient (unitless 0..1) — highlights non-meteo / debris.
const CC_STOPS = [
  s(0.2, [40, 40, 40]),
  s(0.45, [90, 0, 140]),
  s(0.65, [0, 60, 200]),
  s(0.8, [0, 180, 200]),
  s(0.9, [0, 200, 60]),
  s(0.95, [230, 230, 0]),
  s(0.98, [255, 120, 0]),
  s(1.0, [255, 255, 255]),
];

// Differential reflectivity (dB).
const ZDR_STOPS = [
  s(-4, [60, 60, 60]),
  s(-1, [0, 0, 180]),
  s(0, [0, 160, 160]),
  s(1, [0, 200, 0]),
  s(2, [230, 230, 0]),
  s(4, [255, 120, 0]),
  s(6, [255, 0, 0]),
  s(8, [255, 0, 255]),
];

// Differential phase (degrees).
const PHI_STOPS = [
  s(0, [20, 20, 60]),
  s(60, [0, 120, 220]),
  s(120, [0, 200, 120]),
  s(180, [230, 220, 0]),
  s(240, [255, 120, 0]),
  s(360, [255, 0, 0]),
];

export const PRODUCTS = {
  REF: {
    id: 'REF',
    name: 'Reflectivity',
    unit: 'dBZ',
    moment: 'REF',
    range: [-30, 75],
    scale: buildLUT(REF_STOPS, -30, 75),
  },
  VEL: {
    id: 'VEL',
    name: 'Velocity',
    unit: 'm/s',
    moment: 'VEL',
    range: [-40, 40],
    scale: buildLUT(VEL_STOPS, -40, 40),
  },
  SW: {
    id: 'SW',
    name: 'Spectrum Width',
    unit: 'm/s',
    moment: 'SW',
    range: [0, 20],
    scale: buildLUT(SW_STOPS, 0, 20),
  },
  RHO: {
    id: 'RHO',
    name: 'Correlation Coeff.',
    unit: 'ρHV',
    moment: 'RHO',
    range: [0.2, 1.0],
    scale: buildLUT(CC_STOPS, 0.2, 1.0),
  },
  ZDR: {
    id: 'ZDR',
    name: 'Differential Refl.',
    unit: 'dB',
    moment: 'ZDR',
    range: [-4, 8],
    scale: buildLUT(ZDR_STOPS, -4, 8),
  },
  PHI: {
    id: 'PHI',
    name: 'Differential Phase',
    unit: '°',
    moment: 'PHI',
    range: [0, 360],
    scale: buildLUT(PHI_STOPS, 0, 360),
  },
};

export const PRODUCT_ORDER = ['REF', 'VEL', 'SW', 'RHO', 'ZDR', 'PHI'];

// Map a physical value to [r,g,b] using a product's precomputed LUT.
export function colorFor(product, v) {
  if (Number.isNaN(v)) return null;
  const { lut, lo, hi, steps } = product.scale;
  let i = Math.round(((v - lo) / (hi - lo)) * (steps - 1));
  if (i < 0) i = 0;
  if (i >= steps) i = steps - 1;
  const o = i * 3;
  return [lut[o], lut[o + 1], lut[o + 2]];
}
