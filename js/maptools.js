// maptools.js — interactive map tools that draw onto the radar scope:
//   • Draw     — freehand annotation paths (drag to sketch).
//   • Measure  — click vertices to measure great-circle distance and area.
//   • Storm track — mark a storm's position and heading, project its path
//     forward, and label the towns in its path with ETAs (town names from the
//     public api.weather.gov point endpoint).
//
// All committed geometry lives in one GeoJSON source ('mt-shapes') with fill,
// line and vertex layers added on top of the basemap. Text (distances, ETAs)
// is rendered as HTML markers so we don't depend on a particular style's glyph
// set. The committed geometry is exposed via getFeatureCollection()/onChange so
// the split-screen panel can mirror it.

const R_EARTH = 6371008.8; // mean Earth radius, metres
const M_TO_MI = 0.000621371;
const M_TO_KM = 0.001;

function toRad(d) { return (d * Math.PI) / 180; }

export function haversine(a, b) {
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const la1 = toRad(a[1]);
  const la2 = toRad(b[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(h));
}

// Initial bearing from a→b, degrees clockwise from north.
function bearing(a, b) {
  const la1 = toRad(a[1]), la2 = toRad(b[1]);
  const dLon = toRad(b[0] - a[0]);
  const y = Math.sin(dLon) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180) / Math.PI;
}

// Point `distM` metres from `origin` along `brngDeg` (great-circle).
function destination(origin, brngDeg, distM) {
  const d = distM / R_EARTH;
  const br = toRad(brngDeg);
  const la1 = toRad(origin[1]), lo1 = toRad(origin[0]);
  const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(br));
  const lo2 = lo1 + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la2));
  return [((lo2 * 180) / Math.PI + 540) % 360 - 180, (la2 * 180) / Math.PI];
}

// Spherical polygon area in m² (positive), via the spherical-excess formula.
function ringArea(coords) {
  if (coords.length < 3) return 0;
  let total = 0;
  for (let i = 0; i < coords.length; i++) {
    const p1 = coords[i];
    const p2 = coords[(i + 1) % coords.length];
    total += toRad(p2[0] - p1[0]) * (2 + Math.sin(toRad(p1[1])) + Math.sin(toRad(p2[1])));
  }
  return Math.abs((total * R_EARTH * R_EARTH) / 2);
}

function fmtDist(m) {
  const mi = m * M_TO_MI;
  const km = m * M_TO_KM;
  if (mi < 0.2) return `${Math.round(m * 3.28084)} ft · ${Math.round(m)} m`;
  return `${mi.toFixed(mi < 10 ? 2 : 1)} mi · ${km.toFixed(km < 10 ? 2 : 1)} km`;
}

function fmtArea(m2) {
  const mi2 = m2 * 3.861e-7;
  const km2 = m2 * 1e-6;
  return `${mi2.toFixed(mi2 < 10 ? 2 : 1)} mi² · ${km2.toFixed(km2 < 10 ? 1 : 0)} km²`;
}

const bgColor = { draw: '#36e0c8', measure: '#ffd54a', storm: '#ff5a7a' };

export class MapTools {
  constructor(map) {
    this.map = map;
    this.tool = null;
    this.shapes = []; // committed GeoJSON features
    this.labelMarkers = []; // committed HTML label markers
    this.draft = null; // in-progress geometry { kind, coords }
    this.draftMarkers = [];
    this.onChange = null;
    this.onToolEnd = null;
    this.stormSpeed = 30; // mph
    this.stormMinutes = 60;
    this._storm = null; // { a, b }

    this._setup();
    map.on('style.load', () => this._setup());

    this._bindPointer();
  }

