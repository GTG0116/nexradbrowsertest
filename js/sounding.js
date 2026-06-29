// sounding.js — point soundings for the model view: a Skew-T / log-P diagram, a
// storm-relative hodograph, and the severe-weather parameters meteorologists
// read off a profile (CAPE, shear, SRH, STP/SCP, …).
//
// The profile follows whichever model is selected for the active forecast hour.
// Supported models build the column from their own GRIB2 data: the browser
// Range-fetches pressure-level fields, samples the requested grid point, then
// computes parcel theory, Bunkers storm motion, helicity and composites locally.

import { loadModelColumn } from './models.js';

const KT2MS = 0.514444;
const MS2KT = 1.943844;
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
// The sounding source for each in-app model. `native: true` means the column is
// decoded in-browser from the model's own GRIB2. `label` names the model shown
// in the panel.
// `unavailable: true` marks models that publish no usable column for a sounding
// (the AI models carry no per-level humidity, GraphCast no surface at all), so
// the panel shows a short notice instead of a misleading profile.
const SOUNDING_SOURCE = {
  hrrr:     { label: 'HRRR',     native: true },
  gfs:      { label: 'GFS',      native: true },
  nam:      { label: 'NAM',      native: true },
  namnest:  { label: 'NAM Nest', native: true },
  rap:      { label: 'RAP',      native: true },
  aigfs:    { label: 'AI GFS',   unavailable: true },
  hrrrcast: { label: 'HRRRCast', unavailable: true },
};

// The sounding source descriptor for an in-app model key (defaults to HRRR).
export function soundingModel(modelKey) {
  return SOUNDING_SOURCE[modelKey] || SOUNDING_SOURCE.hrrr;
}

const num = (x) => (x == null ? NaN : x);

// ---------------------------------------------------------------------------
// Native GRIB2 column: same profile shape for every supported model, built from
// the model's own data via models.js.
// ---------------------------------------------------------------------------

// Dew point (°C) from temperature (°C) and relative humidity (%).
function dewFromRH(Tc, rh) {
  const r = Math.max(1, Math.min(100, rh));
  const es = 6.112 * Math.exp((17.67 * Tc) / (Tc + 243.5));
  const ln = Math.log(((r / 100) * es) / 6.112);
  return (243.5 * ln) / (17.67 - ln);
}

// Push a column level, deriving speed/direction from native u/v (eastward /
// northward m/s) wind components — the same (u, v) convention the hodograph and
// helicity math use directly.
function pushColumnLevel(arr, p, z, T, Td, u, v) {
  if (z == null || !Number.isFinite(z) || !Number.isFinite(T)) return;
  if (Td != null && Td > T) Td = T;
  const uu = Number.isFinite(u) ? u : 0;
  const vv = Number.isFinite(v) ? v : 0;
  const spd = Math.hypot(uu, vv);
  const dir = (Math.atan2(-uu, -vv) * R2D + 360) % 360;
  arr.push({ p, z, T, Td: Td == null ? T - 30 : Td, spdKt: spd * MS2KT, dir, u: uu, v: vv });
}

// Build a sounding from a model's native GRIB2 column. `run` is a listModels
// entry, `fhour` the forecast hour, `onProgress(frac)` reports load progress.
export async function fetchSoundingNative(modelKey, run, fhour, lat, lon, validTime, onProgress) {
  const src = soundingModel(modelKey);
  const { levels: raw, sfc } = await loadModelColumn(modelKey, run, fhour, lat, lon, onProgress);

  const sfcZ = Number.isFinite(sfc.zsfc) ? sfc.zsfc : 0;
  const sfcP = Number.isFinite(sfc.psfc) ? sfc.psfc / 100 : NaN; // Pa → hPa

  const levels = [];
  // Surface (2 m / 10 m) as the base of the profile.
  if (Number.isFinite(sfc.t2)) {
    const t2 = sfc.t2 - 273.15;
    let td2;
    if (Number.isFinite(sfc.d2)) td2 = sfc.d2 - 273.15;
    else if (Number.isFinite(sfc.rh2)) td2 = dewFromRH(t2, sfc.rh2);
    pushColumnLevel(levels, Number.isFinite(sfcP) ? sfcP : raw[0].p, sfcZ, t2, td2, sfc.u10, sfc.v10);
  }
  // Pressure levels above the ground.
  for (const o of raw) {
    if (Number.isFinite(sfcP) && o.p >= sfcP) continue; // below ground
    const Tc = o.TMP - 273.15;
    const td = Number.isFinite(o.RH) ? dewFromRH(Tc, o.RH) : Tc - 30;
    pushColumnLevel(levels, o.p, o.HGT, Tc, td, o.UGRD, o.VGRD);
  }
  if (levels.length < 3) throw new Error(`${src.label} sounding column was too sparse to plot.`);

  levels.sort((a, b) => b.p - a.p); // surface → top
  for (const lv of levels) lv.zAGL = lv.z - sfcZ;

  const cape = Number.isFinite(sfc.cape) ? sfc.cape : NaN;
  // GRIB CIN is a negative J/kg; params/panel expect a positive magnitude.
  const cin = Number.isFinite(sfc.cin) ? Math.max(0, -sfc.cin) : NaN;

  const profile = { lat, lon, validTime, sfcZ, sfcP, levels, cape, cin, li: NaN };
  profile.params = computeParams(profile);
  profile.modelLabel = src.label;
  return profile;
}

