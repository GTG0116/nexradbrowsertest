// satClient.js — main-thread proxy to satellite.worker.js. Exposes promise-based
// loadSceneAsync / ensureBandsAsync that mirror goes.js's loadScene / ensureBands
// but run the fetch + decode in a worker, so loading a frame (Himawari full-disk
// bzip2 in particular) no longer blocks the UI. The returned scene is a "slim"
// clone — geometry, projection, time and the decoded channel arrays — which is all
// buildRGBA, sceneBBox, lonLatToColRow and the inspect readout need.

let worker = null;
let seq = 0;
const pending = new Map(); // id -> { resolve, reject, onProgress }

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./satellite.worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
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
  worker.onerror = (ev) => {
    const err = new Error(`satellite worker error: ${ev.message || 'crashed'}`);
    for (const p of pending.values()) p.reject(err);
    pending.clear();
    worker.terminate();
    worker = null;
  };
  return worker;
}

function call(msg, onProgress) {
  const w = ensureWorker();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    w.postMessage({ ...msg, id });
  });
}

export function loadSceneAsync(satKey, sectorKey, key, bands, onProgress) {
  return call({ type: 'load', satKey, sectorKey, key, bands }, onProgress).then((m) => m.scene);
}

// Decode any of `bands` not already on the scene, merging the new channel arrays
// into scene.channels. Returns the same scene for chaining.
export function ensureBandsAsync(scene, satKey, sectorKey, bands) {
  const need = bands.filter((b) => !scene.channels[b]);
  if (!need.length) return Promise.resolve(scene);
  return call({ type: 'ensure', satKey, sectorKey, key: scene.key, bands: need })
    .then((m) => { Object.assign(scene.channels, m.channels); return scene; });
}

// Drop a scene's cached decode state in the worker (frees a GOES file's bytes).
export function evictScene(key) {
  if (worker) worker.postMessage({ type: 'evict', key });
}
