// Orchestrateur de l'interface : source audio → transcription (worker) → résultat/export.
// Nouveautés : transcription en direct, reprise automatique, suppression des enregistrements.
import { MODELS, DEFAULT_MODEL, LANGUAGES, CHUNKING, TRANSFORMERS_VERSION, SAMPLE_RATE as SR, pickVariant, lighterModel, isStreaming } from './config.js';
import { decodeToMono16k, isAcceptedFile, Recorder, DEFAULT_AUDIO_SETTINGS, listMicrophones } from './audio.js';
import { loadLexicon, saveLexicon, compileLexicon, applyLexicon, DEFAULT_LEXICON } from './lexicon.js';
import { toTxt, toMarkdown, toSrt, download, fmtClock, safeFilename } from './exporters.js';
import { History, Audios, RecChunks, clearAll, newId } from './history.js';
import { LiveSession, VoxtralLive } from './live.js';
import { Monitor, CONF } from './monitor.js';
import { DICTATION, LAPTOP_PRESET, CALIBRATION_CONFIGS, dictationScore, analyzeRoom } from './calibration.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const store = {
  get: (k, d) => { try { return localStorage.getItem('transcripteur.' + k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem('transcripteur.' + k, v); } catch { /* ignore */ } },
  del: (k) => { try { localStorage.removeItem('transcripteur.' + k); } catch { /* ignore */ } },
};

const state = {
  caps: null,
  forceWasm: false,
  cache: {},
  modelId: MODELS.some((m) => m.id === store.get('model')) ? store.get('model') : DEFAULT_MODEL,
  language: store.get('lang', 'fr'),
  audio: null, // { pcm, blob, name, durationS, url, audioId, docId }
  phase: 'idle', // idle | loading | transcribing | live
  segments: [],
  doc: null, // transcription affichée (entrée d'historique)
  run: null, // transcription en cours { doc, jobId, lastAt, maxBlockMs, heavy }
  rec: null, // enregistrement en cours { id, live, mime, startedAt, pending }
  live: null, // LiveSession
  lexicon: loadLexicon(),
  jobId: 0,
};

// ======================================================================
// Utilitaires d'affichage
// ======================================================================
const fmtMB = (mb) => (mb >= 1000 ? `${(mb / 1000).toFixed(2).replace('.', ',')} Go` : `${Math.round(mb)} Mo`);
const fmtBytes = (b) => (b < 1e6 ? `${Math.max(1, Math.round(b / 1e3))} Ko` : fmtMB(b / 1e6));
function fmtDuration(s) {
  if (!isFinite(s)) return '—';
  if (s < 60) return `${Math.max(1, Math.round(s))} s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  if (m < 60) return r ? `${m} min ${String(r).padStart(2, '0')} s` : `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}
