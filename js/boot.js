// Démarrage (chargé avant la page, de façon bloquante) : protection contre l'affichage dans un cadre,
// thème et personnalisation sans flash, filet de sécurité des mises à jour, service worker.
// (Sorti de index.html pour permettre une politique de sécurité du contenu sans script intégré.)

// Protection contre le « clickjacking » : l'appli refuse de s'afficher dans le cadre d'un autre site
(function () {
  if (window.top === window.self) return;
  var ok = false;
  try { ok = window.top.location.origin === window.location.origin; } catch (e) { ok = false; }
  if (ok) return;
  document.documentElement.style.display = 'none';
  try { window.top.location = window.location.href; } catch (e) { /* ignore */ }
})();

  // Thème clair / sombre : choix enregistré, sinon celui de Windows
  (function () {
    var t = null;
    try { t = localStorage.getItem('transcripteur.theme'); } catch (e) {}
    if (t !== 'light' && t !== 'dark') t = window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', t);
    // Personnalisation : fond, flou, voile, opacité des panneaux
    try {
      var p = JSON.parse(localStorage.getItem('transcripteur.perso') || 'null');
      if (p) {
        var s = document.documentElement.style;
        var img = p.bg === 'custom' ? localStorage.getItem('transcripteur.perso.image') : null;
        s.setProperty('--bg-image', img ? 'url("' + img + '")' : (p.css || "url('assets/bg.webp')"));
        s.setProperty('--bg-blur', (p.blur == null ? 14 : p.blur) + 'px');
        s.setProperty('--veil-k', String((p.veil == null ? 100 : p.veil) / 100));
        s.setProperty('--panel-k', String((p.panel == null ? 100 : p.panel) / 100));
        var av = p.accentVars && p.accentVars[t];
        if (av) for (var k in av) s.setProperty(k, av[k]);
      }
    } catch (e) {}
  })();

  // Filet de sécurité des mises à jour : si l'application ne démarre pas (souvent un mélange
  // d'ancienne et de nouvelle version gardées par le navigateur), on retélécharge tous ses
  // fichiers puis on recharge une fois. Si ça échoue encore, un bandeau explique quoi faire.
  (function () {
    var FILES = ['./', 'index.html', 'js/boot.js?v=2026-11-22-43', 'styles.css?v=2026-11-22-43', 'sw.js', 'js/app.js?v=2026-11-22-43', 'js/config.js', 'js/audio.js', 'js/lexicon.js',
      'js/exporters.js', 'js/claude-export.js', 'js/player.js', 'js/translate.js', 'js/translate-worker.js', 'js/speakers.js', 'js/speaker-worker.js', 'js/voices.js', 'js/actions.js', 'js/insights.js', 'js/assistant.js', 'js/perso.js', 'js/spaces.js', 'js/opus-ogg.js', 'js/llm-worker.js', 'js/langid.js', 'js/cloud.js', 'js/history.js', 'js/live.js', 'js/monitor.js', 'js/asr-worker.js', 'js/voxtral-engine.js', 'js/pcm-worklet.js', 'js/report.js', 'js/ui/report-ui.js', 'js/ui/space-chat.js', 'js/calendar.js', 'js/outlook.js', 'js/ui/calendar-ui.js', 'js/verify.js', 'js/ui/verify-ui.js', 'js/ui/storage-ui.js', 'js/ui/hover-glow.js', 'js/ui/settings-ui.js', 'js/ui/liquid-tabs.js', 'js/actionboard.js', 'js/ui/actions-board.js', 'js/presentation.js', 'js/projects.js',
      'js/ui/account.js', 'js/ui/assistant.js', 'js/ui/core.js', 'js/ui/dashboard.js', 'js/ui/diagnostic.js', 'js/ui/doc-tabs.js', 'js/ui/doc.js', 'js/ui/engine.js', 'js/ui/history.js', 'js/ui/notifs.js', 'js/ui/pages.js', 'js/ui/recording.js', 'js/ui/sound.js', 'js/ui/spaces.js', 'js/ui/speakers.js', 'js/ui/transcription.js', 'js/ui/translation.js', 'js/ui/views.js'];
    var done = false;
    function refreshAll() {
      return Promise.all(FILES.map(function (f) { return fetch(f, { cache: 'reload' }).catch(function () {}); }));
    }
    window.__forceUpdate = function () { refreshAll().then(function () { location.reload(); }); };
    function fail() {
      if (done || window.__appBoot) return;
      done = true;
      var tried = false;
      try { tried = sessionStorage.getItem('boot-retry') === '1'; sessionStorage.setItem('boot-retry', '1'); } catch (e) {}
      if (!tried) return window.__forceUpdate();
      var b = document.createElement('div');
      b.className = 'boot-error';
      b.innerHTML = '<strong>L’application n’a pas pu démarrer.</strong> Ton navigateur garde peut-être une ancienne version en mémoire. ' +
        '<button type="button">Recharger la dernière version</button><span>Si le problème continue : Ctrl + Maj + R.</span>';
      b.querySelector('button').onclick = function () { window.__forceUpdate(); };
      (document.body || document.documentElement).appendChild(b);
    }
    window.addEventListener('error', function () { setTimeout(fail, 300); });
    window.addEventListener('unhandledrejection', function () { setTimeout(fail, 300); });
    setTimeout(fail, 15000);
  })();

  // Active l'isolation cross-origin via un service worker (GitHub Pages ne permet pas
  // d'envoyer les en-têtes COOP/COEP). Elle autorise le WASM multithread (3-4× plus rapide sur CPU).
  (function () {
    if (window.crossOriginIsolated || !('serviceWorker' in navigator) || !window.isSecureContext) return;
    navigator.serviceWorker.register('sw.js').then(function (reg) {
      if (navigator.serviceWorker.controller) return; // déjà contrôlé : l'isolation dépend du navigateur
      try { if (sessionStorage.getItem('coi-reload')) return; sessionStorage.setItem('coi-reload', '1'); } catch (e) { return; }
      var go = function () { location.reload(); };
      if (reg.active) go(); else navigator.serviceWorker.addEventListener('controllerchange', go, { once: true });
    }).catch(function () {});
  })();
