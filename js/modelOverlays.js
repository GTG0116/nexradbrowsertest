// modelOverlays.js — wind-barb and geopotential-height overlays for upper-air
// model products (the classic "field + wind + height" chart). The colored
// scalar fill is drawn by gridLayer; here we add, on top of it:
//   • wind barbs    — a Mapbox symbol layer of canvas-rendered barb glyphs,
//                     rotated to the wind direction (screen-space, so they keep
//                     a constant size and Mapbox declutters them as you zoom).
//   • height lines  — geopotential-height contours from marching squares, plus
//                     decameter labels placed along the lines.
//   • MSLP lines    — sea-level pressure contours, labelled in hPa, for selected
//                     surface model fields, plus H/L pressure-center markers.
//   • wind lines    — wind-speed contours for surface wind and gust products.
//
// Overlay data rides on `grid.overlays = { u, v, hgt, interval, level, mslp,
// windSpeed }`, with the value arrays sharing the main grid's lat/lon geometry.

const KT = 1.9438445; // m/s → knots
const MS_TO_MPH = 2.2369363;
const BARB_STRIDE_DEG = 0.6; // target spacing between plotted barbs
const CONTOUR_STRIDE_DEG = 0.2; // height field is downsampled to this before contouring

// ---------------------------------------------------------------------------
// Barb icons
// ---------------------------------------------------------------------------
// One icon per 5-knot bracket (0…100kt), drawn pointing north; Mapbox rotates
// each instance to the wind's source direction via `icon-rotate`.
const BARB_MAX = 100;
const barbName = (kt) => `barb-${Math.min(BARB_MAX, Math.round(kt / 5) * 5)}`;

function drawBarb(kt) {
  const S = 48, cx = S / 2, cy = S / 2; // device px; added at pixelRatio 2 → 24 CSS px
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  const g = c.getContext('2d');
  g.strokeStyle = '#0b1020';
  g.fillStyle = '#0b1020';
  g.lineWidth = 2;
  g.lineCap = 'round';

  const spd = Math.round(kt / 5) * 5;
  if (spd < 3) { // calm — open circle
    g.lineWidth = 2;
    g.beginPath(); g.arc(cx, cy, 4, 0, Math.PI * 2); g.stroke();
    return g.getImageData(0, 0, S, S);
  }

  // Staff points up (north). Station at centre; tip at top.
  const tipY = 6, baseY = cy + 14; // staff from baseY (bottom) up to tipY
  g.beginPath(); g.moveTo(cx, baseY); g.lineTo(cx, tipY); g.stroke();

  let rem = spd;
  let y = tipY; // place flags/barbs from the tip downward
  const step = 5, barbDx = -11, barbDy = 5; // barbs to the left, angled toward tip
  const drawFlag = () => {
    g.beginPath();
    g.moveTo(cx, y);
    g.lineTo(cx + barbDx, y + barbDy * 0.5);
    g.lineTo(cx, y + step);
    g.closePath(); g.fill();
    y += step + 1;
  };
  const drawFull = () => { g.beginPath(); g.moveTo(cx, y); g.lineTo(cx + barbDx, y + barbDy); g.stroke(); y += step; };
  const drawHalf = () => { g.beginPath(); g.moveTo(cx, y); g.lineTo(cx + barbDx * 0.55, y + barbDy * 0.55); g.stroke(); y += step; };

  while (rem >= 50) { drawFlag(); rem -= 50; }
  // a single full barb shouldn't sit right at the tip if a flag was drawn
  while (rem >= 10) { drawFull(); rem -= 10; }
  if (rem >= 5) drawHalf();

  return g.getImageData(0, 0, S, S);
}

// Register every barb bracket once per style load.
export function ensureBarbImages(map) {
  for (let kt = 0; kt <= BARB_MAX; kt += 5) {
    const name = `barb-${kt}`;
    if (!map.hasImage(name)) map.addImage(name, drawBarb(kt), { pixelRatio: 2 });
  }
}

// ---------------------------------------------------------------------------
// Marching-squares height contours
// ---------------------------------------------------------------------------

