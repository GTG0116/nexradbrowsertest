// level2.js — NEXRAD WSR-88D "Archive II" (Level II) decoder.
//
// File layout (big-endian throughout):
//   [0..24)   Volume Header Record
//   then a sequence of LDM compressed records:
//       int32  controlWord  (|value| = byte length of the bzip2 block;
//                            a negative value marks the final record)
//       byte[] bzip2 stream (begins with "BZh")
//   Each decompressed record is a stream of messages. Every message is preceded
//   by a 12-byte legacy "CTM" header, followed by a 16-byte Message Header.
//   Most message types occupy a fixed 2432-byte slot. Modern digital radar data
//   uses Message Type 31 (variable length); pre-Build-10 archive volumes use the
//   fixed-size Message Type 1 layout instead.
//
// We decode both generations. Message 31 carries REF, VEL, SW, ZDR, PHI, RHO
// (and CFP); legacy Message 1 carries REF, VEL and SW. NCEI's historical `.gz`
// files are gunzipped in decoder.worker.js before they reach this parser.

import { decodeBzip2 } from './bzip2.js';

const RECORD_SIZE = 2432;
const CTM_HEADER = 12;
const MSG_HEADER = 16;

// Moment block names as they appear in the file.
export const MOMENTS = ['REF', 'VEL', 'SW', 'ZDR', 'PHI', 'RHO', 'CFP'];

class Reader {
  constructor(buffer) {
    this.dv = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    this.bytes = buffer;
  }
  u8(o) { return this.dv.getUint8(o); }
  i8(o) { return this.dv.getInt8(o); }
  u16(o) { return this.dv.getUint16(o); }
  i16(o) { return this.dv.getInt16(o); }
  u32(o) { return this.dv.getUint32(o); }
  i32(o) { return this.dv.getInt32(o); }
  f32(o) { return this.dv.getFloat32(o); }
  str(o, n) {
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.bytes[o + i]);
    return s;
  }
}

