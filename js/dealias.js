// dealias.js — optional velocity dealiasing (unfolding) for NEXRAD VEL sweeps.
//
// Doppler velocity is "aliased": the radar can only measure speeds within
// ±Nyquist velocity (VN), so anything faster wraps around — a strong outbound
// gate past +VN reads as a strong *inbound* value, creating a false
// green-next-to-red boundary. Dealiasing adds the right whole number of 2·VN
// intervals to each gate so the field is continuous again.
//
// This is a lightweight continuity unfold: radials are walked in azimuth order;
// within a radial each gate is referenced against the previous (already
// unfolded) gate, and the first gate of a radial is seeded from the same gate of
// the previous radial. That keeps both along-beam and beam-to-beam continuity
// without the cost/complexity of a full region-based 4DD. Near the radar the
// velocities are small and unaliased, which anchors the unfolding outward.
//
// The result is a sweep whose VEL moment blocks carry re-encoded 16-bit codes
// (so unfolded values beyond the original ±VN range still fit) with a matching
// offset/scale, so the existing GL layer and point sampler consume it unchanged.

const cache = new WeakMap();

// Velocities never realistically exceed this magnitude (m/s); used to pick an
// encoding offset so even large negative unfolded values map to a positive code.
const VMIN = -200;

// Dealias a sweep's VEL moment, memoised per sweep object. Returns the original
// sweep unchanged when there's no velocity data or no Nyquist information.
export function dealiasSweep(sweep) {
  if (!sweep) return sweep;
  if (cache.has(sweep)) return cache.get(sweep);
  const out = computeDealias(sweep);
  cache.set(sweep, out);
  return out;
}

function computeDealias(sweep) {
  const velRadials = sweep.radials.filter((r) => r.moments.VEL);
  if (!velRadials.length) return sweep;

  // Encoding shared by every rebuilt block in the sweep (the shader uses one
  // offset/scale uniform, so they must match). Keep the native resolution.
  const SC = velRadials[0].moments.VEL.scale || 1;
  const OFF2 = 2 - VMIN * SC; // value v -> code = round(v*SC + OFF2) >= 2

  // Process in azimuth order for beam-to-beam seeding.
  const ordered = [...velRadials].sort((a, b) => a.azimuth - b.azimuth);
  const rebuilt = new Map();
  let prevVals = null;

  for (const r of ordered) {
    const m = r.moments.VEL;
    const gc = m.gateCount;
    const raw = m.raw;
    const mOff = m.offset;
    const mSc = m.scale || 1;
    const vals = new Float32Array(gc);
    const VN = r.nyquist;
    const canUnfold = VN > 0 && VN < 100;
    const twoVN = 2 * VN;
    let prevGate = NaN;

    for (let g = 0; g < gc; g++) {
      const c = raw[g];
      if (c < 2) { vals[g] = NaN; continue; }
      let v = (c - mOff) / mSc;
      if (canUnfold) {
        let ref = !Number.isNaN(prevGate) ? prevGate
          : (prevVals && g < prevVals.length && !Number.isNaN(prevVals[g])) ? prevVals[g]
          : NaN;
        if (!Number.isNaN(ref)) v += Math.round((ref - v) / twoVN) * twoVN;
        prevGate = v;
      }
      vals[g] = v;
    }

    const newRaw = new Uint16Array(gc);
    for (let g = 0; g < gc; g++) {
      const v = vals[g];
      if (Number.isNaN(v)) { newRaw[g] = 0; continue; }
      let code = Math.round(v * SC + OFF2);
      newRaw[g] = code < 2 ? 2 : code > 65535 ? 65535 : code;
    }
    rebuilt.set(r, { ...m, raw: newRaw, offset: OFF2, scale: SC });
    prevVals = vals;
  }

  // Preserve the original radial order; swap in the rebuilt VEL blocks.
  const radials = sweep.radials.map((r) => {
    const nm = rebuilt.get(r);
    return nm ? { ...r, moments: { ...r.moments, VEL: nm } } : r;
  });
  return { ...sweep, radials };
}
