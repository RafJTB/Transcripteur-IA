// Vérification d'une transcription : un modèle plus précis réécoute les passages douteux (ou tout),
// puis on compare. Accord → validé ; nouvelle écoute plus sûre → corrigé (annulable) ; désaccord → « à vérifier ».

import { MODELS, SAMPLE_RATE as SR, isStreaming, pickVariant } from '../config.js';
import { decodeToMono16k } from '../audio.js';
import { fmtClock } from '../exporters.js';
import { VERIFY, carrySpeakers, compareBlock, planBlocks } from '../verify.js';
import { $, caps, esc, progress, state, store, toast } from './core.js';
import { applyLexiconTo, renderMeta, renderSegments } from './doc.js';
import { request } from './engine.js';
import { carryTranslations } from './translation.js';
import { confirmBigDownload, ensureLoaded, getAudio, persist } from './transcription.js';
import { player } from './recording.js';

const RANK = { base: 1, small: 2, turbo: 3 };
const clean = ({ vfix, vcheck, vok, vgrp, ...s }) => s;
let seq = 0;

/** Vérifier automatiquement après chaque transcription (rapide, sur les passages douteux). */
export const autoVerifyOn = () => store.get('verify.auto', '1') === '1';

/** Modèle qui réécoute : le plus précis disponible sur cet appareil (Whisper, pas le direct Voxtral). */
export function verifierModel(doc) {
  const c = caps() || {};
  const order = c.webgpu ? ['turbo', 'small', 'base'] : ['small', 'turbo', 'base'];
  const ok = order.map((id) => MODELS.find((m) => m.id === id)).filter((m) => m && !isStreaming(m) && pickVariant(m, c));
  const mine = RANK[doc?.modelId] || 0;
  // Sur le processeur, « small » suffit sauf si la transcription l'a déjà utilisé
  return ok.find((m) => (RANK[m.id] || 0) > mine) || ok[0] || null;
}

/** Faut-il vérifier tout seul cette transcription (à la fin) ? Modèle déjà téléchargé seulement. */
export function shouldAutoVerify(doc) {
  if (!autoVerifyOn() || !doc?.segments?.length || !doc.audioId) return false;
  const m = verifierModel(doc);
  if (!m || !state.cache?.[m.id]) return false;
  return planBlocks(doc.segments, { mode: 'quick' }).length > 0;
}

async function pcmOf(doc) {
  if (state.audio?.docId === doc.id && state.audio.pcm) return state.audio.pcm;
  const rec = doc.audioId ? await getAudio(doc.audioId) : null;
  if (!rec?.blob) return null;
  return decodeToMono16k(rec.blob);
}

/**
 * Lance la vérification.
 * @param {object} doc transcription
 * @param {{mode?: 'quick'|'full', auto?: boolean}} o
 */
