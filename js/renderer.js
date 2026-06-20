// renderer.js — render a radar sweep as true polar cells in a Web-Mercator
// pixel space.
//
// Each gate is drawn as the quadrilateral it actually is in (range, azimuth)
// space, projecting its four corners to mercator pixels. Gates close to the
// radar render small and far gates render large — their true physical footprint
// — and a wedge at a 45° azimuth is a slanted polar cell, not a staircase of
// equal squares. renderRadarCanvas() uses this to rasterise the whole sweep
// once into a fixed canvas, which Mapbox GL then draws as a georeferenced
// CanvasSource and reprojects on the GPU as the map moves.

const M_PER_DEG_LAT = 111320;
const D2R = Math.PI / 180;
const LAT2MY = Math.PI / 360; // degrees latitude → mercator-y argument

// Largest range (metres) actually covered by a moment in this sweep.
export function sweepMaxRange(sweep, moment) {
  let maxR = 0;
  for (const rad of sweep.radials) {
    const m = rad.moments[moment];
    if (!m) continue;
    const end = m.firstGate + m.gateCount * m.gateSpacing;
    if (end > maxR) maxR = end;
  }
  return maxR;
}

// Draw a sweep into a 2D context using a Web-Mercator screen projection.
//
// view = {
//   scale,            // 256 * 2^zoom  (world pixels across at this zoom)
//   offX, offY,       // pixel offset of the canvas top-left in world-pixel space
//   w, h,             // canvas size in CSS px (for off-screen culling)
//   siteLat, siteLon, // radar location
//   mPerDegLon,       // metres per degree longitude at the site latitude
// }
//
// screen-x(lon) = scale*(lon/360 + 0.5) - offX
// screen-y(lat) = scale*(0.5 - ln(tan(π/4 + lat*π/360))/(2π)) - offY
export function renderScreen(ctx, sweep, product, view) {
  if (!sweep) return;

  const { rgba, lo, hi, steps } = product.scale;
  const invRange = (steps - 1) / (hi - lo);

  const { scale, offX, offY, w, h, siteLat, siteLon, mPerDegLon } = view;
  const invLat = 1 / M_PER_DEG_LAT;
  const invLon = 1 / mPerDegLon;
  const kX = scale / 360;
  const kY = scale / (2 * Math.PI);
  const baseX = scale * 0.5 - offX;
  const baseY = scale * 0.5 - offY;
  const PI4 = Math.PI / 4;

  // Project a polar offset (range r, with precomputed sin/cos of an azimuth
  // edge) to a canvas pixel.
  const sxOf = (r, s) => kX * (siteLon + r * s * invLon) + baseX;
  const syOf = (r, c) =>
    baseY - kY * Math.log(Math.tan(PI4 + (siteLat + r * c * invLat) * LAT2MY));

  // Beams carrying this moment, sorted by azimuth so each beam gets a wedge that
  // meets its neighbours (no radial gaps).
  const beams = [];
  for (const rad of sweep.radials) {
    const m = rad.moments[product.moment];
    if (m) beams.push({ az: rad.azimuth, m });
  }
  beams.sort((a, b) => a.az - b.az);
  const n = beams.length;
  if (!n) return;

  for (let i = 0; i < n; i++) {
    const { az, m } = beams[i];
    let dPrev = az - beams[(i - 1 + n) % n].az;
    if (dPrev < 0) dPrev += 360;
    if (dPrev > 2 || dPrev <= 0) dPrev = 1;
    let dNext = beams[(i + 1) % n].az - az;
    if (dNext < 0) dNext += 360;
    if (dNext > 2 || dNext <= 0) dNext = 1;

    // A hair of azimuth overlap hides anti-alias seams between adjacent wedges.
    const a0 = (az - dPrev / 2 - 0.04) * D2R;
    const a1 = (az + dNext / 2 + 0.04) * D2R;
    const s0 = Math.sin(a0),
      c0 = Math.cos(a0),
      s1 = Math.sin(a1),
      c1 = Math.cos(a1);

    const { gateCount, firstGate, gateSpacing, offset, scale: mScale, raw } = m;
    let runStart = -1;
    let runLi = -1;

    const flush = (gEnd) => {
      if (runStart < 0) return;
      const r0 = firstGate + (runStart - 0.5) * gateSpacing;
      const r1 = firstGate + (gEnd - 0.5) * gateSpacing + gateSpacing * 0.5;

      const x00 = sxOf(r0, s0),
        y00 = syOf(r0, c0),
        x01 = sxOf(r0, s1),
        y01 = syOf(r0, c1),
        x11 = sxOf(r1, s1),
        y11 = syOf(r1, c1),
        x10 = sxOf(r1, s0),
        y10 = syOf(r1, c0);

      // Skip cells entirely outside the canvas.
      const minX = Math.min(x00, x01, x11, x10);
      const maxX = Math.max(x00, x01, x11, x10);
      const minY = Math.min(y00, y01, y11, y10);
      const maxY = Math.max(y00, y01, y11, y10);
      if (maxX < 0 || minX > w || maxY < 0 || minY > h) {
        runStart = -1;
        runLi = -1;
        return;
      }

      const o = runLi * 4;
      ctx.fillStyle = `rgba(${rgba[o]},${rgba[o + 1]},${rgba[o + 2]},${
        rgba[o + 3] / 255
      })`;
      ctx.beginPath();
      ctx.moveTo(x00, y00);
      ctx.lineTo(x01, y01);
      ctx.lineTo(x11, y11);
      ctx.lineTo(x10, y10);
      ctx.closePath();
      ctx.fill();
      runStart = -1;
      runLi = -1;
    };

    for (let g = 0; g < gateCount; g++) {
      const code = raw[g];
      if (code < 2) {
        flush(g);
        continue;
      }
      const v = (code - offset) / mScale;
      let li = Math.round((v - lo) * invRange);
      if (li < 0) li = 0;
      else if (li >= steps) li = steps - 1;
      if (rgba[li * 4 + 3] === 0) {
        flush(g);
        continue;
      }
      if (li !== runLi) {
        flush(g);
        runStart = g;
        runLi = li;
      }
    }
    flush(gateCount);
  }
}

