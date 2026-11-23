// Réunion ouverte : affichage, phrases, recherche, enregistrement, Claude, vues, export.

import { Audios, History } from '../history.js';
import { AI_TARGETS, CLAUDE_NEW, SUMMARY_TYPES, aiTarget, buildPrompt, claudeUrl } from '../claude-export.js';
import { CONF } from '../monitor.js';
import { LANGUAGES } from '../config.js';
import { Sync } from '../cloud.js';
import { applyLexicon, compileLexicon } from '../lexicon.js';
import { download, fmtClock, safeFilename, toMarkdown, toSrt, toTxt } from '../exporters.js';
import { segmentAt } from '../player.js';
import { speakerColor } from '../speakers.js';
import { renderDocFolder } from './account.js';
import { $, $$, CLAUDE_ICON, ask, esc, fmtDuration, fold, lsGet, lsSet, state, toast, writeClipboard } from './core.js';
import { tool } from './diagnostic.js';
import { renderAnalysis, renderInsights, renderSummary } from './doc-tabs.js';
import { renderStorage } from './engine.js';
import { clearAudio, loadDocVideo, micBusy, monitor, player, recorder } from './recording.js';
import { renderSpeakers, speakerNames } from './speakers.js';
import { hideResume, persist } from './transcription.js';
import { setView } from './views.js';
import { renderBar } from './verify-ui.js';

// ======================================================================
// Résultat
// ======================================================================
const lexRules = () => compileLexicon(state.lexicon);
export const applyLexiconTo = (segs) => { const r = lexRules(); return segs.map((s) => (s.lang && s.lang !== 'fr' ? s : { ...s, text: applyLexicon(s.text, r) })); };

export function showDoc(doc, { editable = true } = {}) {
  state.doc = doc;
  loadDocVideo(doc);
  state.segments = doc.segments || [];
  $('#result-title').value = doc.title;
  renderMeta();
  renderSegments(state.segments, { editable });
  renderSpeakers();
  renderSummary();
  renderDocFolder();
  setView('doc');
  renderBar();
}

export function clearResult() {
  state.doc = null;
  loadDocVideo(null);
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

export function renderMeta() {
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
    const low = withC.filter((x) => x.conf < CONF.fair && !x.vok && !x.vfix).length + state.segments.filter((x) => x.vcheck && (x.conf == null || x.conf >= CONF.fair)).length;
    if (low) chips.push(metaChip('check', `${low} à vérifier`, { cls: 'tocheck', title: 'Aller au passage suivant à vérifier (souligné dans le texte)' }));
  }
  el.innerHTML = chips.join('');
  renderInsights();
  if (state.dtab === 'analysis') renderAnalysis();
}

export function langSummary(segs) {
  const n = {};
  for (const s of segs) if (s.lang) n[s.lang] = (n[s.lang] || 0) + 1;
  const langs = Object.keys(n).sort((a, b) => n[b] - n[a]);
  if (!langs.length || (langs.length === 1 && langs[0] === 'fr')) return null;
  return langs.map((l) => langName(l).toLowerCase()).join(' + ');
}

