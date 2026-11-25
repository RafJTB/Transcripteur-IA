// Page « Suivi des actions » : toutes les actions de toutes les réunions, à cocher, filtrer et copier.

import { emptyState } from './empty.js';
import { History } from '../history.js';
import { Folders } from '../cloud.js';
import { actionPeople, actionsToText, collectActions, countActions, filterActions, groupActions } from '../actionboard.js';
import { folderColor } from '../projects.js';
import { $, $$, esc, initials, lsGet, lsSet, state, toast, writeClipboard } from './core.js';
import { openDoc } from './history.js';
import { myDocs, persist } from './transcription.js';
import { setDocTab } from './views.js';

const PALETTE = ['#818cf8', '#34d399', '#f59e0b', '#f472b6', '#38bdf8', '#a78bfa', '#fb7185', '#2dd4bf'];
const colorOf = (name) => { let h = 0; for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return PALETTE[h % PALETTE.length]; };
const fmtDay = (t) => new Date(t).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });

const ICON = {
  todo: '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="4"/></svg>',
  overdue: '<svg viewBox="0 0 24 24"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2M9 2h6"/></svg>',
  soon: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
  done: '<svg viewBox="0 0 24 24"><path d="M9 11l3 3 8-8"/><path d="M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="m5 12 5 5 9-10"/></svg>',
  open: '<svg viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg>',
};

// Filtres retenus d'une visite à l'autre
const f = (() => {
  try { return { status: 'todo', who: null, folder: null, q: '', by: 'due', ...JSON.parse(lsGet('actions.filters', '{}')) }; } catch { return { status: 'todo', who: null, folder: null, q: '', by: 'due' }; }
})();
const saveFilters = () => lsSet('actions.filters', JSON.stringify({ status: f.status, who: f.who, folder: f.folder, by: f.by }));

let all = [];

/** Pastille du menu : nombre d'actions en retard. */
export function renderActionBadge(items = all) {
  const n = countActions(items).overdue;
  $$('#nav [data-nav="actions"]').forEach((b) => { b.classList.toggle('has-late', n > 0); b.dataset.late = n > 99 ? '99+' : String(n); });
}

