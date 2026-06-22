// export.js — capture the live scope as a shareable PNG.
//
// No external libraries. The Mapbox basemap, the custom radar/satellite WebGL
// layers and the draw/measure shapes all render into the map's single WebGL
// canvas, so a `toDataURL` of that canvas already contains the full picture (the
// map is created with preserveDrawingBuffer:true so the backbuffer stays
// readable). We composite that canvas onto a 2D canvas, stamp a title banner and
// a color legend reconstructed from the live `#legend` DOM, then present a small
// preview modal offering native Share, Copy and Download.
//
// In split view both panes are passed in and laid out side by side.

export class ExportTool {
  // getScene() -> { canvases:[HTMLCanvasElement], caption, legendEl }
  //   canvases : one map canvas, or two for split view (left → right)
  //   caption  : { brand, tagline, title, sub, time, stamp }
  //   legendEl : the live legend element to redraw, or null
  constructor({ getScene }) {
    this.getScene = getScene;
    this._scrim = null;
  }

  // Build the image and open the preview modal. Any failure (e.g. a blocked GL
  // read) surfaces through onError so the caller can show a status message.
  run() {
    const scene = this.getScene();
    if (!scene || !scene.canvases || !scene.canvases.length) return;
    const canvas = this._compose(scene);
    this._openModal(canvas, scene.caption);
  }

  // ---- Composition --------------------------------------------------------
  _compose(scene) {
    const maps = scene.canvases;
    const cap = scene.caption || {};
    const legend = readLegend(scene.legendEl);

    // Device-pixel ratio of the backing store, so banner text matches the map's
    // crispness on hi-dpi screens.
    const dpr = (maps[0].width / maps[0].clientWidth) || 1;
    const gap = maps.length > 1 ? Math.round(2 * dpr) : 0;
    const mapW = maps.reduce((s, c) => s + c.width, 0) + gap * (maps.length - 1);
    const mapH = Math.max(...maps.map((c) => c.height));

    const headerH = Math.round(70 * dpr);
    const footerH = Math.round((legend ? 58 : 34) * dpr);

    const out = document.createElement('canvas');
    out.width = mapW;
    out.height = headerH + mapH + footerH;
    const ctx = out.getContext('2d');

    // Header band.
    ctx.fillStyle = '#0a0e14';
    ctx.fillRect(0, 0, out.width, headerH);
    drawHeader(ctx, cap, out.width, headerH, dpr);

    // The map panes.
    let x = 0;
    for (const c of maps) {
      ctx.drawImage(c, x, headerH, c.width, c.height);
      x += c.width + gap;
    }

    // Footer band: legend (left) + credit/timestamp (right).
    const fy = headerH + mapH;
    ctx.fillStyle = '#0a0e14';
    ctx.fillRect(0, fy, out.width, footerH);
    if (legend) drawLegend(ctx, legend, out.width, fy, footerH, dpr);
    drawCredit(ctx, cap, out.width, fy, footerH, dpr, !!legend);

    return out;
  }

