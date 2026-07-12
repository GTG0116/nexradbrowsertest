import assert from 'node:assert/strict';
import { SplitView } from '../js/splitview.js';

const state = {
  live: true,
  date: new Date('2026-07-12T00:00:00Z'),
  mrms: { frameKey: 'frame-a' },
  observations: { frameKey: 'obs-a' },
  models: { modelKey: 'hrrr', runKey: 'run-a', stormId: null, fhour: 1 },
};
const split = new SplitView({ state });

assert.equal(split._gridKey('mrms', 'REF'), 'mrms:REF:frame-a');
state.mrms.frameKey = 'frame-b';
assert.equal(split._gridKey('mrms', 'REF'), 'mrms:REF:frame-b');

for (let i = 0; i < 7; i++) split._gridCacheSet(`grid-${i}`, { i });
assert.equal(split._gridCache.size, 6, 'large split grids should use a bounded cache');
assert.equal(split._gridCacheGet('grid-0'), undefined, 'the oldest grid should be evicted');
assert.deepEqual(split._gridCacheGet('grid-6'), { i: 6 });

// Selecting an inactive pane must consume the first gesture before Mapbox or
// any map tool sees it, while still updating the active-pane UI callback.
const listeners = new Map();
const hosts = new Map([1, 2].map((n) => [n, {
  classList: { toggle() {} },
  addEventListener(type, handler) { listeners.set(`${n}:${type}`, handler); },
  removeEventListener() {},
}]));
const oldDocument = globalThis.document;
globalThis.document = { getElementById(id) {
  if (id === 'map') return hosts.get(1);
  if (id === 'map2') return hosts.get(2);
  return null;
} };
let activeChanges = 0;
const selecting = new SplitView({ state: { ...state, map: null }, onActivePaneChange() { activeChanges++; } });
selecting.active = true;
selecting.paneCount = 2;
selecting._bindPaneSelect();
let prevented = 0;
let stopped = 0;
listeners.get('2:mousedown')({
  preventDefault() { prevented++; },
  stopImmediatePropagation() { stopped++; },
});
assert.equal(selecting.activePane, 2);
assert.equal(activeChanges, 1);
assert.equal(prevented, 1);
assert.equal(stopped, 1);
listeners.get('2:click')({
  preventDefault() { prevented++; },
  stopImmediatePropagation() { stopped++; },
});
assert.equal(prevented, 2, 'the synthetic click following pane selection is consumed too');
assert.equal(stopped, 2);
globalThis.document = oldDocument;
