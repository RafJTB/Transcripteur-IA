// Conversation d'un espace : messages entre membres, en direct, non-lus et notifications.

import { Spaces, spacesError } from '../spaces.js';
import { speakerColor } from '../speakers.js';
import { $, ask, esc, initials, lsGet, lsSet, state, toast, writeClipboard } from './core.js';
import { notify } from './notifs.js';

const SEEN = 'spaces.seen'; // dernier message lu, par espace
const chat = {
  me: null,
  spaces: () => [],
  stop: null, // arrêt de l'écoute en direct
  live: false,
  poll: 0,
  unread: {}, // espace → nombre de messages non lus
  mounted: null, // { space, docs, own, messages, more, openDoc }
  attach: null, // réunion jointe au prochain message
  sending: false,
};

// (par compte : deux personnes peuvent utiliser le même navigateur)
const seenKey = () => `${SEEN}.${chat.me?.id || ''}`;
const seen = () => { try { return JSON.parse(lsGet(seenKey(), '{}')) || {}; } catch { return {}; } };
const setSeen = (id, iso) => { const s = seen(); if (!s[id] || s[id] < iso) { s[id] = iso; lsSet(seenKey(), JSON.stringify(s)); } };
const colorOf = (email = '') => speakerColor([...email].reduce((a, c) => a + c.charCodeAt(0), 0));
const timeOf = (iso) => new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
function dayOf(iso) {
  const d = new Date(iso);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const t = new Date(d); t.setHours(0, 0, 0, 0);
  const diff = Math.round((today - t) / 86400000);
  if (diff === 0) return 'Aujourd’hui';
  if (diff === 1) return 'Hier';
  return d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) });
}
/** Texte d'un message : échappé, liens cliquables, retours à la ligne. */
export function messageHtml(body) {
  return esc(body)
    .replace(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`)
    .replace(/\n/g, '<br>');
}

// ---------- Non-lus : pastilles sur la liste des espaces et dans le menu ----------
function renderBadges() {
  const total = Object.values(chat.unread).reduce((a, n) => a + n, 0);
  for (const b of document.querySelectorAll('[data-nav="spaces"]')) {
    b.classList.toggle('has-unread', total > 0);
    b.dataset.unread = total > 99 ? '99+' : String(total || '');
  }
  for (const item of document.querySelectorAll('#spc-list [data-space]')) {
    const n = chat.unread[item.dataset.space] || 0;
    let i = item.querySelector('.spc-unread');
    if (!n) { i?.remove(); continue; }
    if (!i) { i = document.createElement('i'); i.className = 'spc-unread'; item.append(i); }
    i.textContent = n > 99 ? '99+' : n;
    i.title = `${n} message${n > 1 ? 's' : ''} non lu${n > 1 ? 's' : ''}`;
  }
}
const viewing = (spaceId) => state.page === 'spaces' && chat.mounted?.space.id === spaceId && !document.hidden;

function markRead() {
  const m = chat.mounted;
  if (!m || !viewing(m.space.id)) return;
  const last = m.messages.at(-1);
  if (last) setSeen(m.space.id, last.created_at);
  if (chat.unread[m.space.id]) { chat.unread[m.space.id] = 0; renderBadges(); }
}

// ---------- Écoute en direct ----------
function onInsert(msg) {
  if (!msg?.space_id) return;
  const m = chat.mounted;
  if (m && m.space.id === msg.space_id) {
    if (!m.messages.some((x) => x.id === msg.id)) { m.messages.push(msg); renderMessages({ stick: true }); }
    if (viewing(msg.space_id)) return markRead();
  }
  if (msg.author === chat.me?.id) return;
  chat.unread[msg.space_id] = (chat.unread[msg.space_id] || 0) + 1;
  renderBadges();
  const s = chat.spaces().find((x) => x.id === msg.space_id);
  notify({ kind: 'ok', title: `${msg.author_name || msg.author_email || 'Un membre'} · ${s?.name || 'Espace'}`, text: msg.body.slice(0, 140), action: `space:${msg.space_id}`, system: true });
}
function onDelete(id) {
  const m = chat.mounted;
  if (!m || !id) return;
  const n = m.messages.length;
  m.messages = m.messages.filter((x) => x.id !== id);
  if (m.messages.length !== n) renderMessages();
}

/** Démarre l'écoute des messages de tous mes espaces (une seule fois), et compte les non-lus. */
export async function startChat(me, spacesGetter) {
  chat.spaces = spacesGetter;
  if (chat.me?.id === me?.id && chat.stop) return;
  stopChat();
  chat.me = me;
  if (!me) return;
  // Non-lus depuis la dernière lecture de chaque espace (au plus 30 jours en arrière)
  try {
    const s = seen();
    const since = new Date(Date.now() - 30 * 86400000).toISOString();
    const rows = await Spaces.messagesSince(since, me.id);
    chat.unread = {};
    for (const r of rows) if (!s[r.space_id] || r.created_at > s[r.space_id]) chat.unread[r.space_id] = (chat.unread[r.space_id] || 0) + 1;
    renderBadges();
  } catch (e) { console.warn('non-lus', e); }
  try {
    chat.stop = await Spaces.listenMessages({
      onInsert,
      onDelete,
      onStatus: (st) => { chat.live = st === 'SUBSCRIBED'; renderStatus(); },
    });
  } catch (e) { console.warn('direct', e); }
  // Filet de sécurité si le direct est coupé : on relit les nouveaux messages de l'espace ouvert
  clearInterval(chat.poll);
  chat.poll = setInterval(() => { if (!chat.live && chat.mounted && !document.hidden) pollNew(); }, 20_000);
}
export function stopChat() {
  chat.stop?.();
  chat.stop = null;
  chat.live = false;
  clearInterval(chat.poll);
  chat.unread = {};
  chat.me = null;
  renderBadges();
}
async function pollNew() {
  const m = chat.mounted;
  if (!m) return;
  try {
    const rows = await Spaces.messages(m.space.id, { limit: 30 });
    for (const r of rows) if (!m.messages.some((x) => x.id === r.id)) onInsert(r);
  } catch { /* on réessaiera */ }
}

// ---------- Carte « Conversation » ----------
export function chatCardHtml(space, members) {
  return `<section class="glass dash-card spc-chat" id="spc-chat" data-chat="${esc(space.id)}">
    <header class="dash-head"><h3><svg viewBox="0 0 24 24"><path d="M4 5h16v11H8l-4 4z"/><path d="M8 9h8M8 12h5"/></svg>Conversation</h3><span class="chat-live" id="chat-live"><i></i><span></span></span></header>
    <div class="chat-msgs" id="chat-msgs" aria-live="polite"><p class="dash-empty sm">Chargement…</p></div>
    <form class="chat-compose" id="chat-compose">
      <div class="chat-attach-chip" id="chat-attach-chip" hidden></div>
      <div class="chat-row">
        <button class="icon-btn" type="button" id="chat-attach" title="Joindre une réunion de l’espace" aria-label="Joindre une réunion de l’espace"><svg viewBox="0 0 24 24"><path d="m21 11-8.6 8.6a5 5 0 0 1-7-7l8.5-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.3-2.4l7.9-7.9"/></svg></button>
        <textarea id="chat-text" rows="1" maxlength="4000" placeholder="Écrire aux ${members.length} membre${members.length > 1 ? 's' : ''}…" aria-label="Message"></textarea>
        <button class="btn primary sm chat-go" type="submit" aria-label="Envoyer"><svg viewBox="0 0 24 24"><path d="M4 12 20 4l-4 16-4-7z"/><path d="m12 13 8-9"/></svg></button>
      </div>
      <div class="chat-pick" id="chat-pick" hidden></div>
    </form>
  </section>`;
}

function renderStatus() {
  const el = $('#chat-live');
  if (!el) return;
  el.classList.toggle('on', chat.live);
  $('span', el).textContent = chat.live ? 'en direct' : 'reconnexion…';
  el.title = chat.live ? 'Les nouveaux messages arrivent tout seuls.' : 'Connexion en direct indisponible : les messages sont relus toutes les 20 secondes.';
}

function renderMessages({ stick = false, keep = false } = {}) {
  const box = $('#chat-msgs');
  const m = chat.mounted;
  if (!box || !m) return;
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  const prevH = box.scrollHeight;
  if (!m.messages.length) {
    box.innerHTML = `<div class="chat-empty"><b>Aucun message</b><small>Écris le premier : il sera visible par tous les membres de « ${esc(m.space.name)} ».</small></div>`;
    return;
  }
  let html = m.more ? '<button class="link-btn chat-more" type="button" data-more>Messages précédents</button>' : '';
  let day = '';
  let prev = null;
  for (const x of m.messages) {
    const d = dayOf(x.created_at);
    if (d !== day) { html += `<p class="chat-day"><span>${esc(d)}</span></p>`; day = d; prev = null; }
    const mine = x.author === chat.me?.id;
    const cont = prev && prev.author === x.author && new Date(x.created_at) - new Date(prev.created_at) < 5 * 60000;
    const who = x.author_name || x.author_email || 'Membre';
    const doc = x.doc_id ? m.docs.find((dd) => dd.id === x.doc_id) : null;
    const canDel = mine || m.own;
    html += `<div class="cm${mine ? ' mine' : ''}${cont ? ' cont' : ''}" data-mid="${esc(x.id)}">
      ${mine ? '' : `<i class="cm-av" style="--spk:${colorOf(x.author_email || who)}" title="${esc(who)}">${cont ? '' : esc(initials(who))}</i>`}
      <div class="cm-b">${cont ? '' : `<header>${mine ? '' : `<b>${esc(who)}</b>`}<time datetime="${esc(x.created_at)}">${timeOf(x.created_at)}</time></header>`}
        <p>${messageHtml(x.body)}</p>
        ${x.doc_id ? (doc ? `<button type="button" class="cm-doc" data-open-sdoc="${esc(doc.id)}"><svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg><span>${esc(doc.title)}</span></button>` : '<span class="cm-doc gone">Réunion retirée de l’espace</span>') : ''}
        ${canDel ? `<button type="button" class="cm-del" data-del="${esc(x.id)}" title="Supprimer le message" aria-label="Supprimer le message"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>` : ''}
      </div></div>`;
    prev = x;
  }
  box.innerHTML = html;
  if (keep) box.scrollTop = box.scrollHeight - prevH;
  else if (stick ? atBottom || m.messages.at(-1)?.author === chat.me?.id : true) box.scrollTop = box.scrollHeight;
}

function renderAttach() {
  const chip = $('#chat-attach-chip');
  if (!chip) return;
  const d = chat.attach && chat.mounted?.docs.find((x) => x.id === chat.attach);
  chip.hidden = !d;
  chip.innerHTML = d ? `<svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg><span>${esc(d.title)}</span><button type="button" class="spc-x" data-unattach aria-label="Retirer la réunion jointe"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>` : '';
}

/** Affiche la conversation d'un espace (appelé à chaque ouverture d'un espace). */
export async function mountChat(space, { docs = [], own = false, openDoc } = {}) {
  chat.mounted = { space, docs, own, messages: [], more: false, openDoc };
  chat.attach = null;
  renderStatus();
  bindCard();
  try {
    const rows = await Spaces.messages(space.id, { limit: 50 });
    if (chat.mounted?.space.id !== space.id) return;
    $('#chat-compose')?.classList.remove('blocked');
    chat.mounted.messages = rows;
    chat.mounted.more = rows.length === 50;
    renderMessages();
    markRead();
  } catch (e) {
    const box = $('#chat-msgs');
    if (!box) return;
    // Table absente : le projet Supabase n'a pas encore le script à jour → marche à suivre et copie en un clic
    if (isMissingTable(e)) {
      box.innerHTML = `<div class="chat-setup"><b>Une dernière étape dans Supabase</b>
        <small>La conversation a besoin d’une nouvelle table. À faire une seule fois (tes espaces et réunions ne changent pas) :</small>
        <ol><li><button class="btn primary sm" type="button" data-copy-sql>Copier le script SQL</button></li><li>Supabase → <b>SQL Editor</b> → <b>New query</b> → coller → <b>Run</b></li><li>Revenir ici : <button class="btn sm" type="button" data-retry-chat>Réessayer</button></li></ol></div>`;
      $('#chat-compose')?.classList.add('blocked');
      return;
    }
    box.innerHTML = `<p class="dash-empty sm">${esc(spacesError(e))}</p>`;
  }
}
const isMissingTable = (e) => /relation .* does not exist|schema cache|Could not find the table|42P01|PGRST205/i.test(`${e?.code || ''} ${e?.message || e || ''}`);

/** Copie le script SQL du site (supabase/schema.sql). */
async function copySql() {
  try {
    const sql = await (await fetch('supabase/schema.sql', { cache: 'no-cache' })).text();
    if (!/create table/i.test(sql)) throw new Error('script introuvable');
    const ok = await writeClipboard(sql);
    toast(ok ? 'Script SQL copié : colle-le dans Supabase → SQL Editor → New query, puis « Run ».' : 'Copie refusée par le navigateur : ouvre supabase/schema.sql et copie-le à la main.', ok ? 'ok' : 'warn', 7000);
  } catch { toast('Copie impossible : ouvre supabase/schema.sql sur le site ou sur GitHub.', 'err', 6000); }
}
export function unmountChat() { chat.mounted = null; }
export const unreadOf = (id) => chat.unread[id] || 0;
export const refreshBadges = renderBadges;

async function send() {
  const m = chat.mounted;
  const ta = $('#chat-text');
  const body = ta.value.trim();
  if (!m || !body || chat.sending) return;
  chat.sending = true;
  $('#chat-compose').classList.add('busy');
  try {
    const row = await Spaces.sendMessage(m.space.id, body, chat.me, chat.attach);
    ta.value = '';
    autosize(ta);
    chat.attach = null;
    renderAttach();
    if (chat.mounted?.space.id === m.space.id && !m.messages.some((x) => x.id === row.id)) { m.messages.push(row); renderMessages({ stick: true }); }
    markRead();
  } catch (e) {
    if (isMissingTable(e)) return mountChat(m.space, { docs: m.docs, own: m.own, openDoc: m.openDoc });
    toast(spacesError(e), 'err', 6000);
  } finally {
    chat.sending = false;
    $('#chat-compose')?.classList.remove('busy');
    ta.focus();
  }
}
const autosize = (ta) => { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`; };

function bindCard() {
  const card = $('#spc-chat');
  if (!card || card.dataset.bound) return;
  card.dataset.bound = '1';
  const ta = $('#chat-text');
  ta.addEventListener('input', () => autosize(ta));
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });
  $('#chat-compose').addEventListener('submit', (e) => { e.preventDefault(); send(); });
  card.addEventListener('click', async (e) => {
    const m = chat.mounted;
    if (!m) return;
    if (e.target.closest('[data-more]')) {
      try {
        const rows = await Spaces.messages(m.space.id, { before: m.messages[0]?.created_at, limit: 50 });
        m.messages = [...rows, ...m.messages];
        m.more = rows.length === 50;
        renderMessages({ keep: true });
      } catch (err) { toast(spacesError(err), 'err', 5000); }
      return;
    }
    const del = e.target.closest('[data-del]');
    if (del) {
      if (!(await ask('Supprimer ce message ?', 'Il disparaîtra pour tous les membres.', 'Supprimer', { danger: true }))) return;
      try { await Spaces.deleteMessage(del.dataset.del); onDelete(del.dataset.del); } catch (err) { toast(spacesError(err), 'err', 5000); }
      return;
    }
    if (e.target.closest('[data-copy-sql]')) return copySql();
    if (e.target.closest('[data-retry-chat]')) { $('#chat-compose')?.classList.remove('blocked'); return mountChat(m.space, { docs: m.docs, own: m.own, openDoc: m.openDoc }); }
    const open = e.target.closest('[data-open-sdoc]');
    if (open) return m.openDoc?.(open.dataset.openSdoc);
    const msg = e.target.closest('.cm');
    if (msg && !e.target.closest('a')) {
      for (const x of card.querySelectorAll('.cm.sel')) if (x !== msg) x.classList.remove('sel');
      msg.classList.toggle('sel');
      return;
    }
    const pick = $('#chat-pick');
    if (e.target.closest('#chat-attach')) {
      if (!pick.hidden) { pick.hidden = true; return; }
      pick.innerHTML = m.docs.length
        ? `<p class="sp-label">Joindre une réunion de l’espace</p>${m.docs.slice(0, 30).map((d) => `<button type="button" class="sp-row" data-attach="${esc(d.id)}"><span class="sp-txt"><b>${esc(d.title)}</b><small>par ${esc(d.author_name || d.author_email || 'un membre')}</small></span></button>`).join('')}`
        : '<p class="sp-empty">Aucune réunion partagée dans cet espace pour l’instant.</p>';
      pick.hidden = false;
      return;
    }
    const at = e.target.closest('[data-attach]');
    if (at) { chat.attach = at.dataset.attach; pick.hidden = true; renderAttach(); ta.focus(); return; }
    if (e.target.closest('[data-unattach]')) { chat.attach = null; renderAttach(); }
  });
}

// Retour sur l'onglet : les messages affichés sont lus
document.addEventListener('visibilitychange', markRead);
export const chatMarkRead = markRead;
