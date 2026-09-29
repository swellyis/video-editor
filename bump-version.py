#!/usr/bin/env python3
"""Stamp sw.js with a content hash of the app shell so installed copies update, and stamp the same build id into
index.html (<meta name="ve-build">) and js/build.js so the app can detect a page/script mismatch and heal itself.
Run this after editing any file, before deploying:  python3 bump-version.py"""
import hashlib, re, pathlib
root = pathlib.Path(__file__).parent
sw = (root / 'sw.js').read_text()
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
print('sw.js VERSION =', ver)
