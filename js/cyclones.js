// cyclones.js — active tropical cyclones overlay (NHC + JTWC).
//
// Two sources, both CORS-enabled (the browser fetches them directly, like every
// other feed in the app):
//
//   • NHC — Atlantic (AL), East Pacific (EP) and Central Pacific (CP) storms
//     from the NOAA ArcGIS tropical MapServer. The official CurrentStorms.json
//     on nhc.noaa.gov sends no Access-Control-Allow-Origin header, so it is
//     unusable from a browser; the MapServer mirrors the same advisories as
//     queryable GeoJSON layers *with* CORS. The service carries 15 fixed storm
//     slots (AT1–AT5, EP1–EP5, CP1–CP5), each a block of 26 layers; an inactive
//     slot's layers simply return zero features. Per slot (index 0–14):
//       forecast points = 6 + 26·slot     forecast track = 7 + 26·slot
//       forecast cone   = 8 + 26·slot     past points   = 11 + 26·slot
//       past track      = 12 + 26·slot
//     Fetch strategy: phase 1 queries all 15 forecast-point layers in parallel
//     (tiny responses — a handful of point features each); slots that answer
//     with features are the active storms. Phase 2 fetches each active storm's
//     cone + forecast track + past track in parallel.
//
//   • JTWC — West Pacific (WP), Indian Ocean (IO) and Southern Hemisphere (SH)
//     typhoons/cyclones from a CORS-safe GitHub mirror of the JTWC advisories.
//     JTWC issues no forecast cone (they publish wind-field radii instead,
//     which we deliberately do NOT draw) — so JTWC storms show the forecast
//     path + current location only. The mirror also repeats any East-Pacific
//     storm NHC already covers; those are filtered out here.
//
// The controller mirrors AlertsController's shape: app.js builds the GL source
// + layers in setupOverlays (style reloads wipe them; reapply() re-pushes the
// data and re-applies the visibility toggles), and this class owns the fetch
// cycle, the master/path/current/cone toggles, the sidebar storm list, and the
// compact preview card a click on a storm opens.

const NHC_BASE =
  'https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather/MapServer';
const JTWC_URL =
  'https://raw.githubusercontent.com/GTG0116/JTWCTyphoonData/refs/heads/claude/jtwc-forecast-viewer-NQqQA/data/storms.json';

// Refresh while the overlay is on. Advisories update every few hours, so a
// several-minute poll is already generous.
const REFRESH_MS = 8 * 60000;

const NHC_SLOTS = 15; // AT1–AT5, EP1–EP5, CP1–CP5
const nhcLayerIds = (slot) => ({
  forecastPoints: 6 + 26 * slot,
  forecastTrack: 7 + 26 * slot,
  forecastCone: 8 + 26 * slot,
  pastPoints: 11 + 26 * slot,
  pastTrack: 12 + 26 * slot,
});

// JTWC basins we draw; EP/CP/AL storms in the mirror are NHC's to show.
const JTWC_BASINS = new Set(['WP', 'IO', 'SH']);

// Saffir-Simpson colours (the palette familiar from track maps): depression,
// storm, then categories 1–5. Keyed off max sustained wind in knots.
export function stormCategory(windKt) {
  const w = Number(windKt) || 0;
  if (w >= 137) return { label: 'Category 5', color: '#ff6060' };
  if (w >= 113) return { label: 'Category 4', color: '#ff8f20' };
  if (w >= 96) return { label: 'Category 3', color: '#ffc140' };
  if (w >= 83) return { label: 'Category 2', color: '#ffe775' };
  if (w >= 64) return { label: 'Category 1', color: '#ffffcc' };
  if (w >= 34) return { label: 'Tropical Storm', color: '#00faf4' };
  return { label: 'Tropical Depression', color: '#5ebaff' };
}

const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'
  );

const KT_TO_MPH = 1.151;

function degToCompass(deg) {
  const dirs = [
    'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
    'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW',
  ];
  return dirs[Math.round(deg / 22.5) % 16];
}

