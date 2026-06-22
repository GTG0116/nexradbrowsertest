// products.js — radar product definitions, color scales, and .pal parsing.
//
// A "scale" maps a physical value to an RGBA color through a precomputed lookup
// table (`rgba`, 4 bytes per step). Scales are built from "segments": each
// segment has a start value and a start color, and optionally a distinct end
// color, so we can represent both smooth ramps and the two-color gradient
// segments used by GRLevelX `.pal` files. Alpha is supported so palettes can
// make selected value ranges transparent.

const STEPS = 1024;

function lerp(a, b, t) {
  return Math.round(a + (b - a) * t);
}

// segments: [{ v, c1:[r,g,b,a?], c2:[r,g,b,a?]|null }]  (a defaults to 255)
export function makeScale(segments) {
  const segs = [...segments].sort((a, b) => a.v - b.v);
  const lo = segs[0].v;
  const hi = segs[segs.length - 1].v;
  const rgba = new Uint8Array(STEPS * 4);
  const span = hi - lo || 1;
  let seg = 0;
  for (let i = 0; i < STEPS; i++) {
    const v = lo + (span * i) / (STEPS - 1);
    while (seg < segs.length - 2 && v > segs[seg + 1].v) seg++;
    const a = segs[seg];
    const b = segs[Math.min(seg + 1, segs.length - 1)];
    let t = b.v > a.v ? (v - a.v) / (b.v - a.v) : 0;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const start = a.c1;
    const end = a.c2 || b.c1;
    const o = i * 4;
    rgba[o] = lerp(start[0], end[0], t);
    rgba[o + 1] = lerp(start[1], end[1], t);
    rgba[o + 2] = lerp(start[2], end[2], t);
    rgba[o + 3] = lerp(start[3] == null ? 255 : start[3], end[3] == null ? 255 : end[3], t);
  }
  return { lo, hi, steps: STEPS, rgba };
}

// Convert single-color stops into segments (each gradients to the next stop).
function stopsToSegments(stops) {
  return stops.map((s) => ({ v: s.v, c1: [...s.c, 255], c2: null }));
}

const s = (v, c) => ({ v, c });

// Reflectivity (dBZ) — classic NWS reflectivity ramp.
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

