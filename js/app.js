// Orchestrateur de l'interface : source audio → transcription (worker) → résultat/export.
// Nouveautés : transcription en direct, reprise automatique, suppression des enregistrements.
import { MODELS, DEFAULT_MODEL, LANGUAGES, CHUNKING, TRANSFORMERS_VERSION, SAMPLE_RATE as SR, pickVariant, lighterModel, isStreaming, LLM_MODELS } from './config.js';
import { clusterSpeakers, buildTimeline, assignSpeakers, orderSpeakers, speakingTime, speakerColor, defaultSpeakerName } from './speakers.js';
import { decodeToMono16k, isAcceptedFile, Recorder, DEFAULT_AUDIO_SETTINGS, listMicrophones, listSpeakers, canPickOutput, isBluetooth, canCaptureSystem, speechStart, LevelBooster } from './audio.js';
import { loadLexicon, saveLexicon, compileLexicon, applyLexicon, DEFAULT_LEXICON } from './lexicon.js';
import { toTxt, toMarkdown, toSrt, download, fmtClock, safeFilename } from './exporters.js';
import { History, Audios, RecChunks, newId } from './history.js';
import { Auth, Sync, Folders, redirectUri } from './cloud.js';
import { LiveSession, VoxtralLive } from './live.js';
import { Monitor, CONF } from './monitor.js';
import { SUMMARY_TYPES, buildPrompt, claudeUrl, CLAUDE_NEW } from './claude-export.js';
import { Player, segmentAt } from './player.js';
import { describeEngine, createTranslator, localCached, localPlan, chromeAvailability } from './translate.js';
import { guessLang } from './langid.js';
import { VoiceBook, centroids, matchVoices, packEmb } from './voices.js';
import { extractActions, actionsToMarkdown } from './actions.js';
import { dashStats, dailyMinutes, weeklyMinutes, speakerTotals, topicShares, periodStart, searchMeetings } from './insights.js';
import { buildContext, buildMessages, renderAnswer, citedRefs } from './assistant.js';
import { Spaces, spacesError } from './spaces.js';
import { encodeOggOpus, canEncodeOpus } from './opus-ogg.js';
import { ACCENTS, accentVars, BACKGROUNDS, DEFAULTS as PERSO_DEFAULTS, loadPerso, savePerso, applyPerso, customImage, shrinkImage, saveCustomImage } from './perso.js';
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
  language: store.get('lang', 'auto'),
  autoTr: store.get('autotr', '1') === '1', // traduire automatiquement en français
  voiceId: store.get('voiceid', '1') === '1', // reconnaître les voix déjà nommées (carnet de voix)
  autoSpk: store.get('autospk', '1') === '1', // identifier qui parle après chaque transcription
  editMode: store.get('edit', '1') === '1', // texte modifiable directement
  autoTune: store.get('auto', '1') === '1', // réglage automatique (son + modèle) avant chaque enregistrement
  page: 'home', // vue affichée (accueil, document, projets, paramètres)
  dtab: 'tr', // onglet du document
  capture: ['mic', 'mix', 'system'].includes(store.get('capture', 'mic')) ? store.get('capture', 'mic') : 'mic', // ce qu'on enregistre
  view: store.get('view', 'tr'), // texte affiché quand une traduction existe : orig | tr | both
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
  renderModelPick();
  renderLangHint();
  renderLiveHint();
  if (state.page === 'models') renderModelsPage();
}

/** Ligne résumée du modèle choisi (le détail s'ouvre au clic). */
function renderModelPick() {
  const m = modelById(state.modelId);
  const v = state.caps ? pickVariant(m, caps()) : m.variants.webgpu;
  $('#pk-label').textContent = m.label;
  $('#pk-name').textContent = m.name;
  const size = v ? fmtMB(v.sizeMB) : '';
  $('#pk-sub').textContent = !state.caps ? 'Détection du matériel…'
    : !v ? 'Indisponible sur ce PC'
    : state.cache[m.id] ? `Prêt · ${size} en cache` : `À télécharger · ${size}`;
}

function renderLangHint() {
  const m = modelById(state.modelId);
  const el = $('#lang-hint');
  if (el) el.hidden = !isStreaming(m);
}

function renderLiveHint() {
  const el = $('#live-hint');
  const m = modelById(state.modelId);
  // Sans carte graphique, l'avertissement général (sous « Transcrire ») suffit
  el.className = 'live-hint warn';
  el.textContent = isStreaming(m) && state.caps && !caps().webgpu ? 'Voxtral a besoin d’une carte graphique pour suivre en direct.' : '';
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
    player.load(state.audio.url, pcm, durationS);
    status(durationS > 7200 ? 'Audio très long : la transcription peut prendre beaucoup de temps et de mémoire.' : '', durationS > 7200 ? 'warn' : '');
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
  player.clear();
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
  const rec = await getAudio(doc.audioId);
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
let player = null; // lecteur audio du résultat (créé au démarrage)

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
    $('#rb-time').textContent = fmtClock(s);
    if (state.live) renderRecState();
  },
  // Chaque seconde, le morceau compressé est sauvegardé : rien n'est perdu si l'onglet plante.
  onChunk(blob, idx) {
    const r = state.rec;
    if (!r) return;
    r.pending = r.pending.then(() => RecChunks.add(r.id, idx, blob)).catch(() => {});
  },
  // Voxtral : voix faibles remontées pour le modèle ; l'enregistrement, lui, reste intact.
  onPcm(pcm) { if (state.live) state.live.push(state.booster ? state.booster.process(pcm) : pcm); },
  // Casque Bluetooth éteint ou hors de portée pendant l'enregistrement
  onDeviceLost(label, kind) {
    if (kind === 'system') {
      if (!recorder.stream) toast('Partage arrêté : le son de la visio n’arrive plus. Arrête l’enregistrement (ce qui précède est conservé).', 'err', 12000);
      else toast('Partage arrêté : seul ton micro est encore enregistré.', 'warn', 8000);
      return;
    }
    const name = label ? `« ${label} »` : 'Le micro';
    if (micBusy()) toast(`${name} s’est déconnecté : l’enregistrement n’entend plus rien. Arrête-le (ce qui précède est conservé), puis relance avec un autre micro.`, 'err', 12000);
    else if (recorder.state === 'preview') { stopMicTest(); toast(`${name} s’est déconnecté.`, 'warn', 5000); }
  },
});

/** Prévient si le micro choisi était absent et que le micro par défaut a pris le relais. */
function warnFallback() {
  if (!recorder.fellBack) return;
  const name = sound.deviceLabel ? `« ${sound.deviceLabel} »` : 'Le micro choisi';
  toast(`${name} est introuvable (débranché ou éteint ?) : le micro par défaut est utilisé${recorder.deviceLabel ? ` (${recorder.deviceLabel})` : ''}.`, 'warn', 8000);
}

async function recToggle() {
  if (!micBusy()) await recStart();
  else await recStop();
}

async function recStart() {
  if (state.phase !== 'idle') return toast('Attends la fin de la transcription en cours.', 'warn');
  if (state.autoTune && !(await autoSetup())) return;
  const live = !!state.caps; // la transcription en direct est toujours active
  if (live && !(await confirmBigDownload(modelById(state.modelId)))) return;
  stopMicTest();
  try {
    await recorder.start({ pcm: live, settings: sound, capture: captureMode() });
  } catch (e) {
    status(e.message, 'err');
    toast(e.message, 'err', 7000);
    return;
  }
  warnFallback();
  startAutoGain();
  const rec = { id: newId(), live, mime: recorder.mimeType, startedAt: Date.now(), pending: Promise.resolve() };
  state.rec = rec;
  monitor?.start();
  refreshDevices();
  store.set('rec.active', JSON.stringify({ id: rec.id, live, mime: rec.mime, startedAt: rec.startedAt }));
  clearAudio();
  hideResume();
  // Amplification réservée à Voxtral (sensible au volume absolu). Whisper normalise lui-même chaque bloc.
  state.booster = live && isStreaming(modelById(state.modelId)) ? new LevelBooster() : null;
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
  liveTranslate(s);
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
      carryTranslations(finalSegs, s.committed);
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
  if (s !== 'idle' && recorder.capturingSystem) text = text.replace('Enregistrement', recorder.stream ? 'Enregistrement voix + visio' : 'Enregistrement de la visio');
  else if (s === 'idle' && captureMode() !== 'mic') text = captureMode() === 'mix' ? 'Prêt : ta voix + la visio' : 'Prêt : son de la visio';
  const l = state.live;
  if (l && s !== 'idle') {
    if (l.failed) text += ' · direct interrompu';
    else if (!l.ready) text += ' · chargement du modèle…';
    else text += l.lagS > 8 ? ` · direct (retard ≈ ${Math.round(l.lagS)} s)` : ' · direct';
  }
  $('#rec-state').textContent = text;
}

// ======================================================================
// Ce qu'on enregistre : ma voix, ma voix + la visio, ou la visio seule
// ======================================================================
const captureMode = () => (canCaptureSystem() ? state.capture : 'mic');

function renderCapture() {
  const m = captureMode();
  $('#capture-row').hidden = !canCaptureSystem();
  $$('#capture-seg button').forEach((b) => {
    b.setAttribute('aria-selected', String(b.dataset.capture === m));
    b.disabled = micBusy();
  });
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
  $('#rec-pause span').textContent = s === 'paused' ? 'Reprendre' : 'Pause';
  if (s === 'idle') $('#rec-time').textContent = '00:00';
  $('#step-source').dataset.rec = s;
  const bar = $('#rec-bar');
  bar.hidden = s === 'idle';
  bar.classList.toggle('paused', s === 'paused');
  $('#rb-state').textContent = s === 'paused' ? 'En pause' : 'Enregistrement en cours';
  $('#rb-pause span').textContent = s === 'paused' ? 'Reprendre' : 'Pause';
  if (s === 'idle') $('#rb-time').textContent = '00:00';
  renderCapture();
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
  doc.updatedAt = Date.now();
  const u = Auth.user();
  if (u && !doc.owner) doc.owner = u.email; // créée avec un compte : rangée dans ce compte
  try { await History.put(structuredClone(doc)); } catch (e) { console.warn('Historique indisponible', e); }
  scheduleHistory();
  if (doc.status !== 'running' && doc.status !== 'live') Sync.schedule();
}

/** Transcriptions du compte connecté (ou, sans compte, celles faites sans compte). */
const isMine = (d) => (Auth.user() ? d.owner === Auth.user().email : !d.owner);

/** Audio d'une transcription : dans ce navigateur, sinon récupéré du Google Drive. */
async function getAudio(id) {
  if (!id) return null;
  const a = await Audios.get(id).catch(() => null);
  if (a?.blob) return a;
  if (!Sync.enabled()) return null;
  status('Récupération de l’audio depuis Google Drive…');
  const r = await Sync.pullAudio(id).catch(() => null);
  status('');
  return r;
}

let histTimer = 0;
function scheduleHistory() {
  clearTimeout(histTimer);
  histTimer = setTimeout(renderHistory, 800);
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
  return speechStart(pcm, Math.round(fromS * SR), pcm.length) / SR;
}

function stopByUser(doc) {
  doc.status = 'interrupted';
  doc.stopReason = 'user';
  toast('Transcription arrêtée. Le texte obtenu est conservé ; « Reprendre » continue là où elle s’est arrêtée.', 'warn', 7000);
}

function finalizeDoc(doc, newSegments) {
  doc.segments = applyLexiconTo([...doc.job.baseSegments, ...newSegments]);
  delete doc.speakers; // nouveau texte : intervenants à recalculer
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
  autoTranslate(doc);
  if (state.autoSpk && doc.segments.length) identifySpeakers(doc);
  if (doc.segments.length) notify({ kind: 'ok', title: 'Transcription terminée', text: `« ${doc.title} »${doc.durationS ? ` · ${fmtClock(doc.durationS)}` : ''}`, docId: doc.id, system: true });
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
const applyLexiconTo = (segs) => { const r = lexRules(); return segs.map((s) => (s.lang && s.lang !== 'fr' ? s : { ...s, text: applyLexicon(s.text, r) })); };

function showDoc(doc, { editable = true } = {}) {
  state.doc = doc;
  state.segments = doc.segments || [];
  $('#result-title').value = doc.title;
  renderMeta();
  renderSegments(state.segments, { editable });
  renderSpeakers();
  renderSummary();
  renderDocFolder();
  setView('doc');
}

function clearResult() {
  state.doc = null;
  state.segments = [];
  $('#result-title').value = '';
  renderMeta();
  showWaiting(false);
  renderSegments([], {});
  renderSpeakers();
  renderSummary();
  renderDocFolder();
  hideResume();
  if (state.page === 'doc') setView('home');
}

/** Icônes des pastilles d'infos (traits, 24×24). */
const META_ICONS = {
  date: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>',
  audio: '<path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2"/>',
  words: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  model: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  time: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2M10 2h4"/>',
  lang: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  conf: '<path d="M20 6 9 17l-5-5"/>',
  check: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
};

function metaChip(icon, text, { title = '', cls = '', dev = '' } = {}) {
  const extra = dev ? `<span class="dev"> · ${esc(dev)}</span>` : '';
  return `<span class="mchip${cls ? ` ${cls}` : ''}"${title ? ` title="${esc(title)}"` : ''}><svg viewBox="0 0 24 24">${META_ICONS[icon]}</svg>${esc(text)}${extra}</span>`;
}

function renderMeta() {
  const d = state.doc;
  const el = $('#result-meta');
  if (!d) { el.innerHTML = ''; return renderInsights(); }
  const words = state.segments.reduce((n, s) => n + (s.text.match(/\S+/g)?.length || 0), 0);
  const created = new Date(d.createdAt);
  const chips = [];
  const st = d.status === 'live' ? ['live', 'En direct'] : d.status === 'interrupted' ? ['warn', 'Interrompue'] : d.partial ? ['warn', 'Partielle'] : null;
  if (st) chips.push(`<span class="mchip badge-${st[0]}">${st[1]}</span>`);
  const day = created.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  const hour = created.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  chips.push(metaChip('date', `${day} · ${hour}`,
    { title: created.toLocaleString('fr-FR', { dateStyle: 'full', timeStyle: 'short' }) }));
  if (d.durationS) chips.push(metaChip('audio', fmtClock(d.durationS), { title: 'Durée de l’audio' }));
  chips.push(metaChip('words', `${words} mot${words > 1 ? 's' : ''}`));
  const langs = langSummary(state.segments);
  const mainLang = d.language && d.language !== 'auto' ? d.language : 'fr';
  chips.push(metaChip('lang', langs ? langs.replace(/^./, (c) => c.toUpperCase()) : `Langue : ${langName(mainLang)}`, { title: langs ? 'Langues détectées' : 'Langue' }));
  if (d.model) {
    const dev = d.device === 'webgpu' ? 'GPU' : d.device ? 'CPU' : '';
    chips.push(metaChip('model', d.model.replace(/^Whisper /, ''), { cls: 'model', dev,
      title: `${d.model}${d.device ? ` (${d.device === 'webgpu' ? 'carte graphique, WebGPU' : 'processeur, WASM'})` : ''}${d.processingS ? ` · transcrit en ${fmtDuration(d.processingS)}` : ''}` }));
  }
  const withC = state.segments.filter((x) => x.conf != null);
  if (withC.length) {
    const avg = withC.reduce((a, x) => a + x.conf, 0) / withC.length;
    const level = avg >= CONF.good ? 'ok' : avg >= CONF.fair ? 'warn' : 'err';
    chips.push(`<span class="mchip conf conf-${level}" title="Confiance moyenne du modèle dans ce qu’il a écrit" style="--p:${Math.round(avg * 100)}%"><svg viewBox="0 0 24 24">${META_ICONS.conf}</svg>Confiance ${Math.round(avg * 100)} %<i class="meter"></i></span>`);
    const low = withC.filter((x) => x.conf < CONF.fair).length;
    if (low) chips.push(metaChip('check', `${low} à vérifier`, { cls: 'tocheck', title: 'Aller au passage suivant à vérifier (souligné dans le texte)' }));
  }
  el.innerHTML = chips.join('');
  renderInsights();
  if (state.dtab === 'analysis') renderAnalysis();
}

function langSummary(segs) {
  const n = {};
  for (const s of segs) if (s.lang) n[s.lang] = (n[s.lang] || 0) + 1;
  const langs = Object.keys(n).sort((a, b) => n[b] - n[a]);
  if (!langs.length || (langs.length === 1 && langs[0] === 'fr')) return null;
  return langs.map((l) => langName(l).toLowerCase()).join(' + ');
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
  $('#out-device').value = sound.outputId;
  if ($('#out-device').value !== sound.outputId) $('#out-device').value = '';
  renderBtHint();
  renderSoundSummary();
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
    hint.textContent = 'Pendant l’enregistrement, seuls le gain et le filtre des basses sont modifiables.';
  } else if (sound.autoGainControl && sound.gainDb !== 0) {
    hint.className = 'sc-hint warn';
    hint.textContent = 'Le gain automatique compense en partie ton réglage : coupe-le pour un contrôle total.';
  } else {
    hint.className = 'sc-hint';
    hint.textContent = testing ? 'Règle le gain pour que la courbe reste dans la zone verte.' : '';
  }
}

function renderSoundSummary() {
  const sel = $('#mic-device');
  const name = sel.selectedOptions[0]?.textContent || 'Micro par défaut';
  $('#sound-sum').textContent = `${name.length > 28 ? name.slice(0, 27) + '…' : name} · gain ${fmtGain(sound.gainDb)}`;
  const chips = [['Gain auto', sound.autoGainControl], ['Anti-bruit', sound.noiseSuppression], ['Anti-écho', sound.echoCancellation], ['Filtre basses', sound.highpass]];
  $('#sound-chips').innerHTML = chips.map(([l, on]) => `<span class="chip${on ? '' : ' off'}">${l}</span>`).join('');
}

/**
 * Options d'une liste d'appareils : « Par défaut (nom réel) », puis chaque appareil.
 * Un appareil choisi mais absent reste affiché « non connecté » : le choix est gardé pour son retour.
 */
function deviceOptions(list, kind, chosenId, chosenLabel) {
  const def = list.find((d) => d.deviceId === 'default');
  const defName = def?.label?.replace(/^(par défaut|default)\s*[-–:]\s*/i, '');
  const word = kind === 'in' ? 'Micro' : 'Sortie';
  const real = list.filter((d) => d.deviceId && d.deviceId !== 'default');
  const opts = [new Option(defName ? `Par défaut (${defName})` : `${word} par défaut`, '')];
  real.forEach((d, i) => opts.push(new Option(d.label || `${word} ${i + 1}`, d.deviceId)));
  if (chosenId && !real.some((d) => d.deviceId === chosenId)) opts.push(new Option(`${chosenLabel || word + ' choisi'} — non connecté`, chosenId));
  return { real, opts };
}

/** Windows peut changer l'identifiant d'un casque : on le retrouve par son nom. */
function relink(real, idKey, labelKey) {
  if (!sound[idKey] || real.some((d) => d.deviceId === sound[idKey])) return false;
  const same = sound[labelKey] && real.find((d) => d.label === sound[labelKey]);
  if (!same) return false;
  sound[idKey] = same.deviceId;
  return true;
}

let knownDevices = null;
async function refreshDevices(fromEvent = false) {
  const mics = await listMicrophones();
  const outs = await listSpeakers();
  const realIn = mics.filter((d) => d.deviceId && d.deviceId !== 'default');
  const realOut = outs.filter((d) => d.deviceId && d.deviceId !== 'default');
  const changed = relink(realIn, 'deviceId', 'deviceLabel') | relink(realOut, 'outputId', 'outputLabel');
  if (changed) saveSound();
  $('#mic-device').replaceChildren(...deviceOptions(mics, 'in', sound.deviceId, sound.deviceLabel).opts);
  $('#out-device').replaceChildren(...deviceOptions(outs, 'out', sound.outputId, sound.outputLabel).opts);
  $('#out-row').hidden = !canPickOutput();
  // Annonce discrète d'un casque qui vient d'être connecté
  const ids = new Set([...realIn, ...realOut].map((d) => d.deviceId));
  if (fromEvent && knownDevices?.size) {
    const fresh = [...realIn, ...realOut].filter((d) => !knownDevices.has(d.deviceId) && d.label);
    const names = [...new Set(fresh.map((d) => d.label))];
    if (names.length) toast(`Appareil connecté : ${names[0]}. Choisis-le dans « Réglages du son » si tu veux l’utiliser.`, 'ok', 5000);
  }
  knownDevices = ids;
  await applyOutput(false);
  renderSound();
}

/** Envoie la relecture vers la sortie choisie (casque, haut-parleurs). */
async function applyOutput(loud = true) {
  if (!canPickOutput()) return;
  const el = $('#audio-player');
  const id = $('#out-device').value === sound.outputId ? sound.outputId : '';
  if (el.sinkId === id) return;
  try {
    await el.setSinkId(id);
  } catch (e) {
    if (loud) toast(`Impossible d’utiliser cette sortie : ${e.message || e.name}`, 'err', 6000);
  }
}

/** Conseil Bluetooth : le micro d'un casque sans fil dégrade le son (profil « mains libres »). */
function renderBtHint() {
  const sel = $('#mic-device');
  const label = sel.selectedOptions[0]?.textContent || '';
  $('#bt-hint').hidden = !isBluetooth(label);
}

/** Petit carillon joué sur la sortie choisie. */
let chimeUrl = null;
async function testOutput() {
  if (!chimeUrl) {
    const rate = 22050;
    const n = Math.round(rate * 0.7);
    const buf = new ArrayBuffer(44 + n * 2);
    const v = new DataView(buf);
    const str = (o, t) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVEfmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) {
      const t = i / rate;
      const f = t < 0.25 ? 660 : 880;
      const local = t < 0.25 ? t : t - 0.25;
      const env = Math.min(1, local * 80) * Math.exp(-local * 6);
      v.setInt16(44 + i * 2, Math.sin(2 * Math.PI * f * t) * env * 0.35 * 32767, true);
    }
    chimeUrl = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  }
  const a = new Audio(chimeUrl);
  try {
    if (sound.outputId && canPickOutput()) await a.setSinkId(sound.outputId);
    await a.play();
  } catch (e) {
    toast(`Lecture impossible sur cette sortie : ${e.message || e.name}`, 'err', 6000);
  }
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
  warnFallback();
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
  // Modification à la main : pendant un enregistrement, le gain auto s'arrête ;
  // sinon, le réglage automatique du son se désactive pour garder ton choix.
  const manual = (e) => {
    if (!e.isTrusted || !state.autoTune) return;
    if (micBusy()) { liveGain.locked = true; return; }
    if (recorder.state === 'preview') return;
    setAutoTune(false, 'Réglage automatique désactivé : tes réglages manuels sont gardés.');
  };
  ['#gain', '#opt-agc', '#opt-ns', '#opt-ec', '#opt-hp'].forEach((id) => $(id).addEventListener(id === '#gain' ? 'input' : 'change', manual));
  $('#gain').addEventListener('input', (e) => applySound('gainDb', Number(e.target.value)));
  $('#opt-agc').onchange = (e) => applySound('autoGainControl', e.target.checked);
  $('#opt-ns').onchange = (e) => applySound('noiseSuppression', e.target.checked);
  $('#opt-ec').onchange = (e) => applySound('echoCancellation', e.target.checked);
  $('#opt-hp').onchange = (e) => applySound('highpass', e.target.checked);
  $('#mic-device').onchange = (e) => {
    sound.deviceLabel = e.target.value ? e.target.selectedOptions[0].textContent.replace(/ — non connecté$/, '') : '';
    applySound('deviceId', e.target.value);
  };
  $('#out-device').onchange = async (e) => {
    sound.outputId = e.target.value;
    sound.outputLabel = e.target.value ? e.target.selectedOptions[0].textContent.replace(/ — non connecté$/, '') : '';
    saveSound();
    await applyOutput();
    renderSound();
  };
  $('#out-test').onclick = testOutput;
  $('#mic-test').onclick = () => (recorder.state === 'preview' ? stopMicTest() : startMicTest());
  $('#gain-auto').onclick = autoGain;
  $('#preset-laptop').onclick = applyLaptopPreset;
  $('#tool-diag').onclick = runDiagnostic;
  $('#tool-calib').onclick = runCalibration;
  $('#tool-close').onclick = () => tool.close();
  $('#sound-reset').onclick = async () => {
    Object.assign(sound, DEFAULT_AUDIO_SETTINGS);
    saveSound();
    applyOutput(false);
    recorder.setGain(0);
    recorder.setHighpass(false);
    if (recorder.state === 'preview') { stopMicTest(); await startMicTest(); }
    renderSound();
    toast('Réglages du son par défaut rétablis.', 'ok', 2500);
  };
  navigator.mediaDevices?.addEventListener?.('devicechange', () => refreshDevices(true));
  refreshDevices();
}

// ======================================================================
// Centre de notifications (cloche) : événements importants, notifications Windows en option
// ======================================================================
const NOTIF_MAX = 30;
const notifs = {
  list() { try { return JSON.parse(store.get('notifs', '[]')); } catch { return []; } },
  save(l) { store.set('notifs', JSON.stringify(l.slice(0, NOTIF_MAX))); },
};

/**
 * Ajoute une notification.
 * system : aussi une notification Windows si l'onglet est en arrière-plan (et si autorisé).
 * docId : un clic ouvre la transcription ; action 'account' : ouvre le compte.
 */
function notify({ kind = 'ok', title, text = '', docId = null, action = null, system = false }) {
  const n = { id: newId(), at: Date.now(), kind, title, text, docId, action, read: false };
  notifs.save([n, ...notifs.list()]);
  renderBell();
  if (system && document.hidden && store.get('notifs.system') === '1' && 'Notification' in window && Notification.permission === 'granted') {
    try {
      const sys = new Notification(title, { body: text, icon: 'icons/icon-192.png', tag: n.id });
      sys.onclick = () => { window.focus(); openNotif(n); sys.close(); };
    } catch { /* ignore */ }
  }
}

function ago(t) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'à l’instant';
  if (s < 3600) return `il y a ${Math.round(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.round(s / 3600)} h`;
  return new Date(t).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
}

function renderBell() {
  const l = notifs.list();
  const unread = l.filter((n) => !n.read).length;
  const bell = $('#btn-bell');
  bell.classList.toggle('has-new', unread > 0);
  bell.setAttribute('aria-label', unread ? `Notifications (${unread} nouvelle${unread > 1 ? 's' : ''})` : 'Notifications');
  $('#bell-count').textContent = unread > 9 ? '9+' : unread || '';
  const box = $('#notif-list');
  if (!l.length) { box.innerHTML = '<p class="notif-empty">Rien de nouveau. Tu seras prévenu ici quand une transcription, une traduction ou une synchronisation se termine.</p>'; return; }
  box.innerHTML = l.map((n) => `<button type="button" class="notif ${n.read ? '' : 'unread'} n-${n.kind}" data-id="${n.id}"><i></i><span><b>${esc2(n.title)}</b><small>${esc2(n.text)}</small></span><time>${ago(n.at)}</time></button>`).join('');
  const sysOk = 'Notification' in window;
  $('#notif-system').hidden = !sysOk;
  $('#notif-system-input').checked = sysOk && store.get('notifs.system') === '1' && Notification.permission === 'granted';
}

