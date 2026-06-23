// gridLayer.js — a Mapbox GL custom WebGL layer for a regular lat/lon (plate-
// carrée) grid, used for the MRMS products decoded by grib2.js/mrms.js. Same idea
// as the radar/satellite layers: a fragment shader inverts web-mercator to
// lon/lat per screen pixel, finds the grid cell, and looks up its colour with
// NEAREST sampling — so the grid stays pixel-exact at any zoom.
//
// The decoded MRMS grid is huge (7000×3500 ≈ 24.5 M cells). We max-pool it down
// to a GPU-friendly texture before upload (max-pool, not average, so peak hail /
// rotation / rainfall values survive the reduction). Each cell is stored as a
// 16-bit normalised code in the R,G bytes; 0 means "missing" (transparent).

const MAX_DIM = 3600; // cap the larger texture dimension

const VERT_SRC = `
attribute vec2 a_pos;
uniform mat4 u_matrix;
varying vec2 v_merc;
void main() { v_merc = a_pos; gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0); }`;

const FRAG_SRC = `
precision highp float;
varying vec2 v_merc;
uniform sampler2D u_data;
uniform sampler2D u_lut;
uniform float u_ni, u_nj;
uniform float u_lon1, u_lat1, u_di, u_dj;
uniform float u_steps, u_opacity;
uniform float u_smooth;          // 0 = nearest (crisp cells), 1 = bilinear smooth
const float PI = 3.141592653589793;

// Decode one grid cell to vec2(t, valid), t in [0,1]. Missing cells (code 0)
// report valid = 0 so the smoothing blend can skip them.
vec2 cellValue(float ci, float cj) {
  if (ci < 0.0 || ci >= u_ni || cj < 0.0 || cj >= u_nj) return vec2(0.0, 0.0);
  vec4 d = texture2D(u_data, vec2((ci + 0.5) / u_ni, (cj + 0.5) / u_nj));
  float code = floor(d.r * 255.0 + 0.5) + floor(d.g * 255.0 + 0.5) * 256.0;
  if (code < 1.0) return vec2(0.0, 0.0);
  return vec2((code - 1.0) / 65534.0, 1.0);
}

void main() {
  float lon = v_merc.x * 360.0 - 180.0;
  float lat = degrees(2.0 * atan(exp((1.0 - 2.0 * v_merc.y) * PI)) - PI * 0.5);
  float fi = (lon - u_lon1) / u_di;
  float fj = (u_lat1 - lat) / u_dj;       // row 0 is the northernmost
  if (fi < 0.0 || fi >= u_ni || fj < 0.0 || fj >= u_nj) discard;

  float t;
  if (u_smooth < 0.5) {
    vec2 cv = cellValue(floor(fi), floor(fj));   // NEAREST: crisp cell
    if (cv.y < 0.5) discard;                      // missing
    t = cv.x;
  } else {
    // Bilinear interpolation in (i, j) cell space. Cell centres sit at integer
    // indices, so shifting by -0.5 lands a sample's neighbours on the corners.
    float ic = fi - 0.5, jc = fj - 0.5;
    float i0 = floor(ic), fi2 = ic - i0;
    float j0 = floor(jc), fj2 = jc - j0;
    vec2 s00 = cellValue(i0,       j0);
    vec2 s10 = cellValue(i0 + 1.0, j0);
    vec2 s01 = cellValue(i0,       j0 + 1.0);
    vec2 s11 = cellValue(i0 + 1.0, j0 + 1.0);
    float w00 = (1.0 - fi2) * (1.0 - fj2) * s00.y;
    float w10 = fi2         * (1.0 - fj2) * s10.y;
    float w01 = (1.0 - fi2) * fj2         * s01.y;
    float w11 = fi2         * fj2         * s11.y;
    float wsum = w00 + w10 + w01 + w11;
    if (wsum < 1e-4) discard;                     // no valid cell nearby
    t = (s00.x * w00 + s10.x * w10 + s01.x * w01 + s11.x * w11) / wsum;
  }

  float li = clamp(floor(t * (u_steps - 1.0) + 0.5), 0.0, u_steps - 1.0);
  vec4 col = texture2D(u_lut, vec2((li + 0.5) / u_steps, 0.5));
  if (col.a == 0.0) discard;
  float a = col.a * u_opacity;
  gl_FragColor = vec4(col.rgb * a, a);
}`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS))
    throw new Error('grid shader: ' + gl.getShaderInfoLog(sh));
  return sh;
}

