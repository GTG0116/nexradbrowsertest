// app.js — application controller: ties the data, decode, and render layers to
// the UI. Everything runs in the browser; the only network calls are the public
// S3 list/download requests in s3.js and the Mapbox GL basemap tiles.

import { listVolumes, fetchVolume, RADARS, nearestSite } from './s3.js';
import { PRODUCTS, PRODUCT_ORDER, makeScale, parsePal, palTargetProduct } from './products.js';
import { renderRadarCanvas, sampleAt, sweepMaxRange } from './renderer.js';
import { AlertsController } from './alerts.js';

const M_PER_DEG_LAT = 111320;

// ---------------------------------------------------------------------------
// Basemap — Mapbox GL JS vector styles. Rendering with GL (rather than raster
// tiles) is what lets us slot the radar and alert layers *into* the basemap's
// own layer stack, beneath its town-name and boundary layers, so place names
// and borders always draw on top of the radar — natively, no second label set.
// ---------------------------------------------------------------------------
const MAPBOX_TOKEN =
  'pk.eyJ1IjoiZ3RnMDExNiIsImEiOiJjbWxsODV6NXAwNThmM2ZwdWlkYm0xNjFlIn0.vI186twXYzY45nnuV5FucQ';

// key → { url: mapbox style url, label }. "Dark" keeps the original console look.
const BASEMAPS = {
  dark: { url: 'mapbox://styles/mapbox/dark-v11', label: 'Dark' },
  satellite: { url: 'mapbox://styles/mapbox/satellite-streets-v12', label: 'Satellite' },
  streets: { url: 'mapbox://styles/mapbox/streets-v12', label: 'Streets' },
  light: { url: 'mapbox://styles/mapbox/light-v11', label: 'Light' },
  outdoors: { url: 'mapbox://styles/mapbox/outdoors-v12', label: 'Outdoors' },
};

// Canvas resolution for the rasterised radar. Higher = crisper when zoomed in,
// at the cost of memory and a longer render. A still view renders once so it
// can afford a big canvas; playback re-renders every frame, so it drops to a
// lighter resolution to stay smooth.
const RADAR_RES = () => {
  const mobile = window.matchMedia('(max-width: 900px)').matches;
  if (state.playback && state.playback.active) return mobile ? 1024 : 2048;
  return mobile ? 2048 : 4096;
};

// Find the basemap layer to insert our overlays *below*, so the style's town
// labels and administrative borders stay on top of the radar. We slot in just
// under the first label (symbol) or boundary line layer.
function firstLabelLayerId(map) {
  const layers = map.getStyle().layers || [];
  for (const ly of layers) {
    if (ly.type === 'symbol') return ly.id;
    if (ly.type === 'line' && /admin|boundary|border/i.test(ly.id)) return ly.id;
  }
  return undefined; // nothing matched → overlays go on top
}

// ---------------------------------------------------------------------------
// Overlay layers (radar, alerts, rings, radar-site dots)
//
// Everything is slotted into the Mapbox style's own layer stack, beneath the
// first label/boundary layer, so town names and borders draw on top. Back to
// front: basemap fills → alert fill → radar → alert borders → range rings →
// site dots → [basemap labels & boundaries].
// ---------------------------------------------------------------------------

// Build the dashed range-ring geometry (and skip the centre marker — the
// current-site dot already marks the radar).
function ringsGeoJSON(site, maxR) {
  const mPerDegLon = M_PER_DEG_LAT * Math.cos((site.lat * Math.PI) / 180);
  const features = [];
  const stepKm = 100;
  for (let km = stepKm; km * 1000 <= maxR + 1; km += stepKm) {
    const dLat = (km * 1000) / M_PER_DEG_LAT;
    const dLon = (km * 1000) / mPerDegLon;
    const ring = [];
    for (let a = 0; a <= 72; a++) {
      const t = (a / 72) * 2 * Math.PI;
      ring.push([site.lon + dLon * Math.sin(t), site.lat + dLat * Math.cos(t)]);
    }
    features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: ring }, properties: {} });
  }
  return { type: 'FeatureCollection', features };
}

function sitesGeoJSON() {
  return {
    type: 'FeatureCollection',
    features: RADARS.map(([icao, name, lat, lon]) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties: { icao, name, current: icao === state.site ? 1 : 0 },
    })),
  };
}

