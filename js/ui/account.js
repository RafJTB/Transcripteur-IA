// Compte Google, synchronisation, dossiers, installation.

import { NO_FOLDER_COLOR, folderColor } from '../projects.js';
import { Audios, History } from '../history.js';
import { Auth, Folders, Sync, redirectUri } from '../cloud.js';
import { $, ask, askText, esc2, initials, state, toast, writeClipboard } from './core.js';
import { helloText } from './dashboard.js';
import { clearResult, saveDoc, showDoc, updateButtons } from './doc.js';
import { renderStorage } from './engine.js';
import { renderHistory } from './history.js';
import { notify } from './notifs.js';
import { clearAudio, loadDocVideo, micBusy } from './recording.js';
import { isMine, persist } from './transcription.js';
import { setView } from './views.js';
import { removeFolder } from './undo.js';
import { renderSettings, setSettingsTab } from './settings-ui.js';

// ======================================================================
// Compte Google et dossiers de travail
// ======================================================================
const G_ICON = '<svg class="g-ico" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.2l7.9 6.2C12.5 13.6 17.8 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.6 5.9c4.4-4.1 7-10.1 7-17.6z"/><path fill="#FBBC05" d="M10.6 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.2C1 16.6 0 20.2 0 24s1 7.4 2.7 10.8l7.9-6.2z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.6-5.9c-2.1 1.4-4.9 2.3-8.3 2.3-6.2 0-11.5-4.1-13.4-9.8l-7.9 6.2C6.6 42.6 14.6 48 24 48z"/></svg>';

function syncLabel() {
  if (!Auth.clientId()) return 'Connexion Google à configurer';
  if (!Auth.user()) return 'Sauvegarde dans Google Drive';
  switch (Sync.status) {
    case 'syncing': return 'Synchronisation…';
    case 'error': return 'Erreur de synchronisation';
    case 'expired': return 'Reconnexion nécessaire';
    default: {
      if (!Sync.lastAt) return 'Connecté';
      const min = Math.round((Date.now() - Sync.lastAt) / 60000);
      return min < 1 ? 'Synchronisé à l’instant' : `Synchronisé il y a ${min} min`;
    }
  }
}

/** Carte du compte (barre latérale) et carte « Compte Google » (Paramètres). */
function renderAccount() {
  const u = Auth.user();
  if (state.page === 'home') $('#hero-hello').textContent = helloText();
  const card = $('#user-card');
  card.classList.toggle('signed-out', !u);
  card.dataset.sync = u ? Sync.status : '';
  if (u) {
    const av = u.picture
      ? `<img class="avatar" src="${esc2(u.picture)}" alt="" referrerpolicy="no-referrer" crossorigin="anonymous" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'avatar',textContent:'${initials(u.name).replace(/'/g, '')}'}))" />`
      : `<span class="avatar">${esc2(initials(u.name))}</span>`;
    card.innerHTML = `${av}<div><b>${esc2(u.name)}</b><small><i></i>${esc2(syncLabel())}</small></div><svg class="chev" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>`;
  } else {
    card.innerHTML = `<span class="avatar g">${G_ICON}</span><div><b>Se connecter</b><small>${esc2(syncLabel())}</small></div><svg class="chev" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg>`;
  }
  // Paramètres
  const st = $('#acc-status');
  if (!st) return;
  st.innerHTML = u
    ? `<b>${esc2(u.name)}</b> · ${esc2(u.email)}<br><span class="acc-sync" data-sync="${Sync.status}">${esc2(syncLabel())}${Sync.status === 'error' && Sync.error ? ` : ${esc2(Sync.error)}` : ''}</span>`
    : Auth.clientId() ? 'Non connecté. Sans compte, tout reste dans ce navigateur.' : 'Connexion Google pas encore configurée : renseigne l’identifiant client ci-dessous.';
  $('#acc-login').hidden = !!u && !Auth.expired();
  $('#acc-login span').textContent = u ? 'Se reconnecter' : 'Se connecter avec Google';
  $('#acc-login').disabled = !Auth.clientId();
  $('#acc-sync').hidden = !u || Auth.expired();
  $('#acc-logout').hidden = !u;
  $('#acc-switch').hidden = !u;
  $('#acc-client').value = Auth.clientId();
  $('#acc-redirect').textContent = redirectUri();
  renderSettings();
}