// Unwrap a run of longitudes so consecutive points never jump across the
// antimeridian (a WP track crossing 180° would otherwise draw a line around
// the whole globe). Mapbox renders world copies, so out-of-[-180,180] values
// are fine as long as the run is continuous.
function unwrapLons(coords) {
  if (coords.length < 2) return coords;
  const out = [coords[0].slice()];
  for (let i = 1; i < coords.length; i++) {
    let lon = coords[i][0];
    const prev = out[i - 1][0];
    while (lon - prev > 180) lon -= 360;
    while (lon - prev < -180) lon += 360;
    out.push([lon, coords[i][1]]);
  }
  return out;
}

async function queryNhcLayer(layerId) {
  const url = `${NHC_BASE}/${layerId}/query?where=1%3D1&outFields=*&f=geojson`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`NHC HTTP ${res.status}`);
  const json = await res.json();
  return (json && json.features) || [];
}

// One normalised storm record, whichever agency it came from:
//   { id, agency, basin, name, classLabel, windKt, gustKt, mslp, lat, lon,
//     advisory, motion, cone (geometry|null), trackCoords ([[lon,lat],…]),
//     pastCoords ([[[lon,lat],…],…]), points ([{lon,lat,tau,label,windKt,classLabel}]) }
async function fetchNhcStorms() {
  // Phase 1: probe all 15 slots' forecast-point layers at once.
  const slotFeatures = await Promise.all(
    Array.from({ length: NHC_SLOTS }, (_, slot) =>
      queryNhcLayer(nhcLayerIds(slot).forecastPoints).catch(() => [])
    )
  );
  const active = [];
  slotFeatures.forEach((feats, slot) => {
    if (feats.length) active.push({ slot, feats });
  });

  // Phase 2: pull each active storm's cone / forecast track / past track.
  return Promise.all(
    active.map(async ({ slot, feats }) => {
      const ids = nhcLayerIds(slot);
      const [coneFeats, trackFeats, pastFeats] = await Promise.all([
        queryNhcLayer(ids.forecastCone).catch(() => []),
        queryNhcLayer(ids.forecastTrack).catch(() => []),
        queryNhcLayer(ids.pastTrack).catch(() => []),
      ]);

      const pts = feats
        .filter((f) => f.geometry && f.geometry.type === 'Point')
        .sort((a, b) => (a.properties.tau || 0) - (b.properties.tau || 0));
      const cur = pts[0] || feats[0];
      const p = cur.properties || {};
      const [lon, lat] = cur.geometry.coordinates;

      const points = pts.slice(1).map((f, index) => ({
        index,
        lon: f.geometry.coordinates[0],
        lat: f.geometry.coordinates[1],
        tau: f.properties.tau,
        label: f.properties.datelbl || '',
        windKt: f.properties.maxwind,
        gustKt: f.properties.gust,
        mslp: f.properties.mslp,
        classLabel: f.properties.tcdvlp || '',
        raw: f.properties || {},
      }));

      // Forecast track: join every track feature's coordinates (usually one
      // LineString; MultiLineString shows up on long forecasts).
      const trackCoords = [];
      for (const f of trackFeats) {
        const g = f.geometry;
        if (!g) continue;
        if (g.type === 'LineString') trackCoords.push(...g.coordinates);
        else if (g.type === 'MultiLineString') for (const part of g.coordinates) trackCoords.push(...part);
      }

      // Past track arrives as one feature per intensity segment; keep them as
      // separate runs (they already connect end-to-end).
      const pastCoords = [];
      for (const f of pastFeats) {
        const g = f.geometry;
        if (!g) continue;
        if (g.type === 'LineString') pastCoords.push(unwrapLons(g.coordinates));
        else if (g.type === 'MultiLineString') for (const part of g.coordinates) pastCoords.push(unwrapLons(part));
      }

      const motion =
        p.tcdir != null && p.tcspd != null && p.tcspd > 0
          ? `${degToCompass(p.tcdir)} at ${Math.round(p.tcspd * KT_TO_MPH)} mph`
          : null;

      return {
        id: `nhc:${p.binnumber || 'slot' + slot}`,
        agency: 'NHC',
        basin: p.basin || '—',
        name: p.stormname || 'Tropical cyclone',
        classLabel: p.tcdvlp || stormCategory(p.maxwind).label,
        windKt: p.maxwind,
        gustKt: p.gust,
        mslp: p.mslp,
        lat, lon,
        advisory: p.advdate || null,
        motion,
        cone: coneFeats.length ? coneFeats[0].geometry : null,
        trackCoords: unwrapLons(trackCoords),
        pastCoords,
        points,
      };
    })
  );
}