export async function verifyDoc(doc, { mode = 'quick', auto = false } = {}) {
  if (!doc?.segments?.length) return;
  if (state.phase !== 'idle') { if (!auto) toast('Attends la fin de la transcription en cours.', 'warn'); return; }
  if (!doc.audioId) { if (!auto) toast('L’audio de cette transcription n’est plus là : impossible de la réécouter.', 'warn', 5000); return; }
  const blocks = planBlocks(doc.segments, { mode });
  if (!blocks.length) {
    if (!auto) toast(mode === 'quick' ? 'Aucun passage douteux : le modèle était sûr de lui partout. « Tout réécouter » vérifie quand même tout le texte.' : 'Rien à vérifier (phrases corrigées à la main exclues).', 'ok', 6000);
    return;
  }
  const model = verifierModel(doc);
  if (!model) { if (!auto) toast('Aucun modèle de vérification disponible sur cet appareil.', 'warn'); return; }
  // Tests automatisés : seconde écoute simulée (window.__verifyTranscribe), sans modèle à télécharger
  const fake = typeof window.__verifyTranscribe === 'function' ? window.__verifyTranscribe : null;
  if (!auto && !fake && !(await confirmBigDownload(model))) return;
  const same = (RANK[model.id] || 0) <= (RANK[doc.modelId] || 0);
  state.phase = 'verifying';
  state.verifying = { cancel: false, docId: doc.id };
  renderBar();
  const label = `Vérification (${model.name.replace(/^Whisper /, '')})`;
  progress.show(`${label} : préparation…`, { sub: mode === 'quick' ? `${blocks.length} passage${blocks.length > 1 ? 's' : ''} douteux à réécouter` : 'tout le texte est réécouté' });
  const stats = { checked: 0, ok: 0, fixed: 0, doubt: 0 };
  const v = (doc.verify ??= { changes: [], doubts: [] });
  try {
    const pcm = await pcmOf(doc);
    if (!pcm) throw new Error('Audio illisible.');
    if (!fake) await ensureLoaded(model);
    const lang = doc.language && doc.language !== 'auto' ? doc.language : state.language;
    // Phrases d'origine de chaque passage (les indices bougent quand on remplace)
    const work = blocks.map((b) => ({ ...b, orig: doc.segments.slice(b.from, b.to + 1) }));
    for (let k = 0; k < work.length; k++) {
      if (state.verifying.cancel) break;
      const b = work[k];
      progress.show(`${label} : passage ${k + 1} / ${work.length}`, { value: (k / work.length) * 100, sub: `${fmtClock(b.start)} – ${fmtClock(b.end)} · ${stats.fixed} corrigé${stats.fixed > 1 ? 's' : ''}, ${stats.doubt} à vérifier` });
      const a = Math.max(0, b.start - 0.3), e = Math.min(pcm.length / SR, b.end + 0.3);
      const audio = pcm.slice(Math.floor(a * SR), Math.ceil(e * SR));
      const res = fake
        ? await fake({ start: b.start, end: b.end, offsetS: a, samples: audio.length, text: b.orig.map((s) => s.text).join(' ') })
        : await request({ type: 'transcribe', jobId: `verify-${++seq}`, audio, language: lang, chunkLengthS: 0, offsetS: a, quiet: true }, ['result', 'cancelled'], [audio.buffer]);
      const cand = applyLexiconTo((res.segments || []).filter((s) => s.text?.trim()));
      const r = compareBlock(b.orig, cand, { focus: mode === 'quick' });
      stats.checked += b.orig.length;
      const at = doc.segments.indexOf(b.orig[0]);
      if (at < 0) continue; // modifié entre-temps
      if (r.verdict === 'ok') {
        stats.ok++;
        b.orig.forEach((s) => { delete s.vcheck; s.vok = true; });
      } else if (r.verdict === 'fixed') {
        stats.fixed++;
        const id = `c${Date.now().toString(36)}${k}`;
        const after = carrySpeakers(cand, b.orig).map((s) => ({ ...s, vfix: id }));
        carryTranslations(after, b.orig);
        doc.segments.splice(at, b.orig.length, ...after);
        v.changes.push({ id, start: b.start, end: b.end, before: b.orig.map(clean), after: after.map(clean), conf: [r.before, r.after] });
      } else {
        stats.doubt++;
        const id = `d${Date.now().toString(36)}${k}`;
        // Tout le passage est mémorisé (vgrp) ; seules les phrases peu sûres sont marquées « à vérifier »,
        // pas les voisines ajoutées pour donner du contexte au modèle
        const unsure = b.orig.filter((s) => s.conf == null || s.conf < 0.8);
        b.orig.forEach((s) => { s.vgrp = id; delete s.vok; });
        (unsure.length ? unsure : b.orig).forEach((s) => { s.vcheck = id; });
        v.doubts.push({ id, start: b.start, end: b.end, alt: cand.map((s) => s.text.trim()).join(' '), altSegs: cand.map(clean), conf: [r.before, r.after] });
      }
      if (state.doc === doc) { state.segments = doc.segments; renderSegments(state.segments); }
    }
    Object.assign(v, { at: Date.now(), model: model.name, mode, last: stats, same, cancelled: !!state.verifying.cancel });
    // Les listes ne gardent que ce qui est encore dans le texte
    v.changes = v.changes.filter((c) => doc.segments.some((s) => s.vfix === c.id));
    v.doubts = v.doubts.filter((d) => doc.segments.some((s) => s.vcheck === d.id));
    doc.segments.forEach((s) => { if (s.vgrp && !v.doubts.some((d) => d.id === s.vgrp)) delete s.vgrp; });
    await persist(doc);
    const msg = `${stats.checked} phrase${stats.checked > 1 ? 's' : ''} réécoutée${stats.checked > 1 ? 's' : ''} : ${stats.fixed} corrigée${stats.fixed > 1 ? 's' : ''}, ${stats.doubt} à vérifier${state.verifying.cancel ? ' (arrêtée avant la fin)' : ''}.`;
    toast(`Vérification terminée · ${msg}`, stats.doubt || stats.fixed ? 'info' : 'ok', 6000);
  } catch (e) {
    console.warn(e);
    toast(`Vérification impossible : ${e.message}`, 'err', 7000);
  } finally {
    state.phase = 'idle';
    state.verifying = null;
    progress.hide();
    if (state.doc === doc) { state.segments = doc.segments; renderSegments(state.segments); renderMeta(); }
    renderBar();
  }
}

/** Arrête la vérification après le passage en cours. */
export function stopVerify() { if (state.verifying) { state.verifying.cancel = true; progress.show('Arrêt de la vérification…', { sub: 'fin du passage en cours' }); } }

