// Où garder l'audio d'une transcription : sur ce PC, dans le Google Drive de l'utilisateur, ou nulle part.
// La question est posée à chaque audio traité (sauf si un choix par défaut est réglé dans Paramètres).
//   local : gardé dans ce navigateur, jamais envoyé ;
//   drive : envoyé dans le Google Drive de l'utilisateur, puis retiré de ce PC (récupéré au besoin) ;
//   none  : effacé dès la transcription terminée (vérification et « Qui parle ? » compris) : seul le texte reste.

import { Audios, History } from '../history.js';
import { Auth, Sync } from '../cloud.js';
import { $, ask, esc, state, store, toast } from './core.js';
import { speakersBusy } from './speakers.js';

export const WHERE = {
  local: { label: 'Sur ce PC', chip: 'Audio sur ce PC', sub: 'Gardé dans ce navigateur, sur cet ordinateur. Jamais envoyé sur Internet.' },
  drive: { label: 'Sur mon Google Drive', chip: 'Audio sur Google Drive', sub: 'Envoyé dans ton Drive (dossier « Transcripteur IA »), puis retiré de ce PC. Réécoutable depuis tes autres appareils.' },
  none: { label: 'Ne pas garder l’audio', chip: 'Audio non gardé', sub: 'Effacé dès la transcription terminée : seul le texte reste. Plus de réécoute ni de « Qui parle ? » ensuite.' },
};
const ICON = {
  local: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>',
  drive: '<svg viewBox="0 0 24 24"><path d="M7 18a4.5 4.5 0 0 1-.6-9A6 6 0 0 1 18 8.5a4 4 0 0 1-.5 9.5z"/></svg>',
  none: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>',
};

/** Choix par défaut réglé dans Paramètres : 'ask' (demander à chaque fois), 'local', 'drive' ou 'none'. */
export const audioPolicy = () => store.get('audio.where', 'ask');
export function setAudioPolicy(v) { store.set('audio.where', v); const sel = document.getElementById('audio-policy'); if (sel) sel.value = v; }

/**
 * Demande où garder l'audio.
 * @returns {Promise<'local'|'drive'|'none'>} (Échap ou fermeture : « Sur ce PC », rien ne sort de l'appareil)
 */
export function askAudioStorage({ name = '', durationS = 0, recording = false } = {}) {
  const policy = audioPolicy();
  const driveOk = Sync.enabled();
  if (policy !== 'ask' && (policy !== 'drive' || driveOk)) return Promise.resolve(policy);
  return new Promise((resolve) => {
    const m = document.createElement('div');
    m.className = 'modal';
    m.id = 'store-modal';
    const dur = durationS ? ` · ${durationS < 60 ? `${Math.max(1, Math.round(durationS))} s` : `${Math.round(durationS / 60)} min`}` : '';
    m.innerHTML = `<div class="modal-box store-box" role="dialog" aria-modal="true" aria-labelledby="st-h">
      <h3 id="st-h">Où garder cet audio ?</h3>
      <p>${name ? `« ${esc(name)} »${dur}. ` : ''}La transcription, elle, se fait toujours sur ton PC.</p>
      <div class="store-opts">${['local', 'drive', 'none'].map((k) => {
        const off = k === 'drive' && !driveOk;
        return `<button type="button" class="store-opt${off ? ' off' : ''}" data-where="${k}"${off ? ' disabled' : ''}><span class="so-ico">${ICON[k]}</span><span><b>${WHERE[k].label}</b><small>${off ? 'Connecte-toi d’abord avec Google (Paramètres → Compte).' : WHERE[k].sub}</small></span></button>`;
      }).join('')}</div>
      <label class="modal-check"><input type="checkbox" id="st-remember" /><span>Toujours ce choix, sans redemander (modifiable dans Paramètres → Stockage)</span></label>
      ${recording ? '<p class="an-note">Pendant l’enregistrement, l’audio a été gardé temporairement sur ce PC, en cas de coupure : cette copie de secours est déjà effacée.</p>' : ''}
    </div>`;
    const done = (v) => {
      if ($('#st-remember', m)?.checked) { setAudioPolicy(v); toast('Choix retenu : modifiable dans Paramètres → Stockage.', 'ok', 4000); }
      m.remove();
      resolve(v);
    };
    m.addEventListener('click', (e) => { const b = e.target.closest('[data-where]'); if (b && !b.disabled) done(b.dataset.where); });
    m.addEventListener('keydown', (e) => { if (e.key === 'Escape') done('local'); });
    document.body.append(m);
    m.querySelector('[data-where="local"]').focus();
  });
}

/** Encore utilisé (transcription, vérification, « Qui parle ? ») ? */
const busyWith = (doc) => doc.status === 'running' || doc.status === 'live' || state.verifying?.docId === doc.id || speakersBusy();

/** « Ne pas garder » : efface l'audio (et la vidéo de l'écran) ici et dans le Drive, une fois tout terminé. */
export async function dropAudioIfNone(doc, tries = 0) {
  if (!doc || doc.audioWhere !== 'none' || !doc.audioId) return;
  if (busyWith(doc)) { if (tries < 60) setTimeout(() => dropAudioIfNone(doc, tries + 1), 3000); return; }
  const aid = doc.audioId;
  await Audios.remove(aid).catch(() => {});
  Sync.forget(null, aid);
  doc.audioId = null;
  doc.updatedAt = Date.now();
  await History.put(doc);
  if (state.audio?.docId === doc.id || state.audio?.audioId === aid) state.audio.audioId = null;
  if (state.doc?.id === doc.id) { renderAudioChip(); toast('Audio effacé, comme demandé : seul le texte est gardé.', 'ok', 4500); }
}

