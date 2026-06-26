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

function fmtDist(m) {
  const mi = m * M_TO_MI;
  const km = m * M_TO_KM;
  if (mi < 0.2) return `${Math.round(m * 3.28084)} ft · ${Math.round(m)} m`;
  return `${mi.toFixed(mi < 10 ? 2 : 1)} mi · ${km.toFixed(km < 10 ? 2 : 1)} km`;
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
    this.stormMaxTowns = 20; // cap on town labels in the cone (user-adjustable)
    this._stormSeq = 0; // guards against overlapping async town lookups
    this._storm = null; // { a, b }

    // Add our source/layers now if the style is already up, otherwise on
    // style.load. We must NOT gate the style.load path on isStyleLoaded():
    // inside that event the style spec is parsed (addSource/addLayer work) but
    // pending tile sources can still make isStyleLoaded() report false, which
    // previously made _setup bail permanently — so nothing ever drew.
    if (map.isStyleLoaded && map.isStyleLoaded()) this._setup();
    map.on('style.load', () => this._setup());

    this._bindPointer();
  }

  _setup() {
    const map = this.map;
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
    // Freehand draw and the drag-to-measure both need the pointer (no map pan
    // while the gesture is in progress); the storm click tool keeps the map
    // interactive but suppresses double-click zoom while finishing a shape.
    if (tool === 'draw' || tool === 'measure') this.map.dragPan.disable();
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
    let measuring = false;

    map.on('mousedown', (e) => {
      const pt = [e.lngLat.lng, e.lngLat.lat];
      if (this.tool === 'draw') {
        drawing = true;
        this.draft = { kind: 'draw', coords: [pt] };
      } else if (this.tool === 'measure') {
        // Drag-to-measure: press sets the start, the end follows the pointer.
        measuring = true;
        this.draft = { kind: 'measure', coords: [pt, pt] };
        this._renderMeasureLabels();
        this._refresh();
      }
    });
    map.on('mousemove', (e) => {
      const pt = [e.lngLat.lng, e.lngLat.lat];
      if (this.tool === 'draw' && drawing) {
        this.draft.coords.push(pt);
        this._refresh();
      } else if (this.tool === 'measure' && measuring) {
        this.draft.coords[1] = pt;
        this._renderMeasureLabels();
        this._refresh();
      }
    });
    map.on('mouseup', () => {
      if (this.tool === 'draw' && drawing) {
        drawing = false;
        this._commitDraft();
      } else if (this.tool === 'measure' && measuring) {
        measuring = false;
        this._commitMeasure();
      }
    });

    // Touch: freehand draw and drag-measure on the canvas directly so we get
    // every move (Mapbox swallows touch pans before its own move events).
    const canvas = map.getCanvas();
    let touchDrawing = false;
    let touchMeasuring = false;
    const llFromTouch = (t) => {
      const rect = canvas.getBoundingClientRect();
      return map.unproject([t.clientX - rect.left, t.clientY - rect.top]);
    };
    canvas.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      const ll = llFromTouch(e.touches[0]);
      const pt = [ll.lng, ll.lat];
      if (this.tool === 'draw') {
        e.preventDefault();
        touchDrawing = true;
        this.draft = { kind: 'draw', coords: [pt] };
      } else if (this.tool === 'measure') {
        e.preventDefault();
        touchMeasuring = true;
        this.draft = { kind: 'measure', coords: [pt, pt] };
        this._renderMeasureLabels();
        this._refresh();
      }
    }, { passive: false });
    canvas.addEventListener('touchmove', (e) => {
      const ll = llFromTouch(e.touches[0]);
      const pt = [ll.lng, ll.lat];
      if (this.tool === 'draw' && touchDrawing) {
        e.preventDefault();
        this.draft.coords.push(pt);
        this._refresh();
      } else if (this.tool === 'measure' && touchMeasuring) {
        e.preventDefault();
        this.draft.coords[1] = pt;
        this._renderMeasureLabels();
        this._refresh();
      }
    }, { passive: false });
    canvas.addEventListener('touchend', () => {
      if (this.tool === 'draw' && touchDrawing) {
        touchDrawing = false;
        this._commitDraft();
      } else if (this.tool === 'measure' && touchMeasuring) {
        touchMeasuring = false;
        this._commitMeasure();
      }
    });

    // Storm track still places discrete points by click/tap.
    map.on('click', (e) => {
      const pt = [e.lngLat.lng, e.lngLat.lat];
      if (this.tool === 'storm') this._stormClick(pt);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.tool) {
        if (this.draft) this._cancelDraft();
        else this.setTool(null);
        if (this.onToolEnd) this.onToolEnd();
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

  // ---- Measure (drag: press start → drag → release end) ----
  _renderMeasureLabels() {
    for (const m of this.draftMarkers) m.remove();
    this.draftMarkers = [];
    const coords = this.draft.coords;
    const dist = coords.length >= 2 ? haversine(coords[0], coords[coords.length - 1]) : 0;
    const txt = coords.length < 2 ? 'drag to measure' : fmtDist(dist);
    this.draftMarkers.push(this._label(coords[coords.length - 1], txt, 'measure'));
  }

  _commitMeasure() {
    const coords = this.draft && this.draft.coords;
    // A tap without a drag (start ≈ end) is not a measurement — discard it.
    if (!coords || coords.length < 2 || haversine(coords[0], coords[1]) < 1) {
      this._cancelDraft();
      return;
    }
    const total = haversine(coords[0], coords[coords.length - 1]);
    this.shapes.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: coords.slice() },
      properties: { kind: 'measure', color: bgColor.measure },
    });
    for (const c of coords)
      this.shapes.push({ type: 'Feature', geometry: { type: 'Point', coordinates: c }, properties: { kind: 'measure', color: bgColor.measure, role: 'vertex' } });
    // Promote the live label to a committed marker.
    this.labelMarkers.push(this._label(coords[coords.length - 1], fmtDist(total), 'measure'));
    for (const m of this.draftMarkers) m.remove();
    this.draftMarkers = [];
    this.draft = null;
    this._emit();
    // Stay armed so the user can drag another measurement; toggle the tool off to
    // exit.
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
    const seq = ++this._stormSeq; // invalidate any in-flight town lookup
    const brng = bearing(a, b);
    const speedMph = this.stormSpeed;
    const minutes = this.stormMinutes;
    const speedMs = speedMph * 0.44704;
    const totalM = speedMs * minutes * 60;
    const end = destination(a, brng, totalM);
    const cone = coneRing(a, brng, totalM);

    // Forecast cone — a wedge that widens with lead time to convey positional
    // uncertainty (like an NHC/SPC track cone). Drawn first so the track line
    // and ticks sit on top of its translucent fill.
    this.shapes.push({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [cone] },
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

    // Tick marks every 15 minutes along the centreline, for the time scale.
    const stepMin = 15;
    const now = Date.now();
    for (let t = stepMin; t <= minutes; t += stepMin) {
      const p = destination(a, brng, speedMs * t * 60);
      this.shapes.push({ type: 'Feature', geometry: { type: 'Point', coordinates: p }, properties: { kind: 'storm', color: bgColor.storm, role: 'vertex' } });
    }
    this._cleanupStormDraft();
    this._emit();
    this._showStormPanel(`Heading ${compass(brng)} at ${speedMph} mph — finding towns in the cone…`, true);

    // Flood the cone with every town inside it (not just centreline ticks): pull
    // all populated places in the cone's bbox from OpenStreetMap (Overpass), keep
    // those actually inside the cone polygon, and tag each with the ETA at which
    // the storm passes its closest approach. Sorted by ETA, capped to maxTowns.
    let towns = [];
    try {
      towns = await townsInCone(cone);
    } catch (_) { /* keep the track even if the town service is down */ }
    if (seq !== this._stormSeq) return; // a newer rebuild superseded this one

    const along = projectAlong(a, brng); // → metres along heading
    const scored = [];
    for (const tn of towns) {
      const d = along(tn.lon, tn.lat);
      if (d < -2000 || d > totalM) continue; // behind the storm or past the window
      const tMin = Math.max(0, d / speedMs / 60);
      scored.push({ ...tn, tMin });
    }
    scored.sort((x, y) => x.tMin - y.tMin);
    const shown = scored.slice(0, Math.max(1, this.stormMaxTowns | 0));
    for (const tn of shown) {
      const eta = new Date(now + tn.tMin * 60000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      const text = `${tn.name}\n+${Math.round(tn.tMin)}m · ${eta}`;
      this.labelMarkers.push(this._label([tn.lon, tn.lat], text, 'storm'));
    }
    const note = scored.length > shown.length
      ? `${shown.length} of ${scored.length} towns in cone (raise max to show more)`
      : `${shown.length} town${shown.length === 1 ? '' : 's'} in cone`;
    this._showStormPanel(`Track · ${compass(brng)} at ${speedMph} mph — ${note}.`, true);
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
      <div class="storm-head">
        <span class="storm-dot"></span>
        <span class="storm-kicker">Storm track</span>
        <button id="stormDone" class="storm-x" title="Finish (Esc)">✕</button>
      </div>
      <div class="storm-msg">${msg}</div>
      <div class="storm-inputs">
        <label>Speed <input type="number" min="5" max="120" value="${this.stormSpeed}" id="stormSpeed"> mph</label>
        <label>Time <input type="number" min="15" max="180" step="15" value="${this.stormMinutes}" id="stormMin"> min</label>
        <label>Max towns <input type="number" min="1" max="200" step="1" value="${this.stormMaxTowns}" id="stormMaxTowns"></label>
        <button id="stormReset">Reset</button>
      </div>`;
    const sp = p.querySelector('#stormSpeed');
    const mn = p.querySelector('#stormMin');
    const mx = p.querySelector('#stormMaxTowns');
    const recompute = () => {
      this.stormSpeed = Math.max(5, Number(sp.value) || 30);
      this.stormMinutes = Math.max(15, Number(mn.value) || 60);
      this.stormMaxTowns = Math.min(200, Math.max(1, Number(mx.value) || 20));
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
    mx.addEventListener('change', recompute);
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

function compass(deg) {
  const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return dirs[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
}

// Signed distance (metres) of a point along the storm heading from `origin`,
// using a local equirectangular approximation (good for a few hundred km). Used
// to turn a town's position into the ETA at which the storm reaches it.
function projectAlong(origin, brngDeg) {
  const mPerDegLat = 111320;
  const mPerDegLon = 111320 * Math.cos(toRad(origin[1]));
  const ux = Math.sin(toRad(brngDeg)); // east component of heading
  const uy = Math.cos(toRad(brngDeg)); // north component
  return (lon, lat) => {
    const dx = (lon - origin[0]) * mPerDegLon;
    const dy = (lat - origin[1]) * mPerDegLat;
    return dx * ux + dy * uy;
  };
}

// Ray-casting point-in-polygon for a [lon,lat] ring.
function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const hit = (yi > lat) !== (yj > lat) &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}

// All populated places inside the storm cone, from OpenStreetMap via the public
// Overpass API (CORS-enabled, key-free, global). We query the cone's bounding
// box, then keep only the nodes actually inside the cone polygon. Returns
// [{ name, lat, lon }].
async function townsInCone(coneRingCoords) {
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  for (const [lon, lat] of coneRingCoords) {
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  // Overpass bbox order is (south,west,north,east).
  const bbox = `${minLat},${minLon},${maxLat},${maxLon}`;
  const query = `[out:json][timeout:25];(node["place"~"^(city|town|village)$"]["name"](${bbox}););out body 600;`;
  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'data=' + encodeURIComponent(query),
  });
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
  const json = await res.json();
  const out = [];
  const seen = new Set();
  for (const eln of json.elements || []) {
    const name = eln.tags && eln.tags.name;
    if (!name || eln.lat == null || eln.lon == null) continue;
    if (!pointInRing(eln.lon, eln.lat, coneRingCoords)) continue;
    const key = name + '@' + eln.lat.toFixed(2) + ',' + eln.lon.toFixed(2);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, lat: eln.lat, lon: eln.lon });
  }
  return out;
}