// Average the height field down to ~CONTOUR_STRIDE_DEG spacing (it is smooth, so
// this both speeds up contouring and de-noises the lines).
function downsample(grid, values) {
  const { ni, nj, di, dj, lon1, lat1 } = grid;
  const v = values;
  const sx = Math.max(1, Math.round(CONTOUR_STRIDE_DEG / di));
  const sy = Math.max(1, Math.round(CONTOUR_STRIDE_DEG / dj));
  const w = Math.floor(ni / sx), h = Math.floor(nj / sy);
  const out = new Float32Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      let sum = 0, n = 0;
      for (let b = 0; b < sy; b++) {
        for (let a = 0; a < sx; a++) {
          const val = v[(j * sy + b) * ni + (i * sx + a)];
          if (!Number.isNaN(val)) { sum += val; n++; }
        }
      }
      out[j * w + i] = n ? sum / n : NaN;
    }
  }
  // Each output cell averages an sx×sy block of source cells; anchor it at the
  // block's *center*, not the block's first (north-west) cell. Anchoring on the
  // first cell dragged every contour/H-L marker ~half a block west and north —
  // most visible on coarse grids like the 12 km NAM.
  return {
    v: out, w, h,
    lon1: lon1 + ((sx - 1) / 2) * di,
    lat1: lat1 - ((sy - 1) / 2) * dj,
    di: di * sx, dj: dj * sy,
  };
}

// Linear crossing point between two grid corners for a contour level.
function lerpPt(x1, y1, v1, x2, y2, v2, level) {
  const t = (level - v1) / (v2 - v1);
  return [x1 + (x2 - x1) * t, y1 + (y2 - y1) * t];
}

// Marching squares over one cell: push 2-point segments for `level`.
function cellSegments(d, i, j, level, segs) {
  const { v, w, lon1, lat1, di, dj } = d;
  const idx = (ii, jj) => jj * w + ii;
  const vTL = v[idx(i, j)], vTR = v[idx(i + 1, j)];
  const vBL = v[idx(i, j + 1)], vBR = v[idx(i + 1, j + 1)];
  if (Number.isNaN(vTL) || Number.isNaN(vTR) || Number.isNaN(vBL) || Number.isNaN(vBR)) return;
  // Corner geographic coords (lat1 is the north edge → rows go south).
  const xL = lon1 + i * di, xR = lon1 + (i + 1) * di;
  const yT = lat1 - j * dj, yB = lat1 - (j + 1) * dj;
  let code = 0;
  if (vTL > level) code |= 8;
  if (vTR > level) code |= 4;
  if (vBR > level) code |= 2;
  if (vBL > level) code |= 1;
  if (code === 0 || code === 15) return;
  const top = () => lerpPt(xL, yT, vTL, xR, yT, vTR, level);
  const right = () => lerpPt(xR, yT, vTR, xR, yB, vBR, level);
  const bottom = () => lerpPt(xL, yB, vBL, xR, yB, vBR, level);
  const left = () => lerpPt(xL, yT, vTL, xL, yB, vBL, level);
  const push = (a, b) => segs.push([a, b]);
  switch (code) {
    case 1: case 14: push(left(), bottom()); break;
    case 2: case 13: push(bottom(), right()); break;
    case 3: case 12: push(left(), right()); break;
    case 4: case 11: push(top(), right()); break;
    case 6: case 9: push(top(), bottom()); break;
    case 7: case 8: push(left(), top()); break;
    case 5: push(left(), top()); push(bottom(), right()); break;
    case 10: push(left(), bottom()); push(top(), right()); break;
  }
}

