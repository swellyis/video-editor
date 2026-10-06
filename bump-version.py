#!/usr/bin/env python3
"""Stamp sw.js with a content hash of the app shell so installed copies update, and stamp the same build id into
index.html (<meta name="ve-build">) and js/build.js so the app can detect a page/script mismatch and heal itself.
Run this after editing any file, before deploying:  python3 bump-version.py"""
import hashlib, re, pathlib
root = pathlib.Path(__file__).parent

# ---- AI files (MediaPipe face/segmenter, Whisper runtime, Clean voice Strong): they live in the long-lived 'video-editor-ai' cache,
# which survives app updates. Each file gets a content hash; the cache key is the URL + '?h=<hash>', so a changed vendor file gets a
# new key (returning users fetch it again) and the service worker drops the old entry. The same map goes into js/ai-manifest.js
# (page side) and sw.js (written before the shell hash below, so a changed model also changes the app version).
import json
AI_DIRS = ['vendor/mediapipe', 'vendor/whisper', 'vendor/clean-strong']
ai = {}
for d in AI_DIRS:
    for p in sorted((root / d).rglob('*')):
        if p.is_file() and not p.name.endswith('.txt'):  # licence texts are never fetched
            ai[p.relative_to(root).as_posix()] = hashlib.sha256(p.read_bytes()).hexdigest()[:16]
ai_json = json.dumps(ai, sort_keys=True, separators=(',', ':'))
(root / 'js' / 'ai-manifest.js').write_text(
    "// Written by bump-version.py: content hashes of the AI files kept in the 'video-editor-ai' cache (sw.js has the same map).\n"
    "/** Path (from the app root) -> first 16 hex digits of the file's SHA-256. */\n"
    f"export const AI_FILES = {ai_json};\n"
    "/** The app root URL (this file is js/ai-manifest.js). */\n"
    "export const AI_ROOT = new URL('../', import.meta.url).href;\n"
    "/** Cache key of an AI file: its URL + '?h=<content hash>' (any query/hash dropped). Other URLs are returned unchanged. */\n"
    "export function aiKey(url) {\n"
    "  const u = new URL(url, AI_ROOT), clean = u.href.split(/[?#]/)[0];\n"
    "  const rel = clean.startsWith(AI_ROOT) ? clean.slice(AI_ROOT.length) : null, h = rel && AI_FILES[rel];\n"
    "  return h ? clean + '?h=' + h : u.href;\n"
    "}\n")
sw = (root / 'sw.js').read_text()
sw, n = re.subn(r"const AI_FILES = \{[^;]*\};", lambda m: f"const AI_FILES = {ai_json};", sw)
if n != 1: raise SystemExit('sw.js: const AI_FILES = {...}; not found')
files = re.findall(r"'\./([^']+)'", sw.split('];')[0])
STAMP = re.compile(r'(<meta name="ve-build" content=")[^"]*(")')
h = hashlib.sha1()
for f in sorted(set(files)):
    p = root / f
    if f == 'js/build.js': continue  # holds the stamp itself
    if p.is_file():
        data = p.read_bytes()
        if f == 'index.html': data = STAMP.sub(lambda m: m.group(1) + m.group(2), data.decode()).encode()
        h.update(f.encode()); h.update(data)
ver = 'v' + h.hexdigest()[:10]
sw = re.sub(r"const VERSION = '[^']*';", f"const VERSION = '{ver}';", sw)
(root / 'sw.js').write_text(sw)
idx = (root / 'index.html').read_text()
idx = STAMP.sub(lambda m: m.group(1) + ver + m.group(2), idx)
(root / 'index.html').write_text(idx)
(root / 'js' / 'build.js').write_text(f"// Written by bump-version.py. Must equal <meta name=\"ve-build\"> in index.html, or the page reloads itself once.\nexport const BUILD = '{ver}';\n")
print('sw.js VERSION =', ver, '| AI files:', len(ai))