async function fetchJtwcStorms() {
  const res = await fetch(JTWC_URL);
  if (!res.ok) throw new Error(`JTWC HTTP ${res.status}`);
  const json = await res.json();
  return ((json && json.storms) || [])
    .filter((s) => JTWC_BASINS.has(s.basin))
    .map((s) => {
      const cur = s.current || {};
      const fcst = (s.forecast || []).slice().sort((a, b) => (a.tau || 0) - (b.tau || 0));
      // The path runs current position → every forecast point (tau 0 repeats
      // the current fix; keep it so the line starts at the marker).
      const trackCoords = unwrapLons(
        (fcst.length ? fcst : [{ lat: cur.lat, lon: cur.lon }]).map((f) => [f.lon, f.lat])
      );
      const points = fcst
        .filter((f) => (f.tau || 0) > 0)
        .map((f, index) => ({
          index,
          lon: f.lon,
          lat: f.lat,
          tau: f.tau,
          label: f.datetime ? f.datetime.replace('T', ' ').replace(':00Z', 'Z') : `+${f.tau}h`,
          windKt: f.wind_kt,
          gustKt: f.gust_kt,
          mslp: f.pressure_mb,
          classLabel: f.classification_label || '',
          raw: f,
        }));
      // JTWC names depressions by number ("Ten"); prefix the classification so
      // the list reads like NHC's ("Tropical Storm Bavi").
      const classLabel = cur.classification_label || stormCategory(cur.wind_kt).label;
      return {
        id: `jtwc:${s.id}`,
        agency: 'JTWC',
        basin: s.basin,
        name: `${classLabel} ${s.name}`,
        classLabel,
        windKt: cur.wind_kt,
        gustKt: null,
        mslp: (fcst[0] && fcst[0].pressure_mb) || null,
        lat: cur.lat,
        lon: cur.lon,
        advisory: s.advisory_time || null,
        motion: null,
        cone: null, // JTWC publishes no cone (and wind radii are deliberately not drawn)
        trackCoords,
        pastCoords: [],
        points,
      };
    });
}

// GeoJSON features for the `cyclones` source. Every feature carries a `kind`
// the GL layers filter on: 'cone' | 'track' | 'past' | 'point' | 'current'.
function stormsToFeatures(storms) {
  const features = [];
  for (const storm of storms) {
    const cat = stormCategory(storm.windKt);
    const base = { id: storm.id, name: storm.name };
    if (storm.cone)
      features.push({ type: 'Feature', geometry: storm.cone, properties: { ...base, kind: 'cone' } });
    for (const run of storm.pastCoords) {
      if (run.length < 2) continue;
      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: run },
        properties: { ...base, kind: 'past' },
      });
    }
    if (storm.trackCoords.length >= 2)
      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: storm.trackCoords },
        properties: { ...base, kind: 'track', color: cat.color },
      });
    for (const [pointIndex, pt] of storm.points.entries())
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [pt.lon, pt.lat] },
        properties: {
          ...base,
          kind: 'point',
          pointIndex,
          tau: pt.tau,
          time: pt.label || '',
          color: stormCategory(pt.windKt).color,
        },
      });
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [storm.lon, storm.lat] },
      properties: { ...base, kind: 'current', color: cat.color },
    });
  }
  return features;
}

// Which GL layers each toggle governs (all built by setupOverlays in app.js).
const LAYER_GROUPS = {
  cone: ['cyclones-cone', 'cyclones-cone-line'],
  path: ['cyclones-past', 'cyclones-track', 'cyclones-points'],
  current: ['cyclones-current'],
};
export const CYCLONE_LAYER_IDS = Object.values(LAYER_GROUPS).flat();