// ---------------------------------------------------------------------------
// Meteorology
// ---------------------------------------------------------------------------

// Linear interpolation of [u,v] (m/s) at a height AGL, from the height-sorted
// profile. Clamps to the ends outside the profile range.
function windAtAGL(levels, hAGL) {
  if (hAGL <= levels[0].zAGL) return [levels[0].u, levels[0].v];
  for (let i = 1; i < levels.length; i++) {
    if (hAGL <= levels[i].zAGL) {
      const a = levels[i - 1], b = levels[i];
      const f = (hAGL - a.zAGL) / (b.zAGL - a.zAGL || 1);
      return [a.u + (b.u - a.u) * f, a.v + (b.v - a.v) * f];
    }
  }
  const t = levels[levels.length - 1];
  return [t.u, t.v];
}

// Mean wind over a height layer (m/s), sampled every 100 m so it is a true
// depth-average rather than weighted by uneven level spacing.
function meanWind(levels, loAGL, hiAGL) {
  let su = 0, sv = 0, n = 0;
  for (let z = loAGL; z <= hiAGL + 1; z += 100) {
    const [u, v] = windAtAGL(levels, z);
    su += u; sv += v; n++;
  }
  return [su / n, sv / n];
}

// Bunkers (2000) storm motion — the internal-dynamics method SPC uses. Returns
// right- and left-mover vectors plus the 0-6 km mean wind (all m/s u/v).
function bunkers(levels) {
  const mean = meanWind(levels, 0, 6000);
  const low = meanWind(levels, 0, 500);
  const high = meanWind(levels, 5500, 6000);
  const shr = [high[0] - low[0], high[1] - low[1]];
  const mag = Math.hypot(shr[0], shr[1]);
  if (mag < 0.1) return { rm: mean, lm: mean, mean };
  const D = 7.5; // m/s deviation off the mean wind
  // Right mover: deviate to the right of the shear vector (rotate −90°).
  const rm = [mean[0] + D * (shr[1] / mag), mean[1] - D * (shr[0] / mag)];
  const lm = [mean[0] - D * (shr[1] / mag), mean[1] + D * (shr[0] / mag)];
  return { rm, lm, mean };
}

// Storm-relative helicity over 0→topAGL for a storm motion c=[u,v] (m/s).
// Integrates −k·((V−c)×dV) along the hodograph, m²/s².
function srh(levels, topAGL, c) {
  // Build a height-sorted list of {u,v} including an interpolated cap at topAGL.
  const pts = [];
  for (const lv of levels) {
    if (lv.zAGL < -10) continue;
    if (lv.zAGL > topAGL) break;
    pts.push([lv.u, lv.v]);
  }
  const cap = windAtAGL(levels, topAGL);
  pts.push(cap);
  let s = 0;
  for (let i = 1; i < pts.length; i++) {
    const u1 = pts[i - 1][0] - c[0], v1 = pts[i - 1][1] - c[1];
    const u2 = pts[i][0] - c[0], v2 = pts[i][1] - c[1];
    s += u2 * v1 - u1 * v2;
  }
  return s;
}

