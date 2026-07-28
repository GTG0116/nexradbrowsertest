// splitview.js - synced comparison panes for the main map.
//
// Two-pane split and four-pane quad mode share the same controller. Pane 1 is
// the app's normal map; panes 2-4 are Mapbox maps created on demand and kept in
// camera lock-step. Each extra pane owns its own custom data layer instances so
// it can show a different product over the same view.

import { createRadarLayer } from './radarLayer.js';
import { createGridLayer } from './gridLayer.js';
import { createSatelliteLayer, SATELLITE_LAYER_ID } from './satelliteLayer.js';
import { PRODUCTS, PRODUCT_ORDER, reflectivityProduct } from './products.js';
import { MRMS_PRODUCTS, MRMS_ORDER, listMrms, loadMrms } from './mrms.js';
import { MODEL_PRODUCTS, MODEL_CATEGORIES, loadModel, modelSupports } from './models.js';
import { OBS_PRODUCTS, OBS_CATEGORIES } from './observations.js';
import { OUTLOOKS, OUTLOOK_ORDER, loadOutlookData } from './outlooks.js';
import { SAT_CHANNELS, SAT_RGB, SAT_RGB_ORDER, SAT_PRECIP, SAT_PRECIP_ID, bandsFor, buildRGBA } from './satProducts.js';
import { sceneBBox } from './goes.js';
import { ensureBandsAsync } from './satClient.js';
import { applyMapStyle, liftBoundaryLayers } from './mapStyle.js';
import { prepareModelOverlayData, showPreparedModelOverlays, clearModelOverlays } from './modelOverlays.js';

const p2 = (n) => String(n).padStart(2, '0');
const resolveGrid = (p) => (p && p.reflectivity ? reflectivityProduct(p) : p);
const DATA_LAYER_IDS = ['radar', 'mrms', 'models', 'observations', SATELLITE_LAYER_ID];
const OUTLOOK_SEP = '|';
const EMPTY_FC = { type: 'FeatureCollection', features: [] };
// Alternate-pane grids can be tens of megabytes (MRMS is especially large).
// Keep only the current working set instead of retaining every frame/hour that
// a long split-view session visits.
const GRID_CACHE_MAX = 2;

function outlookValue(productId, detailId) {
  return `${productId}${OUTLOOK_SEP}${detailId}`;
}

function parseOutlookValue(value, fallback = null) {
  if (value && typeof value === 'object') return value;
  const raw = String(value || '');
  const i = raw.indexOf(OUTLOOK_SEP);
  if (i >= 0) return { product: raw.slice(0, i), detail: raw.slice(i + 1) };
  if (fallback) return { ...fallback };
  return { product: 'spc_conv', detail: OUTLOOKS.spc_conv.details[0].id };
}

function outlookLabel(value) {
  const sel = parseOutlookValue(value);
  const product = OUTLOOKS[sel.product] || OUTLOOKS.spc_conv;
  const detail = product.details.find((d) => d.id === sel.detail) || product.details[0];
  return `${product.label}: ${detail.label}`;
}

function firstLabelLayerId(map) {
  const layers = map.getStyle().layers || [];
  for (const ly of layers) {
    if (ly.type === 'line' && /admin|boundary|border/i.test(ly.id)) return ly.id;
  }
  for (const ly of layers) {
    if (ly.type === 'symbol') return ly.id;
  }
  return undefined;
}

function dataLayerAnchor(map) {
  const layers = map.getStyle().layers || [];
  for (const ly of layers) {
    if ((ly.type === 'line' || ly.type === 'symbol') &&
        (ly['source-layer'] === 'road' || ly['source-layer'] === 'transportation')) {
      return ly.id;
    }
  }
  for (const ly of layers) {
    if (ly.type === 'line' || ly.type === 'symbol') return ly.id;
  }
  return firstLabelLayerId(map);
}

function paneContainer(n) {
  return document.getElementById(n === 1 ? 'map' : `map${n}`);
}

export class SplitView {
  constructor(ctx) {
    this.ctx = ctx;
    this.active = false;
    this.paneCount = 1;
    this.map = null; // Back-compat alias for pane 2.
    this.maps = { 2: null, 3: null, 4: null };
    this.layersByPane = {
      2: this._emptyLayers(),
      3: this._emptyLayers(),
      4: this._emptyLayers(),
    };
    this.productIds = { 2: null, 3: null, 4: null };
    this.productId = null; // Back-compat alias for pane 2.
    this.outlooksByPane = { 2: null, 3: null, 4: null };
    this.syncing = false;
    this.drawings = { type: 'FeatureCollection', features: [] };
    this._gridCache = new Map();
    this._paneLegends = [null, null, null, null];
    this._badges = [null, null, null, null];
    this._paneSelectHandlers = [];
    this._syncHandlers = [];
    this.activePane = 1;
  }

  _emptyLayers() {
    return { radar: null, mrms: null, models: null, observations: null, sat: null };
  }

  _gridKey(mode, id) {
    const state = this.ctx.state;
    if (mode === 'mrms') {
      const frame = state.mrms.frameKey || (state.live ? 'live' : state.date.getTime());
      return `mrms:${id}:${frame}`;
    }
    if (mode === 'observations')
      return `observations:${id}:${state.observations.frameKey || ''}`;
    if (mode === 'models')
      return `models:${state.models.modelKey}:${id}:${state.models.runKey}:${state.models.stormId}:${state.models.fhour}`;
    return `${mode}:${id}`;
  }

