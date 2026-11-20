// Outils communs de l’interface : sélecteurs, état, formats, notifications, fenêtres de dialogue, stockage local.

import { DEFAULT_MODEL, MODELS } from '../config.js';
import { loadLexicon } from '../lexicon.js';

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const store = {
  get: (k, d) => { try { return localStorage.getItem('transcripteur.' + k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem('transcripteur.' + k, v); } catch { /* ignore */ } },
  del: (k) => { try { localStorage.removeItem('transcripteur.' + k); } catch { /* ignore */ } },
};

export const state = {
  caps: null,
  forceWasm: false,
  cache: {},
  modelId: MODELS.some((m) => m.id === store.get('model')) ? store.get('model') : DEFAULT_MODEL,
  language: store.get('lang', 'auto'),
  autoTr: store.get('autotr', '1') === '1', // traduire automatiquement en français
  keepVideo: store.get('video', '0') === '1', // garder la vidéo de l'écran (visio)
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
export const fmtMB = (mb) => (mb >= 1000 ? `${(mb / 1000).toFixed(2).replace('.', ',')} Go` : `${Math.round(mb)} Mo`);
export const fmtBytes = (b) => (b < 1e6 ? `${Math.max(1, Math.round(b / 1e3))} Ko` : fmtMB(b / 1e6));
export function fmtDuration(s) {
  if (!isFinite(s)) return '—';
  if (s < 60) return `${Math.max(1, Math.round(s))} s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  if (m < 60) return r ? `${m} min ${String(r).padStart(2, '0')} s` : `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}
export const modelById = (id) => MODELS.find((m) => m.id === id);
export const caps = () => ({ ...state.caps, webgpu: state.caps?.webgpu && !state.forceWasm });
export const recName = (d = new Date()) => `Enregistrement ${d.toLocaleDateString('fr-FR')} ${d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;

export function toast(text, kind = 'info', ms = 5000) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, ms);
}

export function status(text, kind = '') {
  const el = $('#status-line');
  el.textContent = text || '';
  el.className = `status-line ${kind}`;
}

/** Confirmation. Renvoie false si annulé, sinon { checked } (case à cocher optionnelle). */
export function ask(title, text, okLabel = 'Continuer', { danger = false, checkbox = null, checked = true } = {}) {
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

export const progress = {
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
// Outils qualité du micro : préréglage PC portable, diagnostic, calibration
// ======================================================================
export const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ======================================================================
// Recherche dans le texte (surlignage sans toucher au texte éditable)
// ======================================================================
export const fold = (c) => {
  const n = c.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  return n.length === 1 ? n : c.toLowerCase().slice(0, 1) || c;
};

export async function writeClipboard(text) {
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

export const CLAUDE_ICON = '<svg class="claude-ico" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" stroke="none" d="M11.47 9.25 L10.79 1.07 L13.21 1.07 L12.53 9.25 L12.91 9.35 L15.70 3.58 L17.45 4.59 L13.84 9.89 L14.11 10.16 L20.86 5.49 L22.07 7.58 L14.65 11.09 L14.75 11.47 L21.14 10.99 L21.14 13.01 L14.75 12.53 L14.65 12.91 L22.07 16.42 L20.86 18.51 L14.11 13.84 L13.84 14.11 L17.45 19.41 L15.70 20.42 L12.91 14.65 L12.53 14.75 L13.21 22.93 L10.79 22.93 L11.47 14.75 L11.09 14.65 L8.30 20.42 L6.55 19.41 L10.16 14.11 L9.89 13.84 L3.14 18.51 L1.93 16.42 L9.35 12.91 L9.25 12.53 L2.86 13.01 L2.86 10.99 L9.25 11.47 L9.35 11.09 L1.93 7.58 L3.14 5.49 L9.89 10.16 L10.16 9.89 L6.55 4.59 L8.30 3.58 L11.09 9.35Z"/></svg>';

export const lsGet = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
export const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* stockage indisponible */ } };

// ======================================================================
// Tableau de bord (accueil), analyses, modèles, assistant
// ======================================================================
export const DAY_MS = 86400000;

export const fmtHours = (s) => {
  if (s < 60) return `${Math.round(s)} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  const h = s / 3600;
  return h < 10 ? `${h.toFixed(1).replace('.', ',').replace(',0', '')} h` : `${Math.round(h)} h`;
};
export const fmtShortDur = (s) => (s >= 3600 ? `${Math.floor(s / 3600)} h ${String(Math.round((s % 3600) / 60)).padStart(2, '0')}` : `${Math.max(1, Math.round(s / 60))} min`);

export function relDay(t) {
  const d0 = new Date(); d0.setHours(0, 0, 0, 0);
  const diff = Math.floor((d0.getTime() - new Date(t).setHours(0, 0, 0, 0)) / DAY_MS);
  if (diff === 0) return 'Aujourd’hui';
  if (diff === 1) return 'Hier';
  return new Date(t).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
}

export const esc2 = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const initials = (name) => (String(name || '').match(/[\p{L}\p{N}]+/gu) || []).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';

export function askText(title, label, value = '', okLabel = 'Valider') {
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
