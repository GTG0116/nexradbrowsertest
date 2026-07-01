// metars.js - global METAR station plots rendered on one canvas overlay.
//
// The layer fetches a raw AviationWeather cache file, parses it in the browser,
// and keeps the current global observation set in memory. Rendering is entirely
// local: the map view is culled, thinned on a screen grid, capped by the user
// selected limit, then drawn as WMO-style station plots on a single canvas. That
// avoids the thousands of DOM markers that made the old layer feel sluggish.

const RAW_SOURCES = [
  { url: 'https://aviationweather.gov/data/cache/metars.cache.xml.gz', type: 'xml-gz' },
  { url: 'https://aviationweather.gov/data/cache/metars.cache.csv', type: 'csv' },
  { url: 'https://aviationweather.gov/data/cache/metars.cache.xml', type: 'xml' },
];

const REFRESH_MS = 5 * 60 * 1000;
const MAX_AGE_MIN = 180;
const LIMIT_STORAGE_KEY = 'rn.metars.maxStations';
const LIMIT_CHOICES = [150, 300, 600, 900, 1200, 1800, 2400];
const DEFAULT_LIMIT = 900;
const IN_HG_TO_HPA = 33.8639;
const COVER_OKTAS = { SKC: 0, CLR: 0, CAVOK: 0, NSC: 0, FEW: 2, SCT: 4, BKN: 6, OVC: 8, OVX: 8 };

const cToF = (c) => (c == null || Number.isNaN(c) ? null : (c * 9) / 5 + 32);
const num = (v) => {
  if (v == null || v === '' || v === 'M') return null;
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
  for (const cover of clouds) {
    const oktas = COVER_OKTAS[String(cover || '').toUpperCase()];
    if (oktas == null) continue;
    best = best == null ? oktas : Math.max(best, oktas);
  }
  return best;
}

function inLngRange(lng, west, east) {
  if (west <= east) return lng >= west && lng <= east;
  return lng >= west || lng <= east;
}

function csvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function parseCsvMetars(text) {
  const rows = csvRows(text).filter((r) => r.length > 1);
  if (!rows.length) return [];
  const seen = new Map();
  const headers = rows[0].map((h) => {
    const key = String(h || '').trim();
    const count = seen.get(key) || 0;
    seen.set(key, count + 1);
    return count ? `${key}_${count + 1}` : key;
  });

  const obs = [];
  for (let i = 1; i < rows.length; i++) {
    const rec = {};
    for (let j = 0; j < headers.length; j++) rec[headers[j]] = rows[i][j] || '';
    const ob = normalizeCacheRecord(rec);
    if (ob) obs.push(ob);
  }
  return obs;
}

function parseXmlMetars(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const nodes = Array.from(doc.getElementsByTagName('METAR'));
  const obs = [];
  for (const node of nodes) {
    const rec = {};
    for (const child of Array.from(node.children)) {
      if (child.tagName === 'sky_condition') continue;
      rec[child.tagName] = child.textContent || '';
    }
    rec._clouds = Array.from(node.getElementsByTagName('sky_condition'))
      .map((sky) => sky.getAttribute('sky_cover'))
      .filter(Boolean);
    const ob = normalizeCacheRecord(rec);
    if (ob) obs.push(ob);
  }
  return obs;
}

function cloudsFromRecord(rec) {
  if (rec._clouds) return rec._clouds;
  return Object.keys(rec)
    .filter((k) => k === 'sky_cover' || k.startsWith('sky_cover_'))
    .map((k) => rec[k])
    .filter(Boolean);
}

function normalizeCacheRecord(rec) {
  const lat = num(rec.latitude);
  const lon = num(rec.longitude);
  const id = rec.station_id || rec.station || rec.icaoId || rec.icao_id || '';
  if (!id || lat == null || lon == null) return null;

  const observedAt = Date.parse(rec.observation_time || rec.valid || rec.report_time || '');
  if (Number.isFinite(observedAt)) {
    const ageMin = (Date.now() - observedAt) / 60000;
    if (ageMin > MAX_AGE_MIN || ageMin < -30) return null;
  }

  const slp = num(rec.sea_level_pressure_mb) ?? num(rec.mslp)
    ?? (num(rec.altim_in_hg) != null ? num(rec.altim_in_hg) * IN_HG_TO_HPA : null)
    ?? (num(rec.altimeter) != null ? num(rec.altimeter) * IN_HG_TO_HPA : null);

  return {
    icaoId: id,
    lat,
    lon,
    temp: num(rec.temp_c),
    dewp: num(rec.dewpoint_c),
    slp,
    clouds: cloudsFromRecord(rec),
    wdir: rec.wind_dir_degrees || rec.drct || '',
    wspd: num(rec.wind_speed_kt ?? rec.sknt),
    gust: num(rec.wind_gust_kt),
    visibility: rec.visibility_statute_mi || '',
    wxString: rec.wx_string || rec.wxcodes || '',
    observedAt: Number.isFinite(observedAt) ? observedAt : null,
    rawOb: rec.raw_text || rec.raw || id,
  };
}

