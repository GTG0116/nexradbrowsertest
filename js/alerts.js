// alerts.js — live NWS watches/warnings layer.
//
// Pulls the active alert feed from the public api.weather.gov endpoint, draws
// alert polygons over the map, and (because the request asked
// for "only the alerts in the screenshot") shows only those alerts, plus tsunami
// alerts, when their polygon
// actually intersects the current map view in both the side list and on the
// map. When the alert feed omits inline geometry (common for county/zone-based
// and tsunami products), we resolve the affected NWS zones and merge their
// geometries so those alerts still appear on the map. Clicking an alert opens a
// compact preview card summarising it, with a button to open the full-screen
// briefing panel.
//
// Two flavours of "upgrade" are applied on top of the raw NWS event name:
//   • Impact-Based Warning damage tags — a Tornado Warning tagged CONSIDERABLE
//     becomes a PDS Tornado Warning (pink); tagged CATASTROPHIC it becomes a
//     Tornado Emergency (purple). A Flash Flood Warning tagged CATASTROPHIC
//     becomes a Flash Flood Emergency (a darker, distinct green); a CONSIDERABLE
//     tag stays a normal Flash Flood Warning. Severe Thunderstorm damage
//     threats are noted as tags too.
//   • Free-text scan — watches (and anything else) whose text contains
//     "PARTICULARLY DANGEROUS SITUATION" / "EXTREMELY DANGEROUS SITUATION" are
//     relabelled "PDS <event>" / "EDS <event>" even when no structured tag is
//     present, since the SPC encodes PDS watches only in prose.

const ACTIVE_URL =
  'https://api.weather.gov/alerts/active?status=actual&message_type=alert,update';
const REFRESH_MS = 120000;
const zoneGeometryCache = new Map();

// Colors keyed to the alert types in the legend screenshot. Special "upgrade"
// states (PDS / Emergency) override these.
const PDS_PINK = '#ff3fc8';
const EMERGENCY_PURPLE = '#b02cff';
// A Flash Flood Emergency stays "green" to read as a flood alert, but uses a
// deep, saturated green that is clearly distinct from the bright Flash Flood
// Warning green (#2ecc40) so the most severe flood alert stands out.
const FLASH_FLOOD_EMERGENCY_GREEN = '#0a6e2a';

const EVENT_COLORS = {
  'Tornado Warning': '#e0152d',
  'Tornado Watch': '#9d6fc9',
  'Severe Thunderstorm Warning': '#ffa500',
  'Severe Thunderstorm Watch': '#f5e000',
  'Flash Flood Warning': '#2ecc40',
  'Flash Flood Watch': '#4caf7d',
  'Flood Warning': '#2e8b57',
  'Flood Watch': '#3cb371',
  'Flood Advisory': '#5fae7a',
  'Winter Storm Watch': '#4d9be6',
  'Winter Storm Warning': '#d46aa0',
  'Blizzard Warning': '#f4631e',
  'Ice Storm Warning': '#8b4789',
  'Snow Squall Warning': '#a98cd0',
  'Winter Weather Advisory': '#7a8fd0',
  'Storm Surge Warning': '#9b30c0',
  'Storm Surge Watch': '#b98ad9',
  'Tropical Storm Warning': '#d9344a',
  'Tropical Storm Watch': '#e69b8f',
  'Hurricane Warning': '#e01530',
  'Hurricane Watch': '#e040b0',
  'Typhoon Warning': '#d9344a',
  'Typhoon Watch': '#ff20c0',
  'Tsunami Advisory': '#d88a73',
  'Tsunami Warning': '#ff4500',
  'Tsunami Watch': '#ff8c00',
  'Extreme Wind Warning': '#f08000',
  'Special Weather Statement': '#2bbfb0',
  'Special Marine Warning': '#ffa500',
  'Marine Weather Statement': '#3da6c0',
  'High Wind Warning': '#daa520',
  'High Wind Watch': '#b8860b',
  'Wind Advisory': '#d2b48c',
  'Dust Storm Warning': '#ffe4b5',
  'Dense Fog Advisory': '#708090',
  'Excessive Heat Warning': '#c71585',
  'Heat Advisory': '#ff7f50',
  'Red Flag Warning': '#ff1493',
  'Fire Weather Watch': '#ffdead',
  'Freeze Warning': '#483d8b',
  'Frost Advisory': '#6699cc',
};
const DEFAULT_COLOR = '#6f8aa8';

// Keep the map/list focused to the alert types shown in the app legend
// screenshot, plus tsunami products. Other NWS products remain intentionally
// hidden to avoid cluttering the radar map.
const MAP_ALERT_EVENTS = new Set([
  'Tornado Warning',
  'Tornado Watch',
  'Severe Thunderstorm Warning',
  'Severe Thunderstorm Watch',
  'Flash Flood Warning',
  'Winter Storm Watch',
  'Winter Storm Warning',
  'Blizzard Warning',
  'Snow Squall Warning',
  'Storm Surge Warning',
  'Storm Surge Watch',
  'Tropical Storm Warning',
  'Tropical Storm Watch',
  'Hurricane Warning',
  'Hurricane Watch',
  'Typhoon Warning',
  'Typhoon Watch',
  'Extreme Wind Warning',
  'Special Weather Statement',
  'Tsunami Advisory',
  'Tsunami Warning',
  'Tsunami Watch',
]);