// (Re)create all overlay sources and layers in the correct order. Called on
// every style load — including after a basemap switch, which wipes custom
// layers — and then repopulated with whatever data we currently hold.
function setupOverlays(map) {
  const anchor = firstLabelLayerId(map);

  if (!map.getSource('alerts'))
    map.addSource('alerts', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  if (!map.getSource('rings'))
    map.addSource('rings', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  if (!map.getSource('sites'))
    map.addSource('sites', { type: 'geojson', data: sitesGeoJSON() });

  // Translucent alert fill — sits below the radar.
  map.addLayer(
    {
      id: 'alerts-fill',
      type: 'fill',
      source: 'alerts',
      paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.18 },
    },
    anchor
  );
  // Alert outline — above the radar (the radar layer is inserted before this).
  map.addLayer(
    {
      id: 'alerts-line',
      type: 'line',
      source: 'alerts',
      paint: { 'line-color': ['get', 'color'], 'line-width': 2.5, 'line-opacity': 0.95 },
    },
    anchor
  );
  map.addLayer(
    {
      id: 'rings',
      type: 'line',
      source: 'rings',
      paint: {
        'line-color': 'rgba(120,200,255,0.45)',
        'line-width': 1,
        'line-dasharray': [2, 3],
      },
    },
    anchor
  );
  map.addLayer(
    {
      id: 'sites',
      type: 'circle',
      source: 'sites',
      paint: {
        'circle-radius': ['case', ['==', ['get', 'current'], 1], 6, 3.5],
        'circle-color': ['case', ['==', ['get', 'current'], 1], '#36e0c8', 'rgba(80,140,220,0.85)'],
        'circle-stroke-color': ['case', ['==', ['get', 'current'], 1], '#36e0c8', 'rgba(150,205,255,0.85)'],
        'circle-stroke-width': ['case', ['==', ['get', 'current'], 1], 2, 1],
        'circle-opacity': ['case', ['==', ['get', 'current'], 1], 1, 0.6],
      },
    },
    anchor
  );

  refreshSiteDots();

  // Repaint the radar (if we have a sweep) into its place between fill and line.
  if (state.shownSweep && state.shownSite)
    setRadarSource(map, state.shownSweep, PRODUCTS[state.productId], state.shownSite);
  if (state.alerts) state.alerts.refreshVisible();
}

// Rasterise the current sweep and (re)bind it as a georeferenced CanvasSource
// beneath the alert outline. Mapbox then reprojects this single image on the
// GPU as the map moves — no per-frame JS, which is the whole point of the move
// off the old re-render-on-every-pan canvas.
function setRadarSource(map, sweep, product, site) {
  const maxR = sweepMaxRange(sweep, product.moment) || 300000;
  const { coordinates } = renderRadarCanvas(
    el.radarCanvas,
    sweep,
    product,
    site,
    maxR,
    RADAR_RES()
  );
  if (map.getLayer('radar')) map.removeLayer('radar');
  if (map.getSource('radar')) map.removeSource('radar');
  map.addSource('radar', {
    type: 'canvas',
    canvas: el.radarCanvas,
    coordinates,
    animate: false,
  });
  map.addLayer(
    {
      id: 'radar',
      type: 'raster',
      source: 'radar',
      paint: {
        'raster-opacity': state.opacity,
        'raster-fade-duration': 0,
        // Don't let the GPU bilinear-smooth between gates — keep each gate's
        // value sharp-edged (true polar cells), not blurred into its neighbour.
        'raster-resampling': 'nearest',
      },
    },
    map.getLayer('alerts-line') ? 'alerts-line' : firstLabelLayerId(map)
  );
}

function clearRadarSource(map) {
  if (!map) return;
  if (map.getLayer('radar')) map.removeLayer('radar');
  if (map.getSource('radar')) map.removeSource('radar');
}

// Decode volumes off the main thread.
const worker = new Worker(new URL('./decoder.worker.js', import.meta.url), {
  type: 'module',
});
let decodeSeq = 0;
const pending = new Map();
worker.onmessage = (e) => {
  const { id, ok, result, error } = e.data;
  const job = pending.get(id);
  if (!job) return;
  pending.delete(id);
  if (ok) job.resolve(result);
  else job.reject(new Error(error));
};
function decodeVolume(bytes) {
  const id = ++decodeSeq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, bytes }, [bytes.buffer]); // zero-copy transfer
  });
}

const state = {
  site: 'KTLX',
  date: new Date(),
  volumes: [],
  volumeKey: null,
  volume: null,
  sweeps: [],
  selectedElevation: 0.5,
  productId: 'REF',
  opacity: 0.85,
  live: false,
  liveTimer: null,
  map: null,
  basemap: 'dark',
  styleReady: false,
  showRings: true,
  geo: null,
  alerts: null,
  shownSweep: null,
  shownSite: null,
  inspect: false,
  playback: null,
};

const $ = (sel) => document.querySelector(sel);
const el = {};

function cacheEls() {
  el.map = $('#map');
  el.radarCanvas = $('#radarCanvas');
  el.mapWrap = $('#mapWrap');
  el.siteSelect = $('#siteSelect');
  el.dateInput = $('#dateInput');
  el.volumeList = $('#volumeList');
  el.productButtons = $('#productButtons');
  el.tiltList = $('#tiltList');
  el.legend = $('#legend');
  el.status = $('#status');
  el.clock = $('#clock');
  el.meta = $('#meta');
  el.readout = $('#mapReadout');
  el.liveBtn = $('#liveBtn');
  el.refreshBtn = $('#refreshBtn');
  el.progress = $('#progress');
  el.decoding = $('#decoding');
  el.opacity = $('#opacity');
  el.opacityVal = $('#opacityVal');
  el.palInput = $('#palInput');
  el.palReset = $('#palReset');
  el.palName = $('#palName');
  el.alertList = $('#alertList');
  el.alertsToggle = $('#alertsToggle');
  el.ringsToggle = $('#ringsToggle');
  el.alertDetail = $('#alertDetail');
  el.alertDetailPanel = $('#alertDetailPanel');
  el.alertClose = $('#alertClose');

  // Mobile control surface.
  el.railLeft = $('.rail-left');
  el.railRight = $('.rail-right');
  el.layout = $('.layout');
  el.stage = $('.stage');
  el.mobileDock = $('#mobileDock');
  el.dockStatus = $('#dockStatus');
  el.dockProd = $('#dockProd');
  el.dockSite = $('#dockSite');
  el.dockTime = $('#dockTime');
  el.playBtn = $('#playBtn');
  el.inspectBtn = $('#inspectBtn');
  el.sheet = $('#mobileSheet');
  el.sheetBody = $('#sheetBody');
  el.sheetScrim = $('#sheetScrim');
  el.sheetGrip = $('#sheetGrip');
  el.sheetClose = $('#sheetClose');
  el.sheetHeader = $('#sheetHeader');
  el.basemapSelect = $('#basemapSelect');
  el.sheetPlayback = $('#sheetPlayback');
  el.playSpeed = $('#playSpeed');
  el.playSpeedVal = $('#playSpeedVal');
  el.crosshair = $('#crosshair');
  el.crosshairRead = $('#crosshairRead');
  el.playbackBar = $('#playbackBar');
  el.playToggle = $('#playToggle');
  el.playScrub = $('#playScrub');
  el.playLabel = $('#playLabel');
  el.playClose = $('#playClose');
}

