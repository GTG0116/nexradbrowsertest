// radarLayer.js — a Mapbox GL *custom WebGL layer* that draws a NEXRAD sweep
// straight from its polar data on the GPU, every frame, at native screen
// resolution.
//
// Why this exists
// ---------------
// The old path rasterised the sweep into a fixed mercator canvas and let Mapbox
// reproject that bitmap. That bakes the polar data into a pixel grid, so once you
// zoom past the canvas's resolution the GPU has to invent in-between pixels and
// the gates go soft ("auto smoothing"). No canvas size escapes that — at some
// zoom it is always upsampling.
//
// Here we never rasterise. The gate codes live in a texture indexed by
// (azimuth, range). A fragment shader runs for every screen pixel, walks
// *backwards* — screen pixel → mercator → lon/lat → (range, azimuth) → gate —
// and looks the gate up with NEAREST sampling. Because the lookup is nearest, a
// screen pixel always shows exactly one gate's true value: the NEXRAD pixels stay
// perfect at any zoom, with no spatial interpolation and no mercator-grid
// artefacts. Pan/zoom/rotate are free (the shader was going to run anyway) and
// there is zero per-move JavaScript.

const M_PER_DEG_LAT = 111320;
// Azimuth bins for the data texture. NEXRAD beams are 0.5° (super-res) or 1°
// apart; 1440 bins (0.25°) over-resolves that, so binning each beam to its
// nearest bin reproduces the "each beam owns a wedge to its neighbours" model
// without losing or smearing data.
const NAZ = 1440;
// A beam more than this far (deg) from a bin centre leaves that bin empty, so a
// dropped-radial gap stays a gap instead of being smeared across.
const GAP_DEG = 1.5;

const VERT_SRC = `
attribute vec2 a_pos;            // mercator world coords [0,1]
uniform mat4 u_matrix;
varying vec2 v_merc;
void main() {
  v_merc = a_pos;
  gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
}`;

