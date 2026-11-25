// Page « Mes projets » : calculs purs (couleurs de dossier, temps de parole, regroupement par date).

/** Couleurs des dossiers (R G B), choisies automatiquement et stables pour un même dossier. */
export const FOLDER_COLORS = ['139 92 246', '249 115 22', '6 182 212', '16 185 129', '236 72 153', '245 158 11', '59 130 246', '132 204 22'];
export const NO_FOLDER_COLOR = '148 163 184';

export function folderColor(id, all = null) {
  if (!id) return NO_FOLDER_COLOR;
  // Dans l'ordre de création : 8 dossiers de suite ont 8 couleurs différentes
  const i = all ? all.findIndex((f) => f.id === id) : -1;
  if (i >= 0) return FOLDER_COLORS[i % FOLDER_COLORS.length];
  let h = 0;
  for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return FOLDER_COLORS[h % FOLDER_COLORS.length];
}

/** Part du temps de parole de chaque personne (en %, arrondi, total 100), les plus bavards d'abord. */
export function speakerShares(doc) {
  const segs = (doc?.segments || []).filter((s) => Number.isInteger(s.spk) && s.spk >= 0);
  const tot = new Map();
  for (const s of segs) {
    const d = Math.max(0, (Number(s.end) || 0) - (Number(s.start) || 0)) || 0.01;
    tot.set(s.spk, (tot.get(s.spk) || 0) + d);
  }
  const sum = [...tot.values()].reduce((a, b) => a + b, 0);
  if (!sum) return [];
  const names = doc.speakers || [];
  const out = [...tot.entries()].map(([spk, d]) => ({ spk, name: names[spk]?.name || `Personne ${spk + 1}`, pct: (d / sum) * 100 }))
    .sort((a, b) => b.pct - a.pct);
  // Arrondi qui garde un total de 100
  let acc = 0;
  out.forEach((x, i) => { x.pct = i === out.length - 1 ? Math.max(0, 100 - acc) : Math.round(x.pct); acc += x.pct; });
  return out;
}

const DAY = 86400000;
const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

/** Groupe d'une réunion : aujourd'hui, les 7 derniers jours, puis par mois. */
export function dayGroup(ts, now = Date.now()) {
  const today = startOfDay(now);
  if (ts >= today) return { key: 'today', label: 'Aujourd’hui' };
  if (ts >= today - 6 * DAY) return { key: 'week', label: 'Cette semaine' };
  const d = new Date(ts);
  const label = d.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
  return { key: `m${d.getFullYear()}-${d.getMonth()}`, label: label[0].toUpperCase() + label.slice(1) };
}

/** Libellé court du jour dans la colonne de gauche : heure aujourd'hui, « Hier », jour de la semaine, puis date. */
export function dayLabel(ts, now = Date.now()) {
  const today = startOfDay(now);
  if (ts >= today) return new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  if (ts >= today - DAY) return 'Hier';
  if (ts >= today - 6 * DAY) { const w = new Date(ts).toLocaleDateString('fr-FR', { weekday: 'long' }); return w[0].toUpperCase() + w.slice(1); }
  const sameYear = new Date(ts).getFullYear() === new Date(now).getFullYear();
  return new Date(ts).toLocaleDateString('fr-FR', sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' });
}

// ---------- Recherche par intervenant ----------
const foldTxt = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const isGeneric = (n) => !n || /^Personne \d+$/.test(n);

/** Intervenants nommés de toutes les réunions, du plus présent au moins présent. */
export function meetingPeople(docs) {
  const m = new Map();
  for (const d of docs) {
    const seen = new Set();
    (d.segments || []).forEach((s) => {
      const name = d.speakers?.[s.spk]?.name;
      if (isGeneric(name)) return;
      const key = foldTxt(name);
      const e = m.get(key) || { name, meetings: 0, seconds: 0 };
      e.seconds += Math.max(0, (s.end || 0) - (s.start || 0));
      if (!seen.has(key)) { seen.add(key); e.meetings++; }
      m.set(key, e);
    });
  }
  return [...m.values()].sort((a, b) => b.meetings - a.meetings || b.seconds - a.seconds || a.name.localeCompare(b.name, 'fr'));
}

/**
 * Passages d'une réunion dits par un intervenant (comparaison sans accents ni majuscules),
 * éventuellement limités à ceux qui contiennent le texte cherché.
 * @returns {{text: string, start: number}[]}
 */
export function saidBy(doc, person, q = '') {
  const p = foldTxt(person), nq = foldTxt(q).trim();
  return (doc.segments || [])
    .filter((s) => foldTxt(doc.speakers?.[s.spk]?.name) === p && (!nq || foldTxt(s.text).includes(nq)))
    .map((s) => ({ text: s.text, start: s.start }));
}
