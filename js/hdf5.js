// hdf5.js — a minimal, dependency-free HDF5 / NetCDF-4 reader, just enough to
// pull the gridded variables out of NOAA GOES-R ABI Level-2 files (which are
// NetCDF-4, i.e. HDF5 underneath).
//
// Everything runs in the browser. The only "library" we lean on is the platform
// `DecompressionStream`, used to inflate the zlib-compressed (filter id 1) data
// chunks — so the project keeps its "decode it all yourself" character with no
// third-party code.
//
// What it supports (the subset GOES files actually use):
//   • Superblock v2 / v3 (and a best-effort v0).
//   • Object header v2 ("OHDR") with continuation ("OCHK") blocks.
//   • Dense link storage and dense attribute storage via fractal heaps — GOES
//     root groups and variables both use these.
//   • Dataspace, Datatype (fixed-point + floating-point + fixed strings),
//     Data Layout (contiguous + chunked), Filter Pipeline (shuffle + deflate).
//   • Chunked data indexed by a version-1 B-tree.
//
// It is deliberately not a general HDF5 implementation; it targets the shapes
// these specific products take.

const SIG = [0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a];
const UNDEF = 0xffffffffffffffff;

// Inflate a zlib stream (HDF5 filter id 1) with the platform DecompressionStream.
//
// HDF5 chunks frequently carry bytes *after* the zlib end-of-stream marker — a
// Fletcher32 checksum (filter id 3) and/or chunk padding. Firefox and Safari stop
// cleanly at the stream end and ignore the extra bytes, but Chrome's
// DecompressionStream rejects with "junk found after the end of the compressed
// data" — and the convenient `new Response(stream).arrayBuffer()` pattern then
// throws away *all* the output that was already produced. That made every GOES
// chunk fail to decode in Chrome (and only Chrome): the map drew but no satellite.
//
// So drive the stream by hand: read the inflated output as it comes, feed the
// input fire-and-forget, and treat a post-output error as a normal end-of-stream.
// We only surface an error if nothing at all was decoded (a genuinely bad stream).
async function inflate(bytes) {
  const ds = new DecompressionStream('deflate');
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  const chunks = [];
  let total = 0;
  let readErr = null;

  const collect = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.length;
      }
    } catch (e) {
      readErr = e; // trailing-junk (Chrome) or truncation — judged below by `total`
    }
  })();

  // Errors on the input side are reported by the read side; swallow them here so a
  // trailing-bytes rejection can't discard the already-inflated output.
  writer.write(bytes).catch(() => {});
  writer.close().catch(() => {});
  await collect;

  if (!total && readErr) throw readErr; // produced nothing → a real failure
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

// Undo the HDF5 byte-shuffle filter (filter id 2): de-interleave the planes of
// each element back into element order.
function unshuffle(bytes, elsize) {
  if (elsize <= 1) return bytes;
  const n = (bytes.length / elsize) | 0;
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < elsize; i++) {
    const base = i * n;
    for (let j = 0; j < n; j++) out[j * elsize + i] = bytes[base + j];
  }
  return out;
}

// Thrown by the byte accessors when the requested span is not resident in a
// range-loaded file. The async drivers (`_resolve`, `readVariable`) catch it,
// pull that part of the object over HTTP and retry the parse — a page-fault
// handler for a sparsely loaded file.
class MissingBytes extends Error {
  constructor(start, end) {
    super(`hdf5: bytes ${start}-${end} not loaded`);
    this.start = start;
    this.end = end;
  }
}

function makeSegment(start, bytes, pinned) {
  return {
    start,
    end: start + bytes.length,
    bytes,
    view: new DataView(bytes.buffer, bytes.byteOffset, bytes.length),
    pinned: !!pinned,
  };
}

// How much to pull on a metadata fault, and how far apart two data chunks may
// sit before they stop sharing one request. Both are tuned for S3: a request is
// worth ~100 ms of latency, so reading a little extra beats a second round trip.
const FAULT_WINDOW = 512 * 1024;
const COALESCE_GAP = 512 * 1024;
// Ceiling on one coalesced data read, so a full-disk band streams through in a
// few bounded pieces instead of one ~20 MB allocation.
const MAX_DATA_READ = 8 * 1024 * 1024;

export class HDF5File {
  // `buffer` is the complete object. For a file read over HTTP range requests
  // use HDF5File.ranged() instead.
  constructor(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    this._init(bytes.length, [makeSegment(0, bytes, true)], null);
  }