async function openNotif(n) {
  $('#notif-panel').hidden = true;
  if (n.action === 'account') return setView('settings');
  if (!n.docId) return;
  const d = await History.get(n.docId).catch(() => null);
  if (!d || !isMine(d)) return toast('Cette transcription n’existe plus.', 'warn', 3000);
  openDoc(d);
}

function bindBell() {
  const panel = $('#notif-panel');
  $('#btn-bell').onclick = (e) => {
    e.stopPropagation();
    panel.hidden = !panel.hidden;
    if (!panel.hidden) {
      renderBell();
      // Ouvrir le panneau = tout est vu (la pastille disparaît, les nouveautés restent surlignées)
      setTimeout(() => { notifs.save(notifs.list().map((n) => ({ ...n, read: true }))); $('#btn-bell').classList.remove('has-new'); $('#bell-count').textContent = ''; }, 300);
    }
  };
  document.addEventListener('click', (e) => { if (!e.target.closest('#notif-panel, #btn-bell')) panel.hidden = true; });
  $('#notif-list').addEventListener('click', (e) => {
    const b = e.target.closest('.notif');
    if (!b) return;
    const n = notifs.list().find((x) => x.id === b.dataset.id);
    if (n) openNotif(n);
  });
  $('#notif-clear').onclick = () => { notifs.save([]); renderBell(); };
  $('#notif-system-input').onchange = async (e) => {
    if (!e.target.checked) { store.set('notifs.system', '0'); return; }
    const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission().catch(() => 'denied');
    if (perm === 'granted') {
      store.set('notifs.system', '1');
      toast('Tu seras prévenu par Windows quand une transcription se termine en arrière-plan.', 'ok', 4000);
    } else {
      e.target.checked = false;
      toast('Notifications refusées par le navigateur : autorise-les dans la barre d’adresse (icône cadenas) pour activer l’option.', 'warn', 7000);
    }
  };
  setInterval(() => { if (!panel.hidden) renderBell(); }, 60 * 1000);
  renderBell();
}

// ======================================================================
// Réglage automatique : diagnostic du PC et du son avant l'enregistrement
// ======================================================================
const AUTO_TTL = 60 * 60 * 1000; // un diagnostic du son reste valable 1 h pour le même micro
const LAPTOP_MIC = /array|réseau de micro|intégr|internal|built-?in|realtek|conexant|smart sound|intel/i;
const HEADPHONES = /casque|headphone|headset|écouteur|earbud|airpods|buds|bluetooth|hands-?free|mains libres/i;

/** Modèle conseillé pour transcrire en direct sur ce PC. */
function autoModelFor(c = caps()) {
  const mem = c.memoryGB ?? 8;
  if (c.webgpu && mem >= 4) return { id: 'small', why: 'carte graphique disponible' };
  return { id: 'base', why: c.webgpu ? 'mémoire limitée' : 'pas de carte graphique' };
}

/** Réglages du son selon la pièce et le matériel. */
function autoSoundFrom({ noise, label, outLabel }) {
  const bt = isBluetooth(label);
  const laptop = !bt && LAPTOP_MIC.test(label || '');
  const headphones = HEADPHONES.test(outLabel || '') || bt;
  const noisy = noise > -58;
  const quiet = noise < -72;
  const settings = {
    autoGainControl: true,
    noiseSuppression: noisy || laptop || bt || !quiet,
    echoCancellation: !headphones,
    highpass: laptop || noisy,
    gainDb: 0,
  };
  const micKind = bt ? 'micro Bluetooth' : laptop ? 'micro du PC' : label ? 'micro externe' : 'micro';
  const room = quiet ? 'pièce calme' : noisy ? 'pièce bruyante' : 'bruit léger';
  return { settings, micKind, room, headphones };
}

const AI_ICONS = {
  mic: '<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
  bt: '<svg viewBox="0 0 24 24"><path d="m7 7 10 10-5 5V2l5 5L7 17"/></svg>',
  chip: '<svg viewBox="0 0 24 24"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="m5 12 5 5 9-10"/></svg>',
};
const aiChip = (cls, icon, html, title = '') => `<span class="ai-chip ${cls}"${title ? ` title="${title}"` : ''}>${icon}${html}</span>`;

function renderAutoInfo() {
  const el = $('#auto-info');
  $('#toggle-auto').checked = state.autoTune;
  $('#auto-redo').hidden = !state.autoTune;
  const m = modelById(state.modelId);
  const manualModel = store.get('model.manual') === '1';
  const model = aiChip('model', AI_ICONS.chip, `${m.label}<em>${manualModel ? 'ton choix' : 'auto'}</em>`, 'Modèle de transcription');
  if (!state.autoTune) { el.innerHTML = `<span class="ai-note">Réglages manuels du son</span>${model}`; return; }
  let last = null;
  try { last = JSON.parse(store.get('auto.last', 'null')); } catch { /* ignore */ }
  if (!last) { el.innerHTML = `<span class="ai-note">3 s de diagnostic au premier enregistrement</span>${model}`; return; }
  const r = last.res, st = r.settings;
  const kind = r.micKind[0].toUpperCase() + r.micKind.slice(1);
  const lvl = r.room === 'pièce calme' ? 1 : r.room === 'pièce bruyante' ? 3 : 2;
  const bars = `<i class="ai-bars l${lvl}"><b></b><b></b><b></b></i>`;
  const db = String(Math.round(last.noise)).replace('-', '−');
  const filters = [st.noiseSuppression && 'Anti-bruit', st.echoCancellation && 'Anti-écho', st.highpass && 'Coupe-bas'].filter(Boolean);
  el.innerHTML =
    aiChip('mic', /bluetooth/i.test(r.micKind) ? AI_ICONS.bt : AI_ICONS.mic, kind, 'Micro détecté') +
    aiChip(`noise l${lvl}`, bars, `${db} dB`, `Bruit de fond : ${r.room}`) +
    model +
    (filters.length ? aiChip('filter', AI_ICONS.check, filters.join('<s>·</s>'), 'Filtres activés') : aiChip('filter off', '', 'Son brut'));
}

function setAutoTune(on, msg = '') {
  state.autoTune = on;
  store.set('auto', on ? '1' : '0');
  if (on) store.del('model.manual');
  renderAutoInfo();
  if (msg) toast(msg, 'ok', 5000);
}

/**
 * Avant l'enregistrement : choisit le modèle, puis mesure le bruit de fond (3 s) pour régler le son.
 * Renvoie false si l'utilisateur annule.
 */
async function autoSetup({ force = false } = {}) {
  // 1. Modèle (instantané)
  if (state.caps && store.get('model.manual') !== '1') {
    const pick = autoModelFor();
    if (pick.id !== state.modelId && pickVariant(modelById(pick.id), caps())) {
      state.modelId = pick.id;
      store.set('model', pick.id);
      renderModelPick();
      renderLiveHint();
      renderLangHint();
    }
  }
  // 2. Son : diagnostic récent pour ce micro → réutilisé, l'enregistrement démarre tout de suite
  const key = sound.deviceId || 'default';
  let last = null;
  try { last = JSON.parse(store.get('auto.last', 'null')); } catch { /* ignore */ }
  if (!force && last && last.key === key && Date.now() - last.at < AUTO_TTL) {
    applyAutoSound(last.res.settings);
    renderAutoInfo();
    return true;
  }
  stopMicTest();
  tool.open('Réglage automatique');
  try {
    await recorder.start({ preview: true, settings: { ...sound, noiseSuppression: false, autoGainControl: false, echoCancellation: false, highpass: false, gainDb: 0 } });
    monitor.start();
    const t0 = monitor.now;
    const r = await tool.show({
      step: 'Diagnostic du son',
      meter: true,
      timeout: 3,
      html: `<p class="tool-big">Silence 3 secondes…</p><p>On mesure le bruit de ta pièce et ton micro pour tout régler automatiquement. Ne parle pas, ne touche pas au clavier.</p>`,
      actions: [{ label: 'Annuler', value: null }, { label: 'Démarrer sans attendre', value: 'go', primary: true }],
    });
    const levels = monitor.levels.filter((l) => l.t >= t0 + 0.3).map((l) => l.db).sort((a, b) => a - b);
    const label = recorder.deviceLabel || '';
    toolCleanup();
    tool.close();
    if (r === null) return false; // annulé
    const outLabel = $('#out-device').selectedOptions[0]?.textContent || '';
    if (levels.length >= 15) {
      const noise = levels[Math.floor(levels.length * 0.2)];
      const res = autoSoundFrom({ noise, label, outLabel });
      store.set('auto.last', JSON.stringify({ key, at: Date.now(), noise, res }));
      applyAutoSound(res.settings);
      const on = [res.settings.noiseSuppression && 'anti-bruit', res.settings.echoCancellation && 'anti-écho', res.settings.highpass && 'filtre des basses'].filter(Boolean);
      toast(`Réglé : ${res.micKind}, ${res.room}${on.length ? ` · ${on.join(', ')}` : ''} · modèle ${modelById(state.modelId).label}.`, 'ok', 5000);
    } else if (last?.res) {
      applyAutoSound(last.res.settings); // mesure trop courte : on garde le dernier réglage
    }
    renderAutoInfo();
    return true;
  } catch (e) {
    toolCleanup();
    tool.close();
    toast(e.message, 'err', 7000);
    return false;
  }
}

function applyAutoSound(settings) {
  Object.assign(sound, settings);
  saveSound();
  renderSound();
}

/** Pendant l'enregistrement : corrige le gain si la voix est trop faible ou sature. */
const liveGain = { timer: 0, locked: false, told: false };
function startAutoGain() {
  clearInterval(liveGain.timer);
  liveGain.locked = false;
  if (!state.autoTune) return;
  liveGain.timer = setInterval(() => {
    if (!micBusy()) return clearInterval(liveGain.timer);
    if (liveGain.locked || recorder.state !== 'recording') return;
    const d = monitor.gainAdvice();
    if (d == null || (d < 5 && d > -4)) return;
    const next = Math.max(-12, Math.min(18, Math.round(sound.gainDb + Math.max(-6, Math.min(6, d)))));
    if (next === sound.gainDb) return;
    applySound('gainDb', next);
    if (!liveGain.told) { liveGain.told = true; toast(`Gain ajusté automatiquement (${fmtGain(next)}).`, 'ok', 3000); }
  }, 5000);
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
  if (monitor?.replaying) {
    set('#vol-state', volume, '—');
    set('#conf-state', conf, '—');
    const el = $('#monitor-hint');
    el.className = 'monitor-hint';
    el.textContent = '';
    return;
  }
  set('#vol-state', volume, recorder.state === 'idle' ? '—' : 'Mesure…');
  set('#conf-state', conf, recorder.state === 'idle' ? '—' : testing ? 'Test du micro (pas de transcription)' : state.live ? 'En attente du modèle…' : 'Mode direct désactivé');
  const hint = (volume?.level === 'err' && volume.hint) || (conf?.level === 'err' && conf.hint) || volume?.hint || conf?.hint;
  const el = $('#monitor-hint');
  el.className = 'monitor-hint' + (hint ? ' warn' : '');
  el.textContent = hint || (testing ? (volume?.level === 'ok' ? 'Bon niveau : tu peux lancer l’enregistrement.' : 'Parle normalement pour vérifier le niveau.') : '');
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
  const people = state.doc?.speakers;
  const multi = editable && people?.length > 1;
  segs.forEach((s, i) => {
    let row = rows[i];
    if (!row) {
      row = document.createElement('div');
      row.className = 'segment';
      row.innerHTML = '<button class="spk" type="button" title="Changer l’intervenant de ce passage"></button><button class="ts" type="button"></button><div class="txt" spellcheck="true"></div><div class="tr" spellcheck="true" lang="fr"></div><span class="turn-range"></span>';
      t.insertBefore(row, typing || null);
    }
    row.classList.toggle('partial', !editable);
    row.classList.toggle('tentative', !!s.tentative);
    row.classList.toggle('gap', i > 0 && s.start - segs[i - 1].end > 2);
    const low = !s.tentative && s.conf != null && s.conf < CONF.fair;
    row.classList.toggle('low-conf', low);
    const ts = $('.ts', row);
    ts.textContent = fmtClock(s.start);
    if (s.lang && s.lang !== 'fr') ts.dataset.lang = s.lang.toUpperCase();
    else delete ts.dataset.lang;
    ts.dataset.start = s.start;
    ts.title = `${fmtClock(s.start)} → ${fmtClock(s.end)}`;
    const txt = $('.txt', row);
    txt.dataset.i = i;
    txt.title = s.conf != null ? `Confiance du modèle : ${Math.round(s.conf * 100)} %${low ? ' — passage à vérifier' : ''}` : '';
    if (editable && state.editMode) txt.setAttribute('contenteditable', 'plaintext-only');
    else txt.removeAttribute('contenteditable');
    if (document.activeElement !== txt && txt.textContent !== s.text) txt.textContent = s.text;
    const tr = $('.tr', row);
    tr.dataset.i = i;
    if (editable && state.editMode && s.tr != null) tr.setAttribute('contenteditable', 'plaintext-only');
    else tr.removeAttribute('contenteditable');
    row.classList.toggle('native', s.tr == null && (!s.lang || s.lang === 'fr'));
    row.classList.toggle('pending-tr', s.tr == null && !!s.lang && s.lang !== 'fr');
    const trText = s.tr ?? '';
    if (document.activeElement !== tr && tr.textContent !== trText) tr.textContent = trText;
    // Intervenant : couleur sur toute la ligne, nom au début de chaque prise de parole
    const who = multi && s.spk != null ? people[s.spk] : null;
    row.classList.toggle('has-spk', !!who);
    row.classList.toggle('spk-start', !!who && (i === 0 || segs[i - 1].spk !== s.spk));
    const chip = $('.spk', row);
    if (who) {
      row.style.setProperty('--spk', speakerColor(s.spk));
      chip.textContent = who.name;
      chip.dataset.i = i;
      if (row.classList.contains('spk-start')) {
        let j = i;
        while (j + 1 < segs.length && segs[j + 1].spk === s.spk) j++;
        $('.turn-range', row).textContent = `${fmtClock(s.start)} – ${fmtClock(segs[j].end)}`;
      }
    } else row.style.removeProperty('--spk');
  });
  $('#transcript').dataset.edit = state.editMode ? 'on' : 'off';
  renderView();
  updateButtons();
  // Le surlignage de lecture est recalculé : on retire l'ancien (les lignes sont réutilisées)
  for (const r of $$('#transcript .segment.playing')) r.classList.toggle('playing', false);
  playingRow = -1;
  find.refresh();
  player?.draw();
}

// ======================================================================
// Lecture : phrase en cours surlignée
// ======================================================================
let playingRow = -1;

/** Le moniteur suit la relecture (dès qu'on lance la lecture, puis aux déplacements). */
const monitorPb = { url: null, segs: null };
function syncMonitor(t, playing) {
  if (!monitor || recorder.state !== 'idle') return;
  if (t < 0 || !state.audio?.pcm) {
    monitorPb.url = null;
    monitor.clearPlayback();
    return renderMonitorState({ volume: null, conf: null });
  }
  if (!playing && !monitor.replaying) return; // simple chargement : on ne remplace pas le graphique
  if (monitorPb.url !== state.audio.url || !monitor.playback) {
    monitor.setPlayback(state.audio.pcm);
    monitorPb.url = state.audio.url;
    monitorPb.segs = null;
  }
  if (monitorPb.segs !== state.segments) {
    monitor.setPlaybackConfs(state.audio.docId === state.doc?.id || !state.audio.docId ? state.segments : []);
    monitorPb.segs = state.segments;
  }
  monitor.showAt(t);
}

function onPlayerTime(t, playing) {
  syncMonitor(t, playing);
  const rows = $$('#transcript .segment');
  const i = t < 0 ? -1 : segmentAt(state.segments, t);
  if (i === playingRow) return;
  rows[playingRow]?.classList.remove('playing');
  playingRow = i;
  const row = rows[i];
  if (!row) return;
  row.classList.add('playing');
  // Suit la lecture, sauf si l'utilisateur est en train de corriger le texte
  if (playing && !$('#transcript').contains(document.activeElement)) row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// ======================================================================
// Recherche dans le texte (surlignage sans toucher au texte éditable)
// ======================================================================
const fold = (c) => {
  const n = c.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  return n.length === 1 ? n : c.toLowerCase().slice(0, 1) || c;
};
const find = {
  hits: [],
  cur: -1,
  _t: 0,
  refresh() {
    clearTimeout(this._t);
    if ($('#find').value.trim()) this._t = setTimeout(() => this.run(false), 150);
  },
  run(jump = true) {
    const q = [...$('#find').value.trim()].map(fold).join('');
    this.hits = [];
    if (q) {
      for (const txt of $$('#transcript .segment .txt, #transcript .segment .tr').filter((el) => el.getClientRects().length)) {
        const walker = document.createTreeWalker(txt, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const hay = [...node.data].map(fold).join('');
          if (hay.length !== node.data.length) continue; // sécurité (caractères spéciaux)
          for (let i = hay.indexOf(q); i >= 0; i = hay.indexOf(q, i + q.length)) {
            const r = new Range();
            r.setStart(node, i);
            r.setEnd(node, i + q.length);
            this.hits.push(r);
          }
        }
      }
    }
    if (this.cur >= this.hits.length || jump) this.cur = this.hits.length ? 0 : -1;
    this.paint(jump);
  },
  step(d) {
    if (!this.hits.length) return this.run();
    this.cur = (this.cur + d + this.hits.length) % this.hits.length;
    this.paint(true);
  },
  clear() {
    $('#find').value = '';
    $('#find-box').classList.remove('has-q');
    this.hits = [];
    this.cur = -1;
    this.paint(false);
  },
  paint(scroll) {
    const n = this.hits.length;
    const q = $('#find').value.trim();
    $('#find-count').textContent = !q ? '' : n ? `${this.cur + 1} / ${n}` : 'aucun';
    $('#find-box').classList.toggle('none', !!q && !n);
    $('#find-prev').hidden = $('#find-next').hidden = n < 2;
    if (window.CSS?.highlights && window.Highlight) {
      CSS.highlights.set('find', new Highlight(...this.hits));
      CSS.highlights.set('find-cur', new Highlight(...(this.hits[this.cur] ? [this.hits[this.cur]] : [])));
    }
    const r = this.hits[this.cur];
    if (scroll && r) r.startContainer.parentElement?.closest('.segment')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  },
};

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

async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

const CLAUDE_ICON = '<svg class="claude-ico" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" stroke="none" d="M11.47 9.25 L10.79 1.07 L13.21 1.07 L12.53 9.25 L12.91 9.35 L15.70 3.58 L17.45 4.59 L13.84 9.89 L14.11 10.16 L20.86 5.49 L22.07 7.58 L14.65 11.09 L14.75 11.47 L21.14 10.99 L21.14 13.01 L14.75 12.53 L14.65 12.91 L22.07 16.42 L20.86 18.51 L14.11 13.84 L13.84 14.11 L17.45 19.41 L15.70 20.42 L12.91 14.65 L12.53 14.75 L13.21 22.93 L10.79 22.93 L11.47 14.75 L11.09 14.65 L8.30 20.42 L6.55 19.41 L10.16 14.11 L9.89 13.84 L3.14 18.51 L1.93 16.42 L9.35 12.91 L9.25 12.53 L2.86 13.01 L2.86 10.99 L9.25 11.47 L9.35 11.09 L1.93 7.58 L3.14 5.49 L9.89 10.16 L10.16 9.89 L6.55 4.59 L8.30 3.58 L11.09 9.35Z"/></svg>';

/**
 * Ouvre Claude avec une consigne. La consigne est copiée AVANT de quitter l'appli (le navigateur
 * refuse la copie une fois l'onglet de Claude au premier plan). Trop longue pour le lien : une
 * dernière étape explique de la coller, et un clic ouvre Claude.
 */
document.addEventListener('click', (e) => {
  if (e.target.id !== 'cl-copy-again') return;
  const ta = document.querySelector('.cl-raw');
  ta.select();
  const ok = document.execCommand('copy');
  toast(ok ? 'Consigne copiée.' : 'Sélectionne le texte et fais Ctrl + C.', ok ? 'ok' : 'warn', 3000);
});

async function openInClaude(prompt) {
  const url = claudeUrl(prompt);
  const copied = await writeClipboard(prompt);
  {
    tool.open('Ouvrir dans Claude');
    const go = await tool.show({
      step: 'Dernière étape',
      html: `<div class="cl-paste"><span class="cl-logo">${CLAUDE_ICON}</span><div>
        <p><b>${copied ? 'Ta consigne est copiée' : 'Copie automatique impossible'}</b> (${prompt.length.toLocaleString('fr-FR')} caractères)${copied ? '.' : ' : le navigateur a bloqué le presse-papiers.'}</p>
        <ol><li>${copied ? 'Clique sur « Ouvrir Claude ».' : 'Clique sur « Copier », puis sur « Ouvrir Claude ».'}</li><li>${url ? 'Si la consigne n’apparaît pas dans la zone de message, clique dedans' : 'Dans Claude, clique dans la zone de message'} et fais <kbd>Ctrl</kbd> + <kbd>V</kbd> (<kbd>⌘</kbd> + <kbd>V</kbd> sur Mac).</li><li>Appuie sur <kbd>Entrée</kbd>.</li></ol></div></div>
        ${copied ? '' : `<textarea class="cl-raw" readonly rows="4">${esc(prompt.slice(0, 200000))}</textarea><button class="btn sm" type="button" id="cl-copy-again">Copier</button>`}`,
      actions: [{ label: 'Annuler', value: null }, { label: 'Ouvrir Claude', value: true, primary: true }],
    });
    tool.close();
    if (!go) return;
  }
  const win = window.open(url || CLAUDE_NEW, '_blank');
  if (win) win.opener = null;
  if (!win) toast('Le navigateur a bloqué l’ouverture de Claude : ouvre claude.ai et colle la consigne (Ctrl + V).', 'warn', 9000);
  else if (url) toast('Claude s’ouvre avec ta consigne : vérifie et envoie. (Elle est aussi copiée, au cas où.)', 'ok', 6000);
  else toast('Dans Claude : Ctrl + V puis Entrée.', 'ok', 8000);
}

async function copyText() {
  await writeClipboard(toTxt(shownSegments(), { timestamps: tsOn(), speakers: speakerNames() }));
  toast('Texte copié dans le presse-papiers.', 'ok', 2500);
}

function docMeta() {
  const d = state.doc;
  return [d?.source, d?.durationS ? `durée ${fmtClock(d.durationS)}` : null, new Date(d?.createdAt || Date.now()).toLocaleString('fr-FR')]
    .filter(Boolean).join(' · ');
}

const lsGet = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* stockage indisponible */ } };

/** Résumer avec Claude : choix du type de résumé, puis ouverture de claude.ai avec la consigne. */
async function sendToClaude(preset = null) {
  if (!state.segments.length) return;
  const last = typeof preset === 'string' ? preset : lsGet('claude.type', 'cr');
  const ts = lsGet('claude.ts', '1') === '1';
  tool.open('Résumer avec Claude');
  const go = await tool.show({
    step: 'Export vers Claude',
    html: `<p>Choisis le type de résumé. La transcription et la consigne s’ouvrent dans Claude, il n’y a plus qu’à envoyer.</p>
      <div class="cl-types">${SUMMARY_TYPES.map((t) => `<label class="cl-type"><input type="radio" name="cl-type" value="${t.key}"${t.key === last ? ' checked' : ''} />
        <span><strong>${esc(t.label)}</strong><small>${esc(t.short)}</small></span></label>`).join('')}</div>
      <label class="cl-field"><span>Consignes en plus <em>(facultatif)</em></span>
        <textarea id="cl-extra" rows="2" placeholder="Ex. : réunion de synthèse BIM, mets en avant les conflits entre lots">${esc(lsGet('claude.extra', ''))}</textarea></label>
      <label class="modal-check"><input type="checkbox" id="cl-ts"${ts ? ' checked' : ''} /><span>Inclure les horodatages (Claude pourra citer les moments)</span></label>
      <p class="cl-note">Confidentialité : jusqu’ici tout restait sur ton PC. À partir de ce clic, le texte est envoyé à Claude (ton compte claude.ai). L’audio, lui, ne quitte pas ton PC.</p>`,
    actions: [{ label: 'Annuler', value: null }, { label: 'Ouvrir dans Claude', value: true, primary: true }],
  });
  if (!go) return;
  const type = document.querySelector('input[name="cl-type"]:checked')?.value || 'cr';
  const extra = $('#cl-extra').value;
  const withTs = $('#cl-ts').checked;
  lsSet('claude.type', type);
  lsSet('claude.extra', extra);
  lsSet('claude.ts', withTs ? '1' : '0');
  const prompt = buildPrompt({
    type, extra,
    title: $('#result-title').value.trim() || state.doc?.title || '',
    meta: docMeta(),
    transcript: toTxt(shownSegments(), { timestamps: withTs, speakers: speakerNames() }),
    speakers: speakerNames(),
    language: langName(state.doc?.language || 'fr').toLowerCase(),
    translatedFrom: currentView() !== 'orig' ? (langSummary(state.segments) || langName(state.doc?.translation?.from).toLowerCase()) : null,
    both: currentView() === 'both',
  });
  tool.close();
  await openInClaude(prompt);
}

// ======================================================================
// Traduction (locale) vers le français
// ======================================================================
const langName = (code) => LANGUAGES.find((l) => l[0] === code)?.[1] ?? code ?? '';
/** « de l’anglais », « du russe »… */
function langFrom(code) {
  const n = langName(code).toLowerCase();
  if (!n) return '';
  if (/^[aeiouéèh]/.test(n)) return `de l’${n}`;
  return { russe: 'du russe', turc: 'du turc', chinois: 'du chinois', japonais: 'du japonais', portugais: 'du portugais', polonais: 'du polonais', roumain: 'du roumain', néerlandais: 'du néerlandais' }[n] || `de ${n}`;
}
const hasTranslation = () => state.segments.some((s) => s.tr != null);
const currentView = () => (hasTranslation() ? state.view : 'orig');

