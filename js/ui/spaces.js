// Espaces collaboratifs (interface).

import { Audios, History, newId } from '../history.js';
import { Auth } from '../cloud.js';
import { Spaces, sanitizeSharedDoc, spacesError } from '../spaces.js';
import { canEncodeOpus, encodeOggOpus } from '../opus-ogg.js';
import { decodeToMono16k } from '../audio.js';
import { speakerColor } from '../speakers.js';
import { avatarHtml } from './account.js';
import { $, ask, askText, esc, fmtBytes, fmtShortDur, initials, lsGet, lsSet, relDay, toast, writeClipboard } from './core.js';
import { STAT_ICONS, docIcon } from './dashboard.js';
import { tool } from './diagnostic.js';
import { openDoc } from './history.js';
import { getAudio, myDocs } from './transcription.js';
import { setView } from './views.js';
import { chatCardHtml, mountChat, refreshBadges, startChat, stopChat, unmountChat } from './space-chat.js';

// ======================================================================
// Espaces collaboratifs (Supabase)
// ======================================================================
const spState = { me: null, spaces: [], current: lsGet('spaces.current', ''), members: [], docs: [], loading: false };
export const SP_PEOPLE = '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><circle cx="17" cy="9" r="2.5"/><path d="M16 14.2a5 5 0 0 1 5.5 5.8"/></svg>';
const spErr = (e) => toast(spacesError(e), 'err', 7000);

export async function renderSpaces() {
  const setup = $('#spc-setup'), login = $('#spc-login'), main = $('#spc-main');
  if (!setup) return;
  setup.hidden = login.hidden = main.hidden = true;
  if (!Spaces.configured() && !window.__spacesClient) { setup.hidden = false; renderSpacesSetup(); return; }
  try { spState.me = await Spaces.user(); } catch (e) { spState.me = null; spErr(e); }
  if (!spState.me) { stopChat(); login.hidden = false; return; }
  main.hidden = false;
  $('#spc-me').innerHTML = `${avatarHtml(spState.me)}<span><b>${esc(spState.me.name)}</b><small>${esc(spState.me.email)}</small></span>`;
  await loadSpaces();
  startChat(spState.me, () => spState.spaces);
}

function renderSpacesSetup() {
  $('#spc-url').value = Spaces.url();
  $('#spc-key').value = Spaces.key() ? '••••••••••••' : '';
  $('#spc-redirect').textContent = location.origin + location.pathname;
}

async function loadSpaces() {
  try { spState.spaces = await Spaces.list(); } catch (e) { spState.spaces = []; spErr(e); }
  if (!spState.spaces.some((s) => s.id === spState.current)) spState.current = spState.spaces[0]?.id || '';
  lsSet('spaces.current', spState.current);
  renderSpaceList();
  await loadSpace();
}

function renderSpaceList() {
  const list = $('#spc-list');
  list.innerHTML = spState.spaces.length
    ? spState.spaces.map((s) => `<button type="button" class="spc-item${s.id === spState.current ? ' active' : ''}" data-space="${esc(s.id)}"><span class="spc-ico">${SP_PEOPLE}</span><span class="spc-txt"><b>${esc(s.name)}</b><small>${s.members} membre${s.members > 1 ? 's' : ''} · ${s.docs} réunion${s.docs > 1 ? 's' : ''}</small></span>${s.owner === spState.me?.id ? '<i class="spc-own" title="Tu es propriétaire">Propriétaire</i>' : ''}</button>`).join('')
    : '<p class="dash-empty sm">Aucun espace pour l’instant. Crée le premier, ou demande à quelqu’un de t’inviter avec ton adresse.</p>';
  refreshBadges();
}