function setStatus(text, busy = false) {
  el.status.textContent = text;
  el.status.classList.toggle('busy', busy);
}

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------
function initMap() {
  mapboxgl.accessToken = MAPBOX_TOKEN;
  const map = new mapboxgl.Map({
    container: 'map',
    style: (BASEMAPS[state.basemap] || BASEMAPS.dark).url,
    center: [-97.27, 35.33], // Mapbox is [lng, lat]
    zoom: 6,
    minZoom: 4,
    maxZoom: 14,
    attributionControl: true,
    // Flat Web Mercator (not the v3 default globe): the radar CanvasSource and
    // its corner math assume a flat mercator plane.
    projection: 'mercator',
    // The vector basemap renders on its own; our radar/alert layers slot into
    // its layer stack beneath the labels (set up in setupOverlays).
    renderWorldCopies: true,
  });
  map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-left');
  state.map = map;

  // (Re)build overlays on every style load — the initial load and after any
  // basemap switch (setStyle drops custom layers).
  map.on('style.load', () => {
    state.styleReady = true;
    setupOverlays(map);
  });

  // Throttle the gate-sampling readout to one update per frame; sampleAt scans
  // every radial, so firing it on every raw mousemove event made panning while
  // hovering feel sticky.
  let readoutRaf = null;
  let lastLatLng = null;
  map.on('mousemove', (e) => {
    lastLatLng = e.lngLat;
    if (readoutRaf) return;
    readoutRaf = requestAnimationFrame(() => {
      readoutRaf = null;
      updateReadout(lastLatLng);
    });
  });
  map.on('mouseout', () => el.readout.classList.remove('show'));

  // Right-click anywhere to jump to the NEXRAD radar nearest that point.
  map.on('contextmenu', (e) => {
    const r = nearestSite(e.lngLat.lat, e.lngLat.lng);
    if (!r) return;
    selectSite(r[0], r[1]);
    setStatus(`nearest radar: ${r[0]} — ${r[1]}`);
  });

  // Click / hover for the radar-site dots.
  map.on('click', 'sites', (e) => {
    const f = e.features && e.features[0];
    if (f) selectSite(f.properties.icao, f.properties.name);
  });
  for (const layer of ['sites', 'alerts-fill', 'alerts-line']) {
    map.on('mouseenter', layer, () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', layer, () => (map.getCanvas().style.cursor = ''));
  }

  // Hover tooltip on the radar-site dots (the old bindTooltip equivalent).
  const siteTip = new mapboxgl.Popup({
    closeButton: false,
    closeOnClick: false,
    offset: 8,
    className: 'site-tip',
  });
  map.on('mousemove', 'sites', (e) => {
    const f = e.features && e.features[0];
    if (!f) return;
    siteTip.setLngLat(e.lngLat).setHTML(`${f.properties.icao} — ${f.properties.name}`).addTo(map);
  });
  map.on('mouseleave', 'sites', () => siteTip.remove());
}

// Swap the Mapbox basemap style. setStyle wipes custom layers, so the
// 'style.load' handler rebuilds and repopulates the overlays afterward.
function setBasemap(key) {
  if (!BASEMAPS[key] || !state.map) return;
  state.basemap = key;
  state.styleReady = false;
  state.map.setStyle(BASEMAPS[key].url);
}

// Switch to a radar by ICAO, injecting it into the picker if it isn't a curated
// option (so right-click can reach any of the ~160 WSR-88D sites).
function selectSite(icao, name) {
  if (!el.siteSelect.querySelector(`option[value="${icao}"]`)) {
    const opt = document.createElement('option');
    opt.value = icao;
    opt.textContent = name ? `${icao} — ${name}` : icao;
    el.siteSelect.appendChild(opt);
  }
  el.siteSelect.value = icao;
  onSiteSwitch(icao);
}

// Shared housekeeping whenever the active radar changes (picker, dot, long-press
// or right-click). Always recenters and loads the newest scan automatically.
function onSiteSwitch(icao) {
  if (state.playback && state.playback.active) state.playback.stop();
  state.site = icao;
  state._centered = false;
  state._forceLatest = true; // show the latest frame without needing LIVE
  refreshSiteDots();
  closeSheet();
  loadVolumeList();
}

// ---------------------------------------------------------------------------
// Per-product sweep selection
// ---------------------------------------------------------------------------
// Split-cut VCPs separate the Doppler moments (VEL/SW) and the dual-pol moments
// (ZDR/PHI/RHO) into different sweeps at nearly the same elevation. So for the
// chosen product we render whichever sweep actually carries that moment closest
// to the selected tilt — that is what makes ρHV / ZDR / φDP display.
function sweepsForProduct(productId = state.productId) {
  const moment = PRODUCTS[productId].moment;
  return state.sweeps.filter((sw) => sw.moments.includes(moment));
}

// Pick the sweep from an arbitrary sweeps array that carries the given product's
// moment closest to the chosen tilt. Shared by the live view and playback.
function pickSweep(sweeps, productId = state.productId, elev = state.selectedElevation) {
  const moment = PRODUCTS[productId].moment;
  const list = sweeps.filter((sw) => sw.moments.includes(moment));
  if (!list.length) return null;
  let best = list[0];
  let bestDiff = Infinity;
  for (const sw of list) {
    const d = Math.abs(sw.elevation - elev);
    if (d < bestDiff) {
      bestDiff = d;
      best = sw;
    }
  }
  return best;
}

function currentSweep() {
  return pickSweep(state.sweeps);
}

// ---------------------------------------------------------------------------
// UI construction
// ---------------------------------------------------------------------------
function buildSiteSelect() {
  // Every WSR-88D site in the country, alphabetised by ICAO.
  const sites = [...RADARS].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [code, name] of sites) {
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = `${code} — ${name}`;
    if (code === state.site) opt.selected = true;
    el.siteSelect.appendChild(opt);
  }
  el.siteSelect.addEventListener('change', () => onSiteSwitch(el.siteSelect.value));
}

