// Service worker minimal : ajoute les en-têtes COOP/COEP aux réponses du site
// pour activer crossOriginIsolated (SharedArrayBuffer → WASM multithread).
// Les requêtes vers d'autres domaines (CDN, Hugging Face) ne sont pas touchées.
// Les fichiers du site sont toujours revérifiés auprès du serveur (cache: 'no-cache') :
// après une mise à jour, le navigateur ne peut plus mélanger ancienne et nouvelle version.
// Version : 2026-11-22-20
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (new URL(req.url).origin !== self.location.origin) return;
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;
  event.respondWith(
    fetch(req, { cache: 'no-cache' }).then((res) => {
      if (res.status === 0) return res;
      const headers = new Headers(res.headers);
      headers.set('Cross-Origin-Opener-Policy', 'same-origin');
      headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
      headers.set('Cross-Origin-Resource-Policy', 'same-origin');
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    })
  );
});
