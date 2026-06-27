// splitview.js — a second, camera-synced map pane that shows a *different*
// product over the exact same view as the main scope. Side-by-side on desktop,
// stacked (chosen product on top) on mobile.
//
// The two maps share center/zoom/bearing/pitch (kept in lock-step both ways).
// The second pane gets its own custom GL data layer instances and renders from
// the data already in `state`:
//   • radar  — any moment from the loaded volume (free; no refetch).
//   • satellite — any channel/RGB (extra bands decoded from the cached file).
//   • MRMS / models — the chosen product's frame is fetched on demand + cached.
// Any annotations drawn with the map tools are mirrored into the second pane.

import { createRadarLayer } from './radarLayer.js';
import { createGridLayer } from './gridLayer.js';
import { createSatelliteLayer } from './satelliteLayer.js';
import { PRODUCTS, PRODUCT_ORDER, reflectivityProduct } from './products.js';
import { MRMS_PRODUCTS, MRMS_ORDER, listMrms, loadMrms } from './mrms.js';
import { MODEL_PRODUCTS, MODEL_CATEGORIES, loadModel, modelSupports } from './models.js';
import { SAT_CHANNELS, SAT_RGB, SAT_RGB_ORDER, bandsFor, buildRGBA } from './satProducts.js';
import { ensureBands, sceneBBox } from './goes.js';
import { applyMapStyle } from './mapStyle.js';

const p2 = (n) => String(n).padStart(2, '0');
const resolveGrid = (p) => (p && p.reflectivity ? reflectivityProduct(p) : p);

// Layer-stack helpers — kept in sync with app.js. Two anchors: the label anchor
// (first admin/boundary line) for annotations + our redrawn borders, and the data
// anchor (first road layer) for the data layer, so the basemap's roads, borders
// and labels all draw on top of the radar/satellite/grid data.
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
    if ((ly.type === 'line' || ly.type === 'symbol') && ly['source-layer'] === 'road')
      return ly.id;
  }
  for (const ly of layers) {
    if (ly.type === 'line' || ly.type === 'symbol') return ly.id;
  }
  return firstLabelLayerId(map);
}

export class SplitView {
  constructor(ctx) {
    this.ctx = ctx; // { state, MAPBOX_TOKEN, BASEMAPS, radarSweepFor }
    this.active = false;
    this.map = null;
    this.layers = { radar: null, mrms: null, models: null, sat: null };
    this.productId = null;
    this.syncing = false;
    this.drawings = { type: 'FeatureCollection', features: [] };
    this._gridCache = new Map();
    this._paneLegends = [null, null];
    this._weatherPickers = [null, null];
    // Which pane the shared bottom UI currently drives: 1 = main map, 2 = this
    // pane. Click a panel to switch. Starts on the main map so behaviour is
    // unchanged until the user picks the second pane.
    this.activePane = 1;
  }

  // ---- Enable / disable ----
  enable() {
    if (this.active) return;
    this.active = true;
    const { state, MAPBOX_TOKEN, BASEMAPS } = this.ctx;
    const wrap = document.getElementById('mapWrap');
    wrap.classList.add('split');
    const cont = document.getElementById('map2');
    cont.hidden = false;

    const main = state.map;
    const map = new mapboxgl.Map({
      container: 'map2',
      style: (BASEMAPS[state.basemap] || BASEMAPS.dark).url,
      center: main.getCenter(),
      zoom: main.getZoom(),
      bearing: main.getBearing(),
      pitch: main.getPitch(),
      minZoom: 4, maxZoom: 14,
      projection: 'mercator',
      attributionControl: false,
      accessToken: MAPBOX_TOKEN,
      preserveDrawingBuffer: true, // keep the pane grabbable by the export tool
    });
    this.map = map;
    this.productId = this._defaultProduct();

    map.on('style.load', () => {
      this._setupOverlays();
      this.render();
      this._setDrawSource();
    });
    this._bindSync();
    this._buildBadges();
    this._buildPaneChrome();
    this._bindPaneSelect();
    this.activePane = 1;
    this._updatePaneUI();
    if (this.ctx.onSplitProductsChange) this.ctx.onSplitProductsChange();
    setTimeout(() => { main.resize(); map.resize(); }, 60);
  }