const modelById = (id) => MODELS.find((m) => m.id === id);
const caps = () => ({ ...state.caps, webgpu: state.caps?.webgpu && !state.forceWasm });
const recName = (d = new Date()) => `Enregistrement ${d.toLocaleDateString('fr-FR')} ${d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;

function toast(text, kind = 'info', ms = 5000) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, ms);
}

function status(text, kind = '') {
  const el = $('#status-line');
  el.textContent = text || '';
  el.className = `status-line ${kind}`;
}

/** Confirmation. Renvoie false si annulé, sinon { checked } (case à cocher optionnelle). */
function ask(title, text, okLabel = 'Continuer', { danger = false, checkbox = null, checked = true } = {}) {
  return new Promise((resolve) => {
    const m = $('#modal');
    $('#modal-title').textContent = title;
    $('#modal-text').textContent = text;
    $('#modal-ok').textContent = okLabel;
    $('#modal-ok').classList.toggle('danger-fill', danger);
    $('#modal-check').hidden = !checkbox;
    $('#modal-check-label').textContent = checkbox || '';
    $('#modal-check-input').checked = checked;
    m.hidden = false;
    $('#modal-ok').focus();
    const done = (v) => { m.hidden = true; $('#modal-ok').onclick = $('#modal-cancel').onclick = null; resolve(v); };
    $('#modal-ok').onclick = () => done({ checked: !!checkbox && $('#modal-check-input').checked });
    $('#modal-cancel').onclick = () => done(false);
  });
}

const progress = {
  show(label, { value = null, sub = '' } = {}) {
    $('#progress-block').hidden = false;
    $('#progress-label').textContent = label;
    const bar = $('#progress-block .bar');
    bar.classList.toggle('indeterminate', value == null);
    $('#progress-fill').style.width = value == null ? '' : `${Math.min(100, value).toFixed(1)}%`;
    $('#progress-value').textContent = value == null ? '' : `${Math.floor(value)} %`;
    $('#progress-sub').textContent = sub;
  },
  hide() { $('#progress-block').hidden = true; },
};

// ======================================================================
// Worker (+ détection des plantages)
// ======================================================================
let worker;
const listeners = new Set();

function startWorker() {
  worker?.terminate();
  let booted = false;
  worker = new Worker(new URL('./asr-worker.js', import.meta.url), { type: 'module' });
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
function signalCrash(message) {
  for (const l of [...listeners]) {
    l({ type: 'error', during: 'transcribe', kind: 'crash', message });
    l({ type: 'error', during: 'load', kind: 'crash', message });
  }
  state.live?.fail?.(new Error(message));
}

function request(msg, doneTypes, transfer) {
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
      if (state.phase !== 'live') status(cached ? 'Modèle déjà en cache : aucun téléchargement.' : 'Premier téléchargement : le modèle sera ensuite gardé en cache dans le navigateur.');
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
function renderEngine() {
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
}

function renderModels() {
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
  renderLangHint();
  renderLiveHint();
}

function renderLangHint() {
  const m = modelById(state.modelId);
  const el = $('#lang-hint');
  if (el) el.hidden = !isStreaming(m);
}

function renderLiveHint() {
  const el = $('#live-hint');
  const m = modelById(state.modelId);
  if (isStreaming(m)) {
    el.className = 'live-hint';
    el.textContent = 'Vrai temps réel avec Voxtral : le texte suit ta voix avec environ une demi-seconde de décalage (si ta carte graphique suit le rythme).';
  } else if (state.caps && !caps().webgpu && m.id !== 'base') {
    el.className = 'live-hint warn';
    el.textContent = `Sans carte graphique, ${m.name} risque de prendre du retard en direct : le modèle « Rapide » est conseillé. Le texte sera de toute façon complété à l’arrêt.`;
  } else {
    el.className = 'live-hint';
    el.textContent = `Le texte s’affiche pendant que tu parles, avec quelques secondes de décalage (modèle : ${m.name}).`;
  }
}

async function refreshCache() {
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

async function renderStorage() {
  try {
    const est = await navigator.storage?.estimate?.();
    if (est) $('#foot-storage').textContent = `Stockage local utilisé : ${fmtBytes(est.usage)}`;
  } catch { /* ignore */ }
}

// ======================================================================
// Source audio
// ======================================================================
/** Charge un audio dans la zone 1. `pcm` évite un décodage si on l'a déjà (direct). */
async function setAudioFromBlob(blob, name, { audioId = null, pcm = null, docId = null } = {}) {
  status('Décodage de l’audio…');
  try {
    pcm ??= await decodeToMono16k(blob);
    const durationS = pcm.length / SR;
    if (state.audio?.url) URL.revokeObjectURL(state.audio.url);
    state.audio = { pcm, blob, name, durationS, url: URL.createObjectURL(blob), audioId, docId };
    $('#audio-card').hidden = false;
    $('#audio-name').textContent = name;
    $('#audio-info').textContent = `${fmtClock(durationS)} · ${fmtBytes(blob.size)}${audioId ? ' · sauvegardé' : ''}`;
    $('#audio-player').src = state.audio.url;
    status(durationS > 7200 ? 'Audio très long : la transcription peut prendre beaucoup de temps et de mémoire.' : 'Audio prêt. Choisis un modèle puis lance la transcription.', durationS > 7200 ? 'warn' : '');
    if (durationS < 0.5) status('Audio très court (moins d’une demi-seconde).', 'warn');
  } catch (e) {
    status(e.message, 'err');
    toast(e.message, 'err');
  }
  updateButtons();
}

function clearAudio() {
  if (state.audio?.url) URL.revokeObjectURL(state.audio.url);
  state.audio = null;
  $('#audio-card').hidden = true;
  $('#audio-player').removeAttribute('src');
  status('');
  updateButtons();
}

/** Sauvegarde l'audio courant dans le navigateur (nécessaire pour reprendre après fermeture). */
async function ensureAudioStored() {
  const a = state.audio;
  if (a.audioId) return a.audioId;
  const key = `${a.name}|${a.blob.size}|${a.blob.lastModified ?? ''}`;
  const existing = await Audios.findByKey(key).catch(() => null);
  if (existing) return (a.audioId = existing);
  const id = newId();
  try {
    await Audios.put({ id, key, blob: a.blob, name: a.name, durationS: a.durationS, createdAt: Date.now() });
    a.audioId = id;
    return id;
  } catch {
    toast('Espace insuffisant pour sauvegarder l’audio : la reprise ne sera possible que tant que l’onglet reste ouvert.', 'warn', 8000);
    return null;
  }
}

/** Recharge l'audio d'une transcription depuis le stockage local. */
async function loadDocAudio(doc) {
  const a = state.audio;
  if (a && ((doc.audioId && a.audioId === doc.audioId) || a.docId === doc.id)) return true;
  if (!doc.audioId) return false;
  const rec = await Audios.get(doc.audioId).catch(() => null);
  if (!rec?.blob) return false;
  await setAudioFromBlob(rec.blob, rec.name, { audioId: rec.id, docId: doc.id });
  return !!state.audio;
}

function handleFiles(files) {
  const f = files?.[0];
  if (!f) return;
  if (state.phase !== 'idle' || micBusy()) return toast('Attends la fin de l’enregistrement ou de la transcription en cours.', 'warn');
  if (!isAcceptedFile(f)) {
    toast(`Format non supporté : « ${f.name} ». Formats acceptés : mp3, wav, m4a, webm, mp4, ogg, flac…`, 'err');
    return;
  }
  selectTab('file');
  hideResume();
  setAudioFromBlob(f, f.name);
}

function selectTab(name) {
  $$('.seg [data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  $$('.tab-panel').forEach((p) => (p.hidden = p.dataset.panel !== name));
}

// ======================================================================
// Micro (+ direct, + sauvegarde continue)
// ======================================================================
let monitor = null; // graphique volume / compréhension (créé au démarrage)

/** Micro occupé par un enregistrement (le simple test du micro ne bloque rien). */
const micBusy = () => recorder.state === 'recording' || recorder.state === 'paused';

/** Réglages du son, mémorisés dans le navigateur. */
const sound = (() => {
  try { return { ...DEFAULT_AUDIO_SETTINGS, ...JSON.parse(store.get('sound', '{}')) }; } catch { return { ...DEFAULT_AUDIO_SETTINGS }; }
})();
const saveSound = () => store.set('sound', JSON.stringify(sound));
const recorder = new Recorder({
  onLevel(l, info) {
    if (info) monitor?.addLevel(info.t, info.rms, info.peak);
    if (tool.meter) $('#tool-meter-fill').style.width = `${Math.round(Math.min(1, l * 1.4) * 100)}%`;
  },
  onTick(s) {
    $('#rec-time').textContent = fmtClock(s);
    if (state.live) renderRecState();
  },
  // Chaque seconde, le morceau compressé est sauvegardé : rien n'est perdu si l'onglet plante.
  onChunk(blob, idx) {
    const r = state.rec;
    if (!r) return;
    r.pending = r.pending.then(() => RecChunks.add(r.id, idx, blob)).catch(() => {});
  },
  onPcm(pcm) { state.live?.push(pcm); },
});

async function recToggle() {
  if (!micBusy()) await recStart();
  else await recStop();
}

async function recStart() {
  if (state.phase !== 'idle') return toast('Attends la fin de la transcription en cours.', 'warn');
  const live = $('#toggle-live').checked && !!state.caps;
  if (live && !(await confirmBigDownload(modelById(state.modelId)))) return;
  stopMicTest();
  try {
    await recorder.start({ pcm: live, settings: sound });
  } catch (e) {
    status(e.message, 'err');
    toast(e.message, 'err', 7000);
    return;
  }
  const rec = { id: newId(), live, mime: recorder.mimeType, startedAt: Date.now(), pending: Promise.resolve() };
  state.rec = rec;
  monitor?.start();
  refreshDevices();
  store.set('rec.active', JSON.stringify({ id: rec.id, live, mime: rec.mime, startedAt: rec.startedAt }));
  clearAudio();
  hideResume();
  if (live) startLive(rec);
  renderRec();
}

function startLive(rec) {
  const model = modelById(state.modelId);
  const doc = newDoc({ id: rec.id, title: recName(), source: 'Micro (direct)', modelId: model.id, model: model.name, status: 'live', liveP: 0 });
  showDoc(doc, { editable: false });
  persist(doc);

  let lastSave = 0;
  const handlers = {
    onUpdate: (s) => {
      doc.segments = s.committed.slice();
      state.segments = doc.segments;
      renderMeta();
      doc.liveP = s.committedS;
      if (performance.now() - lastSave > 2000) { lastSave = performance.now(); persist(doc); }
      renderLive();
      if (s.finishing) progress.show('Finalisation du direct…', { sub: s.lagS > 1 ? `Reste ≈ ${Math.round(s.lagS)} s d’audio à traiter` : 'Dernière phrase…' });
    },
    onError: (e) => {
      console.error(e);
      toast(`Transcription en direct interrompue (${e.message}). L’enregistrement continue : le texte sera complété à l’arrêt.`, 'warn', 9000);
      renderRecState();
    },
  };
  // Voxtral : vrai flux continu. Whisper : relecture de fenêtres toutes les ~3 s.
  const session = isStreaming(model)
    ? new VoxtralLive({ send: (msg, transfer) => worker.postMessage(msg, transfer || []), ...handlers })
    : new LiveSession({
      transcribeWindow: async (pcm, offsetS) => {
        const jobId = ++state.jobId;
        const durS = pcm.length / SR;
        const r = await request({ type: 'transcribe', jobId, audio: pcm, language: state.language, chunkLengthS: 0, offsetS, quiet: true }, ['result', 'cancelled'], [pcm.buffer]);
        const c = (r.segments || []).find((x) => x.conf != null)?.conf;
        if (c != null) monitor?.addConf(offsetS + durS, c);
        return r.segments || [];
      },
      ...handlers,
    });
  state.live = session;
  state.phase = 'live';
  showWaiting(true);
  updateButtons();

  // Chargement du modèle en parallèle : l'audio est mis en mémoire en attendant.
  ensureLoaded(model)
    .then((v) => {
      if (state.live !== session) return;
      doc.device = v.device;
      if (session.kind === 'voxtral') session.start(++state.jobId);
      else session.ready = true;
      progress.hide();
      status(`En direct · ${model.name} · ${v.device === 'webgpu' ? 'WebGPU' : 'WASM'}`);
      renderRecState();
    })
    .catch((e) => {
      if (state.live !== session) return;
      session.failed = true;
      session.pending = [];
      progress.hide();
      toast(`Modèle indisponible pour le direct (${e.message}). L’enregistrement continue ; tu pourras transcrire à l’arrêt.`, 'warn', 9000);
      renderRecState();
    });
}

function renderLive() {
  const s = state.live;
  if (!s) return;
  const t = $('#transcript');
  const nearBottom = t.scrollHeight - t.scrollTop - t.clientHeight < 80;
  const segs = [...s.committed, ...s.tentative.map((x) => ({ ...x, tentative: true }))];
  renderSegments(applyLexiconTo(segs), { editable: false });
  if (nearBottom) t.scrollTop = t.scrollHeight;
  renderRecState();
}

async function recStop() {
  const rec = state.rec;
  const r = await recorder.stop();
  state.rec = null;
  monitor?.stop();
  renderRec();
  if (!r || !rec) return;
  await rec.pending; // derniers morceaux écrits
  const name = recName(new Date(rec.startedAt));
  let audioId = rec.id;
  try {
    await Audios.put({ id: audioId, blob: r.blob, name, durationS: r.seconds, createdAt: Date.now() });
    await RecChunks.remove(rec.id);
  } catch {
    audioId = null;
  }
  store.del('rec.active');

  if (rec.live && state.live) {
    const s = state.live;
    const doc = state.doc;
    let finalSegs = null;
    if (s.kind === 'voxtral') {
      finalSegs = await s.finish(); // le modèle termine l'audio déjà reçu, sans tout retranscrire
      if (!finalSegs) await s.stop();
    } else {
      await s.stop();
    }
    state.live = null;
    state.phase = 'idle';
    progress.hide();
    const pcm = s.pcm;
    if (finalSegs) {
      await setAudioFromBlob(r.blob, name, { audioId, pcm, docId: doc.id });
      Object.assign(doc, { audioId, source: name, durationS: pcm.length / SR });
      doc.job = { modelId: doc.modelId, language: state.language, fromS: 0, baseSegments: finalSegs, seqs: [], total: null };
      return finalizeDoc(doc, []);
    }
    await setAudioFromBlob(r.blob, name, { audioId, pcm, docId: doc.id });
    Object.assign(doc, { audioId, source: name, durationS: pcm.length / SR, segments: s.committed.slice(), status: 'running' });
    doc.job = { modelId: doc.modelId, language: state.language, fromS: s.committedS, baseSegments: s.committed.slice(), seqs: [], total: null };
    if (pcm.length - Math.round(skipLeadingSilence(pcm, s.committedS) * SR) < SR * 0.5) return finalizeDoc(doc, []);
    status('Finalisation : transcription de la fin de l’enregistrement…');
    await runJob(doc);
  } else {
    await setAudioFromBlob(r.blob, name, { audioId });
  }
}

/** Supprime l'enregistrement en cours sans rien garder. */
async function recDiscard() {
  if (!micBusy()) return;
  const ok = await ask('Supprimer cet enregistrement ?', 'L’audio enregistré et le texte transcrit en direct seront définitivement effacés de ce navigateur.', 'Supprimer', { danger: true });
  if (!ok || !micBusy()) return;
  const rec = state.rec;
  state.rec = null;
  recorder.cancel();
  monitor?.reset();
  // Effacement visible tout de suite ; le moteur termine son calcul en cours en arrière-plan.
  const live = state.live;
  state.live = null;
  const stopping = live?.stop(); // bloque toute mise à jour du direct avant l'effacement
  progress.hide();
  showWaiting(false);
  if (state.doc?.id === rec?.id) clearResult();
  status('');
  renderRec();
  if (rec) {
    await rec.pending;
    await RecChunks.remove(rec.id).catch(() => {});
    await History.remove(rec.id).catch(() => {});
    await Audios.remove(rec.id).catch(() => {});
  }
  store.del('rec.active');
  renderStorage();
  toast('Enregistrement supprimé.', 'ok', 3000);
  if (live) {
    await stopping;
    state.phase = 'idle';
    updateButtons();
  }
}

function renderRecState() {
  const s = micBusy() ? recorder.state : 'idle';
  let text = { idle: 'Prêt à enregistrer', recording: 'Enregistrement en cours…', paused: 'En pause' }[s];
  const l = state.live;
  if (l && s !== 'idle') {
    if (l.failed) text += ' · direct interrompu';
    else if (!l.ready) text += ' · chargement du modèle…';
    else text += l.lagS > 8 ? ` · direct (retard ≈ ${Math.round(l.lagS)} s)` : ' · direct';
  }
  $('#rec-state').textContent = text;
}

function renderRec() {
  const s = micBusy() ? recorder.state : 'idle';
  const btn = $('#rec-main');
  btn.classList.toggle('recording', s !== 'idle');
  btn.classList.toggle('paused', s === 'paused');
  btn.setAttribute('aria-label', s === 'idle' ? 'Démarrer l’enregistrement' : 'Arrêter l’enregistrement');
  renderRecState();
  $('#rec-pause').disabled = s === 'idle';
  $('#rec-stop').disabled = s === 'idle';
  $('#rec-discard').disabled = s === 'idle';
  $('#toggle-live').disabled = s !== 'idle';
  $('#rec-pause span').textContent = s === 'paused' ? 'Reprendre' : 'Pause';
  if (s === 'idle') $('#rec-time').textContent = '00:00';
  renderSound();
  updateButtons();
}

// ======================================================================
// Transcription (reprise + repli automatiques)
// ======================================================================
async function ensureLoaded(model) {
  const v = pickVariant(model, caps());
  if (!v) {
    const err = new Error(`${model.name} nécessite une carte graphique compatible WebGPU.`);
    err.kind = 'unsupported';
    throw err;
  }
  const key = `${model.repo}|${v.device}|${JSON.stringify(v.dtype)}`;
  if (state.loadedKey === key) return v;
  if (state.phase === 'idle') {
    state.phase = 'loading';
    updateButtons();
  }
  // Un seul chargement à la fois : on rejoint celui en cours s'il concerne le même modèle.
  if (state.loading?.key !== key) {
    const promise = request({ type: 'load', repo: model.repo, kind: model.kind, device: v.device, dtype: v.dtype }, ['ready'])
      .finally(() => { if (state.loading?.promise === promise) state.loading = null; });
    state.loading = { key, promise };
  }
  await state.loading.promise;
  state.loadedKey = key;
  state.cache[model.id] = true;
  renderModels();
  renderStorage();
  return v;
}

function newDoc(fields) {
  return {
    id: newId(),
    createdAt: Date.now(),
    title: 'Transcription',
    source: '',
    audioId: null,
    modelId: state.modelId,
    model: modelById(state.modelId).name,
    device: null,
    language: state.language,
    durationS: 0,
    processingS: null,
    status: 'done', // done | running | interrupted | live
    job: null,
    segments: [],
    ...fields,
  };
}

async function persist(doc = state.doc) {
  if (!doc) return;
  try { await History.put(structuredClone(doc)); } catch (e) { console.warn('Historique indisponible', e); }
}

/** Premier téléchargement d'un gros modèle : on prévient avant. */
async function confirmBigDownload(model) {
  const v = pickVariant(model, caps());
  if (!v || state.cache[model.id] || v.sizeMB < 1000) return true;
  return !!(await ask(
    'Gros téléchargement',
    `${model.name} pèse ${fmtMB(v.sizeMB)}. Il sera téléchargé une seule fois puis gardé dans le navigateur. Selon ta connexion, compte de quelques minutes à plus d’un quart d’heure.`,
    'Télécharger'
  ));
}

async function startTranscription() {
  if (!state.audio || state.phase !== 'idle' || micBusy()) return;
  const model = modelById(state.modelId);
  if (model.heavy && !caps().webgpu) {
    const ok = await ask(
      'Modèle lourd sans carte graphique',
      `WebGPU n’est pas disponible : ${model.name} tournera sur le processeur et peut prendre plusieurs fois la durée de l’audio (téléchargement ${fmtMB(pickVariant(model, caps()).sizeMB)}). Le modèle « Équilibré » est conseillé ici.`,
      'Continuer quand même'
    );
    if (!ok) return;
  }
  if (!(await confirmBigDownload(model))) return;
  const a = state.audio;
  const audioId = await ensureAudioStored();
  const doc = newDoc({
    title: a.name.replace(/\.[a-z0-9]{2,4}$/i, ''),
    source: a.name,
    audioId,
    modelId: model.id,
    model: model.name,
    durationS: a.durationS,
    status: 'running',
    job: { modelId: model.id, language: state.language, fromS: 0, baseSegments: [], seqs: [], total: null },
  });
  a.docId = doc.id;
  await persist(doc);
  await runJob(doc);
}

/**
 * Lance ou reprend une transcription. Les blocs déjà faits (doc.job.seqs) ne sont pas refaits.
 * Plantage du moteur → redémarrage et reprise automatique (2 fois max).
 */
async function runJob(doc) {
  if (state.phase !== 'idle' || micBusy()) return;
  hideResume();
  showDoc(doc, { editable: false });
  if (!(await loadDocAudio(doc))) {
    toast('L’audio de cette transcription n’est plus disponible : impossible de reprendre.', 'err');
    doc.status = 'done';
    doc.partial = true;
    doc.job = null;
    await persist(doc);
    return showDoc(doc);
  }
  // Reprise en milieu d'audio : on démarre au début de la parole (Whisper date mal après un silence).
  if (doc.job.fromS > 0 && !doc.job.seqs.length) doc.job.fromS = skipLeadingSilence(state.audio.pcm, doc.job.fromS);
  let model = modelById(doc.job.modelId) || modelById(state.modelId);
  let v;
  let crashes = 0;
  showWaiting(true);

  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      v = await ensureLoaded(model);
      Object.assign(doc, { status: 'running', modelId: model.id, model: model.name, device: v.device });
      doc.job.modelId = model.id;
      await persist(doc);
      state.phase = 'transcribing';
      updateButtons();
      const done = doc.job.seqs.length;
      const unit = isStreaming(model) ? 'partie' : 'bloc';
      progress.show(done ? `Reprise ${unit === 'partie' ? 'à la partie' : 'au bloc'} ${done + 1}${doc.job.total ? ` / ${doc.job.total}` : ''}…` : 'Transcription…', {
        value: doc.job.total ? (done / doc.job.total) * 100 : 0,
        sub: done ? 'Les blocs déjà transcrits ne sont pas refaits' : 'Analyse du premier bloc',
      });
      status(`${model.name} · ${v.device === 'webgpu' ? 'WebGPU' : 'WASM'} · ${LANGUAGES.find((l) => l[0] === doc.job.language)?.[1] ?? doc.job.language}`);
      const pcm = state.audio.pcm.slice(Math.round(doc.job.fromS * SR));
      const jobId = ++state.jobId;
      state.run = { doc, jobId, lastAt: performance.now(), maxBlockMs: 0, heavy: !!model.heavy && v.device === 'wasm' };
      const res = await request(
        {
          type: 'transcribe', jobId, audio: pcm, language: doc.job.language,
          chunkLengthS: CHUNKING.chunkLengthS, strideLengthS: CHUNKING.strideLengthS,
          offsetS: doc.job.fromS, resumeSeqs: doc.job.seqs,
        },
        ['result', 'cancelled'],
        [pcm.buffer]
      );
      if (res.type === 'cancelled') {
        stopByUser(doc);
      } else {
        doc.processingS = (doc.processingS || 0) + res.seconds;
        finalizeDoc(doc, res.segments);
        toast(`Transcription terminée en ${fmtDuration(res.seconds)}.`, 'ok');
      }
      break;
    } catch (err) {
      console.error(err);
      if (err.kind === 'cancelled') { stopByUser(doc); break; }
      if (err.kind === 'crash') {
        if (++crashes > 2) {
          status('Le moteur s’est arrêté plusieurs fois. Essaie un modèle plus léger, puis « Reprendre ».', 'err');
          doc.status = 'interrupted';
          break;
        }
        toast(`Le moteur de transcription s’est arrêté. Reprise automatique ${isStreaming(model) ? 'à la partie' : 'au bloc'} ${doc.job.seqs.length + 1}…`, 'warn', 7000);
        await startWorker().catch(() => {});
        continue;
      }
      const next = fallbackFor(err, model);
      if (!next) {
        const msg = err.kind === 'network'
          ? 'Téléchargement impossible : vérifie la connexion (huggingface.co doit être accessible pour le premier chargement).'
          : `Erreur : ${err.message}`;
        status(msg, 'err');
        toast(msg, 'err', 8000);
        doc.status = 'interrupted';
        break;
      }
      toast(next.reason, 'warn', 8000);
      status(next.reason, 'warn');
      if (next.wasm) {
        // Même modèle sur le processeur : les blocs déjà faits restent valables.
        state.forceWasm = true;
        renderEngine();
        await startWorker();
        await refreshCache();
      }
      if (next.model) {
        // Autre modèle : on repart de zéro sur la partie restante.
        model = next.model;
        state.modelId = model.id;
        store.set('model', model.id);
        doc.job.seqs = [];
        doc.job.total = null;
        renderModels();
        await startWorker();
      }
    }
  }
  state.run = null;
  if (doc.status === 'running') doc.status = 'interrupted';
  await persist(doc);
  state.phase = 'idle';
  showWaiting(false);
  progress.hide();
  showDoc(doc);
  renderResume(doc);
}

function skipLeadingSilence(pcm, fromS) {
  const frame = SR / 10;
  let i = Math.round(fromS * SR);
  const start = i;
  while (i + frame <= pcm.length) {
    let e = 0;
    for (let k = i; k < i + frame; k++) e += pcm[k] * pcm[k];
    if (Math.sqrt(e / frame) > 0.006) break;
    i += frame;
  }
  return Math.max(start, i - SR / 4) / SR;
}

function stopByUser(doc) {
  doc.status = 'interrupted';
  doc.stopReason = 'user';
  toast('Transcription arrêtée. Le texte obtenu est conservé ; « Reprendre » continue là où elle s’est arrêtée.', 'warn', 7000);
}

function finalizeDoc(doc, newSegments) {
  doc.segments = applyLexiconTo([...doc.job.baseSegments, ...newSegments]);
  doc.status = 'done';
  doc.job = null;
  doc.stopReason = null;
  doc.autoResumes = 0;
  persist(doc);
  state.phase = 'idle';
  showWaiting(false);
  progress.hide();
  showDoc(doc);
  if (matchMedia('(max-width: 980px)').matches) $('#step-result').scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (!doc.segments.length) status('Aucune parole détectée dans cet audio.', 'warn');
}

/** Décide du repli : WebGPU → WASM, ou gros modèle → modèle plus léger. */
function fallbackFor(err, model) {
  if (err.kind === 'network') return null;
  const lighter = lighterModel(model.id);
  if (err.kind === 'memory' && lighter)
    return { model: lighter, reason: `Mémoire insuffisante pour ${model.name}. Bascule automatique sur ${lighter.name}.` };
  if (caps().webgpu && (err.kind === 'webgpu' || err.kind === 'unknown' || err.kind === 'memory'))
    return { wasm: true, reason: 'Le calcul WebGPU a échoué sur ce PC. Bascule automatique sur le processeur (WASM).' };
  if (lighter) return { model: lighter, reason: `${model.name} n’a pas pu être utilisé (${err.message.slice(0, 80)}). Essai avec ${lighter.name}.` };
  return null;
}

function cancel() {
  if (state.phase === 'transcribing') {
    worker.postMessage({ type: 'cancel' });
    progress.show('Arrêt…', { sub: 'Fin du bloc en cours' });
  } else if (state.phase === 'loading') {
    // Impossible d'interrompre proprement un téléchargement : on redémarre le worker.
    for (const l of [...listeners]) l({ type: 'error', during: 'load', kind: 'cancelled', message: 'Chargement annulé' });
    startWorker().then(refreshCache);
    status('Chargement annulé.');
  }
}

// ---------- Bloc « Reprendre » ----------
let autoTimer = null;

function isResumable(doc) {
  return !!doc && doc.status === 'interrupted' && !!doc.job && (!!doc.audioId || state.audio?.docId === doc.id);
}

function hideResume() {
  clearInterval(autoTimer);
  autoTimer = null;
  $('#resume-block').hidden = true;
}

/** Affiche « Reprendre » ; avec `auto`, la reprise se lance seule après un compte à rebours. */
function renderResume(doc = state.doc, { auto = false } = {}) {
  hideResume();
  if (!isResumable(doc) || state.phase !== 'idle' || micBusy()) return;
  const j = doc.job;
  const done = j.seqs?.length || 0;
  const unit = isStreaming(modelById(j.modelId)) ? 'partie' : 'bloc';
  const what = j.total
    ? `${unit} ${done} / ${j.total} (${Math.round((done / j.total) * 100)} %)`
    : j.fromS > 0 ? `reste à partir de ${fmtClock(j.fromS)}` : 'pas encore commencée';
  const base = `${what} · ${modelById(j.modelId)?.name ?? ''}`;
  $('#resume-title').textContent = doc.stopReason === 'user' ? 'Transcription arrêtée' : 'Transcription interrompue';
  $('#resume-sub').textContent = base;
  $('#resume-block').hidden = false;
  $('#btn-resume').onclick = () => resumeDoc(doc);
  if (auto) {
    let n = 8;
    const tick = () => {
      if (n <= 0) return resumeDoc(doc, { auto: true });
      $('#resume-sub').textContent = `${base} · reprise automatique dans ${n--} s`;
    };
    tick();
    autoTimer = setInterval(tick, 1000);
  }
}

async function resumeDoc(doc, { auto = false } = {}) {
  hideResume();
  if (auto) doc.autoResumes = (doc.autoResumes || 0) + 1;
  doc.stopReason = null;
  await runJob(doc);
}

// ======================================================================
// Résultat
// ======================================================================
const lexRules = () => compileLexicon(state.lexicon);
const applyLexiconTo = (segs) => { const r = lexRules(); return segs.map((s) => ({ ...s, text: applyLexicon(s.text, r) })); };

function showDoc(doc, { editable = true } = {}) {
  state.doc = doc;
  state.segments = doc.segments || [];
  $('#result-title').value = doc.title;
  renderMeta();
  renderSegments(state.segments, { editable });
}

function clearResult() {
  state.doc = null;
  state.segments = [];
  $('#result-title').value = '';
  renderMeta();
  showWaiting(false);
  renderSegments([], {});
  hideResume();
}

function renderMeta() {
  const d = state.doc;
  if (!d) return ($('#result-meta').textContent = '');
  const words = state.segments.reduce((n, s) => n + (s.text.match(/\S+/g)?.length || 0), 0);
  const parts = [
    new Date(d.createdAt).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }),
    d.durationS ? `audio ${fmtClock(d.durationS)}` : null,
    `${words} mots`,
    d.model + (d.device ? ` (${d.device === 'webgpu' ? 'WebGPU' : 'WASM'})` : ''),
    d.processingS ? `traité en ${fmtDuration(d.processingS)}` : null,
    confSummary(state.segments),
    d.status === 'live' ? 'en direct' : d.status === 'interrupted' ? 'interrompue' : d.partial ? 'partiel' : null,
  ];
  $('#result-meta').textContent = parts.filter(Boolean).join(' · ');
}

function confSummary(segs) {
  const withC = segs.filter((x) => x.conf != null);
  if (!withC.length) return null;
  const avg = withC.reduce((a, x) => a + x.conf, 0) / withC.length;
  const low = withC.filter((x) => x.conf < CONF.fair).length;
  return `confiance ${Math.round(avg * 100)} %` + (low ? ` · ${low} passage${low > 1 ? 's' : ''} à vérifier (soulignés)` : '');
}

// ======================================================================
// Réglages du son (sous le graphique)
// ======================================================================
const fmtGain = (db) => (db > 0 ? `+${db} dB` : `${db} dB`).replace('-', '−');

function renderSound() {
  $('#gain').value = sound.gainDb;
  $('#gain-val').textContent = fmtGain(sound.gainDb);
  $('#opt-agc').checked = sound.autoGainControl;
  $('#opt-ns').checked = sound.noiseSuppression;
  $('#opt-ec').checked = sound.echoCancellation;
  $('#opt-hp').checked = sound.highpass;
  $('#mic-device').value = sound.deviceId;
  if ($('#mic-device').value !== sound.deviceId) $('#mic-device').value = '';
  const busy = micBusy();
  const testing = recorder.state === 'preview';
  // Ces réglages imposent de rouvrir le micro : figés pendant un enregistrement
  ['#mic-device', '#opt-agc', '#opt-ns', '#opt-ec', '#tool-diag', '#tool-calib'].forEach((id) => ($(id).disabled = busy));
  $('#gain-auto').disabled = !(busy || testing);
  $('#mic-test').disabled = busy;
  $('#mic-test').classList.toggle('active', testing);
  $('#mic-test span').textContent = testing ? 'Arrêter le test' : 'Tester le micro';
  const hint = $('#sc-hint');
  if (busy) {
    hint.className = 'sc-hint';
    hint.textContent = 'Pendant l’enregistrement, seuls le gain et le filtre des basses sont modifiables. Les autres réglages s’appliqueront au prochain.';
  } else if (sound.autoGainControl && sound.gainDb !== 0) {
    hint.className = 'sc-hint warn';
    hint.textContent = 'Le gain automatique du navigateur compense en partie ton réglage : coupe-le pour un contrôle total du gain.';
  } else {
    hint.className = 'sc-hint';
    hint.textContent = testing ? 'Test en cours : parle normalement et règle le gain pour que la courbe reste dans la zone verte.' : 'Astuce : « Tester le micro » montre le niveau sans rien enregistrer.';
  }
}

async function refreshDevices() {
  const sel = $('#mic-device');
  const mics = (await listMicrophones()).filter((d) => d.deviceId && d.deviceId !== 'default');
  sel.replaceChildren(new Option('Micro par défaut', ''), ...mics.map((d, i) => new Option(d.label || `Micro ${i + 1}`, d.deviceId)));
  renderSound();
}

/** Applique un changement de réglage. Gain et filtre : immédiat. Autres : rouvre le micro en test. */
async function applySound(key, value) {
  sound[key] = value;
  saveSound();
  if (key === 'gainDb') recorder.setGain(value);
  else if (key === 'highpass') recorder.setHighpass(value);
  else if (recorder.state === 'preview') { stopMicTest(); await startMicTest(); }
  renderSound();
}

async function startMicTest() {
  if (micBusy() || recorder.state === 'preview') return;
  try {
    await recorder.start({ preview: true, settings: sound });
  } catch (e) {
    status(e.message, 'err');
    toast(e.message, 'err', 7000);
    return;
  }
  monitor.start();
  refreshDevices(); // les noms des micros sont visibles après autorisation
  renderSound();
}

function stopMicTest() {
  if (recorder.state !== 'preview') return;
  recorder.stopPreview();
  monitor.stop();
  renderSound();
}

function autoGain() {
  const delta = monitor.gainAdvice();
  if (delta == null) return toast('Parle normalement quelques secondes, puis clique à nouveau.', 'warn', 4000);
  const next = Math.max(-12, Math.min(24, Math.round(sound.gainDb + delta)));
  if (next === sound.gainDb) return toast(`Le niveau est déjà bon (gain ${fmtGain(next)}).`, 'ok', 3000);
  applySound('gainDb', next);
  toast(`Gain ajusté à ${fmtGain(next)}.${sound.autoGainControl ? ' Coupe le gain automatique pour un réglage plus stable.' : ''}`, 'ok', 5000);
}

function bindSound() {
  $('#gain').addEventListener('input', (e) => applySound('gainDb', Number(e.target.value)));
  $('#opt-agc').onchange = (e) => applySound('autoGainControl', e.target.checked);
  $('#opt-ns').onchange = (e) => applySound('noiseSuppression', e.target.checked);
  $('#opt-ec').onchange = (e) => applySound('echoCancellation', e.target.checked);
  $('#opt-hp').onchange = (e) => applySound('highpass', e.target.checked);
  $('#mic-device').onchange = (e) => applySound('deviceId', e.target.value);
  $('#mic-test').onclick = () => (recorder.state === 'preview' ? stopMicTest() : startMicTest());
  $('#gain-auto').onclick = autoGain;
  $('#preset-laptop').onclick = applyLaptopPreset;
  $('#tool-diag').onclick = runDiagnostic;
  $('#tool-calib').onclick = runCalibration;
  $('#tool-close').onclick = () => tool.close();
  $('#sound-reset').onclick = async () => {
    Object.assign(sound, DEFAULT_AUDIO_SETTINGS);
    saveSound();
    recorder.setGain(0);
    recorder.setHighpass(false);
    if (recorder.state === 'preview') { stopMicTest(); await startMicTest(); }
    renderSound();
    toast('Réglages du son par défaut rétablis.', 'ok', 2500);
  };
  navigator.mediaDevices?.addEventListener?.('devicechange', refreshDevices);
  refreshDevices();
}

// ======================================================================
// Outils qualité du micro : préréglage PC portable, diagnostic, calibration
// ======================================================================
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Fenêtre guidée : une étape = un texte + des boutons ; renvoie la valeur du bouton (null si fermé). */
const tool = {
  meter: false,
  _resolve: null,
  _timer: null,
  open(title) {
    $('#tool-title').textContent = title;
    $('#tool').hidden = false;
    this.cancelled = false;
  },
  close() {
    $('#tool').hidden = true;
    this.cancelled = true;
    this.meter = false;
    clearInterval(this._timer);
    this._resolve?.(null);
    this._resolve = null;
  },
  /** Affiche une étape. `timeout` (s) : valide automatiquement le dernier bouton à la fin du délai. */
  show({ step = '', html, actions = [], meter = false, timeout = 0 }) {
    if (this.cancelled) return Promise.resolve(null);
    clearInterval(this._timer);
    $('#tool-step').textContent = step;
    $('#tool-body').innerHTML = html;
    this.meter = meter;
    $('#tool-meter').hidden = !meter;
    $('#tool-timer').textContent = '';
    const box = $('#tool-actions');
    box.innerHTML = '';
    return new Promise((resolve) => {
      this._resolve = resolve;
      const done = (v) => { clearInterval(this._timer); this._resolve = null; resolve(v); };
      for (const a of actions) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn' + (a.primary ? ' primary' : '');
        b.textContent = a.label;
        b.onclick = () => (a.value === null ? this.close() : done(a.value));
        box.appendChild(b);
      }
      box.lastElementChild?.focus();
      if (timeout) {
        const end = performance.now() + timeout * 1000;
        const last = actions[actions.length - 1];
        this._timer = setInterval(() => {
          const left = Math.ceil((end - performance.now()) / 1000);
          $('#tool-timer').textContent = `${Math.max(0, left)} s`;
          if (left <= 0) done(last.value);
        }, 200);
      }
      if (!actions.length) this._resolve = resolve; // étape d'attente : se termine par close() ou par le code
    });
  },
  /** Étape sans bouton (attente), à remplacer par la suivante. */
  wait(step, html) {
    if (this.cancelled) return;
    clearInterval(this._timer);
    $('#tool-step').textContent = step;
    $('#tool-body').innerHTML = html;
    this.meter = false;
    $('#tool-meter').hidden = true;
    $('#tool-actions').innerHTML = '<button class="btn" type="button">Annuler</button>';
    $('#tool-actions button').onclick = () => this.close();
  },
};

function toolBusy() {
  if (state.phase !== 'idle' || micBusy()) {
    toast('Attends la fin de la transcription ou de l’enregistrement en cours.', 'warn');
    return true;
  }
  return false;
}

/** Arrête proprement le micro s'il a été ouvert par un outil. */
function toolCleanup() {
  tool.meter = false;
  if (recorder.state === 'preview') recorder.stopPreview();
  else if (recorder.state !== 'idle') recorder.cancel();
  monitor.stop();
  renderRec();
}

function applyLaptopPreset() {
  Object.assign(sound, LAPTOP_PRESET);
  saveSound();
  recorder.setGain(sound.gainDb);
  recorder.setHighpass(sound.highpass);
  if (recorder.state === 'preview') { stopMicTest(); startMicTest(); }
  renderSound();
  toast('Réglages optimisés pour le micro du PC : réduction du bruit, annulation d’écho, gain automatique et filtre des basses activés.', 'ok', 6000);
}

const rowHtml = (x, best = false) => `
  <div class="tool-row${best ? ' best' : ''}" data-level="${x.level}">
    <span class="dot"></span><strong>${esc(x.label)}</strong><span class="v">${esc(x.value)}</span>
    ${x.text ? `<small>${esc(x.text)}</small>` : ''}${x.diff ? `<div class="diff">${x.diff}</div>` : ''}
  </div>`;

async function runDiagnostic() {
  if (toolBusy()) return;
  stopMicTest();
  tool.open('Diagnostic de la pièce');
  try {
    const go = await tool.show({
      step: 'Étape 1 / 3',
      html: `<p>On mesure ta pièce avec le <strong>micro brut</strong> (sans traitement du navigateur), pour juger la pièce elle-même.</p>
        <ol><li><strong>3 secondes de silence complet</strong> : ne parle pas, ne touche pas au clavier.</li>
        <li>Puis <strong>lis une phrase à voix haute</strong>, normalement, à ta place habituelle devant le PC.</li></ol>`,
      actions: [{ label: 'Annuler', value: null }, { label: 'Commencer', value: 'go', primary: true }],
    });
    if (!go) return;
    await recorder.start({ preview: true, settings: { ...sound, noiseSuppression: false, autoGainControl: false, echoCancellation: false, highpass: false, gainDb: 0 } });
    monitor.start();
    // 1. Silence
    const t0 = monitor.now;
    for (let n = 3; n > 0 && !tool.cancelled; n--) {
      tool.wait('Étape 2 / 3', `<p class="tool-big">Silence…</p><p>Ne parle pas, ne touche à rien : <strong>${n} s</strong></p>`);
      tool.meter = true; $('#tool-meter').hidden = false;
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (tool.cancelled) return;
    await new Promise((r) => setTimeout(r, 400));
    const silence = monitor.levels.filter((l) => l.t >= t0 + 0.4);
    // 2. Voix
    const t1 = monitor.now;
    const done = await tool.show({
      step: 'Étape 2 / 3',
      meter: true,
      timeout: 15,
      html: `<p>Lis cette phrase à voix haute, normalement, <strong>en marquant de courtes pauses</strong> :</p><blockquote class="tool-sentence">${esc(DICTATION[0])}</blockquote>`,
      actions: [{ label: 'Annuler', value: null }, { label: 'J’ai fini', value: 'done', primary: true }],
    });
    const speech = monitor.levels.filter((l) => l.t >= t1);
    toolCleanup();
    if (!done) return;
    const res = analyzeRoom(silence, speech);
    if (!res) {
      await tool.show({ step: 'Résultat', html: '<p>Mesure trop courte : recommence en laissant le micro ouvert quelques secondes de plus.</p>', actions: [{ label: 'Fermer', value: null }] });
      return;
    }
    const next = await tool.show({
      step: 'Étape 3 / 3 · Résultat',
      html: `<p class="tool-verdict">${esc(res.verdict)}</p>
        <div class="tool-results">${res.items.map((x) => rowHtml(x)).join('')}</div>
        <div class="tool-advice"><p>Conseils</p><ul>${res.advice.map((a) => `<li>${esc(a)}</li>`).join('')}</ul></div>
        <p>Mesure indicative faite avec le micro brut. L’écho est estimé d’après la vitesse à laquelle le son retombe après chaque mot.</p>`,
      actions: [{ label: 'Fermer', value: null }, { label: 'Calibrer les réglages', value: 'calib', primary: true }],
    });
    if (next === 'calib') { tool.close(); runCalibration(); }
  } catch (e) {
    toolCleanup();
    if (!tool.cancelled) { tool.close(); toast(e.message, 'err', 7000); }
  } finally {
    if (recorder.state !== 'idle') toolCleanup();
    renderSound();
  }
}

async function runCalibration() {
  if (toolBusy()) return;
  stopMicTest();
  const model = modelById(state.modelId);
  tool.open('Calibration par dictée');
  try {
    const go = await tool.show({
      step: 'Présentation',
      html: `<p>Tu vas lire <strong>3 phrases</strong>, une par réglage. Pour chacune, l’app transcrit ta lecture et calcule le <strong>pourcentage de mots justes</strong>.</p>
        <ul>${CALIBRATION_CONFIGS.map((c, i) => `<li>Lecture ${i + 1} : ${esc(c.label)}</li>`).join('')}</ul>
        <p>Installe-toi comme d’habitude devant le PC et lis normalement, sans forcer. Modèle utilisé : <strong>${esc(model.name)}</strong>. Durée : environ 1 minute.</p>
        <p>Les écarts de 1 ou 2 % ne sont pas significatifs (deux lectures ne sont jamais identiques).</p>`,
      actions: [{ label: 'Annuler', value: null }, { label: 'Commencer', value: 'go', primary: true }],
    });
    if (!go) return;
    if (!(await confirmBigDownload(model))) return tool.close();
    tool.wait('Préparation', `<p class="tool-big">Préparation du modèle…</p><p>${esc(model.name)} — la première fois, il peut être téléchargé.</p>`);
    await ensureLoaded(model);
    state.phase = 'idle';
    progress.hide();
    updateButtons();
    if (tool.cancelled) return;

    const results = [];
    for (const [i, cfg] of CALIBRATION_CONFIGS.entries()) {
      const sentence = DICTATION[i];
      const step = `Lecture ${i + 1} / ${CALIBRATION_CONFIGS.length}`;
      const ready = await tool.show({
        step,
        html: `<p>Réglage testé : <strong>${esc(cfg.label)}</strong></p><p>Clique sur « Commencer à lire », puis lis :</p><blockquote class="tool-sentence">${esc(sentence)}</blockquote>`,
        actions: [{ label: 'Annuler', value: null }, { label: 'Commencer à lire', value: 'go', primary: true }],
      });
      if (!ready) return;
      await recorder.start({ settings: { ...sound, ...cfg.settings } });
      monitor.start();
      const done = await tool.show({
        step,
        meter: true,
        timeout: 25,
        html: `<p class="tool-rec">● Enregistrement — lis la phrase :</p><blockquote class="tool-sentence">${esc(sentence)}</blockquote>`,
        actions: [{ label: 'Annuler', value: null }, { label: 'J’ai fini', value: 'done', primary: true }],
      });
      if (!done) return;
      const rec = await recorder.stop();
      monitor.stop();
      renderRec();
      tool.wait(step, '<p class="tool-big">Analyse de la lecture…</p><p>Transcription et comparaison avec la phrase lue.</p>');
      const pcm = await decodeToMono16k(rec.blob);
      const jobId = ++state.jobId;
      const r = await request(
        { type: 'transcribe', jobId, audio: pcm, language: 'fr', chunkLengthS: CHUNKING.chunkLengthS, strideLengthS: CHUNKING.strideLengthS, offsetS: 0, quiet: true },
        ['result', 'cancelled'],
        [pcm.buffer]
      );
      if (tool.cancelled) return;
      const hyp = (r.segments || []).map((x) => x.text).join(' ');
      const sc = dictationScore(sentence, hyp);
      const confs = (r.segments || []).map((x) => x.conf).filter((x) => x != null);
      results.push({ cfg, score: sc.score, ops: sc.ops, conf: confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : null });
    }

    // Meilleur réglage ; à 3 points près, on garde le réglage recommandé (A), plus simple
    const A = results[0];
    let best = [...results].sort((a, b) => b.score - a.score)[0];
    const close = best.score - A.score < 0.03;
    if (close) best = A;
    // « Compris : » = la transcription, mots faux surlignés + nombre de mots oubliés
    const diffHtml = (ops) => {
      const said = ops.filter((o) => o.type !== 'del').map((o) => (o.type === 'ok' ? esc(o.hyp ?? o.ref) : `<mark>${esc(o.hyp)}</mark>`)).join(' ');
      const missed = ops.filter((o) => o.type === 'del').length;
      return `<span class="lbl">Compris :</span> ${said || '<em>rien</em>'}${missed ? ` <span class="missed">· ${missed} mot${missed > 1 ? 's' : ''} oublié${missed > 1 ? 's' : ''}</span>` : ''}`;
    };
    const lvl = (s) => (s >= 0.9 ? 'ok' : s >= 0.75 ? 'warn' : 'err');
    const rows = results.map((x) => rowHtml({
      level: lvl(x.score),
      label: x.cfg.label,
      value: `${Math.round(x.score * 100)} %`,
      text: `${x.cfg.short}${x.conf != null ? ` · confiance du modèle ${Math.round(x.conf * 100)} %` : ''}`,
      diff: diffHtml(x.ops),
    }, x === best)).join('');
    const top = Math.max(...results.map((x) => x.score));
    const verdict = top < 0.5
      ? 'Scores trop faibles pour départager les réglages : le problème vient d’ailleurs (distance, bruit, écho ou modèle).'
      : close
        ? `Les réglages se valent (écart de ${Math.round((top - A.score) * 100)} point${top - A.score >= 0.015 ? 's' : ''} au plus) : on garde le réglage recommandé.`
        : `Meilleur réglage : « ${best.cfg.label} » (${Math.round(best.score * 100)} % de mots justes).`;
    const tip = best.score < 0.75
      ? '<div class="tool-advice"><p>Score faible quel que soit le réglage</p><ul><li>Rapproche-toi du PC, réduis le bruit ambiant, ou essaie un modèle plus précis.</li><li>Lance le « Diagnostic de la pièce » pour savoir si le problème vient de l’environnement.</li></ul></div>'
      : '';
    const act = await tool.show({
      step: 'Résultat',
      html: `<p class="tool-verdict">${esc(verdict)}</p><div class="tool-results">${rows}</div>${tip}
        <p>Mots surlignés : mal compris. Le réglage encadré en vert sera appliqué.</p>`,
      actions: [{ label: 'Fermer', value: null }, { label: 'Recommencer', value: 'again' }, { label: 'Appliquer ce réglage', value: 'apply', primary: true }],
    });
    if (act === 'apply') {
      Object.assign(sound, best.cfg.settings);
      saveSound();
      renderSound();
      tool.close();
      toast(`Réglage appliqué : ${best.cfg.label}.`, 'ok', 5000);
    } else if (act === 'again') {
      tool.close();
      runCalibration();
    }
  } catch (e) {
    console.error(e);
    toolCleanup();
    if (!tool.cancelled) { tool.close(); toast(`Calibration interrompue : ${e.message}`, 'err', 8000); }
  } finally {
    if (recorder.state !== 'idle') toolCleanup();
    if (state.phase === 'loading') { state.phase = 'idle'; progress.hide(); updateButtons(); }
    renderSound();
  }
}

/** Pastilles « Volume » / « Compréhension » + conseil sous le graphique. */
function renderMonitorState({ volume, conf }) {
  const set = (id, st, empty) => {
    const el = $(id);
    el.dataset.level = st?.level || '';
    $('.val', el).textContent = st?.label || empty;
  };
  const testing = recorder.state === 'preview';
  set('#vol-state', volume, recorder.state === 'idle' ? '—' : 'Mesure…');
  set('#conf-state', conf, recorder.state === 'idle' ? '—' : testing ? 'Test du micro (pas de transcription)' : state.live ? 'En attente du modèle…' : 'Mode direct désactivé');
  const hint = (volume?.level === 'err' && volume.hint) || (conf?.level === 'err' && conf.hint) || volume?.hint || conf?.hint;
  const el = $('#monitor-hint');
  if (recorder.state === 'idle' && !hint) {
    el.className = 'monitor-hint';
    el.textContent = 'Lance un enregistrement : le graphique montre si ta voix est au bon niveau et, en mode direct, si le modèle te comprend bien.';
  } else {
    el.className = 'monitor-hint' + (hint ? ' warn' : '');
    el.textContent = hint || (recorder.state === 'idle' ? ''
      : testing ? (volume?.level === 'ok' ? 'Bon niveau : tu peux lancer l’enregistrement.' : 'Parle normalement pour vérifier le niveau.')
      : 'Tout va bien : continue à parler normalement.');
  }
}

function showWaiting(on) {
  const t = $('#transcript');
  $('.typing', t)?.remove();
  if (on) {
    $('#empty-state').hidden = true;
    const el = document.createElement('div');
    el.className = 'typing';
    el.innerHTML = '<i></i><i></i><i></i>';
    t.appendChild(el);
  }
}

function renderSegments(segs, { editable = true } = {}) {
  const t = $('#transcript');
  const typing = $('.typing', t);
  $('#empty-state').hidden = segs.length > 0 || !!typing;
  let rows = $$('.segment', t);
  rows.slice(segs.length).forEach((r) => r.remove());
  rows = rows.slice(0, segs.length);
  segs.forEach((s, i) => {
    let row = rows[i];
    if (!row) {
      row = document.createElement('div');
      row.className = 'segment';
      row.innerHTML = '<button class="ts" type="button"></button><div class="txt" spellcheck="true"></div>';
      t.insertBefore(row, typing || null);
    }
    row.classList.toggle('partial', !editable);
    row.classList.toggle('tentative', !!s.tentative);
    row.classList.toggle('gap', i > 0 && s.start - segs[i - 1].end > 2);
    const low = !s.tentative && s.conf != null && s.conf < CONF.fair;
    row.classList.toggle('low-conf', low);
    const ts = $('.ts', row);
    ts.textContent = fmtClock(s.start);
    ts.dataset.start = s.start;
    ts.title = `${fmtClock(s.start)} → ${fmtClock(s.end)}`;
    const txt = $('.txt', row);
    txt.dataset.i = i;
    txt.title = s.conf != null ? `Confiance du modèle : ${Math.round(s.conf * 100)} %${low ? ' — passage à vérifier' : ''}` : '';
    if (editable) txt.setAttribute('contenteditable', 'plaintext-only');
    else txt.removeAttribute('contenteditable');
    if (document.activeElement !== txt && txt.textContent !== s.text) txt.textContent = s.text;
  });
  updateButtons();
}

let saveTimer;
function saveDoc(debounce = 0) {
  const doc = state.doc;
  if (!doc || doc.status === 'running' || doc.status === 'live') return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    doc.segments = state.segments;
    doc.title = $('#result-title').value.trim() || doc.title;
    persist(doc);
  }, debounce);
}

function exportName(ext) { return `${safeFilename(state.doc?.title)}.${ext}`; }
const tsOn = () => $('#toggle-ts').checked;

async function copyText() {
  const text = toTxt(state.segments, { timestamps: tsOn() });
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('Texte copié dans le presse-papiers.', 'ok', 2500);
}

function exportAs(fmt) {
  const segs = state.segments;
  if (!segs.length) return;
  const d = state.doc;
  if (fmt === 'txt') download(exportName('txt'), toTxt(segs, { timestamps: tsOn() }), 'text/plain');
  if (fmt === 'md') {
    const meta = [d?.source, d?.durationS ? `durée ${fmtClock(d.durationS)}` : null, d?.model, new Date(d?.createdAt || Date.now()).toLocaleString('fr-FR')]
      .filter(Boolean).join(' · ');
    download(exportName('md'), toMarkdown(segs, { timestamps: tsOn(), title: d?.title || 'Transcription', meta }), 'text/markdown');
  }
  if (fmt === 'srt') download(exportName('srt'), toSrt(segs), 'application/x-subrip');
}

function updateButtons() {
  const busy = state.phase !== 'idle';
  const recording = micBusy();
  const has = state.segments.length > 0 && !busy;
  const btn = $('#btn-transcribe');
  btn.disabled = !state.audio || busy || recording || !state.caps;
  btn.classList.toggle('busy', busy);
  $('span', btn).textContent = {
    loading: 'Chargement du modèle…', transcribing: 'Transcription en cours…', live: 'Transcription en direct…',
  }[state.phase] || 'Transcrire';
  $('#btn-cancel').hidden = !(state.phase === 'loading' || state.phase === 'transcribing');
  $$('[data-export], #btn-copy, #btn-relex').forEach((b) => (b.disabled = !has));
  $('#result-title').disabled = !state.doc;
  $$('#models input').forEach((i) => (i.disabled = busy || recording));
  $('#lang').disabled = busy || recording;
  $('#audio-delete').disabled = busy;
  $('#audio-clear').disabled = busy;
  $('#btn-resume').disabled = busy || recording;
}

// ======================================================================
// Suppression d'un enregistrement
// ======================================================================
async function deleteRecording() {
  const a = state.audio;
  if (!a || state.phase !== 'idle') return;
  const linked = (await History.list().catch(() => [])).filter((d) => (a.audioId && d.audioId === a.audioId) || d.id === a.docId);
  const r = await ask(
    'Supprimer l’enregistrement ?',
    `« ${a.name} » sera définitivement effacé de ce navigateur.`,
    'Supprimer',
    { danger: true, checkbox: linked.length ? (linked.length > 1 ? 'Supprimer aussi les transcriptions associées' : 'Supprimer aussi la transcription associée') : null, checked: true }
  );
  if (!r) return;
  if (a.audioId) await Audios.remove(a.audioId).catch(() => {});
  for (const d of linked) {
    if (r.checked) {
      await History.remove(d.id).catch(() => {});
      if (state.doc?.id === d.id) clearResult();
    } else {
      d.audioId = null;
      if (d.status === 'interrupted') Object.assign(d, { status: 'done', partial: true, job: null });
      await persist(d);
      if (state.doc?.id === d.id) showDoc(d);
    }
  }
  clearAudio();
  hideResume();
  renderStorage();
  toast(r.checked ? 'Enregistrement et transcription supprimés.' : 'Enregistrement supprimé (le texte est conservé).', 'ok', 3500);
}

// ======================================================================
// Lexique
// ======================================================================
function renderLexicon() {
  const list = $('#lex-list');
  list.innerHTML = '';
  state.lexicon.forEach((e, i) => {
    const row = document.createElement('div');
    row.className = 'lex-row' + (e.enabled === false ? ' off' : '');
    row.innerHTML = `
      <input type="checkbox" ${e.enabled !== false ? 'checked' : ''} aria-label="Activer" data-k="enabled" />
      <input type="text" value="" placeholder="ex. revite" data-k="from" aria-label="Terme entendu" />
      <input type="text" value="" placeholder="ex. Revit" data-k="to" aria-label="Correction" />
      <button class="icon-btn" type="button" data-del aria-label="Supprimer"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
      ${e.note ? '<span></span><span class="note"></span>' : ''}`;
    $('[data-k=from]', row).value = e.from || '';
    $('[data-k=to]', row).value = e.to || '';
    if (e.note) $('.note', row).textContent = e.note;
    row.addEventListener('input', (ev) => {
      const k = ev.target.dataset.k;
      if (!k) return;
      e[k] = k === 'enabled' ? ev.target.checked : ev.target.value;
      row.classList.toggle('off', e.enabled === false);
      saveLexicon(state.lexicon);
    });
    $('[data-del]', row).onclick = () => { state.lexicon.splice(i, 1); saveLexicon(state.lexicon); renderLexicon(); };
    list.appendChild(row);
  });
}

// ======================================================================
// Historique
// ======================================================================
async function renderHistory() {
  const list = $('#hist-list');
  let items = [];
  let sizes = {};
  try { [items, sizes] = await Promise.all([History.list(), Audios.sizes()]); } catch { list.innerHTML = '<p class="hist-empty">Historique indisponible dans ce navigateur.</p>'; return; }
  if (!items.length) { list.innerHTML = '<p class="hist-empty">Aucune transcription enregistrée pour l’instant.</p>'; return; }
  list.innerHTML = '';
  for (const it of items) {
    const el = document.createElement('div');
    el.className = 'hist-item' + (state.doc?.id === it.id ? ' current' : '');
    el.tabIndex = 0;
    el.innerHTML = `<strong></strong><button class="icon-btn danger" type="button" aria-label="Supprimer" title="Supprimer la transcription et son audio"><svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg></button><small></small><p></p>`;
    $('strong', el).textContent = it.title;
    const audioSize = it.audioId ? sizes[it.audioId] : null;
    $('small', el).textContent = [
      new Date(it.createdAt).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }),
      it.durationS ? fmtClock(it.durationS) : null,
      it.model,
      audioSize != null ? `audio ${fmtBytes(audioSize)}` : null,
    ].filter(Boolean).join(' · ');
    if (it.status === 'interrupted' || it.status === 'running') {
      const b = document.createElement('span');
      b.className = 'badge warn';
      b.textContent = 'Interrompue';
      b.style.marginLeft = '8px';
      $('small', el).appendChild(b);
    }
    $('p', el).textContent = it.segments.map((s) => s.text).join(' ').slice(0, 220) || '(vide)';
    const open = () => openDoc(it);
    el.addEventListener('click', (e) => { if (!e.target.closest('.icon-btn')) open(); });
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
    $('.icon-btn', el).onclick = async () => {
      if (state.run?.doc.id === it.id || state.doc?.id === it.id && state.phase !== 'idle') return toast('Cette transcription est en cours.', 'warn');
      const ok = await ask('Supprimer cette transcription ?', `« ${it.title} »${it.audioId ? ' et son audio seront' : ' sera'} définitivement effacé${it.audioId ? 's' : 'e'} de ce navigateur.`, 'Supprimer', { danger: true });
      if (!ok) return;
      await History.remove(it.id);
      if (it.audioId) {
        const others = (await History.list()).some((d) => d.audioId === it.audioId);
        if (!others) {
          await Audios.remove(it.audioId);
          if (state.audio?.audioId === it.audioId) clearAudio();
        }
      }
      if (state.doc?.id === it.id) clearResult();
      renderHistory();
      renderStorage();
      updateButtons();
    };
    list.appendChild(el);
  }
}

function openDoc(it) {
  if (state.phase !== 'idle' || micBusy()) return toast('Attends la fin de la transcription ou de l’enregistrement en cours.', 'warn');
  showDoc(it);
  closeDrawers();
  renderResume(it);
  // Recharge l'audio associé (réécoute, horodatages cliquables, reprise)
  if (it.audioId && state.audio?.audioId !== it.audioId) {
    const before = state.audio;
    Audios.get(it.audioId).then((rec) => {
      // Ne jamais écraser un audio choisi entre-temps par l'utilisateur
      if (rec?.blob && state.doc?.id === it.id && state.phase === 'idle' && state.audio === before && !micBusy()) setAudioFromBlob(rec.blob, rec.name, { audioId: rec.id, docId: it.id }).then(() => renderResume(state.doc));
    }).catch(() => {});
  }
}

// ======================================================================
// Récupération après fermeture ou plantage de l'onglet
// ======================================================================
async function recover() {
  let autoDoc = null;
  // 1. Enregistrement micro interrompu : on reconstitue l'audio à partir des morceaux sauvegardés.
  let act = null;
  try { act = JSON.parse(store.get('rec.active', 'null')); } catch { /* ignore */ }
  store.del('rec.active');
  if (act?.id) {
    const blob = await RecChunks.blob(act.id, act.mime).catch(() => null);
    if (blob?.size) {
      const name = `Enregistrement récupéré (${new Date(act.startedAt).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })})`;
      await Audios.put({ id: act.id, blob, name, createdAt: Date.now() });
      await RecChunks.remove(act.id);
      const doc = await History.get(act.id).catch(() => null);
      if (doc) {
        Object.assign(doc, { audioId: act.id, source: name, status: 'interrupted', stopReason: 'crash' });
        doc.job = { modelId: doc.modelId, language: doc.language, fromS: doc.liveP || 0, baseSegments: doc.segments || [], seqs: [], total: null };
        await persist(doc);
        autoDoc = doc;
      } else {
        await setAudioFromBlob(blob, name, { audioId: act.id });
        toast('Un enregistrement interrompu a été récupéré : tu peux le transcrire.', 'ok', 9000);
      }
    }
  }
  // 2. Transcriptions qui tournaient quand l'onglet s'est fermé.
  const docs = await History.list().catch(() => []);
  for (const d of docs) {
    if (d.status !== 'running' && d.status !== 'live') continue;
    if (d.status === 'live') Object.assign(d, { status: 'done', partial: true, job: null }); // audio perdu
    else Object.assign(d, { status: 'interrupted', stopReason: 'crash' });
    await persist(d);
    if (!autoDoc && d.status === 'interrupted') autoDoc = d;
  }
  if (!autoDoc) return false;
  showDoc(autoDoc);
  const rec = autoDoc.audioId ? await Audios.get(autoDoc.audioId).catch(() => null) : null;
  if (rec?.blob) await setAudioFromBlob(rec.blob, rec.name, { audioId: rec.id, docId: autoDoc.id });
  const auto = (autoDoc.autoResumes || 0) < 3;
  renderResume(autoDoc, { auto });
  toast(auto ? 'Une transcription a été interrompue : elle va reprendre automatiquement.' : 'Une transcription a été interrompue plusieurs fois : clique sur « Reprendre » quand tu veux.', 'warn', 8000);
  return true;
}

// ======================================================================
// Tiroirs
// ======================================================================
function openDrawer(id) {
  const d = $(id);
  d.classList.add('open');
  d.setAttribute('aria-hidden', 'false');
  $('.drawer-panel button, .drawer-panel input', d)?.focus();
}
function closeDrawers() {
  $$('.drawer.open').forEach((d) => { d.classList.remove('open'); d.setAttribute('aria-hidden', 'true'); });
}

// ======================================================================
// Événements
// ======================================================================
function bind() {
  $$('.seg [data-tab]').forEach((b) => (b.onclick = () => selectTab(b.dataset.tab)));
  $('#rec-main').onclick = recToggle;
  $('#rec-stop').onclick = recStop;
  $('#rec-discard').onclick = recDiscard;
  $('#rec-pause').onclick = () => { recorder.state === 'paused' ? recorder.resume() : recorder.pause(); renderRec(); };
  $('#toggle-live').checked = store.get('live', '0') === '1';
  $('#toggle-live').onchange = (e) => store.set('live', e.target.checked ? '1' : '0');

  const dz = $('#dropzone');
  $('#file-input').onchange = (e) => { handleFiles(e.target.files); e.target.value = ''; };
  ['dragenter', 'dragover'].forEach((t) => window.addEventListener(t, (e) => { e.preventDefault(); dz.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((t) => window.addEventListener(t, (e) => { e.preventDefault(); if (t === 'drop' || !e.relatedTarget) dz.classList.remove('over'); }));
  window.addEventListener('drop', (e) => handleFiles(e.dataTransfer?.files));
  $('#audio-clear').onclick = () => { clearAudio(); hideResume(); };
  $('#audio-delete').onclick = deleteRecording;

  $('#models').addEventListener('change', (e) => {
    if (e.target.name !== 'model') return;
    state.modelId = e.target.value;
    store.set('model', state.modelId);
    renderLiveHint();
    renderLangHint();
  });
  $('#models').addEventListener('click', async (e) => {
    const id = e.target.dataset?.clear;
    if (!id) return;
    e.preventDefault();
    const m = modelById(id);
    const v = pickVariant(m, caps());
    if (!(await ask('Supprimer du cache ?', `${m.name} (${fmtMB(v.sizeMB)}) devra être retéléchargé à la prochaine utilisation.`, 'Supprimer'))) return;
    await request({ type: 'cache-clear', repo: m.repo, kind: m.kind, device: v.device, dtype: v.dtype }, ['cache-cleared']).catch(() => {});
    if (state.loadedKey?.startsWith(m.repo + '|')) state.loadedKey = null;
    await refreshCache();
    toast(`${m.name} supprimé du cache.`, 'ok', 2500);
  });

  const lang = $('#lang');
  lang.innerHTML = LANGUAGES.map(([c, n]) => `<option value="${c}">${n}</option>`).join('');
  lang.value = state.language;
  lang.onchange = () => { state.language = lang.value; store.set('lang', lang.value); };

  $('#btn-transcribe').onclick = startTranscription;
  $('#btn-cancel').onclick = cancel;
  $('#btn-resume-dismiss').onclick = hideResume;

  $('#toggle-ts').checked = store.get('ts', '1') === '1';
  $('#transcript').dataset.ts = $('#toggle-ts').checked ? 'on' : 'off';
  $('#toggle-ts').onchange = (e) => { $('#transcript').dataset.ts = e.target.checked ? 'on' : 'off'; store.set('ts', e.target.checked ? '1' : '0'); };

  $('#transcript').addEventListener('input', (e) => {
    const i = e.target.dataset?.i;
    if (i == null || !state.segments[i]) return;
    // Corrigé à la main : le passage n'est plus « à vérifier »
    state.segments[i] = { ...state.segments[i], text: e.target.textContent, conf: undefined, edited: true };
    e.target.closest('.segment')?.classList.remove('low-conf');
    e.target.title = '';
    saveDoc(600);
  });
  $('#transcript').addEventListener('click', (e) => {
    const ts = e.target.closest('.ts');
    if (!ts || !state.audio) return;
    const p = $('#audio-player');
    p.currentTime = Number(ts.dataset.start);
    p.play().catch(() => {});
  });
  $('#result-title').addEventListener('input', () => saveDoc(600));

  $('#btn-copy').onclick = copyText;
  $$('[data-export]').forEach((b) => (b.onclick = () => exportAs(b.dataset.export)));
  $('#btn-relex').onclick = () => {
    state.segments = applyLexiconTo(state.segments);
    renderSegments(state.segments, {});
    saveDoc();
    toast('Lexique appliqué.', 'ok', 2000);
  };

  $('#btn-lexicon').onclick = () => { renderLexicon(); openDrawer('#drawer-lexicon'); };
  $('#btn-history').onclick = () => { renderHistory(); openDrawer('#drawer-history'); };
  $$('.drawer').forEach((d) => d.addEventListener('click', (e) => { if (e.target === d || e.target.closest('[data-close]')) closeDrawers(); }));
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    closeDrawers();
    if (!$('#modal').hidden) $('#modal-cancel').click();
    else if (!$('#tool').hidden) tool.close();
  });
  $('#lex-add').onclick = () => {
    state.lexicon.push({ from: '', to: '', enabled: true });
    saveLexicon(state.lexicon);
    renderLexicon();
    $$('#lex-list [data-k=from]').pop()?.focus();
  };
  $('#lex-reset').onclick = async () => {
    if (!(await ask('Réinitialiser le lexique ?', 'Tes termes personnalisés seront remplacés par la liste par défaut.', 'Réinitialiser'))) return;
    state.lexicon = DEFAULT_LEXICON.map((e) => ({ ...e }));
    saveLexicon(state.lexicon);
    renderLexicon();
  };
  $('#hist-clear').onclick = async () => {
    if (state.phase !== 'idle' || micBusy()) return toast('Attends la fin de la transcription ou de l’enregistrement en cours.', 'warn');
    if (!(await ask('Tout supprimer ?', 'Toutes les transcriptions et tous les audios enregistrés seront définitivement effacés de ce navigateur.', 'Tout supprimer', { danger: true }))) return;
    await clearAll();
    store.del('rec.active');
    clearAudio();
    clearResult();
    renderHistory();
    renderStorage();
    updateButtons();
  };
  window.addEventListener('beforeunload', (e) => { if (state.phase !== 'idle' || micBusy()) e.preventDefault(); });
}

// ======================================================================
// Démarrage
// ======================================================================
async function init() {
  $('#foot-version').textContent = TRANSFORMERS_VERSION;
  monitor = new Monitor($('#monitor-canvas'), { onState: renderMonitorState });
  bind();
  bindSound();
  renderRec();
  // Interface prête : désarme le filet de sécurité des mises à jour (voir index.html)
  window.__appBoot = true;
  try { sessionStorage.removeItem('boot-retry'); } catch { /* ignore */ }
  if (!window.Worker || !window.OfflineAudioContext) {
    status('Ce navigateur est trop ancien. Utilise une version récente de Chrome ou Edge.', 'err');
    return;
  }
  navigator.storage?.persist?.().catch(() => {});
  try {
    await startWorker();
    const r = await request({ type: 'detect' }, ['caps']);
    state.caps = r.caps;
  } catch (e) {
    status(e.message, 'err');
    $('#pill-engine span').textContent = 'Moteur indisponible';
    return;
  }
  renderEngine();
  renderModels();
  updateButtons();
  await refreshCache();
  if (!state.caps.webgpu) status((state.caps.softwareGpu ? 'Pas de carte graphique exploitable (GPU logiciel détecté)' : 'WebGPU non disponible') + ' : la transcription utilisera le processeur (plus lent). Le modèle « Rapide » ou « Équilibré » est conseillé.', 'warn');
  try {
    if (await recover()) return;
    const [last] = await History.list();
    if (last && !state.doc) openDoc(last);
  } catch (e) { console.warn(e); }
}

init();

// Accès de débogage / tests automatisés
window.__app = {
  state, exportAs, toTxt, toSrt, toMarkdown, signalCrash, History, Audios, RecChunks,
  recorderState: () => recorder.state,
  monitorP90: () => { const w = monitor.levels.filter((l) => l.t >= monitor.now - 6).map((l) => l.db).sort((a, b) => a - b); return w[Math.floor(w.length * 0.9)]; },
};