const FRAG_SRC = `
precision highp float;
varying vec2 v_merc;
uniform sampler2D u_data;        // RG = gate code low/high byte; rows=az, cols=gate
uniform sampler2D u_lut;         // colour ramp, u_steps wide
uniform float u_naz, u_ngate;
uniform float u_firstGate, u_gateSpacing, u_maxRange;  // metres
uniform float u_offset, u_scaleM;                      // code -> value
uniform float u_lo, u_hi, u_steps;                     // value -> LUT index
uniform float u_siteLat, u_siteLon, u_mPerDegLon;
uniform float u_opacity;
uniform float u_smooth;          // 0 = nearest (crisp gates), 1 = bilinear smooth

const float PI = 3.141592653589793;
const float M_PER_DEG_LAT = 111320.0;

// Decode one gate cell to vec2(value, valid). Below-threshold / range-folded
// gates (code < 2) report valid = 0 so the smoothing blend can skip them.
// The azimuth row wraps (the sweep is a closed circle); the gate clamps.
vec2 gateValue(float g, float row) {
  if (g < 0.0 || g >= u_ngate) return vec2(0.0, 0.0);
  float r = mod(row, u_naz);
  vec4 d = texture2D(u_data, vec2((g + 0.5) / u_ngate, (r + 0.5) / u_naz));
  float code = floor(d.r * 255.0 + 0.5) + floor(d.g * 255.0 + 0.5) * 256.0;
  if (code < 2.0) return vec2(0.0, 0.0);
  return vec2((code - u_offset) / u_scaleM, 1.0);
}

void main() {
  // mercator [0,1] -> lon/lat (exact inverse, so the gate boundaries are true).
  float lon = v_merc.x * 360.0 - 180.0;
  float lat = degrees(2.0 * atan(exp((1.0 - 2.0 * v_merc.y) * PI)) - PI * 0.5);

  // local east/north metres relative to the radar (matches sampleAt()).
  float dNorth = (lat - u_siteLat) * M_PER_DEG_LAT;
  float dEast = (lon - u_siteLon) * u_mPerDegLon;
  float range = sqrt(dEast * dEast + dNorth * dNorth);
  if (range > u_maxRange) discard;

  float az = degrees(atan(dEast, dNorth));   // atan2(east, north)
  if (az < 0.0) az += 360.0;

  float v;
  if (u_smooth < 0.5) {
    // Nearest gate along the beam + nearest azimuth bin (no interpolation):
    // one screen pixel = one gate's exact value, the crisp default.
    float g = floor((range - u_firstGate) / u_gateSpacing + 0.5);
    if (g < 0.0 || g >= u_ngate) discard;
    float row = floor(az / 360.0 * u_naz);
    vec2 gv = gateValue(g, row);
    if (gv.y < 0.5) discard;     // below threshold / range folded
    v = gv.x;
  } else {
    // Bilinear interpolation in (gate, azimuth) data space. Gate centres sit at
    // integer range steps; azimuth cell centres sit at (row + 0.5), so the
    // continuous coords below put a sample's neighbours at the integer corners.
    float gc = (range - u_firstGate) / u_gateSpacing;
    float rc = az / 360.0 * u_naz - 0.5;
    float g0 = floor(gc), fg = gc - g0;
    float r0 = floor(rc), fr = rc - r0;
    // Hermite-smooth the blend fractions (zero slope at the cell centres) so the
    // interpolation is C1 instead of piecewise-linear: this rounds off the
    // diamond facets / Mach-band creases that make plain bilinear read "pixely",
    // while the gate centres still hold their true value so pixels stay legible.
    fg = fg * fg * (3.0 - 2.0 * fg);
    fr = fr * fr * (3.0 - 2.0 * fr);
    vec2 s00 = gateValue(g0,       r0);
    vec2 s10 = gateValue(g0 + 1.0, r0);
    vec2 s01 = gateValue(g0,       r0 + 1.0);
    vec2 s11 = gateValue(g0 + 1.0, r0 + 1.0);
    // Weight each corner by its bilinear share AND its validity, then
    // renormalise — so missing/folded gates neither leak nor darken the blend.
    float w00 = (1.0 - fg) * (1.0 - fr) * s00.y;
    float w10 = fg         * (1.0 - fr) * s10.y;
    float w01 = (1.0 - fg) * fr         * s01.y;
    float w11 = fg         * fr         * s11.y;
    float wsum = w00 + w10 + w01 + w11;
    if (wsum < 1e-4) discard;    // no valid gate nearby
    v = (s00.x * w00 + s10.x * w10 + s01.x * w01 + s11.x * w11) / wsum;
  }

  float li = clamp(floor((v - u_lo) * (u_steps - 1.0) / (u_hi - u_lo) + 0.5),
                   0.0, u_steps - 1.0);
  vec4 col = texture2D(u_lut, vec2((li + 0.5) / u_steps, 0.5));
  if (col.a == 0.0) discard;

  float a = col.a * u_opacity;
  gl_FragColor = vec4(col.rgb * a, a);   // premultiplied alpha
}`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS))
    throw new Error('radar shader: ' + gl.getShaderInfoLog(sh));
  return sh;
}

