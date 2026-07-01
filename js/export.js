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
  // getScene() -> { canvases:[HTMLCanvasElement], caption, legendEl, alert, briefing }
  //   canvases : one map canvas, or two for split view (left → right)
  //   caption  : { brand, title, sub, time, stamp }
  //   legendEl : the live legend element to redraw, or null
  //   alert    : the open alert preview card to stamp over the map, or null —
  //              { color, title, area, rows:[[label, value], …] }
  //   briefing : the open full alert detail view to reproduce as an on-screen
  //              side panel, or null — { color, title, expires, hazards, motion,
  //              guidance, issued, location, instruction, description, tags,
  //              group }. Takes precedence over `alert` when present.
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
    const theme = normalizeTheme(scene.theme);

    // Pane grid: 4 panes compose as a 2×2 grid (matching the on-screen quad
    // layout — panes 1/2 on top, 3/4 below); anything else stays one row.
    const gap = maps.length > 1 ? 2 : 0;
    const cols = maps.length === 4 ? 2 : maps.length;
    const rows = Math.ceil(maps.length / cols);
    const cellW = Math.max(...maps.map((c) => c.width));
    const cellH = Math.max(...maps.map((c) => c.height));
    const mapW = cols * cellW + gap * (cols - 1);
    const mapH = rows * cellH + gap * (rows - 1);

    // Size the banners relative to the image width so the layout keeps the same
    // proportions whatever the map's resolution/DPR — with a floor so a small
    // (mobile) capture stays legible and a ceiling so a huge one isn't blown up.
    // On phones the captured map is narrow, so the default unit comes out tiny
    // and the header/legend are unreadable when shared. Scale the unit up there
    // (bigger divisor floor) — the header, legend and credit are all measured
    // against `u` and clipped/dropped if space runs out, so a larger unit makes
    // the text far more readable without ever letting the colour table overlap.
    const mobile =
      typeof window !== 'undefined' &&
      Math.min(window.innerWidth || Infinity, window.innerHeight || Infinity) <= 820;
    // Sized so the banner text stays clearly readable when the image is
    // shared/downscaled to a phone timeline, but capped against the map height
    // so a short capture isn't dominated by the bands.
    const u = Math.min(
      mobile
        ? clamp(mapW / 34, 28, 56) // phones: chunkier, readable banners
        : clamp(mapW / 42, 22, 56), // base text unit, ~px
      Math.max(18, mapH / 12));
    const padX = Math.round(u * 1.4);
    const headerH = Math.round(u * 4.4);
    const footerH = Math.round(legend ? u * 4.6 : u * 2.4);

    // Desktop alert briefings make the stage yield room to the side panel.
    // Mirror that in the export: draw the briefing beside the pane grid instead
    // of over the left column, or quad/split exports lose the left panes.
    const dockBriefing = !!scene.briefing && !mobile;
    const briefingW = scene.briefing
      ? briefingPanelWidth(mapW, u, mobile, maps.length > 1)
      : 0;
    const mapX = dockBriefing ? briefingW : 0;
    const outW = mapW + (dockBriefing ? briefingW : 0);

    const out = document.createElement('canvas');
    out.width = outW;
    out.height = headerH + mapH + footerH;
    const ctx = out.getContext('2d');
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, out.width, out.height);

    // Header band.
    ctx.fillStyle = theme.panel;
    ctx.fillRect(0, 0, out.width, headerH);
    drawHeader(ctx, cap, out.width, headerH, u, padX, theme);

    // The map panes, laid out on the grid (centred in their cell if smaller).
    maps.forEach((c, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const px = mapX + col * (cellW + gap) + Math.round((cellW - c.width) / 2);
      const py = headerH + row * (cellH + gap) + Math.round((cellH - c.height) / 2);
      ctx.drawImage(c, px, py, c.width, c.height);
    });

    // Multi-pane exports lose the on-screen pane badges (DOM overlays, not part
    // of the canvas), so stamp each pane's product in its top-left corner.
    if (maps.length > 1 && scene.paneLabels && scene.paneLabels.length) {
      maps.forEach((c, i) => {
        const label = scene.paneLabels[i];
        if (!label) return;
        const col = i % cols;
        const row = Math.floor(i / cols);
        drawPaneTag(ctx, String(label),
          mapX + col * (cellW + gap), headerH + row * (cellH + gap), u, theme);
      });
    }

    // The full alert briefing reproduced as the on-screen side panel takes
    // precedence; otherwise the floating preview card is stamped over the map
    // near the bottom (matching where it sits live), without its "View full
    // briefing" footer.
    if (scene.briefing) {
      if (dockBriefing) {
        drawAlertBriefing(ctx, scene.briefing, 0, headerH, briefingW, mapH, u, mobile, theme, {
          panelW: briefingW,
          compact: maps.length > 1,
        });
      } else {
        drawAlertBriefing(ctx, scene.briefing, 0, headerH, mapW, mapH, u, mobile, theme);
      }
    }
    else if (scene.alert) drawAlertCard(ctx, scene.alert, 0, headerH, mapW, mapH, u, mobile, theme);

    // Footer band: legend (left) + credit/timestamp (right), measured so they
    // never collide.
    const fy = headerH + mapH;
    ctx.fillStyle = theme.panel;
    ctx.fillRect(0, fy, out.width, footerH);
    // Hairline separators between the map and each band.
    ctx.fillStyle = theme.separator;
    ctx.fillRect(0, headerH - 1, out.width, 1);
    ctx.fillRect(0, fy, out.width, 1);

    const legendRight = legend
      ? drawLegend(ctx, legend, padX, fy, footerH, u, out.width - padX * 2, theme)
      : padX;
    drawCredit(ctx, cap, legendRight + Math.round(u), out.width - padX, fy, footerH, u, theme);

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

    const fileName = `radarnexus-${slug(cap && cap.title)}-${tsForName()}.png`;
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
            title: 'RadarNexus radar',
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
      // Play the exit animation, then remove. Detach immediately from this._scrim
      // so a re-open doesn't race with the pending removal.
      const scrim = this._scrim;
      this._scrim = null;
      scrim.classList.add('closing');
      setTimeout(() => scrim.remove(), 200);
    }
  }
}