// Rough display priority so the most significant alerts sort to the top.
const PRIORITY = [
  'Tornado Emergency',
  'PDS Tornado Warning',
  'Tornado Warning',
  'Severe Thunderstorm Warning',
  'Flash Flood Emergency',
  'PDS Flash Flood Warning',
  'Flash Flood Warning',
  'Snow Squall Warning',
  'Extreme Wind Warning',
  'Tsunami Warning',
  'Tornado Watch',
  'Severe Thunderstorm Watch',
  'Tsunami Watch',
  'Tsunami Advisory',
];

function firstParam(params, key) {
  const v = params && params[key];
  return Array.isArray(v) ? v[0] : v || null;
}

// Classify a raw NWS alert feature into a display name + color, applying the
// damage-tag and PDS/EDS text-scan upgrades described at the top of the file.
export function classifyAlert(feature) {
  const p = feature.properties || {};
  const params = p.parameters || {};
  const event = p.event || 'Alert';
  const text = `${p.headline || ''} ${p.description || ''}`.toUpperCase();

  let display = event;
  let color = EVENT_COLORS[event] || DEFAULT_COLOR;
  let upgraded = false;

  const torThreat = (firstParam(params, 'tornadoDamageThreat') || '').toUpperCase();
  if (event === 'Tornado Warning') {
    if (torThreat === 'CATASTROPHIC') {
      display = 'Tornado Emergency';
      color = EMERGENCY_PURPLE;
      upgraded = true;
    } else if (torThreat === 'CONSIDERABLE') {
      display = 'PDS Tornado Warning';
      color = PDS_PINK;
      upgraded = true;
    }
  }

  const ffwThreat = (firstParam(params, 'flashFloodDamageThreat') || '').toUpperCase();
  if (event === 'Flash Flood Warning' && ffwThreat === 'CATASTROPHIC') {
    // CONSIDERABLE stays a normal Flash Flood Warning; only CATASTROPHIC is
    // upgraded to a Flash Flood Emergency.
    display = 'Flash Flood Emergency';
    color = FLASH_FLOOD_EMERGENCY_GREEN;
    upgraded = true;
  }

  // Text scan for PDS/EDS phrasing (mainly watches, where there is no tag).
  if (!upgraded) {
    if (text.includes('EXTREMELY DANGEROUS SITUATION')) {
      display = `EDS ${event}`;
      color = EMERGENCY_PURPLE;
    } else if (text.includes('PARTICULARLY DANGEROUS SITUATION')) {
      display = `PDS ${event}`;
      color = PDS_PINK;
    }
  }

  return { event, display, color };
}

function priorityOf(display) {
  const i = PRIORITY.indexOf(display);
  return i === -1 ? PRIORITY.length + 1 : i;
}

// Geographic bounds [minLat, minLon, maxLat, maxLon] of a GeoJSON geometry.
function geomBounds(geom) {
  if (!geom) return null;
  let minLat = 90,
    minLon = 180,
    maxLat = -90,
    maxLon = -180;
  const walk = (coords) => {
    if (typeof coords[0] === 'number') {
      const lon = coords[0],
        lat = coords[1];
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
    } else {
      for (const c of coords) walk(c);
    }
  };
  if (!geom.coordinates) return null;
  walk(geom.coordinates);
  return [minLat, minLon, maxLat, maxLon];
}

const fmtTime = (iso) => {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString([], {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
};

// Wall-clock time only (e.g. "9:00 PM"), for the compact preview card.
const fmtClock = (iso) => {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch {
    return iso;
  }
};

// Human countdown to an expiry instant: "44m", "2h 5m", or "expired".
function untilText(iso) {
  if (!iso) return '';
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms)) return '';
  if (ms <= 0) return 'expired';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function degToCompass(deg) {
  const dirs = [
    'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
    'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW',
  ];
  return dirs[Math.round(deg / 22.5) % 16];
}

// "...260DEG...30KT" → "MOVING NORTHEAST AT 35 MPH".
function parseMotion(desc) {
  if (!desc) return null;
  const deg = /(\d{1,3})DEG/.exec(desc);
  const kt = /(\d{1,3})KT/.exec(desc);
  if (!deg || !kt) return null;
  const heading = (parseInt(deg[1], 10) + 180) % 360; // storms reported FROM
  const mph = Math.round(parseInt(kt[1], 10) * 1.151);
  const long = {
    N: 'NORTH', NNE: 'NORTH-NORTHEAST', NE: 'NORTHEAST', ENE: 'EAST-NORTHEAST',
    E: 'EAST', ESE: 'EAST-SOUTHEAST', SE: 'SOUTHEAST', SSE: 'SOUTH-SOUTHEAST',
    S: 'SOUTH', SSW: 'SOUTH-SOUTHWEST', SW: 'SOUTHWEST', WSW: 'WEST-SOUTHWEST',
    W: 'WEST', WNW: 'WEST-NORTHWEST', NW: 'NORTHWEST', NNW: 'NORTH-NORTHWEST',
  };
  return `MOVING ${long[degToCompass(heading)]} AT ${mph} MPH`;
}

const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'
  );

// Tag chips rendered at the bottom of each alert section. These come from the
// structured IBW `parameters`, deliberately separate from the free alert text.
const TAG_KEYS = [
  ['tornadoDetection', 'TORNADO'],
  ['tornadoDamageThreat', 'TORNADO DAMAGE THREAT'],
  ['waterspoutDetection', 'WATERSPOUT'],
  ['maxHailSize', 'MAX HAIL'],
  ['hailThreat', 'HAIL THREAT'],
  ['maxWindGust', 'MAX WIND GUST'],
  ['windThreat', 'WIND THREAT'],
  ['thunderstormDamageThreat', 'THUNDERSTORM DAMAGE THREAT'],
  ['flashFloodDamageThreat', 'FLASH FLOOD DAMAGE THREAT'],
  ['flashFloodDetection', 'FLASH FLOOD'],
  ['snowSquallImpact', 'SNOW SQUALL IMPACT'],
];

