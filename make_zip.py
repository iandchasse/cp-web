#!/usr/bin/env python3
"""Package the deployable web bundle for handoff.

Layout inside the zip:
  DEPLOY.md                 (read-me for the deploying agent; not deployed)
  crosspoint/<all of dist>  (drop this folder into the site root)
"""
import os
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(HERE, "dist")
DEPLOY_MD = os.path.join(HERE, "DEPLOY.md")
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.expanduser("~"), "Downloads", "crosspoint-web-deploy.zip")

if os.path.exists(OUT):
    os.remove(OUT)

n, total = 0, 0
with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED, compresslevel=1) as z:
    z.write(DEPLOY_MD, "DEPLOY.md")
    n += 1
    for root, _, files in os.walk(DIST):
        for name in files:
            full = os.path.join(root, name)
            rel = os.path.relpath(full, DIST).replace(os.sep, "/")
            z.write(full, "crosspoint/" + rel)
            n += 1
            total += os.path.getsize(full)

zsize = os.path.getsize(OUT)
print(f"[zip] {OUT}")
print(f"[zip] {n} entries, {total/1048576:.1f} MB uncompressed -> "
      f"{zsize/1048576:.1f} MB zip")