function signIn(silent = false, { email = null, choose = false } = {}) {
  if (state.phase !== 'idle' || micBusy()) return toast('Attends la fin de l’enregistrement ou de la transcription en cours.', 'warn');
  if (!Auth.clientId()) { setSettingsTab('compte'); setView('settings'); return toast('Renseigne d’abord l’identifiant client Google (Paramètres → Compte Google).', 'warn', 6000); }
  saveDoc();
  try { Auth.signIn({ silent, email, choose }); } catch (e) { toast(e.message, 'err'); }
}

/** Changer de compte Google : le compte voulu (déjà utilisé ici) ou le choix de Google. */
function switchAccount(email = null) {
  $('#user-menu').hidden = true;
  if (email && email === Auth.user()?.email) return;
  signIn(false, email ? { email } : { choose: true });
}

export const avatarHtml = (a, cls = 'avatar') => (a.picture
  ? `<img class="${cls}" src="${esc2(a.picture)}" alt="" referrerpolicy="no-referrer" crossorigin="anonymous" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'${cls}',textContent:'${initials(a.name).replace(/'/g, '')}'}))" />`
  : `<span class="${cls}">${esc2(initials(a.name))}</span>`);

/** Menu du profil : compte actuel, autres comptes de ce navigateur, actions. */
function renderUserMenu() {
  const u = Auth.user();
  if (!u) return;
  const others = Auth.accounts().filter((a) => a.email !== u.email);
  $('#um-accounts').innerHTML = `<div class="um-me">${avatarHtml(u)}<div><b>${esc2(u.name)}</b><small>${esc2(u.email)}</small></div><i class="um-check"></i></div>`
    + (others.length ? `<p class="um-label">Changer de compte</p>${others.map((a) => `<div class="um-acc"><button type="button" data-switch="${esc2(a.email)}">${avatarHtml(a)}<span><b>${esc2(a.name)}</b><small>${esc2(a.email)}</small></span></button><button type="button" class="um-forget" data-forget-acc="${esc2(a.email)}" title="Retirer de cette liste" aria-label="Retirer ${esc2(a.email)} de la liste"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>`).join('')}` : '')
    + `<button type="button" class="um-add" data-switch=""><svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0M19 8v6M16 11h6"/></svg>Utiliser un autre compte</button>`;
}

export async function syncNow({ quiet = false } = {}) {
  if (!Sync.enabled()) return;
  if (Auth.expired()) { renderAccount(); if (!quiet) toast('Reconnecte-toi à Google pour synchroniser.', 'warn', 5000); return; }
  try {
    const changed = await Sync.run();
    if (changed) {
      renderHistory();
      // Transcription ouverte modifiée sur un autre appareil : on la recharge (sauf saisie en cours)
      const d = state.doc && (await History.get(state.doc.id).catch(() => null));
      if (state.doc && !d) clearResult();
      else if (d && (d.updatedAt || 0) > (state.doc.updatedAt || 0) && state.phase === 'idle' && !$('#step-result').contains(document.activeElement)) showDoc(d);
    }
    if (state.page === 'doc' && state.doc) loadDocVideo(state.doc);
    if (!quiet) toast('Synchronisé avec Google Drive.', 'ok', 2500);
  } catch (e) {
    if (!quiet) toast(e.message, e.status === 401 ? 'warn' : 'err', 6000);
  }
}

