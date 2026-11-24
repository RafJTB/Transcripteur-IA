// Lexique et liste des projets.

import { Audios, History } from '../history.js';
import { Folders, Sync } from '../cloud.js';
import { saveLexicon } from '../lexicon.js';
import { speakerColor } from '../speakers.js';
import { dayGroup, dayLabel, folderColor, speakerShares } from '../projects.js';
import { folderOptions, moveToFolder, renderFolderBar } from './account.js';
import { $, ask, esc, fmtBytes, fmtHours, fmtShortDur, fold, initials, relDay, state, toast } from './core.js';
import { STAT_ICONS, actionSources, docIcon, renderAnalytics, renderDashboard } from './dashboard.js';
import { clearResult, showDoc, updateButtons } from './doc.js';
import { renderStorage } from './engine.js';
import { clearAudio, micBusy, player, setAudioFromBlob, videoIdOf } from './recording.js';
import { SP_PEOPLE } from './spaces.js';
import { getAudio, isMine, renderResume } from './transcription.js';
import { closeDrawers } from './views.js';

// ======================================================================
// Lexique
// ======================================================================
export function renderLexicon() {
  const list = $('#lex-list');
  list.innerHTML = '';
  state.lexicon.forEach((e, i) => {
    const row = document.createElement('div');
    row.className = 'lex-row' + (e.enabled === false ? ' off' : '');
    row.innerHTML = `
      <input type="checkbox" ${e.enabled !== false ? 'checked' : ''} aria-label="Activer" data-k="enabled" />
      <input type="text" value="" placeholder="ex. revite" data-k="from" aria-label="Terme entendu" />
      <input type="text" value="" placeholder="ex. Revit" data-k="to" aria-label="Correction" />
      <button class="icon-btn" type="button" data-del aria-label="Supprimer"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
      ${e.note ? '<span></span><span class="note"></span>' : ''}`;
    $('[data-k=from]', row).value = e.from || '';
    $('[data-k=to]', row).value = e.to || '';
    if (e.note) $('.note', row).textContent = e.note;
    row.addEventListener('input', (ev) => {
      const k = ev.target.dataset.k;
      if (!k) return;
      e[k] = k === 'enabled' ? ev.target.checked : ev.target.value;
      row.classList.toggle('off', e.enabled === false);
      saveLexicon(state.lexicon);
    });
    $('[data-del]', row).onclick = () => { state.lexicon.splice(i, 1); saveLexicon(state.lexicon); renderLexicon(); };
    list.appendChild(row);
  });
}

