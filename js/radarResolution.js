// radarResolution.js — native/legacy Level-II resolution helpers.
//
// A decoded Archive-II volume contains only the resolution that the radar
// transmitted; there is no second, hidden "legacy" moment to select.  For a
// legacy-resolution view we therefore pool the decoded polar samples to the
// historical Level-II geometry: 1 degree in azimuth, 1 km REF gates, and
// 250 m gates for every other moment.  The returned objects keep the ordinary
// sweep/moment contract, so the radar layer, point sampler, split view and
// derived VEL/SRV paths can consume them without special cases.

export const LEGACY_AZIMUTH_SPACING = 1;

const FINE_AZIMUTH_THRESHOLD = 0.75; // NEXRAD uses 0.5° or 1.0° radials.
const EPS = 1e-6;

// Transform and description caches are keyed by the (normally immutable)
// decoded/derived sweep object.  In particular, dealiasSweep() and
// stormRelativeSweep() return distinct sweep objects, so their VEL fields get
// distinct cached legacy products automatically.
const legacyCache = new WeakMap();
const descriptionCache = new WeakMap();

function momentName(moment) {
  const name = typeof moment === 'string' ? moment : moment && moment.moment;
  return String(name || '').trim().toUpperCase();
}

export function legacyGateSpacingForMoment(moment) {
  return momentName(moment) === 'REF' ? 1000 : 250;
}

