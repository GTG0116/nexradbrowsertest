// decoder.worker.js — runs the heavy bzip2 + Level II decode off the main
// thread so the UI (and the scope animation) stay responsive while a multi-MB
// volume is being decompressed and parsed.
//
// It receives the raw volume bytes, produces the elevation sweeps, and transfers
// the moment data buffers back to the page with zero copying.

import { parseLevel2, buildSweeps } from './level2.js';

self.onmessage = (e) => {
  const { id, bytes } = e.data;
  try {
    const volume = parseLevel2(bytes);
    const sweeps = buildSweeps(volume);

    // Strip the per-gate value() closures (not structured-cloneable) and gather
    // every moment's raw buffer so we can transfer instead of copy.
    const transfer = [];
    const slimSweeps = sweeps.map((sw) => ({
      elevationNumber: sw.elevationNumber,
      elevation: sw.elevation,
      time: sw.time,
      moments: [...sw.moments],
      radials: sw.radials.map((r) => {
        const moments = {};
        for (const [name, m] of Object.entries(r.moments)) {
          transfer.push(m.raw.buffer);
          moments[name] = {
            gateCount: m.gateCount,
            firstGate: m.firstGate,
            gateSpacing: m.gateSpacing,
            scale: m.scale,
            offset: m.offset,
            raw: m.raw,
          };
        }
        return { azimuth: r.azimuth, elevation: r.elevation, nyquist: r.nyquist, moments };
      }),
    }));

    self.postMessage(
      {
        id,
        ok: true,
        result: {
          icao: volume.icao,
          site: volume.site,
          radialCount: volume.radials.length,
          sweeps: slimSweeps,
        },
      },
      transfer
    );
  } catch (err) {
    self.postMessage({ id, ok: false, error: err.message });
  }
};