// Chain 2-point segments into polylines by matching shared endpoints.
function chain(segs) {
  const key = (p) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`;
  const ends = new Map(); // endpoint key → list of segment indices
  segs.forEach((s, i) => {
    for (const p of s) {
      const k = key(p);
      if (!ends.has(k)) ends.set(k, []);
      ends.get(k).push(i);
    }
  });
  const used = new Array(segs.length).fill(false);
  const lines = [];
  const nextFrom = (k, skip) => {
    for (const idx of ends.get(k) || []) if (idx !== skip && !used[idx]) return idx;
    return -1;
  };
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const line = [segs[i][0], segs[i][1]];
    // extend forward
    for (let k = nextFrom(key(line[line.length - 1]), i); k !== -1;) {
      used[k] = true;
      const [a, b] = segs[k];
      const tail = line[line.length - 1];
      line.push(key(a) === key(tail) ? b : a);
      k = nextFrom(key(line[line.length - 1]), k);
    }
    // extend backward
    for (let k = nextFrom(key(line[0]), i); k !== -1;) {
      used[k] = true;
      const [a, b] = segs[k];
      const head = line[0];
      line.unshift(key(a) === key(head) ? b : a);
      k = nextFrom(key(line[0]), k);
    }
    if (line.length >= 2) lines.push(line);
  }
  return lines;
}

// Build LineString features for a contour field.
function contourGeoJSON(grid, values, interval, labelFor, minLevel = null) {
  const d = downsample(grid, values);
  let lo = Infinity, hi = -Infinity;
  for (const val of d.v) if (!Number.isNaN(val)) { if (val < lo) lo = val; if (val > hi) hi = val; }
  const features = [];
  if (!(hi > lo)) return { type: 'FeatureCollection', features };
  const first = Math.ceil(Math.max(lo, minLevel == null ? lo : minLevel) / interval) * interval;
  for (let level = first; level <= hi; level += interval) {
    const segs = [];
    for (let j = 0; j < d.h - 1; j++)
      for (let i = 0; i < d.w - 1; i++) cellSegments(d, i, j, level, segs);
    const label = labelFor(level);
    for (const line of chain(segs)) {
      if (line.length < 4) continue; // drop tiny scraps
      features.push({
        type: 'Feature',
        properties: { value: level, label },
        geometry: { type: 'LineString', coordinates: line },
      });
    }
  }
  return { type: 'FeatureCollection', features };
}

function heightContourGeoJSON(grid) {
  return contourGeoJSON(grid, grid.overlays.hgt, grid.overlays.interval || 60,
    (level) => String(Math.round(level / 10))); // decameters
}

function mslpContourGeoJSON(grid) {
  return contourGeoJSON(grid, grid.overlays.mslp, grid.overlays.mslpInterval || 400,
    (level) => String(Math.round(level / 100))); // Pa → hPa
}

function windContourGeoJSON(grid) {
  const factor = grid.overlays.windContourFactor || MS_TO_MPH;
  const interval = grid.overlays.windContourInterval || (10 / factor);
  return contourGeoJSON(grid, grid.overlays.windSpeed, interval,
    (level) => String(Math.round(level * factor)), 10 / factor);
}

function pressureCenterGeoJSON(grid) {
  const d = downsample(grid, grid.overlays.mslp);
  const features = [];
  if (d.w < 5 || d.h < 5) return { type: 'FeatureCollection', features };

  const radius = Math.max(4, Math.round(1.4 / Math.max(d.di, d.dj)));
  const candidates = [];
  const idx = (i, j) => j * d.w + i;
  for (let j = radius; j < d.h - radius; j++) {
    if (j % 2) continue;
    for (let i = radius; i < d.w - radius; i += 2) {
      const val = d.v[idx(i, j)];
      if (!Number.isFinite(val)) continue;
      let isHigh = true, isLow = true, ringMax = -Infinity, ringMin = Infinity;
      for (let y = j - radius; y <= j + radius; y++) {
        for (let x = i - radius; x <= i + radius; x++) {
          if (x === i && y === j) continue;
          const other = d.v[idx(x, y)];
          if (!Number.isFinite(other)) continue;
          if (other >= val) isHigh = false;
          if (other <= val) isLow = false;
          if (other > ringMax) ringMax = other;
          if (other < ringMin) ringMin = other;
        }
      }
      const lon = d.lon1 + i * d.di;
      const lat = d.lat1 - j * d.dj;
      if (isHigh && val >= 101600 && val - ringMin >= 150)
        candidates.push({ kind: 'H', val, lon, lat, score: val - ringMin });
      if (isLow && val <= 101000 && ringMax - val >= 150)
        candidates.push({ kind: 'L', val, lon, lat, score: ringMax - val });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  const picked = [];
  const farEnough = (a) => picked.every((b) => Math.hypot((a.lon - b.lon) * Math.cos(a.lat * Math.PI / 180), a.lat - b.lat) >= 7);
  for (const c of candidates) {
    if (!farEnough(c)) continue;
    picked.push(c);
    if (picked.length >= 12) break;
  }

  for (const c of picked) {
    features.push({
      type: 'Feature',
      properties: { kind: c.kind, pressure: Math.round(c.val / 100) },
      geometry: { type: 'Point', coordinates: [c.lon, c.lat] },
    });
  }
  return { type: 'FeatureCollection', features };
}

// ---------------------------------------------------------------------------
// Wind barbs
// ---------------------------------------------------------------------------
function barbGeoJSON(grid) {
  const { ni, nj, di, dj, lon1, lat1 } = grid;
  const { u, v } = grid.overlays;
  const sx = Math.max(1, Math.round(BARB_STRIDE_DEG / di));
  const sy = Math.max(1, Math.round(BARB_STRIDE_DEG / dj));
  const features = [];
  for (let j = 0; j < nj; j += sy) {
    for (let i = 0; i < ni; i += sx) {
      const uu = u[j * ni + i], vv = v[j * ni + i];
      if (Number.isNaN(uu) || Number.isNaN(vv)) continue;
      const kt = Math.hypot(uu, vv) * KT;
      const dir = (Math.atan2(-uu, -vv) * 180) / Math.PI; // meteorological "from"
      features.push({
        type: 'Feature',
        properties: { icon: barbName(kt), rot: (dir + 360) % 360 },
        geometry: { type: 'Point', coordinates: [lon1 + i * di, lat1 - j * dj] },
      });
    }
  }
  return { type: 'FeatureCollection', features };
}

// ---------------------------------------------------------------------------
// Layer wiring
// ---------------------------------------------------------------------------
const EMPTY = { type: 'FeatureCollection', features: [] };

// Create overlay sources + layers (idempotent). `anchor` keeps them beneath the
// basemap's labels, like the other custom layers.
export function setupModelOverlayLayers(map, anchor) {
  ensureBarbImages(map);
  if (!map.getSource('hgt-contours')) map.addSource('hgt-contours', { type: 'geojson', data: EMPTY });
  if (!map.getSource('mslp-contours')) map.addSource('mslp-contours', { type: 'geojson', data: EMPTY });
  if (!map.getSource('wind-contours')) map.addSource('wind-contours', { type: 'geojson', data: EMPTY });
  if (!map.getSource('pressure-centers')) map.addSource('pressure-centers', { type: 'geojson', data: EMPTY });
  if (!map.getSource('wind-barbs')) map.addSource('wind-barbs', { type: 'geojson', data: EMPTY });

  if (!map.getLayer('hgt-contours'))
    map.addLayer({
      id: 'hgt-contours', type: 'line', source: 'hgt-contours',
      layout: { visibility: 'none', 'line-join': 'round' },
      paint: { 'line-color': 'rgba(15,20,30,0.8)', 'line-width': 1.1 },
    }, anchor);
  if (!map.getLayer('hgt-labels'))
    map.addLayer({
      id: 'hgt-labels', type: 'symbol', source: 'hgt-contours',
      layout: {
        visibility: 'none', 'symbol-placement': 'line', 'text-field': ['get', 'label'],
        'text-size': 11, 'symbol-spacing': 220, 'text-allow-overlap': false,
      },
      paint: { 'text-color': '#0b1020', 'text-halo-color': 'rgba(255,255,255,0.85)', 'text-halo-width': 1.4 },
    }, anchor);
  if (!map.getLayer('mslp-contours'))
    map.addLayer({
      id: 'mslp-contours', type: 'line', source: 'mslp-contours',
      layout: { visibility: 'none', 'line-join': 'round' },
      paint: { 'line-color': 'rgba(20,70,130,0.88)', 'line-width': 1.2 },
    }, anchor);
  if (!map.getLayer('mslp-labels'))
    map.addLayer({
      id: 'mslp-labels', type: 'symbol', source: 'mslp-contours',
      layout: {
        visibility: 'none', 'symbol-placement': 'line', 'text-field': ['get', 'label'],
        'text-size': 11, 'symbol-spacing': 240, 'text-allow-overlap': false,
      },
      paint: { 'text-color': '#17467f', 'text-halo-color': 'rgba(255,255,255,0.88)', 'text-halo-width': 1.5 },
    }, anchor);
  if (!map.getLayer('wind-contours'))
    map.addLayer({
      id: 'wind-contours', type: 'line', source: 'wind-contours',
      layout: { visibility: 'none', 'line-join': 'round' },
      paint: { 'line-color': 'rgba(20,20,24,0.72)', 'line-width': 1, 'line-dasharray': [2, 1.4] },
    }, anchor);
  if (!map.getLayer('wind-contour-labels'))
    map.addLayer({
      id: 'wind-contour-labels', type: 'symbol', source: 'wind-contours',
      layout: {
        visibility: 'none', 'symbol-placement': 'line', 'text-field': ['get', 'label'],
        'text-size': 10.5, 'symbol-spacing': 220, 'text-allow-overlap': false,
      },
      paint: { 'text-color': '#111318', 'text-halo-color': 'rgba(255,255,255,0.82)', 'text-halo-width': 1.2 },
    }, anchor);
  if (!map.getLayer('wind-barbs'))
    map.addLayer({
      id: 'wind-barbs', type: 'symbol', source: 'wind-barbs',
      layout: {
        visibility: 'none', 'icon-image': ['get', 'icon'], 'icon-rotate': ['get', 'rot'],
        'icon-rotation-alignment': 'map', 'icon-allow-overlap': false, 'icon-ignore-placement': false,
        'icon-size': 1,
      },
    }, anchor);
  if (!map.getLayer('pressure-centers'))
    map.addLayer({
      id: 'pressure-centers', type: 'symbol', source: 'pressure-centers',
      layout: {
        visibility: 'none',
        'text-field': ['get', 'kind'],
        'text-size': 30,
        'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
        'text-allow-overlap': true, 'text-ignore-placement': true,
      },
      paint: {
        'text-color': ['match', ['get', 'kind'], 'H', '#c92a2a', 'L', '#1864ab', '#111318'],
        'text-halo-color': 'rgba(255,255,255,0.9)', 'text-halo-width': 2,
      },
    }, anchor);
  if (!map.getLayer('pressure-center-labels'))
    map.addLayer({
      id: 'pressure-center-labels', type: 'symbol', source: 'pressure-centers',
      layout: {
        visibility: 'none',
        'text-field': ['concat', ['to-string', ['get', 'pressure']], ' mb'],
        'text-size': 12,
        'text-offset': [0, 1.35],
        'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
        'text-allow-overlap': true, 'text-ignore-placement': true,
      },
      paint: {
        'text-color': ['match', ['get', 'kind'], 'H', '#c92a2a', 'L', '#1864ab', '#111318'],
        'text-halo-color': 'rgba(255,255,255,0.92)', 'text-halo-width': 1.6,
      },
    }, anchor);
}

export function prepareModelOverlayData(grid) {
  if (!grid || !grid.overlays) return null;
  const hasHeight = !!grid.overlays.hgt;
  const hasWind = !!(grid.overlays.u && grid.overlays.v);
  const hasMslp = !!grid.overlays.mslp;
  const hasWindContours = !!grid.overlays.windSpeed;

  return {
    hasHeight,
    hasWind,
    hasMslp,
    hasWindContours,
    hgt: hasHeight ? heightContourGeoJSON(grid) : EMPTY,
    windBarbs: hasWind ? barbGeoJSON(grid) : EMPTY,
    mslp: hasMslp ? mslpContourGeoJSON(grid) : EMPTY,
    pressureCenters: hasMslp ? pressureCenterGeoJSON(grid) : EMPTY,
    windContours: hasWindContours ? windContourGeoJSON(grid) : EMPTY,
  };
}

export function showPreparedModelOverlays(map, data) {
  if (!data) { clearModelOverlays(map); return; }
  setupModelOverlayLayers(map, firstAnchor(map));

  map.getSource('hgt-contours').setData(data.hgt || EMPTY);
  map.getSource('wind-barbs').setData(data.windBarbs || EMPTY);
  map.getSource('mslp-contours').setData(data.mslp || EMPTY);
  map.getSource('pressure-centers').setData(data.pressureCenters || EMPTY);
  map.getSource('wind-contours').setData(data.windContours || EMPTY);

  for (const id of ['hgt-contours', 'hgt-labels'])
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', data.hasHeight ? 'visible' : 'none');
  if (map.getLayer('wind-barbs')) map.setLayoutProperty('wind-barbs', 'visibility', data.hasWind ? 'visible' : 'none');
  for (const id of ['mslp-contours', 'mslp-labels'])
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', data.hasMslp ? 'visible' : 'none');
  for (const id of ['pressure-centers', 'pressure-center-labels'])
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', data.hasMslp ? 'visible' : 'none');
  for (const id of ['wind-contours', 'wind-contour-labels'])
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', data.hasWindContours ? 'visible' : 'none');
}

// Show overlays for a grid that carries `.overlays`, or hide them otherwise.
export function renderModelOverlays(map, grid) {
  showPreparedModelOverlays(map, prepareModelOverlayData(grid));
}

export function clearModelOverlays(map) {
  for (const id of ['hgt-contours', 'hgt-labels', 'wind-barbs', 'mslp-contours', 'mslp-labels',
    'pressure-centers', 'pressure-center-labels', 'wind-contours', 'wind-contour-labels'])
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none');
  for (const id of ['hgt-contours', 'wind-barbs', 'mslp-contours', 'pressure-centers', 'wind-contours'])
    if (map.getSource(id)) map.getSource(id).setData(EMPTY);
}

function firstAnchor(map) {
  const layers = map.getStyle().layers || [];
  for (const ly of layers) if (ly.type === 'symbol') return ly.id;
  return undefined;
}