function renderView() {
  const has = hasTranslation();
  const view = currentView();
  $('#view-switch').hidden = !has;
  $('#transcript').dataset.view = view;
  $$('#view-switch [data-view]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === view)));
  if (has) {
    const langs = new Set(state.segments.map((s) => s.lang).filter((l) => l && l !== 'fr'));
    const only = langs.size === 1 ? [...langs][0] : null;
    $('#view-switch [data-view=orig]').textContent = langs.size > 1 ? 'Original' : langName(only || state.doc?.translation?.from) || 'Original';
  }
}

/** Phrases telles qu'affichées (original, traduction, ou les deux) pour copier / exporter / Claude. */
function shownSegments() {
  const view = currentView();
  if (view === 'orig') return state.segments;
  return state.segments.map((s) => ({ ...s, text: view === 'tr' ? (s.tr || s.text) : s.tr ? `${s.text}\n→ ${s.tr}` : s.text }));
}

// ======================================================================
// Qui parle ? (pyannote + WeSpeaker, dans un worker ; ~33 Mo téléchargés une fois)
// ======================================================================
const SPK_WORKER = new URL('./speaker-worker.js', import.meta.url);
let spkWorker = null;
let spkSeq = 0;
let spkRun = null;
/** Empreintes vocales déjà calculées, par transcription : changer le nombre de personnes est instantané. */
const spkCache = new Map();

/** Noms des intervenants (pour les exports), ou null s'il n'y en a pas plusieurs. */
function speakerNames() {
  const sp = state.doc?.speakers;
  return sp?.length > 1 ? sp.map((p) => p.name) : null;
}

function spkEngine() {
  if (!spkWorker) {
    spkWorker = new Promise((resolve, reject) => {
      const w = new Worker(SPK_WORKER, { type: 'module' });
      const fail = (msg) => { clearTimeout(t); w.terminate(); reject(new Error(msg)); };
      const t = setTimeout(() => fail('le module ne démarre pas.'), 60000);
      w.onerror = (e) => { e.preventDefault?.(); fail('impossible de charger le module (cdn.jsdelivr.net et huggingface.co doivent être accessibles au premier lancement).'); };
      w.onmessage = ({ data }) => {
        if (data.type !== 'boot') return;
        clearTimeout(t);
        w.onmessage = null;
        w.onerror = null;
        resolve(w);
      };
    });
    spkWorker.catch(() => (spkWorker = null));
  }
  return spkWorker;
}

/** Empreintes vocales de l'audio (voir speaker-worker.js). */
async function analyseVoices(pcm, onProgress) {
  const w = await spkEngine();
  const id = ++spkSeq;
  return new Promise((resolve, reject) => {
    const h = ({ data }) => {
      if (data.id !== id) return;
      if (data.type === 'progress') return onProgress?.(data);
      w.removeEventListener('message', h);
      if (data.type === 'result') resolve(data.items);
      else reject(new Error(data.message));
    };
    w.addEventListener('message', h);
    w.postMessage({ type: 'run', id, pcm });
  });
}

let spkStatusTimer = 0;
function spkStatus(text, done = false) {
  clearTimeout(spkStatusTimer);
  const el = $('#spk-status');
  el.hidden = !text;
  el.classList.toggle('done', done);
  $('#spk-status-text').textContent = text;
  if (done) spkStatusTimer = setTimeout(() => (el.hidden = true), 5000);
}

/**
 * Identifie les intervenants d'une transcription.
 * k : nombre de personnes imposé (null = automatique). manual : lancé par le bouton.
 */
function identifySpeakers(doc, { k = doc?.speakerCount ?? null, manual = false } = {}) {
  if (!doc?.segments?.length) return null;
  if (spkRun) {
    if (manual) toast('Analyse des voix déjà en cours…', 'warn', 3000);
    return spkRun;
  }
  spkRun = (async () => {
    let items = spkCache.get(doc.id);
    if (!items) {
      spkStatus('Qui parle ? Préparation…');
      const pcm = (await loadDocAudio(doc)) ? state.audio.pcm : null;
      if (!pcm) {
        spkStatus('');
        if (manual) toast('L’audio de cette transcription n’est plus disponible : impossible de reconnaître les voix.', 'warn', 6000);
        return;
      }
      items = await analyseVoices(pcm, (p) => {
        const pct = `${Math.round((p.value || 0) * 100)} %`;
        spkStatus(p.stage === 'load' ? `Qui parle ? Téléchargement du module (≈ 33 Mo, une seule fois)… ${pct}` : `Qui parle ? Analyse des voix… ${pct}`);
      });
      spkCache.set(doc.id, items);
    }
    // La traduction numérote les phrases : on attend qu'elle ait fini avant d'en couper
    await autoRun?.promise?.catch(() => {});
    if (doc.status === 'running' || doc.status === 'live') return spkStatus('');
    if (!items.length) {
      spkStatus('');
      if (manual) toast('Aucune voix nette détectée dans cet audio.', 'warn', 5000);
      return;
    }
    const known = applySpeakers(doc, items, k);
    const n = doc.speakers.length;
    const kn = known.length ? ` · ${known.join(', ')} reconnu${known.length > 1 ? 's' : ''}` : '';
    spkStatus((n > 1 ? `${n} personnes` : 'Une seule voix') + (kn || (n > 1 ? ' reconnues' : ' reconnue')), true);
    if (n > 1) notify({ kind: 'ok', title: `${n} personnes reconnues`, text: known.length ? `« ${doc.title} » : ${known.join(', ')} reconnu${known.length > 1 ? 's' : ''} à la voix.` : `« ${doc.title} » : renomme-les dans l’onglet Transcription.`, docId: doc.id });
  })()
    .catch((e) => { spkStatus(''); toast(`Qui parle ? ${e.message}`, 'err', 8000); })
    .finally(() => { spkRun = null; });
  return spkRun;
}

/** Regroupe les voix et attribue chaque phrase (rapide : empreintes déjà calculées). */
function applySpeakers(doc, items, k) {
  const labels = clusterSpeakers(items, { k });
  const timeline = buildTimeline(items, labels);
  const base = doc.segments.map(({ spk, ...rest }) => rest);
  const names = (doc.speakers || []).map((p) => p.name);
  const { segments, speakers, order } = orderSpeakers(assignSpeakers(base, timeline), names);
  // Empreinte de chaque personne (pour le carnet de voix), puis reconnaissance des voix connues
  const cents = centroids(items, labels);
  speakers.forEach((p, n) => { const c = cents.get(order[n]); if (c) p.emb = packEmb(c); });
  const known = recognizeVoices(speakers);
  doc.segments = segments;
  doc.speakers = speakers;
  doc.speakerCount = k;
  if (state.doc === doc) {
    state.segments = doc.segments;
    renderSegments(state.segments, {});
    renderSpeakers();
    renderMeta();
  }
  persist(doc);
  return known;
}

/**
 * Donne leur nom aux voix déjà connues (carnet de voix). Renvoie les noms reconnus.
 * Un nom du carnet n'est jamais donné à deux personnes à la fois.
 */
function recognizeVoices(speakers) {
  if (!state.voiceId) return [];
  const book = VoiceBook.load();
  if (!book.length) return [];
  const m = matchVoices(speakers.map((p) => p.emb || null), book);
  const found = [];
  speakers.forEach((p, n) => {
    if (m[n].index < 0) { delete p.known; return; }
    p.name = book[m[n].index].name;
    p.known = Math.round(m[n].sim * 100) / 100;
    p.learned = p.name;
    found.push(p.name);
  });
  // Un autre intervenant ne garde pas un nom désormais porté par une voix reconnue
  const taken = new Set(found.map((x) => x.toLowerCase()));
  speakers.forEach((p, n) => { if (p.known == null && taken.has(p.name.toLowerCase())) p.name = defaultSpeakerName(n); });
  return found;
}

/** Après un renommage : la voix est apprise (ou affinée) dans le carnet. */
function learnSpeaker(n) {
  const p = state.doc?.speakers?.[n];
  if (!state.voiceId || !p?.emb || !p.name || /^Personne \d+$/.test(p.name) || p.learned === p.name) return;
  const isNew = !VoiceBook.load().some((v) => v.name.toLowerCase() === p.name.toLowerCase());
  VoiceBook.learn(p.name, p.emb);
  p.learned = p.name;
  saveDoc(0);
  renderVoices();
  toast(isNew ? `Voix de ${p.name} mémorisée : reconnaissance automatique aux prochaines réunions.` : `Voix de ${p.name} affinée.`, 'ok', 4000);
}

/** Paramètres : liste des voix connues. */
function renderVoices() {
  const box = $('#voice-list');
  if (!box) return;
  $('#toggle-voiceid').checked = state.voiceId;
  const book = VoiceBook.load().sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  $('#voice-clear').hidden = !book.length;
  box.innerHTML = book.length
    ? book.map((v) => `<li><span class="v-av">${esc(v.name.slice(0, 1).toUpperCase())}</span><span class="v-name">${esc(v.name)}<small>appris sur ${v.n || 1} réunion${(v.n || 1) > 1 ? 's' : ''}</small></span><button class="icon-btn sm" type="button" data-forget="${esc(v.name)}" aria-label="Oublier la voix de ${esc(v.name)}" title="Oublier cette voix"><svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button></li>`).join('')
    : '<li class="none">Aucune voix pour l’instant. Renomme un intervenant (« Personne 1 » → « Julie ») : sa voix sera reconnue aux réunions suivantes.</li>';
}

function bindVoices() {
  $('#toggle-voiceid').onchange = (e) => {
    state.voiceId = e.target.checked;
    store.set('voiceid', state.voiceId ? '1' : '0');
  };
  $('#voice-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-forget]');
    if (!b) return;
    VoiceBook.remove(b.dataset.forget);
    renderVoices();
    toast(`Voix de ${b.dataset.forget} oubliée.`, 'ok', 3000);
  });
  $('#voice-clear').onclick = async () => {
    if (!(await ask('Oublier toutes les voix connues ?', 'Les intervenants ne seront plus reconnus automatiquement. Les transcriptions ne changent pas.', 'Tout oublier', { danger: true }))) return;
    VoiceBook.clear();
    renderVoices();
  };
  renderVoices();
}

/** Barre des intervenants : noms modifiables, temps de parole, nombre de personnes. */
function renderSpeakers() {
  const d = state.doc;
  const sp = d?.speakers;
  $('#spk-panel').hidden = !sp?.length;
  $('#spk-side').hidden = !state.segments.length || d?.status === 'running' || d?.status === 'live';
  renderInsights();
  if (!sp?.length) return;
  const t = speakingTime(state.segments, sp.length);
  const tot = t.reduce((a, b) => a + b, 0) || 1;
  const list = $('#spk-list');
  const focused = document.activeElement?.closest?.('#spk-list') ? document.activeElement.dataset.n : null;
  list.replaceChildren(...sp.map((p, n) => {
    const item = document.createElement('label');
    item.className = 'spk-item';
    item.style.setProperty('--spk', speakerColor(n));
    item.title = 'Clique pour renommer';
    item.innerHTML = '<span class="dot"></span><input class="spk-name" spellcheck="false" maxlength="40" /><small></small>';
    const input = $('input', item);
    input.value = p.name;
    input.dataset.n = n;
    input.size = Math.max(6, Math.min(22, p.name.length + 1));
    input.setAttribute('aria-label', `Nom de ${p.name}`);
    $('small', item).textContent = `${Math.round((t[n] / tot) * 100)} %`;
    return item;
  }));
  if (focused != null) $(`#spk-list input[data-n="${focused}"]`)?.focus();
  $('#spk-count').value = d.speakerCount ? String(d.speakerCount) : '';
}

/** Après une correction : retire les intervenants sans phrase et renumérote. */
function compactSpeakers(d) {
  const used = [...new Set(state.segments.map((s) => s.spk).filter((x) => x != null))].sort((a, b) => a - b);
  const map = new Map(used.map((o, n) => [o, n]));
  // Les noms par défaut suivent la nouvelle numérotation ; les noms choisis sont gardés
  d.speakers = used.map((o, n) => {
    const p = d.speakers[o] || { name: '' };
    return { ...p, name: !p.name || /^Personne \d+$/.test(p.name) ? defaultSpeakerName(n) : p.name };
  });
  state.segments = state.segments.map((s) => (s.spk == null ? s : { ...s, spk: map.get(s.spk) }));
  d.segments = state.segments;
}

/** Menu d'une étiquette : attribuer cette prise de parole à quelqu'un d'autre. */
function openSpeakerMenu(chip) {
  const d = state.doc;
  const i = Number(chip.dataset.i);
  if (!d?.speakers || !state.segments[i]) return;
  const pop = $('#spk-pop');
  const from = state.segments[i].spk;
  const opts = d.speakers.map((p, n) => ({ n, label: p.name })).filter((o) => o.n !== from);
  opts.push({ n: d.speakers.length, label: 'Nouvelle personne' });
  pop.innerHTML = '<p>Ce passage est dit par…</p>';
  for (const o of opts) {
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = '<span class="dot"></span>';
    b.append(o.label);
    b.style.setProperty('--spk', speakerColor(o.n));
    b.onclick = () => {
      if (o.n >= d.speakers.length) d.speakers.push({ name: defaultSpeakerName(o.n), seconds: 0 });
      for (let j = i; j < state.segments.length && state.segments[j].spk === from; j++) state.segments[j] = { ...state.segments[j], spk: o.n };
      compactSpeakers(d);
      closeSpeakerMenu();
      renderSegments(state.segments, {});
      renderSpeakers();
      saveDoc();
    };
    pop.append(b);
  }
  const r = chip.getBoundingClientRect();
  pop.hidden = false;
  pop.style.left = `${Math.min(r.left, innerWidth - pop.offsetWidth - 12)}px`;
  pop.style.top = `${r.bottom + pop.offsetHeight + 8 > innerHeight ? r.top - pop.offsetHeight - 6 : r.bottom + 6}px`;
  pop.querySelector('button')?.focus();
}

function closeSpeakerMenu() { $('#spk-pop').hidden = true; }

// ======================================================================
// Interface v3 : vues, onglets du document, panneau d'analyse
// ======================================================================
const PAGE_OF = { home: 'home', record: 'record', doc: 'doc', projects: 'history', history: 'history', settings: 'settings', analytics: 'analytics', models: 'models', help: 'help', custom: 'custom', spaces: 'spaces' };

/** Affiche une vue (accueil, document, projets / historique, paramètres). */
/** Téléphone : le panneau « Analyse audio » s'ouvre en plein écran (onglet Analyse). */
function toggleSheet(open = !document.body.classList.contains('sheet-open')) {
  document.body.classList.toggle('sheet-open', open);
  $('#nav [data-nav="panel"]').classList.toggle('active', open);
  if (open) {
    $$('#nav [data-nav]').forEach((b) => b.dataset.nav !== 'panel' && b.classList.remove('active'));
    requestAnimationFrame(() => monitor?.draw());
  } else setView(state.page === 'history' ? ($('#step-history').dataset.mode === 'projects' ? 'projects' : 'history') : state.page);
}

function setView(name) {
  if (document.body.classList.contains('sheet-open')) { document.body.classList.remove('sheet-open'); $('#nav [data-nav="panel"]')?.classList.remove('active'); }
  const page = PAGE_OF[name] || 'home';
  state.page = page;
  document.body.dataset.page = page;
  $$('.view').forEach((v) => v.classList.toggle('active', v.dataset.page === page));
  const navKey = page === 'doc' ? 'projects' : page === 'record' ? 'home' : name;
  $$('#nav [data-nav]').forEach((b) => b.classList.toggle('active', b.dataset.nav === navKey));
  if (page === 'history') {
    $('#h-hist').textContent = name === 'projects' ? 'Mes projets' : 'Historique';
    $('#step-history').dataset.mode = name === 'projects' ? 'projects' : 'history';
    if (name === 'history') state.folder = 'all';
    renderHistory();
  }
  if (page === 'home') renderDashboard();
  else if (page !== 'record' && page !== 'doc') renderQuick();
  if (page === 'analytics') renderAnalytics();
  if (page === 'models') renderModelsPage();
  if (page === 'custom') renderPerso();
  if (page === 'spaces') renderSpaces();
  if (page === 'record') requestAnimationFrame(() => monitor?.draw());
  if (page === 'doc') requestAnimationFrame(() => player?.draw());
  else {
    // Hors du document : lecture en pause et panneau d'analyse vierge (sauf micro en cours d'utilisation)
    if (player?.loaded && !player.audio.paused) player.audio.pause();
    if (monitor && recorder.state === 'idle' && page !== 'record') { monitor.clearPlayback(); monitor.reset(); }
  }
  renderInsights();
}

function setDocTab(tab) {
  state.dtab = tab;
  $$('[data-dtab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.dtab === tab)));
  $$('[data-dpanel]').forEach((p) => (p.hidden = p.dataset.dpanel !== tab));
  if (tab === 'analysis') renderAnalysis();
  if (tab === 'summary') renderSummary();
  if (tab === 'actions') renderActions();
}

const ICON_OK = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.6 2.5L16 9.5"/></svg>';
const ICON_WARN = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5M12 16h.01"/></svg>';

/** Panneau de droite : répartition des intervenants et qualité de la transcription. */
function renderInsights() {
  // Le panneau ne montre que la transcription affichée : vierge sur l'accueil, les projets et les paramètres
  const onDoc = state.page === 'doc';
  const d = onDoc ? state.doc : null;
  const segs = onDoc ? state.segments : [];
  // Donut des intervenants
  const sp = d?.speakers;
  const donut = $('#spk-donut');
  const legend = $('#spk-legend');
  const R = 15.915; // circonférence 100
  if (sp?.length > 1) {
    const t = speakingTime(segs, sp.length);
    const tot = t.reduce((a, b) => a + b, 0) || 1;
    let off = 0;
    donut.innerHTML = `<circle cx="21" cy="21" r="${R}" stroke="rgb(var(--ov) / 0.06)"/>` + t.map((v, n) => {
      const pct = (v / tot) * 100;
      const c = `<circle cx="21" cy="21" r="${R}" stroke="${speakerColor(n)}" stroke-dasharray="${Math.max(0, pct - 0.6)} ${100 - Math.max(0, pct - 0.6)}" stroke-dashoffset="${-off}"/>`;
      off += pct;
      return c;
    }).join('');
    legend.innerHTML = sp.map((p, n) => `<li style="--spk:${speakerColor(n)}"><i class="dot"></i><span>${esc(p.name)}</span><b>${Math.round((t[n] / tot) * 100)} %</b></li>`).join('');
  } else {
    donut.innerHTML = `<circle cx="21" cy="21" r="${R}" stroke="rgb(var(--ov) / 0.08)"/>`;
    legend.innerHTML = `<li class="none">${!d ? 'Ouvre une transcription pour voir qui parle.' : sp?.length === 1 ? 'Une seule voix reconnue.' : 'Clique sur « Qui parle ? » pour reconnaître les voix.'}</li>`;
  }
  // Jauge de qualité (confiance réelle du modèle)
  const withC = segs.filter((x) => x.conf != null);
  const gauge = $('#q-gauge');
  const list = $('#q-list');
  if (!withC.length) {
    gauge.dataset.level = '';
    $('#q-fill').classList.add('empty');
    $('#q-val').textContent = '—';
    list.innerHTML = `<li class="none">${d ? 'Pas de mesure de confiance pour cette transcription.' : 'La qualité s’affiche après une transcription.'}</li>`;
    return;
  }
  const avg = withC.reduce((a, x) => a + x.conf, 0) / withC.length;
  const pct = Math.round(avg * 100);
  const level = avg >= CONF.good ? 'ok' : avg >= CONF.fair ? 'warn' : 'err';
  gauge.dataset.level = level;
  $('#q-fill').classList.remove('empty');
  $('#q-fill').style.strokeDasharray = `${(pct / 100) * 100.5} 101`;
  $('#q-val').textContent = `${pct} %`;
  const low = withC.filter((x) => x.conf < CONF.fair).length;
  const edited = segs.filter((x) => x.edited).length;
  const items = [
    [level, level === 'ok' ? 'Bonne compréhension' : level === 'warn' ? 'Compréhension moyenne' : 'Compréhension faible'],
    [low ? 'warn' : 'ok', low ? `${low} passage${low > 1 ? 's' : ''} à vérifier` : 'Aucun passage à vérifier'],
    ['ok', edited ? `${edited} phrase${edited > 1 ? 's' : ''} corrigée${edited > 1 ? 's' : ''}` : `${segs.length} phrase${segs.length > 1 ? 's' : ''}`],
  ];
  list.innerHTML = items.map(([lv, txt]) => `<li class="${lv}">${lv === 'ok' ? ICON_OK : ICON_WARN}${esc(txt)}</li>`).join('');
}

/** Onglet Analyse : chiffres clés, temps de parole, passages à vérifier. */
function renderAnalysis() {
  const box = $('#analysis');
  const d = state.doc;
  const segs = state.segments;
  if (!d || !segs.length) return (box.innerHTML = '<p class="a-empty">Pas encore de texte à analyser.</p>');
  const words = (s) => s.text.match(/\S+/g)?.length || 0;
  const total = segs.reduce((n, s) => n + words(s), 0);
  const dur = d.durationS || segs[segs.length - 1].end || 0;
  const sp = d.speakers?.length > 1 ? d.speakers : null;
  const langs = langSummary(segs);
  const stats = [
    ['Durée', fmtClock(dur)],
    ['Mots', String(total)],
    ['Débit', dur > 5 ? `${Math.round(total / (dur / 60))} mots/min` : '—'],
    ['Phrases', String(segs.length)],
    ['Intervenants', sp ? String(sp.length) : '—'],
    ['Modèle', d.model ? `${d.model.replace(/^Whisper /, '')}${d.device ? ` · ${d.device === 'webgpu' ? 'GPU' : 'CPU'}` : ''}` : '—'],
    ['Langue', langs ? langs.replace(/^./, (c) => c.toUpperCase()) : langName(d.language && d.language !== 'auto' ? d.language : 'fr')],
  ];
  let html = `<div class="stat-grid">${stats.map(([k, v]) => `<div class="stat"><small>${k}</small><b>${esc(v)}</b></div>`).join('')}</div>`;
  if (sp) {
    const t = speakingTime(segs, sp.length);
    const tot = t.reduce((a, b) => a + b, 0) || 1;
    const w = sp.map((_, n) => segs.filter((s) => s.spk === n).reduce((a, s) => a + words(s), 0));
    html += `<div class="a-block"><h4>Temps de parole</h4><table class="a-table"><thead><tr><th>Intervenant</th><th>Temps</th><th>Mots</th><th style="width:40%">Part</th></tr></thead><tbody>${
      sp.map((p, n) => `<tr style="--spk:${speakerColor(n)}"><td><i class="dot"></i>${esc(p.name)}</td><td>${fmtClock(t[n])}</td><td>${w[n]}</td><td><div class="bar-in"><i style="width:${Math.round((t[n] / tot) * 100)}%"></i></div></td></tr>`).join('')
    }</tbody></table></div>`;
  }
  const low = segs.map((s, i) => ({ s, i })).filter(({ s }) => s.conf != null && s.conf < CONF.fair);
  html += `<div class="a-block"><h4>Passages à vérifier</h4>${low.length
    ? `<div class="check-list">${low.map(({ s, i }) => `<button type="button" data-i="${i}"><time>${fmtClock(s.start)}</time><span>${esc(s.text.length > 140 ? s.text.slice(0, 139) + '…' : s.text)}</span></button>`).join('')}</div>`
    : '<p class="a-empty">Aucun : le modèle était sûr de lui sur tout le texte.</p>'}</div>`;
  box.innerHTML = html;
}

/** Décisions et actions repérées, avec l'état choisi par l'utilisateur (fait / retiré). */
function docActions(d = state.doc) {
  if (!d || !state.segments.length) return [];
  const st = d.actionState || {};
  return extractActions(state.segments, { speakers: d.speakers || [], meetingTime: d.createdAt })
    .map((x) => ({ ...x, done: st[x.key] === 'done', hidden: st[x.key] === 'hidden' }));
}

const fmtDue = (date) => date.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });

/** Onglet Actions : relevé de décisions et d'actions (qui fait quoi, pour quand). */
function renderActions() {
  const box = $('#actions');
  const d = state.doc;
  if (!d || !state.segments.length) return (box.innerHTML = '<p class="a-empty">Pas encore de texte à analyser.</p>');
  const all = docActions(d);
  const shown = all.filter((x) => !x.hidden);
  const hidden = all.length - shown.length;
  const dec = shown.filter((x) => x.type === 'decision');
  const act = shown.filter((x) => x.type === 'action');
  const spkIdx = new Map((d.speakers || []).map((p, n) => [p.name, n]));
  const time = (x) => `<button class="act-time" type="button" data-seek="${x.i}" title="Écouter ce passage">${fmtClock(x.start)}</button>`;
  const del = (x) => `<button class="icon-btn sm act-del" type="button" data-hide="${esc(x.key)}" aria-label="Retirer" title="Ce n’en est pas une : retirer"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>`;
  const who = (x) => {
    const n = spkIdx.get(x.who);
    return x.who
      ? `<span class="act-who"${n != null ? ` style="--spk:${speakerColor(n)}"` : ''}><i class="dot"></i>${esc(x.who)}</span>`
      : '<span class="act-who none">Qui ? À préciser</span>';
  };
  const due = (x) => x.due
    ? `<span class="act-due" title="${x.date ? esc(x.date.toLocaleDateString('fr-FR', { dateStyle: 'full' })) : ''}"><svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/></svg>${esc(x.date ? fmtDue(x.date) : x.due)}</span>`
    : '<span class="act-due none">Sans échéance</span>';
  const doneN = act.filter((x) => x.done).length;
  let html = `<div class="act-block"><h4><span class="act-ico dec"><svg viewBox="0 0 24 24"><path d="m5 12 5 5 9-10"/></svg></span>Décisions <small>${dec.length}</small></h4>${dec.length
    ? `<ul class="act-list">${dec.map((x) => `<li class="act-item dec">${time(x)}<div class="act-body"><p>${esc(x.text)}</p></div>${del(x)}</li>`).join('')}</ul>`
    : '<p class="a-empty">Aucune décision repérée (« on valide », « on part sur », « c’est acté »…).</p>'}</div>`;
  html += `<div class="act-block"><h4><span class="act-ico"><svg viewBox="0 0 24 24"><path d="M10 6h10M10 12h10M10 18h10M3.5 6l1.5 1.5L7.5 5M3.5 12l1.5 1.5 2.5-2.5M3.5 18l1.5 1.5 2.5-2.5"/></svg></span>Actions <small>${act.length ? `${doneN}/${act.length} faite${doneN > 1 ? 's' : ''}` : '0'}</small></h4>${act.length
    ? `<ul class="act-list">${act.map((x) => `<li class="act-item${x.done ? ' done' : ''}"><label class="act-check" title="Marquer comme faite"><input type="checkbox" data-done="${esc(x.key)}"${x.done ? ' checked' : ''} /><span><svg viewBox="0 0 24 24"><path d="m5 12 5 5 9-10"/></svg></span></label><div class="act-body"><p>${esc(x.text)}</p><div class="act-meta">${who(x)}${due(x)}${time(x)}</div></div>${del(x)}</li>`).join('')}</ul>`
    : '<p class="a-empty">Aucune action repérée (« il faut », « tu peux… », « je m’en occupe », « je t’envoie »…).</p>'}</div>`;
  if (hidden) html += `<p class="act-hidden">${hidden} élément${hidden > 1 ? 's' : ''} retiré${hidden > 1 ? 's' : ''} · <button class="link-btn" type="button" data-unhide>Tout réafficher</button></p>`;
  box.innerHTML = html;
  $('#act-copy').disabled = !shown.length;
}