// Bulk wind difference (kt) between the surface and a height AGL.
function bulkShearKt(levels, topAGL) {
  const [u, v] = windAtAGL(levels, topAGL);
  return Math.hypot(u - levels[0].u, v - levels[0].v) * MS2KT;
}

// Saturation vapour pressure (hPa) over water for a temperature in °C.
const esat = (Tc) => 6.112 * Math.exp((17.67 * Tc) / (Tc + 243.5));
// Mixing ratio (kg/kg) from dewpoint °C at pressure p (hPa).
const mixr = (Td, p) => { const e = esat(Td); return 0.622 * e / (p - e); };

// Precipitable water (mm) — ∫ w dp / g over the column.
function pwat(levels) {
  let mm = 0;
  for (let i = 1; i < levels.length; i++) {
    const a = levels[i - 1], b = levels[i];
    const wa = mixr(a.Td, a.p), wb = mixr(b.Td, b.p);
    mm += ((wa + wb) / 2) * (a.p - b.p) * 100 / 9.81; // dp Pa, g 9.81 → kg/m² = mm
  }
  return mm;
}

// 700→500 mb lapse rate (°C/km).
function lapse700_500(levels) {
  const l700 = levels.find((l) => l.p === 700);
  const l500 = levels.find((l) => l.p === 500);
  if (!l700 || !l500) return NaN;
  return ((l700.T - l500.T) / (l500.z - l700.z)) * 1000;
}

// Lifted-condensation-level height AGL (m), Espy's surface-based estimate.
const lclHeight = (T, Td) => Math.max(0, 125 * (T - Td));

// Derive every parameter the severe panel and hodograph need.
export function computeParams(profile) {
  const L = profile.levels;
  const sm = bunkers(L);
  const rm = sm.rm;
  const srh1 = srh(L, 1000, rm);
  const srh3 = srh(L, 3000, rm);
  const shr1 = bulkShearKt(L, 1000);
  const shr6 = bulkShearKt(L, 6000);
  const shr6ms = shr6 * KT2MS;
  const cape = profile.cape;
  const cin = profile.cin; // positive magnitude from API
  const sfc = L[0];
  const lcl = lclHeight(sfc.T, sfc.Td);

  // SPC fixed-layer composites (same formulation as the gridded products in
  // models.js). With only surface-based CAPE from the API these are good
  // first-order estimates, labelled "~" in the panel.
  const ehi1 = (Math.max(0, cape) * srh1) / 160000;
  const ehi3 = (Math.max(0, cape) * srh3) / 160000;
  let scp = 0;
  { let s = shr6ms; if (s >= 10) { if (s > 20) s = 20; scp = Math.max(0, (cape / 1000) * (srh3 / 50) * (s / 20)); } }
  const lclT = lcl <= 1000 ? 1 : lcl >= 2000 ? 0 : (2000 - lcl) / 1000;
  const shrT = shr6ms < 12.5 ? 0 : shr6ms > 30 ? 1.5 : shr6ms / 20;
  const cinN = -cin; // STP expects signed CIN
  const cinT = cinN >= -50 ? 1 : cinN < -200 ? 0 : (200 + cinN) / 150;
  const stp = Math.max(0, (cape / 1500) * lclT * (srh1 / 150) * shrT * cinT);

  const rmDir = (Math.atan2(-rm[0], -rm[1]) * R2D + 360) % 360;
  const rmSpd = Math.hypot(rm[0], rm[1]) * MS2KT;

  return {
    stormMotion: sm,
    rmDir, rmSpd,
    srh1, srh3, shr1, shr6,
    lapse: lapse700_500(L),
    lcl, pwat: pwat(L),
    cape, cin, li: profile.li,
    ehi1, ehi3, scp, stp,
  };
}

// ---------------------------------------------------------------------------
// Skew-T / log-P rendering
// ---------------------------------------------------------------------------
const PBOT = 1050, PTOP = 100;
const TMIN = -40, TMAX = 40;        // temperature axis (°C) at the chart bottom
const SKEW = 0.62;                  // isotherm tilt, as a fraction of plot width

function prepCanvas(canvas, ctx) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, hgt = canvas.clientHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(hgt * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, hgt);
  return { w, h: hgt };
}