  _gridCacheGet(key) {
    if (!this._gridCache.has(key)) return undefined;
    const value = this._gridCache.get(key);
    this._gridCache.delete(key);
    this._gridCache.set(key, value);
    return value;
  }

  _gridCacheSet(key, value) {
    this._gridCache.delete(key);
    this._gridCache.set(key, value);
    while (this._gridCache.size > GRID_CACHE_MAX)
      this._gridCache.delete(this._gridCache.keys().next().value);
  }

  _paneNums() {
    return Array.from({ length: this.paneCount }, (_, i) => i + 1);
  }

  _extraPaneNums() {
    return this._paneNums().filter((n) => n > 1);
  }

  _mapForPane(n) {
    return n === 1 ? this.ctx.state.map : this.maps[n];
  }

  _allMaps() {
    return this._paneNums().map((n) => this._mapForPane(n)).filter(Boolean);
  }

  // The extra pane maps (everything but the app's main map), for callers in
  // app.js that need to mirror a paint change onto every live pane.
  paneMaps() {
    return this._extraPaneNums().map((n) => this._mapForPane(n)).filter(Boolean);
  }

  enable(paneCount = 2) {
    const count = paneCount === 4 ? 4 : 2;
    if (this.active && this.paneCount === count) return;
    if (this.active) this.disable();

    this.active = true;
    this.paneCount = count;
    this.activePane = 1;

    const { state, MAPBOX_TOKEN, basemapStyleUrl } = this.ctx;
    const main = state.map;
    const camera = {
      center: main.getCenter(), zoom: main.getZoom(),
      bearing: main.getBearing(), pitch: main.getPitch(),
    };
    const wrap = document.getElementById('mapWrap');
    wrap.classList.add('split');
    wrap.classList.toggle('quad', count === 4);
    // Commit pane 1 to its new CSS box before the other maps copy its camera.
    // This prevents its canvas/display area from retaining the one-pane size.
    main.resize();
    main.jumpTo(camera);

    for (const n of [2, 3, 4]) {
      const cont = paneContainer(n);
      if (cont) cont.hidden = n > count;
      this.layersByPane[n] = this._emptyLayers();
      this.productIds[n] = n <= count ? this._defaultProduct(n) : null;
      this.outlooksByPane[n] = this.productIds[n] ? parseOutlookValue(this.productIds[n]) : null;
    }
    this.productId = this.productIds[2];

    for (const n of this._extraPaneNums()) {
      const map = new mapboxgl.Map({
        container: `map${n}`,
        style: basemapStyleUrl(state.basemap),
        center: main.getCenter(),
        zoom: main.getZoom(),
        bearing: main.getBearing(),
        pitch: main.getPitch(),
        minZoom: 4,
        maxZoom: 14,
        projection: 'mercator',
        attributionControl: false,
        accessToken: MAPBOX_TOKEN,
        preserveDrawingBuffer: false,
        maxTileCacheSize: count === 4 ? 24 : 48,
      });
      this.maps[n] = map;
      if (n === 2) this.map = map;
      map.on('style.load', () => {
        this._setupOverlays(n);
        this.renderPane(n);
        this._setDrawSource(n);
        // A pane's style can finish loading after the user has already panned
        // the main map; snap it to the current shared camera so it doesn't stay
        // stranded at wherever it was first created.
        this._resyncCamera();
      });
      map.on('mousemove', (e) => this._inspectMove(n, e));
      map.on('mouseout', () => {
        if (this.ctx.onInspectOut) this.ctx.onInspectOut(n);
      });
    }

    this._bindSync();
    this._buildBadges();
    this._buildPaneChrome();
    this._bindPaneSelect();
    this._updatePaneUI();
    if (this.ctx.onLayoutChange) this.ctx.onLayoutChange(count);
    if (this.ctx.onSplitProductsChange) this.ctx.onSplitProductsChange();
    // Mapbox can resize on a different frame from the CSS quadrant layout.
    // Resize and then re-copy the authoritative main camera after each layout
    // settle so no pane keeps the pre-split center/zoom.
    for (const delay of [0, 60, 180]) {
      setTimeout(() => {
        if (!this.active || this.paneCount !== count) return;
        this._allMaps().forEach((m) => {
          m.resize();
          try { m.jumpTo(camera); } catch (_) { /* style still loading */ }
        });
      }, delay);
    }
  }

  disable() {
    if (!this.active) return;
    this.active = false;

    const wrap = document.getElementById('mapWrap');
    wrap.classList.remove('split', 'quad');

    this._unbindSync();
    this._unbindPaneSelect();
    this._removeBadges();
    this._removePaneChrome();

    const alerts = this.ctx.state && this.ctx.state.alerts;
    for (const n of [2, 3, 4]) {
      const map = this.maps[n];
      if (alerts && map) alerts.removeMirror(map);
      if (map) map.remove();
      this.maps[n] = null;
      this.layersByPane[n] = this._emptyLayers();
      this.productIds[n] = null;
      this.outlooksByPane[n] = null;
      const cont = paneContainer(n);
      if (cont) cont.hidden = true;
    }

    const mainEl = paneContainer(1);
    if (mainEl) mainEl.classList.remove('pane-active');
    this.map = null;
    this.productId = null;
    this.paneCount = 1;
    this.activePane = 1;
    this._gridCache.clear();

    if (this.ctx.onLayoutChange) this.ctx.onLayoutChange(1);
    if (this.ctx.onActivePaneChange) this.ctx.onActivePaneChange();
    if (this.ctx.onSplitProductsChange) this.ctx.onSplitProductsChange();
    setTimeout(() => this.ctx.state.map && this.ctx.state.map.resize(), 60);
  }

