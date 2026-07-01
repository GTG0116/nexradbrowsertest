// outlooks.js — a general "forecast outlook" overlay: pick a product (SPC
// convective, SPC fire weather, SPC mesoscale discussions, CPC temperature /
// precipitation) and a sub-detail (the day + hazard, or the lead window), and the
// matching polygons are fetched as GeoJSON and drawn through the shared
// `spc-outlook` GL source (the fill/line layers live in app.js so they survive a
// basemap swap).
//
// Two feed families:
//   • SPC convective outlooks are ready-made GeoJSON on spc.noaa.gov that already
//     carry each risk area's official fill/stroke/label — drawn as-is.
//   • Everything else comes from NOAA's ArcGIS map service as GeoJSON; those carry
//     only a code (a `dn` level, or a CPC `cat`+`prob`), so each product maps that
//     code to the official colour/label here before the same fill/line layers
//     read it through `properties.fill` / `.stroke`.

const SPC = 'https://www.spc.noaa.gov/products';
const ARC = 'https://mapservices.weather.noaa.gov/vector/rest/services';

// A GeoJSON query against one ArcGIS map-service layer.
function arcUrl(path, layer) {
  const q = 'where=' + encodeURIComponent('1=1') +
    '&outFields=*&returnGeometry=true&outSR=4326&f=geojson';
  return `${ARC}/${path}/MapServer/${layer}/query?${q}`;
}

// ---- SPC convective (ready-made GeoJSON, colours included) ------------------
const SPC_TYPE_LABELS = { cat: 'Categorical', torn: 'Tornado', wind: 'Wind', hail: 'Hail', prob: 'Probability' };
function spcTypesForDay(day) {
  if (day === 1 || day === 2) return ['cat', 'torn', 'wind', 'hail'];
  if (day === 3) return ['cat', 'prob'];
  return ['prob']; // days 4–8: combined "any severe" probability
}
function spcConvUrl(detail) {
  const [d, type] = detail.id.split(':');
  const day = +d;
  if (day >= 4) return `${SPC}/exper/day4-8/day${day}prob.nolyr.geojson`;
  if (day === 3 && type === 'prob') return `${SPC}/outlook/day3otlk_prob.nolyr.geojson`;
  return `${SPC}/outlook/day${day}otlk_${type}.nolyr.geojson`;
}
const spcConvDetails = [];
for (let d = 1; d <= 8; d++)
  for (const t of spcTypesForDay(d)) spcConvDetails.push({ id: `${d}:${t}`, label: `Day ${d} ${SPC_TYPE_LABELS[t]}` });

// ---- SPC fire weather (ArcGIS, styled by `dn`) ------------------------------
const FIRE_CAT = {
  5: { label: 'Elevated', fill: 'rgb(230,152,0)' },
  8: { label: 'Critical', fill: 'rgb(255,0,0)' },
  10: { label: 'Extremely Critical', fill: 'rgb(230,0,169)' },
};
const FIRE_DRYT = {
  4: { label: 'Isolated Dry T-storm', fill: 'rgb(115,38,0)' },
  5: { label: 'Isolated Dry T-storm', fill: 'rgb(115,38,0)' },
  8: { label: 'Scattered Dry T-storm', fill: 'rgb(255,0,0)' },
};

// ---- CPC temperature / precipitation (ArcGIS, styled by `cat` + `prob`) -----
// Probability-class colours straight from the CPC ArcGIS renderers.
const CPC_TEMP_ABOVE = [[33, [231, 177, 104]], [40, [227, 139, 75]], [50, [218, 87, 49]], [60, [201, 59, 26]], [70, [179, 46, 5]], [80, [145, 38, 0]], [90, [112, 33, 0]]];
const CPC_TEMP_BELOW = [[33, [191, 203, 228]], [40, [160, 192, 223]], [50, [119, 181, 226]], [60, [56, 159, 220]], [70, [0, 93, 161]], [80, [46, 33, 111]], [90, [34, 24, 82]]];
const CPC_PRECIP_ABOVE = [[33, [179, 217, 171]], [40, [149, 206, 127]], [50, [72, 180, 48]], [60, [0, 150, 32]], [70, [0, 120, 20]], [80, [40, 96, 10]], [90, [40, 83, 0]]];
const CPC_PRECIP_BELOW = [[33, [240, 212, 147]], [40, [216, 167, 79]], [50, [187, 109, 51]], [60, [155, 80, 49]], [70, [147, 70, 57]], [80, [120, 55, 45]], [90, [95, 40, 35]]];