  // A file whose bytes are fetched on demand: `head` is the leading slice
  // already read (enough for the superblock), `loader(start, end)` resolves to
  // the bytes of any other span. Only the metadata and the chunks of the
  // variables actually read are ever downloaded.
  static ranged(size, head, loader) {
    const f = Object.create(HDF5File.prototype);
    f._init(size, [makeSegment(0, head, true)], loader);
    return f;
  }

  _init(size, segments, loader) {
    this.size = size;
    this.segs = segments;
    this.loader = loader || null;
    this._seg = segments[0] || null;
    this._parseSuperblock();
    this._links = null; // name -> object-header address (lazy)
  }

  // Locate the resident segment holding [o, o+n). Multi-byte reads never
  // straddle a segment because overlapping/adjacent segments are merged on
  // insert, so a straddling read simply faults and is retried on merged bytes.
  _at(o, n) {
    const s = this._seg;
    if (s && o >= s.start && o + n <= s.end) return s;
    for (const seg of this.segs) {
      if (o >= seg.start && o + n <= seg.end) { this._seg = seg; return seg; }
    }
    throw new MissingBytes(o, o + n);
  }

  // ---- little-endian primitives ----
  u8(o) { const s = this._at(o, 1); return s.bytes[o - s.start]; }
  u16(o) { const s = this._at(o, 2); return s.view.getUint16(o - s.start, true); }
  u32(o) { const s = this._at(o, 4); return s.view.getUint32(o - s.start, true); }
  u64(o) { const s = this._at(o, 8); return Number(s.view.getBigUint64(o - s.start, true)); }
  i16(o) { const s = this._at(o, 2); return s.view.getInt16(o - s.start, true); }
  i32(o) { const s = this._at(o, 4); return s.view.getInt32(o - s.start, true); }
  i8(o) { const s = this._at(o, 1); return s.view.getInt8(o - s.start); }
  f32(o) { const s = this._at(o, 4); return s.view.getFloat32(o - s.start, true); }
  f64(o) { const s = this._at(o, 8); return s.view.getFloat64(o - s.start, true); }
  // A view of [o, o+n) — no copy for a fully buffered file.
  slice(o, n) { const s = this._at(o, n); return s.bytes.subarray(o - s.start, o - s.start + n); }
  str(o, n) { return new TextDecoder().decode(this.slice(o, n)).replace(/\0.*$/, ''); }
  sig4(o) { const b = this.slice(o, 4); return String.fromCharCode(b[0], b[1], b[2], b[3]); }

  // ---- sparse loading -----------------------------------------------------

  _has(start, end) {
    for (const seg of this.segs) if (start >= seg.start && end <= seg.end) return true;
    return false;
  }

  // Insert a freshly read span, merging it with any overlapping/adjacent
  // segment of the same kind so later multi-byte reads never straddle a seam.
  _insert(start, bytes, pinned) {
    let seg = makeSegment(start, bytes, pinned);
    for (;;) {
      const i = this.segs.findIndex((s) =>
        s.pinned === seg.pinned && s.start <= seg.end && seg.start <= s.end);
      if (i < 0) break;
      const other = this.segs.splice(i, 1)[0];
      if (other.start <= seg.start && other.end >= seg.end) { seg = other; continue; }
      const start2 = Math.min(seg.start, other.start);
      const end2 = Math.max(seg.end, other.end);
      const merged = new Uint8Array(end2 - start2);
      merged.set(other.bytes, other.start - start2);
      merged.set(seg.bytes, seg.start - start2); // the newer read wins on overlap
      seg = makeSegment(start2, merged, seg.pinned);
    }
    this.segs.push(seg);
    this._seg = seg;
    return seg;
  }

  async _load(start, end, pinned) {
    const a = Math.max(0, start);
    const b = Math.min(this.size, end);
    if (b <= a || this._has(a, b)) return;
    if (!this.loader) throw new MissingBytes(a, b);
    this._insert(a, await this.loader(a, b), pinned);
  }

  // Drop every unpinned (data) segment. Metadata stays resident so another band
  // can be decoded later without re-reading the header.
  releaseData() {
    this.segs = this.segs.filter((s) => s.pinned);
    this._seg = this.segs[0] || null;
  }

  // Run a synchronous parse, pulling in whatever spans it faults on. Metadata
  // faults read a window around the address, so a header spread over a few
  // structures costs a couple of requests rather than one per field.
  async _resolve(parse) {
    for (let attempt = 0; attempt < 256; attempt++) {
      try {
        return parse();
      } catch (err) {
        if (!(err instanceof MissingBytes) || !this.loader) throw err;
        // A read past the end of the object is a genuinely corrupt/unsupported
        // structure, not a fault we can satisfy — retrying would spin.
        if (err.start >= this.size) throw err;
        const start = Math.max(0, Math.floor(err.start / FAULT_WINDOW) * FAULT_WINDOW);
        const end = Math.max(err.end, start + FAULT_WINDOW);
        await this._load(start, end, true);
      }
    }
    throw new Error('hdf5: header could not be resolved');
  }

