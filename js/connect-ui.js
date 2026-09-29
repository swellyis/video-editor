// "Connect" tab: link import with progress, saved website shortcuts (sandboxed panel or new window), share-out helpers.
// Logic lives in connect.js (unit-testable); this file only wires the DOM. Nothing here sends project data anywhere.
import { $, el, icon, fmtBytes } from './util.js';
import { parseHttpsUrl, extractUrl, cleanSiteName, defaultSiteName, loadSites, saveSites, moveSite, sanitizeSites, knownNoFrame, fetchMedia, ConnectError, SITE_SUGGESTIONS, MAX_SITES, LIMITS } from './connect.js';

const FRAME_WAIT_MS = 8000;

export function initConnect({ importFiles, showTab, toast, openDialog, closeDialog }) {
  // ------------------------------------------------------------ import from link
  const msg = (id, text, kind) => { const m = $(id); m.textContent = text; m.classList.toggle('err', kind === 'err'); m.classList.toggle('okm', kind === 'ok'); };
  let job = null;
  const lowMemory = () => (navigator.deviceMemory && navigator.deviceMemory <= 4) || matchMedia('(pointer:coarse)').matches;
  const setBusy = (busy) => { $('linkGo').disabled = busy; $('linkInput').readOnly = busy; $('linkProgress').hidden = !busy; };
  async function importLink(raw) {
    if (job) return;
    const p = parseHttpsUrl(raw);
    if (!p.ok) { msg('linkMsg', p.error, 'err'); $('linkInput').focus(); return; }
    $('linkInput').value = p.url;
    const ac = new AbortController(); job = ac;
    setBusy(true); msg('linkMsg', 'Connecting to ' + new URL(p.url).hostname + '…'); $('linkStat').textContent = 'Connecting…';
    const bar = $('linkBar'); bar.classList.add('indet'); bar.style.width = '';
    try {
      const file = await fetchMedia(p.url, {
        signal: ac.signal, maxBytes: lowMemory() ? 300 * 1024 * 1024 : LIMITS.urlBytes,
        onProgress: (l, t) => {
          if (t) { bar.classList.remove('indet'); bar.style.width = Math.min(100, l / t * 100).toFixed(1) + '%'; $('linkStat').textContent = `${fmtBytes(l)} of ${fmtBytes(t)} · ${Math.round(l / t * 100)}%`; }
          else $('linkStat').textContent = fmtBytes(l) + ' downloaded';
        },
      });
      bar.classList.remove('indet'); bar.style.width = '100%';
      msg('linkMsg', `Downloaded ${file.name} (${fmtBytes(file.size)}). Adding it to the project…`);
      await importFiles([file]);
      msg('linkMsg', `Added ${file.name} (${fmtBytes(file.size)}) to the project.`, 'ok'); $('linkInput').value = '';
    } catch (e) {
      if (e instanceof ConnectError) msg('linkMsg', e.code === 'cancelled' ? 'Download cancelled.' : e.message, e.code === 'cancelled' ? '' : 'err');
      else { console.warn(e); msg('linkMsg', 'Something went wrong: ' + (e && e.message || e), 'err'); }
    } finally { job = null; setBusy(false); }
  }
  $('linkGo').onclick = () => importLink($('linkInput').value);
  $('linkInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); importLink($('linkInput').value); } });
  $('linkCancel').onclick = () => { if (job) job.abort(); };
  $('cloudInput').onchange = (e) => { importFiles(e.target.files); e.target.value = ''; };

  // ------------------------------------------------------------ my sites
  let sites = loadSites();
  const persist = (next) => { sites = saveSites(next); renderSites(); };
  const hostOf = (u) => { try { const x = new URL(u); return x.hostname.replace(/^www\./, '') + (x.pathname.length > 1 ? x.pathname : ''); } catch { return u; } };
  const sameUrl = (a, b) => { try { return new URL(a).href === new URL(b).href; } catch { return a === b; } };
  function siteMsg(text, kind) { msg('siteMsg', text, kind); }
  function addSite(name, url) {
    const p = parseHttpsUrl(url);
    if (!p.ok) { siteMsg(p.error, 'err'); return false; }
    if (sites.length >= MAX_SITES) { siteMsg(`You can keep up to ${MAX_SITES} sites. Remove one first.`, 'err'); return false; }
    if (sites.some(s => sameUrl(s.url, p.url))) { siteMsg('That site is already in your list.', 'err'); return false; }
    const nm = cleanSiteName(name, p.url);
    persist([...sites, { id: 's_' + Math.random().toString(36).slice(2, 9), name: nm, url: p.url }]);
    siteMsg(`Added ${nm}.`, 'ok'); return true;
  }
  $('siteForm').addEventListener('submit', (e) => {
    e.preventDefault();
    if (addSite($('siteName').value, $('siteUrl').value)) { $('siteName').value = ''; $('siteUrl').value = ''; }
    else $('siteUrl').focus();
  });
  const ib = (label, ico, onclick, disabled) => {
    const b = el('button', { class: 'icon-btn', type: 'button', 'aria-label': label, title: label, onclick });
    b.append(icon(ico)); if (disabled) b.setAttribute('aria-disabled', 'true'); return b;
  };
  function renderSites() {
    const list = $('siteList'); list.replaceChildren();
    sites.forEach((s, i) => {
      const nameIn = el('input', { class: 'site-name', value: s.name, maxlength: 40, 'aria-label': 'Name of ' + s.name, 'data-id': s.id, enterkeyhint: 'done' });
      const commit = () => {
        const nm = cleanSiteName(nameIn.value, s.url);
        if (nm !== s.name) { sites = saveSites(sites.map(x => x.id === s.id ? { ...x, name: nm } : x)); s.name = nm; siteMsg(`Renamed to ${nm}.`, 'ok'); }
        nameIn.value = nm;
      };
      nameIn.addEventListener('change', commit);
      nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); nameIn.blur(); } });
      const row = el('div', { class: 'site-row', 'data-id': s.id },
        el('div', { class: 'site-main' }, nameIn, el('span', { class: 'site-host', text: hostOf(s.url), title: s.url })),
        el('div', { class: 'site-actions' },
          el('button', { class: 'btn primary', type: 'button', 'data-open': s.id, text: 'Open', 'aria-label': 'Open ' + s.name, onclick: () => openSite(s) }),
          ib('Move ' + s.name + ' up', 'chevUp', () => { if (i > 0) persist(moveSite(sites, s.id, -1)); }, i === 0),
          ib('Move ' + s.name + ' down', 'chevDown', () => { if (i < sites.length - 1) persist(moveSite(sites, s.id, 1)); }, i === sites.length - 1),
          ib('Remove ' + s.name, 'trash', () => { persist(sites.filter(x => x.id !== s.id)); siteMsg(`Removed ${s.name}.`, 'ok'); })));
      list.append(row);
    });
    $('siteEmpty').hidden = sites.length > 0;
    const sg = $('siteSuggest'); sg.replaceChildren();
    for (const x of SITE_SUGGESTIONS) {
      if (sites.some(s => sameUrl(s.url, x.url))) continue;
      sg.append(el('button', { class: 'btn secondary', type: 'button', 'data-suggest': x.name, text: '＋ ' + x.name, 'aria-label': 'Add ' + x.name, onclick: () => addSite(x.name, x.url) }));
    }
  }

  // ------------------------------------------------------------ site panel
  let waitTimer = 0;
  function closePanel() { clearTimeout(waitTimer); $('siteFrameWrap').replaceChildren(); }
  $('siteDialog').addEventListener('close', closePanel);
  function mountFrame(url) {
    clearTimeout(waitTimer); $('siteFrameWrap').replaceChildren();
    const f = el('iframe', {
      title: 'Website panel', src: url, referrerpolicy: 'no-referrer', loading: 'eager',
      // no top navigation, no camera / microphone / location: only what browsing a media site needs
      sandbox: 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads',
      allow: 'fullscreen; clipboard-write; encrypted-media; picture-in-picture',
    });
    let loaded = false;
    f.addEventListener('load', () => { loaded = true; clearTimeout(waitTimer); $('siteNote').textContent = 'If the panel is blank or shows an error, this site does not allow being shown inside other pages. Use Open in new window.'; $('siteTryRow').hidden = true; });
    $('siteFrameWrap').append(f);
    $('siteNote').textContent = 'Loading…';
    waitTimer = setTimeout(() => {
      if (loaded) return;
      $('siteNote').textContent = navigator.onLine === false ? 'You are offline, so the site cannot load. Use Open in new window when you are back online.' : 'This is taking a long time. The site may refuse to be shown inside other pages. Use Open in new window.';
    }, FRAME_WAIT_MS);
  }
  function openSite(s) {
    const p = parseHttpsUrl(s.url); if (!p.ok) return siteMsg(p.error, 'err'); // never load anything that is not https
    $('siteTitle').textContent = s.name;
    const a = $('siteNewWin'); a.href = p.url; a.setAttribute('aria-label', 'Open ' + s.name + ' in a new window');
    closePanel(); $('siteTryRow').hidden = true;
    if (knownNoFrame(p.url)) {
      $('siteNote').textContent = `${defaultSiteName(p.url)} refuses to be shown inside other pages, so a panel here would stay blank. Use Open in new window.`;
      $('siteTryRow').hidden = false; $('siteTry').onclick = () => { $('siteTryRow').hidden = true; mountFrame(p.url); };
    } else mountFrame(p.url);
    openDialog('siteDialog');
  }
  renderSites();

  return {
    /** A link arrived from another app (share sheet): show it in the import box, ready to import. */
    receiveLink(text) {
      const u = extractUrl(text); if (!u) return false;
      showTab('connect'); $('linkInput').value = u; msg('linkMsg', 'A link was shared with the editor. Tap Import to download it if it is a direct media file.');
      return true;
    },
    sites: () => sites.map(s => ({ ...s })),
    sanitizeSites,
  };
}
