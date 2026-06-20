// app.js — application controller: ties the data, decode, and render layers to
// the UI. Everything runs in the browser; the only network calls are the public
// S3 list/download requests in s3.js and the Leaflet basemap tiles.

import { listVolumes, fetchVolume, RADARS, nearestSite } from './s3.js';
import { PRODUCTS, PRODUCT_ORDER, makeScale, parsePal, palTargetProduct } from './products.js';
import { renderScreen, sampleAt, sweepMaxRange } from './renderer.js';
import { AlertsController } from './alerts.js';

const M_PER_DEG_LAT = 111320;

// ---------------------------------------------------------------------------
// Radar layer — draws polar cells straight into a canvas in the map's screen
// space and re-renders on every zoom/move, so gates stay crisp and true-to-size
// at any zoom instead of being upscaled from a fixed-resolution bitmap.
// ---------------------------------------------------------------------------
function createRadarLayer() {
  const RadarLayer = L.Layer.extend({
    initialize() {
      this._sweep = null;
      this._product = null;
      this._site = null;
      this._opacity = 0.85;
    },

    onAdd(map) {
      this._map = map;
      const canvas = (this._canvas = L.DomUtil.create(
        'canvas',
        'radar-canvas leaflet-zoom-hide'
      ));
      canvas.style.position = 'absolute';
      canvas.style.pointerEvents = 'none';
      canvas.style.opacity = this._opacity;
      map.getPanes().overlayPane.appendChild(canvas);
      map.on('moveend zoomend resize viewreset', this._reset, this);
      this._reset();
    },

    onRemove(map) {
      L.DomUtil.remove(this._canvas);
      map.off('moveend zoomend resize viewreset', this._reset, this);
    },

    setData(sweep, product, site) {
      this._sweep = sweep;
      this._product = product;
      this._site = site;
      if (this._map) this._reset();
    },

    setOpacity(o) {
      this._opacity = o;
      if (this._canvas) this._canvas.style.opacity = o;
    },

    _reset() {
      const map = this._map;
      const canvas = this._canvas;
      if (!map || !canvas) return;

      const size = map.getSize();
      // Oversize the canvas a little so a short pan reveals already-drawn area
      // before the moveend redraw catches up.
      const padX = Math.round(size.x * 0.3);
      const padY = Math.round(size.y * 0.3);
      const wCss = size.x + 2 * padX;
      const hCss = size.y + 2 * padY;

      const corner = map.containerPointToLayerPoint([-padX, -padY]);
      L.DomUtil.setPosition(canvas, corner);

      const dpr = window.devicePixelRatio || 1;
      canvas.style.width = wCss + 'px';
      canvas.style.height = hCss + 'px';
      canvas.width = Math.round(wCss * dpr);
      canvas.height = Math.round(hCss * dpr);

      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, wCss, hCss);

      if (!this._sweep || !this._site) return;

      // screen pixel = world-pixel(latlng) - (pixelOrigin + canvasCorner)
      const pixelOrigin = map.getPixelOrigin();
      const scale = 256 * Math.pow(2, map.getZoom());
      const mPerDegLon =
        M_PER_DEG_LAT * Math.cos((this._site.lat * Math.PI) / 180);

      renderScreen(ctx, this._sweep, this._product, {
        scale,
        offX: pixelOrigin.x + corner.x,
        offY: pixelOrigin.y + corner.y,
        w: wCss,
        h: hCss,
        siteLat: this._site.lat,
        siteLon: this._site.lon,
        mPerDegLon,
      });
    },
  });
  return new RadarLayer();
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
  radarLayer: null,
  ringLayer: null,
  geo: null,
  alerts: null,
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
  el.palInput = $('#palInput');
  el.palReset = $('#palReset');
  el.palName = $('#palName');
  el.alertList = $('#alertList');
  el.alertsToggle = $('#alertsToggle');
  el.alertDetail = $('#alertDetail');
  el.alertDetailPanel = $('#alertDetailPanel');
  el.alertClose = $('#alertClose');
}