// CPC features carry cat ("Above"/"Below"/"Normal") + prob (%). "Normal"/Equal
// Chances are a flat grey; Above/Below pick the deepest ramp class ≤ prob.
function cpcStyle(ramps) {
  return (f) => {
    const p = f.properties || {};
    const cat = p.cat, prob = +p.prob;
    if (cat !== 'Above' && cat !== 'Below')
      return { fill: 'rgb(190,190,190)', stroke: 'rgb(120,120,120)', label: 'Near Normal', sort: 0 };
    const ramp = cat === 'Above' ? ramps.above : ramps.below;
    let c = ramp[0][1];
    for (const [thr, col] of ramp) if (prob >= thr) c = col;
    const fill = `rgb(${c[0]},${c[1]},${c[2]})`;
    return { fill, stroke: fill, label: `${cat} ${prob}%`, sort: (cat === 'Above' ? 1 : -1) * prob };
  };
}

// Map a fire `dn` through a level table to a fill/label.
function fireStyle(table) {
  return (f) => {
    const dn = (f.properties || {}).dn;
    const t = table[dn] || { label: `dn ${dn}`, fill: 'rgb(150,150,150)' };
    return { fill: t.fill, stroke: t.fill, label: t.label, sort: +dn || 0 };
  };
}

// ---- WPC Excessive Rainfall Outlook (ArcGIS, styled by `dn` risk level) ------
// Same four-tier risk ladder as the convective outlook, with WPC's ERO colours.
const ERO_CLASS = {
  1: { label: 'Marginal', fill: 'rgb(56,168,0)', stroke: 'rgb(0,115,76)' },
  2: { label: 'Slight', fill: 'rgb(255,254,0)', stroke: 'rgb(230,152,0)' },
  3: { label: 'Moderate', fill: 'rgb(245,0,0)', stroke: 'rgb(138,0,0)' },
  4: { label: 'High', fill: 'rgb(255,105,197)', stroke: 'rgb(255,0,255)' },
};
function eroStyle(f) {
  const p = f.properties || {};
  const dn = +p.dn;
  const t = ERO_CLASS[dn] || { label: p.outlook || `Level ${dn}`, fill: 'rgb(150,150,150)', stroke: 'rgb(110,110,110)' };
  return { fill: t.fill, stroke: t.stroke, label: t.label, sort: dn || 0 };
}

