// app.js — application controller: ties the data, decode, and render layers to
// the UI. Everything runs in the browser; the only network calls are the
// public S3 list/download requests in s3.js.

import { listVolumes, fetchVolume, SITES } from './s3.js';
import { PRODUCTS, PRODUCT_ORDER } from './products.js';
import { renderSweep, renderOverlay } from './renderer.js';

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
    // Transfer the input buffer into the worker (zero-copy).
    worker.postMessage({ id, bytes }, [bytes.buffer]);
  });
}

const state = {
  site: 'KTLX',
  date: new Date(),
  volumes: [],
  volumeKey: null,
  volume: null,
  sweeps: [],
  sweepIndex: 0,
  productId: 'REF',
  live: false,
  liveTimer: null,
  view: { zoom: 1, panX: 0, panY: 0, rangeMeters: 300000 },
};

const $ = (sel) => document.querySelector(sel);
const el = {};

function cacheEls() {
  el.scope = $('#scope');
  el.overlay = $('#overlay');
  el.siteSelect = $('#siteSelect');
  el.dateInput = $('#dateInput');
  el.volumeList = $('#volumeList');
  el.productButtons = $('#productButtons');
  el.tiltList = $('#tiltList');
  el.legend = $('#legend');
  el.status = $('#status');
  el.clock = $('#clock');
  el.meta = $('#meta');
  el.readout = $('#readout');
  el.liveBtn = $('#liveBtn');
  el.refreshBtn = $('#refreshBtn');
  el.progress = $('#progress');
  el.scopeWrap = $('#scopeWrap');
}

function setStatus(text, busy = false) {
  el.status.textContent = text;
  el.status.classList.toggle('busy', busy);
}

// ---------------------------------------------------------------------------
// Canvas sizing
// ---------------------------------------------------------------------------
function sizeCanvases() {
  const rect = el.scopeWrap.getBoundingClientRect();
  const size = Math.floor(Math.min(rect.width, rect.height));
  for (const c of [el.scope, el.overlay]) {
    c.width = size;
    c.height = size;
    c.style.width = size + 'px';
    c.style.height = size + 'px';
  }
  render();
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
      render();
      buildLegend();
    });
    el.productButtons.appendChild(btn);
  }
}

