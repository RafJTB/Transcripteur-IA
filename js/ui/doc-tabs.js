// Onglets d une réunion : analyse, actions, résumé, réglages de la page.

import { CONF } from '../monitor.js';
import { actionsToMarkdown, extractActions } from '../actions.js';
import { defaultSpeakerName, speakerColor, speakingTime } from '../speakers.js';
import { fmtClock } from '../exporters.js';
import { $, $$, esc, state, store, toast } from './core.js';
import { langName, langSummary, renderSegments, saveDoc, sendToClaude } from './doc.js';
import { fmtLag, player } from './recording.js';
import { applySpeakers, closeSpeakerMenu, identifySpeakers, learnSpeaker, renderSpeakers, spkCache } from './speakers.js';
import { persist } from './transcription.js';
import { setDocTab, setView, toggleSheet } from './views.js';

const ICON_OK = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.6 2.5L16 9.5"/></svg>';
const ICON_WARN = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5M12 16h.01"/></svg>';

/** Panneau de droite : répartition des intervenants et qualité de la transcription. */
export function renderInsights() {
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
export function renderAnalysis() {
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
    ...(d.liveLag ? [['Décalage du direct', `${fmtLag(d.liveLag.avg)} en moyenne · max ${fmtLag(d.liveLag.max)}`]] : []),
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
export function docActions(d = state.doc) {
  if (!d || !state.segments.length) return [];
  const st = d.actionState || {};
  return extractActions(state.segments, { speakers: d.speakers || [], meetingTime: d.createdAt })
    .map((x) => ({ ...x, done: st[x.key] === 'done', hidden: st[x.key] === 'hidden' }));
}

const fmtDue = (date) => date.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });

/** Onglet Actions : relevé de décisions et d'actions (qui fait quoi, pour quand). */
export function renderActions() {
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

export function bindActions() {
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
export function renderSummary() {
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

export function bindV3() {
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

export function bindSpeakers() {
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
