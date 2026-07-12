// xsect.js — vertical cross sections (RHI-style slices) through a decoded
// Level II volume, for every Level II product (REF / VEL / SRV / SW / RHO /
// ZDR / PHI).
//
// The user arms the tool and clicks two points on the map (A → B). For each of
// ~N columns along that line we walk every elevation sweep carrying the active
// product's moment, find the nearest radial and gate at the column's ground
// range, and place the sampled value at the beam-centre height given by the
// standard 4/3-earth-radius propagation model. The panel paints the section on
// a canvas using the product's own color scale (including any user-loaded
// .pal), with height (kft) and along-line distance (mi) axes.
//
// The computation reuses the volume's existing gate arrays and produces only a
// few small Float32 columns per sweep, so opening a section costs essentially
// no resident memory — in keeping with the app's memory budget.

import { PRODUCTS, PRODUCT_ORDER, colorFor, dispValue, dispUnitOf, unitDecimals } from './products.js';
import { dealiasSweep, stormRelativeSweep } from './dealias.js';

const M_PER_DEG_LAT = 111320;
const RE_EFFECTIVE = (4 / 3) * 6371000; // 4/3-earth effective radius, metres
const M_TO_MI = 0.000621371;
const M_TO_KFT = 0.00328084;
const TILT_EPS = 0.15; // same tolerance the tilt list uses to merge SAILS revisits
const MAX_AZ_GAP_DEG = 1.6; // farther than this from any beam → gap, not data
const XS_SOURCE = 'xsect-line';
const XS_LINE_LAYER = 'xsect-line-stroke';
const XS_POINT_LAYER = 'xsect-line-points';

// Beam-centre height (m, above the radar) of a gate at slant range r on a tilt
// of elevation `sinEl/cosEl`, 4/3-earth model.
function beamHeight(r, sinEl) {
  return Math.sqrt(r * r + RE_EFFECTIVE * RE_EFFECTIVE + 2 * r * RE_EFFECTIVE * sinEl) - RE_EFFECTIVE;
}

// Ground (great-circle) distance for a slant range r at elevation θ.
function groundDistance(r, sinEl, cosEl) {
  const h = beamHeight(r, sinEl);
  return RE_EFFECTIVE * Math.asin((r * cosEl) / (RE_EFFECTIVE + h));
}

// Invert ground distance → slant range for a tilt (monotonic; two fixed-point
// refinements of r ≈ s/cosθ are accurate to well under a gate width).
function slantForGround(s, sinEl, cosEl) {
  let r = s / Math.max(cosEl, 0.05);
  for (let i = 0; i < 2; i++) {
    const sr = groundDistance(r, sinEl, cosEl);
    if (sr > 1) r *= s / sr;
  }
  return r;
}

// Build one time-coherent elevation set. A SAILS/MESO-SAILS volume can contain
// a fresh low-level revisit after the higher tilts were collected. Picking the
// newest sweep independently at every elevation mixes two scan cycles. Use the
// oldest of each elevation's newest samples as the latest common cutoff.
function tiltsForMoment(sweeps, moment) {
  const list = sweeps.filter((sw) => {
    const m = sw.moments;
    return m && (Array.isArray(m) ? m.includes(moment) : m.has && m.has(moment));
  });
  const groups = [];
  for (const sw of list) {
    let group = groups.find((g) => Math.abs(sw.elevation - g.elevation) <= TILT_EPS);
    if (!group) groups.push((group = { elevation: sw.elevation, sweeps: [] }));
    group.sweeps.push(sw);
  }
  if (!groups.length) return [];
  for (const group of groups) group.sweeps.sort((a, b) => (a.time || 0) - (b.time || 0));
  const commonTime = Math.min(...groups.map((g) => g.sweeps[g.sweeps.length - 1].time || 0));
  const out = groups.map((g) => {
    const eligible = g.sweeps.filter((sw) => !commonTime || (sw.time || 0) <= commonTime);
    return eligible[eligible.length - 1] || g.sweeps[0];
  });
  out.commonTime = commonTime;
  return out;
}