/** Applique le choix à une transcription (dès qu'il est connu). */
export async function applyAudioChoice(doc, where) {
  if (!doc || !where) return;
  doc.audioWhere = where;
  doc.updatedAt = Date.now();
  await History.put(doc);
  if (where === 'drive') Sync.schedule(1500);
  if (where === 'none') dropAudioIfNone(doc);
  if (state.doc?.id === doc.id) renderAudioChip();
}

/** Pastille dans l'en-tête d'une transcription. */
export function audioChipHtml(d) {
  if (!d?.audioId && d?.audioWhere !== 'none') return '';
  const w = d.audioId ? d.audioWhere || (Sync.enabled() ? 'drive' : 'local') : 'none';
  // « Ne pas garder » demandé, transcription pas encore finie : l'audio sert encore
  const label = w === 'none' && d.audioId ? 'Audio effacé à la fin' : WHERE[w].chip;
  return `<button type="button" class="mchip store-chip where-${w}" data-audio-where title="Où est gardé l’audio : cliquer pour changer"><svg viewBox="0 0 24 24">${ICON[w].replace(/^<svg[^>]*>|<\/svg>$/g, '')}</svg>${label}</button>`;
}
function renderAudioChip() {
  const old = document.querySelector('#result-meta [data-audio-where]');
  const html = audioChipHtml(state.doc);
  if (old) old.outerHTML = html || '';
  else if (html) $('#result-meta')?.insertAdjacentHTML('beforeend', html);
}

/** Changer d'avis pour une transcription déjà faite. */
async function changeWhere(d, to) {
  const from = d.audioId ? d.audioWhere || (Sync.enabled() ? 'drive' : 'local') : 'none';
  if (to === from) return;
  if (to === 'drive' && !Sync.enabled()) return toast('Connecte-toi d’abord avec Google (Paramètres → Compte).', 'warn', 5000);
  if (to === 'local') {
    // Rapatrié sur ce PC, puis retiré du Drive
    let a = await Audios.get(d.audioId).catch(() => null);
    if (!a?.blob && Sync.enabled()) a = await Sync.pullAudio(d.audioId).catch(() => null);
    if (!a?.blob) return toast('Audio introuvable sur ce PC et dans le Drive.', 'err', 5000);
    Sync.forget(null, d.audioId);
    d.audioWhere = 'local';
    d.updatedAt = Date.now();
    await History.put(d);
    toast(Auth.token() ? 'Audio gardé sur ce PC : il est supprimé de ton Google Drive dans quelques secondes (définitivement, sans passer par la corbeille).' : 'Audio gardé sur ce PC. Ta connexion Google a expiré : reconnecte-toi pour qu’il soit supprimé de ton Drive.', Auth.token() ? 'ok' : 'warn', 7000);
  } else if (to === 'drive') {
    d.audioWhere = 'drive';
    d.updatedAt = Date.now();
    await History.put(d);
    Sync.schedule(800);
    toast('L’audio part sur ton Google Drive, puis sera retiré de ce PC.', 'ok', 5000);
  } else {
    if (!(await ask('Effacer l’audio ?', 'L’audio (et la vidéo de l’écran) sera effacé de ce PC et de ton Google Drive. Seul le texte reste : plus de réécoute ni de « Qui parle ? ».', 'Effacer', { danger: true }))) return;
    d.audioWhere = 'none';
    await dropAudioIfNone(d);
  }
  renderAudioChip();
}

function openMenu(btn) {
  const d = state.doc;
  if (!d) return;
  document.getElementById('store-pop')?.remove();
  const pop = document.createElement('div');
  pop.id = 'store-pop';
  pop.className = 'who-pop';
  const cur = d.audioId ? d.audioWhere || (Sync.enabled() ? 'drive' : 'local') : 'none';
  pop.innerHTML = `<p>Où garder l’audio de cette réunion ?</p>${['local', 'drive', 'none'].map((k) => `<button type="button" data-pick="${k}"${k === cur ? ' class="on"' : ''}${!d.audioId && k !== 'none' ? ' disabled' : ''}>${WHERE[k].label}</button>`).join('')}`;
  document.body.append(pop);
  const r = btn.getBoundingClientRect();
  pop.style.left = `${Math.max(12, Math.min(r.left, innerWidth - pop.offsetWidth - 12))}px`;
  pop.style.top = `${r.bottom + 6}px`;
  pop.addEventListener('click', (e) => { const b = e.target.closest('[data-pick]'); if (!b || b.disabled) return; pop.remove(); changeWhere(d, b.dataset.pick); });
  const close = (e) => { if (!pop.contains(e.target) && e.target !== btn) { pop.remove(); document.removeEventListener('pointerdown', close, true); } };
  document.addEventListener('pointerdown', close, true);
}

export function bindStorage() {
  document.addEventListener('click', (e) => {
    const b = e.target.closest('#result-meta [data-audio-where]');
    if (b) openMenu(b);
  });
  const sel = $('#audio-policy');
  if (sel) {
    sel.value = audioPolicy();
    sel.onchange = () => { setAudioPolicy(sel.value); toast(sel.value === 'ask' ? 'La question sera posée pour chaque audio.' : `Par défaut : ${WHERE[sel.value].label.toLowerCase()}.`, 'ok', 3500); };
  }
}
