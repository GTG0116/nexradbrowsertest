// decoder.worker.js — runs the heavy bzip2 + Level II decode off the main
// thread so the UI (and the scope animation) stay responsive while a multi-MB
// volume is being decompressed and parsed.
//
// It receives the raw volume bytes, produces the elevation sweeps, and transfers
// the moment data buffers back to the page with zero copying.

import { parseLevel2, buildSweeps } from './level2.js';

async function gunzipIfNeeded(bytes) {
  if (!(bytes[0] === 0x1f && bytes[1] === 0x8b)) return bytes;
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('this browser cannot decompress gzip radar archives');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

self.onmessage = async (e) => {
  const { id, bytes } = e.data;
  try {
    const fileBytes = await gunzipIfNeeded(bytes);
    const volume = parseLevel2(fileBytes);
    const sweeps = buildSweeps(volume);

    // Strip the per-gate value() closures (not structured-cloneable) and gather
    // every moment's raw buffer so we can transfer instead of copy.
    const transfer = [];
    const slimSweeps = sweeps.map((sw) => ({
      elevationNumber: sw.elevationNumber,
      elevation: sw.elevation,
      time: sw.time,
      supportsSuperRes: sw.supportsSuperRes,
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
        return {
          azimuth: r.azimuth,
          elevation: r.elevation,
          azimuthResolution: r.azimuthResolution,
          messageType: r.messageType,
          nyquist: r.nyquist,
          moments,
        };
      }),
    }));

    self.postMessage(
      {
        id,
        ok: true,
        result: {
          icao: volume.icao,
          site: volume.site,
          messageType: volume.messageType,
          supportsSuperRes: volume.supportsSuperRes,
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