function setActionState(key, value) {
  const d = state.doc;
  if (!d) return;
  d.actionState = { ...(d.actionState || {}) };
  if (value) d.actionState[key] = value;
  else delete d.actionState[key];
  saveDoc(0);
  renderActions();
}

function bindActions() {
  $('#actions').addEventListener('click', (e) => {
    const t = e.target.closest('[data-seek], [data-hide], [data-unhide]');
    if (!t) return;
    if (t.dataset.hide) return setActionState(t.dataset.hide, 'hidden');
    if (t.hasAttribute('data-unhide')) {
      const d = state.doc;
      if (!d?.actionState) return;
      d.actionState = Object.fromEntries(Object.entries(d.actionState).filter(([, v]) => v !== 'hidden'));
      saveDoc(0);
      return renderActions();
    }
    const i = Number(t.dataset.seek);
    setDocTab('tr');
    const row = $$('#transcript .segment')[i];
    row?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row?.classList.toggle('flash', true);
    setTimeout(() => row?.classList.toggle('flash', false), 1300);
    if (state.audio && state.segments[i]) player.seek(state.segments[i].start, { play: true });
  });
  $('#actions').addEventListener('change', (e) => {
    const k = e.target.dataset.done;
    if (k) setActionState(k, e.target.checked ? 'done' : null);
  });
  $('#act-copy').onclick = async () => {
    const items = docActions().filter((x) => !x.hidden);
    const md = actionsToMarkdown(items, { title: $('#result-title').value.trim() || state.doc?.title || '', fmtDate: fmtDue });
    try {
      await navigator.clipboard.writeText(md);
      toast('Relevé copié : colle-le dans un mail, Teams ou Notion.', 'ok', 3500);
    } catch {
      toast('Copie impossible (presse-papiers bloqué par le navigateur).', 'err', 4000);
    }
  };
  $('#act-claude').onclick = () => sendToClaude('actions');
}

/** Onglet Résumé IA : résumé collé depuis Claude, gardé avec la transcription. */
function renderSummary() {
  const ta = $('#summary-text');
  if (document.activeElement !== ta) ta.value = state.doc?.summary || '';
  ta.disabled = !state.doc;
}

async function toggleFullscreen() {
  const el = $('#step-result');
  if (document.fullscreenElement) return document.exitFullscreen().catch(() => {});
  if (el.classList.contains('full-fallback')) return el.classList.remove('full-fallback');
  try { await el.requestFullscreen(); } catch { el.classList.add('full-fallback'); }
}

function bindV3() {
  $$('[data-nav]').forEach((b) => (b.onclick = () => (b.dataset.nav === 'panel' ? toggleSheet() : setView(b.dataset.nav))));
  $('#panel-close').onclick = () => toggleSheet(false);
  $$('[data-dtab]').forEach((b) => (b.onclick = () => setDocTab(b.dataset.dtab)));
  // Recherche du haut : transcriptions enregistrées
  const hs = $('#hist-search');
  hs.addEventListener('focus', () => { if (state.page !== 'history') setView('history'); });
  hs.addEventListener('input', () => { if (state.page !== 'history') setView('history'); });
  // Barre d'enregistrement et de progression (vue document)
  $('#rb-pause').onclick = () => $('#rec-pause').click();
  $('#rb-stop').onclick = () => $('#rec-stop').click();
  $('#pb-cancel').onclick = () => $('#btn-cancel').click();
  // Mode édition
  $('#toggle-edit').checked = state.editMode;
  $('#toggle-edit').onchange = (e) => {
    state.editMode = e.target.checked;
    store.set('edit', state.editMode ? '1' : '0');
    const st = state.doc?.status;
    renderSegments(state.segments, { editable: st !== 'running' && st !== 'live' });
  };
  // Plein écran, volume
  $('#btn-full').onclick = toggleFullscreen;
  $('#pl-full').onclick = toggleFullscreen;
  $('#pl-vol').onclick = () => {
    const a = $('#audio-player');
    a.muted = !a.muted;
    $('#pl-vol').classList.toggle('muted', a.muted);
    $('#pl-vol').setAttribute('aria-label', a.muted ? 'Remettre le son' : 'Couper le son');
  };
  // Résumé IA
  $('#btn-claude-tab').onclick = () => sendToClaude();
  $('#summary-text').addEventListener('input', (e) => {
    if (!state.doc) return;
    state.doc.summary = e.target.value;
    saveDoc(600);
  });
  // Analyse : clic sur un passage à vérifier → écoute + texte
  $('#analysis').addEventListener('click', (e) => {
    const b = e.target.closest('[data-i]');
    if (!b) return;
    const i = Number(b.dataset.i);
    setDocTab('tr');
    const row = $$('#transcript .segment')[i];
    row?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row?.classList.toggle('flash', true);
    setTimeout(() => row?.classList.toggle('flash', false), 1300);
    if (state.audio && state.segments[i]) player.seek(state.segments[i].start, { play: true });
  });
  // Menu Exporter : se referme après Copier / Claude
  $$('#btn-copy, #btn-claude').forEach((b) => b.addEventListener('click', () => ($('#export-menu').open = false)));
  // Loupe : reste ouverte tant qu'une recherche est saisie
  $('#find').addEventListener('input', (e) => $('#find-box').classList.toggle('has-q', !!e.target.value));
  setDocTab('tr');
  setView('home');
  renderInsights();
}

function bindSpeakers() {
  $('#btn-speakers').onclick = () => {
    const d = state.doc;
    if (!d) return;
    if (d.status === 'running' || d.status === 'live') return toast('Attends la fin de la transcription.', 'warn', 3000);
    identifySpeakers(d, { manual: true });
  };
  $('#spk-list').addEventListener('input', (e) => {
    const d = state.doc;
    const n = Number(e.target.dataset.n);
    if (!d?.speakers?.[n]) return;
    d.speakers[n].name = e.target.value.trim() || defaultSpeakerName(n);
    e.target.size = Math.max(6, Math.min(22, e.target.value.length + 1));
    for (const c of $$('#transcript .segment.spk-start .spk')) {
      const s = state.segments[Number(c.dataset.i)];
      if (s?.spk === n) c.textContent = d.speakers[n].name;
    }
    saveDoc(600);
  });
  $('#spk-list').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
  $('#spk-list').addEventListener('change', (e) => { const n = Number(e.target.dataset.n); if (Number.isInteger(n)) learnSpeaker(n); });
  $('#spk-count').onchange = (e) => {
    const d = state.doc;
    if (!d) return;
    const k = e.target.value ? Number(e.target.value) : null;
    const items = spkCache.get(d.id);
    if (items?.length) applySpeakers(d, items, k);
    else identifySpeakers(d, { k, manual: true });
  };
  $('#spk-clear').onclick = () => {
    const d = state.doc;
    if (!d) return;
    delete d.speakers;
    delete d.speakerCount;
    state.segments = state.segments.map(({ spk, ...rest }) => rest);
    d.segments = state.segments;
    renderSegments(state.segments, {});
    renderSpeakers();
    persist(d);
  };
  $('#toggle-autospk').checked = state.autoSpk;
  $('#toggle-autospk').onchange = (e) => {
    state.autoSpk = e.target.checked;
    store.set('autospk', state.autoSpk ? '1' : '0');
  };
  document.addEventListener('pointerdown', (e) => { if (!e.target.closest('#spk-pop, .spk')) closeSpeakerMenu(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSpeakerMenu(); });
  addEventListener('scroll', closeSpeakerMenu, true);
}

const TR_WORKER = new URL('./translate-worker.js', import.meta.url);

// ---------- Traduction automatique ----------
/** Traducteurs réutilisés : un par langue d'origine (Chrome ou modèle local). */
const translators = new Map();
function getTranslator(lang) {
  if (!translators.has(lang)) {
    const p = createTranslator(lang, 'fr', {
      workerUrl: TR_WORKER,
      onProgress: (x) => trStatus(`Téléchargement du traducteur… ${Math.round(x.value * 100)} %`),
    });
    p.catch(() => translators.delete(lang));
    translators.set(lang, p);
  }
  return translators.get(lang);
}

let trStatusTimer = 0;
function trStatus(text) {
  clearTimeout(trStatusTimer);
  $('#tr-status').hidden = !text;
  $('#tr-status-text').textContent = text || '';
  $('#tr-status').classList.toggle('done', /^Traduit/.test(text || ''));
}

/** Langue d'une phrase : celle donnée par Whisper, sinon devinée à partir du texte. */
function segLang(s) {
  return s.lang || guessLang(s.text);
}

/** Le modèle lourd (NLLB, ~900 Mo) n'est téléchargé qu'avec accord, une fois. */
async function heavyOk(lang, { canAsk }) {
  if (localPlan(lang)?.kind !== 'nllb') return true;
  const a = await chromeAvailability(lang, 'fr');
  if (a && a !== 'unavailable') return true;
  if (store.get('tr.nllb', '') === '1') return true;
  if (!canAsk) return false;
  const ok = await ask('Traduire depuis cette langue ?',
    `Pour traduire ${langFrom(lang)}, il faut un modèle de traduction de ~900 Mo (téléchargé une seule fois, puis tout reste sur ton PC).`, 'Télécharger');
  if (ok) store.set('tr.nllb', '1');
  return !!ok;
}

let autoRun = null;
/** Traduit en français les phrases d'une autre langue (après une transcription ou à la demande). */
async function autoTranslate(doc) {
  if (!state.autoTr || !doc?.segments?.length) return;
  if (autoRun?.doc === doc) return autoRun.promise;
  const run = { doc };
  run.promise = (async () => {
    // Langue de chaque phrase (Voxtral : devinée à partir du texte, puis la langue majoritaire pour les phrases courtes)
    const segs = doc.segments.map((s) => (s.lang ? s : { ...s, lang: guessLang(s.text) || undefined }));
    const counts = {};
    for (const s of segs) if (s.lang) counts[s.lang] = (counts[s.lang] || 0) + 1;
    const main = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
    for (const s of segs) if (!s.lang && main) s.lang = main;
    doc.segments = segs;
    const todo = segs.map((s, i) => i).filter((i) => segs[i].lang && segs[i].lang !== 'fr' && segs[i].tr == null && segs[i].text.trim());
    if (state.doc === doc) { state.segments = doc.segments; renderSegments(state.segments, {}); }
    if (!todo.length) return;
    const byLang = {};
    for (const i of todo) (byLang[segs[i].lang] ||= []).push(i);
    let done = 0;
    const engines = new Set();
    for (const [lang, idx] of Object.entries(byLang)) {
      if (!(await heavyOk(lang, { canAsk: true }))) continue;
      trStatus(`Traduction ${langFrom(lang)} en français…`);
      let tr;
      try {
        tr = await getTranslator(lang);
      } catch (e) {
        toast(`Traduction automatique impossible ${langFrom(lang)} : ${e.message}`, 'warn', 7000);
        continue;
      }
      engines.add(tr.label);
      for (let k = 0; k < idx.length; k += 6) {
        if (doc.status === 'running' || doc.status === 'live') return; // retranscription en cours
        const batch = idx.slice(k, k + 6);
        let out;
        try { out = await tr.translate(batch.map((i) => doc.segments[i].text)); } catch (e) { console.warn(e); break; }
        batch.forEach((i, j) => { doc.segments[i] = { ...doc.segments[i], tr: out[j] }; });
        done += batch.length;
        trStatus(`Traduction en français… ${done} / ${todo.length} phrases`);
        if (state.doc === doc) { state.segments = doc.segments; renderSegments(state.segments, {}); }
      }
    }
    if (!done) return;
    const foreign = Object.keys(counts).filter((l) => l !== 'fr').sort((x, y) => counts[y] - counts[x])[0] || main;
    doc.translation = { auto: true, from: foreign, to: 'fr', engine: [...engines].join(' + '), at: Date.now() };
    await persist(doc);
    if (state.doc === doc) renderView();
    trStatus(`Traduit en français (${[...engines].join(' + ')}) · ${done} phrase${done > 1 ? 's' : ''}`);
    notify({ kind: 'ok', title: 'Traduction terminée', text: `« ${doc.title} » · ${done} phrase${done > 1 ? 's' : ''} traduite${done > 1 ? 's' : ''} en français`, docId: doc.id });
    trStatusTimer = setTimeout(() => trStatus(''), 5000);
  })().finally(() => {
    if (autoRun === run) autoRun = null;
    if (!/^Traduit/.test($('#tr-status-text').textContent)) trStatus('');
  });
  autoRun = run;
  return run.promise;
}

/** Direct : chaque phrase validée dans une autre langue est traduite dès qu'elle arrive. */
const liveQueued = new WeakSet();
let liveQueue = Promise.resolve();
function liveTranslate(session) {
  if (!state.autoTr) return;
  for (const seg of session.committed) {
    if (liveQueued.has(seg) || seg.tr != null) continue;
    const lang = segLang(seg);
    if (!lang) continue;
    seg.lang = lang;
    liveQueued.add(seg);
    if (lang === 'fr') continue;
    liveQueue = liveQueue.then(async () => {
      if (state.live !== session || !(await heavyOk(lang, { canAsk: false }))) return;
      try {
        const tr = await getTranslator(lang);
        if (/^Téléchargement/.test($('#tr-status-text').textContent)) trStatus('');
        const [t] = await tr.translate([seg.text]);
        seg.tr = t;
        if (state.live === session) renderLive();
      } catch (e) { console.warn('Traduction en direct', e); }
    });
  }
}

/** Reprend les traductions faites en direct quand le moteur renvoie le texte final. */
function carryTranslations(finalSegs, oldSegs) {
  const byText = new Map(oldSegs.filter((s) => s.tr != null).map((s) => [s.text.trim(), s]));
  for (const s of finalSegs) {
    const o = byText.get(s.text.trim());
    if (o) Object.assign(s, { tr: o.tr, lang: o.lang });
  }
}

async function translateDoc() {
  if (!state.segments.length || state.phase !== 'idle' || micBusy()) return;
  const doc = state.doc;
  const choices = LANGUAGES.filter(([c]) => c !== 'fr');
  const guess = doc?.translation?.from || (doc?.language && doc.language !== 'fr' ? doc.language : lsGet('tr.from', 'en'));
  const voxtral = isStreaming(modelById(doc?.modelId));
  tool.open('Traduire en français');
  const shown = tool.show({
    step: 'Traduction locale',
    html: `<p>Chaque phrase est traduite en français en gardant ses horodatages : la réécoute au clic marche aussi sur la traduction.</p>
      <label class="cl-field"><span>Langue parlée dans l’enregistrement</span>
        <select id="tr-from" class="select">${choices.map(([c, n]) => `<option value="${c}"${c === guess ? ' selected' : ''}>${n}</option>`).join('')}</select></label>
      ${voxtral ? '<p class="cl-note">Transcrit avec Voxtral, qui détecte la langue tout seul : vérifie la langue ci-dessus.</p>' : ''}
      ${doc?.language === 'fr' && !doc?.translation ? '<p class="cl-note warn">Cette transcription a été faite avec la langue « Français ». Si l’enregistrement est dans une autre langue, retranscris-le d’abord avec la bonne langue (choix sous le modèle) : le résultat sera bien meilleur.</p>' : ''}
      <div class="tr-engine" id="tr-engine"><span class="dot"></span><span>Recherche du meilleur traducteur…</span></div>
      <p class="cl-note">Tout se passe sur ton PC : aucun texte n’est envoyé sur Internet.${hasTranslation() ? ' La traduction actuelle sera remplacée.' : ''}</p>`,
    actions: [{ label: 'Annuler', value: null }, { label: 'Traduire', value: true, primary: true }],
  });
  const showEngine = async () => {
    const from = $('#tr-from').value;
    const cached = await localCached(from, 'fr', TR_WORKER).catch(() => false);
    const d = await describeEngine(from, 'fr', { cached });
    if (tool.cancelled || $('#tr-from')?.value !== from) return;
    $('#tr-engine').dataset.ok = d.engine ? '1' : '0';
    $('#tr-engine span:last-child').textContent = d.text;
  };
  $('#tr-from').onchange = showEngine;
  showEngine();
  if (!(await shown)) return;
  const from = $('#tr-from').value;
  lsSet('tr.from', from);
  const total = state.segments.length;
  const bar = (label, v) => {
    tool.wait('Traduction locale', `<p class="tool-big">${esc(label)}</p><div class="bar"><div class="bar-fill" id="tr-bar" style="width:${Math.round((v || 0) * 100)}%"></div></div>`);
  };
  bar('Préparation du traducteur…', 0);
  let tr;
  try {
    tr = await createTranslator(from, 'fr', {
      workerUrl: TR_WORKER,
      onProgress: (p) => { if (!tool.cancelled) { const el = $('#tr-bar'); if (el) el.style.width = `${Math.round(p.value * 100)}%`; $('.tool-big', $('#tool-body')).textContent = `Téléchargement du traducteur… ${Math.round(p.value * 100)} %`; } },
    });
  } catch (e) {
    tool.close();
    return toast(`Traduction impossible : ${e.message}`, 'err', 8000);
  }
  const target = state.doc;
  const out = state.segments.map((s) => ({ ...s, tr: undefined }));
  const t0 = performance.now();
  let failed = null;
  try {
    for (let i = 0; i < total && !tool.cancelled; i += 6) {
      bar(`Traduction… ${i} / ${total} phrases (${tr.label})`, i / total);
      const slice = state.segments.slice(i, i + 6);
      const texts = await tr.translate(slice.map((s) => (s.lang === 'fr' ? '' : s.text)));
      texts.forEach((t, k) => { if (slice[k].lang !== 'fr') out[i + k].tr = t; });
    }
  } catch (e) {
    failed = e;
  } finally {
    tr.destroy();
  }
  const cancelled = tool.cancelled;
  tool.close();
  if (state.doc !== target) return; // l'utilisateur a ouvert autre chose entre-temps
  if (failed && !out.some((s) => s.tr != null)) return toast(`Traduction impossible : ${failed.message}`, 'err', 8000);
  state.segments = out.map((s) => (s.tr == null ? (({ tr: _, ...rest }) => rest)(s) : s));
  target.translation = { from, to: 'fr', engine: tr.label, at: Date.now() };
  if (state.view === 'orig') state.view = 'tr';
  renderSegments(state.segments, {});
  saveDoc();
  const done = out.filter((s) => s.tr != null).length;
  if (cancelled || failed) toast(`Traduction partielle : ${done} / ${total} phrases.`, 'warn', 6000);
  else toast(`Traduit ${langFrom(from)} en ${fmtDuration((performance.now() - t0) / 1000)} (${tr.label}).`, 'ok', 5000);
}

function exportAs(fmt) {
  const segs = shownSegments();
  if (!segs.length) return;
  const d = state.doc;
  const speakers = speakerNames();
  if (fmt === 'txt') download(exportName('txt'), toTxt(segs, { timestamps: tsOn(), speakers }), 'text/plain');
  if (fmt === 'md') {
    const meta = [d?.source, d?.durationS ? `durée ${fmtClock(d.durationS)}` : null, d?.model, currentView() !== 'orig' ? `traduit ${langFrom(d?.translation?.from)} (${d?.translation?.engine})` : null, new Date(d?.createdAt || Date.now()).toLocaleString('fr-FR')]
      .filter(Boolean).join(' · ');
    download(exportName('md'), toMarkdown(segs, { timestamps: tsOn(), title: d?.title || 'Transcription', meta, speakers }), 'text/markdown');
  }
  if (fmt === 'srt') download(exportName('srt'), toSrt(segs, { speakers }), 'application/x-subrip');
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
  $$('[data-export], #btn-copy, #btn-relex, #btn-claude, #btn-claude-tab, #btn-translate, #btn-speakers, #act-copy, #act-claude').forEach((b) => (b.disabled = !has));
  $('#summary-text').disabled = !state.doc;
  $('#export-menu').classList.toggle('disabled', !has);
  if (!has) $('#export-menu').open = false;
  $('#find').disabled = !state.segments.length;
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
  if (a.audioId) { await Audios.remove(a.audioId).catch(() => {}); Sync.forget(null, a.audioId); }
  for (const d of linked) {
    if (r.checked) {
      await History.remove(d.id).catch(() => {});
      Sync.forget(d.id);
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
  if (state.page === 'home') renderDashboard();
  if (state.page === 'analytics') renderAnalytics();
  const list = $('#hist-list');
  let items = [];
  let sizes = {};
  try { [items, sizes] = await Promise.all([History.list(), Audios.sizes()]); } catch { list.innerHTML = '<p class="hist-empty">Historique indisponible dans ce navigateur.</p>'; return; }
  items = items.filter(isMine);
  renderFolderBar(items);
  if (state.folder !== 'all') items = items.filter((it) => (state.folder === 'none' ? !Folders.get(it.folderId) : it.folderId === state.folder));
  const total = items.reduce((a, it) => a + (it.durationS || 0), 0);
  $('#hist-count').textContent = items.length ? `${items.length} transcription${items.length > 1 ? 's' : ''}${total ? ` · ${fmtHours(total)} d’audio` : ''}` : '';
  if (!items.length) { list.innerHTML = `<div class="hist-empty"><span class="r-ico violet">${STAT_ICONS.docs}</span><b>${state.folder === 'all' ? 'Aucune transcription pour l’instant' : 'Ce dossier est vide'}</b><small>${state.folder === 'all' ? 'Lance ta première avec « Nouvelle transcription » sur l’accueil.' : 'Range une transcription ici avec son menu « Dossier ».'}</small></div>`; return; }
  const q = [...$('#hist-search').value.trim()].map(fold).join('');
  const textOf = (it) => [...`${it.title} ${it.segments.map((x) => x.text).join(' ')}`].map(fold).join('');
  if (q) items = items.filter((it) => textOf(it).includes(q));
  if (!items.length) { list.innerHTML = '<p class="hist-empty">Aucun résultat.</p>'; return; }
  list.innerHTML = '';
  for (const it of items) {
    const el = document.createElement('article');
    el.className = 'hist-item proj-card' + (state.doc?.id === it.id ? ' current' : '');
    el.tabIndex = 0;
    const [tone, icon] = docIcon(it.title);
    const sp = (it.speakers || []).filter((x) => x?.name);
    const audioSize = it.audioId ? sizes[it.audioId] : null;
    const interrupted = it.status === 'interrupted' || it.status === 'running';
    el.innerHTML = `<div class="pc-top"><span class="r-ico ${tone}">${icon}</span><div class="pc-title"><strong></strong><small></small></div>
      <button class="icon-btn danger pc-del" type="button" aria-label="Supprimer" title="Supprimer la transcription et son audio"><svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg></button></div>
      <div class="pc-chips">${it.durationS ? `<span><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>${fmtShortDur(it.durationS)}</span>` : ''}${sp.length > 1 ? `<span>${STAT_ICONS.people}${sp.length} intervenants</span>` : ''}${it.model ? `<span>${esc(it.model.replace(/^Whisper /, ''))}</span>` : ''}${audioSize != null ? `<span><svg viewBox="0 0 24 24"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>${fmtBytes(audioSize)}</span>` : ''}${interrupted ? '<span class="warn">Interrompue</span>' : ''}${it.fromSpace ? `<span class="shared">${SP_PEOPLE}${esc(it.fromSpace.name)}${it.fromSpace.by ? ` · ${esc(it.fromSpace.by)}` : ''}</span>` : ''}</div>
      <p></p>
      <div class="pc-foot"><label class="pc-folder" title="Ranger dans un dossier"><svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg><select class="hist-move" aria-label="Dossier"></select></label>
        ${sp.length > 1 ? `<span class="pc-avatars">${sp.slice(0, 3).map((x, n) => `<i style="--spk:${speakerColor(n)}" title="${esc(x.name)}">${esc(/^Personne (\d+)$/.test(x.name) ? x.name.replace(/\D/g, '') : initials(x.name).slice(0, 2))}</i>`).join('')}${sp.length > 3 ? `<i class="more">+${sp.length - 3}</i>` : ''}</span>` : ''}
        <span class="pc-open" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg></span></div>`;
    $('strong', el).textContent = it.title;
    $('.pc-title small', el).textContent = `${relDay(it.createdAt)} · ${new Date(it.createdAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
    const mv = $('.hist-move', el);
    mv.innerHTML = folderOptions(it.folderId);
    mv.onchange = () => moveToFolder(it, mv.value);
    const all = it.segments.map((x) => x.text).join(' ');
    let preview = all.slice(0, 160);
    if (q) {
      // Montre le passage qui contient le mot cherché
      const at = [...all].map(fold).join('').indexOf(q);
      if (at > 40) preview = '…' + all.slice(at - 40, at + 120);
    }
    $('p', el).textContent = preview || '(vide)';
    if (!preview) $('p', el).classList.add('empty');
    const open = () => openDoc(it);
    el.addEventListener('click', (e) => { if (!e.target.closest('.icon-btn, .hist-move, .pc-folder')) open(); });
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
    $('.pc-del', el).onclick = async () => {
      if (state.run?.doc.id === it.id || state.doc?.id === it.id && state.phase !== 'idle') return toast('Cette transcription est en cours.', 'warn');
      const ok = await ask('Supprimer cette transcription ?', `« ${it.title} »${it.audioId ? ' et son audio seront' : ' sera'} définitivement effacé${it.audioId ? 's' : 'e'} de ce navigateur.`, 'Supprimer', { danger: true });
      if (!ok) return;
      await History.remove(it.id);
      Sync.forget(it.id);
      if (it.audioId) {
        const others = (await History.list()).some((d) => d.audioId === it.audioId);
        if (!others) {
          await Audios.remove(it.audioId);
          Sync.forget(null, it.audioId);
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
  renderHistory();
  renderResume(it);
  // Recharge l'audio associé (réécoute, horodatages cliquables, reprise)
  if (it.audioId && state.audio?.audioId !== it.audioId) {
    const before = state.audio;
    getAudio(it.audioId).then((rec) => {
      // Ne jamais écraser un audio choisi entre-temps par l'utilisateur
      if (rec?.blob && state.doc?.id === it.id && state.phase === 'idle' && state.audio === before && !micBusy()) setAudioFromBlob(rec.blob, rec.name, { audioId: rec.id, docId: it.id }).then(() => renderResume(state.doc));
    }).catch(() => {});
  }
}

// ======================================================================
// Tableau de bord (accueil), analyses, modèles, assistant
// ======================================================================
const DAY_MS = 86400000;

/** Transcriptions de l'utilisateur, terminées ou non, les plus récentes d'abord. */
async function myDocs() {
  try { return (await History.list()).filter(isMine).sort((a, b) => b.createdAt - a.createdAt); } catch { return []; }
}

const fmtHours = (s) => {
  if (s < 60) return `${Math.round(s)} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  const h = s / 3600;
  return h < 10 ? `${h.toFixed(1).replace('.', ',').replace(',0', '')} h` : `${Math.round(h)} h`;
};
const fmtShortDur = (s) => (s >= 3600 ? `${Math.floor(s / 3600)} h ${String(Math.round((s % 3600) / 60)).padStart(2, '0')}` : `${Math.max(1, Math.round(s / 60))} min`);

function relDay(t) {
  const d0 = new Date(); d0.setHours(0, 0, 0, 0);
  const diff = Math.floor((d0.getTime() - new Date(t).setHours(0, 0, 0, 0)) / DAY_MS);
  if (diff === 0) return 'Aujourd’hui';
  if (diff === 1) return 'Hier';
  return new Date(t).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Petite pastille d'évolution (« ↑ 3 cette sem. »). */
const trend = (txt, kind = 'up') => (txt ? `<span class="trend ${kind}">${kind === 'up' ? '↑' : kind === 'down' ? '↓' : ''} ${esc(txt)}</span>` : '');

const STAT_ICONS = {
  docs: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  time: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  people: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><circle cx="17" cy="9" r="2.5"/><path d="M16 14.2a5 5 0 0 1 5.5 5.8"/></svg>',
  star: '<svg viewBox="0 0 24 24"><path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"/></svg>',
};
const statTile = (cls, icon, value, label, extra = '') => `<div class="glass stat-tile ${cls}"><span class="st-ico">${icon}</span><div><b>${esc(value)}</b><small>${esc(label)}${extra}</small></div></div>`;

function statTiles(docs, st) {
  const folders = Folders.list().length;
  const people = speakerTotals(docs).filter((p) => !p.unknown).length;
  const dConf = st.confWeek != null && st.confPrev != null ? Math.round((st.confWeek - st.confPrev) * 100) : null;
  return [
    statTile('t-violet', STAT_ICONS.docs, String(st.count), 'Transcriptions', trend(st.countWeek ? `${st.countWeek} cette sem.` : '')),
    statTile('t-blue', STAT_ICONS.time, st.seconds ? fmtHours(st.seconds) : '0 h', 'Audio traité', trend(st.secondsWeek >= 60 ? `${fmtHours(st.secondsWeek)} cette sem.` : '')),
    folders
      ? statTile('t-indigo', STAT_ICONS.people, String(folders), folders > 1 ? 'Projets' : 'Projet')
      : statTile('t-indigo', STAT_ICONS.people, String(people), people > 1 ? 'Voix connues' : 'Voix connue'),
    statTile('t-amber', STAT_ICONS.star, st.conf != null ? `${Math.round(st.conf * 100)} %` : '—', 'Compréhension', dConf ? trend(`${Math.abs(dConf)} pts`, dConf > 0 ? 'up' : 'down') : ''),
  ].join('');
}

/** Icône d'un projet, d'après les mots de son titre. */
function docIcon(title) {
  const t = String(title).toLowerCase();
  if (/chantier|gros|œuvre|oeuvre|visite|opr|réception/.test(t)) return ['amber', '<svg viewBox="0 0 24 24"><path d="M4 18h16M6 18v-3a6 6 0 0 1 12 0v3M12 9V6M9.5 9.5 8 7M14.5 9.5 16 7"/></svg>'];
  if (/formation|cours|tuto|webinaire|conférence/.test(t)) return ['blue', '<svg viewBox="0 0 24 24"><path d="m2 9 10-5 10 5-10 5z"/><path d="M6 11v5c3 2 9 2 12 0v-5M22 9v6"/></svg>'];
  if (/bim|maquette|synthèse|coordination|revit|ifc|modèle|clash/.test(t)) return ['violet', '<svg viewBox="0 0 24 24"><path d="M4 21V5l8-3v19M12 9l8 3v9M2 21h20M7 8h2M7 12h2M7 16h2M15 14h2M15 17h2"/></svg>'];
  if (/équipe|point|réunion|meeting|call|visio|daily/.test(t)) return ['indigo', STAT_ICONS.people];
  return ['slate', '<svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></svg>'];
}

const STATUS = (d) => (d.status === 'running' || d.status === 'live' ? ['run', 'En cours'] : d.status === 'interrupted' ? ['warn', 'Interrompue'] : ['ok', 'Terminée']);

function recentRows(docs) {
  if (!docs.length) return '<p class="dash-empty">Aucune transcription pour l’instant. Lance ta première avec « Nouvelle transcription ».</p>';
  return docs.slice(0, 12).map((d) => {
    const [tone, icon] = docIcon(d.title);
    const [sk, sl] = STATUS(d);
    const n = d.speakers?.length || 0;
    const meta = [relDay(d.createdAt), d.durationS ? fmtShortDur(d.durationS) : null, n > 1 ? `${n} intervenants` : null].filter(Boolean).join(' · ');
    return `<div class="recent-row" data-doc="${esc(d.id)}" tabindex="0">
      <span class="r-ico ${tone}">${icon}</span>
      <div class="r-main"><b>${esc(d.title)}</b><small><svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/></svg>${esc(meta)}</small></div>
      <span class="r-status ${sk}">${sk === 'ok' ? '<svg viewBox="0 0 24 24"><path d="m5 12 5 5 9-10"/></svg>' : ''}${sl}</span>
      <div class="r-acts">
        <button class="r-btn" type="button" data-act="play" title="Écouter" aria-label="Écouter"${d.audioId ? '' : ' disabled'}><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></button>
        <button class="r-btn" type="button" data-act="open" title="Ouvrir la transcription" aria-label="Ouvrir"><svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></svg></button>
        <button class="r-btn ghost" type="button" data-act="more" title="Plus" aria-label="Plus d’options"><svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg></button>
      </div>
    </div>`;
  }).join('');
}

/** Courbe lissée (Catmull-Rom → Bézier) pour la mini-courbe. */
function smoothPath(pts) {
  if (pts.length < 2) return '';
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0]},${p2[1].toFixed(1)}`;
  }
  return d;
}

function sparkline(days) {
  const W = 220, H = 70, pad = 8;
  const max = Math.max(...days.map((d) => d.minutes), 1);
  const pts = days.map((d, i) => [Math.round(pad + (i * (W - 2 * pad)) / (days.length - 1)), H - pad - (d.minutes / max) * (H - 2 * pad - 14)]);
  const line = smoothPath(pts);
  const peak = days.reduce((b, d, i) => (d.minutes > days[b].minutes ? i : b), 0);
  const [px, py] = pts[peak];
  const label = days[peak].minutes ? fmtShortDur(days[peak].minutes * 60) : '';
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
    <defs><linearGradient id="spk-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".35"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>
    <path d="${line} L${pts[pts.length - 1][0]},${H} L${pts[0][0]},${H} Z" fill="url(#spk-fill)" stroke="none"/>
    <path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2.2" vector-effect="non-scaling-stroke"/>
    ${label ? `<line x1="${px}" x2="${px}" y1="${py}" y2="${H}" stroke="var(--accent)" stroke-dasharray="2 3" stroke-opacity=".5" vector-effect="non-scaling-stroke"/><circle cx="${px}" cy="${py}" r="4" fill="var(--card-solid)" stroke="var(--accent)" stroke-width="2" vector-effect="non-scaling-stroke"/>` : ''}
  </svg>${label ? `<span class="spark-tip" style="left:${(px / W) * 100}%">${esc(label)}</span>` : ''}`;
}

const TOPIC_COLORS = ['#8b7cff', '#c4b5fd', '#6d5dfc', '#a5b4fc'];

/** Donut SVG (parts 0..1) */
function donutSvg(parts, colors, { gap = 0.8 } = {}) {
  const R = 15.915;
  let off = 0;
  return `<circle cx="21" cy="21" r="${R}" stroke="rgb(var(--ov) / 0.08)"/>` + parts.map((v, i) => {
    const pct = v * 100;
    const len = Math.max(0, pct - (parts.length > 1 ? gap : 0));
    const c = `<circle cx="21" cy="21" r="${R}" stroke="${colors[i % colors.length]}" stroke-dasharray="${len} ${100 - len}" stroke-dashoffset="${-off}"/>`;
    off += pct;
    return c;
  }).join('');
}

function actionSources(docs) {
  return docs.map((d) => {
    const st = d.actionState || {};
    const items = extractActions(d.segments || [], { speakers: d.speakers || [], meetingTime: d.createdAt })
      .filter((x) => st[x.key] !== 'hidden')
      .map((x) => ({ ...x, done: st[x.key] === 'done' }));
    return { doc: d, items };
  });
}

function insightsHtml(docs) {
  const now = Date.now();
  const st = dashStats(docs, now);
  const days = dailyMinutes(docs, 7, now);
  const delta = st.secondsPrev > 0 ? Math.round(((st.secondsWeek - st.secondsPrev) / st.secondsPrev) * 100) : null;
  const topics = topicShares(docs.slice(0, 40));
  const week = actionSources(docs.filter((d) => d.createdAt >= now - 7 * DAY_MS));
  const prev = actionSources(docs.filter((d) => d.createdAt >= now - 14 * DAY_MS && d.createdAt < now - 7 * DAY_MS));
  const nAct = week.reduce((a, s) => a + s.items.filter((x) => x.type === 'action').length, 0);
  const nPrev = prev.reduce((a, s) => a + s.items.filter((x) => x.type === 'action').length, 0);
  const nOpen = week.reduce((a, s) => a + s.items.filter((x) => x.type === 'action' && !x.done).length, 0);
  const aDelta = nPrev > 0 ? Math.round(((nAct - nPrev) / nPrev) * 100) : null;
  return `
    <div class="ins-col">
      <h4>Temps d’audio traité</h4>
      <div class="ins-big"><b>${st.secondsWeek ? fmtHours(st.secondsWeek) : '0 min'}</b>${delta != null ? trend(`${Math.abs(delta)} %`, delta >= 0 ? 'up' : 'down') : ''}</div>
      <small class="ins-sub">${delta != null ? 'vs semaine précédente' : 'ces 7 derniers jours'}</small>
      <div class="spark-wrap">${sparkline(days)}</div>
    </div>
    <div class="ins-col">
      <h4>Sujets principaux</h4>
      ${topics.length ? `<div class="ins-topics"><svg class="mini-donut" viewBox="0 0 42 42" aria-hidden="true">${donutSvg(topics.map((t) => t.share), TOPIC_COLORS)}</svg>
        <ul class="legend">${topics.slice(0, 3).map((t, i) => `<li style="--spk:${TOPIC_COLORS[i]}"><i class="dot"></i><span>${esc(t.label)}</span><b>${Math.round(t.share * 100)} %</b></li>`).join('')}</ul></div>`
      : '<p class="dash-empty sm">Les sujets apparaissent après quelques transcriptions.</p>'}
    </div>
    <div class="ins-col">
      <h4>Actions extraites</h4>
      <div class="ins-big"><b>${nAct}</b>${aDelta != null && aDelta !== 0 ? trend(`${Math.abs(aDelta)} %`, aDelta > 0 ? 'up' : 'down') : ''}</div>
      <small class="ins-sub">ces 7 derniers jours${nAct ? ` · ${nOpen} à faire` : ''}</small>
      <button class="link-btn more-link" type="button" data-nav="analytics">Voir les actions en cours<svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg></button>
    </div>`;
}

function helloText() {
  const h = new Date().getHours();
  const name = Auth.user()?.name?.split(/[\s@]/)[0];
  return `${h >= 18 || h < 5 ? 'Bonsoir' : 'Bonjour'}${name ? ` ${name}` : ''} ! 👋`;
}

let dashToken = 0;
async function renderDashboard() {
  const t = ++dashToken;
  const docs = await myDocs();
  if (t !== dashToken) return;
  $('#hero-hello').textContent = helloText();
  $('#dash-stats').innerHTML = statTiles(docs, dashStats(docs));
  $('#dash-recent').innerHTML = recentRows(docs);
  $('#dash-insights').innerHTML = insightsHtml(docs);
  renderQuick(docs);
}

/** Panneau « Analyse rapide » : temps de parole par personne sur la période. */
async function renderQuick(docs = null) {
  docs ??= await myDocs();
  const range = $('#quick-range').value;
  const from = periodStart(range);
  const list = speakerTotals(docs.filter((d) => d.createdAt >= from));
  const total = list.reduce((a, p) => a + p.seconds, 0);
  const top = list.filter((p) => !p.unknown).slice(0, 3);
  const rest = total - top.reduce((a, p) => a + p.seconds, 0);
  const rows = [...top.map((p, i) => ({ name: p.name, s: p.seconds, c: speakerColor(i) })), ...(rest > 0 ? [{ name: top.length ? 'Autres' : 'Non identifiés', s: rest, c: 'rgb(var(--ov) / 0.35)' }] : [])];
  $('#quick-donut').innerHTML = total ? donutSvg(rows.map((r) => r.s / total), rows.map((r) => r.c)) : donutSvg([], []);
  $('#quick-total').textContent = total ? fmtShortDur(total) : '—';
  $('#quick-legend').innerHTML = total
    ? rows.map((r) => `<li style="--spk:${r.c}"><i class="dot"></i><span>${esc(r.name)}</span><b>${Math.round((r.s / total) * 100)} %</b></li>`).join('')
    : `<li class="none">${docs.length ? 'Lance « Qui parle ? » sur une réunion pour voir qui parle le plus.' : 'Rien sur cette période.'}</li>`;
}

// ---------- Assistant (recherche locale + Claude) ----------
const chatLog = [];
function chatAdd(role, html) {
  chatLog.push({ role, html });
  if (chatLog.length > 12) chatLog.shift();
  renderChat();
}
// ---------- Périmètre de l'assistant : toutes les réunions, un dossier ou une réunion ----------
let asstScope = (() => { try { return JSON.parse(lsGet('assistant.scope', 'null')) || { type: 'all' }; } catch { return { type: 'all' }; } })();
const FOLDER_SVG = '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
const ALL_SVG = '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 4v5"/></svg>';

/** Réunions concernées par le périmètre choisi. */
function scopeDocs(docs) {
  if (asstScope.type === 'folder') return docs.filter((d) => (asstScope.id === 'none' ? !Folders.get(d.folderId) : d.folderId === asstScope.id));
  if (asstScope.type === 'doc') return docs.filter((d) => d.id === asstScope.id);
  return docs;
}

/** Le périmètre existe-t-il encore (dossier supprimé, réunion effacée…) ? Sinon : toutes les réunions. */
async function checkScope() {
  if (asstScope.type === 'folder' && asstScope.id !== 'none' && !Folders.get(asstScope.id)) setScope({ type: 'all' }, { quiet: true });
  if (asstScope.type === 'doc' && !(await myDocs()).some((d) => d.id === asstScope.id)) setScope({ type: 'all' }, { quiet: true });
}

function renderScopeChip() {
  const chip = $('#asst-scope');
  if (!chip) return;
  const icon = asstScope.type === 'folder' ? FOLDER_SVG : asstScope.type === 'doc' ? STAT_ICONS.docs.replace('M3 7a2', 'M3 7a2') : ALL_SVG;
  chip.classList.toggle('on', asstScope.type !== 'all');
  chip.innerHTML = `${asstScope.type === 'doc' ? '<svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>' : icon}<span><small>Sur</small>${esc(asstScope.label || 'Toutes les réunions')}</span><svg class="chev" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>`;
  $('#asst-scope-clear').hidden = asstScope.type === 'all';
}

function setScope(sc, { quiet = false } = {}) {
  asstScope = sc.type === 'all' ? { type: 'all' } : sc;
  lsSet('assistant.scope', JSON.stringify(asstScope));
  lastExchange = null;
  renderScopeChip();
  if (!quiet) {
    chatAdd('sys', asstScope.type === 'all' ? 'Je réponds maintenant sur <b>toutes tes réunions</b>.' : `Je réponds maintenant sur <b>${esc(asstScope.label)}</b>${asstScope.type === 'folder' ? ` (${asstScope.n || 0} réunion${(asstScope.n || 0) > 1 ? 's' : ''})` : ''}.`);
    $('#chat-input')?.focus();
  }
}

/** Fenêtre de choix du périmètre (dossiers et réunions, avec recherche). */
async function openScopePicker() {
  const pop = $('#scope-pop');
  if (!pop.hidden) return closeScopePicker();
  const docs = (await myDocs()).filter((d) => d.segments?.length);
  const folders = Folders.list();
  const count = (id) => docs.filter((d) => (id === 'none' ? !Folders.get(d.folderId) : d.folderId === id)).length;
  const render = (q = '') => {
    const f = [...q.trim()].map(fold).join('');
    const match = (t) => !f || [...String(t)].map(fold).join('').includes(f);
    const row = (attrs, icon, title, sub, active) => `<button type="button" class="sp-row${active ? ' active' : ''}" ${attrs}><span class="sp-ico">${icon}</span><span class="sp-txt"><b>${esc(title)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</span>${active ? '<i class="sp-on"></i>' : ''}</button>`;
    let html = '';
    if (match('Toutes les réunions')) html += row('data-scope="all"', ALL_SVG, 'Toutes les réunions', `${docs.length} réunion${docs.length > 1 ? 's' : ''}`, asstScope.type === 'all');
    const fl = folders.filter((x) => match(x.name));
    if (fl.length || (folders.length && match('Sans dossier'))) {
      html += '<p class="sp-label">Projets (dossiers)</p>';
      html += fl.map((x) => row(`data-scope="folder" data-id="${esc(x.id)}" data-label="${esc(x.name)}" data-n="${count(x.id)}"`, FOLDER_SVG, x.name, `${count(x.id)} réunion${count(x.id) > 1 ? 's' : ''}`, asstScope.type === 'folder' && asstScope.id === x.id)).join('');
      if (folders.length && match('Sans dossier') && count('none')) html += row(`data-scope="folder" data-id="none" data-label="Sans dossier" data-n="${count('none')}"`, FOLDER_SVG, 'Sans dossier', `${count('none')} réunion${count('none') > 1 ? 's' : ''}`, asstScope.type === 'folder' && asstScope.id === 'none');
    }
    const dl = docs.filter((d) => match(d.title)).slice(0, 30);
    if (dl.length) {
      html += '<p class="sp-label">Réunions</p>';
      html += dl.map((d) => { const [tone, icon] = docIcon(d.title); return row(`data-scope="doc" data-id="${esc(d.id)}" data-label="${esc(d.title)}"`, `<span class="r-ico ${tone}">${icon}</span>`, d.title, `${relDay(d.createdAt)}${d.durationS ? ` · ${fmtShortDur(d.durationS)}` : ''}${Folders.get(d.folderId) ? ` · ${Folders.get(d.folderId).name}` : ''}`, asstScope.type === 'doc' && asstScope.id === d.id); }).join('');
    }
    $('#sp-list').innerHTML = html || '<p class="sp-empty">Aucun résultat.</p>';
  };
  render();
  pop.hidden = false;
  $('#sp-search').value = '';
  $('#sp-search').oninput = (e) => render(e.target.value);
  $('#sp-search').focus();
}

function closeScopePicker() {
  const pop = $('#scope-pop');
  if (pop) pop.hidden = true;
}

function bindScope() {
  $('#asst-scope').onclick = (e) => { e.stopPropagation(); openScopePicker(); };
  $('#asst-scope-clear').onclick = (e) => { e.stopPropagation(); closeScopePicker(); setScope({ type: 'all' }); };
  $('#sp-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-scope]');
    if (!b) return;
    closeScopePicker();
    setScope({ type: b.dataset.scope, id: b.dataset.id, label: b.dataset.label, n: Number(b.dataset.n) || undefined });
  });
  $('#sp-search').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeScopePicker(); $('#chat-input').focus(); }
    if (e.key === 'Enter') { e.preventDefault(); $('#sp-list [data-scope]:not(.active)')?.click() || $('#sp-list [data-scope]')?.click(); }
  });
  document.addEventListener('pointerdown', (e) => { if (!e.target.closest('#scope-pop, #asst-scope')) closeScopePicker(); });
  // « @ » au début du champ : ouvre le choix
  $('#chat-input').addEventListener('input', (e) => {
    if (e.target.value.endsWith('@') && $('#scope-pop').hidden) { e.target.value = e.target.value.slice(0, -1); openScopePicker(); }
  });
  renderScopeChip();
  checkScope();
}