// ---------------------------------------------------------------------------
// Banner painting helpers
// ---------------------------------------------------------------------------
const MONO = "'JetBrains Mono', ui-monospace, monospace";
const SANS = "'Manrope', system-ui, sans-serif";

// Header: "◆ RadarNexus" wordmark on the left, title + sub stacked in the middle,
// scan time on the right. Everything is measured and clipped so the three blocks
// never overlap, whatever the image width. `u` is the base text unit (~px).
function drawHeader(ctx, cap, W, H, u, padX, theme) {
  const AZURE = theme.accent;
  // Brand accent bar down the left edge.
  ctx.fillStyle = AZURE;
  ctx.fillRect(0, 0, Math.max(2, Math.round(u * 0.22)), H);

  const midY = Math.round(H / 2);
  // Wordmark (left), vertically centred. Drawn two-tone when the brand is the
  // default RadarNexus — white "Radar" + azure "Nexus", matching the logo.
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.font = `700 ${Math.round(u * 1.15)}px ${MONO}`;
  const brand = cap.brand || 'RadarNexus';
  let brandRight;
  const split = /^Radar(Nexus)$/.test(brand) ? ['Radar', 'Nexus'] : null;
  if (split) {
    ctx.fillStyle = theme.text;
    ctx.fillText(split[0], padX, midY);
    const midX = padX + ctx.measureText(split[0]).width;
    ctx.fillStyle = AZURE;
    ctx.fillText(split[1], midX, midY);
    brandRight = midX + ctx.measureText(split[1]).width;
  } else {
    ctx.fillStyle = AZURE;
    ctx.fillText(brand, padX, midY);
    brandRight = padX + ctx.measureText(brand).width;
  }

  // Scan time (right), vertically centred — measured first so the title block
  // knows where it must stop.
  let timeLeft = W - padX;
  if (cap.time) {
    ctx.textAlign = 'right';
    ctx.fillStyle = AZURE;
    ctx.font = `700 ${Math.round(u * 1.1)}px ${MONO}`;
    ctx.fillText(cap.time, W - padX, midY);
    timeLeft = W - padX - ctx.measureText(cap.time).width;
  }

  // Title + sub (middle block) between the wordmark and the time. The sub-line
  // carries the product/source details, so it gets nearly title-sized text —
  // it must survive social-media downscaling too.
  const tx = brandRight + Math.round(u * 1.3);
  const availW = timeLeft - Math.round(u * 1.3) - tx;
  if (availW > u * 2) {
    ctx.textAlign = 'left';
    ctx.fillStyle = theme.text;
    ctx.font = `700 ${Math.round(u * 1.32)}px ${SANS}`;
    ctx.fillText(clip(ctx, cap.title || '', availW), tx, Math.round(H * 0.34));
    ctx.fillStyle = theme.dim;
    ctx.font = `600 ${Math.round(u * 0.98)}px ${SANS}`;
    ctx.fillText(clip(ctx, cap.sub || '', availW), tx, Math.round(H * 0.7));
  }
  ctx.textAlign = 'left';
}

