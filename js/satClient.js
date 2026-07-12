// satClient.js — main-thread proxy to satellite.worker.js. Exposes promise-based
// loadSceneAsync / ensureBandsAsync that mirror goes.js's loadScene / ensureBands
// but run the fetch + decode in a worker, so loading a frame (Himawari full-disk
// bzip2 in particular) no longer blocks the UI. The returned scene is a "slim"
// clone — geometry, projection, time and the decoded channel arrays — which is all
// buildRGBA, sceneBBox, lonLatToColRow and the inspect readout need.

let worker = null;
let seq = 0;
const pending = new Map(); // id -> { resolve, reject, onProgress }

function failWorker(target, error) {
  // Ignore a late error event from a worker that has already been replaced.
  if (worker !== target) return;
  for (const p of pending.values()) p.reject(error);
  pending.clear();
  try { target.terminate(); } catch (_) { /* already stopped */ }
  worker = null;
}

function ensureWorker() {
  if (worker) return worker;
  const next = new Worker(new URL('./satellite.worker.js', import.meta.url), { type: 'module' });
  worker = next;
  next.onmessage = (e) => {
    const m = e.data;
    const p = pending.get(m.id);
    if (!p) return;
    if (m.progress != null) { if (p.onProgress) p.onProgress(m.progress); return; }
    pending.delete(m.id);
    if (m.ok) p.resolve(m);
    else p.reject(new Error(m.error || 'satellite decode failed'));
  };
  // A worker-level crash rejects everything in flight so callers surface an error
  // instead of hanging; the next call lazily respawns the worker.
  next.onerror = (ev) => {
    const err = new Error(`satellite worker error: ${ev.message || 'crashed'}`);
    failWorker(next, err);
  };
  // Structured-clone failures are reported separately from runtime errors in
  // some browsers. Treat them the same way; otherwise all requests stay pending.
  next.onmessageerror = () => {
    failWorker(next, new Error('satellite worker returned an unreadable response'));
  };
  return next;
}

function call(msg, onProgress) {
  return new Promise((resolve, reject) => {
    let w;
    try {
      w = ensureWorker();
    } catch (error) {
      reject(error);
      return;
    }
    const id = ++seq;
    pending.set(id, { resolve, reject, onProgress });
    try {
      w.postMessage({ ...msg, id });
    } catch (error) {
      // postMessage can throw synchronously (for example after a worker was
      // terminated by the browser). Every message here is internally cloneable,
      // so retire that worker and reject all jobs it can no longer answer.
      failWorker(w, error);
    }
  });
}

function postControl(message) {
  const target = worker;
  if (!target) return;
  try {
    target.postMessage(message);
  } catch (error) {
    // A crash can become observable between the null check and postMessage.
    // Retire the dead worker so cache housekeeping never breaks a mode switch.
    failWorker(target, error);
  }
}

export function loadSceneAsync(satKey, sectorKey, key, bands, onProgress) {
  return call({ type: 'load', satKey, sectorKey, key, bands }, onProgress).then((m) => m.scene);
}

// Decode any of `bands` not already on the scene, merging the new channel arrays
// into scene.channels. Returns the same scene for chaining. Himawari bands are
// ten separately-fetched HSD segments each, so a transient S3 hiccup can drop a
// band; a single retry of whatever is still missing turns those flaky switches
// into reliable ones instead of leaving the newly-selected product blank.
export async function ensureBandsAsync(scene, satKey, sectorKey, bands) {
  const need = [...new Set(bands)].filter((b) => !scene.channels[b]);
  if (!need.length) return scene;
  const request = (want) =>
    call({ type: 'ensure', satKey, sectorKey, key: scene.key, bands: want })
      .then((m) => { Object.assign(scene.channels, m.channels); });

  let lastError = null;
  // Retry both explicit worker failures and successful-but-partial Himawari
  // responses. The old chain only retried the partial-success case; a rejected
  // first attempt jumped straight to a catch that silently reported success.
  for (let attempt = 0; attempt < 2; attempt++) {
    const still = need.filter((b) => !scene.channels[b]);
    if (!still.length) return scene;
    try {
      await request(still);
      lastError = null;
    } catch (error) {
      lastError = error;
    }
  }

  const missing = need.filter((b) => !scene.channels[b]);
  if (missing.length) {
    const detail = lastError && lastError.message ? `: ${lastError.message}` : '';
    throw new Error(`satellite band${missing.length === 1 ? '' : 's'} ${missing.join(', ')} unavailable after retry${detail}`);
  }
  return scene;
}

// Drop a scene's cached decode state in the worker (frees a GOES file's bytes).
export function evictScene(key) {
  postControl({ type: 'evict', key });
}

// Release every decoded source file when Satellite is no longer active. The
// worker is kept alive for fast reuse, but its large scene/parser cache is not.
export function clearSceneCache() {
  postControl({ type: 'clear' });
}