async function responseText(source) {
  const res = await fetch(`${source.url}?_=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${source.url} returned HTTP ${res.status}`);
  if (source.type !== 'xml-gz') return res.text();
  if (!('DecompressionStream' in window) || !res.body) {
    throw new Error('gzip METAR cache requires DecompressionStream');
  }
  const stream = res.body.pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

async function fetchRawMetars() {
  const errors = [];
  for (const source of RAW_SOURCES) {
    try {
      const text = await responseText(source);
      const obs = source.type === 'csv' ? parseCsvMetars(text) : parseXmlMetars(text);
      if (obs.length) return { obs, source: source.url };
      errors.push(`${source.url}: empty cache`);
    } catch (err) {
      errors.push(err.message || String(err));
    }
  }
  throw new Error(errors.join('; '));
}

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
    this._timer = null;
    this._raf = null;
    this._seq = 0;
    this._lastLoad = 0;
    this._loading = false;

    this._scheduleRender = () => this.scheduleRender();
    this._mousemove = (e) => this.handleMouseMove(e);
    this._mouseleave = () => this.hideTooltip();

    map.on('move', this._scheduleRender);
    map.on('zoom', this._scheduleRender);
    map.on('resize', this._scheduleRender);
    map.on('rotate', this._scheduleRender);
  }

  setEnabled(on) {
    this.enabled = on;
    if (on) {
      this.ensureOverlay();
      this.ensurePanel();
      this.refresh();
      this._timer = setInterval(() => this.enabled && this.refresh(true), REFRESH_MS);
      this.scheduleRender();
    } else {
      clearInterval(this._timer);
      this._timer = null;
      this.hideOverlay();
      this.hidePanel();
      this.hideTooltip();
      this.drawn = [];
    }
    return this.enabled;
  }

  async refresh(force = false) {
    if (!this.enabled || this._loading) return;
    if (!force && this.obs.length && Date.now() - this._lastLoad < REFRESH_MS - 15000) {
      this.scheduleRender();
      return;
    }
    const seq = ++this._seq;
    this._loading = true;
    if (this.onStatus) this.onStatus('loading global METAR cache');
    try {
      const { obs, source } = await fetchRawMetars();
      if (seq !== this._seq || !this.enabled) return;
      this.obs = obs;
      this._lastLoad = Date.now();
      this._source = source;
      this.scheduleRender();
    } catch (err) {
      if (seq !== this._seq) return;
      console.error('metar load failed', err);
      if (this.onStatus) this.onStatus('METARs unavailable');
    } finally {
      if (seq === this._seq) this._loading = false;
    }
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

    const selected = this.selectVisible(w, h);
    this.drawn = selected;
    for (const item of selected) drawStationPlot(ctx, item.ob, item.x, item.y, this.map.getZoom());

    const count = this.panel?.querySelector('.metar-panel-count');
    if (count) {
      const total = this._visibleCount || 0;
      count.textContent = `${selected.length}/${total} shown`;
    }
    if (this.onStatus && this.obs.length) {
      const capped = this._visibleCount > selected.length ? `, capped at ${this.maxStations}` : '';
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
    const cell = clamp(86 - zoom * 4, 42, 72);
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
    const when = ob.observedAt ? new Date(ob.observedAt).toISOString().slice(11, 16) + 'Z' : '';
    this.tooltip.innerHTML = `
      <strong>${escapeHtml(ob.icaoId)}</strong>${when ? ` <span>${when}</span>` : ''}
      <div>${escapeHtml(ob.rawOb || '')}</div>
    `;
    this.tooltip.style.left = `${x + 14}px`;
    this.tooltip.style.top = `${y + 14}px`;
    this.tooltip.hidden = false;
  }

  hideTooltip() {
    if (this.tooltip) this.tooltip.hidden = true;
  }
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

function drawStationPlot(ctx, ob, x, y, zoom) {
  const scale = clamp(0.82 + zoom * 0.03, 0.9, 1.2);
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  drawWindBarb(ctx, ob.wdir, ob.wspd, ob.gust);
  drawSky(ctx, maxCover(ob.clouds));
  drawLabels(ctx, ob);

  ctx.restore();
}

function drawSky(ctx, oktas) {
  const r = 8;
  haloStroke(ctx, () => {
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.stroke();
  }, 1.6, '#dfeaff');

  ctx.fillStyle = '#dfeaff';
  if (oktas == null) {
    haloStroke(ctx, () => {
      ctx.beginPath();
      ctx.moveTo(-r, 0);
      ctx.lineTo(r, 0);
      ctx.moveTo(0, -r);
      ctx.lineTo(0, r);
      ctx.stroke();
    }, 1.4, '#dfeaff');
    return;
  }
  if (oktas <= 0) return;
  if (oktas <= 2) {
    haloStroke(ctx, () => {
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(0, -r);
      ctx.stroke();
    }, 1.5, '#dfeaff');
  } else if (oktas <= 4) {
    ctx.beginPath();
    ctx.moveTo(0, -r);
    ctx.arc(0, 0, r, -Math.PI / 2, Math.PI / 2);
    ctx.closePath();
    ctx.fill();
  } else if (oktas <= 6) {
    ctx.beginPath();
    ctx.arc(0, 0, r, -Math.PI / 2, Math.PI * 1.5);
    ctx.moveTo(0, -r);
    ctx.arc(0, 0, r, -Math.PI / 2, Math.PI / 2);
    ctx.closePath();
    ctx.fill('evenodd');
  } else if (oktas === 7) {
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    haloStroke(ctx, () => {
      ctx.beginPath();
      ctx.moveTo(0, -r);
      ctx.lineTo(0, r);
      ctx.stroke();
    }, 1.2, '#071427');
  } else {
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawWindBarb(ctx, dir, kt, gust) {
  const d = String(dir || '').toUpperCase();
  const degrees = d === 'VRB' ? null : num(d);
  const speed = num(kt);
  if (speed == null) return;
  if (speed < 1 || degrees == null) {
    if (speed < 1) {
      haloStroke(ctx, () => {
        ctx.beginPath();
        ctx.arc(0, 0, 12, 0, Math.PI * 2);
        ctx.stroke();
      }, 1.2, '#9fd0ff');
    }
    return;
  }

  const r = 8;
  const len = 34;
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
  let t = r + len;
  const step = 6;
  const barbLen = 11;
  const point = () => ({ x: ux * t, y: uy * t });
  const pennants = Math.floor(remaining / 50);
  remaining -= pennants * 50;
  const fulls = Math.floor(remaining / 10);
  remaining -= fulls * 10;
  const halves = Math.floor(remaining / 5);

  for (let i = 0; i < pennants; i++) {
    const a = point();
    t -= step * 1.45;
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
  if (pennants) t -= step * 0.4;
  for (let i = 0; i < fulls; i++) {
    const a = point();
    parts.push((c) => {
      c.beginPath();
      c.moveTo(a.x, a.y);
      c.lineTo(a.x + px * barbLen, a.y + py * barbLen);
      c.stroke();
    });
    t -= step;
  }
  for (let i = 0; i < halves; i++) {
    if (t >= r + len - 0.1) t -= step;
    const a = point();
    parts.push((c) => {
      c.beginPath();
      c.moveTo(a.x, a.y);
      c.lineTo(a.x + px * barbLen * 0.55, a.y + py * barbLen * 0.55);
      c.stroke();
    });
    t -= step;
  }

  ctx.save();
  ctx.lineWidth = 3.8;
  ctx.strokeStyle = 'rgba(4, 10, 24, 0.95)';
  ctx.fillStyle = 'rgba(4, 10, 24, 0.95)';
  for (const part of parts) part(ctx);
  ctx.lineWidth = 1.7;
  ctx.strokeStyle = '#9fd0ff';
  ctx.fillStyle = '#9fd0ff';
  for (const part of parts) part(ctx);
  ctx.restore();
}

function drawLabels(ctx, ob) {
  ctx.font = '700 13px "JetBrains Mono", monospace';
  ctx.textBaseline = 'middle';
  const temp = cToF(ob.temp);
  const dewp = cToF(ob.dewp);
  const pressure = pressureCode(ob.slp);
  const wx = String(ob.wxString || '').split(/\s+/).filter(Boolean).slice(0, 2).join(' ');

  if (temp != null) text(ctx, Math.round(temp), -12, -12, 'right', '#ff6a6a');
  if (dewp != null) text(ctx, Math.round(dewp), -12, 14, 'right', '#57d98a');
  if (pressure) text(ctx, pressure, 12, -12, 'left', '#d8e4f8', 12);
  if (wx) text(ctx, wx.slice(0, 7), -12, 1, 'right', '#c79bff', 10);
}

function text(ctx, value, x, y, align, fill, size = 13) {
  ctx.save();
  ctx.font = `700 ${size}px "JetBrains Mono", monospace`;
  ctx.textAlign = align;
  ctx.lineWidth = 4;
  ctx.strokeStyle = 'rgba(5, 12, 27, 0.96)';
  ctx.strokeText(String(value), x, y);
  ctx.fillStyle = fill;
  ctx.fillText(String(value), x, y);
  ctx.restore();
}

function haloStroke(ctx, draw, width, stroke) {
  ctx.save();
  ctx.lineWidth = width + 3.4;
  ctx.strokeStyle = 'rgba(4, 10, 24, 0.95)';
  draw();
  ctx.lineWidth = width;
  ctx.strokeStyle = stroke;
  draw();
  ctx.restore();
}