export function drawSkewT(canvas, profile) {
  const ctx = canvas.getContext('2d');
  const { w, h } = prepCanvas(canvas, ctx);
  const m = { l: 34, r: 26, t: 10, b: 22 };
  const pw = w - m.l - m.r, ph = h - m.t - m.b;
  const top = m.t, bot = m.t + ph, left = m.l;

  const yOf = (p) => top + (Math.log(p) - Math.log(PTOP)) / (Math.log(PBOT) - Math.log(PTOP)) * ph;
  const xOf = (T, y) => left + ((T - TMIN) / (TMAX - TMIN)) * pw + SKEW * pw * ((bot - y) / ph);

  ctx.save();
  ctx.beginPath();
  ctx.rect(left, top, pw, ph);
  ctx.clip();

  // Dry adiabats (constant potential temperature) — subtle warm grey.
  ctx.strokeStyle = 'rgba(190,130,70,0.22)';
  ctx.lineWidth = 1;
  for (let th = -40; th <= 200; th += 20) {
    ctx.beginPath();
    let first = true;
    for (let p = PBOT; p >= PTOP - 1; p -= 25) {
      const T = (th + 273.15) * Math.pow(p / 1000, 0.2854) - 273.15;
      const y = yOf(p), x = xOf(T, y);
      first ? (ctx.moveTo(x, y), first = false) : ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // Moist adiabats (pseudoadiabats) — subtle green.
  ctx.strokeStyle = 'rgba(80,180,120,0.22)';
  for (let t0 = -20; t0 <= 36; t0 += 8) {
    ctx.beginPath();
    let T = t0, first = true;
    for (let p = 1000; p >= PTOP - 1; p -= 10) {
      const y = yOf(p), x = xOf(T, y);
      first ? (ctx.moveTo(x, y), first = false) : ctx.lineTo(x, y);
      T -= moistLapseDP(T, p) * 10; // step −10 hPa
    }
    ctx.stroke();
  }

  // Saturation mixing-ratio lines — dashed teal.
  ctx.strokeStyle = 'rgba(90,170,200,0.30)';
  ctx.setLineDash([3, 3]);
  for (const wgkg of [1, 2, 4, 8, 12, 20]) {
    ctx.beginPath();
    let first = true;
    for (let p = PBOT; p >= 500; p -= 25) {
      const w = wgkg / 1000;
      const e = (w * p) / (0.622 + w);
      const Td = (243.5 * Math.log(e / 6.112)) / (17.67 - Math.log(e / 6.112));
      const y = yOf(p), x = xOf(Td, y);
      first ? (ctx.moveTo(x, y), first = false) : ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // Skewed isotherms every 10 °C; freezing line emphasised.
  for (let T = -100; T <= 50; T += 10) {
    ctx.strokeStyle = T === 0 ? 'rgba(120,180,255,0.55)' : 'rgba(120,140,170,0.22)';
    ctx.lineWidth = T === 0 ? 1.4 : 1;
    ctx.beginPath();
    ctx.moveTo(xOf(T, bot), bot);
    ctx.lineTo(xOf(T, top), top);
    ctx.stroke();
  }
  ctx.restore();

  // Isobars + pressure labels.
  ctx.strokeStyle = 'rgba(120,140,170,0.30)';
  ctx.fillStyle = 'rgba(150,170,195,0.9)';
  ctx.font = '10px "JetBrains Mono", monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 1;
  for (const p of [1000, 925, 850, 700, 500, 400, 300, 250, 200, 150, 100]) {
    const y = yOf(p);
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(left + pw, y);
    ctx.stroke();
    ctx.fillText(String(p), left - 4, y);
  }

  // Temperature scale ticks along the bottom.
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let T = TMIN; T <= TMAX; T += 20) {
    const x = xOf(T, bot);
    if (x > left && x < left + pw) ctx.fillText(`${T}`, x, bot + 4);
  }

  const L = profile.levels;

  // Lifted surface-parcel path + CAPE/CIN shading.
  const parcel = liftParcel(L[0]);
  shadeParcel(ctx, L, parcel, yOf, xOf, left, top, pw, ph);

  // Dewpoint (green) and temperature (red) traces.
  traceLine(ctx, L, (lv) => lv.Td, yOf, xOf, '#34d27b', 2.6);
  traceLine(ctx, L, (lv) => lv.T, yOf, xOf, '#ff5a4d', 2.6);

  // Parcel path, dashed white.
  ctx.strokeStyle = 'rgba(255,255,255,0.8)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  let f0 = true;
  for (const pt of parcel) {
    const y = yOf(pt.p), x = xOf(pt.T, y);
    f0 ? (ctx.moveTo(x, y), f0 = false) : ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.setLineDash([]);

  // Wind barbs up the right margin.
  drawBarbs(ctx, L, yOf, left + pw + 2, m.r - 4);
}

function traceLine(ctx, levels, val, yOf, xOf, color, width) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  let first = true;
  for (const lv of levels) {
    const y = yOf(lv.p), x = xOf(val(lv), y);
    first ? (ctx.moveTo(x, y), first = false) : ctx.lineTo(x, y);
  }
  ctx.stroke();
}

// Pseudo-adiabatic lapse rate dT/dp (°C per hPa) at temperature T (°C), p (hPa).
function moistLapseDP(T, p) {
  const Tk = T + 273.15;
  const ws = mixr(T, p); // saturation mixing ratio (Td=T)
  const Lv = 2.501e6, Rd = 287, eps = 0.622, cp = 1004;
  // dT/dp = (Rd*T/p)(1 + Lv ws/(Rd T)) / (cp + Lv² ws eps/(Rd T²))
  const num = (Rd * Tk / p) * (1 + (Lv * ws) / (Rd * Tk));
  const den = cp + (Lv * Lv * ws * eps) / (Rd * Tk * Tk);
  return num / den; // °C / hPa (positive: T falls as p falls)
}

// Lift a surface parcel: dry-adiabatic to the LCL, then pseudo-moist above.
// Returns [{p,T}] from the surface up to PTOP.
function liftParcel(sfc) {
  const out = [];
  const T0 = sfc.T, Td0 = sfc.Td, p0 = sfc.p;
  const th0 = (T0 + 273.15) * Math.pow(1000 / p0, 0.2854); // potential temp (K)
  const w0 = mixr(Td0, p0);
  // Find LCL pressure: where the dry adiabat meets the constant-w dewpoint.
  let lclP = PTOP;
  for (let p = p0; p >= PTOP; p -= 2) {
    const Tdry = th0 * Math.pow(p / 1000, 0.2854) - 273.15;
    const e = (w0 * p) / (0.622 + w0);
    const Tdew = (243.5 * Math.log(e / 6.112)) / (17.67 - Math.log(e / 6.112));
    if (Tdew >= Tdry) { lclP = p; break; }
  }
  // Below LCL: dry adiabat.
  for (let p = p0; p > lclP; p -= 10) out.push({ p, T: th0 * Math.pow(p / 1000, 0.2854) - 273.15 });
  // From LCL up: integrate the moist adiabat.
  let T = th0 * Math.pow(lclP / 1000, 0.2854) - 273.15;
  for (let p = lclP; p >= PTOP; p -= 10) {
    out.push({ p, T });
    T -= moistLapseDP(T, p) * 10;
  }
  return out;
}

// Shade CAPE (parcel warmer than environment, red) and CIN (cooler, blue).
function shadeParcel(ctx, levels, parcel, yOf, xOf, left, top, pw, ph) {
  const envT = (p) => {
    for (let i = 1; i < levels.length; i++) {
      if (p >= levels[i].p) {
        const a = levels[i - 1], b = levels[i];
        const f = (Math.log(p) - Math.log(a.p)) / (Math.log(b.p) - Math.log(a.p) || 1);
        return a.T + (b.T - a.T) * f;
      }
    }
    return levels[levels.length - 1].T;
  };
  ctx.save();
  ctx.beginPath();
  ctx.rect(left, top, pw, ph);
  ctx.clip();
  for (const pt of parcel) {
    const e = envT(pt.p);
    const warm = pt.T > e;
    const y = yOf(pt.p);
    const xP = xOf(pt.T, y), xE = xOf(e, y);
    ctx.strokeStyle = warm ? 'rgba(255,80,60,0.18)' : 'rgba(80,140,255,0.16)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(xE, y);
    ctx.lineTo(xP, y);
    ctx.stroke();
  }
  ctx.restore();
}

// Wind barbs (kt) drawn at a fixed x, one per ~every-other level to avoid clutter.
function drawBarbs(ctx, levels, yOf, x, room) {
  ctx.strokeStyle = '#cdd6e6';
  ctx.fillStyle = '#cdd6e6';
  ctx.lineWidth = 1.2;
  let lastY = Infinity;
  for (const lv of levels) {
    if (lv.p < PTOP) break;
    const y = yOf(lv.p);
    if (lastY - y < 18) continue; // thin them out
    lastY = y;
    barb(ctx, x, y, lv.spdKt, lv.dir, Math.min(room, 16));
  }
}

// A single station-model wind barb. `dir` is the meteorological from-direction.
function barb(ctx, x, y, spdKt, dir, len) {
  if (spdKt < 2) { // calm circle
    ctx.beginPath(); ctx.arc(x, y, 2, 0, 7); ctx.stroke(); return;
  }
  // Shaft points toward the wind source (up-wind), like a real barb.
  const ang = (dir + 180) * D2R;
  const dx = Math.sin(ang), dy = -Math.cos(ang);
  const x2 = x + dx * len, y2 = y + dy * len;
  ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x2, y2); ctx.stroke();
  // Barbs/flags from the up-wind end back toward the point.
  let kt = Math.round(spdKt / 5) * 5;
  const px = -dx, py = -dy;          // back along the shaft
  const fx = -dy, fy = dx;           // perpendicular (feather side)
  let pos = 0; // distance from the up-wind tip
  const place = (length) => {
    const bx = x2 + px * pos, by = y2 + py * pos;
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(bx + fx * 5 + px * 2, by + fy * 5 + py * 2);
    ctx.stroke();
    return length;
  };
  while (kt >= 50) { // pennant
    const bx = x2 + px * pos, by = y2 + py * pos;
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(bx + fx * 5 + px * 2, by + fy * 5 + py * 2);
    ctx.lineTo(bx + px * 4, by + py * 4);
    ctx.closePath(); ctx.fill();
    pos += 5; kt -= 50;
  }
  while (kt >= 10) { place(); pos += 3; kt -= 10; }
  if (kt >= 5) { // half barb, set in a touch
    if (pos === 0) pos = 3;
    const bx = x2 + px * pos, by = y2 + py * pos;
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(bx + fx * 2.5 + px * 1, by + fy * 2.5 + py * 1);
    ctx.stroke();
  }
}

// ---------------------------------------------------------------------------
// Hodograph rendering
// ---------------------------------------------------------------------------
const HODO_BANDS = [
  { max: 1000, color: '#ff5a4d' },   // 0-1 km
  { max: 3000, color: '#46d27b' },   // 1-3 km
  { max: 6000, color: '#ffd24a' },   // 3-6 km
  { max: 9000, color: '#5ad0ff' },   // 6-9 km
  { max: 99000, color: '#9aa6bd' },  // 9 km+
];

// The hodograph trace points (u,v m/s) from the surface up to a height AGL, with
// an interpolated cap exactly at topAGL so the storm-relative area closes cleanly.
function hodoPointsTo(levels, topAGL) {
  const pts = [];
  for (const lv of levels) {
    if (lv.zAGL < -10) continue;
    if (lv.zAGL > topAGL) break;
    pts.push([lv.u, lv.v]);
  }
  pts.push(windAtAGL(levels, topAGL));
  return pts;
}

export function drawHodograph(canvas, profile) {
  const ctx = canvas.getContext('2d');
  const { w, h } = prepCanvas(canvas, ctx);
  const cx = w / 2, cy = h / 2;
  const L = profile.levels;

  // Scale so the deepest plotted wind (≤10 km) and the storm motions fit.
  let maxKt = 30;
  for (const lv of L) { if (lv.zAGL <= 10000) maxKt = Math.max(maxKt, lv.spdKt); }
  const sm = profile.params.stormMotion;
  maxKt = Math.max(maxKt, Math.hypot(sm.rm[0], sm.rm[1]) * MS2KT);
  const ring = Math.ceil((maxKt + 5) / 10) * 10;
  const R = Math.min(w, h) / 2 - 14;
  const sc = R / ring; // px per kt

  const px = (u) => cx + u * MS2KT * sc;
  const py = (v) => cy - v * MS2KT * sc;

  // Range rings + labels.
  ctx.strokeStyle = 'rgba(120,140,170,0.28)';
  ctx.fillStyle = 'rgba(150,170,195,0.85)';
  ctx.font = '9px "JetBrains Mono", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let r = 10; r <= ring; r += 10) {
    ctx.beginPath(); ctx.arc(cx, cy, r * sc, 0, 7); ctx.stroke();
    ctx.fillText(String(r), cx + r * sc + 8, cy - 4);
  }
  // Axes.
  ctx.strokeStyle = 'rgba(120,140,170,0.4)';
  ctx.beginPath();
  ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy);
  ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R);
  ctx.stroke();

  // ---- Storm-relative helicity area shading ----------------------------------
  // The signed area swept out by the storm-relative wind vectors between the
  // surface and 3 km equals ½·SRH. Filling the single polygon bounded by the
  // storm-motion point and the 0–3 km hodograph trace is the classic grey/white
  // "SRH" region on an SPC/SHARPpy hodograph — one fill, relative to the right
  // mover, with a single inflow edge so it reads cleanly (no overlapping fills).
  const srhPts = hodoPointsTo(L, 3000);
  if (srhPts.length >= 2) {
    ctx.beginPath();
    ctx.moveTo(px(sm.rm[0]), py(sm.rm[1]));
    for (const [u, v] of srhPts) ctx.lineTo(px(u), py(v));
    ctx.closePath();
    ctx.fillStyle = 'rgba(205,214,228,0.18)';
    ctx.fill();
  }

  // Storm-relative inflow vector: storm motion → surface wind (the one edge that
  // bounds the shaded area).
  ctx.strokeStyle = 'rgba(230,236,247,0.45)';
  ctx.setLineDash([4, 3]);
  ctx.lineWidth = 1.1;
  ctx.beginPath();
  ctx.moveTo(px(sm.rm[0]), py(sm.rm[1]));
  ctx.lineTo(px(L[0].u), py(L[0].v));
  ctx.stroke();
  ctx.setLineDash([]);

  // Hodograph curve, coloured by height band.
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  for (let i = 1; i < L.length; i++) {
    const a = L[i - 1], b = L[i];
    if (b.zAGL > 12000) break;
    ctx.strokeStyle = HODO_BANDS.find((band) => b.zAGL <= band.max).color;
    ctx.beginPath();
    ctx.moveTo(px(a.u), py(a.v));
    ctx.lineTo(px(b.u), py(b.v));
    ctx.stroke();
  }

  // Height markers: a numbered dot at each whole kilometre AGL along the trace,
  // like the labelled rings in a reference hodograph.
  const topKm = Math.min(12, Math.floor(L[L.length - 1].zAGL / 1000));
  ctx.font = '700 9px "JetBrains Mono", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let km = 1; km <= topKm; km++) {
    const [u, v] = windAtAGL(L, km * 1000);
    if (Math.hypot(u, v) * MS2KT > ring) continue; // outside the plotted rings
    const x = px(u), y = py(v);
    ctx.beginPath(); ctx.arc(x, y, 7, 0, 7);
    ctx.fillStyle = 'rgba(12,16,24,0.92)'; ctx.fill();
    ctx.lineWidth = 1.2; ctx.strokeStyle = 'rgba(230,236,247,0.85)'; ctx.stroke();
    ctx.fillStyle = '#e6ecf7';
    ctx.fillText(String(km), x, y + 0.5);
  }

  // Storm motion markers.
  const drawSM = (vec, label, fill) => {
    const x = px(vec[0]), y = py(vec[1]);
    ctx.beginPath(); ctx.arc(x, y, 5, 0, 7);
    ctx.fillStyle = fill; ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = '#0b0f17'; ctx.stroke();
    ctx.fillStyle = '#e6ecf7';
    ctx.font = '700 10px "Space Grotesk", sans-serif';
    ctx.fillText(label, x + 12, y);
  };
  // 0–6 km mean wind (hollow, labelled MW), then both movers.
  const mx = px(sm.mean[0]), my = py(sm.mean[1]);
  ctx.beginPath(); ctx.arc(mx, my, 4, 0, 7);
  ctx.strokeStyle = '#9aa6bd'; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.fillStyle = '#e6ecf7';
  ctx.font = '700 10px "Space Grotesk", sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('MW', mx + 14, my);
  drawSM(sm.lm, 'LM', '#6aa9ff');
  drawSM(sm.rm, 'RM', '#ff6f61');
}