// Correlation coefficient (ρHV) — matched to the GR-style base table: greyscale
// at low CC (non-meteorological / debris), blue–green through the mid range,
// yellow/orange/red approaching 1, and pink at the very top.
const CC_STOPS = [
  s(0.2, [50, 50, 50]),
  s(0.3, [90, 90, 90]),
  s(0.45, [150, 150, 150]),
  s(0.5, [110, 105, 180]),
  s(0.55, [70, 70, 215]),
  s(0.65, [0, 80, 255]),
  s(0.72, [0, 200, 200]),
  s(0.8, [60, 220, 80]),
  s(0.85, [240, 240, 0]),
  s(0.9, [255, 180, 0]),
  s(0.93, [255, 100, 0]),
  s(0.96, [255, 0, 0]),
  s(0.98, [220, 0, 90]),
  s(1.0, [255, 145, 225]),
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

// `disp` carries an imperial display conversion applied only to the *labels and
// readouts* (legend ticks, cursor / inspect values) — the color scale and the
// physical values stay native, so colours are unaffected. value_shown =
// value*factor + offset.
const MS_TO_MPH = 2.2369363;

function product(id, name, unit, moment, stops, disp) {
  const scale = makeScale(stopsToSegments(stops));
  const dispUnit = (disp && disp.unit) || unit;
  const dispFactor = (disp && disp.factor) || 1;
  const dispOffset = (disp && disp.offset) || 0;
  return {
    id,
    name,
    unit,
    defaultUnit: unit,
    moment,
    range: [scale.lo, scale.hi],
    scale,
    defaultScale: scale,
    dispUnit, dispFactor, dispOffset,
    defaultDispUnit: dispUnit, defaultDispFactor: dispFactor, defaultDispOffset: dispOffset,
  };
}

export const PRODUCTS = {
  REF: product('REF', 'Reflectivity', 'dBZ', 'REF', REF_STOPS),
  VEL: product('VEL', 'Velocity', 'm/s', 'VEL', VEL_STOPS, { unit: 'mph', factor: MS_TO_MPH }),
  SW: product('SW', 'Spectrum Width', 'm/s', 'SW', SW_STOPS, { unit: 'mph', factor: MS_TO_MPH }),
  RHO: product('RHO', 'Correlation Coeff.', 'ρHV', 'RHO', CC_STOPS),
  ZDR: product('ZDR', 'Differential Refl.', 'dB', 'ZDR', ZDR_STOPS),
  PHI: product('PHI', 'Differential Phase', '°', 'PHI', PHI_STOPS),
};

// Decimal places to show for a (display) unit.
const UNIT_DECIMALS = {
  mph: 0, in: 2, '°F': 0, '°C': 0, dBZ: 0, ρHV: 2, dB: 1, '°': 0, '%': 0, 'm/s': 1,
  kt: 0, 'J/kg': 0, 'm²/s²': 0, '°C/km': 1, '10⁻⁵/s': 0, m: 0, 'flash/km²': 1,
};
export function unitDecimals(unit) {
  return unit in UNIT_DECIMALS ? UNIT_DECIMALS[unit] : 1;
}

// Convert a native physical value to its imperial display value + format it.
export function dispValue(product, v) {
  return v * (product.dispFactor || 1) + (product.dispOffset || 0);
}
export function dispUnitOf(product) {
  return product.dispUnit || product.unit;
}

// Conversion from a product's NATIVE physical unit to a display unit. A loaded
// .pal color table lists its thresholds in its own `Units`, but the shader and
// point sampler work in the native unit (m/s for velocity), so when a table is
// authored in an alternate unit we use this to (a) convert its thresholds back
// to native for the color LUT and (b) keep the native->display factor for the
// legend and readout. Keys are lower-cased display units.
const UNIT_FACTORS = {
  'm/s': {
    'm/s': 1, mps: 1, ms: 1,
    mph: MS_TO_MPH,
    kt: 1.9438445, kts: 1.9438445, knot: 1.9438445, knots: 1.9438445,
    'km/h': 3.6, kph: 3.6, kmh: 3.6,
  },
};

// Factor converting `nativeUnit` -> `dispUnit`, or null when the pair is unknown
// (caller then shows thresholds verbatim, as before).
export function displayFactorFor(nativeUnit, dispUnit) {
  if (!dispUnit) return null;
  const table = UNIT_FACTORS[nativeUnit];
  if (!table) return null;
  const f = table[String(dispUnit).trim().toLowerCase()];
  return f == null ? null : f;
}

export const PRODUCT_ORDER = ['REF', 'VEL', 'SW', 'RHO', 'ZDR', 'PHI'];

// The reflectivity color table is shared across single-site radar, MRMS and the
// weather models, so they all draw dBZ identically — and a user-loaded
// reflectivity .pal (which targets REF) recolours every one of them. A grid
// product flagged `reflectivity:true` borrows REF's *live* scale and range here
// (keeping its own `floor`), so it always tracks whatever REF currently uses.
export function reflectivityProduct(base) {
  const ref = PRODUCTS.REF;
  return {
    ...base,
    scale: ref.scale,
    lo: ref.scale.lo,
    hi: ref.scale.hi,
    unit: ref.unit,
    dispUnit: ref.dispUnit,
    dispFactor: ref.dispFactor,
    dispOffset: ref.dispOffset,
  };
}

// ---------------------------------------------------------------------------
// GRLevelX / GR2Analyst ".pal" color table parser.
//
// Recognised directives (case-insensitive):
//   Color:  value  r g b  [r2 g2 b2]
//   Color4: value  r g b a [r2 g2 b2 a2]
//   SolidColor(4): value r g b [a]      (constant color, no gradient)
//   Product:/Units:/Step:/RF:           (metadata)
// A line's second color triplet, when present, is the color at the *next* entry,
// producing a gradient across the segment.
// ---------------------------------------------------------------------------
export function parsePal(text) {
  const segments = [];
  let units = null;
  let productHint = null;
  let rf = null;

  for (let raw of text.split(/\r?\n/)) {
    const line = raw.replace(/;.*$/, '').trim(); // strip comments
    if (!line) continue;
    const m = line.match(/^(\w+)\s*:?\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const rest = m[2].trim();

    if (key === 'units') {
      units = rest;
      continue;
    }
    if (key === 'product') {
      productHint = rest;
      continue;
    }
    if (key === 'rf') {
      const n = rest.split(/[\s,]+/).map(Number);
      rf = [n[0] || 0, n[1] || 0, n[2] || 0, n[3] == null ? 255 : n[3]];
      continue;
    }
    if (key === 'color' || key === 'color4' || key === 'solidcolor' || key === 'solidcolor4') {
      const hasAlpha = key.endsWith('4');
      const n = rest.split(/[\s,]+/).map(Number);
      if (n.length < (hasAlpha ? 5 : 4)) continue;
      let i = 0;
      const v = n[i++];
      const c1 = [n[i++], n[i++], n[i++], hasAlpha ? n[i++] : 255];
      let c2 = null;
      if (n.length >= i + (hasAlpha ? 4 : 3)) {
        c2 = [n[i++], n[i++], n[i++], hasAlpha ? n[i++] : 255];
      }
      // SolidColor: constant across its segment.
      if (key.startsWith('solid')) c2 = c1.slice();
      if ([v, ...c1].some((x) => Number.isNaN(x))) continue;
      segments.push({ v, c1, c2 });
    }
  }

  if (segments.length < 2) throw new Error('no usable Color entries found');
  return { segments, units, productHint, rf };
}

// Map a .pal "Product:" / "Units:" hint to one of our product ids, if possible.
export function palTargetProduct(pal) {
  const hint = `${pal.productHint || ''} ${pal.units || ''}`.toUpperCase();
  if (/\bCC\b|RHOHV|CORRELATION/.test(hint)) return 'RHO';
  if (/ZDR|DIFFERENTIAL REF/.test(hint)) return 'ZDR';
  if (/PHI|KDP|DIFFERENTIAL PH/.test(hint)) return 'PHI';
  if (/\bSW\b|SPECTRUM/.test(hint)) return 'SW';
  if (/\bBV\b|\bV\b|VEL|M\/S|KT|KNOT/.test(hint)) return 'VEL';
  if (/\bBR\b|\bZ\b|DBZ|REFLECT/.test(hint)) return 'REF';
  return null;
}

// Map a physical value to [r,g,b,a] using a product's scale.
export function colorFor(product, v) {
  if (Number.isNaN(v)) return null;
  const { rgba, lo, hi, steps } = product.scale;
  let i = Math.round(((v - lo) / (hi - lo)) * (steps - 1));
  if (i < 0) i = 0;
  else if (i >= steps) i = steps - 1;
  const o = i * 4;
  return [rgba[o], rgba[o + 1], rgba[o + 2], rgba[o + 3]];
}