// ======================================================================
// Historique
// ======================================================================
export async function renderHistory() {
  if (state.page === 'home') renderDashboard();
  if (state.page === 'analytics') renderAnalytics();
  const list = $('#hist-list');
  let items = [];
  let sizes = {};
  try { [items, sizes] = await Promise.all([History.list(), Audios.sizes()]); } catch { list.innerHTML = '<p class="hist-empty">Historique indisponible dans ce navigateur.</p>'; return; }
  items = items.filter(isMine);
  renderFolderBar(items);
  if (state.folder !== 'all') items = items.filter((it) => (state.folder === 'none' ? !Folders.get(it.folderId) : it.folderId === state.folder));
  const total = items.reduce((a, it) => a + (it.durationS || 0), 0);
  const acts = items.reduce((a, it) => a + openActionCount(it), 0);
  $('#hist-count').innerHTML = items.length ? `<b>${items.length} réunion${items.length > 1 ? 's' : ''}</b>${total ? ` · ${fmtHours(total)} d’audio` : ''}${acts ? ` · <b>${acts} action${acts > 1 ? 's' : ''}</b> à faire` : ''}` : '';
  renderProjStorage(sizes);
  if (!items.length) { list.innerHTML = `<div class="hist-empty"><span class="r-ico violet">${STAT_ICONS.docs}</span><b>${state.folder === 'all' ? 'Aucune transcription pour l’instant' : 'Ce dossier est vide'}</b><small>${state.folder === 'all' ? 'Lance ta première avec « Nouvelle transcription » sur l’accueil.' : 'Range une transcription ici avec son menu « Dossier ».'}</small></div>`; return; }
  const q = [...$('#hist-search').value.trim()].map(fold).join('');
  const textOf = (it) => [...`${it.title} ${it.segments.map((x) => x.text).join(' ')}`].map(fold).join('');
  if (q) items = items.filter((it) => textOf(it).includes(q));
  if (!items.length) { list.innerHTML = '<p class="hist-empty">Aucun résultat.</p>'; return; }
  list.innerHTML = '';
  const now = Date.now();
  let group = null;
  for (const it of items) {
    const g = dayGroup(it.createdAt, now);
    if (!group || group.key !== g.key) {
      group = { ...g, n: items.filter((x) => dayGroup(x.createdAt, now).key === g.key).length };
      const h = document.createElement('div');
      h.className = 'proj-group';
      h.innerHTML = `<span>${esc(g.label)}</span><em>${group.n}</em><hr />`;
      list.appendChild(h);
    }
    const el = document.createElement('article');
    el.className = 'hist-item proj-row' + (state.doc?.id === it.id ? ' current' : '');
    el.tabIndex = 0;
    el.dataset.doc = it.id;
    const folder = Folders.get(it.folderId);
    el.style.setProperty('--fc', folderColor(folder?.id, Folders.raw()));
    const [, icon] = docIcon(it.title);
    const shares = speakerShares(it);
    const audioSize = it.audioId ? sizes[it.audioId] : null;
    const hasVideo = it.audioId && sizes[videoIdOf(it.audioId)] != null;
    const interrupted = it.status === 'interrupted' || it.status === 'running';
    const open = openActionCount(it);
    const time = new Date(it.createdAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    const isToday = g.key === 'today';
    const sub = [isToday ? '' : time, it.durationS ? fmtShortDur(it.durationS) : ''].filter(Boolean).join(' · ');
    el.innerHTML = `<span class="pr-when"><b>${esc(dayLabel(it.createdAt, now))}</b><small>${esc(sub)}</small></span>
      <span class="pr-stripe" aria-hidden="true"></span>
      <span class="pr-title"><span class="pr-ico">${icon}</span><span class="pr-txt"><b></b><small></small></span></span>
      <span class="pr-who">${shares.length ? `<span class="pr-av">${shares.slice(0, 4).map((x) => `<i style="--c:${speakerColor(x.spk)}" title="${esc(x.name)} · ${x.pct} %">${esc(/^Personne (\d+)$/.test(x.name) ? x.name.replace(/\D/g, '') : initials(x.name).slice(0, 1))}</i>`).join('')}${shares.length > 4 ? `<i class="more">+${shares.length - 4}</i>` : ''}</span><span class="pr-share" title="Temps de parole">${shares.map((x) => `<i style="--c:${speakerColor(x.spk)};flex:${Math.max(1, x.pct)}" title="${esc(x.name)} · ${x.pct} %"></i>`).join('')}</span>` : ''}</span>
      <span class="pr-chips">${interrupted ? '<span class="pr-chip warn">Interrompue</span>' : ''}${it.fromSpace ? `<span class="pr-chip shared" title="Partagée dans l’espace « ${esc(it.fromSpace.name)} »${it.fromSpace.by ? ` par ${esc(it.fromSpace.by)}` : ''}">${SP_PEOPLE}</span>` : ''}${hasVideo ? `<span class="pr-chip vid" title="Vidéo de l’écran gardée (${fmtBytes(sizes[videoIdOf(it.audioId)])})"><svg viewBox="0 0 24 24"><rect x="3" y="6" width="13" height="12" rx="2"/><path d="m16 10 5-3v10l-5-3z"/></svg></span>` : ''}${open ? `<span class="pr-chip act" title="${open} action${open > 1 ? 's' : ''} à faire"><svg viewBox="0 0 24 24"><path d="M9 11l3 3 8-8"/><path d="M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9"/></svg>${open}</span>` : ''}</span>
      <span class="pr-end">
        <label class="pr-btn pr-folder" title="Ranger dans un dossier"><svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg><select class="hist-move" aria-label="Dossier"></select></label>
        <button class="pr-btn danger pc-del" type="button" aria-label="Supprimer" title="Supprimer la transcription et son audio"><svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg></button>
        <button class="pr-play" type="button" data-play aria-label="Écouter" title="${it.audioId ? `Écouter${audioSize != null ? ` (${fmtBytes(audioSize)})` : ''}` : 'Pas d’audio gardé'}"${it.audioId ? '' : ' disabled'}><svg viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z"/></svg></button>
        <svg class="pr-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>
      </span>`;
    $('.pr-txt b', el).textContent = it.title;
    const mv = $('.hist-move', el);
    mv.innerHTML = folderOptions(it.folderId);
    mv.onchange = () => moveToFolder(it, mv.value);
    const all = it.segments.map((x) => x.text).join(' ');
    let preview = all.slice(0, 160);
    if (q) {
      // Montre le passage qui contient le mot cherché
      const at = [...all].map(fold).join('').indexOf(q);
      if (at > 40) preview = '…' + all.slice(at - 40, at + 120);
    }
    $('.pr-txt small', el).textContent = `${folder ? `${folder.name} · ` : ''}${preview || '(vide)'}`;
    const openIt = () => openDoc(it);
    el.addEventListener('click', (e) => {
      if (e.target.closest('.pr-btn, .hist-move')) return;
      openIt();
      if (e.target.closest('[data-play]') && it.audioId) {
        const t0 = Date.now();
        const tick = () => {
          if (state.audio?.audioId === it.audioId && player?.loaded) player.audio.play().catch(() => {});
          else if (Date.now() - t0 < 8000) setTimeout(tick, 150);
        };
        tick();
      }
    });
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === el) openIt(); });
    $('.pc-del', el).onclick = async () => {
      if (state.run?.doc.id === it.id || state.doc?.id === it.id && state.phase !== 'idle') return toast('Cette transcription est en cours.', 'warn');
      const ok = await ask('Supprimer cette transcription ?', `« ${it.title} »${it.audioId ? ' et son audio seront' : ' sera'} définitivement effacé${it.audioId ? 's' : 'e'} de ce navigateur.`, 'Supprimer', { danger: true });
      if (!ok) return;
      await History.remove(it.id);
      Sync.forget(it.id);
      if (it.audioId) {
        const others = (await History.list()).some((d) => d.audioId === it.audioId);
        if (!others) {
          await Audios.remove(it.audioId);
          Sync.forget(null, it.audioId);
          if (state.audio?.audioId === it.audioId) clearAudio();
        }
      }
      if (state.doc?.id === it.id) clearResult();
      renderHistory();
      renderStorage();
      updateButtons();
    };
    list.appendChild(el);
  }
}