function renderChat() {
  const box = $('#chat');
  if (!chatLog.length) {
    box.innerHTML = `<div class="chat-hello"><span class="bot-ico">${'<svg viewBox="0 0 24 24"><path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2"/></svg>'}</span><div><p>Pose une question sur tes réunions : je lis tes transcriptions et je te réponds en citant mes sources.</p>
      <div class="chat-sugg"><button type="button" data-q="Quelles décisions cette semaine ?">Décisions de la semaine</button><button type="button" data-q="Quelles actions restent à faire ?">Actions à faire</button></div></div></div>`;
    return;
  }
  box.innerHTML = chatLog.map((m) => m.role === 'sys' ? `<p class="msg-sys">${m.html}</p>` : `<div class="msg ${m.role}">${m.role === 'bot' ? '<span class="bot-ico"><svg viewBox="0 0 24 24"><path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2"/></svg></span>' : ''}<div class="bubble">${m.html}</div></div>`).join('');
  box.scrollTop = box.scrollHeight;
}

let lastQuestion = '';
let lastExchange = null;

// ---------- Moteurs de l'assistant ----------
const CLAUDE_SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.5.0/+esm';
const CLAUDE_MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (le plus capable)', fallbacks: true },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (rapide)', fallbacks: true },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (le plus économique)', fallbacks: false },
];
const asstEngine = () => lsGet('assistant.engine', 'auto');
const claudeKey = () => lsGet('assistant.key', '');
/**
 * Modèles locaux à essayer, dans l'ordre. Sur carte graphique : format q4f16 si elle gère la
 * demi-précision (shader-f16), sinon q4. Les échecs mémorisés sont sautés.
 */
function localCandidates() {
  const e = asstEngine();
  const gpu = caps().webgpu;
  const f16 = !!caps().f16;
  const failed = (k) => !!lsGet(`assistant.failed.${k}`, '');
  const big = { ...LLM_MODELS.large, dtype: f16 ? 'q4f16' : 'q4', sizeMB: f16 ? 1430 : 2150, key: `large-${f16 ? 'q4f16' : 'q4'}` };
  const smallGpu = { ...LLM_MODELS.small, device: 'webgpu', dtype: f16 ? 'q4f16' : 'q4', sizeMB: f16 ? 570 : 920, key: `small-gpu-${f16 ? 'q4f16' : 'q4'}`, light: true };
  const smallCpu = { ...LLM_MODELS.small, key: 'small-cpu', light: true };
  let list;
  if (e === 'local-large') list = gpu ? [big, smallGpu, smallCpu] : [smallCpu];
  else if (e === 'local-small') list = gpu ? [smallGpu, smallCpu] : [smallCpu];
  else list = gpu ? [big, smallGpu] : [];
  const ok = list.filter((m) => !failed(m.key));
  // Choix explicite : on retente au moins le dernier ; automatique : recherche simple si tout a échoué
  return ok.length || e === 'auto' ? ok : list.slice(-1);
}
/** Premier modèle local qui sera essayé (pour l'affichage). */
const localLlm = () => localCandidates()[0] || LLM_MODELS.small;

let llm = null;
let llmReady = null;
let llmSeq = 0;
const llmPending = new Map();
let llmIdle = null;
function llmWorker() {
  if (llm) return llm;
  llm = new Worker(new URL('./llm-worker.js', import.meta.url), { type: 'module' });
  // Le worker charge Transformers.js avant d'écouter : les messages attendent son signal « ready »
  let ready;
  llmReady = new Promise((r) => (ready = r));
  llm.onmessage = ({ data: m }) => {
    if (m.type === 'ready') return ready();
    if (m.type === 'progress') { for (const p of llmPending.values()) p.onProgress?.(m); return; }
    const p = llmPending.get(m.id);
    if (!p) return;
    if (m.type === 'token') return p.onToken?.(m.text);
    llmPending.delete(m.id);
    if (m.type === 'error') p.reject(new Error(m.message));
    else p.resolve(m);
  };
  llm.onerror = (e) => {
    for (const p of llmPending.values()) p.reject(new Error(e.message || 'Le modèle local s’est arrêté (mémoire insuffisante ?).'));
    llmPending.clear();
    llm?.terminate();
    llm = null;
    llmReady = null;
  };
  return llm;
}
function llmCall(msg, { onToken, onProgress } = {}) {
  const id = ++llmSeq;
  clearTimeout(llmIdle);
  return new Promise((resolve, reject) => {
    llmPending.set(id, { resolve, reject, onToken, onProgress });
    const w = llmWorker();
    llmReady.then(() => w.postMessage({ ...msg, id }));
  }).finally(() => {
    // Mémoire libérée après 15 min sans question
    llmIdle = setTimeout(() => { if (!llmPending.size && llm) { llm.terminate(); llm = null; llmReady = null; } }, 15 * 60 * 1000);
  });
}

let asstBusy = false;
let asstAbort = null;

/** Messages d'erreur du moteur local, en clair. */
function llmError(e) {
  const t = String(e?.message || e);
  if (e?.detail) return e;
  if (/bad_alloc|out of memory|OOM|memory/i.test(t)) return new Error('Mémoire insuffisante pour faire tourner ce modèle sur cet appareil.');
  if (/fetch|network|Failed to load/i.test(t)) return new Error('Téléchargement du modèle impossible (connexion, ou Hugging Face bloqué par le réseau).');
  return new Error(`Le modèle local a rencontré une erreur : ${t.slice(0, 160)}`);
}

async function answerLocal(messages, opts) {
  const tries = localCandidates();
  let lastErr = null;
  const errors = [];
  for (let k = 0; k < tries.length; k++) {
    const m = tries[k];
    try {
      const text = await answerLocalWith(m, messages, opts, k > 0);
      if (text != null && k > 0) opts.onNote?.(`${tries[0].label} n’a pas pu démarrer sur cet appareil : réponse de ${m.label}${m.light ? ' (modèle léger, réponses plus approximatives)' : ''}.`);
      return text;
    } catch (e) {
      lastErr = e;
      const raw = String(e?.message || e);
      if (llm) { llm.terminate(); llm = null; llmReady = null; }
      // Un problème de réseau n'est pas un échec du modèle : on s'arrête là, on pourra réessayer
      if (/fetch|network|Failed to load|ERR_|timeout/i.test(raw)) {
        const err = new Error(`Téléchargement de ${m.label} interrompu (connexion ?). Repose ta question pour reprendre.`);
        err.detail = `${m.repo} · ${m.device} · ${m.dtype} — ${raw.slice(0, 300)}`;
        throw err;
      }
      lsSet(`assistant.failed.${m.key}`, raw.slice(0, 300));
      errors.push(`${m.label} (${m.device}, ${m.dtype}) : ${raw.slice(0, 220)}`);
      if (k < tries.length - 1) opts.onStatus(`${m.label} n’a pas pu démarrer (${llmError(e).message.replace(/\.$/, '')}) : essai avec ${tries[k + 1].label}…`);
    }
  }
  const err = llmError(lastErr);
  err.message = `Aucun modèle local n’a pu démarrer sur cet appareil : je passe en recherche simple. Envoie-moi le détail ci-dessous, ou choisis Claude dans Paramètres → Assistant IA.`;
  err.detail = `${caps().adapter || 'Pas de carte graphique'} · f16 ${caps().f16 ? 'oui' : 'non'} · ${errors.join(' | ')}`;
  throw err;
}