  // Attributes, resolving range faults. Prefer this over readAttributes() on a
  // file opened with HDF5File.ranged().
  readAttributesAsync(name) {
    return this._resolve(() => this.readAttributes(name));
  }

  _parseSuperblock() {
    for (let i = 0; i < 8; i++) if (this.u8(i) !== SIG[i]) throw new Error('not an HDF5 file');
    const ver = this.u8(8);
    this.sbVersion = ver;
    if (ver === 0 || ver === 1) {
      // v0/v1 superblock: offsets sit a bit further in.
      this.offSize = this.u8(13);
      this.lenSize = this.u8(14);
      // root group symbol-table entry → object header address.
      const base = 24 + (ver === 1 ? 4 : 0);
      // skip base addr / free space / eof / driver (4 * offSize) then sym table entry
      const ste = base + 4 * this.offSize;
      // symbol table entry: link name offset (off), object header addr (off)
      this.rootOH = this.u64(ste + this.offSize);
    } else if (ver === 2 || ver === 3) {
      this.offSize = this.u8(9);
      this.lenSize = this.u8(10);
      this.rootOH = this.u64(36);
    } else {
      throw new Error('unsupported HDF5 superblock version ' + ver);
    }
  }

  // -----------------------------------------------------------------------
  // Object header v2 message iteration (with OCHK continuation blocks).
  // -----------------------------------------------------------------------
  *_messages(addr) {
    if (this.sig4(addr) !== 'OHDR') {
      // v1 object header (used by some v0-superblock files): header prefix is
      // version(1), reserved(1), #messages(2), ref count(4), header size(4).
      yield* this._messagesV1(addr);
      return;
    }
    const flags = this.u8(addr + 5);
    let p = addr + 6;
    if (flags & 0x20) p += 16; // timestamps
    if (flags & 0x10) p += 4;  // max compact / min dense attrs
    const szf = flags & 3;
    const cl = szf === 0 ? 1 : szf === 1 ? 2 : szf === 2 ? 4 : 8;
    let chunkSize = cl === 1 ? this.u8(p) : cl === 2 ? this.u16(p) : this.u32(p);
    p += cl;
    const orderTracked = !!(flags & 4);
    const queue = [[p, p + chunkSize]];
    while (queue.length) {
      const [start, end] = queue.shift();
      let pp = start;
      while (pp < end - 3) {
        const type = this.u8(pp);
        const sz = this.u16(pp + 1);
        let dp = pp + 4;
        if (orderTracked) dp += 2;
        if (type === 0x10) {
          const ca = this.u64(dp);
          const cs = this.u64(dp + 8);
          // continuation block: "OCHK" sig (4) ... messages ... checksum (4)
          queue.push([ca + 4, ca + 4 + cs - 4]);
        } else {
          yield { type, dp, sz };
        }
        pp = dp + sz;
      }
    }
  }

  *_messagesV1(addr) {
    const nmsg = this.u16(addr + 2);
    let p = addr + 16; // 8-byte aligned header prefix
    let count = 0;
    const blocks = [];
    let limit = Infinity;
    while (count < nmsg) {
      const type = this.u16(p);
      const sz = this.u16(p + 2);
      const dp = p + 8;
      if (type === 0x10) {
        const ca = this.u64(dp);
        blocks.push(ca);
      } else {
        yield { type, dp, sz };
      }
      p = dp + sz;
      count++;
      if (p >= addr + 16 + limit && blocks.length) {
        p = blocks.shift();
      }
    }
  }