// Resample a sweep's radials into a regular [NAZ x gateCount] grid of gate codes,
// encoded as RG bytes (low, high). Returns { data, w, h } or null if empty.
function buildGrid(sweep, moment) {
  const beams = [];
  let rep = null; // representative moment block for firstGate/gateSpacing
  let gateCount = 0;
  for (const rad of sweep.radials) {
    const m = rad.moments[moment];
    if (!m) continue;
    beams.push({ az: rad.azimuth, m });
    if (m.gateCount > gateCount) gateCount = m.gateCount;
    if (!rep) rep = m;
  }
  if (!beams.length || !gateCount) return null;
  beams.sort((a, b) => a.az - b.az);

  const w = gateCount;
  const h = NAZ;
  const data = new Uint8Array(w * h * 4);
  const nb = beams.length;
  // Beams are sorted by azimuth; as the bin centre sweeps upward, the first beam
  // past the centre only moves forward, so a single advancing cursor finds it.
  // The straddling pair is beams[hi-1] and beams[hi], both taken modulo nb so the
  // wrap at due north (bins below the first beam / above the last) is handled.
  let hi = 0;
  for (let row = 0; row < h; row++) {
    const center = ((row + 0.5) / h) * 360;
    while (hi < nb && beams[hi].az <= center) hi++;
    const a = beams[(hi - 1 + nb) % nb];
    const b = beams[hi % nb];
    let da = Math.abs(center - a.az);
    if (da > 180) da = 360 - da;
    let db = Math.abs(center - b.az);
    if (db > 180) db = 360 - db;
    const best = db < da ? b : a;
    if (Math.min(da, db) > GAP_DEG) continue; // leave the row empty (gap)

    const raw = best.m.raw;
    const gc = best.m.gateCount;
    let o = row * w * 4;
    for (let g = 0; g < w; g++, o += 4) {
      const code = g < gc ? raw[g] : 0;
      data[o] = code & 255;
      data[o + 1] = (code >> 8) & 255;
    }
  }
  return { data, w, h, rep, gateCount };
}

