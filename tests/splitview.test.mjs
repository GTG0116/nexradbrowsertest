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