// Small product chip stamped in a pane's top-left corner on multi-pane exports
// (the live pane badges are DOM overlays, so they never reach the canvas).
function drawPaneTag(ctx, label, paneX, paneY, u, theme) {
  const fs = Math.round(u * 0.85);
  ctx.font = `700 ${fs}px ${MONO}`;
  const padX = Math.round(u * 0.55);
  const w = Math.ceil(ctx.measureText(label).width) + padX * 2;
  const h = Math.round(u * 1.5);
  const x = paneX + Math.round(u * 0.6);
  const y = paneY + Math.round(u * 0.6);
  roundRectPath(ctx, x, y, w, h, Math.round(u * 0.35));
  ctx.fillStyle = 'rgba(8,11,17,0.82)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth = Math.max(1, Math.round(u / 20));
  ctx.stroke();
  ctx.fillStyle = theme.accent;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, x + padX, y + h / 2 + 1);
  ctx.textBaseline = 'alphabetic';
}

// Legend: caption above a gradient bar with low/mid/high ticks beneath. Returns
// the x of its right edge so the credit can be placed clear of it.
function drawLegend(ctx, legend, x, y, H, u, maxW, theme) {
  const barW = Math.round(clamp(maxW * 0.42, u * 8, u * 16));
  const barH = Math.round(u * 0.7);
  const barY = y + Math.round(H * 0.42);

  // Caption above the bar.
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = theme.dim;
  ctx.font = `600 ${Math.round(u * 0.85)}px ${MONO}`;
  ctx.fillText(clip(ctx, (legend.title || '').toUpperCase(), barW + u * 4), x, barY - Math.round(u * 0.45));

  // Gradient bar.
  if (legend.stops && legend.stops.length) {
    const grad = ctx.createLinearGradient(x, 0, x + barW, 0);
    for (const [pos, color] of legend.stops) grad.addColorStop(clamp(pos, 0, 1), color);
    ctx.fillStyle = grad;
    ctx.fillRect(x, barY, barW, barH);
    ctx.strokeStyle = theme.separator;
    ctx.lineWidth = Math.max(1, Math.round(u / 14));
    ctx.strokeRect(x, barY, barW, barH);
  }

  // Low / mid / high ticks under the bar.
  const ticks = legend.ticks || [];
  ctx.fillStyle = theme.faint;
  ctx.font = `500 ${Math.round(u * 0.85)}px ${MONO}`;
  const ty = barY + barH + Math.round(u * 0.95);
  if (ticks[0]) { ctx.textAlign = 'left'; ctx.fillText(ticks[0], x, ty); }
  if (ticks[1]) { ctx.textAlign = 'center'; ctx.fillText(ticks[1], x + barW / 2, ty); }
  if (ticks[2]) { ctx.textAlign = 'right'; ctx.fillText(ticks[2], x + barW, ty); }
  ctx.textAlign = 'left';
  return x + barW;
}

// Credit + UTC stamp, right-aligned and clipped to the space left of `maxX` after
// the legend. Drops the wordmark suffix first, then ellipsises, when space is tight.
function drawCredit(ctx, cap, minX, maxX, y, H, u, theme) {
  const avail = maxX - minX;
  if (avail < u * 6) return; // no room — skip rather than overlap the legend
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = theme.faint;
  ctx.font = `500 ${Math.round(u * 0.8)}px ${MONO}`;
  const full = `${cap.stamp || ''}  ·  radarnexus`;
  const text = ctx.measureText(full).width <= avail ? full : (cap.stamp || '');
  ctx.fillText(clip(ctx, text, avail), maxX, y + H / 2);
  ctx.textAlign = 'left';
}

