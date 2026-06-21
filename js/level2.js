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
//   Most message types occupy a fixed 2432-byte slot; the digital radar data we
//   care about is Message Type 31, which is variable length.
//
// We only fully decode Message 31 (the generic "digital radar data" message),
// which carries the moment data: REF, VEL, SW, ZDR, PHI, RHO (and CFP).

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

// Decompress all LDM records and concatenate the message stream.
function inflateRecords(buffer) {
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
  return radial;
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

  // Decode raw codes to physical units lazily-friendly typed arrays.
  const raw = new Uint16Array(gateCount);
  if (wordSize === 16) {
    for (let i = 0; i < gateCount; i++) raw[i] = r.u16(dataStart + i * 2);
  } else {
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
  const header = new Reader(fileBytes);
  const volume = {
    version: header.str(0, 9),
    icao: header.str(20, 4),
    radials: [],
    site: null,
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
    } else {
      pos += RECORD_SIZE;
    }
  }

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
      });
    }
    const sw = sweeps.get(key);
    sw.radials.push(rad);
    for (const m of Object.keys(rad.moments)) sw.moments.add(m);
  }
  const list = [...sweeps.values()].sort((a, b) => a.elevation - b.elevation);
  for (const sw of list) sw.radials.sort((a, b) => a.azimuth - b.azimuth);
  return list;
}
