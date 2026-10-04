// Add media from a link and files shared in from other apps: pure logic, no DOM (the dialog is add-media-ui.js). A browser can't drive other sites, so this covers what it CAN do:
// receive files shared from other apps (Web Share Target, see sw.js), download a media file from an https link (CORS),
// and share results out.
// Nothing here ever sends project data anywhere: the only requests are GETs of the links the user typed.

export const URL_MAX = 2048;
export const LIMITS = { urlBytes: 1024 * 1024 * 1024, probeMs: 6000 }; // 1 GiB: the file is held in memory while it downloads

const hasControlOrSpace = (s) => { for (const ch of s) { const c = ch.charCodeAt(0); if (c <= 32 || c === 127) return true; } return /\s/.test(s); };

/** Parse what the user typed into an https URL. Returns { ok, url, error }. Only https: no javascript:, data:, blob:, file:, http:, credentials in the URL. */
export function parseHttpsUrl(input) {
  let s = String(input == null ? '' : input).trim();
  if (!s) return { ok: false, error: 'Type or paste a link first.' };
  if (s.length > URL_MAX) return { ok: false, error: 'That link is too long.' };
  if (hasControlOrSpace(s)) return { ok: false, error: 'A link cannot contain spaces or line breaks.' };
  if (s.startsWith('//')) s = 'https:' + s;
  else if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[a-z0-9-]+(\.[a-z0-9-]+)*:\d+(\/|$)/i.test(s)) {
    // has a scheme (javascript:, data:, http:, ...). "example.com:8080/x" is a host and port, not a scheme.
    if (!/^https:\/\//i.test(s)) return { ok: false, error: /^http:/i.test(s) ? 'Only secure https:// links are allowed. Try the same address starting with https://.' : 'Only https:// links are allowed.' };
  } else s = 'https://' + s; // "canva.com/videos" -> https://canva.com/videos
  let u; try { u = new URL(s); } catch { return { ok: false, error: 'That does not look like a web address.' }; }
  if (u.protocol !== 'https:') return { ok: false, error: 'Only secure https:// links are allowed.' };
  if (u.username || u.password) return { ok: false, error: 'Links with a user name or password are not allowed.' };
  const host = u.hostname;
  if (!host || (!host.includes('.') && !host.includes(':')) || host.endsWith('.')) return { ok: false, error: 'That does not look like a web address (for example https://example.com/video.mp4).' };
  return { ok: true, url: u.href };
}

/** First http(s) link inside shared text ("Look at this https://x.com/a.mp4"), or ''. */
export function extractUrl(text) {
  const m = /https?:\/\/[^\s<>"']+/i.exec(String(text || ''));
  return m ? m[0].replace(/[).,;!?]+$/, '') : '';
}