  // -----------------------------------------------------------------------
  // Fractal heap: enumerate the data regions of every managed direct block.
  // We don't decode the doubling table fully — we collect each direct block's
  // payload span, then parse the self-delimiting records packed inside.
  // -----------------------------------------------------------------------
  _fractalHeapBlocks(heapAddr) {
    let h = heapAddr + 4;
    h += 1; // version
    const idLen = this.u16(h); h += 2;
    const ioFilter = this.u16(h); h += 2;
    const flags = this.u8(h); h += 1;
    h += 4;  // max managed obj size
    h += 8;  // next huge id
    h += 8;  // huge btree
    h += 8;  // free space in managed blocks
    h += 8;  // free space manager addr
    h += 8;  // managed space
    h += 8;  // allocated managed space
    h += 8;  // direct block iterator offset
    h += 8;  // number of managed objects
    h += 8;  // huge object size
    h += 8;  // number of huge objects
    h += 8;  // tiny object size
    h += 8;  // number of tiny objects
    const tableWidth = this.u16(h); h += 2;
    const startBlockSize = this.u64(h); h += 8;
    const maxDirectSize = this.u64(h); h += 8;
    const maxHeapBits = this.u16(h); h += 2;
    h += 2; // starting # rows of root indirect block
    const rootAddr = this.u64(h); h += 8;
    const curRows = this.u16(h); h += 2;

    const checksummed = !!(flags & 2);
    const offBytes = Math.ceil(maxHeapBits / 8);
    const blocks = [];
    const rowSize = (row) => (row < 2 ? startBlockSize : startBlockSize * Math.pow(2, row - 1));

    const readDirect = (addr, size) => {
      if (!addr || addr === UNDEF || addr >= this.size) return;
      if (this.sig4(addr) !== 'FHDB') return;
      let p = addr + 4 + 1 + this.offSize + offBytes; // sig, ver, heap-hdr-addr, block offset
      if (checksummed) p += 4;
      blocks.push({ start: p, end: addr + size });
    };
    const readIndirect = (addr, nrows) => {
      let p = addr + 4 + 1 + this.offSize + offBytes; // sig, ver, heap-hdr-addr, block offset
      for (let row = 0; row < nrows; row++) {
        const bs = rowSize(row);
        for (let col = 0; col < tableWidth; col++) {
          const child = this.u64(p); p += this.offSize;
          if (ioFilter > 0) p += this.lenSize + 4; // filtered size + mask (unused here)
          if (bs <= maxDirectSize) readDirect(child, bs);
          else if (child && child !== UNDEF) readIndirect(child, /*nested*/ this._indirectRows(child, startBlockSize, maxDirectSize, tableWidth));
        }
      }
    };

    if (curRows === 0) readDirect(rootAddr, startBlockSize);
    else readIndirect(rootAddr, curRows);
    return { blocks, idLen };
  }

  _indirectRows() {
    // GOES never nests indirect blocks (heaps stay small); return a safe cap.
    return 0;
  }

  // -----------------------------------------------------------------------
  // Links — map every variable / group name in the root group to its object
  // header address. GOES root groups use dense (fractal-heap) link storage.
  // -----------------------------------------------------------------------
  _ensureLinks() {
    if (this._links) return this._links;
    const map = {};
    for (const m of this._messages(this.rootOH)) {
      if (m.type === 6) { // compact Link message
        const r = this._parseLink(m.dp);
        if (r && r.name) map[r.name] = r.oh;
      } else if (m.type === 2) { // Link Info → dense storage
        let p = m.dp;
        const flags = this.u8(p + 1);
        let q = p + 2;
        if (flags & 1) q += this.lenSize; // max creation index
        const heapAddr = this.u64(q);
        if (heapAddr && heapAddr !== UNDEF) this._collectLinks(heapAddr, map);
      }
    }
    this._links = map;
    return map;
  }

  _collectLinks(heapAddr, map) {
    const { blocks } = this._fractalHeapBlocks(heapAddr);
    for (const blk of blocks) {
      let p = blk.start;
      while (p < blk.end - 5) {
        if (this.u8(p) !== 1) { p++; continue; } // link message version
        const r = this._parseLink(p);
        if (r && /^[A-Za-z_][A-Za-z0-9_.]*$/.test(r.name)) {
          map[r.name] = r.oh;
          p = r.end;
        } else p++;
      }
    }
  }

  _parseLink(p) {
    const lf = this.u8(p + 1);
    let q = p + 2;
    let linkType = 0;
    if (lf & 0x08) { linkType = this.u8(q); q += 1; }
    if (lf & 0x04) q += 8;          // creation order
    if (lf & 0x10) q += 1;          // link name charset
    const lenSz = lf & 3;
    let nlen;
    if (lenSz === 0) { nlen = this.u8(q); q += 1; }
    else if (lenSz === 1) { nlen = this.u16(q); q += 2; }
    else if (lenSz === 2) { nlen = this.u32(q); q += 4; }
    else { nlen = this.u64(q); q += 8; }
    // Dense link storage is scanned byte by byte for records, so a garbage
    // position can declare an absurd name length; decoding one would read far
    // past the record for nothing. Real link names are short.
    if (!(nlen > 0 && nlen <= 1024)) return null;
    const name = this.str(q, nlen); q += nlen;
    if (linkType !== 0) return { name, oh: null, end: q };
    const oh = this.u64(q); q += this.offSize;
    return { name, oh, end: q };
  }

  listVariables() {
    return Object.keys(this._ensureLinks());
  }