async function loadSpace() {
  const box = $('#spc-content');
  const s = spState.spaces.find((x) => x.id === spState.current);
  if (!s) { unmountChat(); box.innerHTML = `<div class="glass dash-card spc-empty"><span class="r-ico violet">${SP_PEOPLE}</span><b>Crée ton premier espace</b><small>Un espace = un groupe de personnes qui partagent des réunions : un projet, une équipe, la famille…</small><button class="btn primary" type="button" data-spc="new">Nouvel espace</button></div>`; return; }
  box.innerHTML = '<p class="dash-empty">Chargement…</p>';
  try { [spState.members, spState.docs] = await Promise.all([Spaces.members(s.id), Spaces.docs(s.id)]); } catch (e) { spErr(e); spState.members = []; spState.docs = []; }
  if (spState.current !== s.id) return;
  const own = s.owner === spState.me?.id;
  const used = spState.docs.reduce((a, d) => a + (d.audio_bytes || 0), 0);
  box.innerHTML = `
    <section class="glass dash-card spc-head">
      <div><h3>${esc(s.name)}</h3><small>${own ? 'Tu es propriétaire' : 'Tu es membre'} · ${spState.docs.length} réunion${spState.docs.length > 1 ? 's' : ''}${used ? ` · ${fmtBytes(used)} d’audio` : ''}</small></div>
      <div class="spc-acts">
        <button class="btn primary sm" type="button" data-spc="share"><svg viewBox="0 0 24 24"><path d="M12 15V4m0 0-4 4m4-4 4 4"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>Partager une transcription</button>
        ${own ? '<button class="icon-btn" type="button" data-spc="rename" title="Renommer l’espace" aria-label="Renommer l’espace"><svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg></button><button class="icon-btn danger" type="button" data-spc="delete" title="Supprimer l’espace" aria-label="Supprimer l’espace"><svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg></button>'
        : '<button class="btn sm ghost" type="button" data-spc="leave">Quitter l’espace</button>'}
      </div>
    </section>
    <div class="spc-body"><div class="spc-left">
    <section class="glass dash-card">
      <header class="dash-head"><h3>${SP_PEOPLE}Membres <small class="dash-sub">${spState.members.length}</small></h3></header>
      <div class="spc-members">${spState.members.map((m) => `<span class="spc-member"><i style="--spk:${speakerColor([...m.email].reduce((a, c) => a + c.charCodeAt(0), 0))}">${esc(initials(m.email.split('@')[0]))}</i><span>${esc(m.email)}${m.email === spState.me?.email ? ' (toi)' : ''}</span>${m.role === 'owner' ? '<b>propriétaire</b>' : own ? `<button type="button" class="spc-x" data-remove="${esc(m.email)}" title="Retirer" aria-label="Retirer ${esc(m.email)}"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>` : ''}</span>`).join('')}</div>
      ${own ? `<form class="spc-invite" id="spc-invite"><input type="email" class="text-input" id="spc-email" placeholder="adresse@gmail.com" required autocomplete="off" /><button class="btn sm" type="submit">Inviter</button></form><p class="an-note">La personne voit l’espace dès qu’elle se connecte ici avec cette adresse Google. Aucun e-mail n’est envoyé : préviens-la avec « Copier l’invitation ».</p>` : ''}
    </section>
    <section class="spc-docs">${spState.docs.length ? spState.docs.map((d) => spaceDocCard(d, own)).join('') : '<div class="hist-empty"><span class="r-ico violet">' + STAT_ICONS.docs + '</span><b>Aucune réunion partagée</b><small>« Partager une transcription » envoie le texte et, si tu veux, l’audio compressé.</small></div>'}</section>
    </div>${chatCardHtml(s, spState.members)}</div>`;
  mountChat(s, { docs: spState.docs, own, openDoc: openSpaceDoc });
}

/** Ouvre un espace précis (par exemple depuis une notification de message). */
export function openSpace(id) {
  spState.current = id;
  lsSet('spaces.current', id);
  setView('spaces');
}

