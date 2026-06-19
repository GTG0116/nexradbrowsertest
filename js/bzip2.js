// bzip2.js — pure-JavaScript bzip2 stream decompressor.
//
// NEXRAD Level II "Archive II" files store their radar messages as a series of
// LDM records, each independently compressed with bzip2 (the blocks begin with
// the ASCII magic "BZh"). The browser has no native bzip2, so we decode it here
// with a self-contained implementation of the algorithm (Huffman + MTF + RLE2 +
// inverse Burrows–Wheeler + RLE1). No external dependencies.
//
// Exports decodeBzip2(Uint8Array) -> Uint8Array (the decompressed bytes of a
// single bzip2 stream, which may contain multiple internal blocks).

const STREAM_MAGIC_1 = 0x425a; // "BZ"
const BLOCK_PI = 0x314159; // first 24 bits of 0x314159265359
const BLOCK_PI2 = 0x265359;
const EOS_SQRT = 0x177245; // first 24 bits of 0x177245385090
const EOS_SQRT2 = 0x385090;

class BitReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.pos = 0;
    // We keep the accumulator as a plain Number (53-bit safe) and use integer
    // division instead of `<<` so reads wider than 31 bits never overflow.
    this.buf = 0;
    this.count = 0;
  }

  bits(n) {
    while (this.count < n) {
      const b = this.pos < this.bytes.length ? this.bytes[this.pos] : 0;
      this.pos++;
      this.buf = this.buf * 256 + b;
      this.count += 8;
    }
    this.count -= n;
    const div = Math.pow(2, this.count);
    const r = Math.floor(this.buf / div);
    this.buf -= r * div;
    return r;
  }

  bit() {
    return this.bits(1);
  }
}

// Build the canonical Huffman decode tables (limit/base/perm) used by bzip2.
function makeTables(lengths, alphaSize) {
  let minLen = 32;
  let maxLen = 0;
  for (let i = 0; i < alphaSize; i++) {
    const l = lengths[i];
    if (l > maxLen) maxLen = l;
    if (l < minLen) minLen = l;
  }

  const perm = new Int32Array(alphaSize);
  let pp = 0;
  for (let len = minLen; len <= maxLen; len++) {
    for (let i = 0; i < alphaSize; i++) {
      if (lengths[i] === len) perm[pp++] = i;
    }
  }

  const size = maxLen + 2;
  const base = new Int32Array(size);
  const limit = new Int32Array(size);

  for (let i = 0; i < alphaSize; i++) base[lengths[i] + 1]++;
  for (let i = 1; i < size; i++) base[i] += base[i - 1];

  let vec = 0;
  for (let len = minLen; len <= maxLen; len++) {
    vec += base[len + 1] - base[len];
    limit[len] = vec - 1;
    vec <<= 1;
  }
  for (let len = minLen + 1; len <= maxLen; len++) {
    base[len] = ((limit[len - 1] + 1) << 1) - base[len];
  }

  return { limit, base, perm, minLen, maxLen };
}

function decodeSymbol(br, t) {
  let len = t.minLen;
  let vec = br.bits(len);
  while (len <= t.maxLen) {
    if (vec <= t.limit[len]) break;
    len++;
    vec = (vec << 1) | br.bit();
  }
  return t.perm[vec - t.base[len]];
}