  // -----------------------------------------------------------------------
  // Attributes — compact (message 12) plus dense (Attribute Info, message 21).
  // -----------------------------------------------------------------------
  readAttributes(name) {
    const links = this._ensureLinks();
    const oh = name == null ? this.rootOH : links[name];
    if (oh == null) return {};
    const attrs = {};
    for (const m of this._messages(oh)) {
      if (m.type === 12) {
        const a = this._parseAttr(m.dp);
        if (a) attrs[a.name] = a.val;
      } else if (m.type === 21) {
        let p = m.dp;
        const flags = this.u8(p + 1);
        let q = p + 2;
        if (flags & 1) q += 2; // max creation index
        const heapAddr = this.u64(q);
        if (heapAddr && heapAddr !== UNDEF) {
          const { blocks } = this._fractalHeapBlocks(heapAddr);
          for (const blk of blocks) {
            let pp = blk.start;
            while (pp < blk.end - 4) {
              const v = this.u8(pp);
              if (v !== 1 && v !== 2 && v !== 3) { pp++; continue; }
              const a = this._tryAttr(pp, blk.end);
              if (a) { attrs[a.name] = a.val; pp = a.end; }
              else pp++;
            }
          }
        }
      }
    }
    return attrs;
  }

  // Dense attribute storage has no per-record index, so records are found by
  // trying to parse one at every plausible byte of the heap block. `limit` is
  // that block's end: a record cannot run past it, and enforcing that is what
  // keeps a *failed* attempt cheap. Without it a random byte pattern could
  // declare a multi-billion-element array and the "parse" would spin for
  // seconds building it before finally faulting — which is exactly what made
  // reading one band's attributes take ten seconds.
  _tryAttr(p, limit) {
    try {
      const a = this._parseAttr(p, limit);
      if (a && a.name && /^[\x20-\x7e]+$/.test(a.name)) return a;
    } catch (_) { /* not an attribute here */ }
    return null;
  }

  _parseAttr(p, limit = Infinity) {
    const ver = this.u8(p);
    let nameSz, dtSz, dsSz, q, dtp, dsp, name;
    if (ver === 1) {
      nameSz = this.u16(p + 2); dtSz = this.u16(p + 4); dsSz = this.u16(p + 6); q = p + 8;
      name = this.str(q, nameSz); q += Math.ceil(nameSz / 8) * 8;
      dtp = q; q += Math.ceil(dtSz / 8) * 8;
      dsp = q; q += Math.ceil(dsSz / 8) * 8;
    } else if (ver === 2 || ver === 3) {
      nameSz = this.u16(p + 2); dtSz = this.u16(p + 4); dsSz = this.u16(p + 6); q = p + 8;
      if (ver === 3) q += 1; // name character-set encoding
      name = this.str(q, nameSz); q += nameSz;
      dtp = q; q += dtSz;
      dsp = q; q += dsSz;
    } else {
      return null;
    }
    // A real record's name, datatype and dataspace all fit inside the block.
    if (!(nameSz > 0 && dsp <= limit)) return null;
    const cls = this.u8(dtp) & 0x0f;
    const dtBits = this.u8(dtp + 1);
    const elsize = this.u32(dtp + 4);
    if (!(elsize > 0 && elsize <= 65536)) return null;

    // dataspace: count elements
    const dsVer = this.u8(dsp);
    const ndim = this.u8(dsp + 1);
    if (ndim > 4) return null;
    let r = dsp + (dsVer === 1 ? 8 : 4);
    let n = 1;
    for (let i = 0; i < ndim; i++) { n *= this.u64(r); r += 8; }
    if (n < 1) n = 1;
    // The values must fit in the block too — the check that keeps a misparse
    // from allocating a huge array before it fails.
    if (!Number.isFinite(n) || q + n * elsize > limit) return null;

    const readOne = (o) => {
      if (cls === 1) return elsize === 4 ? this.f32(o) : this.f64(o);
      if (cls === 0) {
        const signed = (dtBits & 0x08) !== 0;
        if (elsize === 1) return signed ? this.i8(o) : this.u8(o);
        if (elsize === 2) return signed ? this.i16(o) : this.u16(o);
        if (elsize === 4) return signed ? this.i32(o) : this.u32(o);
        return this.u64(o);
      }
      if (cls === 3) return this.str(o, elsize); // fixed-length string
      return null;
    };

    let val;
    if (cls === 3 && ndim === 0) val = this.str(q, elsize);
    else if (n === 1) val = readOne(q);
    else { val = []; for (let i = 0; i < n; i++) val.push(readOne(q + i * elsize)); }
    return { name, val, end: q + n * elsize };
  }