  // ---- Preview modal ------------------------------------------------------
  _openModal(canvas, cap) {
    this._close();
    const scrim = document.createElement('div');
    scrim.className = 'export-scrim';

    const card = document.createElement('div');
    card.className = 'export-card';

    const head = document.createElement('div');
    head.className = 'export-head';
    head.innerHTML = `<h2>Export image</h2>`;
    const closeBtn = document.createElement('button');
    closeBtn.className = 'export-x';
    closeBtn.title = 'Close (Esc)';
    closeBtn.textContent = '✕';
    head.appendChild(closeBtn);

    const preview = document.createElement('div');
    preview.className = 'export-preview';
    canvas.classList.add('export-img');
    preview.appendChild(canvas);

    const actions = document.createElement('div');
    actions.className = 'export-actions';

    const fileName = `aether-${slug(cap && cap.title)}-${tsForName()}.png`;
    const toBlob = () => new Promise((res) => canvas.toBlob(res, 'image/png'));

    // Native share — only shown when the platform can share files.
    const shareBtn = mkBtn('⤴ Share', 'primary');
    const canShareFiles =
      typeof navigator !== 'undefined' &&
      navigator.canShare &&
      (() => {
        try {
          return navigator.canShare({ files: [new File([new Blob()], fileName, { type: 'image/png' })] });
        } catch (_) {
          return false;
        }
      })();
    if (canShareFiles) {
      shareBtn.addEventListener('click', async () => {
        try {
          const blob = await toBlob();
          const file = new File([blob], fileName, { type: 'image/png' });
          await navigator.share({
            files: [file],
            title: 'AETHER radar',
            text: shareText(cap),
          });
        } catch (e) {
          if (e && e.name !== 'AbortError') flash(shareBtn, 'Share failed');
        }
      });
      actions.appendChild(shareBtn);
    }

    // Copy to clipboard (where supported).
    const copyBtn = mkBtn('⧉ Copy');
    copyBtn.addEventListener('click', async () => {
      try {
        const blob = await toBlob();
        await navigator.clipboard.write([new window.ClipboardItem({ 'image/png': blob })]);
        flash(copyBtn, '✓ Copied');
      } catch (e) {
        flash(copyBtn, 'Copy blocked');
      }
    });
    if (navigator.clipboard && window.ClipboardItem) actions.appendChild(copyBtn);

    // Download always works.
    const dlBtn = mkBtn('⤓ Download', canShareFiles ? '' : 'primary');
    dlBtn.addEventListener('click', async () => {
      const blob = await toBlob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    });
    actions.appendChild(dlBtn);

    card.append(head, preview, actions);
    scrim.appendChild(card);
    document.body.appendChild(scrim);
    this._scrim = scrim;

    const onKey = (e) => {
      if (e.key === 'Escape') this._close();
    };
    document.addEventListener('keydown', onKey);
    this._onKey = onKey;
    scrim.addEventListener('click', (e) => {
      if (e.target === scrim) this._close();
    });
    closeBtn.addEventListener('click', () => this._close());
  }

