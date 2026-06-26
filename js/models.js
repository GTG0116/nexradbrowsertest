// models.js — list and load NWP model output from the open NODD AWS buckets,
// decoded with grib2.js. It exposes a range of HRRR surface fields —
// reflectivity, temperature, wind, humidity, cloud cover and precipitation.
//
// HRRR posts a full GRIB2 file per cycle plus a sidecar `.idx` index that lists
// every field and its byte offset. We read the tiny index, find the composite
// reflectivity record, and issue a single HTTP Range request for just that
// message — so loading one field costs a few hundred KB, not the ~150 MB file.
//
// HRRR is on a Lambert Conformal grid, so after decoding we resample it onto a
// plain lat/lon grid (resampleLambert) — that lets it ride the exact same GPU
// grid layer and inspect path as the lat/lon MRMS products.

import { decodeGrib2 } from './grib2.js';
import { makeScale } from './products.js';

// Optional CORS proxy for buckets that don't advertise CORS (RRFS — see
// `needsProxy` below). Left empty, those models talk to AWS directly, which a
// browser will block; set a Range-capable proxy prefix here to enable them. The
// proxy must forward the `Range` request header and return 206 Partial Content,
// since model loads fetch single GRIB messages by byte range.
function defaultModelProxy() {
  const loc = window.location;
  const local = /^(localhost|127\.0\.0\.1|::1)$/.test(loc.hostname);
  if (local && loc.port && loc.port !== '8080') {
    const host = loc.hostname === '::1' ? '[::1]' : loc.hostname;
    return `${loc.protocol}//${host}:8080/proxy?url=`;
  }
  return `${loc.origin}/proxy?url=`;
}
let modelProxy = defaultModelProxy();
export function setModelProxy(p) {
  modelProxy = p || '';
}
// The fetch URL for a bucket key, routed through the proxy for `needsProxy`
// models when one is configured (otherwise the bare bucket URL).
function modelUrl(model, key) {
  const full = `${model.bucket}/${key}`;
  return model.needsProxy && modelProxy ? modelProxy + encodeURIComponent(full) : full;
}

// Available models, each backed by a CORS-enabled NODD AWS bucket (listing, GET
// and Range requests). Per-model fields:
//   keysFor(day, cycle, fhour, file) → { grib, idx } object keys.
//   cycleStep   hours between model runs (1 = hourly, 6 = synoptic only).
//   latencyMin  minutes after a cycle's nominal time before it's posted.
//   maxForecastHour(cycle) / forecastHoursList(cycle) define the forecast hours
//     a run offers — the former for plain hourly ranges, the latter for mixed
//     stepping (e.g. NAM hourly to F36 then 3-hourly).
//   levelFix    per-variable level-string overrides where a model labels a field
//     differently than HRRR (e.g. NAM/RAP store lightning at 'surface').
//   products    the subset of MODEL_PRODUCTS this model can supply (attached
//     below, once MODEL_ORDER exists); unset means "all".
// HRRR posts surface ('sfc'/wrfsfc) and pressure ('prs'/wrfprs) files
// separately; the other models pack everything into one file per forecast hour,
// so their keysFor ignores the `file` argument.
export const MODELS = {
  hrrr: {
    id: 'hrrr',
    label: 'HRRR (3 km CONUS)',
    bucket: 'https://noaa-hrrr-bdp-pds.s3.amazonaws.com',
    cycleStep: 1,
    latencyMin: 55,
    keysFor(dayStr, cycle, fhour, file = 'sfc') {
      const kind = file === 'prs' ? 'wrfprs' : 'wrfsfc';
      const grib = `hrrr.${dayStr}/conus/hrrr.t${pad(cycle)}z.${kind}f${pad(fhour)}.grib2`;
      return { grib, idx: grib + '.idx' };
    },
    // Synoptic cycles (00/06/12/18z) run out to F48; the rest to F18.
    maxForecastHour(cycle) {
      return cycle % 6 === 0 ? 48 : 18;
    },
  },
  nam: {
    id: 'nam',
    label: 'NAM (12 km CONUS)',
    bucket: 'https://noaa-nam-pds.s3.amazonaws.com',
    cycleStep: 6,
    latencyMin: 200,
    levelFix: { LTNG: 'surface' },
    keysFor(dayStr, cycle, fhour) {
      const grib = `nam.${dayStr}/nam.t${pad(cycle)}z.awphys${pad(fhour)}.tm00.grib2`;
      return { grib, idx: grib + '.idx' };
    },
    // Hourly to F36, then 3-hourly out to F84.
    forecastHoursList() {
      return steppedList(36, 84, 3);
    },
  },
  namnest: {
    id: 'namnest',
    label: 'NAM Nest (3 km CONUS)',
    bucket: 'https://noaa-nam-pds.s3.amazonaws.com',
    cycleStep: 6,
    latencyMin: 200,
    levelFix: { LTNG: 'surface' },
    keysFor(dayStr, cycle, fhour) {
      const grib = `nam.${dayStr}/nam.t${pad(cycle)}z.conusnest.hiresf${pad(fhour)}.tm00.grib2`;
      return { grib, idx: grib + '.idx' };
    },
    maxForecastHour() {
      return 60;
    },
  },
  rap: {
    id: 'rap',
    label: 'RAP (13 km CONUS)',
    // The AWS noaa-rap-pds bucket isn't CORS-enabled (unlike the HRRR/NAM/GFS
    // ones), so browser fetches are blocked; use Azure's mirror, which sends
    // Access-Control-Allow-Origin. Same key layout, same JPEG2000-packed data.
    bucket: 'https://noaarap.blob.core.windows.net/rap',
    cycleStep: 1,
    latencyMin: 75,
    levelFix: { LTNG: 'surface' },
    keysFor(dayStr, cycle, fhour) {
      const grib = `rap.${dayStr}/rap.t${pad(cycle)}z.awp130pgrbf${pad(fhour)}.grib2`;
      return { grib, idx: grib + '.idx' };
    },
    // Extended (51 h) runs at 03/09/15/21z; the rest reach F21.
    maxForecastHour(cycle) {
      return cycle % 6 === 3 ? 51 : 21;
    },
  },
  gfs: {
    id: 'gfs',
    label: 'GFS (0.25° Global)',
    bucket: 'https://noaa-gfs-bdp-pds.s3.amazonaws.com',
    cycleStep: 6,
    latencyMin: 230,
    keysFor(dayStr, cycle, fhour) {
      const grib = `gfs.${dayStr}/${pad(cycle)}/atmos/gfs.t${pad(cycle)}z.pgrb2.0p25.f${pad(fhour, 3)}`;
      return { grib, idx: grib + '.idx' };
    },
    // Hourly to F120, then 3-hourly out to F384.
    forecastHoursList() {
      return steppedList(120, 384, 3);
    },
  },
  aigfs: {
    id: 'aigfs',
    label: 'AI GFS / GraphCast (0.25° Global)',
    bucket: 'https://noaa-nws-graphcastgfs-pds.s3.amazonaws.com',
    cycleStep: 6,
    latencyMin: 330,
    keysFor(dayStr, cycle, fhour) {
      const grib = `aigfs.${dayStr}/${pad(cycle)}/model/atmos/grib2/aigfs.t${pad(cycle)}z.pres.f${pad(fhour, 3)}.grib2`;
      return { grib, idx: grib + '.idx' };
    },
    // GraphCast posts pressure-level fields only, 6-hourly out to F384.
    forecastHoursList() {
      const out = [];
      for (let f = 0; f <= 384; f += 6) out.push(f);
      return out;
    },
  },
  hrrrcast: {
    id: 'hrrrcast',
    label: 'HRRRCast (3 km CONUS, AI)',
    bucket: 'https://noaa-gsl-experimental-pds.s3.amazonaws.com',
    cycleStep: 1,
    latencyMin: 120,
    // The ensemble-mean (avg) member, on the same Lambert 3 km grid as HRRR.
    keysFor(dayStr, cycle, fhour) {
      const grib = `HRRRCast/${dayStr}/${pad(cycle)}/hrrrcast.avg.t${pad(cycle)}z.pgrb2.f${pad(fhour)}`;
      return { grib, idx: grib + '.idx' };
    },
    maxForecastHour() {
      return 48;
    },
  },
  rrfs: {
    id: 'rrfs',
    label: 'RRFS (3 km CONUS)',
    bucket: 'https://noaa-rrfs-pds.s3.amazonaws.com',
    // The AWS RRFS bucket isn't CORS-enabled and has no CORS mirror (unlike the
    // RAP/Azure case), so browser fetches need a Range-capable proxy via
    // setModelProxy(); without one this model can't load in the browser.
    needsProxy: true,
    cycleStep: 1,
    latencyMin: 90,
    // Surface fields live in the 2dfld file, pressure levels in prslev.
    keysFor(dayStr, cycle, fhour, file = 'sfc') {
      const kind = file === 'prs' ? 'prslev' : '2dfld';
      const grib = `rrfs_a/rrfs.${dayStr}/${pad(cycle)}/rrfs.t${pad(cycle)}z.${kind}.3km.f${pad(fhour, 3)}.conus.grib2`;
      return { grib, idx: grib + '.idx' };
    },
    // Synoptic cycles (00/06/12/18z) run out to F84; the rest to F18.
    maxForecastHour(cycle) {
      return cycle % 6 === 0 ? 84 : 18;
    },
  },
};