// ---- import from link
export class LinkError extends Error { constructor(code, message) { super(message); this.name = 'LinkError'; this.code = code; } }
const EXT_TYPE = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', '3gp': 'video/3gpp', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', heic: 'image/heic', heif: 'image/heif' };
const TYPE_EXT = { 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/ogg': 'ogg', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const GENERIC = /^(application\/octet-stream|binary\/octet-stream|application\/x-binary|application\/download|application\/force-download)?$/;

/** File name for a downloaded URL: last path segment (decoded, cleaned), with an extension from the content type if it has none. */
export function nameFromUrl(url, type) {
  let n = ''; try { n = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || ''); } catch { /* keep '' */ }
  n = Array.from(n, ch => ch.charCodeAt(0) < 32 ? '_' : ch).join('').replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 100);
  if (!n) n = 'linked-media';
  if (!/\.[a-z0-9]{2,5}$/i.test(n)) { const e = TYPE_EXT[type]; if (e) n += '.' + e; }
  return n;
}
/** Decide what a response is from its content type and URL: returns the media type to use, or throws LinkError('notmedia'). */
export function mediaTypeOf(contentType, url) {
  const ct = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (/^(video|audio|image)\//.test(ct)) { if (ct === 'image/svg+xml') throw new LinkError('notmedia', 'SVG drawings are not supported. Use a PNG or JPG image.'); return ct; }
  if (/mpegurl/.test(ct)) throw new LinkError('notmedia', 'That link is a streaming playlist (HLS), not a single video file.');
  if (GENERIC.test(ct) || ct === 'application/mp4' || ct === 'application/ogg') {
    const ext = ((/\.([a-z0-9]{2,5})(?:$|[?#])/i.exec((() => { try { return new URL(url).pathname; } catch { return ''; } })()) || [])[1] || '').toLowerCase();
    if (EXT_TYPE[ext]) return EXT_TYPE[ext];
  }
  if (/^text\/html|application\/xhtml/.test(ct)) throw new LinkError('notmedia', 'That link is a web page, not a media file. Open the page, then copy the address of the video file itself (it usually ends in .mp4, .mov, .mp3 or .jpg).');
  throw new LinkError('notmedia', 'That link is not a video, photo or audio file' + (ct ? ' (the server says it is ' + ct + ')' : '') + '.');
}

/**
 * Download one media file. opts: { signal, onProgress(loaded, total|0), maxBytes }.
 * Errors are LinkError with code: badurl | offline | cors | unreachable | http | notmedia | toolarge | cancelled.
 */
export async function fetchMedia(input, opts = {}) {
  const p = parseHttpsUrl(input); if (!p.ok) throw new LinkError('badurl', p.error);
  const { signal, onProgress } = opts, maxBytes = opts.maxBytes || LIMITS.urlBytes;
  const cancelled = () => new LinkError('cancelled', 'Download cancelled.');
  let res;
  try {
    res = await fetch(p.url, { mode: 'cors', credentials: 'omit', redirect: 'follow', referrerPolicy: 'no-referrer', cache: 'no-store', signal });
  } catch (e) {
    if (signal && signal.aborted) throw cancelled();
    if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new LinkError('offline', 'You are offline. Connect to the internet and try again.');
    // A blocked cross-origin read and a dead server both look the same to a page. Probe with an opaque request: if the server
    // answers, it is reachable and simply doesn't allow other websites to read the file (CORS).
    let reachable = false;
    try {
      const ac = new AbortController(), t = setTimeout(() => ac.abort(), LIMITS.probeMs);
      const r = await fetch(p.url, { mode: 'no-cors', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', signal: ac.signal });
      clearTimeout(t); reachable = !!r; ac.abort();
    } catch { /* unreachable */ }
    if (signal && signal.aborted) throw cancelled();
    if (reachable) throw new LinkError('cors', 'This site does not allow other apps to download its files (CORS), so it cannot be imported from a link. Download the file in your browser, then add it with Add clips.');
    throw new LinkError('unreachable', 'Could not reach that address. You may be offline, the link may be wrong, or the site may be down.');
  }
  if (!res.url || !/^https:/i.test(res.url)) { try { res.body && res.body.cancel(); } catch { /* ignore */ } throw new LinkError('badurl', 'That link redirected somewhere that is not https, so it was not downloaded.'); }
  if (!res.ok) { try { res.body && res.body.cancel(); } catch { /* ignore */ } throw new LinkError('http', `The server answered “${res.status}${res.statusText ? ' ' + res.statusText : ''}”. ${res.status === 404 ? 'The file was not found.' : res.status === 401 || res.status === 403 ? 'The file needs a login or is not shared publicly.' : 'Try again later.'}`); }
  let type; try { type = mediaTypeOf(res.headers.get('content-type'), res.url); } catch (e) { try { res.body && res.body.cancel(); } catch { /* ignore */ } throw e; }
  const total = parseInt(res.headers.get('content-length') || '0', 10) || 0; // only readable when the server exposes it
  const tooBig = () => new LinkError('toolarge', `That file is larger than ${Math.round(maxBytes / 1048576)} MB, which is more than this device can safely hold while downloading. Download it in your browser and add it with Add clips.`);
  if (total > maxBytes) { try { res.body && res.body.cancel(); } catch { /* ignore */ } throw tooBig(); }
  const chunks = []; let loaded = 0;
  if (res.body && res.body.getReader) {
    const rd = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await rd.read(); if (done) break;
        loaded += value.byteLength; if (loaded > maxBytes) { rd.cancel().catch(() => { }); throw tooBig(); }
        chunks.push(value); onProgress && onProgress(loaded, total);
      }
    } catch (e) { if (e instanceof LinkError) throw e; if (signal && signal.aborted) throw cancelled(); throw new LinkError('unreachable', 'The download was interrupted. Check your connection and try again.'); }
  } else { const b = await res.blob(); if (b.size > maxBytes) throw tooBig(); chunks.push(b); loaded = b.size; onProgress && onProgress(loaded, loaded); }
  if (signal && signal.aborted) throw cancelled();
  if (!loaded) throw new LinkError('notmedia', 'The file is empty.');
  const name = nameFromUrl(res.url, type);
  const file = new File(chunks, name, { type });
  if (!/^(video|audio|image)\//.test(type)) throw new LinkError('notmedia', 'That is not a video, photo or audio file.');
  return file;
}

/** Share files with the system share sheet where supported, else download them. Returns 'shared' | 'cancelled' | 'downloaded'. */
export async function shareOrDownload(files, { title = '', download }) {
  if (typeof navigator !== 'undefined' && navigator.share && navigator.canShare) {
    let can = false; try { can = navigator.canShare({ files }); } catch { /* unsupported */ }
    if (can) {
      try { await navigator.share({ files, title }); return 'shared'; }
      catch (e) { if (e && e.name === 'AbortError') return 'cancelled'; /* share failed: fall back to a download */ }
    }
  }
  for (const f of files) download(f, f.name);
  return 'downloaded';
}