function tagChips(params) {
  const chips = [];
  for (const [key, label] of TAG_KEYS) {
    let val = firstParam(params, key);
    if (!val) continue;
    if (key === 'maxHailSize' && !/in/i.test(val)) val = `${val} IN`;
    const strong = /CONSIDERABLE|CATASTROPHIC|DESTRUCTIVE|OBSERVED/i.test(val);
    chips.push(
      `<span class="alert-tag${strong ? ' strong' : ''}">${esc(label)}: ${esc(
        String(val).toUpperCase()
      )}</span>`
    );
  }
  return chips.join('');
}

// Plain-language "what this means / what to do" guidance for the common
// storm-scale alerts, shown above the official NWS instruction text. Keyed by
// the classified display name first (so a Tornado Emergency gets its own,
// stronger wording) and the raw event name second.
const GUIDANCE = {
  'Tornado Emergency': {
    lead: 'A confirmed, large and destructive tornado is on the ground. This is the most urgent tornado alert the NWS issues — a life-threatening situation is happening now.',
    points: [
      'Go to a basement or storm shelter immediately. If you have none, get to a small interior room on the lowest floor — a bathroom or closet — away from all windows.',
      'Cover your head and neck with your arms and put as much as you can between you and the storm (mattress, blankets, helmet).',
      'Do NOT try to outrun it in a vehicle. Abandon mobile homes and vehicles for a sturdy building.',
      'If caught outside with no shelter, lie flat in the lowest spot you can find and shield your head.',
    ],
  },
  'PDS Tornado Warning': {
    lead: 'A particularly dangerous situation: a strong tornado is likely or confirmed. Treat this as a life-threatening emergency.',
    points: [
      'Shelter now in a basement or an interior room on the lowest floor, away from windows.',
      'Protect your head and neck; get under something sturdy if you can.',
      'Leave mobile homes and vehicles for a substantial building immediately.',
    ],
  },
  'Tornado Warning': {
    lead: 'A tornado is indicated by radar or has been spotted. Take cover right now — do not wait to see it.',
    points: [
      'Move to a basement or an interior room on the lowest floor (bathroom, closet, hallway), away from windows.',
      'Cover your head and neck and crouch low.',
      'Mobile homes offer no protection — go to a sturdy building.',
      'If driving, do not shelter under an overpass; seek a strong building instead.',
    ],
  },
  'Severe Thunderstorm Warning': {
    lead: 'A storm capable of damaging winds (58+ mph) and/or large hail is occurring. These storms can also spin up brief tornadoes.',
    points: [
      'Move indoors and stay away from windows.',
      'Bring in or secure loose outdoor objects that can become projectiles.',
      'Avoid using corded electronics and plumbing during frequent lightning.',
      'If a tornado warning follows, go to your safe room immediately.',
    ],
  },
  'Flash Flood Emergency': {
    lead: 'The most urgent flood alert the NWS issues — catastrophic, life-threatening flash flooding is happening now and severe damage is occurring or imminent.',
    points: [
      'Move to higher ground immediately. Do not wait — water can rise feet in minutes.',
      'Never walk or drive into flood waters. Turn Around, Don’t Drown.',
      'If you are in a low-lying area or near a creek, river, or dam, evacuate now along your highest route.',
      'If water is entering your home, move to the highest level; only go onto the roof if rising water forces you, and signal for help.',
      'If water is rising around your vehicle, abandon it and reach higher ground only if you can do so safely.',
    ],
  },
  'PDS Flash Flood Warning': {
    lead: 'A particularly dangerous situation: severe, fast-rising flash flooding is occurring or imminent. Treat this as a life-threatening emergency.',
    points: [
      'Move to higher ground now. Never walk or drive into flood waters.',
      'Turn Around, Don’t Drown — 6 inches of moving water can knock you down; 12 inches can sweep away most cars.',
      'Avoid low-water crossings, underpasses, and creek beds.',
      'If water is rising around your vehicle, abandon it and move to higher ground if you can do so safely.',
    ],
  },
  'Flash Flood Warning': {
    lead: 'Flooding is imminent or already happening. Flash floods rise fast and are the leading cause of storm deaths.',
    points: [
      'Move to higher ground now. Never walk or drive into flood waters.',
      'Turn Around, Don’t Drown — 6 inches of moving water can knock you down; 12 inches can sweep away most cars.',
      'Avoid low-water crossings, underpasses, and creek beds.',
      'If water is rising around your vehicle, abandon it and move to higher ground if you can do so safely.',
    ],
  },
  'Tornado Watch': {
    lead: 'Conditions are favorable for tornadoes in and near the watch area. No tornado yet — this is your time to prepare.',
    points: [
      'Review where your safe room is and have a way to receive warnings (NOAA radio, phone alerts).',
      'Keep shoes, a flashlight, and helmets handy; charge your phone.',
      'Stay alert and be ready to act quickly if a warning is issued.',
    ],
  },
  'Severe Thunderstorm Watch': {
    lead: 'Conditions are favorable for severe thunderstorms with damaging wind and large hail.',
    points: [
      'Secure loose outdoor items and park vehicles under cover if possible.',
      'Stay weather-aware and ready to move indoors quickly.',
    ],
  },
  'Flash Flood Watch': {
    lead: 'Conditions may lead to flash flooding. Flooding is not occurring yet, but be prepared.',
    points: [
      'Know your evacuation route to higher ground.',
      'Avoid camping or parking along streams and washes.',
      'Be ready to act if a warning is issued.',
    ],
  },
  'Snow Squall Warning': {
    lead: 'A brief, intense burst of heavy snow and wind is causing sudden whiteout conditions and dangerous travel.',
    points: [
      'Avoid or delay travel until the squall passes (usually under an hour).',
      'If already driving, reduce speed, turn on headlights, and leave extra distance — sudden whiteouts cause chain-reaction crashes.',
    ],
  },
  'Winter Storm Warning': {
    lead: 'Heavy snow, ice, or a combination is expected and will make travel dangerous.',
    points: [
      'Avoid travel if you can; if you must go, carry a winter emergency kit.',
      'Keep extra food, water, and a heat source on hand in case of power loss.',
    ],
  },
  'Blizzard Warning': {
    lead: 'Heavy snow with strong winds will produce whiteout conditions and life-threatening travel.',
    points: [
      'Do not travel. If stranded in a vehicle, stay inside and run the engine sparingly for heat with a window cracked.',
      'Keep blankets, food, water, and a charged phone within reach.',
    ],
  },
  'Ice Storm Warning': {
    lead: 'Significant ice accumulation is expected, which can down trees and power lines and make any travel treacherous.',
    points: [
      'Avoid travel — even a thin glaze makes roads and walkways extremely slick.',
      'Prepare for extended power outages with alternate heat and light.',
    ],
  },
  'Extreme Wind Warning': {
    lead: 'Extreme sustained winds (115+ mph), typically from a major hurricane’s eyewall, are imminent.',
    points: [
      'Treat this like a tornado warning: move to an interior room on the lowest floor, away from windows, now.',
    ],
  },
  'Tsunami Warning': {
    lead: 'A tsunami with dangerous coastal flooding and powerful currents is expected or occurring. Move inland and to higher ground immediately.',
    points: [
      'Leave beaches, harbors, marinas, and low-lying coastal areas now.',
      'Follow evacuation routes and instructions from local officials.',
      'Do not return to the coast until officials say it is safe; dangerous surges can continue for hours.',
    ],
  },
  'Tsunami Watch': {
    lead: 'A distant or possible tsunami may affect the coast. Be ready to evacuate if a warning or local officials tell you to move.',
    points: [
      'Review your route to higher ground or inland shelter.',
      'Stay away from beaches and harbors while monitoring official updates.',
      'Keep your phone charged and be prepared to leave quickly.',
    ],
  },
  'Tsunami Advisory': {
    lead: 'Strong currents or waves dangerous to people in or near the water are expected or occurring.',
    points: [
      'Stay out of the ocean, bays, harbors, and marinas.',
      'Move away from beaches, jetties, and low-lying shorelines.',
      'Follow local official instructions and wait for the advisory to be cancelled.',
    ],
  },
  'High Wind Warning': {
    lead: 'Sustained high winds or strong gusts are expected that can down limbs and power lines.',
    points: [
      'Secure loose outdoor objects and avoid being under trees.',
      'Use extra caution driving high-profile vehicles.',
    ],
  },
};

