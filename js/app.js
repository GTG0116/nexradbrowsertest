// app.js — application controller: ties the data, decode, and render layers to
// the UI. Everything runs in the browser; the only network calls are the public
// S3 list/download requests in s3.js and the Leaflet basemap tiles.

import { listVolumes, fetchVolume, SITES } from './s3.js';
import { PRODUCTS, PRODUCT_ORDER } from './products.js';
import { renderGeo, sampleAt, sweepMaxRange } from './renderer.js';

const M_PER_DEG_LAT = 111320;

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
  radarOverlay: null,
  ringLayer: null,
  geo: null,
  radarCanvas: null,
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
}

function setStatus(text, busy = false) {
  el.status.textContent = text;
  el.status.classList.toggle('busy', busy);
}

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------
function initMap() {
  state.radarCanvas = document.createElement('canvas');
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

  state.ringLayer = L.layerGroup().addTo(map);
  state.map = map;

  map.on('mousemove', (e) => updateReadout(e.latlng));
  map.on('mouseout', () => el.readout.classList.remove('show'));
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
  for (const [code, name] of SITES) {
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
  const { lo, hi, lut, steps } = p.scale;
  const segs = 60;
  const colors = [];
  for (let i = 0; i <= segs; i++) {
    let li = Math.round((i / segs) * (steps - 1));
    if (li >= steps) li = steps - 1;
    const o = li * 3;
    colors.push(`rgb(${lut[o]},${lut[o + 1]},${lut[o + 2]}) ${(i / segs) * 100}%`);
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
    if (state.radarOverlay) {
      state.radarOverlay.remove();
      state.radarOverlay = null;
    }
    state.ringLayer.clearLayers();
    return;
  }

  let maxR = sweepMaxRange(sweep, product.moment) || 300000;
  const latR = maxR / M_PER_DEG_LAT;
  const lonR = maxR / (M_PER_DEG_LAT * Math.cos((site.lat * Math.PI) / 180));
  const geo = {
    siteLat: site.lat,
    siteLon: site.lon,
    latMin: site.lat - latR,
    latMax: site.lat + latR,
    lonMin: site.lon - lonR,
    lonMax: site.lon + lonR,
  };
  state.geo = geo;

  // Resolution: keep cells near the native gate size without going overboard.
  const size = 1400;
  state.radarCanvas.width = size;
  state.radarCanvas.height = size;
  renderGeo(state.radarCanvas, sweep, product, geo);
  const url = state.radarCanvas.toDataURL();

  const bounds = [
    [geo.latMin, geo.lonMin],
    [geo.latMax, geo.lonMax],
  ];
  if (!state.radarOverlay) {
    state.radarOverlay = L.imageOverlay(url, bounds, {
      opacity: state.opacity,
      interactive: false,
      className: 'radar-overlay',
    }).addTo(state.map);
  } else {
    state.radarOverlay.setBounds(bounds);
    state.radarOverlay.setUrl(url);
    state.radarOverlay.setOpacity(state.opacity);
  }

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
    if (state.radarOverlay) state.radarOverlay.setOpacity(state.opacity);
  });

  window.addEventListener('resize', () => state.map && state.map.invalidateSize());
  setTimeout(() => state.map.invalidateSize(), 100);

  tickClock();
  setInterval(tickClock, 1000);
  loadVolumeList();
}

document.addEventListener('DOMContentLoaded', init);