  _setup() {
    const map = this.map;
    // Sources/layers can only be added once the style is loaded; the style.load
    // handler re-runs this after the initial load and any basemap switch.
    if (!map.isStyleLoaded || !map.isStyleLoaded()) return;
    if (!map.getSource('mt-shapes'))
      map.addSource('mt-shapes', { type: 'geojson', data: this._fc() });
    const add = (layer) => { if (!map.getLayer(layer.id)) map.addLayer(layer); };
    add({
      id: 'mt-fill', type: 'fill', source: 'mt-shapes',
      filter: ['==', ['geometry-type'], 'Polygon'],
      paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.12 },
    });
    // Two line layers: line-dasharray is a data-CONSTANT property in Mapbox GL
    // (no `['get', …]` support), so a per-feature dash expression silently fails
    // to validate and the whole line layer never gets added — which is why
    // drawing/measuring showed nothing. Split solid vs. dashed into two layers,
    // each with a constant dasharray, keyed off the feature's `dashed` flag.
    add({
      id: 'mt-line', type: 'line', source: 'mt-shapes',
      filter: ['all', ['!=', ['geometry-type'], 'Point'], ['!=', ['get', 'dashed'], true]],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['get', 'color'],
        'line-width': ['case', ['==', ['get', 'kind'], 'storm'], 3, 2.4],
        'line-opacity': 0.95,
      },
    });
    add({
      id: 'mt-line-dash', type: 'line', source: 'mt-shapes',
      filter: ['all', ['!=', ['geometry-type'], 'Point'], ['==', ['get', 'dashed'], true]],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['get', 'color'],
        'line-width': ['case', ['==', ['get', 'kind'], 'storm'], 3, 2.4],
        'line-dasharray': [2, 1.6],
        'line-opacity': 0.95,
      },
    });
    add({
      id: 'mt-vertex', type: 'circle', source: 'mt-shapes',
      filter: ['==', ['geometry-type'], 'Point'],
      paint: {
        'circle-radius': ['case', ['==', ['get', 'role'], 'storm-pos'], 6, 4],
        'circle-color': ['get', 'color'],
        'circle-stroke-color': '#06101f',
        'circle-stroke-width': 1.5,
      },
    });
    this._refresh();
  }

  _fc() {
    // Committed shapes plus any in-progress draft, so edits show live.
    const feats = [...this.shapes];
    if (this.draft && this.draft.coords.length) feats.push(...this._draftFeatures());
    return { type: 'FeatureCollection', features: feats };
  }

  _draftFeatures() {
    const d = this.draft;
    const color = bgColor[d.kind] || '#36e0c8';
    const out = [];
    if (d.coords.length >= 2) {
      out.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: d.coords },
        properties: { kind: d.kind, color, dashed: d.kind === 'storm' },
      });
    }
    for (const c of d.coords)
      out.push({ type: 'Feature', geometry: { type: 'Point', coordinates: c }, properties: { kind: d.kind, color, role: 'vertex' } });
    return out;
  }

  _refresh() {
    const src = this.map.getSource && this.map.getSource('mt-shapes');
    if (src) src.setData(this._fc());
  }

  // ---- Public FeatureCollection (committed only) for the split mirror ----
  getFeatureCollection() {
    return { type: 'FeatureCollection', features: this.shapes };
  }

  _emit() {
    this._refresh();
    if (this.onChange) this.onChange(this.getFeatureCollection());
  }

  // ---- Tool activation ----
  setTool(tool) {
    if (this.tool === tool) tool = null; // toggle off
    this._cancelDraft();
    this.tool = tool;
    const canvas = this.map.getCanvas();
    canvas.style.cursor = tool ? 'crosshair' : '';
    // Freehand draw needs full pointer control; the click tools keep the map
    // interactive but suppress double-click zoom while finishing a shape.
    if (tool === 'draw') this.map.dragPan.disable();
    else this.map.dragPan.enable();
    if (tool) this.map.doubleClickZoom.disable();
    else this.map.doubleClickZoom.enable();
    if (tool === 'storm') this._startStorm();
    return this.tool;
  }

  clearAll() {
    this.shapes = [];
    for (const m of this.labelMarkers) m.remove();
    this.labelMarkers = [];
    this._cancelDraft();
    this._emit();
  }

  _cancelDraft() {
    this.draft = null;
    for (const m of this.draftMarkers) m.remove();
    this.draftMarkers = [];
    this._storm = null;
    if (this._stormPanel) { this._stormPanel.remove(); this._stormPanel = null; }
    this._refresh();
  }

  // ---- Pointer plumbing (mouse + touch unified) ----
  _bindPointer() {
    const map = this.map;
    let drawing = false;

    map.on('mousedown', (e) => {
      if (this.tool !== 'draw') return;
      drawing = true;
      this.draft = { kind: 'draw', coords: [[e.lngLat.lng, e.lngLat.lat]] };
    });
    map.on('mousemove', (e) => {
      if (this.tool !== 'draw' || !drawing) return;
      this.draft.coords.push([e.lngLat.lng, e.lngLat.lat]);
      this._refresh();
    });
    map.on('mouseup', () => {
      if (this.tool !== 'draw' || !drawing) return;
      drawing = false;
      this._commitDraft();
    });

    // Touch: freehand draw on the canvas directly so we get every move.
    const canvas = map.getCanvas();
    let touchDrawing = false;
    const llFromTouch = (t) => {
      const rect = canvas.getBoundingClientRect();
      return map.unproject([t.clientX - rect.left, t.clientY - rect.top]);
    };
    canvas.addEventListener('touchstart', (e) => {
      if (this.tool !== 'draw' || e.touches.length !== 1) return;
      e.preventDefault();
      touchDrawing = true;
      const ll = llFromTouch(e.touches[0]);
      this.draft = { kind: 'draw', coords: [[ll.lng, ll.lat]] };
    }, { passive: false });
    canvas.addEventListener('touchmove', (e) => {
      if (this.tool !== 'draw' || !touchDrawing) return;
      e.preventDefault();
      const ll = llFromTouch(e.touches[0]);
      this.draft.coords.push([ll.lng, ll.lat]);
      this._refresh();
    }, { passive: false });
    canvas.addEventListener('touchend', () => {
      if (this.tool !== 'draw' || !touchDrawing) return;
      touchDrawing = false;
      this._commitDraft();
    });

    // Click tools: measure + storm vertices.
    map.on('click', (e) => {
      const pt = [e.lngLat.lng, e.lngLat.lat];
      if (this.tool === 'measure') this._measureClick(pt);
      else if (this.tool === 'storm') this._stormClick(pt);
    });
    map.on('dblclick', (e) => {
      if (this.tool === 'measure' && this.draft) {
        e.preventDefault();
        this._commitMeasure();
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.tool) {
        if (this.draft) this._cancelDraft();
        else this.setTool(null);
        if (this.onToolEnd) this.onToolEnd();
      } else if (e.key === 'Enter' && this.tool === 'measure' && this.draft) {
        this._commitMeasure();
      }
    });
  }

  // ---- Draw ----
  _commitDraft() {
    if (!this.draft || this.draft.coords.length < 2) { this._cancelDraft(); return; }
    this.shapes.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: this.draft.coords },
      properties: { kind: 'draw', color: bgColor.draw },
    });
    this.draft = null;
    this._emit();
  }

  // ---- Measure ----
  _measureClick(pt) {
    if (!this.draft) this.draft = { kind: 'measure', coords: [] };
    this.draft.coords.push(pt);
    this._renderMeasureLabels();
    this._refresh();
  }

  _renderMeasureLabels() {
    for (const m of this.draftMarkers) m.remove();
    this.draftMarkers = [];
    const coords = this.draft.coords;
    let cum = 0;
    for (let i = 0; i < coords.length; i++) {
      if (i > 0) cum += haversine(coords[i - 1], coords[i]);
      if (i === coords.length - 1) {
        const txt = coords.length === 1 ? 'click to measure' : fmtDist(cum);
        this.draftMarkers.push(this._label(coords[i], txt, 'measure'));
      }
    }
    if (coords.length >= 3) {
      const area = ringArea(coords);
      const c = centroid(coords);
      this.draftMarkers.push(this._label(c, fmtArea(area), 'measure', true));
    }
  }

  _commitMeasure() {
    if (!this.draft || this.draft.coords.length < 2) { this._cancelDraft(); return; }
    const coords = this.draft.coords;
    let total = 0;
    for (let i = 1; i < coords.length; i++) total += haversine(coords[i - 1], coords[i]);
    this.shapes.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: coords },
      properties: { kind: 'measure', color: bgColor.measure },
    });
    for (const c of coords)
      this.shapes.push({ type: 'Feature', geometry: { type: 'Point', coordinates: c }, properties: { kind: 'measure', color: bgColor.measure, role: 'vertex' } });
    // Promote the live labels to committed markers.
    const last = coords[coords.length - 1];
    this.labelMarkers.push(this._label(last, fmtDist(total), 'measure'));
    if (coords.length >= 3)
      this.labelMarkers.push(this._label(centroid(coords), fmtArea(ringArea(coords)), 'measure', true));
    for (const m of this.draftMarkers) m.remove();
    this.draftMarkers = [];
    this.draft = null;
    this._emit();
    this.setTool(null);
    if (this.onToolEnd) this.onToolEnd();
  }

  // ---- Storm track ----
  _startStorm() {
    this._storm = { a: null, b: null };
    this._showStormPanel('Click the storm’s current location.');
  }

  _stormClick(pt) {
    if (!this._storm) this._storm = { a: null, b: null };
    if (!this._storm.a) {
      this._storm.a = pt;
      this.draft = { kind: 'storm', coords: [pt] };
      this._showStormPanel('Now click a point in the direction the storm is moving.');
      this._refresh();
    } else if (!this._storm.b) {
      this._storm.b = pt;
      this.draft = { kind: 'storm', coords: [this._storm.a, pt] };
      this._refresh();
      this._buildStormTrack();
    }
  }

  async _buildStormTrack() {
    const { a, b } = this._storm;
    this._lastStorm = { a, b }; // remember so speed/time edits can re-plot
    const brng = bearing(a, b);
    const speedMph = this.stormSpeed;
    const minutes = this.stormMinutes;
    const speedMs = speedMph * 0.44704;
    const totalM = speedMs * minutes * 60;
    const end = destination(a, brng, totalM);

    // Forecast cone — a wedge that widens with lead time to convey positional
    // uncertainty (like an NHC/SPC track cone). Drawn first so the track line
    // and ticks sit on top of its translucent fill.
    this.shapes.push({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [coneRing(a, brng, totalM)] },
      properties: { kind: 'storm', color: bgColor.storm, dashed: true, role: 'cone' },
    });

    // Track line (origin → forecast end), dashed.
    const trackCoords = [a, end];
    this.shapes.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: trackCoords },
      properties: { kind: 'storm', color: bgColor.storm, dashed: true },
    });
    // Storm position marker.
    this.shapes.push({ type: 'Feature', geometry: { type: 'Point', coordinates: a }, properties: { kind: 'storm', color: bgColor.storm, role: 'storm-pos' } });

    // Tick marks + town lookups every 15 minutes along the path.
    const stepMin = 15;
    const now = Date.now();
    const labels = [];
    for (let t = stepMin; t <= minutes; t += stepMin) {
      const p = destination(a, brng, speedMs * t * 60);
      this.shapes.push({ type: 'Feature', geometry: { type: 'Point', coordinates: p }, properties: { kind: 'storm', color: bgColor.storm, role: 'vertex' } });
      const eta = new Date(now + t * 60000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      labels.push({ p, t, eta });
    }
    this._cleanupStormDraft();
    this._emit();
    this._showStormPanel(`Heading ${compass(brng)} at ${speedMph} mph — locating towns…`);

    // Look up the nearest town for each tick via the weather.gov point API.
    for (const lab of labels) {
      let town = '';
      try { town = await nearestTown(lab.p); } catch (_) { /* keep ETA only */ }
      const text = town ? `${town}\n+${lab.t}m · ${lab.eta}` : `+${lab.t}m · ${lab.eta}`;
      this.labelMarkers.push(this._label(lab.p, text, 'storm'));
    }
    this._showStormPanel(`Track plotted · ${compass(brng)} at ${speedMph} mph. Adjust speed/time or click ✕ to finish.`, true);
  }

  _cleanupStormDraft() {
    this.draft = null;
    for (const m of this.draftMarkers) m.remove();
    this.draftMarkers = [];
    this._storm = null;
  }

  // Floating control for the storm tool: status text + speed/time inputs.
  _showStormPanel(msg, withInputs) {
    if (!this._stormPanel) {
      const div = document.createElement('div');
      div.className = 'storm-panel';
      this.map.getContainer().appendChild(div);
      this._stormPanel = div;
    }
    const p = this._stormPanel;
    p.innerHTML = `
      <div class="storm-msg">${msg}</div>
      <div class="storm-inputs">
        <label>Speed <input type="number" min="5" max="120" value="${this.stormSpeed}" id="stormSpeed"> mph</label>
        <label>Time <input type="number" min="15" max="180" step="15" value="${this.stormMinutes}" id="stormMin"> min</label>
        <button id="stormReset">Reset</button>
        <button id="stormDone">✕</button>
      </div>`;
    const sp = p.querySelector('#stormSpeed');
    const mn = p.querySelector('#stormMin');
    const recompute = () => {
      this.stormSpeed = Math.max(5, Number(sp.value) || 30);
      this.stormMinutes = Math.max(15, Number(mn.value) || 60);
      // Re-plot if a heading is already defined.
      if (this._storm && this._storm.a && this._storm.b) {
        this._removeStormShapes();
        this._buildStormTrack();
      } else if (this._lastStorm) {
        this._storm = { ...this._lastStorm };
        this._removeStormShapes();
        this._buildStormTrack();
      }
    };
    sp.addEventListener('change', recompute);
    mn.addEventListener('change', recompute);
    p.querySelector('#stormReset').addEventListener('click', () => { this._removeStormShapes(); this._startStorm(); });
    p.querySelector('#stormDone').addEventListener('click', () => { this.setTool(null); if (this.onToolEnd) this.onToolEnd(); });
    if (this._storm && this._storm.a && this._storm.b) this._lastStorm = { ...this._storm };
  }

  // Remove the last-built storm shapes + labels so a recompute replaces them.
  _removeStormShapes() {
    this.shapes = this.shapes.filter((f) => f.properties.kind !== 'storm');
    for (const m of this.labelMarkers.filter((m) => m._kind === 'storm')) m.remove();
    this.labelMarkers = this.labelMarkers.filter((m) => m._kind !== 'storm');
    this._emit();
  }

  // ---- Shared HTML label marker ----
  _label(lngLat, text, kind, faint) {
    const div = document.createElement('div');
    div.className = `mt-label mt-label-${kind}${faint ? ' faint' : ''}`;
    div.textContent = text;
    const mk = new mapboxgl.Marker({ element: div, anchor: 'bottom', offset: [0, -8] })
      .setLngLat(Array.isArray(lngLat) ? lngLat : [lngLat[0], lngLat[1]])
      .addTo(this.map);
    mk._kind = kind;
    return mk;
  }
}

