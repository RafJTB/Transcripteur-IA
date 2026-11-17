// Orchestrateur de l'interface : source audio → transcription (worker) → résultat/export.
import { MODELS, DEFAULT_MODEL, LANGUAGES, CHUNKING, TRANSFORMERS_VERSION, pickVariant, lighterModel } from './config.js';
import { decodeToMono16k, isAcceptedFile, Recorder } from './audio.js';
import { loadLexicon, saveLexicon, compileLexicon, applyLexicon, DEFAULT_LEXICON } from './lexicon.js';
import { toTxt, toMarkdown, toSrt, download, fmtClock, safeFilename } from './exporters.js';
import { History, newId } from './history.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const store = {
  get: (k, d) => { try { return localStorage.getItem('transcripteur.' + k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem('transcripteur.' + k, v); } catch { /* ignore */ } },
};

const state = {
  caps: null,
  forceWasm: false,
  cache: {},
  modelId: MODELS.some((m) => m.id === store.get('model')) ? store.get('model') : DEFAULT_MODEL,
  language: store.get('lang', 'fr'),
  audio: null, // { pcm, name, durationS, url }
  phase: 'idle', // idle | loading | transcribing
  segments: [],
  partial: [],
  doc: null, // entrée d'historique courante
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

function ask(title, text, okLabel = 'Continuer') {
  return new Promise((resolve) => {
    const m = $('#modal');
    $('#modal-title').textContent = title;
    $('#modal-text').textContent = text;
    $('#modal-ok').textContent = okLabel;
    m.hidden = false;
    $('#modal-ok').focus();
    const done = (v) => { m.hidden = true; $('#modal-ok').onclick = $('#modal-cancel').onclick = null; resolve(v); };
    $('#modal-ok').onclick = () => done(true);
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
// Worker
// ======================================================================
let worker;
const listeners = new Set();
let workerBoot;

function startWorker() {
  worker?.terminate();
  worker = new Worker(new URL('./asr-worker.js', import.meta.url), { type: 'module' });
  workerBoot = new Promise((resolve, reject) => {
    const l = (m) => { if (m.type === 'boot') { listeners.delete(l); resolve(); } };
    listeners.add(l);
    worker.onerror = (e) => {
      e.preventDefault?.();
      reject(new Error('Impossible de charger le moteur de transcription. Au premier lancement, cdn.jsdelivr.net doit être accessible.'));
    };
  });
  worker.onmessage = (e) => { for (const l of [...listeners]) l(e.data); onWorkerMessage(e.data); };
  state.loadedKey = null;
  return workerBoot;
}

function request(msg, doneTypes, transfer) {
  return new Promise((resolve, reject) => {
    const l = (m) => {
      if (doneTypes.includes(m.type) && (m.jobId == null || m.jobId === msg.jobId)) { listeners.delete(l); resolve(m); }
      else if (m.type === 'error' && m.during === msg.type) {
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

// Messages de progression (non bloquants)
let dl = null;
function onWorkerMessage(m) {
  switch (m.type) {
    case 'load-start': {
      const model = MODELS.find((x) => x.repo === m.repo);
      const v = pickVariant(model, { ...caps(), webgpu: m.device === 'webgpu' });
      const cached = state.cache[model.id];
      dl = { t0: performance.now(), cached };
      progress.show(cached ? `Chargement de ${model.name} depuis le cache…` : `Téléchargement de ${model.name} (${fmtMB(v.sizeMB)})`, { value: 0 });
      status(cached ? 'Modèle déjà en cache : aucun téléchargement.' : 'Premier téléchargement : le modèle sera ensuite gardé en cache dans le navigateur.');
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
    case 'warmup':
      progress.show('Initialisation du moteur…', { sub: caps().webgpu ? 'Compilation des shaders WebGPU (quelques secondes, une seule fois par session)' : 'Préparation du moteur WASM' });
      break;
    case 'progress': {
      const pct = (m.done / m.total) * 100;
      const rt = state.audio ? (Math.min(m.done * 20 + 10, state.audio.durationS) / Math.max(m.elapsed, 0.01)) : 0;
      progress.show(`Transcription · bloc ${m.done} / ${m.total}`, {
        value: pct,
        sub: m.done < m.total ? `≈ ${fmtDuration(m.eta)} restantes · ${rt ? `×${rt.toFixed(1).replace('.', ',')} temps réel` : ''}` : 'Finalisation…',
      });
      state.partial = m.segments;
      renderSegments(applyLexiconTo(m.segments), { partial: true });
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
  for (const m of MODELS) {
    const v = pickVariant(m, caps());
    const cached = state.cache[m.id];
    const slow = m.heavy && !caps().webgpu;
    const el = document.createElement('label');
    el.className = 'model';
    el.innerHTML = `
      <input type="radio" name="model" value="${m.id}" ${m.id === state.modelId ? 'checked' : ''} />
      <span class="radio"></span>
      <span class="m-title">${m.label}<em>${m.name}</em></span>
      <span class="m-size">${fmtMB(v.sizeMB)}</span>
      <span class="m-desc">${m.description}</span>
      <span class="m-badges" style="grid-column:2/4;display:flex;gap:6px;align-items:center;margin-top:4px">
        ${cached ? '<span class="badge cached">En cache</span>' : '<span class="badge">À télécharger</span>'}
        ${slow ? '<span class="badge slow">Lent sans WebGPU</span>' : ''}
        ${cached ? `<button class="m-clear" type="button" data-clear="${m.id}">Supprimer du cache</button>` : ''}
      </span>`;
    box.appendChild(el);
  }
}

async function refreshCache() {
  if (!state.caps) return;
  const models = MODELS.map((m) => {
    const v = pickVariant(m, caps());
    return { id: m.id, repo: m.repo, device: v.device, dtype: v.dtype };
  });
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
async function setAudioFromBlob(blob, name) {
  status('Décodage de l’audio…');
  try {
    const pcm = await decodeToMono16k(blob);
    const durationS = pcm.length / 16000;
    if (state.audio?.url) URL.revokeObjectURL(state.audio.url);
    state.audio = { pcm, name, durationS, url: URL.createObjectURL(blob) };
    $('#audio-card').hidden = false;
    $('#audio-name').textContent = name;
    $('#audio-info').textContent = `${fmtClock(durationS)} · ${fmtBytes(blob.size)}`;
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

function handleFiles(files) {
  const f = files?.[0];
  if (!f) return;
  if (!isAcceptedFile(f)) {
    toast(`Format non supporté : « ${f.name} ». Formats acceptés : mp3, wav, m4a, webm, mp4, ogg, flac…`, 'err');
    return;
  }
  selectTab('file');
  setAudioFromBlob(f, f.name);
}

function selectTab(name) {
  $$('.seg [data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  $$('.tab-panel').forEach((p) => (p.hidden = p.dataset.panel !== name));
}

// ---------- Micro ----------
const METER_BARS = 28;
const levels = new Array(METER_BARS).fill(0);
let meterTick = 0;
const recorder = new Recorder({
  onLevel(l) {
    if (++meterTick % 3 && l > 0) return; // ~20 fps
    levels.shift();
    levels.push(l);
    $$('#meter i').forEach((b, i) => {
      const v = levels[i];
      b.style.transform = `scaleY(${Math.max(0.12, v)})`;
      b.className = v > 0.85 ? 'hot' : v > 0.05 ? 'on' : '';
    });
  },
  onTick(s) { $('#rec-time').textContent = fmtClock(s); },
});

async function recToggle() {
  if (recorder.state === 'idle') {
    try {
      await recorder.start();
    } catch (e) {
      status(e.message, 'err');
      toast(e.message, 'err', 7000);
      return;
    }
    clearAudio();
    renderRec();
  } else {
    await recStop();
  }
}

async function recStop() {
  const r = await recorder.stop();
  renderRec();
  if (!r) return;
  const d = new Date();
  await setAudioFromBlob(r.blob, `Enregistrement ${d.toLocaleDateString('fr-FR')} ${d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`);
}

function renderRec() {
  const s = recorder.state;
  const btn = $('#rec-main');
  btn.classList.toggle('recording', s !== 'idle');
  btn.classList.toggle('paused', s === 'paused');
  btn.setAttribute('aria-label', s === 'idle' ? 'Démarrer l’enregistrement' : 'Arrêter l’enregistrement');
  $('#rec-state').textContent = { idle: 'Prêt à enregistrer', recording: 'Enregistrement en cours…', paused: 'En pause' }[s];
  $('#rec-pause').disabled = s === 'idle';
  $('#rec-stop').disabled = s === 'idle';
  $('#rec-pause span').textContent = s === 'paused' ? 'Reprendre' : 'Pause';
  if (s === 'idle') $('#rec-time').textContent = '00:00';
  updateButtons();
}

// ======================================================================
// Transcription (avec repli automatique)
// ======================================================================
async function ensureLoaded(model) {
  const v = pickVariant(model, caps());
  const key = `${model.repo}|${v.device}|${JSON.stringify(v.dtype)}`;
  if (state.loadedKey === key) return v;
  state.phase = 'loading';
  updateButtons();
  await request({ type: 'load', repo: model.repo, device: v.device, dtype: v.dtype }, ['ready']);
  state.loadedKey = key;
  state.cache[model.id] = true;
  renderModels();
  renderStorage();
  return v;
}

async function transcribe() {
  if (!state.audio || state.phase !== 'idle' || recorder.state !== 'idle') return;
  let model = modelById(state.modelId);

  if (model.heavy && !caps().webgpu) {
    const ok = await ask(
      'Modèle lourd sans carte graphique',
      `WebGPU n’est pas disponible : ${model.name} tournera sur le processeur et peut prendre plusieurs fois la durée de l’audio (téléchargement ${fmtMB(pickVariant(model, caps()).sizeMB)}). Le modèle « Équilibré » est conseillé ici.`,
      'Continuer quand même'
    );
    if (!ok) return;
  }

  state.partial = [];
  state.segments = [];
  renderSegments([], {});
  showWaiting(true);
  const jobId = ++state.jobId;
  let v;

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      v = await ensureLoaded(model);
      state.phase = 'transcribing';
      updateButtons();
      progress.show('Transcription…', { value: 0, sub: 'Analyse du premier bloc' });
      status(`${model.name} · ${v.device === 'webgpu' ? 'WebGPU' : 'WASM'} · ${LANGUAGES.find((l) => l[0] === state.language)?.[1] ?? state.language}`);
      const pcm = state.audio.pcm.slice(); // copie transférée au worker
      const res = await request(
        { type: 'transcribe', jobId, audio: pcm, language: state.language, chunkLengthS: CHUNKING.chunkLengthS, strideLengthS: CHUNKING.strideLengthS },
        ['result', 'cancelled'],
        [pcm.buffer]
      );
      if (res.type === 'cancelled') {
        finish(state.partial, { model, v, partial: true });
        toast('Transcription annulée. Le texte déjà obtenu est conservé.', 'warn');
      } else {
        finish(res.segments, { model, v, seconds: res.seconds });
        toast(`Transcription terminée en ${fmtDuration(res.seconds)}.`, 'ok');
      }
      break;
    } catch (err) {
      console.error(err);
      if (err.kind === 'cancelled') break;
      const next = fallbackFor(err, model, v);
      if (!next) {
        const msg = err.kind === 'network'
          ? 'Téléchargement impossible : vérifie la connexion (huggingface.co doit être accessible pour le premier chargement).'
          : `Erreur : ${err.message}`;
        status(msg, 'err');
        toast(msg, 'err', 8000);
        break;
      }
      toast(next.reason, 'warn', 8000);
      status(next.reason, 'warn');
      if (next.wasm) {
        state.forceWasm = true;
        renderEngine();
        await startWorker();
        await refreshCache();
      }
      if (next.model) {
        model = next.model;
        state.modelId = model.id;
        store.set('model', model.id);
        renderModels();
        // Libère la mémoire du gros modèle en redémarrant le worker
        await startWorker();
      }
    }
  }
  state.phase = 'idle';
  showWaiting(false);
  progress.hide();
  updateButtons();
}

/** Décide du repli : WebGPU → WASM, ou gros modèle → modèle plus léger. */
function fallbackFor(err, model, v) {
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
    progress.show('Annulation…', { sub: 'Fin du bloc en cours' });
  } else if (state.phase === 'loading') {
    // Impossible d'interrompre proprement un téléchargement : on redémarre le worker.
    for (const l of [...listeners]) l({ type: 'error', during: 'load', kind: 'cancelled', message: 'Chargement annulé' });
    startWorker().then(refreshCache);
    status('Chargement annulé.');
  }
}

// ======================================================================
// Résultat
// ======================================================================
const lexRules = () => compileLexicon(state.lexicon);
const applyLexiconTo = (segs) => { const r = lexRules(); return segs.map((s) => ({ ...s, text: applyLexicon(s.text, r) })); };

function finish(rawSegments, { model, v, seconds, partial }) {
  state.segments = applyLexiconTo(rawSegments || []);
  const d = new Date();
  const title = state.audio?.name?.replace(/\.[a-z0-9]{2,4}$/i, '') || `Transcription ${d.toLocaleDateString('fr-FR')}`;
  state.doc = {
    id: newId(),
    createdAt: Date.now(),
    title,
    source: state.audio?.name || '',
    model: model.name,
    device: v?.device,
    language: state.language,
    durationS: state.audio?.durationS || 0,
    processingS: seconds || null,
    partial: !!partial,
    segments: state.segments,
  };
  $('#result-title').value = title;
  renderMeta();
  renderSegments(state.segments, {});
  saveDoc();
  if (matchMedia('(max-width: 980px)').matches) $('#step-result').scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (!state.segments.length) status('Aucune parole détectée dans cet audio.', 'warn');
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
    d.partial ? 'partiel' : null,
  ];
  $('#result-meta').textContent = parts.filter(Boolean).join(' · ');
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

function renderSegments(segs, { partial }) {
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
    row.classList.toggle('partial', !!partial);
    row.classList.toggle('gap', i > 0 && s.start - segs[i - 1].end > 2);
    const ts = $('.ts', row);
    ts.textContent = fmtClock(s.start);
    ts.dataset.start = s.start;
    ts.title = `${fmtClock(s.start)} → ${fmtClock(s.end)}`;
    const txt = $('.txt', row);
    txt.dataset.i = i;
    if (partial) txt.removeAttribute('contenteditable');
    else txt.setAttribute('contenteditable', 'plaintext-only');
    if (document.activeElement !== txt && txt.textContent !== s.text) txt.textContent = s.text;
  });
  updateButtons();
}

let saveTimer;
function saveDoc(debounce = 0) {
  if (!state.doc) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    state.doc.segments = state.segments;
    state.doc.title = $('#result-title').value.trim() || state.doc.title;
    try { await History.put(structuredClone(state.doc)); } catch (e) { console.warn('Historique indisponible', e); }
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
  const has = state.segments.length > 0 && !busy;
  const btn = $('#btn-transcribe');
  btn.disabled = !state.audio || busy || recorder.state !== 'idle' || !state.caps;
  btn.classList.toggle('busy', busy);
  $('span', btn).textContent = state.phase === 'loading' ? 'Chargement du modèle…' : state.phase === 'transcribing' ? 'Transcription en cours…' : 'Transcrire';
  $('#btn-cancel').hidden = !busy;
  $$('[data-export], #btn-copy, #btn-relex').forEach((b) => (b.disabled = !has));
  $('#result-title').disabled = !state.doc;
  $$('#models input').forEach((i) => (i.disabled = busy));
  $('#lang').disabled = busy;
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
  try { items = await History.list(); } catch { list.innerHTML = '<p class="hist-empty">Historique indisponible dans ce navigateur.</p>'; return; }
  if (!items.length) { list.innerHTML = '<p class="hist-empty">Aucune transcription enregistrée pour l’instant.</p>'; return; }
  list.innerHTML = '';
  for (const it of items) {
    const el = document.createElement('div');
    el.className = 'hist-item' + (state.doc?.id === it.id ? ' current' : '');
    el.tabIndex = 0;
    el.innerHTML = `<strong></strong><button class="icon-btn" type="button" aria-label="Supprimer"><svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg></button><small></small><p></p>`;
    $('strong', el).textContent = it.title;
    $('small', el).textContent = [new Date(it.createdAt).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }), it.durationS ? fmtClock(it.durationS) : null, it.model].filter(Boolean).join(' · ');
    $('p', el).textContent = it.segments.map((s) => s.text).join(' ').slice(0, 220) || '(vide)';
    const open = () => openDoc(it);
    el.addEventListener('click', (e) => { if (!e.target.closest('.icon-btn')) open(); });
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
    $('.icon-btn', el).onclick = async () => {
      await History.remove(it.id);
      if (state.doc?.id === it.id) state.doc = null;
      renderHistory();
      updateButtons();
    };
    list.appendChild(el);
  }
}

function openDoc(it) {
  if (state.phase !== 'idle') return toast('Attends la fin de la transcription en cours.', 'warn');
  state.doc = it;
  state.segments = it.segments;
  $('#result-title').value = it.title;
  renderMeta();
  renderSegments(state.segments, {});
  closeDrawers();
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
  $('#meter').innerHTML = '<i></i>'.repeat(METER_BARS);
  $('#rec-main').onclick = recToggle;
  $('#rec-stop').onclick = recStop;
  $('#rec-pause').onclick = () => { recorder.state === 'paused' ? recorder.resume() : recorder.pause(); renderRec(); };

  const dz = $('#dropzone');
  $('#file-input').onchange = (e) => { handleFiles(e.target.files); e.target.value = ''; };
  ['dragenter', 'dragover'].forEach((t) => window.addEventListener(t, (e) => { e.preventDefault(); dz.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((t) => window.addEventListener(t, (e) => { e.preventDefault(); if (t === 'drop' || !e.relatedTarget) dz.classList.remove('over'); }));
  window.addEventListener('drop', (e) => handleFiles(e.dataTransfer?.files));
  $('#audio-clear').onclick = clearAudio;

  $('#models').addEventListener('change', (e) => {
    if (e.target.name !== 'model') return;
    state.modelId = e.target.value;
    store.set('model', state.modelId);
  });
  $('#models').addEventListener('click', async (e) => {
    const id = e.target.dataset?.clear;
    if (!id) return;
    e.preventDefault();
    const m = modelById(id);
    const v = pickVariant(m, caps());
    if (!(await ask('Supprimer du cache ?', `${m.name} (${fmtMB(v.sizeMB)}) devra être retéléchargé à la prochaine utilisation.`, 'Supprimer'))) return;
    await request({ type: 'cache-clear', repo: m.repo, device: v.device, dtype: v.dtype }, ['cache-cleared']).catch(() => {});
    if (state.loadedKey?.startsWith(m.repo + '|')) state.loadedKey = null;
    await refreshCache();
    toast(`${m.name} supprimé du cache.`, 'ok', 2500);
  });

  const lang = $('#lang');
  lang.innerHTML = LANGUAGES.map(([c, n]) => `<option value="${c}">${n}</option>`).join('');
  lang.value = state.language;
  lang.onchange = () => { state.language = lang.value; store.set('lang', lang.value); };

  $('#btn-transcribe').onclick = transcribe;
  $('#btn-cancel').onclick = cancel;

  $('#toggle-ts').checked = store.get('ts', '1') === '1';
  $('#transcript').dataset.ts = $('#toggle-ts').checked ? 'on' : 'off';
  $('#toggle-ts').onchange = (e) => { $('#transcript').dataset.ts = e.target.checked ? 'on' : 'off'; store.set('ts', e.target.checked ? '1' : '0'); };

  $('#transcript').addEventListener('input', (e) => {
    const i = e.target.dataset?.i;
    if (i == null || !state.segments[i]) return;
    state.segments[i] = { ...state.segments[i], text: e.target.textContent };
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
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeDrawers(); if (!$('#modal').hidden) $('#modal-cancel').click(); } });
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
    if (!(await ask('Tout supprimer ?', 'Toutes les transcriptions de l’historique seront définitivement effacées de ce navigateur.', 'Tout supprimer'))) return;
    await History.clear();
    state.doc = null;
    renderHistory();
    updateButtons();
  };
  window.addEventListener('beforeunload', (e) => { if (state.phase !== 'idle' || recorder.state !== 'idle') e.preventDefault(); });
}

// ======================================================================
// Démarrage
// ======================================================================
async function init() {
  $('#foot-version').textContent = TRANSFORMERS_VERSION;
  bind();
  renderRec();
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
  // Dernière transcription de l'historique
  try {
    const [last] = await History.list();
    if (last && !state.doc) openDoc(last);
  } catch { /* ignore */ }
}

init();

// Accès de débogage / tests automatisés
window.__app = { state, exportAs, toTxt, toSrt, toMarkdown };