export class CrossSectionTool {
  // opts: { map, getVolume, getProductId, getDealias, onStatus, onToolEnd }
  constructor(opts) {
    this.map = opts.map;
    this.getVolume = opts.getVolume;
    this.getProductId = opts.getProductId || (() => 'REF');
    this.getDealias = opts.getDealias || (() => true);
    this.onStatus = opts.onStatus || (() => {});
    this.onToolEnd = opts.onToolEnd || (() => {});
    this.armed = false;
    this.open = false;
    this.points = []; // committed endpoints [[lng,lat], …]
    this.hover = null; // live cursor position while placing B
    this.productId = 'REF';
    this._volumeShown = null;
    this._panel = null;

    this.map.on('click', (e) => this._onClick(e));
    this.map.on('mousemove', (e) => this._onMove(e));
    this.map.on('style.load', () => {
      // A basemap switch drops our source; restore it if a section is up.
      if (this.points.length) setTimeout(() => this._refreshLine(), 0);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && (this.armed || this.open)) this.close();
    });
  }

  active() {
    return this.armed || this.open;
  }

  // Toggle the picking mode. Returns whether the tool is now active.
  toggle() {
    if (this.armed || this.open) {
      this.close();
      return false;
    }
    const vol = this.getVolume();
    if (!vol || !vol.sweeps || !vol.sweeps.length || !vol.site) {
      this.onStatus('cross section: load a radar volume first');
      return false;
    }
    this.armed = true;
    this.points = [];
    this.hover = null;
    this.map.getCanvas().style.cursor = 'crosshair';
    this.map.doubleClickZoom.disable();
    this.onStatus('cross section: click the start point (A)');
    return true;
  }

  close() {
    const wasActive = this.armed || this.open;
    this.armed = false;
    this.open = false;
    this.points = [];
    this.hover = null;
    this.map.getCanvas().style.cursor = '';
    this.map.doubleClickZoom.enable();
    this._refreshLine();
    if (this._panel) this._panel.hidden = true;
    if (wasActive) this.onToolEnd();
  }

  // Called by the app when a new volume displays, so an open section tracks the
  // live data (and a product palette change repaints in the new colors).
  refresh() {
    if (!this.open) return;
    const vol = this.getVolume();
    if (!vol || vol === this._volumeShown) return;
    this._compute();
  }

  _onClick(e) {
    if (!this.armed) return;
    const pt = [e.lngLat.lng, e.lngLat.lat];
    if (!this.points.length) {
      this.points = [pt];
      this.onStatus('cross section: click the end point (B)');
      this._refreshLine();
      return;
    }
    if (this.points.length === 1) {
      this.points.push(pt);
      this.hover = null;
      this.armed = false;
      this.map.getCanvas().style.cursor = '';
      this.map.doubleClickZoom.enable();
      this._refreshLine();
      // Default the section to the product on screen (SRV/VEL/etc.).
      const pid = this.getProductId();
      this.productId = PRODUCTS[pid] ? pid : 'REF';
      this.openPanel();
    }
  }

  _onMove(e) {
    if (!this.armed || this.points.length !== 1) return;
    this.hover = [e.lngLat.lng, e.lngLat.lat];
    this._refreshLine();
  }

  // ---- Map line (A→B) ----
  _ensureLayers() {
    const map = this.map;
    if (!map.getStyle || !map.getStyle()) return false;
    try {
      if (!map.getSource(XS_SOURCE))
        map.addSource(XS_SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      if (!map.getLayer(XS_LINE_LAYER)) {
        map.addLayer({
          id: XS_LINE_LAYER, type: 'line', source: XS_SOURCE,
          filter: ['==', ['geometry-type'], 'LineString'],
          layout: { 'line-cap': 'round' },
          paint: { 'line-color': '#7c6cff', 'line-width': 3, 'line-dasharray': [1.6, 1.2], 'line-opacity': 0.95 },
        });
      }
      if (!map.getLayer(XS_POINT_LAYER)) {
        map.addLayer({
          id: XS_POINT_LAYER, type: 'circle', source: XS_SOURCE,
          filter: ['==', ['geometry-type'], 'Point'],
          paint: {
            'circle-radius': 5,
            'circle-color': '#7c6cff',
            'circle-stroke-color': '#0a0e16',
            'circle-stroke-width': 1.5,
          },
        });
      }
    } catch (_) {
      return false;
    }
    return true;
  }

  _refreshLine() {
    if (!this._ensureLayers()) return;
    const feats = [];
    const pts = this.hover && this.points.length === 1 ? [...this.points, this.hover] : this.points;
    if (pts.length >= 2)
      feats.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: pts }, properties: {} });
    this.points.forEach((c, i) => feats.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: c },
      properties: { label: i === 0 ? 'A' : 'B' },
    }));
    const src = this.map.getSource(XS_SOURCE);
    if (src) src.setData({ type: 'FeatureCollection', features: feats });
  }

  // ---- Panel ----
  _buildPanel() {
    if (this._panel) return;
    const div = document.createElement('div');
    div.className = 'xsect';
    div.hidden = true;
    div.innerHTML = `
      <div class="xs-head">
        <div class="xs-title">
          <h2>Cross section</h2>
          <div class="xs-meta">—</div>
        </div>
        <div class="xs-products"></div>
        <button class="xs-close" title="Close (Esc)">✕</button>
      </div>
      <div class="xs-body">
        <canvas class="xs-canvas"></canvas>
        <div class="xs-read" hidden></div>
      </div>`;
    document.body.appendChild(div);
    this._panel = div;
    this._canvas = div.querySelector('.xs-canvas');
    this._meta = div.querySelector('.xs-meta');
    this._productsEl = div.querySelector('.xs-products');
    this._readEl = div.querySelector('.xs-read');
    div.querySelector('.xs-close').addEventListener('click', () => this.close());
    // Repaint (cheap — data already sampled) when the panel geometry changes.
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(() => { if (this.open && this._section) this._render(); }).observe(this._canvas);
    } else {
      window.addEventListener('resize', () => { if (this.open && this._section) this._render(); });
    }
    // Hover readout: value + height under the cursor.
    this._canvas.addEventListener('mousemove', (e) => this._onCanvasHover(e));
    this._canvas.addEventListener('mouseleave', () => { this._readEl.hidden = true; });
  }

  openPanel() {
    this._buildPanel();
    this.open = true;
    this._panel.hidden = false;
    this._buildProductButtons();
    this._compute();
  }

  _buildProductButtons() {
    const vol = this.getVolume();
    const host = this._productsEl;
    host.innerHTML = '';
    if (!vol) return;
    const avail = new Set();
    for (const sw of vol.sweeps) {
      const m = sw.moments;
      for (const name of Array.isArray(m) ? m : (m ? [...m] : [])) avail.add(name);
    }
    for (const id of PRODUCT_ORDER) {
      const p = PRODUCTS[id];
      if (!p || !avail.has(p.moment)) continue;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = id;
      btn.title = p.name;
      btn.classList.toggle('active', id === this.productId);
      btn.addEventListener('click', () => {
        this.productId = id;
        this._buildProductButtons();
        this._compute();
      });
      host.appendChild(btn);
    }
  }

  // ---- Sampling ----
  _compute() {
    const vol = this.getVolume();
    if (!vol || !vol.site || this.points.length !== 2) return;
    const product = PRODUCTS[this.productId] || PRODUCTS.REF;
    this._volumeShown = vol;

    let sweeps = tiltsForMoment(vol.sweeps, product.moment);
    if (!sweeps.length) {
      this._section = null;
      this._meta.textContent = `${vol.icao || ''} · ${product.name}: no data in this volume`;
      this._render();
      return;
    }
    const commonTime = sweeps.commonTime || 0;
    // Velocity products are shown the way the map shows them: dealiased (always,
    // for SRV; per the user toggle for VEL), with SRV's mean-wind removal.
    if (this.productId === 'SRV') sweeps = sweeps.map((sw) => stormRelativeSweep(dealiasSweep(sw)));
    else if (this.productId === 'VEL' && this.getDealias()) sweeps = sweeps.map((sw) => dealiasSweep(sw));

    const site = vol.site;
    const [a, b] = this.points;
    const mPerDegLon = M_PER_DEG_LAT * Math.cos((site.lat * Math.PI) / 180);
    const dxTot = (b[0] - a[0]) * mPerDegLon;
    const dyTot = (b[1] - a[1]) * M_PER_DEG_LAT;
    const totalM = Math.sqrt(dxTot * dxTot + dyTot * dyTot) || 1;
    const ncol = Math.max(160, Math.min(560, Math.round(totalM / 250)));

    // Pre-index each sweep: azimuth-sorted radials of this moment.
    const tilts = sweeps.map((sw) => {
      const beams = [];
      for (const r of sw.radials) {
        const m = r.moments[product.moment];
        if (m) beams.push({ az: r.azimuth, m });
      }
      beams.sort((x, y) => x.az - y.az);
      const el = (sw.elevation * Math.PI) / 180;
      return {
        elevation: sw.elevation,
        sinEl: Math.sin(el),
        cosEl: Math.cos(el),
        beams,
        azs: beams.map((x) => x.az),
        vals: new Float32Array(ncol).fill(NaN),
        hts: new Float32Array(ncol),
      };
    });

    let maxHt = 0;
    let anyData = false;
    for (let i = 0; i < ncol; i++) {
      const t = i / (ncol - 1);
      const lon = a[0] + (b[0] - a[0]) * t;
      const lat = a[1] + (b[1] - a[1]) * t;
      const dEast = (lon - site.lon) * mPerDegLon;
      const dNorth = (lat - site.lat) * M_PER_DEG_LAT;
      const s = Math.sqrt(dEast * dEast + dNorth * dNorth);
      let az = (Math.atan2(dEast, dNorth) * 180) / Math.PI;
      if (az < 0) az += 360;

      for (const tl of tilts) {
        const nb = tl.beams.length;
        if (!nb) continue;
        // Nearest beam by azimuth (binary search over the sorted list, wrapping).
        let lo = 0, hi = nb;
        const azs = tl.azs;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (azs[mid] < az) lo = mid + 1; else hi = mid; }
        const cand = [(lo - 1 + nb) % nb, lo % nb];
        let best = null, bestD = 999;
        for (const ci of cand) {
          let d = Math.abs(azs[ci] - az);
          if (d > 180) d = 360 - d;
          if (d < bestD) { bestD = d; best = tl.beams[ci]; }
        }
        if (!best || bestD > MAX_AZ_GAP_DEG) continue;

        const r = slantForGround(s, tl.sinEl, tl.cosEl);
        const m = best.m;
        const g = Math.round((r - m.firstGate) / m.gateSpacing);
        const h = beamHeight(r, tl.sinEl);
        tl.hts[i] = h;
        if (g < 0 || g >= m.gateCount) continue;
        const code = m.raw[g];
        if (code < 2) continue;
        tl.vals[i] = (code - m.offset) / (m.scale || 1);
        anyData = true;
        if (h > maxHt) maxHt = h;
      }
    }

    this._section = {
      product,
      tilts,
      ncol,
      totalM,
      anyData,
      // Headroom above the highest echo; sane floor/cap so the axis stays readable.
      maxHt: Math.min(Math.max(maxHt * 1.15, 6000), 22000),
    };
    const miles = (totalM * M_TO_MI).toFixed(totalM * M_TO_MI < 20 ? 1 : 0);
    this._meta.textContent =
      `${vol.icao || ''} · ${product.name} · ${tilts.length} tilts` +
      `${commonTime ? ` · coherent through ${new Date(commonTime).toISOString().slice(11, 19)}Z` : ''} · ${miles} mi`;
    this._render();
  }

  // ---- Painting ----
  _render() {
    const canvas = this._canvas;
    const sec = this._section;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cw = canvas.clientWidth || 600;
    const ch = canvas.clientHeight || 300;
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);

    const padL = 44, padR = 10, padT = 8, padB = 24;
    const plotW = cw - padL - padR;
    const plotH = ch - padT - padB;
    if (plotW < 40 || plotH < 40) return;

    ctx.fillStyle = 'rgba(2, 8, 16, 0.55)';
    ctx.fillRect(padL, padT, plotW, plotH);

    const axis = 'rgba(190, 205, 225, 0.85)';
    const grid = 'rgba(160, 180, 205, 0.14)';
    ctx.font = '10px "JetBrains Mono", monospace';

    if (!sec || !sec.anyData) {
      ctx.fillStyle = axis;
      ctx.textAlign = 'center';
      ctx.fillText('no echo along this line', padL + plotW / 2, padT + plotH / 2);
      this._plotBox = null;
      return;
    }

    const { product, tilts, ncol, totalM, maxHt } = sec;
    const yFor = (h) => padT + plotH - (h / maxHt) * plotH;
    const colW = plotW / ncol;

    // Column fill: each tilt's sample owns the band from the midpoint below to
    // the midpoint above (the classic RHI wedge fill), so the section is
    // continuous without inventing values between beams.
    const styleCache = new Map();
    for (let i = 0; i < ncol; i++) {
      const x = padL + i * colW;
      for (let k = 0; k < tilts.length; k++) {
        const v = tilts[k].vals[i];
        if (Number.isNaN(v)) continue;
        const h = tilts[k].hts[i];
        const hBelow = k > 0 ? tilts[k - 1].hts[i] : 0;
        const hAbove = k < tilts.length - 1 ? tilts[k + 1].hts[i] : h + (h - hBelow);
        let y0 = k > 0 ? (h + hBelow) / 2 : Math.max(0, h - (hAbove - h) / 2);
        let y1 = (h + hAbove) / 2;
        if (y1 <= y0) y1 = y0 + 60;
        const c = colorFor(product, v);
        if (!c || c[3] === 0) continue;
        const key = (c[0] << 16) | (c[1] << 8) | c[2];
        let fill = styleCache.get(key);
        if (!fill) { fill = `rgb(${c[0]},${c[1]},${c[2]})`; styleCache.set(key, fill); }
        ctx.fillStyle = fill;
        const top = yFor(Math.min(y1, maxHt));
        const bot = yFor(Math.max(y0, 0));
        ctx.fillRect(x, top, colW + 0.6, Math.max(bot - top, 0.5));
      }
    }

    // Height axis (kft) with gridlines.
    const maxKft = maxHt * M_TO_KFT;
    const stepKft = maxKft > 45 ? 10 : 5;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let kft = 0; kft <= maxKft; kft += stepKft) {
      const y = yFor(kft / M_TO_KFT);
      ctx.strokeStyle = grid;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
      ctx.stroke();
      ctx.fillStyle = axis;
      ctx.fillText(kft ? `${kft}` : '0 kft', padL - 6, y);
    }

    // Distance axis (mi), A → B.
    const totalMi = totalM * M_TO_MI;
    const stepMi = totalMi > 120 ? 25 : totalMi > 50 ? 10 : totalMi > 20 ? 5 : totalMi > 8 ? 2 : 1;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let mi = 0; mi <= totalMi; mi += stepMi) {
      const x = padL + (mi / totalMi) * plotW;
      ctx.strokeStyle = grid;
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + plotH);
      ctx.stroke();
      ctx.fillStyle = axis;
      ctx.fillText(`${mi}`, x, padT + plotH + 4);
    }
    ctx.fillStyle = axis;
    ctx.textAlign = 'left';
    ctx.fillText('A', padL + 2, padT + plotH + 4);
    ctx.textAlign = 'right';
    ctx.fillText(`B (mi)`, padL + plotW - 2, padT + plotH + 4);

    this._plotBox = { padL, padT, plotW, plotH };
  }

  // Value + height readout under the cursor.
  _onCanvasHover(e) {
    const sec = this._section;
    const box = this._plotBox;
    if (!sec || !sec.anyData || !box) { this._readEl.hidden = true; return; }
    const rect = this._canvas.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    const fx = (x - box.padL) / box.plotW;
    const fy = 1 - (y - box.padT) / box.plotH;
    if (fx < 0 || fx > 1 || fy < 0 || fy > 1) { this._readEl.hidden = true; return; }
    const i = Math.max(0, Math.min(sec.ncol - 1, Math.round(fx * (sec.ncol - 1))));
    const h = fy * sec.maxHt;
    // The tilt whose beam height at this column is closest to the cursor height.
    let best = null, bestD = Infinity;
    for (const tl of sec.tilts) {
      const d = Math.abs(tl.hts[i] - h);
      if (d < bestD) { bestD = d; best = tl; }
    }
    const p = sec.product;
    const v = best ? best.vals[i] : NaN;
    const val = Number.isNaN(v)
      ? 'no echo'
      : `${dispValue(p, v).toFixed(unitDecimals(dispUnitOf(p)))} ${dispUnitOf(p)}`;
    this._readEl.textContent =
      `${val} · ${(h * M_TO_KFT).toFixed(1)} kft · ${(fx * sec.totalM * M_TO_MI).toFixed(1)} mi` +
      (best ? ` · ${best.elevation.toFixed(1)}°` : '');
    this._readEl.hidden = false;
    this._readEl.style.left = `${Math.min(x + 12, rect.width - 150)}px`;
    this._readEl.style.top = `${Math.max(4, y - 26)}px`;
  }
}
