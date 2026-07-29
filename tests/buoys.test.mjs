import assert from 'node:assert/strict';
import {
  parseCatalog, catalogName, normalizeMaritime, normalizeErddap, compassPoint, sstColor,
} from '../js/buoys.js';

const now = Date.parse('2026-07-28T23:00:00Z');

// --- catalogue ------------------------------------------------------------

assert.equal(
  catalogName('41008 (LLNR 833) - GRAYS REEF - 40 NM Southeast of Savannah, GA', '41008'),
  'GRAYS REEF - 40 NM Southeast of Savannah, GA'
);
assert.equal(catalogName('SMKF1 - Sombrero Key, FL', 'SMKF1'), 'Sombrero Key, FL');

const catalog = parseCatalog({
  columnNames: ['datasetID', 'minLongitude', 'minLatitude', 'title', 'maxTime'],
  rows: [
    ['gov-ndbc-41008', -80.866, 31.4, '41008 (LLNR 833) - GRAYS REEF', '2026-07-28T22:50:00Z'],
    ['gov-ndbc-smkf1', -81.111, 24.628, 'SMKF1 - Sombrero Key, FL', '2026-07-28T22:50:00Z'],
    // Recovered buoy: last report is days old, so it must not be plotted.
    ['gov-ndbc-41009', -80.185, 28.508, '41009 - CANAVERAL', '2026-07-20T10:00:00Z'],
    // DART tsunami buoys carry no met/wave payload.
    ['gov-ndbc-dart-21413', 152.123, 30.514, '21413 - SOUTHEAST TOKYO', '2026-07-28T22:00:00Z'],
    // Non-NDBC datasets on the same ERDDAP are not buoys we know how to read.
    ['edu_usf_marine_comps_c10', -82.9, 27.2, 'C10 - WFS Central Buoy', '2026-07-28T22:00:00Z'],
  ],
}, now);

assert.deepEqual(catalog.map((s) => s.id), ['41008', 'SMKF1']);
assert.equal(catalog[0].name, 'GRAYS REEF');
assert.equal(catalog[0].lat, 31.4);
assert.equal(catalog[0].lon, -80.866);

// --- bulk GTS marine rows -------------------------------------------------

const gts = normalizeMaritime({
  attributes: {
    stationname: '41004', timeobs: Date.parse('2026-07-28T22:50:00Z'),
    temperature: 84.74, dewpoint: 79.0, winddir: 200, windspeed: 17.49, windgust: 21,
    sealevelpress: 1007.5, preschange: -1.2, visibility: 10, sst: 84.56, waveheight: 2.62,
  },
  geometry: { x: -79.1, y: 32.5 },
}, now);

assert.equal(gts.id, '41004');
assert.equal(gts.ob.source, 'gts');
assert.ok(Math.abs(gts.ob.tempC - 29.3) < 0.05, 'air temperature converts °F → °C');
assert.ok(Math.abs(gts.ob.waveHtM - 0.8) < 0.02, 'wave height converts ft → m');
assert.equal(gts.ob.windKt, 17.49, 'the service already reports wind in knots');

// Stale rows are dropped rather than plotted as if they were current.
assert.equal(normalizeMaritime({
  attributes: { stationname: '41004', timeobs: Date.parse('2026-07-28T12:00:00Z') },
  geometry: { x: -79.1, y: 32.5 },
}, now), null);

// --- full ERDDAP station report -------------------------------------------

// Buoys interleave payloads: the wave block and the met block land in separate
// rows minutes apart, so the newest value of EACH variable has to win.
const detail = normalizeErddap({
  columnNames: [
    'time', 'air_temperature', 'sea_surface_temperature',
    'sea_surface_wave_significant_height',
    'sea_surface_wave_period_at_variance_spectral_density_maximum',
    'sea_surface_wave_from_direction', 'wind_speed', 'wind_speed_of_gust', 'wind_from_direction',
  ],
  rows: [
    ['2026-07-28T22:20:00Z', 29.5, 29.9, 0.9, 8, 170, 7, 9, 185],
    ['2026-07-28T22:50:00Z', 30.1, null, null, null, null, 8, 11, 190],
  ],
});

assert.equal(detail.source, 'ndbc');
assert.equal(detail.at, Date.parse('2026-07-28T22:50:00Z'));
assert.equal(detail.tempC, 30.1, 'newest row wins where it has a value');
assert.equal(detail.sstC, 29.9, 'older row fills in what the newest row omits');
assert.equal(detail.waveHtM, 0.9);
assert.equal(detail.wavePeakS, 8);
assert.equal(detail.waveDir, 170);
assert.ok(Math.abs(detail.windKt - 15.55) < 0.01, 'wind converts m/s → kt');

assert.equal(normalizeErddap({ columnNames: ['time'], rows: [] }), null);
assert.equal(
  normalizeErddap({ columnNames: ['time', 'air_temperature'], rows: [['2026-07-28T22:50:00Z', null]] }),
  null,
  'a row with no readable variables is not an observation'
);

// --- small helpers --------------------------------------------------------

assert.equal(compassPoint(0), 'N');
assert.equal(compassPoint(190), 'S');
assert.equal(compassPoint(350), 'N');
assert.equal(compassPoint(null), '');
assert.equal(sstColor(null), null);
assert.match(sstColor(-40), /^rgb\(/, 'temperatures below the ramp clamp to its cold end');
assert.match(sstColor(99), /^rgb\(/, 'temperatures above the ramp clamp to its warm end');
assert.notEqual(sstColor(5), sstColor(25));

console.log('buoy overlay tests passed');