// Build a forecast-hour list: hourly out to `hourlyMax`, then every `step` hours
// out to `total` (e.g. NAM = steppedList(36, 84, 3)).
function steppedList(hourlyMax, total, step) {
  const out = [];
  for (let f = 0; f <= hourlyMax; f++) out.push(f);
  for (let f = hourlyMax + step; f <= total; f += step) out.push(f);
  return out;
}

// Products are grouped into categories (MODEL_CATEGORIES, defined after the
// product table); MODEL_ORDER is the flattened list in display order.

// Display conversions applied only to legend ticks / cursor readouts — the
// physical values and color scales stay native (see products.js `disp`).
const MS_TO_MPH = 2.2369363; // m/s → mph
const MS_TO_KT = 1.9438445; // m/s → knots
const K_TO_F = { factor: 1.8, offset: -459.67 }; // kelvin → °F
const K_TO_C = { unit: '°C', factor: 1, offset: -273.15 }; // kelvin → °C
const MM_TO_IN = 1 / 25.4; // kg/m² (mm) → inches

// Build a smooth color scale from [value, [r,g,b]] stops.
const rampScale = (stops) =>
  makeScale(stops.map(([v, c]) => ({ v, c1: [c[0], c[1], c[2], 255], c2: null })));

// 2 m temperature (K). Purple/blue (cold) → green/yellow → red (hot); stops are
// placed at round °F values converted to kelvin.
const TMP_SCALE = rampScale([
  [233.15, [145, 0, 160]], [244.26, [110, 40, 200]], [255.37, [60, 60, 220]],
  [266.48, [40, 130, 230]], [273.15, [70, 200, 230]], [277.59, [60, 200, 150]],
  [283.15, [70, 200, 80]], [288.71, [150, 210, 60]], [294.26, [230, 220, 60]],
  [299.82, [240, 170, 50]], [305.37, [235, 110, 40]], [310.93, [220, 50, 40]],
  [316.48, [150, 25, 35]],
]);

// 2 m dew point (K). Brown/tan (dry) → green → teal/blue (humid).
const DPT_SCALE = rampScale([
  [249.82, [120, 90, 60]], [260.93, [150, 130, 90]], [266.48, [175, 160, 110]],
  [272.04, [205, 200, 150]], [277.59, [150, 200, 150]], [283.15, [90, 185, 110]],
  [285.93, [60, 165, 95]], [288.71, [40, 145, 95]], [291.48, [30, 130, 115]],
  [294.26, [30, 120, 135]], [297.04, [40, 110, 155]], [299.82, [60, 100, 175]],
]);

// 10 m wind speed (m/s). Stops placed at round mph values converted to m/s.
const WIND_SCALE = rampScale([
  [2.24, [180, 200, 230]], [4.47, [120, 190, 230]], [8.94, [80, 200, 160]],
  [13.41, [120, 210, 80]], [17.88, [220, 220, 70]], [22.35, [240, 160, 50]],
  [26.82, [230, 90, 50]], [31.29, [200, 40, 60]], [35.76, [150, 30, 110]],
]);

// Wind gust (m/s) — same ramp as wind, extended to higher speeds.
const GUST_SCALE = rampScale([
  [4.47, [180, 200, 230]], [8.94, [120, 190, 230]], [13.41, [80, 200, 160]],
  [17.88, [120, 210, 80]], [22.35, [220, 220, 70]], [26.82, [240, 160, 50]],
  [31.29, [230, 90, 50]], [35.76, [200, 40, 60]], [40.23, [160, 30, 110]],
  [44.70, [110, 20, 130]],
]);

// Relative humidity (%). Brown (dry) → green → blue (saturated).
const RH_SCALE = rampScale([
  [0, [120, 70, 20]], [20, [170, 130, 60]], [40, [220, 200, 130]],
  [50, [230, 230, 200]], [60, [170, 210, 150]], [70, [90, 190, 130]],
  [80, [40, 160, 140]], [90, [30, 120, 160]], [100, [20, 70, 150]],
]);

// Total cloud cover (%) — dark→light grey.
const CLOUD_SCALE = rampScale([
  [0, [40, 60, 90]], [25, [90, 110, 130]], [50, [150, 160, 170]],
  [75, [200, 205, 210]], [100, [242, 246, 250]],
]);

// Precipitation accumulation, as fractions of the product's full-scale value
// (kg/m² ≈ mm). One palette reused at several depth ranges.
const PRECIP_STOPS = [
  [0.00, [200, 240, 200]], [0.05, [110, 200, 110]], [0.10, [70, 170, 70]],
  [0.20, [60, 150, 220]], [0.35, [40, 80, 200]], [0.50, [220, 220, 80]],
  [0.65, [230, 160, 50]], [0.80, [220, 80, 40]], [0.90, [170, 30, 40]],
  [1.00, [150, 40, 130]],
];
const precipScale = (hiMM) => rampScale(PRECIP_STOPS.map(([f, c]) => [f * hiMM, c]));

// Snowfall accumulation (depth), as fractions of the product's full-scale value.
// Light dustings in pale blue, deepening through blue → purple → pink for the big
// totals, following the familiar NWS snowfall look.
const SNOW_STOPS = [
  [0.00, [219, 237, 255]], [0.04, [150, 200, 245]], [0.08, [80, 150, 230]],
  [0.16, [40, 80, 205]], [0.28, [90, 60, 200]], [0.42, [150, 50, 190]],
  [0.58, [185, 35, 150]], [0.72, [140, 20, 95]], [0.86, [205, 130, 165]],
  [1.00, [240, 225, 240]],
];
const snowScale = (hiMM) => rampScale(SNOW_STOPS.map(([f, c]) => [f * hiMM, c]));

// Ice / freezing-rain accretion (mm liquid equivalent). Pink → magenta → purple,
// distinct from the snow palette so a wintry mix reads clearly.
const ICE_STOPS = [
  [0.00, [255, 215, 235]], [0.10, [255, 160, 210]], [0.25, [235, 90, 175]],
  [0.45, [195, 40, 150]], [0.65, [145, 20, 120]], [0.85, [95, 10, 95]],
  [1.00, [60, 0, 70]],
];
const iceScale = (hiMM) => rampScale(ICE_STOPS.map(([f, c]) => [f * hiMM, c]));

// Upper-air temperature (K) — broad ramp covering values from 850 mb down to
// 500 mb. Same family of colors as the surface temperature scale.
const UA_TMP_SCALE = rampScale([
  [228.15, [120, 20, 150]], [238.15, [80, 60, 200]], [248.15, [50, 90, 220]],
  [258.15, [40, 150, 230]], [268.15, [80, 200, 200]], [273.15, [200, 200, 200]],
  [278.15, [120, 200, 110]], [288.15, [230, 220, 60]], [298.15, [235, 120, 40]],
  [308.15, [200, 40, 40]],
]);

// Wind speed aloft (m/s) — isotachs; placed at round knot values. Calm/light is
// transparent, jet-level speeds saturate to magenta.
const ISOTACH_SCALE = rampScale([
  [10.29, [120, 190, 230]], [15.43, [80, 200, 160]], [20.58, [120, 210, 80]],
  [25.72, [220, 220, 70]], [30.87, [240, 160, 50]], [41.16, [230, 90, 50]],
  [51.44, [200, 40, 60]], [61.73, [170, 30, 110]], [77.17, [120, 20, 140]],
]);

// Absolute vorticity (s⁻¹), shown in 10⁻⁵ s⁻¹. Cyclonic (positive) maxima
// highlighted yellow→red→purple; low/anticyclonic left transparent by `floor`.
const VORT_SCALE = rampScale([
  [8e-5, [120, 160, 200]], [12e-5, [120, 200, 140]], [16e-5, [220, 220, 80]],
  [22e-5, [240, 170, 50]], [28e-5, [230, 90, 50]], [36e-5, [200, 40, 60]],
  [44e-5, [160, 30, 120]], [52e-5, [110, 20, 140]],
]);

// CAPE (J/kg). Green → yellow → red → purple.
const capeScale = (hi) => rampScale([
  [0.02 * hi, [120, 200, 120]], [0.1 * hi, [70, 175, 70]], [0.2 * hi, [220, 220, 80]],
  [0.35 * hi, [240, 160, 50]], [0.5 * hi, [230, 90, 50]], [0.7 * hi, [200, 40, 60]],
  [0.85 * hi, [160, 30, 120]], [1.0 * hi, [110, 20, 140]],
]);

// CIN, stored as positive inhibition magnitude (J/kg). Weak → strong = blue →
// purple. (Displayed as a negative value.)
const CIN_SCALE = rampScale([
  [25, [120, 170, 220]], [50, [80, 130, 220]], [100, [90, 90, 210]],
  [150, [130, 60, 190]], [250, [120, 30, 150]], [400, [80, 20, 110]],
]);