function spaceDocCard(d, own) {
  const [tone, icon] = docIcon(d.title);
  const mine = d.created_by === spState.me?.id;
  return `<article class="glass proj-card spc-doc" data-sdoc="${esc(d.id)}" tabindex="0">
    <div class="pc-top"><span class="r-ico ${tone}">${icon}</span><div class="pc-title"><strong>${esc(d.title)}</strong><small>par ${esc(mine ? 'toi' : d.author_name || d.author_email || 'un membre')} · ${relDay(new Date(d.created_at).getTime())}</small></div>
      ${mine || own ? `<button class="icon-btn danger pc-del" type="button" data-unshare="${esc(d.id)}" title="Retirer de l’espace" aria-label="Retirer de l’espace"><svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg></button>` : ''}</div>
    <div class="pc-chips">${d.duration_s ? `<span><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>${fmtShortDur(d.duration_s)}</span>` : ''}${d.audio_path ? `<span><svg viewBox="0 0 24 24"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>audio ${fmtBytes(d.audio_bytes || 0)}</span>` : '<span>texte seul</span>'}</div>
    <div class="pc-foot"><span class="an-note">Ouvrir en fait une copie dans « Mes projets ».</span><span class="pc-open" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg></span></div>
  </article>`;
}

/** Partage : choix d'une transcription, compression de l'audio, envoi. */
async function shareToSpace() {
  const s = spState.spaces.find((x) => x.id === spState.current);
  if (!s) return;
  const docs = (await myDocs()).filter((d) => d.segments?.length && d.status !== 'running' && d.status !== 'live' && !d.fromSpace);
  if (!docs.length) return toast('Aucune transcription à partager pour l’instant.', 'warn');
  tool.open(`Partager dans « ${s.name} »`);
  const pick = await tool.show({
    step: 'Choix de la transcription',
    html: `<p>Les membres de l’espace verront le texte, les intervenants et, si tu le coches, l’audio. Ces données seront stockées sur le serveur de l’espace.</p>
      <div class="cl-types spc-pick">${docs.slice(0, 40).map((d, i) => `<label class="cl-type"><input type="radio" name="spc-doc" value="${esc(d.id)}"${i ? '' : ' checked'} /><span><strong>${esc(d.title)}</strong><small>${relDay(d.createdAt)}${d.durationS ? ` · ${fmtShortDur(d.durationS)}` : ''}${d.audioId ? '' : ' · sans audio'}</small></span></label>`).join('')}</div>
      <label class="modal-check"><input type="checkbox" id="spc-with-audio" checked /><span>Inclure l’audio, compressé en qualité voix (≈ 11 Mo par heure)</span></label>`,
    actions: [{ label: 'Annuler', value: null }, { label: 'Partager', value: true, primary: true }],
  });
  if (!pick) return;
  const id = document.querySelector('input[name="spc-doc"]:checked')?.value;
  const withAudio = $('#spc-with-audio').checked;
  const d = docs.find((x) => x.id === id);
  if (!d) return tool.close();
  const step = (t) => tool.show({ step: 'Envoi', html: `<p>${esc(t)}</p>` });
  try {
    let blob = null;
    if (withAudio && d.audioId) {
      step('Préparation de l’audio…');
      const rec = await getAudio(d.audioId);
      if (rec?.blob) {
        if (canEncodeOpus()) {
          const pcm = await decodeToMono16k(rec.blob);
          blob = await encodeOggOpus(pcm, { onProgress: (v) => ($('#tool-body').innerHTML = `<p>Compression de l’audio… ${Math.round(v * 100)} %</p>`) });
        } else if (rec.blob.size < 45e6) blob = rec.blob;
        else toast('Audio trop lourd pour ce navigateur : seul le texte est partagé.', 'warn', 6000);
      }
    }
    if (blob && blob.size > 50 * 1048576) { toast('Audio trop lourd même compressé (> 50 Mo) : seul le texte est partagé.', 'warn', 6000); blob = null; }
    step(blob ? `Envoi (${fmtBytes(blob.size)})…` : 'Envoi du texte…');
    await Spaces.share(s.id, d, blob, spState.me);
    tool.close();
    toast(`« ${d.title} » partagée dans « ${s.name} ».`, 'ok', 4000);
    await loadSpaces();
  } catch (e) {
    tool.close();
    spErr(e);
  }
}

