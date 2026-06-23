// app.js — application controller: ties the data, decode, and render layers to
// the UI. Everything runs in the browser; the only network calls are the public
// S3 list/download requests in s3.js and the Mapbox GL basemap tiles.

import { listVolumes, fetchVolume, RADARS, nearestSite, isTDWR } from './s3.js';
import { PRODUCTS, PRODUCT_ORDER, makeScale, parsePal, palTargetProduct, dispValue, dispUnitOf, unitDecimals, reflectivityProduct, displayFactorFor } from './products.js';
import { sampleAt, sweepMaxRange } from './renderer.js';
import { createRadarLayer } from './radarLayer.js';
import { dealiasSweep } from './dealias.js';
import { AlertsController } from './alerts.js';
import { SATELLITES, SECTORS, CONUS_VIEWS, listScenes, loadScene as loadGoesScene, ensureBands, sceneBBox, lonLatToColRow } from './goes.js';
import { SAT_CHANNELS, SAT_RGB, SAT_RGB_ORDER, bandsFor, buildRGBA, WV_BANDS, enhancementGradientCSS } from './satProducts.js';
import { createSatelliteLayer } from './satelliteLayer.js';
import { MRMS_PRODUCTS, MRMS_ORDER, listMrms, loadMrms } from './mrms.js';
import { MODELS, MODEL_PRODUCTS, MODEL_CATEGORIES, listModels, loadModel, forecastHours,
  modelSupports, defaultProductFor } from './models.js';
import { createGridLayer, prepareGridTexture } from './gridLayer.js';
import { setupModelOverlayLayers, renderModelOverlays, clearModelOverlays } from './modelOverlays.js';
import { fetchSounding, drawSkewT, drawHodograph, paramRows, soundingModel } from './sounding.js';
import { MetarController } from './metars.js';
import { MapTools } from './maptools.js';
import { SplitView } from './splitview.js';
import { ExportTool } from './export.js';

// Grid products (MRMS / models) flagged `reflectivity` borrow the single-site
// radar reflectivity color table, so all reflectivity is colored identically and
// a user-loaded reflectivity .pal applies everywhere. Resolved at use, never
// cached, so it always reflects REF's current (possibly custom) scale.
function resolveGridProduct(p) {
  return p && p.reflectivity ? reflectivityProduct(p) : p;
}

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

// Two insertion anchors keep the basemap legible over the radar.
//
// `firstLabelLayerId` (the *label* anchor) is the first administrative-boundary
// line — in every Mapbox style the boundaries sit just beneath the whole label
// stack. App annotations (alert outlines, range rings, site dots) and our own
// redrawn borders slot in here, so they stay above the basemap's roads but below
// the town-name labels.
function firstLabelLayerId(map) {
  const layers = map.getStyle().layers || [];
  for (const ly of layers) {
    if (ly.type === 'line' && /admin|boundary|border/i.test(ly.id)) return ly.id;
  }
  // No vector boundaries (e.g. a raster-only style): fall back to the first
  // label symbol so labels still draw on top of the radar.
  for (const ly of layers) {
    if (ly.type === 'symbol') return ly.id;
  }
  return undefined; // nothing matched → overlays go on top
}

// `dataLayerAnchor` (the *data* anchor) drops the radar/satellite/MRMS/model
// layers in just beneath the basemap's road network. Roads/tunnels/bridges all
// live in the `road` source-layer, so anchoring on the first of those makes the
// roads, highways, boundaries and labels all draw on top of the data (the classic
// radar-overlay look) while the data still drapes over the ground/water fills.
function dataLayerAnchor(map) {
  const layers = map.getStyle().layers || [];
  for (const ly of layers) {
    if ((ly.type === 'line' || ly.type === 'symbol') && ly['source-layer'] === 'road')
      return ly.id;
  }
  // No road layer: fall back to the first line/symbol so the data still sits
  // above the basemap's ground fills.
  for (const ly of layers) {
    if (ly.type === 'line' || ly.type === 'symbol') return ly.id;
  }
  return firstLabelLayerId(map);
}

// ---------------------------------------------------------------------------
// Overlay layers (radar, alerts, rings, radar-site dots)
//
// Slotted into the Mapbox style's own layer stack. Back to front:
//   basemap ground/water fills → alert fill → radar/data → basemap roads &
//   highways → our country/state/county outlines → alert outlines → range rings
//   → site dots → basemap town labels.
// So the radar drapes over the terrain while every reference line (roads,
// borders, county lines) and the labels stay legible on top of it.
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

// Stroke the coastline (and lake/large-river shores) by outlining the basemap's
// own `water` polygons. We reuse whatever vector source the active style packs
// them in (Mapbox styles call it `composite`), so it works across every basemap
// without shipping coastline geometry of our own. Drawn at the same anchor as the
// other overlays, so it sits above the radar fill but beneath the town labels.
function addCoastline(map, anchor) {
  if (map.getLayer('coastline')) return;
  const layers = map.getStyle().layers || [];
  const water = layers.find((l) => l['source-layer'] === 'water' && l.source);
  if (!water) return; // a label-free / raster style with no vector water layer
  map.addLayer(
    {
      id: 'coastline',
      type: 'line',
      source: water.source,
      'source-layer': 'water',
      layout: { 'line-join': 'round' },
      paint: {
        'line-color': 'rgba(130,190,235,0.55)',
        'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.6, 7, 1.2, 11, 1.8],
      },
    },
    anchor
  );
}

// White country/state borders (plus county lines) on every basemap.
//
// Every Mapbox style ships country (admin_level 0) and state (admin_level 1)
// borders in its `admin` vector source as `admin-0-boundary` / `admin-1-boundary`
// (each with a `-bg` casing layer) — but paints them crisply only on Dark/Light
// and almost invisibly on Satellite/Streets/Outdoors. Earlier versions tried to
// hide those native lines and redraw our own beneath them, but the redrawn lines
// ended up *under* the still-visible native ones, so the faint native borders
// were what actually showed — fine on Dark/Light, invisible on the rest.
//
// Instead we restyle the basemap's OWN admin lines in place. They already sit in
// the right spot in every style's layer stack (above the roads/radar, below the
// town labels), so recoloring them to white gives one identical, high-contrast
// look on every basemap without fighting layer order. Counties (admin_level 2)
// aren't drawn by the stock styles, so we still add those ourselves.
function adminSource(map) {
  const layers = map.getStyle().layers || [];
  const admin = layers.find((l) => l['source-layer'] === 'admin' && l.source);
  return admin && admin.source;
}

function styleBoundaries(map, anchor) {
  // Override paint on a native admin layer (if the style has it) and make sure
  // it's visible — setStyle resets these to their stock paint on every load.
  const repaint = (id, paint) => {
    if (!map.getLayer(id)) return;
    for (const [k, v] of Object.entries(paint)) map.setPaintProperty(id, k, v);
    map.setLayoutProperty(id, 'visibility', 'visible');
  };
  // Country (admin_level 0): bright white over a dark casing for contrast on any
  // basemap, light or dark.
  repaint('admin-0-boundary-bg', {
    'line-color': 'rgba(8,14,24,0.5)',
    'line-opacity': 1,
    'line-blur': 0,
    'line-width': ['interpolate', ['linear'], ['zoom'], 3, 2.6, 7, 3.8, 11, 4.8],
  });
  repaint('admin-0-boundary', {
    'line-color': '#ffffff',
    'line-opacity': 1,
    'line-dasharray': [1, 0], // solid
    'line-width': ['interpolate', ['linear'], ['zoom'], 3, 1.1, 7, 1.9, 11, 2.5],
  });
  repaint('admin-0-boundary-disputed', {
    'line-color': '#ffffff',
    'line-opacity': 0.9,
    'line-dasharray': [2, 2],
    'line-width': ['interpolate', ['linear'], ['zoom'], 3, 1, 7, 1.6, 11, 2.1],
  });
  // State (admin_level 1): white, thinner and dashed, over a faint dark casing.
  repaint('admin-1-boundary-bg', {
    'line-color': 'rgba(8,14,24,0.35)',
    'line-opacity': 1,
    'line-blur': 0,
    'line-width': ['interpolate', ['linear'], ['zoom'], 3, 1.4, 7, 2.2, 11, 3],
  });
  repaint('admin-1-boundary', {
    'line-color': '#ffffff',
    'line-opacity': 0.85,
    'line-dasharray': [3, 2],
    'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.5, 7, 1, 11, 1.5],
  });
  // Counties (admin_level 2): not drawn by the stock styles, so add our own from
  // the same `admin` source — faint white, and only once zoomed in (there are far
  // too many to read at continental scale).
  if (!map.getLayer('county-outline')) {
    const source = adminSource(map);
    if (!source) return; // raster-only style with no vector admin source
    map.addLayer(
      {
        id: 'county-outline',
        type: 'line',
        source,
        'source-layer': 'admin',
        // Match the basemap's own admin filtering: skip maritime/disputed
        // segments and pin to the US worldview.
        filter: [
          'all',
          ['==', ['get', 'admin_level'], 2],
          ['==', ['get', 'maritime'], 'false'],
          ['==', ['get', 'disputed'], 'false'],
          ['match', ['get', 'worldview'], ['all', 'US'], true, false],
        ],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        minzoom: 5,
        paint: {
          'line-color': 'rgba(255,255,255,0.35)',
          'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.3, 8, 0.7, 11, 1.1],
        },
      },
      anchor
    );
  }
}

function sitesGeoJSON() {
  return {
    type: 'FeatureCollection',
    features: RADARS.map(([icao, name, lat, lon]) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties: { icao, name, current: icao === state.site ? 1 : 0, tdwr: isTDWR(icao) ? 1 : 0 },
    })),
  };
}

// (Re)create all overlay sources and layers in the correct order. Called on
// every style load — including after a basemap switch, which wipes custom
// layers — and then repopulated with whatever data we currently hold.
function setupOverlays(map) {
  // Label anchor → annotations + our borders (above roads, below town labels).
  // Data anchor → radar/alert-fill (below the basemap roads, over the terrain).
  const anchor = firstLabelLayerId(map);
  const dataAnchor = dataLayerAnchor(map);

  if (!map.getSource('alerts'))
    map.addSource('alerts', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  if (!map.getSource('rings'))
    map.addSource('rings', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  if (!map.getSource('sites'))
    map.addSource('sites', { type: 'geojson', data: sitesGeoJSON() });

  // Translucent alert fill — sits below the radar (and the basemap roads).
  map.addLayer(
    {
      id: 'alerts-fill',
      type: 'fill',
      source: 'alerts',
      paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.18 },
    },
    dataAnchor
  );
  // Alert outline — at the label anchor, so it stays above the radar and the
  // basemap roads but beneath the town labels.
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
        // Active site → accent; TDWR terminal radars → yellow; NEXRAD → blue.
        'circle-color': [
          'case',
          ['==', ['get', 'current'], 1], '#36e0c8',
          ['==', ['get', 'tdwr'], 1], 'rgba(245,205,40,0.9)',
          'rgba(80,140,220,0.85)',
        ],
        'circle-stroke-color': [
          'case',
          ['==', ['get', 'current'], 1], '#36e0c8',
          ['==', ['get', 'tdwr'], 1], 'rgba(255,230,130,0.95)',
          'rgba(150,205,255,0.85)',
        ],
        'circle-stroke-width': ['case', ['==', ['get', 'current'], 1], 2, 1],
        'circle-opacity': ['case', ['==', ['get', 'current'], 1], 1, 0.6],
      },
    },
    anchor
  );

  addCoastline(map, anchor);
  // Restyle the basemap's own country/state borders to white (and add county
  // lines) so they look the same on every basemap instead of only showing up on
  // Dark/Light. The native admin lines already sit above the radar/roads and
  // below the town labels, so recoloring them in place keeps that ordering.
  styleBoundaries(map, anchor);

  refreshSiteDots();

  // Repaint the active source's layer into its place between fill and line.
  if (state.mode === 'radar' && state.shownSweep && state.shownSite)
    setRadarSource(map, state.shownSweep, PRODUCTS[state.productId], state.shownSite);
  else if (state.mode === 'satellite' && state.sat.scene) renderSatellite();
  else if (state.mode === 'mrms' && state.mrms.grid) renderMrms();
  else if (state.mode === 'models' && state.models.grid) renderModels();
  // Re-apply the single-site radar overlay if it's enabled in a non-radar mode.
  if (state.mode !== 'radar' && state.radarOverlay) applyRadarOverlay();
  if (state.alerts) state.alerts.refreshVisible();
}