// Storm-relative helicity (m²/s²).
const SRH_SCALE = rampScale([
  [50, [120, 200, 140]], [100, [220, 220, 80]], [150, [240, 170, 50]],
  [250, [230, 90, 50]], [350, [200, 40, 60]], [500, [160, 30, 120]],
]);

// Bulk shear / storm motion (m/s), shown in knots.
const SHEAR_SCALE = rampScale([
  [5.14, [120, 190, 230]], [10.29, [80, 200, 160]], [15.43, [120, 210, 80]],
  [20.58, [220, 220, 70]], [25.72, [240, 160, 50]], [30.87, [230, 90, 50]],
  [41.16, [170, 30, 110]],
]);

// 700–500 mb lapse rate (°C/km). Stable → steep = blue → red.
const LAPSE_SCALE = rampScale([
  [5.0, [70, 110, 200]], [6.0, [90, 190, 150]], [7.0, [220, 220, 80]],
  [8.0, [240, 140, 50]], [9.0, [210, 40, 50]],
]);

// LCL height AGL (m). Low (favourable) → high (unfavourable) = green → brown.
const LCL_SCALE = rampScale([
  [0, [40, 150, 90]], [500, [120, 195, 90]], [1000, [220, 220, 110]],
  [1750, [205, 165, 90]], [2500, [165, 120, 70]], [4000, [120, 85, 55]],
]);

// Lightning flash density (flashes km⁻² over the period).
const LTNG_SCALE = rampScale([
  [0.1, [70, 90, 160]], [1, [70, 170, 220]], [3, [120, 210, 90]],
  [8, [230, 220, 70]], [16, [240, 140, 50]], [30, [220, 40, 50]],
]);

// Dimensionless composite-severe indices (EHI / SCP / STP). Shared ramp scaled
// to each parameter's typical maximum.
const compositeScale = (hi) => rampScale([
  [0.06 * hi, [120, 200, 140]], [0.15 * hi, [120, 200, 140]], [0.3 * hi, [220, 220, 80]],
  [0.5 * hi, [240, 150, 50]], [0.7 * hi, [220, 60, 55]], [0.85 * hi, [180, 30, 100]],
  [1.0 * hi, [120, 20, 140]],
]);

// Helper for a standard (non-reflectivity) model product: the color scale's
// range *is* the product range, so GPU encoding and colors line up.
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

// A model product names the GRIB field(s) to pull. The simplest form sets
// `varName`/`level`, matched against the `.idx`. Products may instead define
// `sources(fhour)` returning one or more index matchers plus a `combine` rule
// ('mag' = magnitude of two fields, 'diff' = first minus second) — used for
// wind speed (from U/V) and multi-hour precip (from run-total differences).
// `acc` further constrains a match by the accumulation/forecast field, needed
// where one varName/level appears at several accumulation periods (e.g. APCP).
// `reflectivity:true` borrows the shared reflectivity color table. `floor` is
// the lowest value drawn; everything below is left transparent. `minFhour`
// products draw nothing before that forecast hour (e.g. 1 hr precip at F00).
const TMP_PROD = gridProduct('TMP', 'Temperature', TMP_SCALE, TMP_SCALE.lo, 'K', { unit: '°F', ...K_TO_F });
const DPT_PROD = gridProduct('DPT', 'Dew Point', DPT_SCALE, DPT_SCALE.lo, 'K', { unit: '°F', ...K_TO_F });
const RH_PROD = gridProduct('RH', 'Relative Humidity', RH_SCALE, 0, '%');
const WIND_PROD = gridProduct('WIND', 'Wind Speed', WIND_SCALE, 0.5, 'm/s', { unit: 'mph', factor: MS_TO_MPH });
const GUST_PROD = gridProduct('GUST', 'Wind Gusts', GUST_SCALE, 0.5, 'm/s', { unit: 'mph', factor: MS_TO_MPH });
const CLOUD_PROD = gridProduct('TCDC', 'Total Cloud Cover', CLOUD_SCALE, 1, '%');

// APCP appears twice per file: the run total ("0-…") and the latest 1 hr bucket
// ("(f-1)-f hour acc fcst"). Multi-hour totals are the difference of two run
// totals (now minus `hours` earlier); at short lead times that earlier total is
// before the run start, so we just use the run total so far.
const apcpTotal = { varName: 'APCP', level: 'surface', acc: /^0-/ };
function precipWindow(hours) {
  return (fhour) => fhour > hours
    ? [apcpTotal, { ...apcpTotal, fhourDelta: -hours }]
    : [apcpTotal];
}

// Pressure-level source descriptors (from the wrfprs file).
const prs = (varName, mb) => ({ varName, level: `${mb} mb`, file: 'prs' });
// Surface-file source descriptor.
const sfc = (varName, level) => ({ varName, level, file: 'sfc' });

// ---- Winter precipitation (snow / ice / freezing rain) ----
// WEASD ("water equivalent of accumulated snow depth") is the liquid-equivalent
// of snow that has fallen, posted as a run total ("0-N hour acc") just like APCP.
// Snow *depth* is that liquid times a snow-to-liquid ratio (SLR): a fixed 10:1, or
// the temperature-dependent Kuchera ratio. FROZR (total frozen precip) and FRZR
// (freezing rain) are likewise run-total accumulations.
const weasdTotal = { varName: 'WEASD', level: 'surface', acc: /^0-/ };
const frozrTotal = { varName: 'FROZR', level: 'surface', acc: /^0-/ };
const frzrTotal = { varName: 'FRZR', level: 'surface', acc: /^0-/ };
// Low/mid-level temperatures (K) that bracket the warmest layer the snow falls
// through — the input to the Kuchera ratio.
const SNOW_TEMPS = [sfc('TMP', '2 m above ground'), prs('TMP', 925), prs('TMP', 850), prs('TMP', 700)];

// Kuchera & Bentley snow-to-liquid ratio from the column's max temperature (K):
// 12:1 at −2°C, rising steeply in the cold, falling toward 0 as the warm layer
// approaches freezing (wet, heavy snow).
function kucheraRatio(tmaxK) {
  const d = 271.16 - tmaxK;
  return tmaxK <= 271.16 ? 12 + 2 * d : Math.max(0, 12 + d);
}
// Liquid-equivalent (mm) over the window: the run total now, minus `hours` earlier
// when that earlier total is present (longer lead times); floored at zero. NaN at
// `now` propagates so gaps stay gaps. `then` is undefined at short lead times.
const weasdDelta = (now, then) => {
  if (Number.isNaN(now)) return NaN;
  const w = then === undefined ? now : now - then;
  return w > 0 ? w : 0;
};
// 10:1 snow depth (mm) — arrays = [weasdNow, weasdThen?].
const tenToOneSnow = (a, i) => weasdDelta(a[0][i], a.length > 1 ? a[1][i] : undefined) * 10;
// Kuchera snow depth (mm) — arrays = [T2m, T925, T850, T700, weasdNow, weasdThen?].
const kucheraSnow = (a, i) => {
  let tmax = -Infinity;
  for (let k = 0; k < 4; k++) { const t = a[k][i]; if (Number.isFinite(t) && t > tmax) tmax = t; }
  const w = weasdDelta(a[4][i], a.length > 5 ? a[5][i] : undefined);
  if (Number.isNaN(w)) return NaN;
  return w * (tmax > -Infinity ? kucheraRatio(tmax) : 10);
};
// Source builders: run total alone before the window opens, else now minus then.
const snowWindow = (hours) => (fhour) =>
  fhour > hours ? [weasdTotal, { ...weasdTotal, fhourDelta: -hours }] : [weasdTotal];
const kucheraWindow = (hours) => (fhour) =>
  fhour > hours ? [...SNOW_TEMPS, weasdTotal, { ...weasdTotal, fhourDelta: -hours }]
    : [...SNOW_TEMPS, weasdTotal];

// A snowfall product (depth stored in mm of snow, shown in inches). 10:1 or
// Kuchera, over a fixed window (`hours`) or the whole run (`hours` omitted).
function snowProduct(id, name, hiMM, ratio, hours) {
  const isKuchera = ratio === 'kuchera';
  const combine = isKuchera ? kucheraSnow : tenToOneSnow;
  const sources = hours == null
    ? () => (isKuchera ? [...SNOW_TEMPS, weasdTotal] : [weasdTotal])
    : (isKuchera ? kucheraWindow(hours) : snowWindow(hours));
  return {
    ...gridProduct(id, name, snowScale(hiMM), 2.5, 'mm', { unit: 'in', factor: MM_TO_IN }),
    combine, sources,
  };
}
// An ice / freezing-rain run-total product (mm liquid equiv, shown in inches).
function iceProduct(id, name, src, hiMM) {
  return { ...gridProduct(id, name, iceScale(hiMM), 0.25, 'mm', { unit: 'in', factor: MM_TO_IN }), sources: () => [src] };
}

// Wind speed at a pressure level (magnitude of U/V), with wind + height overlays
// at the same level. `hi` is the layout/contour interval for the height field.
function isotachProduct(id, mb) {
  return {
    ...gridProduct(id, `${mb} mb Winds`, ISOTACH_SCALE, 10, 'm/s', { unit: 'kt', factor: MS_TO_KT }),
    combine: 'mag', sources: () => [prs('UGRD', mb), prs('VGRD', mb)],
  };
}

