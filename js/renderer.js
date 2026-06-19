// renderer.js — render a radar sweep into a geographically-referenced canvas
// that can be draped over a Leaflet map as an image overlay.
//
// The canvas spans the radar's bounding box in equirectangular (lat/lon-linear)
// space. For every output pixel we inverse-map lat/lon back to the radar's
// (range, azimuth) polar frame and look up the gate value — O(pixels), which is
// fast and yields a clean, smooth field. Pixels with no echo stay transparent so
// the basemap shows through.

const M_PER_DEG_LAT = 111320;

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

// geo = { siteLat, siteLon, latMin, latMax, lonMin, lonMax }
//
// The output canvas is destined for a Leaflet (Web Mercator) image overlay, so
// rows are distributed linearly in Mercator-Y rather than in latitude. If we
// spaced rows linearly in latitude, Mercator's poleward stretch would push the
// imagery north of the true radar site; spacing in Mercator-Y keeps the cone of
// silence centred exactly on the site marker.
const mercY = (latDeg) => Math.log(Math.tan(Math.PI / 4 + (latDeg * Math.PI) / 360));

export function renderGeo(canvas, sweep, product, geo) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (!sweep) return;

  const { rgba, lo, hi, steps } = product.scale;
  const invRange = (steps - 1) / (hi - lo);

  const { siteLat, siteLon, latMin, latMax, lonMin, lonMax } = geo;
  const mPerDegLon = M_PER_DEG_LAT * Math.cos((siteLat * Math.PI) / 180);
  const D2R = Math.PI / 180;
  const yTop = mercY(latMax);
  const yBot = mercY(latMin);
  const lonSpan = lonMax - lonMin;
  const ySpan = yBot - yTop;

  // Project metres (east/north from the site) to canvas pixels, matching the
  // Mercator row spacing the Leaflet overlay expects.
  const projX = (dEast) => ((siteLon + dEast / mPerDegLon - lonMin) / lonSpan) * (w - 1);
  const projY = (dNorth) =>
    ((mercY(siteLat + dNorth / M_PER_DEG_LAT) - yTop) / ySpan) * (h - 1);

  // Beams carrying this moment, sorted by azimuth so each beam can be given a
  // wedge that meets its neighbours (no radial gaps, no per-pixel aliasing).
  const beams = [];
  for (const rad of sweep.radials) {
    const m = rad.moments[product.moment];
    if (m) beams.push({ az: rad.azimuth, m });
  }
  beams.sort((a, b) => a.az - b.az);
  const n = beams.length;
  if (!n) return;

  // Render each gate as an actual polar cell (forward rendering). Consecutive
  // gates of the same colour are merged into one quad both to cut fill count and
  // to keep cells contiguous. A tiny azimuth/range overlap hides anti-alias
  // seams between adjacent cells.
  for (let i = 0; i < n; i++) {
    const { az, m } = beams[i];
    let dPrev = az - beams[(i - 1 + n) % n].az;
    if (dPrev < 0) dPrev += 360;
    if (dPrev > 2 || dPrev <= 0) dPrev = 1;
    let dNext = beams[(i + 1) % n].az - az;
    if (dNext < 0) dNext += 360;
    if (dNext > 2 || dNext <= 0) dNext = 1;

    const a0 = (az - dPrev / 2 - 0.03) * D2R;
    const a1 = (az + dNext / 2 + 0.03) * D2R;
    const s0 = Math.sin(a0),
      c0 = Math.cos(a0),
      s1 = Math.sin(a1),
      c1 = Math.cos(a1);

    const { gateCount, firstGate, gateSpacing, offset, scale, raw } = m;
    let runStart = -1;
    let runLi = -1;

    const flush = (gEnd) => {
      if (runStart < 0) return;
      const r0 = firstGate + (runStart - 0.5) * gateSpacing;
      const r1 = firstGate + (gEnd - 0.5) * gateSpacing + gateSpacing * 0.5;
      const o = runLi * 4;
      ctx.fillStyle = `rgba(${rgba[o]},${rgba[o + 1]},${rgba[o + 2]},${
        rgba[o + 3] / 255
      })`;
      ctx.beginPath();
      ctx.moveTo(projX(r0 * s0), projY(r0 * c0));
      ctx.lineTo(projX(r0 * s1), projY(r0 * c1));
      ctx.lineTo(projX(r1 * s1), projY(r1 * c1));
      ctx.lineTo(projX(r1 * s0), projY(r1 * c0));
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
      const v = (code - offset) / scale;
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
