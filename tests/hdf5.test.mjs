import assert from 'node:assert/strict';
import { HDF5File, mapLimit } from '../js/hdf5.js';

// A buffer with just enough superblock for the constructor: signature, v2, and
// 8-byte offsets/lengths. Nothing below reads real HDF5 structure — these
// exercise the byte source, the dense-attribute record guard and the strided
// chunk scatter directly.
function blankFile(size = 4096) {
  const b = new Uint8Array(size);
  b.set([0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b[8] = 2;  // superblock version
  b[9] = 8;  // offset size
  b[10] = 8; // length size
  return b;
}

// A v3 dense-attribute record: version, flags, name/datatype/dataspace sizes,
// then the name, a fixed-point datatype, a dataspace and the values.
function attrRecord(name, dims, elsize, values) {
  const nameBytes = new TextEncoder().encode(name + '\0');
  const dt = new Uint8Array(8);
  dt[0] = 0;                                  // class 0 = fixed point
  new DataView(dt.buffer).setUint32(4, elsize, true);
  const ds = new Uint8Array(4 + dims.length * 8);
  ds[0] = 2;                                  // dataspace version
  ds[1] = dims.length;
  const dv = new DataView(ds.buffer);
  dims.forEach((d, i) => dv.setBigUint64(4 + i * 8, BigInt(d), true));

  const head = new Uint8Array(9);
  const hv = new DataView(head.buffer);
  head[0] = 3;                                // attribute message version 3
  hv.setUint16(2, nameBytes.length, true);
  hv.setUint16(4, dt.length, true);
  hv.setUint16(6, ds.length, true);
  head[8] = 0;                                // name character-set encoding

  const body = new Uint8Array(values.length * elsize);
  const bv = new DataView(body.buffer);
  values.forEach((v, i) => bv.setUint16(i * elsize, v, true));

  const out = new Uint8Array(head.length + nameBytes.length + dt.length + ds.length + body.length);
  let o = 0;
  for (const part of [head, nameBytes, dt, ds, body]) { out.set(part, o); o += part.length; }
  return out;
}

// Dense attribute storage has no record index, so every plausible byte of a
// heap block is tried as the start of a record. A garbage position can declare
// an astronomically large element count, and the parser used to walk it: one
// misparse of a real GOES file grew the heap by ~900 MB and took ~11 seconds,
// per band — enough to have mobile WebKit kill the tab the moment the user
// switched to Satellite. A record must fit inside its block.
{
  const bytes = blankFile();
  const at = 1024;
  const record = attrRecord('scale_factor', [1e12], 2, []);
  bytes.set(record, at);
  const h5 = new HDF5File(bytes);

  const started = Date.now();
  assert.equal(h5._parseAttr(at, at + record.length), null,
    'a record claiming more values than its block holds must be rejected');
  assert.ok(Date.now() - started < 1000, 'rejection must be immediate, not a trillion-element walk');
  assert.equal(h5._tryAttr(at, at + record.length), null);
}

// A well-formed record still parses, values and all.
{
  const bytes = blankFile();
  const at = 512;
  const record = attrRecord('valid_range', [2], 2, [0, 4095]);
  bytes.set(record, at);
  const h5 = new HDF5File(bytes);
  const a = h5._parseAttr(at, at + record.length);
  assert.ok(a, 'a record that fits its block should parse');
  assert.equal(a.name, 'valid_range');
  assert.deepEqual(a.val, [0, 4095]);
}

// Strided scatter: reading every Nth row/column writes the decimated array, so
// a phone never materialises the full-resolution one. Values must land where a
// post-hoc subsample would have put them.
{
  const h5 = new HDF5File(blankFile());
  const H = 8, W = 8, stride = 2;
  const outW = W / stride;
  const full = new Int16Array(H * W);
  for (let i = 0; i < full.length; i++) full[i] = i;
  const out = new Int16Array((H / stride) * outW);

  // One chunk covering the whole array, laid out row-major as raw int16.
  const raw = new Uint8Array(full.buffer.slice(0));
  h5._scatterChunk(raw, [0, 0], [H, W], [H, W], [W, 1], 2, out, 0, true, stride);
  for (let y = 0; y < H / stride; y++)
    for (let x = 0; x < outW; x++)
      assert.equal(out[y * outW + x], full[y * stride * W + x * stride]);

  // Same, but as four chunks — a chunk whose origin is not on a sampled row or
  // column must still contribute its sampled cells at the right offsets.
  const out2 = new Int16Array(out.length);
  for (const [r0, c0] of [[0, 0], [0, 4], [4, 0], [4, 4]]) {
    const chunk = new Int16Array(4 * 4);
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) chunk[r * 4 + c] = full[(r0 + r) * W + c0 + c];
    h5._scatterChunk(new Uint8Array(chunk.buffer), [r0, c0], [H, W], [4, 4], [W, 1], 2, out2, 0, true, stride);
  }
  assert.deepEqual(Array.from(out2), Array.from(out));
}

// The sparse byte source: reads outside the resident window pull the missing
// span through the loader and resume, and the faulted metadata stays resident so
// a later band doesn't re-read the same header.
{
  const size = 4 << 20;
  const whole = blankFile(size);
  const dv = new DataView(whole.buffer);
  dv.setUint32(1_500_000, 0xdeadbeef, true);
  whole[3_000_000] = 0x5a;

  const asked = [];
  const h5 = HDF5File.ranged(size, whole.subarray(0, 4096), async (start, end) => {
    asked.push([start, end]);
    return whole.subarray(start, end);
  });
  assert.equal(h5.size, size);
  assert.equal(h5.u8(8), 2, 'the resident head reads without faulting');
  assert.equal(asked.length, 0);

  const value = await h5._resolve(() => h5.u32(1_500_000));
  assert.equal(value, 0xdeadbeef);
  assert.equal(asked.length, 1, 'one fault, one range read');

  await h5._resolve(() => h5.u32(1_500_000));
  assert.equal(asked.length, 1, 'a resolved span is not fetched twice');

  await h5._load(3_000_000, 3_000_016);
  assert.equal(h5.u8(3_000_000), 0x5a);
  assert.equal(h5.u8(8), 2, 'the resident head is still readable');
  assert.equal(h5.u32(1_500_000), 0xdeadbeef, 'faulted header bytes stay resident');
}

// Data reads are private buffers, not shared segments. A scene decodes several
// bands at once now, and the old path published each read as a segment that any
// other band's decode was free to release out from under it — so a read must
// hand back its bytes without ever becoming visible through the byte accessors.
{
  const size = 4 << 20;
  const whole = blankFile(size);
  whole[2_000_000] = 0x7c;

  const h5 = HDF5File.ranged(size, whole.subarray(0, 4096),
    async (start, end) => whole.subarray(start, end));

  const bytes = await h5._fetchRange(2_000_000, 2_000_016);
  assert.equal(bytes[0], 0x7c, 'the span is returned to the caller');
  assert.throws(() => h5.u8(2_000_000), /not loaded/,
    'a data read must not become a shared segment another decode could release');

  // A fully buffered file has the bytes already: the same call is a plain view.
  const buffered = new HDF5File(whole);
  const view = await buffered._fetchRange(2_000_000, 2_000_016);
  assert.equal(view[0], 0x7c);
  assert.equal(view.buffer, whole.buffer, 'a buffered file copies nothing');
}

// Concurrent decodes fault on the same header window at the same moment. That
// span must be pulled once, not once per band — on a phone the duplicate range
// requests are the expensive part.
{
  const size = 4 << 20;
  const whole = blankFile(size);
  new DataView(whole.buffer).setUint32(1_200_000, 0xfeedface, true);

  let requests = 0;
  let unblock;
  const gate = new Promise((r) => { unblock = r; });
  const h5 = HDF5File.ranged(size, whole.subarray(0, 4096), async (start, end) => {
    requests++;
    await gate;
    return whole.subarray(start, end);
  });

  const readers = [
    h5._resolve(() => h5.u32(1_200_000)),
    h5._resolve(() => h5.u32(1_200_000)),
    h5._resolve(() => h5.u32(1_200_004)),
  ];
  await new Promise((r) => setTimeout(r, 1)); // let all three reach the fault
  unblock();
  const values = await Promise.all(readers);

  assert.deepEqual(values, [0xfeedface, 0xfeedface, 0]);
  assert.equal(requests, 1, 'concurrent faults on one window share a single range read');
  assert.equal(h5.u32(1_200_000), 0xfeedface, 'the shared span is pinned once resolved');
}

// The scatter's typed-array fast path only applies when the chunk bytes start on
// an element boundary; an inflate output that doesn't must still decode, and to
// exactly the same values.
{
  const h5 = new HDF5File(blankFile());
  const H = 4, W = 4;
  const full = new Int16Array(H * W);
  for (let i = 0; i < full.length; i++) full[i] = i * 7 - 20;

  const aligned = new Uint8Array(full.buffer.slice(0));
  const outA = new Int16Array(H * W);
  h5._scatterChunk(aligned, [0, 0], [H, W], [H, W], [W, 1], 2, outA, 0, true, 1);

  // Same bytes at an odd offset, so no Int16Array view can be taken over them.
  const padded = new Uint8Array(aligned.length + 1);
  padded.set(aligned, 1);
  const outB = new Int16Array(H * W);
  h5._scatterChunk(padded.subarray(1), [0, 0], [H, W], [H, W], [W, 1], 2, outB, 0, true, 1);

  assert.deepEqual(Array.from(outB), Array.from(outA));
  assert.deepEqual(Array.from(outA), Array.from(full));
}

// _copyRaw's memcpy path must agree with the byte-by-byte one it replaces.
{
  const h5 = new HDF5File(blankFile());
  const src = new Float32Array([1.5, -2.25, 0, 1e10]);
  const bytes = new Uint8Array(src.buffer.slice(0));
  const fast = new Float32Array(src.length);
  const slow = new Float32Array(src.length);
  h5._copyRaw(bytes, fast, 0, src.length, 1, false, 4);
  h5._copyRaw(bytes, slow, 0, src.length);           // no dclass → DataView path
  assert.deepEqual(Array.from(fast), Array.from(src));
  assert.deepEqual(Array.from(slow), Array.from(src));
}

// mapLimit covers every item exactly once and never exceeds its width — the cap
// is what keeps concurrent band decodes inside a phone's memory budget.
{
  const items = [0, 1, 2, 3, 4, 5, 6];
  const seen = [];
  let live = 0, peak = 0;
  await mapLimit(items, 3, async (v) => {
    live++;
    peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 1));
    seen.push(v);
    live--;
  });
  assert.deepEqual(seen.sort((a, b) => a - b), items);
  assert.equal(peak, 3, 'no more than `width` tasks may run at once');

  // Fewer items than lanes, and the empty case, both terminate.
  let count = 0;
  await mapLimit([1], 4, async () => { count++; });
  await mapLimit([], 4, async () => { count++; });
  assert.equal(count, 1);

  // A rejection propagates rather than being swallowed by a sibling lane.
  await assert.rejects(mapLimit([1, 2, 3], 2, async (v) => {
    if (v === 2) throw new Error('lane failed');
  }), /lane failed/);
}

console.log('hdf5 tests passed');
