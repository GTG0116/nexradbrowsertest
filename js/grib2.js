// grib2.js — a tiny GRIB2 reader for the MRMS products on AWS. MRMS grids are
// gzip-compressed GRIB2 on a plain lat/lon grid (Grid Definition Template 3.0),
// with the values packed as a grayscale PNG (Data Representation Template 5.41).
//
// We decode it all in pure JS: gunzip with the platform DecompressionStream, walk
// the GRIB2 sections, then decode the embedded PNG ourselves (so we keep full
// 16-bit precision — a <canvas> would clamp 16-bit grayscale to 8-bit). A simple
// (DRT 5.0) fallback is included for the products that aren't PNG-packed.
//
// Model grids broaden the packing we have to read: HRRR/NAM/GFS use complex
// packing (DRT 5.2/5.3), RAP is JPEG2000-packed (DRT 5.40, decoded by jpx.js),
// and ECMWF open data (IFS/AIFS) is CCSDS/AEC-packed (DRT 5.42) — decoded by
// the pure-JS adaptive-entropy decoder below (unpackAEC).

import { decodeJ2K } from './jpx.js';

async function gunzip(bytes) {
  if (!(bytes[0] === 0x1f && bytes[1] === 0x8b)) return bytes; // not gzipped
  const ds = new DecompressionStream('gzip');
  const stream = new Response(bytes).body.pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function inflate(bytes) {
  const ds = new DecompressionStream('deflate');
  const stream = new Response(bytes).body.pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Decode a non-interlaced PNG to an array of integer sample values. GRIB2 DRT
// 5.41 packs the data as a grayscale PNG (colour type 0, bit depth 8 or 16) for
// ≤16-bit fields, but products needing more precision (e.g. lightning
// probability, 24 bits) are stored as an 8-bit RGB PNG (colour type 2) with the
// value spread across the R,G,B bytes — so we handle both. The returned typed
// array is sized to the field's bit depth (Uint8/Uint16/Uint32).
async function decodePNG(png) {
  if (png.length < 33 || png[0] !== 0x89 || png[1] !== 0x50 || png[2] !== 0x4e || png[3] !== 0x47) {
    throw new Error('invalid PNG in GRIB2');
  }
  const dv = new DataView(png.buffer, png.byteOffset, png.length);
  const W = dv.getUint32(16);
  const H = dv.getUint32(20);
  const bitDepth = png[24];
  const colorType = png[25];
  const interlace = png[28];
  if (interlace !== 0) throw new Error('unsupported interlaced PNG in GRIB2');
  // Samples per pixel: grayscale (0) → 1, truecolour RGB (2) → 3.
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : 0;
  if (!channels) throw new Error('unsupported PNG colour type ' + colorType + ' in GRIB2');
  if (!W || !H || (bitDepth !== 8 && !(colorType === 0 && bitDepth === 16))) {
    throw new Error(`unsupported PNG dimensions/bit depth ${W}x${H}/${bitDepth} in GRIB2`);
  }

  // concatenate IDAT chunks
  const idat = [];
  let p = 8;
  while (p < png.length) {
    const len = dv.getUint32(p);
    const type = String.fromCharCode(png[p + 4], png[p + 5], png[p + 6], png[p + 7]);
    if (type === 'IDAT') idat.push(png.subarray(p + 8, p + 8 + len));
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  let total = 0;
  for (const c of idat) total += c.length;
  const comp = new Uint8Array(total);
  let off = 0;
  for (const c of idat) { comp.set(c, off); off += c.length; }
  const raw = await inflate(comp);

  const bpp = (bitDepth / 8) * channels; // bytes per pixel (filter unit)
  const stride = W * bpp;
  if (raw.length !== H * (stride + 1)) throw new Error('truncated PNG scan data in GRIB2');
  // Output values can be 8-bit (gray-8), 16-bit (gray-16) or 24-bit (RGB-8).
  const bitsPerValue = colorType === 2 ? channels * bitDepth : bitDepth;
  const out = bitsPerValue <= 8 ? new Uint8Array(W * H)
    : bitsPerValue <= 16 ? new Uint16Array(W * H)
    : new Uint32Array(W * H);
  const cur = new Uint8Array(stride);
  const prev = new Uint8Array(stride);
  let ip = 0;
  const paeth = (a, b, c) => {
    const pp = a + b - c;
    const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < H; y++) {
    const ft = raw[ip++];
    for (let x = 0; x < stride; x++) {
      const rb = raw[ip++];
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v;
      switch (ft) {
        case 0: v = rb; break;
        case 1: v = rb + a; break;
        case 2: v = rb + b; break;
        case 3: v = rb + ((a + b) >> 1); break;
        case 4: v = rb + paeth(a, b, c); break;
        default: throw new Error(`unsupported PNG filter ${ft} in GRIB2`);
      }
      cur[x] = v & 255;
    }
    const row = y * W;
    if (colorType === 2) {
      // RGB-8: reconstruct the value big-endian across the three bytes.
      for (let x = 0; x < W; x++)
        out[row + x] = (cur[x * 3] << 16) | (cur[x * 3 + 1] << 8) | cur[x * 3 + 2];
    } else if (bitDepth === 16) {
      for (let x = 0; x < W; x++) out[row + x] = (cur[x * 2] << 8) | cur[x * 2 + 1];
    } else {
      for (let x = 0; x < W; x++) out[row + x] = cur[x];
    }
    prev.set(cur);
  }
  return { W, H, samples: out };
}

// GRIB2 stores signed integers in sign-magnitude form (the high bit is the sign,
// the remaining bits the magnitude) — NOT two's complement. So a raw 0x8004 in a
// 16-bit field is −4, not −32764. Every signed template value goes through here.
function signMag(raw, nbits) {
  const signBit = 1 << (nbits - 1);
  return raw & signBit ? -(raw & (signBit - 1)) : raw;
}
function readSignMag(dv, off, nbytes) {
  let raw = 0;
  for (let k = 0; k < nbytes; k++) raw = raw * 256 + dv.getUint8(off + k);
  return signMag(raw, nbytes * 8);
}

// A continuous MSB-first bit reader over a byte buffer, used by the complex
// packing decoder. `align()` advances to the next byte boundary — NCEP's encoder
// byte-aligns the group-reference, group-width and group-length sub-arrays.
class BitReader {
  constructor(buf) { this.buf = buf; this.pos = 0; }
  read(nbits) {
    if (!Number.isInteger(nbits) || nbits < 0 || nbits > 32) {
      throw new Error(`GRIB2: invalid packed bit width ${nbits}`);
    }
    if (this.pos + nbits > this.buf.length * 8) {
      throw new Error('GRIB2: truncated packed data');
    }
    let v = 0, pos = this.pos;
    const buf = this.buf;
    for (let k = 0; k < nbits; k++) {
      v = v * 2 + ((buf[pos >> 3] >> (7 - (pos & 7))) & 1);
      pos++;
    }
    this.pos = pos;
    return v;
  }
  readSigned(nbits) { return signMag(this.read(nbits), nbits); }
  align() { if (this.pos & 7) this.pos = (this.pos + 7) & ~7; }
}

// Complex packing (DRT 5.2) and complex packing with spatial differencing
// (DRT 5.3) — the NCEP scheme used by HRRR and most other model output. The
// field is split into NG groups; each group carries its own reference value and
// bit width, and (for 5.3) the values are 1st- or 2nd-order spatial differences
// that we integrate back. Decodes straight into the destination `values` array.
function unpackComplex(dv, p5, dataSection, npts, R, scaleE, scaleD, drt, values) {
  const g32 = (o) => dv.getUint32(p5 + o);
  const nbitsRef = dv.getUint8(p5 + 19);          // bits per group reference value
  const ng = g32(31);                             // number of groups
  const refGW = dv.getUint8(p5 + 35);             // group-width reference
  const bitsGW = dv.getUint8(p5 + 36);            // bits per group width
  const refGL = g32(37);                          // group-length reference
  const incGL = dv.getUint8(p5 + 41);             // group-length increment
  const lastGL = g32(42);                         // true length of the last group
  const bitsGL = dv.getUint8(p5 + 46);            // bits per scaled group length
  const order = drt === 3 ? dv.getUint8(p5 + 47) : 0;       // spatial-diff order
  const nbytesd = drt === 3 ? dv.getUint8(p5 + 48) : 0;     // octets per extra descriptor

  if (!ng) throw new Error('GRIB2: complex packing has no groups');
  if (drt === 3 && order !== 1 && order !== 2) {
    throw new Error(`GRIB2: unsupported spatial differencing order ${order}`);
  }

  const br = new BitReader(dataSection);

  // Spatial-differencing extras come first: the first `order` field values, then
  // the overall minimum of the differences — each a sign-magnitude integer.
  let ival1 = 0, ival2 = 0, minsd = 0;
  if (drt === 3 && nbytesd > 0) {
    const nbitsd = nbytesd * 8;
    ival1 = br.readSigned(nbitsd);
    if (order === 2) ival2 = br.readSigned(nbitsd);
    minsd = br.readSigned(nbitsd);
  }

  // Group references, then widths, then lengths — each sub-array byte-aligned.
  const refs = new Int32Array(ng);
  for (let i = 0; i < ng; i++) refs[i] = br.read(nbitsRef);
  br.align();
  const widths = new Int32Array(ng);
  for (let i = 0; i < ng; i++) widths[i] = refGW + (bitsGW ? br.read(bitsGW) : 0);
  br.align();
  const lengths = new Int32Array(ng);
  for (let i = 0; i < ng; i++) lengths[i] = refGL + (bitsGL ? br.read(bitsGL) : 0) * incGL;
  lengths[ng - 1] = lastGL;
  br.align();

  // The packed values: each group contributes `length` values of `width` bits,
  // each offset by the group reference. A zero-width group is a run of its ref.
  const X = new Float64Array(npts);
  let k = 0;
  for (let gi = 0; gi < ng; gi++) {
    const w = widths[gi], L = lengths[gi], ref = refs[gi];
    if (w === 0) {
      for (let n = 0; n < L && k < npts; n++) X[k++] = ref;
    } else {
      for (let n = 0; n < L && k < npts; n++) X[k++] = ref + br.read(w);
    }
  }
  if (k !== npts) throw new Error(`GRIB2: complex packing produced ${k}/${npts} values`);

  // Undo the spatial differencing, then scale to physical units.
  if (drt === 3) {
    if (order === 1) {
      X[0] = ival1;
      for (let n = 1; n < npts; n++) X[n] = X[n] + minsd + X[n - 1];
    } else if (order === 2) {
      X[0] = ival1; X[1] = ival2;
      for (let n = 2; n < npts; n++) X[n] = X[n] + minsd + 2 * X[n - 1] - X[n - 2];
    }
  }
  for (let n = 0; n < npts; n++) values[n] = (R + X[n] * scaleE) / scaleD;
}

// ---------------------------------------------------------------------------
// CCSDS 121.0-B adaptive entropy (Rice) decoding — GRIB2 DRT 5.42, the packing
// ECMWF's open-data GRIB2 uses. The compressed stream is a sequence of coded
// data sets (CDS), each covering one block of samples; every reference-sample
// interval (RSI) restarts the unit-delay preprocessor with a raw sample.
// Follows the CCSDS spec, cross-checked against libaec's decoder semantics.
//   flags: bit0 signed, bit1 3-byte, bit2 MSB, bit3 preprocess, bit4 restricted
// GRIB fields are unsigned, so only the unsigned preprocessor restore is
// implemented (signed data throws).
function unpackAEC(dataSection, npts, bits, flags, blockSize, rsi) {
  if (flags & 1) throw new Error('AEC: signed data not supported');
  if (!blockSize || !rsi) throw new Error('AEC: invalid block size or reference interval');
  const pp = !!(flags & 8);
  const padRsi = !!(flags & 32);
  // Option-ID field length by sample resolution (libaec aec_decode_init).
  let idLen;
  if (bits > 16) idLen = 5;
  else if (bits > 8) idLen = 4;
  else if (flags & 16) idLen = bits <= 2 ? 1 : 2; // restricted low-resolution modes
  else idLen = 3;
  const uncompId = (1 << idLen) - 1;
  const xmax = bits >= 31 ? 0xffffffff >>> (32 - bits) : (1 << bits) - 1;

  // Second-extension lookup: gamma → (fs level i, cumulative start ms).
  const seTable = new Int32Array(2 * 92);
  for (let i = 0, k = 0; i < 13; i++) {
    const ms = k;
    for (let j = 0; j <= i; j++) { seTable[2 * k] = i; seTable[2 * k + 1] = ms; k++; }
  }

  // MSB-first reader with at most one byte buffered. This avoids both silent
  // zero-padding at EOF and 32-bit accumulator overflow on wide, unaligned reads.
  const buf = dataSection;
  const len = buf.length;
  let pos = 0, acc = 0, accBits = 0;
  const readBits = (count) => {
    if (!Number.isInteger(count) || count < 0 || count > 32) {
      throw new Error(`AEC: invalid bit width ${count}`);
    }
    let value = 0;
    while (count > 0) {
      if (!accBits) {
        if (pos >= len) throw new Error('AEC: truncated stream');
        acc = buf[pos++];
        accBits = 8;
      }
      const take = Math.min(count, accBits);
      const shift = accBits - take;
      value = value * Math.pow(2, take) + ((acc >>> shift) & ((1 << take) - 1));
      accBits -= take;
      count -= take;
    }
    return value >>> 0;
  };
  // Fundamental sequence (unary): count zeros up to the terminating 1.
  const readFS = () => {
    let fs = 0;
    for (;;) {
      if (accBits === 0) {
        if (pos >= len) throw new Error('AEC: truncated stream');
        acc = buf[pos++]; accBits = 8;
      }
      accBits--;
      if ((acc >>> accBits) & 1) return fs;
      fs++;
    }
  };
  // Byte-align the reader (used before each padded RSI): discard the fractional
  // bits so the next read starts on a byte boundary.
  const alignByte = () => { accBits = 0; };

  const out = new Uint32Array(npts);
  const rsiSize = rsi * blockSize;
  let n = 0; // samples decoded so far

  while (n < npts) {
    // ---- one reference sample interval ----
    const rsiStart = n;
    const rsiEnd = Math.min(npts, rsiStart + rsiSize);
    if (padRsi && rsiStart > 0) alignByte();
    let firstBlock = true;
    while (n < rsiEnd) {
      const ref = pp && firstBlock ? 1 : 0;
      const encLen = blockSize - ref;
      const id = readBits(idLen);
      if (id === 0) {
        // Low-entropy options, discriminated by one extra bit.
        const se = readBits(1);
        if (ref) out[n++] = readBits(bits);
        if (se) {
          // Second extension: FS codes decode to pairs of samples.
          for (let i = ref; i < blockSize && n < rsiEnd; ) {
            const m = readFS();
            if (m > 90) throw new Error('AEC: bad second-extension code');
            const d1 = m - seTable[2 * m + 1];
            if ((i & 1) === 0) { out[n++] = seTable[2 * m] - d1; i++; if (n >= rsiEnd) break; }
            out[n++] = d1; i++;
          }
        } else {
          // Zero block(s): FS value = run of all-zero blocks; 5 = rest of the
          // 64-block segment, >5 shifted down by one.
          let zb = readFS() + 1;
          if (zb === 5) {
            const b = Math.floor((n - rsiStart + ref) / blockSize);
            zb = Math.min(rsi - b, 64 - (b % 64));
          } else if (zb > 5) {
            zb--;
          }
          let zs = zb * blockSize - ref;
          while (zs-- > 0 && n < rsiEnd) out[n++] = 0;
        }
      } else if (id === uncompId) {
        for (let i = 0; i < blockSize && n < rsiEnd; i++) out[n++] = readBits(bits);
      } else {
        // Sample splitting: FS of the high parts, then k-bit remainders.
        const k = id - 1;
        if (ref) out[n++] = readBits(bits);
        const base = n;
        const cnt = Math.min(encLen, rsiEnd - n);
        const pk = k < 31 ? (1 << k) : Math.pow(2, k); // hoisted out of the sample loop
        for (let i = 0; i < encLen; i++) {
          const fs = readFS();
          if (i < cnt) out[base + i] = fs * pk;
        }
        if (k) for (let i = 0; i < encLen; i++) {
          const r = readBits(k);
          if (i < cnt) out[base + i] += r;
        }
        n = base + cnt;
      }
      firstBlock = false;
    }

    // ---- undo the unit-delay preprocessor over this RSI (unsigned restore) ----
    if (pp && rsiEnd > rsiStart) {
      const med = Math.floor(xmax / 2) + 1;
      let data = out[rsiStart]; // reference sample passes through unmapped
      for (let i = rsiStart + 1; i < rsiEnd; i++) {
        const d = out[i];
        const halfD = ((d >>> 1) + (d & 1)) >>> 0;
        const mask = data & med ? xmax : 0;
        // In range, the mapped delta unfolds to ±⌈d/2⌉ around the predictor;
        // out of range it saturates against whichever bound is nearer.
        if (halfD <= ((mask ^ data) >>> 0)) {
          data = d & 1 ? data - ((d >>> 1) + 1) : data + (d >>> 1);
        } else {
          data = (mask ^ d) >>> 0;
        }
        out[i] = data;
      }
    }
  }
  return out;
}

// Decode a GRIB2 message (optionally gzipped) into a grid of physical values.
// For a plain lat/lon grid (GDT 3.0) returns
//   { proj:'latlon', ni, nj, lon1, lat1, di, dj, scanMode, values }
// For a Lambert Conformal grid (GDT 3.30, used by HRRR) returns
//   { proj:'lambert', ni, nj, la1, lo1, lov, lad, latin1, latin2, dx, dy,
//     shape, scanMode, values }
// `values` is a Float32Array in scan order, NaN where data is missing.
//
// A single GRIB2 message can pack several fields (submessages) that share one
// grid definition — NCEP does this for paired components like UGRD/VGRD. Pass
// `sub` (0-based) to choose which field to decode; it defaults to the first.
export async function decodeGrib2(input, sub = 0) {
  const b = await gunzip(input instanceof Uint8Array ? input : new Uint8Array(input));
  if (b.length < 20) throw new Error('GRIB2: message is too short');
  const dv = new DataView(b.buffer, b.byteOffset, b.length);
  if (String.fromCharCode(b[0], b[1], b[2], b[3]) !== 'GRIB') throw new Error('not GRIB2');
  if (b[7] !== 2) throw new Error(`unsupported GRIB edition ${b[7]}`);

  let grid = null;
  // Each completed data section (section 7) closes one field; we collect the
  // packing parameters of every field so the requested submessage can be picked.
  const fields = [];
  let R = 0, E = 0, D = 0, bits = 0, drt = -1, npts = 0, p5 = 0;
  let bitmapIndicator = 255, bitmapSection = null, previousBitmap = null;

  let p = 16; // after section 0
  let sawEnd = false;
  while (p <= b.length - 4) {
    if (String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]) === '7777') {
      sawEnd = true;
      break;
    }
    if (p + 5 > b.length) throw new Error('GRIB2: truncated section header');
    const len = dv.getUint32(p);
    if (len < 5 || p + len > b.length) {
      throw new Error(`GRIB2: invalid section length ${len}`);
    }
    const sec = b[p + 4];
    if (sec === 3) {
      if (len < 72) throw new Error('GRIB2: truncated grid definition section');
      const gdt = dv.getUint16(p + 12); // grid definition template number
      const ni = dv.getUint32(p + 30);
      const nj = dv.getUint32(p + 34);
      if (gdt === 30) {
        if (len < 73) throw new Error('GRIB2: truncated Lambert grid definition');
        // Lambert Conformal Conic (HRRR & most NCEP CONUS model grids).
        grid = {
          proj: 'lambert',
          ni, nj,
          shape: dv.getUint8(p + 14),
          la1: readSignMag(dv, p + 38, 4) / 1e6,
          lo1: readSignMag(dv, p + 42, 4) / 1e6,
          lad: readSignMag(dv, p + 47, 4) / 1e6,
          lov: readSignMag(dv, p + 51, 4) / 1e6,
          dx: dv.getUint32(p + 55) / 1e3,   // metres
          dy: dv.getUint32(p + 59) / 1e3,
          scanMode: dv.getUint8(p + 64),
          latin1: readSignMag(dv, p + 65, 4) / 1e6,
          latin2: readSignMag(dv, p + 69, 4) / 1e6,
        };
        if (grid.lo1 > 180) grid.lo1 -= 360;
        if (grid.lov > 180) grid.lov -= 360;
      } else if (gdt === 0) {
        // Plain lat/lon grid (GDT 3.0) — MRMS and similar. ECMWF grids start at
        // exactly 180°E — the same meridian as −180°, so relabelling keeps the
        // column order intact while placing the grid on the −180…180 map.
        let lon1 = readSignMag(dv, p + 50, 4) / 1e6;
        if (lon1 >= 180) lon1 -= 360;
        grid = {
          proj: 'latlon',
          ni, nj, lon1,
          lat1: readSignMag(dv, p + 46, 4) / 1e6,
          di: dv.getUint32(p + 63) / 1e6,
          dj: dv.getUint32(p + 67) / 1e6,
          scanMode: dv.getUint8(p + 71),
        };
      } else {
        throw new Error(`unsupported GRIB2 grid template ${gdt}`);
      }
    } else if (sec === 5) {
      if (len < 21) throw new Error('GRIB2: truncated data representation section');
      p5 = p;
      npts = dv.getUint32(p + 5);
      drt = dv.getUint16(p + 9);
      const minDrtLength = drt === 2 ? 47 : drt === 3 ? 49 : drt === 42 ? 25 : 21;
      if (len < minDrtLength) throw new Error(`GRIB2: truncated data template ${drt}`);
      R = dv.getFloat32(p + 11);
      E = readSignMag(dv, p + 15, 2);
      D = readSignMag(dv, p + 17, 2);
      bits = b[p + 19];
      // Reset bitmap state for this field; its section 6 (always present) sets it.
      bitmapIndicator = 255; bitmapSection = null;
    } else if (sec === 6) {
      if (len < 6) throw new Error('GRIB2: truncated bitmap section');
      // Bitmap section: octet 6 is the indicator (0 = bitmap present in this
      // section, 255 = none). When present, only the unmasked grid points are
      // encoded in section 7, so the decoded values must be scattered back out.
      bitmapIndicator = b[p + 5];
      if (bitmapIndicator === 0) {
        bitmapSection = b.subarray(p + 6, p + len);
        previousBitmap = bitmapSection;
      } else if (bitmapIndicator === 254) {
        if (!previousBitmap) throw new Error('GRIB2: bitmap reuse requested before a bitmap was defined');
        bitmapSection = previousBitmap;
      } else if (bitmapIndicator === 255) {
        bitmapSection = null;
      } else {
        throw new Error(`unsupported GRIB2 predefined bitmap ${bitmapIndicator}`);
      }
    } else if (sec === 7) {
      if (!p5) throw new Error('GRIB2: data section appeared before its representation section');
      // Close this field with the packing parameters seen since the last one.
      fields.push({ p5, npts, drt, R, E, D, bits, bitmapIndicator, bitmapSection, dataSection: b.subarray(p + 5, p + len) });
    }
    p += len;
  }
  if (!sawEnd) throw new Error('GRIB2: missing end marker');
  if (!grid) throw new Error('GRIB2: no grid definition section');
  if (!fields.length) throw new Error('GRIB2: no data section');

  // Pick the requested submessage. Returning the last field for an invalid
  // index silently renders a different meteorological variable, so fail loudly.
  if (!Number.isInteger(sub) || sub < 0 || sub >= fields.length) {
    throw new Error(`GRIB2: submessage ${sub} is out of range (found ${fields.length})`);
  }
  const f = fields[sub];
  ({ p5, npts, drt, R, E, D, bits } = f);
  const dataSection = f.dataSection;

  const scaleE = Math.pow(2, E);
  // Guard against a pathological decimal-scale exponent underflowing to 0, which
  // would make every unpacked value Infinity/NaN.
  const scaleD = Math.pow(10, D) || 1;
  const total = grid.ni * grid.nj;
  // With a bitmap, section 7 holds only the `npts` unmasked points; decode those,
  // then scatter into the full grid below. Without one, npts === total and the
  // decoded array *is* the grid.
  const bitmap = f.bitmapSection;
  if (bitmap && bitmap.length * 8 < total) throw new Error('GRIB2: truncated bitmap');
  let represented = total;
  if (bitmap) {
    represented = 0;
    for (let i = 0; i < total; i++) represented += (bitmap[i >> 3] >> (7 - (i & 7))) & 1;
  }
  if (npts !== represented) {
    throw new Error(`GRIB2: point count ${npts} does not match the grid/bitmap (${represented})`);
  }
  const decoded = new Float32Array(bitmap ? npts : total);

  if (drt === 41) {
    const { samples } = await decodePNG(dataSection);
    if (samples.length !== decoded.length) throw new Error('GRIB2: PNG sample count does not match the field');
    for (let i = 0; i < decoded.length; i++) decoded[i] = (R + samples[i] * scaleE) / scaleD;
  } else if (drt === 40) {
    // JPEG2000 (RAP). decodeJ2K returns integer samples in raster order.
    const { samples } = decodeJ2K(dataSection);
    if (samples.length !== decoded.length) throw new Error('GRIB2: JPEG2000 sample count does not match the field');
    for (let i = 0; i < decoded.length; i++) decoded[i] = (R + samples[i] * scaleE) / scaleD;
  } else if (drt === 0) {
    // simple packing: big-endian bit field of `bits` per point.
    const br = new BitReader(dataSection);
    for (let i = 0; i < decoded.length; i++) {
      const X = bits === 0 ? 0 : br.read(bits);
      decoded[i] = (R + X * scaleE) / scaleD;
    }
  } else if (drt === 2 || drt === 3) {
    unpackComplex(dv, p5, dataSection, npts, R, scaleE, scaleD, drt, decoded);
  } else if (drt === 42) {
    // CCSDS/AEC (ECMWF open data). Template 5.42 adds the CCSDS parameters
    // after the standard packing octets: flags, block size, reference sample
    // interval.
    const flags = b[p5 + 21];
    const blockSize = b[p5 + 22];
    const rsi = dv.getUint16(p5 + 23);
    if (bits === 0) {
      for (let i = 0; i < decoded.length; i++) decoded[i] = R / scaleD;
    } else {
      const samples = unpackAEC(dataSection, decoded.length, bits, flags, blockSize, rsi);
      for (let i = 0; i < decoded.length; i++) decoded[i] = (R + samples[i] * scaleE) / scaleD;
    }
  } else {
    throw new Error('unsupported GRIB2 data template ' + drt);
  }

  let values;
  if (bitmap) {
    // Scatter the decoded points into the full grid in scan order: a set bit
    // (MSB-first) consumes the next decoded value, a clear bit is a missing point
    // (NaN → transparent). Skipping this leaves every point after the first
    // masked one shifted, which shears the field into horizontal streaks.
    values = new Float32Array(total);
    let src = 0;
    for (let i = 0; i < total; i++) {
      values[i] = (bitmap[i >> 3] >> (7 - (i & 7))) & 1 ? decoded[src++] : NaN;
    }
  } else {
    values = decoded;
  }

  grid.values = values;
  return grid;
}