  // -----------------------------------------------------------------------
  // Variable data — dataspace + datatype + layout, then read the array.
  //
  // `opts.stride` (2-D variables only) decimates while reading: the output is
  // every Nth row and column, and is allocated at that size. A phone reading a
  // 5424² full-disk band at stride 5 never materialises the 58 MB full array.
  // Returns { dims, data, elsize, signed, dclass, fill, stride, fullDims } where
  // `dims` describes the array actually returned.
  // -----------------------------------------------------------------------
  async readVariable(name, opts = {}) {
    const meta = await this._resolve(() => this._variableMeta(name));
    const { dims, chunkDims, btreeAddr, contiguousAddr, elsize, signed, dclass, filters, fill } = meta;

    const stride = dims.length === 2 ? Math.max(1, Math.floor(opts.stride) || 1) : 1;
    const outDims = dims.map((d) => Math.ceil(d / stride));
    const total = outDims.reduce((a, b) => a * b, 1);
    const out = this._makeTyped(dclass, signed, elsize, total);
    const result = { dims: outDims, data: out, elsize, signed, dclass, fill, stride, fullDims: dims };

    if (contiguousAddr != null && contiguousAddr !== UNDEF) {
      const full = dims.reduce((a, b) => a * b, 1);
      await this._load(contiguousAddr, contiguousAddr + full * elsize, false);
      if (stride === 1) {
        this._copyRaw(this.slice(contiguousAddr, full * elsize), out, 0, full);
      } else {
        const [H, W] = dims, [outH, outW] = outDims;
        const src = this._makeTyped(dclass, signed, elsize, full);
        this._copyRaw(this.slice(contiguousAddr, full * elsize), src, 0, full);
        for (let y = 0; y < outH; y++)
          for (let x = 0; x < outW; x++) out[y * outW + x] = src[y * stride * W + x * stride];
      }
      return result;
    }

    if (btreeAddr != null && btreeAddr !== UNDEF) {
      await this._readChunked(btreeAddr, dims, chunkDims, elsize, filters, out, dclass, signed, stride);
      return result;
    }

    // No data block allocated (all fill): leave zeros / fill.
    if (fill != null) out.fill(fill);
    return result;
  }

  // A variable's full dimensions, without reading any of its data.
  async variableShape(name) {
    const meta = await this._resolve(() => this._variableMeta(name));
    return meta.dims;
  }

  // Dataspace + datatype + layout + filters of one variable. Synchronous, so it
  // runs under _resolve() on a range-loaded file.
  _variableMeta(name) {
    const links = this._ensureLinks();
    const oh = links[name];
    if (oh == null) throw new Error('no such variable: ' + name);

    let dims = null, chunkDims = null, btreeAddr = null;
    let contiguousAddr = null, contiguousSize = null;
    let elsize = 2, signed = true, dclass = 0;
    let filters = [];
    let fill = null;

    for (const m of this._messages(oh)) {
      if (m.type === 1) {
        const ndim = this.u8(m.dp + 1);
        let q = m.dp + (this.u8(m.dp) === 1 ? 8 : 4);
        dims = [];
        for (let i = 0; i < ndim; i++) { dims.push(this.u64(q)); q += 8; }
      } else if (m.type === 3) {
        dclass = this.u8(m.dp) & 0x0f;
        signed = (this.u8(m.dp + 1) & 0x08) !== 0;
        elsize = this.u32(m.dp + 4);
      } else if (m.type === 8) {
        const layoutVer = this.u8(m.dp);
        const cls = this.u8(m.dp + 1);
        if (cls === 1) { // contiguous
          contiguousAddr = this.u64(m.dp + 2);
          contiguousSize = this.u64(m.dp + 2 + this.offSize);
        } else if (cls === 2) { // chunked
          const dim = this.u8(m.dp + 2);
          btreeAddr = this.u64(m.dp + 3);
          let q = m.dp + 3 + this.offSize;
          chunkDims = [];
          for (let i = 0; i < dim; i++) { chunkDims.push(this.u32(q)); q += 4; }
          // The layout message's dimensionality is rank+1: the last "dimension"
          // is the element size in bytes, not a chunk extent — drop it.
          chunkDims.pop();
        }
      } else if (m.type === 11) {
        filters = this._parseFilters(m.dp);
      } else if (m.type === 5) {
        fill = this._parseFillValue(m.dp, elsize, signed, dclass);
      }
    }

    if (!dims) throw new Error('variable has no dataspace: ' + name);
    return { dims, chunkDims, btreeAddr, contiguousAddr, contiguousSize, elsize, signed, dclass, filters, fill };
  }

