// dealias.js — optional velocity dealiasing (unfolding) for NEXRAD VEL sweeps.
//
// Doppler velocity is "aliased": the radar can only measure speeds within
// ±Nyquist velocity (VN), so anything faster wraps around — a strong outbound
// gate past +VN reads as a strong *inbound* value, creating a false
// green-next-to-red boundary. Dealiasing adds the right whole number of 2·VN
// intervals to each gate so the field is continuous again.
//
// This is a lightweight continuity unfold done one radial at a time (each radial
// is independent, so a bad gate can never propagate across the whole sweep).
// Walking a beam outward from the radar — where velocities are small and
// unaliased — each gate is unfolded to sit closest to a reference built from the
// *median* of the last few already-unfolded gates. The median is the key to
// avoiding the long radial "streaks" a naive unfold produces: chaining off only
// the single previous gate means one wrong guess at an ambiguous gate makes
// every gate after it look confidently offset by 2·VN, painting a whole spoke
// the wrong colour. Referencing a short window's median instead lets the good
// gates outvote a single bad one, so a mistake stays a lone speckle and the beam
// self-heals on the next gate. A fresh run (the first gate, or the first gate
// after a no-data gap) is seeded from the same gate in the previous radial.
//
// The result is a sweep whose VEL moment blocks carry re-encoded 16-bit codes
// (so unfolded values beyond the original ±VN range still fit) with a matching
// offset/scale, so the existing GL layer and point sampler consume it unchanged.

const cache = new WeakMap();

// Velocities never realistically exceed this magnitude (m/s); used to pick an
// encoding offset so even large negative unfolded values map to a positive code.
const VMIN = -200;

// Length of the along-beam reference window. Small enough that its span stays
// well under one Nyquist interval on ordinary gradients (so it never invents a
// fold), large enough that a single mis-unfolded gate is outvoted by the median.
const WIN = 5;

// Dealias a sweep's VEL moment, memoised per sweep object. Returns the original
// sweep unchanged when there's no velocity data or no Nyquist information.
export function dealiasSweep(sweep) {
  if (!sweep) return sweep;
  if (cache.has(sweep)) return cache.get(sweep);
  const out = computeDealias(sweep);
  cache.set(sweep, out);
  return out;
}

// Median of the first `n` entries of `buf` (n ≤ WIN). Small insertion sort into
// a scratch array; order within the window doesn't matter for the median.
function windowMedian(buf, n, scratch) {
  for (let i = 0; i < n; i++) scratch[i] = buf[i];
  for (let i = 1; i < n; i++) {
    const x = scratch[i];
    let j = i - 1;
    while (j >= 0 && scratch[j] > x) { scratch[j + 1] = scratch[j]; j--; }
    scratch[j + 1] = x;
  }
  const mid = n >> 1;
  return n & 1 ? scratch[mid] : (scratch[mid - 1] + scratch[mid]) / 2;
}

function computeDealias(sweep) {
  const velRadials = sweep.radials.filter((r) => r.moments.VEL);
  if (!velRadials.length) return sweep;

  // Encoding shared by every rebuilt block in the sweep (the shader uses one
  // offset/scale uniform, so they must match). Keep the native resolution.
  const SC = velRadials[0].moments.VEL.scale || 1;
  const OFF2 = 2 - VMIN * SC; // value v -> code = round(v*SC + OFF2) >= 2

  // Process in azimuth order so a fresh run can seed from the adjacent beam.
  const ordered = [...velRadials].sort((a, b) => a.azimuth - b.azimuth);
  const rebuilt = new Map();
  const win = new Float32Array(WIN);
  const scratch = new Float32Array(WIN);
  let prevVals = null; // previous radial's unfolded values (for seeding)

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
    let wn = 0; // number of valid entries currently in the window
    let wi = 0; // next write slot in the ring

    for (let g = 0; g < gc; g++) {
      const c = raw[g];
      // No echo / range folded: emit NaN and break beam continuity, so a gate on
      // the far side of a gap is never referenced against one before it.
      if (c < 2) { vals[g] = NaN; wn = 0; wi = 0; continue; }
      let v = (c - mOff) / mSc;
      if (canUnfold) {
        let ref;
        if (wn > 0) {
          // Anchor to the recent beam: the median rejects a lone bad gate.
          ref = windowMedian(win, wn, scratch);
        } else if (prevVals && g < prevVals.length && !Number.isNaN(prevVals[g])) {
          // Fresh run — seed from the same gate in the previous radial.
          ref = prevVals[g];
        } else {
          // Near the radar with nothing to lean on: assume it's unaliased.
          ref = NaN;
        }
        if (!Number.isNaN(ref)) v += Math.round((ref - v) / twoVN) * twoVN;
        win[wi] = v;
        wi = (wi + 1) % WIN;
        if (wn < WIN) wn++;
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