// Mercator [0,1] coordinates a la mapboxgl.MercatorCoordinate.fromLngLat.
function mercX(lon) {
  return (lon + 180) / 360;
}
function mercY(lat) {
  const s = Math.sin((lat * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}

export function createRadarLayer() {
  return {
    id: 'radar',
    type: 'custom',
    renderingMode: '2d',

    map: null,
    gl: null,
    program: null,
    quad: null,
    dataTex: null,
    lutTex: null,
    has: false,        // do we have a sweep to draw?
    pending: null,     // sweep payload set before onAdd / awaiting upload
    uni: null,         // numeric uniforms for the current sweep
    quadVerts: null,   // Float32Array of 6 mercator vertices
    opacity: 0.85,
    smooth: false,     // bilinear-interpolate gates instead of crisp nearest

    onAdd(map, gl) {
      this.map = map;
      this.gl = gl;
      const vs = compile(gl, gl.VERTEX_SHADER, VERT_SRC);
      const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
      const p = gl.createProgram();
      gl.attachShader(p, vs);
      gl.attachShader(p, fs);
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS))
        throw new Error('radar program: ' + gl.getProgramInfoLog(p));
      this.program = p;
      this.aPos = gl.getAttribLocation(p, 'a_pos');
      this.u = {};
      for (const name of [
        'u_matrix', 'u_data', 'u_lut', 'u_naz', 'u_ngate', 'u_firstGate',
        'u_gateSpacing', 'u_maxRange', 'u_offset', 'u_scaleM', 'u_lo', 'u_hi',
        'u_steps', 'u_siteLat', 'u_siteLon', 'u_mPerDegLon', 'u_opacity',
        'u_smooth',
      ])
        this.u[name] = gl.getUniformLocation(p, name);

      this.quad = gl.createBuffer();
      this.dataTex = gl.createTexture();
      this.lutTex = gl.createTexture();

      // A style reload re-runs onAdd on the same logical layer — re-upload.
      if (this.pending) this._upload(this.pending);
    },

    // CPU-side prep: resample to a polar grid, stash the LUT + uniforms, and
    // (if GL is live) push everything to the GPU. Cheap enough to call per
    // playback frame.
    setSweep(sweep, product, site) {
      const grid = buildGrid(sweep, product.moment);
      if (!grid) {
        this.clear();
        return;
      }
      const sc = product.scale;
      const mPerDegLon = M_PER_DEG_LAT * Math.cos((site.lat * Math.PI) / 180);
      const maxRange =
        grid.rep.firstGate + grid.gateCount * grid.rep.gateSpacing;

      this.pending = {
        grid,
        lut: sc.rgba,
        steps: sc.steps,
        uni: {
          naz: grid.h,
          ngate: grid.w,
          firstGate: grid.rep.firstGate,
          gateSpacing: grid.rep.gateSpacing,
          maxRange,
          offset: grid.rep.offset,
          scaleM: grid.rep.scale || 1,
          lo: sc.lo,
          hi: sc.hi,
          siteLat: site.lat,
          siteLon: site.lon,
          mPerDegLon,
        },
      };
      // Bounding quad: the radar coverage box, a hair larger than the last gate.
      const r = maxRange * 1.02;
      const dLat = r / M_PER_DEG_LAT;
      const dLon = r / mPerDegLon;
      const w = mercX(site.lon - dLon);
      const e = mercX(site.lon + dLon);
      const n = mercY(site.lat + dLat);
      const s = mercY(site.lat - dLat);
      // two triangles (TL,TR,BR, TL,BR,BL)
      this.pending.verts = new Float32Array([
        w, n, e, n, e, s,
        w, n, e, s, w, s,
      ]);

      if (this.gl) this._upload(this.pending);
      this.has = true;
      if (this.map) this.map.triggerRepaint();
    },

    _upload(payload) {
      const gl = this.gl;
      const { grid, lut, steps, uni, verts } = payload;

      gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
      gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
      this.quadVerts = verts;

      gl.bindTexture(gl.TEXTURE_2D, this.dataTex);
      // NEAREST + CLAMP: never blend gate codes — this is what keeps the
      // NEXRAD pixels exact.
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, grid.w, grid.h, 0, gl.RGBA,
        gl.UNSIGNED_BYTE, grid.data);

      gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, steps, 1, 0, gl.RGBA,
        gl.UNSIGNED_BYTE, lut);

      this.uni = uni;
      this.steps = steps;
    },

    setOpacity(o) {
      this.opacity = o;
      if (this.map) this.map.triggerRepaint();
    },

    setSmooth(on) {
      this.smooth = !!on;
      if (this.map) this.map.triggerRepaint();
    },

    clear() {
      this.has = false;
      this.pending = null;
      if (this.map) this.map.triggerRepaint();
    },

    render(gl, matrix) {
      if (!this.has || !this.uni || !this.quadVerts) return;
      // Mapbox may hand render() either a raw 4x4 array or an options object.
      const mat =
        matrix && matrix.length === 16
          ? matrix
          : matrix && matrix.defaultProjectionData
          ? matrix.defaultProjectionData.mainMatrix
          : matrix;

      const p = this.program;
      gl.useProgram(p);
      gl.uniformMatrix4fv(this.u.u_matrix, false, mat);

      gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
      gl.enableVertexAttribArray(this.aPos);
      gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, 0, 0);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.dataTex);
      gl.uniform1i(this.u.u_data, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
      gl.uniform1i(this.u.u_lut, 1);

      const U = this.uni;
      gl.uniform1f(this.u.u_naz, U.naz);
      gl.uniform1f(this.u.u_ngate, U.ngate);
      gl.uniform1f(this.u.u_firstGate, U.firstGate);
      gl.uniform1f(this.u.u_gateSpacing, U.gateSpacing);
      gl.uniform1f(this.u.u_maxRange, U.maxRange);
      gl.uniform1f(this.u.u_offset, U.offset);
      gl.uniform1f(this.u.u_scaleM, U.scaleM);
      gl.uniform1f(this.u.u_lo, U.lo);
      gl.uniform1f(this.u.u_hi, U.hi);
      gl.uniform1f(this.u.u_steps, this.steps);
      gl.uniform1f(this.u.u_siteLat, U.siteLat);
      gl.uniform1f(this.u.u_siteLon, U.siteLon);
      gl.uniform1f(this.u.u_mPerDegLon, U.mPerDegLon);
      gl.uniform1f(this.u.u_opacity, this.opacity);
      gl.uniform1f(this.u.u_smooth, this.smooth ? 1 : 0);

      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // premultiplied alpha
      gl.disable(gl.DEPTH_TEST);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    },

    onRemove(map, gl) {
      if (this.program) gl.deleteProgram(this.program);
      if (this.quad) gl.deleteBuffer(this.quad);
      if (this.dataTex) gl.deleteTexture(this.dataTex);
      if (this.lutTex) gl.deleteTexture(this.lutTex);
      this.program = this.quad = this.dataTex = this.lutTex = null;
      this.gl = null;
    },
  };
}
