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
import { MODEL_PRODUCTS, MODEL_CATEGORIES, loadModel } from './models.js';
import { SAT_CHANNELS, SAT_RGB, SAT_RGB_ORDER, bandsFor, buildRGBA } from './satProducts.js';
import { ensureBands, sceneBBox } from './goes.js';

const p2 = (n) => String(n).padStart(2, '0');
const resolveGrid = (p) => (p && p.reflectivity ? reflectivityProduct(p) : p);

function firstLabelLayerId(map) {
  const layers = map.getStyle().layers || [];
  for (const ly of layers) {
    if (ly.type === 'symbol') return ly.id;
    if (ly.type === 'line' && /admin|boundary|border/i.test(ly.id)) return ly.id;
  }
  return undefined;
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
    });
    this.map = map;
    this.productId = this._defaultProduct();

    map.on('style.load', () => {
      this._setupOverlays();
      this.render();
      this._setDrawSource();
    });
    this._bindSync();
    this._buildPicker();
    this._buildMainPicker();
    setTimeout(() => { main.resize(); map.resize(); }, 60);
  }

  disable() {
    if (!this.active) return;
    this.active = false;
    const wrap = document.getElementById('mapWrap');
    wrap.classList.remove('split');
    document.getElementById('map2').hidden = true;
    if (this._picker) { this._picker.remove(); this._picker = null; }
    if (this._mainPicker) { this._mainPicker.remove(); this._mainPicker = null; }
    // Detach the camera-sync listener from the main map before tearing down the
    // pane, or its next move would call jumpTo on a removed map.
    if (this._onMainMove) { this.ctx.state.map.off('move', this._onMainMove); this._onMainMove = null; }
    if (this.map) { this.map.remove(); this.map = null; }
    this.layers = { radar: null, mrms: null, models: null, sat: null };
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
    if (m === 'models') return MODEL_CATEGORIES.flatMap((c) => c.products).filter((id) => MODEL_PRODUCTS[id]).map((id) => [id, id]);
    if (m === 'satellite') {
      const ch = SAT_CHANNELS.map((c) => ['C' + p2(c.band), 'C' + p2(c.band)]);
      const rgb = SAT_RGB_ORDER.map((id) => ['RGB_' + id, SAT_RGB[id].short]);
      return [...ch, ...rgb];
    }
    return [];
  }

  // Called by app when the mode changes so the picker tracks the active source.
  onModeChange() {
    if (!this.active) return;
    this.productId = this._defaultProduct();
    this._buildPicker();
    this._buildMainPicker();
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

  // Keep the main pane's highlight in step when its product changes elsewhere
  // (e.g. the toolbar product buttons).
  syncMainProduct() {
    if (!this._mainPicker) return;
    const cur = this._mainProduct();
    this._mainPicker.querySelectorAll('.split-prod')
      .forEach((b) => b.classList.toggle('active', b.dataset.id === cur));
  }

  _buildPicker() {
    if (this._picker) this._picker.remove();
    const div = document.createElement('div');
    div.className = 'split-picker';
    const label = document.createElement('span');
    label.className = 'split-picker-label';
    label.textContent = 'PANE 2';
    div.appendChild(label);
    for (const [id, txt] of this._productList()) {
      const b = document.createElement('button');
      b.textContent = txt;
      b.className = 'split-prod' + (id === this.productId ? ' active' : '');
      b.addEventListener('click', () => {
        this.productId = id;
        div.querySelectorAll('.split-prod').forEach((x) => x.classList.toggle('active', x === b));
        this.render();
      });
      div.appendChild(b);
    }
    document.getElementById('map2').appendChild(div);
    this._picker = div;
  }

  // A matching picker on the main (left/top) pane so each panel's data can be
  // chosen by clicking that panel. Selecting here drives the main app's product
  // through ctx.setMainProduct, reusing the normal product-switch path.
  _buildMainPicker() {
    if (this._mainPicker) this._mainPicker.remove();
    const div = document.createElement('div');
    div.className = 'split-picker split-picker-main';
    const label = document.createElement('span');
    label.className = 'split-picker-label';
    label.textContent = 'PANE 1';
    div.appendChild(label);
    const cur = this._mainProduct();
    for (const [id, txt] of this._productList()) {
      const b = document.createElement('button');
      b.textContent = txt;
      b.dataset.id = id;
      b.className = 'split-prod' + (id === cur ? ' active' : '');
      b.addEventListener('click', () => {
        div.querySelectorAll('.split-prod').forEach((x) => x.classList.toggle('active', x === b));
        if (this.ctx.setMainProduct) this.ctx.setMainProduct(id);
      });
      div.appendChild(b);
    }
    document.getElementById('map').appendChild(div);
    this._mainPicker = div;
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
      map.addLayer(this.layers[kind], firstLabelLayerId(map));
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
}