// Alert preview card: a rounded panel with a colour-coded header (warning icon
// + event name + area) over a list of summary rows. Mirrors the live `.apv-*`
// card, but omits the "View full briefing" footer since the export captures the
// first popup, not the expanded briefing. Drawn centred near the bottom of the
// map region so it overlays the scope the way it does on screen.
function drawAlertCard(ctx, alert, mapX, mapY, mapW, mapH, u, mobile, theme) {
  const rows = alert.rows || [];
  // On phones the live preview card spans almost the whole width, so size the
  // exported card the same way (near-full-width) instead of the compact desktop
  // panel — that keeps the popup the same size in the export as on screen. The
  // card's internal text is then driven by a card-local unit `cu` derived from
  // the card width, mirroring the fixed-px proportions of the live .apv-* card.
  const cardW = mobile
    ? Math.round(Math.min(mapW * 0.9, mapW - u * 2))
    : Math.round(clamp(mapW * 0.32, u * 15, u * 26));
  const cu = mobile ? cardW / 22 : u;
  const pad = Math.round(cu * 0.95);
  const headH = Math.round(cu * 3.1);
  const rowH = Math.round(cu * 2.0);
  const bodyTop = headH + Math.round(cu * 0.5);
  const cardH = bodyTop + rows.length * rowH + Math.round(cu * 0.5);
  const x = Math.round(mapX + (mapW - cardW) / 2);
  const y = Math.round(mapY + mapH - cardH - cu * 1.6);
  const r = Math.round(cu * 0.7);

  ctx.save();
  // Card body + border, clipped to the rounded rect so the header band and
  // everything inside keeps the rounded corners.
  roundRectPath(ctx, x, y, cardW, cardH, r);
  ctx.fillStyle = theme.alertPanel;
  ctx.fill();
  ctx.strokeStyle = theme.separator;
  ctx.lineWidth = Math.max(1, Math.round(cu / 16));
  ctx.stroke();
  ctx.clip();

  // Coloured header band.
  ctx.fillStyle = alert.color || '#e0152d';
  ctx.fillRect(x, y, cardW, headH);

  // Warning icon, then the event title (upper) and area (lower).
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillStyle = '#fff';
  const hx = x + pad;
  ctx.font = `700 ${Math.round(cu * 1.3)}px ${SANS}`;
  ctx.fillText('⚠', hx, y + headH / 2);
  const tx = hx + ctx.measureText('⚠').width + Math.round(cu * 0.55);
  const availW = x + cardW - pad - tx;
  ctx.font = `700 ${Math.round(cu * 1.05)}px ${SANS}`;
  ctx.fillText(clip(ctx, (alert.title || '').toUpperCase(), availW), tx, y + Math.round(headH * 0.38));
  ctx.font = `500 ${Math.round(cu * 0.68)}px ${SANS}`;
  ctx.globalAlpha = 0.9;
  ctx.fillText(clip(ctx, alert.area || '', availW), tx, y + Math.round(headH * 0.72));
  ctx.globalAlpha = 1;

  // Summary rows: dim mono label on the left, bold value on the right, with a
  // hairline between rows.
  let ry = y + bodyTop + rowH / 2;
  for (let i = 0; i < rows.length; i++) {
    const [label, value] = rows[i];
    if (i > 0) {
      ctx.fillStyle = theme.separator;
      ctx.fillRect(x + pad, ry - rowH / 2, cardW - pad * 2, 1);
    }
    ctx.textAlign = 'left';
    ctx.fillStyle = theme.dim;
    ctx.font = `600 ${Math.round(cu * 0.62)}px ${MONO}`;
    ctx.fillText(String(label).toUpperCase(), x + pad, ry);
    const labelW = ctx.measureText(String(label).toUpperCase()).width;
    ctx.textAlign = 'right';
    ctx.fillStyle = theme.text;
    ctx.font = `700 ${Math.round(cu * 0.95)}px ${SANS}`;
    ctx.fillText(clip(ctx, String(value), cardW - pad * 2 - labelW - cu), x + cardW - pad, ry);
    ry += rowH;
  }
  ctx.restore();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

// Full alert briefing: reproduce the on-screen detail panel — a dark side panel
// over the scope with a colour-coded header, hazard boxes, safety guidance,
// location and the official alert text — so the export matches what the viewer
// sees. The panel runs the full height of the map region and its content is
// clipped to that box (rendered from the top, like the live panel scrolled to
// its start). On phones the live panel is full-width, so the export panel is too.
function drawAlertBriefing(ctx, b, mapX, mapY, mapW, mapH, u, mobile, theme, opts = {}) {
  const panelW = opts.panelW || briefingPanelWidth(mapW, u, mobile, opts.multiPane);
  const compact = !!opts.compact;
  if (compact) u = Math.min(u, clamp(panelW / 22, 16, 25));
  const x0 = mapX;
  const y0 = mapY;
  const panelH = mapH;
  const pad = Math.round(u * 1.2);
  const innerW = panelW - pad * 2;
  const bottom = y0 + panelH - pad;
  let y = y0;

  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, y0, panelW, panelH);
  ctx.clip();

  // Panel background + right-edge hairline.
  ctx.fillStyle = theme.alertPanel;
  ctx.fillRect(x0, y0, panelW, panelH);
  ctx.fillStyle = theme.separator;
  ctx.fillRect(x0 + panelW - 1, y0, 1, panelH);

  // Optional "X / Y alerts here" cycle bar (stacked alerts).
  if (b.group) {
    const barH = Math.round(u * 2.1);
    ctx.fillStyle = theme.panel;
    ctx.fillRect(x0, y, panelW, barH);
    ctx.fillStyle = theme.separator;
    ctx.fillRect(x0, y + barH - 1, panelW, 1);
    ctx.fillStyle = theme.dim;
    ctx.font = `600 ${Math.round(u * 0.78)}px ${MONO}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${b.group.index} / ${b.group.total} alerts here`, x0 + panelW / 2, y + barH / 2);
    y += barH;
  }

  // Coloured header band: warning icon + (wrapping) event title.
  const headH = Math.round(u * (compact ? 3.6 : 3.0));
  ctx.fillStyle = b.color || '#e0152d';
  ctx.fillRect(x0, y, panelW, headH);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillStyle = '#fff';
  ctx.font = `700 ${Math.round(u * (compact ? 1.1 : 1.3))}px ${SANS}`;
  ctx.fillText('⚠', x0 + pad, y + headH / 2);
  const hx = x0 + pad + ctx.measureText('⚠').width + Math.round(u * 0.5);
  ctx.font = `700 ${Math.round(u * (compact ? 0.95 : 1.12))}px ${SANS}`;
  const titleLines = wrapText(ctx, (b.title || '').toUpperCase(), x0 + panelW - pad - hx)
    .slice(0, compact ? 3 : 2);
  const tlh = Math.round(u * (compact ? 1.05 : 1.3));
  let ty = y + headH / 2 - ((titleLines.length - 1) * tlh) / 2;
  for (const ln of titleLines) {
    ctx.fillText(ln, hx, ty);
    ty += tlh;
  }
  y += headH + Math.round(u * 1.1);
  ctx.textBaseline = 'alphabetic';

  // ---- Content helpers (advance the shared y cursor, clip at the panel) ----
  const sectionLabel = (t) => {
    if (y > bottom) return;
    ctx.textAlign = 'left';
    ctx.fillStyle = theme.dim;
    ctx.font = `600 ${Math.round(u * 0.62)}px ${MONO}`;
    ctx.fillText(String(t).toUpperCase(), x0 + pad, y);
    y += Math.round(u * 1.05);
  };
  const paragraph = (t, opts = {}) => {
    if (!t || y > bottom) return;
    const size = opts.size || 0.92;
    ctx.textAlign = 'left';
    ctx.fillStyle = opts.color || theme.text;
    ctx.font = `${opts.weight || '400'} ${Math.round(u * size)}px ${SANS}`;
    const lh = Math.round(u * size * 1.42);
    for (const block of String(t).split(/\n+/)) {
      for (const ln of wrapText(ctx, block, innerW)) {
        if (y > bottom) return;
        ctx.fillText(ln, x0 + pad, y);
        y += lh;
      }
      y += Math.round(lh * 0.25);
    }
  };
  const bullet = (t) => {
    if (!t || y > bottom) return;
    const size = 0.88;
    const lh = Math.round(u * size * 1.42);
    const bx = x0 + pad + Math.round(u * 1.0);
    ctx.font = `400 ${Math.round(u * size)}px ${SANS}`;
    const lines = wrapText(ctx, t, innerW - Math.round(u * 1.0));
    for (let i = 0; i < lines.length; i++) {
      if (y > bottom) return;
      ctx.textAlign = 'left';
      if (i === 0) {
        ctx.fillStyle = b.color || '#e2643f';
        ctx.fillText('•', x0 + pad, y);
      }
      ctx.fillStyle = theme.text;
      ctx.fillText(lines[i], bx, y);
      y += lh;
    }
  };
  const gap = (k = 1) => { y += Math.round(u * 0.9 * k); };

  // EXPIRES.
  sectionLabel('Expires');
  paragraph(b.expires, { color: theme.text, weight: '700', size: 1.0 });
  gap();

  // Hazard boxes (HAIL / WIND / TORNADO).
  if (b.hazards && b.hazards.length && y < bottom) {
    const n = Math.min(b.hazards.length, 3);
    const bgap = Math.round(u * 0.5);
    const bw = Math.round((innerW - (n - 1) * bgap) / n);
    const bh = Math.round(u * 2.6);
    let bxp = x0 + pad;
    ctx.textBaseline = 'middle';
    for (let i = 0; i < b.hazards.length && i < 3; i++) {
      const [lab, val] = b.hazards[i];
      roundRectPath(ctx, bxp, y, bw, bh, Math.round(u * 0.4));
      ctx.fillStyle = theme.alertSoft;
      ctx.fill();
      ctx.strokeStyle = theme.separator;
      ctx.lineWidth = Math.max(1, Math.round(u / 18));
      ctx.stroke();
      ctx.textAlign = 'center';
      ctx.fillStyle = theme.dim;
      ctx.font = `600 ${Math.round(u * 0.55)}px ${MONO}`;
      ctx.fillText(lab, bxp + bw / 2, y + bh * 0.36);
      ctx.fillStyle = theme.text;
      ctx.font = `700 ${Math.round(u * 0.85)}px ${SANS}`;
      ctx.fillText(clip(ctx, val, bw - u * 0.5), bxp + bw / 2, y + bh * 0.72);
      bxp += bw + bgap;
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    y += bh + Math.round(u * 1.0);
  }

  // Storm motion.
  if (b.motion) {
    paragraph(b.motion, { color: b.color, weight: '700', size: 0.88 });
    gap(0.5);
  }

  // Safety guidance: lead paragraph + bullet points.
  if (b.guidance) {
    sectionLabel('Safety guidance');
    paragraph(b.guidance.lead, { color: theme.text, size: 0.95 });
    gap(0.3);
    for (const pt of b.guidance.points || []) bullet(pt);
    gap();
  }

  // Issued line.
  paragraph(b.issued, { color: theme.dim, size: 0.72 });
  gap(0.6);

  // Location.
  sectionLabel('Location');
  paragraph(b.location, { size: 0.88 });
  gap();

  // What to do (NWS instruction).
  if (b.instruction) {
    sectionLabel('What to do');
    paragraph(b.instruction, { size: 0.9 });
    gap();
  }

  // Full alert text.
  sectionLabel('Full alert text');
  paragraph(b.description, { color: theme.dim, size: 0.84 });
  gap();

  // Tags.
  if (b.tags && b.tags.length) {
    sectionLabel('Tags');
    paragraph(b.tags.join('    '), { color: b.color, weight: '600', size: 0.74 });
  }

  ctx.restore();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

// Word-wrap `text` to fit `maxW` px in the current font, returning the lines.
function wrapText(ctx, text, maxW) {
  const words = String(text == null ? '' : text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    const t = line ? line + ' ' + w : w;
    if (line && ctx.measureText(t).width > maxW) {
      lines.push(line);
      line = w;
    } else {
      line = t;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

// Trace a rounded-rectangle path (uses the native roundRect where available).
function roundRectPath(ctx, x, y, w, h, r) {
  if (ctx.roundRect) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    return;
  }
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function briefingPanelWidth(mapW, u, mobile, multiPane = false) {
  if (mobile) return mapW;
  return Math.round(
    multiPane
      ? clamp(mapW * 0.34, u * 12, u * 16)
      : clamp(mapW * 0.36, u * 16, u * 30)
  );
}

function normalizeTheme(theme) {
  const base = theme && typeof theme === 'object' ? theme : {};
  const dark = base.mode === 'dark';
  return {
    mode: dark ? 'dark' : 'light',
    bg: base.bg || '#fffaf2',
    panel: base.panel || base.bg || '#fffaf2',
    separator: base.separator || 'rgba(42,37,32,0.12)',
    text: base.text || '#2a2520',
    dim: base.dim || '#6f655b',
    faint: base.faint || '#9a8b7b',
    accent: base.accent || '#e2643f',
    alertPanel: base.alertPanel || (dark ? 'rgba(37,31,24,0.98)' : 'rgba(255,250,242,0.98)'),
    alertSoft: base.alertSoft || (dark ? 'rgba(255,255,255,0.06)' : 'rgba(42,37,32,0.055)'),
  };
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
  if (!cap) return 'RadarNexus radar';
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
