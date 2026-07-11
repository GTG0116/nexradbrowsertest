// lsr.js — NWS Local Storm Reports overlay.
//
// Source: the Iowa Environmental Mesonet's LSR GeoJSON feed
// (mesonet.agron.iastate.edu/geojson/lsr.geojson), which aggregates every LSR
// the WFOs issue and serves it CORS-enabled. Chosen over SPC's storm-report
// CSVs deliberately: SPC only carries tornado / wind / hail, while the IEM
// feed has the full LSR event set — flash floods, floods, heavy rain, debris
// flows, winter weather, marine reports, and so on. Each report is a point
// with the raw LSR fields (typetext, magnitude+unit, city/county/state,
// source, remark, issuing WFO, valid time).
//
// The controller mirrors CyclonesController's shape: app.js builds the GL
// source + layer in setupOverlays (style reloads wipe them; reapply()
// re-pushes data, visibility and the category filter), and this class owns
// the fetch cycle, the master toggle, the time-window select, the
// per-category filter chips, the sidebar report list, and the compact preview
// card a click on a report opens.

const LSR_URL = 'https://mesonet.agron.iastate.edu/geojson/lsr.geojson';

// Reports trickle in continuously during active weather; a few-minute poll
// keeps the layer fresh without hammering the feed.
const REFRESH_MS = 5 * 60000;

export const LSR_HOURS_CHOICES = [1, 3, 6, 12, 24];
export const LSR_DEFAULT_HOURS = 6;

// Report categories: the colour/filter buckets every LSR event type maps
// into. Flooding gets its own first-class bucket (flash flood, flood, heavy
// rain, debris flow, coastal…) — the whole point of using the IEM feed over
// SPC's tornado/wind/hail-only CSVs.
export const LSR_CATEGORIES = {
  tornado: { label: 'Tornado', color: '#e8332c', icon: '🌪️' },
  wind: { label: 'Wind', color: '#3f8ef7', icon: '💨' },
  hail: { label: 'Hail', color: '#2fb44b', icon: '🧊' },
  flood: { label: 'Flood / rain', color: '#26c6da', icon: '🌊' },
  winter: { label: 'Winter', color: '#b9a7f7', icon: '❄️' },
  other: { label: 'Other', color: '#93a1b0', icon: '📍' },
};
const CAT_IDS = Object.keys(LSR_CATEGORIES);

export function defaultLsrCats() {
  const cats = {};
  for (const id of CAT_IDS) cats[id] = true;
  return cats;
}

// Map an LSR event type onto a bucket + marker colour. Matched on the raw
// `typetext` (e.g. "TSTM WND DMG", "FLASH FLOOD"). Some types get their own
// colour within a bucket (funnel clouds aren't tornadoes; lightning stands
// out from the grab-bag) — the bucket only governs filtering.
// Rule order matters: FREEZING RAIN must hit `winter` before the rain rule,
// and DUST STORM must miss the wind rules.
const TYPE_RULES = [
  [/TORNADO|LANDSPOUT|WATER ?SPOUT/, 'tornado', null],
  [/FUNNEL|WALL CLOUD|DUST DEVIL/, 'tornado', '#ff9d1e'],
  [/HAIL/, 'hail', null],
  [/SNOW|BLIZZARD|SLEET|ICE|FREEZING|WINTER|AVALANCHE|COLD|WIND CHILL|FROST/, 'winter', null],
  [/FLOOD|RAIN|DEBRIS FLOW|MUD ?SLIDE|LANDSLIDE|STORM SURGE|SEICHE|HIGH SURF|RIP CURRENT|HIGH ASTR|TSUNAMI|DAM (BREAK|FAILURE)/, 'flood', null],
  [/WND|WIND/, 'wind', null],
  [/LIGHTNING/, 'other', '#ffd93d'],
];

export function lsrCategory(typetext) {
  const t = String(typetext || '').toUpperCase();
  for (const [re, cat, color] of TYPE_RULES) {
    if (re.test(t)) return { cat, color: color || LSR_CATEGORIES[cat].color };
  }
  return { cat: 'other', color: LSR_CATEGORIES.other.color };
}

