// buoys.js — NDBC marine observations (buoys + C-MAN stations) as a canvas
// station-plot overlay, mirroring the METAR layer in metars.js: same lifecycle
// (toggle → canvas glued to the map → view-culled, thinned, capped plots), the
// same theme-aware ink, the same Settings-docked controls panel. What differs
// is the payload — waves and water temperature instead of ceilings and flight
// categories — and that every plot is tappable for the station's full report.
//
// Two CORS-enabled NOAA sources, each used for what it is actually good at:
//
//   1. IOOS Sensors ERDDAP (erddap.sensors.ioos.us) — hosts one dataset per
//      NDBC station (`gov-ndbc-<id>`). `allDatasets` gives the whole catalogue
//      in a single 45 KB request: exact positions, station names and each
//      station's newest observation time, which is what decides who gets
//      plotted. Per-station queries then return the FULL buoy report — the
//      wave spectrum summary (significant height, dominant + mean period,
//      direction), the swell / wind-wave partitions, water temperature and the
//      standard met set. That's the "tap for more details" payload, and it is
//      also used to progressively enrich a zoomed-in view.
//
//   2. The NWS surface-observation map service (mapservices.weather.noaa.gov,
//      `obs/surface_obs` MARITIME rows) — one bbox query returns the latest GTS
//      marine reports for a whole view at once. It is a cheap pre-fill, not the
//      backbone: how much of the network it is carrying swings wildly from hour
//      to hour (150 stations globally one hour, a dozen the next), it has no
//      wave periods, and its positions are rounded to 0.1° — so the catalogue's
//      coordinates always win and the per-station reports above overwrite it.
//
// NDBC's own latest_obs feed is deliberately NOT used: www.ndbc.noaa.gov sends
// no access-control-allow-origin header at all, so a browser cannot read it.

import {
  num, clamp, cToF, fToC, text, haloStroke, drawWindBarb, escapeHtml,
} from './stationPlot.js';

const ERDDAP = 'https://erddap.sensors.ioos.us/erddap/tabledap';
const MARITIME_URL =
  'https://mapservices.weather.noaa.gov/vector/rest/services/obs/surface_obs/MapServer/60/query';
const NDBC_STATION_PAGE = 'https://www.ndbc.noaa.gov/station_page.php?station=';

const REFRESH_MS = 5 * 60 * 1000;
// Buoys report every 10–60 minutes and many only make the GTS hourly, so the
// window that counts as "current" is wider than the METAR layer's.
const MAX_AGE_MIN = 240;
// The station catalogue changes when buoys are deployed or recovered — hours,
// not minutes. Re-listed on this interval; its `maxTime` freshness column is
// what keeps recovered/dead buoys off the map.
const CATALOG_TTL_MS = 60 * 60 * 1000;
// Full per-station reports are cached this long before a re-tap refetches.
const DETAIL_TTL_MS = 10 * 60 * 1000;
const DETAIL_HOURS = 3;

const LIMIT_STORAGE_KEY = 'rn.buoys.maxStations';
const LIMIT_CHOICES = [25, 50, 100, 150, 200];
const DEFAULT_LIMIT = 50;
const SIZE_STORAGE_KEY = 'rn.buoys.plotSize';
const SIZE_CHOICES = [0.7, 0.85, 1, 1.25, 1.5, 1.8];
const DEFAULT_SIZE = 1;

// Keep plots out of the top HUD strip (breadcrumb / clock / legend).
const TOP_UI_INSET = 64;

// Plotted stations are filled in from ERDDAP nearest-the-centre first, a few
// requests at a time, so the map paints values quickly and keeps filling
// outwards instead of firing one request per buoy on screen at once. Bounded
// to DETAIL_QUEUE_MAX stations per settled view; everything is cached for
// DETAIL_TTL_MS, so panning back over loaded water costs nothing.
const DETAIL_QUEUE_MAX = 30;
const DETAIL_CONCURRENCY = 5;
const DETAIL_QUEUE_DELAY_MS = 400;

const M_TO_FT = 3.280839895;
const MS_TO_KT = 1.9438445;
const KT_TO_MPH = 1.1507794;

// Theme-aware plot palettes, matching the METAR layer's two themes.
const PLOT_THEMES = {
  dark: {
    halo: 'rgba(10, 14, 19, 0.92)',
    ink: '#e8eef4',
    barb: '#c7d8e5',
    dim: '#93a1b0',
    wave: '#5ec8f0',
    period: '#8fd8ff',
    temp: '#ef4b3f',
    sst: '#ffd166',
    noData: '#5f6d7b',
    ring: 'rgba(232, 238, 244, 0.85)',
  },
  light: {
    halo: 'rgba(255, 255, 255, 0.94)',
    ink: '#0f1720',
    barb: '#344657',
    dim: '#5b6876',
    wave: '#1668a8',
    period: '#2f7fb8',
    temp: '#d93c33',
    sst: '#a86a00',
    noData: '#8190a0',
    ring: 'rgba(15, 23, 32, 0.75)',
  },
};

// Water-temperature colour ramp (°C → RGB). Cold ocean through to bathwater;
// deliberately distinct from the app's air-temperature scales so an SST-filled
// buoy dot never reads as a METAR flight category.
const SST_STOPS = [
  [-2, [40, 30, 110]], [2, [30, 70, 175]], [6, [35, 125, 205]],
  [10, [50, 170, 205]], [14, [60, 190, 160]], [18, [110, 200, 105]],
  [22, [225, 205, 70]], [26, [240, 150, 55]], [30, [225, 75, 55]],
  [34, [155, 25, 45]],
];

export function sstColor(c) {
  if (c == null || Number.isNaN(c)) return null;
  const stops = SST_STOPS;
  if (c <= stops[0][0]) return rgb(stops[0][1]);
  if (c >= stops[stops.length - 1][0]) return rgb(stops[stops.length - 1][1]);
  for (let i = 1; i < stops.length; i++) {
    if (c > stops[i][0]) continue;
    const [v0, c0] = stops[i - 1];
    const [v1, c1] = stops[i];
    const f = (c - v0) / (v1 - v0);
    return rgb([0, 1, 2].map((k) => Math.round(c0[k] + (c1[k] - c0[k]) * f)));
  }
  return rgb(stops[stops.length - 1][1]);
}