// ---------------------------------------------------------------------------
// Severe-parameter panel content
// ---------------------------------------------------------------------------

// Pick a colour for a value given ascending [threshold, color] stops.
function tier(v, stops) {
  let c = stops[0][1];
  for (const [t, col] of stops) if (v >= t) c = col;
  return c;
}
const C = { base: '#9aa6bd', low: '#7fd0a0', mod: '#ffd24a', high: '#ff9a4a', extreme: '#ff5a4d', sig: '#e06bd0' };

// Build the rows (grouped) the panel renders. Each row: {label, value, color}.
export function paramRows(profile) {
  const p = profile.params;
  const f = (x, d = 0) => (Number.isFinite(x) ? x.toFixed(d) : '—');
  return [
    {
      title: 'Instability',
      rows: [
        { label: 'SBCAPE', value: `${f(p.cape)} J/kg`, color: tier(p.cape, [[0, C.base], [500, C.low], [1500, C.mod], [2500, C.high], [3500, C.extreme]]) },
        { label: 'SBCIN', value: `${f(-p.cin)} J/kg`, color: tier(p.cin, [[0, C.low], [25, C.mod], [100, C.high], [200, C.extreme]]) },
        { label: 'Lifted Index', value: `${f(p.li, 1)}`, color: tier(-p.li, [[-99, C.base], [0, C.low], [3, C.mod], [6, C.high], [9, C.extreme]]) },
        { label: '700–500 LR', value: `${f(p.lapse, 1)} °C/km`, color: tier(p.lapse, [[0, C.base], [6, C.low], [7, C.mod], [8, C.high]]) },
        { label: 'PWAT', value: `${f(p.pwat * 0.0393701, 2)} in`, color: tier(p.pwat, [[0, C.base], [25, C.low], [40, C.mod], [50, C.high]]) },
        { label: 'SB LCL', value: `${f(p.lcl)} m`, color: tier(2000 - p.lcl, [[-9999, C.base], [0, C.high], [1000, C.mod], [1500, C.low]]) },
      ],
    },
    {
      title: 'Shear & SRH',
      rows: [
        { label: '0–6 km Shear', value: `${f(p.shr6)} kt`, color: tier(p.shr6, [[0, C.base], [20, C.low], [35, C.mod], [50, C.high]]) },
        { label: '0–1 km Shear', value: `${f(p.shr1)} kt`, color: tier(p.shr1, [[0, C.base], [15, C.low], [25, C.mod], [35, C.high]]) },
        { label: '0–3 km SRH', value: `${f(p.srh3)} m²/s²`, color: tier(p.srh3, [[0, C.base], [100, C.low], [200, C.mod], [300, C.high], [450, C.extreme]]) },
        { label: '0–1 km SRH', value: `${f(p.srh1)} m²/s²`, color: tier(p.srh1, [[0, C.base], [100, C.low], [150, C.mod], [250, C.high], [400, C.extreme]]) },
        { label: 'Bunkers RM', value: `${f(p.rmDir)}° / ${f(p.rmSpd)} kt`, color: C.base },
      ],
    },
    {
      title: 'Composite (~SB)',
      rows: [
        { label: 'Sig. Tornado', value: `${f(p.stp, 1)}`, color: tier(p.stp, [[0, C.base], [1, C.mod], [3, C.high], [6, C.extreme], [8, C.sig]]) },
        { label: 'Supercell', value: `${f(p.scp, 1)}`, color: tier(p.scp, [[0, C.base], [1, C.mod], [4, C.high], [10, C.extreme], [16, C.sig]]) },
        { label: '0–1 km EHI', value: `${f(p.ehi1, 1)}`, color: tier(p.ehi1, [[0, C.base], [1, C.mod], [2, C.high], [3, C.extreme]]) },
        { label: '0–3 km EHI', value: `${f(p.ehi3, 1)}`, color: tier(p.ehi3, [[0, C.base], [1, C.mod], [2, C.high], [3, C.extreme]]) },
      ],
    },
  ];
}