async function signOut() {
  const u = Auth.user();
  if (!u) return;
  const r = await ask('Se déconnecter ?', `Tes transcriptions restent dans ton Google Drive. Sur ce navigateur, elles seront masquées jusqu’à ta prochaine connexion. Tu seras aussi déconnecté(e) des espaces partagés.`, 'Se déconnecter',
    { checkbox: 'Les effacer aussi de ce navigateur (conseillé sur un PC partagé)', checked: false });
  if (!r) return;
  if (r.checked) {
    for (const d of (await History.list()).filter((x) => x.owner === u.email)) {
      await History.remove(d.id);
      if (d.audioId && !(await History.list()).some((x) => x.audioId === d.audioId)) await Audios.remove(d.audioId).catch(() => {});
    }
  }
  await Auth.signOut();
  await (await import('./spaces.js')).signOutSpaces().catch(() => {});
  if (state.doc?.owner === u.email) { clearResult(); clearAudio(); }
  state.folder = 'all';
  Sync._set('off');
  renderAccount();
  renderHistory();
  renderStorage();
  updateButtons();
  toast('Déconnecté.', 'ok', 2500);
}

/** Supprime les transcriptions du compte en cours (ou de l'espace sans compte). */
export async function clearMine() {
  const mine = (await History.list()).filter(isMine);
  for (const d of mine) { await History.remove(d.id); Sync.forget(d.id); }
  const rest = await History.list();
  for (const aid of new Set(mine.map((d) => d.audioId).filter(Boolean))) {
    if (!rest.some((d) => d.audioId === aid)) { await Audios.remove(aid).catch(() => {}); Sync.forget(null, aid); }
  }
}

/** Première connexion : propose de ranger dans le compte les transcriptions faites sans compte. */
async function offerImport() {
  const u = Auth.user();
  const local = (await History.list()).filter((d) => !d.owner);
  if (!local.length) return;
  const n = local.length;
  const ok = await ask('Ajouter tes transcriptions à ton compte ?',
    `${n} transcription${n > 1 ? 's ont été faites' : ' a été faite'} sur ce navigateur sans compte. Les ajouter à ton compte ${u.email} (et à ton Google Drive) ? Sinon, elles restent visibles seulement quand tu es déconnecté.`, 'Ajouter');
  if (!ok) return;
  for (const d of local) await History.put({ ...d, owner: u.email, updatedAt: Date.now() });
  // Les dossiers faits sans compte suivent
  const anon = JSON.parse(localStorage.getItem('transcripteur.cloud.folders.local') || '[]');
  if (anon.length) Folders.merge(anon);
  renderHistory();
}

// ---------- Dossiers ----------
export function folderOptions(current) {
  const fs = Folders.list();
  const cur = Folders.get(current) ? current : '';
  return `<option value="">Sans dossier</option>${fs.map((f) => `<option value="${f.id}"${f.id === cur ? ' selected' : ''}>${esc2(f.name)}</option>`).join('')}<option value="__new">+ Nouveau dossier…</option>`;
}

export async function moveToFolder(doc, value) {
  let id = value;
  if (value === '__new') {
    const name = await askText('Nouveau dossier', 'Nom du dossier', '');
    if (!name) { renderHistory(); renderDocFolder(); return; }
    id = Folders.add(name).id;
  }
  const d = (await History.get(doc.id).catch(() => null)) || doc;
  d.folderId = id || null;
  await persist(d);
  if (state.doc?.id === d.id) state.doc.folderId = d.folderId;
  renderHistory();
  renderDocFolder();
}

export function renderDocFolder() {
  const sel = $('#doc-folder');
  sel.hidden = !state.doc || state.doc.status === 'running' || state.doc.status === 'live';
  if (sel.hidden) return;
  sel.innerHTML = folderOptions(state.doc.folderId);
}

