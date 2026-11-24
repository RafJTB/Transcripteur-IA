// Enregistrement : audio chargé, micro, transcription en direct, décalage, vidéo de l’écran.

import { Audios, History, RecChunks, newId } from '../history.js';
import { DEFAULT_AUDIO_SETTINGS, LevelBooster, Recorder, canCaptureSystem, decodeToMono16k, isAcceptedFile } from '../audio.js';
import { LiveSession, VoxtralLive } from '../live.js';
import { SAMPLE_RATE as SR, isStreaming } from '../config.js';
import { Sync } from '../cloud.js';
import { fmtClock } from '../exporters.js';
import { $, $$, ask, fmtBytes, modelById, progress, recName, state, status, store, toast } from './core.js';
import { tool } from './diagnostic.js';
import { applyLexiconTo, clearResult, renderMeta, renderSegments, showDoc, showWaiting, updateButtons } from './doc.js';
import { renderStorage, request, worker } from './engine.js';
import { autoSetup, refreshDevices, renderSound, startAutoGain, stopMicTest } from './sound.js';
import { confirmBigDownload, ensureLoaded, finalizeDoc, getAudio, hideResume, newDoc, persist, runJob, skipLeadingSilence } from './transcription.js';
import { carryTranslations, liveTranslate } from './translation.js';
import { takeRecordingEvent } from './calendar-ui.js';
import { stopVerify } from './verify-ui.js';
import { applyAudioChoice, askAudioStorage } from './storage-ui.js';