  disable() {
    if (!this.active) return;
    this.active = false;
    const wrap = document.getElementById('mapWrap');
    wrap.classList.remove('split');
    document.getElementById('map2').hidden = true;
    if (this._badge1) { this._badge1.remove(); this._badge1 = null; }
    if (this._badge2) { this._badge2.remove(); this._badge2 = null; }
    this._removePaneChrome();
    this._unbindPaneSelect();
    const mapEl = document.getElementById('map');
    const map2El = document.getElementById('map2');
    if (mapEl) mapEl.classList.remove('pane-active');
    if (map2El) map2El.classList.remove('pane-active');
    this.activePane = 1;
    // Detach the camera-sync listener from the main map before tearing down the
    // pane, or its next move would call jumpTo on a removed map.
    if (this._onMainMove) { this.ctx.state.map.off('move', this._onMainMove); this._onMainMove = null; }
    // Stop mirroring alerts into this pane before its map is torn down.
    if (this.ctx.state && this.ctx.state.alerts) this.ctx.state.alerts.removeMirror(this.map);
    if (this.map) { this.map.remove(); this.map = null; }
    this.layers = { radar: null, mrms: null, models: null, sat: null };
    // Repaint the bottom UI to reflect the main map again.
    if (this.ctx.onActivePaneChange) this.ctx.onActivePaneChange();
    if (this.ctx.onSplitProductsChange) this.ctx.onSplitProductsChange();
    setTimeout(() => this.ctx.state.map && this.ctx.state.map.resize(), 60);
  }

  toggle() { this.active ? this.disable() : this.enable(); return this.active; }

  // ---- Camera sync (both directions, guarded) ----
  _bindSync() {
    const main = this.ctx.state.map;
    const map = this.map;
    const copy = (from, to) => {
      if (this.syncing) return;
      this.syncing = true;
      to.jumpTo({
        center: from.getCenter(), zoom: from.getZoom(),
        bearing: from.getBearing(), pitch: from.getPitch(),
      });
      this.syncing = false;
    };
    this._onMainMove = () => copy(main, map);
    this._onMapMove = () => copy(map, main);
    main.on('move', this._onMainMove);
    map.on('move', this._onMapMove);
  }