function mercX(lon) { return (lon + 180) / 360; }
function mercY(lat) {
  const s = Math.sin((lat * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}

// Max-pool the grid down and encode each surviving cell as a 16-bit code.
function buildTexture(grid, product) {
  const { ni, nj, values, lon1, lat1, di, dj } = grid;
  const factor = Math.max(1, Math.ceil(Math.max(ni, nj) / MAX_DIM));
  const W = Math.ceil(ni / factor);
  const H = Math.ceil(nj / factor);
  const data = new Uint8Array(W * H * 4);
  const { lo, hi, floor } = product;
  const span = hi - lo || 1;

  for (let oy = 0; oy < H; oy++) {
    for (let ox = 0; ox < W; ox++) {
      let best = -Infinity;
      for (let r = 0; r < factor; r++) {
        const sy = oy * factor + r;
        if (sy >= nj) break;
        const base = sy * ni + ox * factor;
        for (let c = 0; c < factor; c++) {
          const sx = ox * factor + c;
          if (sx >= ni) break;
          const v = values[base + c];
          if (v > best) best = v;
        }
      }
      const o = (oy * W + ox) * 4;
      if (!(best >= floor) || Number.isNaN(best)) continue; // leave code 0 (missing)
      let t = (best - lo) / span;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const code = 1 + Math.round(t * 65534);
      data[o] = code & 255;
      data[o + 1] = (code >> 8) & 255;
    }
  }
  return { data, W, H, lon1, lat1, di: di * factor, dj: dj * factor };
}

// Build the GPU-ready payload for a grid (max-pooled texture + quad geometry +
// color LUT) without touching any GL context. Pulling this out of the layer lets
// playback precompute and cache the lightweight payload per frame — crucial
// because a raw MRMS grid is ~100 MB, far too big to hold many of.
export function prepareGridTexture(grid, product) {
  const tex = buildTexture(grid, product);
  const sc = product.scale;
  const w = mercX(tex.lon1);
  const e = mercX(tex.lon1 + tex.W * tex.di);
  const n = mercY(tex.lat1);
  const s = mercY(tex.lat1 - tex.H * tex.dj);
  const verts = new Float32Array([w, n, e, n, e, s, w, n, e, s, w, s]);
  return {
    tex, verts, lut: sc.rgba, steps: sc.steps,
    uni: { ni: tex.W, nj: tex.H, lon1: tex.lon1, lat1: tex.lat1, di: tex.di, dj: tex.dj },
  };
}

export function createGridLayer(id = 'mrms') {
  return {
    id,
    type: 'custom',
    renderingMode: '2d',

    map: null, gl: null, program: null, quad: null, dataTex: null, lutTex: null,
    has: false, pending: null, uni: null, quadVerts: null, steps: 1024, opacity: 0.9,
    smooth: false,

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
        throw new Error('grid program: ' + gl.getProgramInfoLog(p));
      this.program = p;
      this.aPos = gl.getAttribLocation(p, 'a_pos');
      this.u = {};
      for (const n of ['u_matrix', 'u_data', 'u_lut', 'u_ni', 'u_nj', 'u_lon1',
        'u_lat1', 'u_di', 'u_dj', 'u_steps', 'u_opacity', 'u_smooth'])
        this.u[n] = gl.getUniformLocation(p, n);
      this.quad = gl.createBuffer();
      this.dataTex = gl.createTexture();
      this.lutTex = gl.createTexture();
      if (this.pending) this._upload(this.pending);
    },

    setGrid(grid, product) {
      this.showPrepared(prepareGridTexture(grid, product));
    },

    // Display an already-prepared payload (from prepareGridTexture). Playback
    // uses this to swap cached frames without rebuilding the texture each time.
    showPrepared(payload) {
      this.pending = payload;
      if (this.gl) this._upload(this.pending);
      this.has = true;
      if (this.map) this.map.triggerRepaint();
    },

    _upload(payload) {
      const gl = this.gl;
      const { tex, verts, lut, steps, uni } = payload;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
      gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
      this.quadVerts = verts;

      gl.bindTexture(gl.TEXTURE_2D, this.dataTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, tex.W, tex.H, 0, gl.RGBA, gl.UNSIGNED_BYTE, tex.data);

      gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, steps, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, lut);

      this.uni = uni;
      this.steps = steps;
    },

    setOpacity(o) { this.opacity = o; if (this.map) this.map.triggerRepaint(); },

    setSmooth(on) { this.smooth = !!on; if (this.map) this.map.triggerRepaint(); },

    clear() { this.has = false; this.pending = null; if (this.map) this.map.triggerRepaint(); },

    render(gl, matrix) {
      if (!this.has || !this.uni || !this.quadVerts) return;
      const mat = matrix && matrix.length === 16 ? matrix
        : matrix && matrix.defaultProjectionData ? matrix.defaultProjectionData.mainMatrix : matrix;
      gl.useProgram(this.program);
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
      gl.uniform1f(this.u.u_ni, U.ni);
      gl.uniform1f(this.u.u_nj, U.nj);
      gl.uniform1f(this.u.u_lon1, U.lon1);
      gl.uniform1f(this.u.u_lat1, U.lat1);
      gl.uniform1f(this.u.u_di, U.di);
      gl.uniform1f(this.u.u_dj, U.dj);
      gl.uniform1f(this.u.u_steps, this.steps);
      gl.uniform1f(this.u.u_opacity, this.opacity);
      gl.uniform1f(this.u.u_smooth, this.smooth ? 1 : 0);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
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