// ======================================================================
// Source audio
// ======================================================================
/** Charge un audio dans la zone 1. `pcm` évite un décodage si on l'a déjà (direct). */
export async function setAudioFromBlob(blob, name, { audioId = null, pcm = null, docId = null } = {}) {
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

/**
 * Page « Nouvelle transcription » : on part d'une page vide. L'audio d'une réunion déjà
 * transcrite (ouverte depuis les projets, ou enregistrée en direct) n'y reste pas affiché ;
 * il est toujours dans le projet. Un audio pas encore transcrit (import, enregistrement
 * sans direct) est gardé, pour pouvoir cliquer sur « Transcrire ».
 */
export function freshSource() {
  if (micBusy() || state.phase !== 'idle' || !state.audio?.docId) return;
  clearAudio();
}

export function clearAudio() {
  if (state.audio?.url) URL.revokeObjectURL(state.audio.url);
  state.audio = null;
  $('#audio-card').hidden = true;
  player.clear();
  status('');
  updateButtons();
}

/** Sauvegarde l'audio courant dans le navigateur (nécessaire pour reprendre après fermeture). */
export async function ensureAudioStored() {
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
export async function loadDocAudio(doc) {
  const a = state.audio;
  if (a && ((doc.audioId && a.audioId === doc.audioId) || a.docId === doc.id)) return true;
  if (!doc.audioId) return false;
  const rec = await getAudio(doc.audioId);
  if (!rec?.blob) return false;
  await setAudioFromBlob(rec.blob, rec.name, { audioId: rec.id, docId: doc.id });
  return !!state.audio;
}

export function handleFiles(files) {
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

export function selectTab(name) {
  $$('.seg [data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  $$('.tab-panel').forEach((p) => (p.hidden = p.dataset.panel !== name));
}

// ======================================================================
// Micro (+ direct, + sauvegarde continue)
// ======================================================================
export let monitor = null; // graphique volume / compréhension (créé au démarrage)
export let player = null; // lecteur audio du résultat (créé au démarrage)
/** Créés au démarrage (init), utilisés partout. */
export function setMonitor(m) { monitor = m; }
export function setPlayer(p) { player = p; }

/** Micro occupé par un enregistrement (le simple test du micro ne bloque rien). */
export const micBusy = () => recorder.state === 'recording' || recorder.state === 'paused';

/** Réglages du son, mémorisés dans le navigateur. */
export const sound = (() => {
  try { return { ...DEFAULT_AUDIO_SETTINGS, ...JSON.parse(store.get('sound', '{}')) }; } catch { return { ...DEFAULT_AUDIO_SETTINGS }; }
})();
export const saveSound = () => store.set('sound', JSON.stringify(sound));
export const recorder = new Recorder({
  onLevel(l, info) {
    heroLevel(l);
    if (info) monitor?.addLevel(info.t, info.rms, info.peak);
    if (tool.meter) $('#tool-meter-fill').style.width = `${Math.round(Math.min(1, l * 1.4) * 100)}%`;
  },
  onTick(s) {
    $('#rec-time').textContent = fmtClock(s);
    $('#rb-time').textContent = fmtClock(s);
    if (state.live) { renderRecState(); renderLag(); }
  },
  // Chaque seconde, le morceau compressé est sauvegardé : rien n'est perdu si l'onglet plante.
  onChunk(blob, idx) {
    const r = state.rec;
    if (!r) return;
    r.pending = r.pending.then(() => RecChunks.add(r.id, idx, blob)).catch(() => {});
  },
  onVideoChunk(blob, idx) {
    const r = state.rec;
    if (!r) return;
    r.pending = r.pending.then(() => RecChunks.add(`${r.id}.video`, idx, blob)).catch(() => {});
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
export function warnFallback() {
  if (!recorder.fellBack) return;
  const name = sound.deviceLabel ? `« ${sound.deviceLabel} »` : 'Le micro choisi';
  toast(`${name} est introuvable (débranché ou éteint ?) : le micro par défaut est utilisé${recorder.deviceLabel ? ` (${recorder.deviceLabel})` : ''}.`, 'warn', 8000);
}

export async function recToggle() {
  if (!micBusy()) await recStart();
  else await recStop();
}

async function recStart() {
  if (state.phase === 'verifying') {
    stopVerify();
    toast('Vérification arrêtée pour enregistrer.', 'info', 3000);
    for (let k = 0; k < 120 && state.phase === 'verifying'; k++) await new Promise((r) => setTimeout(r, 250));
  }
  if (state.phase !== 'idle') return toast('Attends la fin de la transcription en cours.', 'warn');
  if (state.autoTune && !(await autoSetup())) return;
  const live = !!state.caps; // la transcription en direct est toujours active
  if (live && !(await confirmBigDownload(modelById(state.modelId)))) return;
  stopMicTest();
  try {
    await recorder.start({ pcm: live, settings: sound, capture: captureMode(), video: state.keepVideo && captureMode() !== 'mic' });
  } catch (e) {
    status(e.message, 'err');
    toast(e.message, 'err', 7000);
    return;
  }
  warnFallback();
  startAutoGain();
  if (state.keepVideo && captureMode() !== 'mic') {
    if (recorder.recordingVideo) toast('Vidéo de l’écran enregistrée en même temps (qualité réunion, ≈ 150 Mo par heure). Pense à prévenir les participants.', 'info', 6000);
    else toast('Vidéo de l’écran indisponible : seul le son est enregistré.', 'warn', 6000);
  }
  const rec = { id: newId(), live, mime: recorder.mimeType, video: recorder.recordingVideo, startedAt: Date.now(), pending: Promise.resolve(), event: takeRecordingEvent() };
  state.rec = rec;
  monitor?.start();
  refreshDevices();
  store.set('rec.active', JSON.stringify({ id: rec.id, live, mime: rec.mime, video: rec.video, startedAt: rec.startedAt }));
  clearAudio();
  hideResume();
  // Amplification réservée à Voxtral (sensible au volume absolu). Whisper normalise lui-même chaque bloc.
  state.booster = live && isStreaming(modelById(state.modelId)) ? new LevelBooster() : null;
  state.lagStats = null;
  if (live) startLive(rec);
  renderRec();
  renderLag(true);
}

function startLive(rec) {
  const model = modelById(state.modelId);
  const doc = newDoc({ id: rec.id, title: rec.event?.title || recName(), source: 'Micro (direct)', modelId: model.id, model: model.name, status: 'live', liveP: 0, ...(rec.event ? { event: rec.event } : {}) });
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

export function renderLive() {
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

export async function recStop() {
  const rec = state.rec;
  const r = await recorder.stop();
  state.rec = null;
  monitor?.stop();
  renderRec();
  if (!r || !rec) return;
  await rec.pending; // derniers morceaux écrits
  const name = rec.event?.title || recName(new Date(rec.startedAt));
  let audioId = rec.id;
  try {
    await Audios.put({ id: audioId, blob: r.blob, name, durationS: r.seconds, createdAt: Date.now() });
    await RecChunks.remove(rec.id);
  } catch {
    audioId = null;
  }
  if (r.video && audioId) {
    try {
      await Audios.put({ id: videoIdOf(audioId), blob: r.video, name: `${name} (écran)`, durationS: r.seconds, createdAt: Date.now(), kind: 'video' });
      toast(`Vidéo de l’écran gardée (${fmtBytes(r.video.size)}).`, 'ok', 4000);
    } catch { toast('Vidéo de l’écran trop lourde pour le stockage du navigateur : seul le son est gardé.', 'warn', 7000); }
  }
  RecChunks.remove(`${rec.id}.video`).catch(() => {});
  store.del('rec.active');
  // Où garder cet audio ? (la question n'empêche pas la fin de la transcription de se faire)
  const liveDoc = rec.live ? state.doc : null;
  askAudioStorage({ name, durationS: r.seconds, recording: true }).then((where) => {
    if (liveDoc && liveDoc.id === rec.id) return applyAudioChoice(liveDoc, where);
    if (state.audio && state.audio.audioId === audioId) state.audio.where = where;
  });

  renderLag(true);
  if (rec.live && state.live) {
    const s = state.live;
    const doc = state.doc;
    const st = state.lagStats;
    if (doc && st?.n) doc.liveLag = { avg: Math.round((st.sum / st.n) * 10) / 10, max: Math.round(st.max * 10) / 10 };
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
    if (rec.event && state.audio) state.audio.event = rec.event;
  }
}

/** Supprime l'enregistrement en cours sans rien garder. */
export async function recDiscard() {
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
    await RecChunks.remove(`${rec.id}.video`).catch(() => {});
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

// ---------- Décalage entre la parole et le texte en direct ----------
export const fmtLag = (s) => (s < 60 ? `${Math.max(0, Math.round(s))} s` : `${Math.floor(s / 60)} min ${String(Math.round(s % 60)).padStart(2, '0')}`);
let lagLast = 0;

/** Indicateur « décalage » pendant l'enregistrement + statistiques (moyenne, maximum) gardées dans le projet. */
function renderLag(force = false) {
  const chips = [$('#rb-lag'), $('#rec-lag')];
  const l = state.live;
  const active = l && micBusy() && recorder.state !== 'idle';
  if (!active) { chips.forEach((c) => c && (c.hidden = true)); return; }
  const now = performance.now();
  if (!force && now - lagLast < 250) return;
  lagLast = now;
  let cls = 'wait', text = 'Chargement du modèle…', title = 'Le modèle se charge : le texte apparaîtra dans quelques instants.';
  if (l.failed) { cls = 'err'; text = 'Direct interrompu'; title = 'La transcription en direct s’est arrêtée : l’enregistrement continue, le texte sera fait à l’arrêt.'; }
  else if (l.ready) {
    const lag = l.lagS;
    if (recorder.state === 'recording') {
      const st = (state.lagStats ??= { sum: 0, n: 0, max: 0 });
      st.sum += lag; st.n++; st.max = Math.max(st.max, lag);
    }
    cls = lag <= 5 ? 'ok' : lag <= 15 ? 'warn' : 'err';
    text = `Décalage ${fmtLag(lag)}`;
    const st = state.lagStats;
    title = `Temps entre ce qui est dit et son apparition dans le texte${st?.n ? ` · moyenne ${fmtLag(st.sum / st.n)}, maximum ${fmtLag(st.max)}` : ''}.${cls === 'err' ? ' Le modèle n’arrive pas à suivre : il rattrapera son retard à l’arrêt. Un modèle plus rapide réduit le décalage.' : ' Le texte peut encore se corriger quelques secondes après.'}`;
  }
  for (const c of chips) {
    if (!c) continue;
    c.hidden = false;
    c.className = `lag-chip ${cls}`;
    c.title = title;
    $('b', c).textContent = text;
  }
}

export function renderRecState() {
  const s = micBusy() ? recorder.state : 'idle';
  let text = { idle: 'Prêt à enregistrer', recording: 'Enregistrement en cours…', paused: 'En pause' }[s];
  if (s !== 'idle' && recorder.capturingSystem) text = text.replace('Enregistrement', recorder.stream ? 'Enregistrement voix + visio' : 'Enregistrement de la visio');
  else if (s === 'idle' && captureMode() !== 'mic') text = captureMode() === 'mix' ? 'Prêt : ta voix + la visio' : 'Prêt : son de la visio';
  const l = state.live;
  if (l && s !== 'idle') {
    if (l.failed) text += ' · direct interrompu';
    else if (!l.ready) text += ' · chargement du modèle…';
    else text += ' · direct';
  }
  $('#rec-state').textContent = text;
}

// ======================================================================
// Ce qu'on enregistre : ma voix, ma voix + la visio, ou la visio seule
// ======================================================================
const captureMode = () => (canCaptureSystem() ? state.capture : 'mic');

// ---------- Vidéo de l'écran (visio) ----------
export const videoIdOf = (audioId) => `${audioId}.video`;
let videoUrl = null;

/** Affiche la vidéo de l'écran du projet (si elle existe), calée sur le lecteur audio. */
export async function loadDocVideo(doc) {
  const block = $('#doc-video-block');
  const v = $('#doc-video');
  if (!block) return;
  const want = doc?.audioId;
  if (!want) { block.hidden = true; v.removeAttribute('src'); if (videoUrl) URL.revokeObjectURL(videoUrl); videoUrl = null; return; }
  const rec = await Audios.get(videoIdOf(want)).catch(() => null);
  if (state.doc?.audioId !== want) return; // un autre projet a été ouvert entre-temps
  if (videoUrl) URL.revokeObjectURL(videoUrl);
  videoUrl = null;
  const onDrive = Sync.enabled() && Sync.videoOnDrive(want);
  $('#doc-video-remote').hidden = true;
  if (!rec?.blob?.size) {
    v.removeAttribute('src');
    v.hidden = true;
    // Vidéo seulement dans Google Drive (autre appareil, ou place libérée sur ce PC)
    block.hidden = !onDrive;
    if (onDrive) { $('#doc-video-remote').hidden = false; $('#doc-video-size').textContent = 'Google Drive'; renderVideoDrive(want, false); }
    return;
  }
  v.hidden = false;
  videoUrl = URL.createObjectURL(rec.blob);
  v.src = videoUrl;
  block.hidden = false;
  $('#doc-video-size').textContent = fmtBytes(rec.blob.size);
  renderVideoDrive(want, true);
}

/** Ligne d'état « Google Drive » du bloc vidéo. */
function renderVideoDrive(aid, local) {
  const el = $('#doc-video-drive');
  const f = Sync.enabled() ? Sync.videoOnDrive(aid) : null;
  const link = f ? `<a href="https://drive.google.com/file/d/${encodeURIComponent(f.id)}/view" target="_blank" rel="noopener">Ouvrir dans Drive</a>` : '';
  el.innerHTML = !Sync.enabled() ? 'Sur ce PC seulement (connecte-toi à Google pour la sauvegarder).'
    : f ? `<span class="ok">✓ Sauvegardée dans Google Drive</span> · ${link}${local ? ' · <button class="link-btn" type="button" id="doc-video-free">Libérer la place sur ce PC</button>' : ''}`
    : Sync.videosEnabled() ? 'Envoi vers Google Drive à la prochaine synchronisation…'
    : 'Sur ce PC seulement (sauvegarde des vidéos désactivée dans Paramètres).';
}

export function bindDocVideo() {
  const v = $('#doc-video');
  const a = $('#audio-player');
  if (!v || !a) return;
  // La vidéo (muette) suit le lecteur audio : lecture, pause, position, vitesse
  const sync = (force = false) => {
    if (!v.src || !v.duration) return;
    const t = Math.min(a.currentTime, v.duration - 0.05);
    if (force || Math.abs(v.currentTime - t) > 0.35) v.currentTime = Math.max(0, t);
  };
  a.addEventListener('play', () => { sync(true); v.play().catch(() => {}); });
  a.addEventListener('pause', () => v.pause());
  a.addEventListener('seeked', () => sync(true));
  a.addEventListener('timeupdate', () => sync());
  a.addEventListener('ratechange', () => (v.playbackRate = a.playbackRate));
  // Clic sur la vidéo : lecture / pause du lecteur
  v.addEventListener('click', () => (a.paused ? a.play() : a.pause()).catch?.(() => {}));
  $('#doc-video-full').onclick = () => (v.requestFullscreen?.() || Promise.reject()).catch(() => toast('Plein écran indisponible.', 'warn', 2500));
  $('#doc-video-pip').onclick = async () => {
    try { document.pictureInPictureElement ? await document.exitPictureInPicture() : await v.requestPictureInPicture(); }
    catch { toast('Mode incrustation indisponible dans ce navigateur.', 'warn', 3000); }
  };
  $('#doc-video-pip').hidden = !document.pictureInPictureEnabled;
  $('#doc-video-del').onclick = async () => {
    const d = state.doc;
    if (!d?.audioId) return;
    const onDrive = Sync.enabled() && Sync.videoOnDrive(d.audioId);
    if (!(await ask('Supprimer la vidéo de l’écran ?', `Le son et la transcription sont gardés. La vidéo est effacée de ce navigateur${onDrive ? ' et de ton Google Drive' : ''}.`, 'Supprimer la vidéo', { danger: true }))) return;
    await tx_deleteVideo(d.audioId);
    if (onDrive) { Sync.forgetVideo(d.audioId); Sync._remote = Sync._remote.filter((x) => x !== onDrive); }
    loadDocVideo(d);
    renderStorage();
    toast('Vidéo supprimée.', 'ok', 2500);
  };
  // Place libérée : la copie du PC est effacée, celle de Drive reste
  $('#doc-video-drive').addEventListener('click', async (e) => {
    if (e.target.id !== 'doc-video-free') return;
    const d = state.doc;
    if (!d?.audioId || !Sync.videoOnDrive(d.audioId)) return;
    if (!(await ask('Libérer la place sur ce PC ?', 'La vidéo reste dans ton Google Drive : elle sera retéléchargée si tu veux la revoir ici.', 'Libérer la place'))) return;
    await tx_deleteVideo(d.audioId);
    loadDocVideo(d);
    renderStorage();
    toast('Place libérée : la vidéo reste dans Google Drive.', 'ok', 3500);
  });
  $('#doc-video-get').onclick = async () => {
    const d = state.doc;
    if (!d?.audioId) return;
    const b = $('#doc-video-get');
    b.disabled = true;
    b.textContent = 'Téléchargement depuis Google Drive…';
    try { await Sync.pullVideo(d.audioId); } catch (err) { toast(`Vidéo indisponible : ${err.message}`, 'err', 6000); }
    b.disabled = false;
    b.textContent = 'Télécharger pour la lire ici';
    if (state.doc === d) loadDocVideo(d);
  };
  // Option « Garder la vidéo de l'écran »
  $('#toggle-video').checked = state.keepVideo;
  $('#toggle-video').onchange = (e) => { state.keepVideo = e.target.checked; store.set('video', state.keepVideo ? '1' : '0'); renderCapture(); };
}

// Audios.remove(id) supprime l'audio ET sa vidéo : ici on ne veut que la vidéo
const tx_deleteVideo = (audioId) => Audios.removeOnly(videoIdOf(audioId)).catch(() => {});

export function renderCapture() {
  const m = captureMode();
  $('#capture-row').hidden = !canCaptureSystem();
  $('#video-opt').hidden = m === 'mic';
  $('#toggle-video').disabled = micBusy();
  $$('#capture-seg button').forEach((b) => {
    b.setAttribute('aria-selected', String(b.dataset.capture === m));
    b.disabled = micBusy();
  });
}

// Forme d'onde de la scène : des barres fixes dont la hauteur suit le niveau réel du micro.
let heroLvl = 0, heroAt = 0;
function heroLevel(l) {
  const hero = $('#rec-hero');
  if (!hero || !micBusy()) return;
  const now = performance.now();
  heroLvl = Math.max(Math.min(1, l * 1.4), heroLvl * 0.85); // montée immédiate, retombée douce
  if (now - heroAt < 60) return;
  heroAt = now;
  hero.style.setProperty('--lvl', heroLvl.toFixed(3));
}
function ensureWave() {
  const w = $('#rec-hero .rec-wave');
  if (!w || w.childElementCount) return;
  w.innerHTML = Array.from({ length: 90 }, (_, i) => {
    const v = Math.abs(Math.sin(i * 0.37 + 2) * 0.55 + Math.sin(i * 0.11 + 4) * 0.35 + Math.sin(i * 1.7) * 0.1);
    return `<i style="--h:${Math.round((0.12 + v * 0.88) * 100)}%"></i>`;
  }).join('');
}

export function renderRec() {
  const s = micBusy() ? recorder.state : 'idle';
  ensureWave();
  const hero = $('#rec-hero');
  if (hero) {
    hero.classList.toggle('live', s !== 'idle');
    hero.classList.toggle('paused', s === 'paused');
    if (s === 'idle') { heroLvl = 0; hero.style.setProperty('--lvl', '0'); }
  }
  if ($('#rec-actions')) $('#rec-actions').hidden = s === 'idle';
  // En direct, l'arrêt termine aussi la transcription
  if ($('#rec-stop span')) $('#rec-stop span').textContent = state.rec?.live ? 'Arrêter et transcrire' : 'Arrêter';
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