/** Ouvre une transcription d'un espace : copie dans « Mes projets » (avec son audio), puis ouverture. */
async function openSpaceDoc(id) {
  const localId = `sp-${id}`;
  let local = await History.get(localId).catch(() => null);
  if (!local) {
    try {
      toast('Récupération de la transcription partagée…', 'info', 2500);
      const row = await Spaces.doc(id);
      const s = spState.spaces.find((x) => x.id === row.space_id);
      let audioId = null;
      if (row.audio_path) {
        const blob = await Spaces.audio(row.audio_path);
        audioId = newId();
        await Audios.put({ id: audioId, blob, name: `${row.title}.ogg`, durationS: row.duration_s || undefined, createdAt: Date.now() });
      }
      const clean = sanitizeSharedDoc(row.doc);
      local = {
        ...clean, id: localId, audioId, folderId: null, owner: Auth.user()?.email || undefined,
        fromSpace: { spaceId: row.space_id, name: s?.name || 'Espace', by: String(row.author_name || row.author_email || '').slice(0, 120) },
        title: String(row.title || clean.title).slice(0, 200), createdAt: clean.createdAt || new Date(row.created_at).getTime() || Date.now(), status: 'done',
      };
      await History.put(local);
    } catch (e) { return spErr(e); }
  }
  openDoc(local);
}

function bindSpaces() {
  // Configuration
  $('#spc-save').onclick = () => {
    const url = $('#spc-url').value.trim();
    const key = $('#spc-key').value.trim();
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.(co|in)\/?$/i.test(url)) return toast('Adresse attendue : https://xxxx.supabase.co', 'warn', 5000);
    if (!key.startsWith('•') && key.length < 20) return toast('Clé publique (anon / publishable) attendue.', 'warn', 5000);
    // Clé secrète (accès total à la base, sans règles d'accès) : refusée, quel que soit son format
    let role = '';
    try { role = JSON.parse(atob(key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).role || ''; } catch { /* pas un jeton JWT */ }
    if (/service_role|^sb_secret_/i.test(key) || role === 'service_role') return toast('Ne mets jamais la clé secrète (« service_role » ou « sb_secret_… ») ici : utilise la clé « anon » / « publishable ».', 'err', 8000);
    Spaces.setConfig(url, key.startsWith('•') ? Spaces.key() : key);
    toast('Projet Supabase enregistré.', 'ok', 2500);
    renderSpaces();
  };
  $('#spc-copy-sql').onclick = async () => {
    try {
      const sql = await (await fetch('supabase/schema.sql', { cache: 'no-cache' })).text();
      await writeClipboard(sql);
      toast('Script SQL copié : colle-le dans Supabase → SQL Editor, puis « Run ».', 'ok', 6000);
    } catch { toast('Copie impossible : ouvre supabase/schema.sql sur GitHub.', 'err', 5000); }
  };
  $('#spc-copy-redirect').onclick = () => writeClipboard($('#spc-redirect').textContent).then(() => toast('Adresse copiée.', 'ok', 2000));
  $('#spc-signin').onclick = () => Spaces.signIn(Auth.user()?.email || '').catch(spErr);
  $('#spc-signout').onclick = async () => { await Spaces.signOut().catch(() => {}); spState.me = null; stopChat(); renderSpaces(); };
  $('#spc-new').onclick = () => newSpace();
  $('#spc-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-space]');
    if (!b) return;
    spState.current = b.dataset.space;
    lsSet('spaces.current', spState.current);
    renderSpaceList();
    loadSpace();
  });
  $('#spc-content').addEventListener('click', async (e) => {
    const s = spState.spaces.find((x) => x.id === spState.current);
    const act = e.target.closest('[data-spc]')?.dataset.spc;
    if (act === 'new') return newSpace();
    if (act === 'share') return shareToSpace();
    if (act === 'rename') {
      const n = await askText('Renommer l’espace', 'Nom', s.name, 'Renommer');
      if (n) { await Spaces.rename(s.id, n).catch(spErr); loadSpaces(); }
      return;
    }
    if (act === 'delete') {
      if (!(await ask(`Supprimer « ${s.name} » ?`, 'Les réunions partagées et leur audio seront effacés du serveur pour tous les membres. Les copies déjà ouvertes dans « Mes projets » restent.', 'Supprimer', { danger: true }))) return;
      await Spaces.remove(s.id).catch(spErr);
      spState.current = '';
      return loadSpaces();
    }
    if (act === 'leave') {
      if (!(await ask(`Quitter « ${s.name} » ?`, 'Tu ne verras plus cet espace, sauf si on t’invite à nouveau.', 'Quitter', { danger: true }))) return;
      await Spaces.removeMember(s.id, spState.me.email).catch(spErr);
      spState.current = '';
      return loadSpaces();
    }
    const rm = e.target.closest('[data-remove]');
    if (rm) {
      if (!(await ask('Retirer ce membre ?', `${rm.dataset.remove} ne verra plus « ${s.name} ».`, 'Retirer', { danger: true }))) return;
      await Spaces.removeMember(s.id, rm.dataset.remove).catch(spErr);
      return loadSpace();
    }
    const un = e.target.closest('[data-unshare]');
    if (un) {
      const row = spState.docs.find((d) => d.id === un.dataset.unshare);
      if (!(await ask('Retirer cette réunion de l’espace ?', `« ${row.title} » et son audio seront effacés du serveur. Ta transcription d’origine ne change pas.`, 'Retirer', { danger: true }))) return;
      await Spaces.unshare(row).catch(spErr);
      return loadSpaces();
    }
    const card = e.target.closest('[data-sdoc]');
    if (card) openSpaceDoc(card.dataset.sdoc);
  });
  $('#spc-content').addEventListener('submit', async (e) => {
    if (e.target.id !== 'spc-invite') return;
    e.preventDefault();
    const s = spState.spaces.find((x) => x.id === spState.current);
    const email = $('#spc-email').value.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return toast('Adresse e-mail invalide.', 'warn');
    try {
      await Spaces.invite(s.id, email);
      const msg = `Je t’ai invité(e) dans l’espace « ${s.name} » sur Transcripteur IA : ${location.origin + location.pathname} — onglet « Espaces », connecte-toi avec ${email}.`;
      toast(`${email} invité(e).`, 'ok', 3000);
      await loadSpace();
      const ok = await ask('Prévenir la personne ?', msg, 'Copier l’invitation');
      if (ok) { await writeClipboard(msg); toast('Invitation copiée : colle-la dans un message.', 'ok', 4000); }
    } catch (err) { spErr(err); }
  });
}

