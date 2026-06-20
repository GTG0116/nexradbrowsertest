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

export class AlertsController {
  constructor(map, els) {
    this.map = map;
    this.els = els; // { listPanel, list, detail, detailPanel, close }
    this.alerts = []; // [{ id, feature, cls, bounds }]
    this.layers = new Map(); // id -> leaflet layer (only the visible ones)
    this.layerGroup = L.layerGroup().addTo(map);
    this.enabled = true;
    this.selectedId = null;

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
        this.layerGroup.removeLayer(layer);
        this.layers.delete(id);
      }
    }
    // Add polygons that scrolled into view.
    for (const a of visible) {
      if (this.layers.has(a.id)) continue;
      const layer = L.geoJSON(a.feature, {
        style: () => ({
          color: a.cls.color,
          weight: 2.5,
          opacity: 0.95,
          fill: true,
          fillColor: a.cls.color,
          fillOpacity: 0.12,
        }),
      });
      layer.on('click', () => this.openDetail(a.id));
      layer.addTo(this.layerGroup);
      this.layers.set(a.id, layer);
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

    return `
      <section class="alert-sec${selected ? ' selected' : ''}" data-id="${esc(a.id)}">
        <header class="alert-sec-head" style="--ac:${c}">
          <span class="alert-sec-icon">⚠</span>
          <h3>${esc(a.cls.display)}</h3>
        </header>
        <div class="alert-sec-body">
          <div class="alert-expires">
            <span>EXPIRES</span>
            <b>${esc(fmtTime(p.ends || p.expires))}</b>
          </div>
          ${boxes.length ? `<div class="alert-hazards">${boxes.join('')}</div>` : ''}
          ${motion ? `<div class="alert-motion">${esc(motion)}</div>` : ''}
          <div class="alert-issued">Issued ${esc(fmtTime(p.sent))} · ${esc(
      p.senderName || 'NWS'
    )}</div>
          <div class="alert-loc"><span>LOCATION</span><p>${esc(p.areaDesc || '—')}</p></div>
          ${
            p.instruction
              ? `<div class="alert-block"><span>WHAT TO DO</span><p>${esc(
                  p.instruction
                ).replace(/\n+/g, '</p><p>')}</p></div>`
              : ''
          }
          <div class="alert-block"><span>FULL ALERT TEXT</span><p>${esc(
            p.description || ''
          ).replace(/\n+/g, '</p><p>')}</p></div>
          ${
            tags
              ? `<div class="alert-tags"><span>TAGS</span><div class="alert-tag-row">${tags}</div></div>`
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