function finitePositive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function normalizeAzimuth(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return ((n % 360) + 360) % 360;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length & 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function momentRadials(sweep, moment) {
  if (!sweep || !Array.isArray(sweep.radials) || !moment) return [];
  const out = [];
  for (const radial of sweep.radials) {
    const block = radial && radial.moments && radial.moments[moment];
    if (!block || !block.raw || !(block.gateCount > 0)) continue;
    out.push({ radial, block });
  }
  return out;
}

// Prefer observed beam spacing over the commanded header value.  Missing
// radials turn some gaps into 1.0/1.5 degrees, but the median of a normal sweep
// remains the true 0.5- or 1-degree sampling interval.
function observedAzimuthSpacing(entries) {
  const azimuths = entries
    .map(({ radial }) => normalizeAzimuth(radial.azimuth))
    .filter((v) => v != null)
    .sort((a, b) => a - b);
  if (azimuths.length < 2) return null;

  const unique = [];
  for (const az of azimuths) {
    if (!unique.length || Math.abs(az - unique[unique.length - 1]) > 0.01)
      unique.push(az);
  }
  if (unique.length < 2) return null;

  const gaps = [];
  for (let i = 1; i < unique.length; i++) {
    const d = unique[i] - unique[i - 1];
    // Ignore sector-sized holes while retaining a few consecutively missing
    // NEXRAD beams.  Either 0.5 or 1.0 still dominates the median.
    if (d > 0.01 && d <= 5) gaps.push(d);
  }
  const wrap = unique[0] + 360 - unique[unique.length - 1];
  if (wrap > 0.01 && wrap <= 5) gaps.push(wrap);
  return median(gaps);
}

function explicitAzimuthSpacing(sweep, entries) {
  for (const key of ['azimuthSpacing', 'azimuthSpacingDeg', 'azimuthResolutionDeg']) {
    const value = finitePositive(sweep && sweep[key]);
    if (value != null) return value;
  }
  for (const { radial } of entries) {
    for (const key of ['azimuthSpacing', 'azimuthSpacingDeg', 'azimuthResolutionDeg']) {
      const value = finitePositive(radial[key]);
      if (value != null) return value;
    }
  }

  // Message 31 stores an encoded value: 1 => 0.5°, 2 => 1.0°.  Normalized
  // fields above take priority so an app can retain both the source code and
  // the physical spacing without ambiguity.
  for (const { radial } of entries) {
    const code = Number(radial.azimuthResolution);
    if (code === 1) return 0.5;
    if (code === 2) return 1;
    if (code > 0 && code < 2) return code;
  }
  return null;
}

export function sweepHasMoment(sweep, moment) {
  return momentRadials(sweep, momentName(moment)).length > 0;
}

// Describe the resolution actually present in one sweep/moment.  This is based
// on the radial angles and gate blocks, not the scan date, so it also handles
// station-by-station super-resolution rollout and modern high tilts that are
// natively collected at 1 degree.
export function describeSweepResolution(sweep, moment) {
  const name = momentName(moment);
  if (sweep && typeof sweep === 'object') {
    const byMoment = descriptionCache.get(sweep);
    if (byMoment && byMoment.has(name)) return byMoment.get(name);
  }

  const entries = momentRadials(sweep, name);
  const targetGateSpacing = legacyGateSpacingForMoment(name);
  const gateSpacings = entries
    .map(({ block }) => finitePositive(block.gateSpacing))
    .filter((v) => v != null);
  const observedAzimuth = observedAzimuthSpacing(entries);
  const explicitAzimuth = explicitAzimuthSpacing(sweep, entries);
  const azimuthSpacing = observedAzimuth != null ? observedAzimuth : explicitAzimuth;
  const gateSpacing = median(gateSpacings);
  const minGateSpacing = gateSpacings.length ? Math.min(...gateSpacings) : null;
  const maxGateSpacing = gateSpacings.length ? Math.max(...gateSpacings) : null;
  let maxRange = null;
  for (const { block } of entries) {
    const spacing = finitePositive(block.gateSpacing);
    const first = Number(block.firstGate);
    if (spacing == null || !Number.isFinite(first)) continue;
    const end = first + block.gateCount * spacing;
    if (maxRange == null || end > maxRange) maxRange = end;
  }

  const angularSuperResolution = azimuthSpacing != null && azimuthSpacing < FINE_AZIMUTH_THRESHOLD;
  const rangeSuperResolution = minGateSpacing != null && minGateSpacing < targetGateSpacing - EPS;
  const available = entries.length > 0;
  const legacyEnough = available && !angularSuperResolution && !rangeSuperResolution;
  const description = {
    moment: name,
    available,
    radialCount: entries.length,
    azimuthSpacing,
    observedAzimuthSpacing: observedAzimuth,
    explicitAzimuthSpacing: explicitAzimuth,
    gateSpacing,
    minGateSpacing,
    maxGateSpacing,
    maxRange,
    targetAzimuthSpacing: LEGACY_AZIMUTH_SPACING,
    targetGateSpacing,
    angularSuperResolution,
    rangeSuperResolution,
    superResolution: available && (angularSuperResolution || rangeSuperResolution),
    legacyEnough,
    classification: !available ? 'unavailable' : legacyEnough ? 'legacy' : 'super',
  };

  if (sweep && typeof sweep === 'object') {
    let byMoment = descriptionCache.get(sweep);
    if (!byMoment) descriptionCache.set(sweep, (byMoment = new Map()));
    byMoment.set(name, description);
  }
  return description;
}

export function superResolutionAvailable(sweep, moment) {
  return describeSweepResolution(sweep, moment).superResolution;
}

// Effective display kind for UI/status text.  A native preference naturally
// resolves to legacy when an archive scan contains only legacy-resolution data;
// importantly, callers need not overwrite the user's saved preference.
export function effectiveResolutionMode(sweep, moment, preference = 'native') {
  const description = describeSweepResolution(sweep, moment);
  if (!description.available) return 'unavailable';
  if (preference === 'legacy' || description.legacyEnough) return 'legacy';
  return 'super';
}

function angularDifference(a, b) {
  let d = Math.abs(a - b);
  if (d > 180) d = 360 - d;
  return d;
}

function radialGroups(entries, poolAzimuth) {
  if (!poolAzimuth) {
    return entries.map((entry) => ({
      azimuth: normalizeAzimuth(entry.radial.azimuth),
      entries: [entry],
      representative: entry,
    }));
  }

  const bins = new Map();
  for (const entry of entries) {
    const az = normalizeAzimuth(entry.radial.azimuth);
    if (az == null) continue;
    const bin = Math.floor(az + EPS) % 360;
    let group = bins.get(bin);
    if (!group) bins.set(bin, (group = []));
    group.push(entry);
  }

  const groups = [];
  for (const [bin, grouped] of bins) {
    const centre = bin + 0.5;
    let representative = grouped[0];
    let bestDistance = Infinity;
    for (const entry of grouped) {
      const az = normalizeAzimuth(entry.radial.azimuth);
      const distance = angularDifference(az, centre);
      if (distance < bestDistance) {
        bestDistance = distance;
        representative = entry;
      }
    }
    groups.push({ azimuth: centre, entries: grouped, representative });
  }
  groups.sort((a, b) => a.azimuth - b.azimuth);
  return groups;
}

function rangeGeometry(entries, targetSpacing) {
  const nativeSpacings = entries
    .map(({ block }) => finitePositive(block.gateSpacing))
    .filter((v) => v != null);
  const nativeSpacing = median(nativeSpacings) || targetSpacing;
  // Never invent finer range samples when an unusual source is already coarser
  // than the standard legacy target.
  const gateSpacing = Math.max(targetSpacing, nativeSpacing);
  let start = Infinity;
  let end = -Infinity;

  for (const { block } of entries) {
    const spacing = finitePositive(block.gateSpacing);
    const first = Number(block.firstGate);
    if (spacing == null || !Number.isFinite(first) || !(block.gateCount > 0)) continue;
    start = Math.min(start, first - spacing / 2);
    end = Math.max(end, first + (block.gateCount - 0.5) * spacing);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
    return null;

  const gateCount = Math.max(1, Math.ceil((end - start - EPS) / gateSpacing));
  return {
    start,
    firstGate: start + gateSpacing / 2,
    gateSpacing,
    gateCount,
  };
}

function rawConstructor(raw) {
  const Ctor = raw && raw.constructor;
  if (typeof Ctor === 'function' && Number.isFinite(Ctor.BYTES_PER_ELEMENT)) return Ctor;
  return Uint8Array;
}

function maximumCodeFor(raw) {
  const bytes = raw && raw.BYTES_PER_ELEMENT ? raw.BYTES_PER_ELEMENT : 1;
  // Archive-II moments use unsigned 8- or 16-bit arrays.  Keep this generic for
  // derived moments while avoiding a signed 32-bit shift overflow.
  return 2 ** (bytes * 8) - 1;
}

function pooledMoment(group, geometry) {
  const representativeBlock = group.representative.block;
  const sums = new Float64Array(geometry.gateCount);
  const counts = new Uint32Array(geometry.gateCount);

  for (const { block } of group.entries) {
    const spacing = finitePositive(block.gateSpacing);
    const first = Number(block.firstGate);
    if (spacing == null || !Number.isFinite(first)) continue;
    const scale = finitePositive(block.scale) || 1;
    const offset = Number.isFinite(Number(block.offset)) ? Number(block.offset) : 0;
    const n = Math.min(block.gateCount, block.raw.length);
    for (let gate = 0; gate < n; gate++) {
      const code = block.raw[gate];
      if (!(code >= 2)) continue; // below threshold / range folded / missing
      const value = (code - offset) / scale;
      if (!Number.isFinite(value)) continue;
      const centre = first + gate * spacing;
      const target = Math.floor((centre - geometry.start) / geometry.gateSpacing + EPS);
      if (target < 0 || target >= geometry.gateCount) continue;
      sums[target] += value;
      counts[target]++;
    }
  }

  const Raw = rawConstructor(representativeBlock.raw);
  const raw = new Raw(geometry.gateCount);
  const scale = finitePositive(representativeBlock.scale) || 1;
  const offset = Number.isFinite(Number(representativeBlock.offset))
    ? Number(representativeBlock.offset) : 0;
  const maximumCode = maximumCodeFor(raw);
  for (let gate = 0; gate < geometry.gateCount; gate++) {
    if (!counts[gate]) continue; // Uint arrays initialize to missing code 0.
    const value = sums[gate] / counts[gate];
    raw[gate] = Math.max(2, Math.min(maximumCode, Math.round(value * scale + offset)));
  }

  const pooled = {
    ...representativeBlock,
    gateCount: geometry.gateCount,
    firstGate: geometry.firstGate,
    gateSpacing: geometry.gateSpacing,
    scale,
    offset,
    raw,
  };
  // parseLevel2() moment blocks carry a convenience closure, while worker-
  // cloned app blocks do not.  If one was present, replace it so it cannot keep
  // reading the representative block's old raw array.
  if (typeof representativeBlock.value === 'function') {
    pooled.value = (i) => {
      const code = raw[i];
      return code >= 2 ? (code - offset) / scale : NaN;
    };
  }
  return pooled;
}

// Return a sweep carrying `moment` at legacy Level-II resolution.  Other radial
// metadata and moment blocks are retained from the representative source beam;
// only the requested moment and its polar geometry are replaced.  Consumers
// should call this per product, which also keeps the cache compact.
export function legacyResolutionSweep(sweep, moment) {
  const name = momentName(moment);
  if (!sweep || typeof sweep !== 'object' || !name) return sweep;

  let byMoment = legacyCache.get(sweep);
  if (byMoment && byMoment.has(name)) return byMoment.get(name);

  const description = describeSweepResolution(sweep, name);
  if (!description.available || description.legacyEnough) {
    if (!byMoment) legacyCache.set(sweep, (byMoment = new Map()));
    byMoment.set(name, sweep);
    return sweep;
  }

  const entries = momentRadials(sweep, name);
  const geometry = rangeGeometry(entries, description.targetGateSpacing);
  if (!geometry) return sweep;
  const groups = radialGroups(entries, description.angularSuperResolution);
  const radials = groups.map((group) => {
    const representative = group.representative.radial;
    const radial = {
      ...representative,
      moments: {
        ...representative.moments,
        [name]: pooledMoment(group, geometry),
      },
    };
    if (description.angularSuperResolution) {
      radial.azimuth = group.azimuth;
      // A normalized value takes precedence over the preserved source-format
      // azimuthResolution code in describeSweepResolution().
      radial.azimuthSpacing = LEGACY_AZIMUTH_SPACING;
    }
    return radial;
  });

  const transformed = {
    ...sweep,
    radials,
    azimuthSpacing: description.angularSuperResolution
      ? LEGACY_AZIMUTH_SPACING
      : description.azimuthSpacing,
  };
  if (!byMoment) legacyCache.set(sweep, (byMoment = new Map()));
  byMoment.set(name, transformed);
  return transformed;
}
