// alerts.js — live NWS watches/warnings layer.
//
// Pulls the active alert feed from the public api.weather.gov endpoint, draws
// the storm-based polygons over the Leaflet map, and (because the request asked
// for "only the alerts in the screenshot") shows only the alerts whose polygon
// actually intersects the current map view in both the side list and on the
// map. Clicking an alert opens a full-screen briefing panel.
//
// Two flavours of "upgrade" are applied on top of the raw NWS event name:
//   • Impact-Based Warning damage tags — a Tornado Warning tagged CONSIDERABLE
//     becomes a PDS Tornado Warning (pink); tagged CATASTROPHIC it becomes a
//     Tornado Emergency (purple). Severe Thunderstorm damage threats are noted
//     as tags too.
//   • Free-text scan — watches (and anything else) whose text contains
//     "PARTICULARLY DANGEROUS SITUATION" / "EXTREMELY DANGEROUS SITUATION" are
//     relabelled "PDS <event>" / "EDS <event>" even when no structured tag is
//     present, since the SPC encodes PDS watches only in prose.

const ACTIVE_URL =
  'https://api.weather.gov/alerts/active?status=actual&message_type=alert,update';
const REFRESH_MS = 120000;

// Colors keyed to the alert types in the legend screenshot. Special "upgrade"
// states (PDS / Emergency) override these.
const PDS_PINK = '#ff3fc8';
const EMERGENCY_PURPLE = '#b02cff';

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