// A pressure-level scalar (vorticity or temperature) drawn as the colored fill,
// with 10 m-style wind barbs and geopotential-height contours overlaid at the
// same level (the classic "field + wind + height" upper-air chart).
function aloftProduct(base, mb, interval) {
  return { ...base, overlays: { level: `${mb} mb`, file: 'prs', interval } };
}

// Combine helpers operate element-wise: (arrays, i) → value, where `arrays` is
// the list of source value arrays in declared order.
const negate = (a, i) => -a[0][i];
const magnitude = (a, i) => Math.hypot(a[0][i], a[1][i]);
// 700–500 mb lapse rate (°C/km): −dT/dz over the layer. arrays = T700,T500,z500,z700.
const lapseRate = (a, i) => {
  const dz = a[2][i] - a[3][i];
  return dz > 0 ? ((a[0][i] - a[1][i]) / dz) * 1000 : NaN;
};
// Energy-helicity index: arrays = MLCAPE, SRH.
const ehi = (a, i) => (Math.max(0, a[0][i]) * a[1][i]) / 160000;
// Supercell composite (fixed-layer approx): arrays = MUCAPE, SRH(0-3), Ush(0-6), Vsh(0-6).
const scp = (a, i) => {
  const cape = a[0][i], srh = a[1][i];
  let shr = Math.hypot(a[2][i], a[3][i]);
  if (shr < 10) return 0;
  if (shr > 20) shr = 20;
  return Math.max(0, (cape / 1000) * (srh / 50) * (shr / 20));
};
// Significant tornado (fixed-layer): arrays = SBCAPE, LCL_msl, sfcHGT, SRH(0-1),
// Ush(0-6), Vsh(0-6), SBCIN. Standard SPC term clamps.
const stp = (a, i) => {
  const cape = a[0][i], lcl = a[1][i] - a[2][i], srh = a[3][i], cin = a[6][i];
  const shr = Math.hypot(a[4][i], a[5][i]);
  const lclT = lcl <= 1000 ? 1 : lcl >= 2000 ? 0 : (2000 - lcl) / 1000;
  const shrT = shr < 12.5 ? 0 : shr > 30 ? 1.5 : shr / 20;
  const cinT = cin >= -50 ? 1 : cin < -200 ? 0 : (200 + cin) / 150;
  return Math.max(0, (cape / 1500) * lclT * (srh / 150) * shrT * cinT);
};

export const MODEL_PRODUCTS = {
  REFC: {
    id: 'REFC',
    name: 'Composite Reflectivity',
    unit: 'dBZ',
    lo: -10, hi: 75, floor: 5,
    varName: 'REFC', level: 'entire atmosphere',
    reflectivity: true,
    dispUnit: 'dBZ', dispFactor: 1, dispOffset: 0,
  },
  TMP: { ...TMP_PROD, varName: 'TMP', level: '2 m above ground' },
  WIND: {
    ...WIND_PROD, combine: 'mag',
    sources: () => [
      { varName: 'UGRD', level: '10 m above ground' },
      { varName: 'VGRD', level: '10 m above ground' },
    ],
  },
  GUST: { ...GUST_PROD, varName: 'GUST', level: 'surface' },
  RH: { ...RH_PROD, varName: 'RH', level: '2 m above ground' },
  DPT: { ...DPT_PROD, varName: 'DPT', level: '2 m above ground' },
  TCDC: { ...CLOUD_PROD, varName: 'TCDC', level: 'entire atmosphere' },
  QPF1: {
    ...gridProduct('QPF1', '1 hr Precip', precipScale(50), 0.1, 'mm', { unit: 'in', factor: MM_TO_IN }),
    minFhour: 1,
    sources: (fhour) => [{ varName: 'APCP', level: 'surface', acc: new RegExp(`^${fhour - 1}-${fhour} hour acc`) }],
  },
  QPF6: {
    ...gridProduct('QPF6', '6 hr Precip', precipScale(75), 0.1, 'mm', { unit: 'in', factor: MM_TO_IN }),
    combine: 'diff', sources: precipWindow(6),
  },
  QPF24: {
    ...gridProduct('QPF24', '24 hr Precip', precipScale(150), 0.1, 'mm', { unit: 'in', factor: MM_TO_IN }),
    combine: 'diff', sources: precipWindow(24),
  },
  QPF: {
    ...gridProduct('QPF', 'Total Precip', precipScale(150), 0.1, 'mm', { unit: 'in', factor: MM_TO_IN }),
    sources: () => [apcpTotal],
  },

  // ---- Upper air (wrfprs pressure levels) ----
  W200: isotachProduct('W200', 200),
  W300: isotachProduct('W300', 300),
  W500: isotachProduct('W500', 500),
  W700: isotachProduct('W700', 700),
  W850: isotachProduct('W850', 850),
  W925: isotachProduct('W925', 925),

  VORT850: aloftProduct({
    ...gridProduct('VORT850', '850 mb Vorticity', VORT_SCALE, 10e-5, 's⁻¹', { unit: '10⁻⁵/s', factor: 1e5 }),
    varName: 'ABSV', level: '850 mb', file: 'prs',
  }, 850, 30),
  VORT700: aloftProduct({
    ...gridProduct('VORT700', '700 mb Vorticity', VORT_SCALE, 10e-5, 's⁻¹', { unit: '10⁻⁵/s', factor: 1e5 }),
    varName: 'ABSV', level: '700 mb', file: 'prs',
  }, 700, 30),
  VORT500: aloftProduct({
    ...gridProduct('VORT500', '500 mb Vorticity', VORT_SCALE, 10e-5, 's⁻¹', { unit: '10⁻⁵/s', factor: 1e5 }),
    varName: 'ABSV', level: '500 mb', file: 'prs',
  }, 500, 60),

  TMP925: aloftProduct({
    ...gridProduct('TMP925', '925 mb Temp', UA_TMP_SCALE, UA_TMP_SCALE.lo, 'K', K_TO_C),
    varName: 'TMP', level: '925 mb', file: 'prs',
  }, 925, 30),
  TMP850: aloftProduct({
    ...gridProduct('TMP850', '850 mb Temp', UA_TMP_SCALE, UA_TMP_SCALE.lo, 'K', K_TO_C),
    varName: 'TMP', level: '850 mb', file: 'prs',
  }, 850, 30),
  TMP700: aloftProduct({
    ...gridProduct('TMP700', '700 mb Temp', UA_TMP_SCALE, UA_TMP_SCALE.lo, 'K', K_TO_C),
    varName: 'TMP', level: '700 mb', file: 'prs',
  }, 700, 30),
  TMP500: aloftProduct({
    ...gridProduct('TMP500', '500 mb Temp', UA_TMP_SCALE, UA_TMP_SCALE.lo, 'K', K_TO_C),
    varName: 'TMP', level: '500 mb', file: 'prs',
  }, 500, 60),

  // ---- Severe / convective ----
  SBCAPE: { ...gridProduct('SBCAPE', 'SB CAPE', capeScale(5000), 100, 'J/kg'), varName: 'CAPE', level: 'surface' },
  MLCAPE: { ...gridProduct('MLCAPE', 'ML CAPE', capeScale(5000), 100, 'J/kg'), varName: 'CAPE', level: '90-0 mb above ground' },
  MUCAPE: { ...gridProduct('MUCAPE', 'MU CAPE', capeScale(5000), 100, 'J/kg'), varName: 'CAPE', level: '255-0 mb above ground' },
  CAPE3: { ...gridProduct('CAPE3', '0-3 km CAPE', capeScale(500), 25, 'J/kg'), varName: 'CAPE', level: '0-3000 m above ground' },
  SBCIN: {
    ...gridProduct('SBCIN', 'SB CIN', CIN_SCALE, 25, 'J/kg', { unit: 'J/kg', factor: -1 }),
    combine: negate, sources: () => [sfc('CIN', 'surface')],
  },
  MLCIN: {
    ...gridProduct('MLCIN', 'ML CIN', CIN_SCALE, 25, 'J/kg', { unit: 'J/kg', factor: -1 }),
    combine: negate, sources: () => [sfc('CIN', '90-0 mb above ground')],
  },
  LAPSE: {
    ...gridProduct('LAPSE', 'Lapse Rate', LAPSE_SCALE, 5.5, '°C/km'),
    combine: lapseRate, sources: () => [prs('TMP', 700), prs('TMP', 500), prs('HGT', 500), prs('HGT', 700)],
  },
  LCL: {
    ...gridProduct('LCL', 'SB LCL', LCL_SCALE, 0, 'm'),
    combine: (a, i) => Math.max(0, a[0][i] - a[1][i]),
    sources: () => [sfc('HGT', 'level of adiabatic condensation from sfc'), sfc('HGT', 'surface')],
  },
  SRH1: { ...gridProduct('SRH1', '0-1 km SRH', SRH_SCALE, 50, 'm²/s²'), varName: 'HLCY', level: '1000-0 m above ground' },
  SRH3: { ...gridProduct('SRH3', '0-3 km SRH', SRH_SCALE, 50, 'm²/s²'), varName: 'HLCY', level: '3000-0 m above ground' },
  SHEAR1: {
    ...gridProduct('SHEAR1', '0-1 km Shear', SHEAR_SCALE, 5, 'm/s', { unit: 'kt', factor: MS_TO_KT }),
    combine: magnitude, sources: () => [sfc('VUCSH', '0-1000 m above ground'), sfc('VVCSH', '0-1000 m above ground')],
  },
  SHEAR6: {
    ...gridProduct('SHEAR6', '0-6 km Shear', SHEAR_SCALE, 5, 'm/s', { unit: 'kt', factor: MS_TO_KT }),
    combine: magnitude, sources: () => [sfc('VUCSH', '0-6000 m above ground'), sfc('VVCSH', '0-6000 m above ground')],
  },
  STORM: {
    ...gridProduct('STORM', 'Storm Motion', SHEAR_SCALE, 0, 'm/s', { unit: 'kt', factor: MS_TO_KT }),
    combine: magnitude, sources: () => [sfc('USTM', '0-6000 m above ground'), sfc('VSTM', '0-6000 m above ground')],
  },
  STP: {
    ...gridProduct('STP', 'Sig. Tornado', compositeScale(8), 0.5, ''),
    combine: stp,
    sources: () => [
      sfc('CAPE', 'surface'), sfc('HGT', 'level of adiabatic condensation from sfc'), sfc('HGT', 'surface'),
      sfc('HLCY', '1000-0 m above ground'), sfc('VUCSH', '0-6000 m above ground'),
      sfc('VVCSH', '0-6000 m above ground'), sfc('CIN', 'surface'),
    ],
  },
  SCP: {
    ...gridProduct('SCP', 'Supercell', compositeScale(20), 0.5, ''),
    combine: scp,
    sources: () => [
      sfc('CAPE', '255-0 mb above ground'), sfc('HLCY', '3000-0 m above ground'),
      sfc('VUCSH', '0-6000 m above ground'), sfc('VVCSH', '0-6000 m above ground'),
    ],
  },
  EHI1: {
    ...gridProduct('EHI1', '0-1 km EHI', compositeScale(6), 0.5, ''),
    combine: ehi, sources: () => [sfc('CAPE', '90-0 mb above ground'), sfc('HLCY', '1000-0 m above ground')],
  },
  EHI3: {
    ...gridProduct('EHI3', '0-3 km EHI', compositeScale(6), 0.5, ''),
    combine: ehi, sources: () => [sfc('CAPE', '90-0 mb above ground'), sfc('HLCY', '3000-0 m above ground')],
  },
  LTNG: { ...gridProduct('LTNG', 'Lightning', LTNG_SCALE, 0.1, 'flash/km²'), varName: 'LTNG', level: 'entire atmosphere' },

  // ---- Winter (snow / ice) ----
  SNOW6: snowProduct('SNOW6', '6 hr Snow (10:1)', 300, '10:1', 6),
  SNOW12: snowProduct('SNOW12', '12 hr Snow (10:1)', 460, '10:1', 12),
  SNOW24: snowProduct('SNOW24', '24 hr Snow (10:1)', 760, '10:1', 24),
  SNOWT: snowProduct('SNOWT', 'Total Snow (10:1)', 1000, '10:1'),
  KUCH6: snowProduct('KUCH6', '6 hr Snow (Kuchera)', 300, 'kuchera', 6),
  KUCH12: snowProduct('KUCH12', '12 hr Snow (Kuchera)', 460, 'kuchera', 12),
  KUCH24: snowProduct('KUCH24', '24 hr Snow (Kuchera)', 760, 'kuchera', 24),
  KUCHT: snowProduct('KUCHT', 'Total Snow (Kuchera)', 1000, 'kuchera'),
  ICET: iceProduct('ICET', 'Total Ice (Frozen Precip)', frozrTotal, 50),
  FZRA: iceProduct('FZRA', 'Total Freezing Rain', frzrTotal, 25),
};