function buildProductButtons() {
  el.productButtons.innerHTML = '';
  for (const id of PRODUCT_ORDER) {
    const p = PRODUCTS[id];
    const btn = document.createElement('button');
    btn.className = 'product-btn';
    btn.dataset.id = id;
    btn.innerHTML = `<span class="pb-id">${id}</span><span class="pb-name">${p.name}</span>`;
    if (id === state.productId) btn.classList.add('active');
    btn.addEventListener('click', () => {
      state.productId = id;
      document
        .querySelectorAll('.product-btn')
        .forEach((b) => b.classList.toggle('active', b.dataset.id === id));
      buildTiltList();
      buildLegend();
      renderRadar();
      updateMeta();
    });
    el.productButtons.appendChild(btn);
  }
}

function buildTiltList() {
  el.tiltList.innerHTML = '';
  const list = sweepsForProduct();
  if (!list.length) {
    el.tiltList.innerHTML = '<div class="empty">No tilts for this product.</div>';
    return;
  }
  const active = currentSweep();
  list.forEach((sw) => {
    const btn = document.createElement('button');
    btn.className = 'tilt-btn';
    if (sw === active) btn.classList.add('active');
    btn.textContent = `${sw.elevation.toFixed(2)}°`;
    btn.addEventListener('click', () => {
      state.selectedElevation = sw.elevation;
      buildTiltList();
      renderRadar();
      updateMeta();
    });
    el.tiltList.appendChild(btn);
  });
}

function buildVolumeList() {
  el.volumeList.innerHTML = '';
  if (!state.volumes.length) {
    el.volumeList.innerHTML = '<div class="empty">No scans found for this day.</div>';
    return;
  }
  [...state.volumes].reverse().forEach((v) => {
    const btn = document.createElement('button');
    btn.className = 'vol-btn';
    if (v.key === state.volumeKey) btn.classList.add('active');
    btn.innerHTML = `<span class="dot"></span>${v.label}`;
    btn.addEventListener('click', () => loadVolume(v.key));
    el.volumeList.appendChild(btn);
  });
}

function buildLegend() {
  const p = PRODUCTS[state.productId];
  const { lo, hi, rgba, steps } = p.scale;
  const segs = 80;
  const colors = [];
  for (let i = 0; i <= segs; i++) {
    let li = Math.round((i / segs) * (steps - 1));
    if (li >= steps) li = steps - 1;
    const o = li * 4;
    colors.push(`rgb(${rgba[o]},${rgba[o + 1]},${rgba[o + 2]}) ${(i / segs) * 100}%`);
  }
  el.legend.innerHTML = `
    <div class="legend-title">${p.name} <span>(${p.unit})</span></div>
    <div class="legend-bar" style="background:linear-gradient(90deg,${colors.join(
      ','
    )})"></div>
    <div class="legend-ticks"><span>${lo}</span><span>${(
    (lo + hi) /
    2
  ).toFixed(lo < 0 || hi <= 1 ? 1 : 0)}</span><span>${hi}</span></div>`;
}

// ---------------------------------------------------------------------------
// Custom .pal color tables (GRLevelX / GR2Analyst format)
// ---------------------------------------------------------------------------
async function loadPalFile(file) {
  if (!file) return;
  try {
    const text = await file.text();
    const pal = parsePal(text);
    // Apply to the product the file names, falling back to the current one.
    const targetId = palTargetProduct(pal) || state.productId;
    const p = PRODUCTS[targetId];
    p.scale = makeScale(pal.segments);
    p.range = [p.scale.lo, p.scale.hi];
    if (pal.units) p.unit = pal.units;
    p.customPal = file.name;

    state.productId = targetId;
    document
      .querySelectorAll('.product-btn')
      .forEach((b) => b.classList.toggle('active', b.dataset.id === targetId));
    el.palName.textContent = `${file.name} → ${targetId}`;
    buildLegend();
    buildTiltList();
    renderRadar();
    updateMeta();
    setStatus(`palette “${file.name}” applied to ${targetId}`);
  } catch (err) {
    setStatus(`pal error: ${err.message}`);
  } finally {
    el.palInput.value = '';
  }
}