  toggle(paneCount = 2) {
    const count = paneCount === 4 ? 4 : 2;
    if (this.active && this.paneCount === count) this.disable();
    else this.enable(count);
    return this.active;
  }

  setPaneCount(paneCount) {
    this.enable(paneCount);
  }

  // ---- Camera sync ----
  _bindSync() {
    this._unbindSync();
    const copyFrom = (from) => {
      if (this.syncing) return;
      this.syncing = true;
      // The reset MUST run even if a jumpTo throws (a pane mid-style-reload can),
      // otherwise `syncing` sticks true and camera sync silently dies for the
      // rest of the session — leaving panes stranded on different parts of the
      // globe. A per-map try/catch also keeps one bad pane from blocking the
      // others.
      try {
        const camera = {
          center: from.getCenter(),
          zoom: from.getZoom(),
          bearing: from.getBearing(),
          pitch: from.getPitch(),
        };
        for (const map of this._allMaps()) {
          if (map === from) continue;
          try { map.jumpTo(camera); } catch (_) { /* pane not ready yet */ }
        }
      } finally {
        this.syncing = false;
      }
    };
    this._copyFrom = copyFrom;

    for (const map of this._allMaps()) {
      const handler = () => copyFrom(map);
      map.on('move', handler);
      this._syncHandlers.push([map, handler]);
    }
  }

  _unbindSync() {
    for (const [map, handler] of this._syncHandlers) {
      if (map && handler) map.off('move', handler);
    }
    this._syncHandlers = [];
  }

  // Force every pane to the main map's current camera. Used when a pane's style
  // loads late (it may have missed the pans that happened while it was loading)
  // and as a general "un-stick" if anything ever knocks the panes out of sync.
  _resyncCamera() {
    if (!this.active) return;
    const main = this.ctx.state.map;
    if (main && this._copyFrom) this._copyFrom(main);
  }

  // ---- Shared overlays on extra panes ----
  _setupOverlays(pane) {
    const map = this._mapForPane(pane);
    if (!map) return;

    // Same style normalisation as the main map: lift boundary lines above the
    // data before anchors are derived from the layer order (see mapStyle.js).
    liftBoundaryLayers(map);
    const mapStyle = this.ctx.state && this.ctx.state.mapStyle;
    applyMapStyle(map, mapStyle, firstLabelLayerId(map), { fresh: true });

    if (!map.getSource('alerts')) {
      map.addSource('alerts', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    }
    if (!map.getSource('spc-outlook')) {
      map.addSource('spc-outlook', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    }
    if (this.ctx.outlookData && map.getSource('spc-outlook')) {
      map.getSource('spc-outlook').setData(this.ctx.outlookData() || { type: 'FeatureCollection', features: [] });
    }
    if (!map.getLayer('spc-outlook-fill')) {
      map.addLayer(
        {
          id: 'spc-outlook-fill',
          type: 'fill',
          source: 'spc-outlook',
          paint: {
            'fill-color': ['get', 'fill'],
            'fill-opacity': (this.ctx.state && this.ctx.state.spcOpacity) || 0.3,
          },
        },
        dataLayerAnchor(map)
      );
    }
    if (!map.getLayer('spc-outlook-line')) {
      map.addLayer(
        {
          id: 'spc-outlook-line',
          type: 'line',
          source: 'spc-outlook',
          paint: { 'line-color': ['get', 'stroke'], 'line-width': 1.6, 'line-opacity': 0.9 },
        },
        firstLabelLayerId(map)
      );
    }
    // Same paint as the main map's alert layers, including the user's global
    // alert-opacity multiplier (kept live afterwards via applyAlertOpacity).
    const alertMult = this.ctx.state && typeof this.ctx.state.alertOpacity === 'number'
      ? this.ctx.state.alertOpacity : 1;
    if (!map.getLayer('alerts-fill')) {
      map.addLayer(
        {
          id: 'alerts-fill',
          type: 'fill',
          source: 'alerts',
          paint: {
            'fill-color': ['get', 'color'],
            'fill-opacity': ['*', alertMult, [
              'case',
              ['boolean', ['get', 'selected'], false], 0.34,
              ['coalesce', ['get', 'fillOpacity'], 0.18],
            ]],
          },
        },
        dataLayerAnchor(map)
      );
    }
    if (!map.getLayer('alerts-line')) {
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
            'line-opacity': 0.95 * alertMult,
          },
        },
        firstLabelLayerId(map)
      );
    }
    const alertsCtl = this.ctx.state && this.ctx.state.alerts;
    if (alertsCtl) alertsCtl.addMirror(map);