async function answerLocalWith(m, messages, { onToken, onStatus }, consented = false) {
  const spec = { repo: m.repo, device: m.device, dtype: m.dtype };
  const { cached } = await llmCall({ type: 'cache-status', ...spec });
  if (!cached && !consented && lsGet('assistant.consent', '') !== `${m.repo}|${m.dtype}`) {
    const ok = await ask('Activer l’assistant IA ?', `L’assistant utilise un modèle de langage qui tourne sur ton appareil : ${m.label} (${fmtMB(m.sizeMB)}), téléchargé une seule fois. Tes réunions ne sont envoyées nulle part.`, `Télécharger (${fmtMB(m.sizeMB)})`);
    if (!ok) return null;
    lsSet('assistant.consent', `${m.repo}|${m.dtype}`);
  }
  onStatus(cached ? `Chargement de ${m.label} et lecture de tes réunions…` : `Téléchargement de ${m.label}…`);
  asstAbort = () => llm?.postMessage({ type: 'stop' });
  let first = true;
  const r = await llmCall({ type: 'chat', ...spec, messages, max: 450 }, {
    onProgress: (p) => onStatus(p.value >= 0.999 && p.total > 50e6 ? `${m.label} prêt : lecture de tes réunions…` : `Téléchargement de ${m.label}… ${Math.round(p.value * 100)} % (${fmtMB(p.loaded / 1e6)} / ${fmtMB(p.total / 1e6)})`),
    onToken: (t) => { if (first) { first = false; onStatus(''); } onToken(t); },
  });
  return r.text;
}

async function answerClaude(messages, { onToken, onStatus }) {
  const key = claudeKey();
  if (!key) throw new Error('Aucune clé API Claude : renseigne-la dans Paramètres → Assistant IA.');
  onStatus('Claude réfléchit…');
  const { default: Anthropic } = await import(CLAUDE_SDK_URL);
  const client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true });
  const model = CLAUDE_MODELS.find((x) => x.id === lsGet('assistant.model', CLAUDE_MODELS[0].id)) || CLAUDE_MODELS[0];
  const [sys, ...rest] = messages;
  const params = {
    model: model.id,
    max_tokens: 4000,
    system: sys.content,
    messages: rest,
    output_config: { effort: 'low' },
  };
  // Si le modèle décline une demande, l'API la relance sur un autre modèle (activé par défaut)
  if (model.fallbacks) Object.assign(params, { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
  const stream = model.fallbacks ? client.beta.messages.stream(params) : client.messages.stream(params);
  asstAbort = () => stream.abort();
  let text = '';
  try {
    for await (const ev of stream) {
      if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
        if (!text) onStatus('');
        text += ev.delta.text;
        onToken(ev.delta.text);
      }
    }
    const final = await stream.finalMessage();
    if (final.stop_reason === 'refusal') throw new Error('Claude a décliné cette demande.');
  } catch (e) {
    if (e instanceof Anthropic.APIUserAbortError) return text;
    if (e instanceof Anthropic.AuthenticationError) throw new Error('Clé API Claude refusée : vérifie-la dans Paramètres → Assistant IA.');
    if (e instanceof Anthropic.PermissionDeniedError) throw new Error('Cette clé API n’a pas accès à ce modèle.');
    if (e instanceof Anthropic.RateLimitError) throw new Error('Trop de demandes à Claude pour l’instant : réessaie dans une minute.');
    if (e instanceof Anthropic.APIConnectionError) throw new Error('Impossible de joindre Claude (connexion internet ?).');
    if (e instanceof Anthropic.APIError) throw new Error(`Erreur de l’API Claude (${e.status ?? '?'}) : ${e.message}`);
    throw e;
  }
  return text;
}

/** Ancienne réponse par mots-clés (moteur « Recherche simple », ou si le modèle n'est pas disponible). */
function keywordAnswer(q, sources, note = '') {
  const openOnly = /reste|à faire|a faire|en cours/i.test(q);
  if (openOnly) sources.forEach((s) => (s.items = s.items.filter((x) => !x.done)));
  const { intent, hits } = searchMeetings(q, sources, { limit: 6 });
  const claudeBtn = '<button class="chat-claude" type="button" data-claude>${CLAUDE_ICON}Demander à Claude</button>';
  if (!hits.length) return `<p>Je n’ai rien trouvé de net dans tes transcriptions. Essaie avec d’autres mots (un nom de projet, un lot, une personne).</p>${note}${claudeBtn}`;
  const lead = intent === 'decision' ? 'Voici les décisions trouvées' : intent === 'action' ? (openOnly ? 'Voici les actions encore à faire' : 'Voici les actions trouvées') : 'Voici les passages les plus proches';
  const li = hits.map((h) => `<li><button type="button" data-open="${esc(h.doc.id)}" data-i="${h.i}">${h.type === 'decision' ? '<i class="tag dec">Décision</i>' : h.type === 'action' ? `<i class="tag act">Action${h.who ? ` · ${esc(h.who)}` : ''}</i>` : ''}${esc(h.text.length > 150 ? h.text.slice(0, 149) + '…' : h.text)}<small>${esc(h.doc.title)} · ${relDay(h.doc.createdAt)} · ${fmtClock(h.start)}</small></button></li>`).join('');
  return `<p><svg class="ok-ico" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.6 2.5L16 9.5"/></svg>${lead} :</p><ul class="chat-hits">${li}</ul>${note}<p class="chat-note">Recherche par mots-clés. ${claudeBtn}</p>`;
}

function setChatBusy(on) {
  asstBusy = on;
  $('#chat-form').classList.toggle('busy', on);
  $('.chat-send').setAttribute('aria-label', on ? 'Arrêter la réponse' : 'Envoyer');
  $('.chat-send').innerHTML = on ? '<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>' : '<svg viewBox="0 0 24 24"><path d="M4 12 20 4l-4 16-4-7z"/><path d="m12 13 8-9"/></svg>';
}

async function askAssistant(q) {
  q = q.trim();
  if (!q || asstBusy) return;
  lastQuestion = q;
  chatAdd('me', esc(q));
  await checkScope();
  const all = (await myDocs()).filter((d) => d.status !== 'running' && d.status !== 'live' && d.segments?.length);
  if (!all.length) return chatAdd('bot', '<p>Tu n’as encore aucune transcription : enregistre une réunion et je pourrai répondre à tes questions.</p>');
  const docs = scopeDocs(all);
  if (!docs.length) return chatAdd('bot', `<p>« ${esc(asstScope.label)} » ne contient aucune transcription. Choisis un autre projet avec la pastille « Sur : … » sous la conversation.</p>`);
  const sources = actionSources(docs);
  const engine = asstEngine();
  if (engine === 'search') return chatAdd('bot', keywordAnswer(q, sources));
  if (engine === 'auto' && (!caps().webgpu || !localCandidates().length))
    return chatAdd('bot', keywordAnswer(q, sources, '<p class="chat-note">Sans carte graphique compatible, je fais une recherche dans tes réunions. Pour des réponses rédigées : Claude (clé API) ou le modèle léger, dans Paramètres → Assistant IA.</p>'));
  const claude = engine === 'claude';
  const local = !claude && localLlm();
  const { refs, context } = buildContext(q, sources, { budget: claude ? 14000 : local.light ? 3000 : 5000, fill: asstScope.type !== 'all' && docs.length <= 3 });
  // L'échange précédent aide aux questions de suivi, mais embrouille les petits modèles locaux
  const messages = buildMessages(q, context, claude || !local.light ? lastExchange : null);
  // Bulle de réponse mise à jour au fil de l'eau
  chatAdd('bot', '<p class="typing"><i></i><i></i><i></i></p>');
  const bubble = $$('#chat .msg.bot .bubble').pop();
  const status = document.createElement('p');
  status.className = 'chat-status';
  let text = '';
  let raf = 0;
  const paint = () => {
    raf = 0;
    bubble.innerHTML = (text ? renderAnswer(text, refs) : '<p class="typing"><i></i><i></i><i></i></p>');
    if (status.textContent) bubble.append(status);
    $('#chat').scrollTop = $('#chat').scrollHeight;
  };
  const onToken = (t) => { text += t; if (!raf) raf = requestAnimationFrame(paint); };
  const onStatus = (s) => { status.textContent = s; if (!raf) raf = requestAnimationFrame(paint); };
  let note = '';
  const onNote = (n) => { note = n; };
  setChatBusy(true);
  try {
    const out = claude ? await answerClaude(messages, { onToken, onStatus }) : await answerLocal(messages, { onToken, onStatus, onNote });
    if (out == null) { bubble.innerHTML = keywordAnswer(q, sources, '<p class="chat-note">Assistant IA non activé : voici une recherche par mots-clés.</p>'); return; }
    text = out || text;
    if (!text.trim()) text = 'Je n’ai pas pu formuler de réponse. Reformule ta question, ou demande à Claude.';
    status.textContent = '';
    const src = citedRefs(text, refs);
    const engineLabel = claude ? (CLAUDE_MODELS.find((x) => x.id === lsGet('assistant.model', CLAUDE_MODELS[0].id)) || CLAUDE_MODELS[0]).label.replace(/ \(.*/, '') : `${localLlm().label}, sur ton appareil`;
    bubble.innerHTML = renderAnswer(text, refs)
      + (src.length ? `<ul class="chat-src">${src.map((r) => `<li><button type="button" data-open="${esc(r.doc.id)}" data-i="${r.i}"><b>${r.n}</b><span>« ${esc(r.text.length > 110 ? r.text.slice(0, 109) + '…' : r.text)} »<small>${esc(r.doc.title)} · ${relDay(r.doc.createdAt)} · ${fmtClock(r.start)}</small></span></button></li>`).join('')}</ul>` : '')
      + (note ? `<p class="chat-note warn">${esc(note)}</p>` : '')
      + `<p class="chat-note">${esc(engineLabel)} · à vérifier dans les sources.${claude ? '' : ' <button class="chat-claude" type="button" data-claude>${CLAUDE_ICON}Demander à Claude</button>'}</p>`;
    lastExchange = { q, a: text };
    chatLog[chatLog.length - 1].html = bubble.innerHTML;
  } catch (e) {
    console.warn(e);
    bubble.innerHTML = `<p class="chat-err">${esc(e.message || String(e))}</p>${e.detail ? `<details class="chat-detail"><summary>Détail technique</summary><code>${esc(e.detail)}</code></details>` : ''}` + keywordAnswer(q, sources, '');
    chatLog[chatLog.length - 1].html = bubble.innerHTML;
  } finally {
    asstAbort = null;
    setChatBusy(false);
    $('#chat').scrollTop = $('#chat').scrollHeight;
  }
}

/** Paramètres → Assistant IA → Tester : lance le modèle sur une question simple et produit un rapport. */
async function runAssistantTest() {
  const out = $('#asst-report');
  const lines = [];
  const log = (t) => { lines.push(t); out.hidden = false; $('#asst-report pre').textContent = lines.join('\n'); };
  const c = caps();
  log(`Navigateur : ${navigator.userAgent.match(/(Edg|Chrome|Firefox|Safari)\/[\d.]+/g)?.join(' ') || navigator.userAgent.slice(0, 80)}`);
  log(`Carte graphique : ${c.webgpu ? c.adapter || 'oui' : 'non disponible'}${c.softwareGpu ? ' (logicielle)' : ''} · demi-précision (f16) : ${c.f16 ? 'oui' : 'non'} · tampon max : ${c.maxBufferMB ?? '?'} Mo · mémoire : ${navigator.deviceMemory ?? '?'} Go · cœurs : ${navigator.hardwareConcurrency ?? '?'}`);
  const engine = asstEngine();
  log(`Moteur choisi : ${engine}`);
  if (engine === 'claude' || engine === 'search') return log('Le test concerne le modèle local : choisis « Local » dans le menu Moteur.');
  const tries = localCandidates();
  if (!tries.length) return log('Pas de carte graphique compatible : en automatique, l’assistant fait une recherche simple. Choisis « Local léger » pour tester le modèle sur le processeur.');
  $('#asst-test').disabled = true;
  for (const [k, m] of tries.entries()) {
    const t0 = performance.now();
    log(`→ ${m.label} · ${m.device} · ${m.dtype} (${fmtMB(m.sizeMB)})…`);
    try {
      let first = 0;
      let txt = '';
      const r = await answerLocalWith(m, [{ role: 'system', content: 'Réponds en un seul mot.' }, { role: 'user', content: 'Dis simplement : bonjour' }], {
        onToken: (t) => { if (!first) first = performance.now(); txt += t; },
        onStatus: (s) => { if (s) $('#asst-report small').textContent = s; },
      }, k > 0);
      if (r == null) { log('  annulé (téléchargement refusé).'); break; }
      log(`  ✓ OK en ${((performance.now() - t0) / 1000).toFixed(1)} s (1er mot après ${first ? ((first - t0) / 1000).toFixed(1) : '?'} s) : « ${(r || txt).trim().slice(0, 40)} »`);
      lsSet(`assistant.failed.${m.key}`, '');
      localStorage.removeItem(`assistant.failed.${m.key}`);
      break;
    } catch (e) {
      log(`  ✗ échec : ${String(e?.message || e).slice(0, 400)}`);
      if (!/fetch|network|Failed to load|ERR_|timeout/i.test(String(e?.message))) lsSet(`assistant.failed.${m.key}`, String(e?.message || e).slice(0, 300));
      if (llm) { llm.terminate(); llm = null; llmReady = null; }
    }
  }
  $('#asst-report small').textContent = '';
  $('#asst-test').disabled = false;
  renderAssistantSettings();
}

/** Paramètres → Assistant IA */
function renderAssistantSettings() {
  const sel = $('#asst-engine');
  if (!sel) return;
  sel.value = asstEngine();
  const isClaude = sel.value === 'claude';
  $('#asst-claude').hidden = !isClaude;
  $('#asst-model').value = lsGet('assistant.model', CLAUDE_MODELS[0].id);
  $('#asst-key').value = claudeKey() ? '••••••••••••' : '';
  const m = localLlm();
  const fails = Object.keys(localStorage).filter((k) => k.startsWith('assistant.failed.')).map((k) => `${k.slice(17)} : ${localStorage.getItem(k)}`);
  const failed = fails.join(' | ');
  const noGpu = !caps().webgpu;
  $('#asst-retry').hidden = !failed;
  $('#asst-fail').hidden = !failed;
  $('#asst-fail').textContent = failed ? `Échecs mémorisés : ${failed}` : '';
  $('#asst-info').textContent = sel.value === 'search' ? 'Recherche par mots-clés dans tes réunions, sans modèle de langage.'
    : sel.value === 'auto' && caps().webgpu && !localCandidates().length ? 'Aucun modèle local n’a pu démarrer sur cette carte graphique : recherche dans tes réunions, sans réponse rédigée. Lance le test pour voir pourquoi, ou choisis Claude.'
    : sel.value === 'auto' && failed && m.light ? `${m.label} sur la carte graphique (le modèle plus précis n’a pas pu démarrer). Réponses plus approximatives ; réessaie ou choisis Claude.`
    : sel.value === 'auto' && noGpu ? 'Pas de carte graphique compatible détectée : recherche dans tes réunions, sans réponse rédigée. Pour des réponses rédigées, choisis Claude (le plus fiable) ou le modèle local léger (expérimental, réponses approximatives).'
    : sel.value === 'local-small' ? `${m.label} (${fmtMB(m.sizeMB)}), sur ${m.device === 'webgpu' ? 'la carte graphique' : 'le processeur'}. Expérimental : petit modèle, réponses parfois approximatives ; vérifie dans les sources.${m.device === 'wasm' ? ' 20 s à 2 min par réponse.' : ''}`
    : isClaude ? 'Les extraits utiles de tes réunions et ta question sont envoyés à Claude (Anthropic) via ta clé API. Facturé à l’usage sur ton compte Anthropic.'
    : `${m.label} (${fmtMB(m.sizeMB)}), sur ${m.device === 'webgpu' ? 'la carte graphique' : 'le processeur'}. Rien ne quitte ton appareil.${m.device === 'wasm' ? ' Sans carte graphique, une réponse prend de 20 s à 1 min.' : ''}`;
}

function bindAssistantSettings() {
  const sel = $('#asst-engine');
  if (!sel) return;
  // Anciens échecs (avant la chaîne de repli) : on retente avec la nouvelle logique
  localStorage.removeItem('assistant.largeFailed');
  $('#asst-model').innerHTML = CLAUDE_MODELS.map((m) => `<option value="${m.id}">${esc(m.label)}</option>`).join('');
  sel.onchange = () => { lsSet('assistant.engine', sel.value); renderAssistantSettings(); };
  $('#asst-model').onchange = (e) => lsSet('assistant.model', e.target.value);
  $('#asst-key').onfocus = (e) => { if (e.target.value.startsWith('•')) e.target.value = ''; };
  $('#asst-key').onchange = (e) => {
    const v = e.target.value.trim();
    if (v.startsWith('•')) return;
    lsSet('assistant.key', v);
    renderAssistantSettings();
    toast(v ? 'Clé API enregistrée dans ce navigateur.' : 'Clé API effacée.', 'ok', 3000);
  };
  $('#asst-retry').onclick = () => {
    Object.keys(localStorage).filter((k) => k.startsWith('assistant.failed.') || k === 'assistant.largeFailed').forEach((k) => localStorage.removeItem(k));
    renderAssistantSettings();
    toast('Échecs oubliés : pose ta question à l’assistant (ou lance le test) pour réessayer.', 'ok', 4000);
  };
  $('#asst-test').onclick = runAssistantTest;
  $('#asst-report-copy').onclick = async () => { await writeClipboard($('#asst-report pre').textContent); toast('Rapport copié : colle-le dans la conversation.', 'ok', 3000); };
  $('#asst-key-clear').onclick = () => { lsSet('assistant.key', ''); renderAssistantSettings(); toast('Clé API effacée.', 'ok', 2500); };
  renderAssistantSettings();
}

/** Claude : la question + les transcriptions les plus utiles (dans la limite d'une consigne raisonnable). */
async function askClaudeAbout(q) {
  const docs = scopeDocs((await myDocs()).filter((d) => d.segments?.length));
  const { hits } = searchMeetings(q, actionSources(docs), { limit: 20 });
  const ids = [...new Set(hits.map((h) => h.doc.id))];
  const pick = [...ids.map((id) => docs.find((d) => d.id === id)), ...docs].filter((d, i, a) => d && a.indexOf(d) === i).slice(0, 5);
  let budget = 60000;
  const parts = [];
  for (const d of pick) {
    const txt = toTxt(d.segments, { timestamps: false, speakers: (d.speakers || []).map((p) => p.name) });
    if (budget <= 2000) break;
    const cut = txt.slice(0, budget);
    budget -= cut.length;
    parts.push(`<reunion titre="${d.title.replace(/"/g, "'")}" date="${new Date(d.createdAt).toLocaleDateString('fr-FR')}">\n${cut}\n</reunion>`);
  }
  const prompt = `Voici des transcriptions automatiques de mes réunions (elles peuvent contenir des erreurs de reconnaissance). Réponds à ma question en t’appuyant uniquement sur leur contenu, en citant la réunion et la date. Si l’information n’y est pas, dis-le.\n\nQuestion : ${q}\n\n${parts.join('\n\n')}`;
  await openInClaude(prompt);
}

function bindDashboard() {
  $('#dash-new').onclick = () => { setView('record'); selectTab('mic'); };
  $('#dash-import').onclick = () => { setView('record'); selectTab('file'); $('#file-input').click(); };
  $('#dash-recent').addEventListener('click', async (e) => {
    const row = e.target.closest('.recent-row');
    if (!row) return;
    const act = e.target.closest('[data-act]')?.dataset.act || 'open';
    const d = (await myDocs()).find((x) => x.id === row.dataset.doc);
    if (!d) return;
    if (act === 'more') return openRecentMenu(e.target.closest('[data-act]'), d);
    openDoc(d);
    if (act === 'play' && d.audioId) {
      const t0 = Date.now();
      const tick = () => {
        if (state.audio?.audioId === d.audioId && player?.loaded) player.audio.play().catch(() => {});
        else if (Date.now() - t0 < 8000) setTimeout(tick, 150);
      };
      tick();
    }
  });
  $('#dash-recent').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.classList.contains('recent-row')) e.target.click(); });
  $('#quick-range').onchange = () => renderQuick();
  $('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (asstBusy) return asstAbort?.();
    const q = $('#chat-input').value;
    $('#chat-input').value = '';
    askAssistant(q);
  });
  $('#chat').addEventListener('click', async (e) => {
    const s = e.target.closest('[data-q]');
    if (s) return askAssistant(s.dataset.q);
    if (e.target.closest('[data-claude]')) return askClaudeAbout(lastQuestion);
    const o = e.target.closest('[data-open]');
    if (!o) return;
    const d = (await myDocs()).find((x) => x.id === o.dataset.open);
    if (!d) return;
    openDoc(d);
    const i = Number(o.dataset.i);
    requestAnimationFrame(() => {
      const row = $$('#transcript .segment')[i];
      row?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      row?.classList.add('flash');
      setTimeout(() => row?.classList.remove('flash'), 1300);
    });
  });
  $$('#an-range [data-range]').forEach((b) => (b.onclick = () => {
    $$('#an-range [data-range]').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
    renderAnalytics();
  }));
  $('#an-actions').addEventListener('click', async (e) => {
    const o = e.target.closest('[data-open]');
    if (!o) return;
    const d = (await myDocs()).find((x) => x.id === o.dataset.open);
    if (d) { openDoc(d); setDocTab('actions'); }
  });
  $('#models-page').addEventListener('click', (e) => {
    const b = e.target.closest('[data-use]');
    if (!b) return;
    const r = $(`#models input[value="${b.dataset.use}"]`);
    if (!r || r.disabled) return;
    r.checked = true;
    r.dispatchEvent(new Event('change', { bubbles: true }));
    store.set('model.manual', '1');
    renderAutoInfo();
    renderModelsPage();
    toast(`Modèle « ${modelById(b.dataset.use).label} » choisi pour les prochaines transcriptions.`, 'ok', 3500);
  });
  $$('.dash-close').forEach((b) => (b.onclick = () => toggleSheet(false)));
  // Ctrl + K : recherche
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#hist-search').focus(); }
  });
  renderChat();
  bindAssistantSettings();
  bindPerso();
  bindScope();
  initSpaces();
}

function openRecentMenu(btn, d) {
  $('#recent-pop')?.remove();
  const pop = document.createElement('div');
  pop.id = 'recent-pop';
  pop.className = 'recent-pop';
  pop.innerHTML = `<button type="button" data-m="open">Ouvrir</button><button type="button" data-m="actions">Décisions et actions</button><button type="button" data-m="claude">${CLAUDE_ICON}Résumer avec Claude</button><button type="button" data-m="ask">Interroger l’assistant</button>`;
  document.body.appendChild(pop);
  const r = btn.getBoundingClientRect();
  pop.style.top = `${Math.min(innerHeight - 140, r.bottom + 6)}px`;
  pop.style.left = `${Math.max(12, r.right - 210)}px`;
  const close = (e) => { if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener('pointerdown', close, true); } };
  setTimeout(() => document.addEventListener('pointerdown', close, true));
  pop.onclick = (e) => {
    const m = e.target.closest('[data-m]')?.dataset.m;
    if (!m) return;
    pop.remove();
    if (m === 'ask') {
      setScope({ type: 'doc', id: d.id, label: d.title });
      if (matchMedia('(max-width: 760px)').matches) toggleSheet(true);
      return;
    }
    openDoc(d);
    if (m === 'actions') setDocTab('actions');
    if (m === 'claude') setTimeout(() => sendToClaude(), 50);
  };
}

// ---------- Page Analyses ----------
async function renderAnalytics() {
  const docs = await myDocs();
  const range = $('#an-range [aria-selected="true"]')?.dataset.range || 'month';
  const sel = docs.filter((d) => d.createdAt >= periodStart(range));
  const secs = sel.reduce((a, d) => a + (d.durationS || 0), 0);
  const src = actionSources(sel);
  const acts = src.flatMap((s) => s.items.filter((x) => x.type === 'action').map((x) => ({ ...x, doc: s.doc })));
  const decs = src.reduce((a, s) => a + s.items.filter((x) => x.type === 'decision').length, 0);
  const open = acts.filter((x) => !x.done);
  $('#an-stats').innerHTML = [
    statTile('t-violet', STAT_ICONS.docs, String(sel.length), sel.length > 1 ? 'Transcriptions' : 'Transcription'),
    statTile('t-blue', STAT_ICONS.time, secs ? fmtHours(secs) : '0 h', 'Audio traité'),
    statTile('t-indigo', STAT_ICONS.check, `${acts.length - open.length}/${acts.length}`, 'Actions faites'),
    statTile('t-amber', STAT_ICONS.star, String(decs), decs > 1 ? 'Décisions' : 'Décision'),
  ].join('');
  // Semaines
  const weeks = weeklyMinutes(docs, 8);
  const wmax = Math.max(...weeks.map((w) => w.minutes), 1);
  $('#an-weeks').innerHTML = weeks.map((w) => `<div class="an-bar" title="${w.count} transcription${w.count > 1 ? 's' : ''} · ${fmtShortDur(w.minutes * 60)}"><span style="height:${Math.max(2, (w.minutes / wmax) * 100)}%"></span><small>${new Date(w.week).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })}</small><b>${w.minutes ? fmtShortDur(w.minutes * 60) : ''}</b></div>`).join('');
  // Intervenants
  const sp = speakerTotals(sel);
  const stot = sp.reduce((a, p) => a + p.seconds, 0) || 1;
  $('#an-speakers').innerHTML = sp.length
    ? `<ul class="an-list">${sp.slice(0, 8).map((p, i) => `<li style="--spk:${p.unknown ? 'rgb(var(--ov) / 0.35)' : speakerColor(i)}"><span><i class="dot"></i>${esc(p.name)}</span><div class="bar-in"><i style="width:${Math.round((p.seconds / stot) * 100)}%"></i></div><b>${fmtShortDur(p.seconds)}</b></li>`).join('')}</ul>`
    : '<p class="dash-empty">Pas encore d’intervenants reconnus sur cette période.</p>';
  // Sujets
  const tp = topicShares(sel);
  $('#an-topics').innerHTML = tp.length
    ? `<div class="ins-topics big"><svg class="mini-donut" viewBox="0 0 42 42" aria-hidden="true">${donutSvg(tp.map((t) => t.share), TOPIC_COLORS)}</svg><ul class="legend">${tp.map((t, i) => `<li style="--spk:${TOPIC_COLORS[i]}"><i class="dot"></i><span>${esc(t.label)}</span><b>${Math.round(t.share * 100)} %</b></li>`).join('')}</ul></div><p class="an-note">D’après les mots-clés entendus (BIM, technique, organisation, chantier).</p>`
    : '<p class="dash-empty">Pas assez de texte sur cette période.</p>';
  // Actions en cours
  $('#an-actions-sum').textContent = acts.length ? `${open.length} à faire sur ${acts.length}` : '';
  $('#an-actions').innerHTML = open.length
    ? `<ul class="an-acts">${open.slice(0, 30).map((x) => `<li><button type="button" data-open="${esc(x.doc.id)}"><span class="a-txt">${esc(x.text)}</span><span class="a-meta">${x.who ? `<i class="act-who"><i class="dot"></i>${esc(x.who)}</i>` : ''}${x.date ? `<i class="act-due">${esc(x.date.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' }))}</i>` : ''}<small>${esc(x.doc.title)} · ${relDay(x.doc.createdAt)}</small></span></button></li>`).join('')}</ul>`
    : `<p class="dash-empty">${acts.length ? 'Tout est fait sur cette période. 👏' : 'Aucune action repérée sur cette période.'}</p>`;
}

