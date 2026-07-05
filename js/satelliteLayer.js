// satelliteLayer.js — a Mapbox GL custom WebGL layer that drapes a decoded GOES
// ABI scene over the map. Like the radar layer, it never rasterises to a fixed
// canvas: a fragment shader runs for every screen pixel, inverts the web-mercator
// projection to lon/lat, then runs the GOES fixed-grid navigation *backwards*
// (lon/lat → satellite scan angles → grid column/row) and samples the precomputed
// RGBA image with NEAREST. So the imagery stays crisp at any zoom and pan/zoom
// cost no JavaScript.
//
// The colour science (single-channel enhancement or RGB recipe) is baked into
// the RGBA texture on the CPU by satProducts.buildRGBA; this layer only does the
// geometry.

const VERT_SRC = `
attribute vec2 a_pos;
uniform mat4 u_matrix;
varying vec2 v_merc;
void main() {
  v_merc = a_pos;
  gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
}`;

const FRAG_SRC = `
precision highp float;
varying vec2 v_merc;
uniform sampler2D u_tex;
uniform float u_W, u_H;
uniform float u_xScale, u_xOffset, u_yScale, u_yOffset;
uniform float u_lon0, u_satH, u_rEq, u_rPol;
uniform float u_sweepY;
uniform float u_opacity;
uniform float u_smooth;          // 0 = none, 1 = low, 2 = medium, 3 = high (Gaussian)
const float PI = 3.141592653589793;

// Premultiplied-colour fetch of one grid cell; off-disk / missing texels
// (alpha 0) contribute nothing so the disk edge stays clean under smoothing.
vec4 texelAt(float col, float row) {
  if (col < 0.0 || col >= u_W || row < 0.0 || row >= u_H) return vec4(0.0);
  vec4 c = texture2D(u_tex, vec2((col + 0.5) / u_W, (row + 0.5) / u_H));
  return vec4(c.rgb * c.a, c.a);   // premultiply so the blend is colour-correct
}

// Mitchell–Netravali cubic weight for a sample |x| ∈ [0,2] away, parameterised by
// (B,C). It's the standard high-quality image-resampling kernel: unlike a wide
// Gaussian it interpolates (stays sharp, no mush) yet is C1-smooth (no blocks).
// B/C pick the look — (0,0.5) Catmull-Rom is crisp, (1/3,1/3) Mitchell is
// balanced, (1,0) the cubic B-spline is softest with no ringing.
float mnCubic(float x, float B, float C) {
  x = abs(x);
  float x2 = x * x, x3 = x2 * x;
  if (x < 1.0) return ((12.0 - 9.0*B - 6.0*C)*x3 + (-18.0 + 12.0*B + 6.0*C)*x2 + (6.0 - 2.0*B)) / 6.0;
  if (x < 2.0) return ((-B - 6.0*C)*x3 + (6.0*B + 30.0*C)*x2 + (-12.0*B - 48.0*C)*x + (8.0*B + 24.0*C)) / 6.0;
  return 0.0;
}

void main() {
  // web-mercator [0,1] -> lon/lat (radians)
  float lon = (v_merc.x * 360.0 - 180.0) * PI / 180.0;
  float lat = (2.0 * atan(exp((1.0 - 2.0 * v_merc.y) * PI)) - PI * 0.5);

  float req2 = u_rEq * u_rEq;
  float rpol2 = u_rPol * u_rPol;
  // geocentric latitude
  float phic = atan((rpol2 / req2) * tan(lat));
  float cphic = cos(phic);
  float e2 = 1.0 - rpol2 / req2;
  float rc = u_rPol / sqrt(1.0 - e2 * cphic * cphic);

  float dlon = lon - u_lon0;
  float sx = u_satH - rc * cphic * cos(dlon);
  float sy = -rc * cphic * sin(dlon);
  float sz = rc * sin(phic);

  // visible-disk test (point must be on the Earth side facing the satellite)
  if (u_satH * (u_satH - sx) < sy * sy + (req2 / rpol2) * sz * sz) discard;

  float sxyz = sqrt(sx * sx + sy * sy + sz * sz);
  float scanX, scanY;
  // asin's argument can land a hair outside [-1, 1] from rounding (and 0/0 in
  // atan can yield NaN). Some GL stacks — notably Chrome's ANGLE backend on
  // Windows/Linux — then return NaN where Apple/WebKit GPUs clamp, and a NaN
  // here poisons col/row below; clamp the domain so the navigation is finite
  // everywhere the disk is visible.
  if (u_sweepY > 0.5) {
    scanX = atan(sy / sx);
    scanY = asin(clamp(-sz / sxyz, -1.0, 1.0));
  } else {
    scanY = atan(sz / sx);
    scanX = asin(clamp(-sy / sxyz, -1.0, 1.0));
  }

  float col = (scanX - u_xOffset) / u_xScale;
  float row = (scanY - u_yOffset) / u_yScale;
  // Positive-logic bounds test so a NaN col/row discards (a NaN fails every
  // comparison, so the old "col < 0.0 || col >= u_W" form let NaN through and
  // sampled garbage — which reads as a blank disk on stacks that produce NaN).
  if (!(col >= 0.0 && col < u_W && row >= 0.0 && row < u_H)) discard;

  vec3 rgb;
  float alpha;
  if (u_smooth < 0.5) {
    // NEAREST: each ABI pixel stays exact at any zoom (the crisp default).
    vec4 c = texture2D(u_tex, vec2((col + 0.5) / u_W, (row + 0.5) / u_H));
    if (c.a == 0.0) discard;
    rgb = c.rgb;
    alpha = c.a;
  } else {
    // High-quality 4x4 bicubic (Mitchell–Netravali) resample. A wide Gaussian
    // blur — what this used to be — smears the coarse ABI/AHI pixels into mush
    // when you zoom in (the "smoothing looks low quality" complaint); bicubic
    // instead reconstructs a smooth, block-free image that stays sharp, the same
    // filter high-end viewers upsample satellite imagery with. The level picks the
    // look: crisp Catmull-Rom → balanced Mitchell → soft B-spline. Taps sit at the
    // 16 surrounding texel CENTRES (integer positions), point-sampling the exact
    // ABI values, so the cubic — not the hardware bilinear — shapes the result.
    float B = u_smooth < 1.5 ? 0.0 : (u_smooth < 2.5 ? (1.0 / 3.0) : 1.0);
    float C = u_smooth < 1.5 ? 0.5 : (u_smooth < 2.5 ? (1.0 / 3.0) : 0.0);
    float cb = floor(col), rb = floor(row);
    float fx = col - cb, fy = row - rb;
    // Per-axis cubic weights for the four taps at offsets -1,0,1,2.
    float wx0 = mnCubic(fx + 1.0, B, C), wx1 = mnCubic(fx, B, C);
    float wx2 = mnCubic(fx - 1.0, B, C), wx3 = mnCubic(fx - 2.0, B, C);
    float wy0 = mnCubic(fy + 1.0, B, C), wy1 = mnCubic(fy, B, C);
    float wy2 = mnCubic(fy - 1.0, B, C), wy3 = mnCubic(fy - 2.0, B, C);
    vec4 sum = vec4(0.0);
    for (int m = 0; m < 4; m++) {
      float rj = rb + float(m) - 1.0;
      float wy = m == 0 ? wy0 : (m == 1 ? wy1 : (m == 2 ? wy2 : wy3));
      for (int n = 0; n < 4; n++) {
        float ci = cb + float(n) - 1.0;
        float wx = n == 0 ? wx0 : (n == 1 ? wx1 : (n == 2 ? wx2 : wx3));
        sum += texelAt(ci, rj) * (wx * wy);
      }
    }
    // sum is premultiplied; the cubic weights sum to 1, so sum.a is the covered
    // coverage directly. Recover straight-alpha colour by the covered weight and
    // clamp away any cubic overshoot (ringing) so the enhancement can't blow past
    // its colour table. Off-disk taps just soften alpha at the disk edge.
    if (sum.a < 1e-4) discard;
    rgb = clamp(sum.rgb / sum.a, 0.0, 1.0);
    alpha = clamp(sum.a, 0.0, 1.0);
  }

  float a = alpha * u_opacity;
  gl_FragColor = vec4(rgb * a, a); // premultiplied alpha
}`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS))
    throw new Error('satellite shader: ' + gl.getShaderInfoLog(sh));
  return sh;
}

