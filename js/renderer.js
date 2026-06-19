// renderer.js — polar radar rendering onto a 2D canvas.
//
// Strategy: instead of drawing one polygon per gate (millions of them), we walk
// every screen pixel inside the radar disc and inverse-map it back to a
// (range, azimuth) pair, then look up the gate value. This is O(pixels) and
// produces a clean, smooth image. The product's precomputed LUT turns physical
// values into colors without per-pixel branching on color stops.

const BINS = 720; // 0.5° azimuth resolution

function buildAzimuthIndex(sweep, moment) {
  const idx = new Array(BINS).fill(null);
  for (const rad of sweep.radials) {
    const m = rad.moments[moment];
    if (!m) continue;
    let b = Math.round(rad.azimuth * 2) % BINS;
    if (b < 0) b += BINS;
    idx[b] = m;
  }
  // Fill empty bins with the nearest populated neighbour so the sweep is
  // continuous even where radials are missing or coarser than 0.5°.
  const filled = idx.slice();
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < BINS; i++) {
      if (filled[i]) continue;
      const prev = filled[(i - 1 + BINS) % BINS];
      const next = filled[(i + 1) % BINS];
      filled[i] = prev || next || null;
    }
  }
  return filled;
}

export function renderSweep(canvas, sweep, product, view) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const img = ctx.createImageData(w, h);
  const data = img.data;

  if (!sweep) {
    ctx.clearRect(0, 0, w, h);
    return;
  }

  const idx = buildAzimuthIndex(sweep, product.moment);
  const lut = product.scale.lut;
  const lo = product.scale.lo;
  const hi = product.scale.hi;
  const steps = product.scale.steps;
  const invRange = (steps - 1) / (hi - lo);

  const cx = w / 2 + view.panX;
  const cy = h / 2 + view.panY;
  const radiusPx = (Math.min(w, h) / 2) * view.zoom;
  const metersPerPixel = view.rangeMeters / radiusPx;
  const maxRange = view.rangeMeters;
  const RAD2DEG = 180 / Math.PI;

  for (let py = 0; py < h; py++) {
    const dy = py - cy;
    let row = py * w * 4;
    for (let px = 0; px < w; px++, row += 4) {
      const dx = px - cx;
      const rangePx = Math.sqrt(dx * dx + dy * dy);
      const range = rangePx * metersPerPixel;
      if (range > maxRange) continue;

      // Azimuth: clockwise from north (up). North component = -dy, east = dx.
      let az = Math.atan2(dx, -dy) * RAD2DEG;
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
      const o = li * 3;
      data[row] = lut[o];
      data[row + 1] = lut[o + 1];
      data[row + 2] = lut[o + 2];
      data[row + 3] = 255;
    }
  }

  ctx.putImageData(img, 0, 0);
}

// Draw range rings, radials and a compass on the overlay canvas.
export function renderOverlay(canvas, view, options = {}) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const cx = w / 2 + view.panX;
  const cy = h / 2 + view.panY;
  const radiusPx = (Math.min(w, h) / 2) * view.zoom;
  const maxRangeKm = view.rangeMeters / 1000;

  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(120, 200, 255, 0.18)';
  ctx.fillStyle = 'rgba(150, 210, 255, 0.6)';
  ctx.font = '11px "JetBrains Mono", monospace';

  // Range rings every 50 km.
  const ringStep = 50;
  for (let km = ringStep; km <= maxRangeKm + 0.1; km += ringStep) {
    const r = (km / maxRangeKm) * radiusPx;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillText(`${km}km`, cx + 4, cy - r + 12);
  }

  // Radial spokes every 30°.
  ctx.strokeStyle = 'rgba(120, 200, 255, 0.10)';
  for (let a = 0; a < 360; a += 30) {
    const rad = ((a - 90) * Math.PI) / 180; // 0°=N at top
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(rad) * radiusPx, cy + Math.sin(rad) * radiusPx);
    ctx.stroke();
  }

  // Cardinal labels.
  ctx.fillStyle = 'rgba(180, 225, 255, 0.85)';
  ctx.font = 'bold 13px "JetBrains Mono", monospace';
  const card = [
    ['N', 0],
    ['E', 90],
    ['S', 180],
    ['W', 270],
  ];
  for (const [label, ang] of card) {
    const rad = ((ang - 90) * Math.PI) / 180;
    const x = cx + Math.cos(rad) * (radiusPx + 16);
    const y = cy + Math.sin(rad) * (radiusPx + 16);
    ctx.fillText(label, x - 4, y + 4);
  }

  // Center marker (radar site).
  ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.beginPath();
  ctx.arc(cx, cy, 3, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}