const rgb = (c) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

export function compassPoint(deg) {
  const d = num(deg);
  if (d == null) return '';
  return COMPASS[Math.round((((d % 360) + 360) % 360) / 22.5) % 16];
}

function inLngRange(lng, west, east) {
  if (west <= east) return lng >= west && lng <= east;
  return lng >= west || lng <= east;
}

function loadChoice(key, choices, fallback) {
  try {
    const saved = Number(localStorage.getItem(key));
    return choices.includes(saved) ? saved : fallback;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Station catalogue (IOOS Sensors ERDDAP)
// ---------------------------------------------------------------------------

// ERDDAP dataset titles read "41008 (LLNR 833) - GRAYS REEF - 40 NM Southeast
// of Savannah, GA". Drop the leading id and the light-list number, keep the
// human description.
export function catalogName(title, id) {
  let s = String(title || '').trim();
  if (s.toUpperCase().startsWith(String(id).toUpperCase())) s = s.slice(id.length).trim();
  s = s.replace(/^\(LLNR[^)]*\)/i, '').trim();
  s = s.replace(/^[-–—:]\s*/, '').trim();
  return s;
}

// allDatasets rows → the station catalogue. DART tsunami buoys are excluded:
// they carry no met/wave data, so they would only ever plot as empty dots.
export function parseCatalog(table, now = Date.now()) {
  const cols = (table && table.columnNames) || [];
  const idx = (name) => cols.indexOf(name);
  const iId = idx('datasetID');
  const iLon = idx('minLongitude');
  const iLat = idx('minLatitude');
  const iTitle = idx('title');
  const iMax = idx('maxTime');
  const out = [];
  for (const row of (table && table.rows) || []) {
    const datasetId = String(row[iId] || '');
    if (!datasetId.startsWith('gov-ndbc-') || datasetId.includes('-dart-')) continue;
    const id = datasetId.slice('gov-ndbc-'.length).toUpperCase();
    const lat = num(row[iLat]);
    const lon = num(row[iLon]);
    if (!id || lat == null || lon == null) continue;
    const lastAt = Date.parse(row[iMax] || '');
    // Recovered / dead stations: no report inside the age window, no plot.
    if (!Number.isFinite(lastAt) || now - lastAt > MAX_AGE_MIN * 60000) continue;
    out.push({ id, lat, lon, name: catalogName(row[iTitle], id), lastAt });
  }
  return out;
}

async function fetchCatalog() {
  const constraint = encodeURIComponent('datasetID=~"gov-ndbc-.*"');
  const url = `${ERDDAP}/allDatasets.json?datasetID,minLongitude,minLatitude,title,maxTime&${constraint}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`buoy catalogue returned HTTP ${res.status}`);
  const json = await res.json();
  return parseCatalog(json && json.table);
}

// ---------------------------------------------------------------------------
// Bulk latest values (NWS surface_obs, MARITIME rows)
// ---------------------------------------------------------------------------

const MARITIME_FIELDS = [
  'stationname', 'timeobs', 'temperature', 'dewpoint', 'winddir', 'windspeed',
  'windgust', 'sealevelpress', 'preschange', 'visibility', 'sst', 'waveheight',
].join(',');

// One ESRI feature → the internal observation record. The service reports
// imperial (°F, kt, ft, mb); everything is stored in SI + knots so the two
// sources are interchangeable downstream.
export function normalizeMaritime(feature, now = Date.now()) {
  const a = (feature && feature.attributes) || {};
  const id = String(a.stationname || '').trim().toUpperCase();
  if (!id) return null;
  const at = num(a.timeobs);
  if (at != null && (now - at > MAX_AGE_MIN * 60000 || now - at < -30 * 60000)) return null;
  const geom = feature.geometry || {};
  return {
    id,
    lat: num(geom.y),
    lon: num(geom.x),
    ob: {
      source: 'gts',
      at: at != null ? at : null,
      tempC: fToC(num(a.temperature)),
      dewpC: fToC(num(a.dewpoint)),
      sstC: fToC(num(a.sst)),
      windDir: num(a.winddir),
      windKt: num(a.windspeed),
      gustKt: num(a.windgust),
      presHpa: num(a.sealevelpress),
      presChange3h: num(a.preschange),
      visMi: num(a.visibility),
      waveHtM: num(a.waveheight) == null ? null : num(a.waveheight) / M_TO_FT,
    },
  };
}

async function fetchMaritime(box) {
  const [w, s, e, n] = box;
  const params = new URLSearchParams({
    where: "tblname='MARITIME'",
    geometry: `${w},${s},${e},${n}`,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: MARITIME_FIELDS,
    returnGeometry: 'true',
    outSR: '4326',
    resultRecordCount: '2000',
    f: 'json',
  });
  const res = await fetch(`${MARITIME_URL}?${params}`);
  if (!res.ok) throw new Error(`marine obs returned HTTP ${res.status}`);
  const json = await res.json();
  if (json && json.error) throw new Error(json.error.message || 'marine obs query failed');
  const out = [];
  for (const f of (json && json.features) || []) {
    const rec = normalizeMaritime(f);
    if (rec) out.push(rec);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Full per-station report (IOOS Sensors ERDDAP)
// ---------------------------------------------------------------------------

// ERDDAP variable → internal field, with the unit conversion each needs. Only
// the variables a station actually publishes come back, so every one of these
// is optional.
const ERDDAP_FIELDS = {
  air_temperature: ['tempC', (v) => v],
  dew_point_temperature: ['dewpC', (v) => v],
  sea_surface_temperature: ['sstC', (v) => v],
  air_pressure_at_mean_sea_level: ['presHpa', (v) => v],
  wind_speed: ['windKt', (v) => v * MS_TO_KT],
  wind_speed_of_gust: ['gustKt', (v) => v * MS_TO_KT],
  wind_from_direction: ['windDir', (v) => v],
  sea_surface_wave_significant_height: ['waveHtM', (v) => v],
  sea_surface_wave_from_direction: ['waveDir', (v) => v],
  sea_surface_wave_mean_period: ['waveMeanS', (v) => v],
  sea_surface_wave_period_at_variance_spectral_density_maximum: ['wavePeakS', (v) => v],
  sea_surface_swell_wave_significant_height: ['swellHtM', (v) => v],
  sea_surface_swell_wave_period: ['swellPeriodS', (v) => v],
  sea_surface_swell_wave_from_direction: ['swellDir', (v) => v],
  sea_surface_wind_wave_significant_height: ['windWaveHtM', (v) => v],
  sea_surface_wind_wave_period: ['windWavePeriodS', (v) => v],
  sea_surface_wind_wave_from_direction: ['windWaveDir', (v) => v],
};

// An ERDDAP table → one observation record built from the newest row that
// carries each variable. Buoys interleave reports (the wave payload and the met
// payload often land in separate rows a few minutes apart), so taking only the
// last row would blank out half the report.
export function normalizeErddap(table) {
  const cols = (table && table.columnNames) || [];
  const rows = (table && table.rows) || [];
  if (!rows.length) return null;
  const ob = { source: 'ndbc', at: null };
  const iTime = cols.indexOf('time');
  let filled = 0;
  for (let r = rows.length - 1; r >= 0; r--) {
    const row = rows[r];
    const at = Date.parse(row[iTime] || '');
    for (let c = 0; c < cols.length; c++) {
      const map = ERDDAP_FIELDS[cols[c]];
      if (!map) continue;
      const [field, convert] = map;
      if (ob[field] != null) continue; // a newer row already supplied it
      const v = num(row[c]);
      if (v == null) continue;
      ob[field] = convert(v);
      filled++;
      if (Number.isFinite(at) && (ob.at == null || at > ob.at)) ob.at = at;
    }
  }
  return filled ? ob : null;
}

async function fetchDetail(id) {
  const url = `${ERDDAP}/gov-ndbc-${encodeURIComponent(String(id).toLowerCase())}.json` +
    `?&time%3E=now-${DETAIL_HOURS}hours`;
  const res = await fetch(url);
  // 404 is ERDDAP's "no rows matched" as well as "no such dataset"; both mean
  // there is nothing more to show for this station right now.
  if (!res.ok) throw new Error(`station report returned HTTP ${res.status}`);
  const json = await res.json();
  return normalizeErddap(json && json.table);
}

// ---------------------------------------------------------------------------
// Formatting helpers (shared by the plots, the tooltip and the detail card)
// ---------------------------------------------------------------------------

const fmtF = (c) => (c == null ? null : `${Math.round(cToF(c))}°F`);
const fmtFt = (m) => (m == null ? null : `${(m * M_TO_FT).toFixed(m * M_TO_FT < 10 ? 1 : 0)} ft`);
const fmtSec = (s) => (s == null ? null : `${Math.round(s)} s`);

function fmtAge(at) {
  if (!at) return '';
  const mins = Math.max(0, Math.round((Date.now() - at) / 60000));
  if (mins < 60) return `${mins} min ago`;
  const h = Math.floor(mins / 60);
  return `${h}h ${mins % 60}m ago`;
}

function fmtUtc(at) {
  if (!at) return '';
  const d = new Date(at);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}Z`;
}

function fmtWind(ob) {
  if (!ob || ob.windKt == null) return null;
  if (ob.windKt < 1) return 'calm';
  const dir = ob.windDir == null
    ? ''
    : `${compassPoint(ob.windDir)} ${String(Math.round(ob.windDir)).padStart(3, '0')}° `;
  const gust = ob.gustKt ? ` G${Math.round(ob.gustKt)}` : '';
  return `${dir}${Math.round(ob.windKt)}${gust} kt (${Math.round(ob.windKt * KT_TO_MPH)} mph)`;
}

// "4.9 ft @ 9 s from SSE (160°)" for whichever of the three wave trains is asked.
function fmtWaveTrain(ht, period, dir) {
  const bits = [];
  if (ht != null) bits.push(fmtFt(ht));
  if (period != null) bits.push(`@ ${fmtSec(period)}`);
  if (dir != null) bits.push(`from ${compassPoint(dir)} (${Math.round(dir)}°)`);
  return bits.length ? bits.join(' ') : null;
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export class BuoyController {
  constructor(map, opts = {}) {
    this.map = map;
    // Optional Settings host for the controls panel (falls back to floating
    // over the map, exactly like the METAR panel).
    this.panelHost = opts.panelHost || null;
    // Called before a map click is treated as a buoy tap: lets the app keep
    // buoy cards from opening while a click-consuming tool is armed.
    this.blockClicks = opts.blockClicks || (() => false);
    this.enabled = false;
    this.maxStations = loadChoice(LIMIT_STORAGE_KEY, LIMIT_CHOICES, DEFAULT_LIMIT);
    this.sizeScale = loadChoice(SIZE_STORAGE_KEY, SIZE_CHOICES, DEFAULT_SIZE);
    this.canvas = null;
    this.ctx = null;
    this.panel = null;
    this.tooltip = null;
    this.card = null;
    this.selectedId = null;
    this.drawn = [];

    this._stations = new Map(); // id -> { id, lat, lon, name, ob, detail state }
    this._catalogAt = 0;
    this._maritimeAt = 0;
    this._loading = 0;
    this._detailInflight = new Set();
    this._detailQueue = [];
    this._detailWorkers = 0;
    this._timer = null;
    this._moveT = null;
    this._raf = null;
    this._anchor = null;

    this._scheduleRender = () => this.scheduleRender();
    this._onMove = () => this.trackMove();
    this._moveend = () => {
      if (!this.enabled) return;
      this.scheduleRender();
      clearTimeout(this._moveT);
      this._moveT = setTimeout(() => this.maybeFetch(), 350);
    };
    this._mousemove = (e) => this.handleMouseMove(e);
    this._mouseleave = () => this.hideTooltip();
    // Tap/click handling runs in the capture phase on the map container so a
    // hit on a buoy can be swallowed before Mapbox dispatches it — otherwise
    // the same tap would also open an alert briefing or an outlook popup
    // underneath the card. Movement between pointerdown and click is measured
    // here so the click that ends a pan never counts as a tap.
    this._pointerdown = (e) => {
      this._down = { x: e.clientX, y: e.clientY, t: performance.now() };
    };
    this._click = (e) => this.handleClick(e);
    this._keydown = (e) => {
      if (e.key === 'Escape' && this.card && !this.card.hidden) this.closeCard();
    };

    map.on('move', this._onMove);
    map.on('resize', this._scheduleRender);
    map.on('rotate', this._scheduleRender);
    map.on('moveend', this._moveend);
  }

  setEnabled(on) {
    this.enabled = on;
    if (on) {
      this.ensureOverlay();
      this.ensurePanel();
      this.maybeFetch();
      this._timer = setInterval(() => this.enabled && this.maybeFetch(), REFRESH_MS);
      this.scheduleRender();
    } else {
      clearInterval(this._timer);
      this._timer = null;
      clearTimeout(this._moveT);
      clearTimeout(this._queueT);
      this._detailQueue = [];
      this.hideOverlay();
      this.hidePanel();
      this.hideTooltip();
      this.closeCard();
      this.drawn = [];
    }
    return this.enabled;
  }

  // The view as one or two wrapped [w,s,e,n] boxes (two when it crosses the
  // antimeridian), padded so ordinary panning stays covered.
  _viewBoxes(pad = 1) {
    const b = this.map.getBounds();
    const s = clamp(b.getSouth() - pad, -85, 85);
    const n = clamp(b.getNorth() + pad, -85, 85);
    if (b.getEast() - b.getWest() >= 360) return [[-180, s, 180, n]];
    const wrap = (x) => ((((x + 180) % 360) + 360) % 360) - 180;
    const w = wrap(b.getWest() - pad);
    const e = wrap(b.getEast() + pad);
    if (w <= e) return [[w, s, e, n]];
    return [[w, s, 180, n], [-180, s, e, n]];
  }

  async maybeFetch() {
    if (!this.enabled) return;
    const now = Date.now();
    const jobs = [];
    if (now - this._catalogAt > CATALOG_TTL_MS) jobs.push(this._loadCatalog());
    if (now - this._maritimeAt > REFRESH_MS - 15000) jobs.push(this._loadMaritime());
    if (!jobs.length) {
      this.scheduleRender();
      return;
    }
    this._loading++;
    if (this.onStatus && !this._stations.size) this.onStatus('loading buoy observations');
    try {
      const settled = await Promise.allSettled(jobs);
      if (!this.enabled) return;
      if (settled.every((r) => r.status === 'rejected')) throw settled[0].reason;
      this.scheduleRender();
    } catch (err) {
      console.error('buoy load failed', err);
      if (this.onStatus) this.onStatus('buoy data unavailable');
    } finally {
      this._loading--;
    }
  }

  async _loadCatalog() {
    const stations = await fetchCatalog();
    if (!this.enabled) return;
    this._catalogAt = Date.now();
    const seen = new Set();
    for (const st of stations) {
      seen.add(st.id);
      const prev = this._stations.get(st.id);
      if (prev) {
        prev.lat = st.lat;
        prev.lon = st.lon;
        prev.name = st.name || prev.name;
        prev.lastAt = st.lastAt;
        prev.catalogued = true;
      } else {
        this._stations.set(st.id, { ...st, catalogued: true, ob: null });
      }
    }
    // Drop catalogued stations that have gone quiet; keep GTS-only ones (they
    // are aged out by their own observation time in _loadMaritime).
    for (const [id, st] of this._stations) {
      if (st.catalogued && !seen.has(id)) this._stations.delete(id);
    }
  }

  async _loadMaritime() {
    const boxes = this._viewBoxes();
    const settled = await Promise.allSettled(boxes.map((b) => fetchMaritime(b)));
    if (!this.enabled) return;
    if (settled.every((r) => r.status === 'rejected')) throw settled[0].reason;
    this._maritimeAt = Date.now();
    for (const result of settled) {
      if (result.status !== 'fulfilled') continue;
      for (const rec of result.value) this._mergeObservation(rec);
    }
    const cutoff = Date.now() - MAX_AGE_MIN * 60000;
    for (const [id, st] of this._stations) {
      if (st.catalogued) continue;
      if (!st.ob || !st.ob.at || st.ob.at < cutoff) this._stations.delete(id);
    }
  }

  // Merge one bulk record. Positions from the catalogue win (the map service
  // rounds to 0.1°); a full ERDDAP report already held for the station wins
  // over the GTS row unless the GTS row is newer.
  _mergeObservation(rec) {
    let st = this._stations.get(rec.id);
    if (!st) {
      // Not in the NDBC catalogue: ships and other GTS marine platforms report
      // through the same service. Only keep station-shaped ids (5-digit WMO
      // buoys, 5-character C-MAN) so the layer stays a buoy layer.
      if (!/^\d{5}$/.test(rec.id) && !/^[A-Z]{4}\d$/.test(rec.id)) return;
      if (rec.lat == null || rec.lon == null) return;
      st = { id: rec.id, lat: rec.lat, lon: rec.lon, name: '', catalogued: false, ob: null };
      this._stations.set(rec.id, st);
    }
    const prev = st.ob;
    if (prev && prev.source === 'ndbc' && (prev.at || 0) >= (rec.ob.at || 0)) return;
    st.ob = rec.ob;
  }

  // Queue the plotted stations that still need their full report, nearest the
  // centre of the view outwards, and keep a small pool of workers draining the
  // queue. This is what puts values on the map: the bulk GTS feed only carries
  // a fraction of the network (and how large a fraction swings hour to hour),
  // so the per-station reports are the layer's real source.
  //
  // Called (debounced) after every render, so the queue is always rebuilt from
  // what is actually on screen — panning away abandons the stations that left
  // the view instead of finishing a stale list, and everything already fetched
  // is skipped for DETAIL_TTL_MS.
  _queueDetails() {
    if (!this.enabled) return;
    const now = Date.now();
    const cx = this.canvas ? this.canvas.clientWidth / 2 : 0;
    const cy = this.canvas ? this.canvas.clientHeight / 2 : 0;
    this._detailQueue = this.drawn
      .filter((item) => !item.station.noDetail
        && now - (item.station.detailAt || 0) > DETAIL_TTL_MS
        && !this._detailInflight.has(item.station.id))
      .sort((a, b) => ((a.x - cx) ** 2 + (a.y - cy) ** 2) - ((b.x - cx) ** 2 + (b.y - cy) ** 2))
      .slice(0, DETAIL_QUEUE_MAX)
      .map((item) => item.station);
    if (!this._detailQueue.length) return;

    const worker = async () => {
      this._detailWorkers++;
      try {
        while (this.enabled && this._detailQueue.length) {
          await this.loadDetail(this._detailQueue.shift());
        }
      } finally {
        this._detailWorkers--;
      }
    };
    while (this._detailWorkers < DETAIL_CONCURRENCY
      && this._detailWorkers < this._detailQueue.length) worker();
  }

  // Rebuild the fetch queue once the view has settled, rather than on every
  // one of the redraws a pan fires.
  _scheduleDetailQueue() {
    clearTimeout(this._queueT);
    this._queueT = setTimeout(() => this._queueDetails(), DETAIL_QUEUE_DELAY_MS);
  }

  // Fetch (and cache) one station's full report. Resolves when the station's
  // record has been updated, so callers can re-render.
  async loadDetail(station, force = false) {
    if (!station || this._detailInflight.has(station.id)) return;
    const now = Date.now();
    if (!force && (station.noDetail || now - (station.detailAt || 0) < DETAIL_TTL_MS)) return;
    this._detailInflight.add(station.id);
    station.detailPending = true;
    this.refreshCard(station);
    try {
      const ob = await fetchDetail(station.id);
      station.detailAt = Date.now();
      station.detailError = null;
      if (ob) {
        // The bulk GTS row can be newer than ERDDAP's newest; keep whichever
        // fields the full report doesn't carry rather than losing them.
        station.ob = station.ob && station.ob.source === 'gts'
          ? { ...station.ob, ...ob }
          : ob;
      } else {
        station.noDetail = true;
      }
    } catch (err) {
      station.detailError = err;
      // Back off on failure the same way a success is cached, so a station that
      // errors can't be retried on every redraw.
      station.detailAt = Date.now();
      // A station with no ERDDAP dataset never will have one; stop asking.
      if (/HTTP 404/.test(String(err && err.message))) station.noDetail = true;
    } finally {
      this._detailInflight.delete(station.id);
      station.detailPending = false;
      this.refreshCard(station);
      this.scheduleRender();
    }
  }

  // -------------------------------------------------------------------------
  // Overlay + panel plumbing (mirrors MetarController)
  // -------------------------------------------------------------------------

  ensureOverlay() {
    if (!this.canvas) {
      const container = this.map.getContainer();
      this.canvas = document.createElement('canvas');
      this.canvas.className = 'buoy-canvas';
      this.ctx = this.canvas.getContext('2d');
      container.appendChild(this.canvas);
      container.addEventListener('mousemove', this._mousemove);
      container.addEventListener('mouseleave', this._mouseleave);
      container.addEventListener('pointerdown', this._pointerdown, true);
      container.addEventListener('click', this._click, true);
      document.addEventListener('keydown', this._keydown);
    }
    this.canvas.hidden = false;
  }

  hideOverlay() {
    if (!this.canvas) return;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.canvas.style.transform = '';
    this.canvas.style.transformOrigin = '';
    this._anchor = null;
    this.canvas.hidden = true;
  }

  ensurePanel() {
    if (!this.panel) {
      const host = this.panelHost || this.map.getContainer();
      this.panel = document.createElement('div');
      this.panel.className = this.panelHost ? 'buoy-panel buoy-panel--docked' : 'buoy-panel';
      this.panel.innerHTML = `
        <div class="buoy-panel-row">
          <span>Buoys</span>
          <select class="buoy-limit" aria-label="Buoy station limit">
            ${LIMIT_CHOICES.map((n) => `<option value="${n}">${n}</option>`).join('')}
          </select>
        </div>
        <div class="buoy-panel-row">
          <span>Size</span>
          <select class="buoy-size" aria-label="Buoy plot size">
            ${SIZE_CHOICES.map((n) => `<option value="${n}">${Math.round(n * 100)}%</option>`).join('')}
          </select>
        </div>
        <div class="buoy-panel-key">
          <span>Water temp</span>
          <i class="buoy-key-ramp"></i>
          <span class="buoy-key-ends">40°F&nbsp;·&nbsp;90°F</span>
        </div>
        <div class="buoy-panel-count"></div>
      `;
      const limitSel = this.panel.querySelector('.buoy-limit');
      limitSel.value = String(this.maxStations);
      limitSel.addEventListener('change', (e) => {
        this.maxStations = Number(e.target.value) || DEFAULT_LIMIT;
        try { localStorage.setItem(LIMIT_STORAGE_KEY, String(this.maxStations)); } catch {}
        this.scheduleRender();
      });
      const sizeSel = this.panel.querySelector('.buoy-size');
      sizeSel.value = String(this.sizeScale);
      sizeSel.addEventListener('change', (e) => {
        this.sizeScale = Number(e.target.value) || DEFAULT_SIZE;
        try { localStorage.setItem(SIZE_STORAGE_KEY, String(this.sizeScale)); } catch {}
        this.scheduleRender();
      });
      const ramp = this.panel.querySelector('.buoy-key-ramp');
      if (ramp) {
        const stops = [4, 10, 16, 21, 27, 32].map((c) => sstColor(c)).join(', ');
        ramp.style.background = `linear-gradient(90deg, ${stops})`;
      }
      host.appendChild(this.panel);
    }
    this.panel.hidden = false;
    if (this.panelHost) this.panelHost.hidden = false;
  }

  hidePanel() {
    if (this.panel) this.panel.hidden = true;
    if (this.panelHost) this.panelHost.hidden = true;
  }

  scheduleRender() {
    if (!this.enabled || !this.canvas) return;
    cancelAnimationFrame(this._raf);
    this._raf = requestAnimationFrame(() => this.render());
  }

  // Glue the canvas to the map with a CSS transform during pan/zoom, with a
  // full redraw at most every 150 ms (same approach as the METAR overlay).
  trackMove() {
    if (!this.enabled || !this.canvas || this.canvas.hidden) return;
    if (this.card && !this.card.hidden) this.positionCard();
    const a = this._anchor;
    if (!a) {
      this.scheduleRender();
      return;
    }
    const pt = this.map.project(a.lngLat);
    const ds = Math.pow(2, this.map.getZoom() - a.zoom);
    this.canvas.style.transformOrigin = `${a.pt.x}px ${a.pt.y}px`;
    this.canvas.style.transform = `translate(${pt.x - a.pt.x}px, ${pt.y - a.pt.y}px) scale(${ds})`;
    if (performance.now() - (this._lastFull || 0) > 150) this.scheduleRender();
  }

  resizeCanvas() {
    const container = this.map.getContainer();
    const dpr = window.devicePixelRatio || 1;
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.canvas.style.width = `${w}px`;
      this.canvas.style.height = `${h}px`;
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w, h };
  }

  render() {
    if (!this.enabled || !this.canvas || !this.ctx) return;
    const { w, h } = this.resizeCanvas();
    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);

    this._lastFull = performance.now();
    const c = this.map.getCenter();
    this._anchor = {
      lngLat: [c.lng, c.lat],
      pt: this.map.project([c.lng, c.lat]),
      zoom: this.map.getZoom(),
    };
    this.canvas.style.transform = '';
    this.canvas.style.transformOrigin = '';

    const theme = activeTheme();
    const zoom = this.map.getZoom();
    const selected = this.selectVisible(w, h);
    this.drawn = selected;
    for (const item of selected) {
      drawBuoyPlot(ctx, item.station, item.x, item.y, zoom, theme, this.sizeScale,
        item.station.id === this.selectedId);
    }

    const count = this.panel?.querySelector('.buoy-panel-count');
    if (count) {
      const total = this._visibleCount || 0;
      count.textContent = this._loading && !total ? 'loading…' : `${selected.length}/${total} shown`;
    }
    if (this.onStatus && this._stations.size) {
      const capped = selected.length >= this.maxStations ? `, capped at ${this.maxStations}` : '';
      this.onStatus(`${selected.length}/${this._visibleCount || selected.length} buoys${capped}`);
    }
    if (this.card && !this.card.hidden) this.positionCard();
    this._scheduleDetailQueue();
  }

  selectVisible(w, h) {
    if (!this._stations.size) {
      this._visibleCount = 0;
      return [];
    }
    const bounds = this.map.getBounds();
    const west = bounds.getWest();
    const east = bounds.getEast();
    const south = bounds.getSouth();
    const north = bounds.getNorth();
    const zoom = this.map.getZoom();
    const cell = clamp(108 - zoom * 4, 58, 92);
    const margin = 74;
    const grid = new Map();
    let visible = 0;
    const containerRect = this.map.getContainer().getBoundingClientRect();
    const uiRects = Array.from(document.querySelectorAll(
      '.map-hud > *, .legend:not([hidden]), .mobile-topbar:not([hidden]), .map-tools:not([hidden])'
    )).map((node) => {
      const r = node.getBoundingClientRect();
      return {
        left: r.left - containerRect.left - 42,
        right: r.right - containerRect.left + 42,
        top: r.top - containerRect.top - 42,
        bottom: r.bottom - containerRect.top + 42,
      };
    }).filter((r) => r.right > 0 && r.left < w && r.bottom > 0 && r.top < h);

    for (const st of this._stations.values()) {
      if (st.lat < south || st.lat > north || !inLngRange(st.lon, west, east)) continue;
      const pt = this.map.project([st.lon, st.lat]);
      if (pt.x < -margin || pt.y < -margin || pt.x > w + margin || pt.y > h + margin) continue;
      if (pt.y < TOP_UI_INSET) continue;
      if (uiRects.some((r) => pt.x >= r.left && pt.x <= r.right && pt.y >= r.top && pt.y <= r.bottom)) continue;
      visible++;
      const gx = Math.floor(pt.x / cell);
      const gy = Math.floor(pt.y / cell);
      const key = `${gx}:${gy}`;
      const cellCx = gx * cell + cell / 2;
      const cellCy = gy * cell + cell / 2;
      // Stations with an observation beat empty ones for a crowded cell, and
      // the tapped station always survives thinning so its card keeps a plot.
      const score = (pt.x - cellCx) ** 2 + (pt.y - cellCy) ** 2
        + (st.ob ? 0 : 4000) + (st.id === this.selectedId ? -100000 : 0);
      const prev = grid.get(key);
      if (!prev || score < prev.score) grid.set(key, { station: st, x: pt.x, y: pt.y, score });
    }

    this._visibleCount = visible;
    let selected = Array.from(grid.values());
    if (selected.length > this.maxStations) {
      const cx = w / 2;
      const cy = h / 2;
      selected = selected
        .map((item) => ({ ...item, centerScore: (item.x - cx) ** 2 + (item.y - cy) ** 2 + item.score }))
        .sort((a, b) => a.centerScore - b.centerScore)
        .slice(0, this.maxStations);
    }
    return selected;
  }

  // -------------------------------------------------------------------------
  // Hover tooltip + tap card
  // -------------------------------------------------------------------------

  hitTest(x, y, radius = 30) {
    let hit = null;
    let best = radius * radius;
    for (const item of this.drawn) {
      const dx = item.x - x;
      const dy = item.y - y;
      const d = dx * dx + dy * dy;
      if (d < best) {
        best = d;
        hit = item;
      }
    }
    return hit;
  }

  _containerPoint(e) {
    const rect = this.map.getContainer().getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  handleMouseMove(e) {
    if (!this.enabled || !this.drawn.length) return;
    const { x, y } = this._containerPoint(e);
    const hit = this.hitTest(x, y);
    // Only ever touch the cursor we set ourselves, so hovering a buoy can't
    // clobber the crosshair an armed tool is showing.
    const canvas = this.map.getCanvas();
    if (canvas && (hit || this._hoverCursor)) canvas.style.cursor = hit ? 'pointer' : '';
    this._hoverCursor = !!hit;
    if (!hit) {
      this.hideTooltip();
      return;
    }
    this.showTooltip(hit.station, x, y);
  }

  handleClick(e) {
    if (!this.enabled || !this.drawn.length) return;
    const down = this._down;
    this._down = null;
    // Only a real tap counts: a click that ends a drag (pan) must not open a card.
    if (down && (Math.abs(e.clientX - down.x) > 6 || Math.abs(e.clientY - down.y) > 6)) return;
    const { x, y } = this._containerPoint(e);
    // Clicks inside the card itself (close button, NDBC link) are the card's.
    if (this.card && !this.card.hidden && this.card.contains(e.target)) return;
    const hit = this.hitTest(x, y, 34);
    if (!hit) {
      if (this.card && !this.card.hidden) this.closeCard();
      return;
    }
    if (this.blockClicks()) return;
    e.stopPropagation();
    e.stopImmediatePropagation();
    e.preventDefault();
    this.hideTooltip();
    this.openCard(hit.station);
  }

  showTooltip(station, x, y) {
    if (!this.tooltip) {
      this.tooltip = document.createElement('div');
      this.tooltip.className = 'buoy-tooltip';
      this.map.getContainer().appendChild(this.tooltip);
    }
    const ob = station.ob;
    const bits = [];
    if (ob) {
      const wave = fmtFt(ob.waveHtM);
      if (wave) bits.push(`seas ${wave}${ob.wavePeakS ? ` @ ${fmtSec(ob.wavePeakS)}` : ''}`);
      if (ob.sstC != null) bits.push(`water ${fmtF(ob.sstC)}`);
      if (ob.tempC != null) bits.push(`air ${fmtF(ob.tempC)}`);
      const wind = fmtWind(ob);
      if (wind) bits.push(wind);
    }
    this.tooltip.innerHTML = `
      <strong>${escapeHtml(station.id)}</strong>
      ${ob && ob.at ? `<span>${fmtUtc(ob.at)}</span>` : ''}
      ${station.name ? `<div class="buoy-name">${escapeHtml(station.name)}</div>` : ''}
      ${bits.length ? `<div class="buoy-decoded">${escapeHtml(bits.join(' · '))}</div>` : ''}
      <div class="buoy-hint">${ob ? 'tap for the full report' : 'tap to load this buoy'}</div>
    `;
    this.tooltip.style.left = `${x + 14}px`;
    this.tooltip.style.top = `${y + 14}px`;
    this.tooltip.hidden = false;
  }

  hideTooltip() {
    if (this.tooltip) this.tooltip.hidden = true;
  }

  openCard(station) {
    if (!this.card) {
      this.card = document.createElement('div');
      this.card.className = 'buoy-card';
      this.card.addEventListener('click', (e) => {
        if (e.target.closest('.buoy-card-close')) this.closeCard();
      });
      this.map.getContainer().appendChild(this.card);
    }
    this.selectedId = station.id;
    this._cardStation = station;
    this.card.hidden = false;
    this.renderCard(station);
    this.positionCard();
    this.scheduleRender();
    // Always confirm the full report on an explicit tap — the plot may only be
    // carrying the coarse bulk record.
    this.loadDetail(station);
  }

  closeCard() {
    if (this.card) this.card.hidden = true;
    this._cardStation = null;
    this.selectedId = null;
    this.scheduleRender();
  }

  // Re-render the card only when it is showing the station that just changed.
  refreshCard(station) {
    if (this.card && !this.card.hidden && this._cardStation === station) this.renderCard(station);
  }

  renderCard(station) {
    if (!this.card) return;
    const ob = station.ob || {};
    const rows = [];
    const row = (label, value) => {
      if (value) rows.push(`<div class="buoy-row"><span>${label}</span><b>${escapeHtml(value)}</b></div>`);
    };

    const seas = fmtWaveTrain(ob.waveHtM, ob.wavePeakS, ob.waveDir);
    row('Seas', seas);
    row('Mean period', ob.waveMeanS != null ? fmtSec(ob.waveMeanS) : null);
    row('Swell', fmtWaveTrain(ob.swellHtM, ob.swellPeriodS, ob.swellDir));
    row('Wind wave', fmtWaveTrain(ob.windWaveHtM, ob.windWavePeriodS, ob.windWaveDir));
    row('Wind', fmtWind(ob));
    row('Water temp', fmtF(ob.sstC));
    row('Air temp', fmtF(ob.tempC));
    row('Dew point', fmtF(ob.dewpC));
    row('Pressure', ob.presHpa == null
      ? null
      : `${ob.presHpa.toFixed(1)} hPa${ob.presChange3h ? ` (${ob.presChange3h > 0 ? '+' : ''}${ob.presChange3h.toFixed(1)} / 3h)` : ''}`);
    row('Visibility', ob.visMi == null ? null : `${ob.visMi >= 10 ? '10+' : Math.round(ob.visMi * 10) / 10} mi`);
    row('Position', `${Math.abs(station.lat).toFixed(3)}°${station.lat >= 0 ? 'N' : 'S'} ${Math.abs(station.lon).toFixed(3)}°${station.lon >= 0 ? 'E' : 'W'}`);

    let note = '';
    if (station.detailPending) note = 'loading full report…';
    else if (!rows.length) note = station.detailError ? 'no report available right now' : 'no current observation';
    else if (station.detailError) note = 'showing the latest bulk report — full report unavailable';
    else if (ob.source === 'gts') note = 'latest GTS marine report';

    const when = ob.at ? `${fmtUtc(ob.at)} · ${fmtAge(ob.at)}` : '';
    this.card.innerHTML = `
      <div class="buoy-card-head">
        <div>
          <div class="buoy-card-id">${escapeHtml(station.id)}<span class="buoy-card-kind">NDBC</span></div>
          ${station.name ? `<div class="buoy-card-name">${escapeHtml(station.name)}</div>` : ''}
        </div>
        <button class="buoy-card-close" type="button" aria-label="Close buoy report">×</button>
      </div>
      ${when ? `<div class="buoy-card-time">${escapeHtml(when)}</div>` : ''}
      <div class="buoy-card-rows">${rows.join('')}</div>
      ${note ? `<div class="buoy-card-note">${escapeHtml(note)}</div>` : ''}
      <a class="buoy-card-link" href="${NDBC_STATION_PAGE}${encodeURIComponent(station.id)}"
         target="_blank" rel="noopener">Station page at NDBC ↗</a>
    `;
  }

  // Anchor the card beside its station, kept inside the map container. The
  // mobile layout pins it to the bottom of the screen instead (see CSS).
  positionCard() {
    const station = this._cardStation;
    if (!this.card || this.card.hidden || !station) return;
    const container = this.map.getContainer();
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w < 560) {
      this.card.classList.add('buoy-card--sheet');
      this.card.style.left = '';
      this.card.style.top = '';
      return;
    }
    this.card.classList.remove('buoy-card--sheet');
    const pt = this.map.project([station.lon, station.lat]);
    const cw = this.card.offsetWidth || 280;
    const ch = this.card.offsetHeight || 240;
    const left = clamp(pt.x + 18, 8, Math.max(8, w - cw - 8));
    const top = clamp(pt.y - ch / 2, TOP_UI_INSET, Math.max(TOP_UI_INSET, h - ch - 12));
    this.card.style.left = `${left}px`;
    this.card.style.top = `${top}px`;
  }
}

