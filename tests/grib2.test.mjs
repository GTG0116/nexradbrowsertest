import assert from 'node:assert/strict';
import { decodeGrib2 } from '../js/grib2.js';

function section3({ ni = 2, nj = 2, gdt = 0 } = {}) {
  const out = new Uint8Array(72);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, out.length);
  out[4] = 3;
  dv.setUint16(12, gdt);
  dv.setUint32(30, ni);
  dv.setUint32(34, nj);
  dv.setUint32(63, 1_000_000);
  dv.setUint32(67, 1_000_000);
  return out;
}

function simpleField(values, { npts = values.length, bits = 8, bitmap = null, bitmapIndicator } = {}) {
  const s5 = new Uint8Array(21);
  const d5 = new DataView(s5.buffer);
  d5.setUint32(0, s5.length);
  s5[4] = 5;
  d5.setUint32(5, npts);
  d5.setUint16(9, 0); // Data Representation Template 5.0 (simple packing)
  d5.setFloat32(11, 0);
  s5[19] = bits;

  const bitmapBytes = bitmap || new Uint8Array(0);
  const s6 = new Uint8Array(6 + bitmapBytes.length);
  const d6 = new DataView(s6.buffer);
  d6.setUint32(0, s6.length);
  s6[4] = 6;
  s6[5] = bitmapIndicator ?? (bitmap ? 0 : 255);
  s6.set(bitmapBytes, 6);

  const data = Uint8Array.from(values);
  const s7 = new Uint8Array(5 + data.length);
  new DataView(s7.buffer).setUint32(0, s7.length);
  s7[4] = 7;
  s7.set(data, 5);
  return [s5, s6, s7];
}

function message(fields, grid = section3()) {
  const chunks = [new Uint8Array(16), grid, ...fields.flat(), Uint8Array.from([55, 55, 55, 55])];
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(length);
  out.set([71, 82, 73, 66], 0); // GRIB
  out[7] = 2;
  new DataView(out.buffer).setBigUint64(8, BigInt(length));
  let offset = 16;
  for (const chunk of chunks.slice(1)) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

{
  const grid = await decodeGrib2(message([simpleField([1, 2, 3, 4])]));
  assert.deepEqual([...grid.values], [1, 2, 3, 4]);
}

{
  // Indicator 254 reuses the preceding field's bitmap. This occurs in legal
  // multi-field GRIB messages and must not shift later values across the grid.
  const bitmap = Uint8Array.from([0b10110000]);
  const bytes = message([
    simpleField([1, 2, 3], { npts: 3, bitmap }),
    simpleField([4, 5, 6], { npts: 3, bitmapIndicator: 254 }),
  ]);
  const second = await decodeGrib2(bytes, 1);
  assert.equal(second.values[0], 4);
  assert.ok(Number.isNaN(second.values[1]));
  assert.deepEqual([...second.values.slice(2)], [5, 6]);
  await assert.rejects(() => decodeGrib2(bytes, 2), /submessage 2 is out of range/);
}

await assert.rejects(
  () => decodeGrib2(message([simpleField([1, 2], { npts: 4 })])),
  /truncated packed data/
);

await assert.rejects(
  () => decodeGrib2(message([simpleField([1, 2, 3, 4])], section3({ gdt: 1 }))),
  /unsupported GRIB2 grid template 1/
);

{
  const malformed = new Uint8Array(25);
  malformed.set([71, 82, 73, 66], 0);
  malformed[7] = 2;
  new DataView(malformed.buffer).setUint32(16, 0);
  await assert.rejects(() => decodeGrib2(malformed), /invalid section length 0/);
}

{
  const complete = message([simpleField([1, 2, 3, 4])]);
  await assert.rejects(() => decodeGrib2(complete.subarray(0, -4)), /missing end marker/);
}

