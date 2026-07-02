// metars.js - surface observation (METAR) station plots on one canvas overlay.
//
// Source: the Iowa Environmental Mesonet (IEM) current-observations API — the
// one METAR feed that actually serves `access-control-allow-origin: *`
// (aviationweather.gov sends no CORS header at all, so both its data API and
// its raw cache files are unfetchable from a browser; the previous cache-file
// implementation never loaded anything).
//
// IEM has no bbox query, so the view is mapped to the ASOS networks it covers
// (US states / ISO-2 countries, via the coarse boxes at the bottom of this
// file) and each network is fetched once and cached for the refresh interval.
// A wide view over the US doesn't fan out to dozens of state requests — it
// switches to one bulk `country=US` request — so the layer now loads at ANY
// zoom level instead of demanding you zoom in first. Fetched stations merge
// into a per-station store, so panning back over a loaded region redraws
// instantly.
//
// Rendering is entirely local: the view is culled, thinned on a screen grid,
// capped by the user-selected limit, then drawn as station plots designed to be
// readable over the map rather than strictly WMO-cryptic: a flight-category
// coloured station dot (VFR/MVFR/IFR/LIFR) with a cloud-cover pie inside, a
// wind barb with gusts, temperature/dewpoint, and progressively more detail as
// you zoom in. All colours adapt to the light/dark UI theme.

const IEM_URL = 'https://mesonet.agron.iastate.edu/api/1/currents.json';

const REFRESH_MS = 5 * 60 * 1000;
const MAX_AGE_MIN = 180;
const LIMIT_STORAGE_KEY = 'rn.metars.maxStations';
// Hard ceiling of 300 plotted stations — beyond that the screen is unreadable
// and the per-frame redraw cost makes panning feel laggy. (Old stored limits
// above 300 fall back to the default.)
const LIMIT_CHOICES = [100, 150, 200, 250, 300];
const DEFAULT_LIMIT = 300;
const IN_HG_TO_HPA = 33.8639;
// When the view clips more US states than this, one bulk country=US request
// replaces the per-state fan-out (~3 MB gzipped, a second or two).
const BULK_US_THRESHOLD = 6;
// Cap on per-network requests issued for one view.
const MAX_NETWORKS = 12;
const COVER_OKTAS = { SKC: 0, CLR: 0, CAVOK: 0, NSC: 0, FEW: 2, SCT: 4, BKN: 6, OVC: 8, OVX: 8, VV: 8 };

// Theme-aware plot palettes. The light "paper" theme needs dark ink with a warm
// paper halo; the dark theme light ink with a near-black halo — the old layer
// hardcoded pale-blue-on-navy everywhere, which was nearly invisible on the
// light basemap.
const PLOT_THEMES = {
  dark: {
    halo: 'rgba(12, 13, 16, 0.92)',
    ink: '#eef4ff',
    barb: '#d5e3fa',
    dim: '#9fabbd',
    temp: '#ff8577',
    dewp: '#5fd98f',
    wx: '#c9a1ff',
    gust: '#ffb347',
    pres: '#cdd9ec',
    dotBg: '#14161a',
    noData: '#8a94a3',
    cat: { VFR: '#35c268', MVFR: '#3f8ef0', IFR: '#f0524f', LIFR: '#c95df0' },
  },
  light: {
    halo: 'rgba(255, 252, 245, 0.94)',
    ink: '#22201c',
    barb: '#38342e',
    dim: '#6f655b',
    temp: '#c03524',
    dewp: '#0f7a3d',
    wx: '#7040c0',
    gust: '#a35f00',
    pres: '#4a443c',
    dotBg: '#fffaf2',
    noData: '#8a7f72',
    cat: { VFR: '#1e9e50', MVFR: '#2568c8', IFR: '#cc2f2c', LIFR: '#9c3ec4' },
  },
};

const cToF = (c) => (c == null || Number.isNaN(c) ? null : (c * 9) / 5 + 32);
const fToC = (f) => (f == null || Number.isNaN(f) ? null : ((f - 32) * 5) / 9);
const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function loadLimit() {
  try {
    const saved = Number(localStorage.getItem(LIMIT_STORAGE_KEY));
    return LIMIT_CHOICES.includes(saved) ? saved : DEFAULT_LIMIT;
  } catch {
    return DEFAULT_LIMIT;
  }
}