function setStatus(text, busy = false) {
  el.status.textContent = text;
  el.status.classList.toggle('busy', busy);
}

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------
function initMap() {
  const map = L.map('map', {
    zoomControl: true,
    attributionControl: true,
    minZoom: 4,
    maxZoom: 14,
    preferCanvas: true,
  }).setView([35.33, -97.27], 7);

  L.tileLayer(
    'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    {
      subdomains: 'abcd',
      maxZoom: 19,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    }
  ).addTo(map);

  state.radarLayer = createRadarLayer();
  state.radarLayer.setOpacity(state.opacity);
  state.radarLayer.addTo(map);
  state.ringLayer = L.layerGroup().addTo(map);
  state.map = map;

  map.on('mousemove', (e) => updateReadout(e.latlng));
  map.on('mouseout', () => el.readout.classList.remove('show'));

  // Right-click anywhere to jump to the NEXRAD radar nearest that point.
  map.on('contextmenu', (e) => {
    if (e.originalEvent) e.originalEvent.preventDefault();
    const r = nearestSite(e.latlng.lat, e.latlng.lng);
    if (!r) return;
    selectSite(r[0], r[1]);
    setStatus(`nearest radar: ${r[0]} — ${r[1]}`);
  });
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
  state.site = icao;
  state._centered = false;
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

function currentSweep() {
  const list = sweepsForProduct();
  if (!list.length) return null;
  let best = list[0];
  let bestDiff = Infinity;
  for (const sw of list) {
    const d = Math.abs(sw.elevation - state.selectedElevation);
    if (d < bestDiff) {
      bestDiff = d;
      best = sw;
    }
  }
  return best;
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
  el.siteSelect.addEventListener('change', () => {
    state.site = el.siteSelect.value;
    state._centered = false; // recenter the map on the new radar
    loadVolumeList();
  });
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
    if ((!state.volume || state.live) && latest !== state.volumeKey) {
      loadVolume(latest);
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
      state.map.setView([volume.site.lat, volume.site.lon], 8);
      state._centered = true;
    }

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
  const product = PRODUCTS[state.productId];
  const sweep = currentSweep();
  const site = state.volume && state.volume.site;

  if (!sweep || !site) {
    state.radarLayer.setData(null, null, null);
    state.ringLayer.clearLayers();
    return;
  }

  let maxR = sweepMaxRange(sweep, product.moment) || 300000;

  // Draw the sweep as true polar cells in screen space; the layer re-renders
  // itself on zoom/move so gates stay crisp and physically sized at any scale.
  state.radarLayer.setOpacity(state.opacity);
  state.radarLayer.setData(sweep, product, site);

  drawRings(site, maxR);
}

function drawRings(site, maxR) {
  state.ringLayer.clearLayers();
  L.circleMarker([site.lat, site.lon], {
    radius: 3,
    color: '#36e0c8',
    weight: 2,
    fillOpacity: 1,
  }).addTo(state.ringLayer);
  const stepKm = 100;
  for (let km = stepKm; km * 1000 <= maxR + 1; km += stepKm) {
    L.circle([site.lat, site.lon], {
      radius: km * 1000,
      color: 'rgba(120, 200, 255, 0.25)',
      weight: 1,
      fill: false,
      dashArray: '4 6',
    }).addTo(state.ringLayer);
  }
}

function updateMeta() {
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
  buildSiteSelect();
  buildProductButtons();
  buildLegend();
  buildTiltList();

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
    if (state.radarLayer) state.radarLayer.setOpacity(state.opacity);
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

  window.addEventListener('resize', () => state.map && state.map.invalidateSize());
  setTimeout(() => state.map.invalidateSize(), 100);

  tickClock();
  setInterval(tickClock, 1000);
  loadVolumeList();
}

document.addEventListener('DOMContentLoaded', init);
