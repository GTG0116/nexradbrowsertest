// stationPlot.js — drawing primitives shared by the canvas station-plot
// overlays (METAR surface obs in metars.js, NDBC buoys in buoys.js).
//
// Both layers paint the same visual language onto a 2D canvas glued to the map:
// halo-backed text that stays readable over any basemap, and a WMO wind barb
// pointing into the wind with half/full/pennant flags. They were written for
// METARs first; buoys reuse them verbatim so the two overlays can't drift apart.

export const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export const cToF = (c) => (c == null || Number.isNaN(c) ? null : (c * 9) / 5 + 32);
export const fToC = (f) => (f == null || Number.isNaN(f) ? null : ((f - 32) * 5) / 9);

// Text with a fat halo stroke behind it, so labels survive over bright
// coastlines, dark ocean and everything between.
export function text(ctx, value, x, y, align, fill, halo, size = 13) {
  ctx.save();
  ctx.font = `700 ${size}px "JetBrains Mono", monospace`;
  ctx.textAlign = align;
  ctx.lineWidth = 4;
  ctx.strokeStyle = halo;
  ctx.strokeText(String(value), x, y);
  ctx.fillStyle = fill;
  ctx.fillText(String(value), x, y);
  ctx.restore();
}

// Run `draw` twice: once fat in the halo colour, once thin in the ink colour.
export function haloStroke(ctx, draw, width, stroke, halo) {
  ctx.save();
  ctx.lineWidth = width + 3.4;
  ctx.strokeStyle = halo;
  draw();
  ctx.lineWidth = width;
  ctx.strokeStyle = stroke;
  draw();
  ctx.restore();
}

// Standard wind barb, drawn about the origin (translate first). `dir` is the
// direction the wind blows FROM in degrees, `kt` the sustained speed; the flags
// are counted off the gust when one is reported, matching the station-model
// convention the METAR layer has always used. Calm (< 1 kt) draws the open
// circle instead.
export function drawWindBarb(ctx, dir, kt, gust, t) {
  const degrees = num(dir);
  const speed = num(kt);
  if (speed == null) return;
  if (speed < 1 || degrees == null) {
    if (speed < 1) {
      haloStroke(ctx, () => {
        ctx.beginPath();
        ctx.arc(0, 0, 11.5, 0, Math.PI * 2);
        ctx.stroke();
      }, 1.4, t.barb, t.halo);
    }
    return;
  }

  const r = 8;
  const len = 32;
  const rad = (degrees * Math.PI) / 180;
  const ux = Math.sin(rad);
  const uy = -Math.cos(rad);
  const px = -uy;
  const py = ux;
  const sx = ux * r;
  const sy = uy * r;
  const ex = ux * (r + len);
  const ey = uy * (r + len);
  const parts = [];

  parts.push((c) => {
    c.beginPath();
    c.moveTo(sx, sy);
    c.lineTo(ex, ey);
    c.stroke();
  });

  let remaining = Math.round((gust || speed) / 5) * 5;
  let tPos = r + len;
  const step = 6;
  const barbLen = 11;
  const point = () => ({ x: ux * tPos, y: uy * tPos });
  const pennants = Math.floor(remaining / 50);
  remaining -= pennants * 50;
  const fulls = Math.floor(remaining / 10);
  remaining -= fulls * 10;
  const halves = Math.floor(remaining / 5);

  for (let i = 0; i < pennants; i++) {
    const a = point();
    tPos -= step * 1.45;
    const b = point();
    parts.push((c) => {
      c.beginPath();
      c.moveTo(a.x, a.y);
      c.lineTo(a.x + px * barbLen, a.y + py * barbLen);
      c.lineTo(b.x, b.y);
      c.closePath();
      c.fill();
    });
  }
  if (pennants) tPos -= step * 0.4;
  for (let i = 0; i < fulls; i++) {
    const a = point();
    parts.push((c) => {
      c.beginPath();
      c.moveTo(a.x, a.y);
      c.lineTo(a.x + px * barbLen, a.y + py * barbLen);
      c.stroke();
    });
    tPos -= step;
  }
  for (let i = 0; i < halves; i++) {
    if (tPos >= r + len - 0.1) tPos -= step;
    const a = point();
    parts.push((c) => {
      c.beginPath();
      c.moveTo(a.x, a.y);
      c.lineTo(a.x + px * barbLen * 0.55, a.y + py * barbLen * 0.55);
      c.stroke();
    });
    tPos -= step;
  }

  ctx.save();
  ctx.lineWidth = 4.2;
  ctx.strokeStyle = t.halo;
  ctx.fillStyle = t.halo;
  for (const part of parts) part(ctx);
  ctx.lineWidth = 1.9;
  ctx.strokeStyle = t.barb;
  ctx.fillStyle = t.barb;
  for (const part of parts) part(ctx);
  ctx.restore();
}

// Escape for the small HTML snippets both overlays build for their tooltips.
export function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}
