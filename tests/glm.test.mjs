import assert from 'node:assert/strict';
import { loadFlashes, listGlmGranules } from '../js/glm.js';

// Lightning is an enhancement to the infrared rain-rate estimate, never a
// requirement for it (satPrecip.js), so nothing here may leave a caller waiting.
// Five minutes of GLM is fifteen granule downloads per frame and fetch has no
// timeout of its own: on a phone's connection one request the browser never
// settles used to hold the precipitation product's frame — and, with playback's
// single load lane on a constrained device, the whole loop — indefinitely.

const stamp = (hh, mm, ss) => `2026209${hh}${mm}${ss}0`;
const granuleKey = (hh, mm, ss) =>
  `GLM-L2-LCFA/2026/209/${hh}/OR_GLM-L2-LCFA_G19_s${stamp(hh, mm, ss)}_e${stamp(hh, mm, ss)}_c${stamp(hh, mm, ss)}.nc`;

function listing(keys) {
  return new Response(`<ListBucketResult>${keys.map((k) => `<Key>${k}</Key>`).join('')}</ListBucketResult>`);
}

// A fetch that lists granules but never settles their downloads, unless the
// caller's abort signal fires.
function hangingGranules(keys, { onList = () => {} } = {}) {
  return (url, options = {}) => {
    if (String(url).includes('list-type=2')) { onList(); return Promise.resolve(listing(keys)); }
    return new Promise((_, reject) => {
      const signal = options && options.signal;
      if (!signal) return;
      if (signal.aborted) reject(new Error('aborted'));
      else signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  };
}

const realFetch = globalThis.fetch;
try {
  {
    // The budget expires with every download still in flight: the read has to
    // come back with an empty density rather than hang.
    const from = new Date(Date.UTC(2026, 6, 28, 10, 0, 0));
    const to = new Date(Date.UTC(2026, 6, 28, 10, 5, 0));
    globalThis.fetch = hangingGranules([granuleKey('10', '00', '20'), granuleKey('10', '01', '40')]);
    const started = Date.now();
    const flashes = await loadFlashes('goes19', from, to, { budgetMs: 120 });
    const elapsed = Date.now() - started;
    assert.equal(flashes.lat.length, 0, 'no granule landed, so there are no flashes');
    assert.equal(flashes.granules, 2, 'the listing still reports what was available');
    assert.ok(elapsed < 3000, `loadFlashes should return on its budget, took ${elapsed}ms`);
  }

  {
    // A listing that fails must not stay cached as "this hour has no lightning":
    // every later frame in a loop would silently lose its lightning.
    const from = new Date(Date.UTC(2026, 6, 28, 12, 0, 0));
    const to = new Date(Date.UTC(2026, 6, 28, 12, 5, 0));
    globalThis.fetch = async () => new Response('nope', { status: 503 });
    assert.deepEqual(await listGlmGranules('goes19', from, to), [], 'a failed listing yields no granules');

    const key = granuleKey('12', '00', '20');
    globalThis.fetch = async () => listing([key]);
    const retried = await listGlmGranules('goes19', from, to);
    assert.deepEqual(retried.map((g) => g.key), [key], 'the next call should list the folder again');
  }

  {
    // Without a budget the reader behaves exactly as before — no abort signal is
    // attached, and the granules it lists are the ones it tries to read.
    const from = new Date(Date.UTC(2026, 6, 28, 14, 0, 0));
    const to = new Date(Date.UTC(2026, 6, 28, 14, 5, 0));
    let signalled = 0;
    globalThis.fetch = async (url, options = {}) => {
      if (String(url).includes('list-type=2')) return listing([granuleKey('14', '00', '20')]);
      if (options && options.signal) signalled++;
      return new Response('not an HDF5 file', { status: 200 });
    };
    const flashes = await loadFlashes('goes19', from, to);
    assert.equal(signalled, 0, 'no budget means no abort signal');
    assert.equal(flashes.lat.length, 0);
    assert.equal(flashes.loaded, 0, 'an unreadable granule is skipped, not thrown');
  }
} finally {
  globalThis.fetch = realFetch;
}

console.log('glm tests passed');