const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'
  );

// "TSTM WND DMG" → "Tstm Wnd Dmg" reads worse than the raw shout; expand the
// common LSR abbreviations instead, then title-case.
const TYPE_WORDS = {
  TSTM: 'T-storm', 'NON-TSTM': 'Non-t-storm', WND: 'Wind', DMG: 'Damage',
  GST: 'Gust', EXTR: 'Extreme', SUST: 'Sustained',
};
export function lsrTypeName(typetext) {
  return String(typetext || 'Report')
    .trim()
    .split(/\s+/)
    .map((w) => TYPE_WORDS[w.toUpperCase()]
      || w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

// "1.75 inch", "62 mph" — magnitude + unit when the report carries one.
function magnitudeText(p) {
  const mag = p.magnitude != null && p.magnitude !== '' ? p.magnitude : p.magf;
  if (mag == null || mag === '' || Number(mag) === 0) return null;
  return `${mag}${p.unit ? ' ' + String(p.unit).toLowerCase() : ''}`;
}

const pad = (n) => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function timeShort(date, withDate) {
  const hm = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}Z`;
  return withDate ? `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()} ${hm}` : hm;
}

function timeAgo(date) {
  const mins = Math.max(0, Math.round((Date.now() - date.getTime()) / 60000));
  if (mins < 60) return `${mins} min ago`;
  const h = Math.floor(mins / 60);
  return `${h}h ${mins % 60}m ago`;
}

// One normalised report record. `feature` keeps a reference for the GL source.
function normaliseReport(f, index) {
  const p = f.properties || {};
  const [lon, lat] = (f.geometry && f.geometry.coordinates) || [p.lon, p.lat];
  const { cat, color } = lsrCategory(p.typetext);
  const valid = p.valid ? new Date(p.valid) : null;
  return {
    id: `lsr:${index}`,
    cat,
    color,
    lon,
    lat,
    valid,
    typetext: p.typetext || 'REPORT',
    typeName: lsrTypeName(p.typetext),
    magnitude: magnitudeText(p),
    city: p.city || '',
    county: p.county || '',
    state: p.state || p.st || '',
    source: p.source || '',
    remark: p.remark || '',
    wfo: p.wfo || '',
  };
}

function reportsToFeatures(reports) {
  return reports.map((r) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [r.lon, r.lat] },
    properties: { id: r.id, cat: r.cat, color: r.color },
  }));
}

export const LSR_LAYER_IDS = ['lsr-points'];

export class LsrController {
  constructor(map, els) {
    this.map = map;
    // els: { list, status, filters, hoursSelect, preview, previewCard,
    //        suppressClick }
    this.els = els || {};
    this.enabled = false;
    this.hours = LSR_DEFAULT_HOURS;
    // Per-category visibility (all on by default), under the master toggle.
    this.cats = defaultLsrCats();
    this.reports = [];
    this.timer = null;
    this._loading = false;
    this._loadedAt = 0;
    this._loadedHours = 0;
    this._lastFeatures = [];

    // Clicking a report marker opens the compact preview card. Registered up
    // front like alerts/cyclones — Mapbox resolves the layer id at event time,
    // so it's fine that setupOverlays adds the layer later (and re-adds it
    // after every style reload).
    map.on('click', 'lsr-points', (e) => this._openFromEvent(e));
    map.on('mouseenter', 'lsr-points', () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', 'lsr-points', () => (map.getCanvas().style.cursor = ''));
    if (this.els.preview) {
      this.els.preview.addEventListener('click', (e) => {
        if (e.target === this.els.preview) this.closePreview();
      });
    }
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.closePreview();
    });

    if (this.els.hoursSelect) {
      this.els.hoursSelect.addEventListener('change', () => {
        this.setHours(Number(this.els.hoursSelect.value));
        if (this.els.onPrefsChanged) this.els.onPrefsChanged();
      });
    }
    this.renderFilters();
  }

  reportById(id) {
    return this.reports.find((r) => r.id === id) || null;
  }

  // Master toggle. Turning on (re)starts the poll and loads if the data is
  // missing or stale; turning off stops polling and hides the layer, keeping
  // the last data so re-enabling is instant.
  setEnabled(on) {
    this.enabled = !!on;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.enabled) {
      if (this._stale()) this.load();
      this.timer = setInterval(() => this.load(), REFRESH_MS);
    } else {
      this.closePreview();
    }
    this.applyVisibility();
    this.renderList();
  }

  _stale() {
    return !this.reports.length
      || this._loadedHours !== this.hours
      || Date.now() - this._loadedAt > REFRESH_MS;
  }

  setHours(hours) {
    if (!LSR_HOURS_CHOICES.includes(hours)) return;
    this.hours = hours;
    if (this.els.hoursSelect) this.els.hoursSelect.value = String(hours);
    if (this.enabled) this.load();
  }

  setCat(cat, on) {
    if (!(cat in this.cats)) return;
    this.cats[cat] = !!on;
    this.applyFilter();
    this.renderList(); // re-renders the chips too
  }

  // Push master visibility onto the GL layer (no-op until setupOverlays has
  // given the current style the layer).
  applyVisibility() {
    const map = this.map;
    if (!map || !map.getLayer) return;
    const vis = this.enabled ? 'visible' : 'none';
    for (const id of LSR_LAYER_IDS) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
    }
  }

  // Category chips → a GL filter on the points layer.
  applyFilter() {
    const map = this.map;
    if (!map || !map.getLayer || !map.getLayer('lsr-points')) return;
    const on = CAT_IDS.filter((c) => this.cats[c]);
    map.setFilter(
      'lsr-points',
      on.length === CAT_IDS.length ? null : ['in', ['get', 'cat'], ['literal', on]]
    );
  }

  // Re-push data + visibility + filter after a style reload rebuilt the
  // (empty) source and layer — same contract as cyclones.reapply().
  reapply() {
    this._setSourceData(this._lastFeatures);
    this.applyVisibility();
    this.applyFilter();
  }

  async load() {
    if (this._loading) return;
    this._loading = true;
    const hours = this.hours;
    this._setStatus('loading storm reports…');
    let json;
    try {
      const res = await fetch(`${LSR_URL}?hours=${hours}`);
      if (!res.ok) throw new Error(`LSR HTTP ${res.status}`);
      json = await res.json();
    } catch (e) {
      console.error('LSR fetch failed', e);
      this._loading = false;
      this._setStatus('storm reports unavailable');
      return;
    }
    this._loading = false;
    // The window changed while this fetch was in flight — its result is for
    // the old window; refetch instead of presenting it as the new one.
    if (this.hours !== hours) return this.load();
    const feats = (json && json.features) || [];
    this.reports = feats
      .map(normaliseReport)
      .filter((r) => Number.isFinite(r.lon) && Number.isFinite(r.lat))
      .sort((a, b) => (b.valid ? b.valid.getTime() : 0) - (a.valid ? a.valid.getTime() : 0));
    this._loadedAt = Date.now();
    this._loadedHours = hours;
    this._lastFeatures = reportsToFeatures(this.reports);
    this._setSourceData(this._lastFeatures);
    this.applyFilter();
    this.renderList();
  }

  _setSourceData(features) {
    const src = this.map && this.map.getSource && this.map.getSource('lsr');
    if (src) src.setData({ type: 'FeatureCollection', features });
  }

  _setStatus(text) {
    if (this.els.status) this.els.status.textContent = text;
  }

  // The category filter chips: one per bucket, lit when shown. Counts ride on
  // the chips so "is anything flooding?" is answerable at a glance.
  renderFilters() {
    const box = this.els.filters;
    if (!box) return;
    const counts = {};
    for (const r of this.reports) counts[r.cat] = (counts[r.cat] || 0) + 1;
    box.innerHTML = '';
    for (const id of CAT_IDS) {
      const def = LSR_CATEGORIES[id];
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'lsr-chip' + (this.cats[id] ? ' active' : '');
      chip.style.setProperty('--ac', def.color);
      chip.title = `${this.cats[id] ? 'Hide' : 'Show'} ${def.label.toLowerCase()} reports`;
      chip.innerHTML = `<span class="lsr-chip-dot"></span>${esc(def.label)}${
        counts[id] ? ` <b>${counts[id]}</b>` : ''
      }`;
      chip.addEventListener('click', () => {
        this.setCat(id, !this.cats[id]);
        if (this.els.onPrefsChanged) this.els.onPrefsChanged();
      });
      box.appendChild(chip);
    }
  }

  // The sidebar report list (newest first, filtered by the chips); clicking a
  // row flies the map to the report and opens its preview card.
  renderList() {
    this.renderFilters();
    const list = this.els.list;
    if (!list) return;
    if (!this.enabled) {
      list.innerHTML = '';
      this._setStatus('overlay off');
      return;
    }
    const shown = this.reports.filter((r) => this.cats[r.cat]);
    if (!shown.length) {
      list.innerHTML = '';
      if (!this._loading)
        this._setStatus(this.reports.length
          ? 'all categories hidden'
          : `no reports in the past ${this.hours} h`);
      return;
    }
    const hidden = this.reports.length - shown.length;
    this._setStatus(
      `${shown.length} report${shown.length === 1 ? '' : 's'} · past ${this.hours} h` +
      (hidden ? ` (${hidden} filtered)` : '')
    );
    const withDate = this.hours > 12;
    list.innerHTML = '';
    // Cap the DOM at a sane size — a busy 24 h window is thousands of rows.
    for (const r of shown.slice(0, 400)) {
      const row = document.createElement('button');
      row.className = 'alert-row';
      row.style.setProperty('--ac', r.color);
      const name = r.magnitude ? `${r.typeName} · ${r.magnitude}` : r.typeName;
      const where = [r.city, r.state].filter(Boolean).join(', ');
      row.innerHTML = `<span class="alert-row-dot"></span><span class="alert-row-name">${esc(
        name
      )}</span><span class="alert-row-area">${esc(where)}${where ? ' · ' : ''}${
        r.valid ? esc(timeShort(r.valid, withDate)) : ''
      }</span>`;
      row.addEventListener('click', () => {
        this.map.flyTo({ center: [r.lon, r.lat], zoom: Math.max(this.map.getZoom(), 8) });
        this.openPreview(r.id);
      });
      list.appendChild(row);
    }
  }

  _openFromEvent(e) {
    // A click-consuming map tool (storm track / measure / draw) owns the tap.
    if (this.els.suppressClick && this.els.suppressClick()) return;
    const f = (e.features || [])[0];
    if (!f || !f.properties) return;
    this.openPreview(f.properties.id);
  }

  openPreview(id) {
    const r = this.reportById(id);
    if (!r || !this.els.preview || !this.els.previewCard) return;
    const rows = [];
    const addRow = (label, value) => {
      if (value == null || value === '') return;
      rows.push(`<div class="apv-row"><span>${esc(label)}</span><b>${esc(value)}</b></div>`);
    };
    addRow('Magnitude', r.magnitude);
    if (r.valid) addRow('Time', `${timeShort(r.valid, true)} (${timeAgo(r.valid)})`);
    addRow('Location', [r.city, r.county && `${r.county} Co.`, r.state].filter(Boolean).join(', '));
    addRow('Source', r.source);
    addRow('Office', r.wfo ? `NWS ${r.wfo}` : null);
    const remark = r.remark
      ? `<div class="apv-remark">${esc(r.remark)}</div>`
      : '';
    this.els.previewCard.innerHTML = `
      <header class="apv-head" style="--ac:${r.color}">
        <span class="apv-icon">${LSR_CATEGORIES[r.cat].icon}</span>
        <div class="apv-htext">
          <h3>${esc(r.typeName)}</h3>
          <span class="apv-area">Local storm report</span>
        </div>
        <button class="apv-close" aria-label="Close">✕</button>
      </header>
      <div class="apv-body">${rows.join('')}${remark}</div>`;
    this.els.previewCard
      .querySelector('.apv-close')
      .addEventListener('click', () => this.closePreview());
    this.els.preview.hidden = false;
  }

  closePreview() {
    if (this.els.preview) this.els.preview.hidden = true;
  }
}