function mercX(lon) { return (lon + 180) / 360; }
function mercY(lat) {
  const s = Math.sin((lat * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}

export const SATELLITE_LAYER_ID = 'radarnexus-satellite';

export function createSatelliteLayer(id = SATELLITE_LAYER_ID) {
  return {
    id,
    type: 'custom',
    renderingMode: '2d',

    map: null,
    gl: null,
    program: null,
    quad: null,
    tex: null,
    has: false,
    pending: null,
    uni: null,
    quadVerts: null,
    opacity: 0.95,
    smooth: 0,         // 0 none, 1 low, 2 medium, 3 high (Gaussian smoothing)

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
        throw new Error('satellite program: ' + gl.getProgramInfoLog(p));
      this.program = p;
      this.aPos = gl.getAttribLocation(p, 'a_pos');
      this.u = {};
      for (const name of [
        'u_matrix', 'u_tex', 'u_W', 'u_H', 'u_xScale', 'u_xOffset', 'u_yScale',
        'u_yOffset', 'u_lon0', 'u_satH', 'u_rEq', 'u_rPol', 'u_sweepY', 'u_opacity',
        'u_smooth',
      ]) this.u[name] = gl.getUniformLocation(p, name);
      this.quad = gl.createBuffer();
      this.tex = gl.createTexture();
      if (this.pending) this._upload(this.pending);
    },

    // scene: from goes.loadScene; rgba: Uint8Array(W*H*4) from buildRGBA;
    // bbox: [w,s,e,n] from goes.sceneBBox.
    setScene(scene, rgba, bbox) {
      const valid = bbox && bbox.every((v) => Number.isFinite(v)) &&
        bbox[0] < bbox[2] && bbox[1] < bbox[3];
      const bb = valid ? bbox : [-180, -85, 180, 85];
      const w = mercX(bb[0]);
      const e = mercX(bb[2]);
      const n = mercY(Math.max(-85, Math.min(85, bb[3])));
      const s = mercY(Math.max(-85, Math.min(85, bb[1])));
      const verts = new Float32Array([w, n, e, n, e, s, w, n, e, s, w, s]);

      this.pending = {
        rgba, W: scene.width, H: scene.height, verts,
        uni: {
          W: scene.width, H: scene.height,
          xScale: scene.xScale, xOffset: scene.xOffset,
          yScale: scene.yScale, yOffset: scene.yOffset,
          lon0: scene.proj.lon0, satH: scene.proj.H,
          rEq: scene.proj.rEq, rPol: scene.proj.rPol,
          sweepY: scene.proj.sweep === 'y' ? 1 : 0,
        },
      };
      if (this.gl) this._upload(this.pending);
      this.has = true;
      if (this.map) this.map.triggerRepaint();
    },

    _upload(payload) {
      const gl = this.gl;
      const { rgba, W, H, verts, uni } = payload;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
      gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
      this.quadVerts = verts;

      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      // NEAREST keeps each ABI pixel exact at any zoom (no "auto smoothing"),
      // matching the radar/MRMS layers; the projection math already samples at
      // the cell centre.
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);

      this.uni = uni;
    },

    setOpacity(o) { this.opacity = o; if (this.map) this.map.triggerRepaint(); },

    setSmooth(level) { this.smooth = +level || 0; if (this.map) this.map.triggerRepaint(); },

    clear() {
      this.has = false;
      this.pending = null;
      if (this.map) this.map.triggerRepaint();
    },

    render(gl, matrix) {
      if (!this.has || !this.uni || !this.quadVerts) return;
      const mat = matrix && matrix.length === 16
        ? matrix
        : matrix && matrix.defaultProjectionData
        ? matrix.defaultProjectionData.mainMatrix
        : matrix;

      gl.useProgram(this.program);
      gl.uniformMatrix4fv(this.u.u_matrix, false, mat);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
      gl.enableVertexAttribArray(this.aPos);
      gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, 0, 0);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.uniform1i(this.u.u_tex, 0);
      // NEAREST in both modes: level 0 keeps each ABI pixel exact, and the smoothed
      // pass does its own bicubic reconstruction from point-sampled texel centres,
      // so hardware bilinear would only double-filter (softening the cubic result).
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

      const U = this.uni;
      gl.uniform1f(this.u.u_W, U.W);
      gl.uniform1f(this.u.u_H, U.H);
      gl.uniform1f(this.u.u_xScale, U.xScale);
      gl.uniform1f(this.u.u_xOffset, U.xOffset);
      gl.uniform1f(this.u.u_yScale, U.yScale);
      gl.uniform1f(this.u.u_yOffset, U.yOffset);
      gl.uniform1f(this.u.u_lon0, U.lon0);
      // Feed the projection lengths normalised by the equatorial radius. The
      // shader builds the satellite scan angles purely from ratios of these, and
      // the disk-visibility test scales uniformly, so the result is identical —
      // but every intermediate stays O(1) instead of ~1e7 (and its square ~1e15).
      // At that magnitude some desktop GPUs' highp floats lose enough precision
      // that the visibility test discards the whole disk and nothing draws (iOS /
      // Apple GPUs keep more, which is why it rendered there); normalising fixes
      // it everywhere.
      const s = U.rEq || 6378137;
      gl.uniform1f(this.u.u_satH, U.satH / s);
      gl.uniform1f(this.u.u_rEq, U.rEq / s);
      gl.uniform1f(this.u.u_rPol, U.rPol / s);
      gl.uniform1f(this.u.u_sweepY, U.sweepY);
      gl.uniform1f(this.u.u_opacity, this.opacity);
      gl.uniform1f(this.u.u_smooth, this.smooth);

      gl.enable(gl.BLEND);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.STENCIL_TEST);
      gl.disable(gl.CULL_FACE);
      gl.depthMask(false);
      gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    },

    onRemove(map, gl) {
      if (this.program) gl.deleteProgram(this.program);
      if (this.quad) gl.deleteBuffer(this.quad);
      if (this.tex) gl.deleteTexture(this.tex);
      this.program = this.quad = this.tex = null;
      this.gl = null;
    },
  };
}