// ======================================================================
// Espaces collaboratifs (Supabase)
// ======================================================================
const spState = { me: null, spaces: [], current: lsGet('spaces.current', ''), members: [], docs: [], loading: false };
const SP_PEOPLE = '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><circle cx="17" cy="9" r="2.5"/><path d="M16 14.2a5 5 0 0 1 5.5 5.8"/></svg>';
const spErr = (e) => toast(spacesError(e), 'err', 7000);

async function renderSpaces() {
  const setup = $('#spc-setup'), login = $('#spc-login'), main = $('#spc-main');
  if (!setup) return;
  setup.hidden = login.hidden = main.hidden = true;
  if (!Spaces.configured() && !window.__spacesClient) { setup.hidden = false; renderSpacesSetup(); return; }
  try { spState.me = await Spaces.user(); } catch (e) { spState.me = null; spErr(e); }
  if (!spState.me) { login.hidden = false; return; }
  main.hidden = false;
  $('#spc-me').innerHTML = `${avatarHtml(spState.me)}<span><b>${esc(spState.me.name)}</b><small>${esc(spState.me.email)}</small></span>`;
  await loadSpaces();
}

function renderSpacesSetup() {
  $('#spc-url').value = Spaces.url();
  $('#spc-key').value = Spaces.key() ? '••••••••••••' : '';
  $('#spc-redirect').textContent = location.origin + location.pathname;
}

async function loadSpaces() {
  try { spState.spaces = await Spaces.list(); } catch (e) { spState.spaces = []; spErr(e); }
  if (!spState.spaces.some((s) => s.id === spState.current)) spState.current = spState.spaces[0]?.id || '';
  lsSet('spaces.current', spState.current);
  renderSpaceList();
  await loadSpace();
}

function renderSpaceList() {
  const list = $('#spc-list');
  list.innerHTML = spState.spaces.length
    ? spState.spaces.map((s) => `<button type="button" class="spc-item${s.id === spState.current ? ' active' : ''}" data-space="${esc(s.id)}"><span class="spc-ico">${SP_PEOPLE}</span><span class="spc-txt"><b>${esc(s.name)}</b><small>${s.members} membre${s.members > 1 ? 's' : ''} · ${s.docs} réunion${s.docs > 1 ? 's' : ''}</small></span>${s.owner === spState.me?.id ? '<i class="spc-own" title="Tu es propriétaire">Propriétaire</i>' : ''}</button>`).join('')
    : '<p class="dash-empty sm">Aucun espace pour l’instant. Crée le premier, ou demande à quelqu’un de t’inviter avec ton adresse.</p>';
}

async function loadSpace() {
  const box = $('#spc-content');
  const s = spState.spaces.find((x) => x.id === spState.current);
  if (!s) { box.innerHTML = `<div class="glass dash-card spc-empty"><span class="r-ico violet">${SP_PEOPLE}</span><b>Crée ton premier espace</b><small>Un espace = un groupe de personnes qui partagent des réunions : un projet, une équipe, la famille…</small><button class="btn primary" type="button" data-spc="new">Nouvel espace</button></div>`; return; }
  box.innerHTML = '<p class="dash-empty">Chargement…</p>';
  try { [spState.members, spState.docs] = await Promise.all([Spaces.members(s.id), Spaces.docs(s.id)]); } catch (e) { spErr(e); spState.members = []; spState.docs = []; }
  if (spState.current !== s.id) return;
  const own = s.owner === spState.me?.id;
  const used = spState.docs.reduce((a, d) => a + (d.audio_bytes || 0), 0);
  box.innerHTML = `
    <section class="glass dash-card spc-head">
      <div><h3>${esc(s.name)}</h3><small>${own ? 'Tu es propriétaire' : 'Tu es membre'} · ${spState.docs.length} réunion${spState.docs.length > 1 ? 's' : ''}${used ? ` · ${fmtBytes(used)} d’audio` : ''}</small></div>
      <div class="spc-acts">
        <button class="btn primary sm" type="button" data-spc="share"><svg viewBox="0 0 24 24"><path d="M12 15V4m0 0-4 4m4-4 4 4"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>Partager une transcription</button>
        ${own ? '<button class="icon-btn" type="button" data-spc="rename" title="Renommer l’espace" aria-label="Renommer l’espace"><svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg></button><button class="icon-btn danger" type="button" data-spc="delete" title="Supprimer l’espace" aria-label="Supprimer l’espace"><svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg></button>'
        : '<button class="btn sm ghost" type="button" data-spc="leave">Quitter l’espace</button>'}
      </div>
    </section>
    <section class="glass dash-card">
      <header class="dash-head"><h3>${SP_PEOPLE}Membres <small class="dash-sub">${spState.members.length}</small></h3></header>
      <div class="spc-members">${spState.members.map((m) => `<span class="spc-member"><i style="--spk:${speakerColor([...m.email].reduce((a, c) => a + c.charCodeAt(0), 0))}">${esc(initials(m.email.split('@')[0]))}</i><span>${esc(m.email)}${m.email === spState.me?.email ? ' (toi)' : ''}</span>${m.role === 'owner' ? '<b>propriétaire</b>' : own ? `<button type="button" class="spc-x" data-remove="${esc(m.email)}" title="Retirer" aria-label="Retirer ${esc(m.email)}"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>` : ''}</span>`).join('')}</div>
      ${own ? `<form class="spc-invite" id="spc-invite"><input type="email" class="text-input" id="spc-email" placeholder="adresse@gmail.com" required autocomplete="off" /><button class="btn sm" type="submit">Inviter</button></form><p class="an-note">La personne voit l’espace dès qu’elle se connecte ici avec cette adresse Google. Aucun e-mail n’est envoyé : préviens-la avec « Copier l’invitation ».</p>` : ''}
    </section>
    <section class="spc-docs">${spState.docs.length ? spState.docs.map((d) => spaceDocCard(d, own)).join('') : '<div class="hist-empty"><span class="r-ico violet">' + STAT_ICONS.docs + '</span><b>Aucune réunion partagée</b><small>« Partager une transcription » envoie le texte et, si tu veux, l’audio compressé.</small></div>'}</section>`;
}

function spaceDocCard(d, own) {
  const [tone, icon] = docIcon(d.title);
  const mine = d.created_by === spState.me?.id;
  return `<article class="glass proj-card spc-doc" data-sdoc="${esc(d.id)}" tabindex="0">
    <div class="pc-top"><span class="r-ico ${tone}">${icon}</span><div class="pc-title"><strong>${esc(d.title)}</strong><small>par ${esc(mine ? 'toi' : d.author_name || d.author_email || 'un membre')} · ${relDay(new Date(d.created_at).getTime())}</small></div>
      ${mine || own ? `<button class="icon-btn danger pc-del" type="button" data-unshare="${esc(d.id)}" title="Retirer de l’espace" aria-label="Retirer de l’espace"><svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg></button>` : ''}</div>
    <div class="pc-chips">${d.duration_s ? `<span><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>${fmtShortDur(d.duration_s)}</span>` : ''}${d.audio_path ? `<span><svg viewBox="0 0 24 24"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>audio ${fmtBytes(d.audio_bytes || 0)}</span>` : '<span>texte seul</span>'}</div>
    <div class="pc-foot"><span class="an-note">Ouvrir en fait une copie dans « Mes projets ».</span><span class="pc-open" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg></span></div>
  </article>`;
}

/** Partage : choix d'une transcription, compression de l'audio, envoi. */
async function shareToSpace() {
  const s = spState.spaces.find((x) => x.id === spState.current);
  if (!s) return;
  const docs = (await myDocs()).filter((d) => d.segments?.length && d.status !== 'running' && d.status !== 'live' && !d.fromSpace);
  if (!docs.length) return toast('Aucune transcription à partager pour l’instant.', 'warn');
  tool.open(`Partager dans « ${s.name} »`);
  const pick = await tool.show({
    step: 'Choix de la transcription',
    html: `<p>Les membres de l’espace verront le texte, les intervenants et, si tu le coches, l’audio. Ces données seront stockées sur le serveur de l’espace.</p>
      <div class="cl-types spc-pick">${docs.slice(0, 40).map((d, i) => `<label class="cl-type"><input type="radio" name="spc-doc" value="${esc(d.id)}"${i ? '' : ' checked'} /><span><strong>${esc(d.title)}</strong><small>${relDay(d.createdAt)}${d.durationS ? ` · ${fmtShortDur(d.durationS)}` : ''}${d.audioId ? '' : ' · sans audio'}</small></span></label>`).join('')}</div>
      <label class="modal-check"><input type="checkbox" id="spc-with-audio" checked /><span>Inclure l’audio, compressé en qualité voix (≈ 11 Mo par heure)</span></label>`,
    actions: [{ label: 'Annuler', value: null }, { label: 'Partager', value: true, primary: true }],
  });
  if (!pick) return;
  const id = document.querySelector('input[name="spc-doc"]:checked')?.value;
  const withAudio = $('#spc-with-audio').checked;
  const d = docs.find((x) => x.id === id);
  if (!d) return tool.close();
  const step = (t) => tool.show({ step: 'Envoi', html: `<p>${esc(t)}</p>` });
  try {
    let blob = null;
    if (withAudio && d.audioId) {
      step('Préparation de l’audio…');
      const rec = await getAudio(d.audioId);
      if (rec?.blob) {
        if (canEncodeOpus()) {
          const pcm = await decodeToMono16k(rec.blob);
          blob = await encodeOggOpus(pcm, { onProgress: (v) => ($('#tool-body').innerHTML = `<p>Compression de l’audio… ${Math.round(v * 100)} %</p>`) });
        } else if (rec.blob.size < 45e6) blob = rec.blob;
        else toast('Audio trop lourd pour ce navigateur : seul le texte est partagé.', 'warn', 6000);
      }
    }
    if (blob && blob.size > 50 * 1048576) { toast('Audio trop lourd même compressé (> 50 Mo) : seul le texte est partagé.', 'warn', 6000); blob = null; }
    step(blob ? `Envoi (${fmtBytes(blob.size)})…` : 'Envoi du texte…');
    await Spaces.share(s.id, d, blob, spState.me);
    tool.close();
    toast(`« ${d.title} » partagée dans « ${s.name} ».`, 'ok', 4000);
    await loadSpaces();
  } catch (e) {
    tool.close();
    spErr(e);
  }
}

/** Ouvre une transcription d'un espace : copie dans « Mes projets » (avec son audio), puis ouverture. */
async function openSpaceDoc(id) {
  const localId = `sp-${id}`;
  let local = await History.get(localId).catch(() => null);
  if (!local) {
    try {
      toast('Récupération de la transcription partagée…', 'info', 2500);
      const row = await Spaces.doc(id);
      const s = spState.spaces.find((x) => x.id === row.space_id);
      let audioId = null;
      if (row.audio_path) {
        const blob = await Spaces.audio(row.audio_path);
        audioId = newId();
        await Audios.put({ id: audioId, blob, name: `${row.title}.ogg`, durationS: row.duration_s || undefined, createdAt: Date.now() });
      }
      local = {
        ...row.doc, id: localId, audioId, folderId: null, owner: Auth.user()?.email || undefined,
        fromSpace: { spaceId: row.space_id, name: s?.name || 'Espace', by: row.author_name || row.author_email || '' },
        title: row.title, createdAt: row.doc.createdAt || new Date(row.created_at).getTime(), status: 'done',
      };
      await History.put(local);
    } catch (e) { return spErr(e); }
  }
  openDoc(local);
}

function bindSpaces() {
  // Configuration
  $('#spc-save').onclick = () => {
    const url = $('#spc-url').value.trim();
    const key = $('#spc-key').value.trim();
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.(co|in)\/?$/i.test(url)) return toast('Adresse attendue : https://xxxx.supabase.co', 'warn', 5000);
    if (!key.startsWith('•') && key.length < 20) return toast('Clé publique (anon / publishable) attendue.', 'warn', 5000);
    if (/service_role/i.test(key)) return toast('Ne mets jamais la clé « service_role » ici : utilise la clé « anon » / « publishable ».', 'err', 7000);
    Spaces.setConfig(url, key.startsWith('•') ? Spaces.key() : key);
    toast('Projet Supabase enregistré.', 'ok', 2500);
    renderSpaces();
  };
  $('#spc-copy-sql').onclick = async () => {
    try {
      const sql = await (await fetch('supabase/schema.sql', { cache: 'no-cache' })).text();
      await writeClipboard(sql);
      toast('Script SQL copié : colle-le dans Supabase → SQL Editor, puis « Run ».', 'ok', 6000);
    } catch { toast('Copie impossible : ouvre supabase/schema.sql sur GitHub.', 'err', 5000); }
  };
  $('#spc-copy-redirect').onclick = () => writeClipboard($('#spc-redirect').textContent).then(() => toast('Adresse copiée.', 'ok', 2000));
  $('#spc-signin').onclick = () => Spaces.signIn(Auth.user()?.email || '').catch(spErr);
  $('#spc-signout').onclick = async () => { await Spaces.signOut().catch(() => {}); spState.me = null; renderSpaces(); };
  $('#spc-new').onclick = () => newSpace();
  $('#spc-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-space]');
    if (!b) return;
    spState.current = b.dataset.space;
    lsSet('spaces.current', spState.current);
    renderSpaceList();
    loadSpace();
  });
  $('#spc-content').addEventListener('click', async (e) => {
    const s = spState.spaces.find((x) => x.id === spState.current);
    const act = e.target.closest('[data-spc]')?.dataset.spc;
    if (act === 'new') return newSpace();
    if (act === 'share') return shareToSpace();
    if (act === 'rename') {
      const n = await askText('Renommer l’espace', 'Nom', s.name, 'Renommer');
      if (n) { await Spaces.rename(s.id, n).catch(spErr); loadSpaces(); }
      return;
    }
    if (act === 'delete') {
      if (!(await ask(`Supprimer « ${s.name} » ?`, 'Les réunions partagées et leur audio seront effacés du serveur pour tous les membres. Les copies déjà ouvertes dans « Mes projets » restent.', 'Supprimer', { danger: true }))) return;
      await Spaces.remove(s.id).catch(spErr);
      spState.current = '';
      return loadSpaces();
    }
    if (act === 'leave') {
      if (!(await ask(`Quitter « ${s.name} » ?`, 'Tu ne verras plus cet espace, sauf si on t’invite à nouveau.', 'Quitter', { danger: true }))) return;
      await Spaces.removeMember(s.id, spState.me.email).catch(spErr);
      spState.current = '';
      return loadSpaces();
    }
    const rm = e.target.closest('[data-remove]');
    if (rm) {
      if (!(await ask('Retirer ce membre ?', `${rm.dataset.remove} ne verra plus « ${s.name} ».`, 'Retirer', { danger: true }))) return;
      await Spaces.removeMember(s.id, rm.dataset.remove).catch(spErr);
      return loadSpace();
    }
    const un = e.target.closest('[data-unshare]');
    if (un) {
      const row = spState.docs.find((d) => d.id === un.dataset.unshare);
      if (!(await ask('Retirer cette réunion de l’espace ?', `« ${row.title} » et son audio seront effacés du serveur. Ta transcription d’origine ne change pas.`, 'Retirer', { danger: true }))) return;
      await Spaces.unshare(row).catch(spErr);
      return loadSpaces();
    }
    const card = e.target.closest('[data-sdoc]');
    if (card) openSpaceDoc(card.dataset.sdoc);
  });
  $('#spc-content').addEventListener('submit', async (e) => {
    if (e.target.id !== 'spc-invite') return;
    e.preventDefault();
    const s = spState.spaces.find((x) => x.id === spState.current);
    const email = $('#spc-email').value.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return toast('Adresse e-mail invalide.', 'warn');
    try {
      await Spaces.invite(s.id, email);
      const msg = `Je t’ai invité(e) dans l’espace « ${s.name} » sur Transcripteur IA : ${location.origin + location.pathname} — onglet « Espaces », connecte-toi avec ${email}.`;
      toast(`${email} invité(e).`, 'ok', 3000);
      await loadSpace();
      const ok = await ask('Prévenir la personne ?', msg, 'Copier l’invitation');
      if (ok) { await writeClipboard(msg); toast('Invitation copiée : colle-la dans un message.', 'ok', 4000); }
    } catch (err) { spErr(err); }
  });
}

async function newSpace() {
  const n = await askText('Nouvel espace', 'Nom (ex. « Projet Ledona », « Famille »)', '', 'Créer');
  if (!n) return;
  try {
    const s = await Spaces.create(n);
    spState.current = s.id;
    lsSet('spaces.current', s.id);
    await loadSpaces();
  } catch (e) { spErr(e); }
}

/** Au démarrage : retour de la connexion Google de l'espace collaboratif. */
async function initSpaces() {
  bindSpaces();
  const q = new URLSearchParams(location.search);
  if (lsGet('transcripteur.spaces.pending', '') === '1' && q.has('error')) {
    localStorage.removeItem('transcripteur.spaces.pending');
    toast(`Connexion à l’espace collaboratif refusée : ${q.get('error_description') || q.get('error')}`, 'err', 8000);
    history.replaceState(null, '', location.pathname);
    return;
  }
  if (Spaces.configured() && Spaces.isAuthReturn()) {
    try { await Spaces.finishSignIn(); setView('spaces'); toast('Connecté à l’espace collaboratif.', 'ok', 3000); } catch (e) { spErr(e); }
  }
}

// ---------- Page Personnalisation ----------
const PLUS_ICON = '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>';
function setPerso(patch) {
  const p = { ...loadPerso(), ...patch };
  p.css = (BACKGROUNDS.find((b) => b.id === p.bg) || BACKGROUNDS[0]).css;
  // Gardé tout calculé pour le petit script en tête de page (couleur appliquée avant l'affichage)
  p.accentVars = p.accent ? accentVars(p.accent) : null;
  savePerso(p);
  applyPerso(p);
  applyThemeColors();
  renderPerso();
}

function renderPerso() {
  const grid = $('#bg-grid');
  if (!grid) return;
  const p = loadPerso();
  const img = customImage();
  grid.innerHTML = BACKGROUNDS.map((b) => `<button class="bg-tile${p.bg === b.id ? ' active' : ''}" type="button" data-bg="${b.id}"><span class="sw${b.id === 'uni' ? ' uni' : ''}" style="${b.id === 'uni' ? '' : `background:${esc(b.css)};background-size:cover;background-position:center`}"></span>${esc(b.label)}</button>`).join('')
    + (img
      ? `<button class="bg-tile${p.bg === 'custom' ? ' active' : ''}" type="button" data-bg="custom"><span class="sw" style="background-image:url('${img}')"></span>Ton image <small>· <span data-change>changer</span></small></button>`
      : `<button class="bg-tile" type="button" data-import><span class="sw add">${PLUS_ICON}</span>Importer une image</button>`);
  const cur = (p.accent || ACCENTS[0].hex).toLowerCase();
  const known = ACCENTS.find((a) => a.hex === cur);
  $('#accent-row').innerHTML = ACCENTS.map((a) => {
    const v = accentVars(a.hex).dark;
    return `<button type="button" class="acc-sw${a.hex === cur ? ' active' : ''}" data-accent="${a.hex}" title="${esc(a.label)}" aria-label="${esc(a.label)}" style="--a:rgb(${v['--sel-a']});--b:${a.hex}"><i></i></button>`;
  }).join('') + `<label class="acc-sw custom${known ? '' : ' active'}" title="Couleur personnalisée"><i></i><input type="color" id="accent-custom" value="${cur}" aria-label="Couleur personnalisée" /></label><span class="accent-name">${esc(known ? known.label : `Personnalisée (${cur})`)}</span>`;
  const light = document.documentElement.dataset.theme === 'light';
  $('#perso-blur').value = p.blur;
  $('#perso-blur-v').textContent = `${p.blur} px`;
  $('#perso-veil').value = p.veil;
  $('#perso-veil-l').textContent = light ? 'Éclaircissement du fond' : 'Assombrissement du fond';
  $('#perso-veil-v').textContent = `${p.veil} %`;
  $('#perso-panel').value = p.panel;
  // Opacité réelle des panneaux dans le thème affiché
  $('#perso-panel-v').textContent = `${Math.min(100, Math.round((light ? 28 : 16) * (p.panel / 100)))} %`;
}

function bindPerso() {
  applyPerso();
  $('#bg-grid').addEventListener('click', (e) => {
    const t = e.target.closest('[data-bg], [data-import]');
    if (!t) return;
    if (t.hasAttribute('data-import') || e.target.closest('[data-change]')) return $('#bg-file').click();
    setPerso({ bg: t.dataset.bg });
  });
  $('#bg-file').onchange = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    try {
      const url = await shrinkImage(f);
      if (!saveCustomImage(url)) return toast('Stockage du navigateur plein : impossible de garder cette image.', 'err', 6000);
      setPerso({ bg: 'custom' });
      toast('Fond d’écran mis à jour.', 'ok', 2500);
    } catch (err) {
      toast(err.message || 'Image illisible.', 'err', 6000);
    }
  };
  const live = (id, key) => {
    $(id).addEventListener('input', (e) => {
      const p = { ...loadPerso(), [key]: Number(e.target.value) };
      applyPerso(p);
      savePerso({ ...p, css: (BACKGROUNDS.find((b) => b.id === p.bg) || BACKGROUNDS[0]).css });
      renderPerso();
    });
  };
  live('#perso-blur', 'blur');
  live('#perso-veil', 'veil');
  live('#perso-panel', 'panel');
  $('#perso-reset').onclick = () => setPerso({ ...PERSO_DEFAULTS });
  $('#accent-row').addEventListener('click', (e) => {
    const b = e.target.closest('[data-accent]');
    if (b) setPerso({ accent: b.dataset.accent === ACCENTS[0].hex ? null : b.dataset.accent });
  });
  // Sélecteur libre : aperçu en direct, enregistré à la fermeture
  $('#accent-row').addEventListener('input', (e) => {
    if (e.target.id !== 'accent-custom') return;
    applyPerso({ ...loadPerso(), accent: e.target.value });
  });
  $('#accent-row').addEventListener('change', (e) => {
    if (e.target.id === 'accent-custom') setPerso({ accent: e.target.value.toLowerCase() });
  });
  // Le libellé et l'opacité affichée dépendent du thème
  $('#btn-theme').addEventListener('click', () => setTimeout(() => { applyPerso(); applyThemeColors(); renderPerso(); }));
  renderPerso();
}

// ---------- Page Modèles ----------
function renderModelsPage() {
  const box = $('#models-page');
  if (!box) return;
  const auto = state.autoTune && store.get('model.manual') !== '1';
  const MODEL_ICONS = [
    '<svg viewBox="0 0 24 24"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>',
    '<svg viewBox="0 0 24 24"><path d="M12 3v18M5 7h14M5 7l-3 7a4 4 0 0 0 6 0zM19 7l-3 7a4 4 0 0 0 6 0z"/></svg>',
    '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/></svg>',
    '<svg viewBox="0 0 24 24"><path d="M3 12h3l2-6 4 12 3-9 2 3h4"/></svg>',
  ];
  box.innerHTML = MODELS.map((m, mi) => {
    const v = state.caps ? pickVariant(m, caps()) : m.variants.webgpu;
    const off = !!state.caps && !v;
    const cur = m.id === state.modelId;
    const cached = state.cache[m.id];
    return `<section class="glass model-card${cur ? ' current' : ''}${off ? ' off' : ''}">
      <header><span class="mc-ico">${MODEL_ICONS[mi % MODEL_ICONS.length]}</span><div><h3>${esc(m.label)}</h3><small>${esc(m.name)}</small></div>${cur ? `<span class="mc-cur">${auto ? 'Choisi automatiquement' : 'Utilisé'}</span>` : ''}</header>
      <p>${esc(m.description)}</p>
      <div class="mc-tags"><span>${fmtMB((v || m.variants.webgpu).sizeMB)}</span><span class="${cached ? 'ok' : ''}">${cached ? 'Déjà téléchargé' : 'À télécharger'}</span>${isStreaming(m) ? '<span class="live">Vrai temps réel</span>' : ''}${m.heavy && state.caps && !caps().webgpu && !off ? '<span class="warn">Lent sans carte graphique</span>' : ''}${off ? '<span class="warn">Carte graphique requise</span>' : ''}</div>
      <button class="btn ${cur ? '' : 'primary'} sm" type="button" data-use="${m.id}"${cur || off ? ' disabled' : ''}>${cur ? 'Modèle actuel' : 'Utiliser ce modèle'}</button>
    </section>`;
  }).join('') + `<p class="an-note">${state.autoTune ? 'Le réglage automatique choisit le modèle selon ton appareil ; en choisir un ici le remplace jusqu’à ce que tu réactives le réglage automatique.' : 'Réglage automatique désactivé : le modèle choisi ici est utilisé pour toutes les transcriptions.'} Moteur : ${esc($('#pill-engine span')?.textContent || '')}</p>`;
}

// ======================================================================
// Compte Google et dossiers de travail
// ======================================================================
const G_ICON = '<svg class="g-ico" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.2l7.9 6.2C12.5 13.6 17.8 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.6 5.9c4.4-4.1 7-10.1 7-17.6z"/><path fill="#FBBC05" d="M10.6 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.2C1 16.6 0 20.2 0 24s1 7.4 2.7 10.8l7.9-6.2z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.6-5.9c-2.1 1.4-4.9 2.3-8.3 2.3-6.2 0-11.5-4.1-13.4-9.8l-7.9 6.2C6.6 42.6 14.6 48 24 48z"/></svg>';