export function renderFolderBar(items) {
  const bar = $('#folder-bar');
  const fs = Folders.list();
  const count = (id) => items.filter((it) => (id === 'none' ? !Folders.get(it.folderId) : it.folderId === id)).length;
  if (state.folder !== 'all' && state.folder !== 'none' && !Folders.get(state.folder)) state.folder = 'all';
  const folderIco = '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
  const allIco = '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 9h18"/></svg>';
  const chip = (id, name, n, color, ico = folderIco) => `<button type="button" class="fchip${state.folder === id ? ' active' : ''}" data-folder="${id}" style="--fc:${color}"><span class="sq">${ico}</span><span class="nm">${esc2(name)}</span><small>${n}</small></button>`;
  bar.innerHTML = chip('all', 'Tous les projets', items.length, 'var(--accent-rgb)', allIco)
    + fs.map((f) => chip(f.id, f.name, count(f.id), folderColor(f.id, Folders.raw()))).join('')
    + (fs.length ? chip('none', 'Sans dossier', count('none'), NO_FOLDER_COLOR) : '')
    + '<button type="button" class="fchip add" data-folder-new><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg><span class="nm">Nouveau dossier</span></button>';
  const cur = Folders.get(state.folder);
  $('#folder-tools').hidden = !cur;
}

// ---------- Installation comme une application (PWA) ----------
let installPrompt = null;
export function bindInstall() {
  const btns = [$('#btn-install'), $('#btn-install-2')];
  const show = (on) => btns.forEach((b) => (b.hidden = !on));
  addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; show(true); });
  addEventListener('appinstalled', () => { installPrompt = null; show(false); toast('Transcripteur IA est installé : tu le trouves dans ton menu Démarrer et sur ton bureau.', 'ok', 6000); });
  btns.forEach((b) => (b.onclick = async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    const r = await installPrompt.userChoice.catch(() => null);
    if (r?.outcome === 'accepted') show(false);
    installPrompt = null;
  }));
}