/** Actions encore à faire dans une réunion (relevées par l'onglet Actions). */
function openActionCount(d) {
  try { return actionSources([d])[0].items.filter((x) => x.type === 'action' && !x.done).length; } catch { return 0; }
}

/** Place occupée sur ce PC (bas de la colonne des dossiers). */
async function renderProjStorage(sizes) {
  const el = $('#proj-storage');
  if (!el) return;
  const used = Object.values(sizes || {}).reduce((a, b) => a + (b || 0), 0);
  let quota = 0;
  try { quota = (await navigator.storage?.estimate?.())?.quota || 0; } catch { /* inconnu */ }
  const pct = quota ? Math.min(100, Math.max(1, (used / quota) * 100)) : 0;
  el.innerHTML = `<span>Audio gardé sur ce PC</span><span class="bar"><i style="width:${pct.toFixed(1)}%"></i></span><small>${fmtBytes(used)}${quota ? ` sur ${fmtBytes(quota)} disponibles` : ''}</small>`;
}

export function openDoc(it) {
  if (state.phase !== 'idle' || micBusy()) return toast('Attends la fin de la transcription ou de l’enregistrement en cours.', 'warn');
  showDoc(it);
  closeDrawers();
  renderHistory();
  renderResume(it);
  // Recharge l'audio associé (réécoute, horodatages cliquables, reprise)
  if (it.audioId && state.audio?.audioId !== it.audioId) {
    const before = state.audio;
    getAudio(it.audioId).then((rec) => {
      // Ne jamais écraser un audio choisi entre-temps par l'utilisateur
      if (rec?.blob && state.doc?.id === it.id && state.phase === 'idle' && state.audio === before && !micBusy()) setAudioFromBlob(rec.blob, rec.name, { audioId: rec.id, docId: it.id }).then(() => renderResume(state.doc));
    }).catch(() => {});
  }
}
