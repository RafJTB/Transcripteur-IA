// Orchestrateur de l'interface : source audio → transcription (worker) → résultat/export.
// Nouveautés : transcription en direct, reprise automatique, suppression des enregistrements.

import { commitStale } from './ui/undo.js';
import { bindSpeakerPick } from './ui/history.js';
import { Look } from './presentation.js';
import { Audios, History, RecChunks } from './history.js';
import { Auth, Folders, Sync } from './cloud.js';
import { CONF, Monitor } from './monitor.js';
import { DEFAULT_LEXICON, saveLexicon } from './lexicon.js';
import { LANGUAGES, TRANSFORMERS_VERSION, pickVariant } from './config.js';
import { Player } from './player.js';
import { buildPrompt } from './claude-export.js';
import { fmtClock, toMarkdown, toSrt, toTxt } from './exporters.js';
import { guessLang } from './langid.js';
import { bindAccount, bindInstall, clearMine, syncNow } from './ui/account.js';
import { $, $$, ask, caps, fmtMB, modelById, state, status, store, toast } from './ui/core.js';
import { bindDashboard } from './ui/dashboard.js';
import { tool } from './ui/diagnostic.js';
import { applyLexiconTo, clearResult, copyText, deleteRecording, exportAs, find, onPlayerTime, renderMeta, renderMonitorState, renderSegments, renderView, saveDoc, sendToClaude, showDoc, shownSegments, updateButtons } from './ui/doc.js';
import { bindActions, bindSpeakers, bindV3 } from './ui/doc-tabs.js';
import { refreshCache, renderEngine, renderLangHint, renderLiveHint, renderModelPick, renderModels, renderStorage, request, signalCrash, startWorker } from './ui/engine.js';
import { renderHistory, renderLexicon } from './ui/history.js';
import { bindBell, notifs, notify } from './ui/notifs.js';
import { applyThemeColors } from './ui/pages.js';
import { bindDocVideo, clearAudio, handleFiles, micBusy, monitor, player, recDiscard, recStop, recToggle, recorder, renderCapture, renderRec, renderRecState, selectTab, setAudioFromBlob, setMonitor, setPlayer, videoIdOf } from './ui/recording.js';
import { autoSetup, bindSound, renderAutoInfo, setAutoTune } from './ui/sound.js';
import { applySpeakers, bindVoices, identifySpeakers, openSpeakerMenu, spkCache } from './ui/speakers.js';
import { cancel, hideResume, isMine, persist, renderResume, startTranscription } from './ui/transcription.js';
import { autoTranslate, translateDoc } from './ui/translation.js';
import { closeDrawers, openDrawer, setView } from './ui/views.js';
import { bindSettings } from './ui/settings-ui.js';
import { bindActionBoard } from './ui/actions-board.js';
import { bindReport } from './ui/report-ui.js';
import { handleCalendarReturn, initCalendar } from './ui/calendar-ui.js';
import { bindVerify, verifyDoc } from './ui/verify-ui.js';
import { finalizeDoc } from './ui/transcription.js';
import { bindStorage } from './ui/storage-ui.js';

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
      if (act.video) {
        const vb = await RecChunks.blob(`${act.id}.video`, 'video/webm').catch(() => null);
        if (vb?.size) await Audios.put({ id: videoIdOf(act.id), blob: vb, name: `${name} (écran)`, createdAt: Date.now(), kind: 'video' }).catch(() => {});
        await RecChunks.remove(`${act.id}.video`).catch(() => {});
      }
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
  bindSettings();
  bindActionBoard();
  bindSpeakerPick();
  commitStale();
  bindActions();
  bindV3();
  bindDashboard();
  bindDocVideo();
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
  $('#proj-new').onclick = () => { setView('record'); selectTab('mic'); };
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

async function init() {
  // Retour de la page de connexion Google (ou reconnexion silencieuse si l'autorisation a expiré)
  let authResult = null;
  try { await handleCalendarReturn(); } catch (e) { console.warn(e); }
  try { authResult = await Auth.handleRedirect(); } catch (e) { authResult = { ok: false, error: e.message }; }
  if (!authResult && Auth.maybeSilentRefresh()) return;
  // Détection automatique de la langue par défaut (une seule fois, l'utilisateur peut revenir au français)
  if (store.get('lang.auto', '') !== '1') {
    store.set('lang.auto', '1');
    if (state.language === 'fr') { state.language = 'auto'; store.set('lang', 'auto'); }
  }
  $('#foot-version').textContent = TRANSFORMERS_VERSION;
  setMonitor(new Monitor($('#monitor-canvas'), { onState: renderMonitorState }));
  // Thème clair / sombre
  $('#btn-theme').onclick = () => {
    const t = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = t;
    store.set('theme', t);
    applyThemeColors();
    Look.touch();
  };
  setPlayer(new Player({
    root: $('#player'), audio: $('#audio-player'), canvas: $('#pl-wave'), play: $('#pl-play'),
    time: $('#pl-time'), dur: $('#pl-dur'), speed: $('#pl-speed'), fmt: fmtClock, onTime: onPlayerTime,
    markers: () => state.segments.filter((x) => !x.tentative && x.conf != null && x.conf < CONF.fair).map((x) => x.start),
  }));
  applyThemeColors();
  renderHistory();
  bind();
  bindAccount(authResult);
  bindInstall();
  bindReport();
  initCalendar();
  bindVerify();
  bindStorage();
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
  notify, notifs, verifyDoc, finalizeDoc,
  Auth, Sync, Folders, syncNow, isMine,
  recorder, monitor: () => monitor, renderMeta, identifySpeakers, applySpeakers, spkCache,
  state, exportAs, sendToClaude, translateDoc, shownSegments, autoTranslate, guessLang, buildPrompt, showDoc, find, player: () => player, toTxt, toSrt, toMarkdown, signalCrash, History, Audios, RecChunks,
  recorderState: () => recorder.state,
  monitorP90: () => { const w = monitor.levels.filter((l) => l.t >= monitor.now - 6).map((l) => l.db).sort((a, b) => a - b); return w[Math.floor(w.length * 0.9)]; },
};