function resetPalettes() {
  for (const id of PRODUCT_ORDER) {
    const p = PRODUCTS[id];
    p.scale = p.defaultScale;
    p.range = [p.scale.lo, p.scale.hi];
    p.unit = p.defaultUnit;
    delete p.customPal;
  }
  el.palName.textContent = '';
  buildLegend();
  renderRadar();
  setStatus('color tables reset to defaults');
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------
async function loadVolumeList() {
  setStatus(`listing ${state.site}…`, true);
  buildVolumeList();
  try {
    const vols = await listVolumes(state.site, state.date);
    state.volumes = vols;
    buildVolumeList();
    setStatus(`${vols.length} scans available`);
    if (!vols.length) return;
    const latest = vols[vols.length - 1].key;
    if (state._forceLatest || !state.volume || state.live) {
      state._forceLatest = false;
      if (latest !== state.volumeKey) loadVolume(latest);
    }
  } catch (e) {
    setStatus(`list error: ${e.message}`);
    console.error(e);
  }
}

async function loadVolume(key) {
  state.volumeKey = key;
  buildVolumeList();
  setStatus('downloading volume…', true);
  el.progress.style.width = '0%';
  el.progress.classList.add('show');
  el.decoding.classList.remove('show');
  try {
    const bytes = await fetchVolume(key, (p) => {
      el.progress.style.width = Math.round(p * 100) + '%';
    });
    setStatus('decoding…', true);
    el.decoding.classList.add('show');
    const volume = await decodeVolume(bytes);
    state.volume = volume;
    state.sweeps = volume.sweeps;

    // Default to the lowest available tilt of the current product.
    const list = sweepsForProduct();
    if (list.length) state.selectedElevation = list[0].elevation;

    // Centre the map on the radar the first time we get a site fix.
    if (volume.site && !state._centered) {
      state.map.jumpTo({ center: [volume.site.lon, volume.site.lat], zoom: 8 });
      state._centered = true;
    }

    refreshSiteDots();
    buildTiltList();
    updateMeta();
    renderRadar();
    setStatus(`loaded · ${volume.radialCount} radials`);
  } catch (e) {
    setStatus(`decode error: ${e.message}`);
    console.error(e);
  } finally {
    el.progress.classList.remove('show');
    el.decoding.classList.remove('show');
  }
}

// ---------------------------------------------------------------------------
// Rendering onto the map
// ---------------------------------------------------------------------------
function renderRadar() {
  // While scrubbing/playing, the active frame owns the display; just re-render
  // it (e.g. after a product or tilt change).
  if (state.playback && state.playback.active) {
    state.playback.renderFrame();
    return;
  }
  displaySweep(currentSweep(), state.volume && state.volume.site);
}

// Draw one sweep (from any volume) onto the map and remember it so the inspect
// readout and dock can reflect what is actually on screen.
function displaySweep(sweep, site) {
  const product = PRODUCTS[state.productId];
  state.shownSweep = sweep;
  state.shownSite = site;

  const map = state.map;
  // Until the GL style has loaded its layers, just remember the sweep —
  // setupOverlays() repaints it once the style is ready.
  if (!map || !state.styleReady) {
    updateInspect();
    return;
  }

  if (!sweep || !site) {
    clearRadarSource(map);
    drawRings(null, 0);
    updateInspect();
    return;
  }

  const maxR = sweepMaxRange(sweep, product.moment) || 300000;
  setRadarSource(map, sweep, product, site);
  if (map.getLayer('radar')) map.setPaintProperty('radar', 'raster-opacity', state.opacity);
  drawRings(site, maxR);
  updateInspect();
}

function drawRings(site, maxR) {
  const src = state.map && state.map.getSource('rings');
  if (!src) return;
  const show = state.showRings && site;
  src.setData(show ? ringsGeoJSON(site, maxR) : { type: 'FeatureCollection', features: [] });
}

// Recompute and (re)draw the rings for whatever sweep is currently on screen —
// used by the show/hide toggle without forcing a radar re-render.
function refreshRings() {
  const site = state.shownSweep && state.shownSite;
  const maxR = state.shownSweep
    ? sweepMaxRange(state.shownSweep, PRODUCTS[state.productId].moment) || 300000
    : 0;
  drawRings(site ? state.shownSite : null, maxR);
}

// ---------------------------------------------------------------------------
// All-radar dots + nearest-site
//
// The dots live in a single GL `sites` circle layer (built in setupOverlays);
// refreshing just repushes the source (to update which dot is the active site)
// and bumps the touch-friendly radius on small screens.
// ---------------------------------------------------------------------------
function refreshSiteDots() {
  const map = state.map;
  if (!map || !map.getSource('sites')) return;
  map.getSource('sites').setData(sitesGeoJSON());
  const mobile = mqMobile.matches;
  map.setPaintProperty('sites', 'circle-radius', [
    'case',
    ['==', ['get', 'current'], 1],
    mobile ? 9 : 6,
    mobile ? 7 : 3.5,
  ]);
}

// Long-press anywhere on the map (touch) jumps to the nearest WSR-88D site —
// the touch equivalent of the desktop right-click.
function enableLongPress() {
  const container = state.map.getContainer();
  let timer = null;
  let start = null;
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  container.addEventListener(
    'touchstart',
    (e) => {
      cancel();
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      start = { x: t.clientX, y: t.clientY };
      timer = setTimeout(() => {
        timer = null;
        const rect = container.getBoundingClientRect();
        const ll = state.map.unproject([start.x - rect.left, start.y - rect.top]);
        const r = nearestSite(ll.lat, ll.lng);
        if (!r) return;
        if (navigator.vibrate) navigator.vibrate(25);
        selectSite(r[0], r[1]);
        setStatus(`nearest radar: ${r[0]} — ${r[1]}`);
      }, 700);
    },
    { passive: true }
  );
  container.addEventListener(
    'touchmove',
    (e) => {
      if (!start || !e.touches[0]) return;
      const t = e.touches[0];
      if (Math.hypot(t.clientX - start.x, t.clientY - start.y) > 12) cancel();
    },
    { passive: true }
  );
  container.addEventListener('touchend', cancel, { passive: true });
  container.addEventListener('touchcancel', cancel, { passive: true });
}

// ---------------------------------------------------------------------------
// Inspect tool — a fixed crosshair at screen centre reading the gate under it.
// ---------------------------------------------------------------------------
function toggleInspect(on) {
  state.inspect = on == null ? !state.inspect : on;
  el.inspectBtn.classList.toggle('active', state.inspect);
  el.crosshair.hidden = !state.inspect;
  updateInspect();
}

function updateInspect() {
  if (!state.inspect) return;
  const product = PRODUCTS[state.productId];
  const sweep = state.shownSweep;
  const site = state.shownSite;
  if (!sweep || !site) {
    el.crosshairRead.textContent = 'no data';
    return;
  }
  const c = state.map.getCenter();
  const s = sampleAt(sweep, product, c.lat, c.lng, site);
  if (!s || s.range > sweepMaxRange(sweep, product.moment)) {
    el.crosshairRead.textContent = 'out of range';
    return;
  }
  const valueStr =
    s.value == null
      ? 'no echo'
      : `${s.value.toFixed(product.id === 'RHO' ? 2 : 1)} ${product.unit}`;
  el.crosshairRead.innerHTML = `<b>${valueStr}</b> · ${product.id}`;
}

// ---------------------------------------------------------------------------
// Mobile dock + settings sheet
// ---------------------------------------------------------------------------
function updateDock() {
  if (!el.dockProd) return;
  el.dockProd.textContent = state.productId;
  el.dockSite.textContent = (state.volume && state.volume.icao) || state.site;
  if (state.playback && state.playback.active) return; // dock time owned by playback
  const t = state.volumes.find((x) => x.key === state.volumeKey);
  el.dockTime.textContent = t ? t.label : '—';
}

function openSheet() {
  el.sheet.hidden = false;
  el.sheet.style.transition = 'none';
  el.sheet.style.transform = 'translateY(0)';
  el.sheetScrim.hidden = false;
  document.querySelector('.app').classList.add('sheet-open');
}

function closeSheet() {
  el.sheet.hidden = true;
  el.sheet.style.transform = '';
  el.sheet.style.transition = '';
  el.sheetScrim.hidden = true;
  document.querySelector('.app').classList.remove('sheet-open');
}

// Drag the settings sheet down to dismiss it — a more discoverable close than
// tapping the scrim. A short flick or a drag past ~90px closes; otherwise it
// springs back. Dragging starts from the header (grip / minimize) so list
// scrolling inside the body isn't hijacked.
function enableSheetSwipe() {
  const handle = el.sheetHeader || el.sheetGrip;
  if (!handle) return;
  let startY = null;
  let dy = 0;
  let t0 = 0;

  handle.addEventListener(
    'touchstart',
    (e) => {
      if (!e.touches[0]) return;
      startY = e.touches[0].clientY;
      dy = 0;
      t0 = Date.now();
      el.sheet.style.transition = 'none';
    },
    { passive: true }
  );
  handle.addEventListener(
    'touchmove',
    (e) => {
      if (startY == null || !e.touches[0]) return;
      dy = Math.max(0, e.touches[0].clientY - startY);
      el.sheet.style.transform = `translateY(${dy}px)`;
    },
    { passive: true }
  );
  const end = () => {
    if (startY == null) return;
    const fast = dy > 24 && Date.now() - t0 < 250;
    el.sheet.style.transition = 'transform 0.18s ease';
    if (dy > 90 || fast) {
      el.sheet.style.transform = 'translateY(110%)';
      setTimeout(closeSheet, 160);
    } else {
      el.sheet.style.transform = 'translateY(0)';
    }
    startY = null;
  };
  handle.addEventListener('touchend', end, { passive: true });
  handle.addEventListener('touchcancel', end, { passive: true });
}

const mqMobile = window.matchMedia('(max-width: 900px)');
function applyResponsiveLayout() {
  const mobile = mqMobile.matches;
  document.querySelector('.app').classList.toggle('mobile', mobile);
  // While a loop is running its UI owns the dock's space, so keep the dock
  // hidden until playback stops.
  const playing = state.playback && state.playback.active;
  el.mobileDock.hidden = !mobile || playing;
  refreshSiteDots(); // dot sizes differ between desktop and touch layouts
  if (mobile) {
    // In the sheet, stack Product/tilt/basemap first, then Source/volumes and
    // Active alerts as their own full-width sections below — so the alerts list
    // is no longer crowded out of view by the product grid.
    if (el.railRight.parentElement !== el.sheetBody) {
      el.sheetBody.appendChild(el.railRight);
      el.sheetBody.appendChild(el.railLeft);
    }
  } else {
    closeSheet();
    if (state.inspect) toggleInspect(false);
    if (el.railLeft.parentElement !== el.layout) {
      el.layout.insertBefore(el.railLeft, el.stage);
      el.layout.appendChild(el.railRight);
    }
  }
  setTimeout(() => state.map && state.map.resize(), 60);
}

// ---------------------------------------------------------------------------
// Playback — scrub/animate the last 10 scans of the current radar.
// ---------------------------------------------------------------------------
function createPlayback() {
  return {
    active: false,
    playing: false,
    frames: [],
    idx: 0,
    fps: 3,
    timer: null,
    cache: new Map(),

    async start() {
      if (this.active) return;
      if (!state.volumes.length) {
        setStatus('no scans to play back');
        return;
      }
      this.active = true;
      el.playBtn.classList.add('active');
      // The loop UI takes over the dock's space: hide the dock while playing
      // and reveal it again on stop (the ✕ on the bar).
      el.mobileDock.hidden = true;
      el.playbackBar.hidden = false;
      el.sheetPlayback.hidden = false;
      document.querySelector('.app').classList.add('playing');
      el.playLabel.textContent = 'loading…';
      if (state.live) toggleLive(); // freeze auto-refresh during playback

      // Decoding ten full Level II volumes and holding them all in memory at
      // once can exhaust a phone and crash the tab. On mobile, loop fewer,
      // recent frames so the working set stays small.
      const frameCount = mqMobile.matches ? 5 : 10;
      const last = state.volumes.slice(-frameCount);
      setStatus('loading playback…', true);
      const frames = [];
      for (const v of last) {
        let entry = this.cache.get(v.key);
        if (!entry) {
          try {
            const bytes = await fetchVolume(v.key);
            const volume = await decodeVolume(bytes);
            entry = { volume, sweeps: volume.sweeps };
            this.cache.set(v.key, entry);
          } catch (e) {
            continue;
          }
        }
        if (!this.active) return; // user bailed mid-load
        frames.push({ key: v.key, label: v.label, volume: entry.volume });
      }
      if (!frames.length) {
        setStatus('playback unavailable');
        this.stop();
        return;
      }
      // Drop any cached volumes that aren't part of this loop so the cache
      // can't grow without bound as new scans arrive over a long session.
      const keep = new Set(frames.map((f) => f.key));
      for (const k of [...this.cache.keys()]) if (!keep.has(k)) this.cache.delete(k);

      this.frames = frames;
      this.idx = frames.length - 1;
      el.playScrub.max = String(frames.length - 1);
      el.playScrub.value = String(this.idx);
      setStatus(`playback · ${frames.length} frames`);
      this.renderFrame();
      this.play();
    },

    play() {
      if (!this.frames.length) return;
      this.playing = true;
      el.playToggle.textContent = '⏸';
      clearInterval(this.timer);
      this.timer = setInterval(() => {
        this.idx = (this.idx + 1) % this.frames.length;
        el.playScrub.value = String(this.idx);
        this.renderFrame();
      }, 1000 / this.fps);
    },

    pause() {
      this.playing = false;
      el.playToggle.textContent = '▶';
      clearInterval(this.timer);
      this.timer = null;
    },

    toggle() {
      this.playing ? this.pause() : this.play();
    },

    seek(i) {
      if (!this.frames.length) return;
      this.pause();
      this.idx = Math.max(0, Math.min(this.frames.length - 1, i | 0));
      this.renderFrame();
    },

    setFps(f) {
      this.fps = f;
      if (this.playing) this.play();
    },

    renderFrame() {
      const f = this.frames[this.idx];
      if (!f) return;
      displaySweep(pickSweep(f.volume.sweeps), f.volume.site);
      el.playLabel.textContent = `${this.idx + 1}/${this.frames.length} · ${f.label}`;
      el.dockTime.textContent = f.label;
    },

    stop() {
      this.pause();
      this.active = false;
      this.frames = [];
      el.playBtn.classList.remove('active');
      el.playbackBar.hidden = true;
      el.sheetPlayback.hidden = true;
      document.querySelector('.app').classList.remove('playing');
      // Restore the normal bottom dock that the loop UI replaced.
      if (mqMobile.matches) el.mobileDock.hidden = false;
      // Release the decoded-volume cache on phones so playback memory is freed
      // as soon as the loop is dismissed.
      if (mqMobile.matches) this.cache.clear();
      displaySweep(currentSweep(), state.volume && state.volume.site);
      updateDock();
    },
  };
}

function updateMeta() {
  updateDock();
  const v = state.volume;
  const sw = currentSweep();
  if (!v) {
    el.meta.innerHTML = '<div class="empty">No volume loaded.</div>';
    return;
  }
  const t = state.volumes.find((x) => x.key === state.volumeKey);
  const site = v.site;
  el.meta.innerHTML = `
    <div class="meta-row"><span>Radar</span><b>${v.icao || state.site}</b></div>
    <div class="meta-row"><span>Scan time</span><b>${t ? t.label : '—'}</b></div>
    <div class="meta-row"><span>Tilt (this product)</span><b>${
      sw ? sw.elevation.toFixed(2) + '°' : 'n/a'
    }</b></div>
    <div class="meta-row"><span>Radials</span><b>${sw ? sw.radials.length : '—'}</b></div>
    <div class="meta-row"><span>Site lat/lon</span><b>${
      site ? site.lat.toFixed(3) + ', ' + site.lon.toFixed(3) : '—'
    }</b></div>`;
}

// ---------------------------------------------------------------------------
// Cursor readout
// ---------------------------------------------------------------------------
function updateReadout(latlng) {
  const sweep = currentSweep();
  const product = PRODUCTS[state.productId];
  const site = state.volume && state.volume.site;
  if (!sweep || !site) return;

  const s = sampleAt(sweep, product, latlng.lat, latlng.lng, site);
  if (!s || s.range > sweepMaxRange(sweep, product.moment)) {
    el.readout.classList.remove('show');
    return;
  }
  const valueStr =
    s.value == null
      ? 'no echo'
      : `${s.value.toFixed(product.id === 'RHO' ? 2 : 1)} ${product.unit}`;
  el.readout.innerHTML = `<b>${valueStr}</b><span>${product.id} · az ${s.az.toFixed(
    0
  )}° · ${(s.range / 1000).toFixed(0)} km</span>`;
  el.readout.classList.add('show');
}

// ---------------------------------------------------------------------------
// Live mode + clock
// ---------------------------------------------------------------------------
function toggleLive() {
  state.live = !state.live;
  el.liveBtn.classList.toggle('active', state.live);
  el.liveBtn.textContent = state.live ? '● LIVE' : '○ LIVE';
  if (state.live) {
    state.date = new Date();
    el.dateInput.value = isoDate(state.date);
    loadVolumeList();
    state.liveTimer = setInterval(() => loadVolumeList(), 60000);
  } else if (state.liveTimer) {
    clearInterval(state.liveTimer);
    state.liveTimer = null;
  }
}

function tickClock() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  el.clock.textContent = `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(
    d.getUTCSeconds()
  )} UTC`;
}

function isoDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
function init() {
  cacheEls();
  initMap();
  enableLongPress();
  buildSiteSelect();
  buildProductButtons();
  buildLegend();
  buildTiltList();

  state.playback = createPlayback();
  state.map.on('move', updateInspect);

  el.dateInput.value = isoDate(state.date);
  el.dateInput.max = isoDate(state.date);
  el.dateInput.addEventListener('change', () => {
    const [y, m, d] = el.dateInput.value.split('-').map(Number);
    state.date = new Date(Date.UTC(y, m - 1, d));
    loadVolumeList();
  });

  el.refreshBtn.addEventListener('click', () => loadVolumeList());
  el.liveBtn.addEventListener('click', toggleLive);
  el.opacity.addEventListener('input', () => {
    state.opacity = el.opacity.value / 100;
    el.opacityVal.textContent = el.opacity.value + '%';
    if (state.map && state.map.getLayer && state.map.getLayer('radar'))
      state.map.setPaintProperty('radar', 'raster-opacity', state.opacity);
  });
  el.palInput.addEventListener('change', (e) => loadPalFile(e.target.files[0]));
  el.palReset.addEventListener('click', resetPalettes);

  // Live NWS watches/warnings overlay.
  state.alerts = new AlertsController(state.map, {
    listPanel: el.alertList,
    list: el.alertList,
    detail: el.alertDetail,
    detailPanel: el.alertDetailPanel,
    close: el.alertClose,
  });
  state.alerts.start();
  el.alertsToggle.addEventListener('click', () => {
    const on = !el.alertsToggle.classList.contains('active');
    el.alertsToggle.classList.toggle('active', on);
    el.alertsToggle.textContent = on ? 'ON' : 'OFF';
    state.alerts.setEnabled(on);
  });

  el.ringsToggle.addEventListener('click', () => {
    state.showRings = !state.showRings;
    el.ringsToggle.classList.toggle('active', state.showRings);
    el.ringsToggle.textContent = state.showRings ? 'ON' : 'OFF';
    refreshRings();
  });

  // ---- Mobile dock + sheet + playback + inspect wiring ----
  el.dockStatus.addEventListener('click', () =>
    el.sheet.hidden ? openSheet() : closeSheet()
  );
  el.sheetScrim.addEventListener('click', closeSheet);
  el.sheetGrip.addEventListener('click', closeSheet);
  el.sheetClose.addEventListener('click', closeSheet);
  enableSheetSwipe();

  el.basemapSelect.value = state.basemap;
  el.basemapSelect.addEventListener('change', () =>
    setBasemap(el.basemapSelect.value)
  );
  el.inspectBtn.addEventListener('click', () => toggleInspect());
  el.playBtn.addEventListener('click', () => {
    if (state.playback.active) state.playback.stop();
    else state.playback.start();
  });
  el.playToggle.addEventListener('click', () => state.playback.toggle());
  el.playClose.addEventListener('click', () => state.playback.stop());
  el.playScrub.addEventListener('input', () =>
    state.playback.seek(Number(el.playScrub.value))
  );
  el.playSpeed.addEventListener('input', () => {
    const f = Number(el.playSpeed.value);
    el.playSpeedVal.textContent = f;
    state.playback.setFps(f);
  });

  mqMobile.addEventListener('change', applyResponsiveLayout);
  applyResponsiveLayout();

  window.addEventListener('resize', () => state.map && state.map.resize());
  setTimeout(() => state.map.resize(), 100);

  tickClock();
  setInterval(tickClock, 1000);
  loadVolumeList();
}

document.addEventListener('DOMContentLoaded', init);