// Fallback guidance for any watch / warning we don't have specific text for.
function genericGuidance(display) {
  if (/Warning/i.test(display)) {
    return {
      lead: 'A hazardous condition is occurring or imminent. Take protective action now.',
      points: ['Follow the official instructions below and stay tuned for updates.'],
    };
  }
  if (/Watch/i.test(display)) {
    return {
      lead: 'Conditions are favorable for hazardous weather. Stay prepared and monitor for warnings.',
      points: ['Review your safety plan and keep a way to receive alerts close by.'],
    };
  }
  return null;
}

function guidanceFor(cls) {
  return GUIDANCE[cls.display] || GUIDANCE[cls.event] || genericGuidance(cls.display);
}

export class AlertsController {
  constructor(map, els) {
    this.map = map;
    this.els = els; // { listPanel, list, detail, detailPanel, close }
    this.alerts = []; // [{ id, feature, cls, bounds }]
    this.enabled = true;
    this.selectedId = null;

    // Extra maps that mirror the alert polygons (e.g. the split-view second
    // pane). Each must already carry an `alerts` GeoJSON source + fill/line
    // layers; we just keep their source data in lock-step with the main map.
    this.mirrors = [];
    this._lastFeatures = [];

    // The polygons are drawn by the GL `alerts-fill` (below radar) and
    // `alerts-line` (above radar) layers that app.js inserts into the basemap
    // stack; this controller just feeds the `alerts` source the features in
    // view and opens the briefing when one is clicked.
    // A click can land on several overlapping alert polygons at once (e.g. a
    // Tornado Warning inside a Tornado Watch inside a Flash Flood Warning). Pass
    // every feature under the cursor so the briefing can offer arrows to cycle
    // through all the alerts active at that one location.
    const openFromEvent = (e) => {
      // If a radar-site dot sits on top of this alert polygon, the dot owns the
      // tap — selecting that radar — so don't also pop an alert briefing. (The
      // 'sites' layer only exists in radar mode; guard the query accordingly.)
      if (map.getLayer && map.getLayer('sites')) {
        const onSite = map.queryRenderedFeatures(e.point, { layers: ['sites'] });
        if (onSite && onSite.length) return;
      }
      const feats = e.features || [];
      if (!feats.length) return;
      const ids = feats.map((f) => f.properties.id);
      this.openPreview(ids[0], ids);
    };
    map.on('click', 'alerts-fill', openFromEvent);
    map.on('click', 'alerts-line', openFromEvent);

    // Debounce so a pan/zoom doesn't rebuild the feature set mid-gesture.
    this._refreshTimer = null;
    map.on('moveend', () => {
      clearTimeout(this._refreshTimer);
      this._refreshTimer = setTimeout(() => this.refreshVisible(), 120);
    });
    els.close.addEventListener('click', () => this.closeDetail());
    // Dismiss the preview by clicking its dim backdrop (outside the card).
    if (els.preview) {
      els.preview.addEventListener('click', (e) => {
        if (e.target === els.preview) this.closePreview();
      });
    }
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!this.els.preview || this.els.preview.hidden) return this.closeDetail();
        return this.closePreview();
      }
      // Left/right arrows cycle through the alerts stacked at this location, in
      // whichever view is open (preview card or full briefing).
      if (this.els.preview && !this.els.preview.hidden) {
        if (e.key === 'ArrowLeft') this.cyclePreview(-1);
        else if (e.key === 'ArrowRight') this.cyclePreview(1);
        return;
      }
      if (this.els.detail.hidden) return;
      if (e.key === 'ArrowLeft') this.cycle(-1);
      else if (e.key === 'ArrowRight') this.cycle(1);
    });

    // The alerts currently stacked at the opened location, and which one of
    // them the briefing is showing.
    this.group = [];
    this.groupIndex = 0;
  }

  // Push a GeoJSON FeatureCollection to the `alerts` source on the main map and
  // every registered mirror (no-op for any map whose style/layers don't exist
  // yet). Remembers the last set so a mirror registered later can be primed.
  _setSourceData(features) {
    this._lastFeatures = features;
    const apply = (map) => {
      const src = map && map.getSource && map.getSource('alerts');
      if (src) src.setData({ type: 'FeatureCollection', features });
    };
    apply(this.map);
    for (const m of this.mirrors) apply(m);
  }

  // Register a second map that should show the same alert polygons, and prime it
  // with the current features. Safe to call again after the mirror's style is
  // reloaded (e.g. a basemap switch rebuilds its empty `alerts` source) — it
  // re-pushes the latest features without duplicating the registration.
  addMirror(map) {
    if (!map) return;
    if (!this.mirrors.includes(map)) this.mirrors.push(map);
    const src = map.getSource && map.getSource('alerts');
    if (src) src.setData({ type: 'FeatureCollection', features: this._lastFeatures });
  }

  removeMirror(map) {
    const i = this.mirrors.indexOf(map);
    if (i >= 0) this.mirrors.splice(i, 1);
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) {
      this._setSourceData([]);
      this.els.list.innerHTML = '<div class="empty">Alerts hidden.</div>';
      this.closePreview();
      this.closeDetail();
    } else {
      this.refreshVisible();
      if (!this.alerts.length) this.load();
    }
  }

  async load() {
    try {
      const features = await fetchActiveAlerts();
      this.alerts = features
        .filter((f) => f.geometry) // inline polygons plus resolved county/zone geometries
        .map((f) => ({
          id: f.properties.id || f.id,
          feature: f,
          cls: classifyAlert(f),
          bounds: geomBounds(f.geometry),
        }))
        .filter((a) => a.bounds);
      this.refreshVisible();
    } catch (e) {
      console.error('alerts load failed', e);
      this.els.list.innerHTML = `<div class="empty">Alerts unavailable (${esc(
        e.message
      )}).</div>`;
    }
  }

  start() {
    this.load();
    this.timer = setInterval(() => this.enabled && this.load(), REFRESH_MS);
  }

  visibleAlerts() {
    if (!this.map.getBounds) return [];
    const b = this.map.getBounds();
    const w = b.getWest(),
      s = b.getSouth(),
      e = b.getEast(),
      n = b.getNorth();
    return this.alerts
      .filter((a) => {
        // a.bounds = [minLat, minLon, maxLat, maxLon]; reject when the alert's
        // bbox is entirely outside the current view.
        const [minLat, minLon, maxLat, maxLon] = a.bounds;
        return !(maxLon < w || minLon > e || maxLat < s || minLat > n);
      })
      .sort(
        (x, y) =>
          priorityOf(x.cls.display) - priorityOf(y.cls.display) ||
          x.cls.display.localeCompare(y.cls.display)
      );
  }

  refreshVisible() {
    if (!this.enabled) return;
    const visible = this.visibleAlerts();
    // Feed the GL source one feature per visible alert, carrying its colour and
    // id so the fill/line layers can style and the click handler can identify
    // it. Most-significant alerts are pushed last so they render on top.
    const features = [...visible].reverse().map((a) => ({
      type: 'Feature',
      geometry: a.feature.geometry,
      properties: { id: a.id, color: a.cls.color, display: a.cls.display },
    }));
    this._setSourceData(features);
    this.renderList(visible);
  }

  renderList(visible) {
    const list = this.els.list;
    if (!visible.length) {
      list.innerHTML = '<div class="empty">No active alerts in view.</div>';
      return;
    }
    list.innerHTML = '';
    for (const a of visible) {
      const row = document.createElement('button');
      row.className = 'alert-row';
      row.style.setProperty('--ac', a.cls.color);
      row.innerHTML = `<span class="alert-row-dot"></span><span class="alert-row-name">${esc(
        a.cls.display
      )}</span><span class="alert-row-area">${esc(
        (a.feature.properties.areaDesc || '').split(';')[0]
      )}</span>`;
      row.addEventListener('click', () => this.openPreview(a.id));
      list.appendChild(row);
    }
  }

  // Resolve a click into the ordered group of alert ids stacked there. Keeps
  // only ids we still hold, drops duplicates, and puts the most significant
  // alert first (so cycling reads top-down by severity). Sets group state and
  // returns nothing — callers then render.
  _setGroup(id, group) {
    let ids = (group && group.length ? group : [id]).filter(
      (gid, i, arr) => arr.indexOf(gid) === i && this.alerts.some((a) => a.id === gid)
    );
    if (!ids.includes(id)) ids.unshift(id);
    ids.sort((x, y) => {
      const ax = this.alerts.find((a) => a.id === x);
      const ay = this.alerts.find((a) => a.id === y);
      return priorityOf(ax.cls.display) - priorityOf(ay.cls.display);
    });
    this.group = ids;
    this.groupIndex = Math.max(0, ids.indexOf(id));
    this.selectedId = ids[this.groupIndex];
  }

  // Show the compact preview card first. `group` (optional) is the list of
  // alert ids found under the same click, so the card can step through every
  // alert active at that location; `id` is the one to show first.
  openPreview(id, group) {
    if (!this.els.preview) return this.openDetail(id, group);
    this._setGroup(id, group);
    if (!this.selectedId) return;
    this.els.preview.hidden = false;
    // Hide the bottom dock/playback UI while the card is up (mobile) so the card
    // can sit low without colliding with it.
    document.querySelector('.app').classList.add('alert-preview-open');
    this.renderPreview();
  }

  // Step the preview card to another alert stacked here (delta = ±1, wraps).
  cyclePreview(delta) {
    if (!this.group || this.group.length < 2) return;
    this.groupIndex = (this.groupIndex + delta + this.group.length) % this.group.length;
    this.selectedId = this.group[this.groupIndex];
    this.renderPreview();
  }

  closePreview() {
    document.querySelector('.app').classList.remove('alert-preview-open');
    if (!this.els.preview || this.els.preview.hidden) return;
    this.els.preview.hidden = true;
  }

  // Snapshot of the open compact preview card for the export tool: the
  // classified alert plus the same summary rows the card shows. Returns null
  // when no preview is open. The "View full briefing" footer is deliberately
  // left out — the export shows the first popup, not the expanded briefing.
  exportPreview() {
    if (!this.els.preview || this.els.preview.hidden) return null;
    const a = this.alerts.find((x) => x.id === this.selectedId);
    if (!a) return null;
    const p = a.feature.properties;
    const params = p.parameters || {};
    const expiry = p.ends || p.expires;
    const until = untilText(expiry);
    const rows = [['Expires', `${fmtClock(expiry)}${until ? ` (${until})` : ''}`]];
    const tor = firstParam(params, 'tornadoDetection');
    const torThreat = firstParam(params, 'tornadoDamageThreat');
    const hail = firstParam(params, 'maxHailSize');
    const wind = firstParam(params, 'maxWindGust');
    if (tor) {
      const t = String(tor).replace(/\b\w/g, (m) => m.toUpperCase());
      rows.push(['Tornado', `${t}${torThreat ? ` · ${String(torThreat).toUpperCase()}` : ''}`]);
    }
    if (hail) rows.push(['Hail', `${hail}${/in/i.test(hail) ? '' : ' in'}`]);
    if (wind) rows.push(['Wind', String(wind)]);
    return {
      color: a.cls.color,
      title: a.cls.display,
      area: (p.areaDesc || '').split(';')[0],
      rows,
    };
  }

  // Structured snapshot of the open full briefing for the export tool, so the
  // exported image can reproduce the whole alert detail view as it appears on
  // screen. Returns null when the full briefing isn't open.
  exportDetail() {
    if (!this.els.detail || this.els.detail.hidden) return null;
    const a = this.alerts.find((x) => x.id === this.selectedId);
    if (!a) return null;
    const p = a.feature.properties;
    const params = p.parameters || {};

    const hail = firstParam(params, 'maxHailSize');
    const wind = firstParam(params, 'maxWindGust');
    const tor = firstParam(params, 'tornadoDetection');
    const hazards = [];
    if (hail) hazards.push(['HAIL', `${hail}${/in/i.test(hail) ? '' : ' in'}`]);
    if (wind) hazards.push(['WIND', String(wind)]);
    if (tor) hazards.push(['TORNADO', String(tor).toUpperCase()]);

    const motion = parseMotion(firstParam(params, 'eventMotionDescription'));
    const g = guidanceFor(a.cls);

    const tags = [];
    for (const [key, label] of TAG_KEYS) {
      let val = firstParam(params, key);
      if (!val) continue;
      if (key === 'maxHailSize' && !/in/i.test(val)) val = `${val} IN`;
      tags.push(`${label}: ${String(val).toUpperCase()}`);
    }

    const group =
      this.group && this.group.length > 1
        ? { index: this.groupIndex + 1, total: this.group.length }
        : null;

    return {
      color: a.cls.color,
      title: a.cls.display,
      expires: fmtTime(p.ends || p.expires),
      hazards,
      motion,
      guidance: g ? { lead: g.lead, points: g.points || [] } : null,
      issued: `Issued ${fmtTime(p.sent)} · ${p.senderName || 'NWS'}`,
      location: p.areaDesc || '—',
      instruction: p.instruction || '',
      description: p.description || '',
      tags,
      group,
    };
  }

  renderPreview() {
    const a = this.alerts.find((x) => x.id === this.selectedId);
    if (!a) {
      this.closePreview();
      return;
    }
    const p = a.feature.properties;
    const params = p.parameters || {};
    const expiry = p.ends || p.expires;
    const until = untilText(expiry);
    const tor = firstParam(params, 'tornadoDetection');
    const torThreat = firstParam(params, 'tornadoDamageThreat');
    const hail = firstParam(params, 'maxHailSize');
    const wind = firstParam(params, 'maxWindGust');

    const rows = [
      `<div class="apv-row"><span>Expires</span><b>${esc(fmtClock(expiry))}${
        until ? ` <i>(${esc(until)})</i>` : ''
      }</b></div>`,
    ];
    if (tor) {
      const t = String(tor).replace(/\b\w/g, (m) => m.toUpperCase());
      rows.push(
        `<div class="apv-row"><span>Tornado</span><b>${esc(t)}${
          torThreat ? ` · ${esc(String(torThreat).toUpperCase())}` : ''
        }</b></div>`
      );
    }
    if (hail) {
      rows.push(
        `<div class="apv-row"><span>Hail</span><b>${esc(hail)}${
          /in/i.test(hail) ? '' : ' in'
        }</b></div>`
      );
    }
    if (wind) rows.push(`<div class="apv-row"><span>Wind</span><b>${esc(wind)}</b></div>`);

    const multi = this.group && this.group.length > 1;
    const dots = multi
      ? `<div class="apv-dots">${this.group
          .map((_, i) => `<span class="apv-dot${i === this.groupIndex ? ' on' : ''}"></span>`)
          .join('')}</div>`
      : '';
    const nav = multi
      ? `<div class="apv-nav">
           <button class="apv-nav-btn" data-dir="-1" aria-label="Previous alert">‹</button>
           <button class="apv-nav-btn" data-dir="1" aria-label="Next alert">›</button>
         </div>`
      : '';

    this.els.previewCard.innerHTML = `
      <header class="apv-head" style="--ac:${a.cls.color}">
        <span class="apv-icon">⚠</span>
        <div class="apv-htext">
          <h3>${esc(a.cls.display)}</h3>
          <span class="apv-area">${esc((p.areaDesc || '').split(';')[0])}</span>
        </div>
        <button class="apv-close" aria-label="Close">✕</button>
      </header>
      <div class="apv-body">${rows.join('')}${dots}</div>
      <footer class="apv-foot">
        ${nav}
        <button class="apv-details">View full briefing →</button>
      </footer>`;

    this.els.previewCard
      .querySelector('.apv-close')
      .addEventListener('click', () => this.closePreview());
    this.els.previewCard
      .querySelector('.apv-details')
      .addEventListener('click', () => this.openDetail(this.selectedId, this.group));
    this.els.previewCard
      .querySelectorAll('.apv-nav-btn')
      .forEach((b) => b.addEventListener('click', () => this.cyclePreview(Number(b.dataset.dir))));
  }

  // Open the full briefing. `group` (optional) is the list of alert ids found
  // under the same click; `id` is the one to show first.
  openDetail(id, group) {
    this.closePreview();
    this._setGroup(id, group);

    document.querySelector('.app').classList.add('alert-mode');
    this.els.detail.hidden = false;
    this.renderDetail();
    this._fitTo(this.selectedId);
    setTimeout(() => this.map.resize(), 60);
  }

  // Step the briefing to another alert at the same location (delta = ±1, wraps).
  cycle(delta) {
    if (!this.group || this.group.length < 2) return;
    this.groupIndex = (this.groupIndex + delta + this.group.length) % this.group.length;
    this.selectedId = this.group[this.groupIndex];
    this.renderDetail();
  }

  // Zoom the map to an alert. bounds = [minLat, minLon, maxLat, maxLon];
  // Mapbox fitBounds wants [[w,s],[e,n]] in [lng,lat] order.
  _fitTo(id) {
    const sel = this.alerts.find((a) => a.id === id);
    if (!sel) return;
    const [minLat, minLon, maxLat, maxLon] = sel.bounds;
    this.map.fitBounds(
      [
        [minLon, minLat],
        [maxLon, maxLat],
      ],
      { padding: 80, maxZoom: 11 }
    );
  }

  closeDetail() {
    if (this.els.detail.hidden) return;
    this.selectedId = null;
    this.group = [];
    this.groupIndex = 0;
    this.els.detail.hidden = true;
    document.querySelector('.app').classList.remove('alert-mode');
    setTimeout(() => this.map.resize(), 60);
  }

  renderDetail() {
    // The briefing shows the currently selected alert. When several alerts are
    // stacked at this location, a nav bar at the top cycles through them.
    const sel = this.alerts.find((a) => a.id === this.selectedId);
    if (!sel) {
      this.els.detailPanel.innerHTML = '';
      return;
    }
    const multi = this.group && this.group.length > 1;
    const nav = multi
      ? `<div class="alert-nav">
           <button class="alert-nav-btn" data-dir="-1" aria-label="Previous alert">‹</button>
           <span class="alert-nav-count">${this.groupIndex + 1} / ${
          this.group.length
        } alerts here</span>
           <button class="alert-nav-btn" data-dir="1" aria-label="Next alert">›</button>
         </div>`
      : '';
    this.els.detailPanel.innerHTML = nav + this.sectionHTML(sel, true);
    this.els.detailPanel.scrollTop = 0;
    if (multi) {
      this.els.detailPanel
        .querySelectorAll('.alert-nav-btn')
        .forEach((b) =>
          b.addEventListener('click', () => this.cycle(Number(b.dataset.dir)))
        );
    }
  }

  sectionHTML(a, selected) {
    const p = a.feature.properties;
    const params = p.parameters || {};
    const c = a.cls.color;

    const hail = firstParam(params, 'maxHailSize');
    const wind = firstParam(params, 'maxWindGust');
    const tor = firstParam(params, 'tornadoDetection');
    const boxes = [];
    if (hail) boxes.push(`<div class="hz"><span>HAIL</span><b>${esc(hail)}${/in/i.test(hail) ? '' : ' in'}</b></div>`);
    if (wind) boxes.push(`<div class="hz"><span>WIND</span><b>${esc(wind)}</b></div>`);
    if (tor) boxes.push(`<div class="hz"><span>TORNADO</span><b>${esc(String(tor).toUpperCase())}</b></div>`);

    const motion = parseMotion(firstParam(params, 'eventMotionDescription'));
    const tags = tagChips(params);

    const g = guidanceFor(a.cls);
    const guidanceHTML = g
      ? `<div class="alert-guidance">
           <span class="alert-title">SAFETY GUIDANCE</span>
           <p class="alert-guidance-lead">${esc(g.lead)}</p>
           ${
             g.points && g.points.length
               ? `<ul class="alert-guidance-list">${g.points
                   .map((pt) => `<li>${esc(pt)}</li>`)
                   .join('')}</ul>`
               : ''
           }
         </div>`
      : '';

    return `
      <section class="alert-sec${selected ? ' selected' : ''}" data-id="${esc(a.id)}">
        <header class="alert-sec-head" style="--ac:${c}">
          <span class="alert-sec-icon">⚠</span>
          <h3>${esc(a.cls.display)}</h3>
        </header>
        <div class="alert-sec-body">
          <div class="alert-expires">
            <span class="alert-title">EXPIRES</span>
            <b>${esc(fmtTime(p.ends || p.expires))}</b>
          </div>
          ${boxes.length ? `<div class="alert-hazards">${boxes.join('')}</div>` : ''}
          ${motion ? `<div class="alert-motion">${esc(motion)}</div>` : ''}
          ${guidanceHTML}
          <div class="alert-issued">Issued ${esc(fmtTime(p.sent))} · ${esc(
      p.senderName || 'NWS'
    )}</div>
          <div class="alert-loc"><span class="alert-title">LOCATION</span><p>${esc(
            p.areaDesc || '—'
          )}</p></div>
          ${
            p.instruction
              ? `<div class="alert-block"><span class="alert-title">WHAT TO DO</span><p>${esc(
                  p.instruction
                ).replace(/\n+/g, '</p><p>')}</p></div>`
              : ''
          }
          <div class="alert-block"><span class="alert-title">FULL ALERT TEXT</span><p>${esc(
            p.description || ''
          ).replace(/\n+/g, '</p><p>')}</p></div>
          ${
            tags
              ? `<div class="alert-tags"><span class="alert-title">TAGS</span><div class="alert-tag-row">${tags}</div></div>`
              : ''
          }
        </div>
      </section>`;
  }
}