// Return the message stream while preserving its leading 12-byte CTM/compression
// record. Realtime Archive-II files contain bzip2-compressed LDM records, while
// NCEI historical files are already an uncompressed sequence of 2432-byte
// records after their outer gzip wrapper has been removed.
function inflateRecords(buffer) {
  if (buffer.length < 36) return new Uint8Array(0);

  // A realtime file starts at byte 24 with a four-byte LDM control word whose
  // payload begins "BZh". Historical NCEI files instead have their 12-byte
  // CTM/compression record here; passing that raw tail through gives the parser
  // the same leading-12-byte coordinate system used for realtime files.
  const ldmCompressed =
    buffer[28] === 0x42 && buffer[29] === 0x5a && buffer[30] === 0x68;
  if (!ldmCompressed) return buffer.subarray(24);

  const r = new Reader(buffer);
  const parts = [];
  let pos = 24; // skip the volume header record
  const len = buffer.length;

  while (pos + 4 <= len) {
    let size = r.i32(pos);
    pos += 4;
    if (size === 0) break;
    if (size < 0) size = -size; // negative size flags the last record
    if (pos + size > len) size = len - pos;

    const block = buffer.subarray(pos, pos + size);
    pos += size;

    // Compressed blocks start with "BZh"; if not, treat as raw (rare).
    if (block[0] === 0x42 && block[1] === 0x5a && block[2] === 0x68) {
      try {
        parts.push(decodeBzip2(block));
      } catch (e) {
        // Skip a corrupt trailing record rather than failing the whole volume.
        console.warn('skipping record:', e.message);
      }
    } else {
      parts.push(block);
    }
  }

  // Concatenate decompressed parts.
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

const LEGACY_ANGLE_SCALE = 180 / (4096 * 8);

// A moment block in legacy Message 1. The original codes use the same 0/1
// missing-value convention as Message 31, so the rest of the app can consume
// both generations through one moment contract.
function legacyMoment(r, dataStart, gateCount, firstGate, gateSpacing, scale, offset, limit) {
  if (!dataStart || gateCount <= 0 || dataStart >= limit) return null;
  const count = Math.min(gateCount, Math.max(0, limit - dataStart));
  if (!count) return null;
  const raw = new Uint8Array(count);
  raw.set(r.bytes.subarray(dataStart, dataStart + count));
  return {
    gateCount: count,
    firstGate,
    gateSpacing,
    scale,
    offset,
    raw,
    value(i) {
      const code = raw[i];
      return code < 2 ? NaN : (code - offset) / scale;
    },
  };
}

// Parse the pre-2008 fixed-layout Digital Radar Data message (Message Type 1).
// Offsets follow ROC ICD 2620002 Table III and are relative to the start of the
// Message-1 body (immediately after the ordinary 16-byte message header).
function parseMessage1(r, base, recordEnd) {
  const dopplerFirstRaw = r.u16(base + 20);
  const dopplerFirst = dopplerFirstRaw > 0x7fff ? dopplerFirstRaw - 0x10000 : dopplerFirstRaw;
  const reflectivityGates = r.u16(base + 26);
  const dopplerGates = r.u16(base + 28);
  const reflectivityPointer = r.u16(base + 36);
  const velocityPointer = r.u16(base + 38);
  const widthPointer = r.u16(base + 40);
  const velocityResolution = r.u16(base + 42);
  let elevation = r.u16(base + 14) * LEGACY_ANGLE_SCALE;
  if (elevation > 180) elevation -= 360;
  const radial = {
    collectTimeMs: r.u32(base),
    julianDate: r.u16(base + 4),
    unambiguousRange: r.i16(base + 6) * 100,
    azimuth: r.u16(base + 8) * LEGACY_ANGLE_SCALE,
    azimuthNumber: r.u16(base + 10),
    radialStatus: r.u16(base + 12),
    elevation,
    elevationNumber: r.u16(base + 16),
    cutSector: r.u16(base + 30),
    azimuthResolution: 2, // Message 1 is the native 1.0-degree legacy format.
    nyquist: r.i16(base + 60) * 0.01,
    messageType: 1,
    moments: {},
  };

  const ref = legacyMoment(
    r, base + reflectivityPointer, reflectivityGates,
    r.i16(base + 18), r.u16(base + 22), 2, 66, recordEnd
  );
  const vel = legacyMoment(
    r, base + velocityPointer, dopplerGates,
    dopplerFirst, r.u16(base + 24), velocityResolution === 4 ? 1 : 2, 129, recordEnd
  );
  const sw = legacyMoment(
    r, base + widthPointer, dopplerGates,
    dopplerFirst, r.u16(base + 24), 2, 129, recordEnd
  );
  if (ref) radial.moments.REF = ref;
  if (vel) radial.moments.VEL = vel;
  if (sw) radial.moments.SW = sw;
  return radial;
}

// Parse one Message 31 body (starting at the radar identifier) into a radial.
function parseMessage31(r, base, bodyLen) {
  const radial = {
    radarId: r.str(base, 4),
    collectTimeMs: r.u32(base + 4),
    julianDate: r.u16(base + 8),
    azimuthNumber: r.u16(base + 10),
    azimuth: r.f32(base + 12),
    compression: r.u8(base + 16),
    radialLength: r.u16(base + 18),
    azimuthResolution: r.u8(base + 20), // 1 => 0.5°, 2 => 1.0°
    radialStatus: r.u8(base + 21),
    elevationNumber: r.u8(base + 22),
    cutSector: r.u8(base + 23),
    elevation: r.f32(base + 24),
    spotBlanking: r.u8(base + 28),
    azimuthIndexing: r.u8(base + 29),
    blockCount: r.u16(base + 30),
    messageType: 31,
    moments: {},
  };

  const nBlocks = Math.min(radial.blockCount, 10);
  for (let b = 0; b < nBlocks; b++) {
    const ptr = r.u32(base + 32 + b * 4);
    if (ptr === 0 || ptr >= bodyLen) continue;
    const o = base + ptr;
    const blockType = String.fromCharCode(r.u8(o));
    const name = r.str(o + 1, 3).trim();

    if (blockType === 'D' && MOMENTS.includes(name)) {
      radial.moments[name] = parseMomentBlock(r, o);
    }
    // 'R'/'V' blocks (VOL/ELV/RAD) carry site metadata; capture site geometry.
    if (name === 'VOL') {
      radial.latitude = r.f32(o + 8);
      radial.longitude = r.f32(o + 12);
      radial.siteHeight = r.i16(o + 16);
    }
    // The RAD constant block carries the Nyquist (unambiguous) velocity, scaled
    // by 0.01 m/s — needed to unfold (dealias) the velocity moment.
    if (name === 'RAD') {
      radial.nyquist = r.u16(o + 16) * 0.01;
    }
  }
  if (radial.moments.PHI) radial.moments.KDP = deriveKdp(radial.moments.PHI);
  return radial;
}

// KDP is one half the range derivative of differential phase. A four-gate
// centred window damps gate noise while retaining storm-scale gradients.
export function deriveKdp(phi) {
  // Match the ordinary Level-II moment contract: codes 0/1 mean missing and
  // physical value = (code - offset) / scale. Keeping KDP in a Uint16Array
  // makes it transferable through decoder.worker.js and directly consumable
  // by the radar shader, renderer sampler, playback cache, and cross sections.
  const scale = 100;
  const offset = 10002; // code 2 represents -100.00 °/km
  const raw = new Uint16Array(phi.gateCount);
  const halfWindow = 4;
  const spanKm = (2 * halfWindow * phi.gateSpacing) / 1000;
  for (let i = halfWindow; i < phi.gateCount - halfWindow; i++) {
    const a = phi.value(i - halfWindow), b = phi.value(i + halfWindow);
    if (!Number.isFinite(a) || !Number.isFinite(b) || !spanKm) continue;
    let delta = b - a;
    while (delta > 180) delta -= 360;
    while (delta < -180) delta += 360;
    const value = 0.5 * delta / spanKm;
    raw[i] = Math.max(2, Math.min(65535, Math.round(value * scale + offset)));
  }
  return {
    gateCount:phi.gateCount, firstGate:phi.firstGate, gateSpacing:phi.gateSpacing,
    scale, offset, raw,
    value(i) {
      const code = raw[i];
      return code < 2 ? NaN : (code - offset) / scale;
    },
  };
}

// A moment data block (REF/VEL/SW/ZDR/PHI/RHO/CFP).
function parseMomentBlock(r, o) {
  const gateCount = r.u16(o + 8);
  const firstGate = r.i16(o + 10); // metres to centre of first gate
  const gateSpacing = r.u16(o + 12); // metres between gates
  const wordSize = r.u8(o + 19); // bits per gate (8 or 16)
  const scale = r.f32(o + 20);
  const offset = r.f32(o + 24);
  const dataStart = o + 28;

  // Decode raw codes into the narrowest typed array that fits the word size.
  // Most moments (REF/VEL/SW/ZDR/RHO…) are 8-bit; storing them as Uint8Array
  // instead of Uint16Array halves the resident size of every decoded volume,
  // which dominates the app's memory in radar mode. Consumers index `raw[i]`
  // generically, so the element type is transparent to them.
  let raw;
  if (wordSize === 16) {
    raw = new Uint16Array(gateCount);
    for (let i = 0; i < gateCount; i++) raw[i] = r.u16(dataStart + i * 2);
  } else {
    raw = new Uint8Array(gateCount);
    for (let i = 0; i < gateCount; i++) raw[i] = r.u8(dataStart + i);
  }

  return {
    gateCount,
    firstGate,
    gateSpacing,
    scale: scale || 1,
    offset,
    raw,
    // Physical value for a gate: NaN where there is no echo / range folding.
    // code 0 => below threshold, code 1 => range folded.
    value(i) {
      const c = raw[i];
      if (c < 2) return NaN;
      return (c - offset) / (scale || 1);
    },
  };
}

// Decode an entire Archive II file (Uint8Array) into a structured volume.
export function parseLevel2(fileBytes) {
  if (!(fileBytes instanceof Uint8Array)) fileBytes = new Uint8Array(fileBytes);
  if (fileBytes.length < 36) throw new Error('Level II file is too short');
  const header = new Reader(fileBytes);
  const volume = {
    version: header.str(0, 9),
    icao: header.str(20, 4),
    radials: [],
    site: null,
    messageType: null,
    supportsSuperRes: false,
  };

  const stream = inflateRecords(fileBytes);
  const r = new Reader(stream);
  const len = stream.length;
  let pos = 0;

  while (pos + CTM_HEADER + MSG_HEADER <= len) {
    const msgSize = r.u16(pos + CTM_HEADER); // halfwords
    // Message Header field offsets (relative to start of the 16-byte header):
    //   0 size (u16, halfwords)  2 channel (u8)  3 type (u8) ...
    const type = r.u8(pos + CTM_HEADER + 3);

    if (type === 31) {
      // Variable length: total record = 12 (CTM) + msgSize*2 bytes.
      const bodyBase = pos + CTM_HEADER + MSG_HEADER;
      const bodyLen = msgSize * 2 - MSG_HEADER;
      try {
        const radial = parseMessage31(r, bodyBase, bodyLen);
        if (radial.latitude !== undefined && !volume.site) {
          volume.site = {
            lat: radial.latitude,
            lon: radial.longitude,
            height: radial.siteHeight,
          };
        }
        volume.radials.push(radial);
      } catch (e) {
        // Tolerate a malformed radial.
      }
      // Variable advance; guard against a malformed zero-size message.
      pos += msgSize > 0 ? CTM_HEADER + msgSize * 2 : RECORD_SIZE;
    } else if (type === 1) {
      // Legacy Digital Radar Data occupies one fixed 2432-byte record. The
      // stream keeps its initial 12-byte CTM record, so `pos + 12` is the
      // ordinary message header and the body begins another 16 bytes later.
      const bodyBase = pos + CTM_HEADER + MSG_HEADER;
      const recordEnd = Math.min(len, pos + CTM_HEADER + RECORD_SIZE);
      try {
        const radial = parseMessage1(r, bodyBase, recordEnd);
        if (Object.keys(radial.moments).length) volume.radials.push(radial);
      } catch (_) {
        // Tolerate a malformed/truncated radial and continue with the volume.
      }
      pos += RECORD_SIZE;
    } else {
      pos += RECORD_SIZE;
    }
  }

  if (!volume.radials.length) throw new Error('Level II file contains no supported radial data');
  volume.messageType = volume.radials.some((r) => r.messageType === 31) ? 31 : 1;
  // Message 31 can contain both 0.5-degree super-resolution cuts and ordinary
  // 1-degree cuts. A single half-degree radial means the volume supports the
  // modern product; Message 1 is intrinsically legacy-only.
  volume.supportsSuperRes = volume.radials.some(
    (r) => r.messageType === 31 && r.azimuthResolution === 1
  );

  return volume;
}

// Group radials into elevation sweeps and index them by azimuth for fast
// rendering lookups. Returns an array of { elevationNumber, elevation, byMoment }.
export function buildSweeps(volume) {
  const sweeps = new Map();
  for (const rad of volume.radials) {
    const key = rad.elevationNumber;
    if (!sweeps.has(key)) {
      sweeps.set(key, {
        elevationNumber: rad.elevationNumber,
        elevation: rad.elevation,
        radials: [],
        moments: new Set(),
        supportsSuperRes: false,
      });
    }
    const sw = sweeps.get(key);
    sw.radials.push(rad);
    if (rad.azimuthResolution === 1) sw.supportsSuperRes = true;
    for (const m of Object.keys(rad.moments)) sw.moments.add(m);
  }
  const list = [...sweeps.values()].sort((a, b) => a.elevation - b.elevation);
  for (const sw of list) {
    sw.radials.sort((a, b) => a.azimuth - b.azimuth);
    // Collection time of the sweep (epoch ms). VCPs with SAILS revisit the
    // lowest tilt several times per volume, producing multiple sweeps at the
    // same elevation; this lets the viewer prefer the freshest of them.
    sw.time = radialTimeMs(sw.radials[0]);
  }
  return list;
}

// Epoch-ms timestamp of a radial. NEXRAD stores a 1-based "modified Julian
// date" (day 1 = 1970-01-01) plus milliseconds past UTC midnight.
function radialTimeMs(rad) {
  if (!rad || !rad.julianDate) return 0;
  return (rad.julianDate - 1) * 86400000 + (rad.collectTimeMs || 0);
}