  _makeTyped(dclass, signed, elsize, n) {
    if (dclass === 1) return elsize === 4 ? new Float32Array(n) : new Float64Array(n);
    if (signed) return elsize === 1 ? new Int8Array(n) : elsize === 2 ? new Int16Array(n) : new Int32Array(n);
    return elsize === 1 ? new Uint8Array(n) : elsize === 2 ? new Uint16Array(n) : new Uint32Array(n);
  }

  _copyRaw(srcBytes, out, dstElemOffset, count) {
    const view = new DataView(srcBytes.buffer, srcBytes.byteOffset, srcBytes.length);
    const el = out.BYTES_PER_ELEMENT;
    const get =
      out instanceof Float32Array ? (o) => view.getFloat32(o, true)
      : out instanceof Float64Array ? (o) => view.getFloat64(o, true)
      : out instanceof Int16Array ? (o) => view.getInt16(o, true)
      : out instanceof Uint16Array ? (o) => view.getUint16(o, true)
      : out instanceof Int32Array ? (o) => view.getInt32(o, true)
      : out instanceof Uint32Array ? (o) => view.getUint32(o, true)
      : out instanceof Int8Array ? (o) => view.getInt8(o)
      : (o) => srcBytes[o];
    for (let i = 0; i < count; i++) out[dstElemOffset + i] = get(i * el);
  }

  _parseFilters(dp) {
    const ver = this.u8(dp);
    const nf = this.u8(dp + 1);
    let q = dp + (ver === 1 ? 8 : 2);
    const out = [];
    for (let i = 0; i < nf; i++) {
      const id = this.u16(q);
      let nameLen = 0;
      if (ver === 1) { nameLen = this.u16(q + 2); q += 4; q += nameLen; }
      else q += 2;
      const flags = this.u16(q);
      const nval = this.u16(q + 2);
      q += 4;
      const vals = [];
      for (let k = 0; k < nval; k++) { vals.push(this.u32(q)); q += 4; }
      if (ver === 1 && (nval & 1)) q += 4; // padding to 8 bytes
      out.push({ id, vals });
    }
    return out;
  }

  _parseFillValue(dp, elsize, signed, dclass) {
    const ver = this.u8(dp);
    if (ver === 1 || ver === 2) {
      // ver, space alloc, fill write, defined, [size, value]
      const defined = this.u8(dp + 3);
      if (!defined) return null;
      const size = this.u32(dp + 4);
      if (!size) return null;
      return this._readScalar(dp + 8, elsize, signed, dclass);
    }
    // ver 3
    const flags = this.u8(dp + 1);
    if (!(flags & 0x20)) return null; // fill value defined?
    const size = this.u32(dp + 2);
    if (!size) return null;
    return this._readScalar(dp + 6, elsize, signed, dclass);
  }

  _readScalar(o, elsize, signed, dclass) {
    if (dclass === 1) return elsize === 4 ? this.f32(o) : this.f64(o);
    if (elsize === 1) return signed ? this.i8(o) : this.u8(o);
    if (elsize === 2) return signed ? this.i16(o) : this.u16(o);
    if (elsize === 4) return signed ? this.i32(o) : this.u32(o);
    return this.u64(o);
  }