// Rasterise a sweep into a fixed canvas that is *linear in Web Mercator* over
// the radar's coverage box, and return the geographic corners of that canvas.
//
// This is what lets Mapbox GL draw the radar as a georeferenced CanvasSource:
// because both the canvas pixels and Mapbox's image placement are linear in
// mercator, the four corners pin the raster to the map exactly. The sweep is
// drawn ONCE per volume here — Mapbox then reprojects it on the GPU during every
// pan/zoom, so moving the map costs no JavaScript at all.
//
// Returns { coordinates } where coordinates is [[w,n],[e,n],[e,s],[w,s]] (the
// order a Mapbox canvas/image source expects: TL, TR, BR, BL).
export function renderRadarCanvas(canvas, sweep, product, site, maxRange, resolution) {
  const N = resolution || 2048;
  const maxR = (maxRange || 300000) * 1.04; // a little margin past the last gate
  const mPerDegLon = M_PER_DEG_LAT * Math.cos((site.lat * Math.PI) / 180);

  // Pick a mercator scale so the radar's east–west span fills ~96% of the
  // canvas, then centre the square canvas on the radar.
  const halfSpanDegLon = maxR / mPerDegLon;
  const scale = (N * 0.96 * 180) / halfSpanDegLon; // = N*0.96 * 360 / (2*halfSpanDegLon)

  const kY = scale / (2 * Math.PI);
  const wxOfLon = (lon) => (scale / 360) * lon + scale / 2;
  const wyOfLat = (lat) =>
    scale / 2 - kY * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  const lonOfWx = (x) => ((x - scale / 2) * 360) / scale;
  const latOfWy = (y) => {
    const t = (scale / 2 - y) / kY;
    return ((2 * Math.atan(Math.exp(t)) - Math.PI / 2) * 180) / Math.PI;
  };

  const cx = wxOfLon(site.lon);
  const cy = wyOfLat(site.lat);
  const offX = cx - N / 2;
  const offY = cy - N / 2;

  if (canvas.width !== N || canvas.height !== N) {
    canvas.width = N;
    canvas.height = N;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, N, N);

  renderScreen(ctx, sweep, product, {
    scale,
    offX,
    offY,
    w: N,
    h: N,
    siteLat: site.lat,
    siteLon: site.lon,
    mPerDegLon,
  });

  const west = lonOfWx(offX);
  const east = lonOfWx(offX + N);
  const north = latOfWy(offY);
  const south = latOfWy(offY + N);
  return {
    coordinates: [
      [west, north],
      [east, north],
      [east, south],
      [west, south],
    ],
  };
}

// Sample the physical value at a geographic point (for the cursor readout).
// Returns { value, unit, range, az } or null.
export function sampleAt(sweep, product, lat, lon, site) {
  if (!sweep) return null;
  const mPerDegLon = M_PER_DEG_LAT * Math.cos((site.lat * Math.PI) / 180);
  const dNorth = (lat - site.lat) * M_PER_DEG_LAT;
  const dEast = (lon - site.lon) * mPerDegLon;
  const range = Math.sqrt(dEast * dEast + dNorth * dNorth);
  let az = (Math.atan2(dEast, dNorth) * 180) / Math.PI;
  if (az < 0) az += 360;

  // Nearest radial carrying this moment.
  let best = null;
  let bestDiff = 999;
  for (const rad of sweep.radials) {
    const m = rad.moments[product.moment];
    if (!m) continue;
    let d = Math.abs(rad.azimuth - az);
    if (d > 180) d = 360 - d;
    if (d < bestDiff) {
      bestDiff = d;
      best = m;
    }
  }
  if (!best) return { value: null, range, az };
  const g = Math.round((range - best.firstGate) / best.gateSpacing);
  if (g < 0 || g >= best.gateCount) return { value: null, range, az };
  const code = best.raw[g];
  if (code < 2) return { value: null, range, az };
  return { value: (code - best.offset) / best.scale, range, az };
}