function activeTheme() {
  return document.body.classList.contains('theme-dark') ? PLOT_THEMES.dark : PLOT_THEMES.light;
}

// ---------------------------------------------------------------------------
// Station plot drawing
// ---------------------------------------------------------------------------

// 0 = dot + barb, 1 = + seas and water temp, 2 = + period, air temp, station id.
function detailLevel(zoom) {
  if (zoom >= 6.5) return 2;
  if (zoom >= 4.8) return 1;
  return 0;
}

function drawBuoyPlot(ctx, station, x, y, zoom, t, sizeScale = 1, selected = false) {
  const ob = station.ob;
  const scale = clamp(0.85 + (zoom - 4) * 0.09, 0.85, 1.5) * sizeScale;
  const detail = detailLevel(zoom);
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (ob) drawWindBarb(ctx, ob.windDir, ob.windKt, ob.gustKt, t);
  // The wave arrow only appears at full detail: at wide zooms it would sit on
  // top of the wave-height / water-temp labels of the plot next door.
  if (ob && ob.waveDir != null && detail >= 2) drawWaveArrow(ctx, ob.waveDir, t);
  drawBuoyDot(ctx, ob, t, selected);
  drawLabels(ctx, station, t, detail);

  ctx.restore();
}

// Buoy marker: a hull-shaped dot filled with the water temperature. Hollow when
// the station is catalogued but has no current values yet (tap loads it).
function drawBuoyDot(ctx, ob, t, selected) {
  const r = 7.5;
  const fill = ob ? sstColor(ob.sstC) : null;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  ctx.lineWidth = selected ? 2.6 : 1.6;
  ctx.strokeStyle = t.halo;
  ctx.stroke();
  ctx.lineWidth = selected ? 1.8 : 1.2;
  ctx.strokeStyle = selected ? t.ink : t.ring;
  ctx.stroke();

  if (!fill) {
    // No water temperature: a small wave glyph inside keeps the marker legible
    // as a buoy rather than reading like an empty circle.
    ctx.save();
    ctx.lineWidth = 1.3;
    ctx.strokeStyle = ob ? t.dim : t.noData;
    ctx.beginPath();
    ctx.moveTo(-3.4, 1);
    ctx.quadraticCurveTo(-1.7, -1.8, 0, 1);
    ctx.quadraticCurveTo(1.7, 3.8, 3.4, 1);
    ctx.stroke();
    ctx.restore();
  }
}

