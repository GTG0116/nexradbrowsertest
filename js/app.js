// app.js — application controller: ties the data, decode, and render layers to
// the UI. Everything runs in the browser; the only network calls are the public
// S3 list/download requests in s3.js and the Mapbox GL basemap tiles.

import { listVolumes, fetchVolume, RADARS, nearestSite, isTDWR, latestScanTime } from './s3.js';
import { L3_PRODUCTS, L3_ORDER, isL3Product, listLevel3, loadLevel3 } from './level3.js';
import { PRODUCTS, PRODUCT_ORDER, makeScale, parsePal, palTargetProduct, dispValue, dispUnitOf, unitDecimals, reflectivityProduct, displayFactorFor } from './products.js';
import { sampleAt, sweepMaxRange } from './renderer.js';
import { createRadarLayer } from './radarLayer.js';
import { dealiasSweep, stormRelativeSweep } from './dealias.js';
import { describeSweepResolution, legacyResolutionSweep } from './radarResolution.js';
import { AlertsController, setAlertStyle, styleableAlertKinds, DEFAULT_ALERT_FILL_OPACITY, DEFAULT_ALERT_OUTLINE_WIDTH } from './alerts.js';
import { CyclonesController } from './cyclones.js';
import { LsrController, LSR_HOURS_CHOICES, LSR_DEFAULT_HOURS, defaultLsrCats } from './lsr.js';
import { applyMapStyle, liftBoundaryLayers, normalizeMapStyle, DEFAULT_MAP_STYLE, TOWN_FONTS } from './mapStyle.js';
import { OutlookController, OUTLOOKS, OUTLOOK_ORDER, loadOutlookData } from './outlooks.js';
import { SATELLITES, SECTORS, CONUS_VIEWS, sectorsForSatellite, listScenes, sceneBBox, lonLatToColRow } from './goes.js';
import { loadSceneAsync, ensureBandsAsync, evictScene, clearSceneCache } from './satClient.js';
import { SAT_CHANNELS, SAT_RGB, SAT_RGB_ORDER, bandsFor, buildRGBA, WV_BANDS, enhancementGradientCSS } from './satProducts.js';
import { createSatelliteLayer, SATELLITE_LAYER_ID } from './satelliteLayer.js';
import { MIRS_PRODUCTS, MIRS_ORDER, isMirsSat, listMirsScenes, loadMirsGrid, mirsGridBBox } from './mirs.js';
import { MRMS_PRODUCTS, MRMS_ORDER, MRMS_CATEGORIES, listMrms, loadMrms } from './mrms.js';
import { MODELS, MODEL_PRODUCTS, MODEL_CATEGORIES, MODEL_ORDER, listModels, loadModel, forecastHours,
  modelSupports, defaultProductFor, setModelProxy } from './models.js';
import { OBS_PRODUCTS, OBS_CATEGORIES, listObservations, loadObservation } from './observations.js';
import {
  MESO_SECTORS, MESO_CATEGORIES, MESO_PRODUCTS,
  MESO_DEFAULT_SECTOR, MESO_DEFAULT_CODE,
  MESO_FRAME_COUNTS, MESO_DEFAULT_FRAMES,
  mesoImageUrl, mesoProductName, mesoSectorName,
  mesoFrames, mesoFrameUrl,
} from './mesoanalysis.js';
import { createGridLayer, prepareGridTexture } from './gridLayer.js';
import { setupModelOverlayLayers, renderModelOverlays, clearModelOverlays,
  prepareModelOverlayData, prepareModelPlaybackContours, showPreparedModelOverlays, contourGeoJSON } from './modelOverlays.js';
import { fetchSoundingNative, drawSkewT, drawHodograph, paramRows, soundingModel } from './sounding.js';
import { MetarController } from './metars.js';
import { MapTools } from './maptools.js';
import { CrossSectionTool } from './xsect.js';
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
const SMALL_SCREEN_QUERY = '(max-width: 759.98px)';
function isSmallScreenNow() {
  return typeof window !== 'undefined' && window.matchMedia(SMALL_SCREEN_QUERY).matches;
}

// Large decoded weather grids can overlap GPU uploads and cached radar volumes
// on phones. Keep desktop resolution intact while using a smaller working set
// on phones and devices that report limited memory.
function isConstrainedDevice() {
  if (isSmallScreenNow()) return true;
  if (typeof navigator === 'undefined') return false;
  // Safari does not expose deviceMemory. Its touch tablets still need the
  // compact path, including in landscape where they use the desktop layout.
  if (navigator.maxTouchPoints > 0 && typeof window !== 'undefined' &&
      Math.min(window.innerWidth, window.innerHeight) <= 1024) return true;
  const memory = Number(navigator.deviceMemory);
  if (Number.isFinite(memory) && memory > 0 && memory <= 4) return true;
  return false;
}
const CONSTRAINED_DEVICE = isConstrainedDevice();
const CONSTRAINED_GRID_DIM = 1400;

const MODEL_CITY_VALUE_SOURCE = 'model-city-values';
const MODEL_CITY_VALUE_LAYER = 'model-city-value-labels';
const GRID_CITY_VALUE_MODES = new Set(['radar', 'mrms', 'models', 'observations']);
const LAYER_STACK_SOURCES = ['radar', 'satellite', 'mrms', 'models', 'observations', 'outlooks'];
const LAYER_STACK_SOURCE_LABELS = {
  radar: 'Radar',
  satellite: 'Satellite',
  mrms: 'MRMS',
  models: 'Models',
  observations: 'Observations',
  outlooks: 'Outlooks',
};
const OUTLOOK_LAYER_SEP = '|';

// ---------------------------------------------------------------------------
// Basemap — Mapbox GL JS vector styles. Rendering with GL (rather than raster
// tiles) is what lets us slot the radar and alert layers *into* the basemap's
// own layer stack, beneath its town-name and boundary layers, so place names
// and borders always draw on top of the radar — natively, no second label set.
// ---------------------------------------------------------------------------
// The Mapbox public token is supplied by the end user (not baked into the build),
// so a public deployment carries no shared/billable key. It is stored per-browser
// in localStorage and prompted for on first run by the setup gate (see init()).
// NB: the localStorage keys keep their original `aether.*` namespace across the
// RadarNexus rebrand on purpose — renaming them would silently drop every existing
// user's saved token, palettes and settings on their next visit.
const MAPBOX_TOKEN_KEY = 'aether.mapboxToken';
const MAPTILER_TOKEN_KEY = 'aether.maptilerToken';
const MAP_PROVIDER_KEY = 'aether.mapProvider';
let MAPBOX_TOKEN = '';
function getStoredMapProvider() {
  try {
    const provider = (localStorage.getItem(MAP_PROVIDER_KEY) || '').trim();
    if (provider === 'maptiler' || provider === 'mapbox') return provider;
    // No explicit choice yet. Honor a legacy Mapbox token from before the
    // provider key existed; otherwise default new users to MapTiler, whose
    // free keys are the easier of the two to obtain.
    if ((localStorage.getItem(MAPBOX_TOKEN_KEY) || '').trim()) return 'mapbox';
    return 'maptiler';
  } catch {
    return 'maptiler';
  }
}
function getStoredMapToken(provider = getStoredMapProvider()) {
  try {
    const key = provider === 'maptiler' ? MAPTILER_TOKEN_KEY : MAPBOX_TOKEN_KEY;
    return (localStorage.getItem(key) || '').trim();
  } catch {
    return '';
  }
}
function clearStoredMapToken(provider = getStoredMapProvider()) {
  try {
    localStorage.removeItem(provider === 'maptiler' ? MAPTILER_TOKEN_KEY : MAPBOX_TOKEN_KEY);
  } catch {}
}

// key → { url: mapbox style url, label }. "Dark" keeps the original console look.
const BASEMAPS = {
  dark: { mapbox: 'mapbox://styles/mapbox/dark-v11', maptiler: 'darkmatter', label: 'Dark' },
  satellite: { mapbox: 'mapbox://styles/mapbox/satellite-streets-v12', maptiler: 'hybrid', label: 'Satellite' },
  streets: { mapbox: 'mapbox://styles/mapbox/streets-v12', maptiler: 'streets-v2', label: 'Streets' },
  light: { mapbox: 'mapbox://styles/mapbox/light-v11', maptiler: 'basic-v2', label: 'Light' },
  outdoors: { mapbox: 'mapbox://styles/mapbox/outdoors-v12', maptiler: 'outdoor-v2', label: 'Outdoors' },
};

function basemapStyleUrl(key = state.basemap) {
  const bm = BASEMAPS[key] || BASEMAPS.dark;
  if (state.mapProvider === 'maptiler')
    return `https://api.maptiler.com/maps/${bm.maptiler}/style.json?key=${encodeURIComponent(MAPBOX_TOKEN)}`;
  return bm.mapbox;
}

function mapProviderLabel(provider = state.mapProvider) {
  return provider === 'maptiler' ? 'MapTiler' : 'Mapbox';
}

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
    if ((ly.type === 'line' || ly.type === 'symbol') &&
        (ly['source-layer'] === 'road' || ly['source-layer'] === 'transportation'))
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

// The basemap's own town labels, roads, rivers and admin borders are
// restyled in place by applyMapStyle() (js/mapStyle.js) using the user's
// `state.mapStyle` options. setStyle() (a basemap switch) resets every layer to
// its stock paint, so setupOverlays re-applies the customisation on every load.
// Counties (admin_level 2) aren't drawn by the stock styles, so applyMapStyle
// adds those itself. See mapStyle.js for the full rationale.

function sitesGeoJSON() {
  return {
    type: 'FeatureCollection',
    features: RADARS.map(([icao, name, lat, lon]) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties: {
        icao, name,
        pillIcon: sitePillImageId(icao, sitePillKind(icao)),
        current: icao === state.site ? 1 : 0,
        tdwr: isTDWR(icao) ? 1 : 0,
        down: state.downSites && state.downSites.has(icao) ? 1 : 0,
      },
    })),
  };
}

function sitePillKind(icao) {
  if (icao === state.site) return 'current';
  if (state.downSites && state.downSites.has(icao)) return 'down';
  if (isTDWR(icao)) return 'tdwr';
  return 'base';
}

function sitePillImageId(icao, kind) {
  return `site-pill-${icao}-${kind}-${state.uiTheme || 'dark'}`;
}

function selectedRadarColor() {
  return state.uiTheme === 'dark' ? '#22d3ee' : '#0b93b8';
}

function selectedRadarInk() {
  return state.uiTheme === 'dark' ? '#04121a' : '#ffffff';
}

function sitePillImage(icao, kind, ratio = 2) {
  const w = 58 * ratio, h = 24 * ratio, r = 12 * ratio;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const palette = {
    current: {
      fill: state.uiTheme === 'dark' ? 'rgba(34,211,238,0.96)' : 'rgba(11,147,184,0.96)',
      stroke: selectedRadarColor(),
      text: selectedRadarInk(),
    },
    down: { fill: 'rgba(81,26,31,0.96)', stroke: '#f0663f', text: '#fff0ec' },
    tdwr: { fill: 'rgba(77,57,16,0.96)', stroke: '#f5a623', text: '#fff2c9' },
    base: {
      fill: state.uiTheme === 'dark' ? 'rgba(17,24,32,0.96)' : 'rgba(255,255,255,0.96)',
      stroke: state.uiTheme === 'dark' ? '#2b5364' : '#9cc9d5',
      text: state.uiTheme === 'dark' ? '#c7eaf0' : '#145f73',
    },
  }[kind] || {};
  ctx.beginPath();
  ctx.moveTo(r, 1);
  ctx.lineTo(w - r, 1);
  ctx.quadraticCurveTo(w - 1, 1, w - 1, r);
  ctx.lineTo(w - 1, h - r);
  ctx.quadraticCurveTo(w - 1, h - 1, w - r, h - 1);
  ctx.lineTo(r, h - 1);
  ctx.quadraticCurveTo(1, h - 1, 1, h - r);
  ctx.lineTo(1, r);
  ctx.quadraticCurveTo(1, 1, r, 1);
  ctx.closePath();
  ctx.fillStyle = palette.fill;
  ctx.strokeStyle = palette.stroke;
  ctx.lineWidth = 1.5 * ratio;
  ctx.fill();
  ctx.stroke();
  ctx.font = `${11 * ratio}px "IBM Plex Mono", monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = palette.text;
  ctx.fillText(icao, w / 2, h / 2 + 0.5 * ratio);
  return { data: ctx.getImageData(0, 0, w, h), pixelRatio: ratio };
}

function ensureSitePillImages(map) {
  for (const [icao] of RADARS) {
    for (const kind of ['base', 'tdwr', 'down', 'current']) {
      const id = sitePillImageId(icao, kind);
      if (!map.hasImage(id)) {
        const img = sitePillImage(icao, kind);
        map.addImage(id, img.data, { pixelRatio: img.pixelRatio });
      }
    }
  }
}

// Diagonal-hatch tile for an SPC Conditional Intensity Group (CIG) level, drawn
// black on transparent so it reads over the radar like the official "significant"
// hatching. Density rises with the level to match the intensity legend: a sparse
// forward "/" (1), a tighter "/" (2), and a full crosshatch "XX" (3).
function cigHatchImage(level, ratio = 2) {
  const tile = (level === 1 ? 13 : 8) * ratio; // CSS px → device px
  const c = document.createElement('canvas');
  c.width = c.height = tile;
  const ctx = c.getContext('2d');
  ctx.strokeStyle = 'rgba(0,0,0,0.7)';
  ctx.lineWidth = ratio;
  // Corner-to-corner lines so the tile repeats seamlessly when wrapped.
  ctx.beginPath(); ctx.moveTo(0, tile); ctx.lineTo(tile, 0); ctx.stroke();
  if (level >= 3) { ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(tile, tile); ctx.stroke(); }
  return { data: ctx.getImageData(0, 0, tile, tile), pixelRatio: ratio };
}

// (Re)create all overlay sources and layers in the correct order. Called on
// every style load — including after a basemap switch, which wipes custom
// layers — and then repopulated with whatever data we currently hold.
// Alert paint values, shared by the initial addLayer in setupOverlays and the
// live "Alert opacity" slider. Per-kind fill opacity rides on the feature (and
// an isolated alert selected in the open briefing is brightened on top of it);
// the user's global alert-opacity multiplier scales the whole expression.
function alertFillOpacityExpr(mult = state.alertOpacity) {
  return ['*', mult, [
    'case',
    ['boolean', ['get', 'selected'], false], 0.34,
    ['coalesce', ['get', 'fillOpacity'], 0.18],
  ]];
}
function alertLineOpacity(mult = state.alertOpacity) {
  return 0.95 * mult;
}

// Push the current global alert opacity to every live map (main + split panes).
function applyAlertOpacity() {
  const maps = [state.map, ...(state.splitView ? state.splitView.paneMaps() : [])];
  for (const m of maps) {
    if (!m || !m.getLayer) continue;
    try {
      if (m.getLayer('alerts-fill')) m.setPaintProperty('alerts-fill', 'fill-opacity', alertFillOpacityExpr());
      if (m.getLayer('alerts-line')) m.setPaintProperty('alerts-line', 'line-opacity', alertLineOpacity());
    } catch (_) { /* pane mid style-reload */ }
  }
}

function setupOverlays(map) {
  // Normalise the style first: some providers draw admin boundaries beneath the
  // roads, where the data layers would cover them — lift them above the data
  // before the anchors below are computed from the layer order.
  liftBoundaryLayers(map);
  // Label anchor → annotations + our borders (above roads, below town labels).
  // Data anchor → radar/alert-fill (below the basemap roads, over the terrain).
  const anchor = firstLabelLayerId(map);
  const dataAnchor = dataLayerAnchor(map);

  if (!map.getSource('alerts'))
    map.addSource('alerts', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  if (!map.getSource('spc-outlook'))
    map.addSource('spc-outlook', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  if (!map.getSource('rings'))
    map.addSource('rings', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  if (!map.getSource('sites'))
    map.addSource('sites', { type: 'geojson', data: sitesGeoJSON() });
  if (!map.getSource('cyclones'))
    map.addSource('cyclones', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  if (!map.getSource('lsr'))
    map.addSource('lsr', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });

  // Register the CIG hatch tiles. Style loads wipe added images, so (re)add them
  // each time before the layer that references them by name.
  for (const lvl of [1, 2, 3]) {
    const id = `cig-hatch-${lvl}`;
    if (!map.hasImage(id)) {
      const img = cigHatchImage(lvl);
      map.addImage(id, img.data, { pixelRatio: img.pixelRatio });
    }
  }
  ensureSitePillImages(map);

  // SPC outlook fill — translucent risk-area shading, beneath the alert fill (and
  // the radar) so live warnings always read on top. Each feature carries its
  // official `fill`/`stroke` risk colours, so the layers just read them through.
  // Conditional Intensity Group (CIG) areas are excluded here and drawn as a
  // hatch overlay below instead of the flat grey their `fill` would give.
  const isCig = ['==', ['slice', ['coalesce', ['get', 'LABEL'], ''], 0, 3], 'CIG'];
  map.addLayer(
    {
      id: 'spc-outlook-fill',
      type: 'fill',
      source: 'spc-outlook',
      filter: ['!', isCig],
      paint: { 'fill-color': ['get', 'fill'], 'fill-opacity': state.spcOpacity },
    },
    dataAnchor
  );
  // CIG hatch — density keyed to the level, matching the intensity legend.
  map.addLayer(
    {
      id: 'spc-outlook-cig',
      type: 'fill',
      source: 'spc-outlook',
      filter: isCig,
      paint: {
        'fill-pattern': ['match', ['get', 'LABEL'],
          'CIG2', 'cig-hatch-2',
          'CIG3', 'cig-hatch-3',
          'cig-hatch-1'],
        'fill-opacity': Math.min(1, (state.spcOpacity / 0.3) * 0.85),
      },
    },
    dataAnchor
  );

  // Translucent alert fill — sits below the radar (and the basemap roads).
  map.addLayer(
    {
      id: 'alerts-fill',
      type: 'fill',
      source: 'alerts',
      paint: {
        'fill-color': ['get', 'color'],
        'fill-opacity': alertFillOpacityExpr(),
      },
    },
    dataAnchor
  );
  // Alert outline — at the label anchor, so it stays above the radar and the
  // basemap roads but beneath the town labels. Outline colour and width ride on
  // the feature (per-kind, user-adjustable); a selected alert is thickened.
  map.addLayer(
    {
      id: 'alerts-line',
      type: 'line',
      source: 'alerts',
      paint: {
        'line-color': ['coalesce', ['get', 'outlineColor'], ['get', 'color']],
        'line-width': [
          'case',
          ['boolean', ['get', 'selected'], false], 4.5,
          ['coalesce', ['get', 'outlineWidth'], 2.5],
        ],
        'line-opacity': alertLineOpacity(),
      },
    },
    anchor
  );
  map.addLayer({
    id: 'lsr-points', type: 'circle', source: 'lsr',
    layout: { visibility:(state.lsr ? state.lsr.enabled : state._lsr.on) ? 'visible' : 'none' },
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 3, 7, 5.5, 10, 7],
      'circle-color': ['get', 'color'],
      'circle-stroke-color': 'rgba(10,20,35,0.9)', 'circle-stroke-width': 1.2,
      'circle-opacity': .92,
    },
  }, anchor);
  // SPC outlook outline — kept above the radar (label anchor) so risk boundaries
  // stay visible even where radar echoes cover the translucent fill.
  map.addLayer(
    {
      id: 'spc-outlook-line',
      type: 'line',
      source: 'spc-outlook',
      paint: { 'line-color': ['get', 'stroke'], 'line-width': 1.6, 'line-opacity': 0.9 },
    },
    anchor
  );
  // Tropical cyclones. Every feature carries `kind` (cone / past / track /
  // point / current), so one GeoJSON source feeds five filtered layers. The
  // translucent cone fill sits at the data anchor (under the radar, like the
  // alert fill); the tracks/points/markers go at the label anchor so they read
  // over the radar and roads. Visibility comes from the master + per-part
  // toggles (persisted in state._cyclones until the controller is built).
  const cycOn = state.cyclones ? state.cyclones.enabled : state._cyclones.on;
  const cycShow = state.cyclones ? state.cyclones.show : state._cyclones;
  const cycVis = (part) => ({ visibility: cycOn && cycShow[part] ? 'visible' : 'none' });
  map.addLayer(
    {
      id: 'cyclones-cone',
      type: 'fill',
      source: 'cyclones',
      filter: ['==', ['get', 'kind'], 'cone'],
      layout: cycVis('cone'),
      paint: { 'fill-color': '#ffffff', 'fill-opacity': 0.14 },
    },
    dataAnchor
  );
  map.addLayer(
    {
      id: 'cyclones-cone-line',
      type: 'line',
      source: 'cyclones',
      filter: ['==', ['get', 'kind'], 'cone'],
      layout: cycVis('cone'),
      paint: { 'line-color': 'rgba(255,255,255,0.75)', 'line-width': 1.6 },
    },
    anchor
  );
  map.addLayer(
    {
      id: 'cyclones-past',
      type: 'line',
      source: 'cyclones',
      filter: ['==', ['get', 'kind'], 'past'],
      layout: cycVis('path'),
      paint: {
        'line-color': 'rgba(170,180,195,0.9)',
        'line-width': 1.6,
        'line-dasharray': [2, 2.5],
      },
    },
    anchor
  );
  map.addLayer(
    {
      id: 'cyclones-track',
      type: 'line',
      source: 'cyclones',
      filter: ['==', ['get', 'kind'], 'track'],
      layout: { 'line-join': 'round', ...cycVis('path') },
      paint: { 'line-color': ['get', 'color'], 'line-width': 2.4, 'line-opacity': 0.95 },
    },
    anchor
  );
  map.addLayer(
    {
      id: 'cyclones-points',
      type: 'circle',
      source: 'cyclones',
      filter: ['==', ['get', 'kind'], 'point'],
      layout: cycVis('path'),
      paint: {
        'circle-radius': 4.5,
        'circle-color': ['get', 'color'],
        'circle-stroke-color': 'rgba(10,20,35,0.9)',
        'circle-stroke-width': 1.2,
      },
    },
    anchor
  );
  map.addLayer(
    {
      id: 'cyclones-current',
      type: 'circle',
      source: 'cyclones',
      filter: ['==', ['get', 'kind'], 'current'],
      layout: cycVis('current'),
      paint: {
        'circle-radius': 8,
        'circle-color': ['get', 'color'],
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 2,
      },
    },
    anchor
  );
  // Local storm reports — point markers coloured by report category (feature
  // `color`), at the label anchor so they read over the radar. The controller
  // re-applies the category filter (setFilter) and visibility in reapply().
  map.addLayer(
    {
      id: 'lsr-points',
      type: 'circle',
      source: 'lsr',
      layout: { visibility: (state.lsr ? state.lsr.enabled : state._lsr.on) ? 'visible' : 'none' },
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 3, 7, 5.5, 10, 7],
        'circle-color': ['get', 'color'],
        'circle-stroke-color': 'rgba(10,20,35,0.9)',
        'circle-stroke-width': 1.2,
        'circle-opacity': 0.92,
      },
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
      layout: { visibility: state.siteMarkerStyle === 'dot' ? 'visible' : 'none' },
      paint: {
        'circle-radius': ['case', ['==', ['get', 'current'], 1], 6, 3.5],
        // Active site → accent; down (no scan in the past hour) → red; TDWR
        // terminal radars → yellow; NEXRAD → blue.
        'circle-color': [
          'case',
          ['==', ['get', 'current'], 1], selectedRadarColor(),
          ['==', ['get', 'down'], 1], 'rgba(235,60,60,0.9)',
          ['==', ['get', 'tdwr'], 1], 'rgba(245,205,40,0.9)',
          'rgba(80,140,220,0.85)',
        ],
        'circle-stroke-color': [
          'case',
          ['==', ['get', 'current'], 1], selectedRadarColor(),
          ['==', ['get', 'down'], 1], 'rgba(255,120,120,0.95)',
          ['==', ['get', 'tdwr'], 1], 'rgba(255,230,130,0.95)',
          'rgba(150,205,255,0.85)',
        ],
        'circle-stroke-width': ['case', ['==', ['get', 'current'], 1], 2, 1],
        'circle-opacity': ['case', ['==', ['get', 'current'], 1], 1, 0.6],
      },
    },
    anchor
  );
  // The radar-site pills go in *without* an anchor, so they're appended at the
  // very top of the layer stack — above the basemap's town labels and admin
  // borders. (Sites/dots stay at the label anchor; only the labelled pills are
  // lifted clear, per the requested z-order so the station IDs are never hidden
  // behind a town name or a state line.)
  map.addLayer(
    {
      id: 'site-pills',
      type: 'symbol',
      source: 'sites',
      layout: {
        visibility: state.siteMarkerStyle === 'pill' ? 'visible' : 'none',
        'icon-image': ['get', 'pillIcon'],
        'icon-size': ['case', ['==', ['get', 'current'], 1], 1.08, 1],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
      paint: {
        'icon-opacity': ['case', ['==', ['get', 'current'], 1], 1, 0.82],
      },
    }
  );

  addCoastline(map, anchor);
  // Restyle the basemap's own town labels, roads, rivers and borders
  // (and add county lines) per the user's map-style options. setStyle wiped the
  // stock paint, so capture fresh native widths here (fresh: true).
  applyMapStyle(map, state.mapStyle, anchor, { fresh: true });

  refreshSiteDots();

  // Repaint the active source's layer into its place between fill and line.
  // (When the layer stack owns the display the renderLayerStack call below
  // repaints everything; the main radar sweep stays hidden.)
  if (state.mode === 'radar' && state.shownSweep && state.shownSite && !mainSourceSuppressed())
    setRadarSource(map, state.shownSweep, radarProduct(state.productId), state.shownSite);
  else if (state.mode === 'satellite' && state.sat.scene) renderSatellite();
  else if (state.mode === 'mrms' && state.mrms.grid) renderMrms();
  else if (state.mode === 'models' && state.models.grid) renderModels();
  else if (state.mode === 'observations' && state.observations.grid) renderObservations();
  // Re-apply the single-site radar overlay if it's enabled in a non-radar mode.
  if (state.mode !== 'radar' && state.mode !== 'outlooks' && state.radarOverlay) applyRadarOverlay();
  if (state.alerts) state.alerts.refreshVisible();
  if (state.spc) state.spc.reapply();
  if (state.cyclones) state.cyclones.reapply();
  if (state.lsr) state.lsr.reapply();
  renderLayerStack();
}

// Hand the current sweep to the custom WebGL radar layer, inserting the layer at
// the data anchor (beneath the basemap roads/borders) if it isn't on the map yet.
// The layer then renders the polar data directly on the GPU every frame — no
// rasterised image, so the gates stay pixel-exact at every zoom and pan/zoom cost
// no JavaScript.
function setRadarSource(map, sweep, product, site) {
  if (!state.radarLayer) state.radarLayer = createRadarLayer();
  if (!map.getLayer('radar')) map.addLayer(state.radarLayer, dataLayerAnchor(map));
  // As the *overlay* in a non-radar mode the radar must draw on top of the
  // active source (satellite / MRMS / model / obs), which shares the data
  // anchor — so lift it to the label anchor (above the data layers and the
  // basemap roads, still below the town labels). Back in true radar mode it
  // returns to the data anchor, beneath the roads, the classic look.
  try {
    map.moveLayer('radar', state.mode !== 'radar' ? firstLabelLayerId(map) : dataLayerAnchor(map));
  } catch (_) { /* anchor layer missing on an exotic style — keep current slot */ }
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
// Keep the idle footprint predictable. Decoder workers retain their JS/WASM
// heaps after a job, so six long-lived workers could account for hundreds of
// megabytes even after playback closed. Two still overlap download/decode work
// without multiplying the resident heap; constrained devices use one.
const DECODE_POOL_SIZE = CONSTRAINED_DEVICE ? 1 : 2;
let decodeSeq = 0;
const pending = new Map();
const decodeWorkers = new Array(DECODE_POOL_SIZE).fill(null);

function failDecodeWorker(target, error) {
  for (const [id, job] of pending) {
    if (job.worker !== target) continue;
    pending.delete(id);
    job.reject(error);
  }
  target.busy = 0;
  try { target.terminate(); } catch (_) { /* already stopped */ }
  const index = decodeWorkers.indexOf(target);
  if (index >= 0) decodeWorkers[index] = null;
}

function createDecodeWorker(index) {
  const w = new Worker(new URL('./decoder.worker.js', import.meta.url), {
    type: 'module',
  });
  w.busy = 0; // outstanding decode jobs on this worker
  w.onmessage = (e) => {
    const { id, ok, result, error } = e.data;
    const job = pending.get(id);
    if (!job) return;
    pending.delete(id);
    w.busy = Math.max(0, w.busy - 1);
    if (ok) job.resolve(result);
    else job.reject(new Error(error));
  };
  // A worker crash used to leave every assigned promise pending forever and its
  // `busy` count permanently elevated. Reject only this worker's jobs and leave
  // an empty pool slot; the next decode lazily creates a replacement.
  w.onerror = (event) => {
    failDecodeWorker(w, new Error(`radar decode worker error: ${event.message || 'crashed'}`));
  };
  w.onmessageerror = () => {
    failDecodeWorker(w, new Error('radar decode worker returned an unreadable response'));
  };
  decodeWorkers[index] = w;
  return w;
}

function decodeVolume(bytes) {
  const id = ++decodeSeq;
  // Hand the job to the least-loaded worker (round-robin used to stack several
  // decodes on one worker while others sat idle when job durations varied); jobs
  // are keyed by a global id so replies route back correctly regardless of which
  // worker answers first.
  return new Promise((resolve, reject) => {
    let creationError = null;
    for (let i = 0; i < decodeWorkers.length; i++) {
      if (decodeWorkers[i]) continue;
      try { createDecodeWorker(i); }
      catch (error) { creationError = error; }
    }
    const available = decodeWorkers.filter(Boolean);
    if (!available.length) {
      reject(creationError || new Error('no radar decode worker is available'));
      return;
    }
    let w = available[0];
    for (const cand of available) if (cand.busy < w.busy) w = cand;
    w.busy++;
    pending.set(id, { resolve, reject, worker: w });
    try {
      w.postMessage({ id, bytes }, [bytes.buffer]); // zero-copy transfer
    } catch (error) {
      // A browser can synchronously reject a post to a worker it just killed.
      // Route that through the same cleanup as an asynchronous worker crash.
      failDecodeWorker(w, error);
    }
  });
}

// ---------------------------------------------------------------------------
// Decoded-frame caches — the key to instant arrow-key frame stepping.
//
// Stepping through scans used to re-download and re-decode the volume on every
// keypress. Now each decoded Level II volume (and Level III frame) is kept in a
// small LRU, and after a scan displays its neighbours are prefetched in the
// background, so stepping to an adjacent frame is a synchronous cache hit.
// Caches are bounded by count (decoded volumes are multi-MB) and keyed by the
// globally-unique S3 object key, so stale entries from another site/day simply
// age out; small screens keep far fewer frames to avoid memory pressure.
// ---------------------------------------------------------------------------
const VOLUME_CACHE_MAX = CONSTRAINED_DEVICE ? 1 : 3;
const L3_CACHE_MAX = CONSTRAINED_DEVICE ? 2 : 6;
const volumeCache = new Map(); // L2 key -> decoded volume (Map order = LRU)
const l3Cache = new Map(); // `${productId}|${key}` -> decoded L3 frame
const volumeInflight = new Map(); // key -> in-flight Promise (dedupes prefetch vs. click)

function lruGet(cache, key) {
  const v = cache.get(key);
  if (v !== undefined) { cache.delete(key); cache.set(key, v); } // refresh recency
  return v;
}
function lruPut(cache, key, value, max) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > max) cache.delete(cache.keys().next().value);
}

// Synchronous lookup: the LRU first, then a frame the background playback warm
// already decoded. Playback frames are *slim* volumes (only the looping
// product's moment — see slimVolumeForMoment), so they can never be promoted
// into the full-volume LRU: another product would find its moment missing.
function peekDecodedVolume(key) {
  const hit = lruGet(volumeCache, key);
  if (hit) return hit;
  const pb = state.playback;
  if (pb && pb.cache) {
    const warm = pb.cache.get(key);
    if (warm && warm.sweeps && !warm.slim) {
      lruPut(volumeCache, key, warm, VOLUME_CACHE_MAX);
      return warm;
    }
  }
  return null;
}

// A view of a decoded volume keeping only one moment's data blocks (all tilts).
// The gate arrays are shared with the source volume — nothing is copied — so a
// slim frame retains ~1/6th of the full decode once the source volume ages out
// of the LRU. This is what radar playback caches per frame: a loop only ever
// draws one product, and a product switch tears the loop down anyway, so the
// other five moments were pure dead weight (hundreds of MB across a loop).
function slimVolumeForMoment(volume, moment) {
  if (!volume || !volume.sweeps) return volume;
  const sweeps = [];
  for (const sw of volume.sweeps) {
    const radials = [];
    for (const r of sw.radials) {
      const m = r.moments && r.moments[moment];
      if (!m) continue;
      radials.push({
        azimuth: r.azimuth,
        elevation: r.elevation,
        azimuthResolution: r.azimuthResolution,
        messageType: r.messageType,
        nyquist: r.nyquist,
        moments: { [moment]: m },
      });
    }
    if (!radials.length) continue;
    sweeps.push({
      elevationNumber: sw.elevationNumber,
      elevation: sw.elevation,
      time: sw.time,
      supportsSuperRes: sw.supportsSuperRes,
      moments: [moment],
      radials,
    });
  }
  return {
    icao: volume.icao,
    site: volume.site,
    messageType: volume.messageType,
    supportsSuperRes: volume.supportsSuperRes,
    radialCount: volume.radialCount,
    sweeps,
    slim: true,
  };
}

function radarSiteGeometry(icao) {
  const code = String(icao || '').trim().toUpperCase();
  const row = RADARS.find((r) => r[0] === code);
  return row ? { lat: row[2], lon: row[3], height: 0, inferred: true } : null;
}

function siteIdFromVolumeKey(key) {
  const parts = String(key || '').split('/');
  for (const part of parts) {
    if (/^[A-Z0-9]{4}$/i.test(part) && RADARS.some((r) => r[0] === part.toUpperCase()))
      return part.toUpperCase();
  }
  const name = parts[parts.length - 1] || '';
  const match = name.match(/^([A-Z0-9]{4})/i);
  return match ? match[1].toUpperCase() : '';
}

// Message-1 files predate the generic VOL block and therefore contain no tower
// coordinates. Fill them from the app's radar catalog so historical scans draw,
// inspect, export and cross-section exactly like modern Message-31 volumes.
function ensureVolumeSite(volume, fallbackIcao) {
  if (!volume) return volume;
  const headerIcao = String(volume.icao || '').trim().toUpperCase();
  const icao = headerIcao || String(fallbackIcao || '').trim().toUpperCase();
  if (icao) volume.icao = icao;
  if (!volume.site) volume.site = radarSiteGeometry(icao || fallbackIcao);
  return volume;
}

function getDecodedVolume(key, onProgress) {
  const hit = peekDecodedVolume(key);
  if (hit) return Promise.resolve(hit);
  const inflight = volumeInflight.get(key);
  if (inflight) return inflight;
  const job = (async () => {
    const bytes = await fetchVolume(key, onProgress);
    const volume = ensureVolumeSite(await decodeVolume(bytes), siteIdFromVolumeKey(key));
    lruPut(volumeCache, key, volume, VOLUME_CACHE_MAX);
    return volume;
  })();
  volumeInflight.set(key, job);
  job.finally(() => volumeInflight.delete(key)).catch(() => {});
  return job;
}

// Warm the scans adjacent to the one just shown so the next arrow-key step hits
// the cache. Runs quietly in the background on the decode pool; skipped on small
// screens (memory) and never re-requests anything cached or already in flight.
function prefetchAdjacentVolumes(key) {
  if (mqSmallScreen.matches || isL3Product(state.productId)) return;
  const i = state.volumes.findIndex((v) => v.key === key);
  if (i < 0) return;
  // Immediate neighbours only: the LRU holds three volumes, so warming a third
  // neighbour just evicted something still useful (and pinned an extra ~100 MB).
  for (const j of [i - 1, i + 1]) {
    const v = state.volumes[j];
    if (!v || volumeCache.has(v.key) || volumeInflight.has(v.key)) continue;
    getDecodedVolume(v.key).catch(() => {});
  }
}

const state = {
  site: 'KTLX',
  date: utcDay(),
  volumes: [],
  volumeKey: null,
  volume: null,
  sweeps: [],
  selectedElevation: 0.5,
  // Level III single-site products (echo tops / QPE) decode to a synthetic
  // one-tilt sweep held here, separate from the Level II volume above.
  l3: { decoded: null },
  productId: 'REF',
  opacity: 0.85,
  // Smoothing level for the plotted data (radar / satellite / grid sources):
  // 0 none (crisp native pixels), 1 low, 2 medium, 3 high. Opt-in; defaults off.
  // `smooth` is the ACTIVE mode's level; `smoothByMode` remembers each source's
  // own setting so smoothing chosen on (say) models doesn't follow you to obs.
  smooth: 0,
  smoothByMode: { radar: 0, satellite: 0, mrms: 0, models: 0, observations: 0, outlooks: 0 },
  // Unfold aliased velocities by default: without this, gates beyond the Nyquist
  // co-interval fold back to small/wrong-signed values, so VEL reads much lower
  // than dealiased sources (RadarScope, GR2Analyst, NWS). The toggle can turn it
  // off to inspect the raw folded field.
  dealias: true,
  // Opt-in legacy-resolution rendering, tracked per radar product so the user
  // can, say, view REF at legacy resolution while VEL stays super-res. Keys are
  // product ids (REF, VEL, …); a truthy value means "render this product at
  // legacy resolution". The source capability remains separate: pre-super-
  // resolution Message-1 archives are detected from their decoded radial
  // metadata and already draw natively at legacy resolution regardless.
  radarLegacyProducts: {},
  live: false,
  // Radar is pinned to live; archive mode is the only way to browse past scans
  // without the 60 s refresh snapping the view forward. Off ⇒ live.
  radarArchive: false,
  liveTimer: null,
  map: null,
  geolocate: null,
  // Show the clock in the viewer's local time zone instead of UTC.
  tzLocal: false,
  // What the time readout shows: 'product' (the selected frame's scan / valid
  // time — the default) or 'now' (the live wall clock).
  timeSource: 'product',
  mapProvider: 'mapbox',
  basemap: 'dark',
  uiTheme: 'dark',
  reduceMotion: false,
  // User customisation of the basemap's own layers (town labels, roads,
  // rivers, borders). Re-applied on every style load so it survives a
  // basemap switch. See js/mapStyle.js.
  mapStyle: { ...DEFAULT_MAP_STYLE },
  // Per-alert-kind appearance overrides, keyed by display name:
  // { color, fillOpacity, outlineColor, outlineWidth }. Empty = stock colours.
  alertStyle: {},
  // Global multiplier (0.1–1) on every alert's fill AND outline opacity, on top
  // of the per-kind overrides above — one slider to fade the whole alert layer.
  alertOpacity: 1,
  showRings: true,
  siteMarkerStyle: 'dot',
  // Persist the map view, last product and settings between visits (toggleable).
  persist: true,
  radarLayer: null,
  // In satellite / MRMS / model / observation modes the single-site radar is hidden unless
  // this overlay toggle is switched on.
  radarOverlay: false,
  modelCityValues: true,
  cityValuesProducts: {},
  // Appearance of the city data readouts (the value labels drawn above town
  // names): font key (see CITY_READOUT_FONTS), size in px at zoom 12, and color.
  cityReadout: { font: 'default', size: 24, color: '#ffffff' },
  layers: { enabled: false, activeId: null, items: [], seq: 1, renderSeq: 0, renderedIds: [], custom: {}, cache: new Map() },
  styleReady: false,
  geo: null,
  alerts: null,
  // Tropical cyclones overlay (NHC + JTWC). `_cyclones` holds the restored
  // prefs (master + per-part toggles) applied when the controller is built at
  // init — the same pattern as `spc`/`_spc` below.
  cyclones: null,
  _cyclones: { on: false, path: true, current: true, cone: true },
  // Local storm reports overlay (IEM LSR feed — all report types, flooding
  // included). `_lsr` holds the restored prefs (master toggle, time window,
  // per-category filters) applied when the controller is built at init.
  lsr: null,
  _lsr: { on: false, hours: LSR_DEFAULT_HOURS, cats: defaultLsrCats() },
  // ICAO codes of radars judged "down" (no scan in the past hour, or none found)
  // by the background scan kicked off on load; their map dots are drawn red.
  downSites: new Set(),
  _downScanSeq: 0,
  // Forecast outlook overlay (SPC convective / fire wx / mesoscale disc., CPC
  // temp / precip). `_spc` holds the restored prefs applied when the controller
  // is built at init. (`spc`/`_spc` names kept for settings back-compat.)
  spc: null,
  _spc: { on: false, product: 'spc_conv', detail: '1:cat' },
  // Outlook fill shading opacity (0–1), user-adjustable + persisted. The risk-area
  // boundaries (outline) stay full so they read even at a faint fill.
  spcOpacity: 0.3,
  _outlookSourceForced: false,
  _outlookSourcePrevOn: null,
  shownSweep: null,
  shownSite: null,
  // Per-panel collapsed state for the sidebar sections (persisted). Rarely-used
  // panels default collapsed so the sidebar isn't a wall of controls.
  panelCollapsed: {},
  inspect: false,
  // Last-loaded HRRR sounding profile (sounding.js), re-rendered on resize.
  soundingProfile: null,
  playback: null,
  // How many frames each playback loop preloads (user-adjustable).
  playbackFrames: 5,
  // Map-tool controllers (METAR station plots, draw/measure/storm, split view).
  metars: null,
  _metarsOn: false,
  mapTools: null,
  splitView: null,
  exportTool: null,
  // Freehand-draw tool appearance (user-adjustable, persisted).
  draw: { color: '#36e0c8', width: 2.4 },
  // Keyboard shortcuts: { global, radar, satellite, mrms, models } maps of
  // combo→action. Built from defaults or storage by initKeybinds().
  keybinds: null,
  _storedKeybinds: null,

  // Source mode: 'radar' | 'satellite' | 'mrms' | 'models' | 'observations' | 'outlooks'.
  mode: 'radar',
  // Satellite (GOES ABI) state.
  sat: {
    satKey: 'goes19',
    sectorKey: 'conus',
    conusView: 0,
    productId: 'C13',
    enhanceIR: true,
    scenes: [],
    sceneKey: null,
    scene: null,
    _renderedProductId: null,
    displayMeta: null,
    _bbox: null,
    layer: null,
    // Microwave (MIRS) swath state: the rasterised grid of the shown granule
    // and its dedicated GPU grid layer (see mirs.js).
    mirsGrid: null,
    mirsLayer: null,
    // Active cyclone crop: { id, name, lat, lon, bbox }. When set (via the
    // sector picker's "Active cyclones" group or a storm's "View on satellite"
    // button) the full-disk scene is cropped to the storm's bbox.
    cyclone: null,
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
    stormId: null, // selected tropical cyclone id for storm-based models (HAFS)
    fhour: 0,
    grid: null,
    displayGrid: null,
    overlayData: null,
    layer: null,
  },
  observations: {
    productId: 'TMP',
    frames: [],
    frameKey: null,
    grid: null,
    displayGrid: null,
    layer: null,
  },
  // SPC Mesoanalysis (static plots). `active` is set when the Obs-mode Analysis
  // picker is "SPC Mesoanalysis"; the app then covers the map with #mesoView.
  meso: {
    active: false,
    sector: MESO_DEFAULT_SECTOR,
    code: MESO_DEFAULT_CODE,
    frameCount: MESO_DEFAULT_FRAMES,
    frames: [],       // recent hourly archive frames (oldest first)
    frameIndex: 0,    // which frame is on screen
    playing: false,
    _timer: null,
    _preload: null,
  },
};

const $ = (sel) => document.querySelector(sel);
const el = {};

function cacheEls() {
  el.map = $('#map');
  el.mapWrap = $('#mapWrap');
  el.mapHud = $('#mapHud');
  el.siteSelect = $('#siteSelect');
  el.dateInput = $('#dateInput');
  el.volumeList = $('#volumeList');
  el.productButtons = $('#productButtons');
  el.tiltList = $('#tiltList');
  el.legend = $('#legend');
  el.status = $('#status');
  el.clock = $('#clock');
  el.timeBar = $('#timeBar');
  el.tzToggle = $('#tzToggle');
  el.timeSrcToggle = $('#timeSrcToggle');
  el.meta = $('#meta');
  el.readout = $('#mapReadout');
  el.liveBtn = $('#liveBtn');
  el.refreshBtn = $('#refreshBtn');
  el.archiveField = $('#archiveField');
  el.archiveToggle = $('#archiveToggle');
  el.progress = $('#progress');
  el.decoding = $('#decoding');
  el.opacity = $('#opacity');
  el.opacityVal = $('#opacityVal');
  el.overlayOpacityField = $('#overlayOpacityField') || (el.opacity && el.opacity.closest('.opacity-field'));
  el.smooth = $('#smooth');
  el.smoothVal = $('#smoothVal');
  el.smoothField = $('#smoothField');
  el.smoothSegs = $('#smoothSegs');
  el.ringsToggle = $('#ringsToggle');
  el.ringsField = $('#ringsField') || (el.ringsToggle && el.ringsToggle.closest('.toggle-field'));
  el.persistToggle = $('#persistToggle');
  el.dealiasToggle = $('#dealiasToggle');
  el.dealiasField = $('#dealiasField');
  el.radarResolutionToggle = $('#radarResolutionToggle');
  el.radarResolutionField = $('#radarResolutionField');
  el.radarResolutionHint = $('#radarResolutionHint');
  el.radarOverlayField = $('#radarOverlayField');
  el.radarOverlayToggle = $('#radarOverlayToggle');
  el.modelCityValuesField = $('#modelCityValuesField');
  el.modelCityValuesToggle = $('#modelCityValuesToggle');
  el.cityValuesProducts = $('#cityValuesProducts');
  el.cityReadoutStyle = $('#cityReadoutStyle');
  el.cityFontSelect = $('#cityFontSelect');
  el.citySize = $('#citySize');
  el.citySizeVal = $('#citySizeVal');
  el.cityColor = $('#cityColor');
  el.layerPanel = $('#layerPanel');
  el.layeringToggle = $('#layeringToggle');
  el.layerControls = $('#layerControls');
  el.layerList = $('#layerList');
  el.layerAdd = $('#layerAdd');
  el.layerUp = $('#layerUp');
  el.layerDown = $('#layerDown');
  el.layerRemove = $('#layerRemove');
  el.layerSourceSelect = $('#layerSourceSelect');
  el.layerSiteField = $('#layerSiteField');
  el.layerSiteSelect = $('#layerSiteSelect');
  el.layerSatField = $('#layerSatField');
  el.layerSatSelect = $('#layerSatSelect');
  el.layerSectorField = $('#layerSectorField');
  el.layerSectorSelect = $('#layerSectorSelect');
  el.layerModelField = $('#layerModelField');
  el.layerModelSelect = $('#layerModelSelect');
  el.layerProductSelect = $('#layerProductSelect');
  el.layerStyleSelect = $('#layerStyleSelect');
  el.metarsToggle = $('#metarsToggle');
  el.lsrToggle = $('#lsrToggle');
  el.lsrPanel = $('#lsrPanel');
  el.lsrHours = $('#lsrHours');
  el.lsrFilters = $('#lsrFilters');
  el.lsrStatus = $('#lsrStatus');
  el.lsrList = $('#lsrList');
  el.lsrPreview = $('#lsrPreview');
  el.lsrPreviewCard = $('#lsrPreviewCard');
  el.metarsField = $('#metarsField') || (el.metarsToggle && el.metarsToggle.closest('.toggle-field'));
  el.metarControls = $('#metarControls');
  el.loopField = $('#loopField');
  el.loopBtn = $('#loopBtn');
  el.playFramesField = $('#playFramesField');
  el.playFrames = $('#playFrames');
  el.playFramesVal = $('#playFramesVal');
  el.palInput = $('#palInput');
  el.palCreate = $('#palCreate');
  el.palReset = $('#palReset');
  el.palName = $('#palName');
  el.palCreator = $('#palCreator');
  el.palCreatorClose = $('#palCreatorClose');
  el.palCreatorName = $('#palCreatorName');
  el.palCreatorProduct = $('#palCreatorProduct');
  el.palCreatorStops = $('#palCreatorStops');
  el.palAddStop = $('#palAddStop');
  el.palSaveCustom = $('#palSaveCustom');
  el.alertList = $('#alertList');
  el.alertsToggle = $('#alertsToggle');
  el.alertsRefresh = $('#alertsRefresh');
  el.alertDetail = $('#alertDetail');
  el.alertDetailPanel = $('#alertDetailPanel');
  el.alertClose = $('#alertClose');
  el.alertPreview = $('#alertPreview');
  el.alertPreviewCard = $('#alertPreviewCard');
  el.cyclonesPanel = $('#cyclonesPanel');
  el.cyclonesToggle = $('#cyclonesToggle');
  el.cyclonesPathToggle = $('#cyclonesPathToggle');
  el.cyclonesCurrentToggle = $('#cyclonesCurrentToggle');
  el.cyclonesConeToggle = $('#cyclonesConeToggle');
  el.cycloneStatus = $('#cycloneStatus');
  el.cycloneList = $('#cycloneList');
  el.cyclonePreview = $('#cyclonePreview');
  el.cyclonePreviewCard = $('#cyclonePreviewCard');
  el.lsrPanel = $('#lsrPanel');
  el.lsrToggle = $('#lsrToggle');
  el.lsrHours = $('#lsrHours');
  el.lsrFilters = $('#lsrFilters');
  el.lsrStatus = $('#lsrStatus');
  el.lsrList = $('#lsrList');
  el.lsrPreview = $('#lsrPreview');
  el.lsrPreviewCard = $('#lsrPreviewCard');
  el.mapStyleControls = $('#mapStyleControls');
  el.alertOpacity = $('#alertOpacity');
  el.alertOpacityVal = $('#alertOpacityVal');
  el.alertStyleControls = $('#alertStyleControls');
  el.drawStyleControls = $('#drawStyleControls');
  el.drawToolPopup = $('#drawToolPopup');
  el.drawToolPopupTitle = $('#drawToolPopupTitle');
  el.keybindControls = $('#keybindControls');
  el.reduceMotionToggle = $('#reduceMotionToggle');
  el.spcPanel = $('#spcPanel');
  el.spcToggle = $('#spcToggle');
  el.outlookSelect = $('#outlookSelect');
  el.outlookDetail = $('#outlookDetail');
  el.outlookDetailLabel = $('#outlookDetailLabel');
  el.outlookDayField = $('#outlookDayField');
  el.outlookDay = $('#outlookDay');
  el.spcOpacity = $('#spcOpacity');
  el.spcOpacityVal = $('#spcOpacityVal');
  el.spcStatus = $('#spcStatus');
  el.spcLegend = $('#spcLegend');

  // Source modes (radar / satellite / MRMS / models / observations / outlooks).
  el.modeSwitch = $('#modeSwitch');
  el.siteField = $('#siteField');
  el.satFields = $('#satFields');
  el.satSelect = $('#satSelect');
  el.sectorSelect = $('#sectorSelect');
  el.conusViewField = $('#conusViewField');
  el.conusViewSelect = $('#conusViewSelect');
  el.mrmsFields = $('#mrmsFields');
  el.obsFields = $('#obsFields');
  el.obsDomainSelect = $('#obsDomainSelect');
  el.mesoPanel = $('#mesoPanel');
  el.mesoProductSelect = $('#mesoProductSelect');
  el.mesoSectorSelect = $('#mesoSectorSelect');
  el.mesoFramesSelect = $('#mesoFramesSelect');
  el.mesoView = $('#mesoView');
  el.mesoViewTitle = $('#mesoViewTitle');
  el.mesoImg = $('#mesoImg');
  el.mesoLoading = $('#mesoLoading');
  el.mesoError = $('#mesoError');
  el.mesoRefresh = $('#mesoRefresh');
  el.mesoOpen = $('#mesoOpen');
  el.mesoPrev = $('#mesoPrev');
  el.mesoPlay = $('#mesoPlay');
  el.mesoNext = $('#mesoNext');
  el.mesoScrub = $('#mesoScrub');
  el.mesoTime = $('#mesoTime');
  el.modelFields = $('#modelFields');
  el.modelSelect = $('#modelSelect');
  el.stormFields = $('#stormFields');
  el.stormSelect = $('#stormSelect');
  el.fhourPanel = $('#fhourPanel');
  el.fhourList = $('#fhourList');
  el.outlookDetailPanel = $('#outlookDetailPanel');
  el.outlookDetailList = $('#outlookDetailList');
  el.volumeTitle = $('#volumeTitle');
  el.crossSectionVst = $('#crossSectionVst');
  el.tiltPanel = $('#tiltPanel');
  el.satOptsPanel = $('#satOptsPanel');
  el.irEnhanceToggle = $('#irEnhanceToggle');
  el.satInfo = $('#satInfo');

  // Mobile control surface.
  el.sidebar = $('#sidebar');
  el.displayPanel = $('#displayPanel');
  el.settingsBtn = $('#settingsBtn');
  el.layoutSwitch = $('#layoutSwitch');
  el.layoutPanel = $('#layoutPanel');
  el.sidebarFoot = $('.sidebar-foot');
  el.layout = $('.layout');
  el.stage = $('.stage');
  el.mobileDock = $('#mobileDock');
  el.dockStatus = $('#dockStatus');
  el.dockProd = $('#dockProd');
  el.dockSite = $('#dockSite');
  el.dockTime = $('#dockTime');
  el.playBtn = $('#playBtn');
  el.inspectBtn = $('#inspectBtn');
  el.dockSettings = $('#dockSettings');
  el.dockMain = $('#dockMain');
  el.dockNav = $('#dockNav');
  el.dockBack = $('#dockBack');
  el.dockFwd = $('#dockFwd');
  el.dockSource = $('#dockSource');
  el.dockSourceIcon = $('#dockSourceIcon');
  el.dockSourceLabel = $('#dockSourceLabel');
  el.dockSourcePicker = $('#dockSourcePicker');
  el.dockToolSlot = $('#dockToolSlot');
  el.dockToolMore = $('#dockToolMore');
  el.dockToolBtn = $('#dockToolBtn');
  el.dockToolMenu = $('#dockToolMenu');
  // Mobile floating top bar (site chip + LIVE + theme toggle).
  el.mobileTopBar = $('#mobileTopBar');
  el.mtbSite = $('#mtbSite');
  el.mtbCode = $('#mtbCode');
  el.mtbCity = $('#mtbCity');
  el.mtbLive = $('#mtbLive');
  el.mtbTime = $('#mtbTime');
  el.mtbTimeText = $('#mtbTimeText');
  el.mtbTheme = $('#mtbTheme');
  el.mtbThemeIcon = $('#mtbThemeIcon');
  el.soundingHint = $('#soundingHint');
  el.breadcrumb = $('#breadcrumb');
  el.breadcrumbText = $('#breadcrumbText');
  el.breadcrumbIcon = $('#breadcrumbIcon');
  el.sheet = $('#mobileSheet');
  el.sheetBody = $('#sheetBody');
  el.sheetScrim = $('#sheetScrim');
  el.sheetGrip = $('#sheetGrip');
  el.sheetHeader = $('#sheetHeader');
  el.sheetTitle = $('#sheetTitle');
  // Mobile single-scroll surface (Products popup / Settings popup).
  el.sheetScroll = $('#sheetScroll');
  el.sheetProducts = $('#sheetProducts');
  el.sheetSettings = $('#sheetSettings');
  // Mobile swipe carousel (pages + tabs) and the panels relocated into them.
  el.sheetTabs = $('#sheetTabs');
  el.sheetPager = $('#sheetPager');
  el.pageControls = $('#pageControls');
  el.pageSettings = $('#pageSettings');
  el.pageMap = $('#pageMap');
  // Settings popup quick-access block + the collapsible "more settings" body
  // beneath it (desktop collapses this by default; mobile keeps it expanded
  // since it's the only home for Product/Tilt/Source/Alerts there).
  el.quickSettings = $('#quickSettings');
  el.moreSettingsToggle = $('#moreSettingsToggle');
  el.moreSettingsBody = $('#moreSettingsBody');
  el.sourcePanel = $('#sourcePanel');
  el.volumePanel = $('#volumePanel');
  el.alertsPanel = $('#alertsPanel');
  el.productPanel = $('#productPanel');
  el.basemapPanel = $('#basemapPanel');
  el.metaPanel = $('#metaPanel');
  el.mapProviderSelect = $('#mapProviderSelect');
  el.basemapSelect = $('#basemapSelect');
  el.uiThemeSelect = $('#uiThemeSelect');
  el.siteMarkerSelect = $('#siteMarkerSelect');
  el.sheetPlayback = $('#sheetPlayback');
  el.playSpeed = $('#playSpeed');
  el.playSpeedVal = $('#playSpeedVal');
  el.playSpeedBtn = $('#playSpeedBtn');
  el.crosshair = $('#crosshair');
  el.crosshairRead = $('#crosshairRead');

  // Map tools toolbar.
  el.toolDraw = $('#toolDraw');
  el.toolMeasure = $('#toolMeasure');
  el.toolStorm = $('#toolStorm');
  el.toolXsect = $('#toolXsect');
  el.toolInspect = $('#toolInspect');
  el.toolLocate = $('#toolLocate');
  el.toolSplit = $('#toolSplit');
  el.toolExport = $('#toolExport');
  el.toolClear = $('#toolClear');
  el.playbackBar = $('#playbackBar');
  el.playToggle = $('#playToggle');
  el.playScrub = $('#playScrub');
  el.playScrubProg = $('#playScrubProg');
  el.playLabel = $('#playLabel');
  el.playClose = $('#playClose');
  // Dock the playback scrubber inside the bottom dock so that, while a loop runs,
  // it only takes the product + play slot and the inspect + tools buttons stay
  // reachable beside it (CSS hides the product chip + dock play button instead).
  el.dockMain.insertBefore(el.playbackBar, el.inspectBtn);

  // Model sounding (Skew-T / hodograph / severe parameters). Launched in models
  // mode by right-clicking (desktop) or long-pressing (mobile) a map point.
  el.sounding = $('#sounding');
  el.sndClose = $('#sndClose');
  el.sndTitle = $('#sndTitle');
  el.sndMeta = $('#sndMeta');
  el.sndStatus = $('#sndStatus');
  el.sndCharts = $('#sndCharts');
  el.sndSkewt = $('#sndSkewt');
  el.sndHodo = $('#sndHodo');
  el.sndStormMotion = $('#sndStormMotion');
  el.sndParams = $('#sndParams');

  // These overflow panels start `hidden` in the raw markup only so they don't
  // flash in a stray spot while sitting outside both the sidebar and the
  // sheet before the first layout pass runs (below). Their actual on-screen
  // visibility from here on is purely a function of which container (sidebar,
  // sheet page, or neither while the drawer/sheet is closed) they're in.
  [el.volumePanel, el.displayPanel, el.basemapPanel, el.spcPanel, el.metaPanel]
    .forEach((p) => { if (p) p.hidden = false; });
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
    style: basemapStyleUrl(),
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
    // Desktop retains an export-ready backbuffer. On constrained devices that
    // buffer can be tens of MB, so stability takes priority while loading data.
    preserveDrawingBuffer: !CONSTRAINED_DEVICE,
  });
  // The zoom control sits bottom-left: the top-left corner is now the floating
  // time readout and the top-right is the map-tool rail.
  map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'bottom-left');
  // Live user location: a Mapbox GeolocateControl handles the browser permission
  // prompt, the pulsing position dot, the accuracy circle and continuous
  // tracking. Its own control button is hidden (CSS) in favour of the map-tool
  // button below, which simply triggers it.
  state.geolocate = new mapboxgl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true },
    trackUserLocation: true,
    showUserHeading: true,
    showAccuracyCircle: true,
  });
  map.addControl(state.geolocate, 'bottom-left');
  state.map = map;

  window.addEventListener('radarnexus:location', (event) => {
    const d = event.detail || {};
    if (Array.isArray(d.bbox) && d.bbox.length === 4) {
      map.fitBounds([[d.bbox[0], d.bbox[1]], [d.bbox[2], d.bbox[3]]], {
        padding: 70, maxZoom: 13,
      });
    } else if (Number.isFinite(d.lon) && Number.isFinite(d.lat)) {
      map.flyTo({ center: [d.lon, d.lat], zoom: Math.max(map.getZoom(), 10) });
    }
    if (d.label) setStatus(`location: ${d.label}`);
  });

  // If the supplied token is invalid/revoked, Mapbox emits a 401. Clear the bad
  // token and re-open the setup gate rather than leaving the user a blank map.
  map.on('error', (e) => {
    const status = e && e.error && e.error.status;
    if (status === 401 || status === 403) {
      clearStoredMapToken(state.mapProvider);
      showMapboxGate(`That token was rejected by ${mapProviderLabel()} (401/403). Paste a valid public token.`);
    }
  });

  // (Re)build overlays on every style load — the initial load and after any
  // basemap switch (setStyle drops custom layers).
  map.on('style.load', () => {
    state.styleReady = true;
    setupOverlays(map);
    if (state.lsr) state.lsr.reapply();
    // Once the map is up, sweep every site for a recent scan so down radars show
    // red. Kicked off a single time (style.load also fires on basemap switches).
    if (!state._downScanStarted) {
      state._downScanStarted = true;
      scanDownRadars();
    }
  });
  map.on('moveend', () => scheduleModelCityValuesRender());
  map.on('zoomend', () => scheduleModelCityValuesRender());

  // Throttle the gate-sampling readout to one update per frame; sampleAt scans
  // every radial, so firing it on every raw mousemove event made panning while
  // hovering feel sticky.
  let readoutRaf = null;
  let lastLatLng = null;
  let lastPoint = null;
  map.on('mousemove', (e) => {
    lastLatLng = e.lngLat;
    lastPoint = e.point;
    // The cursor-following readout is the desktop inspector: only update it while
    // inspect is armed. (Touch layouts use the centre crosshair instead.)
    if (!state.inspect) return;
    if (readoutRaf) return;
    readoutRaf = requestAnimationFrame(() => {
      readoutRaf = null;
      updateReadout(lastLatLng, lastPoint);
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

  // Right-click anywhere to jump to the NEXRAD radar nearest that point. In
  // models mode a right-click instead opens a point sounding (setupSoundingGestures),
  // so skip the radar jump there — otherwise the map also zooms to the nearest
  // site, yanking the view away from where the sounding was requested.
  map.on('contextmenu', (e) => {
    if (state.mode === 'models') return;
    const r = nearestSite(e.lngLat.lat, e.lngLat.lng);
    if (!r) return;
    selectSite(r[0], r[1]);
    setStatus(`nearest radar: ${r[0]} — ${r[1]}`);
  });

  // Click / hover for the radar-site markers. Clicks belong to an armed
  // click-consuming tool (cross-section endpoints in particular land near
  // radar dots all the time) rather than switching sites.
  for (const siteLayer of ['sites', 'site-pills']) {
    map.on('click', siteLayer, (e) => {
      if (clickConsumingToolActive()) return;
      const f = e.features && e.features[0];
      if (f) selectSite(f.properties.icao, f.properties.name);
    });
  }
  for (const layer of ['sites', 'site-pills', 'alerts-fill', 'alerts-line']) {
    map.on('mouseenter', layer, () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', layer, () => (map.getCanvas().style.cursor = ''));
  }

  // Hover tooltip on the radar-site markers (the old bindTooltip equivalent).
  const siteTip = new mapboxgl.Popup({
    closeButton: false,
    closeOnClick: false,
    offset: 8,
    className: 'site-tip',
  });
  for (const siteLayer of ['sites', 'site-pills']) {
    map.on('mousemove', siteLayer, (e) => {
      const f = e.features && e.features[0];
      if (!f) return;
      siteTip.setLngLat(e.lngLat).setHTML(`${f.properties.icao} - ${f.properties.name}`).addTo(map);
    });
    map.on('mouseleave', siteLayer, () => siteTip.remove());
  }
}

// Swap the Mapbox basemap style. setStyle wipes custom layers, so the
// 'style.load' handler rebuilds and repopulates the overlays afterward.
function setBasemap(key) {
  if (!BASEMAPS[key] || !state.map) return;
  state.basemap = key;
  state.styleReady = false;
  const url = basemapStyleUrl(key);
  state.map.setStyle(url);
  if (state.splitView) state.splitView.setBasemap(url);
  saveSettings();
}

function setMapProvider(provider) {
  const next = provider === 'maptiler' ? 'maptiler' : 'mapbox';
  if (next === state.mapProvider) return;
  const token = getStoredMapToken(next);
  if (!token) {
    if (el.mapProviderSelect) el.mapProviderSelect.value = state.mapProvider;
    showMapboxGate(`Paste a ${mapProviderLabel(next)} public key to switch providers.`, next);
    return;
  }
  state.mapProvider = next;
  MAPBOX_TOKEN = token;
  // The GL library resolves mapbox:// style/tile URLs against the *global*
  // access token at request time, which still holds the old provider's key —
  // so switching (say) MapTiler → Mapbox 401'd every request until a full page
  // reload re-ran init with the right token. Swap the global token (and the
  // split-view context, whose panes are constructed with their own copy)
  // before restyling, and the switch takes effect immediately.
  mapboxgl.accessToken = token;
  try { localStorage.setItem(MAP_PROVIDER_KEY, next); } catch (_) {}
  if (el.mapProviderSelect) el.mapProviderSelect.value = next;
  if (state.splitView) state.splitView.setAccessToken(token);
  if (state.map) {
    state.styleReady = false;
    const url = basemapStyleUrl();
    state.map.setStyle(url);
    if (state.splitView) state.splitView.setBasemap(url);
  }
  saveSettings();
}

function applyUiTheme(theme = state.uiTheme) {
  state.uiTheme = theme === 'dark' ? 'dark' : 'light';
  document.body.classList.toggle('theme-dark', state.uiTheme === 'dark');
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', state.uiTheme === 'dark' ? '#0a0e13' : '#e9edf1');
  if (el.uiThemeSelect) el.uiThemeSelect.value = state.uiTheme;
  if (state.map) ensureSitePillImages(state.map);
  refreshSiteDots();
  if (state.map && state.map.getLayer && state.map.getLayer('sites')) {
    const c = selectedRadarColor();
    state.map.setPaintProperty('sites', 'circle-color', [
      'case',
      ['==', ['get', 'current'], 1], c,
      ['==', ['get', 'down'], 1], 'rgba(240,102,63,0.92)',
      ['==', ['get', 'tdwr'], 1], 'rgba(245,166,35,0.92)',
      'rgba(92,156,180,0.86)',
    ]);
    state.map.setPaintProperty('sites', 'circle-stroke-color', [
      'case',
      ['==', ['get', 'current'], 1], c,
      ['==', ['get', 'down'], 1], 'rgba(255,162,143,0.96)',
      ['==', ['get', 'tdwr'], 1], 'rgba(255,223,143,0.96)',
      'rgba(170,223,236,0.88)',
    ]);
  }
  if (typeof updateMobileTopBar === 'function') updateMobileTopBar();
}

function exportTheme() {
  if (state.uiTheme === 'dark') {
    return {
      mode: 'dark',
      bg: '#0a0e13',
      panel: '#111820',
      separator: 'rgba(255,255,255,0.12)',
      text: '#e8eef4',
      dim: '#93a1b0',
      faint: '#5f6d7b',
      accent: '#22d3ee',
      alertPanel: 'rgba(17,24,32,0.98)',
      alertSoft: 'rgba(255,255,255,0.06)',
    };
  }
  return {
    mode: 'light',
    bg: '#e9edf1',
    panel: '#ffffff',
    separator: 'rgba(15,23,32,0.12)',
    text: '#0f1720',
    dim: '#5b6876',
    faint: '#8190a0',
    accent: '#0b93b8',
    alertPanel: 'rgba(255,255,255,0.98)',
    alertSoft: 'rgba(15,23,32,0.055)',
  };
}

// Switch to a radar by ICAO, injecting it into the picker if it isn't a curated
// option (so right-click can reach any of the ~160 WSR-88D sites).
function selectSite(icao, name, recenter = false) {
  if (!el.siteSelect.querySelector(`option[value="${icao}"]`)) {
    const opt = document.createElement('option');
    opt.value = icao;
    opt.textContent = name ? `${icao} — ${name}` : icao;
    el.siteSelect.appendChild(opt);
  }
  el.siteSelect.value = icao;
  onSiteSwitch(icao, recenter);
}

// Shared housekeeping whenever the active radar changes (picker list, map dot,
// long-press or right-click). Loads the newest scan automatically. Only an
// explicit pick from the site *list* recenters/zooms onto the tower (recenter =
// true); switching via a map dot, right-click or long-press keeps the user's
// current location and zoom so the view doesn't jump out from under them.
function onSiteSwitch(icao, recenter = false) {
  if (state.playback && state.playback.active) state.playback.stop();
  state.site = icao;
  state._recenterRadar = recenter;
  state._forceLatest = true; // show the latest frame without needing LIVE
  // TDWR is Doppler-only: drop a dual-pol selection and rebuild the product row
  // so its dual-pol buttons disappear (and reappear when leaving a TDWR site).
  if (state.mode === 'radar') {
    // TDWR towers carry neither dual-pol nor the WSR-88D Level III products, so
    // fall back to reflectivity when switching to one with such a product active.
    if (isTDWR(icao) && (DUAL_POL.has(state.productId) || isL3Product(state.productId))) {
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
  const p = PRODUCTS[productId];
  if (!p) return []; // a Level III product has no Level II sweeps
  return state.sweeps.filter((sw) => sw.moments.includes(p.moment));
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
  const p = PRODUCTS[productId];
  if (!p) return null; // Level III products aren't drawn from Level II sweeps
  const list = sweeps.filter((sw) => sw.moments.includes(p.moment));
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
  if (isL3Product(state.productId)) return state.l3.decoded ? state.l3.decoded.sweep : null;
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
  // Picking from the list is the one path that recenters/zooms onto the tower.
  el.siteSelect.addEventListener('change', () => onSiteSwitch(el.siteSelect.value, true));
}

// In split view the product buttons drive whichever pane is selected. This
// returns the product id currently shown in that pane so the buttons highlight
// the right one.
function activeProductId() {
  const sv = state.splitView;
  if (sv && sv.active && sv.activePane > 1) {
    return sv.activeProductId ? sv.activeProductId() : sv.productId;
  }
  if (state.mode === 'satellite') return state.sat.productId;
  if (state.mode === 'mrms') return state.mrms.productId;
  if (state.mode === 'models') return state.models.productId;
  if (state.mode === 'observations') return state.observations.productId;
  if (state.mode === 'outlooks' && state.spc) return `${state.spc.product}${OUTLOOK_LAYER_SEP}${state.spc.detail}`;
  return state.productId;
}

// If the bottom UI is aimed at a comparison pane, route a product change there and
// skip the main-map path. Returns true when it handled the click.
function routeProductToPane(id) {
  const sv = state.splitView;
  if (!(sv && sv.active && sv.activePane > 1)) return false;
  document.querySelectorAll('.product-btn').forEach((b) => b.classList.toggle('active', b.dataset.id === id));
  sv.setProduct(id);
  buildLegend();
  renderModelCityValues();
  saveSettings();
  return true;
}

// The dual-polarization moments. TDWR terminal radars scan only to Doppler
// (REF/VEL/SW), so these products are hidden when a TDWR site is active.
const DUAL_POL = new Set(['RHO', 'ZDR', 'PHI', 'KDP']);

// Product ids offered for the current radar site — the full set, minus dual-pol
// for TDWR towers.
function availableProductOrder() {
  let level2 = PRODUCT_ORDER;
  // Archive volumes can predate super resolution and dual polarization. Once a
  // volume is decoded, offer only the Level II moments actually present (SRV
  // follows VEL through its shared moment) instead of leaving dead product
  // buttons that can never render for that scan.
  if (state.sweeps && state.sweeps.length &&
      String(state.volume && state.volume.icao || '').trim().toUpperCase() === state.site) {
    const moments = new Set(state.sweeps.flatMap((sw) => sw.moments || []));
    level2 = PRODUCT_ORDER.filter((id) => PRODUCTS[id] && moments.has(PRODUCTS[id].moment));
  }
  // TDWR terminal radars scan to Doppler only and don't carry the WSR-88D Level
  // III QPE/echo-top products, so they get neither dual-pol nor the L3 set.
  if (isTDWR(state.site)) return level2.filter((id) => !DUAL_POL.has(id));
  return [...level2, ...L3_ORDER];
}

// The product object for a radar product id — a Level II moment (PRODUCTS) or a
// Level III product (L3_PRODUCTS); both expose name/scale/unit/moment/disp*.
function radarProduct(id = state.productId) {
  return isL3Product(id) ? L3_PRODUCTS[id] : PRODUCTS[id];
}

// Single-site radar products, grouped into labelled, collapsible sections (the
// same UI the MRMS/model pickers use). Doppler base moments, the dual-pol
// fields, the Level III QPE accumulations and the derived grids each get their
// own section so the picker reads cleanly as the product set has grown.
const RADAR_CATEGORIES = [
  { id: 'doppler', name: 'Doppler', products: ['REF', 'VEL', 'SRV', 'SW'] },
  { id: 'dualpol', name: 'Dual Pol', products: ['RHO', 'ZDR', 'PHI', 'KDP'] },
  { id: 'precip', name: 'Precip Accumulation', products: ['PR1', 'PR3', 'PRT'] },
  { id: 'ffgx', name: 'FFG Exceedance', products: ['FFX1', 'FFX3'] },
  { id: 'derived', name: 'Derived Products', products: ['ET', 'VIL'] },
];
const radarCatOpen = {};

// One product button for the single-site picker, wired to switch products.
function makeRadarProductButton(id, active) {
  const p = radarProduct(id);
  const btn = document.createElement('button');
  btn.className = 'product-btn';
  btn.dataset.id = id;
  btn.innerHTML = `<span class="pb-id">${id.slice(0, 3)}</span><span class="pb-name">${p.name}</span>`;
  if (id === active) btn.classList.add('active');
  btn.addEventListener('click', () => {
    if (routeProductToPane(id)) return;
    ensureLiveForSwitch();
    const wasL3 = isL3Product(state.productId);
    cancelFrameWarm();
    state.productId = id;
    document
      .querySelectorAll('.product-btn')
      .forEach((b) => b.classList.toggle('active', b.dataset.id === id));
    // Reflect this product's custom palette (if any) in the .pal name label.
    el.palName.textContent = p.customPal ? `${p.customPal} → ${id}` : '';
    buildTiltList();
    buildLegend();
    updateMeta();
    // The legacy-resolution toggle is scoped per product, so refresh it to show
    // the newly selected product's setting.
    updateRadarResolutionUI();
    // Level III products and Level II moments come from different sources (a
    // per-product L3 file vs. the shared volume), so a switch across that
    // boundary — or between two L3 products — reloads the frame list; switching
    // between moments of the same volume just re-renders.
    if (isL3Product(id) || wasL3) loadVolumeList();
    else renderRadar();
    saveSettings();
  });
  return btn;
}

function buildProductButtons() {
  if (state.mode === 'satellite') return buildSatProductButtons();
  if (state.mode === 'mrms') return buildMrmsProductButtons();
  if (state.mode === 'models') return buildModelProductButtons();
  if (state.mode === 'observations') return buildObservationProductButtons();
  if (state.mode === 'outlooks') return buildOutlookProductButtons();
  el.productButtons.innerHTML = '';
  el.productButtons.className = 'product-stack';
  const avail = new Set(availableProductOrder());
  const active = activeProductId();
  for (const cat of RADAR_CATEGORIES) {
    const ids = cat.products.filter((id) => avail.has(id));
    if (!ids.length) continue; // e.g. TDWR sites carry neither dual-pol nor L3

    // Default-open the section holding the active product; otherwise honour the
    // user's remembered expand/collapse choice.
    const hasActive = ids.includes(active);
    const open = radarCatOpen[cat.id] != null ? !!radarCatOpen[cat.id] : hasActive;

    const section = document.createElement('div');
    section.className = 'product-cat-section' + (open ? '' : ' collapsed');

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'product-cat';
    head.innerHTML = `<span class="cat-caret">▾</span><span>${cat.name}</span>`;
    head.addEventListener('click', () => {
      radarCatOpen[cat.id] = section.classList.toggle('collapsed') === false;
    });
    section.appendChild(head);

    const grid = document.createElement('div');
    grid.className = 'product-grid';
    for (const id of ids) grid.appendChild(makeRadarProductButton(id, active));
    section.appendChild(grid);
    el.productButtons.appendChild(section);
  }
  buildCityValueProductControls();
}

function buildTiltList() {
  el.tiltList.innerHTML = '';
  // Level III products are pre-derived single grids — no elevation tilts.
  if (isL3Product(state.productId)) {
    el.tiltList.innerHTML = '<div class="empty">Single derived product — no tilts.</div>';
    return;
  }
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
  el.tiltList.querySelector('.tilt-btn.active')?.scrollIntoView({ block: 'nearest', inline: 'center' });
}

// Elevation / forecast-hour rows are deliberately one horizontal rail. Mouse
// wheels should move through that rail (not strand the higher tilts off-screen),
// while touch users retain native horizontal panning.
function enableHorizontalRailScroll(node) {
  if (!node || node.dataset.horizontalRail === '1') return;
  node.dataset.horizontalRail = '1';
  node.addEventListener('wheel', (event) => {
    if (!node.offsetParent || node.scrollWidth <= node.clientWidth) return;
    const delta = event.shiftKey ? event.deltaX : (Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX);
    if (!delta) return;
    node.scrollLeft += delta;
    event.preventDefault();
  }, { passive: false });
}

function buildVolumeList() {
  el.volumeList.innerHTML = '';
  if (!state.volumes.length) {
    el.volumeList.innerHTML = '<div class="empty">No scans found for this day.</div>';
    return;
  }
  const frag = document.createDocumentFragment();
  [...state.volumes].reverse().forEach((v) => {
    const btn = document.createElement('button');
    btn.className = 'vol-btn';
    btn.dataset.key = v.key;
    if (v.key === state.volumeKey) btn.classList.add('active');
    btn.innerHTML = `<span class="dot"></span>${scanFrameLabel(v)}`;
    btn.addEventListener('click', () => loadVolume(v.key));
    frag.appendChild(btn);
  });
  el.volumeList.appendChild(frag);
}

// Move the active highlight in the scan/scene list without rebuilding it.
// Rebuilding hundreds of buttons on every frame selection was a visible hitch
// when stepping frames with the arrow keys.
function markActiveVolume(key, rebuild = buildVolumeList) {
  if (!el.volumeList) return;
  let found = false;
  for (const b of el.volumeList.querySelectorAll('button.vol-btn')) {
    const active = b.dataset.key === key;
    b.classList.toggle('active', active);
    if (active) found = true;
  }
  // Key not in the rendered list (list stale or built for another day) — fall
  // back to a full rebuild so the UI can't silently show no selection.
  if (!found && key != null) rebuild();
}

function buildLegend() {
  el.legend.className = 'legend';
  if (state.mode === 'satellite') return buildSatLegend();
  if (state.mode === 'mrms') return buildMrmsLegend();
  if (state.mode === 'models') return buildModelLegend();
  if (state.mode === 'observations') return buildObservationLegend();
  if (state.mode === 'outlooks') return buildOutlookLegend();
  const p = radarProduct(state.productId);
  el.legend.innerHTML = legendHTML(p, p.scale);
  updateSplitPaneChrome();
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
  const labels = p.legendTicks || [tick(lo), tick((lo + hi) / 2), tick(hi)];
  const unitLabel = p.legendTicks ? '' : ` <span>(${u})</span>`;
  const labelRow = p.legendGroups
    ? `<div class="legend-groups">${labels.map((label) => `<span>${label}</span>`).join('')}</div>`
    : `<div class="legend-ticks"><span>${labels[0]}</span><span>${labels[1]}</span><span>${labels[2]}</span></div>`;
  return `
    <div class="legend-title">${p.name}${unitLabel}</div>
    <div class="legend-bar" style="background:linear-gradient(90deg,${colors.join(',')})"></div>
    ${labelRow}`;
}

// A small linear-gradient swatch sampled from a product's real color scale —
// reused by the sidebar's product-picker rows so each row's swatch is the
// same color scale the legend/radar layer actually draws with, not an
// invented color.
function swatchGradientCss(scale) {
  if (!scale || !scale.rgba) return '';
  const { rgba, steps } = scale;
  const segs = 4;
  const colors = [];
  for (let i = 0; i <= segs; i++) {
    let li = Math.round((i / segs) * (steps - 1));
    if (li >= steps) li = steps - 1;
    const o = li * 4;
    colors.push(`rgb(${rgba[o]},${rgba[o + 1]},${rgba[o + 2]})`);
  }
  return `linear-gradient(135deg,${colors.join(',')})`;
}

function splitPaneProduct(id) {
  if (state.mode === 'radar') return PRODUCTS[id];
  if (state.mode === 'mrms') return MRMS_PRODUCTS[id] && resolveGridProduct(MRMS_PRODUCTS[id]);
  if (state.mode === 'models') return MODEL_PRODUCTS[id] && resolveGridProduct(MODEL_PRODUCTS[id]);
  if (state.mode === 'observations') return OBS_PRODUCTS[id] && resolveGridProduct(OBS_PRODUCTS[id]);
  return null;
}

function splitPaneLegendHTML(id) {
  const p = splitPaneProduct(id);
  return p && p.scale ? legendHTML(p, p.scale) : '';
}

function updateSplitPaneChrome() {
  const sv = state.splitView;
  if (!sv) return;
  if (!sv.active) {
    if (sv.setPaneLegends) sv.setPaneLegends('', '', '', '');
    return;
  }
  const canCompareLegend = state.mode === 'radar' || state.mode === 'mrms' || state.mode === 'models' ||
    state.mode === 'observations';
  const products = sv.paneProducts
    ? sv.paneProducts()
    : [sv._mainProduct ? sv._mainProduct() : state.productId, sv.productId];
  sv.setPaneLegends(products.map((id) => (canCompareLegend ? splitPaneLegendHTML(id) : '')));
}

// ---------------------------------------------------------------------------
// Custom .pal color tables (GRLevelX / GR2Analyst format)
// ---------------------------------------------------------------------------
// Custom palettes are remembered across visits in localStorage, keyed by the
// radar product they apply to, so a loaded .pal survives a reload (storage may
// be unavailable in private mode — every access is guarded).
const PAL_STORE_KEY = 'aether.pals';

function productForColorTable(id) {
  if (PRODUCTS[id]) return PRODUCTS[id];
  if (MRMS_PRODUCTS[id]) return MRMS_PRODUCTS[id];
  if (MODEL_PRODUCTS[id]) return MODEL_PRODUCTS[id];
  return null;
}

function allColorTableProducts() {
  const rows = [];
  for (const id of PRODUCT_ORDER) if (PRODUCTS[id]) rows.push(['Radar', id, PRODUCTS[id]]);
  for (const id of MRMS_ORDER) if (MRMS_PRODUCTS[id]) rows.push(['MRMS', id, MRMS_PRODUCTS[id]]);
  for (const id of MODEL_ORDER) if (MODEL_PRODUCTS[id]) rows.push(['Model', id, MODEL_PRODUCTS[id]]);
  return rows;
}

function ensureDefaultColorTable(p) {
  if (!p || p._defaultColorTable) return;
  p._defaultColorTable = {
    scale: p.scale,
    lo: p.lo,
    hi: p.hi,
    range: p.range ? [...p.range] : null,
    unit: p.unit,
    dispUnit: p.dispUnit,
    dispFactor: p.dispFactor,
    dispOffset: p.dispOffset,
    floor: p.floor,
  };
}

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

// Velocity palettes mirror onto storm-relative velocity: SRV is derived from the
// same VEL moment, so loading a velocity color table recolours both.
const PAL_MIRRORS = { VEL: ['SRV'] };

// Apply a parsed palette to a single product's color scale (no UI side effects).
function applyPalToProduct(p, pal, name) {
  ensureDefaultColorTable(p);
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

// Apply a parsed palette to a target product, plus any mirrored products (e.g.
// a velocity table also recolours storm-relative velocity).
function applyPal(targetId, pal, name) {
  const p = PRODUCTS[targetId];
  if (!p) return;
  applyPalToProduct(p, pal, name);
  for (const mirrorId of PAL_MIRRORS[targetId] || []) {
    if (PRODUCTS[mirrorId]) applyPalToProduct(PRODUCTS[mirrorId], pal, name);
  }
}

function applyCustomColorTable(targetId, segments, name, units) {
  const p = productForColorTable(targetId);
  if (!p || !segments || segments.length < 2) return false;
  ensureDefaultColorTable(p);
  p.scale = makeScale(segments);
  if (p.range) p.range = [p.scale.lo, p.scale.hi];
  if ('lo' in p) p.lo = p.scale.lo;
  if ('hi' in p) p.hi = p.scale.hi;
  if (units) p.dispUnit = units;
  p.dispFactor = 1;
  p.dispOffset = 0;
  p.customPal = name;
  return true;
}

function repaintAfterColorTable(targetId) {
  if (state.mode === 'radar' && PRODUCTS[targetId]) {
    state.productId = targetId;
    document.querySelectorAll('.product-btn')
      .forEach((b) => b.classList.toggle('active', b.dataset.id === targetId));
    buildLegend();
    buildTiltList();
    renderRadar();
    updateMeta();
  } else if (state.mode === 'mrms') {
    buildMrmsLegend();
    if (state.mrms.grid) renderMrms();
  } else if (state.mode === 'models') {
    buildModelLegend();
    if (state.models.grid) renderModels();
  } else {
    buildLegend();
  }
  updateSplitPaneChrome();
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
      repaintAfterColorTable(targetId);
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
    if (!productForColorTable(id) || !entry) continue;
    try {
      if (entry.segments) applyCustomColorTable(id, entry.segments, entry.name, entry.units);
      else if (entry.text && PRODUCTS[id]) applyPal(id, parsePal(entry.text), entry.name);
    } catch (_) {
      /* skip a corrupt stored entry */
    }
  }
  const cur = PRODUCTS[state.productId];
  if (cur && cur.customPal) el.palName.textContent = `${cur.customPal} → ${state.productId}`;
}

function resetPalettes() {
  for (const [, , p] of allColorTableProducts()) {
    const d = p._defaultColorTable;
    if (d) {
      p.scale = d.scale;
      if (d.range) p.range = [...d.range];
      if ('lo' in p) p.lo = d.lo;
      if ('hi' in p) p.hi = d.hi;
      if ('floor' in p) p.floor = d.floor;
      p.unit = d.unit;
      p.dispUnit = d.dispUnit;
      p.dispFactor = d.dispFactor;
      p.dispOffset = d.dispOffset;
    } else if (PRODUCTS[p.id]) {
      p.scale = p.defaultScale;
      p.range = [p.scale.lo, p.scale.hi];
      p.unit = p.defaultUnit;
      p.dispUnit = p.defaultDispUnit;
      p.dispFactor = p.defaultDispFactor;
      p.dispOffset = p.defaultDispOffset;
    }
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

function currentColorTableTarget() {
  if (state.mode === 'mrms') return state.mrms.productId;
  if (state.mode === 'models') return state.models.productId;
  return state.productId;
}

function colorTableStopsFromProduct(p) {
  if (!p || !p.scale) return [
    { v: 0, c: '#000000' },
    { v: 50, c: '#00ffff' },
    { v: 100, c: '#ffffff' },
  ];
  const lo = Number.isFinite(p.lo) ? p.lo : p.scale.lo;
  const hi = Number.isFinite(p.hi) ? p.hi : p.scale.hi;
  const mid = lo + (hi - lo) / 2;
  const sample = (v) => {
    const { rgba, steps } = p.scale;
    const span = p.scale.hi - p.scale.lo || 1;
    let i = Math.round(((v - p.scale.lo) / span) * (steps - 1));
    if (i < 0) i = 0;
    else if (i >= steps) i = steps - 1;
    const o = i * 4;
    return `#${[rgba[o], rgba[o + 1], rgba[o + 2]].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
  };
  return [
    { v: lo, c: sample(lo) },
    { v: mid, c: sample(mid) },
    { v: hi, c: sample(hi) },
  ];
}

function renderPalCreatorStops(stops) {
  if (!el.palCreatorStops) return;
  el.palCreatorStops.innerHTML = '';
  stops.forEach((stop, i) => {
    const row = document.createElement('div');
    row.className = 'pal-stop-row';
    row.innerHTML = `
      <input type="number" step="any" value="${stop.v}">
      <input type="color" value="${stop.c}">
      <button class="pal-stop-remove" type="button" title="Remove stop">×</button>`;
    row.querySelector('.pal-stop-remove').addEventListener('click', () => {
      if (el.palCreatorStops.children.length <= 2) return;
      row.remove();
    });
    el.palCreatorStops.appendChild(row);
  });
}

function openPalCreator() {
  if (!el.palCreator || !el.palCreatorProduct) return;
  el.palCreatorProduct.innerHTML = '';
  for (const [group, id, p] of allColorTableProducts()) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = `${group}: ${id} — ${p.name}`;
    el.palCreatorProduct.appendChild(opt);
  }
  const target = currentColorTableTarget();
  if (productForColorTable(target)) el.palCreatorProduct.value = target;
  const p = productForColorTable(el.palCreatorProduct.value);
  if (el.palCreatorName) el.palCreatorName.value = p && p.customPal ? p.customPal : 'Custom table';
  renderPalCreatorStops(colorTableStopsFromProduct(p));
  el.palCreator.hidden = false;
}

function closePalCreator() {
  if (el.palCreator) el.palCreator.hidden = true;
}

function readCreatorSegments() {
  const rows = [...el.palCreatorStops.querySelectorAll('.pal-stop-row')];
  const segs = rows.map((row) => {
    const value = Number(row.querySelector('input[type="number"]').value);
    const hex = row.querySelector('input[type="color"]').value;
    const rgb = hex.replace('#', '').match(/.{2}/g).map((x) => parseInt(x, 16));
    return { v: value, c1: [rgb[0], rgb[1], rgb[2], 255], c2: null };
  }).filter((s) => Number.isFinite(s.v));
  segs.sort((a, b) => a.v - b.v);
  return segs;
}

function setupPaletteCreator() {
  if (!el.palCreate || !el.palCreator) return;
  el.palCreate.addEventListener('click', openPalCreator);
  if (el.palCreatorClose) el.palCreatorClose.addEventListener('click', closePalCreator);
  el.palCreator.addEventListener('click', (e) => {
    if (e.target === el.palCreator) closePalCreator();
  });
  if (el.palCreatorProduct) {
    el.palCreatorProduct.addEventListener('change', () => {
      const p = productForColorTable(el.palCreatorProduct.value);
      renderPalCreatorStops(colorTableStopsFromProduct(p));
    });
  }
  if (el.palAddStop) {
    el.palAddStop.addEventListener('click', () => {
      const rows = [...el.palCreatorStops.querySelectorAll('.pal-stop-row')];
      const vals = rows.map((row) => Number(row.querySelector('input[type="number"]').value)).filter(Number.isFinite);
      const next = vals.length ? vals[vals.length - 1] + 10 : 0;
      renderPalCreatorStops([...rows.map((row) => ({
        v: Number(row.querySelector('input[type="number"]').value),
        c: row.querySelector('input[type="color"]').value,
      })), { v: next, c: '#ffffff' }]);
    });
  }
  if (el.palSaveCustom) {
    el.palSaveCustom.addEventListener('click', () => {
      const targetId = el.palCreatorProduct.value;
      const p = productForColorTable(targetId);
      const segments = readCreatorSegments();
      if (!p || segments.length < 2) { setStatus('add at least two color stops'); return; }
      const name = (el.palCreatorName.value || 'Custom table').trim();
      if (!applyCustomColorTable(targetId, segments, name, p.unit)) return;
      const store = readPalStore();
      store[targetId] = { name, segments, units: p.unit };
      writePalStore(store);
      el.palName.textContent = `${name} → ${targetId}`;
      repaintAfterColorTable(targetId);
      closePalCreator();
      setStatus(`color table “${name}” saved for ${targetId}`);
    });
  }
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------
let loadChromeSeq = 0;

function beginLoadChrome(show = true) {
  const token = ++loadChromeSeq;
  el.progress.style.width = '0%';
  el.progress.classList.toggle('show', show);
  el.decoding.classList.remove('show');
  return token;
}

function ownsLoadChrome(token) {
  return token === loadChromeSeq;
}

function finishLoadChrome(token) {
  if (!ownsLoadChrome(token)) return;
  el.progress.classList.remove('show');
  el.decoding.classList.remove('show');
}

function cancelLoadChrome() {
  loadChromeSeq++;
  el.progress.classList.remove('show');
  el.decoding.classList.remove('show');
}

let volumeListSeq = 0;

async function loadVolumeList() {
  if (isL3Product(state.productId)) return loadL3List();
  const seq = ++volumeListSeq;
  const site = state.site;
  const requestMode = state.mode;
  const requestedDate = new Date(state.date);
  const requestedDay = requestedDate.getTime();
  const current = () => seq === volumeListSeq && state.mode === requestMode &&
    !isL3Product(state.productId) && state.site === site && state.date.getTime() === requestedDay;
  setStatus(`listing ${state.site}…`, true);
  buildVolumeList();
  try {
    let vols = await listVolumes(site, requestedDate);
    if (!current()) return;
    // If the selected UTC day has no scans (e.g. just after 00z when the current
    // day is still empty, or a quiet gap), fall back a day at a time until one
    // turns up, adopting that day. LIVE keeps resetting the date to "now", so the
    // view snaps forward to the current UTC day as soon as its first scan lands.
    if (!vols.length) {
      const probe = new Date(requestedDate);
      for (let i = 0; i < 7 && !vols.length; i++) {
        probe.setUTCDate(probe.getUTCDate() - 1);
        const back = await listVolumes(site, probe);
        if (!current()) return;
        if (back.length) {
          state.date = new Date(probe);
          el.dateInput.value = isoDate(state.date);
          vols = back;
          setStatus(`no scans for that day — showing ${isoDate(state.date)}`);
        }
      }
    }
    // A fallback intentionally changes `state.date`; any other context change
    // above already returned through `current()` before reaching this commit.
    if (seq !== volumeListSeq || state.mode !== requestMode || state.site !== site ||
        isL3Product(state.productId)) return;
    state.volumes = vols;
    buildVolumeList();
    setStatus(`${vols.length} scans available`);
    if (!vols.length) return;
    scheduleFrameWarm();
    const latest = vols[vols.length - 1].key;
    if (state._forceLatest || !state.volume || state.live) {
      state._forceLatest = false;
      if (latest !== state.volumeKey) loadVolume(latest);
    }
  } catch (e) {
    if (current()) setStatus(`list error: ${e.message}`);
    console.error(e);
  }
}

// List the Level III frames for the active product at this site/day (reusing the
// volume-list UI), then auto-load the latest, mirroring loadVolumeList for L2.
async function loadL3List() {
  const seq = ++volumeListSeq;
  const site = state.site;
  const requestMode = state.mode;
  const productId = state.productId;
  const requestedDate = new Date(state.date);
  const requestedDay = requestedDate.getTime();
  const current = () => seq === volumeListSeq && state.mode === requestMode &&
    state.site === site && state.productId === productId && state.date.getTime() === requestedDay;
  const prod = radarProduct(productId);
  setStatus(`listing ${state.site} ${prod.name}…`, true);
  buildVolumeList();
  try {
    let frames = await listLevel3(site, productId, requestedDate);
    if (!current()) return;
    if (!frames.length) {
      const probe = new Date(requestedDate);
      for (let i = 0; i < 7 && !frames.length; i++) {
        probe.setUTCDate(probe.getUTCDate() - 1);
        const back = await listLevel3(site, productId, probe);
        if (!current()) return;
        if (back.length) {
          state.date = new Date(probe);
          el.dateInput.value = isoDate(state.date);
          frames = back;
          setStatus(`no frames for that day — showing ${isoDate(state.date)}`);
        }
      }
    }
    if (seq !== volumeListSeq || state.mode !== requestMode || state.site !== site ||
        state.productId !== productId) return;
    state.volumes = frames;
    buildVolumeList();
    setStatus(`${frames.length} frames available`);
    if (!frames.length) { clearRadarSource(state.map); drawRings(null, 0); state.l3.decoded = null; return; }
    scheduleFrameWarm();
    // Load the newest frame on an explicit refresh, in LIVE, or whenever the
    // current key isn't in this list (a product switch leaves volumeKey on the
    // previous product's frame).
    const latest = frames[frames.length - 1].key;
    if (state._forceLatest || state.live || !frames.some((f) => f.key === state.volumeKey)) {
      state._forceLatest = false;
      loadVolume(latest);
    }
  } catch (e) {
    if (current()) setStatus(`list error: ${e.message}`);
    console.error(e);
  }
}

// Download + decode one Level III frame (through the small L3 LRU) and draw it
// as a single-tilt sweep. Frames are small, so neighbours are prefetched too —
// arrow-key stepping through L3 products stays instant like L2.
function getDecodedL3(key, onProgress) {
  const ck = `${state.productId}|${key}`;
  const hit = lruGet(l3Cache, ck);
  if (hit) return Promise.resolve(hit);
  const inflight = volumeInflight.get(ck);
  if (inflight) return inflight;
  const job = loadLevel3(state.site, state.productId, key, onProgress).then(({ decoded }) => {
    lruPut(l3Cache, ck, decoded, L3_CACHE_MAX);
    return decoded;
  });
  volumeInflight.set(ck, job);
  job.finally(() => volumeInflight.delete(ck)).catch(() => {});
  return job;
}

function prefetchAdjacentL3(key) {
  if (mqSmallScreen.matches) return;
  const i = state.volumes.findIndex((v) => v.key === key);
  if (i < 0) return;
  for (const j of [i - 1, i + 1]) {
    const v = state.volumes[j];
    if (!v || l3Cache.has(`${state.productId}|${v.key}`)) continue;
    getDecodedL3(v.key).catch(() => {});
  }
}

async function loadL3Frame(key) {
  state.volumeKey = key;
  markActiveVolume(key);
  const seq = ++volumeLoadSeq;
  const site = state.site;
  const productId = state.productId;
  const requestMode = state.mode;
  const current = () => seq === volumeLoadSeq && state.mode === requestMode &&
    state.site === site && state.productId === productId && state.volumeKey === key;
  const cached = l3Cache.has(`${productId}|${key}`);
  const chrome = beginLoadChrome(!cached);
  if (!cached) {
    setStatus('downloading…', true);
  }
  try {
    const decoded = await getDecodedL3(key, (p) => {
      if (current() && ownsLoadChrome(chrome)) el.progress.style.width = Math.round(p * 100) + '%';
    });
    if (!current()) return;
    state.l3.decoded = decoded;
    const site = { lat: decoded.lat, lon: decoded.lon };
    if (state._recenterRadar) {
      state.map.jumpTo({ center: [site.lon, site.lat], zoom: 8 });
      state._recenterRadar = false;
    }
    buildTiltList();
    updateMeta();
    displaySweep(decoded.sweep, site);
    setStatus(`loaded · ${decoded.sweep.radials.length} radials`);
    prefetchAdjacentL3(key);
  } catch (e) {
    if (current()) setStatus(`decode error: ${e.message}`);
    console.error(e);
  } finally {
    finishLoadChrome(chrome);
  }
}

let volumeLoadSeq = 0;
async function loadVolume(key) {
  if (isL3Product(state.productId)) return loadL3Frame(key);
  state.volumeKey = key;
  markActiveVolume(key);
  const seq = ++volumeLoadSeq;
  const site = state.site;
  const requestMode = state.mode;
  const current = () => seq === volumeLoadSeq && state.mode === requestMode &&
    state.site === site && state.volumeKey === key && !isL3Product(state.productId);
  // Cache hit → skip the download/decode chrome entirely (no progress bar or
  // status flicker), so arrow-key stepping through warmed scans is instant.
  const cached = peekDecodedVolume(key);
  const chrome = beginLoadChrome(!cached);
  if (!cached) {
    setStatus('downloading volume…', true);
  }
  try {
    const volume = cached || await getDecodedVolume(key, (p) => {
      if (!current() || !ownsLoadChrome(chrome)) return;
      el.progress.style.width = Math.round(p * 100) + '%';
      // Download finished → the decode worker owns the wait from here.
      if (p >= 1) { setStatus('decoding…', true); el.decoding.classList.add('show'); }
    });
    if (!current()) return; // a newer selection superseded this one
    state.volume = volume;
    state.sweeps = volume.sweeps;

    const availableMoments = new Set(volume.sweeps.flatMap((sw) => sw.moments || []));
    const selectedMoment = PRODUCTS[state.productId] && PRODUCTS[state.productId].moment;
    if (selectedMoment && !availableMoments.has(selectedMoment)) {
      const fallback = PRODUCT_ORDER.find((id) =>
        PRODUCTS[id] && availableMoments.has(PRODUCTS[id].moment)
      );
      if (fallback) state.productId = fallback;
    }
    // The product catalog is volume-aware: old Message-1 scans expose only
    // REF/VEL/SRV/SW, while modern scans restore the dual-pol products.
    buildProductButtons();
    buildLegend();

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
    // An open cross section tracks the live volume as new scans arrive.
    if (state.xsect) state.xsect.refresh();
    setStatus(`loaded · ${volume.radialCount} radials`);
    prefetchAdjacentVolumes(key);
  } catch (e) {
    if (current()) setStatus(`decode error: ${e.message}`);
    console.error(e);
  } finally {
    finishLoadChrome(chrome);
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
  if (isL3Product(state.productId)) {
    const d = state.l3.decoded;
    displaySweep(d ? d.sweep : null, d ? { lat: d.lat, lon: d.lon } : null);
    return;
  }
  displaySweep(currentSweep(), state.volume && state.volume.site);
}

// Resolve the sweep actually shown: apply velocity dealiasing when enabled and
// the velocity product is selected. Memoised in dealias.js, so this is cheap.
function resolveSweepForProduct(sweep, productId) {
  if (!sweep) return sweep;
  // SRV is derived from the (always-dealiased) velocity field — folded gates would
  // bias the mean-wind fit, so it's unfolded regardless of the VEL dealias toggle.
  if (productId === 'SRV') sweep = stormRelativeSweep(dealiasSweep(sweep));
  else if (state.dealias && productId === 'VEL') sweep = dealiasSweep(sweep);
  const product = PRODUCTS[productId];
  if (product && isLegacyResolution(productId)) sweep = legacyResolutionSweep(sweep, product.moment);
  return sweep;
}

// Whether the given radar product is set to render at legacy resolution.
function isLegacyResolution(productId = state.productId) {
  return !!state.radarLegacyProducts[productId];
}

function setLegacyResolution(productId, on) {
  if (on) state.radarLegacyProducts[productId] = true;
  else delete state.radarLegacyProducts[productId];
}

function resolveSweep(sweep) {
  return resolveSweepForProduct(sweep, state.productId);
}

// Resolve the sweep for an arbitrary radar product at the current elevation,
// applying velocity dealiasing for VEL. Used by the split-screen pane to draw a
// different moment from the same loaded volume.
function radarSweepFor(productId) {
  return resolveSweepForProduct(pickSweep(state.sweeps, productId), productId);
}

// Mirror the current view into the second split-screen pane (no-op when off).
function syncSplit() {
  if (state.splitView && state.splitView.active) {
    state.splitView.render();
    updateSplitPaneChrome();
  }
}

// Format a native physical value in the product's imperial display units.
function fmtValue(product, v) {
  if (typeof product.formatValue === 'function') return product.formatValue(v);
  const u = dispUnitOf(product);
  return `${dispValue(product, v).toFixed(unitDecimals(u))} ${u}`;
}

// Draw one sweep (from any volume) onto the map and remember it so the inspect
// readout and dock can reflect what is actually on screen.
function displaySweep(sweep, site) {
  const product = radarProduct(state.productId);
  sweep = resolveSweep(sweep);
  state.shownSweep = sweep;
  state.shownSite = site;

  const map = state.map;
  // Until the GL style has loaded its layers, just remember the sweep —
  // setupOverlays() repaints it once the style is ready.
  if (!map || !state.styleReady) {
    updateInspect();
    updateDock();
    return;
  }

  // While the layer stack owns the display, the main radar sweep doesn't draw —
  // its stand-in lives in the stack (see mainSourceSuppressed).
  if (state.mode === 'radar' && mainSourceSuppressed()) {
    clearRadarSource(map);
    drawRings(null, 0);
    updateInspect();
    renderLayerStack();
    syncSplit();
    updateDock();
    return;
  }

  // In satellite / MRMS / model modes the single-site radar only draws when the
  // overlay toggle is on; otherwise keep it (and its range rings) hidden.
  if (state.mode !== 'radar' && !state.radarOverlay) {
    clearRadarSource(map);
    drawRings(null, 0);
    renderModelCityValues();
    renderLayerStack();
    syncSplit();
    updateDock();
    return;
  }

  if (!sweep || !site || !product) {
    clearRadarSource(map);
    drawRings(null, 0);
    updateInspect();
    renderModelCityValues();
    renderLayerStack();
    syncSplit();
    updateDock();
    return;
  }

  const maxR = sweepMaxRange(sweep, product.moment) || 300000;
  setRadarSource(map, sweep, product, site);
  drawRings(site, maxR);
  updateInspect();
  renderModelCityValues();
  renderLayerStack();
  syncSplit();
  updateDock();
}

// Show or hide the single-site radar overlay in a non-radar mode. Draws the
// radar volume that's already loaded (the app loads one on startup); the left
// "Volume scans" list stays owned by the active source, so we don't refetch it
// here. If no radar has ever been loaded, prompt the user to visit RADAR once.
function applyRadarOverlay() {
  if (state.mode === 'radar') return;
  // The site dots follow the overlay: shown while it's on (so the drawn site
  // is identifiable — and switchable), hidden as soon as it's switched off.
  refreshSiteDots();
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
  if (el.obsFields) el.obsFields.hidden = state.mode !== 'observations';
  if (el.modelFields) el.modelFields.hidden = state.mode !== 'models';
  if (el.stormFields) {
    const sm = MODELS[state.models.modelKey];
    el.stormFields.hidden = state.mode !== 'models' || !(sm && sm.stormBased);
  }
  // With the layer stack on (desktop), the current product's own controls are
  // swapped out for the layer editor — hide the Product picker, tilt, forecast-
  // hour, outlook-detail and satellite-option panels, while Source, alerts,
  // cyclones and the rest stay put. (No effect on mobile, where the swipe sheet
  // keeps the product controls a swipe away regardless.)
  const hideProduct = layeringUiActive();
  if (el.productPanel) el.productPanel.hidden = hideProduct;
  el.tiltPanel.hidden = state.mode !== 'radar' || hideProduct;
  if (el.fhourPanel) el.fhourPanel.hidden = state.mode !== 'models' || hideProduct;
  // Outlook mode carries its day/product picker in a dedicated sidebar panel;
  // the generic scan list (volumePanel) has nothing to show, so swap them.
  if (el.outlookDetailPanel) el.outlookDetailPanel.hidden = state.mode !== 'outlooks' || hideProduct;
  if (el.volumePanel) el.volumePanel.hidden = state.mode === 'outlooks';
  el.satOptsPanel.hidden = state.mode !== 'satellite' || hideProduct;
  // Keep the dock tool slot in sync with the active source.
  if (state._refreshDockTools) state._refreshDockTools();
  if (el.dealiasField) el.dealiasField.hidden = state.mode !== 'radar';
  updateRadarResolutionUI();
  // The single-site radar overlay control only makes sense outside radar mode.
  if (el.radarOverlayField) el.radarOverlayField.hidden = state.mode === 'radar' || state.mode === 'outlooks';
  if (el.modelCityValuesField) el.modelCityValuesField.hidden = !GRID_CITY_VALUE_MODES.has(state.mode);
  // Model playback always spans the complete run. The generic 2–20 frame
  // control applies only to the scan-based sources and would be misleading.
  if (el.playFramesField) el.playFramesField.hidden = state.mode === 'models';
  buildCityValueProductControls();
  if (el.overlayOpacityField) el.overlayOpacityField.hidden = state.mode === 'outlooks';
  el.conusViewField.hidden = !(state.mode === 'satellite' && state.sat.sectorKey === 'conus');
  el.volumeTitle.textContent =
    state.mode === 'radar' ? 'Volume scans'
    : state.mode === 'satellite' ? 'Satellite scans'
    : state.mode === 'mrms' ? 'MRMS frames'
    : state.mode === 'models' ? 'Model runs'
    : state.mode === 'observations' ? 'RTMA frames' : 'Outlook detail';
  placeDesktopVolumePanel();
  document.querySelectorAll('.mode-btn')
    .forEach((b) => b.classList.toggle('active', b.dataset.mode === state.mode));
  // The forecast-sounding hint is intentionally never shown.
  if (el.soundingHint) el.soundingHint.hidden = true;
  // Radar is pinned live: swap its free LIVE button for the Archive-mode toggle.
  if (el.archiveField) el.archiveField.hidden = state.mode !== 'radar';
  if (el.liveBtn) el.liveBtn.hidden = state.mode === 'radar';
  if (el.archiveToggle) {
    el.archiveToggle.classList.toggle('active', state.radarArchive);
    el.archiveToggle.textContent = state.radarArchive ? 'ON' : 'OFF';
  }
  if (typeof updateDockSourceButton === 'function') updateDockSourceButton();
  // SPC Mesoanalysis sub-mode: cover the map with the static plot and swap the
  // RTMA controls for the product/sector pickers (no-op outside Obs mode).
  if (typeof applyMesoUi === 'function') applyMesoUi();
}

function setMode(mode) {
  if (state.mode === mode) return;
  if (state.playback && state.playback.active) state.playback.stop();
  cancelFrameWarm();
  // Progress/decoding chrome is shared by every source. Retire the previous
  // source's ownership immediately; any late finally block now becomes a no-op.
  cancelLoadChrome();
  const prevMode = state.mode;
  if (prevMode === 'outlooks' && mode !== 'outlooks') leaveOutlookSourceMode();
  state.mode = mode;
  // Do not let one visit to each data source accumulate several full decoded
  // grids/scenes. The browser HTTP cache still makes revisits quick; these are
  // only the large live JS objects and worker parser caches.
  if (prevMode === 'satellite' && mode !== 'satellite') {
    clearSceneCache();
    state.sat.scene = null;
    state.sat.displayMeta = null;
    state.sat._bbox = null;
  } else if (prevMode === 'mrms' && mode !== 'mrms') {
    state.mrms.grid = null;
  } else if (prevMode === 'models' && mode !== 'models') {
    state.models.grid = null;
    state.models.displayGrid = null;
    state.models.overlayData = null;
    packedGridMemo = { payload: null, grid: null };
  } else if (prevMode === 'observations' && mode !== 'observations') {
    state.observations.grid = null;
  }
  if (state.layers && !state.layers.enabled) state.layers.cache.clear();
  // Cross sections are radar-only; leaving radar mode closes an open section.
  if (mode !== 'radar' && state.xsect && state.xsect.active()) state.xsect.close();
  // Each source keeps its own smoothing level — restore this mode's.
  applySmooth(state.smoothByMode[mode] ?? 0);
  if (mode !== 'satellite') clearSatellite();
  if (mode !== 'mrms') clearMrms();
  if (mode !== 'models') clearModels();
  if (mode !== 'observations') clearObservations();
  if (mode === 'outlooks') { clearRadarSource(state.map); drawRings(null, 0); }
  else if (mode !== 'radar') applyRadarOverlay(); // hide radar unless its overlay is on
  if (!GRID_CITY_VALUE_MODES.has(mode)) clearModelCityValues();
  applyModePanels();
  refreshSiteDots(); // show the radar dots only in radar mode
  buildProductButtons();
  buildLegend();
  state._forceLatest = true;

  if (mode === 'radar') {
    // Radar is pinned live unless the user is in archive mode.
    if (!state.radarArchive) ensureLiveForSwitch();
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
  } else if (mode === 'observations') {
    if (state.meso.active) loadMesoImage();
    else loadObservationList();
  } else if (mode === 'outlooks') {
    enterOutlookSourceMode();
  }
  if (state.splitView) state.splitView.onModeChange();
  // Mobile: re-place the product/settings panels for the new source.
  if (mqSmallScreen.matches) layoutMobileSheet();
  updateMeta();
  saveSettings();
}

// Dispatch refresh / live / date changes to the active source.
function refreshActive() {
  if (state.live) syncDateToUtcToday();
  if (state.mode === 'radar') return loadVolumeList();
  if (state.mode === 'satellite') return loadSatScenes();
  if (state.mode === 'mrms') return loadMrmsList();
  if (state.mode === 'models') return loadModelList();
  if (state.mode === 'observations') return state.meso.active ? loadMesoImage(true) : loadObservationList();
  if (state.mode === 'outlooks') return refreshOutlookSource();
}

// ---------------------------------------------------------------------------
// Satellite (GOES ABI)
// ---------------------------------------------------------------------------
function satProviderName() {
  const sat = SATELLITES[state.sat.satKey];
  if (sat && sat.family === 'mirs') return 'MIRS';
  return sat && sat.family === 'himawari' ? 'Himawari' : 'GOES';
}

// The microwave (MIRS) "satellites" carry their own product set; keep
// state.sat.productId valid for whichever family is selected.
function normalizeSatProduct() {
  const mirs = isMirsSat(state.sat.satKey);
  if (mirs && !MIRS_PRODUCTS[state.sat.productId]) state.sat.productId = 'BT89';
  if (!mirs && MIRS_PRODUCTS[state.sat.productId]) state.sat.productId = 'C13';
}

function selectedConusView() {
  const idx = Math.max(0, Math.min(CONUS_VIEWS.length - 1, Number(state.sat.conusView) || 0));
  return CONUS_VIEWS[idx] || CONUS_VIEWS[0];
}

// True while a storm crop should drive the satellite view: a cyclone is
// selected and the full-disk sector (GOES 'full' / Himawari 'hfd') is active.
function cycloneCropActive() {
  return !!(state.sat.cyclone && (state.sat.sectorKey === 'full' || state.sat.sectorKey === 'hfd'));
}

// The lon/lat window a scene is cropped to before display: the selected
// cyclone's bbox on a full-disk scene, or the chosen CONUS regional view.
function satCropBBox() {
  if (cycloneCropActive()) return state.sat.cyclone.bbox;
  if (state.sat.sectorKey === 'conus' && state.sat.conusView) {
    const view = selectedConusView();
    return (view && view[1]) || null;
  }
  return null;
}

function satelliteCrop(scene) {
  if (!scene) return null;
  const box = satCropBBox();
  if (!box) return null;
  const [w, s, e, n] = box;
  let minC = Infinity, minR = Infinity, maxC = -Infinity, maxR = -Infinity;
  const take = (lat, lon) => {
    const p = lonLatToColRow(scene, lat, lon);
    if (!p) return;
    if (p.col < minC) minC = p.col;
    if (p.col > maxC) maxC = p.col;
    if (p.row < minR) minR = p.row;
    if (p.row > maxR) maxR = p.row;
  };
  for (let i = 0; i <= 12; i++) {
    const a = i / 12;
    take(s + (n - s) * a, w);
    take(s + (n - s) * a, e);
    take(s, w + (e - w) * a);
    take(n, w + (e - w) * a);
  }
  if (!Number.isFinite(minC) || !Number.isFinite(minR)) return null;
  const pad = 2;
  const x0 = Math.max(0, Math.floor(minC) - pad);
  const y0 = Math.max(0, Math.floor(minR) - pad);
  const x1 = Math.min(scene.width, Math.ceil(maxC) + pad);
  const y1 = Math.min(scene.height, Math.ceil(maxR) + pad);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0, bbox: [w, s, e, n] };
}

function croppedSatMeta(scene, crop) {
  const meta = satSceneMeta(scene);
  if (!crop) return meta;
  return {
    ...meta,
    width: crop.width,
    height: crop.height,
    xOffset: scene.xOffset + crop.x * scene.xScale,
    yOffset: scene.yOffset + crop.y * scene.yScale,
  };
}

function buildSatPayload(scene, productId = state.sat.productId) {
  const crop = satelliteCrop(scene);
  const rgba = buildRGBA(scene, productId, { enhanceIR: state.sat.enhanceIR, crop });
  const meta = croppedSatMeta(scene, crop);
  const bbox = crop && crop.bbox ? crop.bbox : sceneBBox(meta);
  return { meta, rgba, bbox, crop };
}

function buildSatPayloadForProduct(productId) {
  return state.sat.scene ? buildSatPayload(state.sat.scene, productId) : null;
}

function rebuildSectorSelect() {
  if (!el.sectorSelect) return;
  const sectors = sectorsForSatellite(state.sat.satKey);
  el.sectorSelect.innerHTML = '';
  for (const [key, sec] of Object.entries(sectors)) {
    const o = document.createElement('option');
    o.value = key; o.textContent = sec.label;
    if (!cycloneCropActive() && key === state.sat.sectorKey && !(key === 'conus' && state.sat.conusView)) o.selected = true;
    el.sectorSelect.appendChild(o);
  }
  if (sectors.conus) {
    const og = document.createElement('optgroup');
    og.label = 'CONUS regions';
    CONUS_VIEWS.forEach(([name], i) => {
      const o = document.createElement('option');
      o.value = `conusview:${i}`;
      o.textContent = name;
      if (!cycloneCropActive() && state.sat.sectorKey === 'conus' && state.sat.conusView === i) o.selected = true;
      og.appendChild(o);
    });
    el.sectorSelect.appendChild(og);
  }
  // Active tropical cyclones ride along as extra "sectors": picking one crops
  // the full-disk scan around the storm (and auto-switches to the satellite
  // that sees it best). The list refreshes whenever the cyclones feed does.
  const storms = state.cyclones ? state.cyclones.storms : [];
  if (storms.length) {
    const og = document.createElement('optgroup');
    og.label = 'Active cyclones';
    for (const storm of storms) {
      const o = document.createElement('option');
      o.value = `cyclone:${storm.id}`;
      o.textContent = `${storm.name} (${storm.basin})`;
      if (cycloneCropActive() && state.sat.cyclone.id === storm.id) o.selected = true;
      og.appendChild(o);
    }
    el.sectorSelect.appendChild(og);
  }
}

// ---------------------------------------------------------------------------
// Cyclone → satellite handoff. A storm is viewed as a crop of the full-disk
// scan (storm position ± a few degrees) from whichever satellite has the best
// view of its basin.
// ---------------------------------------------------------------------------
const CYCLONE_CROP_DLON = 5.5; // degrees either side of the storm centre
const CYCLONE_CROP_DLAT = 4.5;

function cycloneBBox(storm) {
  // Normalise into [-180, 180) so the GOES/Himawari inverse navigation (which
  // works on the offset from the sub-satellite longitude) behaves; the crop
  // walk and fitBounds both cope with edges past ±180.
  let lon = storm.lon;
  while (lon > 180) lon -= 360;
  while (lon < -180) lon += 360;
  const lat = Math.max(-65, Math.min(65, storm.lat));
  return [lon - CYCLONE_CROP_DLON, lat - CYCLONE_CROP_DLAT, lon + CYCLONE_CROP_DLON, lat + CYCLONE_CROP_DLAT];
}

// Which satellite sees a storm best: Atlantic → GOES-East; East/Central
// Pacific → GOES-West once the storm is west of ~100°W (near-coast EP storms
// still read fine from East); WP/IO/SH → Himawari.
function bestSatelliteFor(storm) {
  const basin = (storm.basin || '').toUpperCase();
  if (basin === 'WP' || basin === 'IO' || basin === 'SH') return 'himawari9';
  if ((basin === 'EP' || basin === 'CP') && storm.lon < -100) return 'goes18';
  return 'goes19';
}

// Point the satellite view at a storm: pick the satellite, force its full-disk
// sector, store the crop, and (re)load scenes. Works both from the storm's
// "View on satellite" card button (any mode) and the sector picker's cyclone
// options (already in satellite mode).
function viewCycloneOnSatellite(storm) {
  if (!storm) return;
  cancelFrameWarm();
  const satKey = bestSatelliteFor(storm);
  state.sat.satKey = satKey;
  if (el.satSelect) el.satSelect.value = satKey;
  state.sat.sectorKey = SATELLITES[satKey].family === 'himawari' ? 'hfd' : 'full';
  state.sat.cyclone = { id: storm.id, name: storm.name, lat: storm.lat, lon: storm.lon, bbox: cycloneBBox(storm) };
  rebuildSectorSelect();
  state.sat._centered = false;
  state.sat.scene = null; state.sat.sceneKey = null; state.sat.scenes = []; state.sat.displayMeta = null; state.sat._bbox = null;
  clearSatellite();
  setStatus(`satellite view: ${storm.name}`);
  if (state.mode !== 'satellite') {
    setMode('satellite'); // loads the scene list itself
  } else {
    applyModePanels();
    loadSatScenes();
  }
  saveSettings();
}

function initSatSelects() {
  for (const [key, sat] of Object.entries(SATELLITES)) {
    const o = document.createElement('option');
    o.value = key; o.textContent = sat.label;
    if (key === state.sat.satKey) o.selected = true;
    el.satSelect.appendChild(o);
  }
  rebuildSectorSelect();
  CONUS_VIEWS.forEach(([name], i) => {
    const o = document.createElement('option');
    o.value = String(i); o.textContent = name;
    if (i === state.sat.conusView) o.selected = true;
    el.conusViewSelect.appendChild(o);
  });

  el.satSelect.addEventListener('change', () => {
    cancelFrameWarm();
    state.sat.satKey = el.satSelect.value;
    state.sat.cyclone = null; // picking a satellite by hand leaves the storm crop
    const sectors = sectorsForSatellite(state.sat.satKey);
    if (!sectors[state.sat.sectorKey]) state.sat.sectorKey = Object.keys(sectors)[0];
    rebuildSectorSelect();
    // Crossing between the geostationary imagers and the microwave sounders
    // swaps the whole product set (and its legend).
    normalizeSatProduct();
    if (state.mode === 'satellite') { buildSatProductButtons(); buildSatLegend(); }
    state.sat._centered = false;
    state.sat.scene = null; state.sat.sceneKey = null; state.sat.scenes = []; state.sat.displayMeta = null; state.sat._bbox = null;
    state.sat.mirsGrid = null;
    clearSatellite();
    loadSatScenes();
    saveSettings();
  });
  el.sectorSelect.addEventListener('change', () => {
    // The "Active cyclones" optgroup routes through the storm handoff (which
    // may also switch satellites) instead of a plain sector change.
    if (el.sectorSelect.value.startsWith('cyclone:')) {
      const storm = state.cyclones
        && state.cyclones.stormById(el.sectorSelect.value.slice('cyclone:'.length));
      if (storm) viewCycloneOnSatellite(storm);
      else rebuildSectorSelect(); // storm gone since the list was built
      return;
    }
    if (el.sectorSelect.value.startsWith('conusview:')) {
      cancelFrameWarm();
      state.sat.sectorKey = 'conus';
      state.sat.conusView = Math.max(0, Math.min(CONUS_VIEWS.length - 1, Number(el.sectorSelect.value.slice('conusview:'.length)) || 0));
      if (el.conusViewSelect) el.conusViewSelect.value = String(state.sat.conusView);
      state.sat.cyclone = null;
      state.sat._centered = false;
      state.sat.scene = null; state.sat.sceneKey = null; state.sat.scenes = []; state.sat.displayMeta = null; state.sat._bbox = null;
      clearSatellite();
      applyModePanels();
      loadSatScenes();
      saveSettings();
      return;
    }
    cancelFrameWarm();
    state.sat.sectorKey = el.sectorSelect.value;
    state.sat.cyclone = null; // picking a real sector leaves the storm crop
    state.sat._centered = false;
    state.sat.scene = null; state.sat.sceneKey = null; state.sat.scenes = []; state.sat.displayMeta = null; state.sat._bbox = null;
    clearSatellite();
    applyModePanels();
    loadSatScenes();
    saveSettings();
  });
  el.conusViewSelect.addEventListener('change', () => {
    cancelFrameWarm();
    state.sat.conusView = +el.conusViewSelect.value || 0;
    rebuildSectorSelect();
    state.sat._bbox = null;
    const v = CONUS_VIEWS[+el.conusViewSelect.value];
    if (v && state.map) state.map.fitBounds([[v[1][0], v[1][1]], [v[1][2], v[1][3]]], { padding: 12, animate: true });
    if (state.mode === 'satellite' && state.sat.scene) renderSatellite();
    saveSettings();
    });
  el.irEnhanceToggle.addEventListener('click', () => {
    state.sat.enhanceIR = !state.sat.enhanceIR;
    el.irEnhanceToggle.classList.toggle('active', state.sat.enhanceIR);
    el.irEnhanceToggle.textContent = state.sat.enhanceIR ? 'ON' : 'OFF';
    if (state.mode === 'satellite') { renderSatellite(); buildSatLegend(); }
    saveSettings();
  });
}

let satProductSeq = 0;

function buildSatProductButtons() {
  el.productButtons.innerHTML = '';
  el.productButtons.className = 'product-grid';
  normalizeSatProduct();
  // Microwave (MIRS) products: retrieved fields + ATMS brightness temperatures.
  if (isMirsSat(state.sat.satKey)) {
    for (const id of MIRS_ORDER) {
      const p = MIRS_PRODUCTS[id];
      const btn = document.createElement('button');
      btn.className = 'product-btn';
      btn.dataset.id = id;
      btn.innerHTML = `<span class="pb-id">${id}</span><span class="pb-name">${p.name}</span>`;
      if (id === activeProductId()) btn.classList.add('active');
      btn.addEventListener('click', () => {
        if (routeProductToPane(id)) return;
        ensureLiveForSwitch();
        cancelFrameWarm();
        state.sat.productId = id;
        document.querySelectorAll('.product-btn').forEach((b) => b.classList.toggle('active', b.dataset.id === id));
        buildSatLegend();
        if (state.sat.sceneKey) loadSatScene(state.sat.sceneKey); // granule cached; only the field re-rasterises
        updateSatInfo();
        saveSettings();
      });
      el.productButtons.appendChild(btn);
    }
    return;
  }
  const add = (id, label, name) => {
    const btn = document.createElement('button');
    btn.className = 'product-btn';
    btn.dataset.id = id;
    btn.innerHTML = `<span class="pb-id">${label}</span><span class="pb-name">${name}</span>`;
    if (id === activeProductId()) btn.classList.add('active');
    btn.addEventListener('click', async () => {
      if (routeProductToPane(id)) return;
      ensureLiveForSwitch();
      cancelFrameWarm();
      const previousProductId = state.sat._renderedProductId || state.sat.productId;
      state.sat.productId = id;
      const seq = ++satProductSeq;
      const scene = state.sat.scene;
      const satKey = state.sat.satKey;
      const sectorKey = state.sat.sectorKey;
      const current = () => seq === satProductSeq && state.mode === 'satellite' &&
        state.sat.productId === id && state.sat.scene === scene &&
        state.sat.satKey === satKey && state.sat.sectorKey === sectorKey;
      document.querySelectorAll('.product-btn').forEach((b) => b.classList.toggle('active', b.dataset.id === id));
      buildSatLegend();
      updateSatInfo();
      saveSettings();
      // Decode any extra bands this product needs from the cached file first.
      if (scene) {
        setStatus(`rendering ${satProviderName()}…`, true);
        try {
          await ensureBandsAsync(scene, satKey, sectorKey, bandsFor(id));
          if (!current()) return;
          renderSatellite();
          setStatus(`${satProviderName()} ready`);
        } catch (error) {
          if (current()) {
            // Keep the controls/legend aligned with the pixels still on screen.
            // The previous successfully-rendered product already has its bands.
            state.sat.productId = previousProductId;
            document.querySelectorAll('.product-btn')
              .forEach((b) => b.classList.toggle('active', b.dataset.id === previousProductId));
            buildSatLegend();
            updateSatInfo();
            renderSatellite();
            saveSettings();
            setStatus(`${satProviderName()} ${id} error: ${error.message || error}`);
          }
          console.error(error);
        }
      }
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
  const frag = document.createDocumentFragment();
  [...state.sat.scenes].reverse().forEach((v) => {
    const btn = document.createElement('button');
    btn.className = 'vol-btn';
    btn.dataset.key = v.key;
    if (v.key === state.sat.sceneKey) btn.classList.add('active');
    btn.innerHTML = `<span class="dot"></span>${scanFrameLabel(v)}`;
    btn.addEventListener('click', () => loadSatScene(v.key));
    frag.appendChild(btn);
  });
  el.volumeList.appendChild(frag);
}

let satListSeq = 0;

async function loadSatScenes() {
  if (state.mode !== 'satellite') return;
  const seq = ++satListSeq;
  const satKey = state.sat.satKey;
  const sectorKey = state.sat.sectorKey;
  const requestLive = state.live;
  const requestedDay = state.date.getTime();
  const current = () => seq === satListSeq && state.mode === 'satellite' &&
    state.sat.satKey === satKey && state.sat.sectorKey === sectorKey &&
    state.live === requestLive && (requestLive || state.date.getTime() === requestedDay);
  setStatus(`listing ${satProviderName()}…`, true);
  buildSatList();
  try {
    const when = requestLive ? new Date() : new Date(state.date);
    const scenes = isMirsSat(satKey)
      ? await listMirsScenes(satKey, when)
      : await listScenes(satKey, sectorKey, when);
    if (!current()) return;
    state.sat.scenes = scenes;
    buildSatList();
    setStatus(`${scenes.length} ${satProviderName()} scenes`);
    if (!scenes.length) return;
    scheduleFrameWarm();
    const latest = scenes[scenes.length - 1].key;
    if (state._forceLatest || !state.sat.scene || state.live) {
      state._forceLatest = false;
      if (latest !== state.sat.sceneKey) loadSatScene(latest);
    }
  } catch (e) {
    if (current()) setStatus(`${satProviderName()} list error: ${e.message}`);
    console.error(e);
  }
}

let satLoadSeq = 0;
async function loadSatScene(key) {
  state.sat.sceneKey = key;
  markActiveVolume(key, buildSatList);
  const seq = ++satLoadSeq;
  const satKey = state.sat.satKey;
  const sectorKey = state.sat.sectorKey;
  const mirs = isMirsSat(satKey);
  const current = () => seq === satLoadSeq && state.mode === 'satellite' &&
    state.sat.sceneKey === key && state.sat.satKey === satKey && state.sat.sectorKey === sectorKey;
  const chrome = beginLoadChrome(true);
  setStatus(`downloading ${satProviderName()}…`, true);
  // Microwave swaths take their own decode path: NetCDF granule → rasterised
  // lat/lon grid, drawn through the shared GPU grid layer.
  if (mirs) {
    const productId = state.sat.productId;
    try {
      const grid = await loadMirsGrid(satKey, key, productId, (p) => {
        if (current() && state.sat.productId === productId && ownsLoadChrome(chrome))
          el.progress.style.width = Math.round(p * 100) + '%';
      });
      if (!current() || state.sat.productId !== productId) return;
      state.sat.mirsGrid = grid;
      state.sat.scene = null;
      state.sat.displayMeta = { width: grid.ni, height: grid.nj };
      state.sat._bbox = mirsGridBBox(grid);
      renderSatellite();
      updateSatInfo();
      setStatus(`${satProviderName()} ${grid.product.name} loaded`);
    } catch (e) {
      if (current() && state.sat.productId === productId) setStatus(`MIRS error: ${e.message}`);
      console.error(e);
    } finally {
      finishLoadChrome(chrome);
    }
    return;
  }
  try {
    const scene = await loadSceneAsync(satKey, sectorKey, key, bandsFor(state.sat.productId), (p) => {
      if (current() && ownsLoadChrome(chrome)) el.progress.style.width = Math.round(p * 100) + '%';
    });
    if (!current()) return; // a newer selection superseded this one
    // A product can change while the base scene is downloading. Ensure the
    // eventual scene carries whichever bands are current before committing it.
    for (;;) {
      const productId = state.sat.productId;
      await ensureBandsAsync(scene, satKey, sectorKey, bandsFor(productId));
      if (!current()) return;
      if (productId === state.sat.productId) break;
    }
    setStatus(`rendering ${satProviderName()}…`, true);
    if (ownsLoadChrome(chrome)) el.decoding.classList.add('show');
    state.sat.scene = scene;
    state.sat.displayMeta = null;
    state.sat._bbox = null;
    if (!state.sat._centered) {
      const bb = satCropBBox() || sceneBBox(scene);
      state.map.fitBounds([[bb[0], bb[1]], [bb[2], bb[3]]], { padding: 16, animate: false });
      state.sat._centered = true;
    }
    renderSatellite();
    updateSatInfo();
    setStatus(`${satProviderName()} ${SECTORS[state.sat.sectorKey].label} loaded`);
  } catch (e) {
    if (current()) setStatus(`${satProviderName()} error: ${e.message}`);
    console.error(e);
  } finally {
    finishLoadChrome(chrome);
  }
}

function setSatelliteSource(map) {
  if (!state.sat.layer) state.sat.layer = createSatelliteLayer();
  if (!map.getLayer(SATELLITE_LAYER_ID))
    map.addLayer(state.sat.layer, dataLayerAnchor(map));
}

function clearSatellite() {
  if (state.sat.layer) state.sat.layer.clear();
  if (state.sat.mirsLayer) state.sat.mirsLayer.clear();
  state.sat._renderedProductId = null;
}

// The microwave swath rides the same GPU grid layer family as MRMS, on its own
// layer id so it can coexist with the geostationary satellite layer object.
function setMirsSource(map) {
  if (!state.sat.mirsLayer) state.sat.mirsLayer = createGridLayer('sat-mirs');
  if (!map.getLayer('sat-mirs'))
    map.addLayer(state.sat.mirsLayer, dataLayerAnchor(map));
}

function drawMirsGrid(grid) {
  const map = state.map;
  if (!map || !state.styleReady) return;
  setMirsSource(map);
  state.sat.mirsLayer.setGrid(grid, resolveGridProduct(grid.product));
  state.sat.mirsLayer.setOpacity(state.opacity);
  state.sat.mirsLayer.setSmooth(state.smooth);
}

function drawMirsPayload(payload) {
  const map = state.map;
  if (!map || !state.styleReady) return;
  setMirsSource(map);
  state.sat.mirsLayer.showPrepared(payload);
  state.sat.mirsLayer.setOpacity(state.opacity);
  state.sat.mirsLayer.setSmooth(state.smooth);
}

function renderSatellite() {
  const map = state.map;
  if (!map || !state.styleReady) return;
  if (mainSourceSuppressed()) {
    clearSatellite();
    renderLayerStack();
    syncSplit();
    updateDock();
    return;
  }
  if (isMirsSat(state.sat.satKey)) {
    if (state.sat.layer) state.sat.layer.clear(); // leaving no stale GOES frame under the swath
    if (state.sat.mirsGrid) {
      drawMirsGrid(state.sat.mirsGrid);
      state.sat._renderedProductId = state.sat.productId;
    }
    else if (state.sat.mirsLayer) state.sat.mirsLayer.clear();
    renderLayerStack();
    syncSplit();
    updateDock();
    return;
  }
  if (state.sat.mirsLayer) state.sat.mirsLayer.clear();
  const scene = state.sat.scene;
  if (!scene) { clearSatellite(); return; }
  const payload = buildSatPayload(scene);
  state.sat.displayMeta = payload.meta;
  state.sat._bbox = payload.bbox;
  drawSatScene(payload.meta, payload.rgba, payload.bbox);
  state.sat._renderedProductId = state.sat.productId;
  renderLayerStack();
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
  if (isMirsSat(state.sat.satKey) && MIRS_PRODUCTS[id]) {
    const p = resolveGridProduct(MIRS_PRODUCTS[id]);
    el.legend.innerHTML = legendHTML(p, p.scale);
    return;
  }
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
  const t = (s.scene && s.scene.time) || (isMirsSat(s.satKey) && s.mirsGrid && s.mirsGrid.time);
  const grid = s.displayMeta || s.scene;
  el.satInfo.innerHTML = `
    <div class="meta-row"><span>Satellite</span><b>${sat.label}</b></div>
    <div class="meta-row"><span>Sector</span><b>${sec.label}</b></div>
    <div class="meta-row"><span>Grid</span><b>${grid ? grid.width + '×' + grid.height : '—'}</b></div>
    <div class="meta-row"><span>Scan time</span><b>${t ? p2(t.getUTCHours()) + ':' + p2(t.getUTCMinutes()) + 'Z' : '—'}</b></div>
    <div class="meta-row"><span>Refresh</span><b>${sec.refresh}</b></div>`;
}

// ---------------------------------------------------------------------------
// MRMS
// ---------------------------------------------------------------------------
// Remember which MRMS category sections the user has expanded, so a rebuild
// (mode switch, product pick) doesn't snap them all shut again. The section
// holding the active product opens by default; the rest start collapsed to keep
// the long catalogue compact.
const mrmsCatOpen = {};

function buildMrmsProductButtons() {
  el.productButtons.innerHTML = '';
  el.productButtons.className = 'product-stack';
  const active = activeProductId();
  for (const cat of MRMS_CATEGORIES) {
    const ids = cat.products.filter((id) => MRMS_PRODUCTS[id]);
    if (!ids.length) continue;

    // Default-open the section that contains the active product; otherwise honour
    // the user's remembered expand/collapse choice.
    const hasActive = ids.includes(active);
    const open = mrmsCatOpen[cat.id] != null ? !!mrmsCatOpen[cat.id] : hasActive;

    const section = document.createElement('div');
    section.className = 'product-cat-section' + (open ? '' : ' collapsed');

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'product-cat';
    head.innerHTML = `<span class="cat-caret">▾</span><span>${cat.name}</span>`;
    head.addEventListener('click', () => {
      const nowOpen = section.classList.toggle('collapsed') === false;
      mrmsCatOpen[cat.id] = nowOpen;
    });
    section.appendChild(head);

    const grid = document.createElement('div');
    grid.className = 'product-grid';
    for (const id of ids) {
      const p = MRMS_PRODUCTS[id];
      const btn = document.createElement('button');
      btn.className = 'product-btn';
      btn.dataset.id = id;
      btn.innerHTML = `<span class="pb-id">${id}</span><span class="pb-name">${p.name}</span>`;
      if (id === active) btn.classList.add('active');
      btn.addEventListener('click', () => {
        if (routeProductToPane(id)) return;
        ensureLiveForSwitch(); // load the new product's latest frame, stay live
        cancelFrameWarm();
        state.mrms.productId = id;
        document.querySelectorAll('.product-btn').forEach((b) => b.classList.toggle('active', b.dataset.id === id));
        buildMrmsLegend();
        loadMrmsList(); // each product is a different S3 folder
        saveSettings();
      });
      grid.appendChild(btn);
    }
    section.appendChild(grid);
    el.productButtons.appendChild(section);
  }
  buildCityValueProductControls();
}

function buildMrmsList() {
  el.volumeList.innerHTML = '';
  if (!state.mrms.frames.length) {
    el.volumeList.innerHTML = '<div class="empty">No frames found for this day.</div>';
    return;
  }
  const frag = document.createDocumentFragment();
  [...state.mrms.frames].reverse().forEach((v) => {
    const btn = document.createElement('button');
    btn.className = 'vol-btn';
    btn.dataset.key = v.key;
    if (v.key === state.mrms.frameKey) btn.classList.add('active');
    btn.innerHTML = `<span class="dot"></span>${scanFrameLabel(v)}`;
    btn.addEventListener('click', () => loadMrmsFrame(v.key));
    frag.appendChild(btn);
  });
  el.volumeList.appendChild(frag);
}

let mrmsListSeq = 0;

async function loadMrmsList() {
  if (state.mode !== 'mrms') return;
  const seq = ++mrmsListSeq;
  const productId = state.mrms.productId;
  const requestLive = state.live;
  const requestedDay = state.date.getTime();
  const current = () => seq === mrmsListSeq && state.mode === 'mrms' &&
    state.mrms.productId === productId && state.live === requestLive &&
    (requestLive || state.date.getTime() === requestedDay);
  setStatus('listing MRMS…', true);
  buildMrmsList();
  try {
    const when = requestLive ? new Date() : new Date(state.date);
    const frames = await listMrms(productId, when);
    if (!current()) return;
    state.mrms.frames = frames;
    buildMrmsList();
    setStatus(`${frames.length} MRMS frames`);
    if (!frames.length) return;
    scheduleFrameWarm();
    const latest = frames[frames.length - 1].key;
    if (state._forceLatest || !state.mrms.grid || state.live) {
      state._forceLatest = false;
      if (latest !== state.mrms.frameKey) loadMrmsFrame(latest);
    }
  } catch (e) {
    if (current()) setStatus(`MRMS list error: ${e.message}`);
    console.error(e);
  }
}

let mrmsLoadSeq = 0;
async function loadMrmsFrame(key) {
  state.mrms.frameKey = key;
  markActiveVolume(key, buildMrmsList);
  const seq = ++mrmsLoadSeq;
  const productId = state.mrms.productId;
  const current = () => seq === mrmsLoadSeq && state.mode === 'mrms' &&
    state.mrms.productId === productId && state.mrms.frameKey === key;
  const chrome = beginLoadChrome(true);
  setStatus('downloading MRMS…', true);
  try {
    let grid = await loadMrms(productId, key, (p) => {
      if (current() && ownsLoadChrome(chrome)) el.progress.style.width = Math.round(p * 100) + '%';
    });
    if (!current()) return; // a newer selection superseded this one
    setStatus('decoding MRMS…', true);
    if (ownsLoadChrome(chrome)) el.decoding.classList.add('show');
    grid = compactGridForConstrainedDevice(grid);
    state.mrms.grid = grid;
    renderMrms();
    setStatus(`MRMS ${grid.product.name} loaded`);
  } catch (e) {
    if (current()) setStatus(`MRMS error: ${e.message}`);
    console.error(e);
  } finally {
    finishLoadChrome(chrome);
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
  if (mainSourceSuppressed()) {
    clearMrms();
    clearModelCityValues();
    renderLayerStack();
    syncSplit();
    updateDock();
    return;
  }
  const grid = state.mrms.grid;
  if (!grid) { clearMrms(); return; }
  setMrmsSource(map);
  state.mrms.layer.setGrid(grid, resolveGridProduct(grid.product));
  state.mrms.layer.setOpacity(state.opacity);
  state.mrms.layer.setSmooth(state.smooth);
  renderModelCityValues();
  renderLayerStack();
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
  renderModelCityValues();
  renderLayerStack();
}

function buildMrmsLegend() {
  const p = resolveGridProduct(MRMS_PRODUCTS[state.mrms.productId]);
  el.legend.innerHTML = legendHTML(p, p.scale);
  updateSplitPaneChrome();
}

// ---------------------------------------------------------------------------
// Observations (RTMA)
// ---------------------------------------------------------------------------
const obsCatOpen = {};

function buildObservationProductButtons() {
  el.productButtons.innerHTML = '';
  el.productButtons.className = 'product-stack';
  const active = activeProductId();
  for (const cat of OBS_CATEGORIES) {
    const ids = cat.products.filter((id) => OBS_PRODUCTS[id]);
    if (!ids.length) continue;
    const hasActive = ids.includes(active);
    const open = obsCatOpen[cat.id] != null ? !!obsCatOpen[cat.id] : hasActive;

    const section = document.createElement('div');
    section.className = 'product-cat-section' + (open ? '' : ' collapsed');
    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'product-cat';
    head.innerHTML = `<span class="cat-caret">▾</span><span>${cat.name}</span>`;
    head.addEventListener('click', () => {
      obsCatOpen[cat.id] = section.classList.toggle('collapsed') === false;
    });
    section.appendChild(head);

    const grid = document.createElement('div');
    grid.className = 'product-grid';
    for (const id of ids) {
      const p = OBS_PRODUCTS[id];
      const btn = document.createElement('button');
      btn.className = 'product-btn';
      btn.dataset.id = id;
      btn.innerHTML = `<span class="pb-id">${id}</span><span class="pb-name">${p.name}</span>`;
      if (id === active) btn.classList.add('active');
      btn.addEventListener('click', () => {
        if (routeProductToPane(id)) return;
        ensureLiveForSwitch();
        cancelFrameWarm();
        state.observations.productId = id;
        document.querySelectorAll('.product-btn')
          .forEach((b) => b.classList.toggle('active', b.dataset.id === id));
        buildObservationLegend();
        loadObservationFrame(state.observations.frameKey);
        saveSettings();
      });
      grid.appendChild(btn);
    }
    section.appendChild(grid);
    el.productButtons.appendChild(section);
  }
  buildCityValueProductControls();
}

function buildObservationList() {
  el.volumeList.innerHTML = '';
  if (!state.observations.frames.length) {
    el.volumeList.innerHTML = '<div class="empty">No RTMA frames found for this day.</div>';
    return;
  }
  const frag = document.createDocumentFragment();
  [...state.observations.frames].reverse().forEach((v) => {
    const btn = document.createElement('button');
    btn.className = 'vol-btn';
    btn.dataset.key = v.key;
    if (v.key === state.observations.frameKey) btn.classList.add('active');
    btn.innerHTML = `<span class="dot"></span>${scanFrameLabel(v)}`;
    btn.addEventListener('click', () => loadObservationFrame(v.key));
    frag.appendChild(btn);
  });
  el.volumeList.appendChild(frag);
}

let observationListSeq = 0;

async function loadObservationList() {
  if (state.mode !== 'observations' || state.meso.active) return;
  const seq = ++observationListSeq;
  const requestLive = state.live;
  const requestedDay = state.date.getTime();
  const current = () => seq === observationListSeq && state.mode === 'observations' &&
    !state.meso.active && state.live === requestLive &&
    (requestLive || state.date.getTime() === requestedDay);
  setStatus('listing RTMA...', true);
  buildObservationList();
  try {
    const when = requestLive ? new Date() : new Date(state.date);
    const frames = await listObservations(when);
    if (!current()) return;
    state.observations.frames = frames;
    buildObservationList();
    setStatus(`${frames.length} RTMA frames`);
    if (!frames.length) return;
    scheduleFrameWarm();
    const latest = frames[frames.length - 1].key;
    if (state._forceLatest || !state.observations.grid || state.live) {
      state._forceLatest = false;
      loadObservationFrame(latest);
    }
  } catch (e) {
    if (current()) setStatus(`RTMA list error: ${e.message}`);
    console.error(e);
  }
}

let observationLoadSeq = 0;
async function loadObservationFrame(key) {
  if (!key) return;
  state.observations.frameKey = key;
  markActiveVolume(key, buildObservationList);
  const seq = ++observationLoadSeq;
  const productId = state.observations.productId;
  const product = OBS_PRODUCTS[productId];
  const current = () => seq === observationLoadSeq && state.mode === 'observations' &&
    !state.meso.active && state.observations.productId === productId &&
    state.observations.frameKey === key;
  const chrome = beginLoadChrome(true);
  setStatus(`downloading RTMA ${product ? product.name : ''}...`, true);
  try {
    const grid = await loadObservation(productId, key, (p) => {
      if (current() && ownsLoadChrome(chrome)) el.progress.style.width = Math.round(p * 100) + '%';
    });
    if (!current()) return;
    setStatus('decoding RTMA...', true);
    if (ownsLoadChrome(chrome)) el.decoding.classList.add('show');
    state.observations.grid = grid;
    renderObservations();
    setStatus(`RTMA ${grid.product.name} loaded`);
  } catch (e) {
    if (current()) setStatus(`RTMA error: ${e.message}`);
    console.error(e);
  } finally {
    finishLoadChrome(chrome);
  }
}

function setObservationSource(map) {
  if (!state.observations.layer) state.observations.layer = createGridLayer('observations');
  if (!map.getLayer('observations'))
    map.addLayer(state.observations.layer, dataLayerAnchor(map));
}

function clearObservations() {
  state.observations.displayGrid = null;
  if (state.observations.layer) state.observations.layer.clear();
  clearModelCityValues();
}

// ---------------------------------------------------------------------------
// SPC Mesoanalysis (static plots)
//
// SPC only publishes finished raster plots, so there is no grid to drape over
// the map. When a mesoanalysis product is active we cover the interactive map
// with the plain SPC GIF (#mesoView); product and sector pickers live in the
// sidebar (#mesoPanel). This lives inside Obs mode, chosen via the Analysis
// picker (RTMA 2.5 km  |  SPC Mesoanalysis).
// ---------------------------------------------------------------------------
function mesoActive() {
  return state.mode === 'observations' && state.meso.active;
}

function initMesoControls() {
  if (!el.mesoProductSelect) return;
  // Product picker: one <optgroup> per SPC section, in SPC's own order.
  el.mesoProductSelect.innerHTML = '';
  for (const cat of MESO_CATEGORIES) {
    const og = document.createElement('optgroup');
    og.label = cat.name;
    for (const [code, name] of cat.products) {
      const o = document.createElement('option');
      o.value = code;
      o.textContent = name;
      if (code === state.meso.code) o.selected = true;
      og.appendChild(o);
    }
    el.mesoProductSelect.appendChild(og);
  }
  // Sector picker.
  el.mesoSectorSelect.innerHTML = '';
  for (const s of MESO_SECTORS) {
    const o = document.createElement('option');
    o.value = s.id;
    o.textContent = s.name;
    if (s.id === state.meso.sector) o.selected = true;
    el.mesoSectorSelect.appendChild(o);
  }
  // Loop length (how many recent hourly frames playback cycles through).
  if (el.mesoFramesSelect) {
    el.mesoFramesSelect.innerHTML = '';
    for (const n of MESO_FRAME_COUNTS) {
      const o = document.createElement('option');
      o.value = String(n);
      o.textContent = `${n} frames`;
      if (n === state.meso.frameCount) o.selected = true;
      el.mesoFramesSelect.appendChild(o);
    }
    el.mesoFramesSelect.addEventListener('change', () => {
      state.meso.frameCount = Number(el.mesoFramesSelect.value) || MESO_DEFAULT_FRAMES;
      loadMesoImage();
      saveSettings();
    });
  }

  el.mesoProductSelect.addEventListener('change', () => {
    state.meso.code = el.mesoProductSelect.value;
    loadMesoImage();
    saveSettings();
  });
  el.mesoSectorSelect.addEventListener('change', () => {
    state.meso.sector = el.mesoSectorSelect.value;
    loadMesoImage();
    saveSettings();
  });
  if (el.mesoRefresh) el.mesoRefresh.addEventListener('click', () => loadMesoImage(true));
  if (el.mesoPrev) el.mesoPrev.addEventListener('click', () => stepMesoFrame(-1));
  if (el.mesoNext) el.mesoNext.addEventListener('click', () => stepMesoFrame(1));
  if (el.mesoPlay) el.mesoPlay.addEventListener('click', toggleMesoPlay);
  if (el.mesoScrub) el.mesoScrub.addEventListener('input', () => {
    stopMesoPlay();
    showMesoFrame(Number(el.mesoScrub.value), { smooth: true });
  });

  if (el.mesoImg) {
    el.mesoImg.addEventListener('load', () => {
      if (el.mesoLoading) el.mesoLoading.hidden = true;
      if (el.mesoError) el.mesoError.hidden = true;
      el.mesoImg.hidden = false;
    });
    el.mesoImg.addEventListener('error', () => {
      if (el.mesoLoading) el.mesoLoading.hidden = true;
      el.mesoImg.hidden = true;
      if (el.mesoError) el.mesoError.hidden = false;
    });
  }
}

// Rebuild the recent-frame list for the current product/sector and warm the
// browser cache so playback and scrubbing are smooth.
function rebuildMesoFrames() {
  state.meso.frames = mesoFrames(state.meso.frameCount);
  state.meso.frameIndex = state.meso.frames.length - 1; // newest
  if (el.mesoScrub) {
    el.mesoScrub.max = String(Math.max(0, state.meso.frames.length - 1));
    el.mesoScrub.value = String(state.meso.frameIndex);
  }
  const { sector, code, frames } = state.meso;
  // Keep the Image refs alive so the preloaded frames aren't garbage-collected.
  state.meso._preload = frames.map((f) => {
    const im = new Image();
    im.src = mesoFrameUrl(sector, code, f);
    return im;
  });
}

// Show one frame by index. `smooth` (playback/scrub/step) swaps the src in place
// without the loading flash; the default (product/sector change) shows loading.
function showMesoFrame(index, { smooth = false, bust = false } = {}) {
  const { sector, code, frames } = state.meso;
  if (!el.mesoImg || !frames.length) return;
  index = Math.max(0, Math.min(frames.length - 1, index));
  state.meso.frameIndex = index;
  const frame = frames[index];
  const url = mesoFrameUrl(sector, code, frame, bust ? Date.now() : false);
  if (el.mesoViewTitle) el.mesoViewTitle.textContent = `${mesoProductName(code)} — ${mesoSectorName(sector)}`;
  if (el.mesoTime) el.mesoTime.textContent = frame.label;
  if (el.mesoOpen) el.mesoOpen.href = mesoFrameUrl(sector, code, frame);
  if (el.mesoScrub && el.mesoScrub.value !== String(index)) el.mesoScrub.value = String(index);
  if (el.mesoError) el.mesoError.hidden = true;
  if (!smooth) {
    if (el.mesoLoading) el.mesoLoading.hidden = false;
    el.mesoImg.hidden = true;
  }
  el.mesoImg.src = url;
}

function stepMesoFrame(dir) {
  if (!state.meso.frames.length) return false;
  stopMesoPlay();
  let i = state.meso.frameIndex + (dir > 0 ? 1 : -1);
  if (i < 0) i = state.meso.frames.length - 1;
  if (i >= state.meso.frames.length) i = 0;
  showMesoFrame(i, { smooth: true });
  return true;
}

function updateMesoPlayBtn() {
  if (!el.mesoPlay) return;
  el.mesoPlay.classList.toggle('active', state.meso.playing);
  el.mesoPlay.innerHTML = `<i data-lucide="${state.meso.playing ? 'pause' : 'play'}" class="lucide sm" aria-hidden="true"></i>`;
  el.mesoPlay.title = state.meso.playing ? 'Pause loop' : 'Play loop';
  refreshIcons();
}

function startMesoPlay() {
  if (state.meso.playing || state.meso.frames.length < 2) return;
  state.meso.playing = true;
  updateMesoPlayBtn();
  state.meso._timer = setInterval(() => {
    let i = state.meso.frameIndex + 1;
    if (i >= state.meso.frames.length) i = 0;
    showMesoFrame(i, { smooth: true });
  }, 500);
}

function stopMesoPlay() {
  if (state.meso._timer) { clearInterval(state.meso._timer); state.meso._timer = null; }
  if (state.meso.playing) { state.meso.playing = false; updateMesoPlayBtn(); }
}

function toggleMesoPlay() {
  state.meso.playing ? stopMesoPlay() : startMesoPlay();
}

// (Re)load the current product/sector: rebuild the frame list and show the
// latest. `force` busts the cache so a manual refresh / live tick re-fetches.
function loadMesoImage(force) {
  if (!el.mesoImg) return;
  stopMesoPlay();
  rebuildMesoFrames();
  showMesoFrame(state.meso.frameIndex, { bust: force });
}

// Reflect the current mesoanalysis state onto the DOM: show/hide the static
// image view + sidebar panel, and suppress the map-side panels it replaces.
function applyMesoUi() {
  const active = mesoActive();
  const app = document.querySelector('.app');
  if (app) app.classList.toggle('meso-active', active);
  if (el.mesoPanel) el.mesoPanel.hidden = !active;
  if (el.mesoView) el.mesoView.hidden = !active;
  if (!active) { stopMesoPlay(); return; }
  // The static plot stands in for the map, so the RTMA product grid, scan-frame
  // list, opacity and city-value controls have nothing to act on — hide them.
  if (el.productPanel) el.productPanel.hidden = true;
  if (el.volumePanel) el.volumePanel.hidden = true;
  if (el.overlayOpacityField) el.overlayOpacityField.hidden = true;
  if (el.playFramesField) el.playFramesField.hidden = true;
  if (el.modelCityValuesField) el.modelCityValuesField.hidden = true;
  // On mobile the dock rides above the plot; reserve exactly its height at the
  // bottom of the view so the image never hides behind it.
  if (app && app.classList.contains('mobile') && el.mobileDock) {
    const h = el.mobileDock.offsetHeight;
    if (h) app.style.setProperty('--meso-dock-gap', `${h + 8}px`);
  }
}

// Enter/leave the mesoanalysis sub-mode (driven by the Analysis picker). On
// enter we drop the RTMA overlay and show the static plot; on leave we restore
// the normal RTMA-overlay observation flow.
function setMesoActive(active) {
  active = !!active;
  if (state.meso.active === active) { applyMesoUi(); return; }
  state.meso.active = active;
  if (active) {
    clearObservations();
    if (state.playback && state.playback.active) state.playback.stop();
    applyMesoUi();
    loadMesoImage();
  } else {
    applyMesoUi();
    // Rebuild the RTMA product controls / legend and reload the grid list.
    applyModePanels();
    buildProductButtons();
    buildLegend();
    state._forceLatest = true;
    loadObservationList();
  }
  saveSettings();
}

function observationGridForReadouts() {
  return (state.playback && state.playback.active && state.observations.displayGrid) ||
    state.observations.grid;
}

function renderObservations() {
  // SPC Mesoanalysis draws its own static plot over the map — no grid to paint.
  if (state.meso.active) { clearObservations(); return; }
  const map = state.map;
  if (!map || !state.styleReady) return;
  if (mainSourceSuppressed()) {
    clearObservations();
    renderLayerStack();
    syncSplit();
    updateDock();
    return;
  }
  const grid = state.observations.grid;
  if (!grid) { clearObservations(); return; }
  state.observations.displayGrid = grid;
  setObservationSource(map);
  state.observations.layer.setGrid(grid, resolveGridProduct(grid.product));
  state.observations.layer.setOpacity(state.opacity);
  state.observations.layer.setSmooth(state.smooth);
  renderModelCityValues();
  renderLayerStack();
  syncSplit();
  updateDock();
}

function drawObservationPayload(payload) {
  const map = state.map;
  if (!map || !state.styleReady) return;
  // Loop frames carry packed codes only; decode the displayed frame's readout
  // grid from them (memoised per payload) instead of pinning a full Float32
  // grid on every cached frame.
  const grid = payload && (payload.grid || gridFromPackedPayload(payload));
  if (grid) state.observations.displayGrid = grid;
  setObservationSource(map);
  state.observations.layer.showPrepared(payload);
  state.observations.layer.setOpacity(state.opacity);
  state.observations.layer.setSmooth(state.smooth);
  renderModelCityValues();
  renderLayerStack();
}

function buildObservationLegend() {
  const p = resolveGridProduct(OBS_PRODUCTS[activeProductId()] || OBS_PRODUCTS[state.observations.productId]);
  el.legend.innerHTML = legendHTML(p, p.scale);
  updateSplitPaneChrome();
}

function sampleObservationAt(lat, lon) {
  const grid = observationGridForReadouts();
  if (!grid) return null;
  const p = resolveGridProduct(grid.product);
  const v = sampleGridRaw(grid, lat, lon);
  if (v == null) return { out: true };
  if (Number.isNaN(v) || !(v >= p.floor)) return { main: 'no data', sub: p.id };
  return { main: fmtValue(p, v), sub: `RTMA ${p.id}` };
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
  // Wire up the optional model-data CORS proxy (localStorage `modelDataProxy`)
  // before anything probes a source that opts into it via `corsRestricted`.
  setModelProxy(localStorage.getItem('modelDataProxy') || '');
  el.modelSelect.innerHTML = '';
  // Group the long model list: deterministic first, then ensembles, then the
  // storm-following hurricane models.
  const MODEL_GROUPS = [
    ['Deterministic', (m) => !m.group && !m.stormBased],
    ['Ensembles', (m) => m.group === 'ensemble'],
    ['Hurricane (storm-based)', (m) => m.stormBased],
  ];
  for (const [label, match] of MODEL_GROUPS) {
    const og = document.createElement('optgroup');
    og.label = label;
    for (const [key, m] of Object.entries(MODELS)) {
      if (!match(m)) continue;
      const o = document.createElement('option');
      o.value = key; o.textContent = m.label;
      if (key === state.models.modelKey) o.selected = true;
      og.appendChild(o);
    }
    if (og.children.length) el.modelSelect.appendChild(og);
  }
  el.modelSelect.addEventListener('change', () => {
    state.models.modelKey = el.modelSelect.value;
    // Switch to a supported product if this model can't supply the current one.
    if (!modelSupports(state.models.modelKey, state.models.productId))
      state.models.productId = defaultProductFor(state.models.modelKey);
    // Keep comparison panes valid too (they share the selected model).
    if (state.splitView && state.splitView.active) {
      const paneProducts = state.splitView.paneProducts ? state.splitView.paneProducts().slice(1) : [state.splitView.productId];
      if (paneProducts.some((id) => !modelSupports(state.models.modelKey, id))) state.splitView.onModeChange();
    }
    state._forceLatest = true;
    buildModelProductButtons();
    buildModelLegend();
    buildStormList(); // show/hide + clear the storm picker for the new model
    saveSettings();
    loadModelList();
  });

  if (el.stormSelect) {
    el.stormSelect.addEventListener('change', () => {
      cancelFrameWarm();
      state.models.stormId = el.stormSelect.value;
      const run = currentModelRun();
      if (run) {
        stampModelStorm(run);
        // Keep the forecast hour valid for the newly-selected storm's run length.
        const fhrs = forecastHours(run);
        if (!fhrs.includes(state.models.fhour)) {
          const below = fhrs.filter((f) => f <= state.models.fhour);
          state.models.fhour = below.length ? below[below.length - 1] : fhrs[0];
        }
      }
      state._forceLatest = true; // a different storm is a different field entirely
      buildFhourList();
      saveSettings();
      loadModelFrame();
    });
  }
}

// Basin suffix on an ATCF storm id (04e, 09w, 10l, …) → a short region label.
const STORM_BASINS = { l: 'Atlantic', e: 'E Pac', c: 'C Pac', w: 'W Pac', a: 'N Ind', b: 'N Ind', s: 'S Ind', p: 'S Pac' };
function stormLabel(id) {
  const basin = STORM_BASINS[id.slice(-1)];
  return basin ? `${id.toUpperCase()} · ${basin}` : id.toUpperCase();
}

// Pick the selected storm within a storm-based run (falling back to the first
// active storm), and stamp the run with that storm's id + forecast-hour range so
// the fhour picker, playback and split-view (which all read the shared run object)
// follow it. A no-op for fixed-domain models (runs carry no `storms`).
function stampModelStorm(run) {
  if (!run || !run.storms || !run.storms.length) return run;
  const storm = run.storms.find((s) => s.id === state.models.stormId) || run.storms[0];
  state.models.stormId = storm.id;
  run.storm = storm.id;
  run.fhours = storm.fhours;
  run.maxFhour = storm.fhours[storm.fhours.length - 1] || 0;
  return run;
}

// Populate the storm picker from the current run's active storms, and toggle its
// visibility (storm-based models only, in models mode).
function buildStormList() {
  if (!el.stormSelect) return;
  const model = MODELS[state.models.modelKey];
  const stormBased = !!(model && model.stormBased);
  if (el.stormFields) el.stormFields.hidden = state.mode !== 'models' || !stormBased;
  if (!stormBased) return;
  const run = currentModelRun();
  const storms = (run && run.storms) || [];
  el.stormSelect.innerHTML = '';
  if (!storms.length) {
    const o = document.createElement('option');
    o.value = ''; o.textContent = 'No active storms';
    el.stormSelect.appendChild(o);
    return;
  }
  for (const s of storms) {
    const o = document.createElement('option');
    o.value = s.id; o.textContent = stormLabel(s.id);
    if (s.id === state.models.stormId) o.selected = true;
    el.stormSelect.appendChild(o);
  }
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
        ensureLiveForSwitch();
        cancelFrameWarm();
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
  buildCityValueProductControls();
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
    btn.innerHTML = `<span class="dot"></span>${fmtDate(r.time, false)} · ${r.label} run`;
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
  const frag = document.createDocumentFragment();
  for (const f of forecastHours(run)) {
    const btn = document.createElement('button');
    btn.className = 'tilt-btn';
    btn.dataset.fhour = String(f);
    if (f === state.models.fhour) btn.classList.add('active');
    btn.textContent = 'F' + p2(f);
    btn.addEventListener('click', () => selectFhour(f));
    frag.appendChild(btn);
  }
  el.fhourList.appendChild(frag);
  el.fhourList.querySelector('.tilt-btn.active')?.scrollIntoView({ block: 'nearest', inline: 'center' });
}

function selectFhour(f) {
  state.models.fhour = f;
  // Re-highlight in place; rebuilding a 200-hour list per arrow-key step was a
  // visible hitch on global runs.
  let found = false;
  for (const b of el.fhourList.querySelectorAll('button.tilt-btn')) {
    const active = Number(b.dataset.fhour) === f;
    b.classList.toggle('active', active);
    if (active) found = true;
  }
  if (!found) buildFhourList();
  else el.fhourList.querySelector('.tilt-btn.active')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  loadModelFrame();
}

let modelListSeq = 0;

async function loadModelList() {
  if (state.mode !== 'models') return;
  const seq = ++modelListSeq;
  const modelKey = state.models.modelKey;
  const productId = state.models.productId;
  const requestLive = state.live;
  const requestedDay = state.date.getTime();
  const name = modelKey.toUpperCase() || 'model';
  const current = () => seq === modelListSeq && state.mode === 'models' &&
    state.models.modelKey === modelKey && state.models.productId === productId &&
    state.live === requestLive && (requestLive || state.date.getTime() === requestedDay);
  setStatus(`listing ${modelName()}…`, true);
  buildModelList();
  try {
    const when = requestLive ? new Date() : new Date(state.date);
    const runs = await listModels(modelKey, productId, when);
    if (!current()) return;
    state.models.runs = runs;
    buildModelList();
    setStatus(`${runs.length} model runs`);
    if (!runs.length) {
      // A CORS-restricted source with no proxy configured lists nothing — say
      // why instead of leaving a bare "0 model runs".
      const m = MODELS[modelKey];
      if (m && m.corsNote && !localStorage.getItem('modelDataProxy')) setStatus(m.corsNote);
      return;
    }
    const latest = runs[runs.length - 1].key;
    // LIVE must not trap the user on the newest cycle: a 60 s auto-refresh used
    // to force-select `latest` here, snapping back any older run the user had
    // picked (and re-downloading the same frame). Follow new cycles only when
    // the user is (or was) on the latest one; otherwise honor their selection.
    const prevLatest = state.models._latestRunKey;
    state.models._latestRunKey = latest;
    const followingLatest = !state.models.runKey ||
      state.models.runKey === latest || state.models.runKey === prevLatest;
    if (state._forceLatest || !state.models.grid || !currentModelRun() ||
        (state.live && followingLatest && state.models.runKey !== latest)) {
      state._forceLatest = false;
      selectModelRun(latest);
    } else {
      // Honoring the user's older run: re-stamp its storm (a live cycle may have
      // gained forecast hours since the last listing) and refresh the pickers.
      const run = currentModelRun();
      if (run) stampModelStorm(run);
      buildModelList();
      buildStormList();
      buildFhourList();
    }
  } catch (e) {
    if (current()) setStatus(`${name} list error: ${e.message}`);
    console.error(e);
  }
}

function selectModelRun(key) {
  state.models.runKey = key;
  const run = currentModelRun();
  // Keep the chosen forecast hour if the new run offers it; otherwise snap down
  // to the nearest available hour (runs may step non-hourly, e.g. NAM/GFS). For
  // storm-based models the run's hours depend on the selected storm, so stamp it
  // first (picks the storm and sets run.fhours/maxFhour).
  if (run) {
    stampModelStorm(run);
    const fhrs = forecastHours(run);
    if (!fhrs.includes(state.models.fhour)) {
      const below = fhrs.filter((f) => f <= state.models.fhour);
      state.models.fhour = below.length ? below[below.length - 1] : fhrs[0];
    }
  }
  buildModelList();
  buildStormList();
  buildFhourList();
  // If a loop is running, switch it over to the newly-selected run's frames
  // immediately (rather than leaving the old run playing until playback closes).
  if (state.playback && state.playback.active) state.playback.restart();
  else loadModelFrame();
}

// Load the currently-selected run + forecast hour.
let modelLoadSeq = 0;
async function loadModelFrame() {
  const run = currentModelRun();
  if (!run) return;
  const fhour = state.models.fhour;
  const seq = ++modelLoadSeq;
  const modelKey = state.models.modelKey;
  const productId = state.models.productId;
  const runKey = state.models.runKey;
  const stormId = state.models.stormId;
  // Storm selection mutates the live run object; snapshot the request so a
  // later storm click cannot redirect this in-flight load to different files.
  const requestRun = {
    ...run,
    fhours: Array.isArray(run.fhours) ? [...run.fhours] : run.fhours,
    storm: run.storm,
  };
  const name = modelKey.toUpperCase() || 'model';
  const current = () => seq === modelLoadSeq && state.mode === 'models' &&
    state.models.modelKey === modelKey && state.models.productId === productId &&
    state.models.runKey === runKey && state.models.stormId === stormId &&
    state.models.fhour === fhour;
  const chrome = beginLoadChrome(true);
  setStatus(`downloading ${modelName()}…`, true);
  try {
    let grid = await loadModel(modelKey, productId, requestRun, fhour, (p) => {
      // A superseded load keeps downloading in the background — don't let its
      // progress fight the current one's bar.
      if (current() && ownsLoadChrome(chrome)) el.progress.style.width = Math.round(p * 100) + '%';
    });
    // Bail if a newer selection superseded this one, or the user has since left
    // models mode (e.g. a model loop stopped *because* the mode/source changed —
    // its idle() reload must not paint a model layer over the new source).
    if (!current()) return;
    setStatus(`decoding ${modelName()}…`, true);
    if (ownsLoadChrome(chrome)) el.decoding.classList.add('show');
    grid = compactGridForConstrainedDevice(grid);
    grid._overlayData = prepareModelOverlayData(grid);
    state.models.grid = grid;
    state.models.overlayData = grid._overlayData;
    renderModels();
    setStatus(`${modelName()} ${run.label} F${p2(fhour)} · ${grid.product.name}`);
  } catch (e) {
    if (current()) {
      // A 403/404 on the index usually means the run is listed (its F00 is up)
      // but this forecast hour hasn't posted yet — say that instead of "error".
      const stillPosting = /index fetch failed: (403|404)/.test(e.message || '');
      setStatus(stillPosting
        ? `${modelName()} ${run.label} F${p2(fhour)} not posted yet — run still uploading`
        : `${modelName()} error: ${e.message}`);
    }
    console.error(e);
  } finally {
    finishLoadChrome(chrome);
  }
}

function setModelSource(map) {
  if (!state.models.layer) state.models.layer = createGridLayer('models');
  if (!map.getLayer('models'))
    map.addLayer(state.models.layer, dataLayerAnchor(map));
}

function clearModels() {
  state.models.displayGrid = null;
  state.models.overlayData = null;
  if (state.models.layer) state.models.layer.clear();
  if (state.map && state.styleReady) clearModelOverlays(state.map);
  clearModelCityValues();
}

// Font choices for the city readouts. 'default' keeps the original bold look;
// the rest reuse the basemap glyph stacks offered for town labels.
const CITY_READOUT_FONTS = {
  default: { label: 'Open Sans Bold (default)', stack: ['Open Sans Bold', 'Arial Unicode MS Bold'] },
  ...Object.fromEntries(Object.entries(TOWN_FONTS)
    .filter(([, v]) => v.stack)
    .map(([k, v]) => [k, { label: v.label, stack: v.stack }])),
};

function cityReadoutFontStack() {
  const f = CITY_READOUT_FONTS[state.cityReadout.font] || CITY_READOUT_FONTS.default;
  return f.stack;
}

// Zoom curve for the readout text, anchored so the user-chosen size applies at
// zoom 12 and scales down at lower zooms (matches the original 16/20/24 curve).
function cityReadoutTextSize() {
  const s = state.cityReadout.size || 24;
  return ['interpolate', ['linear'], ['zoom'],
    4, Math.round(s * (16 / 24)), 8, Math.round(s * (20 / 24)), 12, s];
}

function setupModelCityValueLayer(map) {
  if (!map.getSource(MODEL_CITY_VALUE_SOURCE))
    map.addSource(MODEL_CITY_VALUE_SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  if (!map.getLayer(MODEL_CITY_VALUE_LAYER)) {
    map.addLayer({
      id: MODEL_CITY_VALUE_LAYER,
      type: 'symbol',
      source: MODEL_CITY_VALUE_SOURCE,
      minzoom: 4,
      layout: {
        visibility: 'none',
        'text-field': ['get', 'label'],
        'text-font': cityReadoutFontStack(),
        'text-size': cityReadoutTextSize(),
        'text-offset': [0, -1.2],
        'text-anchor': 'bottom',
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: {
        'text-color': state.cityReadout.color || '#ffffff',
        'text-halo-color': 'rgba(4,10,18,0.92)',
        'text-halo-width': 2.4,
      },
    });
  }
}

// Re-apply the user's readout font/size/color to every pane's live city-value
// layer (the main map and any split panes).
function applyCityReadoutStyle() {
  for (const { map } of cityValueEntries()) {
    if (!map || !map.getLayer || !map.getLayer(MODEL_CITY_VALUE_LAYER)) continue;
    try {
      map.setLayoutProperty(MODEL_CITY_VALUE_LAYER, 'text-font', cityReadoutFontStack());
      map.setLayoutProperty(MODEL_CITY_VALUE_LAYER, 'text-size', cityReadoutTextSize());
      map.setPaintProperty(MODEL_CITY_VALUE_LAYER, 'text-color', state.cityReadout.color || '#ffffff');
    } catch (_) { /* style mid-reload — the next setup pass reapplies */ }
  }
}

function cityValueKey(mode, productId) {
  return `${mode}:${productId || ''}`;
}

function cityValueDefault(mode) {
  return mode === 'models' || mode === 'observations';
}

function cityValueEnabledFor(mode, productId) {
  if (!state.modelCityValues || !GRID_CITY_VALUE_MODES.has(mode) || !productId) return false;
  const key = cityValueKey(mode, productId);
  if (typeof state.cityValuesProducts[key] === 'boolean') return state.cityValuesProducts[key];
  return cityValueDefault(mode);
}

function cityValueProductsForMode(mode = state.mode) {
  if (mode === 'radar') {
    return availableProductOrder()
      .map((id) => [id, radarProduct(id)])
      .filter(([, p]) => p);
  }
  if (mode === 'mrms') return MRMS_ORDER.map((id) => [id, MRMS_PRODUCTS[id]]).filter(([, p]) => p);
  if (mode === 'models') {
    return MODEL_ORDER
      .filter((id) => MODEL_PRODUCTS[id] && modelSupports(state.models.modelKey, id))
      .map((id) => [id, MODEL_PRODUCTS[id]]);
  }
  if (mode === 'observations') return OBS_CATEGORIES.flatMap((c) => c.products).map((id) => [id, OBS_PRODUCTS[id]]).filter(([, p]) => p);
  return [];
}

function buildCityValueProductControls() {
  if (!el.cityValuesProducts) return;
  const products = cityValueProductsForMode();
  const show = GRID_CITY_VALUE_MODES.has(state.mode) && state.modelCityValues && products.length;
  el.cityValuesProducts.hidden = !show;
  if (el.cityReadoutStyle) el.cityReadoutStyle.hidden = !show;
  el.cityValuesProducts.innerHTML = '';
  if (!show) return;
  for (const [id, product] of products) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.title = `${product.name} city readouts`;
    btn.textContent = id;
    btn.classList.toggle('active', cityValueEnabledFor(state.mode, id));
    btn.addEventListener('click', () => {
      const key = cityValueKey(state.mode, id);
      state.cityValuesProducts[key] = !cityValueEnabledFor(state.mode, id);
      buildCityValueProductControls();
      renderModelCityValues();
      saveSettings();
    });
    el.cityValuesProducts.appendChild(btn);
  }
}

function modelGridForReadouts() {
  if (state.mode === 'observations') return observationGridForReadouts();
  return (state.playback && state.playback.active && state.models.displayGrid) || state.models.grid;
}

function sampleGridRaw(grid, lat, lon) {
  // (lon1, lat1) is the center of cell (0,0) — round to the nearest center so
  // readouts match the raster exactly (same half-cell offset as the shader).
  const i = Math.round((lon - grid.lon1) / grid.di);
  const j = Math.round((grid.lat1 - lat) / grid.dj);
  if (i < 0 || i >= grid.ni || j < 0 || j >= grid.nj) return undefined;
  return grid.values[j * grid.ni + i];
}

function placeLabelLayers(map) {
  const layers = (map.getStyle() && map.getStyle().layers) || [];
  return layers
    .filter((ly) => {
      if (ly.type !== 'symbol' || !ly.layout || !ly.layout['text-field']) return false;
      if (ly.id === MODEL_CITY_VALUE_LAYER) return false;
      if (map.getLayoutProperty && map.getLayoutProperty(ly.id, 'visibility') === 'none') return false;
      const sl = String(ly['source-layer'] || '').toLowerCase();
      const id = String(ly.id || '').toLowerCase();
      const place = /(^|[_-])(place|settlement|city|town|village|hamlet)([_-]|$)/.test(sl) ||
        /(^|[_-])(place|settlement|city|town|village|hamlet)([_-]|$)/.test(id) ||
        sl === 'place' || sl === 'place_label' || sl === 'settlement';
      const nonCity = /road|shield|highway|airport|aeroway|poi|transit|station|water|marine/.test(sl) ||
        /road|shield|highway|airport|aeroway|poi|transit|station|water|marine/.test(id);
      return place && !nonCity;
    })
    .map((ly) => ly.id);
}

function visibleTownPoints(map) {
  const layers = placeLabelLayers(map);
  if (!layers.length) return [];
  let rendered = [];
  try {
    rendered = map.queryRenderedFeatures({ layers });
  } catch (_) {
    return [];
  }
  const seen = new Set();
  const out = [];
  for (const f of rendered) {
    const coords = f && f.geometry && f.geometry.type === 'Point' && f.geometry.coordinates;
    if (!coords || coords.length < 2) continue;
    const p = f.properties || {};
    const name = p.name_en || p.name || p.name_script || '';
    const lon = Number(coords[0]);
    const lat = Number(coords[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const key = `${name}:${lon.toFixed(3)}:${lat.toFixed(3)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, lat, lon });
  }
  return out;
}

function cityValueEntries() {
  const out = [{ pane: 1, map: state.map }];
  const sv = state.splitView;
  if (sv && sv.active && sv._mapForPane) {
    for (let pane = 2; pane <= (sv.paneCount || 1); pane++) {
      const map = sv._mapForPane(pane);
      if (map) out.push({ pane, map });
    }
  }
  return out.filter((x) => x.map);
}

function cityProductForPane(pane) {
  if (pane > 1 && state.splitView && state.splitView.productForPane)
    return state.splitView.productForPane(pane);
  if (state.mode === 'radar') return state.productId;
  if (state.mode === 'mrms') return state.mrms.productId;
  if (state.mode === 'models') return state.models.productId;
  if (state.mode === 'observations') return state.observations.productId;
  return null;
}

function cityValueGeoJSON(map, pane) {
  const features = [];
  for (const { name, lat, lon } of visibleTownPoints(map)) {
    const r = sampleActive(lat, lon, pane);
    if (!r || r.out || !r.main) continue;
    features.push({
      type: 'Feature',
      properties: { name, label: String(r.main) },
      geometry: { type: 'Point', coordinates: [lon, lat] },
    });
  }
  return { type: 'FeatureCollection', features };
}

function clearModelCityValues(map = null) {
  const maps = map ? [map] : cityValueEntries().map((x) => x.map);
  for (const m of maps) clearModelCityValuesOnMap(m);
}

function clearModelCityValuesOnMap(map) {
  if (!map || !map.getSource || !map.getSource(MODEL_CITY_VALUE_SOURCE)) return;
  map.getSource(MODEL_CITY_VALUE_SOURCE).setData({ type: 'FeatureCollection', features: [] });
  if (map.getLayer(MODEL_CITY_VALUE_LAYER))
    map.setLayoutProperty(MODEL_CITY_VALUE_LAYER, 'visibility', 'none');
}

function scheduleModelCityValuesRender() {
  const map = state.map;
  if (!map || state._modelCityValuesScheduled) return;
  state._modelCityValuesScheduled = true;
  let done = false;
  let timer = null;
  const run = () => {
    if (done) return;
    done = true;
    if (timer) clearTimeout(timer);
    state._modelCityValuesScheduled = false;
    requestAnimationFrame(() => renderModelCityValues());
  };
  timer = setTimeout(run, 700);
  if (map.once) map.once('idle', run);
}

function renderModelCityValues() {
  if (!state.styleReady) return;
  for (const { pane, map } of cityValueEntries()) {
    if (!map || !map.getStyle) continue;
    setupModelCityValueLayer(map);
    const productId = cityProductForPane(pane);
    if (!cityValueEnabledFor(state.mode, productId)) {
      clearModelCityValuesOnMap(map);
      continue;
    }
    map.getSource(MODEL_CITY_VALUE_SOURCE).setData(cityValueGeoJSON(map, pane));
    map.setLayoutProperty(MODEL_CITY_VALUE_LAYER, 'visibility', 'visible');
  }
}

function layerId() {
  state.layers.seq = (state.layers.seq || 1) + 1;
  return `user-${Date.now().toString(36)}-${state.layers.seq.toString(36)}`;
}

function layerProductOptions(source, layer = null) {
  if (source === 'radar') {
    return availableProductOrder().map((id) => ({ value: id, label: `${id} - ${radarProduct(id).name}` }));
  }
  if (source === 'satellite') {
    const channels = SAT_CHANNELS.map((c) => ({ value: 'C' + p2(c.band), label: `C${p2(c.band)} - ${c.name}` }));
    const rgbs = SAT_RGB_ORDER.map((id) => ({ value: 'RGB_' + id, label: `${SAT_RGB[id].short} - ${SAT_RGB[id].name}` }));
    return [...channels, ...rgbs];
  }
  if (source === 'mrms') {
    return MRMS_ORDER.filter((id) => MRMS_PRODUCTS[id]).map((id) => ({ value: id, label: `${id} - ${MRMS_PRODUCTS[id].name}` }));
  }
  if (source === 'models') {
    // A layer draws whatever model it's pinned to (layer.modelKey), independent of
    // the main view's model, so its product menu must reflect that model's fields.
    const modelKey = (layer && layer.modelKey) || state.models.modelKey;
    return MODEL_ORDER
      .filter((id) => MODEL_PRODUCTS[id] && modelSupports(modelKey, id))
      .map((id) => ({ value: id, label: `${id} - ${MODEL_PRODUCTS[id].name}` }));
  }
  if (source === 'observations') {
    return OBS_CATEGORIES.flatMap((c) => c.products)
      .filter((id) => OBS_PRODUCTS[id])
      .map((id) => ({ value: id, label: `${id} - ${OBS_PRODUCTS[id].name}` }));
  }
  if (source === 'outlooks') {
    return OUTLOOK_ORDER.flatMap((productId) => {
      const product = OUTLOOKS[productId];
      return product.details.map((d) => ({
        value: outlookValue(productId, d.id),
        label: `${product.label} - ${d.label}`,
        productId,
        detailId: d.id,
      }));
    });
  }
  return [];
}

function defaultLayerSource() {
  return LAYER_STACK_SOURCES.includes(state.mode) ? state.mode : 'radar';
}

function defaultLayerProduct(source) {
  if (source === 'radar') return state.productId;
  if (source === 'satellite') return state.sat.productId;
  if (source === 'mrms') return state.mrms.productId;
  if (source === 'models') return state.models.productId;
  if (source === 'observations') return state.observations.productId;
  if (source === 'outlooks') return state.spc ? outlookValue(state.spc.product, state.spc.detail) : outlookValue('spc_conv', OUTLOOKS.spc_conv.details[0].id);
  return (layerProductOptions(source)[0] || {}).value || '';
}

// The active view's radar site (ICAO), used as the default for a new radar layer.
function activeSiteIcao() {
  return (state.volume && state.volume.icao) || state.site || 'KTLX';
}

// Fill in a layer's source-specific selectors (site / satellite+sector / model)
// from the current view when they're not already set, so a freshly-added or
// source-switched layer starts on something sensible.
function ensureLayerTargets(layer) {
  if (layer.source === 'radar' && !layer.siteId) layer.siteId = activeSiteIcao();
  if (layer.source === 'satellite') {
    // The extra-layer stack draws geostationary scenes only — a microwave
    // (MIRS) key here (or as the fallback) is replaced with GOES-East.
    if (!layer.satKey || !SATELLITES[layer.satKey] || isMirsSat(layer.satKey))
      layer.satKey = isMirsSat(state.sat.satKey) ? 'goes19' : state.sat.satKey;
    const sectors = sectorsForSatellite(layer.satKey);
    if (!layer.sectorKey || !sectors[layer.sectorKey]) {
      layer.sectorKey = sectors[state.sat.sectorKey] ? state.sat.sectorKey : Object.keys(sectors)[0];
    }
  }
  if (layer.source === 'models' && (!layer.modelKey || !MODELS[layer.modelKey])) {
    layer.modelKey = state.models.modelKey;
  }
}

function normalizeLayerProduct(layer, value = null) {
  ensureLayerTargets(layer);
  const options = layerProductOptions(layer.source, layer);
  const chosen = value || layer.productId || (options[0] && options[0].value) || '';
  const opt = options.find((o) => o.value === chosen) || options[0];
  if (!opt) return;
  if (layer.source === 'outlooks') {
    const sel = parseOutlookValue(opt.value);
    layer.productId = sel.product;
    layer.detailId = sel.detail;
  } else {
    layer.productId = opt.value;
    layer.detailId = '';
  }
}

function activeUserLayer() {
  return state.layers.items.find((ly) => ly.id === state.layers.activeId) || state.layers.items[0] || null;
}

function layerDisplayValue(layer) {
  return layer.source === 'outlooks' ? outlookValue(layer.productId, layer.detailId) : layer.productId;
}

function layerProductName(layer) {
  if (layer.source === 'radar') return radarProduct(layer.productId)?.name || layer.productId;
  if (layer.source === 'satellite') {
    const id = layer.productId;
    if (id.startsWith('C')) return (SAT_CHANNELS[parseInt(id.slice(1), 10) - 1] || {}).name || id;
    return (SAT_RGB[id.replace(/^RGB_/, '')] || {}).name || id;
  }
  if (layer.source === 'mrms') return MRMS_PRODUCTS[layer.productId]?.name || layer.productId;
  if (layer.source === 'models') return MODEL_PRODUCTS[layer.productId]?.name || layer.productId;
  if (layer.source === 'observations') return OBS_PRODUCTS[layer.productId]?.name || layer.productId;
  if (layer.source === 'outlooks') {
    const product = OUTLOOKS[layer.productId] || OUTLOOKS.spc_conv;
    const detail = product.details.find((d) => d.id === layer.detailId) || product.details[0];
    return `${product.label} ${detail.label}`;
  }
  return layer.productId;
}

// A short tag for the layer's target (radar site / satellite+sector / model), so
// two layers on the same source but different targets read distinctly in the list.
function layerTargetLabel(layer) {
  if (layer.source === 'radar') return layer.siteId || '';
  if (layer.source === 'satellite') {
    const sat = SATELLITES[layer.satKey];
    const sec = sectorsForSatellite(layer.satKey || '')[layer.sectorKey];
    return [sat && sat.label, sec && sec.label].filter(Boolean).join(' ');
  }
  if (layer.source === 'models') return (MODELS[layer.modelKey] && MODELS[layer.modelKey].label) || layer.modelKey || '';
  return '';
}

function contourCapable(layer) {
  return layer.source === 'mrms' || layer.source === 'models' || layer.source === 'observations' || layer.source === 'outlooks';
}

function syncLayerProductSelect(layer) {
  if (!el.layerProductSelect || !layer) return;
  el.layerProductSelect.innerHTML = '';
  for (const opt of layerProductOptions(layer.source, layer)) {
    const o = document.createElement('option');
    o.value = opt.value;
    o.textContent = opt.label;
    el.layerProductSelect.appendChild(o);
  }
  el.layerProductSelect.value = layerDisplayValue(layer);
}

// Populate a <select> once from [value,label] pairs (skips if already filled).
function fillSelectOnce(sel, pairs) {
  if (!sel || sel.options.length) return;
  for (const [value, label] of pairs) {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    sel.appendChild(o);
  }
}

// Show the source-specific selectors (radar site / satellite + sector / model)
// for the active layer and reflect its current picks.
function syncLayerTargetSelects(layer) {
  const show = (field, on) => { if (field) field.hidden = !on; };
  show(el.layerSiteField, !!layer && layer.source === 'radar');
  show(el.layerSatField, !!layer && layer.source === 'satellite');
  show(el.layerSectorField, !!layer && layer.source === 'satellite');
  show(el.layerModelField, !!layer && layer.source === 'models');
  if (!layer) return;

  if (layer.source === 'radar' && el.layerSiteSelect) {
    fillSelectOnce(el.layerSiteSelect,
      [...RADARS].sort((a, b) => a[0].localeCompare(b[0])).map(([code, name]) => [code, `${code} — ${name}`]));
    el.layerSiteSelect.value = layer.siteId || activeSiteIcao();
  }
  if (layer.source === 'satellite') {
    if (el.layerSatSelect) {
      fillSelectOnce(el.layerSatSelect, Object.entries(SATELLITES).filter(([, sat]) => sat.family !== 'mirs').map(([key, sat]) => [key, sat.label]));
      el.layerSatSelect.value = layer.satKey;
    }
    if (el.layerSectorSelect) {
      // Sectors depend on the chosen satellite, so this one is rebuilt each time.
      el.layerSectorSelect.innerHTML = '';
      for (const [key, sec] of Object.entries(sectorsForSatellite(layer.satKey))) {
        const o = document.createElement('option');
        o.value = key;
        o.textContent = sec.label;
        el.layerSectorSelect.appendChild(o);
      }
      el.layerSectorSelect.value = layer.sectorKey;
    }
  }
  if (layer.source === 'models' && el.layerModelSelect) {
    fillSelectOnce(el.layerModelSelect, Object.entries(MODELS).map(([key, m]) => [key, m.label || key]));
    el.layerModelSelect.value = layer.modelKey;
  }
}

// The layer editor replaces the product controls only on the desktop sidebar; on
// mobile the swipe sheet already keeps everything reachable, so the swap is skipped
// there and the layer controls simply live alongside the rest.
function layeringUiActive() {
  return !!state.layers.enabled && !mqSmallScreen.matches;
}

function buildLayerControls() {
  if (!el.layerControls) return;
  if (el.layeringToggle) setToggleBtn(el.layeringToggle, state.layers.enabled);
  el.layerControls.hidden = !state.layers.enabled;
  if (!el.layerSourceSelect || !el.layerProductSelect || !el.layerStyleSelect || !el.layerList) return;

  if (!el.layerSourceSelect.options.length) {
    for (const source of LAYER_STACK_SOURCES) {
      const o = document.createElement('option');
      o.value = source;
      o.textContent = LAYER_STACK_SOURCE_LABELS[source] || source;
      el.layerSourceSelect.appendChild(o);
    }
  }

  const layer = activeUserLayer();
  // Backfill targets before rendering the list/selects, so a layer restored from
  // an older settings blob (no siteId/satKey/modelKey yet) shows the right site,
  // satellite and model rather than a blank pick until its first draw.
  for (const ly of state.layers.items) ensureLayerTargets(ly);
  el.layerList.innerHTML = '';
  for (let i = state.layers.items.length - 1; i >= 0; i--) {
    const ly = state.layers.items[i];
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'layer-item';
    btn.classList.toggle('active', ly.id === state.layers.activeId);
    const target = layerTargetLabel(ly);
    const sub = (LAYER_STACK_SOURCE_LABELS[ly.source] || ly.source) + (target ? ` · ${target}` : '') + ' · ' + ly.style;
    btn.innerHTML = `<b>${escapeHTML(layerProductName(ly))}</b><span>${escapeHTML(sub)}</span>`;
    btn.addEventListener('click', () => {
      state.layers.activeId = ly.id;
      buildLayerControls();
      saveSettings();
    });
    el.layerList.appendChild(btn);
  }

  const disabled = !layer;
  for (const node of [el.layerSourceSelect, el.layerProductSelect, el.layerStyleSelect, el.layerRemove, el.layerUp, el.layerDown,
    el.layerSiteSelect, el.layerSatSelect, el.layerSectorSelect, el.layerModelSelect])
    if (node) node.disabled = disabled;
  if (!layer) {
    el.layerProductSelect.innerHTML = '';
    syncLayerTargetSelects(null);
    return;
  }
  el.layerSourceSelect.value = layer.source;
  syncLayerTargetSelects(layer);
  syncLayerProductSelect(layer);
  el.layerStyleSelect.value = contourCapable(layer) ? layer.style : 'fill';
}

function addUserLayer() {
  const source = defaultLayerSource();
  const layer = { id: layerId(), source, productId: defaultLayerProduct(source), detailId: '', style: 'fill' };
  ensureLayerTargets(layer);
  normalizeLayerProduct(layer, layer.productId);
  state.layers.items.push(layer);
  state.layers.activeId = layer.id;
  state.layers.enabled = true;
  buildLayerControls();
  renderLayerStack();
  rerenderMainSource(); // first item may hand the main display over to the stack
  saveSettings();
}

function removeUserLayer() {
  const layer = activeUserLayer();
  if (!layer) return;
  const i = state.layers.items.findIndex((ly) => ly.id === layer.id);
  if (i >= 0) state.layers.items.splice(i, 1);
  state.layers.activeId = state.layers.items[Math.min(i, state.layers.items.length - 1)]?.id || null;
  buildLayerControls();
  renderLayerStack();
  rerenderMainSource(); // removing the last layer gives the screen back to the main product
  saveSettings();
}

function moveUserLayer(delta) {
  const layer = activeUserLayer();
  if (!layer) return;
  const i = state.layers.items.findIndex((ly) => ly.id === layer.id);
  const j = Math.max(0, Math.min(state.layers.items.length - 1, i + delta));
  if (i === j) return;
  state.layers.items.splice(i, 1);
  state.layers.items.splice(j, 0, layer);
  buildLayerControls();
  renderLayerStack();
  saveSettings();
}

function clearLayerStack() {
  const map = state.map;
  if (!map || !map.getStyle) return;
  for (const rec of [...(state.layers.renderedIds || [])].reverse()) {
    for (const id of rec.layers || []) {
      if (map.getLayer(id)) map.removeLayer(id);
    }
    for (const id of rec.sources || []) {
      if (map.getSource(id)) map.removeSource(id);
    }
  }
  state.layers.renderedIds = [];
  state.layers.custom = {};
}

function rememberLayerArtifacts(layers, sources = []) {
  state.layers.renderedIds.push({ layers, sources });
}

function layerCacheKey(layer, extra = '') {
  const target = layer.source === 'radar' ? (layer.siteId || '')
    : layer.source === 'satellite' ? `${layer.satKey || ''}/${layer.sectorKey || ''}`
    : layer.source === 'models' ? (layer.modelKey || '')
    : '';
  return `${layer.source}:${target}:${layer.productId}:${layer.detailId || ''}:${extra}`;
}

// Layer-stack data used to stay in this Map indefinitely. A few stacked MRMS or
// model products can each retain a full decoded grid, so keep a bounded LRU.
// Decoded grids are large; retain only the visible layer working set instead of
// dozens of historical model/MRMS grids after the user changes products.
const LAYER_CACHE_MAX = CONSTRAINED_DEVICE ? 2 : 6;
function layerCacheGet(key) {
  const cache = state.layers.cache;
  const value = cache.get(key);
  if (value !== undefined) { cache.delete(key); cache.set(key, value); }
  return value;
}
function layerCachePut(key, value) {
  const cache = state.layers.cache;
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > LAYER_CACHE_MAX) cache.delete(cache.keys().next().value);
  return value;
}

async function loadLayerGrid(layer) {
  if (layer.source === 'mrms') {
    if (state.mode === 'mrms' && layer.productId === state.mrms.productId && state.mrms.grid) return state.mrms.grid;
    const frames = await listMrms(layer.productId, state.live ? new Date() : state.date);
    const frame = frames[frames.length - 1];
    if (!frame) return null;
    const ck = layerCacheKey(layer, frame.key);
    let grid = layerCacheGet(ck);
    if (!grid) grid = layerCachePut(ck, compactGridForConstrainedDevice(await loadMrms(layer.productId, frame.key)));
    return grid;
  }
  if (layer.source === 'observations') {
    if (state.mode === 'observations' && layer.productId === state.observations.productId && state.observations.grid) return state.observations.grid;
    let key = state.observations.frameKey ||
      (state.observations.frames.length ? state.observations.frames[state.observations.frames.length - 1].key : null);
    if (!key) {
      const frames = await listObservations(state.live ? new Date() : state.date);
      const frame = frames[frames.length - 1];
      key = frame && frame.key;
    }
    if (!key) return null;
    const ck = layerCacheKey(layer, key);
    let grid = layerCacheGet(ck);
    if (!grid) grid = layerCachePut(ck, compactGridForConstrainedDevice(await loadObservation(layer.productId, key)));
    return grid;
  }
  if (layer.source === 'models') {
    const modelKey = (layer.modelKey && MODELS[layer.modelKey]) ? layer.modelKey : state.models.modelKey;
    if (!modelSupports(modelKey, layer.productId)) return null;
    const onActiveModel = modelKey === state.models.modelKey;
    // When the layer rides the same model as the main view, reuse its live grid /
    // run / forecast hour so the two stay in lockstep and nothing re-downloads.
    if (onActiveModel && state.mode === 'models' && layer.productId === state.models.productId && state.models.grid)
      return state.models.grid;
    // A models layer must render even when models mode was never entered (so the
    // run list is empty): list the cycles on demand and take the latest. Storm-
    // based models need their run stamped so loadModel can build the frame key.
    let run = onActiveModel ? currentModelRun() : null;
    let stormId = onActiveModel ? (state.models.stormId || '') : '';
    if (!run) {
      const when = state.live ? new Date() : state.date;
      const runs = await listModels(modelKey, layer.productId, when);
      run = runs[runs.length - 1] || null;
      const model = MODELS[modelKey];
      if (run && model && model.stormBased && run.storms && run.storms.length) {
        // Pick a storm for the layer without disturbing the main view's selection.
        const storm = run.storms.find((s) => s.id === state.models.stormId) || run.storms[0];
        stormId = storm.id;
        run.storm = storm.id;
        run.fhours = storm.fhours;
        run.maxFhour = storm.fhours[storm.fhours.length - 1] || 0;
      }
    }
    if (!run) return null;
    // Only a same-model layer can follow the main view's forecast hour; a
    // different model has no shared timeline, so it shows F00.
    const fhour = onActiveModel ? state.models.fhour : 0;
    const ck = layerCacheKey(layer, `${modelKey}:${stormId}:${run.key}:${fhour}`);
    let grid = layerCacheGet(ck);
    if (!grid) grid = layerCachePut(ck, compactGridForConstrainedDevice(await loadModel(modelKey, layer.productId, run, fhour)));
    return grid;
  }
  return null;
}

function niceStep(raw) {
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / pow;
  const m = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return m * pow;
}

function gridContourData(grid) {
  const p = resolveGridProduct(grid.product);
  const lo = dispValue(p, p.lo);
  const hi = dispValue(p, p.hi);
  const displayStep = niceStep(Math.abs(hi - lo) / 8);
  const factor = Math.abs(dispValue(p, p.lo + 1) - dispValue(p, p.lo)) || 1;
  const nativeStep = displayStep / factor;
  return contourGeoJSON(grid, grid.values, nativeStep, (level) => fmtValue(p, level), p.floor);
}

function addContourLayer(layer, grid) {
  const map = state.map;
  const sourceId = `rn-user-${layer.id}-contours`;
  const lineId = `rn-user-${layer.id}-line`;
  const labelId = `rn-user-${layer.id}-labels`;
  map.addSource(sourceId, { type: 'geojson', data: gridContourData(grid) });
  map.addLayer({
    id: lineId,
    type: 'line',
    source: sourceId,
    layout: { 'line-join': 'round' },
    paint: { 'line-color': 'rgba(255,255,255,0.86)', 'line-width': 1.35, 'line-opacity': 0.95 },
  }, firstLabelLayerId(map));
  map.addLayer({
    id: labelId,
    type: 'symbol',
    source: sourceId,
    layout: {
      'symbol-placement': 'line',
      'text-field': ['get', 'label'],
      'text-size': 11,
      'symbol-spacing': 240,
      'text-allow-overlap': false,
    },
    paint: { 'text-color': '#ffffff', 'text-halo-color': 'rgba(4,10,18,0.9)', 'text-halo-width': 1.4 },
  }, firstLabelLayerId(map));
  rememberLayerArtifacts([lineId, labelId], [sourceId]);
}

async function renderGridUserLayer(layer, seq) {
  const map = state.map;
  const grid = await loadLayerGrid(layer);
  if (seq !== state.layers.renderSeq) return;
  if (!grid) return;
  if (layer.style === 'contour' && contourCapable(layer)) {
    addContourLayer(layer, grid);
    return;
  }
  const id = `rn-user-${layer.id}`;
  const glLayer = createGridLayer(id);
  map.addLayer(glLayer, dataLayerAnchor(map));
  glLayer.setGrid(grid, resolveGridProduct(grid.product));
  glLayer.setOpacity(Math.min(0.95, state.opacity));
  glLayer.setSmooth(state.smooth);
  state.layers.custom[id] = glLayer;
  rememberLayerArtifacts([id]);
}

// Fetch + decode the latest Level II volume for a radar site a layer wants to
// draw, independent of the site the main view is on. Cached per site (and briefly
// re-used while LIVE), so several layers or a repaint don't re-download.
async function loadLayerRadarVolume(siteId, seq) {
  state.layers.radarCache = state.layers.radarCache || new Map();
  const cache = state.layers.radarCache;
  const hit = cache.get(siteId);
  if (hit && (!state.live || Date.now() - hit.ts < 120000)) return hit.volume;
  const when = state.live ? new Date() : state.date;
  let vols;
  try { vols = await listVolumes(siteId, when); } catch (_) { return hit ? hit.volume : null; }
  if (seq !== state.layers.renderSeq) return hit ? hit.volume : null;
  if (!vols || !vols.length) return hit ? hit.volume : null;
  const key = vols[vols.length - 1].key;
  if (hit && hit.key === key) { hit.ts = Date.now(); return hit.volume; }
  let volume;
  try {
    const bytes = await fetchVolume(key);
    if (seq !== state.layers.renderSeq) return hit ? hit.volume : null;
    volume = ensureVolumeSite(await decodeVolume(bytes), siteId);
  } catch (_) { return hit ? hit.volume : null; }
  if (!volume) return hit ? hit.volume : null;
  cache.set(siteId, { volume, key, ts: Date.now() });
  // Two sites of layer-stack radar are plenty; each entry is a full decoded
  // volume, so a wider cache quietly pinned several hundred MB.
  while (cache.size > (CONSTRAINED_DEVICE ? 1 : 2)) cache.delete(cache.keys().next().value);
  return volume;
}

async function renderRadarUserLayer(layer, seq) {
  const map = state.map;
  const product = radarProduct(layer.productId);
  // Level III products aren't drawn from Level II sweeps; skip (and don't waste a
  // volume download on) them, matching the main radar path.
  if (!product || !PRODUCTS[layer.productId]) return;
  const siteId = layer.siteId || activeSiteIcao();
  let sweep = null, site = null;
  if (siteId === activeSiteIcao() && state.sweeps && state.sweeps.length) {
    // Same site as the main view — reuse its already-decoded, dealiased sweep.
    sweep = radarSweepFor(layer.productId);
    site = state.shownSite || (state.volume && state.volume.site);
  } else {
    const volume = await loadLayerRadarVolume(siteId, seq);
    if (seq !== state.layers.renderSeq || !volume) return;
    sweep = pickSweep(volume.sweeps, layer.productId);
    sweep = resolveSweepForProduct(sweep, layer.productId);
    site = volume.site;
  }
  if (!sweep || !site || seq !== state.layers.renderSeq) return;
  const id = `rn-user-${layer.id}`;
  const glLayer = createRadarLayer(id);
  map.addLayer(glLayer, dataLayerAnchor(map));
  glLayer.setSweep(sweep, product, site);
  glLayer.setOpacity(Math.min(0.92, state.opacity));
  glLayer.setSmooth(state.smooth);
  state.layers.custom[id] = glLayer;
  rememberLayerArtifacts([id]);
}

// A satellite layer in the stack must render even when satellite mode was never
// entered (so state.sat.scene is null). List the scenes for the layer's chosen
// satellite/sector on demand, load the latest, and cache it keyed by scene key
// (so LIVE picks up new frames) — separate from the mode's own state.sat.scene.
// When the layer targets the exact satellite+sector the main view is showing, the
// already-decoded live scene is reused instead of a second download.
async function ensureLayerSatScene(layer, seq) {
  const satKey = (layer.satKey && SATELLITES[layer.satKey] && !isMirsSat(layer.satKey)) ? layer.satKey
    : (isMirsSat(state.sat.satKey) ? 'goes19' : state.sat.satKey);
  const sectors = sectorsForSatellite(satKey);
  const sectorKey = sectors[layer.sectorKey] ? layer.sectorKey : state.sat.sectorKey;
  if (state.sat.scene && satKey === state.sat.satKey && sectorKey === state.sat.sectorKey)
    return { scene: state.sat.scene, satKey, sectorKey };
  const when = state.live ? new Date() : state.date;
  const scenes = await listScenes(satKey, sectorKey, when);
  if (seq !== state.layers.renderSeq || !scenes.length) return null;
  const key = scenes[scenes.length - 1].key;
  const ck = `layerscene:${satKey}:${sectorKey}:${key}`;
  const cached = layerCacheGet(ck);
  if (cached) return { scene: cached, satKey, sectorKey };
  const scene = await loadSceneAsync(satKey, sectorKey, key, bandsFor(layer.productId));
  if (seq !== state.layers.renderSeq) return null;
  layerCachePut(ck, scene);
  return { scene, satKey, sectorKey };
}

async function renderSatelliteUserLayer(layer, seq) {
  const map = state.map;
  const got = await ensureLayerSatScene(layer, seq);
  if (seq !== state.layers.renderSeq) return;
  if (!got || !got.scene) return;
  const { scene, satKey, sectorKey } = got;
  await ensureBandsAsync(scene, satKey, sectorKey, bandsFor(layer.productId));
  if (seq !== state.layers.renderSeq) return;
  // Only borrow the main view's crop (a CONUS region / cyclone box) when the layer
  // is on the very satellite+sector that crop was computed for; otherwise render
  // the layer's own full scene, or the CONUS box would be projected onto (say) a
  // Himawari disk and land off-Earth.
  const sameAsView = satKey === state.sat.satKey && sectorKey === state.sat.sectorKey;
  const crop = sameAsView ? satelliteCrop(scene) : null;
  const rgba = buildRGBA(scene, layer.productId, { enhanceIR: state.sat.enhanceIR, crop });
  const meta = croppedSatMeta(scene, crop);
  const bbox = crop && crop.bbox ? crop.bbox : sceneBBox(meta);
  const payload = { meta, rgba, bbox };
  const id = `rn-user-${layer.id}`;
  const glLayer = createSatelliteLayer(id);
  map.addLayer(glLayer, dataLayerAnchor(map));
  glLayer.setScene(payload.meta, payload.rgba, payload.bbox);
  glLayer.setOpacity(Math.min(0.92, state.opacity));
  glLayer.setSmooth(state.smooth);
  state.layers.custom[id] = glLayer;
  rememberLayerArtifacts([id]);
}

async function renderOutlookUserLayer(layer, seq) {
  const map = state.map;
  const sourceId = `rn-user-${layer.id}-outlook`;
  const fillId = `rn-user-${layer.id}-fill`;
  const lineId = `rn-user-${layer.id}-line`;
  const ck = layerCacheKey(layer);
  if (!layerCacheGet(ck)) {
    const data = await loadOutlookData(layer.productId, layer.detailId);
    layerCachePut(ck, data.fc);
  }
  if (seq !== state.layers.renderSeq) return;
  map.addSource(sourceId, { type: 'geojson', data: layerCacheGet(ck) || { type: 'FeatureCollection', features: [] } });
  const layers = [];
  if (layer.style !== 'contour') {
    map.addLayer({
      id: fillId,
      type: 'fill',
      source: sourceId,
      paint: { 'fill-color': ['get', 'fill'], 'fill-opacity': Math.max(0.08, state.spcOpacity * 0.75) },
    }, dataLayerAnchor(map));
    layers.push(fillId);
  }
  map.addLayer({
    id: lineId,
    type: 'line',
    source: sourceId,
    paint: { 'line-color': ['get', 'stroke'], 'line-width': layer.style === 'contour' ? 2.2 : 1.5, 'line-opacity': 0.95 },
  }, firstLabelLayerId(map));
  layers.push(lineId);
  rememberLayerArtifacts(layers, [sourceId]);
}

async function renderOneUserLayer(layer, seq) {
  if (!state.map || seq !== state.layers.renderSeq) return;
  normalizeLayerProduct(layer, layerDisplayValue(layer));
  if (layer.source !== 'outlooks' && !contourCapable(layer) && layer.style === 'contour') layer.style = 'fill';
  if (layer.source === 'radar') await renderRadarUserLayer(layer, seq);
  else if (layer.source === 'satellite') await renderSatelliteUserLayer(layer, seq);
  else if (layer.source === 'outlooks') await renderOutlookUserLayer(layer, seq);
  else await renderGridUserLayer(layer, seq);
}

async function renderLayerStack() {
  if (!state.map || !state.styleReady) return;
  const seq = ++state.layers.renderSeq;
  clearLayerStack();
  if (!state.layers.enabled || !state.layers.items.length) return;
  for (const layer of state.layers.items) {
    try {
      await renderOneUserLayer(layer, seq);
    } catch (error) {
      // One unavailable source (including a satellite band that failed both
      // attempts) should not reject an unobserved top-level render promise or
      // prevent the remaining user layers from drawing.
      if (seq === state.layers.renderSeq) {
        console.error(`layer stack ${layer.source} render failed`, error);
        setStatus(`${LAYER_STACK_SOURCE_LABELS[layer.source] || layer.source} layer error: ${error.message || error}`);
      }
    }
    if (seq !== state.layers.renderSeq) return;
  }
}

// While the layer stack is on, the stack IS the display: the main source's own
// fill hides so the layer list accounts for everything on screen. (Enabling
// layers used to leave the previous product drawn underneath as an unlisted
// "extra layer" — the seeded first layer duplicates it, so handing the screen
// to the stack keeps the view identical while making the list truthful.)
// A running playback loop still owns the screen.
function mainSourceSuppressed() {
  return !!(state.layers.enabled && state.layers.items.length) &&
    !(state.playback && state.playback.active);
}

// Redraw the active mode's main display — used when the layer stack toggles
// (the main product hides behind the stack, or comes back out of it).
function rerenderMainSource() {
  if (state.mode === 'radar') renderRadar();
  else if (state.mode === 'satellite') renderSatellite();
  else if (state.mode === 'mrms') renderMrms();
  else if (state.mode === 'models') renderModels();
  else if (state.mode === 'observations') renderObservations();
}

function setupLayerControls() {
  buildLayerControls();
  if (el.layeringToggle) {
    el.layeringToggle.addEventListener('click', () => {
      state.layers.enabled = !state.layers.enabled;
      if (state.layers.enabled && !state.layers.items.length) addUserLayer();
      else {
        buildLayerControls();
        renderLayerStack();
        saveSettings();
      }
      // The main product hands the screen to the stack (or takes it back) —
      // see mainSourceSuppressed.
      rerenderMainSource();
      // Swap the product controls for the layer editor (or back) on the sidebar.
      applyModePanels();
      setStatus(state.layers.enabled ? 'layers on' : 'layers off');
    });
  }
  if (el.layerAdd) el.layerAdd.addEventListener('click', addUserLayer);
  if (el.layerRemove) el.layerRemove.addEventListener('click', removeUserLayer);
  if (el.layerUp) el.layerUp.addEventListener('click', () => moveUserLayer(1));
  if (el.layerDown) el.layerDown.addEventListener('click', () => moveUserLayer(-1));
  if (el.layerSourceSelect) {
    el.layerSourceSelect.addEventListener('change', () => {
      const layer = activeUserLayer();
      if (!layer) return;
      layer.source = el.layerSourceSelect.value;
      ensureLayerTargets(layer);
      layer.productId = defaultLayerProduct(layer.source);
      layer.detailId = '';
      normalizeLayerProduct(layer, layer.productId);
      if (!contourCapable(layer)) layer.style = 'fill';
      buildLayerControls();
      renderLayerStack();
      saveSettings();
    });
  }
  // Per-source targets: a layer can ride a different radar site, satellite +
  // sector, or model than the main view. Changing one re-validates the product
  // menu against the new target and re-renders just the stack.
  if (el.layerSiteSelect) {
    el.layerSiteSelect.addEventListener('change', () => {
      const layer = activeUserLayer();
      if (!layer || layer.source !== 'radar') return;
      layer.siteId = el.layerSiteSelect.value;
      buildLayerControls();
      renderLayerStack();
      saveSettings();
    });
  }
  if (el.layerSatSelect) {
    el.layerSatSelect.addEventListener('change', () => {
      const layer = activeUserLayer();
      if (!layer || layer.source !== 'satellite') return;
      layer.satKey = el.layerSatSelect.value;
      const sectors = sectorsForSatellite(layer.satKey);
      if (!sectors[layer.sectorKey]) layer.sectorKey = Object.keys(sectors)[0];
      buildLayerControls();
      renderLayerStack();
      saveSettings();
    });
  }
  if (el.layerSectorSelect) {
    el.layerSectorSelect.addEventListener('change', () => {
      const layer = activeUserLayer();
      if (!layer || layer.source !== 'satellite') return;
      layer.sectorKey = el.layerSectorSelect.value;
      buildLayerControls();
      renderLayerStack();
      saveSettings();
    });
  }
  if (el.layerModelSelect) {
    el.layerModelSelect.addEventListener('change', () => {
      const layer = activeUserLayer();
      if (!layer || layer.source !== 'models') return;
      layer.modelKey = el.layerModelSelect.value;
      // The new model may not carry the layer's current product — snap to a valid one.
      normalizeLayerProduct(layer, layer.productId);
      buildLayerControls();
      renderLayerStack();
      saveSettings();
    });
  }
  if (el.layerProductSelect) {
    el.layerProductSelect.addEventListener('change', () => {
      const layer = activeUserLayer();
      if (!layer) return;
      normalizeLayerProduct(layer, el.layerProductSelect.value);
      buildLayerControls();
      renderLayerStack();
      saveSettings();
    });
  }
  if (el.layerStyleSelect) {
    el.layerStyleSelect.addEventListener('change', () => {
      const layer = activeUserLayer();
      if (!layer) return;
      layer.style = el.layerStyleSelect.value === 'contour' && contourCapable(layer) ? 'contour' : 'fill';
      buildLayerControls();
      renderLayerStack();
      saveSettings();
    });
  }
}

function renderModels() {
  const map = state.map;
  if (!map || !state.styleReady) return;
  if (mainSourceSuppressed()) {
    clearModels();
    clearModelCityValues();
    renderLayerStack();
    syncSplit();
    updateDock();
    return;
  }
  const grid = state.models.grid;
  if (!grid) { clearModels(); return; }
  state.models.displayGrid = grid;
  setModelSource(map);
  state.models.layer.setGrid(grid, resolveGridProduct(grid.product));
  state.models.layer.setOpacity(state.opacity);
  state.models.layer.setSmooth(state.smooth);
  // Model products may carry wind/height, wind-speed, or MSLP overlays; others clear them.
  state.models.overlayData = grid._overlayData || prepareModelOverlayData(grid);
  showPreparedModelOverlays(map, state.models.overlayData);
  renderModelCityValues();
  renderLayerStack();
  syncSplit();
  updateDock();
}

// Total GeoJSON features an overlay bundle carries — the memory driver when a
// loop keeps overlays per frame.
function countOverlayFeatures(data) {
  if (!data) return 0;
  let n = 0;
  for (const k of ['hgt', 'windBarbs', 'mslp', 'pressureCenters', 'windContours']) {
    if (data[k] && data[k].features) n += data[k].features.length;
  }
  return n;
}

// Reconstruct a readout-grade grid from a packed playback payload's 16-bit fill
// codes (value = product lo + code/65534 × span; code 0 = missing). Loop frames
// carry no Float32 values array, so the inspect readout, city values and
// extrema for the displayed hour decode from the codes instead — quantized to
// 1/65534 of the product range, plenty for a scrubbing readout. Memoised on the
// payload so re-renders of the same frame don't re-decode; each new frame gets
// a fresh array (never a shared scratch) because provider.idle() can promote
// the decoded grid into state.models.grid when the loop stops.
let packedGridMemo = { payload: null, grid: null };
function gridFromPackedPayload(payload) {
  if (!payload || !payload.tex || !payload.tex.packed || !payload.meta) return null;
  if (packedGridMemo.payload === payload) return packedGridMemo.grid;
  const { tex, meta } = payload;
  const p = resolveGridProduct(meta.product);
  const span = (p.hi - p.lo) || 1;
  const n = tex.W * tex.H;
  const codes = tex.packed;
  const values = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const c = codes[i];
    values[i] = c ? p.lo + ((c - 1) / 65534) * span : NaN;
  }
  const grid = {
    ni: tex.W, nj: tex.H,
    lon1: tex.lon1, lat1: tex.lat1, di: tex.di, dj: tex.dj,
    values, product: meta.product, time: meta.time,
  };
  packedGridMemo = { payload, grid };
  return grid;
}

// Display a pre-prepared model grid payload — used by forecast-hour playback.
function drawModelPayload(payload) {
  const map = state.map;
  if (!map || !state.styleReady) return;
  const grid = payload && (payload.grid || gridFromPackedPayload(payload));
  if (grid) state.models.displayGrid = grid;
  setModelSource(map);
  let overlays = (payload && payload.overlays) || null;
  if (!overlays && payload && payload.contoursJson) {
    try { overlays = JSON.parse(payload.contoursJson); } catch (_) { overlays = null; }
  }
  showPreparedModelOverlays(map, overlays);
  state.models.layer.showPrepared(payload);
  state.models.layer.setOpacity(state.opacity);
  state.models.layer.setSmooth(state.smooth);
  renderModelCityValues();
  renderLayerStack();
}

function buildModelLegend() {
  const p = resolveGridProduct(MODEL_PRODUCTS[state.models.productId]);
  el.legend.innerHTML = legendHTML(p, p.scale);
  updateSplitPaneChrome();
}

function sampleModelAt(lat, lon) {
  const grid = modelGridForReadouts();
  if (!grid) return null;
  const p = resolveGridProduct(grid.product);
  const v = sampleGridRaw(grid, lat, lon);
  if (v == null) return { out: true };
  if (Number.isNaN(v) || !(v >= p.floor)) return { main: 'no echo', sub: p.id };
  return { main: fmtValue(p, v), sub: p.id };
}

function visibleModelExtrema() {
  if (state.mode !== 'models' || !state.map) return null;
  const grid = modelGridForReadouts();
  if (!grid || !grid.values) return null;
  const p = resolveGridProduct(grid.product);
  const b = state.map.getBounds && state.map.getBounds();
  if (!b) return null;
  const south = Math.max(-90, b.getSouth());
  const north = Math.min(90, b.getNorth());
  let west = b.getWest();
  let east = b.getEast();
  while (east < west) east += 360;

  const rowStart = Math.max(0, Math.floor((grid.lat1 - north) / grid.dj));
  const rowEnd = Math.min(grid.nj - 1, Math.ceil((grid.lat1 - south) / grid.dj));
  if (rowEnd < rowStart) return null;

  let lo = Infinity, hi = -Infinity;
  const lonInView = (lon) => {
    let x = lon;
    while (x < west) x += 360;
    while (x > east && x - 360 >= west) x -= 360;
    return x >= west && x <= east;
  };
  for (let j = rowStart; j <= rowEnd; j++) {
    const base = j * grid.ni;
    for (let i = 0; i < grid.ni; i++) {
      const lon = grid.lon1 + i * grid.di;
      if (!lonInView(lon)) continue;
      const v = grid.values[base + i];
      if (!Number.isFinite(v) || !(v >= p.floor)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  return {
    title: p.name || p.id,
    low: fmtValue(p, lo),
    high: fmtValue(p, hi),
  };
}

// ---------------------------------------------------------------------------
// Model sounding: a Skew-T, storm-relative hodograph and severe params for the
// clicked model column. The profile is decoded from the selected model's GRIB2
// data in the browser and pinned to the displayed run's valid time.
// ---------------------------------------------------------------------------
let soundingSeq = 0;

// The forecast hour actually shown on screen. While a loop is scrubbing/playing
// the displayed hour is the playback frame's, which is independent of the picker
// selection (state.models.fhour) — so a sounding must follow the frame, not the
// picker, or it would always read the picker's hour (F00 by default).
function currentModelFhour() {
  const pb = state.playback;
  if (pb && pb.active && state.mode === 'models') {
    const f = pb.frames[pb.idx];
    if (f && Number.isFinite(f.fhour)) return f.fhour;
  }
  return state.models.fhour;
}

// Keep the selected forecast hour in lock-step with whatever frame is on screen
// while a model loop scrubs/plays. Without this, the picker highlight, the dock
// label and a sounding opened mid-loop all stay pinned to the hour the loop
// started on (F00 by default) even though the map shows a later frame. Updates
// the picker highlight in place rather than rebuilding the whole list.
function setDisplayedFhour(f) {
  if (!Number.isFinite(f) || state.models.fhour === f) return;
  state.models.fhour = f;
  if (el.fhourList) {
    const want = 'F' + p2(f);
    el.fhourList.querySelectorAll('.tilt-btn').forEach((b) =>
      b.classList.toggle('active', b.textContent === want));
  }
}

function modelValidTime(fhour = currentModelFhour()) {
  const run = currentModelRun();
  if (run) return new Date(run.time.getTime() + fhour * 3600 * 1000);
  const grid = (state.playback && state.playback.active && state.models.displayGrid) || state.models.grid;
  if (grid && grid.time) return grid.time;
  return new Date();
}

// Open a sounding for a map point. `loc` is a {lat, lng} (e.g. an event lngLat);
// it defaults to the map centre. Only meaningful in models mode.
async function openSounding(loc) {
  if (state.mode !== 'models') return;
  const ctr = state.map.getCenter();
  const c = loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng)
    ? { lat: loc.lat, lng: loc.lng } : { lat: ctr.lat, lng: ctr.lng };
  const fhour = currentModelFhour();
  const validTime = modelValidTime(fhour);
  const seq = ++soundingSeq;

  // Follow the model selected for the active forecast hour — state.models.modelKey
  // is the live selection (a sounding is only offered in models mode).
  const modelKey = state.models.modelKey;
  const src = soundingModel(modelKey);
  const label = src.label;

  el.sounding.hidden = false;
  document.body.classList.add('snd-open');
  if (el.sndTitle) el.sndTitle.textContent = `${label} Sounding`;
  el.sndCharts.hidden = true;
  el.sndParams.hidden = true;
  el.sndStatus.hidden = false;

  // Some models (the AI ones) publish no column we can build a sounding from —
  // show a short notice rather than a misleading or empty profile.
  if (src.unavailable) {
    el.sndStatus.textContent = `Soundings aren't available for ${label}.`;
    el.sndMeta.textContent = '';
    state.soundingProfile = null;
    return;
  }

  el.sndStatus.textContent = `Loading ${label} sounding…`;
  const utc = `${WEEKDAY_ABBR[validTime.getUTCDay()]} ${p2(validTime.getUTCHours())}:00Z ${validTime.getUTCFullYear()}-${p2(validTime.getUTCMonth() + 1)}-${p2(validTime.getUTCDate())}`;
  el.sndMeta.textContent = `${c.lat.toFixed(2)}°, ${c.lng.toFixed(2)}° · valid ${utc}`;

  try {
    const run = currentModelRun();
    if (!run) throw new Error('No model run is loaded for this sounding.');
    const profile = await fetchSoundingNative(
        modelKey, run, fhour, c.lat, c.lng, validTime,
        (frac) => {
          if (seq === soundingSeq)
            el.sndStatus.textContent = `Loading ${label} sounding… ${Math.round(frac * 100)}%`;
        });
    if (seq !== soundingSeq) return; // a newer request superseded this one
    state.soundingProfile = profile;
    el.sndStatus.hidden = true;
    el.sndCharts.hidden = false;
    el.sndParams.hidden = false;
    renderSoundingParams(profile);
    renderStormMotion(profile);
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

// Severe-parameter tile grid: every real row paramRows() computes (grouped by
// SPC-style category — instability, shear/SRH, composites), flattened into
// tinted tiles keyed off each row's own tier color (same tiering the plain
// label:value view used), matching the mockup's tile-grid presentation.
function renderSoundingParams(profile) {
  const groups = paramRows(profile);
  el.sndParams.innerHTML = groups.map((g) => `
    <div class="snd-pgroup">
      <h3>${g.title}</h3>
      <div class="snd-pgrid">
        ${g.rows.map((r) => `
          <div class="snd-prow" style="--tc:${r.color};background:color-mix(in srgb, ${r.color} 13%, var(--panel-2));border-color:color-mix(in srgb, ${r.color} 30%, var(--panel-edge))">
            <span class="snd-plabel">${r.label}</span>
            <span class="snd-pval" style="color:${r.color}">${r.value}</span>
          </div>`).join('')}
      </div>
    </div>`).join('');
}

// Storm-motion readout beside the hodograph: Bunkers right/left movers and the
// real 0–6 km mean wind, all straight from computeParams()'s bunkers() output
// (profile.params.stormMotion) — no separately-derived numbers.
function renderStormMotion(profile) {
  if (!el.sndStormMotion) return;
  const p = profile.params;
  const fmt = (dir, spd) => `${Math.round(dir)}° / ${Math.round(spd)} kt`;
  el.sndStormMotion.innerHTML = `
    <div class="snd-motion-title">Storm motion</div>
    <div class="snd-motion-row"><span>Bunkers RM</span><b>${fmt(p.rmDir, p.rmSpd)}</b></div>
    <div class="snd-motion-row"><span>Bunkers LM</span><b>${fmt(p.lmDir, p.lmSpd)}</b></div>
    <div class="snd-motion-row"><span>0–6 km mean wind</span><b>${fmt(p.meanDir, p.meanSpd)}</b></div>`;
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

// Desktop gesture for the model sounding: a right-click opens it at the cursor.
// (Touch uses the long-press handled in enableLongPress, which branches by mode.)
// A no-op outside models mode — openSounding guards too.
function setupSoundingGestures() {
  const map = state.map;
  if (!map) return;
  map.on('contextmenu', (e) => {
    if (state.mode !== 'models') return;
    openSounding(e.lngLat);
  });
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
  // The all-radar dots belong to radar mode — and to any mode where the
  // single-site radar overlay is switched on, so the user can see (and pick)
  // which site the overlay is drawing. Outlook mode has no radar at all.
  const showSites = state.mode === 'radar' || (state.radarOverlay && state.mode !== 'outlooks');
  if (map.getLayer('sites'))
    map.setLayoutProperty('sites', 'visibility', showSites && state.siteMarkerStyle === 'dot' ? 'visible' : 'none');
  if (map.getLayer('site-pills'))
    map.setLayoutProperty('site-pills', 'visibility', showSites && state.siteMarkerStyle === 'pill' ? 'visible' : 'none');
  map.getSource('sites').setData(sitesGeoJSON());
  const mobile = mqSmallScreen.matches;
  if (map.getLayer('sites')) {
    map.setPaintProperty('sites', 'circle-radius', [
      'case',
      ['==', ['get', 'current'], 1],
      mobile ? 9 : 6,
      mobile ? 7 : 3.5,
    ]);
  }
}

// Scan every radar site's most recent scan time and flag the ones that look
// down — no volume in the past hour, or none findable at all — so their dots can
// draw red. This uses only the lightweight rolling IEM list; falling through to
// NOMADS/AWS here would multiply one startup task into hundreds of public-data
// requests. A fresh call supersedes any in-flight one.
const DOWN_SCAN_CONCURRENCY = isSmallScreenNow() ? 1 : 2;
const DOWN_STALE_MS = 60 * 60 * 1000; // "down" = no scan in the past hour
async function scanDownRadars() {
  const seq = ++state._downScanSeq;
  const codes = RADARS.map((r) => r[0]);
  let next = 0, dirty = false;
  // Repaint at most a few times a second while results stream in.
  let flushTimer = null;
  const scheduleFlush = () => {
    if (flushTimer || !dirty) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      if (seq === state._downScanSeq && dirty) { dirty = false; refreshSiteDots(); }
    }, 400);
  };
  const worker = async () => {
    for (;;) {
      if (seq !== state._downScanSeq) return; // superseded
      const i = next++;
      if (i >= codes.length) return;
      const icao = codes[i];
      let down = true;
      try {
        const t = await latestScanTime(icao, { allowArchiveFallback: false });
        if (t === undefined) continue;
        down = !t || (Date.now() - t.getTime() > DOWN_STALE_MS);
      } catch (_) { down = true; }
      if (seq !== state._downScanSeq) return;
      const was = state.downSites.has(icao);
      if (down) state.downSites.add(icao); else state.downSites.delete(icao);
      if (down !== was) { dirty = true; scheduleFlush(); }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(DOWN_SCAN_CONCURRENCY, codes.length) }, worker));
  if (seq === state._downScanSeq && dirty) refreshSiteDots();
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
        // In models mode a long-press opens a sounding at the touched point;
        // elsewhere it jumps to the nearest radar site (the original behaviour).
        if (state.mode === 'models') {
          if (navigator.vibrate) navigator.vibrate(25);
          openSounding(ll);
          return;
        }
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
// Inspect tool — on touch devices a fixed crosshair at screen centre reads the
// gate under it; on a desktop (fine pointer) inspect instead arms a readout that
// follows the mouse, and there is no centre picker.
// ---------------------------------------------------------------------------
// "PC" = a precise hovering pointer (mouse/trackpad). On such devices inspect
// drives a cursor-following readout rather than the centre crosshair, and the
// readout is only shown while inspect is armed.
const mqDesktopPointer = window.matchMedia('(hover: hover) and (pointer: fine)');
function isDesktopPointer() {
  return mqDesktopPointer.matches;
}

function toggleInspect(on) {
  state.inspect = on == null ? !state.inspect : on;
  if (state.inspect) clearOtherTools('inspect');
  el.inspectBtn.classList.toggle('active', state.inspect);
  if (el.toolInspect) el.toolInspect.classList.toggle('active', state.inspect);
  const desktop = isDesktopPointer();
  // Desktop: no centre picker — the mouse readout is the inspector. Touch: the
  // fixed centre crosshair reads the value beneath it as you pan.
  el.crosshair.hidden = desktop || !state.inspect;
  if (!state.inspect && el.readout) el.readout.classList.remove('show');
  updateInspect();
}

// ---------------------------------------------------------------------------
// Single active "modal" map tool at a time. Draw / measure / storm, METARs and
// inspect are mutually exclusive: arming one disarms whatever was running, so a
// tool is never left enabled after another is picked.
// ---------------------------------------------------------------------------
function activeModalTool() {
  if (state.mapTools && state.mapTools.tool) return state.mapTools.tool;
  if (state.xsect && state.xsect.active()) return 'xsect';
  if (state.inspect) return 'inspect';
  return null;
}

// True while a tool that consumes map clicks is armed — used to keep those
// clicks from also opening alert briefings / storm cards / outlook popups or
// switching radar sites.
function clickConsumingToolActive() {
  return !!((state.mapTools && state.mapTools.tool) || (state.xsect && state.xsect.armed));
}

function deactivateModalTool(id) {
  switch (id) {
    case 'draw':
    case 'measure':
    case 'storm':
      if (state.mapTools) state.mapTools.setTool(null);
      if (state._syncToolButtons) state._syncToolButtons();
      break;
    case 'xsect':
      if (state.xsect) state.xsect.close();
      break;
    case 'inspect':
      if (state.inspect) toggleInspect(false);
      break;
  }
}

// Disarm whatever modal tool is currently active, unless it is `except` (the one
// about to be armed). Call this just before turning a tool on.
function clearOtherTools(except) {
  const cur = activeModalTool();
  if (cur && cur !== except) deactivateModalTool(cur);
}

// Sample whichever data layer is active at a geographic point. Returns null
// (no layer), { out: true } (off coverage), or { main, sub } formatted strings.
function sampleActive(lat, lon, pane = 1) {
  if (pane > 1 && state.splitView && state.splitView.sampleAt)
    return state.splitView.sampleAt(pane, lat, lon);
  if (state.mode === 'satellite') return sampleSatAt(lat, lon);
  if (state.mode === 'mrms') return sampleMrmsAt(lat, lon);
  if (state.mode === 'models') return sampleModelAt(lat, lon);
  if (state.mode === 'observations') return sampleObservationAt(lat, lon);
  if (state.mode === 'outlooks') return null;
  return sampleRadarAt(lat, lon);
}

function sampleRadarAt(lat, lon) {
  return sampleRadarAtProduct(state.productId, lat, lon);
}

function sampleRadarAtProduct(productId, lat, lon) {
  const product = radarProduct(productId);
  const sweep = state.mode === 'radar' && productId !== state.productId
    ? radarSweepFor(productId)
    : (productId === state.productId ? state.shownSweep : radarSweepFor(productId));
  const site = state.shownSite;
  if (!sweep || !site || !product) return null;
  const s = sampleAt(sweep, product, lat, lon, site);
  if (!s || s.range > sweepMaxRange(sweep, product.moment)) return { out: true };
  const main = s.value == null ? 'no echo' : fmtValue(product, s.value);
  const mi = ((s.range / 1000) * 0.621371).toFixed(0);
  return { main, sub: `${product.id} · az ${s.az.toFixed(0)}° · ${mi} mi` };
}

function sampleSatAt(lat, lon) {
  if (isMirsSat(state.sat.satKey)) {
    const grid = state.sat.mirsGrid;
    if (!grid) return null;
    const p = resolveGridProduct(grid.product);
    const i = Math.round((((lon - grid.lon1) % 360) + 360) % 360 / grid.di);
    const j = Math.round((grid.lat1 - lat) / grid.dj);
    if (i < 0 || i >= grid.ni || j < 0 || j >= grid.nj) return { out: true };
    const v = grid.values[j * grid.ni + i];
    if (Number.isNaN(v) || !(v >= p.floor)) return { main: 'no data', sub: p.id };
    return { main: fmtValue(p, v), sub: p.id };
  }
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
  const i = Math.round((lon - grid.lon1) / grid.di);
  const j = Math.round((grid.lat1 - lat) / grid.dj);
  if (i < 0 || i >= grid.ni || j < 0 || j >= grid.nj) return { out: true };
  const v = grid.values[j * grid.ni + i];
  if (Number.isNaN(v) || !(v >= p.floor)) return { main: 'no data', sub: p.id };
  return { main: fmtValue(p, v), sub: p.id };
}

function updateInspect() {
  // On desktop the readout follows the mouse (handled by the mousemove handler),
  // so the centre-crosshair sampler only runs on touch layouts.
  if (!state.inspect || isDesktopPointer()) return;
  const pane = state.splitView && state.splitView.active ? state.splitView.activePane : 1;
  const activeMap = pane > 1 && state.splitView._mapForPane ? state.splitView._mapForPane(pane) : state.map;
  const c = (activeMap || state.map).getCenter();
  const r = sampleActive(c.lat, c.lng, pane);
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
    if (isMirsSat(state.sat.satKey) && MIRS_PRODUCTS[id]) {
      prod = id;
      name = MIRS_PRODUCTS[id].name;
    } else if (id.startsWith('C')) {
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
      source: sat ? sat.label.replace(/\s*\(.*\)$/, '') : 'Satellite',
      time: t ? scanFrameLabel(t) : '—',
    };
  }
  if (state.mode === 'mrms') {
    const p = MRMS_PRODUCTS[state.mrms.productId];
    const t = state.mrms.frames.find((x) => x.key === state.mrms.frameKey);
    return {
      prod: state.mrms.productId,
      name: p ? p.name : state.mrms.productId,
      source: 'MRMS',
      time: t ? scanFrameLabel(t) : '—',
    };
  }
  if (state.mode === 'models') {
    const p = MODEL_PRODUCTS[state.models.productId];
    const m = MODELS[state.models.modelKey];
    return {
      prod: state.models.productId,
      name: p ? p.name : state.models.productId,
      source: m ? m.label.split(' ')[0] : 'MODEL',
      time: `F${String(currentModelFhour()).padStart(2, '0')}`,
    };
  }
  if (state.mode === 'observations') {
    const p = OBS_PRODUCTS[state.observations.productId];
    const t = state.observations.frames.find((x) => x.key === state.observations.frameKey);
    return {
      prod: state.observations.productId,
      name: p ? p.name : state.observations.productId,
      source: 'RTMA',
      time: t ? scanFrameLabel(t) : '—',
    };
  }
  if (state.mode === 'outlooks') {
    const product = state.spc && OUTLOOKS[state.spc.product];
    const detail = state.spc && product && product.details.find((d) => d.id === state.spc.detail);
    return {
      prod: 'OUTLOOK',
      name: detail ? detail.label : (product ? product.label : 'Forecast outlook'),
      source: product ? product.label : 'Outlooks',
      time: 'active',
    };
  }
  // Radar (default) — Level II moment or Level III product.
  const p = radarProduct(state.productId);
  const t = state.volumes.find((x) => x.key === state.volumeKey);
  return {
    prod: state.productId,
    name: p ? p.name : state.productId,
    source: (!isL3Product(state.productId) && state.volume && state.volume.icao) || state.site,
    time: t ? scanFrameLabel(t) : '—',
  };
}

const BREADCRUMB_ICON = {
  radar: 'radar',
  satellite: 'satellite',
  mrms: 'layers-3',
  models: 'line-chart',
  observations: 'eye',
  outlooks: 'cloud-sun',
};
function updateDock() {
  if (!el.dockProd) return;
  const info = dockInfo();
  el.dockProd.textContent = info.prod;
  el.dockSite.textContent = info.source;
  if (el.breadcrumbText) {
    el.breadcrumbText.textContent = `${info.source} · ${info.prod}`;
    const want = BREADCRUMB_ICON[state.mode] || 'radar';
    if (el.breadcrumbIcon.dataset.icon !== want) {
      el.breadcrumbIcon.dataset.icon = want;
      el.breadcrumbIcon.innerHTML = `<i data-lucide="${want}" class="lucide sm"></i>`;
      refreshIcons();
    }
  }
  updateMobileTopBar(info);
  tickClock();
  if (state.playback && state.playback.active) return; // dock time owned by playback
  el.dockTime.textContent = info.name ? `${info.name} · ${info.time}` : info.time;
}

// Reflect the current source/site, live state and theme onto the mobile floating
// top bar (the site chip + LIVE indicator + theme toggle that replace the desktop
// command bar on phones). Reuses the same info the dock chip is built from.
function updateMobileTopBar(info = null) {
  if (!el.mtbCode) return;
  info = info || dockInfo();
  el.mtbCode.textContent = info.source;
  // In radar mode the site select carries a "CODE — City, ST" label; show the
  // city as the secondary line. Other sources have no per-site city, so fall
  // back to the product name (what that source is currently showing).
  let city = info.name || '';
  if (state.mode === 'radar' && el.siteSelect && el.siteSelect.selectedOptions[0]) {
    const parts = el.siteSelect.selectedOptions[0].textContent.split('—');
    if (parts[1]) city = parts[1].trim();
  }
  el.mtbCity.textContent = city || '—';
  // Day + time of the on-screen product (radar scan time / model forecast valid
  // time). The desktop time-bar is hidden on mobile, so this is the read-out.
  if (el.mtbTimeText) {
    const pt = productTime();
    el.mtbTimeText.textContent = pt ? fmtProductStamp(pt.time) : '—';
  }
  if (el.mtbLive) el.mtbLive.classList.toggle('is-live', !!state.live);
  if (el.mtbThemeIcon) {
    const want = state.uiTheme === 'dark' ? 'sun' : 'moon';
    if (el.mtbThemeIcon.dataset.icon !== want) {
      el.mtbThemeIcon.dataset.icon = want;
      el.mtbThemeIcon.innerHTML = `<i data-lucide="${want}" class="lucide sm"></i>`;
      refreshIcons();
    }
  }
}

const SHEET_EASE = 'cubic-bezier(.22,1,.36,1)';
let sheetCloseTimer = null;

// `kind` selects which mobile popup opens: 'products' (the dock chip — products
// for the current source + any satellite/model selection) or 'settings' (the
// gear — everything else). Desktop ignores it and shows its drawer/pager.
function openSheet(kind = 'settings') {
  if (sheetCloseTimer) { clearTimeout(sheetCloseTimer); sheetCloseTimer = null; }
  closeDockSourcePicker();
  if (mqSmallScreen.matches) {
    layoutMobileSheet();
    const products = kind === 'products';
    if (el.sheetProducts) el.sheetProducts.hidden = !products;
    if (el.sheetSettings) el.sheetSettings.hidden = products;
    if (el.sheetTitle) {
      el.sheetTitle.hidden = false;
      el.sheetTitle.textContent = products ? 'Products' : 'Settings & data';
    }
    if (el.sheetScroll) el.sheetScroll.scrollTop = 0;
  }
  const mobile = mqSmallScreen.matches;
  if (!mobile && el.sheetTitle) {
    el.sheetTitle.hidden = false;
    el.sheetTitle.textContent = 'Settings & data';
  }
  el.sheet.hidden = false;
  // Desktop settings are a sidebar drawer, so the map stays visible and usable.
  el.sheetScrim.hidden = !mobile;
  document.querySelector('.app').classList.add('sheet-open');
  // Desktop drawer: the current product's controls always lead — open on page 0.
  if (!mqSmallScreen.matches) requestAnimationFrame(() => setSheetPage(0, false));
  // Slide up from the bottom: start off-screen, then animate to rest next frame.
  el.sheet.style.transition = 'none';
  el.sheet.style.transform = mobile ? 'translateY(100%)' : 'translateX(-100%)';
  // Force a reflow so the starting transform is committed before transitioning.
  void el.sheet.offsetHeight;
  requestAnimationFrame(() => {
    el.sheet.style.transition = `transform 0.3s ${SHEET_EASE}`;
    el.sheet.style.transform = 'translateY(0)';
  });
}

function closeSheet() {
  if (el.sheet.hidden) return;
  const mobile = mqSmallScreen.matches;
  el.sheet.style.transition = `transform 0.24s ${SHEET_EASE}`;
  el.sheet.style.transform = mobile ? 'translateY(110%)' : 'translateX(-105%)';
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

// ---------------------------------------------------------------------------
// Dock source picker — the dock's source button morphs the bottom UI into a row
// of sources (radar / satellite / MRMS / models / outlook / obs) so the user can
// jump straight from, say, radar to models without opening a menu.
// ---------------------------------------------------------------------------
const DOCK_SOURCES = [
  ['radar', 'Radar', 'radar'],
  ['satellite', 'Satellite', 'satellite'],
  ['mrms', 'MRMS', 'layers-3'],
  ['models', 'Models', 'line-chart'],
  ['outlooks', 'Outlook', 'cloud-sun'],
  ['observations', 'Obs', 'eye'],
];

function setupDockSourcePicker() {
  if (!el.dockSourcePicker || !el.dockSource) return;
  el.dockSourcePicker.innerHTML = '';
  for (const [mode, label, icon] of DOCK_SOURCES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'dock-source-item';
    b.dataset.mode = mode;
    b.innerHTML = `<i data-lucide="${icon}" class="lucide sm"></i><span>${label}</span>`;
    b.addEventListener('click', () => {
      closeDockSourcePicker();
      if (state.mode !== mode) setMode(mode);
      else updateDockSourceButton();
    });
    el.dockSourcePicker.appendChild(b);
  }
  el.dockSource.addEventListener('click', toggleDockSourcePicker);
  refreshIcons();
  updateDockSourceButton();
}

// Reflect the active source on the dock's source button + picker highlight.
function updateDockSourceButton() {
  const found = DOCK_SOURCES.find((s) => s[0] === state.mode);
  if (el.dockSourceLabel) el.dockSourceLabel.textContent = found ? found[1] : 'Source';
  if (el.dockSourceIcon && el.dockSourceIcon.dataset.icon !== (found && found[2])) {
    const icon = found ? found[2] : 'radar';
    el.dockSourceIcon.dataset.icon = icon;
    el.dockSourceIcon.innerHTML = `<i data-lucide="${icon}" class="lucide sm"></i>`;
    refreshIcons();
  }
  if (el.dockSourcePicker) {
    el.dockSourcePicker.querySelectorAll('.dock-source-item')
      .forEach((b) => b.classList.toggle('active', b.dataset.mode === state.mode));
  }
}

function openDockSourcePicker() {
  if (!el.dockSourcePicker) return;
  updateDockSourceButton();
  el.dockSourcePicker.hidden = false;
  el.mobileDock.classList.add('source-picking');
  el.dockSource.classList.add('active');
}
function closeDockSourcePicker() {
  if (!el.dockSourcePicker || el.dockSourcePicker.hidden) return;
  el.dockSourcePicker.hidden = true;
  el.mobileDock.classList.remove('source-picking');
  el.dockSource.classList.remove('active');
}
function toggleDockSourcePicker() {
  if (el.dockSourcePicker && el.dockSourcePicker.hidden) openDockSourcePicker();
  else closeDockSourcePicker();
}

// ---------------------------------------------------------------------------
// Radar live / archive mode. Radar is pinned to live so the newest scan always
// shows; flipping Archive mode on stops the 60 s refresh from snapping the view
// forward so the user can step back freely. Turning it off returns to live at
// once. Non-radar sources keep their own free LIVE toggle.
// ---------------------------------------------------------------------------
function setRadarArchive(on) {
  on = !!on;
  state.radarArchive = on;
  if (el.archiveToggle) {
    el.archiveToggle.classList.toggle('active', on);
    el.archiveToggle.textContent = on ? 'ON' : 'OFF';
  }
  if (state.mode === 'radar') {
    if (on) stopLive();   // free to browse — no forced-latest, no auto-refresh
    else startLive();     // snap straight back to live
  }
  updateMobileTopBar();
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

// Fill the detail picker with the sub-options the current outlook product offers
// (e.g. the day+hazard for SPC convective, the lead window for CPC), keeping the
// controller's selection or falling back to the product's first detail.
const OUTLOOK_PRODUCT_SHORT = {
  spc_conv: 'SPC',
  spc_fire: 'FIRE',
  spc_md: 'MD',
  wpc_ero: 'ERO',
  wpc_ffg: 'FFG',
  cpc_temp: 'TEMP',
  cpc_precip: 'PCPN',
};

function outlookValue(product, detail) {
  return `${product}${OUTLOOK_LAYER_SEP}${detail}`;
}

function parseOutlookValue(value) {
  const raw = String(value || '');
  const i = raw.indexOf(OUTLOOK_LAYER_SEP);
  if (i >= 0) return { product: raw.slice(0, i), detail: raw.slice(i + 1) };
  if (state.spc) return { product: state.spc.product, detail: state.spc.detail };
  return { product: 'spc_conv', detail: OUTLOOKS.spc_conv.details[0].id };
}

function activeOutlookSelection() {
  const sv = state.splitView;
  if (sv && sv.active && sv.activePane > 1 && state.mode === 'outlooks' && sv.outlookForPane)
    return sv.outlookForPane(sv.activePane);
  return parseOutlookValue(activeProductId());
}

function routeOutlookToPane(product, detail) {
  const sv = state.splitView;
  if (!(sv && sv.active && sv.activePane > 1 && state.mode === 'outlooks')) return false;
  sv.setProduct(outlookValue(product, detail));
  buildOutlookProductButtons();
  buildOutlookDetailList();
  buildOutlookLegend();
  saveSettings();
  return true;
}

function buildOutlookProductButtons() {
  el.productButtons.innerHTML = '';
  el.productButtons.className = 'product-grid outlook-product-grid';
  if (!state.spc) {
    el.productButtons.innerHTML = '<div class="empty">Loading outlooks...</div>';
    return;
  }
  for (const id of OUTLOOK_ORDER) {
    const product = OUTLOOKS[id];
    const btn = document.createElement('button');
    btn.className = 'product-btn';
    btn.dataset.id = id;
    btn.innerHTML = `<span class="pb-id">${OUTLOOK_PRODUCT_SHORT[id] || id}</span><span class="pb-name">${product.label}</span>`;
    const active = id === activeOutlookSelection().product;
    if (active) btn.classList.add('active');
    btn.setAttribute('aria-pressed', String(active));
    btn.title = `Show ${product.label}`;
    btn.addEventListener('click', () => selectOutlookProduct(id));
    el.productButtons.appendChild(btn);
  }
}

function buildOutlookDetailList() {
  if (state.mode !== 'outlooks') return;
  const list = el.outlookDetailList;
  if (!list) return;
  list.className = 'vol-list scroll outlook-detail-list';
  list.innerHTML = '';
  if (!state.spc) {
    list.innerHTML = '<div class="empty">Loading outlooks...</div>';
    return;
  }
  const sel = activeOutlookSelection();
  const ax = state.spc.axesForProduct(sel.product);
  // Two-axis products (SPC convective): a Day group and a Product group, so the
  // day and hazard product can be switched independently.
  if (ax) {
    const { day, type } = ax.split(sel.detail);
    const group = (label, items, activeId, onPick) => {
      const head = document.createElement('div');
      head.className = 'vol-group-label';
      head.textContent = label;
      list.appendChild(head);
      for (const it of items) {
        const btn = document.createElement('button');
        btn.className = 'vol-btn';
        const active = it.id === activeId;
        if (active) btn.classList.add('active');
        btn.setAttribute('aria-pressed', String(active));
        btn.innerHTML = `<span class="dot"></span>${it.label}`;
        btn.addEventListener('click', () => onPick(it.id));
        list.appendChild(btn);
      }
    };
    group(ax.primaryLabel, ax.days(), day, selectOutlookDay);
    group(ax.secondaryLabel, ax.types(day), type, selectOutlookType);
    return;
  }
  for (const d of state.spc.detailsForProduct(sel.product)) {
    const btn = document.createElement('button');
    btn.className = 'vol-btn';
    const active = d.id === sel.detail;
    if (active) btn.classList.add('active');
    btn.setAttribute('aria-pressed', String(active));
    btn.innerHTML = `<span class="dot"></span>${d.label}`;
    btn.addEventListener('click', () => selectOutlookDetail(d.id));
    list.appendChild(btn);
  }
}

function buildOutlookLegend() {
  if (!el.legend) return;
  el.legend.className = 'legend spc-legend';
  el.legend.innerHTML = (state.spc && state.spc._legendHTML) || '<div class="empty">No outlook loaded.</div>';
  updateSplitPaneChrome();
}

function selectOutlookProduct(id) {
  if (!state.spc || !OUTLOOKS[id]) return;
  const cur = activeOutlookSelection();
  const details = state.spc.detailsForProduct(id);
  const detail = details.some((d) => d.id === cur.detail) ? cur.detail : details[0].id;
  if (routeOutlookToPane(id, detail)) return;
  state.spc.setProduct(id);
  if (el.outlookSelect) el.outlookSelect.value = state.spc.product;
  populateOutlookDetails();
  buildOutlookProductButtons();
  buildOutlookDetailList();
  if (state.mode === 'outlooks') enterOutlookSourceMode(false);
  saveSettings();
}

function selectOutlookDetail(id) {
  if (!state.spc) return;
  const cur = activeOutlookSelection();
  if (routeOutlookToPane(cur.product, id)) return;
  state.spc.setDetail(id);
  if (el.outlookDetail) el.outlookDetail.value = state.spc.detail;
  buildOutlookDetailList();
  if (state.mode === 'outlooks') enterOutlookSourceMode(false);
  saveSettings();
}

function selectOutlookDay(dayId) {
  if (!state.spc) return;
  const cur = activeOutlookSelection();
  if (state.mode === 'outlooks') {
    const ax = state.spc.axesForProduct(cur.product);
    if (ax) {
      const split = ax.split(cur.detail);
      const types = ax.types(dayId);
      const type = types.some((t) => t.id === split.type) ? split.type : types[0].id;
      if (routeOutlookToPane(cur.product, ax.join(dayId, type))) return;
    }
  }
  state.spc.setDay(dayId);
  populateOutlookDetails();
  buildOutlookDetailList();
  if (state.mode === 'outlooks') enterOutlookSourceMode(false);
  saveSettings();
}

function selectOutlookType(typeId) {
  if (!state.spc) return;
  const cur = activeOutlookSelection();
  if (state.mode === 'outlooks') {
    const ax = state.spc.axesForProduct(cur.product);
    if (ax) {
      const split = ax.split(cur.detail);
      if (routeOutlookToPane(cur.product, ax.join(split.day, typeId))) return;
    }
  }
  state.spc.setType(typeId);
  populateOutlookDetails();
  buildOutlookDetailList();
  if (state.mode === 'outlooks') enterOutlookSourceMode(false);
  saveSettings();
}

function enterOutlookSourceMode(reload = true) {
  if (!state.spc) return;
  if (!state._outlookSourceForced) {
    state._outlookSourcePrevOn = !!state.spc.enabled;
    state._outlookSourceForced = true;
  }
  clearRadarSource(state.map);
  drawRings(null, 0);
  setToggleBtn(el.spcToggle, true);
  if (!state.spc.enabled) state.spc.setEnabled(true);
  else if (reload) state.spc.load();
  buildOutlookProductButtons();
  buildOutlookDetailList();
  buildOutlookLegend();
  updateDock();
}

function leaveOutlookSourceMode() {
  if (!state.spc || !state._outlookSourceForced) return;
  const restore = !!state._outlookSourcePrevOn;
  state._outlookSourceForced = false;
  state._outlookSourcePrevOn = null;
  setToggleBtn(el.spcToggle, restore);
  state.spc.setEnabled(restore);
}

function refreshOutlookSource() {
  if (!state.spc) return;
  enterOutlookSourceMode();
  setStatus('loading outlook...', true);
}

function populateOutlookDetails() {
  const sel = el.outlookDetail;
  if (!sel) return;
  const ax = state.spc.axesForProduct(state.spc.product);
  // Two-axis products (SPC convective): a Day select plus a product/type select
  // sharing the "Detail" control. Everything else keeps the single flat list.
  if (ax) {
    const { day, type } = ax.split(state.spc.detail);
    if (el.outlookDay) {
      el.outlookDay.innerHTML = '';
      for (const d of ax.days()) {
        const o = document.createElement('option');
        o.value = d.id;
        o.textContent = d.label;
        el.outlookDay.appendChild(o);
      }
      el.outlookDay.value = day;
    }
    if (el.outlookDayField) el.outlookDayField.hidden = false;
    sel.innerHTML = '';
    for (const t of ax.types(day)) {
      const o = document.createElement('option');
      o.value = t.id;
      o.textContent = t.label;
      sel.appendChild(o);
    }
    sel.value = type;
    if (el.outlookDetailLabel) el.outlookDetailLabel.textContent = ax.secondaryLabel;
    return;
  }
  if (el.outlookDayField) el.outlookDayField.hidden = true;
  if (el.outlookDetailLabel) el.outlookDetailLabel.textContent = 'Detail';
  sel.innerHTML = '';
  for (const d of state.spc.detailsForProduct(state.spc.product)) {
    const o = document.createElement('option');
    o.value = d.id;
    o.textContent = d.label;
    sel.appendChild(o);
  }
  sel.value = state.spc.detail;
}

// Push the user's outlook opacity onto the live GL layers. The fill takes it
// directly; the CIG hatch scales from its 0.85 default so the hatch dims with the
// fill but stays readable. The risk-area outline is left at full opacity so the
// boundaries read even when the shading is faint. Safe to call before the layers
// exist; setupOverlays already bakes state.spcOpacity into the layers it (re)adds
// on each basemap swap, so this is mainly the live response to the slider.
function applyOutlookOpacity() {
  const map = state.map;
  if (!map || !map.getLayer) return;
  const o = state.spcOpacity;
  if (map.getLayer('spc-outlook-fill')) map.setPaintProperty('spc-outlook-fill', 'fill-opacity', o);
  if (map.getLayer('spc-outlook-cig'))
    map.setPaintProperty('spc-outlook-cig', 'fill-opacity', Math.min(1, (o / 0.3) * 0.85));
  if (map.getLayer('ffg-outlook')) map.setPaintProperty('ffg-outlook', 'raster-opacity', o);
}

// Drive the Flash Flood Guidance mosaic image overlay (the one "raster" outlook
// product) onto the map. `cfg = { tiles }` (re)creates the source+layer; `null`
// removes it. It sits at the data anchor — under the radar and alerts, like the
// vector outlook fill. Rebuilt on each call so a 1/3/6-hr switch just swaps tiles.
// If the style isn't ready (mid basemap swap), the controller's reapply() re-runs
// this once the new style loads.
function setOutlookRasterOverlay(cfg) {
  const map = state.map;
  const SRC = 'ffg-outlook', LYR = 'ffg-outlook';
  if (!map) return;
  // The style may still be loading when the FFG product is selected (fresh boot,
  // or a mode/basemap switch mid-flight). Adding a source/layer before the style
  // is ready throws and silently drops the overlay — which was the visible
  // symptom of "FFG never shows". Defer to the next style load and re-run once,
  // instead of returning and waiting for some other event to rebuild it.
  if (!map.isStyleLoaded || !map.isStyleLoaded()) {
    map.once('idle', () => setOutlookRasterOverlay(cfg));
    return;
  }
  if (map.getLayer(LYR)) map.removeLayer(LYR);
  if (map.getSource(SRC)) map.removeSource(SRC);
  if (!cfg) return;
  const opacity = Number.isFinite(state.spcOpacity) ? state.spcOpacity : 0.3;
  map.addSource(SRC, {
    type: 'raster',
    tiles: [cfg.tiles],
    tileSize: 256,
    scheme: 'xyz',
    attribution: 'NWS RFC Flash Flood Guidance',
  });
  // Anchor beneath the vector outlook fill so the mosaic sits at the very bottom
  // of the data overlays — the radar, alerts and boundaries all read on top.
  const below = map.getLayer('spc-outlook-fill') ? 'spc-outlook-fill' : dataLayerAnchor(map);
  map.addLayer(
    { id: LYR, type: 'raster', source: SRC, paint: { 'raster-opacity': opacity, 'raster-fade-duration': 180 } },
    below
  );
}

// Reflect state.spcOpacity on the slider + its readout (used at init and restore).
function syncOutlookOpacityUI() {
  if (el.spcOpacity) el.spcOpacity.value = String(Math.round(state.spcOpacity * 100));
  if (el.spcOpacityVal) el.spcOpacityVal.textContent = `${Math.round(state.spcOpacity * 100)}%`;
}

// Wire the outlook controller to its panel: ON/OFF toggle, product + detail
// pickers, opacity, and persistence of all four across sessions.
function setupSpcOutlook() {
  state.spc = new OutlookController(state.map, {
    productSelect: el.outlookSelect,
    detailSelect: el.outlookDetail,
    legend: el.spcLegend,
    status: el.spcStatus,
    // Flash Flood Guidance is a raster image mosaic, not vector polygons.
    setRasterOverlay: setOutlookRasterOverlay,
    // Mesoscale-discussion click-through reuses the alert popup/briefing chrome.
    previewWrap: el.alertPreview,
    previewCard: el.alertPreviewCard,
    detailWrap: el.alertDetail,
    detailPanel: el.alertDetailPanel,
    closeBtn: el.alertClose,
    // Briefing chrome resizes the map area; cover the split/quad panes too.
    resizeMaps: () => {
      if (state.map) state.map.resize();
      if (state.splitView && state.splitView.getMaps)
        for (const m of state.splitView.getMaps()) m.resize();
    },
    alertController: () => state.alerts,
    extraLegend: () => state.mode === 'outlooks' ? el.legend : null,
    extraStatus: (text) => {
      if (state.mode !== 'outlooks') return;
      const product = OUTLOOKS[state.spc.product];
      setStatus(text || `${product ? product.label : 'Outlook'} loaded`);
    },
    onData: () => {
      if (state.splitView && state.splitView.active && state.splitView.setOutlookData)
        state.splitView.setOutlookData((state.spc && state.spc._last) || null);
      renderLayerStack();
    },
    // Keep MD and alert views mutually exclusive (they share the same chrome).
    closeAlerts: () => { if (state.alerts) { state.alerts.closePreview(); state.alerts.closeDetail(); } },
    suppressClick: () => clickConsumingToolActive(),
  });
  state.spc.wireMap();
  // Restore saved product/detail before building the pickers and applying state.
  state.spc.product = OUTLOOKS[state._spc.product] ? state._spc.product : 'spc_conv';
  const dets = state.spc.detailsForProduct(state.spc.product);
  state.spc.detail = dets.some((d) => d.id === state._spc.detail) ? state._spc.detail : dets[0].id;
  if (el.outlookSelect) {
    el.outlookSelect.innerHTML = '';
    for (const id of OUTLOOK_ORDER) {
      const o = document.createElement('option');
      o.value = id;
      o.textContent = OUTLOOKS[id].label;
      el.outlookSelect.appendChild(o);
    }
    el.outlookSelect.value = state.spc.product;
  }
  populateOutlookDetails();
  setToggleBtn(el.spcToggle, state._spc.on);
  if (state._spc.on) state.spc.setEnabled(true);

  if (el.spcToggle) {
    el.spcToggle.addEventListener('click', () => {
      const on = !el.spcToggle.classList.contains('active');
      if (state.mode === 'outlooks' && !on) {
        setToggleBtn(el.spcToggle, true);
        if (!state.spc.enabled) state.spc.setEnabled(true);
        setStatus('Outlook source keeps outlooks visible');
        return;
      }
      setToggleBtn(el.spcToggle, on);
      state.spc.setEnabled(on);
      setStatus(on ? `${OUTLOOKS[state.spc.product].label} outlook on` : 'Outlook off');
      saveSettings();
    });
  }
  if (el.outlookSelect) {
    el.outlookSelect.addEventListener('change', () => {
      selectOutlookProduct(el.outlookSelect.value);
    });
  }
  if (el.outlookDay) {
    el.outlookDay.addEventListener('change', () => {
      selectOutlookDay(el.outlookDay.value);
    });
  }
  if (el.outlookDetail) {
    el.outlookDetail.addEventListener('change', () => {
      const ax = state.spc.axesForProduct(activeOutlookSelection().product);
      if (ax) selectOutlookType(el.outlookDetail.value);
      else selectOutlookDetail(el.outlookDetail.value);
    });
  }
  syncOutlookOpacityUI();
  applyOutlookOpacity();
  if (el.spcOpacity) {
    el.spcOpacity.addEventListener('input', () => {
      state.spcOpacity = Math.max(0.05, Math.min(0.9, (Number(el.spcOpacity.value) || 30) / 100));
      if (el.spcOpacityVal) el.spcOpacityVal.textContent = `${Math.round(state.spcOpacity * 100)}%`;
      applyOutlookOpacity();
      saveSettings();
    });
  }
  if (state.mode === 'outlooks') {
    buildOutlookProductButtons();
    buildOutlookDetailList();
    enterOutlookSourceMode();
  }
}

// ---------------------------------------------------------------------------
// Collapsible sidebar panels — every section header becomes a click target that
// folds its body away (chevron in CSS), so the sidebar reads as a short list of
// headings instead of a wall of controls. The rarely-touched sections start
// collapsed; each panel's state is persisted. The same DOM nodes move into the
// mobile sheet pages, so the behaviour carries over there for free.
// ---------------------------------------------------------------------------
const COLLAPSIBLE_PANELS = [
  // [panel id, collapsed by default]
  ['sourcePanel', false],
  ['layoutPanel', true],
  ['layerPanel', true],
  ['productPanel', false],
  ['mesoPanel', false],
  ['tiltPanel', false],
  ['fhourPanel', false],
  ['outlookDetailPanel', false],
  ['alertsPanel', false],
  ['cyclonesPanel', true],
  ['lsrPanel', true],
];

function setupCollapsiblePanels() {
  for (const [id, defCollapsed] of COLLAPSIBLE_PANELS) {
    const panel = el[id] || document.getElementById(id);
    if (!panel) continue;
    const title = panel.querySelector('.panel-title');
    if (!title) continue;
    title.classList.add('collapsible');
    const stored = state.panelCollapsed[id];
    panel.classList.toggle('collapsed', typeof stored === 'boolean' ? stored : defCollapsed);
    title.addEventListener('click', (e) => {
      // Clicks on a control inside the header (ON/OFF toggles) act on the
      // control, not the fold — but do reveal a collapsed panel's body so the
      // result of flipping the toggle is never hidden.
      if (e.target.closest('button')) {
        if (panel.classList.contains('collapsed')) {
          panel.classList.remove('collapsed');
          state.panelCollapsed[id] = false;
          saveSettings();
        }
        return;
      }
      const collapsed = !panel.classList.contains('collapsed');
      panel.classList.toggle('collapsed', collapsed);
      state.panelCollapsed[id] = collapsed;
      saveSettings();
    });
  }
}

// Pull the settings popup's pinned "quick settings" fields (layer opacity,
// smoothing, and the dealias/METAR/rings overlay switches) out of whichever
// panel they're natively defined in (Product / Display / Map settings) and
// into #quickSettings, which sits above the collapsible "more settings" body
// on both mobile and desktop. Same elements, same listeners — just relocated,
// so nothing needs to be re-wired here.
function layoutQuickSettings() {
  if (!el.quickSettings) return;
  el.quickSettings.append(
    el.overlayOpacityField,
    el.smoothField,
    el.dealiasField,
    el.radarResolutionField,
    el.metarsField,
    // The METAR overlay's controls (station limit / size / category key) sit
    // directly under their toggle, in Settings, rather than floating on the map.
    el.metarControls,
    el.ringsField
  );
}

// Mobile: distribute the control panels into the two single-scroll popups.
//
// The Products popup (#sheetProducts) shows only the products for the current
// source — plus the satellite/model selection UI (with model runs) for the
// sources that have no map dots to switch. Everything else goes in the Settings
// popup (#sheetSettings) as one continuous vertical scroll, replacing the old
// horizontal swipe carousel (which made scrolling awkward). The same id-backed
// DOM nodes are moved, so all wiring/state is intact.
//
// Every mobile panel is placed exactly once here, so neither popup is ever left
// with a stranded panel from a previous mode.
function layoutMobileSheet() {
  if (!el.sheetProducts) return;
  layoutQuickSettings();
  const mode = state.mode;
  const prod = el.sheetProducts;
  const set = el.sheetSettings;
  // Radar/MRMS/observations switch site/domain from the map, so their popup is
  // just the product grid; satellite and models have no dots, so their selection
  // UI (satellite/sector, model/storm + model runs) rides in the popup too.
  const sourceInProducts = mode === 'satellite' || mode === 'models';

  if (sourceInProducts) prod.append(el.sourcePanel);
  if (mode === 'models') prod.append(el.volumePanel); // model runs
  prod.append(el.productPanel);
  if (mode === 'observations') prod.append(el.mesoPanel);
  if (mode === 'outlooks') prod.append(el.spcPanel, el.outlookDetailPanel);

  set.append(el.quickSettings);
  if (!sourceInProducts) set.append(el.sourcePanel);
  set.append(el.tiltPanel, el.fhourPanel);
  if (mode !== 'models') set.append(el.volumePanel);
  set.append(el.layoutPanel, el.layerPanel, el.displayPanel, el.satOptsPanel);
  set.append(el.alertsPanel, el.cyclonesPanel, el.lsrPanel, el.basemapPanel);
  if (mode !== 'outlooks') set.append(el.spcPanel, el.outlookDetailPanel);
  set.append(el.metaPanel);

  // Mobile has no sidebar and no swipe carousel — keep the "more settings" body
  // expanded and the tabs out of the way (they're desktop-only now).
  setMoreSettingsCollapsed(false);
}

// Desktop: the core controls live directly in the sidebar (everything has a
// home, nothing is tucked behind a tap) — only the overflow stuff (scan
// browsing, display toggles, map/outlook settings, metadata) goes in the
// settings drawer, which reuses the same sheet/page machinery as mobile.
function layoutDesktopSidebar() {
  layoutQuickSettings();
  // .append() moves each node to the end, in order — the settings button and
  // footer note must be included here too (last) or they'd get stranded
  // above whichever of these panels happens to already sit below them.
  // Layout switch / layer editor / tropical cyclones live in the settings
  // drawer's "more settings" area on desktop (layoutDesktopDrawer), not the
  // sidebar, which only shows Source (site picker only — its mode switch and
  // heading are hidden in favour of the top command bar), Elevation tilt,
  // Product and Active alerts, per the redesign.
  el.sidebar.append(
    el.sourcePanel, el.layoutPanel, el.layerPanel, el.tiltPanel, el.fhourPanel,
    el.productPanel, el.mesoPanel, el.outlookDetailPanel, el.alertsPanel,
    el.settingsBtn, el.sidebarFoot
  );
  placeDesktopVolumePanel();
}
function layoutDesktopDrawer() {
  layoutQuickSettings();
  // On mobile the quick-settings block is relocated into the Settings popup
  // group; restore it as the desktop drawer's pinned first child.
  if (el.quickSettings && el.moreSettingsToggle && el.quickSettings.parentElement !== el.sheetBody) {
    el.sheetBody.insertBefore(el.quickSettings, el.moreSettingsToggle);
  }
  // One continuous settings surface in the desktop sidebar: no paging and no
  // secondary "More settings" fold.
  el.pageControls.append(
    el.volumePanel, el.displayPanel,
    el.satOptsPanel, el.cyclonesPanel, el.lsrPanel, el.basemapPanel, el.spcPanel, el.metaPanel
  );
  placeDesktopVolumePanel();
  // The sidebar already surfaces the primary controls directly — collapse the
  // rest behind "More settings" by default each time the drawer is (re)built.
  setMoreSettingsCollapsed(false);
}

// Show/hide the settings popup's secondary content (everything but the pinned
// quick-settings block). Desktop starts collapsed (the sidebar already shows
// Elevation/Product/Alerts and the popup itself shows Opacity/Smoothing/
// Overlays); mobile is always expanded since it has no other way to reach
// Product/Tilt/Source/Alerts.
function setMoreSettingsCollapsed(collapsed) {
  if (!el.moreSettingsBody) return;
  if (!mqSmallScreen.matches) collapsed = false;
  el.moreSettingsBody.classList.toggle('collapsed', collapsed);
  if (el.sheetTabs) el.sheetTabs.hidden = !mqSmallScreen.matches || collapsed;
  if (el.moreSettingsToggle) {
    // Mobile has no way to collapse it (there's nowhere else Product/Tilt/
    // Source/Alerts would live), so hide the toggle affordance there.
    el.moreSettingsToggle.hidden = true;
    el.moreSettingsToggle.setAttribute('aria-expanded', String(!collapsed));
    el.moreSettingsToggle.classList.toggle('is-collapsed', collapsed);
  }
}
function placeDesktopVolumePanel() {
  if (!el.volumePanel || mqSmallScreen.matches) return;
  if (state.mode === 'models') {
    if (el.volumePanel.parentElement !== el.sidebar) {
      el.sidebar.insertBefore(el.volumePanel, el.fhourPanel || el.alertsPanel || el.settingsBtn);
    } else if (el.fhourPanel && el.volumePanel.nextElementSibling !== el.fhourPanel) {
      el.sidebar.insertBefore(el.volumePanel, el.fhourPanel);
    }
  } else if (el.volumePanel.parentElement !== el.pageControls) {
    el.pageControls.append(el.volumePanel);
  }
}
function setSheetTabLabels(a, b, c) {
  if (!el.sheetTabs) return;
  const tabs = el.sheetTabs.querySelectorAll('.sheet-tab');
  if (tabs[0]) tabs[0].textContent = a;
  if (tabs[1]) tabs[1].textContent = b;
  if (tabs[2]) tabs[2].textContent = c;
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

// Real responsive split: below ~760px the controls collapse into the bottom
// dock + swipe sheet; at or above it, a proper sidebar sits beside the map and
// only the overflow controls live behind the settings drawer (which reuses
// the same sheet component, restyled — see CSS). `mqSmallScreen` is defined
// further down and used by a few other subsystems (decode sizing, dot radius);
// referencing it here is fine since this function only runs once both have
// been declared (it's only ever called from the init path at the bottom of
// this file).
function applyResponsiveLayout() {
  const mobile = mqSmallScreen.matches;
  document.querySelector('.app').classList.toggle('mobile', mobile);
  // The dock stays visible during playback now — the scrubber lives inside it and
  // only replaces the product + play slot (see `.app.playing` CSS).
  el.mobileDock.hidden = false;
  el.sidebar.hidden = mobile;
  if (el.mobileTopBar) {
    el.mobileTopBar.hidden = !mobile;
    if (mobile) updateMobileTopBar();
  }
  if (!mobile && state._closeDockMenu) state._closeDockMenu();
  refreshSiteDots(); // dot sizes differ between desktop and touch layouts
  if (mobile) {
    closeSheet();
    layoutMobileSheet();
  } else {
    closeSheet();
    if (state.inspect) toggleInspect(false);
    // displayPanel starts as a raw sibling of .sidebar/.stage in the markup
    // (outside both the sidebar and the sheet), so checking its parent
    // reliably detects "first desktop layout pass" too, not just a
    // mobile→desktop transition. (volumePanel is NOT a safe sentinel: the
    // mode-panel pass moves it into pageControls on its own, which used to
    // make this check skip the whole desktop layout and leave every drawer
    // panel strewn inline next to the map.)
    if (el.displayPanel.parentElement !== el.pageSettings) {
      layoutDesktopSidebar();
      layoutDesktopDrawer();
      requestAnimationFrame(() => setSheetPage(state._sheetPage || 0, false));
    }
  }
  updateLayoutSwitchUI();
  // Re-evaluate the layer/product panel swap for the new breakpoint: the sidebar
  // hides the product controls when layering is on, but mobile never does, so a
  // desktop→mobile switch must un-hide them (and vice-versa).
  applyModePanels();
  refreshIcons();
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
const PLAYBACK_CONCURRENCY = CONSTRAINED_DEVICE ? 1 : 6;

// A model loop spans *every* forecast hour of the run (GFS goes hourly to F120
// then 3-hourly to F384 — 200+ frames; AI-GFS is 6-hourly to F384), and every
// frame is loaded and kept resident — no sliding window, no mid-loop re-decode
// stalls. What makes that safe is how compact each resident frame is:
//   • the fill is stored as packed 16-bit codes (prepareGridTexture packed
//     mode) — no per-frame Float32 values array, no RGBA upload buffer, no raw
//     overlay fields; the readout grid for the displayed frame is decoded from
//     the codes on demand (gridFromPackedPayload).
//   • each run's pooling factor is chosen from a fixed memory budget divided by
//     the frame count (poolGridForLoop): a 48-hour HRRR loop stays at full
//     resolution while a 200-frame global GFS run pools just enough that the
//     whole run still fits the same budget. Phones get a smaller budget.
// The decode itself is paced in **chunks**: a small batch decodes, the loop
// yields long enough for the browser to paint and reclaim the transient decode
// buffers, then the next batch starts — steady, bounded allocation instead of
// one big spike.
const MODEL_PLAYBACK_CHUNK = isSmallScreenNow() ? 2 : 6; // forecast hours decoded per batch
const MODEL_PLAYBACK_CHUNK_PAUSE = isSmallScreenNow() ? 260 : 120; // ms breather between batches (GC/paint)
// Decode concurrency within a model batch — kept modest so the transient memory of
// several in-flight GRIB decodes can't pile up the way 10 parallel lanes did.
const MODEL_PLAYBACK_CONCURRENCY = isSmallScreenNow() ? 1 : 2;
// Total bytes the resident fill codes of one model loop may occupy, across all
// of a run's frames. BYTES_PER_CELL pads the 2-byte codes for JS object/GeoJSON
// overhead so the budget errs safe.
const MODEL_LOOP_FILL_BUDGET = 512 * 1024 * 1024;
const MODEL_LOOP_FILL_BUDGET_MOBILE = 32 * 1024 * 1024;
// Long-loop contours borrow from (rather than add to) the existing playback
// budget. JSON text is conservatively counted as two bytes per character.
const MODEL_LOOP_CONTOUR_RESERVE = 32 * 1024 * 1024;
const MODEL_LOOP_CONTOUR_RESERVE_MOBILE = 8 * 1024 * 1024;
const MODEL_LOOP_BYTES_PER_CELL = 3;
// Barb/contour overlays ride along on loop frames only while they stay cheap:
// a per-frame GeoJSON feature cap (global grids blow past it — a 0.6°-stride
// global barb field is ~180k point features per frame) and a run-length cap.
// Past either, the loop shows the colored fill only; stopping the loop restores
// the full overlays via provider.idle().
const MODEL_LOOP_OVERLAY_MAX_FRAMES = isSmallScreenNow() ? 12 : 64;
const MODEL_LOOP_OVERLAY_FRAME_FEATURES = 12000;
// Playback frames are never pooled below what the GPU texture would keep anyway:
// 3600 matches gridLayer's MAX_DIM texture cap — the point past which pooling
// can no longer cost any *displayed* resolution.
const MODEL_PLAYBACK_TARGET_DIM = 3600;
const FRAME_WARM_START_DELAY = 1800;
const FRAME_WARM_IDLE_TIMEOUT = 3000;
const FRAME_WARM_FRAME_PAUSE = 220;
let frameWarmTimer = null;

function waitForFrameWarmSlot() {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(() => resolve(), { timeout: FRAME_WARM_IDLE_TIMEOUT });
    } else {
      setTimeout(resolve, FRAME_WARM_FRAME_PAUSE);
    }
  });
}

// Max-pool a model grid down by an integer factor for playback: a coarser grid
// (values + geometry) that draws and samples the same, at a fraction of the
// memory. Mirrors buildTexture's max-pool so reflectivity-type fields keep their
// peaks. factor ≤ 1 returns the grid untouched.
// The real small-screen check, also used by applyResponsiveLayout (above) to
// drive the sidebar/dock split — the 760px breakpoint mirrors the CSS
// iPad/desktop tier, so phones additionally pool grids harder to fit a
// tighter memory budget.
const mqSmallScreen = window.matchMedia(SMALL_SCREEN_QUERY);

// Pool a model grid for an all-frames-resident loop. The factor comes from the
// device's fill budget divided across the run's frame count, so total resident
// memory is bounded no matter how many forecast hours the run has — short runs
// keep native resolution, very long global runs pool a step or two coarser.
function poolGridForLoop(grid, frameCount) {
  const small = mqSmallScreen.matches;
  let budget = small ? MODEL_LOOP_FILL_BUDGET_MOBILE : MODEL_LOOP_FILL_BUDGET;
  if (frameCount > MODEL_LOOP_OVERLAY_MAX_FRAMES) {
    budget -= small ? MODEL_LOOP_CONTOUR_RESERVE_MOBILE : MODEL_LOOP_CONTOUR_RESERVE;
  }
  const budgetCells = Math.max(
    120 * 60, // quality floor — never pool below roughly a 3°-cell global grid
    Math.floor(budget / Math.max(1, frameCount) / MODEL_LOOP_BYTES_PER_CELL)
  );
  let factor = Math.ceil(Math.sqrt((grid.ni * grid.nj) / budgetCells));
  // Loops must not *look* downscaled. Lambert grids are resampled onto an
  // oversampled lat/lon target (models.js stamps `nativeDi` with the source
  // cell size), so pooling down to the model's native resolution is free —
  // but pooling past it visibly coarsens the field. On desktop, clamp the
  // budget factor so a pooled cell never grows beyond one native model cell;
  // phones keep the unclamped budget (memory there is the harder limit).
  if (!small) {
    const nativeFactor = Math.max(1, Math.floor((grid.nativeDi || grid.di) / grid.di));
    factor = Math.min(factor, nativeFactor);
  }
  // Never keep more cells than the GPU texture cap would preserve anyway.
  factor = Math.max(factor, Math.ceil(Math.max(grid.ni, grid.nj) / MODEL_PLAYBACK_TARGET_DIM));
  return poolGridByFactor(grid, factor);
}

function poolGridByFactor(grid, factor) {
  if (factor <= 1) return grid;
  const { ni, nj, values, di, dj } = grid;
  const no = Math.ceil(ni / factor);
  const mo = Math.ceil(nj / factor);
  const poolValues = (src, mode = 'max') => {
    if (!src) return null;
    const out = new Float32Array(no * mo);
    for (let oy = 0; oy < mo; oy++) {
      for (let ox = 0; ox < no; ox++) {
        let best = -Infinity;
        let sum = 0;
        let n = 0;
        for (let r = 0; r < factor; r++) {
          const sy = oy * factor + r;
          if (sy >= nj) break;
          const base = sy * ni + ox * factor;
          for (let c = 0; c < factor; c++) {
            if (ox * factor + c >= ni) break;
            const v = src[base + c];
            if (!Number.isFinite(v)) continue;
            if (mode === 'max') {
              if (v > best) best = v;
            } else {
              sum += v;
              n++;
            }
          }
        }
        out[oy * no + ox] = mode === 'max'
          ? (best === -Infinity ? NaN : best)
          : (n ? sum / n : NaN);
      }
    }
    return out;
  };
  const out = poolValues(values, 'max');
  let overlays = grid.overlays || null;
  if (overlays) {
    overlays = { ...overlays };
    for (const key of ['u', 'v', 'hgt', 'mslp', 'windSpeed']) {
      if (overlays[key]) overlays[key] = poolValues(overlays[key], 'mean');
    }
  }
  return { ...grid, ni: no, nj: mo, values: out, di: di * factor, dj: dj * factor, overlays };
}

// Retain a compact display/inspection grid after decoding on constrained
// devices. This lets the full source array be reclaimed instead of remaining
// pinned in application state beside its GPU texture.
function compactGridForConstrainedDevice(grid) {
  if (!CONSTRAINED_DEVICE || !grid || !grid.values) return grid;
  const factor = Math.ceil(Math.max(grid.ni || 0, grid.nj || 0) / CONSTRAINED_GRID_DIM);
  return factor > 1 ? poolGridByFactor(grid, factor) : grid;
}

// A short key identifying the current playback context; when it changes (site,
// product, run, sector…) the cached frames are no longer valid and are dropped.
function playbackContextKey() {
  const m = state.mode;
  // Radar frames are cached slim (one moment), so the moment is part of the
  // context: a REF loop's frames are useless to a VEL loop.
  if (m === 'radar') {
    const moment = (PRODUCTS[state.productId] && PRODUCTS[state.productId].moment) || state.productId;
    return `radar:${state.site}:${moment}`;
  }
  if (m === 'mrms') return `mrms:${state.mrms.productId}`;
  if (m === 'satellite')
    return `sat:${state.sat.satKey}:${state.sat.sectorKey}:${state.sat.conusView}:${state.sat.productId}:${state.sat.enhanceIR}`;
  if (m === 'models')
    return `models:${state.models.modelKey}:${state.models.productId}:${state.models.stormId}:${state.models.runKey}`;
  if (m === 'observations') return `obs:${state.observations.productId}`;
  return m;
}

async function buildRadarPlaybackFrames(n) {
  const current = state.volumes.slice(-n);
  if (current.length >= n) return current;

  // When the selected UTC day has started but does not yet contain enough
  // scans for the requested loop length, fill the oldest side of the loop with
  // the newest scans from the previous UTC day. The active date/list stays on
  // the user's selected day; this only affects playback assembly.
  const previousDay = new Date(state.date);
  previousDay.setUTCDate(previousDay.getUTCDate() - 1);
  try {
    const needed = n - current.length;
    const previous = (await listVolumes(state.site, previousDay)).slice(-needed);
    return previous.concat(current);
  } catch (e) {
    console.warn('previous-day playback fill failed:', e.message);
    return current;
  }
}

// Build the per-mode playback provider against the current state. `frames` are
// ordered oldest→newest; `ck` is a globally-unique cache key per frame. Every
// source loops the same user-chosen number of frames (state.playbackFrames).
async function buildPlaybackProvider(opts = {}) {
  const allFrames = !!opts.allFrames;
  const n = allFrames ? Infinity : state.playbackFrames;
  if (state.mode === 'radar') {
    // Level III products loop their own per-frame files (already in state.volumes).
    if (isL3Product(state.productId)) {
      const frames = allFrames ? state.volumes : state.volumes.slice(-n);
      return {
        frames: frames.map((v) => ({ label: v.label, time: v.time, ck: v.key, key: v.key })),
        async load(f) { return (await loadLevel3(state.site, state.productId, f.key)).decoded; },
        render(d) { displaySweep(d.sweep, { lat: d.lat, lon: d.lon }); },
        idle() { renderRadar(); },
      };
    }
    const frames = allFrames ? state.volumes : await buildRadarPlaybackFrames(n);
    // Cache slim per-product volumes, not full decodes: a loop draws exactly one
    // product, and holding every moment of every frame is what used to pin
    // hundreds of MB per loop. The full decode still passes through the shared
    // volume LRU (getDecodedVolume), so arrow-key stepping stays warm.
    const moment = (PRODUCTS[state.productId] && PRODUCTS[state.productId].moment) || 'REF';
    return {
      frames: frames.map((v) => ({ label: v.label, time: v.time, ck: v.key, key: v.key })),
      async load(f) { return slimVolumeForMoment(await getDecodedVolume(f.key), moment); },
      render(vol) { displaySweep(pickSweep(vol.sweeps), vol.site); },
      idle() { displaySweep(currentSweep(), state.volume && state.volume.site); },
    };
  }
  if (state.mode === 'mrms') {
    const frames = allFrames ? state.mrms.frames : state.mrms.frames.slice(-n);
    return {
      frames: frames.map((v) => ({ label: v.label, time: v.time, ck: v.key, key: v.key })),
      async load(f) {
        const grid = await loadMrms(state.mrms.productId, f.key);
        // Packed 16-bit codes (2 bytes/cell) instead of the RGBA upload buffer
        // (4 bytes/cell): halves every resident loop frame; the RGBA is expanded
        // into a shared scratch at upload time.
        return prepareGridTexture(grid, resolveGridProduct(grid.product), { packed: true });
      },
      render(payload) { drawMrmsPayload(payload); },
      idle() { renderMrms(); },
    };
  }
  if (state.mode === 'satellite') {
    const frames = allFrames ? state.sat.scenes : state.sat.scenes.slice(-n);
    // Microwave granules loop as prepared grid payloads (like MRMS frames).
    if (isMirsSat(state.sat.satKey)) {
      return {
        frames: frames.map((v) => ({ label: v.label, time: v.time, ck: `${state.sat.satKey}:${v.key}`, key: v.key })),
        async load(f) {
          const grid = await loadMirsGrid(state.sat.satKey, f.key, state.sat.productId);
          return prepareGridTexture(grid, resolveGridProduct(grid.product), { packed: true });
        },
        render(payload) { drawMirsPayload(payload); },
        idle() { renderSatellite(); },
      };
    }
    // A CONUS frame's prebuilt RGBA is ~15 MB, a full-disk frame ~118 MB — a
    // resident full-disk loop used to pin over half a GB. Budget the resident
    // RGBA bytes instead: once the first frame reveals the real frame size, the
    // window is sized to the budget and the loop streams through it (a window
    // at least as long as the loop behaves exactly like the old resident path,
    // so CONUS/meso loops are unchanged; only oversized loops start recycling).
    const satLoopBudget = CONSTRAINED_DEVICE ? 64e6 : 320e6;
    return {
      streaming: true,
      maxCachedFrames: 3, // conservative until the first frame sizes the budget
      prefetchAhead: 3,
      frames: frames.map((v) => ({ label: v.label, time: v.time, ck: v.key, key: v.key })),
      async load(f) {
        const scene = await loadSceneAsync(state.sat.satKey, state.sat.sectorKey, f.key, bandsFor(state.sat.productId));
        const payload = buildSatPayload(scene);
        // Playback only needs the prebuilt RGBA per frame, not the channels — drop
        // the worker's cached decode so a long loop can't pin many full-disk files.
        if (f.key !== state.sat.sceneKey) evictScene(f.key);
        if (!this._sized && payload.rgba && payload.rgba.byteLength) {
          this._sized = true;
          const fit = Math.floor(satLoopBudget / payload.rgba.byteLength);
          this.maxCachedFrames = Math.max(2, Math.min(this.frames ? this.frames.length : fit, fit));
          this.prefetchAhead = Math.max(1, Math.min(3, this.maxCachedFrames - 1));
        }
        return payload;
      },
      render(payload) { drawSatScene(payload.meta, payload.rgba, payload.bbox); },
      idle() { renderSatellite(); },
    };
  }
  if (state.mode === 'models') {
    const run = currentModelRun();
    if (!run) return { frames: [] };
    // Span the *entire* run — every forecast hour is loaded and stays resident,
    // so playback and scrubbing never stall on a re-decode. Each frame is kept
    // compact (see the MODEL_LOOP_* notes above): packed 16-bit fill codes at a
    // budget-driven resolution, no per-frame Float32 fields; the readout grid
    // for the displayed hour is decoded from the codes on demand. The decode is
    // paced in chunks (see createPlayback.loadInChunks) so 200+ GRIBs don't
    // slam through the decoder at once.
    const hours = forecastHours(run);
    const frameCount = hours.length;
    return {
      // Keep every decoded forecast hour resident. Per-run pooling bounds total
      // memory without discarding frames the user has already loaded.
      concurrency: MODEL_PLAYBACK_CONCURRENCY,
      chunkSize: MODEL_PLAYBACK_CHUNK,
      chunkPause: MODEL_PLAYBACK_CHUNK_PAUSE,
      frames: hours.map((fh) => ({
        label: 'F' + p2(fh),
        time: new Date(run.time.getTime() + fh * 3600 * 1000),
        ck: `${state.models.modelKey}:${state.models.productId}:${state.models.stormId || ''}:${run.key}#${fh}`,
        fhour: fh,
        modelKey: state.models.modelKey,
        productId: state.models.productId,
        run,
      })),
      async load(f) {
        const sourceGrid = await loadModel(f.modelKey, f.productId, f.run, f.fhour);
        const grid = poolGridForLoop(sourceGrid, frameCount);
        const payload = prepareGridTexture(grid, resolveGridProduct(grid.product), { packed: true });
        payload.meta = { product: grid.product, time: grid.time, fhour: f.fhour };
        // Barb/contour overlays only when the whole run can afford them: bounded
        // frame count AND a per-frame GeoJSON budget (grid geometry makes the
        // count identical for every frame of a run, so the whole loop uniformly
        // has overlays or uniformly doesn't — no mid-loop flicker).
        if (grid.overlays && frameCount <= MODEL_LOOP_OVERLAY_MAX_FRAMES) {
          const overlays = prepareModelOverlayData(grid);
          if (overlays && countOverlayFeatures(overlays) <= MODEL_LOOP_OVERLAY_FRAME_FEATURES) {
            payload.overlays = overlays;
          }
        } else if (grid.overlays) {
          // Keep contours on long runs without retaining hundreds of deep
          // GeoJSON object graphs. Only the displayed frame is materialized.
          const contours = prepareModelPlaybackContours(grid);
          if (contours && countOverlayFeatures(contours) <= MODEL_LOOP_OVERLAY_FRAME_FEATURES) {
            const json = JSON.stringify(contours);
            const reserve = isSmallScreenNow() ? MODEL_LOOP_CONTOUR_RESERVE_MOBILE : MODEL_LOOP_CONTOUR_RESERVE;
            if (json.length * 2 <= reserve / Math.max(1, frameCount)) payload.contoursJson = json;
          }
        }
        return payload;
      },
      render(payload) { drawModelPayload(payload); },
      // On stop, restore the live view at the hour the user scrubbed to
      // (state.models.fhour already tracks it via setDisplayedFhour). Promote the
      // cached frame's grid first so the coloured fill stays on screen instantly,
      // then reload that hour in full — the loop's frames carry no overlays, so
      // this brings the barb/contour overlays back. loadModelFrame() is guarded so
      // a stop caused by leaving models mode won't repaint the layer afterwards.
      idle() {
        if (state.models.displayGrid) state.models.grid = state.models.displayGrid;
        renderModels();
        loadModelFrame();
      },
    };
  }
  if (state.mode === 'observations') {
    const frames = allFrames ? state.observations.frames : state.observations.frames.slice(-n);
    return {
      frames: frames.map((v) => ({ label: v.label, time: v.time, ck: v.key, key: v.key })),
      async load(f) {
        const grid = await loadObservation(state.observations.productId, f.key);
        // Packed codes only — retaining each frame's full Float32 grid for the
        // readouts pinned ~15 MB per loop frame. The readout grid for the
        // displayed frame is decoded from the codes on demand instead (see
        // drawObservationPayload / gridFromPackedPayload).
        const payload = prepareGridTexture(grid, resolveGridProduct(grid.product), { packed: true });
        payload.meta = { product: grid.product, time: grid.time };
        return payload;
      },
      render(payload) { drawObservationPayload(payload); },
      idle() { renderObservations(); },
    };
  }
  return { frames: [] };
}

function scheduleFrameWarm() {
  // Playback frames now load only after the user opens playback. The former
  // desktop idle warmer was convenient, but it retained several decoded radar,
  // satellite, or grid frames while the app appeared idle.
  cancelFrameWarm();
}

function cancelFrameWarm() {
  if (frameWarmTimer) {
    clearTimeout(frameWarmTimer);
    frameWarmTimer = null;
  }
  if (state.playback) state.playback.warmSeq++;
}

function createPlayback() {
  return {
    active: false,
    playing: false,
    frames: [],       // { label, ck, payload, loaded, … provider fields }
    segEls: [],       // one progress segment per frame (turns green on load)
    idx: 0,
    loadedCount: 0,
    loadSeq: 0,       // invalidates an in-flight background loader on restart
    fps: 3,
    timer: null,
    cache: new Map(),
    cacheCtx: null,
    loadingIdx: new Set(),
    warming: false,
    warmSeq: 0,
    provider: null,

    async warmAll() {
      const ctx = playbackContextKey();
      const seq = ++this.warmSeq;
      try {
        const provider = await buildPlaybackProvider();
        if (!provider.frames || !provider.frames.length || this.active || this.warmSeq !== seq) return;
        if (ctx !== this.cacheCtx) { this.cache.clear(); this.cacheCtx = ctx; }
        this.warming = true;

        // Warm only the selected playback-window length, one frame at a time,
        // and yield to browser idle time between frames so panning/zooming stays
        // responsive while the cache fills.
        for (const fr of provider.frames) {
          if (this.active || this.warmSeq !== seq || playbackContextKey() !== ctx) return;
          if (this.cache.has(fr.ck)) continue;
          await waitForFrameWarmSlot();
          if (this.active || this.warmSeq !== seq || playbackContextKey() !== ctx) return;
          try {
            const payload = await provider.load(fr);
            if (this.active || this.warmSeq !== seq || playbackContextKey() !== ctx) return;
            this.cache.set(fr.ck, payload);
          } catch (e) {
            console.warn('background frame warm failed:', e.message || e);
          }
          await new Promise((r) => setTimeout(r, FRAME_WARM_FRAME_PAUSE));
        }
      } finally {
        if (this.warmSeq === seq) this.warming = false;
      }
    },

    async start() {
      if (this.active) return;
      this.warmSeq++;
      const provider = await buildPlaybackProvider();
      if (!provider.frames || !provider.frames.length) {
        setStatus('no frames to play back');
        return;
      }
      this.provider = provider;
      if (state.mode === 'models') {
        // The GPU already owns the currently displayed texture. Drop the full
        // static decode before forecast frames begin arriving so it cannot
        // overlap the streaming window and its transient GRIB decodes.
        state.models.grid = null;
        state.models.displayGrid = null;
        state.models.overlayData = null;
        packedGridMemo = { payload: null, grid: null };
      }
      this.active = true;
      el.playBtn.classList.add('active');
      if (el.loopBtn) el.loopBtn.classList.add('active');
      // The loop UI slots into the dock's product + play area (CSS hides those
      // while `.playing`); inspect + tools stay put beside the scrubber.
      if (state._closeDockMenu) state._closeDockMenu();
      el.playbackBar.hidden = false;
      el.sheetPlayback.hidden = false;
      document.querySelector('.app').classList.add('playing');
      if (state.live) toggleLive(); // freeze auto-refresh during playback

      // Drop any cache held for a different context (mode/product/run/…).
      const ctx = playbackContextKey();
      if (ctx !== this.cacheCtx) { this.cache.clear(); this.cacheCtx = ctx; }

      // Show the whole timeline immediately: every frame gets a slot and a grey
      // progress segment up front; the scrubber works as soon as a frame loads.
      this.frames = provider.frames.map((f) => ({ ...f, payload: null, loaded: false }));
      this.idx = 0;
      this.loadedCount = 0;
      this.buildProgress();
      el.playScrub.max = String(this.frames.length - 1);
      el.playScrub.value = '0';
      el.playLabel.textContent = `${scanFrameLabel(this.frames[0])} · 0/${this.frames.length} loaded`;
      el.dockTime.textContent = scanFrameLabel(this.frames[0]);
      setStatus('loading playback…', true);

      this.loadInChunks();
    },

    // Rebuild the loop in place for a changed context — e.g. the user picked a
    // different model run (19z → 18z) while a loop is running. Swap in the new
    // provider's frames and start loading them without tearing down the playback
    // chrome, so the loop switches straight over to the newly-selected run
    // instead of waiting for the user to close playback first. Falls back to a
    // fresh start() if a loop isn't actually active.
    async restart() {
      if (!this.active) return this.start();
      this.warmSeq++;
      this.loadSeq++; // cancel any in-flight loader from the old context
      this.pause();
      const provider = await buildPlaybackProvider();
      if (!provider.frames || !provider.frames.length) { this.stop(); return; }
      this.provider = provider;
      const ctx = playbackContextKey();
      if (ctx !== this.cacheCtx) { this.cache.clear(); this.cacheCtx = ctx; }
      this.frames = provider.frames.map((f) => ({ ...f, payload: null, loaded: false }));
      this.idx = 0;
      this.loadedCount = 0;
      this.loadingIdx.clear();
      this.buildProgress();
      el.playScrub.max = String(Math.max(0, this.frames.length - 1));
      el.playScrub.value = '0';
      el.playLabel.textContent = `${scanFrameLabel(this.frames[0])} · 0/${this.frames.length} loaded`;
      el.dockTime.textContent = scanFrameLabel(this.frames[0]);
      setStatus('loading playback…', true);
      this.loadInChunks();
    },

    // Build the per-frame progress segments (grey now, green as frames arrive).
    buildProgress() {
      this.segEls = [];
      if (!el.playScrubProg) return;
      el.playScrubProg.innerHTML = '';
      const frag = document.createDocumentFragment();
      for (let i = 0; i < this.frames.length; i++) {
        const seg = document.createElement('div');
        seg.className = 'seg';
        frag.appendChild(seg);
        this.segEls.push(seg);
      }
      el.playScrubProg.appendChild(frag);
    },

    // Load every frame, keeping them all resident, but pace the work in chunks so
    // a long run can't spike memory and crash the tab. Each chunk decodes up to
    // `chunkSize` frames with bounded concurrency; between chunks the loop waits
    // `chunkPause` ms so the browser can paint and reclaim the transient decode
    // buffers before the next batch. Sources that set no chunkSize/chunkPause
    // (radar/MRMS/satellite) load in one pass with no pause — unchanged behaviour.
    async loadInChunks() {
      const provider = this.provider;
      const total = this.frames.length;
      const loadTotal = provider.streaming
        ? Math.min(total, Math.max(1, provider.prefetchAhead || provider.maxCachedFrames || total))
        : total;
      const seq = ++this.loadSeq;
      const lanes = Math.min(provider.concurrency || PLAYBACK_CONCURRENCY, loadTotal);
      const chunk = Math.max(lanes, provider.chunkSize || loadTotal);
      const pause = provider.chunkPause || 0;

      for (let start = 0; start < loadTotal; start += chunk) {
        if (!this.active || this.loadSeq !== seq) return; // bailed / restarted
        const end = Math.min(start + chunk, loadTotal);
        let next = start;
        const worker = async () => {
          while (this.active && this.loadSeq === seq) {
            const i = next++;
            if (i >= end) return;
            await this.loadOne(i, seq);
          }
        };
        await Promise.all(Array.from({ length: Math.min(lanes, end - start) }, worker));
        if (end < total && pause && this.active && this.loadSeq === seq) {
          await new Promise((r) => setTimeout(r, pause));
        }
      }

      if (!this.active || this.loadSeq !== seq) return;
      if (!this.loadedCount) { setStatus('playback unavailable'); this.stop(); return; }
      setStatus(provider.streaming
        ? `playback streaming · ${this.frames.length} frames`
        : `playback · ${this.loadedCount}/${total} frames`);
    },

    // Decode (or reuse from cache) a single frame, then mark it loaded and let the
    // playback loop pick it up. Errors are logged and skipped so one bad hour can't
    // stall the whole run.
    async loadOne(i, seq) {
      const fr = this.frames[i];
      if (!fr || this.loadingIdx.has(i)) return;
      this.loadingIdx.add(i);
      let payload = this.cache.get(fr.ck);
      if (!payload) {
        try {
          payload = await this.provider.load(fr);
        } catch (e) {
          console.error(e);
          this.loadingIdx.delete(i);
          return;
        }
        if (!this.active || this.loadSeq !== seq) { this.loadingIdx.delete(i); return; } // bailed / restarted
        this.cache.set(fr.ck, payload);
      }
      if (!this.active || this.loadSeq !== seq) { this.loadingIdx.delete(i); return; }
      this.loadingIdx.delete(i);
      const wasLoaded = fr.loaded;
      fr.payload = payload;
      fr.loaded = true;
      if (!wasLoaded) this.loadedCount++;
      if (this.segEls[i]) this.segEls[i].classList.add('loaded');
      this.onFrameLoaded(i);
      this.evictForLimit();
    },

    // React to a frame finishing: display the first one and start looping; for
    // later frames, just refresh the "still loading" count when paused.
    onFrameLoaded(i) {
      if (this.loadedCount === 1) {
        // First frame available — display it and begin looping the loaded set.
        this.idx = i;
        el.playScrub.value = String(i);
        this.renderFrame();
        this.play();
      } else if (i === this.idx) {
        this.renderFrame();
      } else if (!this.playing) {
        const f = this.frames[this.idx] || this.frames[0];
        el.playLabel.textContent = `${scanFrameLabel(f)} · ${this.loadedCount}/${this.frames.length} loaded`;
      }
    },

    // The next loaded frame index after `from` (circular); -1 if none loaded.
    nextLoaded(from) {
      const n = this.frames.length;
      for (let step = 1; step <= n; step++) {
        const j = (from + step) % n;
        if (this.frames[j].loaded) return j;
      }
      return -1;
    },

    // The loaded frame nearest to index `i` (searching outward); -1 if none.
    nearestLoaded(i) {
      const n = this.frames.length;
      if (this.frames[i] && this.frames[i].loaded) return i;
      for (let d = 1; d < n; d++) {
        if (i - d >= 0 && this.frames[i - d].loaded) return i - d;
        if (i + d < n && this.frames[i + d].loaded) return i + d;
      }
      return -1;
    },

    circularDistance(a, b) {
      const n = this.frames.length || 1;
      const d = Math.abs(a - b);
      return Math.min(d, n - d);
    },

    evictForLimit() {
      const limit = this.provider && this.provider.maxCachedFrames;
      if (!limit || this.loadedCount <= limit) return;
      const n = this.frames.length || 1;
      const candidates = this.frames
        // In a streaming loop, an index just behind the current frame has a
        // large forward distance; evict those consumed frames before any of the
        // prefetched frames immediately ahead.
        .map((f, i) => ({ f, i, d: (i - this.idx + n) % n }))
        .filter((x) => x.f.loaded && x.i !== this.idx)
        .sort((a, b) => b.d - a.d);
      for (const { f, i } of candidates) {
        if (this.loadedCount <= limit) break;
        this.cache.delete(f.ck);
        f.payload = null;
        f.loaded = false;
        this.loadedCount--;
        if (this.segEls[i]) this.segEls[i].classList.remove('loaded');
      }
    },

    prefetchAhead() {
      if (!this.provider || !this.provider.streaming || !this.frames.length) return;
      const ahead = Math.min(this.provider.prefetchAhead || 0, this.frames.length - 1);
      const seq = this.loadSeq;
      for (let step = 1; step <= ahead; step++) {
        if (this.loadingIdx.size >= (this.provider.concurrency || PLAYBACK_CONCURRENCY)) break;
        const i = (this.idx + step) % this.frames.length;
        const fr = this.frames[i];
        if (!fr || fr.loaded || this.loadingIdx.has(i)) continue;
        this.loadOne(i, seq);
      }
    },

    play() {
      if (!this.frames.length) return;
      this.playing = true;
      el.playToggle.textContent = '⏸';
      clearInterval(this.timer);
      this.timer = setInterval(() => {
        if (this.provider && this.provider.streaming) {
          const j = (this.idx + 1) % this.frames.length;
          if (!this.frames[j] || !this.frames[j].loaded) {
            this.loadOne(j, this.loadSeq);
            this.prefetchAhead();
            return;
          }
          this.idx = j;
          el.playScrub.value = String(this.idx);
          this.renderFrame();
          return;
        }
        const j = this.nextLoaded(this.idx);
        if (j < 0) return; // nothing loaded yet — wait
        this.idx = j;
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

    // Scrub to a frame. Frames load in order and stay resident, so a frame ahead
    // of the loaded set isn't renderable yet — snap to the nearest loaded one (and
    // reflect that on the slider) until the chunked loader reaches it.
    seek(i) {
      if (!this.frames.length) return;
      this.pause();
      i = Math.max(0, Math.min(this.frames.length - 1, i | 0));
      if (!this.frames[i] || !this.frames[i].loaded) {
        this.idx = i;
        el.playScrub.value = String(i);
        el.playLabel.textContent = `${scanFrameLabel(this.frames[i])} · ${this.loadedCount}/${this.frames.length} loaded`;
        this.loadOne(i, this.loadSeq);
        if (this.provider && this.provider.streaming) this.prefetchAhead();
        return;
      }
      const j = this.nearestLoaded(i);
      if (j < 0) return;
      this.idx = j;
      el.playScrub.value = String(j);
      this.renderFrame();
    },

    setFps(f) {
      this.fps = f;
      if (this.playing) this.play();
    },

    renderFrame() {
      const f = this.frames[this.idx];
      if (!f || !f.loaded || !this.provider) return;
      this.provider.render(f.payload);
      // Models: the displayed forecast hour is now the source of truth for the
      // picker, dock and any sounding opened mid-loop.
      if (state.mode === 'models') setDisplayedFhour(f.fhour);
      const suffix = this.loadedCount < this.frames.length
        ? ` · ${this.loadedCount}/${this.frames.length} loaded` : '';
      el.playLabel.textContent = `${this.idx + 1}/${this.frames.length} · ${scanFrameLabel(f)}${suffix}`;
      el.dockTime.textContent = scanFrameLabel(f);
      tickClock();
      this.prefetchAhead();
      this.evictForLimit();
    },

    stop() {
      this.pause();
      this.active = false;
      this.loadSeq++; // cancel any in-flight background loader
      const provider = this.provider;
      this.frames = [];
      this.segEls = [];
      this.loadedCount = 0;
      this.loadingIdx.clear();
      if (el.playScrubProg) el.playScrubProg.innerHTML = '';
      el.playBtn.classList.remove('active');
      if (el.loopBtn) el.loopBtn.classList.remove('active');
      el.playbackBar.hidden = true;
      el.sheetPlayback.hidden = true;
      // Dropping `.playing` re-shows the product chip + dock play button that the
      // scrubber stood in for; the dock itself stayed visible throughout.
      document.querySelector('.app').classList.remove('playing');
      // Playback is an on-demand working set; release it on every device as soon
      // as the loop closes so the idle app returns to its baseline footprint.
      this.cache.clear();
      this.cacheCtx = null;
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
  updateRadarResolutionUI();
  if (isL3Product(state.productId)) {
    const d = state.l3.decoded;
    const t = state.volumes.find((x) => x.key === state.volumeKey);
    el.meta.innerHTML = d
      ? `<div class="meta-row"><span>Radar</span><b>${state.site}</b></div>
         <div class="meta-row"><span>Product</span><b>${radarProduct().name}</b></div>
         <div class="meta-row"><span>Frame time</span><b>${t ? t.label : '—'}</b></div>
         <div class="meta-row"><span>Radials</span><b>${d.sweep.radials.length}</b></div>
         <div class="meta-row"><span>Site lat/lon</span><b>${d.lat.toFixed(3)}, ${d.lon.toFixed(3)}</b></div>`
      : '<div class="empty">No frame loaded.</div>';
    return;
  }
  const v = state.volume;
  const sw = currentSweep();
  if (!v) {
    el.meta.innerHTML = '<div class="empty">No volume loaded.</div>';
    return;
  }
  const t = state.volumes.find((x) => x.key === state.volumeKey);
  const site = v.site;
  const product = PRODUCTS[state.productId];
  const resolution = product ? describeSweepResolution(sw, product.moment) : null;
  const resolutionText = resolution && resolution.available
    ? (isLegacyResolution(state.productId) && resolution.superResolution
      ? `Legacy view ${resolutionLabel(resolution.targetAzimuthSpacing, resolution.targetGateSpacing)}`
      : `${resolution.legacyEnough ? 'Native legacy' : 'Native super-res'} ${resolutionLabel(
        resolution.azimuthSpacing, resolution.gateSpacing
      )}`)
    : 'n/a';
  el.meta.innerHTML = `
    <div class="meta-row"><span>Radar</span><b>${v.icao || state.site}</b></div>
    <div class="meta-row"><span>Level II format</span><b>Message ${v.messageType || 'n/a'}</b></div>
    <div class="meta-row"><span>Resolution</span><b>${resolutionText}</b></div>
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
function updateReadout(latlng, point, pane = 1) {
  const r = sampleActive(latlng.lat, latlng.lng, pane);
  if (!r || r.out) {
    el.readout.classList.remove('show');
    return;
  }
  el.readout.innerHTML = `<b>${r.main}</b><span>${r.sub}</span>`;
  // Anchor the readout just above-right of the cursor when we have a pixel point
  // (desktop inspect); otherwise fall back to the fixed top-centre banner.
  if (point) {
    el.readout.classList.add('at-cursor');
    el.readout.style.left = `${point.x + 14}px`;
    el.readout.style.top = `${point.y + 16}px`;
  } else {
    el.readout.classList.remove('at-cursor');
    el.readout.style.left = '';
    el.readout.style.top = '';
  }
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
  updateMobileTopBar();
  syncDateToUtcToday();
  // Explicitly going live means "show me the newest data now" — jump to the
  // latest run/frame even if an older one was selected. (The 60 s auto-refresh
  // itself no longer yanks a deliberately-selected older model run back.)
  state._forceLatest = true;
  refreshActive();
  if (state.liveTimer) clearInterval(state.liveTimer);
  state.liveTimer = setInterval(() => refreshActive(), 60000);
}

function stopLive() {
  state.live = false;
  el.liveBtn.classList.remove('active');
  el.liveBtn.textContent = '○ LIVE';
  updateMobileTopBar();
  if (state.liveTimer) {
    clearInterval(state.liveTimer);
    state.liveTimer = null;
  }
}

// Re-arm LIVE on a product switch so the newest frame for the new selection
// always loads — the user shouldn't have to flip LIVE back on to see it, and the
// view shouldn't stay on the previous product's (now stale) frame. `_forceLatest`
// makes the next list load jump to the most recent frame; if LIVE was off we turn
// it back on (button + 60s auto-refresh) without kicking an extra load, since the
// product handler runs its own load right after.
function ensureLiveForSwitch() {
  if (state.playback && state.playback.active) {
    state.playback.stop();
    state.playback.cache.clear();
    state.playback.cacheCtx = null;
  }
  // Radar archive mode: the user is deliberately browsing past scans, so a
  // product/tilt switch must not snap the view forward to the newest frame.
  if (state.mode === 'radar' && state.radarArchive) { state._forceLatest = false; return; }
  state._forceLatest = true;
  if (state.live) return;
  state.live = true;
  if (el.liveBtn) {
    el.liveBtn.classList.add('active');
    el.liveBtn.textContent = '● LIVE';
  }
  syncDateToUtcToday();
  if (state.liveTimer) clearInterval(state.liveTimer);
  state.liveTimer = setInterval(() => refreshActive(), 60000);
}

// Format a Date as HH:MM(:SS) in either UTC or the viewer's local zone, with the
// matching zone label. Seconds are included only for the live wall clock.
function fmtClock(d, withSeconds) {
  const p = (n) => String(n).padStart(2, '0');
  if (state.tzLocal) {
    // Local time is shown 12-hour with an AM/PM suffix (military is kept only
    // for the always-Zulu UTC clock).
    const h24 = d.getHours();
    const ampm = h24 < 12 ? 'AM' : 'PM';
    const h12 = ((h24 + 11) % 12) + 1;
    const base = `${h12}:${p(d.getMinutes())}`;
    const time = withSeconds ? `${base}:${p(d.getSeconds())}` : base;
    return `${time} ${ampm} ${localTzLabel(d)}`;
  }
  const base = `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
  return `${withSeconds ? `${base}:${p(d.getUTCSeconds())}` : base} UTC`;
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// Compact weekday + calendar date ("Sat Jun 27") to pair with fmtClock. Defaults to the same
// zone the clock is showing (UTC or the viewer's local time); pass local=false to
// force a UTC date for the always-UTC frame labels (radar/satellite/MRMS exports).
function fmtDate(d, local = state.tzLocal) {
  const weekday = WEEKDAY_ABBR[local ? d.getDay() : d.getUTCDay()];
  return local
    ? `${weekday} ${MONTH_ABBR[d.getMonth()]} ${d.getDate()}`
    : `${weekday} ${MONTH_ABBR[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

// Weekday + date + short time for the mobile top bar's product read-out, e.g.
// "Fri Jul 10 12:05pm" (local) or "Fri Jul 10 17:05z" (UTC) — matching whichever
// zone the clock is set to. This is the phone's "what time am I looking at".
function fmtProductStamp(d) {
  if (!d || !Number.isFinite(d.getTime())) return '—';
  const local = state.tzLocal;
  const p = (n) => String(n).padStart(2, '0');
  const wd = WEEKDAY_ABBR[local ? d.getDay() : d.getUTCDay()];
  const mo = MONTH_ABBR[local ? d.getMonth() : d.getUTCMonth()];
  const day = local ? d.getDate() : d.getUTCDate();
  let time;
  if (local) {
    const h24 = d.getHours();
    const h12 = ((h24 + 11) % 12) + 1;
    time = `${h12}:${p(d.getMinutes())}${h24 < 12 ? 'am' : 'pm'}`;
  } else {
    time = `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}z`;
  }
  return `${wd} ${mo} ${day} ${time}`;
}

// Uniform label for every scan/frame list and playback readout. Catalog labels
// are usually time-only; once a real timestamp is available, include its date
// and weekday so crossing midnight is always unambiguous.
function scanFrameLabel(frame) {
  if (!frame) return '—';
  if (!frame.time) return frame.label || '—';
  const stamp = fmtProductStamp(frame.time);
  return /^F\d+/i.test(frame.label || '') ? `${frame.label} · ${stamp}` : stamp;
}

// The valid/scan time (Date) of the frame currently shown for the active mode,
// plus a short tag describing it. Returns null when nothing is loaded yet.
function productTime() {
  const pb = state.playback;
  if (pb && pb.active && pb.frames && pb.frames[pb.idx]) {
    const f = pb.frames[pb.idx];
    if (f.time) {
      const tag = state.mode === 'models'
        ? `F${String(currentModelFhour()).padStart(2, '0')}`
        : state.mode === 'satellite' ? 'sat'
        : state.mode === 'mrms' ? 'mrms'
        : state.mode === 'observations' ? 'rtma' : 'scan';
      return { time: f.time, tag };
    }
  }
  if (state.mode === 'satellite') {
    const f = state.sat.scenes.find((x) => x.key === state.sat.sceneKey);
    const t = (f && f.time) || (state.sat.scene && state.sat.scene.time) || null;
    return t ? { time: t, tag: 'sat' } : null;
  }
  if (state.mode === 'mrms') {
    const f = state.mrms.frames.find((x) => x.key === state.mrms.frameKey);
    const t = (f && f.time) || (state.mrms.grid && state.mrms.grid.time) || null;
    return t ? { time: t, tag: 'mrms' } : null;
  }
  if (state.mode === 'models') {
    const t = modelValidTime();
    return t && Number.isFinite(t.getTime())
      ? { time: t, tag: `F${String(currentModelFhour()).padStart(2, '0')}` }
      : null;
  }
  if (state.mode === 'observations') {
    const f = state.observations.frames.find((x) => x.key === state.observations.frameKey);
    const t = (f && f.time) || (state.observations.grid && state.observations.grid.time) || null;
    return t ? { time: t, tag: 'rtma' } : null;
  }
  // Radar — the active Level II volume / Level III frame.
  const f = state.volumes.find((x) => x.key === state.volumeKey);
  return f && f.time ? { time: f.time, tag: 'scan' } : null;
}

// Refresh the floating time readout. In 'now' mode it shows the live wall clock;
// in 'product' mode (the default) it shows the selected frame's scan / valid time
// with a short tag, falling back to the wall clock until a frame has loaded.
function tickClock() {
  // Keep the mobile top bar's product day/time fresh (and time-zone correct).
  if (el.mtbTimeText && mqSmallScreen.matches) {
    const pt = productTime();
    el.mtbTimeText.textContent = pt ? fmtProductStamp(pt.time) : '—';
  }
  if (!el.clock) return;
  if (state.timeSource === 'product') {
    const pt = productTime();
    if (pt) {
      el.clock.textContent = `${pt.tag} ${fmtDate(pt.time)} ${fmtClock(pt.time, false)}`;
      return;
    }
    const now = new Date();
    el.clock.textContent = `— ${fmtDate(now)} ${fmtClock(now, false)}`;
    return;
  }
  const now = new Date();
  el.clock.textContent = `${fmtDate(now)} ${fmtClock(now, true)}`;
}

// The browser's short time-zone abbreviation for the current locale (e.g. "CDT",
// "PST"), falling back to a UTC offset label if the runtime won't emit one.
function localTzLabel(d) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(d);
    const tz = parts.find((x) => x.type === 'timeZoneName');
    if (tz && tz.value && !/^GMT$/i.test(tz.value)) return tz.value;
  } catch (_) { /* fall through to offset label */ }
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const h = Math.floor(Math.abs(off) / 60);
  return `UTC${sign}${h}`;
}

// Flip the clock between UTC and the viewer's local time zone, updating the
// button label and re-rendering immediately.
function setTzLocal(local) {
  state.tzLocal = !!local;
  if (el.tzToggle) {
    el.tzToggle.classList.toggle('active', state.tzLocal);
    el.tzToggle.textContent = state.tzLocal ? 'UTC' : 'Local';
    el.tzToggle.title = state.tzLocal
      ? 'Show time in UTC'
      : 'Switch between UTC and your local time zone';
  }
  tickClock();
}

// Flip the readout between the selected product's frame time and the live clock.
function setTimeSource(src) {
  state.timeSource = src === 'now' ? 'now' : 'product';
  if (el.timeSrcToggle) {
    const productMode = state.timeSource === 'product';
    el.timeSrcToggle.classList.toggle('active', productMode);
    // The button shows the alternative the click switches to.
    el.timeSrcToggle.textContent = productMode ? 'Now' : 'Frame';
    el.timeSrcToggle.title = productMode
      ? 'Switch to the live clock'
      : "Switch to the selected product's time";
  }
  tickClock();
}

function utcDay(d = new Date()) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function syncDateToUtcToday() {
  state.date = utcDay();
  if (el.dateInput) {
    const today = isoDate(state.date);
    el.dateInput.value = today;
    el.dateInput.max = today;
  }
}

function isoDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

// ---------------------------------------------------------------------------
// Map tools — METAR station plots, draw / measure / storm-track, split screen
// ---------------------------------------------------------------------------
// Populate (or hide) the storm-track side briefing: the full ordered list of
// towns in the cone with their lead time + ETA. Replaces the old, unreadable
// per-town labels stamped over the map. Passing null hides the panel.
function renderStormBriefing(data) {
  let panel = document.getElementById('stormBriefing');
  if (!data || !data.towns || !data.towns.length) {
    if (panel) panel.hidden = true;
    document.body.classList.remove('storm-briefing-open');
    return;
  }
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'stormBriefing';
    panel.className = 'storm-briefing';
    document.body.appendChild(panel);
  }
  const rows = data.towns.map((t) => `
    <li class="sb-row">
      <span class="sb-name">${escapeHTML(t.name)}</span>
      <span class="sb-eta"><span class="sb-lead">+${t.tMin}m</span><span class="sb-time">${escapeHTML(t.eta)}</span></span>
    </li>`).join('');
  const more = data.total > data.shownCount
    ? `<div class="sb-more">Showing ${data.shownCount} of ${data.total} — raise “Max towns” for more</div>`
    : '';
  panel.innerHTML = `
    <div class="sb-head">
      <span class="sb-dot"></span>
      <div class="sb-titlewrap">
        <div class="sb-kicker">Storm track</div>
        <div class="sb-motion">${escapeHTML(data.heading)} · ${data.speed} mph · ${data.minutes} min lead</div>
      </div>
    </div>
    <div class="sb-colhead"><span>Town</span><span>Lead · ETA</span></div>
    <ol class="sb-list">${rows}</ol>
    ${more}`;
  panel.hidden = false;
  document.body.classList.add('storm-briefing-open');
}

function elevationProfile(volume) {
  const vals = [];
  for (const sw of (volume && volume.sweeps) || []) {
    if (!sw.moments || !sw.moments.includes('REF')) continue;
    if (!vals.some((v) => Math.abs(v - sw.elevation) <= TILT_EPS)) vals.push(sw.elevation);
  }
  return { count: vals.length, top: vals.length ? Math.max(...vals) : 0 };
}

function showCrossSectionVst(scan, profile) {
  if (!el.crossSectionVst || !scan) return;
  const when = scan.time instanceof Date ? scan.time : new Date(scan.time);
  const label = Number.isNaN(when.getTime()) ? scan.label : when.toLocaleString([], {
    month:'short', day:'numeric', hour:'numeric', minute:'2-digit', second:'2-digit', timeZoneName:'short',
  });
  el.crossSectionVst.hidden = false;
  el.crossSectionVst.textContent = `Last complete cross-section VST: ${label} · ${profile.count} elevations`;
}

// Find the newest fullest volume at or before the selected scan. The live file
// can appear while it is still accumulating upper tilts; comparing a short run
// of adjacent volumes lets cross sections fall back to the completed VST while
// preserving the exact acquisition time of every elevation in that one file.
async function prepareCrossSectionVolume() {
  const selected = state.volumes.findIndex((v) => v.key === state.volumeKey);
  if (selected < 0) return;
  const candidates = state.volumes.slice(Math.max(0, selected - 5), selected + 1).reverse();
  let best = null;
  for (const scan of candidates) {
    try {
      const volume = scan.key === state.volumeKey && state.volume
        ? state.volume : await getDecodedVolume(scan.key);
      const profile = elevationProfile(volume);
      const score = profile.count * 100 + profile.top;
      if (!best || score > best.score) best = { scan, volume, profile, score };
    } catch (_) { /* try the preceding VST */ }
  }
  if (!best) return;
  showCrossSectionVst(best.scan, best.profile);
  if (best.scan.key !== state.volumeKey) {
    setStatus(`cross section: using complete VST ${best.scan.label || ''}`);
    await loadVolume(best.scan.key);
  }
}

function setupMapTools() {
  // Surface observations (METAR station plots).
  state.metars = new MetarController(state.map, { panelHost: el.metarControls });
  state.metars.onStatus = (msg) => setStatus(msg);
  const setMetars = (on, quiet = false) => {
    on = !!on;
    state._metarsOn = on;
    const enabled = state.metars.setEnabled(on);
    setToggleBtn(el.metarsToggle, enabled);
    if (!enabled && !quiet) setStatus('METARs off');
    saveSettings();
    return enabled;
  };
  if (el.metarsToggle) {
    setToggleBtn(el.metarsToggle, state._metarsOn);
    el.metarsToggle.addEventListener('click', () => setMetars(!state.metars.enabled));
  }
  if (state._metarsOn) setMetars(true, true);

  // NOTE: the local storm reports (LSR) overlay controller and its toggle are
  // wired once in init(), alongside the other overlay controllers. A second
  // setup here previously attached a competing click handler to the same
  // #lsrToggle element, so each press toggled the layer on and then straight
  // back off — the button never appeared to turn on. Keep LSR out of this
  // function so there is a single owner.

  // Draw / measure / storm-track annotations.
  state.mapTools = new MapTools(state.map);
  state.mapTools.getScanTime = () => productTime();
  applyDrawStyle(); // restore the user's freehand-draw colour + width
  // Mirror committed drawings into the split pane.
  state.mapTools.onChange = (fc) => {
    if (state.splitView) state.splitView.setDrawings(fc);
  };
  // When a tool finishes (or is cancelled), drop the pressed state on its button.
  state.mapTools.onToolEnd = () => syncToolButtons();
  // Storm track hands its ordered town list here; show it in the side briefing.
  state.mapTools.onTowns = (data) => renderStormBriefing(data);

  // Vertical cross sections through the loaded Level II volume (all products).
  state.xsect = new CrossSectionTool({
    map: state.map,
    getVolume: () => state.volume,
    getProductId: () => state.productId,
    getDealias: () => state.dealias,
    onStatus: (msg) => setStatus(msg),
    onToolEnd: () => syncToolButtons(),
  });

  const toolButtons = [
    [el.toolDraw, 'draw'],
    [el.toolMeasure, 'measure'],
    [el.toolStorm, 'storm'],
  ];
  function syncToolButtons() {
    for (const [btn, name] of toolButtons)
      btn.classList.toggle('active', state.mapTools.tool === name);
    if (el.toolXsect) el.toolXsect.classList.toggle('active', !!(state.xsect && state.xsect.active()));
    // On mobile the visible tool lives in the dock's single swappable slot, which
    // proxies to these hidden buttons. Its active glow is synced separately, so
    // push the refresh through here too — otherwise arming a tool that resolves
    // asynchronously (the cross section awaits its Level II volume before it
    // toggles) leaves the dock button dark and the tool feels like it never
    // enabled. See setupDockTools().
    if (state._syncDockTool) state._syncDockTool();
    // Storm track takes over the screen: hide the bottom UI (dock, legend,
    // footer) so the track + town list own the view (CSS keys off this class).
    document.body.classList.toggle('storm-active', state.mapTools.tool === 'storm');
    // Draw and measure are full-screen touch gestures on phones. Let CSS move
    // their controls out of the dock's way and hide the bottom dock while armed.
    document.body.classList.toggle('draw-measure-active',
      state.mapTools.tool === 'draw' || state.mapTools.tool === 'measure');
    syncDrawToolPopup();
  }
  function syncDrawToolPopup() {
    if (!el.drawToolPopup) return;
    const tool = state.mapTools.tool;
    const show = tool === 'draw' || tool === 'measure';
    el.drawToolPopup.hidden = !show;
    el.drawToolPopup.classList.toggle('measure-only', tool === 'measure');
    if (el.drawToolPopupTitle) el.drawToolPopupTitle.textContent = tool === 'measure' ? 'Measure' : 'Draw';
  }
  // Expose so the tool coordinator can refresh button state when it disarms a
  // draw/measure/storm tool on behalf of another tool.
  state._syncToolButtons = syncToolButtons;
  for (const [btn, name] of toolButtons) {
    btn.addEventListener('click', () => {
      // Arming this tool? Disarm any other modal tool (METARs, inspect)
      // first so only one is ever active.
      if (state.mapTools.tool !== name) clearOtherTools(name);
      state.mapTools.setTool(name);
      syncToolButtons();
    });
  }
  el.toolClear.addEventListener('click', () => {
    state.mapTools.clearAll();
    syncToolButtons();
  });

  if (el.toolXsect) {
    el.toolXsect.addEventListener('click', async () => {
      if (state.mode !== 'radar') {
        setStatus('cross sections read the Level II volume — switch to RADAR');
        return;
      }
      if (!state.xsect.active()) clearOtherTools('xsect');
      // Pick the best complete VST to slice, but never let a fetch/decode failure
      // block the tool from arming — toggle() has its own volume guard. Without
      // this, a rejected prepare left the tool (and the mobile dock slot that
      // proxies to it) looking like it simply refused to enable.
      if (!state.xsect.active()) {
        try { await prepareCrossSectionVolume(); }
        catch (e) { console.warn('cross-section volume prep failed', e); }
      }
      state.xsect.toggle();
      syncToolButtons();
    });
  }

  // Split screen - synced comparison panes showing different products.
  state.splitView = new SplitView({
    state,
    MAPBOX_TOKEN,
    basemapStyleUrl,
    radarSweepFor,
    satPayloadForProduct: buildSatPayloadForProduct,
    lonLatToColRow,
    sampleRadarAtProduct,
    sampleGridRaw,
    formatGridValue: fmtValue,
    outlookData: () => (state.spc && state.spc._last) || null,
    loadObservationProduct: (id) => {
      const key = state.observations.frameKey ||
        (state.observations.frames.length ? state.observations.frames[state.observations.frames.length - 1].key : null);
      return key ? loadObservation(id, key) : null;
    },
    onInspectMove: (lngLat, point, pane) => {
      if (state.inspect) updateReadout(lngLat, point, pane);
    },
    onInspectOut: () => {
      if (el.readout) el.readout.classList.remove('show');
    },
    // When the user clicks a pane to select it, repaint the product buttons so
    // they highlight — and drive — the newly active pane.
    onActivePaneChange: () => {
      buildProductButtons();
      buildOutlookDetailList();
      buildLegend();
      buildCityValueProductControls();
    },
    onSplitProductsChange: () => {
      updateSplitPaneChrome();
      renderModelCityValues();
    },
    onPaneRendered: () => renderModelCityValues(),
  });
  el.toolSplit.addEventListener('click', () => {
    const on = state.splitView.toggle(2);
    setToggleBtn(el.toolSplit, on);
    if (on) state.splitView.setDrawings(state.mapTools.getFeatureCollection());
    updateSplitPaneChrome();
    updateLayoutSwitchUI();
  });
  // Sidebar Layout switch (single / split / quad) - a friendlier face on the
  // same comparison controller.
  if (el.layoutSwitch) {
    el.layoutSwitch.addEventListener('click', (e) => {
      const btn = e.target.closest('.layout-btn');
      if (!btn) return;
      const layout = btn.dataset.layout;
      if (layout === 'single') {
        if (state.splitView.active) state.splitView.disable();
      } else {
        state.splitView.enable(layout === 'quad4' ? 4 : 2);
        state.splitView.setDrawings(state.mapTools.getFeatureCollection());
      }
      setToggleBtn(el.toolSplit, !!state.splitView.active);
      updateSplitPaneChrome();
      updateLayoutSwitchUI();
    });
  }

  // Export / share — snapshot the live map(s) to a PNG with a caption banner.
  // Before capturing, the basemap's town labels are temporarily enlarged on
  // every pane so place names survive social-media downscaling — readable on a
  // phone timeline without zooming the map in (which would crop the scene).
  // The boost rides the normal map-style machinery (so zoom expressions are
  // rebuilt safely and native sizes aren't compounded) and is restored right
  // after the pixels are read.
  state.exportTool = new ExportTool({ getScene: buildExportScene });
  const exportPaneMaps = () => {
    const maps = [state.map];
    if (state.splitView && state.splitView.active && state.splitView.getMaps)
      maps.push(...state.splitView.getMaps());
    return maps.filter((m) => m && m.getStyle);
  };
  // The custom overlay symbols (H/L pressure centers and their mb labels) are GL
  // symbol layers, not basemap labels, so the town-label boost above never
  // touches them — at export/share resolution their on-screen text stayed small
  // next to the scaled-up banners and legend. Bump their text-size (and halo, so
  // they stay legible over busy fields) during the capture and restore it after.
  // [layerId, kind ('layout'|'paint'), property, on-screen value, export value]
  const OVERLAY_EXPORT_SIZES = [
    ['pressure-centers', 'layout', 'text-size', 30, 46],
    ['pressure-centers', 'paint', 'text-halo-width', 2, 3],
    ['pressure-center-labels', 'layout', 'text-size', 12, 18],
    ['pressure-center-labels', 'paint', 'text-halo-width', 1.6, 2.4],
  ];
  const applyExportOverlayBoost = (maps, boost) => {
    for (const m of maps) {
      if (!m || !m.getLayer) continue;
      for (const [id, kind, prop, base0, boosted] of OVERLAY_EXPORT_SIZES) {
        if (!m.getLayer(id)) continue;
        const val = boost ? boosted : base0;
        try {
          if (kind === 'paint') m.setPaintProperty(id, prop, val);
          else m.setLayoutProperty(id, prop, val);
        } catch (_) {}
      }
    }
  };
  const applyExportLabelStyle = (maps, boost) => {
    const base = normalizeMapStyle(state.mapStyle);
    const opts = boost
      ? {
          ...base,
          townSize: Math.min(3, base.townSize * 1.4),
          townThickness: Math.min(6, Math.max(base.townThickness * 1.25, 1.6)),
        }
      : state.mapStyle;
    for (const m of maps) {
      try { applyMapStyle(m, opts, firstLabelLayerId(m), { fresh: false }); } catch (_) {}
    }
    applyExportOverlayBoost(maps, boost);
  };
  // Resolve once the map has re-laid-out its labels (or after a short cap —
  // label placement runs in workers, so 'idle' is the only reliable signal).
  const waitMapIdle = (map) => new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    map.once('idle', finish);
    setTimeout(finish, 1200);
  });
  let exporting = false;
  el.toolExport.addEventListener('click', async () => {
    if (exporting) return;
    exporting = true;
    const maps = exportPaneMaps();
    try {
      applyExportLabelStyle(maps, true);
      await Promise.all(maps.map(waitMapIdle));
      state.exportTool.run();
    } catch (e) {
      console.error('export failed:', e);
      setStatus('Export failed');
    } finally {
      applyExportLabelStyle(maps, false);
      exporting = false;
    }
  });
}

function escapeHTML(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
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
  { id: 'locate', icon: '📍', label: 'My live location', btn: () => el.toolLocate },
  // The model sounding isn't a slot tool anymore — in models mode you long-press
  // the map (or right-click on desktop) to open a sounding at that point.
  { id: 'export', icon: '⤓', label: 'Export image', btn: () => el.toolExport },
];

// Custom tracking-cone glyph for the storm-track tool (Lucide has no cone
// icon): a dot with a forecast cone fanning out from it, echoing the wedge the
// tool draws on the map. Same inline markup as the #toolStorm button in
// index.html, in Lucide's stroke style.
const CONE_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide sm"><circle cx="5" cy="19" r="1"/><path d="M6.6 15.1L11.3 4.3A16 16 0 0 1 19.7 12.8L8.9 17.4A4.2 4.2 0 0 0 6.6 15.1Z"/></svg>';

// A tool icon is either a Lucide name or raw inline SVG (leading '<').
function toolIconMarkup(icon) {
  return icon.startsWith('<') ? icon : `<i data-lucide="${icon}" class="lucide sm"></i>`;
}

// The tools offered in the mobile dock slot. Kept as a function (rather than the
// constant list) so source-specific filtering can be reintroduced if needed.
const XSECT_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide sm"><line x1="4" y1="20" x2="20" y2="4"/><circle cx="4" cy="20" r="1.5"/><circle cx="20" cy="4" r="1.5"/></svg>';

const MOBILE_TOOL_DEFS = [
  { id: 'inspect', icon: 'crosshair', label: 'Inspect a pixel', btn: () => el.inspectBtn },
  { id: 'storm', icon: CONE_ICON, label: 'Storm track', btn: () => el.toolStorm },
  { id: 'xsect', icon: XSECT_ICON, label: 'Cross section', btn: () => el.toolXsect },
  { id: 'measure', icon: 'ruler', label: 'Measure', btn: () => el.toolMeasure },
  { id: 'draw', icon: 'pencil', label: 'Draw', btn: () => el.toolDraw },
  { id: 'locate', icon: 'navigation', label: 'My live location', btn: () => el.toolLocate },
  { id: 'export', icon: 'download', label: 'Export image', btn: () => el.toolExport },
];

function dockToolsForMode() {
  return MOBILE_TOOL_DEFS;
}

function setupDockTools() {
  if (!el.dockToolBtn) return;
  state.dockTool = state.dockTool || 'inspect';
  if (el.dockToolMore) {
    el.dockToolMore.innerHTML = '<i data-lucide="wrench" class="lucide sm"></i>';
    el.dockToolMore.title = 'Choose tool';
  }

  const current = () => dockToolsForMode().find((t) => t.id === state.dockTool) || dockToolsForMode()[0];

  // Reflect the underlying tool button's pressed state on the slot.
  function syncActive() {
    const t = current();
    const btn = t.btn();
    el.dockToolBtn.classList.toggle('active', !!(btn && btn.classList.contains('active')));
  }
  // Let the tool controllers (which flip the hidden proxy buttons' .active class
  // when a tool arms/disarms — including asynchronously) refresh the dock slot's
  // glow so the mobile UI reflects the real tool state. Without this the cross
  // section, which awaits its volume before toggling, never lights the slot.
  state._syncDockTool = syncActive;

  function buildMenu() {
    el.dockToolMenu.innerHTML = '';
    for (const t of dockToolsForMode()) {
      const item = document.createElement('button');
      item.className = 'dock-tool-item';
      if (t.id === state.dockTool) item.classList.add('active');
      item.innerHTML = `<span class="ti-icon">${toolIconMarkup(t.icon)}</span><span>${t.label}</span>`;
      item.addEventListener('click', () => {
        setDockTool(t.id);
        closeDockMenu();
      });
      el.dockToolMenu.appendChild(item);
    }
    refreshIcons();
  }

  function setDockTool(id) {
    const prev = current();
    if (prev && prev.id !== id) clearOtherTools(null);
    state.dockTool = id;
    const t = current();
    el.dockToolBtn.innerHTML = toolIconMarkup(t.icon);
    el.dockToolBtn.title = t.label;
    syncActive();
    saveSettings();
    refreshIcons();
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
  if (state.splitView && state.splitView.active) {
    const maps = state.splitView.getMaps ? state.splitView.getMaps() : (state.splitView.map ? [state.splitView.map] : []);
    for (const map of maps) {
      if (map.redraw) map.redraw();
      canvases.push(map.getCanvas());
    }
  }
  // Alert overlays: if the full briefing is open, capture the whole detail view
  // as it appears on screen (a side panel over the scope). Otherwise, if the
  // compact preview card is open, stamp that instead (minus its "View full
  // briefing" footer). The full briefing takes precedence over the card.
  const briefing = state.alerts ? state.alerts.exportDetail() : null;
  const alert = briefing ? null : (state.alerts ? state.alerts.exportPreview() : null);
  // Per-pane product ids so multi-pane exports can label each pane (the live
  // pane badges are DOM overlays and never reach the captured canvases).
  const paneLabels = state.splitView && state.splitView.active && state.splitView.paneProducts
    ? state.splitView.paneProducts()
    : null;
  // Storm-track briefing (town list + motion) reproduced as an alert-style side
  // panel on the export, when the storm tool has an active track.
  const stormBriefing = state.mapTools ? state.mapTools.stormBriefing() : null;
  return {
    canvases,
    paneLabels,
    caption: buildExportCaption(),
    legendEl: el.legend,
    alert,
    briefing,
    stormBriefing,
    theme: exportTheme(),
    modelStats: visibleModelExtrema(),
  };
}

// Describe what's on screen for the export banner: a title, a product/source
// sub-line, the scan/frame time and a UTC stamp. Adapts to the active mode.
function buildExportCaption() {
  const cap = {
    brand: 'RadarNexus',
    title: '',
    sub: '',
    time: '',
    stamp: utcStamp(new Date()),
  };

  if (state.mode === 'satellite') {
    const sat = SATELLITES[state.sat.satKey];
    const sec = SECTORS[state.sat.sectorKey];
    cap.title = sat ? sat.label : 'GOES';
    cap.sub = `${state.sat.productId} · ${sec ? sec.label : ''} · ${sat && sat.family === 'himawari' ? 'Himawari AHI' : 'GOES ABI'}`;
    const t = state.sat.scenes.find((x) => x.key === state.sat.sceneKey);
    cap.time = t ? stampWithDate(t) : '';
  } else if (state.mode === 'mrms') {
    const p = MRMS_PRODUCTS[state.mrms.productId];
    cap.title = 'MRMS CONUS';
    cap.sub = `${p ? p.name : state.mrms.productId} · MRMS`;
    const t = state.mrms.frames.find((x) => x.key === state.mrms.frameKey);
    cap.time = t ? stampWithDate(t) : '';
  } else if (state.mode === 'models') {
    const m = MODELS[state.models.modelKey];
    const p = MODEL_PRODUCTS[state.models.productId];
    cap.title = m ? m.label : 'Model';
    cap.sub = `${p ? p.name : state.models.productId} · F${String(state.models.fhour).padStart(2, '0')}`;
    const run = state.models.runs.find((x) => x.key === state.models.runKey);
    // Stamp the frame's valid date + time beside the run, in whichever zone the
    // upper-left clock is showing (UTC or the viewer's local time, per state.tzLocal).
    const valid = modelValidTime();
    const validStr = Number.isFinite(valid.getTime())
      ? `${fmtDate(valid)} ${fmtClock(valid, false)}` : '';
    cap.time = run
      ? (validStr ? `${run.label} run · ${validStr}` : `${run.label} run`)
      : validStr;
  } else if (state.mode === 'observations') {
    const p = OBS_PRODUCTS[state.observations.productId];
    cap.title = 'RTMA Analysis';
    cap.sub = `${p ? p.name : state.observations.productId} · NOAA RTMA`;
    const t = state.observations.frames.find((x) => x.key === state.observations.frameKey);
    cap.time = t ? stampWithDate(t) : '';
  } else if (state.mode === 'outlooks') {
    const product = state.spc && OUTLOOKS[state.spc.product];
    const detail = state.spc && product && product.details.find((d) => d.id === state.spc.detail);
    cap.title = product ? product.label : 'Forecast Outlooks';
    cap.sub = detail ? detail.label : 'Official outlook overlay';
    cap.time = el.spcStatus ? el.spcStatus.textContent : '';
  } else {
    // Radar.
    const l3 = isL3Product(state.productId);
    const site = (!l3 && state.volume && state.volume.icao) || state.site;
    const meta = RADARS.find((r) => r[0] === site);
    const p = radarProduct(state.productId);
    cap.title = meta ? `${site} · ${meta[1]}` : site;
    cap.sub = `${p.name} (${dispUnitOf(p)}) · NEXRAD Level ${l3 ? 'III' : 'II'}`;
    const t = state.volumes.find((x) => x.key === state.volumeKey);
    cap.time = t ? stampWithDate(t) : '';
  }
  return cap;
}

// Prefix a frame's UTC time label (radar/satellite/MRMS) with its calendar date.
// These labels are always UTC, so the date is taken in UTC to match.
function stampWithDate(frame) {
  return frame.time ? `${fmtDate(frame.time, false)} ${frame.label}` : (frame.label || '');
}

// "2026-06-22 18:42:07 UTC" for the export footer.
function utcStamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC`;
}

// ---------------------------------------------------------------------------
// Basemap layer customisation UI (town labels, roads, rivers, borders)
// ---------------------------------------------------------------------------
// Re-apply the current map-style options to the live map(s) without a reload,
// then persist them. The customisation is also re-applied on every style load by
// setupOverlays, so it survives a basemap switch.
function applyMapStyleLive() {
  const map = state.map;
  if (map && map.getStyle) applyMapStyle(map, state.mapStyle, firstLabelLayerId(map), { fresh: false });
  if (state.splitView && state.splitView.setMapStyle) state.splitView.setMapStyle(state.mapStyle);
  saveSettings();
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts (user-customisable)
// ---------------------------------------------------------------------------
// A binding maps a normalised key combo (e.g. "Shift+KeyR") to an action id.
// Tool + playback binds live in the `global` scope (they work in every source
// mode); product binds are per-mode ("radar"/"satellite"/"mrms"/"models") so
// the same key can mean a different product in each source, and the user can add
// their own satellite/MRMS/model product shortcuts. Actions are applied by
// driving the existing buttons, so all of their wiring is reused unchanged.
const KEYBIND_SCOPES = ['global', 'radar', 'satellite', 'mrms', 'models'];

const DEFAULT_KEYBINDS = {
  global: {
    'KeyI': 'tool:inspect',
    'KeyT': 'tool:storm',
    'KeyM': 'tool:measure',
    'KeyD': 'tool:draw',
    'KeyS': 'tool:metars',
    'KeyL': 'tool:locate',
    'KeyE': 'tool:export',
    'Shift+Digit7': 'tool:split',
    'Shift+Digit9': 'tool:clear',
    'Space': 'playback:loop',
    'ArrowRight': 'playback:next',
    'ArrowLeft': 'playback:prev',
  },
  radar: {
    'Shift+KeyR': 'product:REF',
    'Shift+KeyV': 'product:VEL',
    'Shift+KeyC': 'product:RHO',
    'Shift+KeyD': 'product:ZDR',
    'Shift+KeyS': 'product:SW',
    'Shift+KeyP': 'product:PHI',
    'Shift+KeyE': 'product:ET',
    'Shift+KeyT': 'product:PRT',
  },
  satellite: {},
  mrms: {},
  models: {},
};

// Buttons each tool action drives (reuses their full click wiring).
const TOOL_ACTION_BTN = {
  inspect: 'inspectBtn',
  storm: 'toolStorm', measure: 'toolMeasure', draw: 'toolDraw',
  metars: 'metarsToggle', locate: 'toolLocate', xsect: 'toolXsect',
  split: 'toolSplit', export: 'toolExport', clear: 'toolClear',
};
const TOOL_ACTIONS = [
  ['tool:inspect', 'Inspect'],
  ['tool:storm', 'Storm track'], ['tool:measure', 'Measure'], ['tool:draw', 'Draw'],
  ['tool:metars', 'Surface obs'], ['tool:locate', 'Live location'],
  ['tool:split', 'Split screen'], ['tool:export', 'Export'], ['tool:clear', 'Clear drawings'],
];
const PLAYBACK_ACTIONS = [
  ['playback:loop', 'Start / pause loop'],
  ['playback:next', 'Next frame'],
  ['playback:prev', 'Previous frame'],
];

const TOOL_KEYBIND_MIGRATIONS = [
  ['Shift+KeyI', 'KeyI', 'tool:inspect'],
  ['Shift+Digit1', 'KeyT', 'tool:storm'],
  ['Shift+Digit2', 'KeyM', 'tool:measure'],
  ['Shift+Digit3', 'KeyD', 'tool:draw'],
  ['Shift+Digit4', 'KeyS', 'tool:metars'],
  ['Shift+Digit6', 'KeyL', 'tool:locate'],
  ['Shift+Digit8', 'KeyE', 'tool:export'],
];

// Catalog of product actions per source mode, [actionId, label]. Used to label
// existing binds and to populate the "add a shortcut" product picker.
function productCatalog(mode) {
  if (mode === 'radar')
    return [...PRODUCT_ORDER.map((id) => [`product:${id}`, PRODUCTS[id].name]),
            ...L3_ORDER.map((id) => [`product:${id}`, L3_PRODUCTS[id].name])];
  if (mode === 'satellite')
    return [...SAT_CHANNELS.map((ch) => [`product:C${p2(ch.band)}`, `C${p2(ch.band)} · ${ch.name}`]),
            ...SAT_RGB_ORDER.map((id) => [`product:RGB_${id}`, `${SAT_RGB[id].name} RGB`])];
  if (mode === 'mrms')
    return MRMS_ORDER.filter((id) => MRMS_PRODUCTS[id]).map((id) => [`product:${id}`, MRMS_PRODUCTS[id].name]);
  if (mode === 'models')
    return MODEL_ORDER.filter((id) => MODEL_PRODUCTS[id]).map((id) => [`product:${id}`, MODEL_PRODUCTS[id].name]);
  return [];
}

// Human label for an action id (for the shortcut list).
function actionLabel(action) {
  if (action.startsWith('tool:')) {
    const f = TOOL_ACTIONS.find(([id]) => id === action);
    return f ? f[1] : action;
  }
  if (action.startsWith('playback:')) {
    const f = PLAYBACK_ACTIONS.find(([id]) => id === action);
    return f ? f[1] : action;
  }
  if (action.startsWith('product:')) {
    const id = action.slice('product:'.length);
    for (const mode of ['radar', 'satellite', 'mrms', 'models']) {
      const f = productCatalog(mode).find(([a]) => a === action);
      if (f) return f[1];
    }
    return id;
  }
  return action;
}

const KEYBIND_MODIFIER_CODES = new Set([
  'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight',
  'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight',
]);

// Canonicalise a keyboard event to a stable combo string using e.code (so it's
// layout-independent and Shift+letter survives the shifted character). Returns
// null for a bare modifier press.
function keyComboFromEvent(e) {
  const code = e.code || e.key;
  if (!code || KEYBIND_MODIFIER_CODES.has(code)) return null;
  const parts = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Meta');
  parts.push(code);
  return parts.join('+');
}

// Pretty-print a combo for the UI ("Shift+KeyR" → "Shift + R").
function keyComboLabel(combo) {
  return combo.split('+').map((seg) => {
    if (seg.startsWith('Key')) return seg.slice(3);
    if (seg.startsWith('Digit')) return seg.slice(5);
    if (seg === 'ArrowLeft') return '←';
    if (seg === 'ArrowRight') return '→';
    if (seg === 'ArrowUp') return '↑';
    if (seg === 'ArrowDown') return '↓';
    if (seg === 'Space') return 'Space';
    if (seg === 'Ctrl' || seg === 'Alt' || seg === 'Shift' || seg === 'Meta') return seg;
    return seg;
  }).join(' + ');
}

// Build state.keybinds from storage (if any) or the defaults.
function initKeybinds() {
  const stored = state._storedKeybinds;
  state.keybinds = {};
  for (const scope of KEYBIND_SCOPES) {
    const src = stored && typeof stored[scope] === 'object' ? stored[scope] : (stored ? {} : DEFAULT_KEYBINDS[scope]);
    state.keybinds[scope] = { ...src };
  }
  if (stored) migrateToolKeybindDefaults();
  // Existing users may have a saved shortcut map from before inspect was
  // bindable. Add the new default only when it does not collide with a custom
  // combo or an already-bound inspect action.
  if (stored && !findActionForCombo('KeyI')) {
    const hasInspect = KEYBIND_SCOPES.some((scope) =>
      Object.values(state.keybinds[scope] || {}).includes('tool:inspect'));
    if (!hasInspect) state.keybinds.global['KeyI'] = 'tool:inspect';
  }
}

function migrateToolKeybindDefaults() {
  const global = state.keybinds.global || (state.keybinds.global = {});
  let changed = false;
  for (const [oldCombo, nextCombo, action] of TOOL_KEYBIND_MIGRATIONS) {
    if (global[oldCombo] !== action) continue;
    if (findActionForCombo(nextCombo)) continue;
    delete global[oldCombo];
    global[nextCombo] = action;
    changed = true;
  }
  if (changed) saveSettings();
}

// Run an action id by driving the matching button. Returns true if handled.
function runKeyAction(action) {
  if (typeof action !== 'string') return false;
  if (action.startsWith('tool:')) {
    const btn = el[TOOL_ACTION_BTN[action.slice(5)]];
    if (btn) { btn.click(); return true; }
    return false;
  }
  if (action.startsWith('playback:')) return runPlaybackAction(action.slice('playback:'.length));
  if (action.startsWith('product:')) {
    const id = action.slice('product:'.length);
    const btns = el.productButtons ? el.productButtons.querySelectorAll('.product-btn') : [];
    for (const b of btns) if (b.dataset.id === id) { b.click(); return true; }
    return false;
  }
  return false;
}

function runPlaybackAction(which) {
  const pb = state.playback;
  if (!pb) return false;
  if (which === 'loop') {
    if (mesoActive()) { toggleMesoPlay(); return true; }
    if (!pb.active) pb.start();
    else pb.toggle();
    return true;
  }
  if (which === 'next') return stepFrame(1);
  if (which === 'prev') return stepFrame(-1);
  return false;
}

// Step one frame: through the playback loop when it's running, otherwise through
// the active source's scan/scene/frame (or model forecast-hour) list. dir is +1
// for "later in time", −1 for "earlier".
function stepFrame(dir) {
  // Mesoanalysis runs its own image-frame loop (no decoded grids).
  if (mesoActive()) return stepMesoFrame(dir);
  const pb = state.playback;
  if (pb && pb.active && pb.frames.length) { pb.seek(pb.idx + dir); return true; }
  // Radar is pinned live; stepping back is what flips on archive browsing so the
  // 60 s refresh stops snapping the view forward as the user pages through scans.
  if (state.mode === 'radar' && dir < 0 && !state.radarArchive) setRadarArchive(true);
  if (state.mode === 'models') return stepButtonList(el.fhourList, dir > 0 ? 'next' : 'prev');
  // The scan/scene/frame lists render newest-first, so "later" = previous row.
  return stepButtonList(el.volumeList, dir > 0 ? 'prev' : 'next');
}

function stepButtonList(listEl, which) {
  if (!listEl) return false;
  const active = listEl.querySelector('button.active');
  if (!active) {
    const first = listEl.querySelector('button');
    if (first) { first.click(); return true; }
    return false;
  }
  const sib = which === 'next' ? active.nextElementSibling : active.previousElementSibling;
  if (sib && sib.tagName === 'BUTTON') sib.click();
  return true; // consume the key even at an end of the list
}

// Global keydown dispatcher. Skips typing targets and modal overlays, and yields
// to the capture UI while a new combo is being recorded.
function handleKeybind(e) {
  if (state._captureKeybind) return;
  const t = e.target;
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT|OPTION)$/.test(t.tagName))) return;
  if (!el.sounding.hidden || !el.alertDetail.hidden || (el.alertPreview && !el.alertPreview.hidden)) return;
  const combo = keyComboFromEvent(e);
  if (!combo) return;
  let action = state.keybinds.global[combo];
  if (!action) action = (state.keybinds[state.mode] || {})[combo];
  if (!action) return;
  if (runKeyAction(action)) { e.preventDefault(); e.stopPropagation(); }
}

// Where a given action id is stored: tools/playback are global; products live in
// the mode whose catalog lists them.
function scopeForAction(action) {
  if (action.startsWith('tool:') || action.startsWith('playback:')) return 'global';
  for (const mode of ['radar', 'satellite', 'mrms', 'models'])
    if (productCatalog(mode).some(([a]) => a === action)) return mode;
  return 'global';
}

// Remove any existing binding of `combo` across every scope (a combo is unique).
function clearCombo(combo) {
  for (const scope of KEYBIND_SCOPES) delete state.keybinds[scope][combo];
}

function setupKeybinds() {
  initKeybinds();
  // Capture phase so a bound arrow/space reliably reaches us before Mapbox's
  // own canvas keyboard pan/zoom handling (and we only act on real bindings).
  document.addEventListener('keydown', handleKeybind, true);
  setupKeybindControls();
}

// Capture the next key combo the user presses, then invoke `done(combo)`.
function captureNextKey(done) {
  state._captureKeybind = true;
  const onKey = (e) => {
    if (e.key === 'Escape') { finish(null); return; }
    const combo = keyComboFromEvent(e);
    if (!combo) return; // ignore bare modifier presses; wait for the real key
    e.preventDefault();
    e.stopPropagation();
    finish(combo);
  };
  const finish = (combo) => {
    document.removeEventListener('keydown', onKey, true);
    state._captureKeybind = false;
    done(combo);
  };
  document.addEventListener('keydown', onKey, true);
}

// Render the keyboard-shortcuts editor: every binding grouped by scope, each row
// rebindable or removable, plus an "add a shortcut" picker (which also covers
// satellite / MRMS / model products) and a reset-to-defaults button.
function setupKeybindControls() {
  const host = el.keybindControls;
  if (!host) return;
  const groups = [
    ['global', 'Tools & playback'],
    ['radar', 'Radar products'],
    ['satellite', 'Satellite products'],
    ['mrms', 'MRMS products'],
    ['models', 'Model products'],
  ];

  const rowsHTML = groups.map(([scope, title]) => {
    const binds = Object.entries(state.keybinds[scope] || {});
    if (!binds.length && scope !== 'global' && scope !== 'radar') return '';
    const rows = binds.length
      ? binds.map(([combo, action]) => `
          <div class="kb-row" data-combo="${escHtml(combo)}">
            <span class="kb-act">${escHtml(actionLabel(action))}</span>
            <button type="button" class="kb-key" data-combo="${escHtml(combo)}" title="Click, then press a new key">${escHtml(keyComboLabel(combo))}</button>
            <button type="button" class="kb-remove" data-combo="${escHtml(combo)}" title="Remove shortcut">✕</button>
          </div>`).join('')
      : '<div class="kb-empty">No shortcuts.</div>';
    return `<div class="kb-group"><div class="kb-group-title">${escHtml(title)}</div>${rows}</div>`;
  }).join('');

  // "Add a shortcut" picker: every assignable action across all categories.
  const addOpts = [
    `<optgroup label="Tools">${TOOL_ACTIONS.map(([id, l]) => `<option value="${id}">${escHtml(l)}</option>`).join('')}</optgroup>`,
    `<optgroup label="Playback">${PLAYBACK_ACTIONS.map(([id, l]) => `<option value="${id}">${escHtml(l)}</option>`).join('')}</optgroup>`,
    ...['radar', 'satellite', 'mrms', 'models'].map((mode) =>
      `<optgroup label="${mode[0].toUpperCase() + mode.slice(1)} products">${productCatalog(mode)
        .map(([id, l]) => `<option value="${id}">${escHtml(l)}</option>`).join('')}</optgroup>`),
  ].join('');

  host.innerHTML = `
    ${rowsHTML}
    <div class="kb-add">
      <div class="kb-add-title">Add a shortcut</div>
      <select id="kbAddAction" class="kb-add-action">${addOpts}</select>
      <button type="button" id="kbAddKey" class="kb-key kb-add-key">Press a key…</button>
    </div>
    <button type="button" id="kbReset" class="kb-reset">Reset shortcuts to defaults</button>
    <div id="kbHint" class="kb-hint"></div>`;

  const hint = host.querySelector('#kbHint');
  const setHint = (msg) => { if (hint) hint.textContent = msg || ''; };

  // Rebind an existing shortcut: capture a new combo for the same action.
  host.querySelectorAll('.kb-key[data-combo]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const oldCombo = btn.dataset.combo;
      btn.textContent = 'Press a key…';
      captureNextKey((combo) => {
        if (!combo) { setupKeybindControls(); return; }
        const action = findActionForCombo(oldCombo);
        if (!action) { setupKeybindControls(); return; }
        clearCombo(oldCombo);
        clearCombo(combo);
        state.keybinds[scopeForAction(action)][combo] = action;
        saveSettings();
        setupKeybindControls();
      });
    });
  });

  host.querySelectorAll('.kb-remove').forEach((btn) => {
    btn.addEventListener('click', () => {
      clearCombo(btn.dataset.combo);
      saveSettings();
      setupKeybindControls();
    });
  });

  const addKeyBtn = host.querySelector('#kbAddKey');
  const addSel = host.querySelector('#kbAddAction');
  if (addKeyBtn && addSel) {
    addKeyBtn.addEventListener('click', () => {
      const action = addSel.value;
      addKeyBtn.textContent = 'Press a key…';
      captureNextKey((combo) => {
        if (!combo) { setHint('Cancelled.'); addKeyBtn.textContent = 'Press a key…'; return; }
        clearCombo(combo);
        state.keybinds[scopeForAction(action)][combo] = action;
        saveSettings();
        setupKeybindControls();
      });
    });
  }

  const resetBtn = host.querySelector('#kbReset');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      state._storedKeybinds = null;
      initKeybinds();
      saveSettings();
      setupKeybindControls();
    });
  }
}

// Find the action currently bound to a combo (searched across every scope).
function findActionForCombo(combo) {
  for (const scope of KEYBIND_SCOPES)
    if (state.keybinds[scope][combo]) return state.keybinds[scope][combo];
  return null;
}

// The line-style controls (roads, rivers) share one shape: a width multiplier
// slider plus an optional colour override. Borders are always recoloured (no
// "native" colour), so they get a plain colour picker.
const MAP_LINE_CONTROLS = [
  { key: 'road', label: 'Roads', optionalColor: true },
  { key: 'river', label: 'Rivers', optionalColor: true },
  { key: 'border', label: 'Borders', optionalColor: false },
];

// Friendly label for the City-density slider (raw value is a 0.3–3 multiplier on
// the basemap's native label density).
function townDensityLabel(d) {
  if (d <= 0.45) return 'Minimal';
  if (d < 0.9) return 'Fewer';
  if (d <= 1.1) return 'Normal';
  if (d < 2) return 'More';
  return 'Max';
}

function setupMapStyleControls() {
  const host = el.mapStyleControls;
  if (!host) return;
  const ms = state.mapStyle;

  const fontOpts = Object.entries(TOWN_FONTS)
    .map(([k, v]) => `<option value="${k}">${v.label}</option>`)
    .join('');

  const lineRows = MAP_LINE_CONTROLS.map(({ key, label, optionalColor }) => {
    const colorVal = ms[`${key}Color`] || (key === 'border' ? '#ffffff' : '#888888');
    const colorOn = key === 'border' ? true : !!ms[`${key}Color`];
    const colorToggle = optionalColor
      ? `<label class="ms-color-on"><input type="checkbox" id="${key}ColorOn"${colorOn ? ' checked' : ''}>Custom</label>`
      : '';
    return `
      <div class="ms-line">
        <span class="ms-line-name">${label}</span>
        <label class="field opacity-field ms-line-width">
          <span>Thickness <b id="${key}WidthVal">${ms[`${key}Width`].toFixed(1)}×</b></span>
          <input type="range" id="${key}Width" min="0.2" max="4" step="0.1" value="${ms[`${key}Width`]}">
        </label>
        <div class="ms-line-color">
          ${colorToggle}
          <input type="color" id="${key}Color" value="${colorVal}">
        </div>
      </div>`;
  }).join('');

  host.innerHTML = `
    <label class="field">
      <span>Town label font</span>
      <select id="townFontSelect">${fontOpts}</select>
    </label>
    <label class="field opacity-field">
      <span>Town label thickness <b id="townThickVal">${ms.townThickness.toFixed(1)}</b></span>
      <input type="range" id="townThick" min="0" max="4" step="0.5" value="${ms.townThickness}">
    </label>
    <label class="field opacity-field">
      <span>Town label size <b id="townSizeVal">${ms.townSize.toFixed(1)}×</b></span>
      <input type="range" id="townSize" min="0.5" max="3" step="0.1" value="${ms.townSize}">
    </label>
    <div class="ms-line">
      <span class="ms-line-name">Town label color</span>
      <div class="ms-line-color">
        <label class="ms-color-on"><input type="checkbox" id="townColorOn"${ms.townColor ? ' checked' : ''}>Custom</label>
        <input type="color" id="townColor" value="${ms.townColor || '#ffffff'}">
      </div>
    </div>
    <label class="field opacity-field">
      <span>City density <b id="townDensityVal">${townDensityLabel(ms.townDensity)}</b></span>
      <input type="range" id="townDensity" min="0.3" max="3" step="0.1" value="${ms.townDensity}">
    </label>
    ${lineRows}`;

  const fontSel = host.querySelector('#townFontSelect');
  fontSel.value = ms.townFont;
  fontSel.addEventListener('change', () => {
    ms.townFont = fontSel.value;
    applyMapStyleLive();
    saveSettings();
  });

  const thick = host.querySelector('#townThick');
  const thickVal = host.querySelector('#townThickVal');
  thick.addEventListener('input', () => {
    ms.townThickness = Number(thick.value);
    thickVal.textContent = ms.townThickness.toFixed(1);
    applyMapStyleLive();
    saveSettings();
  });

  const size = host.querySelector('#townSize');
  const sizeVal = host.querySelector('#townSizeVal');
  size.addEventListener('input', () => {
    ms.townSize = Number(size.value);
    sizeVal.textContent = ms.townSize.toFixed(1) + '×';
    applyMapStyleLive();
    saveSettings();
  });

  const townColor = host.querySelector('#townColor');
  const townColorOn = host.querySelector('#townColorOn');
  const pushTownColor = () => {
    ms.townColor = townColorOn.checked ? townColor.value : '';
    // text-color can't be un-set live once overridden, so a full basemap restyle
    // (which rebuilds every layer from stock, then re-applies these options) is
    // needed to return to the basemap's native label colour.
    if (!ms.townColor) setBasemap(state.basemap);
    else applyMapStyleLive();
    saveSettings();
  };
  townColor.addEventListener('input', () => {
    if (!townColorOn.checked) townColorOn.checked = true;
    pushTownColor();
  });
  townColorOn.addEventListener('change', pushTownColor);

  const density = host.querySelector('#townDensity');
  const densityVal = host.querySelector('#townDensityVal');
  density.addEventListener('input', () => {
    ms.townDensity = Number(density.value);
    densityVal.textContent = townDensityLabel(ms.townDensity);
    applyMapStyleLive();
    saveSettings();
  });

  for (const { key, optionalColor } of MAP_LINE_CONTROLS) {
    const width = host.querySelector(`#${key}Width`);
    const widthVal = host.querySelector(`#${key}WidthVal`);
    width.addEventListener('input', () => {
      ms[`${key}Width`] = Number(width.value);
      widthVal.textContent = ms[`${key}Width`].toFixed(1) + '×';
      applyMapStyleLive();
    });
    const color = host.querySelector(`#${key}Color`);
    const colorOn = host.querySelector(`#${key}ColorOn`);
    const pushColor = () => {
      if (optionalColor && colorOn && !colorOn.checked) ms[`${key}Color`] = '';
      else ms[`${key}Color`] = color.value;
      applyMapStyleLive();
    };
    color.addEventListener('input', () => {
      if (colorOn && !colorOn.checked) colorOn.checked = true;
      pushColor();
    });
    if (colorOn) colorOn.addEventListener('change', pushColor);
  }
}

// ---------------------------------------------------------------------------
// Freehand-draw tool appearance (colour + line width)
// ---------------------------------------------------------------------------
// Push the stored draw appearance into the live MapTools instance.
function applyDrawStyle() {
  if (!state.mapTools) return;
  state.mapTools.setDrawColor(state.draw.color);
  state.mapTools.setDrawWidth(state.draw.width);
}

function setupDrawStyleControls() {
  const host = el.drawStyleControls;
  if (!host) return;
  const d = state.draw;
  host.innerHTML = `
    <div class="ms-line">
      <span class="ms-line-name">Draw</span>
      <label class="field opacity-field ms-line-width">
        <span>Thickness <b id="drawWidthVal">${d.width.toFixed(1)}px</b></span>
        <input type="range" id="drawWidth" min="1" max="10" step="0.5" value="${d.width}">
      </label>
      <div class="ms-line-color">
        <input type="color" id="drawColor" value="${d.color}">
      </div>
    </div>`;

  const width = host.querySelector('#drawWidth');
  const widthVal = host.querySelector('#drawWidthVal');
  width.addEventListener('input', () => {
    state.draw.width = Number(width.value);
    widthVal.textContent = state.draw.width.toFixed(1) + 'px';
    applyDrawStyle();
    saveSettings();
  });
  const color = host.querySelector('#drawColor');
  color.addEventListener('input', () => {
    state.draw.color = color.value;
    applyDrawStyle();
    saveSettings();
  });
}

// ---------------------------------------------------------------------------
// Per-alert-kind appearance customisation UI
// ---------------------------------------------------------------------------
// Effective default appearance of one alert kind, before any user override.
function alertKindDefault(name, defColor) {
  return {
    color: defColor,
    fillOpacity: DEFAULT_ALERT_FILL_OPACITY,
    outlineColor: defColor,
    outlineWidth: DEFAULT_ALERT_OUTLINE_WIDTH,
  };
}

function setupAlertStyleControls() {
  const host = el.alertStyleControls;
  if (!host) return;
  const kinds = styleableAlertKinds();

  host.innerHTML = kinds
    .map(([name, defColor]) => {
      const ov = state.alertStyle[name] || {};
      const d = alertKindDefault(name, defColor);
      const fill = ov.color || d.color;
      const opacity = Math.round((typeof ov.fillOpacity === 'number' ? ov.fillOpacity : d.fillOpacity) * 100);
      const outline = ov.outlineColor || d.outlineColor;
      const owidth = typeof ov.outlineWidth === 'number' ? ov.outlineWidth : d.outlineWidth;
      const id = cssId(name);
      return `
        <div class="as-kind" data-name="${escHtml(name)}">
          <div class="as-head">
            <span class="as-sw" id="sw-${id}" style="background:${fill}"></span>
            <span class="as-nm">${escHtml(name)}</span>
            <button type="button" class="as-reset" data-name="${escHtml(name)}">Reset</button>
          </div>
          <div class="as-controls">
            <label class="as-ctl"><span>Fill</span><input type="color" data-prop="color" value="${fill}"></label>
            <label class="as-ctl"><span>Opacity <b class="as-opv">${opacity}%</b></span><input type="range" min="0" max="100" data-prop="fillOpacity" value="${opacity}"></label>
            <label class="as-ctl"><span>Outline</span><input type="color" data-prop="outlineColor" value="${outline}"></label>
            <label class="as-ctl"><span>Outline width <b class="as-owv">${owidth.toFixed(1)}</b></span><input type="range" min="0" max="8" step="0.5" data-prop="outlineWidth" value="${owidth}"></label>
          </div>
        </div>`;
    })
    .join('');

  const commit = () => {
    setAlertStyle(state.alertStyle);
    if (state.alerts) state.alerts.restyle();
    saveSettings();
  };

  host.querySelectorAll('.as-kind').forEach((row) => {
    const name = row.dataset.name;
    const sw = row.querySelector('.as-sw');
    row.querySelectorAll('input[data-prop]').forEach((input) => {
      input.addEventListener('input', () => {
        const ov = state.alertStyle[name] || (state.alertStyle[name] = {});
        const prop = input.dataset.prop;
        if (prop === 'fillOpacity') {
          ov.fillOpacity = Number(input.value) / 100;
          row.querySelector('.as-opv').textContent = input.value + '%';
        } else if (prop === 'outlineWidth') {
          ov.outlineWidth = Number(input.value);
          row.querySelector('.as-owv').textContent = ov.outlineWidth.toFixed(1);
        } else {
          ov[prop] = input.value;
          if (prop === 'color') sw.style.background = input.value;
        }
        commit();
      });
    });
    row.querySelector('.as-reset').addEventListener('click', () => {
      delete state.alertStyle[name];
      commit();
      rebuildAlertStyleRow(row, name);
    });
  });
}

// Repaint one alert-kind row's controls back to the kind's defaults after a
// reset (the override entry has already been removed from state.alertStyle).
function rebuildAlertStyleRow(row, name) {
  const entry = styleableAlertKinds().find(([n]) => n === name);
  if (!entry) return;
  const d = alertKindDefault(name, entry[1]);
  row.querySelector('.as-sw').style.background = d.color;
  row.querySelector('input[data-prop="color"]').value = d.color;
  row.querySelector('input[data-prop="outlineColor"]').value = d.outlineColor;
  const op = row.querySelector('input[data-prop="fillOpacity"]');
  op.value = Math.round(d.fillOpacity * 100);
  row.querySelector('.as-opv').textContent = op.value + '%';
  const ow = row.querySelector('input[data-prop="outlineWidth"]');
  ow.value = d.outlineWidth;
  row.querySelector('.as-owv').textContent = d.outlineWidth.toFixed(1);
}

// Safe id/selector fragment from an alert display name.
function cssId(s) { return String(s).replace(/[^a-z0-9]+/gi, '-').toLowerCase(); }
function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'
  );
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
        smoothByMode: state.smoothByMode,
        basemap: state.basemap,
        uiTheme: state.uiTheme,
        mapStyle: state.mapStyle,
        alertStyle: state.alertStyle,
        alertOpacity: state.alertOpacity,
        showRings: state.showRings,
        siteMarkerStyle: state.siteMarkerStyle,
        tzLocal: state.tzLocal,
        timeSource: state.timeSource,
        mapProvider: state.mapProvider,
        dealias: state.dealias,
        radarLegacyProducts: { ...state.radarLegacyProducts },
        radarOverlay: state.radarOverlay,
        metarsOn: state.metars ? state.metars.enabled : state._metarsOn,
        lsr: state.lsr
          ? { on:state.lsr.enabled, hours:state.lsr.hours, cats:{ ...state.lsr.cats } }
          : { ...state._lsr, cats:{ ...state._lsr.cats } },
        modelCityValues: state.modelCityValues,
        cityValuesProducts: state.cityValuesProducts,
        cityReadout: state.cityReadout,
        layers: {
          enabled: !!state.layers.enabled,
          activeId: state.layers.activeId,
          items: state.layers.items.map(({ id, source, productId, detailId, style, siteId, satKey, sectorKey, modelKey }) =>
            ({ id, source, productId, detailId, style, siteId, satKey, sectorKey, modelKey })),
        },
        alertsOn: state.alerts ? state.alerts.enabled : true,
        cyclones: state.cyclones
          ? { on: state.cyclones.enabled, ...state.cyclones.show }
          : { ...state._cyclones },
        lsr: state.lsr
          ? { on: state.lsr.enabled, hours: state.lsr.hours, cats: { ...state.lsr.cats } }
          : { ...state._lsr, cats: { ...state._lsr.cats } },
        spc: state.spc
          ? {
              on: state._outlookSourceForced && typeof state._outlookSourcePrevOn === 'boolean'
                ? state._outlookSourcePrevOn
                : state.spc.enabled,
              product: state.spc.product,
              detail: state.spc.detail,
              opacity: state.spcOpacity,
            }
          : { ...state._spc, opacity: state.spcOpacity },
        playbackFrames: state.playbackFrames,
        reduceMotion: state.reduceMotion,
        panelCollapsed: state.panelCollapsed,
        draw: state.draw,
        keybinds: state.keybinds,
        dockTool: state.dockTool,
        sat: {
          satKey: state.sat.satKey,
          sectorKey: state.sat.sectorKey,
          conusView: state.sat.conusView,
          productId: state.sat.productId,
          enhanceIR: state.sat.enhanceIR,
        },
        mrms: { productId: state.mrms.productId },
        models: { modelKey: state.models.modelKey, productId: state.models.productId, stormId: state.models.stormId },
        observations: { productId: state.observations.productId },
        meso: { active: state.meso.active, sector: state.meso.sector, code: state.meso.code, frameCount: state.meso.frameCount },
        map: c && isFinite(c.lng) ? { lng: c.lng, lat: c.lat, zoom: m.getZoom() } : null,
      };
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
    } catch (_) {
      /* storage full or blocked — settings still apply for this session */
    }
  }, 400);
}

// Keep only well-formed per-kind alert overrides from storage so a corrupted or
// hand-edited blob can't feed bad values into the GL paint expressions.
function sanitizeAlertStyle(raw) {
  const out = {};
  for (const [name, ov] of Object.entries(raw || {})) {
    if (!ov || typeof ov !== 'object') continue;
    const clean = {};
    if (typeof ov.color === 'string') clean.color = ov.color;
    if (typeof ov.outlineColor === 'string') clean.outlineColor = ov.outlineColor;
    if (typeof ov.fillOpacity === 'number')
      clean.fillOpacity = Math.max(0, Math.min(1, ov.fillOpacity));
    if (typeof ov.outlineWidth === 'number')
      clean.outlineWidth = Math.max(0, Math.min(12, ov.outlineWidth));
    if (Object.keys(clean).length) out[name] = clean;
  }
  return out;
}

// Fold stored settings into `state` defaults before the map and UI are built, so
// the first render already reflects them (basemap, last view, last product…).
function applyStoredSettings(s) {
  if (!s || typeof s !== 'object') return;
  if (['radar', 'satellite', 'mrms', 'models', 'observations', 'outlooks'].includes(s.mode)) state.mode = s.mode;
  if (typeof s.site === 'string') state.site = s.site;
  if (typeof s.productId === 'string') state.productId = s.productId;
  if (typeof s.opacity === 'number') state.opacity = s.opacity;
  // Migrate the old boolean smooth toggle (true ≈ medium) to the 0–3 level.
  if (typeof s.smooth === 'number') state.smooth = Math.max(0, Math.min(3, s.smooth | 0));
  else if (typeof s.smooth === 'boolean') state.smooth = s.smooth ? 2 : 0;
  if (s.smoothByMode && typeof s.smoothByMode === 'object') {
    for (const key of Object.keys(state.smoothByMode)) {
      if (typeof s.smoothByMode[key] === 'number')
        state.smoothByMode[key] = Math.max(0, Math.min(3, s.smoothByMode[key] | 0));
    }
  } else {
    // Older blobs stored one global level — seed every mode with it.
    for (const key of Object.keys(state.smoothByMode)) state.smoothByMode[key] = state.smooth;
  }
  // The active value follows the (restored) mode's own setting.
  state.smooth = state.smoothByMode[state.mode] ?? state.smooth;
  if (typeof s.basemap === 'string' && BASEMAPS[s.basemap]) state.basemap = s.basemap;
  if (s.uiTheme === 'dark' || s.uiTheme === 'light') state.uiTheme = s.uiTheme;
  if (typeof s.reduceMotion === 'boolean') state.reduceMotion = s.reduceMotion;
  if (s.mapStyle && typeof s.mapStyle === 'object') state.mapStyle = normalizeMapStyle(s.mapStyle);
  if (s.alertStyle && typeof s.alertStyle === 'object') state.alertStyle = sanitizeAlertStyle(s.alertStyle);
  if (typeof s.alertOpacity === 'number') state.alertOpacity = Math.max(0.1, Math.min(1, s.alertOpacity));
  if (typeof s.showRings === 'boolean') state.showRings = s.showRings;
  if (s.siteMarkerStyle === 'dot' || s.siteMarkerStyle === 'pill') state.siteMarkerStyle = s.siteMarkerStyle;
  if (typeof s.tzLocal === 'boolean') state.tzLocal = s.tzLocal;
  if (s.timeSource === 'now' || s.timeSource === 'product') state.timeSource = s.timeSource;
  if (s.mapProvider === 'mapbox' || s.mapProvider === 'maptiler') state.mapProvider = s.mapProvider;
  if (typeof s.dealias === 'boolean') state.dealias = s.dealias;
  // New per-product form; also accept the old global boolean so a saved
  // "legacy on" preference carries over to every product.
  if (s.radarLegacyProducts && typeof s.radarLegacyProducts === 'object') {
    const next = {};
    for (const id of Object.keys(PRODUCTS))
      if (s.radarLegacyProducts[id]) next[id] = true;
    state.radarLegacyProducts = next;
  } else if (typeof s.radarLegacy === 'boolean') {
    state.radarLegacyProducts = {};
    if (s.radarLegacy) for (const id of Object.keys(PRODUCTS)) state.radarLegacyProducts[id] = true;
  }
  if (typeof s.radarOverlay === 'boolean') state.radarOverlay = s.radarOverlay;
  if (s.lsr && typeof s.lsr === 'object') {
    if (typeof s.lsr.on === 'boolean') state._lsr.on = s.lsr.on;
    if (LSR_HOURS_CHOICES.includes(s.lsr.hours)) state._lsr.hours = s.lsr.hours;
    if (s.lsr.cats && typeof s.lsr.cats === 'object') {
      for (const key of Object.keys(state._lsr.cats))
        if (typeof s.lsr.cats[key] === 'boolean') state._lsr.cats[key] = s.lsr.cats[key];
    }
  }
  if (s.panelCollapsed && typeof s.panelCollapsed === 'object') {
    state.panelCollapsed = {};
    for (const [key, val] of Object.entries(s.panelCollapsed)) {
      if (typeof val === 'boolean') state.panelCollapsed[key] = val;
    }
  }
  if (typeof s.metarsOn === 'boolean') state._metarsOn = s.metarsOn;
  if (typeof s.modelCityValues === 'boolean') state.modelCityValues = s.modelCityValues;
  if (s.cityValuesProducts && typeof s.cityValuesProducts === 'object') {
    state.cityValuesProducts = {};
    for (const [key, val] of Object.entries(s.cityValuesProducts)) {
      if (typeof val === 'boolean') state.cityValuesProducts[key] = val;
    }
  }
  if (s.cityReadout && typeof s.cityReadout === 'object') {
    if (typeof s.cityReadout.font === 'string') state.cityReadout.font = s.cityReadout.font;
    if (typeof s.cityReadout.size === 'number')
      state.cityReadout.size = Math.max(8, Math.min(48, s.cityReadout.size | 0));
    if (typeof s.cityReadout.color === 'string') state.cityReadout.color = s.cityReadout.color;
  }
  if (s.layers && typeof s.layers === 'object') {
    state.layers.enabled = !!s.layers.enabled;
    state.layers.activeId = typeof s.layers.activeId === 'string' ? s.layers.activeId : null;
    state.layers.items = Array.isArray(s.layers.items)
      ? s.layers.items
        .filter((ly) => ly && LAYER_STACK_SOURCES.includes(ly.source) && typeof ly.productId === 'string')
        .map((ly) => ({
          id: typeof ly.id === 'string' ? ly.id : `layer-${Math.random().toString(36).slice(2, 8)}`,
          source: ly.source,
          productId: ly.productId,
          detailId: typeof ly.detailId === 'string' ? ly.detailId : '',
          style: ly.style === 'contour' ? 'contour' : 'fill',
          // Per-layer targets (validated against the current catalogs; missing
          // ones are backfilled from the live view by ensureLayerTargets at render).
          siteId: typeof ly.siteId === 'string' ? ly.siteId : undefined,
          satKey: typeof ly.satKey === 'string' && SATELLITES[ly.satKey] ? ly.satKey : undefined,
          sectorKey: typeof ly.sectorKey === 'string' ? ly.sectorKey : undefined,
          modelKey: typeof ly.modelKey === 'string' && MODELS[ly.modelKey] ? ly.modelKey : undefined,
        }))
      : [];
    if (!state.layers.items.some((ly) => ly.id === state.layers.activeId))
      state.layers.activeId = state.layers.items[0] ? state.layers.items[0].id : null;
  }
  if (typeof s.playbackFrames === 'number') state.playbackFrames = s.playbackFrames;
  if (s.draw && typeof s.draw === 'object') {
    if (typeof s.draw.color === 'string') state.draw.color = s.draw.color;
    if (typeof s.draw.width === 'number' && s.draw.width > 0) state.draw.width = s.draw.width;
  }
  if (s.keybinds && typeof s.keybinds === 'object') state._storedKeybinds = s.keybinds;
  if (typeof s.dockTool === 'string') state.dockTool = s.dockTool;
  if (typeof s.alertsOn === 'boolean') state._alertsOn = s.alertsOn;
  if (s.cyclones && typeof s.cyclones === 'object') {
    for (const key of ['on', 'path', 'current', 'cone']) {
      if (typeof s.cyclones[key] === 'boolean') state._cyclones[key] = s.cyclones[key];
    }
  }
  if (s.lsr && typeof s.lsr === 'object') {
    if (typeof s.lsr.on === 'boolean') state._lsr.on = s.lsr.on;
    if (LSR_HOURS_CHOICES.includes(s.lsr.hours)) state._lsr.hours = s.lsr.hours;
    if (s.lsr.cats && typeof s.lsr.cats === 'object') {
      for (const key of Object.keys(state._lsr.cats))
        if (typeof s.lsr.cats[key] === 'boolean') state._lsr.cats[key] = s.lsr.cats[key];
    }
  }
  if (s.spc && typeof s.spc === 'object') {
    if (typeof s.spc.on === 'boolean') state._spc.on = s.spc.on;
    if (typeof s.spc.opacity === 'number' && isFinite(s.spc.opacity))
      state.spcOpacity = Math.max(0.05, Math.min(0.9, s.spc.opacity));
    // New shape: product + detail. Restore only if the product still exists; the
    // controller re-validates the detail against that product when it builds.
    if (typeof s.spc.product === 'string' && OUTLOOKS[s.spc.product]) {
      state._spc.product = s.spc.product;
      if (typeof s.spc.detail === 'string') state._spc.detail = s.spc.detail;
    }
  }
  if (s.sat && typeof s.sat === 'object') {
    if (typeof s.sat.satKey === 'string') state.sat.satKey = s.sat.satKey;
    if (typeof s.sat.sectorKey === 'string') state.sat.sectorKey = s.sat.sectorKey;
    if (typeof s.sat.conusView === 'number')
      state.sat.conusView = Math.max(0, Math.min(CONUS_VIEWS.length - 1, s.sat.conusView | 0));
    if (typeof s.sat.productId === 'string') state.sat.productId = s.sat.productId;
    if (typeof s.sat.enhanceIR === 'boolean') state.sat.enhanceIR = s.sat.enhanceIR;
    const satSectors = sectorsForSatellite(state.sat.satKey);
    if (!satSectors[state.sat.sectorKey]) state.sat.sectorKey = Object.keys(satSectors)[0];
  }
  if (s.mrms && typeof s.mrms.productId === 'string') state.mrms.productId = s.mrms.productId;
  if (s.models && typeof s.models === 'object') {
    if (typeof s.models.modelKey === 'string' && MODELS[s.models.modelKey]) state.models.modelKey = s.models.modelKey;
    if (typeof s.models.productId === 'string') state.models.productId = s.models.productId;
    if (typeof s.models.stormId === 'string') state.models.stormId = s.models.stormId;
    // A restored product might not exist on the restored model.
    if (!modelSupports(state.models.modelKey, state.models.productId))
      state.models.productId = defaultProductFor(state.models.modelKey);
  }
  if (s.observations && typeof s.observations.productId === 'string' && OBS_PRODUCTS[s.observations.productId])
    state.observations.productId = s.observations.productId;
  if (s.meso && typeof s.meso === 'object') {
    if (typeof s.meso.active === 'boolean') state.meso.active = s.meso.active;
    if (MESO_SECTORS.some((x) => x.id === s.meso.sector)) state.meso.sector = s.meso.sector;
    if (MESO_PRODUCTS[s.meso.code]) state.meso.code = s.meso.code;
    if (MESO_FRAME_COUNTS.includes(s.meso.frameCount)) state.meso.frameCount = s.meso.frameCount;
  }
  if (s.map && isFinite(s.map.lng) && isFinite(s.map.lat)) state._restoreView = s.map;
}

// Flip an ON/OFF toggle button to a given state (class + label together).
function setToggleBtn(btn, on) {
  if (!btn) return;
  btn.classList.toggle('active', !!on);
  btn.setAttribute('aria-pressed', String(!!on));
  btn.textContent = on ? 'ON' : 'OFF';
}

function resolutionLabel(azimuthSpacing, gateSpacing) {
  const az = Number.isFinite(azimuthSpacing)
    ? `${azimuthSpacing.toFixed(azimuthSpacing < 1 ? 1 : 0)}\u00b0`
    : '?\u00b0';
  const gate = Number.isFinite(gateSpacing)
    ? (gateSpacing >= 1000 ? `${gateSpacing / 1000} km` : `${Math.round(gateSpacing)} m`)
    : '? m';
  return `${az} \u00d7 ${gate}`;
}

function updateRadarResolutionUI() {
  const isLevel2 = state.mode === 'radar' && !isL3Product(state.productId) && !!PRODUCTS[state.productId];
  if (el.radarResolutionField) el.radarResolutionField.hidden = !isLevel2;
  const legacyHere = isLegacyResolution(state.productId);
  setToggleBtn(el.radarResolutionToggle, legacyHere);
  if (!el.radarResolutionHint || !isLevel2) return;
  const product = PRODUCTS[state.productId];
  const sourceSweep = pickSweep(state.sweeps, state.productId);
  const info = describeSweepResolution(sourceSweep, product.moment);
  if (!info.available) {
    el.radarResolutionHint.textContent = `${product.name}: resolution detected when a scan loads`;
    return;
  }
  if (legacyHere && info.superResolution) {
    el.radarResolutionHint.textContent =
      `${product.name}: legacy view ${resolutionLabel(info.targetAzimuthSpacing, info.targetGateSpacing)}`;
  } else if (info.legacyEnough) {
    const archive = state.volume && state.volume.messageType === 1 ? 'Archive auto-detected' : 'Native source';
    el.radarResolutionHint.textContent =
      `${product.name} — ${archive}: legacy ${resolutionLabel(info.azimuthSpacing, info.gateSpacing)}`;
  } else {
    el.radarResolutionHint.textContent =
      `${product.name}: native super-res ${resolutionLabel(info.azimuthSpacing, info.gateSpacing)}`;
  }
}

// Reflect the real split-view state onto the sidebar's Layout switch buttons.
function updateLayoutSwitchUI() {
  if (!el.layoutSwitch) return;
  const split = !!(state.splitView && state.splitView.active);
  const paneCount = split ? (state.splitView.paneCount || 2) : 1;
  el.layoutSwitch.querySelectorAll('.layout-btn').forEach((b) => {
    const active =
      (!split && b.dataset.layout === 'single') ||
      (split && paneCount === 2 && b.dataset.layout === 'split2') ||
      (split && paneCount === 4 && b.dataset.layout === 'quad4');
    b.classList.toggle('active', active);
  });
}

// (Re)render any Lucide icon placeholders (<i data-lucide="...">) added to the
// static chrome. Safe to call repeatedly — Lucide just swaps matching <i>
// elements for inline <svg>, and no-ops once an element is already swapped.
let _iconRetries = 0;
function refreshIcons() {
  if (window.lucide && window.lucide.createIcons) { window.lucide.createIcons(); _iconRetries = 0; }
  else if (_iconRetries++ < 40) setTimeout(refreshIcons, 60);
}

// Push restored settings onto their UI controls (run once, after the controls
// exist but before the first data load). state already holds the restored values.
// Smoothing slider stops, indexed by level (0 = none … 3 = high).
const SMOOTH_LABELS = ['None', 'Low', 'Medium', 'High'];

// Apply a smoothing level (0–3) to every live data layer + the slider label.
// The level is remembered per source mode (see state.smoothByMode); setMode
// re-applies the target mode's own level on every switch.
function applySmooth(level) {
  state.smooth = Math.max(0, Math.min(3, level | 0));
  state.smoothByMode[state.mode] = state.smooth;
  if (el.smooth) el.smooth.value = String(state.smooth);
  if (el.smoothVal) el.smoothVal.textContent = SMOOTH_LABELS[state.smooth];
  if (el.smoothSegs) {
    el.smoothSegs.querySelectorAll('.seg-btn').forEach((b) =>
      b.classList.toggle('active', Number(b.dataset.level) === state.smooth)
    );
  }
  if (state.radarLayer) state.radarLayer.setSmooth(state.smooth);
  if (state.sat.layer) state.sat.layer.setSmooth(state.smooth);
  if (state.mrms.layer) state.mrms.layer.setSmooth(state.smooth);
  if (state.models.layer) state.models.layer.setSmooth(state.smooth);
  if (state.observations.layer) state.observations.layer.setSmooth(state.smooth);
  if (state.splitView) state.splitView.setSmooth(state.smooth);
  renderLayerStack();
}

function reflectStoredControls() {
  if (el.opacity) {
    el.opacity.value = String(Math.round(state.opacity * 100));
    el.opacityVal.textContent = el.opacity.value + '%';
  }
  setToggleBtn(el.ringsToggle, state.showRings);
  setToggleBtn(el.dealiasToggle, state.dealias);
  updateRadarResolutionUI();
  if (el.smooth) { el.smooth.value = String(state.smooth); el.smoothVal.textContent = SMOOTH_LABELS[state.smooth]; }
  if (el.alertOpacity) {
    el.alertOpacity.value = String(Math.round(state.alertOpacity * 100));
    el.alertOpacityVal.textContent = el.alertOpacity.value + '%';
  }
  setToggleBtn(el.radarOverlayToggle, state.radarOverlay);
  setToggleBtn(el.metarsToggle, state._metarsOn);
  setToggleBtn(el.modelCityValuesToggle, state.modelCityValues);
  setToggleBtn(el.layeringToggle, state.layers.enabled);
  if (el.layerControls) el.layerControls.hidden = !state.layers.enabled;
  if (typeof state._alertsOn === 'boolean') setToggleBtn(el.alertsToggle, state._alertsOn);
  if (el.mapProviderSelect) el.mapProviderSelect.value = state.mapProvider;
  if (el.basemapSelect) el.basemapSelect.value = state.basemap;
  if (el.uiThemeSelect) el.uiThemeSelect.value = state.uiTheme;
  if (el.siteMarkerSelect) el.siteMarkerSelect.value = state.siteMarkerStyle;
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
// First-run setup gate: the map needs a Mapbox public token the user supplies
// themselves. If none is stored, show the gate and stop boot here; the rest of
// init runs after the user saves a token (which reloads the page).
function showMapboxGate(message, provider = state.mapProvider || getStoredMapProvider()) {
  const gate = document.getElementById('mbxGate');
  if (!gate) return;
  const input = document.getElementById('mbxGateInput');
  const providerSelect = document.getElementById('mbxGateProvider');
  const btn = document.getElementById('mbxGateSave');
  const err = document.getElementById('mbxGateError');
  gate.hidden = false;
  if (message && err) err.textContent = message;
  provider = provider === 'maptiler' ? 'maptiler' : 'mapbox';
  if (providerSelect) providerSelect.value = provider;
  const updatePlaceholder = () => {
    const p = providerSelect && providerSelect.value === 'maptiler' ? 'maptiler' : 'mapbox';
    if (input) input.placeholder = p === 'maptiler' ? 'MapTiler public key' : 'pk.eyJ1Ijoi...';
    const saved = getStoredMapToken(p);
    if (input && saved && !input.value) input.value = saved;
  };
  if (providerSelect) {
    providerSelect.addEventListener('change', () => {
      if (input) input.value = '';
      if (err) err.textContent = '';
      updatePlaceholder();
    });
  }
  const prior = getStoredMapToken(provider);
  if (prior && input) input.value = prior;
  updatePlaceholder();
  const submit = () => {
    const p = providerSelect && providerSelect.value === 'maptiler' ? 'maptiler' : 'mapbox';
    const tok = (input.value || '').trim();
    if (p === 'mapbox' && !/^pk\.[A-Za-z0-9._-]+$/.test(tok)) {
      err.textContent = 'That does not look like a Mapbox public token; it should start with pk.';
      return;
    }
    if (p === 'maptiler' && tok.length < 8) {
      err.textContent = 'Paste a MapTiler public key.';
      return;
    }
    try {
      localStorage.setItem(p === 'maptiler' ? MAPTILER_TOKEN_KEY : MAPBOX_TOKEN_KEY, tok);
      localStorage.setItem(MAP_PROVIDER_KEY, p);
    } catch {
      err.textContent = 'Could not save the key (storage blocked). Enable site storage and retry.';
      return;
    }
    location.reload();
  };
  btn.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });
  input.focus();
}

function init() {
  cacheEls();
  applyStoredSettings(loadSettings()); // restore last session before building UI
  applyUiTheme(state.uiTheme);
  state.mapProvider = getStoredMapProvider();
  MAPBOX_TOKEN = getStoredMapToken(state.mapProvider);
  if (!MAPBOX_TOKEN) {
    showMapboxGate(undefined, state.mapProvider);
    return;
  }
  initMap();
  enableLongPress();
  buildSiteSelect();
  restoreStoredPals(); // re-apply any saved .pal color tables before first paint
  buildProductButtons();
  buildLegend();
  buildTiltList();
  enableHorizontalRailScroll(el.tiltList);
  enableHorizontalRailScroll(el.fhourList);

  state.playback = createPlayback();
  state.map.on('move', updateInspect);
  // Remember the last map position (debounced) so a reload reopens the same view.
  state.map.on('moveend', saveSettings);

  // Reflect any restored toggle/slider settings onto their controls.
  reflectStoredControls();
  setupLayerControls();
  buildCityValueProductControls();

  // Source-mode switch + satellite controls.
  initSatSelects();
  initModelSelects();
  initMesoControls();
  // Obs-mode Analysis picker: RTMA gridded overlay vs. SPC Mesoanalysis plots.
  if (el.obsDomainSelect) {
    el.obsDomainSelect.value = state.meso.active ? 'MESO' : 'RTMA';
    el.obsDomainSelect.addEventListener('change', () => {
      setMesoActive(el.obsDomainSelect.value === 'MESO');
    });
  }
  applyModePanels();
  el.modeSwitch.addEventListener('click', (e) => {
    const btn = e.target.closest('.mode-btn');
    if (btn) setMode(btn.dataset.mode);
  });

  syncDateToUtcToday();
  el.dateInput.addEventListener('change', () => {
    const [y, m, d] = el.dateInput.value.split('-').map(Number);
    state.date = new Date(Date.UTC(y, m - 1, d));
    state._forceLatest = true;
    refreshActive();
  });

  el.refreshBtn.addEventListener('click', () => refreshActive());
  el.liveBtn.addEventListener('click', toggleLive);
  // Radar-only Archive-mode toggle (replaces the LIVE button in radar).
  if (el.archiveToggle) {
    el.archiveToggle.addEventListener('click', () =>
      setRadarArchive(!state.radarArchive)
    );
  }

  // Clock time-zone toggle (UTC ↔ local).
  if (el.tzToggle) {
    el.tzToggle.addEventListener('click', () => {
      setTzLocal(!state.tzLocal);
      saveSettings();
    });
  }

  // Time-source toggle (selected product's frame time ↔ live clock).
  if (el.timeSrcToggle) {
    el.timeSrcToggle.addEventListener('click', () => {
      setTimeSource(state.timeSource === 'product' ? 'now' : 'product');
      saveSettings();
    });
  }

  // Live-location tool: triggers the Mapbox GeolocateControl, which prompts for
  // permission, drops a tracking dot at the user's position and follows it.
  if (el.toolLocate) {
    el.toolLocate.addEventListener('click', () => {
      if (state.geolocate && state.geolocate.trigger) state.geolocate.trigger();
    });
    if (state.geolocate && state.geolocate.on) {
      state.geolocate.on('trackuserlocationstart', () => el.toolLocate.classList.add('active'));
      state.geolocate.on('trackuserlocationend', () => el.toolLocate.classList.remove('active'));
      state.geolocate.on('error', () => el.toolLocate.classList.remove('active'));
    }
  }
  el.opacity.addEventListener('input', () => {
    state.opacity = el.opacity.value / 100;
    el.opacityVal.textContent = el.opacity.value + '%';
    if (state.radarLayer) state.radarLayer.setOpacity(state.opacity);
    if (state.sat.layer) state.sat.layer.setOpacity(state.opacity);
    if (state.mrms.layer) state.mrms.layer.setOpacity(state.opacity);
    if (state.models.layer) state.models.layer.setOpacity(state.opacity);
    if (state.observations.layer) state.observations.layer.setOpacity(state.opacity);
    if (state.splitView) state.splitView.setOpacity(state.opacity);
    renderLayerStack();
    saveSettings();
  });
  el.palInput.addEventListener('change', (e) => loadPalFile(e.target.files[0]));
  el.palReset.addEventListener('click', resetPalettes);
  setupPaletteCreator();

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

  if (el.radarResolutionToggle) {
    el.radarResolutionToggle.addEventListener('click', () => {
      // The toggle scopes to the currently selected product, so different
      // products can independently sit at legacy or native resolution.
      const productId = state.productId;
      const product = PRODUCTS[productId];
      if (!product) return;
      const on = !isLegacyResolution(productId);
      setLegacyResolution(productId, on);
      updateRadarResolutionUI();
      renderRadar();
      updateInspect();
      renderLayerStack();
      if (state.xsect) state.xsect.refresh(true);
      setStatus(on
        ? `${product.name}: legacy-resolution view on`
        : `${product.name}: native radar resolution`);
      saveSettings();
    });
  }

  // Data smoothing — a Gaussian low-pass on the plotted radar / satellite /
  // model / MRMS field, none → high. It only changes a shader uniform on the
  // live layers, so there's nothing to recompute or reload.
  if (el.smooth) {
    el.smooth.addEventListener('input', () => {
      applySmooth(Number(el.smooth.value));
      setStatus(`smoothing: ${SMOOTH_LABELS[state.smooth].toLowerCase()}`);
      saveSettings();
    });
  }
  // Settings-popup segmented smoothing control — a friendlier face on the same
  // #smooth range input above; driving it through a real 'input' event keeps
  // applySmooth() as the single source of truth.
  if (el.smoothSegs) {
    el.smoothSegs.addEventListener('click', (e) => {
      const btn = e.target.closest('.seg-btn');
      if (!btn) return;
      el.smooth.value = btn.dataset.level;
      el.smooth.dispatchEvent(new Event('input', { bubbles: true }));
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

  if (el.modelCityValuesToggle) {
    el.modelCityValuesToggle.addEventListener('click', () => {
      const on = !el.modelCityValuesToggle.classList.contains('active');
      setToggleBtn(el.modelCityValuesToggle, on);
      state.modelCityValues = on;
      buildCityValueProductControls();
      if (on) renderModelCityValues();
      else clearModelCityValues();
      setStatus(on ? 'city values on' : 'city values off');
      saveSettings();
    });
  }

  // City readout appearance: font / size / color.
  if (el.cityFontSelect) {
    el.cityFontSelect.innerHTML = Object.entries(CITY_READOUT_FONTS)
      .map(([k, v]) => `<option value="${k}">${v.label}</option>`)
      .join('');
    el.cityFontSelect.value = CITY_READOUT_FONTS[state.cityReadout.font] ? state.cityReadout.font : 'default';
    el.cityFontSelect.addEventListener('change', () => {
      state.cityReadout.font = CITY_READOUT_FONTS[el.cityFontSelect.value] ? el.cityFontSelect.value : 'default';
      applyCityReadoutStyle();
      saveSettings();
    });
  }
  if (el.citySize) {
    el.citySize.value = String(state.cityReadout.size);
    if (el.citySizeVal) el.citySizeVal.textContent = String(state.cityReadout.size);
    el.citySize.addEventListener('input', () => {
      state.cityReadout.size = Math.max(8, Math.min(48, Number(el.citySize.value) || 24));
      if (el.citySizeVal) el.citySizeVal.textContent = String(state.cityReadout.size);
      applyCityReadoutStyle();
      saveSettings();
    });
  }
  if (el.cityColor) {
    el.cityColor.value = state.cityReadout.color || '#ffffff';
    el.cityColor.addEventListener('input', () => {
      state.cityReadout.color = el.cityColor.value || '#ffffff';
      applyCityReadoutStyle();
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
      cancelFrameWarm();
      scheduleFrameWarm();
      saveSettings();
    });
  }

  // Global alert opacity — one slider that fades every alert's fill and
  // outline together (multiplied on top of the per-kind overrides).
  if (el.alertOpacity) {
    el.alertOpacity.addEventListener('input', () => {
      state.alertOpacity = Math.max(0.1, Math.min(1, Number(el.alertOpacity.value) / 100));
      el.alertOpacityVal.textContent = Math.round(state.alertOpacity * 100) + '%';
      applyAlertOpacity();
      saveSettings();
    });
  }

  // Push any restored per-kind alert overrides into the classifier before the
  // first alert load so colours/outlines are right from the first paint.
  setAlertStyle(state.alertStyle);

  // Live NWS watches/warnings overlay.
  state.alerts = new AlertsController(state.map, {
    listPanel: el.alertList,
    list: el.alertList,
    detail: el.alertDetail,
    detailPanel: el.alertDetailPanel,
    close: el.alertClose,
    preview: el.alertPreview,
    previewCard: el.alertPreviewCard,
    // Suppress alert briefings while a click-consuming map tool is active, so
    // placing storm-track points / measure vertices doesn't also pop an alert.
    suppressClick: () => clickConsumingToolActive(),
  });
  state.alerts.start();
  if (el.alertsRefresh) {
    el.alertsRefresh.addEventListener('click', async () => {
      el.alertsRefresh.classList.add('loading');
      el.alertsRefresh.disabled = true;
      try {
        await state.alerts.load();
        setStatus('active alerts refreshed');
      } finally {
        el.alertsRefresh.classList.remove('loading');
        el.alertsRefresh.disabled = false;
      }
    });
  }
  // Apply the restored alerts on/off preference (default on).
  if (state._alertsOn === false) state.alerts.setEnabled(false);
  el.alertsToggle.addEventListener('click', () => {
    const on = !el.alertsToggle.classList.contains('active');
    el.alertsToggle.classList.toggle('active', on);
    el.alertsToggle.textContent = on ? 'ON' : 'OFF';
    state.alerts.setEnabled(on);
    saveSettings();
  });

  // ---- Active tropical cyclones overlay (NHC + JTWC) ----
  state.cyclones = new CyclonesController(state.map, {
    list: el.cycloneList,
    status: el.cycloneStatus,
    preview: el.cyclonePreview,
    previewCard: el.cyclonePreviewCard,
    // Same guard as alerts: while a click-consuming map tool is active, taps
    // belong to the tool, not to opening a storm card.
    suppressClick: () => clickConsumingToolActive(),
    onViewSatellite: (storm) => viewCycloneOnSatellite(storm),
    // A new storm set changes the satellite sector picker's cyclone options.
    onStormsChanged: () => rebuildSectorSelect(),
  });
  // Apply the restored master + per-part toggle prefs before the first load.
  state.cyclones.show = {
    path: state._cyclones.path,
    current: state._cyclones.current,
    cone: state._cyclones.cone,
  };
  setToggleBtn(el.cyclonesToggle, state._cyclones.on);
  setToggleBtn(el.cyclonesPathToggle, state._cyclones.path);
  setToggleBtn(el.cyclonesCurrentToggle, state._cyclones.current);
  setToggleBtn(el.cyclonesConeToggle, state._cyclones.cone);
  state.cyclones.setEnabled(state._cyclones.on);
  if (el.cyclonesToggle) {
    el.cyclonesToggle.addEventListener('click', () => {
      const on = !el.cyclonesToggle.classList.contains('active');
      setToggleBtn(el.cyclonesToggle, on);
      state.cyclones.setEnabled(on);
      setStatus(on ? 'tropical cyclones on' : 'tropical cyclones off');
      saveSettings();
    });
  }
  const wireCyclonePart = (btn, part) => {
    if (!btn) return;
    btn.addEventListener('click', () => {
      const on = !btn.classList.contains('active');
      setToggleBtn(btn, on);
      state.cyclones.setShow(part, on);
      saveSettings();
    });
  };
  wireCyclonePart(el.cyclonesPathToggle, 'path');
  wireCyclonePart(el.cyclonesCurrentToggle, 'current');
  wireCyclonePart(el.cyclonesConeToggle, 'cone');

  // ---- NWS local storm reports overlay (IEM feed — all LSR types) ----
  state.lsr = new LsrController(state.map, {
    list: el.lsrList,
    status: el.lsrStatus,
    filters: el.lsrFilters,
    hoursSelect: el.lsrHours,
    preview: el.lsrPreview,
    previewCard: el.lsrPreviewCard,
    // Same guard as alerts/cyclones: while a click-consuming map tool is
    // active, taps belong to the tool, not to opening a report card.
    suppressClick: () => clickConsumingToolActive(),
    // Time-window / category-chip changes are user prefs — persist them.
    onPrefsChanged: () => saveSettings(),
  });
  // Apply the restored master toggle + time window + category filters before
  // the first load.
  state.lsr.hours = state._lsr.hours;
  state.lsr.cats = { ...state._lsr.cats };
  if (el.lsrHours) el.lsrHours.value = String(state._lsr.hours);
  setToggleBtn(el.lsrToggle, state._lsr.on);
  state.lsr.setEnabled(state._lsr.on);
  if (el.lsrToggle) {
    el.lsrToggle.addEventListener('click', () => {
      const on = !el.lsrToggle.classList.contains('active');
      setToggleBtn(el.lsrToggle, on);
      state.lsr.setEnabled(on);
      setStatus(on ? 'storm reports on' : 'storm reports off');
      saveSettings();
    });
  }

  // ---- Basemap layer customisation (town labels, roads, rivers, borders) ----
  setupMapStyleControls();
  // ---- Per-alert-kind appearance customisation ----
  setupAlertStyleControls();
  // ---- Freehand-draw tool appearance ----
  setupDrawStyleControls();
  // ---- Keyboard shortcuts (products, tools, playback; user-customisable) ----
  setupKeybinds();

  // ---- SPC convective outlook overlay (days 1–8) ----
  setupSpcOutlook();

  // ---- Map tools: METARs, draw / measure / storm track, split view ----
  setupMapTools();
  // ---- Mobile dock swappable tool slot (delegates to the map tools above) ----
  setupDockTools();

  // ---- Mobile dock + sheet + playback + inspect wiring ----
  // The product chip opens the Products popup (just the products for the current
  // source, plus satellite/model selection where there are no map dots).
  el.dockStatus.addEventListener('click', () => {
    if (!mqSmallScreen.matches) return;
    el.sheet.hidden ? openSheet('products') : closeSheet();
  });
  // Dock settings button (mobile) opens the full Settings popup.
  if (el.dockSettings) {
    el.dockSettings.addEventListener('click', () =>
      el.sheet.hidden ? openSheet('settings') : closeSheet()
    );
  }
  // Back / forward step through frames like the desktop arrow keys.
  if (el.dockBack) el.dockBack.addEventListener('click', () => stepFrame(-1));
  if (el.dockFwd) el.dockFwd.addEventListener('click', () => stepFrame(1));
  // The source button morphs the dock into a source picker.
  setupDockSourcePicker();
  // Mobile top bar: the site chip opens the Settings popup (radar site / source
  // live under Settings now); the theme button flips light/dark.
  if (el.mtbSite) {
    el.mtbSite.addEventListener('click', () =>
      el.sheet.hidden ? openSheet('settings') : closeSheet()
    );
  }
  if (el.mtbTheme) {
    el.mtbTheme.addEventListener('click', () => {
      applyUiTheme(state.uiTheme === 'dark' ? 'light' : 'dark');
      saveSettings();
    });
  }
  el.sheetScrim.addEventListener('click', closeSheet);
  el.sheetGrip.addEventListener('click', closeSheet);
  enableSheetSwipe();
  setupSheetPager();

  // ---- Desktop settings drawer: same sheet, opened from the sidebar ----
  if (el.settingsBtn) {
    el.settingsBtn.addEventListener('click', () =>
      el.sheet.hidden ? openSheet() : closeSheet()
    );
  }
  if (el.moreSettingsToggle) {
    el.moreSettingsToggle.addEventListener('click', () =>
      setMoreSettingsCollapsed(!el.moreSettingsBody.classList.contains('collapsed'))
    );
  }

  if (el.mapProviderSelect) {
    el.mapProviderSelect.value = state.mapProvider;
    el.mapProviderSelect.addEventListener('change', () => setMapProvider(el.mapProviderSelect.value));
  }
  el.basemapSelect.value = state.basemap;
  el.basemapSelect.addEventListener('change', () =>
    setBasemap(el.basemapSelect.value)
  );
  if (el.uiThemeSelect) {
    el.uiThemeSelect.value = state.uiTheme;
    el.uiThemeSelect.addEventListener('change', () => {
      applyUiTheme(el.uiThemeSelect.value);
      saveSettings();
    });
  }
  document.body.classList.toggle('reduce-motion', state.reduceMotion);
  if (el.reduceMotionToggle) {
    setToggleBtn(el.reduceMotionToggle, state.reduceMotion);
    el.reduceMotionToggle.addEventListener('click', () => {
      state.reduceMotion = !state.reduceMotion;
      document.body.classList.toggle('reduce-motion', state.reduceMotion);
      setToggleBtn(el.reduceMotionToggle, state.reduceMotion);
      saveSettings();
    });
  }
  if (el.siteMarkerSelect) {
    el.siteMarkerSelect.value = state.siteMarkerStyle;
    el.siteMarkerSelect.addEventListener('change', () => {
      state.siteMarkerStyle = el.siteMarkerSelect.value === 'pill' ? 'pill' : 'dot';
      refreshSiteDots();
      saveSettings();
    });
  }
  el.inspectBtn.addEventListener('click', () => toggleInspect());
  if (el.toolInspect) el.toolInspect.addEventListener('click', () => toggleInspect());

  // ---- Model sounding launcher: right-click (desktop) / long-press (mobile) ----
  // In models mode, opening a sounding is a map gesture on the point of interest
  // rather than a toolbar button. Right-click maps straight to contextmenu;
  // touch uses a ~500 ms press that cancels if the finger moves (a drag/pan) so
  // it never fights panning.
  setupSoundingGestures();
  el.sndClose.addEventListener('click', closeSounding);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el.sounding.hidden) closeSounding();
  });

  el.playBtn.addEventListener('click', () => {
    if (mesoActive()) { toggleMesoPlay(); return; }
    if (state.playback.active) state.playback.stop();
    else state.playback.start();
  });
  el.playToggle.addEventListener('click', () => state.playback.toggle());
  el.playClose.addEventListener('click', () => state.playback.stop());
  el.playScrub.addEventListener('input', () =>
    state.playback.seek(Number(el.playScrub.value))
  );
  const setPlaybackFps = (f) => {
    f = Math.max(1, Math.min(8, f | 0));
    el.playSpeed.value = String(f);
    el.playSpeedVal.textContent = f;
    if (el.playSpeedBtn) el.playSpeedBtn.textContent = `${f} FPS`;
    state.playback.setFps(f);
  };
  el.playSpeed.addEventListener('input', () => setPlaybackFps(Number(el.playSpeed.value)));
  // Persistent timeline bar's own speed control — cycles a few common rates
  // through the same setFps()/#playSpeed the settings-popup slider drives.
  if (el.playSpeedBtn) {
    const FPS_STEPS = [1, 2, 3, 5, 8];
    el.playSpeedBtn.addEventListener('click', () => {
      const cur = Number(el.playSpeed.value);
      const next = FPS_STEPS[(FPS_STEPS.findIndex((f) => f >= cur) + 1) % FPS_STEPS.length] || FPS_STEPS[0];
      setPlaybackFps(next);
    });
  }

  mqSmallScreen.addEventListener('change', applyResponsiveLayout);
  applyResponsiveLayout();
  setupCollapsiblePanels();

  window.addEventListener('resize', () => {
    if (state.map) state.map.resize();
    drawSoundingCharts();
  });
  setTimeout(() => state.map.resize(), 100);

  setTzLocal(state.tzLocal); // sync the toggle label + clock to the restored prefs
  setTimeSource(state.timeSource);
  setInterval(tickClock, 1000);

  // Start in LIVE mode so the newest data streams in automatically — the user
  // shouldn't have to flip the LIVE switch to get a self-updating view. This
  // also kicks off the first load (refreshActive) and the 60s auto-refresh.
  startLive();
}

document.addEventListener('DOMContentLoaded', init);