// Categories shown as labelled groups in the product picker.
export const MODEL_CATEGORIES = [
  {
    id: 'surface', name: 'Surface & Precip',
    products: ['REFC', 'TMP', 'WIND', 'GUST', 'RH', 'DPT', 'TCDC', 'QPF1', 'QPF6', 'QPF24', 'QPF'],
  },
  {
    id: 'upper', name: 'Upper Air',
    products: ['W200', 'W300', 'W500', 'W700', 'W850', 'W925',
      'VORT850', 'VORT700', 'VORT500', 'TMP925', 'TMP850', 'TMP700', 'TMP500'],
  },
  {
    id: 'severe', name: 'Severe',
    products: ['SBCAPE', 'MLCAPE', 'MUCAPE', 'CAPE3', 'SBCIN', 'MLCIN', 'LAPSE', 'LCL',
      'SRH1', 'SRH3', 'SHEAR1', 'SHEAR6', 'STORM', 'STP', 'SCP', 'EHI1', 'EHI3', 'LTNG'],
  },
  {
    id: 'winter', name: 'Winter',
    products: ['SNOW6', 'SNOW12', 'SNOW24', 'SNOWT', 'KUCH6', 'KUCH12', 'KUCH24', 'KUCHT', 'ICET', 'FZRA'],
  },
];

export const MODEL_ORDER = MODEL_CATEGORIES.flatMap((c) => c.products);

// Which products each model can actually supply, verified against the field and
// level inventory of each model's GRIB2 output. A model omits products whose
// source fields it doesn't carry — e.g. NAM has no 90/255 mb-layer CAPE so it
// drops the mixed-/most-unstable parcels and the composites built on them, RAP
// only stores 500 mb absolute vorticity, GFS carries no 0–6 km shear, and the
// NAM Nest's reset-every-3-hours precip buckets can't form the run-total fields
// the QPF products need. HRRR (unlisted) supports the full set.
const MODEL_PRODUCT_SUPPORT = {
  nam: [
    'REFC', 'TMP', 'WIND', 'GUST', 'RH', 'DPT', 'TCDC', 'QPF6', 'QPF24', 'QPF',
    'W200', 'W300', 'W500', 'W700', 'W850', 'W925',
    'VORT850', 'VORT700', 'VORT500', 'TMP925', 'TMP850', 'TMP700', 'TMP500',
    'SBCAPE', 'SBCIN', 'LAPSE', 'SRH3', 'SHEAR6', 'LTNG',
    // NAM carries WEASD accumulation + pressure-level temps (snow only; no
    // FROZR/FRZR fields for the ice products).
    'SNOW6', 'SNOW12', 'SNOW24', 'SNOWT', 'KUCH6', 'KUCH12', 'KUCH24', 'KUCHT',
  ],
  namnest: [
    'REFC', 'TMP', 'WIND', 'GUST', 'RH', 'DPT', 'TCDC',
    'W200', 'W300', 'W500', 'W700', 'W850', 'W925',
    'VORT850', 'VORT700', 'VORT500', 'TMP925', 'TMP850', 'TMP700', 'TMP500',
    'SBCAPE', 'MLCAPE', 'MUCAPE', 'SBCIN', 'MLCIN', 'LAPSE', 'LCL',
    'SRH1', 'SRH3', 'SHEAR6', 'STORM', 'STP', 'SCP', 'EHI1', 'EHI3', 'LTNG',
  ],
  rap: [
    'REFC', 'TMP', 'WIND', 'GUST', 'RH', 'DPT', 'TCDC', 'QPF1', 'QPF6', 'QPF24', 'QPF',
    'W200', 'W300', 'W500', 'W700', 'W850', 'W925',
    'VORT500', 'TMP925', 'TMP850', 'TMP700', 'TMP500',
    'SBCAPE', 'MLCAPE', 'MUCAPE', 'CAPE3', 'SBCIN', 'MLCIN', 'LAPSE',
    'SRH1', 'SRH3', 'SHEAR6', 'STORM', 'SCP', 'EHI1', 'EHI3', 'LTNG',
    // RAP carries WEASD + FROZR + FRZR accumulations and pressure-level temps.
    'SNOW6', 'SNOW12', 'SNOW24', 'SNOWT', 'KUCH6', 'KUCH12', 'KUCH24', 'KUCHT', 'ICET', 'FZRA',
  ],
  gfs: [
    'REFC', 'TMP', 'WIND', 'GUST', 'RH', 'DPT', 'TCDC', 'QPF6', 'QPF24', 'QPF',
    'W200', 'W300', 'W500', 'W700', 'W850', 'W925',
    'VORT850', 'VORT700', 'VORT500', 'TMP925', 'TMP850', 'TMP700', 'TMP500',
    'SBCAPE', 'MLCAPE', 'MUCAPE', 'SBCIN', 'MLCIN', 'LAPSE', 'SRH3', 'STORM', 'EHI3',
  ],
  // GraphCast posts only pressure-level mass/wind fields (HGT/TMP/UGRD/VGRD/
  // SPFH/VVEL) — no surface, precip, CAPE or absolute vorticity — so it can
  // supply just the isotachs and upper-air temperatures.
  aigfs: [
    'W200', 'W300', 'W500', 'W700', 'W850', 'W925',
    'TMP925', 'TMP850', 'TMP700', 'TMP500',
  ],
  // HRRRCast carries the HRRR surface staples plus pressure-level winds/temps,
  // but no absolute vorticity (drops VORT), no layer-parcel CAPE (only surface
  // → no ML/MU/3 km parcels or the composites built on them), no run-total
  // precip accumulation, lightning or winter fields. Its bulk-shear (VUCSH/
  // VVCSH) fields decode to ~0 here, so the shear products are dropped too;
  // storm motion (USTM/VSTM) is fine.
  hrrrcast: [
    'REFC', 'TMP', 'WIND', 'GUST', 'RH', 'DPT', 'TCDC',
    'W200', 'W300', 'W500', 'W700', 'W850', 'W925',
    'TMP925', 'TMP850', 'TMP700', 'TMP500',
    'SBCAPE', 'SBCIN', 'LAPSE', 'SRH1', 'SRH3', 'STORM',
  ],
  // RRFS carries nearly the full HRRR set across its 2dfld (surface) and prslev
  // (pressure) files — REFC, the layer-parcel CAPE/CIN suite, composites,
  // run-total QPF, lightning and the frozen-precip/freezing-rain accretions.
  // Its WEASD field isn't a run-total accumulation here, so the snow-depth
  // products (which difference run totals) are dropped.
  rrfs: [
    'REFC', 'TMP', 'WIND', 'GUST', 'RH', 'DPT', 'TCDC', 'QPF1', 'QPF6', 'QPF24', 'QPF',
    'W200', 'W300', 'W500', 'W700', 'W850', 'W925',
    'VORT850', 'VORT700', 'VORT500', 'TMP925', 'TMP850', 'TMP700', 'TMP500',
    'SBCAPE', 'MLCAPE', 'MUCAPE', 'CAPE3', 'SBCIN', 'MLCIN', 'LAPSE', 'LCL',
    'SRH1', 'SRH3', 'SHEAR1', 'SHEAR6', 'STORM', 'STP', 'SCP', 'EHI1', 'EHI3', 'LTNG',
    'ICET', 'FZRA',
  ],
};
for (const [key, model] of Object.entries(MODELS)) {
  model.products = new Set(MODEL_PRODUCT_SUPPORT[key] || MODEL_ORDER);
}