// Short arrow showing where the dominant swell is heading (the reported
// direction is where it comes FROM, so it is flipped for the arrow).
function drawWaveArrow(ctx, fromDeg, t) {
  const rad = ((num(fromDeg) + 180) * Math.PI) / 180;
  const ux = Math.sin(rad);
  const uy = -Math.cos(rad);
  const start = 10;
  const end = 17;
  const draw = () => {
    ctx.beginPath();
    ctx.moveTo(ux * start, uy * start);
    ctx.lineTo(ux * end, uy * end);
    ctx.moveTo(ux * end, uy * end);
    ctx.lineTo(ux * (end - 4) - uy * 3, uy * (end - 4) + ux * 3);
    ctx.moveTo(ux * end, uy * end);
    ctx.lineTo(ux * (end - 4) + uy * 3, uy * (end - 4) - ux * 3);
    ctx.stroke();
  };
  haloStroke(ctx, draw, 1.4, t.wave, t.halo);
}

function drawLabels(ctx, station, t, detail) {
  ctx.textBaseline = 'middle';
  if (detail < 1) return;
  const ob = station.ob;

  if (ob) {
    const waveFt = ob.waveHtM == null ? null : ob.waveHtM * M_TO_FT;
    if (waveFt != null) {
      text(ctx, `${waveFt < 10 ? waveFt.toFixed(1) : Math.round(waveFt)}'`, -15, -13, 'right', t.wave, t.halo, 13.5);
    }
    if (ob.sstC != null) text(ctx, `${Math.round(cToF(ob.sstC))}°`, 15, -13, 'left', t.sst, t.halo, 13.5);

    if (detail >= 2) {
      const period = ob.wavePeakS ?? ob.waveMeanS;
      if (period != null) text(ctx, `${Math.round(period)}s`, -15, 13, 'right', t.period, t.halo, 11.5);
      if (ob.tempC != null) text(ctx, `${Math.round(cToF(ob.tempC))}°`, 15, 13, 'left', t.temp, t.halo, 11.5);
    }
  }

  if (detail >= 2) text(ctx, station.id, 0, 23, 'center', t.dim, t.halo, 9.5);
}