function buildTiltList() {
  el.tiltList.innerHTML = '';
  if (!state.sweeps.length) {
    el.tiltList.innerHTML = '<div class="empty">—</div>';
    return;
  }
  state.sweeps.forEach((sw, i) => {
    const btn = document.createElement('button');
    btn.className = 'tilt-btn';
    if (i === state.sweepIndex) btn.classList.add('active');
    btn.textContent = `${sw.elevation.toFixed(2)}°`;
    btn.addEventListener('click', () => {
      state.sweepIndex = i;
      document
        .querySelectorAll('.tilt-btn')
        .forEach((b, j) => b.classList.toggle('active', j === i));
      render();
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
  // Newest first in the UI.
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
  const { lo, hi } = p.scale;
  const stops = 60;
  let gradient = '';
  const colors = [];
  for (let i = 0; i <= stops; i++) {
    const v = lo + ((hi - lo) * i) / stops;
    const { lut, steps } = p.scale;
    let li = Math.round(((v - lo) / (hi - lo)) * (steps - 1));
    if (li < 0) li = 0;
    if (li >= steps) li = steps - 1;
    const o = li * 3;
    colors.push(`rgb(${lut[o]},${lut[o + 1]},${lut[o + 2]}) ${(i / stops) * 100}%`);
  }
  gradient = colors.join(',');
  el.legend.innerHTML = `
    <div class="legend-title">${p.name} <span>(${p.unit})</span></div>
    <div class="legend-bar" style="background:linear-gradient(90deg,${gradient})"></div>
    <div class="legend-ticks"><span>${lo}</span><span>${((lo + hi) / 2).toFixed(
    0
  )}</span><span>${hi}</span></div>`;
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
    // Load the latest scan on first view, or in live mode when a newer scan
    // has appeared — but don't redundantly re-download the current one.
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
  el.scopeWrap.classList.add('scanning');
  try {
    const bytes = await fetchVolume(key, (p) => {
      el.progress.style.width = Math.round(p * 100) + '%';
    });
    setStatus('decoding…', true);
    const volume = await decodeVolume(bytes);
    state.volume = volume;
    state.sweeps = volume.sweeps;
    if (state.sweepIndex >= volume.sweeps.length) state.sweepIndex = 0;
    buildTiltList();
    updateMeta();
    render();
    setStatus(`loaded · ${volume.radialCount} radials`);
  } catch (e) {
    setStatus(`decode error: ${e.message}`);
    console.error(e);
  } finally {
    el.progress.classList.remove('show');
    el.scopeWrap.classList.remove('scanning');
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function currentSweep() {
  return state.sweeps[state.sweepIndex] || null;
}

function render() {
  const product = PRODUCTS[state.productId];
  const sweep = currentSweep();
  renderSweep(el.scope, sweep, product, state.view);
  renderOverlay(el.overlay, state.view);
}

function updateMeta() {
  const v = state.volume;
  const sw = currentSweep();
  if (!v) {
    el.meta.innerHTML = '<div class="empty">No volume loaded.</div>';
    return;
  }
  const site = v.site;
  const t = state.volumes.find((x) => x.key === state.volumeKey);
  el.meta.innerHTML = `
    <div class="meta-row"><span>Radar</span><b>${v.icao || state.site}</b></div>
    <div class="meta-row"><span>Scan time</span><b>${t ? t.label : '—'}</b></div>
    <div class="meta-row"><span>Elevation</span><b>${sw ? sw.elevation.toFixed(2) + '°' : '—'}</b></div>
    <div class="meta-row"><span>Radials</span><b>${sw ? sw.radials.length : '—'}</b></div>
    <div class="meta-row"><span>Site lat/lon</span><b>${
      site ? site.lat.toFixed(3) + ', ' + site.lon.toFixed(3) : '—'
    }</b></div>
    <div class="meta-row"><span>Moments</span><b>${
      sw ? [...sw.moments].join(' ') : '—'
    }</b></div>`;
}

// ---------------------------------------------------------------------------
// Interaction: zoom, pan, hover readout
// ---------------------------------------------------------------------------
function setupInteraction() {
  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  el.scopeWrap.addEventListener('wheel', (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    state.view.zoom = Math.max(0.5, Math.min(12, state.view.zoom * factor));
    render();
  }, { passive: false });

  el.scopeWrap.addEventListener('mousedown', (e) => {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
  });
  window.addEventListener('mouseup', () => (dragging = false));
  window.addEventListener('mousemove', (e) => {
    if (dragging) {
      state.view.panX += e.clientX - lastX;
      state.view.panY += e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      render();
    }
  });

  el.scope.addEventListener('mousemove', (e) => updateReadout(e));
  el.scope.addEventListener('mouseleave', () => {
    el.readout.classList.remove('show');
  });
}

function updateReadout(e) {
  const sweep = currentSweep();
  const product = PRODUCTS[state.productId];
  if (!sweep) return;
  const rect = el.scope.getBoundingClientRect();
  const px = ((e.clientX - rect.left) / rect.width) * el.scope.width;
  const py = ((e.clientY - rect.top) / rect.height) * el.scope.height;

  const cx = el.scope.width / 2 + state.view.panX;
  const cy = el.scope.height / 2 + state.view.panY;
  const radiusPx = (Math.min(el.scope.width, el.scope.height) / 2) * state.view.zoom;
  const metersPerPixel = state.view.rangeMeters / radiusPx;
  const dx = px - cx;
  const dy = py - cy;
  const range = Math.sqrt(dx * dx + dy * dy) * metersPerPixel;
  let az = (Math.atan2(dx, -dy) * 180) / Math.PI;
  if (az < 0) az += 360;
  if (range > state.view.rangeMeters) {
    el.readout.classList.remove('show');
    return;
  }

  // Nearest radial for this azimuth that has the moment.
  let best = null;
  let bestDiff = 999;
  for (const rad of sweep.radials) {
    const m = rad.moments[product.moment];
    if (!m) continue;
    let d = Math.abs(rad.azimuth - az);
    if (d > 180) d = 360 - d;
    if (d < bestDiff) {
      bestDiff = d;
      best = m;
    }
  }
  let valueStr = 'ND';
  if (best) {
    const g = Math.round((range - best.firstGate) / best.gateSpacing);
    if (g >= 0 && g < best.gateCount) {
      const code = best.raw[g];
      if (code >= 2) valueStr = ((code - best.offset) / best.scale).toFixed(1) + ' ' + product.unit;
    }
  }
  el.readout.innerHTML = `<b>${valueStr}</b><span>az ${az.toFixed(1)}° · ${(range / 1000).toFixed(
    1
  )} km</span>`;
  el.readout.classList.add('show');
  el.readout.style.left = px / el.scope.width * 100 + '%';
  el.readout.style.top = py / el.scope.height * 100 + '%';
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

  setupInteraction();
  window.addEventListener('resize', sizeCanvases);
  sizeCanvases();
  tickClock();
  setInterval(tickClock, 1000);

  loadVolumeList();
}

document.addEventListener('DOMContentLoaded', init);
