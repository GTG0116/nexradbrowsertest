// app.js — application controller: ties the data, decode, and render layers to
// the UI. Everything runs in the browser; the only network calls are the public
// S3 list/download requests in s3.js and the Mapbox GL basemap tiles.

import { listVolumes, fetchVolume, RADARS, nearestSite } from './s3.js';
import { PRODUCTS, PRODUCT_ORDER, makeScale, parsePal, palTargetProduct, dispValue, dispUnitOf, unitDecimals } from './products.js';
import { sampleAt, sweepMaxRange } from './renderer.js';
import { createRadarLayer } from './radarLayer.js';
import { dealiasSweep } from './dealias.js';
import { AlertsController } from './alerts.js';
import { SATELLITES, SECTORS, CONUS_VIEWS, listScenes, loadScene as loadGoesScene, ensureBands, sceneBBox, lonLatToColRow } from './goes.js';
import { SAT_CHANNELS, SAT_RGB, SAT_RGB_ORDER, bandsFor, buildRGBA, WV_BANDS, enhancementGradientCSS } from './satProducts.js';
import { createSatelliteLayer } from './satelliteLayer.js';
import { MRMS_PRODUCTS, MRMS_ORDER, listMrms, loadMrms } from './mrms.js';
import { createGridLayer } from './gridLayer.js';

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

// The radar is drawn by a custom WebGL layer (radarLayer.js) that samples the
// polar gate data per screen pixel with NEAREST lookup, every frame. There is no
// rasterised canvas to size to the zoom: the gates stay pixel-exact at any zoom,
// so the old resolution/“auto smoothing” machinery is gone.

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
      layout: { visibility: state.showRings ? 'visible' : 'none' },
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

  // Repaint the active source's layer into its place between fill and line.
  if (state.mode === 'radar' && state.shownSweep && state.shownSite)
    setRadarSource(map, state.shownSweep, PRODUCTS[state.productId], state.shownSite);
  else if (state.mode === 'satellite' && state.sat.scene) renderSatellite();
  else if (state.mode === 'mrms' && state.mrms.grid) renderMrms();
  if (state.alerts) state.alerts.refreshVisible();
}

// Hand the current sweep to the custom WebGL radar layer, inserting the layer
// beneath the alert outline if it isn't on the map yet. The layer then renders
// the polar data directly on the GPU every frame — no rasterised image, so the
// gates stay pixel-exact at every zoom and pan/zoom cost no JavaScript.
function setRadarSource(map, sweep, product, site) {
  if (!state.radarLayer) state.radarLayer = createRadarLayer();
  if (!map.getLayer('radar'))
    map.addLayer(
      state.radarLayer,
      map.getLayer('alerts-line') ? 'alerts-line' : firstLabelLayerId(map)
    );
  state.radarLayer.setSweep(sweep, product, site);
  state.radarLayer.setOpacity(state.opacity);
}

function clearRadarSource(map) {
  if (!map) return;
  if (state.radarLayer) state.radarLayer.clear();
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
  dealias: false,
  live: false,
  liveTimer: null,
  map: null,
  basemap: 'dark',
  showRings: true,
  radarLayer: null,
  styleReady: false,
  geo: null,
  alerts: null,
  shownSweep: null,
  shownSite: null,
  inspect: false,
  playback: null,

  // Source mode: 'radar' | 'satellite' | 'mrms'.
  mode: 'radar',
  // Satellite (GOES ABI) state.
  sat: {
    satKey: 'goes19',
    sectorKey: 'conus',
    productId: 'C13',
    enhanceIR: true,
    scenes: [],
    sceneKey: null,
    scene: null,
    layer: null,
  },
  // MRMS state.
  mrms: {
    productId: 'REFC',
    frames: [],
    frameKey: null,
    grid: null,
    layer: null,
  },
};

const $ = (sel) => document.querySelector(sel);
const el = {};

