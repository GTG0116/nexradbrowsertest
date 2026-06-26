// metars.js — live surface observations (METARs) drawn as classic station plots.
//
// Source: the Iowa Environmental Mesonet (IEM) current-observations API. We
// switched off aviationweather.gov because it serves no Access-Control-Allow-
// Origin header, so browser fetches were blocked by CORS; IEM responds with
// `access-control-allow-origin: *` and is already this app's radar feed. IEM
// has no bbox query, so we map the visible view to the networks it covers and
// pull each one, then filter to the view client-side:
//   • inside the US, the per-state `{ST}_ASOS` networks (fine-grained), and
//   • elsewhere in the world, IEM's per-country `{ISO2}__ASOS` networks
//     (note the *double* underscore) — e.g. GB__ASOS, FR__ASOS, JP__ASOS —
//     so international stations plot too, all from the one CORS-enabled feed.
//
// Only the stations inside the current view are kept, the marker set is diffed
// each refresh (so plots vanish as they leave frame), and a hard cap thins dense
// regions to the stations nearest the view centre — so the screen stays readable
// however far you zoom out.
//
// Each station renders as a WMO station-model plot: a sky-cover circle with the
// temperature (upper-left, °F), dewpoint (lower-left, °F), sea-level pressure
// (upper-right, coded) and a wind barb. Plots are HTML markers (mapboxgl.Marker)
// so they stay crisp and sit above the radar without touching the WebGL stack.
//
// Toggled off by default; only fetches while enabled and only for the current
// view, refetching (debounced) on pan/zoom and on a slow timer.

const IEM_URL = 'https://mesonet.agron.iastate.edu/api/1/currents.json';
// Drop observations older than this (minutes) so a stale ASOS doesn't mislead.
const MAX_AGE_MIN = 150;
// Cap how many networks one view fans out to (a tight view spans 1–3 states or
// countries; a zoomed-out view over Europe can clip a dozen, so allow a few more).
const MAX_NETWORKS = 10;
const REFRESH_MS = 5 * 60 * 1000;
// Below this zoom the plots would overlap into mush, so we hide them and show a
// hint instead of fetching the whole country.
const MIN_ZOOM = 6.5;
// Hard cap on plotted stations so a dense region can't spawn thousands of DOM
// nodes.
const MAX_STATIONS = 400;

const cToF = (c) => (c * 9) / 5 + 32;
const fToC = (f) => (f == null || Number.isNaN(f) ? null : ((f - 32) * 5) / 9);
const IN_HG_TO_HPA = 33.8639;

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
  const L = 22; // staff length
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
  const barbLen = 8;
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
  const r = 6;
  const tF = ob.temp != null ? Math.round(cToF(ob.temp)) : null;
  const dF = ob.dewp != null ? Math.round(cToF(ob.dewp)) : null;
  // Coded pressure group uses sea-level pressure (hPa); skip it when absent.
  const code = pressureCode(ob.slp);
  const oktas = maxCover(ob.clouds);
  // Variable ('VRB') or missing direction → no staff; windBarb guards on null.
  const dir = ob.wdir == null || ob.wdir === 'VRB' ? null : Number(ob.wdir);
  const barb = windBarb(dir, Number(ob.wspd), r);

  const tTxt = tF == null ? '' : `<text x="-9" y="-6" text-anchor="end" class="mp-t">${tF}</text>`;
  const dTxt = dF == null ? '' : `<text x="-9" y="12" text-anchor="end" class="mp-d">${dF}</text>`;
  const pTxt = code ? `<text x="9" y="-6" text-anchor="start" class="mp-p">${code}</text>` : '';
  const wx = ob.wxString ? `<text x="-9" y="3" text-anchor="end" class="mp-w">${ob.wxString.slice(0, 4)}</text>` : '';

  return `<svg width="70" height="50" viewBox="-35 -25 70 50" class="metar-plot-svg" overflow="visible">
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
    const view = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]; // W,S,E,N
    const networks = networksInView(view).slice(0, MAX_NETWORKS);
    if (!networks.length) {
      this.clearMarkers();
      if (this.onStatus) this.onStatus('no surface obs in view');
      return;
    }
    const seq = ++this._seq;
    try {
      // One request per network; tolerate individual failures (a network may
      // briefly 5xx) as long as at least one returns.
      const settled = await Promise.allSettled(networks.map((net) => fetchNetworkObs(net)));
      if (seq !== this._seq || !this.enabled) return;
      const ok = settled.filter((s) => s.status === 'fulfilled');
      if (!ok.length) throw new Error('all state requests failed');

      const seen = new Set();
      const obs = [];
      for (const s of ok) {
        for (const rec of s.value) {
          if (rec.lat == null || rec.lon == null) continue;
          // Keep only stations inside the current view.
          if (rec.lon < view[0] || rec.lon > view[2] || rec.lat < view[1] || rec.lat > view[3]) continue;
          const id = rec.station;
          if (id && seen.has(id)) continue;
          if (id) seen.add(id);
          obs.push(normalizeIem(rec));
        }
      }
      this.obs = obs;
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

// ---- IEM source helpers --------------------------------------------------

// Fetch one IEM network's current obs. `net` is the fully-qualified network name
// (e.g. `OK_ASOS` for a US state, `FR__ASOS` for a country) so this works for the
// US and international networks alike.
async function fetchNetworkObs(net) {
  const url = `${IEM_URL}?network=${net}&minutes=${MAX_AGE_MIN}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return (json && Array.isArray(json.data)) ? json.data : [];
}