// Forecast-cone ring [lon,lat][] around the storm's projected path: sample
// points along the heading and offset them left/right by a half-width that
// starts at the storm's rough size and grows with distance, then close the
// ring (left edge out, right edge back).
const CONE_BASE_M = 4000; // ~4 km initial half-width
const CONE_SPREAD = 0.28; // half-width grows to ~28% of distance travelled
function coneRing(origin, brngDeg, totalM) {
  const samples = 24;
  const left = [];
  const right = [];
  for (let i = 0; i <= samples; i++) {
    const d = (totalM * i) / samples;
    const p = destination(origin, brngDeg, d);
    const half = CONE_BASE_M + CONE_SPREAD * d;
    left.push(destination(p, brngDeg - 90, half));
    right.push(destination(p, brngDeg + 90, half));
  }
  return [...left, ...right.reverse(), left[0]];
}

function centroid(coords) {
  let x = 0, y = 0;
  for (const c of coords) { x += c[0]; y += c[1]; }
  return [x / coords.length, y / coords.length];
}

function compass(deg) {
  const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return dirs[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
}

// Nearest town for a [lon,lat] point, from the NWS point metadata endpoint
// (relativeLocation gives the closest community + state). CORS-enabled.
const townCache = new Map();
async function nearestTown(pt) {
  const key = `${pt[1].toFixed(3)},${pt[0].toFixed(3)}`;
  if (townCache.has(key)) return townCache.get(key);
  const res = await fetch(`https://api.weather.gov/points/${pt[1].toFixed(4)},${pt[0].toFixed(4)}`, {
    headers: { Accept: 'application/geo+json' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const rl = json.properties && json.properties.relativeLocation;
  const props = rl && rl.properties;
  const town = props ? `${props.city}, ${props.state}` : '';
  townCache.set(key, town);
  return town;
}
