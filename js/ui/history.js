// Lexique et liste des projets.

import { Audios, History } from '../history.js';
import { Folders, Sync } from '../cloud.js';
import { saveLexicon } from '../lexicon.js';
import { speakerColor } from '../speakers.js';
import { folderOptions, moveToFolder, renderFolderBar } from './account.js';
import { $, ask, esc, fmtBytes, fmtHours, fmtShortDur, fold, initials, relDay, state, toast } from './core.js';
import { STAT_ICONS, docIcon, renderAnalytics, renderDashboard } from './dashboard.js';
import { clearResult, showDoc, updateButtons } from './doc.js';
import { renderStorage } from './engine.js';
import { clearAudio, micBusy, setAudioFromBlob, videoIdOf } from './recording.js';
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
  $('#hist-count').textContent = items.length ? `${items.length} transcription${items.length > 1 ? 's' : ''}${total ? ` · ${fmtHours(total)} d’audio` : ''}` : '';
  if (!items.length) { list.innerHTML = `<div class="hist-empty"><span class="r-ico violet">${STAT_ICONS.docs}</span><b>${state.folder === 'all' ? 'Aucune transcription pour l’instant' : 'Ce dossier est vide'}</b><small>${state.folder === 'all' ? 'Lance ta première avec « Nouvelle transcription » sur l’accueil.' : 'Range une transcription ici avec son menu « Dossier ».'}</small></div>`; return; }
  const q = [...$('#hist-search').value.trim()].map(fold).join('');
  const textOf = (it) => [...`${it.title} ${it.segments.map((x) => x.text).join(' ')}`].map(fold).join('');
  if (q) items = items.filter((it) => textOf(it).includes(q));
  if (!items.length) { list.innerHTML = '<p class="hist-empty">Aucun résultat.</p>'; return; }
  list.innerHTML = '';
  for (const it of items) {
    const el = document.createElement('article');
    el.className = 'hist-item proj-card' + (state.doc?.id === it.id ? ' current' : '');
    el.tabIndex = 0;
    const [tone, icon] = docIcon(it.title);
    const sp = (it.speakers || []).filter((x) => x?.name);
    const audioSize = it.audioId ? sizes[it.audioId] : null;
    const interrupted = it.status === 'interrupted' || it.status === 'running';
    el.innerHTML = `<div class="pc-top"><span class="r-ico ${tone}">${icon}</span><div class="pc-title"><strong></strong><small></small></div>
      <button class="icon-btn danger pc-del" type="button" aria-label="Supprimer" title="Supprimer la transcription et son audio"><svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg></button></div>
      <div class="pc-chips">${it.durationS ? `<span><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>${fmtShortDur(it.durationS)}</span>` : ''}${sp.length > 1 ? `<span>${STAT_ICONS.people}${sp.length} intervenants</span>` : ''}${it.model ? `<span>${esc(it.model.replace(/^Whisper /, ''))}</span>` : ''}${audioSize != null ? `<span><svg viewBox="0 0 24 24"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>${fmtBytes(audioSize)}</span>` : ''}${it.audioId && sizes[videoIdOf(it.audioId)] != null ? `<span class="vid"><svg viewBox="0 0 24 24"><rect x="3" y="6" width="13" height="12" rx="2"/><path d="m16 10 5-3v10l-5-3z"/></svg>vidéo ${fmtBytes(sizes[videoIdOf(it.audioId)])}</span>` : ''}${interrupted ? '<span class="warn">Interrompue</span>' : ''}${it.fromSpace ? `<span class="shared">${SP_PEOPLE}${esc(it.fromSpace.name)}${it.fromSpace.by ? ` · ${esc(it.fromSpace.by)}` : ''}</span>` : ''}</div>
      <p></p>
      <div class="pc-foot"><label class="pc-folder" title="Ranger dans un dossier"><svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg><select class="hist-move" aria-label="Dossier"></select></label>
        ${sp.length > 1 ? `<span class="pc-avatars">${sp.slice(0, 3).map((x, n) => `<i style="--spk:${speakerColor(n)}" title="${esc(x.name)}">${esc(/^Personne (\d+)$/.test(x.name) ? x.name.replace(/\D/g, '') : initials(x.name).slice(0, 2))}</i>`).join('')}${sp.length > 3 ? `<i class="more">+${sp.length - 3}</i>` : ''}</span>` : ''}
        <span class="pc-open" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg></span></div>`;
    $('strong', el).textContent = it.title;
    $('.pc-title small', el).textContent = `${relDay(it.createdAt)} · ${new Date(it.createdAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
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
    $('p', el).textContent = preview || '(vide)';
    if (!preview) $('p', el).classList.add('empty');
    const open = () => openDoc(it);
    el.addEventListener('click', (e) => { if (!e.target.closest('.icon-btn, .hist-move, .pc-folder')) open(); });
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
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