  // Walk the version-1 chunk B-tree, gather leaf chunk descriptors, then
  // (asynchronously) inflate/unshuffle each and scatter it into `out`.
  //
  // On a range-loaded file the tree's internal nodes sit next to the data they
  // index, so the walk itself faults a few small reads; the leaves are then
  // grouped into a handful of large sequential reads (a NetCDF-4 variable's
  // chunks are written contiguously), and each group is released as soon as its
  // chunks are decoded so only one group is resident at a time.
  async _readChunked(btreeAddr, dims, chunkDims, elsize, filters, out, dclass, signed, stride = 1) {
    const rank = dims.length;
    const collect = () => {
      const leaves = [];
      const visit = (addr) => {
        if (this.sig4(addr) !== 'TREE') return;
        const level = this.u8(addr + 5);
        const nused = this.u16(addr + 6);
        let p = addr + 8 + 2 * this.offSize; // skip left/right sibling
        for (let i = 0; i < nused; i++) {
          const chunkSize = this.u32(p);
          const filterMask = this.u32(p + 4);
          let q = p + 8;
          const offs = [];
          for (let d = 0; d < rank + 1; d++) { offs.push(this.u64(q)); q += 8; }
          const child = this.u64(q); q += this.offSize;
          if (level === 0) leaves.push({ chunkSize, filterMask, offs, addr: child });
          else visit(child);
          p = q;
        }
      };
      visit(btreeAddr);
      return leaves;
    };
    const leaves = await this._resolve(collect);

    const rowStride = []; // element strides for the full array
    rowStride[rank - 1] = 1;
    for (let d = rank - 2; d >= 0; d--) rowStride[d] = rowStride[d + 1] * dims[d + 1];

    // Sequential in file order, so the coalesced reads below are sequential too.
    leaves.sort((a, b) => a.addr - b.addr);

    let group = [];
    const flush = async () => {
      if (!group.length) return;
      const start = group[0].addr;
      const end = group[group.length - 1].addr + group[group.length - 1].chunkSize;
      await this._load(start, end, false);
      for (const lf of group) {
        const applied = (id) => filters.some((f, i) => f.id === id && !(lf.filterMask & (1 << i)));
        let raw = this.slice(lf.addr, lf.chunkSize);
        // Fletcher32 is stored after the compressed chunk bytes. Chrome's
        // DecompressionStream rejects those valid trailing checksum bytes, so strip
        // them before deflate instead of depending on browser-specific tolerance.
        if (applied(3) && raw.length >= 4) raw = raw.subarray(0, raw.length - 4);
        if (applied(1)) raw = await inflate(raw);
        if (applied(2)) raw = unshuffle(raw, elsize);
        this._scatterChunk(raw, lf.offs, dims, chunkDims, rowStride, elsize, out, dclass, signed, stride);
      }
      group = [];
      this.releaseData();
    };

    for (const lf of leaves) {
      if (group.length) {
        const last = group[group.length - 1];
        const span = lf.addr + lf.chunkSize - group[0].addr;
        if (lf.addr - (last.addr + last.chunkSize) > COALESCE_GAP || span > MAX_DATA_READ) await flush();
      }
      group.push(lf);
    }
    await flush();
  }

  // `stride` (2-D only) writes just the sampled rows/columns; `out` is then the
  // decimated array, ceil(dim / stride) on each axis.
  _scatterChunk(rawBytes, offs, dims, chunkDims, rowStride, elsize, out, dclass, signed, stride = 1) {
    const view = new DataView(rawBytes.buffer, rawBytes.byteOffset, rawBytes.length);
    const get =
      dclass === 1 ? (elsize === 4 ? (o) => view.getFloat32(o, true) : (o) => view.getFloat64(o, true))
      : signed ? (elsize === 1 ? (o) => view.getInt8(o) : elsize === 2 ? (o) => view.getInt16(o, true) : (o) => view.getInt32(o, true))
      : (elsize === 1 ? (o) => rawBytes[o] : elsize === 2 ? (o) => view.getUint16(o, true) : (o) => view.getUint32(o, true));

    // Fast path for the 2-D arrays most products use; other ranks (e.g. the
    // (scan, fov, channel) MIRS brightness-temperature stack) take the general
    // odometer walk below.
    if (dims.length === 2) {
      const [H, W] = dims;
      const [CH, CW] = chunkDims;
      const r0 = offs[0], c0 = offs[1];
      const outW = Math.ceil(W / stride);
      // First sampled row/column at or after the chunk's origin.
      const rStart = stride === 1 ? 0 : (stride - (r0 % stride)) % stride;
      const cStart = stride === 1 ? 0 : (stride - (c0 % stride)) % stride;
      const cols = Math.min(CW, W - c0);
      for (let r = rStart; r < CH; r += stride) {
        const gr = r0 + r;
        if (gr >= H) break;
        const rowSrc = r * CW * elsize;
        const dst = (gr / stride) * outW + (c0 + cStart) / stride;
        for (let c = cStart, k = 0; c < cols; c += stride, k++) out[dst + k] = get(rowSrc + c * elsize);
      }
      return;
    }
    // 1-D fallback.
    if (dims.length === 1) {
      const c0 = offs[0];
      const cw = chunkDims[0];
      for (let c = 0; c < cw && c0 + c < dims[0]; c++) out[c0 + c] = get(c * elsize);
      return;
    }
    // General N-D scatter: walk the chunk in row-major order with an odometer,
    // mapping each in-bounds element to its flat index in the full array.
    const rank = dims.length;
    const idx = new Array(rank).fill(0);
    const chunkTotal = chunkDims.reduce((a, b) => a * b, 1);
    for (let e = 0, src = 0; e < chunkTotal; e++, src += elsize) {
      let dst = 0, inside = true;
      for (let d = 0; d < rank; d++) {
        const g = offs[d] + idx[d];
        if (g >= dims[d]) { inside = false; break; }
        dst += g * rowStride[d];
      }
      if (inside) out[dst] = get(src);
      for (let d = rank - 1; d >= 0; d--) {
        if (++idx[d] < chunkDims[d]) break;
        idx[d] = 0;
      }
    }
  }
}
