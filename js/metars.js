// metars.js — live surface observations (METARs) drawn as classic station plots.
//
// Pulls current METARs from the public aviationweather.gov data API (CORS
// enabled) for whatever the map currently shows, and renders each as a WMO
// station-model plot: a sky-cover circle with the temperature (upper-left, °F),
// dewpoint (lower-left, °F), sea-level pressure (upper-right, coded) and a wind
// barb. Plots are HTML markers (mapboxgl.Marker) so they stay crisp and sit
// above the radar without touching the WebGL layer stack.
//
// Toggled off by default; only fetches while enabled and only for the current
// view, refetching (debounced) on pan/zoom and on a slow timer.

const METAR_URL = 'https://aviationweather.gov/api/data/metar';
const REFRESH_MS = 5 * 60 * 1000;
// Below this zoom the plots would overlap into mush, so we hide them and show a
// hint instead of fetching the whole country.
const MIN_ZOOM = 6.5;
// Hard cap on plotted stations so a dense region can't spawn thousands of DOM
// nodes.
const MAX_STATIONS = 400;

const cToF = (c) => (c * 9) / 5 + 32;

// Eighths of sky covered, by METAR cloud-cover token, for the station circle.
const COVER_OKTAS = { SKC: 0, CLR: 0, CAVOK: 0, NSC: 0, FEW: 2, SCT: 4, BKN: 6, OVC: 8, OVX: 8 };

function maxCover(clouds) {
  if (!clouds || !clouds.length) return null;
  let best = 0;
  let seen = false;
  for (const c of clouds) {
    const o = COVER_OKTAS[c.cover];
    if (o == null) continue;
    seen = true;
    if (o > best) best = o;
  }
  return seen ? best : null;
}

// The filled-circle glyph for N eighths of sky cover, drawn in a 0,0-centred
// SVG with radius r. Returns an SVG fragment string.
function skyGlyph(oktas, r) {
  const ring = `<circle cx="0" cy="0" r="${r}" fill="none" stroke="#dfeaff" stroke-width="1.4"/>`;
  if (oktas == null) // missing → cross-hatch (sky obscured / unknown)
    return ring + `<line x1="${-r}" y1="0" x2="${r}" y2="0" stroke="#dfeaff" stroke-width="1.2"/>`;
  const f = '#dfeaff';
  switch (oktas) {
    case 0:
      return ring;
    case 1:
    case 2:
      return ring + `<line x1="0" y1="0" x2="0" y2="${-r}" stroke="${f}" stroke-width="1.4"/>`;
    case 3:
    case 4: // half (right)
      return ring + `<path d="M0,${-r} A${r},${r} 0 0 1 0,${r} Z" fill="${f}"/>`;
    case 5:
    case 6: // three quarters
      return ring + `<path d="M0,${-r} A${r},${r} 0 1 1 0,${r} Z" fill="${f}"/>` +
        `<path d="M0,${-r} A${r},${r} 0 0 1 0,${r} Z" fill="${f}"/>`;
    case 7:
      return ring + `<circle cx="0" cy="0" r="${r}" fill="${f}"/>` +
        `<line x1="0" y1="${-r}" x2="0" y2="${r}" stroke="#0a1426" stroke-width="1.4"/>`;
    default: // 8 = overcast
      return ring + `<circle cx="0" cy="0" r="${r}" fill="${f}"/>`;
  }
}

// Wind-barb staff + barbs for a speed in knots, blowing FROM `dir` degrees.
// Drawn from the station circle outward toward the source direction, barbs on
// the trailing side — the standard NH convention.
function windBarb(dir, kt, r) {
  if (dir == null || kt == null || Number.isNaN(dir) || Number.isNaN(kt)) return '';
  if (kt < 1) // calm: a ring around the circle
    return `<circle cx="0" cy="0" r="${r + 3}" fill="none" stroke="#9fd0ff" stroke-width="1"/>`;
  const L = 26; // staff length
  const rad = (dir * Math.PI) / 180;
  // Unit vector pointing toward the source (where the wind comes from).
  const ux = Math.sin(rad);
  const uy = -Math.cos(rad);
  const sx = ux * r;
  const sy = uy * r;
  const ex = ux * (r + L);
  const ey = uy * (r + L);
  // Perpendicular (barb) direction — to the left of the staff.
  const px = -uy;
  const py = ux;

  let speed = Math.round(kt / 5) * 5;
  const parts = [`<line x1="${sx.toFixed(1)}" y1="${sy.toFixed(1)}" x2="${ex.toFixed(1)}" y2="${ey.toFixed(1)}" stroke="#9fd0ff" stroke-width="1.4"/>`];
  // Walk inward from the outer end placing pennants/full/half barbs.
  let t = r + L; // distance along the staff from the circle centre
  const step = 5;
  const barbLen = 9;
  const place = () => ({ x: ux * t, y: uy * t });
  const pennants = Math.floor(speed / 50); speed -= pennants * 50;
  const fulls = Math.floor(speed / 10); speed -= fulls * 10;
  const halves = Math.floor(speed / 5);

  for (let i = 0; i < pennants; i++) {
    const a = place(); t -= step * 1.5; const b = place();
    parts.push(`<path d="M${a.x.toFixed(1)},${a.y.toFixed(1)} L${(a.x + px * barbLen).toFixed(1)},${(a.y + py * barbLen).toFixed(1)} L${b.x.toFixed(1)},${b.y.toFixed(1)} Z" fill="#9fd0ff"/>`);
  }
  if (pennants) t -= step * 0.4;
  for (let i = 0; i < fulls; i++) {
    const a = place();
    parts.push(`<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${(a.x + px * barbLen).toFixed(1)}" y2="${(a.y + py * barbLen).toFixed(1)}" stroke="#9fd0ff" stroke-width="1.4"/>`);
    t -= step;
  }
  for (let i = 0; i < halves; i++) {
    if (t >= r + L - 0.1) t -= step; // keep a half-barb off the very tip
    const a = place();
    parts.push(`<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${(a.x + px * barbLen * 0.5).toFixed(1)}" y2="${(a.y + py * barbLen * 0.5).toFixed(1)}" stroke="#9fd0ff" stroke-width="1.4"/>`);
    t -= step;
  }
  return parts.join('');
}

