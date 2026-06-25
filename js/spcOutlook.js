// spcOutlook.js — SPC Convective Outlook overlay (days 1–8).
//
// The Storm Prediction Center publishes its convective outlooks as ready-made
// GeoJSON, one file per day-and-hazard. Each feature already carries the official
// risk `fill`/`stroke` colours and human `LABEL`/`LABEL2` text, so the overlay is
// a thin fetch-and-draw: we pick the right URL for the selected day + type, push
// the polygons to the shared `spc-outlook` GL source (the fill/line layers are
// created by app.js so they survive basemap swaps), and build a small legend from
// whatever risk areas came back.
//
// Which hazard "types" exist depends on the day, matching what SPC issues:
//   • Days 1 & 2 — Categorical, plus probabilistic Tornado / Wind / Hail.
//   • Day 3      — Categorical, plus a combined severe Probability.
//   • Days 4–8   — a single "any severe" Probability (the extended outlook).

const BASE = 'https://www.spc.noaa.gov/products';

// Type id → short label shown in the picker / legend heading.
export const SPC_TYPE_LABELS = {
  cat: 'Categorical',
  torn: 'Tornado',
  wind: 'Wind',
  hail: 'Hail',
  prob: 'Probability',
};

// The hazard types SPC issues for a given outlook day, in menu order.
export function spcTypesForDay(day) {
  if (day === 1 || day === 2) return ['cat', 'torn', 'wind', 'hail'];
  if (day === 3) return ['cat', 'prob'];
  return ['prob']; // days 4–8: combined "any severe" probability only
}

// GeoJSON endpoint for a day + type. Days 1–3 live under products/outlook; the
// day 4–8 extended outlooks live under products/exper/day4-8 with a flatter name.
function urlFor(day, type) {
  if (day >= 4) return `${BASE}/exper/day4-8/day${day}prob.nolyr.geojson`;
  if (day === 3 && type === 'prob') return `${BASE}/outlook/day3otlk_prob.nolyr.geojson`;
  return `${BASE}/outlook/day${day}otlk_${type}.nolyr.geojson`;
}

const EMPTY = { type: 'FeatureCollection', features: [] };

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// "Jun 25, 16:30Z" from an SPC ISO timestamp (already UTC).
function fmtZ(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const mon = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  const p = (n) => String(n).padStart(2, '0');
  return `${mon} ${d.getUTCDate()}, ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}Z`;
}

export class SpcOutlookController {
  // els: { daySelect, typeSelect, legend, status }
  constructor(map, els) {
    this.map = map;
    this.els = els;
    this.enabled = false;
    this.day = 1;
    this.type = 'cat';
    this.seq = 0;          // guards against out-of-order fetch resolutions
    this._last = EMPTY;    // last features pushed, so a style reload can re-prime
  }

  setEnabled(on) {
    this.enabled = on;
    if (on) {
      this.load();
    } else {
      this._setData(EMPTY);
      this._renderLegend([]);
      this._setStatus('');
    }
  }

  setDay(day) {
    this.day = day;
    // Drop to a valid type for the new day (e.g. leaving day 1's Hail for day 4).
    const types = spcTypesForDay(day);
    if (!types.includes(this.type)) this.type = types[0];
    if (this.enabled) this.load();
  }

  setType(type) {
    this.type = type;
    if (this.enabled) this.load();
  }

  _setData(fc) {
    this._last = fc;
    const src = this.map && this.map.getSource && this.map.getSource('spc-outlook');
    if (src) src.setData(fc);
  }

  // Re-push the current features after a basemap/style reload rebuilt the source.
  reapply() {
    if (this.enabled) this._setData(this._last);
  }

  async load() {
    const day = this.day;
    const type = this.type;
    const mine = ++this.seq;
    this._setStatus('Loading…');
    try {
      const res = await fetch(urlFor(day, type), { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const fc = await res.json();
      if (mine !== this.seq) return; // a newer request superseded this one
      const feats = (fc.features || []).filter((f) => f.geometry);
      this._setData({ type: 'FeatureCollection', features: feats });
      this._renderLegend(feats);
      this._setStatus(this._validText(feats));
    } catch (e) {
      if (mine !== this.seq) return;
      this._setData(EMPTY);
      this._renderLegend([]);
      this._setStatus(`Unavailable (${esc(e.message)})`);
    }
  }

  _setStatus(text) {
    if (this.els.status) this.els.status.textContent = text || '';
  }

  // "Valid Jun 25 16:30Z – Jun 26 12:00Z" from the first feature's window, or a
  // "no risk areas" note when the outlook came back empty.
  _validText(feats) {
    if (!feats.length) return 'No outlook areas for this day/type.';
    const p = feats[0].properties || {};
    const v = fmtZ(p.VALID_ISO);
    const x = fmtZ(p.EXPIRE_ISO);
    return v && x ? `Valid ${v} – ${x}` : '';
  }

  // Build a swatch legend from the risk areas present, de-duplicated by label and
  // ordered by SPC's DN (ascending = least to most significant).
  _renderLegend(feats) {
    const legend = this.els.legend;
    if (!legend) return;
    const byLabel = new Map();
    for (const f of feats) {
      const p = f.properties || {};
      const key = p.LABEL2 || p.LABEL || '';
      if (!key) continue;
      const prev = byLabel.get(key);
      if (!prev || (p.DN || 0) > prev.dn) {
        byLabel.set(key, { label: key, fill: p.fill || '#888', stroke: p.stroke || '#444', dn: p.DN || 0 });
      }
    }
    const items = [...byLabel.values()].sort((a, b) => a.dn - b.dn);
    if (!items.length) {
      legend.innerHTML = '<div class="empty">No risk areas.</div>';
      return;
    }
    legend.innerHTML = items
      .map(
        (it) =>
          `<div class="spc-legend-row"><span class="spc-legend-sw" style="background:${esc(
            it.fill
          )};border-color:${esc(it.stroke)}"></span><span class="spc-legend-label">${esc(
            it.label
          )}</span></div>`
      )
      .join('');
  }
}
