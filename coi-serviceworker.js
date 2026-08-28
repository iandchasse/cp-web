// Cross-origin isolation service worker.
//
// SharedArrayBuffer (required by the WASM pthreads build) is only available in a
// cross-origin-isolated context, which normally needs the server to send:
//   Cross-Origin-Opener-Policy: same-origin
//   Cross-Origin-Embedder-Policy: require-corp
// Static hosts (GitHub Pages, S3, etc.) often can't set custom headers. This
// worker injects them into every response so the demo works anywhere. When the
// server already sends the headers (e.g. serve.py), the page is isolated on
// first load and never registers this worker.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Let range/cache-only cross-origin requests pass through untouched.
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;

  event.respondWith(
    fetch(req).then((res) => {
      if (res.status === 0) return res; // opaque response, leave as-is
      const headers = new Headers(res.headers);
      headers.set('Cross-Origin-Opener-Policy', 'same-origin');
      headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
      headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
      return new Response(res.body, {
        status: res.status, statusText: res.statusText, headers,
      });
    }).catch((e) => { console.error('[coi-sw]', e); throw e; })
  );
});