function decodeBlock(br, blockSize, out) {
  br.bits(32); // block CRC (not validated)
  if (br.bit() !== 0) throw new Error('bzip2: randomized blocks unsupported');
  const origPtr = br.bits(24);

  // --- Symbol map -----------------------------------------------------------
  const used = [];
  const inUse16 = br.bits(16);
  for (let i = 0; i < 16; i++) {
    if (inUse16 & (0x8000 >> i)) {
      const bits = br.bits(16);
      for (let j = 0; j < 16; j++) {
        if (bits & (0x8000 >> j)) used.push(i * 16 + j);
      }
    }
  }
  const symCount = used.length;
  const alphaSize = symCount + 2;
  const EOB = alphaSize - 1;

  // --- Selectors ------------------------------------------------------------
  const nGroups = br.bits(3);
  const nSelectors = br.bits(15);
  const selectorMtf = new Uint8Array(nSelectors);
  for (let i = 0; i < nSelectors; i++) {
    let j = 0;
    while (br.bit()) j++;
    selectorMtf[i] = j;
  }
  const groupPos = [];
  for (let i = 0; i < nGroups; i++) groupPos.push(i);
  const selectors = new Uint8Array(nSelectors);
  for (let i = 0; i < nSelectors; i++) {
    let v = selectorMtf[i];
    const tmp = groupPos[v];
    while (v > 0) {
      groupPos[v] = groupPos[v - 1];
      v--;
    }
    groupPos[0] = tmp;
    selectors[i] = tmp;
  }

  // --- Huffman tables -------------------------------------------------------
  const tables = [];
  for (let g = 0; g < nGroups; g++) {
    const lengths = new Int32Array(alphaSize);
    let c = br.bits(5);
    for (let s = 0; s < alphaSize; s++) {
      while (br.bit()) {
        if (br.bit()) c--;
        else c++;
      }
      lengths[s] = c;
    }
    tables.push(makeTables(lengths, alphaSize));
  }

  // --- MTF + RLE2 decode into the BWT buffer --------------------------------
  const bwt = new Uint8Array(blockSize);
  const unzftab = new Int32Array(256);
  const mtf = used.slice();
  let nblock = 0;
  let group = -1;
  let inGroup = 0;
  let table = null;
  let run = 0;
  let runShift = 0;

  for (;;) {
    if (inGroup === 0) {
      group++;
      inGroup = 50;
      table = tables[selectors[group]];
    }
    inGroup--;
    const sym = decodeSymbol(br, table);

    if (sym <= 1) {
      // RUNA (0) / RUNB (1): bijective base-2 run length of mtf[0].
      run += (sym + 1) << runShift;
      runShift++;
      continue;
    }

    if (run > 0) {
      const b = mtf[0];
      unzftab[b] += run;
      while (run-- > 0) bwt[nblock++] = b;
      run = 0;
      runShift = 0;
    }

    if (sym === EOB) break;

    const idx = sym - 1;
    const b = mtf[idx];
    for (let k = idx; k > 0; k--) mtf[k] = mtf[k - 1];
    mtf[0] = b;
    unzftab[b]++;
    bwt[nblock++] = b;
  }

  // --- Inverse Burrows–Wheeler transform ------------------------------------
  const cftab = new Int32Array(257);
  for (let i = 0; i < 256; i++) cftab[i + 1] = unzftab[i];
  for (let i = 1; i <= 256; i++) cftab[i] += cftab[i - 1];

  const tt = new Int32Array(nblock);
  for (let i = 0; i < nblock; i++) {
    const ch = bwt[i];
    tt[cftab[ch]] = i;
    cftab[ch]++;
  }

  // --- Final RLE1 decode straight into the output ---------------------------
  let tPos = tt[origPtr];
  let prev = -1;
  let same = 0;
  let i = 0;
  while (i < nblock) {
    const b = bwt[tPos];
    tPos = tt[tPos];
    i++;
    if (same === 4) {
      // `b` is a count of additional copies of `prev`.
      for (let k = 0; k < b; k++) out.push(prev);
      same = 0;
      prev = -1;
      continue;
    }
    if (b === prev) {
      same++;
    } else {
      same = 1;
      prev = b;
    }
    out.push(b);
  }
}

// A small growable byte buffer (push() amortized O(1)).
class ByteSink {
  constructor() {
    this.data = new Uint8Array(1 << 20);
    this.len = 0;
  }
  push(b) {
    if (this.len === this.data.length) {
      const next = new Uint8Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    this.data[this.len++] = b;
  }
  toUint8Array() {
    return this.data.subarray(0, this.len);
  }
}

export function decodeBzip2(bytes) {
  const br = new BitReader(bytes);
  if (br.bits(16) !== STREAM_MAGIC_1) throw new Error('bzip2: bad magic');
  if (br.bits(8) !== 0x68) throw new Error('bzip2: expected "h"'); // 'h'
  const level = br.bits(8) - 0x30; // '1'..'9'
  if (level < 1 || level > 9) throw new Error('bzip2: bad block size');
  const blockSize = level * 100000 + 1;

  const out = new ByteSink();
  for (;;) {
    const m1 = br.bits(24);
    const m2 = br.bits(24);
    if (m1 === BLOCK_PI && m2 === BLOCK_PI2) {
      decodeBlock(br, blockSize, out);
    } else if (m1 === EOS_SQRT && m2 === EOS_SQRT2) {
      br.bits(32); // combined CRC
      break;
    } else {
      throw new Error('bzip2: bad block magic');
    }
  }
  return out.toUint8Array();
}