async function fetchActiveAlerts() {
  const features = [];
  let url = ACTIVE_URL;
  for (let page = 0; page < 8 && url; page++) {
    const res = await fetch(url, { headers: { Accept: 'application/geo+json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.features) features.push(...json.features);
    url = json.pagination && json.pagination.next;
    if (features.length > 4000) break;
  }
  const mapAlerts = features.filter(isMapAlertEvent);
  return Promise.all(mapAlerts.map(resolveAlertGeometry));
}

function isMapAlertEvent(feature) {
  const event = feature && feature.properties && feature.properties.event;
  return MAP_ALERT_EVENTS.has(event);
}

async function resolveAlertGeometry(feature) {
  if (feature.geometry) return feature;
  const zones = ((feature.properties && feature.properties.affectedZones) || []).filter(Boolean);
  if (!zones.length) return feature;

  const geoms = (await Promise.all(zones.map(fetchZoneGeometry))).filter(Boolean);
  const geometry = combinePolygonGeometries(geoms);
  if (!geometry) return feature;
  return { ...feature, geometry };
}

async function fetchZoneGeometry(url) {
  if (zoneGeometryCache.has(url)) return zoneGeometryCache.get(url);
  const promise = fetch(url, { headers: { Accept: 'application/geo+json' } })
    .then((res) => (res.ok ? res.json() : null))
    .then((json) => (json && json.geometry ? json.geometry : null))
    .catch(() => null);
  zoneGeometryCache.set(url, promise);
  return promise;
}

function combinePolygonGeometries(geoms) {
  const polygons = [];
  const add = (geom) => {
    if (!geom) return;
    if (geom.type === 'Polygon') polygons.push(geom.coordinates);
    else if (geom.type === 'MultiPolygon') polygons.push(...geom.coordinates);
    else if (geom.type === 'GeometryCollection') (geom.geometries || []).forEach(add);
  };
  geoms.forEach(add);
  if (!polygons.length) return null;
  return polygons.length === 1
    ? { type: 'Polygon', coordinates: polygons[0] }
    : { type: 'MultiPolygon', coordinates: polygons };
}