const esc2 = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const initials = (name) => (String(name || '').match(/[\p{L}\p{N}]+/gu) || []).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';

function syncLabel() {
  if (!Auth.clientId()) return 'Connexion Google à configurer';
  if (!Auth.user()) return 'Sauvegarde dans Google Drive';
  switch (Sync.status) {
    case 'syncing': return 'Synchronisation…';
    case 'error': return 'Erreur de synchronisation';
    case 'expired': return 'Reconnexion nécessaire';
    default: {
      if (!Sync.lastAt) return 'Connecté';
      const min = Math.round((Date.now() - Sync.lastAt) / 60000);
      return min < 1 ? 'Synchronisé à l’instant' : `Synchronisé il y a ${min} min`;
    }
  }
}

/** Carte du compte (barre latérale) et carte « Compte Google » (Paramètres). */
function renderAccount() {
  const u = Auth.user();
  if (state.page === 'home') $('#hero-hello').textContent = helloText();
  const card = $('#user-card');
  card.classList.toggle('signed-out', !u);
  card.dataset.sync = u ? Sync.status : '';
  if (u) {
    const av = u.picture
      ? `<img class="avatar" src="${esc2(u.picture)}" alt="" referrerpolicy="no-referrer" crossorigin="anonymous" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'avatar',textContent:'${initials(u.name).replace(/'/g, '')}'}))" />`
      : `<span class="avatar">${esc2(initials(u.name))}</span>`;
    card.innerHTML = `${av}<div><b>${esc2(u.name)}</b><small><i></i>${esc2(syncLabel())}</small></div><svg class="chev" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>`;
  } else {
    card.innerHTML = `<span class="avatar g">${G_ICON}</span><div><b>Se connecter</b><small>${esc2(syncLabel())}</small></div><svg class="chev" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg>`;
  }
  // Paramètres
  const st = $('#acc-status');
  if (!st) return;
  st.innerHTML = u
    ? `<b>${esc2(u.name)}</b> · ${esc2(u.email)}<br><span class="acc-sync" data-sync="${Sync.status}">${esc2(syncLabel())}${Sync.status === 'error' && Sync.error ? ` : ${esc2(Sync.error)}` : ''}</span>`
    : Auth.clientId() ? 'Non connecté. Sans compte, tout reste dans ce navigateur.' : 'Connexion Google pas encore configurée : renseigne l’identifiant client ci-dessous.';
  $('#acc-login').hidden = !!u && !Auth.expired();
  $('#acc-login span').textContent = u ? 'Se reconnecter' : 'Se connecter avec Google';
  $('#acc-login').disabled = !Auth.clientId();
  $('#acc-sync').hidden = !u || Auth.expired();
  $('#acc-logout').hidden = !u;
  $('#acc-switch').hidden = !u;
  $('#acc-client').value = Auth.clientId();
  $('#acc-redirect').textContent = redirectUri();
}

function signIn(silent = false, { email = null, choose = false } = {}) {
  if (state.phase !== 'idle' || micBusy()) return toast('Attends la fin de l’enregistrement ou de la transcription en cours.', 'warn');
  if (!Auth.clientId()) { setView('settings'); return toast('Renseigne d’abord l’identifiant client Google (Paramètres → Compte Google).', 'warn', 6000); }
  saveDoc();
  try { Auth.signIn({ silent, email, choose }); } catch (e) { toast(e.message, 'err'); }
}

/** Changer de compte Google : le compte voulu (déjà utilisé ici) ou le choix de Google. */
function switchAccount(email = null) {
  $('#user-menu').hidden = true;
  if (email && email === Auth.user()?.email) return;
  signIn(false, email ? { email } : { choose: true });
}

const avatarHtml = (a, cls = 'avatar') => (a.picture
  ? `<img class="${cls}" src="${esc2(a.picture)}" alt="" referrerpolicy="no-referrer" crossorigin="anonymous" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'${cls}',textContent:'${initials(a.name).replace(/'/g, '')}'}))" />`
  : `<span class="${cls}">${esc2(initials(a.name))}</span>`);

/** Menu du profil : compte actuel, autres comptes de ce navigateur, actions. */
function renderUserMenu() {
  const u = Auth.user();
  if (!u) return;
  const others = Auth.accounts().filter((a) => a.email !== u.email);
  $('#um-accounts').innerHTML = `<div class="um-me">${avatarHtml(u)}<div><b>${esc2(u.name)}</b><small>${esc2(u.email)}</small></div><i class="um-check"></i></div>`
    + (others.length ? `<p class="um-label">Changer de compte</p>${others.map((a) => `<div class="um-acc"><button type="button" data-switch="${esc2(a.email)}">${avatarHtml(a)}<span><b>${esc2(a.name)}</b><small>${esc2(a.email)}</small></span></button><button type="button" class="um-forget" data-forget-acc="${esc2(a.email)}" title="Retirer de cette liste" aria-label="Retirer ${esc2(a.email)} de la liste"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>`).join('')}` : '')
    + `<button type="button" class="um-add" data-switch=""><svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0M19 8v6M16 11h6"/></svg>Utiliser un autre compte</button>`;
}

async function syncNow({ quiet = false } = {}) {
  if (!Sync.enabled()) return;
  if (Auth.expired()) { renderAccount(); if (!quiet) toast('Reconnecte-toi à Google pour synchroniser.', 'warn', 5000); return; }
  try {
    const changed = await Sync.run();
    if (changed) {
      renderHistory();
      // Transcription ouverte modifiée sur un autre appareil : on la recharge (sauf saisie en cours)
      const d = state.doc && (await History.get(state.doc.id).catch(() => null));
      if (state.doc && !d) clearResult();
      else if (d && (d.updatedAt || 0) > (state.doc.updatedAt || 0) && state.phase === 'idle' && !$('#step-result').contains(document.activeElement)) showDoc(d);
    }
    if (!quiet) toast('Synchronisé avec Google Drive.', 'ok', 2500);
  } catch (e) {
    if (!quiet) toast(e.message, e.status === 401 ? 'warn' : 'err', 6000);
  }
}

async function signOut() {
  const u = Auth.user();
  if (!u) return;
  const r = await ask('Se déconnecter ?', `Tes transcriptions restent dans ton Google Drive. Sur ce navigateur, elles seront masquées jusqu’à ta prochaine connexion.`, 'Se déconnecter',
    { checkbox: 'Les effacer aussi de ce navigateur (conseillé sur un PC partagé)', checked: false });
  if (!r) return;
  if (r.checked) {
    for (const d of (await History.list()).filter((x) => x.owner === u.email)) {
      await History.remove(d.id);
      if (d.audioId && !(await History.list()).some((x) => x.audioId === d.audioId)) await Audios.remove(d.audioId).catch(() => {});
    }
  }
  await Auth.signOut();
  if (state.doc?.owner === u.email) { clearResult(); clearAudio(); }
  state.folder = 'all';
  Sync._set('off');
  renderAccount();
  renderHistory();
  renderStorage();
  updateButtons();
  toast('Déconnecté.', 'ok', 2500);
}

/** Supprime les transcriptions du compte en cours (ou de l'espace sans compte). */
async function clearMine() {
  const mine = (await History.list()).filter(isMine);
  for (const d of mine) { await History.remove(d.id); Sync.forget(d.id); }
  const rest = await History.list();
  for (const aid of new Set(mine.map((d) => d.audioId).filter(Boolean))) {
    if (!rest.some((d) => d.audioId === aid)) { await Audios.remove(aid).catch(() => {}); Sync.forget(null, aid); }
  }
}

/** Première connexion : propose de ranger dans le compte les transcriptions faites sans compte. */
async function offerImport() {
  const u = Auth.user();
  const local = (await History.list()).filter((d) => !d.owner);
  if (!local.length) return;
  const n = local.length;
  const ok = await ask('Ajouter tes transcriptions à ton compte ?',
    `${n} transcription${n > 1 ? 's ont été faites' : ' a été faite'} sur ce navigateur sans compte. Les ajouter à ton compte ${u.email} (et à ton Google Drive) ? Sinon, elles restent visibles seulement quand tu es déconnecté.`, 'Ajouter');
  if (!ok) return;
  for (const d of local) await History.put({ ...d, owner: u.email, updatedAt: Date.now() });
  // Les dossiers faits sans compte suivent
  const anon = JSON.parse(localStorage.getItem('transcripteur.cloud.folders.local') || '[]');
  if (anon.length) Folders.merge(anon);
  renderHistory();
}

// ---------- Dossiers ----------
function folderOptions(current) {
  const fs = Folders.list();
  const cur = Folders.get(current) ? current : '';
  return `<option value="">Sans dossier</option>${fs.map((f) => `<option value="${f.id}"${f.id === cur ? ' selected' : ''}>${esc2(f.name)}</option>`).join('')}<option value="__new">+ Nouveau dossier…</option>`;
}

async function moveToFolder(doc, value) {
  let id = value;
  if (value === '__new') {
    const name = await askText('Nouveau dossier', 'Nom du dossier', '');
    if (!name) { renderHistory(); renderDocFolder(); return; }
    id = Folders.add(name).id;
  }
  const d = (await History.get(doc.id).catch(() => null)) || doc;
  d.folderId = id || null;
  await persist(d);
  if (state.doc?.id === d.id) state.doc.folderId = d.folderId;
  renderHistory();
  renderDocFolder();
}

function renderDocFolder() {
  const sel = $('#doc-folder');
  sel.hidden = !state.doc || state.doc.status === 'running' || state.doc.status === 'live';
  if (sel.hidden) return;
  sel.innerHTML = folderOptions(state.doc.folderId);
}

function renderFolderBar(items) {
  const bar = $('#folder-bar');
  const fs = Folders.list();
  const count = (id) => items.filter((it) => (id === 'none' ? !Folders.get(it.folderId) : it.folderId === id)).length;
  if (state.folder !== 'all' && state.folder !== 'none' && !Folders.get(state.folder)) state.folder = 'all';
  const chip = (id, name, n, extra = '') => `<button type="button" class="fchip${state.folder === id ? ' active' : ''}" data-folder="${id}">${extra}<span>${esc2(name)}</span><small>${n}</small></button>`;
  const folderIco = '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
  bar.innerHTML = chip('all', 'Tous', items.length)
    + fs.map((f) => chip(f.id, f.name, count(f.id), folderIco)).join('')
    + (fs.length ? chip('none', 'Sans dossier', count('none')) : '')
    + '<button type="button" class="fchip add" data-folder-new><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg><span>Nouveau dossier</span></button>';
  const cur = Folders.get(state.folder);
  $('#folder-tools').hidden = !cur;
}

function askText(title, label, value = '', okLabel = 'Valider') {
  return new Promise((resolve) => {
    const m = document.createElement('div');
    m.className = 'modal';
    m.innerHTML = `<div class="modal-box" role="dialog" aria-modal="true"><h3></h3><label class="label"></label><input class="text-input" maxlength="60" /><div class="modal-actions"><button class="btn" type="button" data-x>Annuler</button><button class="btn primary" type="button" data-ok></button></div></div>`;
    $('h3', m).textContent = title;
    $('label', m).textContent = label;
    $('[data-ok]', m).textContent = okLabel;
    const input = $('input', m);
    input.value = value;
    document.body.appendChild(m);
    input.focus();
    input.select();
    const done = (v) => { m.remove(); resolve(v); };
    $('[data-x]', m).onclick = () => done(null);
    $('[data-ok]', m).onclick = () => done(input.value.trim() || null);
    input.onkeydown = (e) => { if (e.key === 'Enter') done(input.value.trim() || null); if (e.key === 'Escape') done(null); };
  });
}

// ---------- Installation comme une application (PWA) ----------
let installPrompt = null;
function bindInstall() {
  const btns = [$('#btn-install'), $('#btn-install-2')];
  const show = (on) => btns.forEach((b) => (b.hidden = !on));
  addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; show(true); });
  addEventListener('appinstalled', () => { installPrompt = null; show(false); toast('Transcripteur IA est installé : tu le trouves dans ton menu Démarrer et sur ton bureau.', 'ok', 6000); });
  btns.forEach((b) => (b.onclick = async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    const r = await installPrompt.userChoice.catch(() => null);
    if (r?.outcome === 'accepted') show(false);
    installPrompt = null;
  }));
}

function bindAccount(authResult) {
  state.folder = 'all';
  Sync.on(() => renderAccount());
  // Problème de synchronisation : une notification (pas à chaque tentative)
  let lastSyncIssue = '';
  Sync.on((st) => {
    const issue = st.status === 'error' ? `e:${st.error}` : st.status === 'expired' ? 'expired' : '';
    if (issue && issue !== lastSyncIssue) {
      notify(st.status === 'expired'
        ? { kind: 'warn', title: 'Reconnexion à Google nécessaire', text: 'La synchronisation est en pause. Clique sur ta carte en bas à gauche pour te reconnecter.', action: 'account' }
        : { kind: 'err', title: 'Synchronisation impossible', text: st.error || 'Google Drive ne répond pas.', action: 'account' });
    }
    if (st.status === 'ok' && lastSyncIssue) notify({ kind: 'ok', title: 'Synchronisation rétablie', text: 'Tes transcriptions sont à jour dans Google Drive.' });
    if (st.status === 'ok' || issue) lastSyncIssue = issue;
  });
  // Carte du compte (barre latérale)
  $('#user-card').onclick = (e) => {
    e.stopPropagation();
    const u = Auth.user();
    if (!u) return signIn();
    if (Auth.expired()) return signIn(true);
    const menu = $('#user-menu');
    if (menu.hidden) renderUserMenu();
    menu.hidden = !menu.hidden;
  };
  $('#um-accounts').addEventListener('click', (e) => {
    e.stopPropagation();
    const f = e.target.closest('[data-forget-acc]');
    if (f) { Auth.forgetAccount(f.dataset.forgetAcc); return renderUserMenu(); }
    const b = e.target.closest('[data-switch]');
    if (b) switchAccount(b.dataset.switch || null);
  });
  $('#acc-switch').onclick = () => switchAccount(null);
  document.addEventListener('click', (e) => { if (!e.target.closest('#user-menu')) $('#user-menu').hidden = true; });
  $('#um-sync').onclick = () => { $('#user-menu').hidden = true; syncNow(); };
  $('#um-settings').onclick = () => { $('#user-menu').hidden = true; setView('settings'); };
  $('#um-logout').onclick = () => { $('#user-menu').hidden = true; signOut(); };
  // Paramètres
  $('#acc-login').onclick = () => signIn(!!Auth.user());
  $('#acc-sync').onclick = () => syncNow();
  $('#acc-logout').onclick = signOut;
  $('#acc-client').addEventListener('change', (e) => { Auth.setClientId(e.target.value); renderAccount(); toast(e.target.value.trim() ? 'Identifiant client enregistré.' : 'Identifiant client effacé.', 'ok', 2500); });
  $('#acc-copy').onclick = () => writeClipboard(redirectUri()).then(() => toast('Adresse copiée.', 'ok', 2000));
  // Dossiers
  $('#folder-bar').addEventListener('click', async (e) => {
    if (e.target.closest('[data-folder-new]')) {
      const name = await askText('Nouveau dossier', 'Nom du dossier', '');
      if (!name) return;
      state.folder = Folders.add(name).id;
      return renderHistory();
    }
    const b = e.target.closest('[data-folder]');
    if (!b) return;
    state.folder = b.dataset.folder;
    renderHistory();
  });
  $('#folder-rename').onclick = async () => {
    const f = Folders.get(state.folder);
    if (!f) return;
    const name = await askText('Renommer le dossier', 'Nom du dossier', f.name, 'Renommer');
    if (name) { Folders.rename(f.id, name); renderHistory(); renderDocFolder(); }
  };
  $('#folder-delete').onclick = async () => {
    const f = Folders.get(state.folder);
    if (!f) return;
    if (!(await ask('Supprimer ce dossier ?', `Le dossier « ${f.name} » sera supprimé. Les transcriptions qu’il contient ne sont pas effacées : elles passent dans « Sans dossier ».`, 'Supprimer', { danger: true }))) return;
    Folders.remove(f.id);
    state.folder = 'all';
    renderHistory();
    renderDocFolder();
  };
  $('#doc-folder').onchange = (e) => { if (state.doc) moveToFolder(state.doc, e.target.value); };
  // Synchronisation régulière
  setInterval(() => { if (document.visibilityState === 'visible' && Sync.enabled() && state.phase === 'idle') syncNow({ quiet: true }); }, 3 * 60 * 1000);
  setInterval(() => { if (Auth.user() && Sync.status === 'ok') renderAccount(); }, 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && Sync.enabled()) Sync.schedule(800); });
  renderAccount();
  // Retour de Google
  if (authResult?.ok) {
    renderHistory();
    (async () => {
      if (authResult.first) await offerImport();
      await syncNow({ quiet: true });
      if (authResult.first) toast(`Connecté : ${Auth.user().email}. ${Auth.accounts().length > 1 ? 'Tu vois maintenant les transcriptions et dossiers de ce compte.' : 'Tes transcriptions sont sauvegardées dans ton Google Drive.'}`, 'ok', 6000);
    })();
  } else if (authResult && !authResult.ok) {
    const silentFail = ['login_required', 'interaction_required', 'consent_required'].includes(authResult.error);
    if (silentFail) Sync._set('expired', 'Reconnexion à Google nécessaire.');
    else toast(authResult.error === 'access_denied' ? 'Connexion Google annulée.' : `Connexion Google impossible : ${authResult.error}`, 'warn', 7000);
    renderAccount();
  } else if (Sync.enabled() && Auth.token()) {
    syncNow({ quiet: true });
  } else if (Auth.expired()) {
    Sync._set('expired', 'Reconnexion à Google nécessaire.');
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
        notify({ kind: 'warn', title: 'Enregistrement récupéré', text: `${name} : il a été sauvegardé avant la fermeture de l’onglet. Tu peux le transcrire.` });
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
  notify({ kind: 'warn', title: 'Transcription interrompue', text: `« ${autoDoc.title} » ${auto ? 'reprend automatiquement' : 'attend que tu cliques sur « Reprendre »'}.`, docId: autoDoc.id });
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
  $$('#capture-seg button').forEach((b) => (b.onclick = () => {
    state.capture = b.dataset.capture;
    store.set('capture', state.capture);
    renderCapture();
    renderRecState();
  }));
  renderCapture();
  $('#rec-main').onclick = recToggle;
  $('#rec-stop').onclick = recStop;
  $('#rec-discard').onclick = recDiscard;
  $('#rec-pause').onclick = () => { recorder.state === 'paused' ? recorder.resume() : recorder.pause(); renderRec(); };

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
    if (e.isTrusted && state.autoTune) { store.set('model.manual', '1'); renderAutoInfo(); }
    renderModelPick();
    $('#model-pick').open = false;
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
  lang.innerHTML = [['auto', 'Détection automatique de la langue'], ...LANGUAGES].map(([c, n]) => `<option value="${c}">${n}</option>`).join('');
  $('#toggle-autotr').checked = state.autoTr;
  $('#toggle-autotr').onchange = (e) => {
    state.autoTr = e.target.checked;
    store.set('autotr', state.autoTr ? '1' : '0');
    if (state.autoTr && state.doc && state.phase === 'idle' && !micBusy()) autoTranslate(state.doc);
  };
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
    if (e.target.classList.contains('tr')) {
      state.segments[i] = { ...state.segments[i], tr: e.target.textContent };
      return saveDoc(600);
    }
    // Corrigé à la main : le passage n'est plus « à vérifier »
    state.segments[i] = { ...state.segments[i], text: e.target.textContent, conf: undefined, edited: true };
    e.target.closest('.segment')?.classList.remove('low-conf');
    e.target.title = '';
    saveDoc(600);
  });
  $('#transcript').addEventListener('click', (e) => {
    const chip = e.target.closest('.spk');
    if (chip) return openSpeakerMenu(chip);
    const ts = e.target.closest('.ts');
    if (!ts || !state.audio) return;
    player.seek(Number(ts.dataset.start), { play: true });
  });
  $('#result-title').addEventListener('input', () => saveDoc(600));

  $('#btn-copy').onclick = copyText;
  $('#btn-claude').onclick = sendToClaude;
  $('#btn-translate').onclick = translateDoc;
  // Pastille « à vérifier » : passage suivant où le modèle a hésité
  let checkAt = -1;
  $('#result-meta').addEventListener('click', (e) => {
    if (!e.target.closest('.tocheck')) return;
    const rows = $$('#transcript .segment.low-conf');
    if (!rows.length) return;
    checkAt = (checkAt + 1) % rows.length;
    const row = rows[checkAt];
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.classList.toggle('flash', false);
    void row.offsetWidth; // relance l'animation
    row.classList.toggle('flash', true);
  });
  bindSpeakers();
  bindVoices();
  bindActions();
  bindV3();
  bindDashboard();
  $$('#view-switch [data-view]').forEach((b) => (b.onclick = () => {
    state.view = b.dataset.view;
    store.set('view', state.view);
    renderView();
    find.refresh();
  }));
  $$('[data-export]').forEach((b) => (b.onclick = () => exportAs(b.dataset.export)));
  $('#btn-relex').onclick = () => {
    state.segments = applyLexiconTo(state.segments);
    renderSegments(state.segments, {});
    saveDoc();
    toast('Lexique appliqué.', 'ok', 2000);
  };

  $('#btn-lexicon').onclick = () => { renderLexicon(); openDrawer('#drawer-lexicon'); };
  $('#hist-search').addEventListener('input', () => renderHistory());
  $('#find').addEventListener('input', () => find.run());
  $('#find').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); find.step(e.shiftKey ? -1 : 1); }
    if (e.key === 'Escape') { e.stopPropagation(); find.clear(); $('#find').blur(); }
  });
  $('#find-prev').onclick = (e) => { e.preventDefault(); find.step(-1); };
  $('#find-next').onclick = (e) => { e.preventDefault(); find.step(1); };
  // Menu Exporter : fermé après un choix ou un clic ailleurs, inactif sans texte
  $('#export-btn').addEventListener('click', (e) => { if ($('#export-menu').classList.contains('disabled')) e.preventDefault(); });
  $$('#export-menu [data-export]').forEach((b) => b.addEventListener('click', () => ($('#export-menu').open = false)));
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#export-menu')) $('#export-menu').open = false;
    if (!e.target.closest('#model-pick')) $('#model-pick').open = false;
  });
  // Raccourcis clavier
  document.addEventListener('keydown', (e) => {
    if (!$('#modal').hidden || !$('#tool').hidden) return;
    const el = e.target;
    const typing = el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
    if (e.ctrlKey && e.key === 'Enter') {
      if (!$('#btn-transcribe').disabled) { e.preventDefault(); startTranscription(); }
    } else if (e.ctrlKey && (e.key === 'f' || e.key === 'F') && state.segments.length) {
      e.preventDefault();
      $('#find').focus();
      $('#find').select();
    } else if (e.code === 'Space' && (e.ctrlKey || !typing) && !e.repeat) {
      if (!e.ctrlKey && /^(BUTTON|SUMMARY|A)$/.test(el.tagName)) return; // Espace active déjà le bouton
      if (micBusy() && !e.ctrlKey) { e.preventDefault(); $('#rec-pause').click(); }
      else if (player.loaded) { e.preventDefault(); player.toggle(); }
    }
  });
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
    const where = Sync.enabled() ? 'de ce navigateur et de ton Google Drive' : 'de ce navigateur';
    if (!(await ask('Tout supprimer ?', `Toutes tes transcriptions et leurs audios seront définitivement effacés ${where}.`, 'Tout supprimer', { danger: true }))) return;
    await clearMine();
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
function applyThemeColors() {
  monitor?.refreshColors();
  player?.refreshColors();
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());
}

async function init() {
  // Retour de la page de connexion Google (ou reconnexion silencieuse si l'autorisation a expiré)
  let authResult = null;
  try { authResult = await Auth.handleRedirect(); } catch (e) { authResult = { ok: false, error: e.message }; }
  if (!authResult && Auth.maybeSilentRefresh()) return;
  // Détection automatique de la langue par défaut (une seule fois, l'utilisateur peut revenir au français)
  if (store.get('lang.auto', '') !== '1') {
    store.set('lang.auto', '1');
    if (state.language === 'fr') { state.language = 'auto'; store.set('lang', 'auto'); }
  }
  $('#foot-version').textContent = TRANSFORMERS_VERSION;
  monitor = new Monitor($('#monitor-canvas'), { onState: renderMonitorState });
  // Thème clair / sombre
  $('#btn-theme').onclick = () => {
    const t = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = t;
    store.set('theme', t);
    applyThemeColors();
  };
  player = new Player({
    root: $('#player'), audio: $('#audio-player'), canvas: $('#pl-wave'), play: $('#pl-play'),
    time: $('#pl-time'), dur: $('#pl-dur'), speed: $('#pl-speed'), fmt: fmtClock, onTime: onPlayerTime,
    markers: () => state.segments.filter((x) => !x.tentative && x.conf != null && x.conf < CONF.fair).map((x) => x.start),
  });
  applyThemeColors();
  renderHistory();
  bind();
  bindAccount(authResult);
  bindInstall();
  bindBell();
  $('#toggle-auto').onchange = (e) => setAutoTune(e.target.checked, e.target.checked ? 'Réglage automatique activé : le son et le modèle seront réglés avant chaque enregistrement.' : '');
  $('#auto-redo').onclick = async () => {
    if (micBusy() || state.phase !== 'idle') return toast('Attends la fin de l’enregistrement en cours.', 'warn');
    if (await autoSetup({ force: true })) renderAutoInfo();
  };
  renderAutoInfo();
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
  if (!state.caps.webgpu) status((state.caps.softwareGpu ? 'Pas de carte graphique exploitable (GPU logiciel détecté)' : 'WebGPU non disponible') + ' : transcription sur le processeur, plus lente. Préfère « Rapide » ou « Équilibré ».', 'warn');
  try {
    // L'accueil reste la page d'arrivée : la dernière transcription n'est plus rouverte d'office
    // (seul un enregistrement interrompu à récupérer ouvre directement sa transcription)
    await recover();
  } catch (e) { console.warn(e); }
}

init();

// Accès de débogage / tests automatisés
window.__app = {
  notify, notifs,
  Auth, Sync, Folders, syncNow, isMine,
  recorder, monitor: () => monitor, renderMeta, identifySpeakers, applySpeakers, spkCache,
  state, exportAs, sendToClaude, translateDoc, shownSegments, autoTranslate, guessLang, buildPrompt, showDoc, find, player: () => player, toTxt, toSrt, toMarkdown, signalCrash, History, Audios, RecChunks,
  recorderState: () => recorder.state,
  monitorP90: () => { const w = monitor.levels.filter((l) => l.t >= monitor.now - 6).map((l) => l.db).sort((a, b) => a - b); return w[Math.floor(w.length * 0.9)]; },
};