export function bindAccount(authResult) {
  state.folder = 'all';
  Sync.on(() => renderAccount());
  // Problème de synchronisation : une notification (pas à chaque tentative)
  let lastSyncIssue = '';
  Sync.on((st) => {
    const issue = st.status === 'error' ? `e:${st.error}` : st.status === 'expired' ? 'expired' : '';
    if (issue && issue !== lastSyncIssue) {
      notify(st.status === 'expired'
        ? { kind: 'warn', title: 'Reconnexion à Google nécessaire', text: 'La synchronisation est en pause. Clique sur ta carte en bas à gauche pour te reconnecter.', action: 'account' }
        : { kind: 'err', title: 'Synchronisation impossible', text: st.error || 'Google Drive ne répond pas.', action: 'account' });
    }
    if (st.status === 'ok' && lastSyncIssue) notify({ kind: 'ok', title: 'Synchronisation rétablie', text: 'Tes transcriptions sont à jour dans Google Drive.' });
    if (st.status === 'ok' || issue) lastSyncIssue = issue;
  });
  // Carte du compte (barre latérale)
  $('#user-card').onclick = (e) => {
    e.stopPropagation();
    const u = Auth.user();
    if (!u) return signIn();
    // Reconnexion demandée : vraie connexion (le compte est proposé d'office). Une tentative silencieuse
    // a déjà échoué au lancement ; la refaire échouerait pareil si Google demande une confirmation.
    if (Auth.expired()) return signIn(false);
    const menu = $('#user-menu');
    if (menu.hidden) renderUserMenu();
    menu.hidden = !menu.hidden;
  };
  $('#um-accounts').addEventListener('click', (e) => {
    e.stopPropagation();
    const f = e.target.closest('[data-forget-acc]');
    if (f) { Auth.forgetAccount(f.dataset.forgetAcc); return renderUserMenu(); }
    const b = e.target.closest('[data-switch]');
    if (b) switchAccount(b.dataset.switch || null);
  });
  $('#acc-switch').onclick = () => switchAccount(null);
  $('#acc-videos').checked = Sync.videosEnabled();
  $('#acc-videos').onchange = (e) => { Sync.setVideosEnabled(e.target.checked); if (state.doc) loadDocVideo(state.doc); };
  document.addEventListener('click', (e) => { if (!e.target.closest('#user-menu')) $('#user-menu').hidden = true; });
  $('#um-sync').onclick = () => { $('#user-menu').hidden = true; syncNow(); };
  $('#um-settings').onclick = () => { $('#user-menu').hidden = true; setView('settings'); };
  $('#um-logout').onclick = () => { $('#user-menu').hidden = true; signOut(); };
  // Paramètres
  $('#acc-login').onclick = () => signIn(false);
  $('#acc-sync').onclick = () => syncNow();
  $('#acc-logout').onclick = signOut;
  $('#acc-client').addEventListener('change', (e) => { Auth.setClientId(e.target.value); renderAccount(); toast(e.target.value.trim() ? 'Identifiant client enregistré.' : 'Identifiant client effacé.', 'ok', 2500); });
  $('#acc-copy').onclick = () => writeClipboard(redirectUri()).then(() => toast('Adresse copiée.', 'ok', 2000));
  // Dossiers
  $('#folder-bar').addEventListener('click', async (e) => {
    if (e.target.closest('[data-folder-new]')) {
      const name = await askText('Nouveau dossier', 'Nom du dossier', '');
      if (!name) return;
      state.folder = Folders.add(name).id;
      return renderHistory();
    }
    const b = e.target.closest('[data-folder]');
    if (!b) return;
    state.folder = b.dataset.folder;
    renderHistory();
  });
  $('#folder-rename').onclick = async () => {
    const f = Folders.get(state.folder);
    if (!f) return;
    const name = await askText('Renommer le dossier', 'Nom du dossier', f.name, 'Renommer');
    if (name) { Folders.rename(f.id, name); renderHistory(); renderDocFolder(); }
  };
  $('#folder-delete').onclick = async () => {
    const f = Folders.get(state.folder);
    if (!f) return;
    // Les réunions du dossier ne sont pas effacées (elles passent dans « Sans dossier ») ; « Annuler » le rétablit
    removeFolder(f, ({ removed, id }) => {
      state.folder = removed ? 'all' : id;
      renderHistory();
      renderDocFolder();
    });
  };
  $('#doc-folder').onchange = (e) => { if (state.doc) moveToFolder(state.doc, e.target.value); };
  // Synchronisation régulière
  setInterval(() => { if (document.visibilityState === 'visible' && Sync.enabled() && state.phase === 'idle') syncNow({ quiet: true }); }, 3 * 60 * 1000);
  setInterval(() => { if (Auth.user() && Sync.status === 'ok') renderAccount(); }, 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && Sync.enabled()) Sync.schedule(800); });
  renderAccount();
  // Retour de Google
  if (authResult?.ok) {
    renderHistory();
    (async () => {
      if (authResult.first) await offerImport();
      await syncNow({ quiet: true });
      if (authResult.first) toast(`Connecté : ${Auth.user().email}. ${Auth.accounts().length > 1 ? 'Tu vois maintenant les transcriptions et dossiers de ce compte.' : 'Tes transcriptions sont sauvegardées dans ton Google Drive.'}`, 'ok', 6000);
    })();
  } else if (authResult && !authResult.ok) {
    const silentFail = ['login_required', 'interaction_required', 'consent_required'].includes(authResult.error);
    if (silentFail) Sync._set('expired', 'Reconnexion à Google nécessaire.');
    else toast(authResult.error === 'access_denied' ? 'Connexion Google annulée.' : `Connexion Google impossible : ${authResult.error}`, 'warn', 7000);
    renderAccount();
  } else if (Sync.enabled() && Auth.token()) {
    syncNow({ quiet: true });
  } else if (Auth.expired()) {
    Sync._set('expired', 'Reconnexion à Google nécessaire.');
  }
}
