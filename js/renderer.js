// renderer.js — render a radar sweep into a geographically-referenced canvas
// that can be draped over a Leaflet map as an image overlay.
//
// The canvas spans the radar's bounding box in equirectangular (lat/lon-linear)
// space. For every output pixel we inverse-map lat/lon back to the radar's
// (range, azimuth) polar frame and look up the gate value — O(pixels), which is
// fast and yields a clean, smooth field. Pixels with no echo stay transparent so
// the basemap shows through.

const BINS = 720; // 0.5° azimuth resolution
const M_PER_DEG_LAT = 111320;

function buildAzimuthIndex(sweep, moment) {
  const idx = new Array(BINS).fill(null);
  for (const rad of sweep.radials) {
    const m = rad.moments[moment];
    if (!m) continue;
    let b = Math.round(rad.azimuth * 2) % BINS;
    if (b < 0) b += BINS;
    idx[b] = m;
  }
  // Fill empty bins with the nearest populated neighbour so the sweep stays
  // continuous where radials are missing or coarser than 0.5°.
  const filled = idx.slice();
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < BINS; i++) {
      if (filled[i]) continue;
      filled[i] = filled[(i - 1 + BINS) % BINS] || filled[(i + 1) % BINS] || null;
    }
  }
  return filled;
}

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
const invMercY = (y) => (2 * Math.atan(Math.exp(y)) - Math.PI / 2) * (180 / Math.PI);

export function renderGeo(canvas, sweep, product, geo) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (!sweep) return;

  const img = ctx.createImageData(w, h);
  const data = img.data;

  const idx = buildAzimuthIndex(sweep, product.moment);
  const { rgba, lo, hi, steps } = product.scale;
  const invRange = (steps - 1) / (hi - lo);

  const { siteLat, siteLon, latMin, latMax, lonMin, lonMax } = geo;
  const mPerDegLon = M_PER_DEG_LAT * Math.cos((siteLat * Math.PI) / 180);
  const R2D = 180 / Math.PI;
  const yTop = mercY(latMax);
  const yBot = mercY(latMin);

  for (let py = 0; py < h; py++) {
    const lat = invMercY(yTop + ((yBot - yTop) * py) / (h - 1));
    const dNorth = (lat - siteLat) * M_PER_DEG_LAT;
    let row = py * w * 4;
    for (let px = 0; px < w; px++, row += 4) {
      const lon = lonMin + ((lonMax - lonMin) * px) / (w - 1);
      const dEast = (lon - siteLon) * mPerDegLon;

      const range = Math.sqrt(dEast * dEast + dNorth * dNorth);
      let az = Math.atan2(dEast, dNorth) * R2D; // clockwise from north
      if (az < 0) az += 360;
      let b = Math.round(az * 2) % BINS;
      if (b < 0) b += BINS;
      const m = idx[b];
      if (!m) continue;

      const g = Math.round((range - m.firstGate) / m.gateSpacing);
      if (g < 0 || g >= m.gateCount) continue;
      const code = m.raw[g];
      if (code < 2) continue; // below threshold / range folded => transparent
      const v = (code - m.offset) / m.scale;

      let li = Math.round((v - lo) * invRange);
      if (li < 0) li = 0;
      else if (li >= steps) li = steps - 1;
      const o = li * 4;
      const alpha = rgba[o + 3];
      if (alpha === 0) continue;
      data[row] = rgba[o];
      data[row + 1] = rgba[o + 1];
      data[row + 2] = rgba[o + 2];
      data[row + 3] = alpha;
    }
  }

  ctx.putImageData(img, 0, 0);
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