// Rough display priority so the most significant alerts sort to the top.
const PRIORITY = [
  'Tornado Emergency',
  'PDS Tornado Warning',
  'Tornado Warning',
  'Severe Thunderstorm Warning',
  'Flash Flood Warning',
  'Snow Squall Warning',
  'Extreme Wind Warning',
  'Tornado Watch',
  'Severe Thunderstorm Watch',
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

// Plain-language safety guidance for the common storm-scale alerts, written so
// the briefing always has actionable "what to do" advice even when the NWS
// product omits a structured instruction. Keyed by event name; the strongest
// upgrade displays (PDS / Emergency) get their own, more urgent wording.
const EVENT_GUIDANCE = {
  'Tornado Warning': [
    'Take shelter immediately — a tornado is occurring or imminent.',
    'Go to a basement or storm shelter. If none, get to a small interior room (bathroom, closet) on the lowest floor, away from windows.',
    'Cover your head and neck with your arms; use blankets, a mattress, or a helmet.',
    'Mobile homes and vehicles are unsafe — get to a sturdy building now.',
  ],
  'PDS Tornado Warning': [
    'PARTICULARLY DANGEROUS SITUATION — a strong, potentially violent tornado is on the ground. Act now.',
    'Get underground or to the most interior, lowest room of a sturdy building immediately.',
    'Protect your head and neck; put as many walls between you and the outside as possible.',
    'Do not try to outrun it in a vehicle unless you have a clear escape route at right angles to its path.',
  ],
  'Tornado Emergency': [
    'TORNADO EMERGENCY — a confirmed large, destructive tornado threatens your area. This is life-threatening.',
    'Shelter underground or in the most interior room on the lowest floor right now.',
    'Cover your head and body; a helmet and heavy blankets can save your life.',
    'If you cannot reach shelter, lie flat in a low ditch away from cars and trees and cover your head.',
  ],
  'Severe Thunderstorm Warning': [
    'Move indoors and stay away from windows — damaging winds and large hail are likely.',
    'Bring in or secure loose outdoor objects, and park vehicles under cover if possible.',
    'If driving, watch for fallen trees, power lines, and sudden loss of visibility.',
    'Stay inside until the storm passes; treat any downed power line as live.',
  ],
  'Flash Flood Warning': [
    'Move to higher ground immediately — flooding is occurring or imminent.',
    'Turn Around, Don’t Drown: never walk or drive into flood water. Just 12 inches can sweep away most vehicles.',
    'Avoid low-water crossings, creeks, drainage ditches, and underpasses.',
    'If water is rising around your vehicle, abandon it and move to higher ground on foot if safe.',
  ],
  'Tornado Watch': [
    'Conditions favor tornadoes — stay alert and be ready to act.',
    'Review where you will shelter and keep a way to receive warnings (NOAA radio, phone alerts).',
    'Move anything you would need (shoes, helmet, flashlight) to your shelter spot.',
  ],
  'Severe Thunderstorm Watch': [
    'Conditions favor severe storms with damaging wind and hail — stay weather-aware.',
    'Be ready to move indoors quickly and secure loose outdoor items.',
  ],
  'Flash Flood Watch': [
    'Flash flooding is possible — monitor rising water and be ready to move to higher ground.',
    'Avoid camping or parking along streams and washes.',
  ],
  'Extreme Wind Warning': [
    'Extreme, tornado-strength winds are imminent — shelter like you would for a tornado.',
    'Move to an interior room on the lowest floor, away from all windows, now.',
  ],
  'Winter Storm Warning': [
    'Significant winter weather is occurring or imminent — avoid unnecessary travel.',
    'If you must travel, carry an emergency kit (blankets, water, charger) and tell someone your route.',
  ],
  'Blizzard Warning': [
    'Blizzard conditions — do not travel. Whiteouts make roads deadly.',
    'If you become stranded, stay in your vehicle, run the engine sparingly, and keep the exhaust pipe clear.',
  ],
  'Special Marine Warning': [
    'Hazardous winds, waves, or waterspouts on the water — boaters seek safe harbor now.',
    'Secure loose gear and keep all aboard in life jackets until conditions improve.',
  ],
  'Hurricane Warning': [
    'Follow all evacuation orders without delay.',
    'Secure your home, gather supplies, and move to a safe interior room or designated shelter.',
  ],
  'Tropical Storm Warning': [
    'Prepare for damaging winds and flooding rain — secure property and follow local guidance.',
    'Avoid travel through flooded or wind-blown areas.',
  ],
};

const DEFAULT_GUIDANCE = [
  'Stay indoors, away from windows, and monitor local media or a NOAA Weather Radio.',
  'Be ready to act quickly if conditions worsen or the alert is upgraded.',
];

// Pick the best-matching guidance bullets for a classified alert.
function guidanceFor(cls) {
  return (
    EVENT_GUIDANCE[cls.display] ||
    EVENT_GUIDANCE[cls.event] ||
    (/Warning$/.test(cls.event) ? DEFAULT_GUIDANCE : null)
  );
}

export class AlertsController {
  constructor(map, els) {
    this.map = map;
    this.els = els; // { listPanel, list, detail, detailPanel, close }
    this.alerts = []; // [{ id, feature, cls, bounds }]
    this.layers = new Map(); // id -> { fill, border } (only the visible ones)
    this.layerGroup = L.layerGroup().addTo(map);
    this.enabled = true;
    this.selectedId = null;

    // Dedicated renderers so the fill draws in the under-radar pane and the
    // outline in the over-radar pane. With the map's shared canvas renderer the
    // `pane` option alone would be ignored, so each gets its own pane renderer.
    this.fillRenderer = L.canvas({ pane: 'alertFill' });
    this.borderRenderer = L.canvas({ pane: 'alertBorder' });

    // Debounce so a pan/zoom doesn't rebuild every polygon layer mid-gesture,
    // which is a big contributor to the map feeling laggy while moving.
    this._refreshTimer = null;
    map.on('moveend zoomend', () => {
      clearTimeout(this._refreshTimer);
      this._refreshTimer = setTimeout(() => this.refreshVisible(), 120);
    });
    els.close.addEventListener('click', () => this.closeDetail());
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.closeDetail();
    });
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) {
      this.layerGroup.clearLayers();
      this.layers.clear();
      this.els.list.innerHTML = '<div class="empty">Alerts hidden.</div>';
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
        .filter((f) => f.geometry) // storm-based polygons only
        // Hide areal/river Flood Warnings and the low-end Flood Advisory tier —
        // they clutter the map — while keeping Flash Flood Warnings, the
        // storm-scale alerts that matter next to the radar. ("Flash Flood
        // Warning" is a distinct event name, so it stays.)
        .filter((f) => {
          const ev = (f.properties && f.properties.event) || '';
          return ev !== 'Flood Warning' && ev !== 'Flood Advisory';
        })
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
    const b = this.map.getBounds();
    return this.alerts
      .filter((a) => {
        const ab = L.latLngBounds([a.bounds[0], a.bounds[1]], [a.bounds[2], a.bounds[3]]);
        return b.intersects(ab);
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
    const wantIds = new Set(visible.map((a) => a.id));

    // Drop polygons that scrolled out of view.
    for (const [id, layer] of this.layers) {
      if (!wantIds.has(id)) {
        this.layerGroup.removeLayer(layer.fill);
        this.layerGroup.removeLayer(layer.border);
        this.layers.delete(id);
      }
    }
    // Add polygons that scrolled into view. The fill and the border are drawn
    // as separate layers in separate panes so the radar can sit between them:
    // translucent fill under the radar, crisp outline over it.
    for (const a of visible) {
      if (this.layers.has(a.id)) continue;
      const fill = L.geoJSON(a.feature, {
        renderer: this.fillRenderer,
        interactive: false,
        style: () => ({
          stroke: false,
          fill: true,
          fillColor: a.cls.color,
          fillOpacity: 0.12,
        }),
      });
      const border = L.geoJSON(a.feature, {
        renderer: this.borderRenderer,
        style: () => ({
          color: a.cls.color,
          weight: 2.5,
          opacity: 0.95,
          fill: false,
        }),
      });
      border.on('click', () => this.openDetail(a.id));
      fill.addTo(this.layerGroup);
      border.addTo(this.layerGroup);
      this.layers.set(a.id, { fill, border });
    }
    this.renderList(visible);
    if (this.selectedId && !wantIds.has(this.selectedId)) {
      // keep detail open; selected alert may still be valid even if off-view
    }
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
      row.addEventListener('click', () => this.openDetail(a.id));
      list.appendChild(row);
    }
  }

  openDetail(id) {
    this.selectedId = id;
    document.querySelector('.app').classList.add('alert-mode');
    this.els.detail.hidden = false;
    this.renderDetail();
    // Zoom the map to the selected alert.
    const sel = this.alerts.find((a) => a.id === id);
    if (sel) {
      const b = L.latLngBounds([sel.bounds[0], sel.bounds[1]], [sel.bounds[2], sel.bounds[3]]);
      this.map.fitBounds(b.pad(0.6));
    }
    setTimeout(() => this.map.invalidateSize(), 60);
  }

  closeDetail() {
    if (this.els.detail.hidden) return;
    this.selectedId = null;
    this.els.detail.hidden = true;
    document.querySelector('.app').classList.remove('alert-mode');
    setTimeout(() => this.map.invalidateSize(), 60);
  }

  renderDetail() {
    // The briefing shows only the alert that was selected.
    const sel = this.alerts.find((a) => a.id === this.selectedId);
    this.els.detailPanel.innerHTML = sel ? this.sectionHTML(sel, true) : '';
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

    const guidance = guidanceFor(a.cls);
    const guidanceHTML = guidance
      ? `<div class="alert-block alert-guidance" style="--ac:${c}">
           <span class="alert-block-title">What to do</span>
           <ul>${guidance.map((g) => `<li>${esc(g)}</li>`).join('')}</ul>
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
            <span class="alert-block-title">Expires</span>
            <b>${esc(fmtTime(p.ends || p.expires))}</b>
          </div>
          ${boxes.length ? `<div class="alert-hazards">${boxes.join('')}</div>` : ''}
          ${motion ? `<div class="alert-motion">${esc(motion)}</div>` : ''}
          <div class="alert-issued">Issued ${esc(fmtTime(p.sent))} · ${esc(
      p.senderName || 'NWS'
    )}</div>
          ${guidanceHTML}
          <div class="alert-loc"><span class="alert-block-title">Location</span><p>${esc(
            p.areaDesc || '—'
          )}</p></div>
          ${
            p.instruction
              ? `<div class="alert-block"><span class="alert-block-title">NWS instructions</span><p>${esc(
                  p.instruction
                ).replace(/\n+/g, '</p><p>')}</p></div>`
              : ''
          }
          <div class="alert-block"><span class="alert-block-title">Full alert text</span><p>${esc(
            p.description || ''
          ).replace(/\n+/g, '</p><p>')}</p></div>
          ${
            tags
              ? `<div class="alert-tags"><span class="alert-block-title">Tags</span><div class="alert-tag-row">${tags}</div></div>`
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
  return features;
}
