import assert from 'node:assert/strict';
import { loadScene } from '../js/goes.js';

// The ranged NetCDF reader decides how to read a GOES file from the probe
// response alone: a 206 whose Content-Range gives the object size becomes a
// range-loaded file, anything else has to be downloaded whole. The failure this
// covers is the middle case — a 206 whose Content-Range cannot be read (a proxy
// that drops the header, a CORS response that stops exposing it). Treating the
// probe window as the complete object left every band read past the first
// megabyte throwing "hdf5: bytes … not loaded", which surfaces as a product that
// renders blank rather than as a download error.

const HEAD_BYTES = 1024 * 1024;

// Enough of a superblock for HDF5File's constructor: signature, version 2, and
// 8-byte offsets/lengths. Nothing here parses real structure.
function hdf5Bytes(size) {
  const b = new Uint8Array(size);
  b.set([0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b[8] = 2; b[9] = 8; b[10] = 8;
  return b;
}

function response(body, { status = 206, contentRange = null } = {}) {
  const headers = contentRange ? { 'content-range': contentRange } : {};
  return new Response(body, { status, headers });
}

// Record every request the reader makes, answering the probe as `probe` says and
// any later whole-object GET with a full (but still unparseable) file.
async function loadWith(probe) {
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    const range = (options.headers && options.headers.Range) || null;
    requests.push(range);
    if (range) return probe(range);
    return response(hdf5Bytes(HEAD_BYTES * 3), { status: 200 });
  };
  const error = await loadScene('goes19', 'meso1', 'key.nc', [13]).then(() => null, (e) => e);
  return { requests, error };
}

const realFetch = globalThis.fetch;
try {
  {
    // No readable Content-Range, and the body fills the probe window: the object
    // is larger than what we hold and there is no way to fault the rest in, so
    // the reader must fall back to downloading it whole.
    const { requests, error } = await loadWith(() => response(hdf5Bytes(HEAD_BYTES)));
    assert.equal(requests.length, 2, 'the probe should be followed by a whole-object download');
    assert.equal(requests[1], null, 'the fallback download must not carry a Range header');
    assert.doesNotMatch(String(error), /not loaded/,
      'a truncated file with no loader is exactly what the fallback exists to avoid');
  }

  {
    // A short body with no Content-Range really is the whole object. Downloading
    // it a second time would double the cost of every small file.
    const { requests } = await loadWith(() => response(hdf5Bytes(4096)));
    assert.equal(requests.length, 1, 'a body shorter than the probe window is complete');
  }

  {
    // The normal path: Content-Range gives the size, so the file is read by
    // range and the whole object is never downloaded.
    const { requests } = await loadWith(() =>
      response(hdf5Bytes(HEAD_BYTES), { contentRange: `bytes 0-${HEAD_BYTES - 1}/${HEAD_BYTES * 3}` }));
    assert.ok(requests.every((r) => r !== null), 'a sized 206 must not trigger a whole-object download');
  }
} finally {
  globalThis.fetch = realFetch;
}

console.log('goes tests passed');
