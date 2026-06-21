// grib2.js — a tiny GRIB2 reader for the MRMS products on AWS. MRMS grids are
// gzip-compressed GRIB2 on a plain lat/lon grid (Grid Definition Template 3.0),
// with the values packed as a grayscale PNG (Data Representation Template 5.41).
//
// We decode it all in pure JS: gunzip with the platform DecompressionStream, walk
// the GRIB2 sections, then decode the embedded PNG ourselves (so we keep full
// 16-bit precision — a <canvas> would clamp 16-bit grayscale to 8-bit). A simple
// (DRT 5.0) fallback is included for the products that aren't PNG-packed.

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
        default: v = rb;
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

// Decode a GRIB2 message (optionally gzipped) into a grid of physical values.
// For a plain lat/lon grid (GDT 3.0) returns
//   { proj:'latlon', ni, nj, lon1, lat1, di, dj, scanMode, values }
// For a Lambert Conformal grid (GDT 3.30, used by HRRR) returns
//   { proj:'lambert', ni, nj, la1, lo1, lov, lad, latin1, latin2, dx, dy,
//     shape, scanMode, values }
// `values` is a Float32Array in scan order, NaN where data is missing.
export async function decodeGrib2(input) {
  const b = await gunzip(input instanceof Uint8Array ? input : new Uint8Array(input));
  const dv = new DataView(b.buffer, b.byteOffset, b.length);
  if (String.fromCharCode(b[0], b[1], b[2], b[3]) !== 'GRIB') throw new Error('not GRIB2');

  let grid = null;
  let R = 0, E = 0, D = 0, bits = 0, drt = -1, npts = 0, p5 = 0;
  let dataSection = null;

  let p = 16; // after section 0
  while (p < b.length - 4) {
    if (String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]) === '7777') break;
    const len = dv.getUint32(p);
    const sec = b[p + 4];
    if (sec === 3) {
      const gdt = dv.getUint16(p + 12); // grid definition template number
      const ni = dv.getUint32(p + 30);
      const nj = dv.getUint32(p + 34);
      if (gdt === 30) {
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
      } else {
        // Plain lat/lon grid (GDT 3.0) — MRMS and similar.
        let lon1 = readSignMag(dv, p + 50, 4) / 1e6;
        if (lon1 > 180) lon1 -= 360;
        grid = {
          proj: 'latlon',
          ni, nj, lon1,
          lat1: readSignMag(dv, p + 46, 4) / 1e6,
          di: dv.getUint32(p + 63) / 1e6,
          dj: dv.getUint32(p + 67) / 1e6,
          scanMode: dv.getUint8(p + 71),
        };
      }
    } else if (sec === 5) {
      p5 = p;
      npts = dv.getUint32(p + 5);
      drt = dv.getUint16(p + 9);
      R = dv.getFloat32(p + 11);
      E = readSignMag(dv, p + 15, 2);
      D = readSignMag(dv, p + 17, 2);
      bits = b[p + 19];
    } else if (sec === 7) {
      dataSection = b.subarray(p + 5, p + len);
    }
    p += len;
  }
  if (!grid) throw new Error('GRIB2: no grid definition section');

  const scaleE = Math.pow(2, E);
  const scaleD = Math.pow(10, D);
  const values = new Float32Array(grid.ni * grid.nj);

  if (drt === 41 || drt === 40) {
    const { samples } = await decodePNG(dataSection);
    for (let i = 0; i < values.length; i++) values[i] = (R + samples[i] * scaleE) / scaleD;
  } else if (drt === 0) {
    // simple packing: big-endian bit field of `bits` per point.
    const br = new BitReader(dataSection);
    for (let i = 0; i < values.length; i++) {
      const X = bits === 0 ? 0 : br.read(bits);
      values[i] = (R + X * scaleE) / scaleD;
    }
  } else if (drt === 2 || drt === 3) {
    unpackComplex(dv, p5, dataSection, npts, R, scaleE, scaleD, drt, values);
  } else {
    throw new Error('unsupported GRIB2 data template ' + drt);
  }

  grid.values = values;
  return grid;
}