function pressureCode(slp) {
  if (slp == null || Number.isNaN(slp)) return '';
  return String(Math.round(slp * 10) % 1000).padStart(3, '0');
}

function maxCover(clouds) {
  if (!clouds || !clouds.length) return null;
  let best = null;
  for (const layer of clouds) {
    const oktas = COVER_OKTAS[String(layer.cover || '').toUpperCase()];
    if (oktas == null) continue;
    best = best == null ? oktas : Math.max(best, oktas);
  }
  return best;
}

// Lowest broken-or-worse cloud base (the "ceiling"), in ft AGL, or null.
function ceilingFt(clouds) {
  let ceil = null;
  for (const layer of clouds || []) {
    const cover = String(layer.cover || '').toUpperCase();
    if (cover !== 'BKN' && cover !== 'OVC' && cover !== 'OVX' && cover !== 'VV') continue;
    if (layer.base == null) continue;
    ceil = ceil == null ? layer.base : Math.min(ceil, layer.base);
  }
  return ceil;
}

// Standard aviation flight category from visibility (statute mi) + ceiling
// (ft AGL). Null only when neither input is known.
function flightCategory(visMi, ceilFt) {
  if (visMi == null && ceilFt == null) return null;
  const v = visMi == null ? 99 : visMi;
  const c = ceilFt == null ? 99999 : ceilFt;
  if (v < 1 || c < 500) return 'LIFR';
  if (v < 3 || c < 1000) return 'IFR';
  if (v <= 5 || c <= 3000) return 'MVFR';
  return 'VFR';
}

function inLngRange(lng, west, east) {
  if (west <= east) return lng >= west && lng <= east;
  return lng >= west || lng <= east;
}

// ---------------------------------------------------------------------------
// IEM loading
// ---------------------------------------------------------------------------

// Up to four reported cloud layers → [{ cover, base }] (base in ft AGL).
function cloudsFrom(rec) {
  const out = [];
  for (const i of [1, 2, 3, 4]) {
    const cover = rec[`skyc${i}`];
    if (!cover) continue;
    out.push({ cover, base: num(rec[`skyl${i}`]) });
  }
  return out;
}

// IEM current-obs record → the shape the station-plot renderer expects
// (temps in °C, pressure in hPa, wind in knots, visibility in statute miles).
function normalizeIem(rec) {
  const lat = num(rec.lat);
  const lon = num(rec.lon);
  const id = rec.station || '';
  if (!id || lat == null || lon == null) return null;

  const observedAt = Date.parse(rec.utc_valid || '');
  if (Number.isFinite(observedAt)) {
    const ageMin = (Date.now() - observedAt) / 60000;
    if (ageMin > MAX_AGE_MIN || ageMin < -30) return null;
  }

  // Prefer reported MSLP; fall back to the altimeter setting (QNH, already
  // sea-level-reduced) converted to hPa so the coded pressure group still shows.
  const slp = num(rec.mslp) ?? (num(rec.alti) != null ? num(rec.alti) * IN_HG_TO_HPA : null);
  const clouds = cloudsFrom(rec);
  const visib = num(rec.vsby);

  return {
    icaoId: id,
    name: rec.name || '',
    lat,
    lon,
    temp: fToC(num(rec.tmpf)),
    dewp: fToC(num(rec.dwpf)),
    slp,
    clouds,
    wdir: rec.drct == null ? '' : String(rec.drct),
    wspd: num(rec.sknt),
    gust: num(rec.gust) ?? num(rec.max_gust),
    visib,
    wxString: rec.wxcodes || '',
    cat: flightCategory(visib, ceilingFt(clouds)),
    observedAt: Number.isFinite(observedAt) ? observedAt : null,
    rawOb: rec.raw || id,
  };
}