function cacheEls() {
  el.map = $('#map');
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
  el.ringsToggle = $('#ringsToggle');
  el.dealiasToggle = $('#dealiasToggle');
  el.dealiasField = $('#dealiasField');
  el.palInput = $('#palInput');
  el.palReset = $('#palReset');
  el.palName = $('#palName');
  el.alertList = $('#alertList');
  el.alertsToggle = $('#alertsToggle');
  el.alertDetail = $('#alertDetail');
  el.alertDetailPanel = $('#alertDetailPanel');
  el.alertClose = $('#alertClose');

  // Source modes (radar / satellite / MRMS).
  el.modeSwitch = $('#modeSwitch');
  el.siteField = $('#siteField');
  el.satFields = $('#satFields');
  el.satSelect = $('#satSelect');
  el.sectorSelect = $('#sectorSelect');
  el.conusViewField = $('#conusViewField');
  el.conusViewSelect = $('#conusViewSelect');
  el.mrmsFields = $('#mrmsFields');
  el.volumeTitle = $('#volumeTitle');
  el.tiltPanel = $('#tiltPanel');
  el.satOptsPanel = $('#satOptsPanel');
  el.irEnhanceToggle = $('#irEnhanceToggle');
  el.satInfo = $('#satInfo');

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

  // No zoom handling needed: the custom radar layer re-samples the polar data
  // per pixel every frame, so it stays pixel-exact at any zoom on its own.

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
  if (state.mode === 'satellite') return buildSatProductButtons();
  if (state.mode === 'mrms') return buildMrmsProductButtons();
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
      // Reflect this product's custom palette (if any) in the .pal name label.
      el.palName.textContent = p.customPal ? `${p.customPal} → ${id}` : '';
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
  if (state.mode === 'satellite') return buildSatLegend();
  if (state.mode === 'mrms') return buildMrmsLegend();
  const p = PRODUCTS[state.productId];
  el.legend.innerHTML = legendHTML(p, p.scale);
}

// Build the legend markup for a product/scale, with imperial tick labels.
function legendHTML(p, scale) {
  const { lo, hi, rgba, steps } = scale;
  const segs = 80;
  const colors = [];
  for (let i = 0; i <= segs; i++) {
    let li = Math.round((i / segs) * (steps - 1));
    if (li >= steps) li = steps - 1;
    const o = li * 4;
    colors.push(`rgb(${rgba[o]},${rgba[o + 1]},${rgba[o + 2]}) ${(i / segs) * 100}%`);
  }
  const u = dispUnitOf(p);
  const dec = unitDecimals(u);
  const tick = (v) => dispValue(p, v).toFixed(dec);
  return `
    <div class="legend-title">${p.name} <span>(${u})</span></div>
    <div class="legend-bar" style="background:linear-gradient(90deg,${colors.join(',')})"></div>
    <div class="legend-ticks"><span>${tick(lo)}</span><span>${tick((lo + hi) / 2)}</span><span>${tick(hi)}</span></div>`;
}

// ---------------------------------------------------------------------------
// Custom .pal color tables (GRLevelX / GR2Analyst format)
// ---------------------------------------------------------------------------
// Custom palettes are remembered across visits in localStorage, keyed by the
// radar product they apply to, so a loaded .pal survives a reload (storage may
// be unavailable in private mode — every access is guarded).
const PAL_STORE_KEY = 'aether.pals';

function readPalStore() {
  try {
    return JSON.parse(localStorage.getItem(PAL_STORE_KEY) || '{}') || {};
  } catch (_) {
    return {};
  }
}

function writePalStore(store) {
  try {
    localStorage.setItem(PAL_STORE_KEY, JSON.stringify(store));
  } catch (_) {
    /* storage full or blocked — the palette still applies for this session */
  }
}

// Apply a parsed palette to a product's color scale (no UI side effects).
function applyPal(targetId, pal, name) {
  const p = PRODUCTS[targetId];
  if (!p) return;
  p.scale = makeScale(pal.segments);
  p.range = [p.scale.lo, p.scale.hi];
  if (pal.units) p.unit = pal.units;
  // A custom palette defines values in its own units, so show them verbatim
  // (no imperial conversion on top of the author's scale).
  p.dispUnit = pal.units || p.unit;
  p.dispFactor = 1;
  p.dispOffset = 0;
  p.customPal = name;
}