// Sea-level pressure → the 3-digit coded group (tens, units, tenths of hPa).
function pressureCode(slp) {
  if (slp == null || Number.isNaN(slp)) return '';
  const x = Math.round(slp * 10) % 1000;
  return String(x).padStart(3, '0');
}

// Build the full station-plot SVG for one observation.
function plotSVG(ob) {
  const r = 7;
  const tF = ob.temp != null ? Math.round(cToF(ob.temp)) : null;
  const dF = ob.dewp != null ? Math.round(cToF(ob.dewp)) : null;
  // Coded pressure group uses sea-level pressure (hPa); skip it when absent.
  const code = pressureCode(ob.slp);
  const oktas = maxCover(ob.clouds);
  const barb = windBarb(ob.wdir === 'VRB' ? null : Number(ob.wdir), Number(ob.wspd), r);

  const tTxt = tF == null ? '' : `<text x="-11" y="-7" text-anchor="end" class="mp-t">${tF}</text>`;
  const dTxt = dF == null ? '' : `<text x="-11" y="13" text-anchor="end" class="mp-d">${dF}</text>`;
  const pTxt = code ? `<text x="11" y="-7" text-anchor="start" class="mp-p">${code}</text>` : '';
  const wx = ob.wxString ? `<text x="-11" y="3" text-anchor="end" class="mp-w">${ob.wxString.slice(0, 4)}</text>` : '';

  return `<svg width="80" height="56" viewBox="-40 -28 80 56" class="metar-plot-svg" overflow="visible">
    ${barb}
    <g>${skyGlyph(oktas, r)}</g>
    ${tTxt}${dTxt}${pTxt}${wx}
  </svg>`;
}

export class MetarController {
  constructor(map) {
    this.map = map;
    this.enabled = false;
    this.markers = new Map(); // icaoId → mapboxgl.Marker
    this.obs = [];
    this._timer = null;
    this._debounce = null;
    this._seq = 0;

    map.on('moveend', () => {
      if (!this.enabled) return;
      clearTimeout(this._debounce);
      this._debounce = setTimeout(() => this.refresh(), 250);
    });
  }

  setEnabled(on) {
    this.enabled = on;
    if (on) {
      this.refresh();
      this._timer = setInterval(() => this.enabled && this.refresh(), REFRESH_MS);
    } else {
      clearInterval(this._timer);
      this._timer = null;
      this.clearMarkers();
    }
    return this.enabled;
  }

  clearMarkers() {
    for (const m of this.markers.values()) m.remove();
    this.markers.clear();
  }

  async refresh() {
    if (!this.enabled || !this.map.getBounds) return;
    const z = this.map.getZoom();
    if (z < MIN_ZOOM) {
      this.clearMarkers();
      this._status = 'zoom in to load surface observations';
      if (this.onStatus) this.onStatus(this._status);
      return;
    }
    const b = this.map.getBounds();
    const bbox = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()]
      .map((v) => v.toFixed(2)).join(',');
    const url = `${METAR_URL}?format=json&bbox=${bbox}`;
    const seq = ++this._seq;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (seq !== this._seq || !this.enabled) return;
      this.obs = Array.isArray(data) ? data : [];
      this.render();
      if (this.onStatus) this.onStatus(`${this.markers.size} METARs`);
    } catch (e) {
      if (seq !== this._seq) return;
      console.error('metar load failed', e);
      if (this.onStatus) this.onStatus('METARs unavailable');
    }
  }

  render() {
    // Thin to the strongest-signal stations if a region is dense: keep those
    // closest to the view centre so the screen stays readable.
    let obs = this.obs.filter((o) => o.lat != null && o.lon != null);
    if (obs.length > MAX_STATIONS) {
      const c = this.map.getCenter();
      obs = obs
        .map((o) => ({ o, d: (o.lat - c.lat) ** 2 + (o.lon - c.lng) ** 2 }))
        .sort((a, b) => a.d - b.d)
        .slice(0, MAX_STATIONS)
        .map((x) => x.o);
    }
    const keep = new Set();
    for (const ob of obs) {
      const id = ob.icaoId || `${ob.lat},${ob.lon}`;
      keep.add(id);
      let mk = this.markers.get(id);
      if (!mk) {
        const elm = document.createElement('div');
        elm.className = 'metar-plot';
        elm.title = ob.rawOb || id;
        mk = new mapboxgl.Marker({ element: elm, anchor: 'center' })
          .setLngLat([ob.lon, ob.lat])
          .addTo(this.map);
        this.markers.set(id, mk);
      }
      mk.getElement().innerHTML = plotSVG(ob);
    }
    for (const [id, mk] of this.markers) {
      if (!keep.has(id)) { mk.remove(); this.markers.delete(id); }
    }
  }
}