// Does a model offer a given product?
export function modelSupports(modelKey, productId) {
  const m = MODELS[modelKey];
  return !m || !m.products || m.products.has(productId);
}

// The product ids a model offers, in display order.
export function modelProductOrder(modelKey) {
  return MODEL_ORDER.filter((id) => modelSupports(modelKey, id));
}

// A sensible default product when switching to a model that doesn't carry the
// current one — composite reflectivity if available, else the first supported.
export function defaultProductFor(modelKey) {
  if (modelSupports(modelKey, 'REFC')) return 'REFC';
  return modelProductOrder(modelKey)[0] || 'REFC';
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
const dayStrOf = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;

// The forecast hours a run offers: an explicit list (mixed stepping, e.g. NAM)
// or a plain hourly range [0 … maxForecastHour].
function forecastHoursFor(model, cycle) {
  if (model.forecastHoursList) return model.forecastHoursList(cycle);
  const out = [];
  const max = model.maxForecastHour ? model.maxForecastHour(cycle) : 0;
  for (let f = 0; f <= max; f++) out.push(f);
  return out;
}

const RUN_PROBE_TIMEOUT_MS = 5000;
const runProbeCache = new Map();

async function headOrTinyGet(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RUN_PROBE_TIMEOUT_MS);
  try {
    try {
      const res = await fetch(url, { method: 'HEAD', signal: ctrl.signal });
      if (res.ok) return true;
      if (res.status !== 405 && res.status !== 403) return false;
    } catch (_) {
      // Some buckets/proxies do not support or expose HEAD; a tiny ranged GET is
      // the real browser path anyway, so fall through to that probe.
    }
    const res = await fetch(url, { headers: { Range: 'bytes=0-255' }, signal: ctrl.signal });
    return res.ok || res.status === 206;
  } finally {
    clearTimeout(timer);
  }
}

async function runExists(model, run, productId) {
  const product = MODEL_PRODUCTS[productId] || MODEL_PRODUCTS[defaultProductFor(model.id)];
  const fhours = forecastHours(run);
  const probeHour = fhours.includes(0) ? 0 : (fhours[0] || 0);
  const sourceHour = Math.max(probeHour, product.minFhour || 0);
  const sources = sourcesFor(product, sourceHour);
  const files = new Set(sources.map((src) => (src && src.file) || 'sfc'));
  const checks = [...files].map((file) => {
    const { idx } = model.keysFor(run.dayStr, run.cycle, sourceHour, file);
    const url = modelUrl(model, idx);
    if (!runProbeCache.has(url)) {
      runProbeCache.set(url, headOrTinyGet(url).catch((err) => {
        runProbeCache.delete(url);
        throw err;
      }));
    }
    return runProbeCache.get(url);
  });
  return (await Promise.all(checks)).some(Boolean);
}

// List the available model runs (cycles) for a UTC day, newest last. Cycles step
// by `model.cycleStep` (hourly for HRRR/RAP, 6-hourly for NAM/GFS). For the
// current day we drop any cycle that shouldn't have posted yet (its nominal time
// plus `model.latencyMin`).
export async function listModels(modelKey, productId, date) {
  const model = MODELS[modelKey];
  if (!model) throw new Error('unknown model');
  const dayStr = dayStrOf(date);
  const now = new Date();
  const isToday = dayStrOf(now) === dayStr;
  const step = model.cycleStep || 1;
  const latencyMs = (model.latencyMin || 55) * 60000;
  const runs = [];
  const candidates = [];
  for (let h = 0; h <= 23; h += step) {
    const time = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), h));
    if (isToday && now.getTime() < time.getTime() + latencyMs) continue; // not posted yet
    const fhours = forecastHoursFor(model, h);
    candidates.push({
      key: `${dayStr}t${pad(h)}`,
      dayStr,
      cycle: h,
      label: `${pad(h)}z`,
      time,
      maxFhour: fhours[fhours.length - 1] || 0,
      fhours,
    });
  }
  for (let i = 0; i < candidates.length; i += 6) {
    const batch = candidates.slice(i, i + 6);
    const ok = await Promise.all(batch.map((run) => runExists(model, run, productId)));
    for (let j = 0; j < batch.length; j++) if (ok[j]) runs.push(batch[j]);
  }
  return runs;
}

// The forecast hours available for a run (its precomputed list, or an hourly
// fallback up to maxFhour).
export function forecastHours(run) {
  if (run.fhours) return run.fhours;
  const out = [];
  for (let f = 0; f <= (run.maxFhour || 0); f++) out.push(f);
  return out;
}

// Parse a GRIB `.idx` file and return the [start, end] byte range of the message
// matching a source descriptor (`varName`/`level`, and optional `acc` matched
// against the accumulation/forecast field). `end` is null for the file's last
// record (an open-ended Range covers it).
// Normalize a GRIB `.idx` level string so the same physical level matches across
// models that label it differently: drop the "(considered as a single layer)"
// suffix some models add (e.g. NAM's reflectivity / cloud cover), and sort the
// endpoints of layer spans, since the order is just convention ("6000-0 m" vs
// "0-6000 m", "90-0 mb" — all denote the layer between the two bounds).
function normLevel(s) {
  s = s.replace(' (considered as a single layer)', '');
  const m = /^(\d+)-(\d+)(\D.*)$/.exec(s);
  if (m) {
    const a = +m[1], b = +m[2];
    return `${Math.min(a, b)}-${Math.max(a, b)}${m[3]}`;
  }
  return s;
}

function rangeFromIdx(text, src) {
  const lines = text.split('\n').filter((l) => l.trim());
  const level = normLevel(src.level);
  for (let i = 0; i < lines.length; i++) {
    const f = lines[i].split(':');
    if (f[3] !== src.varName || normLevel(f[4]) !== level) continue;
    if (src.acc != null) {
      const fc = f[5] || '';
      if (src.acc instanceof RegExp ? !src.acc.test(fc) : fc !== src.acc) continue;
    }
    const start = parseInt(f[1], 10);
    // wgrib2 indexes fields packed together in one GRIB message as submessages
    // "rec.sub" (e.g. NAM stores UGRD as "20.1" and VGRD as "20.2" at the *same*
    // byte offset). The 0-based submessage index tells decodeGrib2 which field to
    // pull; default 0 for a plain single-field record.
    const dot = f[0].indexOf('.');
    const sub = dot >= 0 ? Math.max(0, parseInt(f[0].slice(dot + 1), 10) - 1) : 0;
    // The message spans to the next record with a *different* byte offset — using
    // the immediate next line would give a zero-length range for the first field
    // of a multi-field message (its sibling shares the offset).
    let end = null;
    for (let j = i + 1; j < lines.length; j++) {
      const ns = parseInt(lines[j].split(':')[1], 10);
      if (ns !== start) { end = ns - 1; break; }
    }
    return { start, end, sub };
  }
  throw new Error(`field ${src.varName}/${src.level} not in index`);
}

