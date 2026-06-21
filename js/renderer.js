// renderer.js — sweep geometry helpers shared by the app.
//
// The radar itself is now drawn on the GPU by a custom WebGL layer
// (radarLayer.js), which samples the polar gate data per screen pixel. The two
// helpers here are CPU-side utilities the rest of the app still needs: the
// maximum range of a moment (for range rings and culling) and a point sampler
// for the cursor / inspect readout.

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

// Sample the physical value at a geographic point (for the cursor readout).
// Returns { value, unit, range, az } or null. The nearest-radial, nearest-gate
// lookup here matches exactly what the WebGL layer paints on screen.
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