export const OUTLOOKS = {
  spc_conv: {
    label: 'SPC Convective',
    details: spcConvDetails,
    url: spcConvUrl,
    // Two-dimensional detail: the day (1–8) and the hazard product for that day
    // (categorical / tornado / wind / hail / probability). The detail id is
    // `day:type`, so the two axes map onto that split.
    axes: {
      primaryLabel: 'Day',
      secondaryLabel: 'Product',
      days: () => { const out = []; for (let d = 1; d <= 8; d++) out.push({ id: String(d), label: `Day ${d}` }); return out; },
      types: (dayId) => spcTypesForDay(+dayId).map((t) => ({ id: t, label: SPC_TYPE_LABELS[t] })),
      split: (detailId) => { const [d, t] = String(detailId).split(':'); return { day: d, type: t }; },
      join: (day, type) => `${day}:${type}`,
    },
    // Already-coloured features: pass the official fill/stroke/label through.
    style: (f) => {
      const p = f.properties || {};
      return { fill: p.fill || '#888', stroke: p.stroke || '#444', label: p.LABEL2 || p.LABEL || '', code: p.LABEL || '', sort: p.DN || 0 };
    },
    cig: true, // convective alone has the Conditional Intensity hatch areas
  },
  spc_fire: {
    label: 'SPC Fire Weather',
    details: [
      { id: 'd1cat', label: 'Day 1 Fire Wx', path: 'fire_weather/SPC_firewx', layer: 1, table: FIRE_CAT },
      { id: 'd1dry', label: 'Day 1 Dry T-storm', path: 'fire_weather/SPC_firewx', layer: 2, table: FIRE_DRYT },
      { id: 'd2cat', label: 'Day 2 Fire Wx', path: 'fire_weather/SPC_firewx', layer: 4, table: FIRE_CAT },
      { id: 'd2dry', label: 'Day 2 Dry T-storm', path: 'fire_weather/SPC_firewx', layer: 5, table: FIRE_DRYT },
    ],
    style: (f, d) => fireStyle(d.table)(f),
  },
  spc_md: {
    label: 'SPC Mesoscale Disc.',
    details: [{ id: 'active', label: 'Active Discussions', path: 'outlooks/spc_mesoscale_discussion', layer: 0 }],
    style: (f) => {
      const p = f.properties || {};
      return { fill: 'rgb(180,40,230)', stroke: 'rgb(132,0,168)', label: p.name || 'Discussion', sort: 0 };
    },
  },
  wpc_ero: {
    label: 'WPC Excessive Rain',
    details: [
      { id: 'd1', label: 'Day 1', path: 'hazards/wpc_precip_hazards', layer: 0 },
      { id: 'd2', label: 'Day 2', path: 'hazards/wpc_precip_hazards', layer: 1 },
      { id: 'd3', label: 'Day 3', path: 'hazards/wpc_precip_hazards', layer: 2 },
      { id: 'd4', label: 'Day 4', path: 'hazards/wpc_precip_hazards', layer: 3 },
      { id: 'd5', label: 'Day 5', path: 'hazards/wpc_precip_hazards', layer: 4 },
    ],
    style: eroStyle,
  },
  cpc_temp: {
    label: 'CPC Temperature',
    details: [
      { id: '610', label: '6–10 Day', path: 'outlooks/cpc_6_10_day_outlk', layer: 0 },
      { id: '814', label: '8–14 Day', path: 'outlooks/cpc_8_14_day_outlk', layer: 0 },
    ],
    style: cpcStyle({ above: CPC_TEMP_ABOVE, below: CPC_TEMP_BELOW }),
  },
  cpc_precip: {
    label: 'CPC Precipitation',
    details: [
      { id: '610', label: '6–10 Day', path: 'outlooks/cpc_6_10_day_outlk', layer: 1 },
      { id: '814', label: '8–14 Day', path: 'outlooks/cpc_8_14_day_outlk', layer: 1 },
    ],
    style: cpcStyle({ above: CPC_PRECIP_ABOVE, below: CPC_PRECIP_BELOW }),
  },
};

export const OUTLOOK_ORDER = ['spc_conv', 'spc_fire', 'spc_md', 'wpc_ero', 'cpc_temp', 'cpc_precip'];

const EMPTY = { type: 'FeatureCollection', features: [] };

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---- SPC Mesoscale Discussion text (for the click-through briefing) ---------
// The ArcGIS MD feed carries only the number + a link to the SPC product page;
// the probabilistic detail (watch probability, peak tornado/wind/hail) lives in
// the product text. We fetch that page, pull the <pre> body, and parse the fixed
// fields the MD format uses.
function htmlToText(s) {
  return String(s).replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}
function mdGrab(t, re) { const m = re.exec(t); return m ? m[1].trim().replace(/[ \t]+/g, ' ') : ''; }

export function parseMdText(text) {
  const concerning = mdGrab(text, /Concerning\.\.\.([^\n]+)/i);
  const cparts = concerning.split(/\.\.\.+/).map((s) => s.trim()).filter(Boolean);
  const wp = mdGrab(text, /Probability of Watch Issuance\.\.\.\s*(\d+)\s*percent/i);
  // Discussion prose: from after the watch-probability / valid header to before
  // the signature, coordinate block, or boilerplate footer.
  const hdr = /Probability of Watch Issuance[^\n]*\n/i.exec(text) || /Valid\s+[0-9]{6}Z[^\n]*\n/i.exec(text);
  const from = hdr ? hdr.index + hdr[0].length : 0;
  const tail = text.slice(from);
  const end = /\n\s*(?:\.\.[A-Za-z][A-Za-z/. ]*\.\.\s+\d{2}\/\d{2}\/\d{4}|\.\.\.Please see|ATTN\.\.\.|LAT\.\.\.LON)/i.exec(tail);
  return {
    number: mdGrab(text, /Mesoscale Discussion\s+(\d+)/i),
    issued: mdGrab(text, /\n\s*(\d{3,4}\s+(?:AM|PM)\s+\w{2,4}\s+\w{3}\s+\w{3}\s+\d{1,2}\s+\d{4})/i),
    areas: mdGrab(text, /Areas affected\.\.\.([\s\S]*?)\n\s*\n/i),
    concerning,
    category: cparts[0] || concerning,
    watchStatus: cparts.slice(1).join(' · '),
    valid: mdGrab(text, /Valid\s+([0-9]{6}Z\s*-\s*[0-9]{6}Z)/i),
    watchProb: wp ? +wp : null,
    tornado: mdGrab(text, /MOST PROBABLE PEAK TORNADO INTENSITY\.\.\.\s*([^\n]+)/i),
    wind: mdGrab(text, /MOST PROBABLE PEAK WIND GUST\.\.\.\s*([^\n]+)/i),
    hail: mdGrab(text, /MOST PROBABLE PEAK HAIL SIZE\.\.\.\s*([^\n]+)/i),
    body: (end ? tail.slice(0, end.index) : tail).trim(),
  };
}

