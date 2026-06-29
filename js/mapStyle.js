// mapStyle.js — user-adjustable styling of the basemap's own vector layers
// (town labels, roads, rivers and admin borders) plus the alert
// overlay paint. The basemap is a Mapbox vector style, so "customising the map"
// means overriding the paint/layout of the style's native layers in place.
//
// setStyle() (a basemap switch) resets every layer to its stock paint, so these
// overrides are re-applied on every style load. The chosen options live in
// app.js `state.mapStyle` (persisted) and are passed in here; this module holds
// no UI, only the apply logic, so the main scope and the split-view pane can
// share one implementation and stay visually identical.

// Font stacks offered for town/place labels. Every standard Mapbox style ships
// the DIN Pro and Arial Unicode glyph sets, so these resolve on Dark, Light,
// Streets, Satellite-Streets and Outdoors alike. `null` leaves the style's own
// font untouched.
export const TOWN_FONTS = {
  default: { label: 'Map default', stack: null },
  'din-regular': { label: 'DIN Pro Regular', stack: ['DIN Pro Regular', 'Arial Unicode MS Regular'] },
  'din-medium': { label: 'DIN Pro Medium', stack: ['DIN Pro Medium', 'Arial Unicode MS Regular'] },
  'din-bold': { label: 'DIN Pro Bold', stack: ['DIN Pro Bold', 'Arial Unicode MS Bold'] },
  'din-italic': { label: 'DIN Pro Italic', stack: ['DIN Pro Italic', 'Arial Unicode MS Regular'] },
};

// Defaults chosen so that the multiplier-/native-baseline values (1×, white
// borders, ~1 px halo) reproduce the app's prior look exactly when untouched.
export const DEFAULT_MAP_STYLE = {
  townFont: 'default',
  townThickness: 1, // text-halo-width, px
  townSize: 1, // multiplier on the style's native text-size (town/place labels)
  roadColor: '', // '' → keep the style's native colour
  roadWidth: 1, // multiplier on the native line width
  riverColor: '',
  riverWidth: 1,
  borderColor: '#ffffff',
  borderWidth: 1, // multiplier on the native border widths
};