  // ---- Overlay layers on the second pane (drawings mirror) ----
  _setupOverlays() {
    const map = this.map;
    // Restyle the basemap's town labels, roads, rivers and borders to match the
    // main map's user customisation. setStyle reset the stock paint, so capture
    // fresh native widths (fresh: true).
    const mapStyle = this.ctx.state && this.ctx.state.mapStyle;
    applyMapStyle(map, mapStyle, firstLabelLayerId(map), { fresh: true });

    // Live NWS alert polygons, mirrored from the main map so the second pane
    // (the top panel in the stacked split) shows the same watches and
    // warnings. Fill sits below the data layer (like the main scope); the
    // outline sits above the data but beneath the basemap labels. The
    // AlertsController feeds these via addMirror() below.
    if (!map.getSource('alerts'))
      map.addSource('alerts', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    if (!map.getLayer('alerts-fill'))
      map.addLayer(
        {
          id: 'alerts-fill', type: 'fill', source: 'alerts',
          paint: {
            'fill-color': ['get', 'color'],
            'fill-opacity': [
              'case',
              ['boolean', ['get', 'selected'], false], 0.34,
              ['coalesce', ['get', 'fillOpacity'], 0.18],
            ],
          },
        },
        dataLayerAnchor(map)
      );
    if (!map.getLayer('alerts-line'))
      map.addLayer(
        {
          id: 'alerts-line', type: 'line', source: 'alerts',
          paint: {
            'line-color': ['coalesce', ['get', 'outlineColor'], ['get', 'color']],
            'line-width': [
              'case',
              ['boolean', ['get', 'selected'], false], 4.5,
              ['coalesce', ['get', 'outlineWidth'], 2.5],
            ],
            'line-opacity': 0.95,
          },
        },
        firstLabelLayerId(map)
      );
    const alertsCtl = this.ctx.state && this.ctx.state.alerts;
    if (alertsCtl) alertsCtl.addMirror(map);

    if (!map.getSource('mt-shapes'))
      map.addSource('mt-shapes', { type: 'geojson', data: this.drawings });
    const add = (layer) => { if (!map.getLayer(layer.id)) map.addLayer(layer); };
    add({
      id: 'mt-fill', type: 'fill', source: 'mt-shapes',
      filter: ['==', ['geometry-type'], 'Polygon'],
      paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.12 },
    });
    // line-dasharray is data-constant in Mapbox GL, so split solid vs. dashed
    // into two layers (matching maptools.js) instead of a per-feature dash
    // expression that would silently fail to validate.
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
        'circle-stroke-color': '#06101f', 'circle-stroke-width': 1.5,
      },
    });
  }

  setDrawings(fc) {
    this.drawings = fc || { type: 'FeatureCollection', features: [] };
    this._setDrawSource();
  }

  _setDrawSource() {
    const src = this.map && this.map.getSource && this.map.getSource('mt-shapes');
    if (src) src.setData(this.drawings);
  }

  // Re-apply the user's basemap-layer customisation (town labels, roads, rivers,
  // borders) to this pane live, matching a change made on the main map.
  setMapStyle(opts) {
    if (this.active && this.map && this.map.getStyle)
      applyMapStyle(this.map, opts, firstLabelLayerId(this.map), { fresh: false });
  }

  // React to a basemap change on the main map.
  setBasemap(url) {
    if (this.active && this.map) {
      this.map.setStyle(url);
      // style.load handler rebuilds overlays + re-renders.
    }
  }

  // ---- Product picker (overlaid on the second pane) ----
  _defaultProduct() {
    const m = this.ctx.state.mode;
    if (m === 'radar') return this.ctx.state.productId === 'REF' ? 'VEL' : 'REF';
    if (m === 'mrms') return this.ctx.state.mrms.productId;
    if (m === 'models') return this.ctx.state.models.productId;
    if (m === 'satellite') return this.ctx.state.sat.productId;
    return 'REF';
  }

  _productList() {
    const m = this.ctx.state.mode;
    if (m === 'radar') return PRODUCT_ORDER.map((id) => [id, id]);
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
      return [...ch, ...rgb];
    }
    return [];
  }

  // Called by app when the mode changes so the second pane tracks the new
  // source and the badges relabel.
  onModeChange() {
    if (!this.active) return;
    this.productId = this._defaultProduct();
    this._updateBadges();
    if (this.ctx.onSplitProductsChange) this.ctx.onSplitProductsChange();
    this.render();
  }

  // The product currently shown in the main (left/top) pane, by mode.
  _mainProduct() {
    const s = this.ctx.state;
    if (s.mode === 'mrms') return s.mrms.productId;
    if (s.mode === 'models') return s.models.productId;
    if (s.mode === 'satellite') return s.sat.productId;
    return s.productId;
  }

  // The product id of whichever pane the bottom UI is currently driving.
  activeProductId() {
    return this.activePane === 2 ? this.productId : this._mainProduct();
  }

  // Set pane 2's product (called by the app when the bottom UI is aimed here).
  setProduct(id) {
    this.productId = id;
    this._updateBadges();
    if (this.ctx.onSplitProductsChange) this.ctx.onSplitProductsChange();
    this.render();
  }

  // ---- Pane selection: click a panel to aim the bottom UI at it ----
  _bindPaneSelect() {
    this._sel1 = () => this.setActivePane(1);
    this._sel2 = () => this.setActivePane(2);
    const a = document.getElementById('map');
    const b = document.getElementById('map2');
    if (a) a.addEventListener('mousedown', this._sel1, true);
    if (a) a.addEventListener('touchstart', this._sel1, true);
    if (b) b.addEventListener('mousedown', this._sel2, true);
    if (b) b.addEventListener('touchstart', this._sel2, true);
  }

  _unbindPaneSelect() {
    const a = document.getElementById('map');
    const b = document.getElementById('map2');
    if (a && this._sel1) { a.removeEventListener('mousedown', this._sel1, true); a.removeEventListener('touchstart', this._sel1, true); }
    if (b && this._sel2) { b.removeEventListener('mousedown', this._sel2, true); b.removeEventListener('touchstart', this._sel2, true); }
    this._sel1 = this._sel2 = null;
  }

  setActivePane(n) {
    if (!this.active || this.activePane === n) return;
    this.activePane = n;
    this._updatePaneUI();
    // Rebuild the bottom UI's product buttons so they highlight (and now drive)
    // the newly selected pane.
    if (this.ctx.onActivePaneChange) this.ctx.onActivePaneChange();
  }

  _updatePaneUI() {
    const a = document.getElementById('map');
    const b = document.getElementById('map2');
    if (a) a.classList.toggle('pane-active', this.activePane === 1);
    if (b) b.classList.toggle('pane-active', this.activePane === 2);
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
    const makePicker = (host) => {
      if (!host) return null;
      const d = document.createElement('div');
      d.className = 'weather-center-picker split-weather-picker';
      d.hidden = true;
      d.innerHTML = `
        <div class="wxp-line wxp-v"></div>
        <div class="wxp-line wxp-h"></div>
        <div class="wxp-ring"></div>
        <div class="wxp-label">Weather center</div>`;
      host.appendChild(d);
      return d;
    };
    const a = document.getElementById('map');
    const b = document.getElementById('map2');
    this._paneLegends = [makeLegend(a), makeLegend(b)];
    this._weatherPickers = [makePicker(a), makePicker(b)];
  }

  _removePaneChrome() {
    for (const node of [...this._paneLegends, ...this._weatherPickers]) {
      if (node) node.remove();
    }
    this._paneLegends = [null, null];
    this._weatherPickers = [null, null];
  }

  setPaneLegends(mainHTML, splitHTML) {
    const vals = [mainHTML, splitHTML];
    this._paneLegends.forEach((node, i) => {
      if (!node) return;
      node.innerHTML = vals[i] || '';
      node.hidden = !vals[i];
    });
  }

  setWeatherPickers(on) {
    this._weatherPickers.forEach((node) => {
      if (node) node.hidden = !on;
    });
  }

  // A small badge on each pane: which pane it is, its current product, and
  // whether it's the one the bottom UI controls.
  _buildBadges() {
    const make = (host, n) => {
      if (!host) return null;
      const d = document.createElement('div');
      d.className = 'split-badge';
      d.addEventListener('click', (e) => { e.stopPropagation(); this.setActivePane(n); });
      host.appendChild(d);
      return d;
    };
    if (this._badge1) this._badge1.remove();
    if (this._badge2) this._badge2.remove();
    this._badge1 = make(document.getElementById('map'), 1);
    this._badge2 = make(document.getElementById('map2'), 2);
    this._updateBadges();
  }

  _updateBadges() {
    const fmt = (n, prod) => {
      const on = this.activePane === n;
      return `<span class="sb-name">PANE ${n}</span>` +
        `<span class="sb-prod">${prod || '—'}</span>` +
        (on ? '<span class="sb-dot">● editing</span>' : '<span class="sb-dot tap">tap to edit</span>');
    };
    if (this._badge1) {
      this._badge1.innerHTML = fmt(1, this._mainProduct());
      this._badge1.classList.toggle('active', this.activePane === 1);
    }
    if (this._badge2) {
      this._badge2.innerHTML = fmt(2, this.productId);
      this._badge2.classList.toggle('active', this.activePane === 2);
    }
  }

  // ---- Render the chosen product into the second pane ----
  render() {
    if (!this.active || !this.map) return;
    const m = this.ctx.state.mode;
    try {
      if (m === 'radar') this._renderRadar();
      else if (m === 'satellite') this._renderSat();
      else if (m === 'mrms') this._renderGrid('mrms');
      else if (m === 'models') this._renderGrid('models');
    } catch (e) { console.error('split render', e); }
  }

  _ensureLayer(kind, factory) {
    const map = this.map;
    if (!this.layers[kind]) this.layers[kind] = factory();
    const layerId = { radar: 'radar', mrms: 'mrms', models: 'models', sat: 'satellite' }[kind];
    if (!map.getLayer(layerId)) {
      // Drop other data layers so only the active product draws.
      for (const other of ['radar', 'mrms', 'models', 'satellite'])
        if (other !== layerId && map.getLayer(other)) map.removeLayer(other);
      // Data sits beneath the basemap roads/borders so they draw on top of it.
      map.addLayer(this.layers[kind], dataLayerAnchor(map));
    }
    return this.layers[kind];
  }

  _clearData() {
    for (const id of ['radar', 'mrms', 'models', 'satellite'])
      if (this.map.getLayer(id)) this.map.removeLayer(id);
  }

  _renderRadar() {
    const state = this.ctx.state;
    const product = PRODUCTS[this.productId] || PRODUCTS.REF;
    const site = state.shownSite || (state.volume && state.volume.site);
    const sweep = this.ctx.radarSweepFor(this.productId);
    if (!sweep || !site) { this._clearData(); return; }
    const layer = this._ensureLayer('radar', createRadarLayer);
    layer.setSweep(sweep, product, site);
    layer.setOpacity(state.opacity);
    layer.setSmooth(state.smooth);
  }

  _renderSat() {
    const state = this.ctx.state;
    const scene = state.sat.scene;
    if (!scene) { this._clearData(); return; }
    const id = this.productId;
    const draw = () => {
      const rgba = buildRGBA(scene, id, { enhanceIR: state.sat.enhanceIR });
      const layer = this._ensureLayer('sat', createSatelliteLayer);
      layer.setScene(scene, rgba, sceneBBox(scene));
      layer.setOpacity(state.opacity);
      layer.setSmooth(state.smooth);
    };
    // Decode any extra bands this channel/RGB needs, then draw.
    ensureBands(scene, bandsFor(id)).then(draw).catch((e) => console.error(e));
  }

  // MRMS / models: fetch the chosen product's frame if it isn't already what
  // the main map loaded, cache it, and draw it.
  async _renderGrid(mode) {
    const state = this.ctx.state;
    const id = this.productId;
    const sameAsMain = (mode === 'mrms' && id === state.mrms.productId) ||
      (mode === 'models' && id === state.models.productId);
    const draw = (grid) => {
      if (!grid) { this._clearData(); return; }
      const layer = this._ensureLayer(mode, () => createGridLayer(mode));
      layer.setGrid(grid, resolveGrid(grid.product));
      layer.setOpacity(state.opacity);
      layer.setSmooth(state.smooth);
    };
    if (sameAsMain) {
      draw(mode === 'mrms' ? state.mrms.grid : state.models.grid);
      return;
    }
    // Different product — load + cache.
    const ck = mode === 'mrms'
      ? `mrms:${id}`
      : `models:${state.models.modelKey}:${id}:${state.models.runKey}:${state.models.fhour}`;
    if (this._gridCache.has(ck)) { draw(this._gridCache.get(ck)); return; }
    try {
      let grid;
      if (mode === 'mrms') {
        const frames = await listMrms(id, state.live ? new Date() : state.date);
        if (!frames.length) { this._clearData(); return; }
        grid = await loadMrms(id, frames[frames.length - 1].key);
      } else {
        const run = state.models.runs.find((r) => r.key === state.models.runKey);
        if (!run) { this._clearData(); return; }
        grid = await loadModel(state.models.modelKey, id, run, state.models.fhour);
      }
      this._gridCache.set(ck, grid);
      if (this.productId === id) draw(grid); // ignore if user moved on
    } catch (e) { console.error('split grid load', e); this._clearData(); }
  }

  setOpacity(o) {
    for (const l of Object.values(this.layers)) if (l && l.setOpacity) l.setOpacity(o);
  }

  setSmooth(on) {
    for (const l of Object.values(this.layers)) if (l && l.setSmooth) l.setSmooth(on);
  }
}