// The index source(s) a product pulls for a given forecast hour.
function sourcesFor(product, fhour) {
  return typeof product.sources === 'function'
    ? product.sources(fhour)
    : [{ varName: product.varName, level: product.level, file: product.file }];
}

// Combine the values of one or more resampled grids into one. `mode` may be a
// built-in string — 'mag' (vector magnitude, e.g. wind from U/V) or 'diff'
// (first minus second floored at zero, e.g. multi-hour precip) — or an
// element-wise function (arrays, i) → value for derived parameters. With no
// rule a single grid passes through unchanged.
function combineGrids(grids, mode) {
  if (!mode) return grids[0];
  // 'mag'/'diff' need two inputs; with only one (e.g. short-lead precip) the
  // single grid is already the answer.
  if (grids.length === 1 && (mode === 'mag' || mode === 'diff')) return grids[0];
  const arrays = grids.map((g) => g.values);
  const n = arrays[0].length;
  const out = new Float32Array(n);
  if (mode === 'mag') {
    for (let i = 0; i < n; i++) out[i] = Math.hypot(arrays[0][i], arrays[1][i]);
  } else if (mode === 'diff') {
    for (let i = 0; i < n; i++) {
      const d = arrays[0][i] - arrays[1][i];
      out[i] = Number.isNaN(arrays[0][i]) ? NaN : d > 0 ? d : 0;
    }
  } else {
    for (let i = 0; i < n; i++) out[i] = mode(arrays, i);
  }
  return { ...grids[0], values: out };
}

// A tiny all-missing grid, so accumulation products draw nothing (rather than
// erroring) before their accumulation window exists — e.g. 1 hr precip at F00.
function emptyGrid() {
  return {
    proj: 'latlon', ni: 2, nj: 2, lon1: -130, lat1: 50,
    di: 0.1, dj: 0.1, scanMode: 0, values: new Float32Array([NaN, NaN, NaN, NaN]),
  };
}

async function fetchRange(url, range, onProgress) {
  const headers = { Range: `bytes=${range.start}-${range.end == null ? '' : range.end}` };
  const res = await fetch(url, { headers });
  if (!res.ok && res.status !== 206) throw new Error(`download failed: ${res.status}`);
  const total = range.end == null ? 0 : range.end - range.start + 1;
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

// Resample a Lambert Conformal Conic grid (e.g. HRRR) onto a regular lat/lon
// grid so it can reuse the lat/lon GPU layer. We forward-project each target
// lon/lat into the source grid and nearest-sample. Projection factors split
// cleanly — radius ρ depends only on latitude, the rotation θ only on longitude
// — so the per-cell cost is a couple of multiplies after a small precompute.
export function resampleLambert(grid, step = 0.025) {
  const D2R = Math.PI / 180, R2D = 180 / Math.PI;
  // Spherical earth (shape code 6 → radius 6371229 m) covers the HRRR case.
  const Re = 6371229;
  const phi1 = grid.latin1 * D2R, phi2 = grid.latin2 * D2R;
  const lam0 = grid.lov * D2R, phi0 = grid.lad * D2R;
  const n = Math.abs(phi1 - phi2) < 1e-9
    ? Math.sin(phi1)
    : Math.log(Math.cos(phi1) / Math.cos(phi2)) /
      Math.log(Math.tan(Math.PI / 4 + phi2 / 2) / Math.tan(Math.PI / 4 + phi1 / 2));
  const F = Math.cos(phi1) * Math.pow(Math.tan(Math.PI / 4 + phi1 / 2), n) / n;
  const rho0 = Re * F / Math.pow(Math.tan(Math.PI / 4 + phi0 / 2), n);
  const rhoOf = (latDeg) => Re * F / Math.pow(Math.tan(Math.PI / 4 + latDeg * D2R / 2), n);
  const fwd = (lonDeg, latDeg) => {
    const th = n * (lonDeg * D2R - lam0);
    const r = rhoOf(latDeg);
    return [r * Math.sin(th), rho0 - r * Math.cos(th)];
  };
  const inv = (x, y) => {
    const rv = Math.sign(n) * Math.sqrt(x * x + (rho0 - y) * (rho0 - y));
    const th = Math.atan2(x, rho0 - y);
    return [(lam0 + th / n) * R2D, (2 * Math.atan(Math.pow(Re * F / rv, 1 / n)) - Math.PI / 2) * R2D];
  };

  const { ni, nj, dx, dy, values } = grid;
  const [x0, y0] = fwd(grid.lo1, grid.la1); // grid origin (i=0,j=0), the SW corner

  // Geographic bounding box of the whole source grid (scan its border cells).
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  const see = (i, j) => {
    const [lo, la] = inv(x0 + i * dx, y0 + j * dy);
    if (lo < minLon) minLon = lo; if (lo > maxLon) maxLon = lo;
    if (la < minLat) minLat = la; if (la > maxLat) maxLat = la;
  };
  for (let i = 0; i < ni; i += 8) { see(i, 0); see(i, nj - 1); }
  for (let j = 0; j < nj; j += 8) { see(0, j); see(ni - 1, j); }

  const pad = 0.05;
  const lon1 = minLon - pad, lat1 = maxLat + pad; // lat1 is the northern edge
  const niT = Math.ceil((maxLon - minLon + 2 * pad) / step);
  const njT = Math.ceil((maxLat - minLat + 2 * pad) / step);

  // Precompute the per-column rotation and per-row radius, then nearest-sample.
  const sinT = new Float64Array(niT), cosT = new Float64Array(niT);
  for (let i = 0; i < niT; i++) {
    const th = n * ((lon1 + i * step) * D2R - lam0);
    sinT[i] = Math.sin(th); cosT[i] = Math.cos(th);
  }
  const out = new Float32Array(niT * njT);
  for (let j = 0; j < njT; j++) {
    const rj = rhoOf(lat1 - j * step);
    const rowBase = j * niT;
    for (let i = 0; i < niT; i++) {
      const x = rj * sinT[i], y = rho0 - rj * cosT[i];
      const si = Math.round((x - x0) / dx), sj = Math.round((y - y0) / dy);
      out[rowBase + i] = (si >= 0 && si < ni && sj >= 0 && sj < nj)
        ? values[sj * ni + si] : NaN;
    }
  }
  return { proj: 'latlon', ni: niT, nj: njT, lon1, lat1, di: step, dj: step, scanMode: 0, values: out };
}

// Fetch + decode a single index source into its *native* decoded grid (Lambert
// or lat/lon), without resampling. `.idx` text is memoised per file in `idxCache`
// so multi-field reads (overlays, derived parameters, a sounding column) read
// each index only once.
async function fetchDecodeSource(model, run, fhour, src, idxCache, onProgress) {
  const f = fhour + (src.fhourDelta || 0);
  // Apply any per-model level-string override (e.g. NAM lightning at 'surface').
  const fix = model.levelFix && model.levelFix[src.varName];
  if (fix) src = { ...src, level: fix };
  const { grib, idx } = model.keysFor(run.dayStr, run.cycle, f, src.file);
  if (!idxCache.has(grib)) {
    // Cache the in-flight promise so concurrent fields share one fetch, but
    // validate the response and drop the entry on failure so a transient error
    // doesn't poison the cache with a permanently-rejected promise.
    idxCache.set(grib, (async () => {
      const res = await fetch(modelUrl(model, idx));
      if (!res.ok) throw new Error(`index fetch failed: ${res.status}`);
      return res.text();
    })());
  }
  let idxText;
  try {
    idxText = await idxCache.get(grib);
  } catch (e) {
    idxCache.delete(grib);
    throw e;
  }
  const range = rangeFromIdx(idxText, src);
<<<<<<< HEAD
  const bytes = await fetchRange(modelUrl(model, grib), range, onProgress);
=======
  const bytes = await fetchRange(`${model.bucket}/${grib}`, range, onProgress);
>>>>>>> ca3f0acc6be7b611ddbc74e544102aeb485b9545
  return decodeGrib2(bytes, range.sub);
}

// Fetch + decode + resample a single index source into a regular lat/lon grid.
async function loadSource(model, run, fhour, src, idxCache, onProgress) {
  const decoded = await fetchDecodeSource(model, run, fhour, src, idxCache, onProgress);
  if (decoded.proj === 'lambert') return resampleLambert(decoded);
  return recenterGlobal(decoded);
}

// Nearest-sample a single (lat, lon) point straight from a decoded grid, without
// the full resample — cheap enough to pull a whole sounding column field by
// field. Mirrors the forward projection in resampleLambert for Lambert grids,
// and does a plain index lookup (with longitude wrap) for lat/lon grids.
export function sampleGridAt(grid, lat, lon) {
  if (grid.proj === 'lambert') {
    const D2R = Math.PI / 180;
    const Re = 6371229;
    const phi1 = grid.latin1 * D2R, phi2 = grid.latin2 * D2R;
    const lam0 = grid.lov * D2R, phi0 = grid.lad * D2R;
    const n = Math.abs(phi1 - phi2) < 1e-9
      ? Math.sin(phi1)
      : Math.log(Math.cos(phi1) / Math.cos(phi2)) /
        Math.log(Math.tan(Math.PI / 4 + phi2 / 2) / Math.tan(Math.PI / 4 + phi1 / 2));
    const F = Math.cos(phi1) * Math.pow(Math.tan(Math.PI / 4 + phi1 / 2), n) / n;
    const rho0 = Re * F / Math.pow(Math.tan(Math.PI / 4 + phi0 / 2), n);
    const rhoOf = (la) => Re * F / Math.pow(Math.tan(Math.PI / 4 + la * D2R / 2), n);
    const fwd = (lo, la) => {
      const th = n * (lo * D2R - lam0), r = rhoOf(la);
      return [r * Math.sin(th), rho0 - r * Math.cos(th)];
    };
    const [x0, y0] = fwd(grid.lo1, grid.la1);
    const [x, y] = fwd(lon, lat);
    const si = Math.round((x - x0) / grid.dx), sj = Math.round((y - y0) / grid.dy);
    if (si < 0 || si >= grid.ni || sj < 0 || sj >= grid.nj) return NaN;
    return grid.values[sj * grid.ni + si];
  }
  // lat/lon grid: rows run north→south from lat1; columns east from lon1.
  const { ni, nj, lon1, lat1, di, dj, values } = grid;
  let dlon = lon - lon1;
  while (dlon < 0) dlon += 360;
  while (dlon >= 360) dlon -= 360;
  const si = Math.round(dlon / di), sj = Math.round((lat1 - lat) / dj);
  if (si < 0 || si >= ni || sj < 0 || sj >= nj) return NaN;
  return values[sj * ni + si];
}

// Pressure levels (hPa) probed for a native model sounding column — denser in the
// lower troposphere (where CAPE/shear live) and thinning aloft, to keep the
// per-level field count (and thus the request/decode load) reasonable.
const COLUMN_LEVELS = [1000, 975, 950, 925, 900, 875, 850, 825, 800, 775, 750,
  700, 650, 600, 550, 500, 450, 400, 350, 300, 250, 200, 150, 100];

// Surface / near-surface fields for the sounding base + the convective indices.
const COLUMN_SFC = {
  t2: { varName: 'TMP', level: '2 m above ground' },
  d2: { varName: 'DPT', level: '2 m above ground' },
  rh2: { varName: 'RH', level: '2 m above ground' },
  u10: { varName: 'UGRD', level: '10 m above ground' },
  v10: { varName: 'VGRD', level: '10 m above ground' },
  psfc: { varName: 'PRES', level: 'surface' },
  zsfc: { varName: 'HGT', level: 'surface' },
  cape: { varName: 'CAPE', level: 'surface' },
  cin: { varName: 'CIN', level: 'surface' },
};

// Pull a vertical column at (lat, lon) straight from a model's own GRIB2 — the
// data path for models Open-Meteo doesn't serve a browser-reachable sounding for
// (NAM / NAM Nest / RAP). Each pressure-level field is a separate Range-fetched
// message, point-sampled here; we never resample the whole grid. Returns raw
// GRIB units (T in K, heights in gpm, winds in m/s, pressure in Pa) for the
// caller to convert. `onProgress(frac)` reports load progress.
export async function loadModelColumn(modelKey, run, fhour, lat, lon, onProgress) {
  const model = MODELS[modelKey];
  if (!model) throw new Error('unknown model');
  const idxCache = new Map();

  const sample = async (src) => {
    try {
      const g = await fetchDecodeSource(model, run, fhour, src, idxCache);
      return sampleGridAt(g, lat, lon);
    } catch (_) {
      return NaN; // a field/level this model doesn't carry — just skip it
    }
  };

  // One task per field. Pressure-level fields (T, RH, height, wind components)
  // plus the surface set, all sampled with bounded concurrency.
  const tasks = [];
  for (const p of COLUMN_LEVELS)
    for (const vn of ['TMP', 'RH', 'HGT', 'UGRD', 'VGRD'])
      tasks.push({ p, vn, src: { varName: vn, level: `${p} mb`, file: 'prs' } });
  for (const k of Object.keys(COLUMN_SFC)) tasks.push({ sfc: k, src: COLUMN_SFC[k] });

  const results = new Array(tasks.length);
  let next = 0, done = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= tasks.length) return;
      results[i] = await sample(tasks[i].src);
      if (onProgress) onProgress(++done / tasks.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(12, tasks.length) }, worker));

  const levelMap = new Map();
  const sfc = {};
  results.forEach((v, i) => {
    const t = tasks[i];
    if (t.sfc) { sfc[t.sfc] = v; return; }
    let o = levelMap.get(t.p);
    if (!o) { o = { p: t.p }; levelMap.set(t.p, o); }
    o[t.vn] = v;
  });

  // Keep only levels that came back with a temperature and a height.
  const levels = [...levelMap.values()].filter(
    (o) => Number.isFinite(o.TMP) && Number.isFinite(o.HGT));
  if (!levels.length) throw new Error(`${model.label} GRIB column unavailable for this run/point.`);
  return { levels, sfc };
}

