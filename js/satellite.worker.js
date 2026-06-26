// satellite.worker.js — runs the GOES/Himawari fetch + decode off the main thread.
//
// GOES scenes are a single NetCDF-4/HDF5 file; Himawari full-disk scenes are ten
// bzip2-compressed HSD segments per band, decompressed in pure JS and resampled
// onto a 5500×5500 grid. Doing that on the page froze the browser for seconds
// every time a frame loaded (the Himawari bzip2 especially). Here it happens in a
// worker, with the decoded channel buffers transferred back so the page only ever
// touches finished arrays.
//
// The worker keeps the few most-recent full scenes (with their decode source —
// the parsed HDF5 file for GOES, the sector/frame meta for Himawari) so a product
// switch that needs another band is added without re-downloading. The channel
// buffers it hands back are transferred (detached) — that's fine, because
// ensureBands only ever *adds* missing bands and never re-reads the ones already
// sent.

import { loadScene, ensureBands } from './goes.js';

// LRU of decoded scenes, so ensureBands can add bands without a re-download while
// keeping memory bounded (each cached GOES scene pins its downloaded file bytes).
const scenes = new Map();
const order = [];
const MAX_SCENES = 6;

function remember(key, scene) {
  scenes.set(key, scene);
  const i = order.indexOf(key);
  if (i >= 0) order.splice(i, 1);
  order.push(key);
  while (order.length > MAX_SCENES) scenes.delete(order.shift());
}

// The cloneable view of a scene the page needs (geometry + projection + the
// requested channel arrays), plus the channel buffers to transfer.
function slimScene(scene, bands) {
  const channels = {};
  const transfer = [];
  for (const b of bands) {
    const arr = scene.channels[b];
    if (!arr) continue;
    channels[b] = arr;
    transfer.push(arr.buffer);
  }
  const slim = {
    width: scene.width, height: scene.height,
    xScale: scene.xScale, xOffset: scene.xOffset,
    yScale: scene.yScale, yOffset: scene.yOffset,
    proj: scene.proj, time: scene.time, key: scene.key, channels,
  };
  return { slim, transfer };
}

self.onmessage = async (e) => {
  const msg = e.data;
  const { id, type } = msg;
  const progress = (frac) => self.postMessage({ id, progress: frac });
  try {
    if (type === 'evict') {
      scenes.delete(msg.key);
      const i = order.indexOf(msg.key);
      if (i >= 0) order.splice(i, 1);
      return;
    }
    if (type === 'load') {
      const scene = await loadScene(msg.satKey, msg.sectorKey, msg.key, msg.bands, progress);
      remember(msg.key, scene);
      const { slim, transfer } = slimScene(scene, msg.bands);
      self.postMessage({ id, ok: true, scene: slim }, transfer);
      return;
    }
    if (type === 'ensure') {
      let scene = scenes.get(msg.key);
      let added = msg.bands;
      if (!scene) {
        // Evicted (or this worker never had it): reload just the bands wanted.
        scene = await loadScene(msg.satKey, msg.sectorKey, msg.key, msg.bands, progress);
        remember(msg.key, scene);
      } else {
        const before = new Set(Object.keys(scene.channels));
        await ensureBands(scene, msg.bands);
        added = msg.bands.filter((b) => !before.has(String(b)));
      }
      const { slim, transfer } = slimScene(scene, added);
      self.postMessage({ id, ok: true, channels: slim.channels }, transfer);
      return;
    }
    throw new Error(`unknown message ${type}`);
  } catch (err) {
    self.postMessage({ id, ok: false, error: err && err.message ? err.message : String(err) });
  }
};
