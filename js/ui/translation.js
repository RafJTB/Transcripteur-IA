// Traduction (automatique, en direct, à la demande).

import { LANGUAGES, isStreaming } from '../config.js';
import { chromeAvailability, createTranslator, describeEngine, localCached, localPlan } from '../translate.js';
import { guessLang } from '../langid.js';
import { $, ask, esc, fmtDuration, lsGet, lsSet, modelById, state, store, toast } from './core.js';
import { tool } from './diagnostic.js';
import { hasTranslation, langFrom, renderSegments, renderView, saveDoc } from './doc.js';
import { notify } from './notifs.js';
import { micBusy, renderLive } from './recording.js';
import { persist } from './transcription.js';

const TR_WORKER = new URL('../translate-worker.js', import.meta.url);

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

export let autoRun = null;
/** Traduit en français les phrases d'une autre langue (après une transcription ou à la demande). */
export async function autoTranslate(doc) {
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
export function liveTranslate(session) {
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
export function carryTranslations(finalSegs, oldSegs) {
  const byText = new Map(oldSegs.filter((s) => s.tr != null).map((s) => [s.text.trim(), s]));
  for (const s of finalSegs) {
    const o = byText.get(s.text.trim());
    if (o) Object.assign(s, { tr: o.tr, lang: o.lang });
  }
}

export async function translateDoc() {
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
