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

// Decode a GRIB2 message (optionally gzipped) into a lat/lon grid of physical
// values. Returns { ni, nj, lon1, lat1, di, dj, scanMode, values: Float32Array }
// with missing entries set to NaN.
export async function decodeGrib2(input) {
  const b = await gunzip(input instanceof Uint8Array ? input : new Uint8Array(input));
  const dv = new DataView(b.buffer, b.byteOffset, b.length);
  if (String.fromCharCode(b[0], b[1], b[2], b[3]) !== 'GRIB') throw new Error('not GRIB2');

  let ni = 0, nj = 0, lon1 = 0, lat1 = 0, di = 0, dj = 0, scanMode = 0;
  let R = 0, E = 0, D = 0, bits = 0, drt = -1, npts = 0;
  let dataSection = null;

  let p = 16; // after section 0
  while (p < b.length - 4) {
    if (String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]) === '7777') break;
    const len = dv.getUint32(p);
    const sec = b[p + 4];
    if (sec === 3) {
      ni = dv.getUint32(p + 30);
      nj = dv.getUint32(p + 34);
      lat1 = dv.getInt32(p + 46) / 1e6;
      lon1 = dv.getInt32(p + 50) / 1e6;
      if (lon1 > 180) lon1 -= 360;
      di = dv.getUint32(p + 63) / 1e6;
      dj = dv.getUint32(p + 67) / 1e6;
      scanMode = b[p + 71];
    } else if (sec === 5) {
      npts = dv.getUint32(p + 5);
      drt = dv.getUint16(p + 9);
      R = dv.getFloat32(p + 11);
      E = dv.getInt16(p + 15);
      D = dv.getInt16(p + 17);
      bits = b[p + 19];
    } else if (sec === 7) {
      dataSection = b.subarray(p + 5, p + len);
    }
    p += len;
  }

  const scaleE = Math.pow(2, E);
  const scaleD = Math.pow(10, D);
  const values = new Float32Array(ni * nj);

  if (drt === 41 || drt === 40) {
    const { samples } = await decodePNG(dataSection);
    for (let i = 0; i < values.length; i++) {
      const Y = (R + samples[i] * scaleE) / scaleD;
      values[i] = Y;
    }
  } else if (drt === 0) {
    // simple packing: big-endian bit field of `bits` per point.
    const data = dataSection;
    let bitPos = 0;
    const read = (nbits) => {
      let v = 0;
      for (let k = 0; k < nbits; k++) {
        const byte = data[(bitPos >> 3)];
        const bit = (byte >> (7 - (bitPos & 7))) & 1;
        v = (v << 1) | bit;
        bitPos++;
      }
      return v;
    };
    for (let i = 0; i < values.length; i++) {
      const X = bits === 0 ? 0 : read(bits);
      values[i] = (R + X * scaleE) / scaleD;
    }
  } else {
    throw new Error('unsupported GRIB2 data template ' + drt);
  }

  return { ni, nj, lon1, lat1, di, dj, scanMode, values };
}