export class CyclonesController {
  constructor(map, els) {
    this.map = map;
    // els: { list, status, preview, previewCard, suppressClick, onViewSatellite,
    //        onStormsChanged }
    this.els = els || {};
    this.enabled = false;
    // Per-part visibility (Path / Current location / Cone), under the master.
    this.show = { path: true, current: true, cone: true };
    this.storms = [];
    this.timer = null;
    this._loading = false;
    this._loadedAt = 0;
    this._lastFeatures = [];
    this.selectedId = null;

    // Clicking a storm's current-position marker, cone, or forecast point opens
    // the compact preview card. Registered up front like alerts does — Mapbox resolves the
    // layer id at event time, so it's fine that setupOverlays adds the layers
    // later (and re-adds them after every style reload).
    const open = (e) => this._openFromEvent(e);
    map.on('click', 'cyclones-current', open);
    map.on('click', 'cyclones-points', open);
    map.on('click', 'cyclones-cone', open);
    for (const layer of ['cyclones-current', 'cyclones-points', 'cyclones-cone']) {
      map.on('mouseenter', layer, () => (map.getCanvas().style.cursor = 'pointer'));
      map.on('mouseleave', layer, () => (map.getCanvas().style.cursor = ''));
    }
    if (this.els.preview) {
      this.els.preview.addEventListener('click', (e) => {
        if (e.target === this.els.preview) this.closePreview();
      });
    }
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.closePreview();
    });
  }

  stormById(id) {
    return this.storms.find((s) => s.id === id) || null;
  }

  // Master toggle. Turning on (re)starts the poll and loads if the data is
  // missing or stale; turning off stops polling and hides the layers, keeping
  // the last data so re-enabling is instant.
  setEnabled(on) {
    this.enabled = !!on;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.enabled) {
      if (!this.storms.length || Date.now() - this._loadedAt > REFRESH_MS) this.load();
      this.timer = setInterval(() => this.load(), REFRESH_MS);
    } else {
      this.closePreview();
    }
    this.applyVisibility();
    this.renderList();
  }

  setShow(part, on) {
    if (!(part in this.show)) return;
    this.show[part] = !!on;
    this.applyVisibility();
  }

  // Push master + per-part visibility onto the GL layers (no-op for any layer
  // the current style hasn't been given yet).
  applyVisibility() {
    const map = this.map;
    if (!map || !map.getLayer) return;
    for (const [part, layers] of Object.entries(LAYER_GROUPS)) {
      const vis = this.enabled && this.show[part] ? 'visible' : 'none';
      for (const id of layers) {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
      }
    }
  }

  // Re-push data + visibility after a style reload rebuilt the (empty) source
  // and layers — same contract as alerts.refreshVisible()/spc.reapply().
  reapply() {
    this._setSourceData(this._lastFeatures);
    this.applyVisibility();
  }

  async load() {
    if (this._loading) return;
    this._loading = true;
    this._setStatus('loading active storms…');
    // Fetch the two agencies independently so one failing feed doesn't blank
    // the other's storms.
    const [nhc, jtwc] = await Promise.all([
      fetchNhcStorms().catch((e) => { console.error('NHC cyclones failed', e); return null; }),
      fetchJtwcStorms().catch((e) => { console.error('JTWC cyclones failed', e); return null; }),
    ]);
    this._loading = false;
    if (nhc === null && jtwc === null) {
      this._setStatus('cyclone data unavailable');
      return;
    }
    this.storms = [...(nhc || []), ...(jtwc || [])];
    this._loadedAt = Date.now();
    this._lastFeatures = stormsToFeatures(this.storms);
    this._setSourceData(this._lastFeatures);
    this.renderList();
    if (this.els.onStormsChanged) this.els.onStormsChanged(this.storms);
  }

  _setSourceData(features) {
    const src = this.map && this.map.getSource && this.map.getSource('cyclones');
    if (src) src.setData({ type: 'FeatureCollection', features });
  }

  _setStatus(text) {
    if (this.els.status) this.els.status.textContent = text;
  }

  // The sidebar storm list: one row per active storm; clicking a row flies the
  // map to the storm and opens its preview card.
  renderList() {
    const list = this.els.list;
    if (!list) return;
    if (!this.enabled) {
      list.innerHTML = '';
      this._setStatus('overlay off');
      return;
    }
    if (!this.storms.length) {
      list.innerHTML = '';
      if (!this._loading) this._setStatus('no active tropical cyclones');
      return;
    }
    this._setStatus(`${this.storms.length} active storm${this.storms.length === 1 ? '' : 's'}`);
    list.innerHTML = '';
    for (const storm of this.storms) {
      const cat = stormCategory(storm.windKt);
      const row = document.createElement('button');
      row.className = 'alert-row';
      row.style.setProperty('--ac', cat.color);
      row.innerHTML = `<span class="alert-row-dot"></span><span class="alert-row-name">${esc(
        storm.name
      )}</span><span class="alert-row-area">${esc(storm.basin)} · ${esc(
        storm.windKt != null ? storm.windKt + ' kt' : '—'
      )}</span>`;
      row.addEventListener('click', () => {
        this.map.flyTo({ center: [storm.lon, storm.lat], zoom: Math.max(this.map.getZoom(), 4.5) });
        this.openPreview(storm.id);
      });
      list.appendChild(row);
    }
  }

  _openFromEvent(e) {
    // A click-consuming map tool (storm track / measure / draw) owns the tap.
    if (this.els.suppressClick && this.els.suppressClick()) return;
    const f = (e.features || [])[0];
    if (!f || !f.properties) return;
    // Prefer the current-position marker/forecast point when it and the cone
    // stack under one click — point/current layers are registered above cone.
    this.openPreview(f.properties.id, f.properties.kind === 'point' ? Number(f.properties.pointIndex) : null);
  }

  openPreview(id, pointIndex = null) {
    const storm = this.stormById(id);
    if (!storm || !this.els.preview || !this.els.previewCard) return;
    this.selectedId = id;
    const point = Number.isInteger(pointIndex) ? storm.points[pointIndex] : null;
    const display = point || storm;
    const cat = stormCategory(display.windKt);
    const rows = [];
    const addRow = (label, value) => {
      if (value == null || value === '') return;
      rows.push(`<div class="apv-row"><span>${esc(label)}</span><b>${esc(value)}</b></div>`);
    };
    if (point) {
      addRow('Forecast time', point.label || (point.tau != null ? `+${point.tau}h` : null));
      if (point.tau != null) addRow('Forecast hour', `+${point.tau}h`);
      addRow('Intensity', point.classLabel || stormCategory(point.windKt).label);
      if (point.windKt != null)
        addRow('Max wind', `${point.windKt} kt (${Math.round(point.windKt * KT_TO_MPH)} mph)`);
      if (point.gustKt != null) addRow('Gusts', `${point.gustKt} kt`);
      if (point.mslp != null) addRow('Pressure', `${point.mslp} mb`);
      addRow('Position', `${Number(point.lat).toFixed(2)}°, ${Number(point.lon).toFixed(2)}°`);
      addRow('Source', `${storm.agency} · ${storm.basin} basin`);
    } else {
      addRow('Intensity', storm.classLabel);
      if (storm.windKt != null)
        addRow('Max wind', `${storm.windKt} kt (${Math.round(storm.windKt * KT_TO_MPH)} mph)`);
      if (storm.gustKt != null) addRow('Gusts', `${storm.gustKt} kt`);
      if (storm.mslp != null) addRow('Pressure', `${storm.mslp} mb`);
      addRow('Movement', storm.motion);
      addRow('Advisory', storm.advisory);
      addRow('Source', `${storm.agency} · ${storm.basin} basin`);
    }

    this.els.previewCard.innerHTML = `
      <header class="apv-head" style="--ac:${cat.color}">
        <span class="apv-icon">🌀</span>
        <div class="apv-htext">
          <h3>${esc(storm.name)}</h3>
          <span class="apv-area">${esc(point ? 'Forecast point' : `${storm.agency} advisory`)}</span>
        </div>
        <button class="apv-close" aria-label="Close">✕</button>
      </header>
      <div class="apv-body">${rows.join('')}</div>
      <footer class="apv-foot">
        <button class="apv-details">View on satellite →</button>
      </footer>`;
    this.els.previewCard
      .querySelector('.apv-close')
      .addEventListener('click', () => this.closePreview());
    this.els.previewCard.querySelector('.apv-details').addEventListener('click', () => {
      this.closePreview();
      if (this.els.onViewSatellite) this.els.onViewSatellite(storm);
    });
    this.els.preview.hidden = false;
  }

  closePreview() {
    if (this.els.preview) this.els.preview.hidden = true;
  }
}
