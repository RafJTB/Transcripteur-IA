// Moteur de transcription : worker, messages, modèles, cache.

import { renderSettings } from './settings-ui.js';
import { DEFAULT_MODEL, MODELS, isStreaming, pickVariant } from '../config.js';
import { fmtClock } from '../exporters.js';
import { $, $$, caps, fmtBytes, fmtDuration, fmtMB, modelById, progress, state } from './core.js';
import { applyLexiconTo, renderSegments } from './doc.js';
import { renderModelsPage } from './pages.js';
import { monitor } from './recording.js';
import { persist } from './transcription.js';

// ======================================================================
// Worker (+ détection des plantages)
// ======================================================================
export let worker;
export const listeners = new Set();

export function startWorker() {
  worker?.terminate();
  let booted = false;
  worker = new Worker(new URL('../asr-worker.js', import.meta.url), { type: 'module' });
  const boot = new Promise((resolve, reject) => {
    const l = (m) => { if (m.type === 'boot') { listeners.delete(l); booted = true; resolve(); } };
    listeners.add(l);
    worker.onerror = (e) => {
      e.preventDefault?.();
      if (!booted) reject(new Error('Impossible de charger le moteur de transcription. Au premier lancement, cdn.jsdelivr.net doit être accessible.'));
      else signalCrash(`Erreur interne du moteur : ${e.message || 'inconnue'}`);
    };
  });
  worker.onmessage = (e) => { for (const l of [...listeners]) l(e.data); onWorkerMessage(e.data); };
  state.loadedKey = null;
  state.loading = null;
  return boot;
}

/** Le worker a planté ou ne répond plus : on fait échouer les requêtes en attente. */
export function signalCrash(message) {
  for (const l of [...listeners]) {
    l({ type: 'error', during: 'transcribe', kind: 'crash', message });
    l({ type: 'error', during: 'load', kind: 'crash', message });
  }
  state.live?.fail?.(new Error(message));
}

export function request(msg, doneTypes, transfer) {
  return new Promise((resolve, reject) => {
    const l = (m) => {
      if (doneTypes.includes(m.type) && (m.jobId == null || m.jobId === msg.jobId)) { listeners.delete(l); resolve(m); }
      else if (m.type === 'error' && m.during === msg.type && (m.jobId == null || m.jobId === msg.jobId)) {
        listeners.delete(l);
        const err = new Error(m.message);
        err.kind = m.kind;
        reject(err);
      }
    };
    listeners.add(l);
    worker.postMessage(msg, transfer || []);
  });
}

// Chien de garde : un bloc qui ne finit jamais = moteur bloqué ou tué (mémoire).
setInterval(() => {
  const r = state.run;
  if (!r || state.phase !== 'transcribing') return;
  const limit = Math.max(r.heavy ? 300000 : 150000, r.maxBlockMs * 5);
  if (performance.now() - r.lastAt > limit) signalCrash('Le moteur ne répond plus.');
}, 5000);

let dl = null;
function onWorkerMessage(m) {
  switch (m.type) {
    case 'load-start': {
      const model = MODELS.find((x) => x.repo === m.repo);
      const v = pickVariant(model, { ...caps(), webgpu: m.device === 'webgpu' });
      const cached = state.cache[model.id];
      dl = { t0: performance.now(), cached };
      progress.show(cached ? `Chargement de ${model.name} depuis le cache…` : `Téléchargement de ${model.name} (${fmtMB(v.sizeMB)})`, { value: 0 });
      break;
    }
    case 'load-progress': {
      if (!dl) break;
      const el = (performance.now() - dl.t0) / 1000;
      const speed = m.loaded / Math.max(el, 0.1);
      const eta = speed > 0 ? (m.total - m.loaded) / speed : Infinity;
      const sub = m.total ? `${fmtBytes(m.loaded)} / ${fmtBytes(m.total)}${!dl.cached && el > 2 ? ` · ${fmtBytes(speed)}/s · ≈ ${fmtDuration(eta)} restantes` : ''}` : '';
      progress.show($('#progress-label').textContent, { value: m.progress, sub });
      break;
    }
    case 'tick': {
      // Voxtral (fichier) : signe de vie et progression fine à l'intérieur d'une partie
      const r = state.run;
      if (!r || m.jobId !== r.jobId) break;
      r.lastAt = performance.now();
      const pct = (m.doneS / m.totalS) * 100;
      progress.show('Transcription en cours…', { value: pct, sub: `${fmtClock(m.doneS)} / ${fmtClock(m.totalS)} d’audio traité · progression sauvegardée à chaque partie` });
      renderSegments(applyLexiconTo([...r.doc.job.baseSegments, ...m.segments]), { editable: false });
      break;
    }
    case 'stream-pos':
      if (m.conf != null && state.live?.jobId === m.jobId) monitor?.addConf(m.doneS, m.conf);
    // falls through
    case 'stream-seg':
    case 'stream-partial':
    case 'stream-done':
      state.live?.handle?.(m);
      break;
    case 'error':
      if (m.during === 'stream-start') state.live?.fail?.(new Error(m.message));
      break;
    case 'warmup':
      progress.show('Initialisation du moteur…', { sub: caps().webgpu ? 'Compilation des shaders WebGPU (quelques secondes, une seule fois par session)' : 'Préparation du moteur WASM' });
      break;
    case 'progress': {
      const r = state.run;
      if (!r || m.jobId !== r.jobId) break;
      const now = performance.now();
      r.maxBlockMs = Math.max(r.maxBlockMs, now - r.lastAt);
      r.lastAt = now;
      // Sauvegarde du bloc terminé : c'est ce qui permet de reprendre après un plantage.
      const doc = r.doc;
      doc.job.seqs[m.index] = m.seq;
      doc.job.total = m.total;
      doc.segments = [...doc.job.baseSegments, ...m.segments];
      persist(doc);
      const tailS = (state.audio?.durationS ?? 0) - doc.job.fromS;
      const rt = m.elapsed > 0 ? (tailS * ((m.done - m.first) / m.total)) / m.elapsed : 0;
      progress.show(`Transcription · ${isStreaming(modelById(doc.job.modelId)) ? 'partie' : 'bloc'} ${m.done} / ${m.total}`, {
        value: (m.done / m.total) * 100,
        sub: m.done < m.total ? `≈ ${fmtDuration(m.eta)} restantes${rt ? ` · ×${rt.toFixed(1).replace('.', ',')} temps réel` : ''} · progression sauvegardée` : 'Finalisation…',
      });
      renderSegments(applyLexiconTo(doc.segments), { editable: false });
      break;
    }
  }
}