async function newSpace() {
  const n = await askText('Nouvel espace', 'Nom (ex. « Projet Ledona », « Famille »)', '', 'Créer');
  if (!n) return;
  try {
    const s = await Spaces.create(n);
    spState.current = s.id;
    lsSet('spaces.current', s.id);
    await loadSpaces();
  } catch (e) { spErr(e); }
}

/** Au démarrage : retour de la connexion Google de l'espace collaboratif. */
export async function initSpaces() {
  bindSpaces();
  const q = new URLSearchParams(location.search);
  if (lsGet('transcripteur.spaces.pending', '') === '1' && q.has('error')) {
    localStorage.removeItem('transcripteur.spaces.pending');
    toast(`Connexion à l’espace collaboratif refusée : ${q.get('error_description') || q.get('error')}`, 'err', 8000);
    history.replaceState(null, '', location.pathname);
    return;
  }
  if (Spaces.configured() && Spaces.isAuthReturn()) {
    try { await Spaces.finishSignIn(); setView('spaces'); toast('Connecté à l’espace collaboratif.', 'ok', 3000); } catch (e) { spErr(e); }
    return;
  }
  if ((Spaces.configured() || window.__spacesClient) && Spaces.hasSession()) {
    try {
      const me = await Spaces.user();
      if (!me) return;
      spState.me = me;
      if (!spState.spaces.length) spState.spaces = await Spaces.list();
      startChat(me, () => spState.spaces);
    } catch (e) { console.warn('espaces au démarrage', e); }
  }
}
