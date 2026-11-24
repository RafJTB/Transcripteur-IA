// Service worker minimal : ajoute les en-têtes COOP/COEP aux réponses du site
// pour activer crossOriginIsolated (SharedArrayBuffer → WASM multithread).
// Les requêtes vers d'autres domaines (CDN, Hugging Face) ne sont pas touchées.
// Les fichiers du site sont toujours revérifiés auprès du serveur (cache: 'no-cache') :
// après une mise à jour, le navigateur ne peut plus mélanger ancienne et nouvelle version.
// Version : 2026-11-22-32
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
      // Sécurité (GitHub Pages ne permet pas d'envoyer ces en-têtes) : pas d'interprétation hasardeuse des types,
      // pas de référent, et pour la page elle-même : jamais affichée dans le cadre d'un autre site, accès limités.
      headers.set('X-Content-Type-Options', 'nosniff');
      headers.set('Referrer-Policy', 'no-referrer');
      if (req.mode === 'navigate') {
        headers.set('X-Frame-Options', 'SAMEORIGIN');
        headers.set('Content-Security-Policy', "frame-ancestors 'self'");
        headers.set('Permissions-Policy', 'camera=(), geolocation=(), payment=(), usb=(), microphone=(self), display-capture=(self)');
      }
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    })
  );
});