// Hand the current sweep to the custom WebGL radar layer, inserting the layer at
// the data anchor (beneath the basemap roads/borders) if it isn't on the map yet.
// The layer then renders the polar data directly on the GPU every frame — no
// rasterised image, so the gates stay pixel-exact at every zoom and pan/zoom cost
// no JavaScript.
function setRadarSource(map, sweep, product, site) {
  if (!state.radarLayer) state.radarLayer = createRadarLayer();
  if (!map.getLayer('radar')) map.addLayer(state.radarLayer, dataLayerAnchor(map));
  state.radarLayer.setSweep(sweep, product, site);
  state.radarLayer.setOpacity(state.opacity);
  state.radarLayer.setSmooth(state.smooth);
}

function clearRadarSource(map) {
  if (!map) return;
  if (state.radarLayer) state.radarLayer.clear();
}

// Decode volumes off the main thread.
// A small pool of decode workers so playback can decompress several volumes at
// once. A single worker serialises every decode, which made building a loop
// slow (each multi-MB frame waited for the previous one); a pool lets the
// parallel frame loader below keep more than one core busy. Sized to the
// hardware but capped so we don't spawn a worker per frame or hog memory.
const DECODE_POOL_SIZE = Math.min(4, Math.max(2, (navigator.hardwareConcurrency || 4) - 1));
let decodeSeq = 0;
let decodeRR = 0;
const pending = new Map();
const decodeWorkers = Array.from({ length: DECODE_POOL_SIZE }, () => {
  const w = new Worker(new URL('./decoder.worker.js', import.meta.url), {
    type: 'module',
  });
  w.onmessage = (e) => {
    const { id, ok, result, error } = e.data;
    const job = pending.get(id);
    if (!job) return;
    pending.delete(id);
    if (ok) job.resolve(result);
    else job.reject(new Error(error));
  };
  return w;
});
function decodeVolume(bytes) {
  const id = ++decodeSeq;
  // Round-robin across the pool; jobs are keyed by a global id so replies route
  // back correctly regardless of which worker answers first.
  const w = decodeWorkers[decodeRR++ % decodeWorkers.length];
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, bytes }, [bytes.buffer]); // zero-copy transfer
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
  // Bilinear-smooth the plotted data (radar / satellite / model / MRMS) instead
  // of the crisp native-resolution default. Opt-in: off so nothing auto-smooths.
  smooth: false,
  // Unfold aliased velocities by default: without this, gates beyond the Nyquist
  // co-interval fold back to small/wrong-signed values, so VEL reads much lower
  // than dealiased sources (RadarScope, GR2Analyst, NWS). The toggle can turn it
  // off to inspect the raw folded field.
  dealias: true,
  live: false,
  liveTimer: null,
  map: null,
  basemap: 'dark',
  showRings: true,
  // Persist the map view, last product and settings between visits (toggleable).
  persist: true,
  radarLayer: null,
  // In satellite / MRMS / model modes the single-site radar is hidden unless
  // this overlay toggle is switched on.
  radarOverlay: false,
  styleReady: false,
  geo: null,
  alerts: null,
  shownSweep: null,
  shownSite: null,
  inspect: false,
  // Last-loaded HRRR sounding profile (sounding.js), re-rendered on resize.
  soundingProfile: null,
  playback: null,
  // How many frames each playback loop preloads (user-adjustable).
  playbackFrames: 5,
  // Map-tool controllers (METAR station plots, draw/measure/storm, split view).
  metars: null,
  mapTools: null,
  splitView: null,
  exportTool: null,

  // Source mode: 'radar' | 'satellite' | 'mrms' | 'models'.
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
  // Weather-model state (HRRR for now). A run is a model cycle; each run has a
  // set of forecast hours that the forecast-hour picker and playback step through.
  models: {
    modelKey: 'hrrr',
    productId: 'REFC',
    runs: [],
    runKey: null,
    fhour: 0,
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
  el.smoothToggle = $('#smoothToggle');
  el.ringsToggle = $('#ringsToggle');
  el.persistToggle = $('#persistToggle');
  el.dealiasToggle = $('#dealiasToggle');
  el.dealiasField = $('#dealiasField');
  el.radarOverlayField = $('#radarOverlayField');
  el.radarOverlayToggle = $('#radarOverlayToggle');
  el.loopField = $('#loopField');
  el.loopBtn = $('#loopBtn');
  el.playFrames = $('#playFrames');
  el.playFramesVal = $('#playFramesVal');
  el.palInput = $('#palInput');
  el.palReset = $('#palReset');
  el.palName = $('#palName');
  el.alertList = $('#alertList');
  el.alertsToggle = $('#alertsToggle');
  el.alertDetail = $('#alertDetail');
  el.alertDetailPanel = $('#alertDetailPanel');
  el.alertClose = $('#alertClose');
  el.alertPreview = $('#alertPreview');
  el.alertPreviewCard = $('#alertPreviewCard');

  // Source modes (radar / satellite / MRMS).
  el.modeSwitch = $('#modeSwitch');
  el.siteField = $('#siteField');
  el.satFields = $('#satFields');
  el.satSelect = $('#satSelect');
  el.sectorSelect = $('#sectorSelect');
  el.conusViewField = $('#conusViewField');
  el.conusViewSelect = $('#conusViewSelect');
  el.mrmsFields = $('#mrmsFields');
  el.modelFields = $('#modelFields');
  el.modelSelect = $('#modelSelect');
  el.fhourPanel = $('#fhourPanel');
  el.fhourList = $('#fhourList');
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
  el.dockToolSlot = $('#dockToolSlot');
  el.dockToolMore = $('#dockToolMore');
  el.dockToolBtn = $('#dockToolBtn');
  el.dockToolMenu = $('#dockToolMenu');
  el.sheet = $('#mobileSheet');
  el.sheetBody = $('#sheetBody');
  el.sheetScrim = $('#sheetScrim');
  el.sheetGrip = $('#sheetGrip');
  el.sheetHeader = $('#sheetHeader');
  // Mobile swipe carousel (pages + tabs) and the panels relocated into them.
  el.sheetTabs = $('#sheetTabs');
  el.sheetPager = $('#sheetPager');
  el.pageControls = $('#pageControls');
  el.pageSettings = $('#pageSettings');
  el.pageMap = $('#pageMap');
  el.sourcePanel = $('#sourcePanel');
  el.volumePanel = $('#volumePanel');
  el.alertsPanel = $('#alertsPanel');
  el.productPanel = $('#productPanel');
  el.basemapPanel = $('#basemapPanel');
  el.metaPanel = $('#metaPanel');
  el.basemapSelect = $('#basemapSelect');
  el.sheetPlayback = $('#sheetPlayback');
  el.playSpeed = $('#playSpeed');
  el.playSpeedVal = $('#playSpeedVal');
  el.crosshair = $('#crosshair');
  el.crosshairRead = $('#crosshairRead');

  // Map tools toolbar.
  el.toolDraw = $('#toolDraw');
  el.toolMeasure = $('#toolMeasure');
  el.toolStorm = $('#toolStorm');
  el.toolMetars = $('#toolMetars');
  el.toolSplit = $('#toolSplit');
  // (toolSounding cached above with the sounding block)
  el.toolExport = $('#toolExport');
  el.toolClear = $('#toolClear');
  el.playbackBar = $('#playbackBar');
  el.playToggle = $('#playToggle');
  el.playScrub = $('#playScrub');
  el.playLabel = $('#playLabel');
  el.playClose = $('#playClose');

  // HRRR sounding (Skew-T / hodograph / severe parameters). The launcher now
  // lives in the map-tools toolbar / dock tool slot (models mode only).
  el.toolSounding = $('#toolSounding');
  el.sounding = $('#sounding');
  el.sndClose = $('#sndClose');
  el.sndTitle = $('#sndTitle');
  el.sndMeta = $('#sndMeta');
  el.sndStatus = $('#sndStatus');
  el.sndCharts = $('#sndCharts');
  el.sndSkewt = $('#sndSkewt');
  el.sndHodo = $('#sndHodo');
  el.sndParams = $('#sndParams');
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
    // Restore the last map position from a previous visit when we have one.
    center: state._restoreView
      ? [state._restoreView.lng, state._restoreView.lat]
      : [-97.27, 35.33], // Mapbox is [lng, lat]
    zoom: state._restoreView ? state._restoreView.zoom : 6,
    minZoom: 4,
    maxZoom: 14,
    attributionControl: true,
    // Flat Web Mercator (not the v3 default globe): the radar CanvasSource and
    // its corner math assume a flat mercator plane.
    projection: 'mercator',
    // The vector basemap renders on its own; our radar/alert layers slot into
    // its layer stack beneath the labels (set up in setupOverlays).
    renderWorldCopies: true,
    // Keep the WebGL backbuffer readable so the export tool can grab the canvas
    // (basemap + radar + drawings) with toDataURL at any time, not just inside a
    // render frame. The cost is a small amount of GPU memory bandwidth.
    preserveDrawingBuffer: true,
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
  map.on('mouseout', () => {
    // Cancel any queued readout update so it can't re-show the readout after the
    // cursor has already left the map (which caused a brief flicker-back).
    if (readoutRaf) { cancelAnimationFrame(readoutRaf); readoutRaf = null; }
    el.readout.classList.remove('show');
  });

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
  if (state.splitView) state.splitView.setBasemap(BASEMAPS[key].url);
  saveSettings();
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
  state._recenterRadar = true; // explicit pick → recenter/zoom on the next load
  state._forceLatest = true; // show the latest frame without needing LIVE
  // TDWR is Doppler-only: drop a dual-pol selection and rebuild the product row
  // so its dual-pol buttons disappear (and reappear when leaving a TDWR site).
  if (state.mode === 'radar') {
    if (isTDWR(icao) && DUAL_POL.has(state.productId)) {
      state.productId = 'REF';
      buildTiltList();
      buildLegend();
    }
    buildProductButtons();
  }
  refreshSiteDots();
  closeSheet();
  loadVolumeList();
  saveSettings();
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

// Sweeps at (effectively) the same tilt — a SAILS VCP scans the lowest
// elevation several times per volume, so its 0.5° cut shows up as multiple
// sweeps a few hundredths of a degree apart. Distinct cuts differ by ≥0.2°.
const TILT_EPS = 0.1;

// Pick the sweep from an arbitrary sweeps array that carries the given product's
// moment closest to the chosen tilt. Shared by the live view and playback. When
// a VCP revisits that tilt (SAILS), the most recently collected sweep wins, so
// the low-level products show the freshest scan rather than the volume's first.
function pickSweep(sweeps, productId = state.productId, elev = state.selectedElevation) {
  const moment = PRODUCTS[productId].moment;
  const list = sweeps.filter((sw) => sw.moments.includes(moment));
  if (!list.length) return null;
  let bestDiff = Infinity;
  for (const sw of list) bestDiff = Math.min(bestDiff, Math.abs(sw.elevation - elev));
  let best = null;
  for (const sw of list) {
    if (Math.abs(sw.elevation - elev) > bestDiff + TILT_EPS) continue;
    if (!best || (sw.time || 0) > (best.time || 0)) best = sw;
  }
  return best;
}

// Collapse repeated tilts (SAILS) to one entry each, keeping the freshest, for
// the elevation list. Input is assumed sorted by elevation ascending.
function dedupeTilts(list) {
  const out = [];
  for (const sw of list) {
    const last = out[out.length - 1];
    if (last && Math.abs(sw.elevation - last.elevation) <= TILT_EPS) {
      if ((sw.time || 0) > (last.time || 0)) out[out.length - 1] = sw;
    } else {
      out.push(sw);
    }
  }
  return out;
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

// In split view the product buttons drive whichever pane is selected. This
// returns the product id currently shown in that pane so the buttons highlight
// the right one.
function activeProductId() {
  const sv = state.splitView;
  if (sv && sv.active && sv.activePane === 2) return sv.productId;
  if (state.mode === 'satellite') return state.sat.productId;
  if (state.mode === 'mrms') return state.mrms.productId;
  if (state.mode === 'models') return state.models.productId;
  return state.productId;
}

// If the bottom UI is aimed at split pane 2, route a product change there and
// skip the main-map path. Returns true when it handled the click.
function routeProductToPane(id) {
  const sv = state.splitView;
  if (!(sv && sv.active && sv.activePane === 2)) return false;
  document.querySelectorAll('.product-btn').forEach((b) => b.classList.toggle('active', b.dataset.id === id));
  sv.setProduct(id);
  return true;
}

// The dual-polarization moments. TDWR terminal radars scan only to Doppler
// (REF/VEL/SW), so these products are hidden when a TDWR site is active.
const DUAL_POL = new Set(['RHO', 'ZDR', 'PHI']);

// Product ids offered for the current radar site — the full set, minus dual-pol
// for TDWR towers.
function availableProductOrder() {
  if (isTDWR(state.site)) return PRODUCT_ORDER.filter((id) => !DUAL_POL.has(id));
  return PRODUCT_ORDER;
}

function buildProductButtons() {
  if (state.mode === 'satellite') return buildSatProductButtons();
  if (state.mode === 'mrms') return buildMrmsProductButtons();
  if (state.mode === 'models') return buildModelProductButtons();
  el.productButtons.innerHTML = '';
  el.productButtons.className = 'product-grid';
  for (const id of availableProductOrder()) {
    const p = PRODUCTS[id];
    const btn = document.createElement('button');
    btn.className = 'product-btn';
    btn.dataset.id = id;
    btn.innerHTML = `<span class="pb-id">${id}</span><span class="pb-name">${p.name}</span>`;
    if (id === activeProductId()) btn.classList.add('active');
    btn.addEventListener('click', () => {
      if (routeProductToPane(id)) return;
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
      saveSettings();
    });
    el.productButtons.appendChild(btn);
  }
}

function buildTiltList() {
  el.tiltList.innerHTML = '';
  const list = dedupeTilts(sweepsForProduct());
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
  if (state.mode === 'models') return buildModelLegend();
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
  // A .pal lists its thresholds in its own `Units`, but the shader and point
  // sampler work in the product's NATIVE unit (e.g. m/s for velocity). When the
  // table is authored in an alternate unit we know how to convert (mph, kt, …),
  // rescale the thresholds back to native so the colors land on the right gates,
  // and keep the native->table factor so the legend/readout still read in the
  // table's unit. Otherwise (native unit, or an unknown one) show verbatim.
  const factor = displayFactorFor(p.defaultUnit, pal.units);
  if (factor && factor !== 1) {
    p.scale = makeScale(pal.segments.map((sg) => ({ ...sg, v: sg.v / factor })));
    p.dispUnit = pal.units;
    p.dispFactor = factor;
  } else {
    p.scale = makeScale(pal.segments);
    p.dispUnit = pal.units || p.unit;
    p.dispFactor = 1;
  }
  p.range = [p.scale.lo, p.scale.hi];
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

    el.palName.textContent = `${file.name} → ${targetId}`;
    // Update the radar product menu only while radar is the active source; in a
    // grid mode the product buttons belong to MRMS/models, not the radar set.
    if (state.mode === 'radar') {
      state.productId = targetId;
      document
        .querySelectorAll('.product-btn')
        .forEach((b) => b.classList.toggle('active', b.dataset.id === targetId));
      buildLegend();
      buildTiltList();
      renderRadar();
      updateMeta();
    } else {
      // A reflectivity .pal recolors MRMS/models too — repaint the live grid.
      refreshGridReflectivity();
    }
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
  if (state.mode === 'radar') renderRadar();
  else refreshGridReflectivity();
  setStatus('color tables reset to defaults');
}

// Repaint the live MRMS/model grid after the shared reflectivity table changes
// (a .pal load or reset), so grid reflectivity tracks the radar color table.
function refreshGridReflectivity() {
  if (state.mode === 'mrms' && state.mrms.grid) { buildMrmsLegend(); renderMrms(); }
  else if (state.mode === 'models' && state.models.grid) { buildModelLegend(); renderModels(); }
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------
async function loadVolumeList() {
  setStatus(`listing ${state.site}…`, true);
  buildVolumeList();
  try {
    let vols = await listVolumes(state.site, state.date);
    // If the selected UTC day has no scans (e.g. just after 00z when the current
    // day is still empty, or a quiet gap), fall back a day at a time until one
    // turns up, adopting that day. LIVE keeps resetting the date to "now", so the
    // view snaps forward to the current UTC day as soon as its first scan lands.
    if (!vols.length) {
      const probe = new Date(state.date);
      for (let i = 0; i < 7 && !vols.length; i++) {
        probe.setUTCDate(probe.getUTCDate() - 1);
        const back = await listVolumes(state.site, probe);
        if (back.length) {
          state.date = new Date(probe);
          el.dateInput.value = isoDate(state.date);
          vols = back;
          setStatus(`no scans for that day — showing ${isoDate(state.date)}`);
        }
      }
    }
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

let volumeLoadSeq = 0;
async function loadVolume(key) {
  state.volumeKey = key;
  buildVolumeList();
  const seq = ++volumeLoadSeq;
  setStatus('downloading volume…', true);
  el.progress.style.width = '0%';
  el.progress.classList.add('show');
  el.decoding.classList.remove('show');
  try {
    const bytes = await fetchVolume(key, (p) => {
      el.progress.style.width = Math.round(p * 100) + '%';
    });
    if (seq !== volumeLoadSeq) return; // a newer selection superseded this one
    setStatus('decoding…', true);
    el.decoding.classList.add('show');
    const volume = await decodeVolume(bytes);
    if (seq !== volumeLoadSeq) return;
    state.volume = volume;
    state.sweeps = volume.sweeps;

    // Default to the lowest available tilt of the current product.
    const list = sweepsForProduct();
    if (list.length) state.selectedElevation = list[0].elevation;

    // Only recenter/zoom when the user explicitly picked this radar (from the
    // site list, a dot, right-click or long-press). Plain frame loads and the
    // LIVE auto-refresh leave the user's current pan/zoom untouched.
    if (volume.site && state._recenterRadar) {
      state.map.jumpTo({ center: [volume.site.lon, volume.site.lat], zoom: 8 });
      state._recenterRadar = false;
    }

    refreshSiteDots();
    buildTiltList();
    updateMeta();
    renderRadar();
    setStatus(`loaded · ${volume.radialCount} radials`);
  } catch (e) {
    if (seq === volumeLoadSeq) setStatus(`decode error: ${e.message}`);
    console.error(e);
  } finally {
    if (seq === volumeLoadSeq) {
      el.progress.classList.remove('show');
      el.decoding.classList.remove('show');
    }
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

// Resolve the sweep for an arbitrary radar product at the current elevation,
// applying velocity dealiasing for VEL. Used by the split-screen pane to draw a
// different moment from the same loaded volume.
function radarSweepFor(productId) {
  let sweep = pickSweep(state.sweeps, productId);
  if (sweep && state.dealias && productId === 'VEL') sweep = dealiasSweep(sweep);
  return sweep;
}

// Mirror the current view into the second split-screen pane (no-op when off).
function syncSplit() {
  if (state.splitView && state.splitView.active) state.splitView.render();
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

  // In satellite / MRMS / model modes the single-site radar only draws when the
  // overlay toggle is on; otherwise keep it (and its range rings) hidden.
  if (state.mode !== 'radar' && !state.radarOverlay) {
    clearRadarSource(map);
    drawRings(null, 0);
    syncSplit();
    return;
  }

  if (!sweep || !site || !product) {
    clearRadarSource(map);
    drawRings(null, 0);
    updateInspect();
    syncSplit();
    return;
  }

  const maxR = sweepMaxRange(sweep, product.moment) || 300000;
  setRadarSource(map, sweep, product, site);
  drawRings(site, maxR);
  updateInspect();
  syncSplit();
}

// Show or hide the single-site radar overlay in a non-radar mode. Draws the
// radar volume that's already loaded (the app loads one on startup); the left
// "Volume scans" list stays owned by the active source, so we don't refetch it
// here. If no radar has ever been loaded, prompt the user to visit RADAR once.
function applyRadarOverlay() {
  if (state.mode === 'radar') return;
  if (state.radarOverlay && !state.volume) {
    setStatus('radar overlay: open RADAR once to load a site');
    return;
  }
  displaySweep(currentSweep(), state.volume && state.volume.site);
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
  if (el.modelFields) el.modelFields.hidden = state.mode !== 'models';
  el.tiltPanel.hidden = state.mode !== 'radar';
  if (el.fhourPanel) el.fhourPanel.hidden = state.mode !== 'models';
  el.satOptsPanel.hidden = state.mode !== 'satellite';
  // The sounding launcher (a map tool now) follows the selected model, so it's
  // only offered in models mode.
  if (el.toolSounding) el.toolSounding.hidden = state.mode !== 'models';
  // Keep the dock tool slot in sync — drop the sounding tool when leaving models.
  if (state._refreshDockTools) state._refreshDockTools();
  if (el.dealiasField) el.dealiasField.hidden = state.mode !== 'radar';
  // The single-site radar overlay control only makes sense outside radar mode.
  if (el.radarOverlayField) el.radarOverlayField.hidden = state.mode === 'radar';
  el.conusViewField.hidden = !(state.mode === 'satellite' && state.sat.sectorKey === 'conus');
  el.volumeTitle.textContent =
    state.mode === 'radar' ? 'Volume scans'
    : state.mode === 'satellite' ? 'Satellite scans'
    : state.mode === 'mrms' ? 'MRMS frames' : 'Model runs';
  document.querySelectorAll('.mode-btn')
    .forEach((b) => b.classList.toggle('active', b.dataset.mode === state.mode));
}

function setMode(mode) {
  if (state.mode === mode) return;
  if (state.playback && state.playback.active) state.playback.stop();
  state.mode = mode;
  if (mode !== 'satellite') clearSatellite();
  if (mode !== 'mrms') clearMrms();
  if (mode !== 'models') clearModels();
  if (mode !== 'radar') applyRadarOverlay(); // hide radar unless its overlay is on
  applyModePanels();
  refreshSiteDots(); // show the radar dots only in radar mode
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
  } else if (mode === 'models') {
    loadModelList();
  }
  if (state.splitView) state.splitView.onModeChange();
  updateMeta();
  saveSettings();
}

// Dispatch refresh / live / date changes to the active source.
function refreshActive() {
  if (state.mode === 'radar') return loadVolumeList();
  if (state.mode === 'satellite') return loadSatScenes();
  if (state.mode === 'mrms') return loadMrmsList();
  return loadModelList();
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
    saveSettings();
  });
  el.sectorSelect.addEventListener('change', () => {
    state.sat.sectorKey = el.sectorSelect.value;
    state.sat._centered = false;
    applyModePanels();
    loadSatScenes();
    saveSettings();
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
    saveSettings();
  });
}

function buildSatProductButtons() {
  el.productButtons.innerHTML = '';
  el.productButtons.className = 'product-grid';
  const add = (id, label, name) => {
    const btn = document.createElement('button');
    btn.className = 'product-btn';
    btn.dataset.id = id;
    btn.innerHTML = `<span class="pb-id">${label}</span><span class="pb-name">${name}</span>`;
    if (id === activeProductId()) btn.classList.add('active');
    btn.addEventListener('click', async () => {
      if (routeProductToPane(id)) return;
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
      saveSettings();
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

let satLoadSeq = 0;
async function loadSatScene(key) {
  state.sat.sceneKey = key;
  buildSatList();
  const seq = ++satLoadSeq;
  setStatus('downloading GOES…', true);
  el.progress.style.width = '0%';
  el.progress.classList.add('show');
  try {
    const scene = await loadGoesScene(state.sat.satKey, state.sat.sectorKey, key, bandsFor(state.sat.productId), (p) => {
      el.progress.style.width = Math.round(p * 100) + '%';
    });
    if (seq !== satLoadSeq) return; // a newer selection superseded this one
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
    if (seq === satLoadSeq) setStatus(`GOES error: ${e.message}`);
    console.error(e);
  } finally {
    if (seq === satLoadSeq) {
      el.progress.classList.remove('show');
      el.decoding.classList.remove('show');
    }
  }
}

function setSatelliteSource(map) {
  if (!state.sat.layer) state.sat.layer = createSatelliteLayer();
  if (!map.getLayer('satellite'))
    map.addLayer(state.sat.layer, dataLayerAnchor(map));
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
  drawSatScene(scene, rgba, bbox);
  syncSplit();
  updateDock();
}

// The projection metadata the satellite layer needs to draw a scene — small
// enough to cache per playback frame (unlike the scene's full channel arrays).
function satSceneMeta(scene) {
  return {
    width: scene.width, height: scene.height,
    xScale: scene.xScale, xOffset: scene.xOffset,
    yScale: scene.yScale, yOffset: scene.yOffset,
    proj: scene.proj,
  };
}

// Draw a satellite frame from its prebuilt RGBA + projection meta. `meta` may be
// the full scene (live view) or a stripped satSceneMeta (playback).
function drawSatScene(meta, rgba, bbox) {
  const map = state.map;
  if (!map || !state.styleReady) return;
  setSatelliteSource(map);
  state.sat.layer.setScene(meta, rgba, bbox);
  state.sat.layer.setOpacity(state.opacity);
  state.sat.layer.setSmooth(state.smooth);
}

function buildSatLegend() {
  const id = state.sat.productId;
  if (id.startsWith('C')) {
    const band = parseInt(id.slice(1), 10);
    const meta = SAT_CHANNELS[band - 1];
    if (!meta) { el.legend.innerHTML = ''; return; }
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
  el.productButtons.className = 'product-grid';
  for (const id of MRMS_ORDER) {
    const p = MRMS_PRODUCTS[id];
    const btn = document.createElement('button');
    btn.className = 'product-btn';
    btn.dataset.id = id;
    btn.innerHTML = `<span class="pb-id">${id}</span><span class="pb-name">${p.name}</span>`;
    if (id === activeProductId()) btn.classList.add('active');
    btn.addEventListener('click', () => {
      if (routeProductToPane(id)) return;
      state.mrms.productId = id;
      document.querySelectorAll('.product-btn').forEach((b) => b.classList.toggle('active', b.dataset.id === id));
      buildMrmsLegend();
      loadMrmsList(); // each product is a different S3 folder
      saveSettings();
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

let mrmsLoadSeq = 0;
async function loadMrmsFrame(key) {
  state.mrms.frameKey = key;
  buildMrmsList();
  const seq = ++mrmsLoadSeq;
  setStatus('downloading MRMS…', true);
  el.progress.style.width = '0%';
  el.progress.classList.add('show');
  try {
    const grid = await loadMrms(state.mrms.productId, key, (p) => {
      el.progress.style.width = Math.round(p * 100) + '%';
    });
    if (seq !== mrmsLoadSeq) return; // a newer selection superseded this one
    setStatus('decoding MRMS…', true);
    el.decoding.classList.add('show');
    state.mrms.grid = grid;
    renderMrms();
    setStatus(`MRMS ${grid.product.name} loaded`);
  } catch (e) {
    if (seq === mrmsLoadSeq) setStatus(`MRMS error: ${e.message}`);
    console.error(e);
  } finally {
    if (seq === mrmsLoadSeq) {
      el.progress.classList.remove('show');
      el.decoding.classList.remove('show');
    }
  }
}

function setMrmsSource(map) {
  if (!state.mrms.layer) state.mrms.layer = createGridLayer();
  if (!map.getLayer('mrms'))
    map.addLayer(state.mrms.layer, dataLayerAnchor(map));
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
  state.mrms.layer.setGrid(grid, resolveGridProduct(grid.product));
  state.mrms.layer.setOpacity(state.opacity);
  state.mrms.layer.setSmooth(state.smooth);
  syncSplit();
  updateDock();
}

// Display a pre-prepared MRMS grid payload (see prepareGridTexture) — used by
// playback to swap cached frames cheaply.
function drawMrmsPayload(payload) {
  const map = state.map;
  if (!map || !state.styleReady) return;
  setMrmsSource(map);
  state.mrms.layer.showPrepared(payload);
  state.mrms.layer.setOpacity(state.opacity);
  state.mrms.layer.setSmooth(state.smooth);
}

function buildMrmsLegend() {
  const p = resolveGridProduct(MRMS_PRODUCTS[state.mrms.productId]);
  el.legend.innerHTML = legendHTML(p, p.scale);
}

// ---------------------------------------------------------------------------
// Weather models (HRRR, NAM, NAM Nest, RAP, GFS)
//
// Models reuse the lat/lon grid layer and the time-list / opacity / playback
// chrome. A model field is decoded straight from a Range request against the
// model's GRIB2 on S3 (see models.js), resampled from its native grid to
// lat/lon, then drawn through the same GPU path as MRMS. Each model advertises
// which products it can supply, so the picker only shows supported fields.
// ---------------------------------------------------------------------------
function initModelSelects() {
  if (!el.modelSelect) return;
  // A saved product may not exist on the (saved) model — fall back if so.
  if (!modelSupports(state.models.modelKey, state.models.productId))
    state.models.productId = defaultProductFor(state.models.modelKey);
  el.modelSelect.innerHTML = '';
  for (const [key, m] of Object.entries(MODELS)) {
    const o = document.createElement('option');
    o.value = key; o.textContent = m.label;
    if (key === state.models.modelKey) o.selected = true;
    el.modelSelect.appendChild(o);
  }
  el.modelSelect.addEventListener('change', () => {
    state.models.modelKey = el.modelSelect.value;
    // Switch to a supported product if this model can't supply the current one.
    if (!modelSupports(state.models.modelKey, state.models.productId))
      state.models.productId = defaultProductFor(state.models.modelKey);
    // Keep split pane 2 valid too (it shares the model).
    if (state.splitView && state.splitView.active &&
        !modelSupports(state.models.modelKey, state.splitView.productId))
      state.splitView.onModeChange();
    state._forceLatest = true;
    buildModelProductButtons();
    buildModelLegend();
    saveSettings();
    loadModelList();
  });
}

// Short model name for status lines (HRRR, NAM, RAP, …).
function modelName() {
  return (state.models.modelKey || '').toUpperCase() || 'model';
}

// Remember which model product categories the user has expanded, so a rebuild
// (mode switch, product pick) doesn't snap them all shut again. Everything starts
// collapsed by default to keep the long model product list compact.
const modelCatOpen = {};

function buildModelProductButtons() {
  el.productButtons.innerHTML = '';
  el.productButtons.className = 'product-stack';
  const modelKey = state.models.modelKey;
  for (const cat of MODEL_CATEGORIES) {
    // Only the products this model actually supplies; skip a category that ends
    // up empty for the current model.
    const ids = cat.products.filter((id) => MODEL_PRODUCTS[id] && modelSupports(modelKey, id));
    if (!ids.length) continue;

    // Every category starts collapsed to keep the long model list compact; the
    // user's manual expand/collapse choices are remembered across rebuilds.
    const open = !!modelCatOpen[cat.name];

    const section = document.createElement('div');
    section.className = 'product-cat-section' + (open ? '' : ' collapsed');

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'product-cat';
    head.innerHTML = `<span class="cat-caret">▾</span><span>${cat.name}</span>`;
    head.addEventListener('click', () => {
      const nowOpen = section.classList.toggle('collapsed') === false;
      modelCatOpen[cat.name] = nowOpen;
    });
    section.appendChild(head);

    const grid = document.createElement('div');
    grid.className = 'product-grid';
    for (const id of ids) {
      const p = MODEL_PRODUCTS[id];
      const btn = document.createElement('button');
      btn.className = 'product-btn';
      btn.dataset.id = id;
      btn.innerHTML = `<span class="pb-id">${id}</span><span class="pb-name">${p.name}</span>`;
      if (id === activeProductId()) btn.classList.add('active');
      btn.addEventListener('click', () => {
        if (routeProductToPane(id)) return;
        state.models.productId = id;
        document.querySelectorAll('.product-btn').forEach((b) => b.classList.toggle('active', b.dataset.id === id));
        buildModelLegend();
        loadModelFrame(); // same run/forecast hour, different field
        saveSettings();
      });
      grid.appendChild(btn);
    }
    section.appendChild(grid);
    el.productButtons.appendChild(section);
  }
}

function currentModelRun() {
  return state.models.runs.find((r) => r.key === state.models.runKey) || null;
}

// The left "Model runs" list — each entry is a model cycle.
function buildModelList() {
  el.volumeList.innerHTML = '';
  if (!state.models.runs.length) {
    el.volumeList.innerHTML = '<div class="empty">No model runs found for this day.</div>';
    return;
  }
  [...state.models.runs].reverse().forEach((r) => {
    const btn = document.createElement('button');
    btn.className = 'vol-btn';
    if (r.key === state.models.runKey) btn.classList.add('active');
    btn.innerHTML = `<span class="dot"></span>${r.label} run`;
    btn.addEventListener('click', () => selectModelRun(r.key));
    el.volumeList.appendChild(btn);
  });
}

// Forecast-hour picker (right rail), mirroring the radar elevation-tilt list.
function buildFhourList() {
  if (!el.fhourList) return;
  el.fhourList.innerHTML = '';
  const run = currentModelRun();
  if (!run) { el.fhourList.innerHTML = '<div class="empty">No run selected.</div>'; return; }
  for (const f of forecastHours(run)) {
    const btn = document.createElement('button');
    btn.className = 'tilt-btn';
    if (f === state.models.fhour) btn.classList.add('active');
    btn.textContent = 'F' + p2(f);
    btn.addEventListener('click', () => selectFhour(f));
    el.fhourList.appendChild(btn);
  }
}

function selectFhour(f) {
  state.models.fhour = f;
  buildFhourList();
  loadModelFrame();
}

async function loadModelList() {
  if (state.mode !== 'models') return;
  setStatus(`listing ${modelName()}…`, true);
  buildModelList();
  try {
    const when = state.live ? new Date() : state.date;
    const runs = await listModels(state.models.modelKey, state.models.productId, when);
    state.models.runs = runs;
    buildModelList();
    setStatus(`${runs.length} model runs`);
    if (!runs.length) return;
    const latest = runs[runs.length - 1].key;
    if (state._forceLatest || !state.models.grid || state.live || !currentModelRun()) {
      state._forceLatest = false;
      selectModelRun(latest);
    } else {
      buildModelList();
      buildFhourList();
    }
  } catch (e) {
    setStatus(`${modelName()} list error: ${e.message}`);
    console.error(e);
  }
}

function selectModelRun(key) {
  state.models.runKey = key;
  const run = currentModelRun();
  // Keep the chosen forecast hour if the new run offers it; otherwise snap down
  // to the nearest available hour (runs may step non-hourly, e.g. NAM/GFS).
  if (run) {
    const fhrs = forecastHours(run);
    if (!fhrs.includes(state.models.fhour)) {
      const below = fhrs.filter((f) => f <= state.models.fhour);
      state.models.fhour = below.length ? below[below.length - 1] : fhrs[0];
    }
  }
  buildModelList();
  buildFhourList();
  loadModelFrame();
}

// Load the currently-selected run + forecast hour.
let modelLoadSeq = 0;
async function loadModelFrame() {
  const run = currentModelRun();
  if (!run) return;
  const fhour = state.models.fhour;
  const seq = ++modelLoadSeq;
  setStatus(`downloading ${modelName()}…`, true);
  el.progress.style.width = '0%';
  el.progress.classList.add('show');
  try {
    const grid = await loadModel(state.models.modelKey, state.models.productId, run, fhour, (p) => {
      el.progress.style.width = Math.round(p * 100) + '%';
    });
    if (seq !== modelLoadSeq) return; // a newer selection superseded this one
    setStatus(`decoding ${modelName()}…`, true);
    el.decoding.classList.add('show');
    state.models.grid = grid;
    renderModels();
    setStatus(`${modelName()} ${run.label} F${p2(fhour)} · ${grid.product.name}`);
  } catch (e) {
    if (seq === modelLoadSeq) setStatus(`${modelName()} error: ${e.message}`);
    console.error(e);
  } finally {
    if (seq === modelLoadSeq) {
      el.progress.classList.remove('show');
      el.decoding.classList.remove('show');
    }
  }
}

function setModelSource(map) {
  if (!state.models.layer) state.models.layer = createGridLayer('models');
  if (!map.getLayer('models'))
    map.addLayer(state.models.layer, dataLayerAnchor(map));
}

function clearModels() {
  if (state.models.layer) state.models.layer.clear();
  if (state.map && state.styleReady) clearModelOverlays(state.map);
}

function renderModels() {
  const map = state.map;
  if (!map || !state.styleReady) return;
  const grid = state.models.grid;
  if (!grid) { clearModels(); return; }
  setModelSource(map);
  state.models.layer.setGrid(grid, resolveGridProduct(grid.product));
  state.models.layer.setOpacity(state.opacity);
  state.models.layer.setSmooth(state.smooth);
  // Upper-air products carry wind + height overlays; others clear them.
  renderModelOverlays(map, grid);
  syncSplit();
  updateDock();
}

// Display a pre-prepared model grid payload — used by forecast-hour playback.
// Playback shows the colored fill only; barb/contour overlays are hidden.
function drawModelPayload(payload) {
  const map = state.map;
  if (!map || !state.styleReady) return;
  setModelSource(map);
  clearModelOverlays(map);
  state.models.layer.showPrepared(payload);
  state.models.layer.setOpacity(state.opacity);
  state.models.layer.setSmooth(state.smooth);
}

function buildModelLegend() {
  const p = resolveGridProduct(MODEL_PRODUCTS[state.models.productId]);
  el.legend.innerHTML = legendHTML(p, p.scale);
}

function sampleModelAt(lat, lon) {
  const grid = state.models.grid;
  if (!grid) return null;
  const p = resolveGridProduct(grid.product);
  const i = Math.floor((lon - grid.lon1) / grid.di);
  const j = Math.floor((grid.lat1 - lat) / grid.dj);
  if (i < 0 || i >= grid.ni || j < 0 || j >= grid.nj) return { out: true };
  const v = grid.values[j * grid.ni + i];
  if (Number.isNaN(v) || !(v >= p.floor)) return { main: 'no echo', sub: p.id };
  return { main: fmtValue(p, v), sub: p.id };
}

// ---------------------------------------------------------------------------
// HRRR sounding — a Skew-T, a storm-relative hodograph and the severe params,
// for the column under the map center. Opens as a full-screen, mobile-first
// sheet. The profile comes from the CORS-enabled HRRR point endpoint (see
// sounding.js); we pin it to the displayed run's valid time.
// ---------------------------------------------------------------------------
let soundingSeq = 0;

function modelValidTime() {
  if (state.models.grid && state.models.grid.time) return state.models.grid.time;
  const run = currentModelRun();
  if (!run) return new Date();
  return new Date(run.time.getTime() + state.models.fhour * 3600 * 1000);
}

async function openSounding() {
  const c = state.map.getCenter();
  const validTime = modelValidTime();
  const seq = ++soundingSeq;

  // Follow the model selected for the active forecast hour. The sounding tool is
  // only offered in models mode, so state.models.modelKey is the live selection.
  const modelKey = state.models.modelKey;
  const label = soundingModel(modelKey).label;

  el.sounding.hidden = false;
  document.body.classList.add('snd-open');
  if (el.sndTitle) el.sndTitle.textContent = `${label} Sounding`;
  el.sndCharts.hidden = true;
  el.sndParams.hidden = true;
  el.sndStatus.hidden = false;
  el.sndStatus.textContent = `Loading ${label} sounding…`;
  const utc = `${p2(validTime.getUTCHours())}:00Z ${validTime.getUTCFullYear()}-${p2(validTime.getUTCMonth() + 1)}-${p2(validTime.getUTCDate())}`;
  el.sndMeta.textContent = `${c.lat.toFixed(2)}°, ${c.lng.toFixed(2)}° · valid ${utc}`;

  try {
    const profile = await fetchSounding(c.lat, c.lng, validTime, modelKey);
    if (seq !== soundingSeq) return; // a newer request superseded this one
    state.soundingProfile = profile;
    el.sndStatus.hidden = true;
    el.sndCharts.hidden = false;
    el.sndParams.hidden = false;
    renderSoundingParams(profile);
    // One frame later, so the now-visible charts have their final layout size
    // before the canvases size themselves to it.
    requestAnimationFrame(drawSoundingCharts);
  } catch (e) {
    if (seq !== soundingSeq) return;
    el.sndStatus.hidden = false;
    el.sndStatus.textContent = e.message || 'Could not load sounding.';
    console.error(e);
  }
}

function renderSoundingParams(profile) {
  const groups = paramRows(profile);
  el.sndParams.innerHTML = groups.map((g) => `
    <div class="snd-pgroup">
      <h3>${g.title}</h3>
      <div class="snd-pgrid">
        ${g.rows.map((r) => `
          <div class="snd-prow">
            <span class="snd-plabel">${r.label}</span>
            <span class="snd-pval" style="color:${r.color}">${r.value}</span>
          </div>`).join('')}
      </div>
    </div>`).join('');
}

// (Re)draw both canvases at their current on-screen size — called on open and
// whenever the window/orientation changes while the sheet is up.
function drawSoundingCharts() {
  const profile = state.soundingProfile;
  if (!profile || el.sounding.hidden) return;
  drawSkewT(el.sndSkewt, profile);
  drawHodograph(el.sndHodo, profile);
}

function closeSounding() {
  el.sounding.hidden = true;
  document.body.classList.remove('snd-open');
  soundingSeq++; // cancel any in-flight render
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
  // The all-radar dots only belong to radar mode — in satellite / MRMS / model
  // modes there's no site to pick, so hide them rather than littering the map.
  if (map.getLayer('sites'))
    map.setLayoutProperty('sites', 'visibility', state.mode === 'radar' ? 'visible' : 'none');
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
  if (state.mode === 'models') return sampleModelAt(lat, lon);
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
  const p = resolveGridProduct(grid.product);
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
// Describe what the dock chip should show for the active source: a short product
// code, the source it comes from (radar site / satellite / MRMS / model), the
// human product name (reflectivity, infrared…) and the frame time. This is what
// lets the dock follow the user off radar onto another product entirely.
function dockInfo() {
  if (state.mode === 'satellite') {
    const id = state.sat.productId;
    let prod, name;
    if (id.startsWith('C')) {
      const band = parseInt(id.slice(1), 10);
      const ch = SAT_CHANNELS[band - 1];
      prod = id;
      name = ch ? ch.name : id;
    } else {
      const rgb = SAT_RGB[id.replace(/^RGB_/, '')];
      prod = rgb ? rgb.short : id;
      name = rgb ? rgb.name : id;
    }
    const sat = SATELLITES[state.sat.satKey];
    const t = state.sat.scenes.find((x) => x.key === state.sat.sceneKey);
    return {
      prod,
      name,
      source: sat ? sat.label.replace(/\s*\(.*\)$/, '') : 'GOES',
      time: t ? t.label : '—',
    };
  }
  if (state.mode === 'mrms') {
    const p = MRMS_PRODUCTS[state.mrms.productId];
    const t = state.mrms.frames.find((x) => x.key === state.mrms.frameKey);
    return {
      prod: state.mrms.productId,
      name: p ? p.name : state.mrms.productId,
      source: 'MRMS',
      time: t ? t.label : '—',
    };
  }
  if (state.mode === 'models') {
    const p = MODEL_PRODUCTS[state.models.productId];
    const m = MODELS[state.models.modelKey];
    return {
      prod: state.models.productId,
      name: p ? p.name : state.models.productId,
      source: m ? m.label.split(' ')[0] : 'MODEL',
      time: `F${String(state.models.fhour).padStart(2, '0')}`,
    };
  }
  // Radar (default).
  const p = PRODUCTS[state.productId];
  const t = state.volumes.find((x) => x.key === state.volumeKey);
  return {
    prod: state.productId,
    name: p ? p.name : state.productId,
    source: (state.volume && state.volume.icao) || state.site,
    time: t ? t.label : '—',
  };
}

function updateDock() {
  if (!el.dockProd) return;
  const info = dockInfo();
  el.dockProd.textContent = info.prod;
  el.dockSite.textContent = info.source;
  if (state.playback && state.playback.active) return; // dock time owned by playback
  el.dockTime.textContent = info.name ? `${info.name} · ${info.time}` : info.time;
}

const SHEET_EASE = 'cubic-bezier(.22,1,.36,1)';
let sheetCloseTimer = null;

function openSheet() {
  if (sheetCloseTimer) { clearTimeout(sheetCloseTimer); sheetCloseTimer = null; }
  el.sheet.hidden = false;
  el.sheetScrim.hidden = false;
  document.querySelector('.app').classList.add('sheet-open');
  // The current product's controls always lead — open on page 0 every time.
  requestAnimationFrame(() => setSheetPage(0, false));
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

// Distribute the control panels into the mobile swipe carousel pages. Page 0 is
// the controls for the current product; page 1 the source settings (its mode
// switch acts as the single-site / SAT / MRMS / models selection bar); page 2 the
// map settings + metadata. The same DOM nodes are moved, so all wiring is intact.
function layoutMobilePages() {
  el.pageControls.append(el.productPanel, el.tiltPanel, el.fhourPanel, el.satOptsPanel);
  el.pageSettings.append(el.sourcePanel, el.volumePanel, el.alertsPanel);
  el.pageMap.append(el.basemapPanel, el.metaPanel);
}

// Put every panel back in its rail (desktop), in the original order.
function layoutDesktopRails() {
  el.railLeft.append(el.sourcePanel, el.volumePanel, el.alertsPanel);
  el.railRight.append(
    el.productPanel, el.basemapPanel, el.tiltPanel, el.fhourPanel, el.satOptsPanel, el.metaPanel
  );
}

const SHEET_PAGES = 3;
// Scroll the carousel to a page index and reflect it on the tabs.
function setSheetPage(i, smooth = true) {
  i = Math.max(0, Math.min(SHEET_PAGES - 1, i | 0));
  state._sheetPage = i;
  if (el.sheetPager) {
    el.sheetPager.scrollTo({ left: el.sheetPager.clientWidth * i, behavior: smooth ? 'smooth' : 'auto' });
  }
  if (el.sheetTabs) {
    el.sheetTabs.querySelectorAll('.sheet-tab')
      .forEach((t) => t.classList.toggle('active', Number(t.dataset.page) === i));
  }
}

// Tabs + native horizontal swipe both drive the carousel; keep them in sync.
function setupSheetPager() {
  if (!el.sheetPager) return;
  el.sheetTabs.addEventListener('click', (e) => {
    const tab = e.target.closest('.sheet-tab');
    if (tab) setSheetPage(Number(tab.dataset.page));
  });
  let scrollRaf = null;
  el.sheetPager.addEventListener('scroll', () => {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = null;
      const w = el.sheetPager.clientWidth || 1;
      const i = Math.round(el.sheetPager.scrollLeft / w);
      if (i !== state._sheetPage) {
        state._sheetPage = i;
        el.sheetTabs.querySelectorAll('.sheet-tab')
          .forEach((t) => t.classList.toggle('active', Number(t.dataset.page) === i));
      }
    });
  }, { passive: true });
}

// The touch-first "dock + settings sheet" layout is now the universal layout on
// every screen — phones, iPads and desktops alike. The desktop multi-rail layout
// was retired in favour of the same simple experience everywhere (the CSS scales
// the dock/sheet up for tablet and desktop widths). This query therefore always
// matches; it's kept as a matchMedia so the rest of the code can keep asking
// "are we in the dock layout?" unchanged.
const mqMobile = window.matchMedia('(min-width: 0px)');
function applyResponsiveLayout() {
  const mobile = mqMobile.matches;
  document.querySelector('.app').classList.toggle('mobile', mobile);
  // While a loop is running its UI owns the dock's space, so keep the dock
  // hidden until playback stops.
  const playing = state.playback && state.playback.active;
  el.mobileDock.hidden = !mobile || playing;
  if ((!mobile || playing) && state._closeDockMenu) state._closeDockMenu();
  refreshSiteDots(); // dot sizes differ between desktop and touch layouts
  if (mobile) {
    if (el.productPanel.parentElement !== el.pageControls) {
      layoutMobilePages();
      // Re-anchor the carousel to whatever page was last shown (default: controls).
      requestAnimationFrame(() => setSheetPage(state._sheetPage || 0, false));
    }
  } else {
    closeSheet();
    if (state.inspect) toggleInspect(false);
    if (el.sourcePanel.parentElement !== el.railLeft) {
      layoutDesktopRails();
    }
  }
  setTimeout(() => state.map && state.map.resize(), 60);
}

// ---------------------------------------------------------------------------
// Playback — scrub/animate a loop of recent frames. Works for every source:
// radar volumes, MRMS frames, satellite scenes, and HRRR forecast hours. Each
// mode supplies a "provider" describing its frames, how to load one, how to draw
// a loaded one, and how to restore the live view when playback stops.
//
// Raw decoded data is far too big to cache many of (an MRMS grid alone is
// ~100 MB), so grid/satellite providers load each frame straight into a compact
// GPU-ready payload (a max-pooled texture or a prebuilt RGBA) and cache that.
// ---------------------------------------------------------------------------

// How many playback frames to fetch/decode at once. Higher overlaps more of the
// per-frame network latency; the decode worker pool caps how much actually runs
// in parallel for radar, while grid/satellite frames are network-bound so a few
// extra lanes mostly hide round-trip time.
const PLAYBACK_CONCURRENCY = 6;

// A short key identifying the current playback context; when it changes (site,
// product, run, sector…) the cached frames are no longer valid and are dropped.
function playbackContextKey() {
  const m = state.mode;
  if (m === 'radar') return `radar:${state.site}`;
  if (m === 'mrms') return `mrms:${state.mrms.productId}`;
  if (m === 'satellite')
    return `sat:${state.sat.satKey}:${state.sat.sectorKey}:${state.sat.productId}:${state.sat.enhanceIR}`;
  if (m === 'models')
    return `models:${state.models.modelKey}:${state.models.productId}:${state.models.runKey}`;
  return m;
}

// Build the per-mode playback provider against the current state. `frames` are
// ordered oldest→newest; `ck` is a globally-unique cache key per frame. Every
// source loops the same user-chosen number of frames (state.playbackFrames).
function buildPlaybackProvider() {
  const n = state.playbackFrames;
  if (state.mode === 'radar') {
    return {
      frames: state.volumes.slice(-n).map((v) => ({ label: v.label, ck: v.key, key: v.key })),
      async load(f) { return await decodeVolume(await fetchVolume(f.key)); },
      render(vol) { displaySweep(pickSweep(vol.sweeps), vol.site); },
      idle() { displaySweep(currentSweep(), state.volume && state.volume.site); },
    };
  }
  if (state.mode === 'mrms') {
    return {
      frames: state.mrms.frames.slice(-n).map((v) => ({ label: v.label, ck: v.key, key: v.key })),
      async load(f) {
        const grid = await loadMrms(state.mrms.productId, f.key);
        return prepareGridTexture(grid, resolveGridProduct(grid.product));
      },
      render(payload) { drawMrmsPayload(payload); },
      idle() { renderMrms(); },
    };
  }
  if (state.mode === 'satellite') {
    return {
      frames: state.sat.scenes.slice(-n).map((v) => ({ label: v.label, ck: v.key, key: v.key })),
      async load(f) {
        const scene = await loadGoesScene(state.sat.satKey, state.sat.sectorKey, f.key, bandsFor(state.sat.productId));
        const rgba = buildRGBA(scene, state.sat.productId, { enhanceIR: state.sat.enhanceIR });
        return { meta: satSceneMeta(scene), rgba, bbox: sceneBBox(scene) };
      },
      render(payload) { drawSatScene(payload.meta, payload.rgba, payload.bbox); },
      idle() { renderSatellite(); },
    };
  }
  if (state.mode === 'models') {
    const run = currentModelRun();
    if (!run) return { frames: [] };
    // Loop the first N forecast hours of the selected run; the picker still
    // reaches every hour out to F48.
    const hours = forecastHours(run).slice(0, n);
    return {
      frames: hours.map((fh) => ({ label: 'F' + p2(fh), ck: `${run.key}#${fh}`, fhour: fh, run })),
      async load(f) {
        const grid = await loadModel(state.models.modelKey, state.models.productId, f.run, f.fhour);
        return prepareGridTexture(grid, resolveGridProduct(grid.product));
      },
      render(payload) { drawModelPayload(payload); },
      idle() { renderModels(); },
    };
  }
  return { frames: [] };
}

function createPlayback() {
  return {
    active: false,
    playing: false,
    frames: [],
    idx: 0,
    fps: 3,
    timer: null,
    cache: new Map(),
    cacheCtx: null,
    provider: null,

    async start() {
      if (this.active) return;
      const provider = buildPlaybackProvider();
      if (!provider.frames || !provider.frames.length) {
        setStatus('no frames to play back');
        return;
      }
      this.provider = provider;
      this.active = true;
      el.playBtn.classList.add('active');
      if (el.loopBtn) el.loopBtn.classList.add('active');
      // The loop UI takes over the dock's space: hide the dock while playing
      // and reveal it again on stop (the ✕ on the bar).
      if (state._closeDockMenu) state._closeDockMenu();
      el.mobileDock.hidden = true;
      el.playbackBar.hidden = false;
      el.sheetPlayback.hidden = false;
      document.querySelector('.app').classList.add('playing');
      el.playLabel.textContent = 'loading…';
      if (state.live) toggleLive(); // freeze auto-refresh during playback

      // Drop any cache held for a different context (mode/product/run/…).
      const ctx = playbackContextKey();
      if (ctx !== this.cacheCtx) { this.cache.clear(); this.cacheCtx = ctx; }

      setStatus('loading playback…', true);
      // Load frames with bounded concurrency instead of one-at-a-time. The old
      // sequential await chained every frame's fetch+decode end to end; building
      // a loop now overlaps the network round-trips (and, via the worker pool,
      // the decodes), which is the bulk of the wait. Results are stitched back
      // into frame order afterwards so playback stays oldest→newest.
      const total = provider.frames.length;
      const results = new Array(total);
      let done = 0;
      let next = 0;
      const runWorker = async () => {
        while (this.active) {
          const idx = next++;
          if (idx >= total) return;
          const fr = provider.frames[idx];
          let payload = this.cache.get(fr.ck);
          if (!payload) {
            try {
              payload = await provider.load(fr);
              this.cache.set(fr.ck, payload);
            } catch (e) {
              console.error(e);
              done++;
              continue;
            }
          }
          if (!this.active) return; // user bailed mid-load
          results[idx] = { label: fr.label, ck: fr.ck, payload };
          el.playLabel.textContent = `loading ${++done}/${total}…`;
        }
      };
      const lanes = Math.min(PLAYBACK_CONCURRENCY, total);
      await Promise.all(Array.from({ length: lanes }, runWorker));
      if (!this.active) return; // user bailed mid-load
      const frames = results.filter(Boolean);
      if (!frames.length) {
        setStatus('playback unavailable');
        this.stop();
        return;
      }
      // Bound the cache to this loop so it can't grow without limit.
      const keep = new Set(frames.map((f) => f.ck));
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
      if (!f || !this.provider) return;
      this.provider.render(f.payload);
      el.playLabel.textContent = `${this.idx + 1}/${this.frames.length} · ${f.label}`;
      el.dockTime.textContent = f.label;
    },

    stop() {
      this.pause();
      this.active = false;
      const provider = this.provider;
      this.frames = [];
      el.playBtn.classList.remove('active');
      if (el.loopBtn) el.loopBtn.classList.remove('active');
      el.playbackBar.hidden = true;
      el.sheetPlayback.hidden = true;
      document.querySelector('.app').classList.remove('playing');
      // Restore the normal bottom dock that the loop UI replaced.
      if (mqMobile.matches) el.mobileDock.hidden = false;
      // Release the frame cache on phones so playback memory is freed at once.
      if (mqMobile.matches) { this.cache.clear(); this.cacheCtx = null; }
      // Restore the live view for the active source.
      if (provider && provider.idle) provider.idle();
      else displaySweep(currentSweep(), state.volume && state.volume.site);
      this.provider = null;
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
  if (state.live) stopLive();
  else startLive();
}

// Turn LIVE on: snap to "now", load the latest frame and auto-refresh every 60s.
// Idempotent, so it's safe to call on startup (the app boots into LIVE).
function startLive() {
  state.live = true;
  el.liveBtn.classList.add('active');
  el.liveBtn.textContent = '● LIVE';
  state.date = new Date();
  el.dateInput.value = isoDate(state.date);
  refreshActive();
  if (state.liveTimer) clearInterval(state.liveTimer);
  state.liveTimer = setInterval(() => refreshActive(), 60000);
}

function stopLive() {
  state.live = false;
  el.liveBtn.classList.remove('active');
  el.liveBtn.textContent = '○ LIVE';
  if (state.liveTimer) {
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
// Map tools — METAR station plots, draw / measure / storm-track, split screen
// ---------------------------------------------------------------------------
function setupMapTools() {
  // Surface observations (METAR station plots).
  state.metars = new MetarController(state.map);
  state.metars.onStatus = (msg) => setStatus(msg);
  el.toolMetars.addEventListener('click', () => {
    const on = state.metars.setEnabled(!state.metars.enabled);
    el.toolMetars.classList.toggle('active', on);
    if (!on) setStatus('METARs off');
  });

  // Draw / measure / storm-track annotations.
  state.mapTools = new MapTools(state.map);
  // Mirror committed drawings into the split pane.
  state.mapTools.onChange = (fc) => {
    if (state.splitView) state.splitView.setDrawings(fc);
  };
  // When a tool finishes (or is cancelled), drop the pressed state on its button.
  state.mapTools.onToolEnd = () => syncToolButtons();

  const toolButtons = [
    [el.toolDraw, 'draw'],
    [el.toolMeasure, 'measure'],
    [el.toolStorm, 'storm'],
  ];
  function syncToolButtons() {
    for (const [btn, name] of toolButtons)
      btn.classList.toggle('active', state.mapTools.tool === name);
  }
  for (const [btn, name] of toolButtons) {
    btn.addEventListener('click', () => {
      state.mapTools.setTool(name);
      syncToolButtons();
    });
  }
  el.toolClear.addEventListener('click', () => {
    state.mapTools.clearAll();
    syncToolButtons();
  });

  // Split screen — a second synced pane showing a different product.
  state.splitView = new SplitView({
    state,
    MAPBOX_TOKEN,
    BASEMAPS,
    radarSweepFor,
    // When the user clicks a pane to select it, repaint the product buttons so
    // they highlight — and drive — the newly active pane.
    onActivePaneChange: () => buildProductButtons(),
  });
  el.toolSplit.addEventListener('click', () => {
    const on = state.splitView.toggle();
    el.toolSplit.classList.toggle('active', on);
    if (on) state.splitView.setDrawings(state.mapTools.getFeatureCollection());
  });

  // Export / share — snapshot the live map(s) to a PNG with a caption banner.
  state.exportTool = new ExportTool({ getScene: buildExportScene });
  el.toolExport.addEventListener('click', () => {
    try {
      state.exportTool.run();
    } catch (e) {
      console.error('export failed:', e);
      setStatus('Export failed');
    }
  });
}

// ---------------------------------------------------------------------------
// Mobile dock tool slot — a single dock button that can be any of the map tools.
// Tapping ▴ opens a menu to choose which tool occupies the slot; tapping the
// slot itself runs that tool. The tools themselves live on the (now mobile-
// hidden) toolbar buttons, so the slot just delegates clicks to them and mirrors
// their pressed state — no tool logic is duplicated here.
// ---------------------------------------------------------------------------
const DOCK_TOOLS = [
  { id: 'storm', icon: '➤', label: 'Storm track', btn: () => el.toolStorm },
  { id: 'measure', icon: '📏', label: 'Measure', btn: () => el.toolMeasure },
  { id: 'draw', icon: '✎', label: 'Draw', btn: () => el.toolDraw },
  { id: 'metars', icon: '⛅', label: 'Surface obs (METARs)', btn: () => el.toolMetars },
  // The sounding follows the selected model, so it only appears when models is active.
  { id: 'sounding', icon: '⊙', label: 'Model sounding', btn: () => el.toolSounding, modelsOnly: true },
  { id: 'split', icon: '⊟', label: 'Split screen', btn: () => el.toolSplit },
  { id: 'export', icon: '⤓', label: 'Export image', btn: () => el.toolExport },
  { id: 'clear', icon: '✕', label: 'Clear drawings', btn: () => el.toolClear },
];

// The tools offered in the dock slot depend on the active source: the sounding
// tool is only meaningful in HRRR/models mode.
function dockToolsForMode() {
  return DOCK_TOOLS.filter((t) => !t.modelsOnly || state.mode === 'models');
}

function setupDockTools() {
  if (!el.dockToolBtn) return;
  state.dockTool = state.dockTool || 'storm';

  const current = () => dockToolsForMode().find((t) => t.id === state.dockTool) || dockToolsForMode()[0];

  // Reflect the underlying tool button's pressed state on the slot.
  function syncActive() {
    const t = current();
    const btn = t.btn();
    el.dockToolBtn.classList.toggle('active', !!(btn && btn.classList.contains('active')));
  }

  function buildMenu() {
    el.dockToolMenu.innerHTML = '';
    for (const t of dockToolsForMode()) {
      const item = document.createElement('button');
      item.className = 'dock-tool-item';
      if (t.id === state.dockTool) item.classList.add('active');
      item.innerHTML = `<span class="ti-icon">${t.icon}</span><span>${t.label}</span>`;
      item.addEventListener('click', () => {
        setDockTool(t.id);
        closeDockMenu();
      });
      el.dockToolMenu.appendChild(item);
    }
  }

  function setDockTool(id) {
    state.dockTool = id;
    const t = current();
    el.dockToolBtn.textContent = t.icon;
    el.dockToolBtn.title = t.label;
    syncActive();
    saveSettings();
  }

  function openDockMenu() {
    buildMenu();
    el.dockToolMenu.hidden = false;
    el.dockToolSlot.classList.add('open');
  }
  function closeDockMenu() {
    el.dockToolMenu.hidden = true;
    el.dockToolSlot.classList.remove('open');
  }
  state._closeDockMenu = closeDockMenu;

  el.dockToolMore.addEventListener('click', (e) => {
    e.stopPropagation();
    if (el.dockToolMenu.hidden) openDockMenu();
    else closeDockMenu();
  });

  // Tapping the slot delegates to the chosen tool's toolbar button, then mirrors
  // its new pressed state (after the tool controllers settle on the next tick).
  el.dockToolBtn.addEventListener('click', () => {
    closeDockMenu();
    const btn = current().btn();
    if (btn) btn.click();
    setTimeout(syncActive, 0);
  });

  // The map-tool controllers flip button state when a tool ends; keep in sync.
  if (state.mapTools) {
    const prevEnd = state.mapTools.onToolEnd;
    state.mapTools.onToolEnd = () => { if (prevEnd) prevEnd(); syncActive(); };
  }

  // Dismiss the menu on any outside tap.
  document.addEventListener('click', (e) => {
    if (el.dockToolMenu.hidden) return;
    if (el.dockToolSlot.contains(e.target) || el.dockToolMenu.contains(e.target)) return;
    closeDockMenu();
  });

  // When the source mode changes, the available tools change (sounding appears
  // only in models mode). Drop a now-unavailable selection back to the default
  // and rebuild any open menu.
  state._refreshDockTools = () => {
    if (!dockToolsForMode().some((t) => t.id === state.dockTool)) {
      setDockTool(dockToolsForMode()[0].id);
    }
    if (!el.dockToolMenu.hidden) buildMenu();
  };

  setDockTool(state.dockTool);
  state._refreshDockTools(); // drop a restored tool that isn't valid for this mode
}

// Gather the canvases, caption and legend for the export tool. In split view
// both panes are included, left → right.
function buildExportScene() {
  // Force a fresh GL frame so the captured backbuffer is current (the map is
  // created with preserveDrawingBuffer, so the read itself is then safe).
  if (state.map && state.map.redraw) state.map.redraw();
  const canvases = [state.map.getCanvas()];
  if (state.splitView && state.splitView.active && state.splitView.map) {
    if (state.splitView.map.redraw) state.splitView.map.redraw();
    canvases.push(state.splitView.map.getCanvas());
  }
  // Alert overlays: if the full briefing is open, capture the whole detail view
  // as it appears on screen (a side panel over the scope). Otherwise, if the
  // compact preview card is open, stamp that instead (minus its "View full
  // briefing" footer). The full briefing takes precedence over the card.
  const briefing = state.alerts ? state.alerts.exportDetail() : null;
  const alert = briefing ? null : (state.alerts ? state.alerts.exportPreview() : null);
  return { canvases, caption: buildExportCaption(), legendEl: el.legend, alert, briefing };
}

// Describe what's on screen for the export banner: a title, a product/source
// sub-line, the scan/frame time and a UTC stamp. Adapts to the active mode.
function buildExportCaption() {
  const cap = {
    brand: 'AETHER',
    title: '',
    sub: '',
    time: '',
    stamp: utcStamp(new Date()),
  };

  if (state.mode === 'satellite') {
    const sat = SATELLITES[state.sat.satKey];
    const sec = SECTORS[state.sat.sectorKey];
    cap.title = sat ? sat.label : 'GOES';
    cap.sub = `${state.sat.productId} · ${sec ? sec.label : ''} · GOES ABI`;
    const t = state.sat.scenes.find((x) => x.key === state.sat.sceneKey);
    cap.time = t ? t.label : '';
  } else if (state.mode === 'mrms') {
    const p = MRMS_PRODUCTS[state.mrms.productId];
    cap.title = 'MRMS CONUS';
    cap.sub = `${p ? p.name : state.mrms.productId} · MRMS`;
    const t = state.mrms.frames.find((x) => x.key === state.mrms.frameKey);
    cap.time = t ? t.label : '';
  } else if (state.mode === 'models') {
    const m = MODELS[state.models.modelKey];
    const p = MODEL_PRODUCTS[state.models.productId];
    cap.title = m ? m.label : 'Model';
    cap.sub = `${p ? p.name : state.models.productId} · F${String(state.models.fhour).padStart(2, '0')}`;
    const run = state.models.runs.find((x) => x.key === state.models.runKey);
    cap.time = run ? `${run.label} run` : '';
  } else {
    // Radar.
    const site = (state.volume && state.volume.icao) || state.site;
    const meta = RADARS.find((r) => r[0] === site);
    const p = PRODUCTS[state.productId];
    cap.title = meta ? `${site} · ${meta[1]}` : site;
    cap.sub = `${p.name} (${dispUnitOf(p)}) · NEXRAD Level II`;
    const t = state.volumes.find((x) => x.key === state.volumeKey);
    cap.time = t ? t.label : '';
  }
  return cap;
}

// "2026-06-22 18:42:07 UTC" for the export footer.
function utcStamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC`;
}

// ---------------------------------------------------------------------------
// Persisted settings — remember the user's last source/product, the map view
// (center + zoom) and every map/display toggle across visits, so a reload drops
// you right back where you left off. Storage may be blocked (private mode), so
// every access is guarded. Kept separate from the .pal store above.
// ---------------------------------------------------------------------------
const SETTINGS_KEY = 'aether.settings';

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {};
  } catch (_) {
    return {};
  }
}

let _settingsTimer = null;
function saveSettings() {
  if (!state.persist) return; // user opted out of remembering anything
  // Debounce: map moves and slider drags fire rapidly, and we only need the
  // resting value.
  if (_settingsTimer) return;
  _settingsTimer = setTimeout(() => {
    _settingsTimer = null;
    try {
      const m = state.map;
      const c = m && m.getCenter ? m.getCenter() : null;
      const s = {
        mode: state.mode,
        site: state.site,
        productId: state.productId,
        opacity: state.opacity,
        smooth: state.smooth,
        basemap: state.basemap,
        showRings: state.showRings,
        dealias: state.dealias,
        radarOverlay: state.radarOverlay,
        alertsOn: state.alerts ? state.alerts.enabled : true,
        playbackFrames: state.playbackFrames,
        dockTool: state.dockTool,
        sat: {
          satKey: state.sat.satKey,
          sectorKey: state.sat.sectorKey,
          productId: state.sat.productId,
          enhanceIR: state.sat.enhanceIR,
        },
        mrms: { productId: state.mrms.productId },
        models: { modelKey: state.models.modelKey, productId: state.models.productId },
        map: c && isFinite(c.lng) ? { lng: c.lng, lat: c.lat, zoom: m.getZoom() } : null,
      };
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
    } catch (_) {
      /* storage full or blocked — settings still apply for this session */
    }
  }, 400);
}

// Fold stored settings into `state` defaults before the map and UI are built, so
// the first render already reflects them (basemap, last view, last product…).
function applyStoredSettings(s) {
  if (!s || typeof s !== 'object') return;
  if (['radar', 'satellite', 'mrms', 'models'].includes(s.mode)) state.mode = s.mode;
  if (typeof s.site === 'string') state.site = s.site;
  if (typeof s.productId === 'string') state.productId = s.productId;
  if (typeof s.opacity === 'number') state.opacity = s.opacity;
  if (typeof s.smooth === 'boolean') state.smooth = s.smooth;
  if (typeof s.basemap === 'string' && BASEMAPS[s.basemap]) state.basemap = s.basemap;
  if (typeof s.showRings === 'boolean') state.showRings = s.showRings;
  if (typeof s.dealias === 'boolean') state.dealias = s.dealias;
  if (typeof s.radarOverlay === 'boolean') state.radarOverlay = s.radarOverlay;
  if (typeof s.playbackFrames === 'number') state.playbackFrames = s.playbackFrames;
  if (typeof s.dockTool === 'string') state.dockTool = s.dockTool;
  if (typeof s.alertsOn === 'boolean') state._alertsOn = s.alertsOn;
  if (s.sat && typeof s.sat === 'object') {
    if (typeof s.sat.satKey === 'string') state.sat.satKey = s.sat.satKey;
    if (typeof s.sat.sectorKey === 'string') state.sat.sectorKey = s.sat.sectorKey;
    if (typeof s.sat.productId === 'string') state.sat.productId = s.sat.productId;
    if (typeof s.sat.enhanceIR === 'boolean') state.sat.enhanceIR = s.sat.enhanceIR;
  }
  if (s.mrms && typeof s.mrms.productId === 'string') state.mrms.productId = s.mrms.productId;
  if (s.models && typeof s.models === 'object') {
    if (typeof s.models.modelKey === 'string' && MODELS[s.models.modelKey]) state.models.modelKey = s.models.modelKey;
    if (typeof s.models.productId === 'string') state.models.productId = s.models.productId;
    // A restored product might not exist on the restored model.
    if (!modelSupports(state.models.modelKey, state.models.productId))
      state.models.productId = defaultProductFor(state.models.modelKey);
  }
  if (s.map && isFinite(s.map.lng) && isFinite(s.map.lat)) state._restoreView = s.map;
}

// Flip an ON/OFF toggle button to a given state (class + label together).
function setToggleBtn(btn, on) {
  if (!btn) return;
  btn.classList.toggle('active', !!on);
  btn.textContent = on ? 'ON' : 'OFF';
}

// Push restored settings onto their UI controls (run once, after the controls
// exist but before the first data load). state already holds the restored values.
function reflectStoredControls() {
  if (el.opacity) {
    el.opacity.value = String(Math.round(state.opacity * 100));
    el.opacityVal.textContent = el.opacity.value + '%';
  }
  setToggleBtn(el.ringsToggle, state.showRings);
  setToggleBtn(el.dealiasToggle, state.dealias);
  setToggleBtn(el.smoothToggle, state.smooth);
  setToggleBtn(el.radarOverlayToggle, state.radarOverlay);
  if (typeof state._alertsOn === 'boolean') setToggleBtn(el.alertsToggle, state._alertsOn);
  if (el.basemapSelect) el.basemapSelect.value = state.basemap;
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
function init() {
  cacheEls();
  applyStoredSettings(loadSettings()); // restore last session before building UI
  initMap();
  enableLongPress();
  buildSiteSelect();
  restoreStoredPals(); // re-apply any saved .pal color tables before first paint
  buildProductButtons();
  buildLegend();
  buildTiltList();

  state.playback = createPlayback();
  state.map.on('move', updateInspect);
  // Remember the last map position (debounced) so a reload reopens the same view.
  state.map.on('moveend', saveSettings);

  // Reflect any restored toggle/slider settings onto their controls.
  reflectStoredControls();

  // Source-mode switch + satellite controls.
  initSatSelects();
  initModelSelects();
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
    if (state.models.layer) state.models.layer.setOpacity(state.opacity);
    if (state.splitView) state.splitView.setOpacity(state.opacity);
    saveSettings();
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
    saveSettings();
  });

  // Remember-view-&-settings toggle. Turning it off forgets everything stored.
  if (el.persistToggle) {
    el.persistToggle.addEventListener('click', () => {
      const on = !el.persistToggle.classList.contains('active');
      setToggleBtn(el.persistToggle, on);
      state.persist = on;
      if (on) {
        saveSettings();
      } else {
        try { localStorage.removeItem(SETTINGS_KEY); } catch (_) {}
      }
      setStatus(on ? 'remembering view & settings' : 'no longer remembering settings');
    });
  }

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
    saveSettings();
  });

  // Data smoothing — bilinear-interpolate the plotted radar / satellite / model /
  // MRMS field instead of the crisp native default. It only flips a shader
  // uniform on the live layers, so there's nothing to recompute or reload.
  if (el.smoothToggle) {
    el.smoothToggle.addEventListener('click', () => {
      const on = !el.smoothToggle.classList.contains('active');
      setToggleBtn(el.smoothToggle, on);
      state.smooth = on;
      if (state.radarLayer) state.radarLayer.setSmooth(on);
      if (state.sat.layer) state.sat.layer.setSmooth(on);
      if (state.mrms.layer) state.mrms.layer.setSmooth(on);
      if (state.models.layer) state.models.layer.setSmooth(on);
      if (state.splitView) state.splitView.setSmooth(on);
      setStatus(on ? 'data smoothing on' : 'data smoothing off');
      saveSettings();
    });
  }

  // Single-site radar overlay for the satellite / MRMS / model modes.
  if (el.radarOverlayToggle) {
    el.radarOverlayToggle.addEventListener('click', () => {
      const on = !el.radarOverlayToggle.classList.contains('active');
      el.radarOverlayToggle.classList.toggle('active', on);
      el.radarOverlayToggle.textContent = on ? 'ON' : 'OFF';
      state.radarOverlay = on;
      applyRadarOverlay();
      setStatus(on ? `radar overlay on (${state.site})` : 'radar overlay off');
      saveSettings();
    });
  }

  // Desktop playback trigger (mobile uses the dock's ▶ button).
  if (el.loopBtn) {
    el.loopBtn.addEventListener('click', () => {
      if (state.playback.active) state.playback.stop();
      else state.playback.start();
    });
  }

  // How many frames a playback loop preloads. Applied the next time playback
  // starts (the count determines how much is fetched up front).
  if (el.playFrames) {
    el.playFrames.value = String(state.playbackFrames);
    el.playFramesVal.textContent = state.playbackFrames;
    el.playFrames.addEventListener('input', () => {
      state.playbackFrames = Number(el.playFrames.value);
      el.playFramesVal.textContent = state.playbackFrames;
      saveSettings();
    });
  }

  // Live NWS watches/warnings overlay.
  state.alerts = new AlertsController(state.map, {
    listPanel: el.alertList,
    list: el.alertList,
    detail: el.alertDetail,
    detailPanel: el.alertDetailPanel,
    close: el.alertClose,
    preview: el.alertPreview,
    previewCard: el.alertPreviewCard,
  });
  state.alerts.start();
  // Apply the restored alerts on/off preference (default on).
  if (state._alertsOn === false) state.alerts.setEnabled(false);
  el.alertsToggle.addEventListener('click', () => {
    const on = !el.alertsToggle.classList.contains('active');
    el.alertsToggle.classList.toggle('active', on);
    el.alertsToggle.textContent = on ? 'ON' : 'OFF';
    state.alerts.setEnabled(on);
    saveSettings();
  });

  // ---- Map tools: METARs, draw / measure / storm track, split view ----
  setupMapTools();
  // ---- Mobile dock swappable tool slot (delegates to the map tools above) ----
  setupDockTools();

  // ---- Mobile dock + sheet + playback + inspect wiring ----
  el.dockStatus.addEventListener('click', () =>
    el.sheet.hidden ? openSheet() : closeSheet()
  );
  el.sheetScrim.addEventListener('click', closeSheet);
  el.sheetGrip.addEventListener('click', closeSheet);
  enableSheetSwipe();
  setupSheetPager();

  el.basemapSelect.value = state.basemap;
  el.basemapSelect.addEventListener('change', () =>
    setBasemap(el.basemapSelect.value)
  );
  el.inspectBtn.addEventListener('click', () => toggleInspect());

  // ---- HRRR sounding launcher (map tool, models mode only) + sheet ----
  el.toolSounding.addEventListener('click', openSounding);
  el.sndClose.addEventListener('click', closeSounding);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el.sounding.hidden) closeSounding();
  });

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

  window.addEventListener('resize', () => {
    if (state.map) state.map.resize();
    drawSoundingCharts();
  });
  setTimeout(() => state.map.resize(), 100);

  tickClock();
  setInterval(tickClock, 1000);

  // Start in LIVE mode so the newest data streams in automatically — the user
  // shouldn't have to flip the LIVE switch to get a self-updating view. This
  // also kicks off the first load (refreshActive) and the 60s auto-refresh.
  startLive();
}

document.addEventListener('DOMContentLoaded', init);
