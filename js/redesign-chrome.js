/*
 * Thin interaction bridge for the desktop command bar added by the UI redesign.
 * The app's controls keep their existing IDs and event handlers; this file only
 * reflects their state into the new chrome and forwards deliberate user actions.
 */

function installCommandBar() {
  const bar = document.querySelector('.console-commandbar');
  const siteSelect = document.querySelector('#siteSelect');
  const modeSwitch = document.querySelector('#modeSwitch');
  const clock = document.querySelector('#clock');
  const liveButton = document.querySelector('#liveBtn');
  if (!bar || !siteSelect || !modeSwitch) return;

  const siteCode = document.querySelector('#consoleSiteCode');
  const siteName = document.querySelector('#consoleSiteName');
  const consoleClock = document.querySelector('#consoleClock');
  const liveChip = bar.querySelector('.console-live');
  const modeButtons = [...bar.querySelectorAll('[data-console-mode]')];
  const themeIcon = document.querySelector('#consoleThemeIcon');
  const app = document.querySelector('.app');
  const sidebar = document.querySelector('#sidebar');
  const sidebarResize = document.querySelector('#sidebarResize');
  const sidebarCollapse = document.querySelector('#sidebarCollapse');
  const SIDEBAR_KEY = 'aether.sidebar.width';
  const SIDEBAR_HIDDEN_KEY = 'aether.sidebar.hidden';
  const SIDEBAR_MIN = 284;
  let notifyingLayout = false;
  const notifyLayout = () => {
    if (notifyingLayout) return;
    notifyingLayout = true;
    window.dispatchEvent(new Event('resize'));
    notifyingLayout = false;
  };

  const sidebarMax = () => {
    // Match the right edge of the command-bar radar-site picker when it is
    // available; leave a usable minimum map width on narrower windows.
    const pickerRight = bar.querySelector('.console-site')?.getBoundingClientRect().right || 460;
    return Math.max(SIDEBAR_MIN, Math.min(Math.round(pickerRight), window.innerWidth - 320));
  };
  const setSidebarWidth = (value, persist = true) => {
    if (!app) return;
    const width = Math.max(SIDEBAR_MIN, Math.min(sidebarMax(), Math.round(value)));
    app.style.setProperty('--sidebar-w', `${width}px`);
    if (persist) {
      try { localStorage.setItem(SIDEBAR_KEY, String(width)); } catch (_) {}
    }
    notifyLayout();
  };
  const setSidebarHidden = (hidden, persist = true) => {
    if (!app) return;
    app.classList.toggle('sidebar-hidden', hidden);
    // The desktop Settings drawer lives against the sidebar; hiding the sidebar
    // should take its drawer with it. Otherwise the settings panel is left
    // floating over the map after the sidebar it belongs to has slid away.
    if (hidden && app.classList.contains('sheet-open')) {
      document.querySelector('#settingsBtn')?.click();
    }
    if (sidebarCollapse) {
      sidebarCollapse.title = hidden ? 'Show sidebar' : 'Hide sidebar';
      sidebarCollapse.setAttribute('aria-label', hidden ? 'Show sidebar' : 'Hide sidebar');
    }
    if (persist) {
      try { localStorage.setItem(SIDEBAR_HIDDEN_KEY, hidden ? '1' : '0'); } catch (_) {}
    }
    notifyLayout();
  };

  try {
    const savedWidth = Number(localStorage.getItem(SIDEBAR_KEY));
    if (Number.isFinite(savedWidth) && savedWidth >= SIDEBAR_MIN) setSidebarWidth(savedWidth, false);
    setSidebarHidden(localStorage.getItem(SIDEBAR_HIDDEN_KEY) === '1', false);
  } catch (_) {}

  sidebarCollapse?.addEventListener('click', () =>
    setSidebarHidden(!app.classList.contains('sidebar-hidden'))
  );
  if (sidebarResize) {
    let startX = 0;
    let startW = SIDEBAR_MIN;
    const finish = () => {
      if (app && !app.classList.contains('sidebar-hidden')) {
        setSidebarWidth(sidebar?.getBoundingClientRect().width || SIDEBAR_MIN, true);
      }
      app?.classList.remove('sidebar-resizing');
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', finish);
      document.removeEventListener('pointercancel', finish);
    };
    const move = (event) => setSidebarWidth(startW + event.clientX - startX, false);
    sidebarResize.addEventListener('pointerdown', (event) => {
      if (!app || app.classList.contains('sidebar-hidden')) return;
      startX = event.clientX;
      startW = sidebar?.getBoundingClientRect().width || SIDEBAR_MIN;
      app.classList.add('sidebar-resizing');
      sidebarResize.setPointerCapture?.(event.pointerId);
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', finish);
      document.addEventListener('pointercancel', finish);
      event.preventDefault();
    });
    window.addEventListener('resize', () => {
      if (notifyingLayout) return;
      if (!app || app.classList.contains('sidebar-hidden')) return;
      setSidebarWidth(sidebar?.getBoundingClientRect().width || SIDEBAR_MIN, false);
    });
  }

  const syncSite = () => {
    const option = siteSelect.selectedOptions[0];
    const label = option?.textContent?.trim() || siteSelect.value || 'Radar site';
    const [code, ...rest] = label.split(/\s+(?:—|-|·)\s+/);
    if (siteCode) siteCode.textContent = code || siteSelect.value || 'Radar';
    if (siteName) siteName.textContent = rest.join(' — ') || 'Choose radar site';
  };

  const syncMode = () => {
    const activeMode = modeSwitch.querySelector('.mode-btn.active')?.dataset.mode;
    modeButtons.forEach((button) => {
      button.classList.toggle('active', button.dataset.consoleMode === activeMode);
      button.setAttribute('aria-current', button.dataset.consoleMode === activeMode ? 'page' : 'false');
    });
  };

  const syncClock = () => {
    if (consoleClock && clock?.textContent?.trim()) consoleClock.textContent = clock.textContent.trim();
  };

  const syncLive = () => {
    if (liveChip) liveChip.classList.toggle('active', Boolean(liveButton?.classList.contains('active')));
  };

  const syncTheme = () => {
    if (!themeIcon) return;
    const dark = document.body.classList.contains('theme-dark');
    const want = dark ? 'moon' : 'sun';
    if (themeIcon.dataset.icon !== want) {
      themeIcon.dataset.icon = want;
      themeIcon.innerHTML = `<i data-lucide="${want}" aria-hidden="true"></i>`;
      window.lucide?.createIcons?.();
    }
  };

  const sync = () => {
    syncSite();
    syncMode();
    syncClock();
    syncLive();
    syncTheme();
  };

  modeButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const source = modeSwitch.querySelector(`.mode-btn[data-mode="${button.dataset.consoleMode}"]`);
      source?.click();
      requestAnimationFrame(sync);
    });
  });

  const locationBox = document.querySelector('#locationSearch');
  const locationForm = document.querySelector('#locationSearchForm');
  const locationInput = document.querySelector('#locationSearchInput');
  const locationResults = document.querySelector('#locationSearchResults');
  const closeLocation = () => { if (locationBox) locationBox.hidden = true; };
  bar.querySelector('[data-console-focus]')?.addEventListener('click', () => {
    if (!locationBox) return;
    locationBox.hidden = false;
    locationInput?.focus();
  });
  document.querySelector('#locationSearchClose')?.addEventListener('click', closeLocation);
  locationForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const q = locationInput?.value.trim();
    if (!q || !locationResults) return;
    locationResults.innerHTML = '<div class="location-search-status">Searching…</div>';
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&addressdetails=1&q=${encodeURIComponent(q)}`;
      const response = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const places = await response.json();
      locationResults.innerHTML = '';
      if (!places.length) locationResults.innerHTML = '<div class="location-search-status">No locations found.</div>';
      for (const place of places) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = place.display_name;
        button.addEventListener('click', () => {
          const bb = place.boundingbox;
          window.dispatchEvent(new CustomEvent('radarnexus:location', { detail: {
            label: place.display_name, lat: Number(place.lat), lon: Number(place.lon),
            bbox: bb ? [Number(bb[2]), Number(bb[0]), Number(bb[3]), Number(bb[1])] : null,
          } }));
          closeLocation();
        });
        locationResults.appendChild(button);
      }
    } catch (error) {
      locationResults.innerHTML = `<div class="location-search-status">Search unavailable (${error.message}).</div>`;
    }
  });

  bar.querySelector('[data-console-action="settings"]')?.addEventListener('click', () => {
    setSidebarHidden(false);
    document.querySelector('#settingsBtn')?.click();
  });

  bar.querySelector('[data-console-action="theme"]')?.addEventListener('click', () => {
    const themeSelect = document.querySelector('#uiThemeSelect');
    if (!themeSelect) return;
    themeSelect.value = document.body.classList.contains('theme-dark') ? 'light' : 'dark';
    themeSelect.dispatchEvent(new Event('change', { bubbles: true }));
  });

  siteSelect.addEventListener('change', syncSite);
  modeSwitch.addEventListener('click', () => requestAnimationFrame(sync));
  liveButton?.addEventListener('click', () => requestAnimationFrame(syncLive));
  clock && new MutationObserver(syncClock).observe(clock, { childList: true, characterData: true, subtree: true });
  new MutationObserver(syncMode).observe(modeSwitch, { attributes: true, subtree: true, attributeFilter: ['class'] });
  new MutationObserver(() => { syncLive(); syncTheme(); }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  sync();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => requestAnimationFrame(installCommandBar), { once: true });
} else {
  requestAnimationFrame(installCommandBar);
}
