// Transcription d’un fichier : chargement du modèle, tâche, reprise.

import { Audios, History, newId } from '../history.js';
import { Auth, Sync } from '../cloud.js';
import { CHUNKING, SAMPLE_RATE as SR, isStreaming, lighterModel, pickVariant } from '../config.js';
import { fmtClock } from '../exporters.js';
import { speechStart } from '../audio.js';
import { $, ask, caps, fmtDuration, fmtMB, modelById, progress, state, status, store, toast } from './core.js';
import { applyLexiconTo, showDoc, showWaiting, updateButtons } from './doc.js';
import { listeners, refreshCache, renderEngine, renderModels, renderStorage, request, startWorker, worker } from './engine.js';
import { renderHistory } from './history.js';
import { notify } from './notifs.js';
import { ensureAudioStored, loadDocAudio, micBusy } from './recording.js';
import { identifySpeakers } from './speakers.js';
import { autoTranslate } from './translation.js';

// ======================================================================
// Transcription (reprise + repli automatiques)
// ======================================================================
export async function ensureLoaded(model) {
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

export function newDoc(fields) {
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

export async function persist(doc = state.doc) {
  if (!doc) return;
  doc.updatedAt = Date.now();
  const u = Auth.user();
  if (u && !doc.owner) doc.owner = u.email; // créée avec un compte : rangée dans ce compte
  try { await History.put(structuredClone(doc)); } catch (e) { console.warn('Historique indisponible', e); }
  scheduleHistory();
  if (doc.status !== 'running' && doc.status !== 'live') Sync.schedule();
}

/** Transcriptions du compte connecté (ou, sans compte, celles faites sans compte). */
export const isMine = (d) => (Auth.user() ? d.owner === Auth.user().email : !d.owner);

/** Audio d'une transcription : dans ce navigateur, sinon récupéré du Google Drive. */
export async function getAudio(id) {
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
export async function confirmBigDownload(model) {
  const v = pickVariant(model, caps());
  if (!v || state.cache[model.id] || v.sizeMB < 1000) return true;
  return !!(await ask(
    'Gros téléchargement',
    `${model.name} pèse ${fmtMB(v.sizeMB)}. Il sera téléchargé une seule fois puis gardé dans le navigateur. Selon ta connexion, compte de quelques minutes à plus d’un quart d’heure.`,
    'Télécharger'
  ));
}

export async function startTranscription() {
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
export async function runJob(doc) {
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

export function skipLeadingSilence(pcm, fromS) {
  return speechStart(pcm, Math.round(fromS * SR), pcm.length) / SR;
}

function stopByUser(doc) {
  doc.status = 'interrupted';
  doc.stopReason = 'user';
  toast('Transcription arrêtée. Le texte obtenu est conservé ; « Reprendre » continue là où elle s’est arrêtée.', 'warn', 7000);
}

export function finalizeDoc(doc, newSegments) {
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

export function cancel() {
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

export function hideResume() {
  clearInterval(autoTimer);
  autoTimer = null;
  $('#resume-block').hidden = true;
}

/** Affiche « Reprendre » ; avec `auto`, la reprise se lance seule après un compte à rebours. */
export function renderResume(doc = state.doc, { auto = false } = {}) {
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

/** Transcriptions de l'utilisateur, terminées ou non, les plus récentes d'abord. */
export async function myDocs() {
  try { return (await History.list()).filter(isMine).sort((a, b) => b.createdAt - a.createdAt); } catch { return []; }
}