export function normalizeMapStyle(s) {
  const o = { ...DEFAULT_MAP_STYLE };
  if (s && typeof s === 'object') {
    if (TOWN_FONTS[s.townFont]) o.townFont = s.townFont;
    if (typeof s.townThickness === 'number') o.townThickness = clamp(s.townThickness, 0, 6);
    if (typeof s.townSize === 'number') o.townSize = clamp(s.townSize, 0.5, 3);
    for (const k of ['roadColor', 'riverColor', 'borderColor'])
      if (typeof s[k] === 'string') o[k] = s[k];
    for (const k of ['roadWidth', 'riverWidth', 'borderWidth'])
      if (typeof s[k] === 'number') o[k] = clamp(s[k], 0.1, 6);
  }
  return o;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function adminSource(map) {
  const layers = map.getStyle().layers || [];
  const admin = layers.find((l) =>
    (l['source-layer'] === 'admin' || l['source-layer'] === 'boundary') && l.source);
  return admin && admin.source;
}

// Classify the style's native line layers so the right user control drives each.
// (Highways live in the same `road` source-layer as ordinary roads in Mapbox's
// styles, so they're covered by the single Roads control.)
function isRoadLayer(ly) {
  return ly.type === 'line' &&
    (ly['source-layer'] === 'road' || ly['source-layer'] === 'transportation' || /road|transport/i.test(ly.id));
}
function isRiverLayer(ly) {
  return ly.type === 'line' && (ly['source-layer'] === 'waterway' || /waterway|river/i.test(ly.id));
}

// Does an expression reference a camera value (zoom)? Such expressions may only
// appear at the top level of a paint property, never nested inside another
// expression — so we must never wrap them in a multiply.
function referencesCamera(expr) {
  return Array.isArray(expr) && (expr[0] === 'zoom' || expr.some(referencesCamera));
}

// Scale a single interpolate/step output (a constant, normally) by `mult`.
function scaleOutput(v, mult) {
  return typeof v === 'number' ? v * mult : referencesCamera(v) ? v : ['*', v, mult];
}

// Multiply a `line-width` value by `mult` *without* nesting a zoom expression
// inside a multiply (which Mapbox rejects, silently dropping the property — the
// reason an earlier version's thickness sliders did nothing). For zoom-/step-
// interpolated widths we rebuild the expression with each output stop scaled, so
// `['zoom']` stays at the top level; plain numbers are multiplied directly.
function scaleLineWidth(value, mult) {
  if (mult === 1) return value;
  if (typeof value === 'number') return value * mult;
  if (Array.isArray(value)) {
    const op = value[0];
    if (op === 'interpolate' || op === 'interpolate-hcl' || op === 'interpolate-lab') {
      const out = value.slice(0, 3); // ['interpolate', interpolation, input]
      for (let i = 3; i < value.length; i += 2) out.push(value[i], scaleOutput(value[i + 1], mult));
      return out;
    }
    if (op === 'step') {
      const out = [value[0], value[1], scaleOutput(value[2], mult)]; // step, input, out0
      for (let i = 3; i < value.length; i += 2) out.push(value[i], scaleOutput(value[i + 1], mult));
      return out;
    }
    // Any other expression: multiply only when it carries no camera reference.
    return referencesCamera(value) ? value : ['*', value, mult];
  }
  return value;
}
function isTownLabelLayer(ly) {
  if (ly.type !== 'symbol') return false;
  const sl = ly['source-layer'] || '';
  return /settlement|place/i.test(sl) || /settlement|place/i.test(ly.id);
}

// Apply every basemap customisation to one map. `opts` is a normalised
// DEFAULT_MAP_STYLE-shaped object. `anchor` is the layer the county outline is
// inserted beneath. `fresh` must be true on a style (re)load so the captured
// native line widths are re-read from the now-reset stock paint; passing false
// (a live slider change on an already-loaded style) reuses the captured natives
// so width multipliers don't compound.
export function applyMapStyle(map, opts, anchor, { fresh = false } = {}) {
  if (!map || !map.getStyle) return;
  const o = normalizeMapStyle(opts);
  if (fresh || !map.__nativeLineWidth) map.__nativeLineWidth = {};
  const natives = map.__nativeLineWidth;
  // Town/place labels' native text-size is captured the same way as line widths
  // so the user's size multiplier scales the stock value without compounding on
  // repeated live changes (and is re-read fresh on each style load).
  if (fresh || !map.__nativeTextSize) map.__nativeTextSize = {};
  const textNatives = map.__nativeTextSize;
  // Generic boundary widths (MapTiler etc.) are captured the same way; re-read on
  // a fresh style load so a basemap switch doesn't reuse the old style's widths.
  if (fresh || !map.__nativeBorderWidth) map.__nativeBorderWidth = {};

  // Remember a layer's stock line width the first time we see it on this style
  // load, then drive its width as native × multiplier (and optionally recolour).
  const styleLine = (id, mult, color) => {
    if (!map.getLayer(id)) return;
    if (!(id in natives)) {
      const w = map.getPaintProperty(id, 'line-width');
      natives[id] = w == null ? 1 : w;
    }
    map.setPaintProperty(id, 'line-width', scaleLineWidth(natives[id], mult));
    if (color) map.setPaintProperty(id, 'line-color', color);
    map.setLayoutProperty(id, 'visibility', 'visible');
  };

  const layers = map.getStyle().layers || [];
  for (const ly of layers) {
    if (isRoadLayer(ly)) styleLine(ly.id, opts.roadWidth, opts.roadColor);
    else if (isRiverLayer(ly)) styleLine(ly.id, opts.riverWidth, opts.riverColor);
    else if (isTownLabelLayer(ly)) {
      const f = TOWN_FONTS[opts.townFont];
      if (f && f.stack) map.setLayoutProperty(ly.id, 'text-font', f.stack);
      map.setPaintProperty(ly.id, 'text-halo-width', opts.townThickness);
      if (!(ly.id in textNatives)) {
        const ts = map.getLayoutProperty(ly.id, 'text-size');
        textNatives[ly.id] = ts == null ? 16 : ts;
      }
      map.setLayoutProperty(ly.id, 'text-size', scaleLineWidth(textNatives[ly.id], o.townSize));
    }
  }

  styleBoundaries(map, anchor, o);
}

// The Mapbox admin layer IDs we hand-tune for the classic look. They only exist
// on Mapbox vector styles; MapTiler/OpenMapTiles names its boundaries differently
// (and the colour/width controls did nothing there until the generic pass below).
const MAPBOX_ADMIN_LAYERS = new Set([
  'admin-0-boundary-bg', 'admin-0-boundary', 'admin-0-boundary-disputed',
  'admin-1-boundary-bg', 'admin-1-boundary',
]);

// Is this a country/state administrative *line* layer (any provider)? Catches
// Mapbox's `admin-*` ids and OpenMapTiles' `boundary` source-layer (MapTiler).
function isBoundaryLayer(ly) {
  if (ly.type !== 'line' || ly.id === 'county-outline') return false;
  const sl = ly['source-layer'] || '';
  return /^(admin|boundary|administrative)$/i.test(sl) || /admin|boundary|border/i.test(ly.id);
}

// Recolour/resize the basemap's own country/state borders (and add county lines
// from the same admin source). See the long note in app.js: the native admin
// lines already sit above the radar/roads and below the labels, so restyling
// them in place gives one consistent look on every basemap.
//
// Mapbox's stock styles get the hand-tuned per-level look (halo backings,
// dashes); every other provider (notably MapTiler, whose boundary layer IDs
// aren't the Mapbox `admin-*` set, so the old hardcoded repaints were silent
// no-ops) gets a generic pass that recolours each boundary line and scales its
// native width by the multiplier — so the colour/width controls finally work.
function styleBoundaries(map, anchor, o) {
  const col = o.borderColor || '#ffffff';
  const mult = o.borderWidth;
  // Build a zoom-interpolated width from (zoom, width) pairs, baking the border
  // thickness multiplier into each width output so `['zoom']` stays at the top
  // level (Mapbox rejects a zoom expression nested inside a multiply).
  const w = (...stops) => {
    const expr = ['interpolate', ['linear'], ['zoom']];
    for (let i = 0; i < stops.length; i += 2) expr.push(stops[i], stops[i + 1] * mult);
    return expr;
  };
  const repaint = (id, paint) => {
    if (!map.getLayer(id)) return;
    for (const [k, v] of Object.entries(paint)) map.setPaintProperty(id, k, v);
    map.setLayoutProperty(id, 'visibility', 'visible');
  };
  repaint('admin-0-boundary-bg', {
    'line-color': 'rgba(8,14,24,0.5)', 'line-opacity': 1, 'line-blur': 0,
    'line-width': w(3, 2.6, 7, 3.8, 11, 4.8),
  });
  repaint('admin-0-boundary', {
    'line-color': col, 'line-opacity': 1, 'line-dasharray': [1, 0],
    'line-width': w(3, 1.1, 7, 1.9, 11, 2.5),
  });
  repaint('admin-0-boundary-disputed', {
    'line-color': col, 'line-opacity': 0.9, 'line-dasharray': [2, 2],
    'line-width': w(3, 1, 7, 1.6, 11, 2.1),
  });
  repaint('admin-1-boundary-bg', {
    'line-color': 'rgba(8,14,24,0.35)', 'line-opacity': 1, 'line-blur': 0,
    'line-width': w(3, 1.4, 7, 2.2, 11, 3),
  });
  repaint('admin-1-boundary', {
    'line-color': col, 'line-opacity': 0.85, 'line-dasharray': [3, 2],
    'line-width': w(3, 0.5, 7, 1, 11, 1.5),
  });

  // Generic pass for any boundary line layer not in the Mapbox set above — i.e.
  // every MapTiler/OpenMapTiles boundary. Capture each layer's stock width once
  // (so the multiplier scales the native value without compounding on repeated
  // live slider changes), drive width as native × multiplier, and recolour.
  const bNatives = map.__nativeBorderWidth || (map.__nativeBorderWidth = {});
  for (const ly of map.getStyle().layers || []) {
    if (!isBoundaryLayer(ly) || MAPBOX_ADMIN_LAYERS.has(ly.id)) continue;
    const id = ly.id;
    if (!(id in bNatives)) {
      const nw = map.getPaintProperty(id, 'line-width');
      bNatives[id] = nw == null ? 1 : nw;
    }
    map.setPaintProperty(id, 'line-width', scaleLineWidth(bNatives[id], mult));
    map.setPaintProperty(id, 'line-color', col);
    map.setLayoutProperty(id, 'visibility', 'visible');
  }

  // County (admin_level 2) lines aren't drawn by the stock styles; add our own
  // once, then keep its paint in sync on later calls.
  if (map.getLayer('county-outline')) {
    map.setPaintProperty('county-outline', 'line-color', withAlpha(col, 0.35));
    map.setPaintProperty('county-outline', 'line-width', w(5, 0.3, 8, 0.7, 11, 1.1));
  } else {
    const source = adminSource(map);
    if (!source) return;
    const adminLayer = (map.getStyle().layers || []).find((l) =>
      l.source === source && (l['source-layer'] === 'admin' || l['source-layer'] === 'boundary'));
    map.addLayer(
      {
        id: 'county-outline', type: 'line', source,
        'source-layer': adminLayer && adminLayer['source-layer'] ? adminLayer['source-layer'] : 'admin',
        filter: [
          'all',
          ['match', ['get', 'admin_level'], [2, '2', 6, '6'], true, false],
          ['any', ['!', ['has', 'maritime']], ['==', ['get', 'maritime'], 'false'], ['==', ['get', 'maritime'], 0]],
          ['any', ['!', ['has', 'disputed']], ['==', ['get', 'disputed'], 'false'], ['==', ['get', 'disputed'], 0]],
          ['any', ['!', ['has', 'worldview']], ['match', ['get', 'worldview'], ['all', 'US'], true, false]],
        ],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        minzoom: 5,
        paint: {
          'line-color': withAlpha(col, 0.35),
          'line-width': w(5, 0.3, 8, 0.7, 11, 1.1),
        },
      },
      anchor
    );
  }
}

// Fade a #rrggbb (or rgb/rgba) colour to the given alpha for the faint county
// lines, so the border colour the user picks also tints the county outlines.
function withAlpha(color, a) {
  if (typeof color !== 'string') return `rgba(255,255,255,${a})`;
  const m = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (m) {
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(color.trim());
  if (rgb) {
    const parts = rgb[1].split(',').map((x) => x.trim());
    return `rgba(${parts[0]},${parts[1]},${parts[2]},${a})`;
  }
  return `rgba(255,255,255,${a})`;
}