// ---------- Bandeau et marques dans le texte ----------
function issues() {
  const segs = state.segments || [];
  const out = [];
  segs.forEach((s, i) => {
    const key = s.vfix || s.vcheck;
    if (key && (i === 0 || (segs[i - 1].vfix || segs[i - 1].vcheck) !== key)) out.push({ i, kind: s.vfix ? 'fix' : 'check' });
  });
  return out;
}

export function renderBar() {
  const bar = $('#verify-bar');
  if (!bar) return;
  const d = state.doc;
  const running = state.verifying?.docId === d?.id;
  const v = d?.verify;
  const list = issues();
  const fixes = list.filter((x) => x.kind === 'fix').length;
  const checks = list.length - fixes;
  bar.hidden = !d || !state.segments?.length || d.status === 'live' || d.status === 'running';
  if (bar.hidden) return;
  const ico = '<svg viewBox="0 0 24 24"><path d="M12 3 5 6v5c0 4.5 3 8.3 7 10 4-1.7 7-5.5 7-10V6z"/><path d="m9 12 2 2 4-4"/></svg>';
  let html;
  if (running) html = `<span class="vb-ico spin">${ico}</span><span class="vb-txt"><b>Vérification en cours…</b><small>Un modèle plus précis réécoute l’audio.</small></span><button class="btn xs" type="button" data-v="stop">Arrêter</button>`;
  else if (v?.at) {
    const when = new Date(v.at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
    html = `<span class="vb-ico ${checks ? 'warn' : 'ok'}">${ico}</span><span class="vb-txt"><b>Vérifiée ${fixes || checks ? `· <i class="vfix-c">${fixes} corrigé${fixes > 1 ? 's' : ''}</i> · <i class="vcheck-c">${checks} à vérifier</i>` : '· aucune différence'}</b><small>Seconde écoute par ${esc(v.model || '')} le ${when}${v.mode === 'full' ? ' (tout le texte)' : ' (passages douteux)'}${v.same ? ' · même modèle que la transcription' : ''}</small></span>
      ${list.length ? '<span class="vb-nav"><button class="icon-btn xs" type="button" data-v="prev" aria-label="Différence précédente"><svg viewBox="0 0 24 24"><path d="m15 6-6 6 6 6"/></svg></button><button class="icon-btn xs" type="button" data-v="next" aria-label="Différence suivante"><svg viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg></button></span>' : ''}
      ${v.mode !== 'full' ? '<button class="btn xs" type="button" data-v="full">Tout réécouter</button>' : ''}`;
  } else {
    const low = planBlocks(state.segments, { mode: 'quick' }).length;
    html = `<span class="vb-ico">${ico}</span><span class="vb-txt"><b>${low ? `${low} passage${low > 1 ? 's' : ''} douteux` : 'Pas encore vérifiée'}</b><small>Un modèle plus précis peut réécouter l’audio et comparer.</small></span><button class="btn xs primary" type="button" data-v="quick"${low ? '' : ' hidden'}>Vérifier</button><button class="btn xs" type="button" data-v="full">Tout réécouter</button>`;
  }
  bar.innerHTML = html;
}

let cursor = -1;
function go(step) {
  const list = issues();
  if (!list.length) return;
  cursor = (cursor + step + list.length) % list.length;
  const row = document.querySelectorAll('#transcript .segment')[list[cursor].i];
  row?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  row?.classList.add('flash');
  setTimeout(() => row?.classList.remove('flash'), 1300);
}

/** Petite fenêtre sur une phrase corrigée ou douteuse : avant / après, annuler, garder, remplacer, écouter. */
function openPop(btn) {
  const d = state.doc;
  const i = Number(btn.dataset.i);
  const s = state.segments[i];
  if (!d || !s) return;
  closePop();
  const pop = document.createElement('div');
  pop.className = 'v-pop';
  pop.id = 'v-pop';
  if (s.vfix) {
    const c = d.verify?.changes.find((x) => x.id === s.vfix);
    pop.innerHTML = `<p class="vp-h">Corrigé par la seconde écoute</p>
      <div class="vp-row"><small>Avant</small><p class="vp-before">${esc(c ? c.before.map((x) => x.text.trim()).join(' ') : '—')}</p></div>
      <div class="vp-row"><small>Après</small><p>${esc(c ? c.after.map((x) => x.text.trim()).join(' ') : s.text)}</p></div>
      ${c?.conf ? `<p class="vp-note">Confiance : ${Math.round((c.conf[0] ?? 0) * 100)} % → ${Math.round((c.conf[1] ?? 0) * 100)} %</p>` : ''}
      <div class="vp-acts"><button class="btn xs" type="button" data-vp="play">Écouter</button><button class="btn xs" type="button" data-vp="undo">Annuler la correction</button><button class="btn xs primary" type="button" data-vp="keep">OK</button></div>`;
  } else {
    const o = d.verify?.doubts.find((x) => x.id === s.vcheck);
    pop.innerHTML = `<p class="vp-h">Les deux écoutes ne sont pas d’accord</p>
      <div class="vp-row"><small>Transcription</small><p>${esc(state.segments.filter((x) => (x.vgrp || x.vcheck) === s.vcheck).map((x) => x.text.trim()).join(' '))}</p></div>
      <div class="vp-row"><small>Seconde écoute</small><p>${o?.alt ? esc(o.alt) : '<i>rien entendu</i>'}</p></div>
      <div class="vp-acts"><button class="btn xs" type="button" data-vp="play">Écouter</button>${o?.alt ? '<button class="btn xs" type="button" data-vp="take">Prendre la seconde écoute</button>' : ''}<button class="btn xs primary" type="button" data-vp="ok">Garder</button></div>`;
  }
  pop.dataset.i = i;
  document.body.append(pop);
  const r = btn.getBoundingClientRect();
  pop.style.left = `${Math.max(12, Math.min(r.left - 8, innerWidth - pop.offsetWidth - 12))}px`;
  pop.style.top = `${r.bottom + pop.offsetHeight + 10 > innerHeight ? r.top - pop.offsetHeight - 8 : r.bottom + 8}px`;
}
function closePop() { document.getElementById('v-pop')?.remove(); }

async function popAction(act, i) {
  const d = state.doc;
  const s = state.segments[i];
  if (!d || !s) return closePop();
  const v = d.verify;
  if (act === 'play') {
    const key = s.vfix || s.vcheck;
    const first = state.segments.findIndex((x) => (x.vfix || x.vcheck) === key);
    if (state.audio) player.seek(state.segments[first].start, { play: true });
    else toast('Ouvre l’audio de la transcription pour écouter.', 'info', 3000);
    return;
  }
  if (act === 'keep') return closePop();
  if (act === 'undo') {
    const c = v.changes.find((x) => x.id === s.vfix);
    const at = d.segments.findIndex((x) => x.vfix === s.vfix);
    const n = d.segments.filter((x) => x.vfix === s.vfix).length;
    if (c && at >= 0) d.segments.splice(at, n, ...c.before.map((x) => ({ ...x, vok: true })));
    v.changes = v.changes.filter((x) => x.id !== s.vfix);
  }
  if (act === 'ok') {
    const id = s.vcheck;
    d.segments.forEach((x) => { if (x.vcheck === id || x.vgrp === id) { const was = x.vcheck === id; delete x.vcheck; delete x.vgrp; if (was) x.vok = true; } });
    v.doubts = v.doubts.filter((x) => x.id !== id);
  }
  if (act === 'take') {
    const id = s.vcheck;
    const o = v.doubts.find((x) => x.id === id);
    const inGroup = (x) => (x.vgrp || x.vcheck) === id;
    const at = d.segments.findIndex(inGroup);
    const old = d.segments.filter(inGroup);
    if (o && at >= 0) {
      const cid = `c${Date.now().toString(36)}`;
      const after = carrySpeakers(o.altSegs, old).map((x) => ({ ...x, vfix: cid }));
      d.segments.splice(at, old.length, ...after);
      v.changes.push({ id: cid, start: o.start, end: o.end, before: old.map(clean), after: after.map(clean), conf: o.conf, byUser: true });
    }
    v.doubts = v.doubts.filter((x) => x.id !== id);
  }
  closePop();
  state.segments = d.segments;
  renderSegments(state.segments);
  renderMeta();
  renderBar();
  await persist(d);
}

export function bindVerify() {
  const t = $('#transcript');
  t?.addEventListener('click', (e) => {
    const b = e.target.closest('.vmark');
    if (!b) return;
    e.stopPropagation();
    openPop(b);
  }, true);
  document.addEventListener('click', (e) => {
    const vp = e.target.closest('#v-pop [data-vp]');
    if (vp) return popAction(vp.dataset.vp, Number(e.target.closest('#v-pop').dataset.i));
    if (!e.target.closest('#v-pop, .vmark')) closePop();
    const vb = e.target.closest('#verify-bar [data-v]');
    if (!vb) return;
    const act = vb.dataset.v;
    if (act === 'stop') return stopVerify();
    if (act === 'prev') return go(-1);
    if (act === 'next') return go(1);
    if (act === 'quick' || act === 'full') return verifyDoc(state.doc, { mode: act });
  });
  const tg = $('#toggle-verify');
  if (tg) {
    tg.checked = autoVerifyOn();
    tg.onchange = () => {
      store.set('verify.auto', tg.checked ? '1' : '0');
      toast(tg.checked ? 'Après chaque transcription, les passages douteux seront réécoutés par un modèle plus précis (s’il est déjà téléchargé).' : 'Vérification automatique désactivée.', 'ok', 5000);
    };
  }
}
export const VERIFY_SETTINGS = VERIFY;
