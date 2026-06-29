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
    // Gaussian low-pass over a 7x7 pixel neighbourhood — sigma grows with the
    // level (low/medium/high) so even coarse ABI pixels dissolve into a smooth
    // field instead of staying visible as blocks. The texels are premultiplied,
    // so blending colour and alpha with the Gaussian weights is colour-correct;
    // off-disk neighbours (alpha 0) just soften the disk edge.
    float sigma = u_smooth < 1.5 ? 0.6 : (u_smooth < 2.5 ? 1.1 : 1.8);
    float cn = floor(col + 0.5), rn = floor(row + 0.5);
    float inv2s2 = 1.0 / (2.0 * sigma * sigma);
    vec4 sum = vec4(0.0);
    float wsum = 0.0;               // total Gaussian weight (incl. off-disk taps)
    for (int m = -3; m <= 3; m++) {
      for (int n = -3; n <= 3; n++) {
        float ci = cn + float(n), rj = rn + float(m);
        float dx = ci - col, dy = rj - row;
        float w = exp(-(dx * dx + dy * dy) * inv2s2);
        sum += texelAt(ci, rj) * w;
        wsum += w;
      }
    }
    if (sum.a < 1e-4 || wsum < 1e-6) discard;
    // sum is premultiplied. The colour divides by the covered weight (sum.a) to
    // recover straight-alpha colour, but the coverage must divide by the TOTAL
    // weight (wsum) so it stays in [0,1]. The old code set alpha = sum.a — the raw
    // Gaussian weight-sum, which for the medium/high kernels is much greater than
    // 1 — so the premultiplied rgb*a blew past white: the "blinding light" that
    // wiped out the colour tables. Normalising by wsum keeps the enhancement
    // intact and only softens alpha at the disk edge (where some taps are off-disk).
    rgb = sum.rgb / sum.a;
    alpha = sum.a / wsum;
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

export function createSatelliteLayer() {
  return {
    id: SATELLITE_LAYER_ID,
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
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.disable(gl.DEPTH_TEST);
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