export async function renderActionBoard() {
  const list = $('#ab-list');
  if (!list) return;
  all = collectActions(await myDocs());
  list.removeAttribute('aria-busy');
  renderActionBadge();
  const c = countActions(all);
  const tiles = [['todo', 'À faire', c.todo, 'violet'], ['overdue', 'En retard', c.overdue, 'red'], ['soon', 'Cette semaine', c.soon, 'amber'], ['done', 'Faites', c.done, 'green']];
  $('#ab-stats').innerHTML = tiles.map(([k, label, n, tone]) => `<button type="button" class="ab-stat t-${tone}${f.status === k ? ' on' : ''}" data-ab-status="${k}" aria-pressed="${f.status === k}"><span class="ab-ic">${ICON[k]}</span><span><b>${n}</b><small>${label}</small></span></button>`).join('');

  // Responsables
  const people = actionPeople(all);
  if (f.who != null && !people.some((p) => p.name === f.who)) f.who = null;
  $('#ab-people').innerHTML = `<button type="button" class="ab-person${f.who == null ? ' on' : ''}" data-ab-who="*"><span class="av all">∗</span>Tout le monde</button>`
    + people.map((p) => `<button type="button" class="ab-person${f.who === p.name ? ' on' : ''}" data-ab-who="${esc(p.name)}" title="${p.todo} à faire${p.overdue ? ` · ${p.overdue} en retard` : ''}"><span class="av" style="--c:${p.name ? colorOf(p.name) : '#94a3b8'}">${p.name ? esc(initials(p.name).slice(0, 2)) : '?'}</span>${p.name ? esc(p.name) : 'Sans responsable'}<small>${p.todo}</small>${p.overdue ? '<i class="late" aria-label="en retard"></i>' : ''}</button>`).join('');

  // Dossiers
  const folders = Folders.list();
  if (f.folder && f.folder !== 'none' && !folders.some((x) => x.id === f.folder)) f.folder = null;
  $('#ab-folder').innerHTML = `<option value="">Tous les dossiers</option>${folders.map((x) => `<option value="${esc(x.id)}"${f.folder === x.id ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}<option value="none"${f.folder === 'none' ? ' selected' : ''}>Sans dossier</option>`;
  $$('#ab-by [data-ab-by]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.abBy === f.by)));

  const shown = filterActions(all, f);
  $('#ab-copy').disabled = !shown.length;
  if (!all.length) {
    list.innerHTML = emptyState({ art: 'actions', title: 'Aucune action pour l’instant', text: 'Les actions sont relevées automatiquement dans tes réunions : « Julie, tu peux… », « je m’en occupe », « pour vendredi »…' });
    return;
  }
  if (!shown.length) {
    list.innerHTML = f.status === 'overdue'
      ? emptyState({ art: 'actions', title: 'Aucune action en retard', text: 'Tout est dans les temps. 👏', small: true })
      : emptyState({ art: 'search', title: f.status === 'done' ? 'Aucune action faite' : 'Rien à afficher', text: 'Change de filtre pour voir d’autres actions.', small: true });
    return;
  }
  const allF = Folders.raw();
  list.innerHTML = groupActions(shown, f.by).map((g) => `<div class="ab-group ${g.tone}"><span>${esc(g.label)}</span><em>${g.items.length}</em><hr /></div>`
    + g.items.map((x) => {
      const fc = folderColor(x.folderId, allF);
      const when = x.date != null ? fmtDay(x.date) : x.due ? x.due : '';
      return `<article class="ab-row${x.done ? ' done' : ''}${x.overdue ? ' late' : ''}" style="--fc:${fc}" data-doc="${esc(x.docId)}" data-key="${esc(x.key)}">
        <button type="button" class="ab-check" data-ab-done aria-pressed="${x.done}" aria-label="${x.done ? 'Marquer à faire' : 'Marquer comme faite'}" title="${x.done ? 'Marquer à faire' : 'Marquer comme faite'}">${ICON.check}</button>
        <span class="ab-txt"><b>${esc(x.text)}</b>
          <span class="ab-meta">${x.who ? `<span class="ab-who"><i style="--c:${colorOf(x.who)}">${esc(initials(x.who).slice(0, 2))}</i>${esc(x.who)}</span>` : '<span class="ab-who none">Sans responsable</span>'}${when ? `<span class="ab-due${x.overdue ? ' late' : x.soon ? ' soon' : ''}">${ICON.soon}${esc(when)}</span>` : ''}</span></span>
        <button type="button" class="ab-doc" data-ab-open title="Ouvrir la réunion"><i></i><span>${esc(x.docTitle)}<small>${esc(new Date(x.meetingAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }))}</small></span>${ICON.open}</button>
      </article>`;
    }).join('')).join('');
}

async function toggleDone(docId, key) {
  const d = await History.get(docId).catch(() => null);
  if (!d) return;
  const done = d.actionState?.[key] === 'done';
  d.actionState = { ...(d.actionState || {}) };
  if (done) delete d.actionState[key];
  else d.actionState[key] = 'done';
  await persist(d);
  // Réunion ouverte : l'onglet Actions reflète le changement
  if (state.doc?.id === docId) state.doc.actionState = d.actionState;
  if (!done) toast('Action faite.', 'ok', 1800);
  renderActionBoard();
}

export function bindActionBoard() {
  if (!$('#ab-list')) return;
  $('#ab-stats').addEventListener('click', (e) => {
    const b = e.target.closest('[data-ab-status]');
    if (!b) return;
    f.status = f.status === b.dataset.abStatus && b.dataset.abStatus !== 'todo' ? 'todo' : b.dataset.abStatus;
    saveFilters();
    renderActionBoard();
  });
  $('#ab-people').addEventListener('click', (e) => {
    const b = e.target.closest('[data-ab-who]');
    if (!b) return;
    f.who = b.dataset.abWho === '*' ? null : b.dataset.abWho;
    saveFilters();
    renderActionBoard();
  });
  $('#ab-folder').onchange = (e) => { f.folder = e.target.value || null; saveFilters(); renderActionBoard(); };
  $('#ab-by').addEventListener('click', (e) => {
    const b = e.target.closest('[data-ab-by]');
    if (!b) return;
    f.by = b.dataset.abBy;
    saveFilters();
    renderActionBoard();
  });
  let t = 0;
  $('#ab-q').addEventListener('input', (e) => { f.q = e.target.value; clearTimeout(t); t = setTimeout(renderActionBoard, 150); });
  $('#ab-list').addEventListener('click', async (e) => {
    const row = e.target.closest('.ab-row');
    if (!row) return;
    if (e.target.closest('[data-ab-done]')) return toggleDone(row.dataset.doc, row.dataset.key);
    if (e.target.closest('[data-ab-open]')) {
      const d = await History.get(row.dataset.doc).catch(() => null);
      if (!d) return;
      openDoc(d);
      setDocTab('actions');
    }
  });
  $('#ab-copy').onclick = async () => {
    const txt = actionsToText(filterActions(all, f));
    const ok = await writeClipboard(txt);
    toast(ok ? 'Liste copiée : colle-la dans un mail ou sur Teams.' : 'Copie refusée par le navigateur.', ok ? 'ok' : 'warn', 3500);
  };
  // Pastille du menu dès le démarrage
  myDocs().then((docs) => renderActionBadge(collectActions(docs))).catch(() => {});
}
