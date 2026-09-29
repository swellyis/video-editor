// "Install app" button + help: never shown when the app is already installed or running as an installed app.
// Sources of truth, cheapest first: display-mode media queries (installed desktop window, Android app, iOS home-screen
// app), navigator.standalone, an android-app:// referrer (Trusted Web Activity), the `appinstalled` event (remembered in
// localStorage), navigator.getInstalledRelatedApps() (tab open while the app is installed), and Chrome itself: it only
// fires `beforeinstallprompt` when the app is NOT installed, so a late one means an old "installed" flag is stale.
export const K_INSTALLED = 've.installed', K_DISMISSED = 've.installDismissed';
export const DAY = 864e5, DISMISS_MS = 90 * DAY, IOS_DISMISS_MS = 3650 * DAY, STALE_MS = DAY, FLAG_MAX_MS = 730 * DAY;
export const DISPLAY_MODES = ['standalone', 'fullscreen', 'minimal-ui', 'window-controls-overlay'];

export function isStandalone(env = globalThis, modes = DISPLAY_MODES) {
  const { matchMedia, navigator: nav = {}, document: doc = {} } = env;
  for (const m of modes) { try { if (matchMedia && matchMedia(`(display-mode: ${m})`).matches) return true; } catch { /* unsupported mode */ } }
  return nav.standalone === true || String(doc.referrer || '').startsWith('android-app://');
}
const read = (ls, k) => { try { const v = JSON.parse(ls.getItem(k)); return v && typeof v === 'object' ? v : null; } catch { return null; } };
const write = (ls, k, v) => { try { ls.setItem(k, JSON.stringify(v)); } catch { /* private mode / quota */ } };
export const installedFlag = (ls, now = Date.now()) => { const f = read(ls, K_INSTALLED); return f && f.t && now - f.t < FLAG_MAX_MS ? f : null; };
export const setInstalledFlag = (ls, via, now = Date.now()) => write(ls, K_INSTALLED, { t: now, via });
export const clearInstalledFlag = (ls) => { try { ls.removeItem(K_INSTALLED); } catch { /* ignore */ } };
export const dismissedActive = (ls, now = Date.now()) => { const d = read(ls, K_DISMISSED); return !!(d && d.until > now); };
export const setDismissed = (ls, ms = DISMISS_MS, now = Date.now()) => write(ls, K_DISMISSED, { t: now, until: now + ms });

const HELP = {
  ios: '<b>Install on iPhone / iPad:</b> open this page in <b>Safari</b>, tap the <b>Share</b> button (square with arrow), then choose <b>Add to Home Screen</b>. The editor then opens full-screen and works offline.',
  android: '<b>Install on Android:</b> open the browser menu (⋮) and choose <b>Install app</b> or <b>Add to Home screen</b>. If you don’t see it, reload the page once.',
  desktop: '<b>Install on desktop:</b> in Chrome or Edge, click the install icon at the right of the address bar (or menu ⋮ → <b>Install Video Editor</b>). In Safari on Mac: File → <b>Add to Dock</b>.',
};

export function initInstall({ $, toast, isIOS, env = window, storage = window.localStorage }) {
  const root = env.document.documentElement, btn = $('installBtn'), help = $('installHelp'), copy = $('installCopy');
  const nav = env.navigator;
  let deferred = null;
  const ios = () => isIOS();

  function refresh() {
    const st = isStandalone(env);
    // remember it so a normal tab of the same browser knows too (F11 browser fullscreen also reports 'fullscreen', so that alone isn't remembered)
    if (isStandalone(env, DISPLAY_MODES.filter(m => m !== 'fullscreen')) && !installedFlag(storage)) setInstalledFlag(storage, 'standalone');
    const installed = st || !!installedFlag(storage), dismissed = !installed && dismissedActive(storage);
    root.toggleAttribute('data-installed', installed);
    root.toggleAttribute('data-install-dismissed', dismissed);
    if (installed) deferred = null;
    btn.hidden = installed || dismissed;
    if (installed || dismissed) help.classList.remove('show');
    btn.textContent = deferred ? 'Install app' : 'How to install';
  }
  function helpText() { return ios() ? HELP.ios : /android/i.test(nav.userAgent) ? HELP.android : HELP.desktop; }

  env.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // we show our own button (and only when not installed)
    if (isStandalone(env)) return;
    const f = installedFlag(storage);
    if (f) {
      if (Date.now() - f.t < STALE_MS && f.via !== 'related') return; // just installed; ignore
      clearInstalledFlag(storage); // Chrome only offers install when the app is not installed: the flag is stale (uninstalled)
    }
    deferred = e; refresh();
  });
  env.addEventListener('appinstalled', () => {
    setInstalledFlag(storage, 'appinstalled'); deferred = null; refresh(); toast('Installed! Open it from your home screen or app list.');
  });
  btn.onclick = async () => {
    if (root.hasAttribute('data-installed')) return;
    if (deferred) {
      const d = deferred; deferred = null;
      d.prompt();
      const { outcome } = await d.userChoice.catch(() => ({}));
      if (outcome === 'dismissed') setDismissed(storage); // don't nag: the button stays away for 90 days
      else if (outcome === 'accepted') toast('Installing…');
      refresh(); return;
    }
    copy.innerHTML = helpText();
    help.classList.toggle('show');
  };
  $('closeInstall').onclick = () => { setDismissed(storage, ios() ? IOS_DISMISS_MS : DISMISS_MS); help.classList.remove('show'); refresh(); };

  // extra hint: a normal browser tab while the app is installed (Chrome/Edge; needs related_applications in the manifest)
  async function checkRelated() {
    if (isStandalone(env) || typeof nav.getInstalledRelatedApps !== 'function') return;
    try {
      const apps = await nav.getInstalledRelatedApps();
      if (apps && apps.length) setInstalledFlag(storage, 'related');
      else { const f = installedFlag(storage); if (f && f.via === 'related') clearInstalledFlag(storage); }
      refresh();
    } catch { /* not supported here (incognito, insecure context, old Chrome) */ }
  }
  refresh();
  checkRelated();
  // iOS Safari has no install prompt: show the Add to Home Screen hint on its own, once, until it is dismissed
  if (ios() && !root.hasAttribute('data-installed') && !root.hasAttribute('data-install-dismissed')) { copy.innerHTML = HELP.ios; help.classList.add('show'); }
  return { refresh, get deferred() { return deferred; } };
}
