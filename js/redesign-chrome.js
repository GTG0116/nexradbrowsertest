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

  bar.querySelector('[data-console-focus]')?.addEventListener('click', () => {
    const sourcePanel = document.querySelector('#sourcePanel');
    sourcePanel?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    siteSelect.focus({ preventScroll: true });
  });

  bar.querySelector('[data-console-action="settings"]')?.addEventListener('click', () => {
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