export async function fetchMdDetail(url) {
  const u = (url || '').replace(/^http:/i, 'https:');
  const res = await fetch(u, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const m = /<pre[^>]*>([\s\S]*?)<\/pre>/i.exec(html);
  return parseMdText(htmlToText(m ? m[1] : html));
}

// "Jun 25, 16:30Z" from several timestamp shapes the feeds use: an ISO string
// (SPC convective), a YYYYMMDDHHMM string (SPC fire), or epoch-ms (CPC).
function fmtZ(v) {
  let d;
  if (typeof v === 'number') d = new Date(v);
  else if (/^\d{12}$/.test(v || '')) d = new Date(Date.UTC(+v.slice(0, 4), +v.slice(4, 6) - 1, +v.slice(6, 8), +v.slice(8, 10), +v.slice(10, 12)));
  else d = new Date(v);
  if (!d || Number.isNaN(d.getTime())) return '';
  const mon = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  const p = (n) => String(n).padStart(2, '0');
  return `${mon} ${d.getUTCDate()}, ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}Z`;
}

export class OutlookController {
  // els: { productSelect, detailSelect, legend, status }
  constructor(map, els) {
    this.map = map;
    this.els = els;
    this.enabled = false;
    this.product = 'spc_conv';
    this.detail = spcConvDetails[0].id;
    this.seq = 0;
    this._last = EMPTY;
  }

  // The detail ids valid for the current product, used to repopulate the picker.
  detailsForProduct(productId) {
    return (OUTLOOKS[productId] || OUTLOOKS.spc_conv).details;
  }

  // The two-axis (day + product) descriptor for a product, or null when the
  // product's details are a single flat list.
  axesForProduct(productId) {
    return (OUTLOOKS[productId] || OUTLOOKS.spc_conv).axes || null;
  }

  // Switch the day of a two-axis product, keeping the current product/type when
  // that type still exists for the new day (else falling back to the first).
  setDay(dayId) {
    const ax = this.axesForProduct(this.product);
    if (!ax) return;
    const cur = ax.split(this.detail);
    const types = ax.types(dayId);
    const type = types.some((t) => t.id === cur.type) ? cur.type : types[0].id;
    this.setDetail(ax.join(dayId, type));
  }

  // Switch the product/type of a two-axis product, keeping the current day.
  setType(typeId) {
    const ax = this.axesForProduct(this.product);
    if (!ax) return;
    const cur = ax.split(this.detail);
    this.setDetail(ax.join(cur.day, typeId));
  }

  setEnabled(on) {
    this.enabled = on;
    if (on) this.load();
    else { this._setData(EMPTY); this._renderLegend([], null); this._setStatus(''); }
  }

  setProduct(productId) {
    this.product = productId;
    const details = this.detailsForProduct(productId);
    if (!details.some((d) => d.id === this.detail)) this.detail = details[0].id;
    if (this.enabled) this.load();
  }

  setDetail(detailId) {
    this.detail = detailId;
    if (this.enabled) this.load();
  }

  _setData(fc) {
    this._last = fc;
    const src = this.map && this.map.getSource && this.map.getSource('spc-outlook');
    if (src) src.setData(fc);
  }

  reapply() {
    if (this.enabled) this._setData(this._last);
  }

  async load() {
    const product = OUTLOOKS[this.product] || OUTLOOKS.spc_conv;
    const detail = product.details.find((d) => d.id === this.detail) || product.details[0];
    const mine = ++this.seq;
    this._setStatus('Loading…');
    try {
      const url = product.url ? product.url(detail) : arcUrl(detail.path, detail.layer);
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const fc = await res.json();
      if (mine !== this.seq) return;
      const feats = (fc.features || []).filter((f) => f.geometry);
      // Normalise each feature's styling into the props the GL layers read.
      for (const f of feats) {
        const s = product.style(f, detail) || {};
        f.properties = f.properties || {};
        f.properties.fill = s.fill || '#888';
        f.properties.stroke = s.stroke || s.fill || '#444';
        f.properties._label = s.label || '';
        f.properties._code = s.code || '';
        f.properties._sort = s.sort || 0;
      }
      this._setData({ type: 'FeatureCollection', features: feats });
      this._renderLegend(feats, product);
      this._setStatus(this._validText(feats, product));
    } catch (e) {
      if (mine !== this.seq) return;
      this._setData(EMPTY);
      this._renderLegend([], product);
      this._setStatus(`Unavailable (${esc(e.message)})`);
    }
  }

  _setStatus(text) {
    if (this.els.status) this.els.status.textContent = text || '';
    if (typeof this.els.extraStatus === 'function') this.els.extraStatus(text || '');
  }

  // A "valid …" line from whatever timestamp fields the feed provides.
  _validText(feats, product) {
    if (!feats.length) return 'No areas for this outlook.';
    const p = feats[0].properties || {};
    // WPC ERO ships a ready-made human window string.
    if (typeof p.valid_time === 'string' && p.valid_time) return `Valid ${p.valid_time}`;
    const v = fmtZ(p.VALID_ISO != null ? p.VALID_ISO : p.valid != null ? p.valid : p.start_date);
    const x = fmtZ(p.EXPIRE_ISO != null ? p.EXPIRE_ISO : p.expire != null ? p.expire : p.end_date);
    if (v && x) return `Valid ${v} – ${x}`;
    if (product && product.label === OUTLOOKS.spc_md.label) return `${feats.length} active discussion${feats.length === 1 ? '' : 's'}`;
    return '';
  }

  // Swatch legend from the distinct areas present, de-duplicated by label.
  _renderLegend(feats, product) {
    const targets = [];
    const seen = new Set();
    const addTarget = (node) => {
      if (!node || seen.has(node)) return;
      seen.add(node);
      targets.push(node);
    };
    addTarget(this.els.legend);
    if (typeof this.els.extraLegend === 'function') addTarget(this.els.extraLegend());
    if (!targets.length) return;
    const byLabel = new Map();
    for (const f of feats) {
      const p = f.properties || {};
      const key = p._label || '';
      if (!key) continue;
      const prev = byLabel.get(key);
      if (!prev || (p._sort || 0) > prev.sort)
        byLabel.set(key, { label: key, code: p._code || '', fill: p.fill || '#888', stroke: p.stroke || '#444', sort: p._sort || 0 });
    }
    const items = [...byLabel.values()].sort((a, b) => a.sort - b.sort);
    if (!items.length) {
      this._legendHTML = '<div class="empty">No areas.</div>';
      targets.forEach((legend) => { legend.innerHTML = this._legendHTML; });
      return;
    }
    this._legendHTML = items.map((it) => {
      // Convective Conditional Intensity areas draw as hatching on the map; match
      // that in the swatch instead of their flat grey fill.
      const m = product && product.cig && /^CIG(\d)/.exec(it.code);
      const sw = m
        ? `<span class="spc-legend-sw spc-legend-hatch" data-cig="${m[1]}"></span>`
        : `<span class="spc-legend-sw" style="background:${esc(it.fill)};border-color:${esc(it.stroke)}"></span>`;
      return `<div class="spc-legend-row">${sw}<span class="spc-legend-label">${esc(it.label)}</span></div>`;
    }).join('');
    targets.forEach((legend) => { legend.innerHTML = this._legendHTML; });
  }

  // ---- SPC Mesoscale Discussion click-through (popup + full briefing) --------
  // Reuses the alert preview/briefing chrome (same DOM + CSS), so an MD reads just
  // like a warning: a compact card first, then a full briefing. Wired once; only
  // acts while the MD product is the active outlook.

  wireMap() {
    if (!this.map || this._wired) return;
    this._wired = true;
    this.map.on('click', (e) => this._onMapClick(e));
    if (this.els.closeBtn)
      this.els.closeBtn.addEventListener('click', () => this.closeMd());
  }

  _onMapClick(e) {
    if (!this.enabled || this.product !== 'spc_md') return;
    if (this.els.suppressClick && this.els.suppressClick()) return; // a map tool owns the click
    if (!this.map.getLayer('spc-outlook-fill')) return;
    const mdFeats = this.map.queryRenderedFeatures(e.point, { layers: ['spc-outlook-fill'] });
    const alertCtrl = this.els.alertController && this.els.alertController();
    const alertIds = alertCtrl && alertCtrl.alertIdsAtPoint ? alertCtrl.alertIdsAtPoint(e.point, this.map) : [];
    const items = [];
    const seenMd = new Set();
    for (const f of mdFeats) {
      const p = f.properties || {};
      const key = p.popupinfo || p.name || JSON.stringify(f.geometry || {});
      if (seenMd.has(key)) continue;
      seenMd.add(key);
      items.push({ kind: 'md', feature: f, key });
    }
    for (const id of alertIds) items.push({ kind: 'alert', id });
    if (items.length) this._openStack(items);
  }

  _openStack(items) {
    if (this.els.closeAlerts) this.els.closeAlerts();
    this._stack = items;
    this._stackIndex = 0;
    document.querySelector('.app')?.classList.add('alert-preview-open');
    this._renderStackPreview();
  }

  _stackItem() {
    return this._stack && this._stack[this._stackIndex];
  }

  _cycleStack(delta) {
    if (!this._stack || this._stack.length < 2) return;
    this._stackIndex = (this._stackIndex + delta + this._stack.length) % this._stack.length;
    this._renderStackPreview();
  }

  _stackNavHTML() {
    const multi = this._stack && this._stack.length > 1;
    if (!multi) return { dots: '', nav: '' };
    const dots = `<div class="apv-dots">${this._stack
      .map((_, i) => `<span class="apv-dot${i === this._stackIndex ? ' on' : ''}"></span>`)
      .join('')}</div>`;
    const nav = `<div class="apv-nav">
      <button class="apv-nav-btn" data-dir="-1" aria-label="Previous item">‹</button>
      <button class="apv-nav-btn" data-dir="1" aria-label="Next item">›</button>
    </div>`;
    return { dots, nav };
  }

  _renderStackPreview() {
    const item = this._stackItem();
    if (!item) return this.closeMd();
    if (item.kind === 'alert') return this._renderAlertStackPreview(item.id);
    this._openMd(item.feature, true);
  }

  _renderAlertStackPreview(id) {
    const alertCtrl = this.els.alertController && this.els.alertController();
    const data = alertCtrl && alertCtrl.previewData && alertCtrl.previewData(id);
    const wrap = this.els.previewWrap, card = this.els.previewCard;
    if (!data || !wrap || !card) return;
    const { dots, nav } = this._stackNavHTML();
    const rows = data.rows.map(([k, v]) => `<div class="apv-row"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('');
    card.innerHTML = `
      <header class="apv-head" style="--ac:${data.color}">
        <span class="apv-icon">⚠</span>
        <div class="apv-htext">
          <h3>${esc(data.title)}</h3>
          <span class="apv-area">${esc(data.area)}</span>
        </div>
        <button class="apv-close" aria-label="Close">✕</button>
      </header>
      <div class="apv-body">${rows}${dots}</div>
      <footer class="apv-foot">
        ${nav}
        <button class="apv-details">View full briefing →</button>
      </footer>`;
    wrap.hidden = false;
    card.querySelector('.apv-close').addEventListener('click', () => this.closeMd());
    card.querySelector('.apv-details').addEventListener('click', () => this._openStackBriefing());
    card.querySelectorAll('.apv-nav-btn')
      .forEach((b) => b.addEventListener('click', () => this._cycleStack(Number(b.dataset.dir))));
  }

  async _openMd(feature, stacked = false) {
    const p = feature.properties || {};
    const url = p.popupinfo || '';
    const name = p.name || 'Mesoscale Discussion';
    if (!stacked && this.els.closeAlerts) this.els.closeAlerts(); // MD and alerts share the chrome
    const mine = (this._mdSeq = (this._mdSeq || 0) + 1);
    // Show the card immediately with a loading state, then fill in the detail.
    this._md = { number: (name.match(/\d+/) || [''])[0], url, loading: true };
    this._renderMdPreview(name);
    try {
      const md = await fetchMdDetail(url);
      if (mine !== this._mdSeq) return;
      this._md = { ...md, url };
      this._renderMdPreview(name);
    } catch (err) {
      if (mine !== this._mdSeq) return;
      this._md = { number: this._md.number, url, error: err.message };
      this._renderMdPreview(name);
    }
  }

  // The "Most Probable Peak Intensity" hazard chips + the Min→Max scale bar, the
  // graphic SPC publishes with watch-concerning MDs.
  _mdHazardsHTML(md) {
    const boxes = [];
    if (md.tornado) boxes.push(`<div class="hz"><span>TORNADO</span><b>${esc(md.tornado)}</b></div>`);
    if (md.wind) boxes.push(`<div class="hz"><span>WIND</span><b>${esc(md.wind)}</b></div>`);
    if (md.hail) boxes.push(`<div class="hz"><span>HAIL</span><b>${esc(md.hail)}</b></div>`);
    if (!boxes.length) return '';
    return `<div class="md-peak-title">Most Probable Peak Intensity</div>
      <div class="alert-hazards">${boxes.join('')}</div>`;
  }

  _renderMdPreview(name) {
    const wrap = this.els.previewWrap, card = this.els.previewCard;
    if (!wrap || !card) return;
    const md = this._md || {};
    const ac = '#b32fe0';
    let body;
    if (md.loading) body = `<div class="apv-row"><span>Loading…</span><b></b></div>`;
    else if (md.error) body = `<div class="apv-row"><span>Unavailable</span><b>${esc(md.error)}</b></div>`;
    else {
      const rows = [];
      if (md.category) rows.push(`<div class="apv-row"><span>Concerning</span><b>${esc(md.category)}</b></div>`);
      if (md.watchStatus) rows.push(`<div class="apv-row"><span>Status</span><b>${esc(md.watchStatus)}</b></div>`);
      if (md.watchProb != null) rows.push(`<div class="apv-row"><span>Watch Prob.</span><b>${md.watchProb}%</b></div>`);
      body = rows.join('') + this._mdHazardsHTML(md);
    }
    const stackChrome = this._stack ? this._stackNavHTML() : { dots: '', nav: '' };
    card.innerHTML = `
      <header class="apv-head" style="--ac:${ac}">
        <span class="apv-icon">▦</span>
        <div class="apv-htext">
          <h3>Mesoscale Disc. #${esc(md.number || (name.match(/\d+/) || [''])[0])}</h3>
          <span class="apv-area">${esc(md.areas ? md.areas.replace(/\s+/g, ' ') : 'SPC')}</span>
        </div>
        <button class="apv-close" aria-label="Close">✕</button>
      </header>
      <div class="apv-body">${body}${stackChrome.dots}</div>
      <footer class="apv-foot">
        ${stackChrome.nav}
        <button class="apv-details"${md.loading || md.error ? ' disabled' : ''}>View full briefing →</button>
      </footer>`;
    wrap.hidden = false;
    card.querySelector('.apv-close').addEventListener('click', () => this.closeMd());
    const det = card.querySelector('.apv-details');
    if (det && !md.loading && !md.error) det.addEventListener('click', () => this._stack ? this._openStackBriefing() : this._openMdBriefing());
    card.querySelectorAll('.apv-nav-btn')
      .forEach((b) => b.addEventListener('click', () => this._cycleStack(Number(b.dataset.dir))));
  }

  _openStackBriefing() {
    const item = this._stackItem();
    if (!item) return;
    if (this.els.previewWrap) this.els.previewWrap.hidden = true;
    const app = document.querySelector('.app');
    if (app) {
      app.classList.remove('alert-preview-open');
      app.classList.add('alert-mode');
      app.classList.toggle('alert-split-mode', !!document.querySelector('.map-wrap.split'));
    }
    const nav = this._stack && this._stack.length > 1
      ? `<div class="alert-nav">
           <button class="alert-nav-btn" data-dir="-1" aria-label="Previous item">â€¹</button>
           <span class="alert-nav-count">${this._stackIndex + 1} / ${this._stack.length} items here</span>
           <button class="alert-nav-btn" data-dir="1" aria-label="Next item">â€º</button>
         </div>`
      : '';
    let html = '';
    if (item.kind === 'alert') {
      const alertCtrl = this.els.alertController && this.els.alertController();
      const a = alertCtrl && alertCtrl.alertById && alertCtrl.alertById(item.id);
      html = a && alertCtrl.sectionHTML ? alertCtrl.sectionHTML(a, true) : '';
    } else {
      const md = this._md;
      if (!md || md.error || md.loading) return;
      html = this._renderMdBriefing(md);
    }
    if (this.els.detailPanel) {
      this.els.detailPanel.innerHTML = nav + html;
      this.els.detailPanel.scrollTop = 0;
      this.els.detailPanel.querySelectorAll('.alert-nav-btn')
        .forEach((b) => b.addEventListener('click', async () => {
          this._stackIndex = (this._stackIndex + Number(b.dataset.dir) + this._stack.length) % this._stack.length;
          const next = this._stackItem();
          if (next && next.kind === 'md') await this._openMd(next.feature, true);
          this._openStackBriefing();
        }));
    }
    if (this.els.detailWrap) this.els.detailWrap.hidden = false;
    setTimeout(() => this.map && this.map.resize(), 60);
  }

  _openMdBriefing() {
    const md = this._md;
    if (!md || md.error) return;
    if (this.els.previewWrap) this.els.previewWrap.hidden = true;
    const app = document.querySelector('.app');
    if (app) {
      app.classList.add('alert-mode');
      app.classList.toggle('alert-split-mode', !!document.querySelector('.map-wrap.split'));
    }
    if (this.els.detailPanel) this.els.detailPanel.innerHTML = this._renderMdBriefing(md);
    if (this.els.detailWrap) this.els.detailWrap.hidden = false;
    if (this.els.detailPanel) this.els.detailPanel.scrollTop = 0;
    setTimeout(() => this.map && this.map.resize(), 60);
  }

  _renderMdBriefing(md) {
    const ac = '#b32fe0';
    const concern = [md.category, md.watchStatus].filter(Boolean).join(' · ');
    const paras = (md.body || '')
      .split(/\n\s*\n/)
      .map((s) => esc(s.replace(/\s*\n\s*/g, ' ').trim()))
      .filter(Boolean)
      .map((s) => `<p>${s}</p>`)
      .join('');
    const concernBlock = (concern || md.watchProb != null)
      ? `<div class="md-concern">
           ${concern ? `<div class="md-concern-line">${esc(concern)}</div>` : ''}
           ${md.watchProb != null ? `<div class="md-watchprob"><span>Watch Probability</span><b>${md.watchProb}%</b></div>` : ''}
         </div>`
      : '';
    return `
      <section class="alert-sec selected">
        <header class="alert-sec-head" style="--ac:${ac}">
          <span class="alert-sec-icon">▦</span>
          <h3>Mesoscale Discussion #${esc(md.number)}</h3>
        </header>
        <div class="alert-sec-body">
          ${md.valid ? `<div class="alert-expires"><span class="alert-title">VALID</span><b>${esc(md.valid)}</b></div>` : ''}
          ${concernBlock}
          ${this._mdHazardsHTML(md)}
          ${md.issued ? `<div class="alert-issued">Issued ${esc(md.issued)} · NWS SPC</div>` : ''}
          ${md.areas ? `<div class="alert-loc"><span class="alert-title">AREAS AFFECTED</span><p>${esc(md.areas.replace(/\s+/g, ' '))}</p></div>` : ''}
          <div class="alert-block"><span class="alert-title">DISCUSSION</span>${paras || '<p>—</p>'}</div>
          <div class="md-source"><a href="${esc(md.url || '#')}" target="_blank" rel="noopener">Open on spc.noaa.gov →</a></div>
        </div>
      </section>`;
  }

  // Hide both the MD card and briefing and restore the layout. Safe to call when
  // nothing MD-related is open (it just clears the shared chrome's MD state).
  closeMd() {
    this._mdSeq = (this._mdSeq || 0) + 1; // cancel any in-flight fetch
    this._md = null;
    this._stack = null;
    this._stackIndex = 0;
    if (this.els.previewWrap) this.els.previewWrap.hidden = true;
    if (this.els.detailWrap) this.els.detailWrap.hidden = true;
    const app = document.querySelector('.app');
    if (app) app.classList.remove('alert-mode', 'alert-split-mode', 'alert-preview-open');
  }
}