// Up to four reported cloud layers → [{ cover }] for maxCover().
function cloudsFrom(rec) {
  const out = [];
  for (const k of ['skyc1', 'skyc2', 'skyc3', 'skyc4']) {
    if (rec[k]) out.push({ cover: rec[k] });
  }
  return out;
}

// IEM current-obs record → the `ob` shape the station-plot renderer expects
// (temps in °C, pressure in hPa, wind in knots).
function normalizeIem(rec) {
  // Prefer reported MSLP; fall back to the altimeter setting (QNH, already
  // sea-level-reduced) converted to hPa so the coded pressure group still shows.
  const slp = rec.mslp != null ? rec.mslp
    : (rec.alti != null ? rec.alti * IN_HG_TO_HPA : null);
  return {
    icaoId: rec.station,
    lat: rec.lat,
    lon: rec.lon,
    temp: fToC(rec.tmpf),
    dewp: fToC(rec.dwpf),
    slp,
    clouds: cloudsFrom(rec),
    wdir: rec.drct,          // numeric degrees, or null when variable/missing
    wspd: rec.sknt,          // knots
    wxString: rec.wxcodes || '',
    rawOb: rec.raw || rec.station,
  };
}

// IEM networks whose bounding box intersects the view [W,S,E,N], ordered by
// proximity of the box centre to the view centre so the MAX_NETWORKS cap keeps
// the most relevant ones. US states map to `{ST}_ASOS`; world countries map to
// `{ISO2}__ASOS` (double underscore — IEM's international convention).
function networksInView(view) {
  const [w, s, e, n] = view;
  const cx = (w + e) / 2;
  const cy = (s + n) / 2;
  const hits = [];
  const consider = (box, net) => {
    const [bw, bs, be, bn] = box;
    if (be < w || bw > e || bn < s || bs > n) return; // no overlap
    const dx = (bw + be) / 2 - cx;
    const dy = (bs + bn) / 2 - cy;
    hits.push({ net, d: dx * dx + dy * dy });
  };
  for (const st in STATE_BBOX) consider(STATE_BBOX[st], `${st}_ASOS`);
  for (const cc in COUNTRY_BBOX) consider(COUNTRY_BBOX[cc], `${cc}__ASOS`);
  return hits.sort((a, b) => a.d - b.d).map((h) => h.net);
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