// Fetch one target: 'US' → bulk country request; otherwise an IEM network name
// (`OK_ASOS` for a US state, `FR__ASOS` for a country). Returns normalized obs.
async function fetchTarget(target) {
  const query = target === 'US'
    ? `networkclass=ASOS&country=US`
    : `network=${encodeURIComponent(target)}`;
  const res = await fetch(`${IEM_URL}?${query}&minutes=${MAX_AGE_MIN}`);
  if (!res.ok) throw new Error(`IEM ${target} returned HTTP ${res.status}`);
  const json = await res.json();
  const data = json && Array.isArray(json.data) ? json.data : [];
  const obs = [];
  for (const rec of data) {
    const ob = normalizeIem(rec);
    if (ob) obs.push(ob);
  }
  return obs;
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export class MetarController {
  constructor(map) {
    this.map = map;
    this.enabled = false;
    this.obs = [];
    this.drawn = [];
    this.maxStations = loadLimit();
    this.canvas = null;
    this.ctx = null;
    this.panel = null;
    this.tooltip = null;
    this._store = new Map(); // icaoId -> newest observation
    this._fetched = new Map(); // target ('US' | network) -> last-success ms
    this._inflight = new Set(); // targets currently being fetched
    this._timer = null;
    this._moveT = null;
    this._raf = null;
    this._loading = 0;

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

    // While the map moves, the canvas is glued to it with a cheap CSS
    // translate+scale (trackMove) and fully redrawn only every ~150 ms; the
    // moveend/resize/rotate paths do an immediate full redraw. Redrawing every
    // frame made plots visibly lag the drag, then snap back into place.
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
      this.hideOverlay();
      this.hidePanel();
      this.hideTooltip();
      this.drawn = [];
    }
    return this.enabled;
  }

  // The view as one or two wrapped [w,s,e,n] boxes (two when it crosses the
  // antimeridian), padded a little so ordinary panning stays covered.
  _viewBoxes(pad = 0.2) {
    const b = this.map.getBounds();
    const s = clamp(b.getSouth() - pad, -85, 85);
    const n = clamp(b.getNorth() + pad, -85, 85);
    if (b.getEast() - b.getWest() >= 360) return [[-180, s, 180, n]];
    const wrap = (x) => ((((x + 180) % 360) + 360) % 360) - 180;
    const w = wrap(b.getWest() - pad);
    const e = wrap(b.getEast() + pad);
    if (w <= e) return [[w, s, e, n]];
    return [
      [w, s, 180, n],
      [-180, s, e, n],
    ];
  }

  // Fetch whatever networks the current view needs and aren't fresh in the
  // cache. Runs on enable, on a 5-minute timer, and (debounced) on moveend —
  // there is deliberately NO minimum zoom: a wide US view collapses to one bulk
  // country request instead of refusing to load.
  async maybeFetch() {
    if (!this.enabled) return;
    const nets = [];
    for (const box of this._viewBoxes()) nets.push(...networksInView(box));
    nets.sort((a, b) => a.d - b.d);

    const states = nets.filter((h) => h.us);
    const countries = nets.filter((h) => !h.us);
    let targets;
    if (states.length > BULK_US_THRESHOLD) {
      targets = ['US', ...countries.slice(0, MAX_NETWORKS - 1).map((h) => h.net)];
    } else {
      targets = nets.slice(0, MAX_NETWORKS).map((h) => h.net);
    }

    const now = Date.now();
    const due = targets.filter(
      (t) => !this._inflight.has(t) && now - (this._fetched.get(t) || 0) > REFRESH_MS - 15000
    );
    if (!due.length) {
      this.scheduleRender();
      return;
    }
    for (const t of due) this._inflight.add(t);

    this._loading++;
    if (this.onStatus && !this.obs.length) this.onStatus('loading surface obs');
    try {
      const settled = await Promise.allSettled(due.map((t) => fetchTarget(t)));
      // No sequence guard needed: results merge per-station with newest-wins,
      // so a slow response landing after a newer one can't clobber anything.
      if (!this.enabled) return;
      let any = false;
      settled.forEach((s, i) => {
        if (s.status !== 'fulfilled') return;
        any = true;
        this._fetched.set(due[i], Date.now());
        this._merge(s.value);
      });
      if (!any) throw settled[0] && settled[0].reason;
      this.scheduleRender();
    } catch (err) {
      console.error('metar load failed', err);
      if (this.onStatus) this.onStatus('METARs unavailable');
    } finally {
      for (const t of due) this._inflight.delete(t);
      this._loading--;
    }
  }

  // Merge fetched observations into the per-station store (newest wins) and
  // rebuild the draw list, dropping anything past the age cutoff.
  _merge(obs) {
    for (const ob of obs) {
      const prev = this._store.get(ob.icaoId);
      if (!prev || (ob.observedAt || 0) >= (prev.observedAt || 0)) this._store.set(ob.icaoId, ob);
    }
    const cutoff = Date.now() - MAX_AGE_MIN * 60000;
    for (const [id, ob] of this._store) {
      if (ob.observedAt && ob.observedAt < cutoff) this._store.delete(id);
    }
    this.obs = Array.from(this._store.values());
  }

  ensureOverlay() {
    if (!this.canvas) {
      const container = this.map.getContainer();
      this.canvas = document.createElement('canvas');
      this.canvas.className = 'metar-canvas';
      this.ctx = this.canvas.getContext('2d');
      container.appendChild(this.canvas);
      container.addEventListener('mousemove', this._mousemove);
      container.addEventListener('mouseleave', this._mouseleave);
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
      const container = this.map.getContainer();
      this.panel = document.createElement('div');
      this.panel.className = 'metar-panel';
      this.panel.innerHTML = `
        <div class="metar-panel-row">
          <span>METAR</span>
          <select aria-label="METAR station limit">
            ${LIMIT_CHOICES.map((n) => `<option value="${n}">${n}</option>`).join('')}
          </select>
        </div>
        <div class="metar-panel-cats"></div>
        <div class="metar-panel-count"></div>
      `;
      this.panel.querySelector('select').value = String(this.maxStations);
      this.panel.querySelector('select').addEventListener('change', (e) => {
        this.maxStations = Number(e.target.value) || DEFAULT_LIMIT;
        try { localStorage.setItem(LIMIT_STORAGE_KEY, String(this.maxStations)); } catch {}
        this.scheduleRender();
      });
      container.appendChild(this.panel);
    }
    // Flight-category key in the current theme's plot colours.
    const cats = this.panel.querySelector('.metar-panel-cats');
    if (cats) {
      const t = activeTheme();
      cats.innerHTML = ['VFR', 'MVFR', 'IFR', 'LIFR']
        .map((c) => `<i style="--c:${t.cat[c]}"></i>${c}`)
        .join(' ');
    }
    this.panel.hidden = false;
  }

  hidePanel() {
    if (this.panel) this.panel.hidden = true;
  }

  scheduleRender() {
    if (!this.enabled || !this.canvas) return;
    cancelAnimationFrame(this._raf);
    this._raf = requestAnimationFrame(() => this.render());
  }

  // Keep the plots glued to the map during pan/zoom without redrawing every
  // frame: transform the whole canvas by how much the last full render's
  // anchor point has moved (translate) and how much the zoom has changed
  // (scale about that anchor). A real redraw follows at most every 150 ms and
  // on moveend, which recomputes positions and resets the transform.
  trackMove() {
    if (!this.enabled || !this.canvas || this.canvas.hidden) return;
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

    // Fresh positions — drop the interim move transform and re-anchor.
    this._lastFull = performance.now();
    const c = this.map.getCenter();
    this._anchor = { lngLat: [c.lng, c.lat], pt: this.map.project([c.lng, c.lat]), zoom: this.map.getZoom() };
    this.canvas.style.transform = '';
    this.canvas.style.transformOrigin = '';

    const theme = activeTheme();
    const zoom = this.map.getZoom();
    const selected = this.selectVisible(w, h);
    this.drawn = selected;
    for (const item of selected) drawStationPlot(ctx, item.ob, item.x, item.y, zoom, theme);

    const count = this.panel?.querySelector('.metar-panel-count');
    if (count) {
      const total = this._visibleCount || 0;
      count.textContent = this._loading && !total ? 'loading…' : `${selected.length}/${total} shown`;
    }
    if (this.onStatus && this.obs.length) {
      const capped = selected.length >= this.maxStations ? `, capped at ${this.maxStations}` : '';
      this.onStatus(`${selected.length}/${this._visibleCount || selected.length} METARs${capped}`);
    }
  }

  selectVisible(w, h) {
    if (!this.obs.length) {
      this._visibleCount = 0;
      return [];
    }
    const bounds = this.map.getBounds();
    const west = bounds.getWest();
    const east = bounds.getEast();
    const south = bounds.getSouth();
    const north = bounds.getNorth();
    const zoom = this.map.getZoom();
    // Plots are larger than the old WMO glyphs, so the thinning grid is a bit
    // coarser to keep neighbours from overlapping.
    const cell = clamp(108 - zoom * 4, 58, 92);
    const margin = 74;
    const grid = new Map();
    let visible = 0;

    for (const ob of this.obs) {
      if (ob.lat < south || ob.lat > north || !inLngRange(ob.lon, west, east)) continue;
      const pt = this.map.project([ob.lon, ob.lat]);
      if (pt.x < -margin || pt.y < -margin || pt.x > w + margin || pt.y > h + margin) continue;
      visible++;
      const gx = Math.floor(pt.x / cell);
      const gy = Math.floor(pt.y / cell);
      const key = `${gx}:${gy}`;
      const cellCx = gx * cell + cell / 2;
      const cellCy = gy * cell + cell / 2;
      const score = (pt.x - cellCx) ** 2 + (pt.y - cellCy) ** 2 + agePenalty(ob);
      const prev = grid.get(key);
      if (!prev || score < prev.score) grid.set(key, { ob, x: pt.x, y: pt.y, score });
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

  handleMouseMove(e) {
    if (!this.enabled || !this.drawn.length) return;
    const rect = this.map.getContainer().getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    let hit = null;
    let best = 999999;
    for (const item of this.drawn) {
      const dx = item.x - x;
      const dy = item.y - y;
      const d = dx * dx + dy * dy;
      if (d < best && d < 34 * 34) {
        best = d;
        hit = item;
      }
    }
    if (!hit) {
      this.hideTooltip();
      return;
    }
    this.showTooltip(hit.ob, x, y);
  }

  showTooltip(ob, x, y) {
    if (!this.tooltip) {
      this.tooltip = document.createElement('div');
      this.tooltip.className = 'metar-tooltip';
      this.map.getContainer().appendChild(this.tooltip);
    }
    const theme = activeTheme();
    const when = ob.observedAt ? new Date(ob.observedAt).toISOString().slice(11, 16) + 'Z' : '';
    const cat = ob.cat
      ? ` <em class="metar-cat" style="color:${theme.cat[ob.cat]}">${ob.cat}</em>`
      : '';
    const temp = cToF(ob.temp);
    const dewp = cToF(ob.dewp);
    const bits = [];
    if (temp != null) bits.push(`${Math.round(temp)}°F${dewp != null ? ` / ${Math.round(dewp)}°F` : ''}`);
    if (ob.wspd != null) {
      const dir = num(ob.wdir) != null ? `${String(num(ob.wdir)).padStart(3, '0')}°` : '';
      bits.push(ob.wspd < 1 ? 'calm' : `${dir} ${Math.round(ob.wspd)}${ob.gust ? `G${Math.round(ob.gust)}` : ''} kt`);
    }
    if (ob.visib != null) bits.push(`${ob.visib >= 10 ? '10+' : Math.round(ob.visib * 10) / 10} mi`);
    if (ob.wxString) bits.push(escapeHtml(ob.wxString));
    this.tooltip.innerHTML = `
      <strong>${escapeHtml(ob.icaoId)}</strong>${cat}${when ? ` <span>${when}</span>` : ''}
      ${ob.name ? `<div class="metar-name">${escapeHtml(String(ob.name).split(',')[0])}</div>` : ''}
      ${bits.length ? `<div class="metar-decoded">${bits.join(' · ')}</div>` : ''}
      <div class="metar-raw">${escapeHtml(ob.rawOb || '')}</div>
    `;
    this.tooltip.style.left = `${x + 14}px`;
    this.tooltip.style.top = `${y + 14}px`;
    this.tooltip.hidden = false;
  }

  hideTooltip() {
    if (this.tooltip) this.tooltip.hidden = true;
  }
}

function activeTheme() {
  return document.body.classList.contains('theme-dark') ? PLOT_THEMES.dark : PLOT_THEMES.light;
}

function agePenalty(ob) {
  if (!ob.observedAt) return 0;
  return clamp((Date.now() - ob.observedAt) / 60000, 0, MAX_AGE_MIN) * 0.04;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

// ---------------------------------------------------------------------------
// Station plot drawing
// ---------------------------------------------------------------------------

// Detail grows with zoom so a wide view stays uncluttered while a close view
// shows the full plot: 0 = dot + barb, 1 = + temp/dewpoint, 2 = + gust, wx,
// pressure and station id.
function detailLevel(zoom) {
  if (zoom >= 6.5) return 2;
  if (zoom >= 4.8) return 1;
  return 0;
}

function drawStationPlot(ctx, ob, x, y, zoom, t) {
  // Grows steadily with zoom.
  const scale = clamp(0.85 + (zoom - 4) * 0.09, 0.85, 1.5);
  const detail = detailLevel(zoom);
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  drawWindBarb(ctx, ob.wdir, ob.wspd, ob.gust, t);
  drawStationDot(ctx, ob, t);
  drawLabels(ctx, ob, t, detail);

  ctx.restore();
}

// Flight-category coloured dot with a cloud-cover pie inside: the ring colour
// answers "how's the weather there" at a glance, the pie keeps the traditional
// sky-cover reading.
function drawStationDot(ctx, ob, t) {
  const r = 7.5;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fillStyle = (ob.cat && t.cat[ob.cat]) || t.noData;
  ctx.fill();
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = t.halo;
  ctx.stroke();

  const ri = 4.6;
  ctx.beginPath();
  ctx.arc(0, 0, ri, 0, Math.PI * 2);
  ctx.fillStyle = t.dotBg;
  ctx.fill();

  const oktas = maxCover(ob.clouds);
  if (oktas == null) {
    // Cover unknown — a small dash instead of a bogus clear-sky reading.
    ctx.strokeStyle = t.dim;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(-2.2, 0);
    ctx.lineTo(2.2, 0);
    ctx.stroke();
  } else if (oktas > 0) {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, ri, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * oktas) / 8);
    ctx.closePath();
    ctx.fillStyle = t.ink;
    ctx.fill();
  }
}

function drawWindBarb(ctx, dir, kt, gust, t) {
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

function drawLabels(ctx, ob, t, detail) {
  ctx.textBaseline = 'middle';
  if (detail < 1) return;

  const temp = cToF(ob.temp);
  const dewp = cToF(ob.dewp);
  if (temp != null) text(ctx, `${Math.round(temp)}°`, -12, -12, 'right', t.temp, t.halo, 13.5);
  if (dewp != null) text(ctx, `${Math.round(dewp)}°`, -12, 13, 'right', t.dewp, t.halo, 13.5);

  if (detail < 2) return;
  const pressure = pressureCode(ob.slp);
  const wx = String(ob.wxString || '').split(/\s+/).filter(Boolean).slice(0, 2).join(' ');
  if (pressure) text(ctx, pressure, 13, -12, 'left', t.pres, t.halo, 11.5);
  if (ob.gust) text(ctx, `G${Math.round(ob.gust)}`, 13, 13, 'left', t.gust, t.halo, 11.5);
  if (wx) text(ctx, wx.slice(0, 8), -14, 0, 'right', t.wx, t.halo, 10.5);
  if (ob.icaoId) text(ctx, ob.icaoId, 0, 22, 'center', t.dim, t.halo, 9.5);
}

function text(ctx, value, x, y, align, fill, halo, size = 13) {
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

function haloStroke(ctx, draw, width, stroke, halo) {
  ctx.save();
  ctx.lineWidth = width + 3.4;
  ctx.strokeStyle = halo;
  draw();
  ctx.lineWidth = width;
  ctx.strokeStyle = stroke;
  draw();
  ctx.restore();
}

// ---------------------------------------------------------------------------
// View → IEM networks
// ---------------------------------------------------------------------------

// IEM networks whose bounding box intersects the view [W,S,E,N], tagged with
// the squared distance of the box centre to the view centre (callers sort on
// it) and whether the hit is a US state. US states map to `{ST}_ASOS`; world
// countries map to `{ISO2}__ASOS` (double underscore — IEM's international
// convention).
function networksInView(view) {
  const [w, s, e, n] = view;
  const cx = (w + e) / 2;
  const cy = (s + n) / 2;
  const hits = [];
  const consider = (box, net, us) => {
    const [bw, bs, be, bn] = box;
    if (be < w || bw > e || bn < s || bs > n) return; // no overlap
    const dx = (bw + be) / 2 - cx;
    const dy = (bs + bn) / 2 - cy;
    hits.push({ net, d: dx * dx + dy * dy, us });
  };
  for (const st in STATE_BBOX) consider(STATE_BBOX[st], `${st}_ASOS`, true);
  for (const cc in COUNTRY_BBOX) consider(COUNTRY_BBOX[cc], `${cc}__ASOS`, false);
  return hits;
}

// Approximate [west, south, east, north] bounding boxes for the 50 states + DC.
// Slightly padded; only used to decide which `{ST}_ASOS` networks to query, so
// over-selecting a neighbor is harmless (obs are filtered to the exact view).
const STATE_BBOX = {
  AL: [-88.5, 30.1, -84.9, 35.1], AZ: [-114.9, 31.3, -109.0, 37.1],
  AR: [-94.7, 33.0, -89.6, 36.6], CA: [-124.5, 32.5, -114.1, 42.1],
  CO: [-109.1, 36.9, -102.0, 41.1], CT: [-73.8, 40.9, -71.7, 42.1],
  DC: [-77.2, 38.7, -76.8, 39.1], DE: [-75.8, 38.4, -75.0, 39.9],
  FL: [-87.7, 24.4, -79.9, 31.1], GA: [-85.7, 30.3, -80.8, 35.1],
  IA: [-96.7, 40.3, -90.1, 43.6], ID: [-117.3, 41.9, -111.0, 49.1],
  IL: [-91.6, 36.9, -87.0, 42.6], IN: [-88.1, 37.7, -84.7, 41.8],
  KS: [-102.1, 36.9, -94.5, 40.1], KY: [-89.6, 36.4, -81.9, 39.2],
  LA: [-94.1, 28.9, -88.8, 33.1], MA: [-73.6, 41.2, -69.9, 42.9],
  MD: [-79.5, 37.8, -75.0, 39.8], ME: [-71.2, 42.9, -66.9, 47.5],
  MI: [-90.5, 41.6, -82.3, 48.3], MN: [-97.3, 43.4, -89.4, 49.5],
  MO: [-95.8, 35.9, -89.0, 40.7], MS: [-91.7, 30.1, -88.0, 35.1],
  MT: [-116.1, 44.3, -104.0, 49.1], NC: [-84.4, 33.8, -75.4, 36.7],
  ND: [-104.1, 45.9, -96.5, 49.1], NE: [-104.1, 39.9, -95.2, 43.1],
  NH: [-72.6, 42.6, -70.5, 45.4], NJ: [-75.6, 38.9, -73.8, 41.4],
  NM: [-109.1, 31.2, -102.9, 37.1], NV: [-120.1, 35.0, -114.0, 42.1],
  NY: [-79.8, 40.4, -71.8, 45.1], OH: [-84.9, 38.3, -80.5, 42.4],
  OK: [-103.1, 33.6, -94.4, 37.1], OR: [-124.6, 41.9, -116.4, 46.3],
  PA: [-80.6, 39.7, -74.6, 42.4], RI: [-71.9, 41.1, -71.1, 42.1],
  SC: [-83.4, 32.0, -78.5, 35.3], SD: [-104.1, 42.4, -96.4, 46.0],
  TN: [-90.4, 34.9, -81.6, 36.7], TX: [-106.7, 25.8, -93.5, 36.6],
  UT: [-114.1, 36.9, -109.0, 42.1], VA: [-83.7, 36.5, -75.2, 39.5],
  VT: [-73.5, 42.7, -71.5, 45.1], WA: [-124.8, 45.5, -116.9, 49.1],
  WI: [-92.9, 42.4, -86.8, 47.1], WV: [-82.7, 37.1, -77.7, 40.7],
  WY: [-111.1, 40.9, -104.0, 45.1],
  AK: [-179.2, 51.0, -129.9, 71.5], HI: [-160.3, 18.9, -154.8, 22.3],
};

// Approximate [west, south, east, north] boxes for world countries with IEM
// `{ISO2}__ASOS` networks. Only used to decide which networks to query (obs are
// filtered to the exact view), so coarse boxes and over-selecting neighbours are
// harmless. The US is omitted — its states above already cover it.
const COUNTRY_BBOX = {
  CA: [-141.0, 41.7, -52.6, 70.0], MX: [-117.2, 14.5, -86.7, 32.7],
  GB: [-8.6, 49.9, 1.8, 60.9], IE: [-10.5, 51.4, -6.0, 55.4],
  FR: [-5.1, 41.3, 9.6, 51.1], ES: [-9.3, 36.0, 3.3, 43.8],
  PT: [-9.5, 36.9, -6.2, 42.2], DE: [5.9, 47.3, 15.0, 55.1],
  NL: [3.4, 50.8, 7.2, 53.6], BE: [2.5, 49.5, 6.4, 51.5],
  CH: [5.9, 45.8, 10.5, 47.8], AT: [9.5, 46.4, 17.2, 49.0],
  IT: [6.6, 36.6, 18.5, 47.1], GR: [19.4, 34.8, 28.3, 41.8],
  PL: [14.1, 49.0, 24.2, 54.9], CZ: [12.1, 48.5, 18.9, 51.1],
  SK: [16.8, 47.7, 22.6, 49.6], HU: [16.1, 45.7, 22.9, 48.6],
  RO: [20.2, 43.6, 29.7, 48.3], BG: [22.3, 41.2, 28.6, 44.2],
  RS: [18.8, 42.2, 23.0, 46.2], HR: [13.4, 42.4, 19.4, 46.6],
  DK: [8.0, 54.5, 12.7, 57.8], NO: [4.5, 57.9, 31.1, 71.2],
  SE: [11.1, 55.3, 24.2, 69.1], FI: [20.5, 59.7, 31.6, 70.1],
  EE: [23.3, 57.5, 28.2, 59.7], LV: [20.9, 55.6, 28.2, 58.1],
  LT: [20.9, 53.9, 26.8, 56.5], BY: [23.1, 51.2, 32.8, 56.2],
  UA: [22.1, 44.3, 40.2, 52.4], RU: [27.0, 41.2, 180.0, 77.0],
  TR: [25.6, 35.8, 44.8, 42.1], IS: [-24.6, 63.3, -13.5, 66.6],
  MA: [-13.2, 27.6, -1.0, 35.9], DZ: [-8.7, 18.9, 12.0, 37.1],
  TN: [7.5, 30.2, 11.6, 37.5], EG: [24.7, 22.0, 36.9, 31.7],
  ZA: [16.4, -34.9, 32.9, -22.1], KE: [33.9, -4.7, 41.9, 5.0],
  NG: [2.7, 4.3, 14.7, 13.9], ET: [33.0, 3.4, 47.9, 14.9],
  IN: [68.1, 6.5, 97.4, 35.5], PK: [60.9, 23.7, 77.8, 37.1],
  CN: [73.5, 18.2, 134.8, 53.6], JP: [129.4, 31.0, 145.8, 45.5],
  KR: [125.9, 33.1, 129.6, 38.6], TW: [120.0, 21.9, 122.0, 25.3],
  TH: [97.3, 5.6, 105.6, 20.5], VN: [102.1, 8.4, 109.5, 23.4],
  MY: [99.6, 0.8, 119.3, 7.4], ID: [95.0, -11.0, 141.0, 6.1],
  PH: [116.9, 4.6, 126.6, 19.6], SG: [103.6, 1.2, 104.1, 1.5],
  AE: [51.0, 22.6, 56.4, 26.1], SA: [34.5, 16.4, 55.7, 32.2],
  IL: [34.2, 29.5, 35.9, 33.3], IR: [44.0, 25.1, 63.3, 39.8],
  IQ: [38.8, 29.1, 48.6, 37.4], AU: [112.9, -43.7, 153.6, -10.1],
  NZ: [166.4, -47.3, 178.6, -34.4], BR: [-74.0, -33.8, -34.8, 5.3],
  AR: [-73.6, -55.1, -53.6, -21.8], CL: [-75.7, -55.9, -66.4, -17.5],
  PE: [-81.4, -18.4, -68.7, -0.0], CO: [-79.0, -4.2, -66.9, 12.5],
  VE: [-73.4, 0.6, -59.8, 12.2], EC: [-81.0, -5.0, -75.2, 1.4],
  BO: [-69.6, -22.9, -57.5, -9.7], PY: [-62.6, -27.6, -54.3, -19.3],
  UY: [-58.4, -34.9, -53.1, -30.1],
};