    if (!map.getSource('mt-shapes')) {
      map.addSource('mt-shapes', { type: 'geojson', data: this.drawings });
    }
    const add = (layer) => {
      if (!map.getLayer(layer.id)) map.addLayer(layer);
    };
    add({
      id: 'mt-fill',
      type: 'fill',
      source: 'mt-shapes',
      filter: ['==', ['geometry-type'], 'Polygon'],
      paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.12 },
    });
    add({
      id: 'mt-line',
      type: 'line',
      source: 'mt-shapes',
      filter: ['all', ['!=', ['geometry-type'], 'Point'], ['!=', ['get', 'dashed'], true]],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['get', 'color'],
        'line-width': ['case', ['==', ['get', 'kind'], 'storm'], 3, ['coalesce', ['get', 'width'], 2.4]],
        'line-opacity': 0.95,
      },
    });
    add({
      id: 'mt-line-dash',
      type: 'line',
      source: 'mt-shapes',
      filter: ['all', ['!=', ['geometry-type'], 'Point'], ['==', ['get', 'dashed'], true]],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['get', 'color'],
        'line-width': ['case', ['==', ['get', 'kind'], 'storm'], 3, ['coalesce', ['get', 'width'], 2.4]],
        'line-dasharray': [2, 1.6],
        'line-opacity': 0.95,
      },
    });
    add({
      id: 'mt-vertex',
      type: 'circle',
      source: 'mt-shapes',
      filter: ['==', ['geometry-type'], 'Point'],
      paint: {
        'circle-radius': ['case', ['==', ['get', 'role'], 'storm-pos'], 6, 4],
        'circle-color': ['get', 'color'],
        'circle-stroke-color': '#06101f',
        'circle-stroke-width': 1.5,
      },
    });
  }

  setDrawings(fc) {
    this.drawings = fc || { type: 'FeatureCollection', features: [] };
    for (const n of this._extraPaneNums()) this._setDrawSource(n);
  }

  setOutlookData(fc) {
    const data = fc || EMPTY_FC;
    for (const n of this._extraPaneNums()) {
      if (this.ctx.state.mode === 'outlooks' && this.productForPane(n) !== this._mainProduct()) continue;
      const map = this._mapForPane(n);
      const src = map && map.getSource && map.getSource('spc-outlook');
      if (src) src.setData(data);
    }
  }

  _setDrawSource(pane) {
    const map = this._mapForPane(pane);
    const src = map && map.getSource && map.getSource('mt-shapes');
    if (src) src.setData(this.drawings);
  }

  setMapStyle(opts) {
    for (const n of this._extraPaneNums()) {
      const map = this._mapForPane(n);
      if (map && map.getStyle) applyMapStyle(map, opts, firstLabelLayerId(map), { fresh: false });
    }
  }

  // A map-provider switch hands every map a new key. Panes created from now on
  // read it from ctx at construction; already-live panes copied the old token
  // into their RequestManager when they were built, so patch that in place too
  // (private API, but the only alternative is tearing each pane down) — must
  // run before the setBasemap() restyle triggers new tile/style requests.
  setAccessToken(token) {
    this.ctx.MAPBOX_TOKEN = token;
    for (const n of this._extraPaneNums()) {
      const map = this._mapForPane(n);
      if (map && map._requestManager) {
        try { map._requestManager._customAccessToken = token; } catch (_) { /* private API drifted */ }
      }
    }
  }

  setBasemap(url) {
    for (const n of this._extraPaneNums()) {
      const map = this._mapForPane(n);
      if (map) map.setStyle(url);
    }
  }

  // ---- Product selection ----
  _defaultProduct(pane = 2) {
    // Outlooks compare best as a forecast-day spread of the same hazard, not a
    // walk through the flat product list (which dropped panes onto the tornado/
    // wind/hail and experimental day 4-8 probability feeds — the 4-pane mess).
    if (this.ctx.state.mode === 'outlooks') return this._defaultOutlook(pane);
    const list = this._productList().map(([id]) => id);
    if (!list.length) return 'REF';
    const main = this._mainProduct();
    if (this.ctx.state.mode === 'radar' && pane === 2) {
      return main === 'REF' && list.includes('VEL') ? 'VEL' : 'REF';
    }
    const start = Math.max(0, list.indexOf(main));
    return list[(start + pane - 1) % list.length] || list[0];
  }

  // Default outlook for an extra pane: keep the main pane's product family and
  // hazard type, stepping the forecast day (Day 1 / Day 2 / Day 3 categorical,
  // …). For single-axis outlook products (fire, ERO, CPC) it steps the detail.
  _defaultOutlook(pane) {
    const main = parseOutlookValue(this._mainProduct());
    const product = OUTLOOKS[main.product] || OUTLOOKS.spc_conv;
    const ax = product.axes;
    if (ax) {
      const { day, type } = ax.split(main.detail);
      const dayIds = ax.days().map((d) => d.id);
      // Prefer days that actually carry the main hazard type so a categorical
      // comparison stays categorical (days 4-8 are probability-only).
      const usable = dayIds.filter((d) => ax.types(d).some((t) => t.id === type));
      const pool = usable.length ? usable : dayIds;
      const start = Math.max(0, pool.indexOf(day));
      const wantDay = pool[(start + pane - 1) % pool.length];
      const types = ax.types(wantDay).map((t) => t.id);
      const wantType = types.includes(type) ? type : types[0];
      return outlookValue(main.product, ax.join(wantDay, wantType));
    }
    const details = product.details.map((d) => d.id);
    const start = Math.max(0, details.indexOf(main.detail));
    return outlookValue(main.product, details[(start + pane - 1) % details.length] || details[0]);
  }

  _productList() {
    const m = this.ctx.state.mode;
    if (m === 'radar') return PRODUCT_ORDER.map((id) => [id, id]);
    if (m === 'observations') {
      return OBS_CATEGORIES.flatMap((c) => c.products)
        .filter((id) => OBS_PRODUCTS[id])
        .map((id) => [id, id]);
    }
    if (m === 'outlooks') {
      return OUTLOOK_ORDER.flatMap((productId) => {
        const product = OUTLOOKS[productId];
        return product.details.map((d) => [outlookValue(productId, d.id), `${product.label}: ${d.label}`]);
      });
    }
    if (m === 'mrms') return MRMS_ORDER.map((id) => [id, id]);
    if (m === 'models') {
      const modelKey = this.ctx.state.models.modelKey;
      return MODEL_CATEGORIES.flatMap((c) => c.products)
        .filter((id) => MODEL_PRODUCTS[id] && modelSupports(modelKey, id))
        .map((id) => [id, id]);
    }
    if (m === 'satellite') {
      const ch = SAT_CHANNELS.map((c) => ['C' + p2(c.band), 'C' + p2(c.band)]);
      const rgb = SAT_RGB_ORDER.map((id) => ['RGB_' + id, SAT_RGB[id].short]);
      // The derived precipitation retrieval only exists on the sectors the host
      // offers it on; pairing it against an ABI channel in the other pane is one
      // of the more useful things a split can show.
      const derived = this.ctx.satPrecipAvailable && this.ctx.satPrecipAvailable()
        ? [[SAT_PRECIP_ID, SAT_PRECIP.short]] : [];
      return [...ch, ...rgb, ...derived];
    }
    return [];
  }

  onModeChange() {
    if (!this.active) return;
    // Cached grids belong to the previous source/timeline and may be very large.
    this._gridCache.clear();
    for (const n of this._extraPaneNums()) {
      this.productIds[n] = this._defaultProduct(n);
      this.outlooksByPane[n] = this.ctx.state.mode === 'outlooks' ? parseOutlookValue(this.productIds[n]) : null;
    }
    this.productId = this.productIds[2] || null;
    this._updateBadges();
    if (this.ctx.onSplitProductsChange) this.ctx.onSplitProductsChange();
    this.render();
  }

  _mainProduct() {
    const s = this.ctx.state;
    if (s.mode === 'mrms') return s.mrms.productId;
    if (s.mode === 'models') return s.models.productId;
    if (s.mode === 'satellite') return s.sat.productId;
    if (s.mode === 'observations') return s.observations.productId;
    if (s.mode === 'outlooks') return s.spc ? outlookValue(s.spc.product, s.spc.detail) : outlookValue('spc_conv', OUTLOOKS.spc_conv.details[0].id);
    return s.productId;
  }

  activeProductId() {
    return this.activePane > 1 ? this.productIds[this.activePane] : this._mainProduct();
  }

  setProduct(id, pane = this.activePane) {
    if (pane <= 1 || pane > this.paneCount) return;
    if (this.ctx.state.mode === 'outlooks') {
      const sel = parseOutlookValue(id, this.outlookForPane(pane));
      const product = OUTLOOKS[sel.product] || OUTLOOKS.spc_conv;
      const detail = product.details.some((d) => d.id === sel.detail) ? sel.detail : product.details[0].id;
      id = outlookValue(sel.product, detail);
      this.outlooksByPane[pane] = { product: sel.product, detail };
    }
    this.productIds[pane] = id;
    if (pane === 2) this.productId = id;
    this._updateBadges();
    if (this.ctx.onSplitProductsChange) this.ctx.onSplitProductsChange();
    this.renderPane(pane);
  }

  productForPane(pane) {
    return pane === 1 ? this._mainProduct() : this.productIds[pane];
  }

  outlookForPane(pane) {
    if (pane <= 1) {
      const spc = this.ctx.state.spc;
      return spc ? { product: spc.product, detail: spc.detail } : parseOutlookValue(this._mainProduct());
    }
    const parsed = parseOutlookValue(this.productIds[pane], this.outlooksByPane[pane]);
    const product = OUTLOOKS[parsed.product] || OUTLOOKS.spc_conv;
    const detail = product.details.some((d) => d.id === parsed.detail) ? parsed.detail : product.details[0].id;
    return { product: parsed.product, detail };
  }

  paneProducts() {
    return this._paneNums().map((n) => this.productForPane(n));
  }

  // ---- Pane selection and chrome ----
  _bindPaneSelect() {
    this._unbindPaneSelect();
    for (const n of this._paneNums()) {
      const host = paneContainer(n);
      if (!host) continue;
      let suppressClick = false;
      const activate = (e) => {
        if (this.activePane === n) return;
        // The first gesture on an inactive pane is selection only. Consume it
        // in capture phase before Mapbox, alerts, or drawing tools can pan,
        // inspect, select, or add a point underneath it.
        e.preventDefault();
        e.stopImmediatePropagation();
        suppressClick = true;
        this.setActivePane(n);
      };
      const click = (e) => {
        if (!suppressClick) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        suppressClick = false;
      };
      host.addEventListener('mousedown', activate, true);
      host.addEventListener('touchstart', activate, { capture: true, passive: false });
      host.addEventListener('click', click, true);
      this._paneSelectHandlers.push([host, activate, click]);
    }
  }

  _unbindPaneSelect() {
    for (const [host, activate, click] of this._paneSelectHandlers) {
      host.removeEventListener('mousedown', activate, true);
      host.removeEventListener('touchstart', activate, true);
      host.removeEventListener('click', click, true);
    }
    this._paneSelectHandlers = [];
  }

  setActivePane(n) {
    if (!this.active || this.activePane === n || n < 1 || n > this.paneCount) return;
    this.activePane = n;
    this._updatePaneUI();
    this._resyncCamera();
    if (this.ctx.onActivePaneChange) this.ctx.onActivePaneChange();
  }

  _updatePaneUI() {
    for (let n = 1; n <= 4; n++) {
      const host = paneContainer(n);
      if (host) host.classList.toggle('pane-active', this.active && n === this.activePane);
    }
    this._updateBadges();
  }

  _buildPaneChrome() {
    this._removePaneChrome();
    const makeLegend = (host) => {
      if (!host) return null;
      const d = document.createElement('div');
      d.className = 'legend split-pane-legend';
      host.appendChild(d);
      return d;
    };
    this._paneLegends = this._paneNums().map((n) => makeLegend(paneContainer(n)));
  }

  _removePaneChrome() {
    for (const node of this._paneLegends) {
      if (node) node.remove();
    }
    this._paneLegends = [null, null, null, null];
  }

  setPaneLegends(...htmls) {
    const vals = Array.isArray(htmls[0]) ? htmls[0] : htmls;
    this._paneLegends.forEach((node, i) => {
      if (!node) return;
      node.innerHTML = vals[i] || '';
      node.hidden = !vals[i];
    });
  }

  paneLegendElements() {
    return this._paneLegends.slice(0, this.paneCount);
  }

  _buildBadges() {
    this._removeBadges();
    this._badges = this._paneNums().map((n) => {
      const host = paneContainer(n);
      if (!host) return null;
      const d = document.createElement('div');
      d.className = 'split-badge';
      d.addEventListener('click', (e) => {
        e.stopPropagation();
        this.setActivePane(n);
      });
      host.appendChild(d);
      return d;
    });
    this._updateBadges();
  }

  _removeBadges() {
    for (const node of this._badges) {
      if (node) node.remove();
    }
    this._badges = [null, null, null, null];
  }

  _updateBadges() {
    const fmt = (n, prod) => {
      const on = this.activePane === n;
      const label = this.ctx.state.mode === 'outlooks' ? outlookLabel(prod) : prod;
      return `<span class="sb-name">PANE ${n}</span>` +
        `<span class="sb-prod">${label || '-'}</span>` +
        (on ? '<span class="sb-dot">editing</span>' : '<span class="sb-dot tap">tap to edit</span>');
    };
    this._badges.forEach((badge, i) => {
      if (!badge) return;
      const n = i + 1;
      badge.innerHTML = fmt(n, this.productForPane(n));
      badge.classList.toggle('active', this.activePane === n);
    });
  }

  // ---- Render data products ----
  render() {
    if (!this.active) return;
    for (const n of this._extraPaneNums()) this.renderPane(n);
  }

  renderPane(pane) {
    if (!this.active || pane <= 1 || !this._mapForPane(pane)) return;
    const m = this.ctx.state.mode;
    try {
      if (m === 'radar') this._renderRadar(pane);
      else if (m === 'satellite') this._renderSat(pane);
      else if (m === 'mrms') this._renderGrid('mrms', pane);
      else if (m === 'models') this._renderGrid('models', pane);
      else if (m === 'observations') this._renderGrid('observations', pane);
      else if (m === 'outlooks') this._renderOutlook(pane);
      else this._clearData(pane);
    } catch (e) {
      console.error('split render', e);
    }
  }

  _ensureLayer(pane, kind, factory) {
    const map = this._mapForPane(pane);
    const layers = this.layersByPane[pane] || (this.layersByPane[pane] = this._emptyLayers());
    if (!layers[kind]) layers[kind] = factory();
    const layerId = { radar: 'radar', mrms: 'mrms', models: 'models', observations: 'observations', sat: SATELLITE_LAYER_ID }[kind];
    if (!map.getLayer(layerId)) {
      for (const other of DATA_LAYER_IDS) {
        if (other !== layerId && map.getLayer(other)) map.removeLayer(other);
      }
      map.addLayer(layers[kind], dataLayerAnchor(map));
    }
    return layers[kind];
  }

  _clearData(pane) {
    const map = this._mapForPane(pane);
    if (!map) return;
    for (const id of DATA_LAYER_IDS) {
      if (map.getLayer(id)) map.removeLayer(id);
    }
    clearModelOverlays(map);
  }

  _renderRadar(pane) {
    const state = this.ctx.state;
    const map = this._mapForPane(pane);
    clearModelOverlays(map);
    const id = this.productIds[pane];
    const product = PRODUCTS[id] || PRODUCTS.REF;
    const site = state.shownSite || (state.volume && state.volume.site);
    const sweep = this.ctx.radarSweepFor(id);
    if (!sweep || !site) {
      this._clearData(pane);
      return;
    }
    const layer = this._ensureLayer(pane, 'radar', createRadarLayer);
    layer.setSweep(sweep, product, site);
    layer.setOpacity(state.opacity);
    layer.setSmooth(state.smooth);
    if (this.ctx.onPaneRendered) this.ctx.onPaneRendered(pane);
  }

  _renderSat(pane) {
    const state = this.ctx.state;
    const map = this._mapForPane(pane);
    clearModelOverlays(map);
    const scene = state.sat.scene;
    if (!scene) {
      this._clearData(pane);
      return;
    }
    const id = this.productIds[pane] || state.sat.productId;
    const draw = () => {
      // The band decode is async: by the time it resolves the user may have left
      // satellite mode, closed the split, or retargeted this pane. Bail rather
      // than stamp a stale satellite frame over whatever the pane shows now.
      if (!this.active || pane > this.paneCount || state.mode !== 'satellite') return;
      if ((this.productIds[pane] || state.sat.productId) !== id) return;
      if (state.sat.scene !== scene) return;
      const payload = this.ctx.satPayloadForProduct
        ? this.ctx.satPayloadForProduct(id)
        : { meta: scene, rgba: buildRGBA(scene, id, { enhanceIR: state.sat.enhanceIR }), bbox: sceneBBox(scene) };
      if (!payload) {
        this._clearData(pane);
        return;
      }
      const layer = this._ensureLayer(pane, 'sat', createSatelliteLayer);
      layer.setScene(payload.meta, payload.rgba, payload.bbox);
      layer.setOpacity(state.opacity);
      layer.setSmooth(state.smooth);
      if (this.ctx.onPaneRendered) this.ctx.onPaneRendered(pane);
    };
    // Derived products (the precipitation retrieval) need more than their bands
    // decoded, so prefer the host's own preparation step when it supplies one.
    const prepare = this.ctx.ensureSatProduct
      ? this.ctx.ensureSatProduct(scene, state.sat.satKey, state.sat.sectorKey, id)
      : ensureBandsAsync(scene, state.sat.satKey, state.sat.sectorKey, bandsFor(id));
    prepare.then(draw).catch((e) => console.error(e));
  }

  async _renderGrid(mode, pane) {
    const state = this.ctx.state;
    const id = this.productIds[pane] || (mode === 'observations' ? state.observations.productId : null);
    const sameAsMain = (mode === 'mrms' && id === state.mrms.productId) ||
      (mode === 'models' && id === state.models.productId) ||
      (mode === 'observations' && id === state.observations.productId);
    const map = this._mapForPane(pane);
    const ck = this._gridKey(mode, id);
    const current = () => this.active && pane <= this.paneCount &&
      this._mapForPane(pane) === map && state.mode === mode &&
      (this.productIds[pane] || (mode === 'observations' ? state.observations.productId : null)) === id &&
      this._gridKey(mode, id) === ck;
    const draw = (grid) => {
      if (!current()) return;
      if (!grid) {
        this._clearData(pane);
        return;
      }
      const layer = this._ensureLayer(pane, mode, () => createGridLayer(mode));
      layer.setGrid(grid, resolveGrid(grid.product));
      layer.setOpacity(state.opacity);
      layer.setSmooth(state.smooth);
      if (mode === 'models') showPreparedModelOverlays(map, grid._overlayData || prepareModelOverlayData(grid));
      else clearModelOverlays(map);
      if (this.ctx.onPaneRendered) this.ctx.onPaneRendered(pane);
    };

    if (sameAsMain) {
      draw(mode === 'mrms' ? state.mrms.grid : mode === 'models' ? state.models.grid : state.observations.grid);
      return;
    }

    const cached = this._gridCacheGet(ck);
    if (cached !== undefined) {
      draw(cached);
      return;
    }

    try {
      let grid;
      if (mode === 'mrms') {
        const frames = await listMrms(id, state.live ? new Date() : state.date);
        if (!current()) return;
        if (!frames.length) {
          this._clearData(pane);
          return;
        }
        grid = await loadMrms(id, frames[frames.length - 1].key);
      } else if (mode === 'observations') {
        if (this.ctx.loadObservationProduct) {
          grid = await this.ctx.loadObservationProduct(id);
        } else {
          this._clearData(pane);
          return;
        }
      } else {
        const run = state.models.runs.find((r) => r.key === state.models.runKey);
        if (!run) {
          this._clearData(pane);
          return;
        }
        grid = await loadModel(state.models.modelKey, id, run, state.models.fhour);
      }
      this._gridCacheSet(ck, grid);
      draw(grid);
    } catch (e) {
      console.error('split grid load', e);
      if (current()) this._clearData(pane);
    }
  }

  setOpacity(o) {
    for (const layers of Object.values(this.layersByPane)) {
      for (const l of Object.values(layers)) if (l && l.setOpacity) l.setOpacity(o);
    }
  }

  setSmooth(on) {
    for (const layers of Object.values(this.layersByPane)) {
      for (const l of Object.values(layers)) if (l && l.setSmooth) l.setSmooth(on);
    }
  }

  getMaps() {
    return this._extraPaneNums().map((n) => this._mapForPane(n)).filter(Boolean);
  }

  _renderOutlook(pane) {
    const map = this._mapForPane(pane);
    if (!map) return;
    const src = map.getSource && map.getSource('spc-outlook');
    const sel = this.outlookForPane(pane);
    const current = () => this.active && pane <= this.paneCount &&
      this._mapForPane(pane) === map && this.ctx.state.mode === 'outlooks' && (() => {
        const now = this.outlookForPane(pane);
        return now.product === sel.product && now.detail === sel.detail;
      })();
    const draw = (data) => {
      if (!current()) return;
      if (src) src.setData(data || EMPTY_FC);
      if (map.getLayer('spc-outlook-fill'))
        map.setPaintProperty('spc-outlook-fill', 'fill-opacity', (this.ctx.state && this.ctx.state.spcOpacity) || 0.3);
      this._clearData(pane);
      clearModelOverlays(map);
      if (this.ctx.onPaneRendered) this.ctx.onPaneRendered(pane);
    };
    const main = parseOutlookValue(this._mainProduct());
    if (sel.product === main.product && sel.detail === main.detail && this.ctx.outlookData) {
      draw(this.ctx.outlookData() || EMPTY_FC);
      return;
    }
    const ck = `outlook:${sel.product}:${sel.detail}`;
    const cached = this._gridCacheGet(ck);
    if (cached !== undefined) {
      draw(cached);
      return;
    }
    loadOutlookData(sel.product, sel.detail)
      .then(({ fc }) => {
        this._gridCacheSet(ck, fc);
        const cur = this.outlookForPane(pane);
        if (cur.product === sel.product && cur.detail === sel.detail) draw(fc);
      })
      .catch((e) => {
        console.error('split outlook load', e);
        if (current()) draw(EMPTY_FC);
      });
    if (map.getLayer('spc-outlook-fill'))
      map.setPaintProperty('spc-outlook-fill', 'fill-opacity', (this.ctx.state && this.ctx.state.spcOpacity) || 0.3);
    this._clearData(pane);
  }

  _inspectMove(pane, e) {
    if (!this.ctx.onInspectMove) return;
    const host = paneContainer(pane);
    const wrap = document.getElementById('mapWrap');
    const hr = host && host.getBoundingClientRect();
    const wr = wrap && wrap.getBoundingClientRect();
    const point = hr && wr
      ? { x: e.point.x + hr.left - wr.left, y: e.point.y + hr.top - wr.top }
      : e.point;
    this.ctx.onInspectMove(e.lngLat, point, pane);
  }

  sampleAt(pane, lat, lon) {
    const state = this.ctx.state;
    const id = this.productForPane(pane);
    if (!id) return null;
    if (state.mode === 'satellite') return this._sampleSat(id, lat, lon);
    if (state.mode === 'mrms' || state.mode === 'models' || state.mode === 'observations')
      return this._sampleGridPane(pane, state.mode, id, lat, lon);
    return this.ctx.sampleRadarAtProduct ? this.ctx.sampleRadarAtProduct(id, lat, lon) : null;
  }

  _sampleSat(id, lat, lon) {
    const scene = this.ctx.state.sat.scene;
    if (!scene) return null;
    const cr = this.ctx.lonLatToColRow ? this.ctx.lonLatToColRow(scene, lat, lon) : null;
    if (!cr) return { out: true };
    if (id === SAT_PRECIP_ID) {
      const rr = scene.channels.RR;
      const v = rr ? rr[Math.round(cr.row) * scene.width + Math.round(cr.col)] : NaN;
      if (!Number.isFinite(v)) return { main: 'no data', sub: SAT_PRECIP_ID };
      return { main: `${v.toFixed(v < 10 ? 1 : 0)} mm/hr`, sub: 'sat. precip estimate' };
    }
    if (!id.startsWith('C')) {
      const rgb = SAT_RGB[id.replace(/^RGB_/, '')];
      return { main: rgb ? rgb.short : id, sub: 'RGB composite' };
    }
    const band = parseInt(id.slice(1), 10);
    const meta = SAT_CHANNELS[band - 1];
    const arr = scene.channels[band];
    if (!arr) return { out: true };
    const v = arr[Math.round(cr.row) * scene.width + Math.round(cr.col)];
    if (Number.isNaN(v)) return { main: 'no data', sub: id };
    if (meta && meta.type === 'vis') return { main: `${(v * 100).toFixed(0)} %`, sub: `${id} reflectance` };
    const f = ((v - 273.15) * 9 / 5 + 32).toFixed(0);
    return { main: `${f} °F`, sub: `${id} cloud-top` };
  }

  _sampleGridPane(pane, mode, id, lat, lon) {
    const state = this.ctx.state;
    let grid = null;
    if (mode === 'mrms' && id === state.mrms.productId) grid = state.mrms.grid;
    else if (mode === 'models' && id === state.models.productId) grid = state.models.grid;
    else if (mode === 'observations' && id === state.observations.productId) grid = state.observations.grid;
    if (!grid) {
      grid = this._gridCacheGet(this._gridKey(mode, id));
    }
    if (!grid || !this.ctx.sampleGridRaw || !this.ctx.formatGridValue) return null;
    const p = resolveGrid(grid.product);
    const v = this.ctx.sampleGridRaw(grid, lat, lon);
    if (v == null) return { out: true };
    if (Number.isNaN(v) || !(v >= p.floor)) return { main: mode === 'models' ? 'no echo' : 'no data', sub: p.id };
    return { main: this.ctx.formatGridValue(p, v), sub: mode === 'observations' ? `RTMA ${p.id}` : p.id };
  }
}