// ======================================================================
// Détection matérielle & modèles
// ======================================================================
export function renderEngine() {
  const pill = $('#pill-engine');
  const c = state.caps;
  if (!c) return;
  let text;
  if (c.webgpu && !state.forceWasm) {
    pill.className = 'pill ok';
    text = `WebGPU actif${c.adapter ? ' · ' + c.adapter : ''}`;
    pill.title = `Carte graphique utilisée pour le calcul.${c.f16 ? ' Précision fp16 disponible.' : ' fp16 non disponible.'}`;
  } else {
    pill.className = 'pill warn';
    const thr = c.crossOriginIsolated ? `multithread (${Math.min(4, Math.ceil(c.threads / 2))} threads)` : '1 thread';
    text = `WASM (processeur) · ${thr}`;
    pill.title = state.forceWasm ? 'WebGPU a échoué : bascule automatique sur le processeur.'
      : c.softwareGpu ? `Seul un GPU logiciel est disponible (${c.adapter}) : plus lent que le processeur, donc ignoré.`
      : 'WebGPU indisponible dans ce navigateur : calcul sur le processeur, plus lent.';
  }
  $('span', pill).textContent = text;
  renderSettings();
}

export function renderModels() {
  const box = $('#models');
  $$('.model', box).forEach((e) => e.remove());
  if (state.caps && !pickVariant(modelById(state.modelId), caps())) state.modelId = DEFAULT_MODEL;
  for (const m of MODELS) {
    const v = pickVariant(m, caps());
    const off = !!state.caps && !v;
    const cached = state.cache[m.id];
    const slow = m.heavy && !caps().webgpu && !off;
    const el = document.createElement('label');
    el.className = 'model' + (off ? ' unavailable' : '');
    el.innerHTML = `
      <input type="radio" name="model" value="${m.id}" ${m.id === state.modelId ? 'checked' : ''} ${off ? 'disabled' : ''} />
      <span class="radio"></span>
      <span class="m-title">${m.label}<em>${m.name}</em></span>
      <span class="m-size">${fmtMB((v || m.variants.webgpu).sizeMB)}</span>
      <span class="m-desc">${m.description}</span>
      <span class="m-badges" style="grid-column:2/4;display:flex;gap:6px;align-items:center;margin-top:4px">
        ${off ? '<span class="badge slow">Indisponible : carte graphique (WebGPU) requise</span>' : cached ? '<span class="badge cached">En cache</span>' : '<span class="badge">À télécharger</span>'}
        ${isStreaming(m) && !off ? '<span class="badge live">Vrai temps réel</span>' : ''}
        ${slow ? '<span class="badge slow">Lent sans WebGPU</span>' : ''}
        ${cached && !off ? `<button class="m-clear" type="button" data-clear="${m.id}">Supprimer du cache</button>` : ''}
      </span>`;
    box.appendChild(el);
  }
  renderModelPick();
  renderLangHint();
  renderLiveHint();
  if (state.page === 'models') renderModelsPage();
}

/** Ligne résumée du modèle choisi (le détail s'ouvre au clic). */
export function renderModelPick() {
  const m = modelById(state.modelId);
  const v = state.caps ? pickVariant(m, caps()) : m.variants.webgpu;
  $('#pk-label').textContent = m.label;
  $('#pk-name').textContent = m.name;
  const size = v ? fmtMB(v.sizeMB) : '';
  $('#pk-sub').textContent = !state.caps ? 'Détection du matériel…'
    : !v ? 'Indisponible sur ce PC'
    : state.cache[m.id] ? `Prêt · ${size} en cache` : `À télécharger · ${size}`;
}

export function renderLangHint() {
  const m = modelById(state.modelId);
  const el = $('#lang-hint');
  if (el) el.hidden = !isStreaming(m);
}

export function renderLiveHint() {
  const el = $('#live-hint');
  const m = modelById(state.modelId);
  // Sans carte graphique, l'avertissement général (sous « Transcrire ») suffit
  el.className = 'live-hint warn';
  el.textContent = isStreaming(m) && state.caps && !caps().webgpu ? 'Voxtral a besoin d’une carte graphique pour suivre en direct.' : '';
}

export async function refreshCache() {
  if (!state.caps) return;
  const models = MODELS.map((m) => {
    const v = pickVariant(m, caps());
    return v && { id: m.id, repo: m.repo, kind: m.kind, device: v.device, dtype: v.dtype };
  }).filter(Boolean);
  try {
    const r = await request({ type: 'cache-status', models }, ['cache']);
    state.cache = r.status;
  } catch { /* ignore */ }
  renderModels();
  renderStorage();
}

export async function renderStorage() {
  try {
    const est = await navigator.storage?.estimate?.();
    if (est) $('#foot-storage').textContent = `Stockage local utilisé : ${fmtBytes(est.usage)}`;
  } catch { /* ignore */ }
}
