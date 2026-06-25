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
// after a no-data gap) starts from the native value instead of copying the
// previous radial, preventing one bad azimuth from becoming a whole spoke.
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

// Require a small local history before applying a fold correction. This avoids
// letting the first valid gate after a blank range gap choose an arbitrary
// 2·Nyquist offset and paint the rest of that radial as a 100+ mph beam.
const MIN_REF_GATES = 3;

// Radar velocities around 100 mph (≈45 m/s) can be real in compact couplets, but
// a long, one-radial-wide run at that magnitude is usually an unfolding spoke.
const HIGH_VELOCITY_MPS = 44;
const MIN_SPOKE_GATES = 18;

// Azimuthal de-spoke passes. A continuity unfold walks each radial outward in
// isolation, so a single ambiguous gate can flip a whole radial onto the wrong
// 2·VN co-interval — painting a one-radial-wide "beam" (e.g. a real +30 m/s spoke
// folded down to a cyan ≈-10 m/s streak, too low for the high-velocity spoke
// guard to catch). Such a beam is, by definition, discontinuous with the *good*
// radials on either side of it, so after the per-radial unfold we compare every
// gate to the same gate in its two azimuth neighbours: when both neighbours agree
// the gate is offset by the same whole number of 2·VN intervals, that's the
// unmistakable signature of a fold error and we snap the gate back into line. A
// few passes let a correction propagate across a rare run of adjacent spokes.
const DESPOKE_PASSES = 3;

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


function suppressHighVelocitySpokes(vals, nativeVals, folds) {
  let start = -1;
  for (let g = 0; g <= vals.length; g++) {
    const suspect = g < vals.length
      && folds[g] !== 0
      && Math.abs(vals[g]) >= HIGH_VELOCITY_MPS;
    if (suspect && start < 0) start = g;
    if ((!suspect || g === vals.length) && start >= 0) {
      const end = g;
      if (end - start >= MIN_SPOKE_GATES) {
        for (let i = start; i < end; i++) {
          vals[i] = nativeVals[i];
          folds[i] = 0;
        }
      }
      start = -1;
    }
  }
}

// Snap each gate that two neighbouring radials both place a whole 2·VN interval
// away back onto the neighbours' co-interval. Operates in place on the unfolded
// `vals` arrays gathered in `infos` (already azimuth-sorted, so consecutive
// entries are azimuth neighbours; the list wraps 359°→0°). A correction is only
// applied when both neighbours agree on the *same* nonzero fold, so genuine
// features — which span several radials, making neighbours agree with the gate
// (fold 0) — are never touched, while a lone mis-folded beam, whose good
// neighbours both disagree by the same 2·VN, is pulled back into continuity.
function despokeAzimuthal(infos) {
  const n = infos.length;
  if (n < 3) return;
  for (let pass = 0; pass < DESPOKE_PASSES; pass++) {
    let corrected = 0;
    for (let i = 0; i < n; i++) {
      const cur = infos[i];
      if (!cur.canUnfold) continue;
      const prev = infos[(i - 1 + n) % n];
      const next = infos[(i + 1) % n];
      const { vals, folds, twoVN } = cur;
      const pv = prev.vals, nv = next.vals;
      const pn = pv.length, nn = nv.length;
      for (let g = 0; g < vals.length; g++) {
        const v = vals[g];
        if (Number.isNaN(v)) continue;
        if (g >= pn || g >= nn) continue;
        const a = pv[g], b = nv[g];
        if (Number.isNaN(a) || Number.isNaN(b)) continue;
        const fa = Math.round((a - v) / twoVN);
        if (fa === 0) continue;
        if (Math.round((b - v) / twoVN) !== fa) continue;
        vals[g] = v + fa * twoVN;
        folds[g] += fa;
        corrected++;
      }
    }
    if (!corrected) break; // converged — no spokes left to pull in
  }
}

function computeDealias(sweep) {
  const velRadials = sweep.radials.filter((r) => r.moments.VEL);
  if (!velRadials.length) return sweep;

  // Encoding shared by every rebuilt block in the sweep (the shader uses one
  // offset/scale uniform, so they must match). Keep the native resolution.
  const SC = velRadials[0].moments.VEL.scale || 1;
  const OFF2 = 2 - VMIN * SC; // value v -> code = round(v*SC + OFF2) >= 2

  // Process in azimuth order for stable, deterministic output.
  const ordered = [...velRadials].sort((a, b) => a.azimuth - b.azimuth);
  const win = new Float32Array(WIN);
  const scratch = new Float32Array(WIN);

  // Phase 1 — unfold each radial in isolation (continuity walk outward), keeping
  // the per-radial arrays so a second, cross-radial pass can de-spoke them.
  const infos = [];
  for (const r of ordered) {
    const m = r.moments.VEL;
    const gc = m.gateCount;
    const raw = m.raw;
    const mOff = m.offset;
    const mSc = m.scale || 1;
    const vals = new Float32Array(gc);
    const nativeVals = new Float32Array(gc);
    const folds = new Int16Array(gc);
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
      const native = (c - mOff) / mSc;
      let v = native;
      nativeVals[g] = native;
      if (canUnfold) {
        // Anchor only to a mature recent-beam median. If the window was just
        // reset by no-data/range-folded gates, keep the first few gates native
        // until there is enough same-radial evidence to avoid a long false spoke.
        if (wn >= MIN_REF_GATES) {
          const ref = windowMedian(win, wn, scratch);
          const fold = Math.round((ref - v) / twoVN);
          v += fold * twoVN;
          folds[g] = fold;
        }
        win[wi] = v;
        wi = (wi + 1) % WIN;
        if (wn < WIN) wn++;
      }
      vals[g] = v;
    }

    suppressHighVelocitySpokes(vals, nativeVals, folds);
    infos.push({ r, m, vals, nativeVals, folds, twoVN, canUnfold });
  }

  // Phase 2 — pull any remaining mis-folded beams back into azimuthal continuity.
  despokeAzimuthal(infos);

  // Phase 3 — re-encode each rebuilt VEL block from the corrected values.
  const rebuilt = new Map();
  for (const info of infos) {
    const { r, m, vals } = info;
    const gc = m.gateCount;
    const newRaw = new Uint16Array(gc);
    for (let g = 0; g < gc; g++) {
      const v = vals[g];
      if (Number.isNaN(v)) { newRaw[g] = 0; continue; }
      let code = Math.round(v * SC + OFF2);
      newRaw[g] = code < 2 ? 2 : code > 65535 ? 65535 : code;
    }
    rebuilt.set(r, { ...m, raw: newRaw, offset: OFF2, scale: SC });
  }

  // Preserve the original radial order; swap in the rebuilt VEL blocks.
  const radials = sweep.radials.map((r) => {
    const nm = rebuilt.get(r);
    return nm ? { ...r, moments: { ...r.moments, VEL: nm } } : r;
  });
  return { ...sweep, radials };
}
