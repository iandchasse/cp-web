#!/usr/bin/env python3
"""Static file server for the CrossPoint WASM demo.

By default adds the COOP/COEP headers required for SharedArrayBuffer (pthreads),
which the firmware's threaded render model needs. Serves ./dist.

  python serve.py [port]
  python serve.py 8000 --no-coi            # emulate a host that cannot set
                                           # headers (GitHub Pages); forces the
                                           # coi-serviceworker.js fallback
  python serve.py 8000 --prefix=/demo/     # emulate deployment to a subpath

--no-coi and --prefix exist so the two things most likely to break a deploy --
missing COOP/COEP, and being served from somewhere other than the site root --
can be reproduced locally instead of discovered in production.
"""
import http.server
import os
import sys

args = sys.argv[1:]
flags = [a for a in args if a.startswith("--")]
pos = [a for a in args if not a.startswith("--")]

PORT = int(pos[0]) if pos else 8000
NO_COI = "--no-coi" in flags
PREFIX = "/"
for f in flags:
    if f.startswith("--prefix"):
        PREFIX = f.split("=", 1)[1] if "=" in f else "/"
if not PREFIX.startswith("/"):
    PREFIX = "/" + PREFIX
if not PREFIX.endswith("/"):
    PREFIX += "/"

DIST = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dist")


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=DIST, **kw)

    def translate_path(self, path):
        # Strip the emulated subpath so dist/ can stay at the filesystem root.
        if PREFIX != "/" and path.startswith(PREFIX.rstrip("/")):
            path = path[len(PREFIX.rstrip("/")):] or "/"
        return super().translate_path(path)

    def end_headers(self):
        if not NO_COI:
            self.send_header("Cross-Origin-Opener-Policy", "same-origin")
            self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
            self.send_header("Cross-Origin-Resource-Policy", "cross-origin")
        # Cache the immutable loose SD assets (mirrors the _headers rule) so
        # reloads don't re-download the fonts/dictionary every time; keep
        # app/html/json uncached so rebuilds show up immediately.
        if "/fs/" in getattr(self, "path", ""):
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        else:
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # quiet


if __name__ == "__main__":
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    mode = "no COOP/COEP - service-worker fallback" if NO_COI else "COOP/COEP enabled"
    print(f"[serve] http://127.0.0.1:{PORT}{PREFIX}  ({mode}, dir={DIST})")
    httpd.serve_forever()
