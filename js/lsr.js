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
const escAttr = (s) => esc(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');

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
  if (!date || !Number.isFinite(date.getTime())) return '';
  const hm = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}Z`;
  return withDate ? `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()} ${hm}` : hm;
}

function timeAgo(date) {
  if (!date || !Number.isFinite(date.getTime())) return '';
  const mins = Math.max(0, Math.round((Date.now() - date.getTime()) / 60000));
  if (mins < 60) return `${mins} min ago`;
  const h = Math.floor(mins / 60);
  return `${h}h ${mins % 60}m ago`;
}

function timeFull(date) {
  if (!date || !Number.isFinite(date.getTime())) return 'Time unavailable';
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()} · ${pad(
    date.getUTCHours()
  )}:${pad(date.getUTCMinutes())}Z`;
}

function parseReportDate(value) {
  if (value == null || value === '') return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

// A feed refresh can freely reorder its FeatureCollection, so array indexes are
// not report identities. Prefer a source-provided id; otherwise hash the fields
// that define a report. This keeps an open preview/briefing attached to the same
// report across the five-minute refresh cycle.
function hashText(value) {
  let hash = 2166136261;
  const text = String(value == null ? '' : value);
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function stableReportId(feature, p, lon, lat) {
  const supplied = feature.id ?? p.id ?? p.lsr_id ?? p.report_id;
  if (supplied != null && supplied !== '') return `lsr:${String(supplied)}`;
  const fingerprint = [
    // One NWS text product can contain several point reports, so product_id is
    // useful input to the fingerprint but is not unique by itself.
    p.product_id,
    p.valid,
    p.typetext,
    p.magnitude ?? p.magf,
    p.unit,
    p.city,
    p.county,
    p.state ?? p.st,
    p.source,
    p.wfo,
    p.remark,
    Number.isFinite(Number(lon)) ? Number(lon).toFixed(5) : lon,
    Number.isFinite(Number(lat)) ? Number(lat).toFixed(5) : lat,
  ].map((v) => String(v == null ? '' : v)).join('\u001f');
  return `lsr:${hashText(fingerprint)}`;
}

function detailValue(value) {
  if (value == null || value === '') return '';
  if (Array.isArray(value)) return value.map(detailValue).filter(Boolean).join(', ');
  if (typeof value === 'object') {
    try { return JSON.stringify(value); }
    catch (_) { return String(value); }
  }
  return String(value);
}

function detailLabel(key) {
  return String(key || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

const CORE_REPORT_FIELDS = new Set([
  'valid', 'typetext', 'magnitude', 'magf', 'unit', 'city', 'county', 'state', 'st',
  'source', 'remark', 'wfo', 'lon', 'lat',
]);

function extraReportDetails(p) {
  const details = [];
  for (const [key, raw] of Object.entries(p)) {
    if (CORE_REPORT_FIELDS.has(key)) continue;
    const value = detailValue(raw);
    if (!value) continue;
    details.push({ key, label: detailLabel(key), value });
  }
  return details;
}

function reportLocation(r) {
  return [r.city, r.county && `${r.county} Co.`, r.state].filter(Boolean).join(', ');
}

function reportCoordinates(r) {
  if (!Number.isFinite(r.lat) || !Number.isFinite(r.lon)) return '';
  const lat = `${Math.abs(r.lat).toFixed(4)}° ${r.lat < 0 ? 'S' : 'N'}`;
  const lon = `${Math.abs(r.lon).toFixed(4)}° ${r.lon < 0 ? 'W' : 'E'}`;
  return `${lat}, ${lon}`;
}

function coordinateNumber(value) {
  if (value == null || value === '') return NaN;
  return Number(value);
}

// One normalised report record. Keep the complete primitive property set as
// `extraDetails` so the expanded briefing does not silently discard fields the
// feed adds beyond the familiar LSR schema.
function normaliseReport(f) {
  const p = f.properties || {};
  const [lon, lat] = (f.geometry && f.geometry.coordinates) || [p.lon, p.lat];
  const { cat, color } = lsrCategory(p.typetext);
  const valid = parseReportDate(p.valid);
  return {
    id: stableReportId(f, p, lon, lat),
    cat,
    color,
    lon: coordinateNumber(lon),
    lat: coordinateNumber(lat),
    valid,
    validRaw: p.valid || '',
    typetext: p.typetext || 'REPORT',
    typeName: lsrTypeName(p.typetext),
    magnitude: magnitudeText(p),
    city: p.city || '',
    county: p.county || '',
    state: p.state || p.st || '',
    source: p.source || '',
    remark: p.remark || '',
    wfo: p.wfo || '',
    extraDetails: extraReportDetails(p),
  };
}

function reportsToFeatures(reports, selectedId = null) {
  return reports.map((r) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [r.lon, r.lat] },
    properties: { id: r.id, cat: r.cat, color: r.color, selected: r.id === selectedId },
  }));
}

export const LSR_LAYER_IDS = ['lsr-points'];

export class LsrController {
  constructor(map, els) {
    this.map = map;
    // els: { list, status, filters, hoursSelect, preview, previewCard,
    //        detail, detailPanel, detailClose, resizeMaps,
    //        closeOtherBriefings, suppressClick }
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
    this.selectedId = null;
    this.group = [];
    this.groupIndex = 0;
    this.detailOpen = false;

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
    const detailClose = this.els.detailClose || this.els.close;
    if (detailClose) detailClose.addEventListener('click', () => this.closeDetail());
    document.addEventListener('keydown', (e) => {
      const previewOpen = !!(this.els.preview && !this.els.preview.hidden);
      if (e.key === 'Escape') {
        if (previewOpen) this.closePreview();
        else if (this.detailOpen) this.closeDetail();
        return;
      }
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const delta = e.key === 'ArrowLeft' ? -1 : 1;
      if (previewOpen) this.cyclePreview(delta);
      else if (this.detailOpen) this.cycle(delta);
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

  _previewOpen() {
    return !!(this.els.preview && !this.els.preview.hidden);
  }

  _closeOtherBriefings() {
    if (typeof this.els.closeOtherBriefings === 'function')
      this.els.closeOtherBriefings('lsr');
  }

  // Resolve a click into the reports rendered at that point. IDs are de-duped
  // and filtered against the latest feed so stale GL events cannot select a
  // report that disappeared during a refresh.
  _setGroup(id, group) {
    const candidates = group && group.length ? group : [id];
    const ids = [];
    for (const candidate of candidates) {
      if (!candidate || ids.includes(candidate) || !this.reportById(candidate)) continue;
      ids.push(candidate);
    }
    if (this.reportById(id) && !ids.includes(id)) ids.unshift(id);
    this.group = ids;
    this.groupIndex = Math.max(0, ids.indexOf(id));
    this.selectedId = ids[this.groupIndex] || null;
  }

  _clearSelection() {
    this.selectedId = null;
    this.group = [];
    this.groupIndex = 0;
  }

  // Keep an open card/panel attached to its stable report after a feed refresh.
  // If the report aged out of the selected time window, dismiss that view.
  _reconcileOpenSelection() {
    if (!this.selectedId) return;
    const ids = this.group.filter((id) => !!this.reportById(id));
    if (!this.reportById(this.selectedId)) {
      if (ids.length) this.selectedId = ids[0];
      else {
        if (this.detailOpen) this.closeDetail();
        else if (this._previewOpen()) this.closePreview();
        return;
      }
    }
    this._setGroup(this.selectedId, ids);
    if (this.detailOpen) this.renderDetail();
    else if (this._previewOpen()) this.renderPreview();
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
      this.closeDetail();
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
    const categoryFilter = ['in', ['get', 'cat'], ['literal', on]];
    // A selected report stays visible even if its category chip is switched
    // off while the briefing is open.
    const filter = on.length === CAT_IDS.length
      ? null
      : this.detailOpen
        ? ['any', ['boolean', ['get', 'selected'], false], categoryFilter]
        : categoryFilter;
    map.setFilter(
      'lsr-points',
      filter
    );
  }

  // Re-push data + visibility + filter after a style reload rebuilt the
  // (empty) source and layer — same contract as cyclones.reapply().
  reapply() {
    this._applyReportFeatures();
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
    const seen = new Set();
    this.reports = feats
      .map(normaliseReport)
      .filter((r) => Number.isFinite(r.lon) && Number.isFinite(r.lat))
      .filter((r) => {
        if (seen.has(r.id)) return false;
        seen.add(r.id);
        return true;
      })
      .sort((a, b) => (b.valid ? b.valid.getTime() : 0) - (a.valid ? a.valid.getTime() : 0));
    this._loadedAt = Date.now();
    this._loadedHours = hours;
    this._lastFeatures = reportsToFeatures(this.reports);
    this._reconcileOpenSelection();
    this._applyReportFeatures();
    this.applyFilter();
    this.renderList();
  }

  _setSourceData(features) {
    const src = this.map && this.map.getSource && this.map.getSource('lsr');
    if (src) src.setData({ type: 'FeatureCollection', features });
  }

  // Match alert briefing behavior by isolating the selected point while its
  // expanded report is open. The base feature cache remains untouched so close
  // and style reloads can restore the complete report set immediately.
  _applyReportFeatures() {
    if (this.detailOpen && this.selectedId) {
      const selected = this.reportById(this.selectedId);
      if (selected) {
        this._setSourceData(reportsToFeatures([selected], selected.id));
        return;
      }
    }
    this._setSourceData(this._lastFeatures);
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
    const ids = [];
    for (const feature of e.features || []) {
      const id = feature && feature.properties && feature.properties.id;
      if (id && !ids.includes(id) && this.reportById(id)) ids.push(id);
    }
    if (ids.length) this.openPreview(ids[0], ids);
  }

  _previewRows(r) {
    const rows = [];
    const add = (label, value) => {
      if (value != null && value !== '') rows.push([label, String(value)]);
    };
    add('Magnitude', r.magnitude);
    if (r.valid) {
      const ago = timeAgo(r.valid);
      add('Time', `${timeShort(r.valid, true)}${ago ? ` (${ago})` : ''}`);
    } else {
      add('Time', r.validRaw);
    }
    add('Location', reportLocation(r));
    add('Source', r.source);
    add('Office', r.wfo ? `NWS ${r.wfo}` : '');
    return rows;
  }

  // Public data-only form used by exports and by any future mixed popup stack.
  // It intentionally matches the existing alert-card basics (color/title/area/
  // rows) while identifying itself and carrying its own icon.
  previewData(id) {
    const r = this.reportById(id);
    if (!r) return null;
    return {
      kind: 'storm-report',
      icon: LSR_CATEGORIES[r.cat].icon,
      color: r.color,
      title: r.typeName,
      subtitle: 'Local storm report',
      area: reportLocation(r) || 'Local storm report',
      rows: this._previewRows(r),
      remark: r.remark || '',
    };
  }

  _groupData() {
    return this.group && this.group.length > 1
      ? {
          index: this.groupIndex + 1,
          total: this.group.length,
          noun: 'reports',
          label: 'reports here',
        }
      : null;
  }

  _detailData(r) {
    const category = LSR_CATEGORIES[r.cat] || LSR_CATEGORIES.other;
    const location = reportLocation(r) || 'Location unavailable';
    const coordinates = reportCoordinates(r);
    const reported = r.valid ? timeFull(r.valid) : (r.validRaw || 'Time unavailable');
    const office = r.wfo ? `NWS ${r.wfo}` : 'Not specified';
    const source = r.source || 'Not specified';
    const remark = r.remark || 'No additional remarks were supplied.';
    const hazards = [
      ['MAGNITUDE', r.magnitude || 'Not specified'],
      ['CATEGORY', category.label],
      ['OFFICE', office],
    ];
    const fields = [
      { label: 'Reported', value: reported },
      { label: 'Report type', value: r.typetext },
      { label: 'Category', value: category.label },
      { label: 'Magnitude', value: r.magnitude || 'Not specified' },
      { label: 'Location', value: location },
      { label: 'Coordinates', value: coordinates || 'Unavailable' },
      { label: 'Source', value: source },
      { label: 'Issuing office', value: office },
      { label: 'Remark', value: remark },
      ...r.extraDetails.map((d) => ({ label: d.label, value: d.value, key: d.key })),
    ];
    return {
      kind: 'storm-report',
      icon: category.icon,
      color: r.color,
      title: r.typeName,
      subtitle: 'Local storm report',
      primaryLabel: 'Reported',
      primary: reported,
      hazardsLabel: 'Report details',
      hazards,
      locationLabel: 'Location',
      location,
      coordinates,
      bodyLabel: 'Remark',
      body: remark,
      meta: [r.source ? `Source: ${r.source}` : '', r.wfo ? `Issued by NWS ${r.wfo}` : '']
        .filter(Boolean)
        .join(' · '),
      tags: [`TYPE: ${r.typetext}`, `CATEGORY: ${category.label.toUpperCase()}`],
      fields,
      sections: [
        { label: 'Location', value: [location, coordinates].filter(Boolean).join('\n') },
        { label: 'Source', value: source },
        { label: 'Issuing office', value: office },
        { label: 'Remark', value: remark },
      ],
      group: this._groupData(),
    };
  }

  openPreview(id, group) {
    const r = this.reportById(id);
    if (!r || !this.els.preview || !this.els.previewCard) return false;
    if (this.detailOpen) this.closeDetail();
    this._closeOtherBriefings();
    this._setGroup(id, group);
    if (!this.selectedId) return false;
    this.els.preview.hidden = false;
    const app = typeof document !== 'undefined' && document.querySelector('.app');
    if (app) app.classList.add('alert-preview-open');
    this.renderPreview();
    return true;
  }

  renderPreview() {
    const r = this.reportById(this.selectedId);
    const card = this.els.previewCard;
    if (!r || !card) {
      this.closePreview();
      return;
    }
    const data = this.previewData(r.id);
    const rows = data.rows
      .map(([label, value]) => `<div class="apv-row"><span>${esc(label)}</span><b>${esc(value)}</b></div>`)
      .join('');
    const remark = data.remark ? `<div class="apv-remark">${esc(data.remark)}</div>` : '';
    const multi = this.group.length > 1;
    const dots = multi
      ? `<div class="apv-dots">${this.group
          .map((_, i) => `<span class="apv-dot${i === this.groupIndex ? ' on' : ''}"></span>`)
          .join('')}</div>`
      : '';
    const nav = multi
      ? `<div class="apv-nav">
           <button class="apv-nav-btn" data-dir="-1" aria-label="Previous report">‹</button>
           <button class="apv-nav-btn" data-dir="1" aria-label="Next report">›</button>
         </div>`
      : '';
    const canBrief = !!(this.els.detail && this.els.detailPanel);
    const footer = nav || canBrief
      ? `<footer class="apv-foot">
           ${nav}
           ${canBrief ? '<button class="apv-details">View full briefing →</button>' : ''}
         </footer>`
      : '';
    card.innerHTML = `
      <header class="apv-head" style="--ac:${r.color}">
        <span class="apv-icon">${data.icon}</span>
        <div class="apv-htext">
          <h3>${esc(data.title)}</h3>
          <span class="apv-area">${esc(data.area)}</span>
        </div>
        <button class="apv-close" aria-label="Close">✕</button>
      </header>
      <div class="apv-body">${rows}${remark}${dots}</div>
      ${footer}`;
    card.querySelector('.apv-close')?.addEventListener('click', () => this.closePreview());
    card.querySelector('.apv-details')?.addEventListener('click', () => {
      this.openDetail(this.selectedId, [...this.group]);
    });
    card.querySelectorAll('.apv-nav-btn')
      .forEach((button) => button.addEventListener('click', () => this.cyclePreview(Number(button.dataset.dir))));
  }

  cyclePreview(delta) {
    if (this.group.length < 2) return;
    this.groupIndex = (this.groupIndex + delta + this.group.length) % this.group.length;
    this.selectedId = this.group[this.groupIndex];
    this.renderPreview();
  }

  closePreview() {
    if (this.els.preview) this.els.preview.hidden = true;
    if (!this.detailOpen) this._clearSelection();
    if (typeof document === 'undefined') return;
    const app = document.querySelector('.app');
    const anotherPreview = document.querySelector('.alert-preview:not([hidden])');
    if (app && !anotherPreview) app.classList.remove('alert-preview-open');
  }

  openDetail(id, group) {
    const r = this.reportById(id);
    if (!r || !this.els.detail || !this.els.detailPanel) return false;
    const ids = group && group.length ? [...group] : [id];
    if (!this.detailOpen) this._closeOtherBriefings();
    this.closePreview();
    this._setGroup(id, ids);
    if (!this.selectedId) return false;
    this.detailOpen = true;
    this._applyReportFeatures();
    this.applyFilter();
    const app = typeof document !== 'undefined' && document.querySelector('.app');
    if (app) {
      app.classList.add('alert-mode');
      app.classList.toggle(
        'alert-split-mode',
        !!document.querySelector('.map-wrap.split')
      );
    }
    this.els.detail.hidden = false;
    this.renderDetail();
    this._fitTo(this.selectedId);
    this._resizeMaps();
    return true;
  }

  _resizeMaps() {
    const resize = () => {
      if (typeof this.els.resizeMaps === 'function') this.els.resizeMaps();
      else if (this.map && this.map.resize) this.map.resize();
      if (this.map && this.map.triggerRepaint) this.map.triggerRepaint();
    };
    if (typeof requestAnimationFrame === 'function')
      requestAnimationFrame(() => requestAnimationFrame(resize));
    else
      setTimeout(resize, 0);
    setTimeout(resize, 180);
  }

  _fitTo(id) {
    const r = this.reportById(id);
    if (!r || !this.map || !this.map.flyTo) return;
    const zoom = this.map.getZoom ? Math.max(this.map.getZoom(), 9) : 9;
    const mobile = typeof window !== 'undefined'
      && window.matchMedia
      && window.matchMedia('(max-width: 759.98px)').matches;
    this.map.flyTo({
      center: [r.lon, r.lat],
      zoom,
      maxDuration: 900,
      ...(mobile ? { offset: [0, -Math.round(window.innerHeight * 0.27)] } : {}),
    });
  }

  cycle(delta) {
    if (this.group.length < 2) return;
    this.groupIndex = (this.groupIndex + delta + this.group.length) % this.group.length;
    this.selectedId = this.group[this.groupIndex];
    this.renderDetail();
    this._applyReportFeatures();
    this.applyFilter();
    this._fitTo(this.selectedId);
  }

  closeDetail() {
    // The detail DOM is shared with alerts and outlook discussions. Only hide
    // it when this controller is the current owner.
    if (!this.detailOpen) return false;
    this.detailOpen = false;
    if (this.els.detail) this.els.detail.hidden = true;
    if (this.els.detailPanel) this.els.detailPanel.innerHTML = '';
    this._clearSelection();
    this._applyReportFeatures();
    this.applyFilter();
    if (typeof document !== 'undefined') {
      const app = document.querySelector('.app');
      if (app) app.classList.remove('alert-mode', 'alert-split-mode');
    }
    this._resizeMaps();
    return true;
  }

  renderDetail() {
    const r = this.reportById(this.selectedId);
    const panel = this.els.detailPanel;
    if (!r || !panel) {
      if (panel) panel.innerHTML = '';
      return;
    }
    const multi = this.group.length > 1;
    const nav = multi
      ? `<div class="alert-nav">
           <button class="alert-nav-btn" data-dir="-1" aria-label="Previous report">‹</button>
           <span class="alert-nav-count">${this.groupIndex + 1} / ${this.group.length} reports here</span>
           <button class="alert-nav-btn" data-dir="1" aria-label="Next report">›</button>
         </div>`
      : '';
    panel.innerHTML = nav + this.sectionHTML(r, true);
    panel.scrollTop = 0;
    panel.querySelectorAll('.alert-nav-btn')
      .forEach((button) => button.addEventListener('click', () => this.cycle(Number(button.dataset.dir))));
  }

  sectionHTML(report, selected = false) {
    const r = typeof report === 'string' ? this.reportById(report) : report;
    if (!r) return '';
    const d = this._detailData(r);
    const hazards = d.hazards
      .map(([label, value]) => `<div class="hz"><span>${esc(label)}</span><b>${esc(value)}</b></div>`)
      .join('');
    const location = [d.location, d.coordinates].filter(Boolean).join('\n');
    const extra = r.extraDetails.length
      ? `<div class="alert-block"><span class="alert-title">ADDITIONAL DETAILS</span>${r.extraDetails
          .map((item) => `<p><b>${esc(item.label)}:</b> ${esc(item.value)}</p>`)
          .join('')}</div>`
      : '';
    const remarkParagraphs = esc(d.body).replace(/\n+/g, '</p><p>');
    const tags = d.tags
      .map((tag, i) => `<span class="alert-tag${i === 0 ? ' strong' : ''}">${esc(tag)}</span>`)
      .join('');
    return `
      <section class="alert-sec${selected ? ' selected' : ''}" data-id="${escAttr(r.id)}">
        <header class="alert-sec-head" style="--ac:${r.color}">
          <span class="alert-sec-icon">${d.icon}</span>
          <h3>${esc(r.typeName)}</h3>
        </header>
        <div class="alert-sec-body">
          <div class="alert-expires">
            <span class="alert-title">REPORTED</span>
            <b>${esc(d.primary)}</b>
          </div>
          <div class="alert-hazards">${hazards}</div>
          <div class="alert-issued">Local storm report${r.wfo ? ` · NWS ${esc(r.wfo)}` : ''}</div>
          <div class="alert-loc"><span class="alert-title">LOCATION</span><p>${esc(location)}</p></div>
          <div class="alert-loc"><span class="alert-title">REPORTER / SOURCE</span><p>${esc(r.source || 'Not specified')}</p></div>
          <div class="alert-loc"><span class="alert-title">ISSUING OFFICE</span><p>${esc(r.wfo ? `NWS ${r.wfo}` : 'Not specified')}</p></div>
          <div class="alert-block"><span class="alert-title">REMARK</span><p>${remarkParagraphs}</p></div>
          ${extra}
          <div class="alert-tags"><span class="alert-title">REPORT TAGS</span><div class="alert-tag-row">${tags}</div></div>
        </div>
      </section>`;
  }

  exportPreview() {
    if (!this._previewOpen() || !this.selectedId) return null;
    const data = this.previewData(this.selectedId);
    return data ? { ...data, group: this._groupData() } : null;
  }

  exportDetail() {
    if (!this.detailOpen || !this.selectedId) return null;
    const r = this.reportById(this.selectedId);
    return r ? this._detailData(r) : null;
  }
}