async function loadPalFile(file) {
  if (!file) return;
  try {
    const text = await file.text();
    const pal = parsePal(text);
    // Apply to the product the file names, falling back to the current one.
    const targetId = palTargetProduct(pal) || state.productId;
    applyPal(targetId, pal, file.name);

    // Persist the raw .pal text so it can be re-applied on the next visit.
    const store = readPalStore();
    store[targetId] = { name: file.name, text };
    writePalStore(store);

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

// Re-apply any saved palettes on startup. Runs before the first legend/render so
// the restored colors show immediately.
function restoreStoredPals() {
  const store = readPalStore();
  for (const [id, entry] of Object.entries(store)) {
    if (!PRODUCTS[id] || !entry || !entry.text) continue;
    try {
      applyPal(id, parsePal(entry.text), entry.name);
    } catch (_) {
      /* skip a corrupt stored entry */
    }
  }
  const cur = PRODUCTS[state.productId];
  if (cur && cur.customPal) el.palName.textContent = `${cur.customPal} → ${state.productId}`;
}

function resetPalettes() {
  for (const id of PRODUCT_ORDER) {
    const p = PRODUCTS[id];
    p.scale = p.defaultScale;
    p.range = [p.scale.lo, p.scale.hi];
    p.unit = p.defaultUnit;
    p.dispUnit = p.defaultDispUnit;
    p.dispFactor = p.defaultDispFactor;
    p.dispOffset = p.defaultDispOffset;
    delete p.customPal;
  }
  writePalStore({}); // forget the saved palettes too
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

// Resolve the sweep actually shown: apply velocity dealiasing when enabled and
// the velocity product is selected. Memoised in dealias.js, so this is cheap.
function resolveSweep(sweep) {
  if (sweep && state.dealias && state.productId === 'VEL') return dealiasSweep(sweep);
  return sweep;
}

// Format a native physical value in the product's imperial display units.
function fmtValue(product, v) {
  const u = dispUnitOf(product);
  return `${dispValue(product, v).toFixed(unitDecimals(u))} ${u}`;
}

// Draw one sweep (from any volume) onto the map and remember it so the inspect
// readout and dock can reflect what is actually on screen.
function displaySweep(sweep, site) {
  const product = PRODUCTS[state.productId];
  sweep = resolveSweep(sweep);
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
  drawRings(site, maxR);
  updateInspect();
}

function drawRings(site, maxR) {
  const src = state.map && state.map.getSource('rings');
  if (!src) return;
  src.setData(site ? ringsGeoJSON(site, maxR) : { type: 'FeatureCollection', features: [] });
}

// ===========================================================================
// Source modes — Radar / Satellite (GOES ABI) / MRMS
//
// The three sources share the same map, time list, opacity, basemap and
// playback chrome; switching mode swaps the product menu, the controls shown in
// the rails, and which custom GL layer is live. Radar stays exactly as it was.
// ===========================================================================
const p2 = (n) => String(n).padStart(2, '0');

function applyModePanels() {
  el.siteField.hidden = state.mode !== 'radar';
  el.satFields.hidden = state.mode !== 'satellite';
  el.mrmsFields.hidden = state.mode !== 'mrms';
  el.tiltPanel.hidden = state.mode !== 'radar';
  el.satOptsPanel.hidden = state.mode !== 'satellite';
  if (el.dealiasField) el.dealiasField.hidden = state.mode !== 'radar';
  el.conusViewField.hidden = !(state.mode === 'satellite' && state.sat.sectorKey === 'conus');
  el.volumeTitle.textContent =
    state.mode === 'radar' ? 'Volume scans'
    : state.mode === 'satellite' ? 'Satellite scans' : 'MRMS frames';
  document.querySelectorAll('.mode-btn')
    .forEach((b) => b.classList.toggle('active', b.dataset.mode === state.mode));
}

function setMode(mode) {
  if (state.mode === mode) return;
  if (state.playback && state.playback.active) state.playback.stop();
  state.mode = mode;
  if (mode !== 'radar') clearRadarSource(state.map);
  if (mode !== 'satellite') clearSatellite();
  if (mode !== 'mrms') clearMrms();
  applyModePanels();
  buildProductButtons();
  buildLegend();
  state._forceLatest = true;

  if (mode === 'radar') {
    buildTiltList();
    buildVolumeList();
    if (state.volumes.length) loadVolumeList();
    renderRadar();
  } else if (mode === 'satellite') {
    loadSatScenes();
  } else if (mode === 'mrms') {
    loadMrmsList();
  }
  updateMeta();
}

// Dispatch refresh / live / date changes to the active source.
function refreshActive() {
  if (state.mode === 'radar') return loadVolumeList();
  if (state.mode === 'satellite') return loadSatScenes();
  return loadMrmsList();
}

// ---------------------------------------------------------------------------
// Satellite (GOES ABI)
// ---------------------------------------------------------------------------
function initSatSelects() {
  for (const [key, sat] of Object.entries(SATELLITES)) {
    const o = document.createElement('option');
    o.value = key; o.textContent = sat.label;
    if (key === state.sat.satKey) o.selected = true;
    el.satSelect.appendChild(o);
  }
  for (const [key, sec] of Object.entries(SECTORS)) {
    const o = document.createElement('option');
    o.value = key; o.textContent = sec.label;
    if (key === state.sat.sectorKey) o.selected = true;
    el.sectorSelect.appendChild(o);
  }
  CONUS_VIEWS.forEach(([name], i) => {
    const o = document.createElement('option');
    o.value = String(i); o.textContent = name;
    el.conusViewSelect.appendChild(o);
  });

  el.satSelect.addEventListener('change', () => {
    state.sat.satKey = el.satSelect.value;
    state.sat._centered = false;
    loadSatScenes();
  });
  el.sectorSelect.addEventListener('change', () => {
    state.sat.sectorKey = el.sectorSelect.value;
    state.sat._centered = false;
    applyModePanels();
    loadSatScenes();
  });
  el.conusViewSelect.addEventListener('change', () => {
    const v = CONUS_VIEWS[+el.conusViewSelect.value];
    if (v && state.map) state.map.fitBounds([[v[1][0], v[1][1]], [v[1][2], v[1][3]]], { padding: 12, animate: true });
  });
  el.irEnhanceToggle.addEventListener('click', () => {
    state.sat.enhanceIR = !state.sat.enhanceIR;
    el.irEnhanceToggle.classList.toggle('active', state.sat.enhanceIR);
    el.irEnhanceToggle.textContent = state.sat.enhanceIR ? 'ON' : 'OFF';
    if (state.mode === 'satellite') { renderSatellite(); buildSatLegend(); }
  });
}

function buildSatProductButtons() {
  el.productButtons.innerHTML = '';
  const add = (id, label, name) => {
    const btn = document.createElement('button');
    btn.className = 'product-btn';
    btn.dataset.id = id;
    btn.innerHTML = `<span class="pb-id">${label}</span><span class="pb-name">${name}</span>`;
    if (id === state.sat.productId) btn.classList.add('active');
    btn.addEventListener('click', async () => {
      state.sat.productId = id;
      document.querySelectorAll('.product-btn').forEach((b) => b.classList.toggle('active', b.dataset.id === id));
      buildSatLegend();
      // Decode any extra bands this product needs from the cached file first.
      if (state.sat.scene) {
        setStatus('rendering GOES…', true);
        await ensureBands(state.sat.scene, bandsFor(id));
        renderSatellite();
        setStatus('GOES ready');
      }
      updateSatInfo();
    });
    el.productButtons.appendChild(btn);
  };
  for (const ch of SAT_CHANNELS) add('C' + p2(ch.band), 'C' + p2(ch.band), `${ch.name} · ${ch.um}µm`);
  for (const id of SAT_RGB_ORDER) add('RGB_' + id, SAT_RGB[id].short, SAT_RGB[id].name + ' RGB');
}

function buildSatList() {
  el.volumeList.innerHTML = '';
  if (!state.sat.scenes.length) {
    el.volumeList.innerHTML = '<div class="empty">No scenes found.</div>';
    return;
  }
  [...state.sat.scenes].reverse().forEach((v) => {
    const btn = document.createElement('button');
    btn.className = 'vol-btn';
    if (v.key === state.sat.sceneKey) btn.classList.add('active');
    btn.innerHTML = `<span class="dot"></span>${v.label}`;
    btn.addEventListener('click', () => loadSatScene(v.key));
    el.volumeList.appendChild(btn);
  });
}

async function loadSatScenes() {
  if (state.mode !== 'satellite') return;
  setStatus('listing GOES…', true);
  buildSatList();
  try {
    const when = state.live ? new Date() : state.date;
    const scenes = await listScenes(state.sat.satKey, state.sat.sectorKey, when);
    state.sat.scenes = scenes;
    buildSatList();
    setStatus(`${scenes.length} GOES scenes`);
    if (!scenes.length) return;
    const latest = scenes[scenes.length - 1].key;
    if (state._forceLatest || !state.sat.scene || state.live) {
      state._forceLatest = false;
      if (latest !== state.sat.sceneKey) loadSatScene(latest);
    }
  } catch (e) {
    setStatus(`GOES list error: ${e.message}`);
    console.error(e);
  }
}

async function loadSatScene(key) {
  state.sat.sceneKey = key;
  buildSatList();
  setStatus('downloading GOES…', true);
  el.progress.style.width = '0%';
  el.progress.classList.add('show');
  try {
    const scene = await loadGoesScene(state.sat.satKey, state.sat.sectorKey, key, bandsFor(state.sat.productId), (p) => {
      el.progress.style.width = Math.round(p * 100) + '%';
    });
    setStatus('rendering GOES…', true);
    el.decoding.classList.add('show');
    state.sat.scene = scene;
    state.sat._bbox = null;
    if (!state.sat._centered) {
      const bb = sceneBBox(scene);
      state.map.fitBounds([[bb[0], bb[1]], [bb[2], bb[3]]], { padding: 16, animate: false });
      state.sat._centered = true;
    }
    renderSatellite();
    updateSatInfo();
    setStatus(`GOES ${SECTORS[state.sat.sectorKey].label} loaded`);
  } catch (e) {
    setStatus(`GOES error: ${e.message}`);
    console.error(e);
  } finally {
    el.progress.classList.remove('show');
    el.decoding.classList.remove('show');
  }
}

function setSatelliteSource(map) {
  if (!state.sat.layer) state.sat.layer = createSatelliteLayer();
  if (!map.getLayer('satellite'))
    map.addLayer(state.sat.layer, map.getLayer('alerts-line') ? 'alerts-line' : firstLabelLayerId(map));
}

function clearSatellite() {
  if (state.sat.layer) state.sat.layer.clear();
}

function renderSatellite() {
  const map = state.map;
  if (!map || !state.styleReady) return;
  const scene = state.sat.scene;
  if (!scene) { clearSatellite(); return; }
  const rgba = buildRGBA(scene, state.sat.productId, { enhanceIR: state.sat.enhanceIR });
  const bbox = state.sat._bbox || (state.sat._bbox = sceneBBox(scene));
  setSatelliteSource(map);
  state.sat.layer.setScene(scene, rgba, bbox);
  state.sat.layer.setOpacity(state.opacity);
}

function buildSatLegend() {
  const id = state.sat.productId;
  if (id.startsWith('C')) {
    const band = parseInt(id.slice(1), 10);
    const meta = SAT_CHANNELS[band - 1];
    const isVis = meta.type === 'vis';
    const isWV = WV_BANDS.has(band);
    const grad = isVis
      ? 'linear-gradient(90deg,#000,#fff)'
      : state.sat.enhanceIR
      ? enhancementGradientCSS(band)
      : 'linear-gradient(90deg,#fff,#000)';
    const kind = isVis ? 'reflectance' : isWV ? 'WV brightness temp' : 'brightness temp';
    // Warmest knot is +50°C (122°F) for IR, 0°C (32°F) for WV; coldest −95°C (−139°F).
    const warmTick = isWV ? '32°F' : '122°F';
    const ticks = isVis ? '<span>0</span><span>reflectance</span><span>1</span>'
      : `<span>${warmTick}</span><span>${kind}</span><span>−139°F</span>`;
    el.legend.innerHTML = `
      <div class="legend-title">${meta.name} <span>(${id} · ${meta.um}µm)</span></div>
      <div class="legend-bar" style="background:${grad}"></div>
      <div class="legend-ticks">${ticks}</div>`;
  } else {
    const r = SAT_RGB[id.replace(/^RGB_/, '')];
    el.legend.innerHTML = `
      <div class="legend-title">${r.name} <span>(RGB composite)</span></div>
      <div class="legend-bar" style="background:linear-gradient(90deg,#f33,#3f3,#33f)"></div>
      <div class="legend-ticks"><span>multi-band</span><span>${r.day ? 'daytime' : 'day/night'}</span></div>`;
  }
}

function updateSatInfo() {
  const s = state.sat;
  const sat = SATELLITES[s.satKey];
  const sec = SECTORS[s.sectorKey];
  const t = s.scene && s.scene.time;
  el.satInfo.innerHTML = `
    <div class="meta-row"><span>Satellite</span><b>${sat.label}</b></div>
    <div class="meta-row"><span>Sector</span><b>${sec.label}</b></div>
    <div class="meta-row"><span>Grid</span><b>${s.scene ? s.scene.width + '×' + s.scene.height : '—'}</b></div>
    <div class="meta-row"><span>Scan time</span><b>${t ? p2(t.getUTCHours()) + ':' + p2(t.getUTCMinutes()) + 'Z' : '—'}</b></div>
    <div class="meta-row"><span>Refresh</span><b>${sec.refresh}</b></div>`;
}

// ---------------------------------------------------------------------------
// MRMS
// ---------------------------------------------------------------------------
function buildMrmsProductButtons() {
  el.productButtons.innerHTML = '';
  for (const id of MRMS_ORDER) {
    const p = MRMS_PRODUCTS[id];
    const btn = document.createElement('button');
    btn.className = 'product-btn';
    btn.dataset.id = id;
    btn.innerHTML = `<span class="pb-id">${id}</span><span class="pb-name">${p.name}</span>`;
    if (id === state.mrms.productId) btn.classList.add('active');
    btn.addEventListener('click', () => {
      state.mrms.productId = id;
      document.querySelectorAll('.product-btn').forEach((b) => b.classList.toggle('active', b.dataset.id === id));
      buildMrmsLegend();
      loadMrmsList(); // each product is a different S3 folder
    });
    el.productButtons.appendChild(btn);
  }
}

function buildMrmsList() {
  el.volumeList.innerHTML = '';
  if (!state.mrms.frames.length) {
    el.volumeList.innerHTML = '<div class="empty">No frames found for this day.</div>';
    return;
  }
  [...state.mrms.frames].reverse().forEach((v) => {
    const btn = document.createElement('button');
    btn.className = 'vol-btn';
    if (v.key === state.mrms.frameKey) btn.classList.add('active');
    btn.innerHTML = `<span class="dot"></span>${v.label}`;
    btn.addEventListener('click', () => loadMrmsFrame(v.key));
    el.volumeList.appendChild(btn);
  });
}

async function loadMrmsList() {
  if (state.mode !== 'mrms') return;
  setStatus('listing MRMS…', true);
  buildMrmsList();
  try {
    const when = state.live ? new Date() : state.date;
    const frames = await listMrms(state.mrms.productId, when);
    state.mrms.frames = frames;
    buildMrmsList();
    setStatus(`${frames.length} MRMS frames`);
    if (!frames.length) return;
    const latest = frames[frames.length - 1].key;
    if (state._forceLatest || !state.mrms.grid || state.live) {
      state._forceLatest = false;
      if (latest !== state.mrms.frameKey) loadMrmsFrame(latest);
    }
  } catch (e) {
    setStatus(`MRMS list error: ${e.message}`);
    console.error(e);
  }
}

async function loadMrmsFrame(key) {
  state.mrms.frameKey = key;
  buildMrmsList();
  setStatus('downloading MRMS…', true);
  el.progress.style.width = '0%';
  el.progress.classList.add('show');
  try {
    const grid = await loadMrms(state.mrms.productId, key, (p) => {
      el.progress.style.width = Math.round(p * 100) + '%';
    });
    setStatus('decoding MRMS…', true);
    el.decoding.classList.add('show');
    state.mrms.grid = grid;
    renderMrms();
    setStatus(`MRMS ${grid.product.name} loaded`);
  } catch (e) {
    setStatus(`MRMS error: ${e.message}`);
    console.error(e);
  } finally {
    el.progress.classList.remove('show');
    el.decoding.classList.remove('show');
  }
}

function setMrmsSource(map) {
  if (!state.mrms.layer) state.mrms.layer = createGridLayer();
  if (!map.getLayer('mrms'))
    map.addLayer(state.mrms.layer, map.getLayer('alerts-line') ? 'alerts-line' : firstLabelLayerId(map));
}

function clearMrms() {
  if (state.mrms.layer) state.mrms.layer.clear();
}

function renderMrms() {
  const map = state.map;
  if (!map || !state.styleReady) return;
  const grid = state.mrms.grid;
  if (!grid) { clearMrms(); return; }
  setMrmsSource(map);
  state.mrms.layer.setGrid(grid, grid.product);
  state.mrms.layer.setOpacity(state.opacity);
}

function buildMrmsLegend() {
  const p = MRMS_PRODUCTS[state.mrms.productId];
  el.legend.innerHTML = legendHTML(p, p.scale);
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

// Sample whichever data layer is active at a geographic point. Returns null
// (no layer), { out: true } (off coverage), or { main, sub } formatted strings.
function sampleActive(lat, lon) {
  if (state.mode === 'satellite') return sampleSatAt(lat, lon);
  if (state.mode === 'mrms') return sampleMrmsAt(lat, lon);
  return sampleRadarAt(lat, lon);
}

function sampleRadarAt(lat, lon) {
  const product = PRODUCTS[state.productId];
  const sweep = state.shownSweep;
  const site = state.shownSite;
  if (!sweep || !site) return null;
  const s = sampleAt(sweep, product, lat, lon, site);
  if (!s || s.range > sweepMaxRange(sweep, product.moment)) return { out: true };
  const main = s.value == null ? 'no echo' : fmtValue(product, s.value);
  const mi = ((s.range / 1000) * 0.621371).toFixed(0);
  return { main, sub: `${product.id} · az ${s.az.toFixed(0)}° · ${mi} mi` };
}

function sampleSatAt(lat, lon) {
  const scene = state.sat.scene;
  if (!scene) return null;
  const id = state.sat.productId;
  const cr = lonLatToColRow(scene, lat, lon);
  if (!cr) return { out: true };
  if (!id.startsWith('C'))
    return { main: SAT_RGB[id.replace(/^RGB_/, '')].short, sub: 'RGB composite' };
  const band = parseInt(id.slice(1), 10);
  const meta = SAT_CHANNELS[band - 1];
  const arr = scene.channels[band];
  if (!arr) return { out: true };
  const v = arr[Math.round(cr.row) * scene.width + Math.round(cr.col)];
  if (Number.isNaN(v)) return { main: 'no data', sub: id };
  if (meta.type === 'vis') return { main: `${(v * 100).toFixed(0)} %`, sub: `${id} reflectance` };
  const f = ((v - 273.15) * 9 / 5 + 32).toFixed(0);
  return { main: `${f} °F`, sub: `${id} cloud-top` };
}

function sampleMrmsAt(lat, lon) {
  const grid = state.mrms.grid;
  if (!grid) return null;
  const p = grid.product;
  const i = Math.floor((lon - grid.lon1) / grid.di);
  const j = Math.floor((grid.lat1 - lat) / grid.dj);
  if (i < 0 || i >= grid.ni || j < 0 || j >= grid.nj) return { out: true };
  const v = grid.values[j * grid.ni + i];
  if (Number.isNaN(v) || !(v >= p.floor)) return { main: 'no data', sub: p.id };
  return { main: fmtValue(p, v), sub: p.id };
}

function updateInspect() {
  if (!state.inspect) return;
  const c = state.map.getCenter();
  const r = sampleActive(c.lat, c.lng);
  if (!r) { el.crosshairRead.textContent = 'no data'; return; }
  if (r.out) { el.crosshairRead.textContent = 'out of range'; return; }
  el.crosshairRead.innerHTML = `<b>${r.main}</b> · ${r.sub}`;
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

const SHEET_EASE = 'cubic-bezier(.22,1,.36,1)';
let sheetCloseTimer = null;

function openSheet() {
  if (sheetCloseTimer) { clearTimeout(sheetCloseTimer); sheetCloseTimer = null; }
  el.sheet.hidden = false;
  el.sheetScrim.hidden = false;
  document.querySelector('.app').classList.add('sheet-open');
  // Slide up from the bottom: start off-screen, then animate to rest next frame.
  el.sheet.style.transition = 'none';
  el.sheet.style.transform = 'translateY(100%)';
  // Force a reflow so the starting transform is committed before transitioning.
  void el.sheet.offsetHeight;
  requestAnimationFrame(() => {
    el.sheet.style.transition = `transform 0.3s ${SHEET_EASE}`;
    el.sheet.style.transform = 'translateY(0)';
  });
}

function closeSheet() {
  if (el.sheet.hidden) return;
  el.sheet.style.transition = `transform 0.24s ${SHEET_EASE}`;
  el.sheet.style.transform = 'translateY(110%)';
  el.sheetScrim.hidden = true;
  document.querySelector('.app').classList.remove('sheet-open');
  if (sheetCloseTimer) clearTimeout(sheetCloseTimer);
  sheetCloseTimer = setTimeout(() => {
    sheetCloseTimer = null;
    el.sheet.hidden = true;
    el.sheet.style.transform = '';
    el.sheet.style.transition = '';
  }, 240);
}

// Drag the settings sheet down to dismiss it — a more discoverable close than
// tapping the scrim. A short flick or a drag past ~90px closes; otherwise it
// springs back. Dragging starts from the header (the grip) so list scrolling
// inside the body isn't hijacked.
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
  const r = sampleActive(latlng.lat, latlng.lng);
  if (!r || r.out) {
    el.readout.classList.remove('show');
    return;
  }
  el.readout.innerHTML = `<b>${r.main}</b><span>${r.sub}</span>`;
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
    refreshActive();
    state.liveTimer = setInterval(() => refreshActive(), 60000);
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
  restoreStoredPals(); // re-apply any saved .pal color tables before first paint
  buildProductButtons();
  buildLegend();
  buildTiltList();

  state.playback = createPlayback();
  state.map.on('move', updateInspect);

  // Source-mode switch + satellite controls.
  initSatSelects();
  applyModePanels();
  el.modeSwitch.addEventListener('click', (e) => {
    const btn = e.target.closest('.mode-btn');
    if (btn) setMode(btn.dataset.mode);
  });

  el.dateInput.value = isoDate(state.date);
  el.dateInput.max = isoDate(state.date);
  el.dateInput.addEventListener('change', () => {
    const [y, m, d] = el.dateInput.value.split('-').map(Number);
    state.date = new Date(Date.UTC(y, m - 1, d));
    state._forceLatest = true;
    refreshActive();
  });

  el.refreshBtn.addEventListener('click', () => refreshActive());
  el.liveBtn.addEventListener('click', toggleLive);
  el.opacity.addEventListener('input', () => {
    state.opacity = el.opacity.value / 100;
    el.opacityVal.textContent = el.opacity.value + '%';
    if (state.radarLayer) state.radarLayer.setOpacity(state.opacity);
    if (state.sat.layer) state.sat.layer.setOpacity(state.opacity);
    if (state.mrms.layer) state.mrms.layer.setOpacity(state.opacity);
  });
  el.palInput.addEventListener('change', (e) => loadPalFile(e.target.files[0]));
  el.palReset.addEventListener('click', resetPalettes);

  // Range-ring visibility — toggles the GL layer in place (the geometry is
  // already built, so there's nothing to recompute).
  el.ringsToggle.addEventListener('click', () => {
    const on = !el.ringsToggle.classList.contains('active');
    el.ringsToggle.classList.toggle('active', on);
    el.ringsToggle.textContent = on ? 'ON' : 'OFF';
    state.showRings = on;
    if (state.map && state.map.getLayer && state.map.getLayer('rings'))
      state.map.setLayoutProperty('rings', 'visibility', on ? 'visible' : 'none');
  });

  // Velocity dealiasing — unfold aliased VEL gates. Re-renders the current sweep
  // (and refreshes the inspect/cursor readouts) through the same path.
  el.dealiasToggle.addEventListener('click', () => {
    const on = !el.dealiasToggle.classList.contains('active');
    el.dealiasToggle.classList.toggle('active', on);
    el.dealiasToggle.textContent = on ? 'ON' : 'OFF';
    state.dealias = on;
    renderRadar();
    updateInspect();
    setStatus(on ? 'velocity dealiasing on' : 'velocity dealiasing off');
  });

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

  // ---- Mobile dock + sheet + playback + inspect wiring ----
  el.dockStatus.addEventListener('click', () =>
    el.sheet.hidden ? openSheet() : closeSheet()
  );
  el.sheetScrim.addEventListener('click', closeSheet);
  el.sheetGrip.addEventListener('click', closeSheet);
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
