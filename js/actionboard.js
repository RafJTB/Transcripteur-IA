// Suivi des actions : toutes les actions relevées dans toutes les réunions (calculs purs).
import { extractActions } from './actions.js';

const DAY = 86400000;
const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

/**
 * Toutes les actions (pas les décisions) de toutes les réunions, avec l'état choisi par l'utilisateur.
 * @returns {{docId, docTitle, folderId, meetingAt, key, text, who, due, date, done, overdue, soon, start}[]}
 */
export function collectActions(docs, now = Date.now()) {
  const today = startOfDay(now);
  const out = [];
  for (const d of docs) {
    if (!d?.segments?.length) continue;
    const st = d.actionState || {};
    for (const x of extractActions(d.segments, { speakers: d.speakers || [], meetingTime: d.createdAt })) {
      if (x.type !== 'action' || st[x.key] === 'hidden') continue;
      const who = d.actionWho && x.key in d.actionWho ? d.actionWho[x.key] || null : x.who || null;
      const date = x.date ? new Date(x.date).getTime() : null;
      const done = st[x.key] === 'done';
      out.push({
        docId: d.id, docTitle: d.title || 'Réunion', folderId: d.folderId || null, meetingAt: d.createdAt || 0,
        key: x.key, text: x.text, who, due: x.due || null, date, done, start: x.start,
        overdue: !done && date != null && date < today,
        soon: !done && date != null && date >= today && date < today + 7 * DAY,
      });
    }
  }
  return out;
}

/** Compteurs du haut de page. */
export function countActions(items) {
  return {
    todo: items.filter((x) => !x.done).length,
    overdue: items.filter((x) => x.overdue).length,
    soon: items.filter((x) => x.soon).length,
    done: items.filter((x) => x.done).length,
  };
}

/** Filtres : statut (todo | overdue | soon | done | all), responsable (nom, '' = personne), dossier, texte. */
export function filterActions(items, { status = 'todo', who = null, folder = null, q = '' } = {}) {
  const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const nq = fold(q).trim();
  return items.filter((x) =>
    (status === 'all' || (status === 'todo' && !x.done) || (status === 'done' && x.done) || (status === 'overdue' && x.overdue) || (status === 'soon' && x.soon))
    && (who == null || (who === '' ? !x.who : x.who === who))
    && (folder == null || (folder === 'none' ? !x.folderId : x.folderId === folder))
    && (!nq || fold(`${x.text} ${x.who || ''} ${x.docTitle}`).includes(nq)));
}

/** Responsables, du plus chargé au moins chargé (actions à faire). */
export function actionPeople(items) {
  const m = new Map();
  for (const x of items) {
    const k = x.who || '';
    const e = m.get(k) || { name: k, todo: 0, overdue: 0, total: 0 };
    e.total++;
    if (!x.done) e.todo++;
    if (x.overdue) e.overdue++;
    m.set(k, e);
  }
  return [...m.values()].sort((a, b) => (!a.name) - (!b.name) || b.todo - a.todo || a.name.localeCompare(b.name, 'fr'));
}

/** Tri : en retard d'abord, puis par échéance, puis sans échéance (réunions les plus récentes d'abord). */
export function sortActions(items) {
  return [...items].sort((a, b) =>
    (a.done - b.done)
    || ((a.date == null) - (b.date == null))
    || ((a.date ?? 0) - (b.date ?? 0))
    || (b.meetingAt - a.meetingAt)
    || (a.start - b.start));
}

/**
 * Regroupement pour l'affichage.
 * @param {'due'|'who'|'meeting'} by
 * @returns {{key: string, label: string, tone: string, items: object[]}[]}
 */
export function groupActions(items, by = 'due', now = Date.now()) {
  const sorted = sortActions(items);
  const groups = new Map();
  const add = (key, label, tone, x) => { if (!groups.has(key)) groups.set(key, { key, label, tone, items: [] }); groups.get(key).items.push(x); };
  const today = startOfDay(now);
  for (const x of sorted) {
    if (by === 'who') add(`w:${x.who || ''}`, x.who || 'Sans responsable', x.who ? '' : 'muted', x);
    else if (by === 'meeting') add(`m:${x.docId}`, x.docTitle, '', x);
    else if (x.done) add('done', 'Faites', 'ok', x);
    else if (x.overdue) add('late', 'En retard', 'late', x);
    else if (x.date != null && x.date < today + DAY) add('today', 'Aujourd’hui', 'soon', x);
    else if (x.soon) add('week', 'Dans les 7 jours', 'soon', x);
    else if (x.date != null) add('later', 'Plus tard', '', x);
    else add('nodate', 'Sans échéance', 'muted', x);
  }
  const order = ['late', 'today', 'week', 'later', 'nodate', 'done'];
  const list = [...groups.values()];
  if (by === 'due') list.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  if (by === 'who') list.sort((a, b) => (a.key === 'w:') - (b.key === 'w:') || b.items.filter((x) => !x.done).length - a.items.filter((x) => !x.done).length);
  return list;
}

/** Liste à copier (mail, Teams) : par responsable, avec l'échéance et la réunion. */
export function actionsToText(items, fmtDate = (t) => new Date(t).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })) {
  const lines = [];
  for (const g of groupActions(items, 'who')) {
    lines.push(`${g.label} :`);
    for (const x of g.items) lines.push(`- [${x.done ? 'x' : ' '}] ${x.text}${x.date != null ? ` (pour le ${fmtDate(x.date)})` : x.due ? ` (${x.due})` : ''} · ${x.docTitle}`);
    lines.push('');
  }
  return lines.join('\n').trim();
}