  _close() {
    if (this._onKey) {
      document.removeEventListener('keydown', this._onKey);
      this._onKey = null;
    }
    if (this._scrim) {
      this._scrim.remove();
      this._scrim = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Banner painting helpers
// ---------------------------------------------------------------------------
const MONO = "'JetBrains Mono', ui-monospace, monospace";
const SANS = "'Space Grotesk', system-ui, sans-serif";

function drawHeader(ctx, cap, W, H, dpr) {
  const padX = Math.round(20 * dpr);
  // Brand accent bar.
  ctx.fillStyle = '#36e2c4';
  ctx.fillRect(0, 0, Math.round(4 * dpr), H);

  ctx.textBaseline = 'middle';
  // Brand mark + tagline (left).
  ctx.fillStyle = '#36e2c4';
  ctx.font = `700 ${Math.round(15 * dpr)}px ${MONO}`;
  ctx.textAlign = 'left';
  ctx.fillText((cap.brand || 'AETHER'), padX, Math.round(H * 0.34));
  ctx.fillStyle = '#6b7785';
  ctx.font = `400 ${Math.round(10 * dpr)}px ${MONO}`;
  ctx.fillText((cap.tagline || ''), padX, Math.round(H * 0.66));

  // Title + sub (centre-left, after the brand block).
  const tx = padX + Math.round(150 * dpr);
  ctx.fillStyle = '#e8eef5';
  ctx.font = `700 ${Math.round(20 * dpr)}px ${SANS}`;
  ctx.fillText(clip(ctx, cap.title || '', W - tx - Math.round(150 * dpr)), tx, Math.round(H * 0.34));
  ctx.fillStyle = '#9aa7b4';
  ctx.font = `500 ${Math.round(12 * dpr)}px ${SANS}`;
  ctx.fillText(clip(ctx, cap.sub || '', W - tx - Math.round(150 * dpr)), tx, Math.round(H * 0.68));

  // Scan time (right).
  if (cap.time) {
    ctx.textAlign = 'right';
    ctx.fillStyle = '#36e2c4';
    ctx.font = `700 ${Math.round(16 * dpr)}px ${MONO}`;
    ctx.fillText(cap.time, W - padX, Math.round(H * 0.5));
  }
  ctx.textAlign = 'left';
}

function drawLegend(ctx, legend, W, y, H, dpr) {
  const padX = Math.round(20 * dpr);
  const barW = Math.min(Math.round(260 * dpr), Math.round(W * 0.4));
  const barH = Math.round(12 * dpr);
  const barX = padX;
  const barY = y + Math.round(H * 0.32);

  // Title above the bar.
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#9aa7b4';
  ctx.font = `600 ${Math.round(10 * dpr)}px ${MONO}`;
  ctx.fillText((legend.title || '').toUpperCase(), barX, barY - Math.round(5 * dpr));

  // Gradient bar.
  if (legend.stops && legend.stops.length) {
    const grad = ctx.createLinearGradient(barX, 0, barX + barW, 0);
    for (const [pos, color] of legend.stops) grad.addColorStop(Math.max(0, Math.min(1, pos)), color);
    ctx.fillStyle = grad;
    ctx.fillRect(barX, barY, barW, barH);
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = Math.max(1, dpr);
    ctx.strokeRect(barX, barY, barW, barH);
  }

  // Ticks under the bar.
  const ticks = legend.ticks || [];
  ctx.fillStyle = '#6b7785';
  ctx.font = `400 ${Math.round(10 * dpr)}px ${MONO}`;
  const ty = barY + barH + Math.round(13 * dpr);
  if (ticks[0]) { ctx.textAlign = 'left'; ctx.fillText(ticks[0], barX, ty); }
  if (ticks[1]) { ctx.textAlign = 'center'; ctx.fillText(ticks[1], barX + barW / 2, ty); }
  if (ticks[2]) { ctx.textAlign = 'right'; ctx.fillText(ticks[2], barX + barW, ty); }
  ctx.textAlign = 'left';
}

function drawCredit(ctx, cap, W, y, H, dpr) {
  const padX = Math.round(20 * dpr);
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#6b7785';
  ctx.font = `400 ${Math.round(11 * dpr)}px ${MONO}`;
  const credit = `${cap.stamp || ''}  ·  aether — browser-native NEXRAD scope`;
  ctx.fillText(credit, W - padX, y + H / 2);
  ctx.textAlign = 'left';
}

// Truncate text with an ellipsis so it fits `maxW` px in the current font.
function clip(ctx, text, maxW) {
  if (!text || ctx.measureText(text).width <= maxW) return text || '';
  let t = text;
  while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t + '…';
}

// ---------------------------------------------------------------------------
// Read the live legend DOM into { title, stops:[[0..1, 'rgb()']], ticks:[...] }
// ---------------------------------------------------------------------------
function readLegend(legendEl) {
  if (!legendEl) return null;
  const bar = legendEl.querySelector('.legend-bar');
  if (!bar) return null;
  const css = bar.style.background || bar.style.backgroundImage ||
    getComputedStyle(bar).backgroundImage || '';
  const stops = parseGradient(css);
  if (!stops.length) return null;
  const titleEl = legendEl.querySelector('.legend-title');
  const title = titleEl ? titleEl.textContent.replace(/\s+/g, ' ').trim() : '';
  const ticks = [...legendEl.querySelectorAll('.legend-ticks span')].map((s) => s.textContent.trim());
  return { title, stops, ticks };
}

// Parse `linear-gradient(90deg, rgb(r,g,b) 12.5%, …)` into ordered colour stops
// in the 0..1 range. Stops without an explicit percentage are spread evenly.
function parseGradient(css) {
  // Strip the `linear-gradient(… deg,` prefix so the leading angle isn't read as
  // a stop, then pull each `<color> [pos%]` token (rgb()/rgba()/hex all work as
  // canvas addColorStop inputs).
  const body = css.replace(/^[^,]*\bgradient\([^,]*,/i, '');
  const out = [];
  const re = /(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\))\s*([\d.]+%)?/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const color = m[1];
    const pos = m[2] != null ? parseFloat(m[2]) / 100 : null;
    out.push([pos, color]);
  }
  const n = out.length;
  return out.map(([pos, color], i) => [pos == null ? (n > 1 ? i / (n - 1) : 0) : pos, color]);
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------
function mkBtn(label, variant) {
  const b = document.createElement('button');
  b.className = 'export-btn' + (variant ? ' ' + variant : '');
  b.textContent = label;
  return b;
}

function flash(btn, msg) {
  const prev = btn.textContent;
  btn.textContent = msg;
  btn.disabled = true;
  setTimeout(() => {
    btn.textContent = prev;
    btn.disabled = false;
  }, 1400);
}

function shareText(cap) {
  if (!cap) return 'AETHER radar';
  return [cap.title, cap.sub, cap.time].filter(Boolean).join(' · ');
}

function slug(s) {
  return (s || 'scope').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'scope';
}

function tsForName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}z`;
}