/** Pastilles « Volume » / « Compréhension » + conseil sous le graphique. */
export function renderMonitorState({ volume, conf }) {
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

export function showWaiting(on) {
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

export function renderSegments(segs, { editable = true } = {}) {
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
      row.innerHTML = '<button class="spk" type="button" title="Changer l’intervenant de ce passage"></button><button class="ts" type="button"></button><div class="txt" spellcheck="true"></div><div class="tr" spellcheck="true" lang="fr"></div><button class="vmark" type="button" hidden></button><span class="turn-range"></span>';
      t.insertBefore(row, typing || null);
    }
    row.classList.toggle('partial', !editable);
    row.classList.toggle('tentative', !!s.tentative);
    row.classList.toggle('gap', i > 0 && s.start - segs[i - 1].end > 2);
    const low = !s.tentative && s.conf != null && s.conf < CONF.fair;
    row.classList.toggle('low-conf', low && !s.vok && !s.vfix);
    // Vérification : phrase corrigée par la seconde écoute, ou désaccord entre les deux écoutes
    row.classList.toggle('vfix', !!s.vfix);
    row.classList.toggle('vcheck', !!s.vcheck);
    row.classList.toggle('vok', !!s.vok);
    const vm = $('.vmark', row);
    const vFirst = (s.vfix || s.vcheck) && (i === 0 || (segs[i - 1].vfix || segs[i - 1].vcheck) !== (s.vfix || s.vcheck));
    vm.hidden = !vFirst || !editable;
    if (vFirst) { vm.dataset.i = i; vm.textContent = s.vfix ? 'corrigé' : 'à vérifier'; vm.title = s.vfix ? 'Corrigé par la seconde écoute : voir l’avant / après' : 'Les deux écoutes ne sont pas d’accord : choisir'; }
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

export function onPlayerTime(t, playing) {
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

export const find = {
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
export function saveDoc(debounce = 0) {
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

const aiIcon = () => CLAUDE_ICON; // icône neutre, quelle que soit l'IA

/** Claude (pour l'assistant et les anciens appels). */
export const openInClaude = (prompt) => openInAI(prompt, 'claude');

/**
 * Ouvre une IA (Claude ou Copilot) avec la consigne : elle est copiée, puis collée par l'utilisateur.
 * @param {string} prompt consigne
 * @param {string} key cible (AI_TARGETS)
 * @param {{file?: string}} o fichier téléchargé à joindre (transcription trop longue)
 */
export async function openInAI(prompt, key = 'claude', { file = '' } = {}) {
  const t = aiTarget(key);
  const url = t.key === 'claude' ? claudeUrl(prompt) : null;
  const copied = await writeClipboard(prompt);
  tool.open(`Ouvrir dans ${t.label}`);
  const go = await tool.show({
    step: 'Dernière étape',
    html: `<div class="cl-paste"><span class="cl-logo">${aiIcon(t.key)}</span><div>
      <p><b>${copied ? 'Ta consigne est copiée' : 'Copie automatique impossible'}</b> (${prompt.length.toLocaleString('fr-FR')} caractères)${copied ? '.' : ' : le navigateur a bloqué le presse-papiers.'}</p>
      ${file ? `<p class="cl-file">La transcription était trop longue pour la zone de message de ${esc(t.label)} : elle a été <b>téléchargée</b> dans le fichier « ${esc(file)} ».</p>` : ''}
      <ol><li>${copied ? `Clique sur « Ouvrir ${esc(t.label)} »${t.key === 'claude' ? '' : ' (connecte-toi si besoin)'}.` : `Clique sur « Copier », puis sur « Ouvrir ${esc(t.label)} ».`}</li>
        ${file ? `<li>Joins le fichier « ${esc(file)} » (bouton <b>+</b> ou trombone, ou glisse-le dans la conversation).</li>` : ''}
        <li>${url ? 'Si la consigne n’apparaît pas dans la zone de message, clique dedans' : 'Clique dans la zone de message'} et fais <kbd>Ctrl</kbd> + <kbd>V</kbd> (<kbd>⌘</kbd> + <kbd>V</kbd> sur Mac).</li><li>Appuie sur <kbd>Entrée</kbd>.</li></ol></div></div>
      ${copied ? '' : `<textarea class="cl-raw" readonly rows="4">${esc(prompt.slice(0, 200000))}</textarea><button class="btn sm" type="button" id="cl-copy-again">Copier</button>`}`,
    actions: [{ label: 'Annuler', value: null }, { label: `Ouvrir ${t.label}`, value: true, primary: true }],
  });
  tool.close();
  if (!go) return;
  const win = window.open(url || t.url, '_blank');
  if (win) win.opener = null;
  if (!win) toast(`Le navigateur a bloqué l’ouverture de ${t.label} : ouvre ${t.url.replace(/^https:\/\//, '').replace(/\/$/, '')} et colle la consigne (Ctrl + V).`, 'warn', 9000);
  else if (url) toast('Claude s’ouvre avec ta consigne : vérifie et envoie. (Elle est aussi copiée, au cas où.)', 'ok', 6000);
  else toast(`Dans ${t.label} : ${file ? 'joins le fichier, puis ' : ''}Ctrl + V et Entrée.`, 'ok', 8000);
}

export async function copyText() {
  await writeClipboard(toTxt(shownSegments(), { timestamps: tsOn(), speakers: speakerNames() }));
  toast('Texte copié dans le presse-papiers.', 'ok', 2500);
}

function docMeta() {
  const d = state.doc;
  return [d?.source, d?.durationS ? `durée ${fmtClock(d.durationS)}` : null, new Date(d?.createdAt || Date.now()).toLocaleString('fr-FR')]
    .filter(Boolean).join(' · ');
}

/** Résumer avec Claude : choix du type de résumé, puis ouverture de claude.ai avec la consigne. */
export async function sendToClaude(preset = null) {
  if (!state.segments.length) return;
  const last = typeof preset === 'string' ? preset : lsGet('claude.type', 'cr');
  const ts = lsGet('claude.ts', '1') === '1';
  const target = lsGet('summary.target', 'claude');
  tool.open('Résumer avec une IA');
  const go = await tool.show({
    step: 'Résumé',
    html: `<p>Choisis l’IA et le type de résumé : la consigne et la transcription sont préparées, il n’y a plus qu’à coller et envoyer.</p>
      <div class="ai-pick" role="radiogroup" aria-label="IA">${AI_TARGETS.map((t) => `<label class="ai-opt"><input type="radio" name="ai-target" value="${t.key}"${t.key === aiTarget(target).key ? ' checked' : ''} /><span><strong>${esc(t.label)}</strong><small>${esc(t.sub)}</small></span></label>`).join('')}</div>
      <div class="cl-types">${SUMMARY_TYPES.map((t) => `<label class="cl-type"><input type="radio" name="cl-type" value="${t.key}"${t.key === last ? ' checked' : ''} />
        <span><strong>${esc(t.label)}</strong><small>${esc(t.short)}</small></span></label>`).join('')}</div>
      <label class="cl-field"><span>Consignes en plus <em>(facultatif)</em></span>
        <textarea id="cl-extra" rows="2" placeholder="Ex. : réunion de synthèse BIM, mets en avant les conflits entre lots">${esc(lsGet('claude.extra', ''))}</textarea></label>
      <label class="modal-check"><input type="checkbox" id="cl-ts"${ts ? ' checked' : ''} /><span>Inclure les horodatages (l’IA pourra citer les moments)</span></label>
      <p class="cl-note" id="ai-privacy">Confidentialité : jusqu’ici tout restait sur ton PC. ${esc(aiTarget(target).privacy)} L’audio, lui, ne quitte pas ton PC.</p>`,
    actions: [{ label: 'Annuler', value: null }, { label: 'Continuer', value: true, primary: true }],
    onRender: () => document.querySelectorAll('input[name="ai-target"]').forEach((r) => r.addEventListener('change', () => {
      const n = $('#ai-privacy');
      if (n) n.textContent = `Confidentialité : jusqu’ici tout restait sur ton PC. ${aiTarget(r.value).privacy} L’audio, lui, ne quitte pas ton PC.`;
    })),
  });
  if (!go) return;
  const key = document.querySelector('input[name="ai-target"]:checked')?.value || 'claude';
  lsSet('summary.target', key);
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
  // Trop long pour la zone de message de Copilot : transcription téléchargée en fichier, consigne seule copiée
  const t = aiTarget(key);
  if (prompt.length > t.max) {
    const title = $('#result-title').value.trim() || state.doc?.title || 'Transcription';
    const file = `${safeFilename(title)}.txt`;
    const head = [`Titre : ${title}`, `Infos : ${docMeta()}`, ''].join('\n');
    download(file, head + toTxt(shownSegments(), { timestamps: withTs, speakers: speakerNames() }), 'text/plain');
    const short = buildPrompt({
      type, extra, title, meta: docMeta(), transcript: '', speakers: speakerNames(), attached: file,
      language: langName(state.doc?.language || 'fr').toLowerCase(),
      translatedFrom: currentView() !== 'orig' ? (langSummary(state.segments) || langName(state.doc?.translation?.from).toLowerCase()) : null,
      both: currentView() === 'both',
    });
    return openInAI(short, key, { file });
  }
  await openInAI(prompt, key);
}

// ======================================================================
// Traduction (locale) vers le français
// ======================================================================
export const langName = (code) => LANGUAGES.find((l) => l[0] === code)?.[1] ?? code ?? '';
/** « de l’anglais », « du russe »… */
export function langFrom(code) {
  const n = langName(code).toLowerCase();
  if (!n) return '';
  if (/^[aeiouéèh]/.test(n)) return `de l’${n}`;
  return { russe: 'du russe', turc: 'du turc', chinois: 'du chinois', japonais: 'du japonais', portugais: 'du portugais', polonais: 'du polonais', roumain: 'du roumain', néerlandais: 'du néerlandais' }[n] || `de ${n}`;
}
export const hasTranslation = () => state.segments.some((s) => s.tr != null);
const currentView = () => (hasTranslation() ? state.view : 'orig');

export function renderView() {
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
export function shownSegments() {
  const view = currentView();
  if (view === 'orig') return state.segments;
  return state.segments.map((s) => ({ ...s, text: view === 'tr' ? (s.tr || s.text) : s.tr ? `${s.text}\n→ ${s.tr}` : s.text }));
}

export function exportAs(fmt) {
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

export function updateButtons() {
  const busy = state.phase !== 'idle';
  const recording = micBusy();
  const has = state.segments.length > 0 && !busy;
  const btn = $('#btn-transcribe');
  btn.disabled = !state.audio || busy || recording || !state.caps;
  btn.classList.toggle('busy', busy);
  $('span', btn).textContent = {
    loading: 'Chargement du modèle…', transcribing: 'Transcription en cours…', live: 'Transcription en direct…',
  }[state.phase] || 'Transcrire';
  $('#btn-cancel').hidden = !(state.phase === 'loading' || state.phase === 'transcribing' || state.phase === 'verifying');
  $$('[data-export], #btn-report, #act-report, #btn-copy, #btn-relex, #btn-claude, #btn-claude-tab, #btn-translate, #btn-speakers, #act-copy, #act-claude').forEach((b) => (b.disabled = !has));
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
export async function deleteRecording() {
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