// Prepare a lat/lon grid (GFS) for the web-mercator GPU layer:
//  • Global grids start at 0° longitude and run to ~360°, so the western
//    hemisphere lands off the right edge — roll the columns by half so the grid
//    spans −180…180 and lines up with the CONUS-centered map.
//  • The grid layer projects to web-mercator, where ±90° maps to infinity, so a
//    global grid that reaches the poles yields a degenerate (invisible) quad —
//    crop the rows outside the mercator latitude limit (~±85°).
function recenterGlobal(grid) {
  if (grid.proj !== 'latlon') return grid;
  let { lon1, values } = grid;
  const { ni, nj, di, dj, lat1 } = grid;

  const span = ni * di;
  if (Math.abs(span - 360) <= di && lon1 <= 1) { // full globe starting near 0°
    const half = Math.round(180 / di) % ni;
    if (half) {
      const rolled = new Float32Array(ni * nj);
      for (let j = 0; j < nj; j++) {
        const row = j * ni;
        for (let i = 0; i < ni; i++) rolled[row + i] = values[row + ((i + half) % ni)];
      }
      values = rolled;
      lon1 -= 180;
    }
  }

  // Rows run north→south (lat = lat1 − j·dj); keep those within ±MERC_LAT.
  const MERC_LAT = 85.06;
  const jStart = Math.max(0, Math.ceil((lat1 - MERC_LAT) / dj));
  const jEnd = Math.min(nj - 1, Math.floor((lat1 + MERC_LAT) / dj));
  if (jStart > 0 || jEnd < nj - 1) {
    const h = jEnd - jStart + 1;
    const cropped = new Float32Array(ni * h);
    cropped.set(values.subarray(jStart * ni, (jEnd + 1) * ni));
    return { ...grid, lon1, lat1: lat1 - jStart * dj, nj: h, values: cropped };
  }
  return { ...grid, lon1, values };
}

// Wind + geopotential-height fields for an upper-air overlay, at the product's
// overlay level. Returned as raw value arrays (the geometry matches the main
// grid, since everything resamples to the same lat/lon target).
async function loadOverlays(model, run, fhour, ov, idxCache) {
  const [u, v, h] = await Promise.all([
    loadSource(model, run, fhour, { varName: 'UGRD', level: ov.level, file: ov.file }, idxCache),
    loadSource(model, run, fhour, { varName: 'VGRD', level: ov.level, file: ov.file }, idxCache),
    loadSource(model, run, fhour, { varName: 'HGT', level: ov.level, file: ov.file }, idxCache),
  ]);
  return { u: u.values, v: v.values, hgt: h.values, interval: ov.interval, level: ov.level };
}

// Download + decode one forecast hour of a model run into a lat/lon grid of
// physical values. `run` is an entry from listModels; `fhour` an integer.
export async function loadModel(modelKey, productId, run, fhour, onProgress) {
  const model = MODELS[modelKey];
  const product = MODEL_PRODUCTS[productId];
  if (!model || !product) throw new Error('unknown model/product');
  const idxCache = new Map();

  // Accumulation products with nothing to show yet draw an empty grid.
  let grid;
  if (product.minFhour && fhour < product.minFhour) {
    grid = emptyGrid();
  } else {
    const sources = sourcesFor(product, fhour);
    const grids = [];
    for (let s = 0; s < sources.length; s++) {
      grid = await loadSource(model, run, fhour, sources[s], idxCache,
        onProgress && ((p) => onProgress((s + p) / sources.length)));
      grids.push(grid);
    }
    grid = combineGrids(grids, product.combine);
    if (product.overlays) grid.overlays = await loadOverlays(model, run, fhour, product.overlays, idxCache);
  }
  grid.product = product;
  grid.model = model;
  grid.fhour = fhour;
  grid.runTime = run.time;
  // Valid time = cycle time + forecast hour.
  grid.time = new Date(run.time.getTime() + fhour * 3600 * 1000);
  grid.key = model.keysFor(run.dayStr, run.cycle, fhour).grib;
  return grid;
}
