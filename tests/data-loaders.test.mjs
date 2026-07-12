import assert from 'node:assert/strict';
import { loadModel } from '../js/models.js';
import { loadObservation } from '../js/observations.js';

function simpleGrib(value, missing = false) {
  const grid = new Uint8Array(72);
  const gd = new DataView(grid.buffer);
  gd.setUint32(0, grid.length); grid[4] = 3;
  gd.setUint16(12, 0); gd.setUint32(30, 1); gd.setUint32(34, 1);
  gd.setUint32(63, 1_000_000); gd.setUint32(67, 1_000_000);

  const s5 = new Uint8Array(21);
  const d5 = new DataView(s5.buffer);
  d5.setUint32(0, s5.length); s5[4] = 5;
  d5.setUint32(5, missing ? 0 : 1); d5.setUint16(9, 0); s5[19] = 8;

  const s6 = new Uint8Array(missing ? 7 : 6);
  new DataView(s6.buffer).setUint32(0, s6.length); s6[4] = 6;
  s6[5] = missing ? 0 : 255;

  const s7 = new Uint8Array(missing ? 5 : 6);
  new DataView(s7.buffer).setUint32(0, s7.length); s7[4] = 7;
  if (!missing) s7[5] = value;

  const length = 16 + grid.length + s5.length + s6.length + s7.length + 4;
  const out = new Uint8Array(length);
  out.set([71, 82, 73, 66], 0); out[7] = 2;
  new DataView(out.buffer).setBigUint64(8, BigInt(length));
  let offset = 16;
  for (const chunk of [grid, s5, s6, s7, Uint8Array.from([55, 55, 55, 55])]) {
    out.set(chunk, offset); offset += chunk.length;
  }
  return out;
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

const realFetch = globalThis.fetch;
try {
  const run = {
    dayStr: '20260712', cycle: 0,
    time: new Date(Date.UTC(2026, 6, 12)), fhours: [0, 1, 7], maxFhour: 7,
  };

  // A missing earlier accumulation must remain missing. Treating NaN as zero
  // paints a false positive six-hour precipitation/snow amount.
  for (const [product, variable] of [['QPF6', 'APCP'], ['SNOW6', 'WEASD']]) {
    globalThis.fetch = async (url) => {
      if (String(url).endsWith('.idx')) {
        return new Response(`1:0:d=2026071200:${variable}:surface:0-7 hour acc fcst:\n`);
      }
      const missing = String(url).includes('.f001');
      return new Response(simpleGrib(missing ? 0 : 10, missing), { status: 206 });
    };
    const grid = await loadModel('gfs', product, run, 7);
    assert.ok(Number.isNaN(grid.values[0]), `${product} should preserve a missing prior accumulation`);
  }

  // A server/proxy that ignores a closed Range must fail rather than feeding a
  // whole GRIB file to the single-field decoder and silently rendering field 1.
  globalThis.fetch = async (url) => String(url).endsWith('.idx')
    ? new Response('1:0:d=2026071200:APCP:surface:0-7 hour acc fcst:\n2:100:d=x:OTHER:surface:x:\n')
    : new Response(simpleGrib(10), { status: 200 });
  await assert.rejects(
    () => loadModel('gfs', 'QPF6', run, 7),
    /ignored the requested byte range/
  );

  // When the RTMA sidecar index is unavailable, fallback `record` numbers refer
  // to concatenated GRIB messages. The third record must decode as 42, not clamp
  // to the first message's only submessage.
  const rtma = concat(simpleGrib(1), simpleGrib(2), simpleGrib(42));
  globalThis.fetch = async (url) => String(url).endsWith('.idx')
    ? new Response('', { status: 404 })
    : new Response(rtma);
  const observation = await loadObservation(
    'TMP',
    'rtma2p5_ru.20260712/rtma2p5_ru.t0000z.2dvarges_ndfd.grb2'
  );
  assert.equal(observation.values[0], 42);
} finally {
  globalThis.fetch = realFetch;
}

