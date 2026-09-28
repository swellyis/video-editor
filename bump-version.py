#!/usr/bin/env python3
"""Stamp sw.js with a content hash of the app shell so installed copies update.
Run this after editing any file, before deploying:  python3 bump-version.py"""
import hashlib, re, pathlib
root = pathlib.Path(__file__).parent
sw = (root / 'sw.js').read_text()
files = re.findall(r"'\./([^']+)'", sw.split('];')[0])
h = hashlib.sha1()
for f in sorted(set(files)):
    p = root / f
    if p.is_file():
        h.update(f.encode()); h.update(p.read_bytes())
ver = 'v' + h.hexdigest()[:10]
sw = re.sub(r"const VERSION = '[^']*';", f"const VERSION = '{ver}';", sw)
(root / 'sw.js').write_text(sw)
print('sw.js VERSION =', ver)
