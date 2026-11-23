// Vérification d'une transcription : un second modèle (plus précis) réécoute des passages,
// puis on compare les deux versions. Fonctions pures, testables seules.

export const VERIFY = {
  doubtful: 0.6, // en dessous : passage douteux (vérifié en mode rapide)
  agree: 0.85, // similarité à partir de laquelle les deux écoutes sont d'accord
  margin: 0.08, // la nouvelle écoute doit être plus sûre d'elle d'au moins autant pour remplacer
  minS: 4, // un passage trop court se réécoute mal : on l'élargit aux phrases voisines
  maxS: 25, // un passage = une seule fenêtre du modèle (30 s)
};

/** Mots comparables : minuscules, sans accents ni ponctuation. */
export function normWords(t) {
  return String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[’']/g, ' ').replace(/[^a-z0-9œæ\s-]/g, ' ').replace(/-/g, ' ').split(/\s+/).filter(Boolean);
}

/** Distance entre deux mots, en lettres. */
function charDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Coût de remplacement d'un mot par un autre : 0 s'ils sont identiques ; faible s'ils ne diffèrent
 * que d'une lettre (« valider » / « validé », « scanne » / « scan »), car l'audio ne départage pas ces écarts.
 */
function subCost(a, b) {
  if (a === b) return 0;
  const d = charDistance(a, b);
  if (Math.max(a.length, b.length) >= 4 && d <= 1) return 0.25;
  if (Math.max(a.length, b.length) >= 6 && d <= 2) return 0.5;
  return 1;
}

/**
 * Distance d'édition entre deux listes de mots.
 * `soft` : remplacements pondérés par la ressemblance des mots ; `soft: 'meaning'` : seuls comptent les mots
 * vraiment différents (« mardi » / « jeudi »), pas les écarts d'orthographe (« revite » / « Revit »).
 */
export function wordDistance(a, b, { soft = true } = {}) {
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (soft === 'meaning' ? (subCost(a[i - 1], b[j - 1]) < 1 ? 0 : 1) : soft ? subCost(a[i - 1], b[j - 1]) : a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Ressemblance de deux textes (1 = identiques, 0 = rien en commun).
 * `soft` (par défaut) : les mots qui ne diffèrent que d'une lettre ou deux comptent presque comme identiques.
 */
export function similarity(a, b, { soft = true } = {}) {
  const x = normWords(a), y = normWords(b);
  if (!x.length && !y.length) return 1;
  return 1 - wordDistance(x, y, { soft }) / Math.max(x.length, y.length);
}

/** Confiance moyenne d'un passage, pondérée par la durée (null si inconnue). */
export function blockConf(segs) {
  let w = 0, sum = 0;
  for (const s of segs) {
    if (s.conf == null) continue;
    const d = Math.max(0.3, (s.end ?? s.start) - s.start);
    w += d;
    sum += s.conf * d;
  }
  return w ? sum / w : null;
}

const usable = (s) => !s.tentative && !s.edited;

/**
 * Passages à réécouter.
 * - « quick » : les phrases douteuses (confiance basse), élargies aux voisines jusqu'à ~4 s ;
 * - « full » : toute la transcription, par passages d'au plus ~25 s.
 * Les phrases corrigées à la main ne sont jamais touchées.
 * @returns {{from: number, to: number, start: number, end: number}[]} indices inclus
 */
export function planBlocks(segs, { mode = 'quick', doubtful = VERIFY.doubtful, minS = VERIFY.minS, maxS = VERIFY.maxS } = {}) {
  const blocks = [];
  const dur = (a, b) => (segs[b].end ?? segs[b].start) - segs[a].start;
  if (mode === 'full') {
    let from = -1;
    for (let i = 0; i < segs.length; i++) {
      if (!usable(segs[i])) { if (from >= 0) blocks.push([from, i - 1]); from = -1; continue; }
      if (from < 0) { from = i; continue; }
      if (dur(from, i) > maxS || segs[i].start - (segs[i - 1].end ?? segs[i - 1].start) > 3) { blocks.push([from, i - 1]); from = i; }
    }
    if (from >= 0) blocks.push([from, segs.length - 1]);
  } else {
    const bad = segs.map((s) => usable(s) && s.conf != null && s.conf < doubtful);
    for (let i = 0; i < segs.length; i++) {
      if (!bad[i]) continue;
      let from = i, to = i;
      // Phrases douteuses qui se suivent : un seul passage
      while (to + 1 < segs.length && bad[to + 1] && dur(from, to + 1) <= maxS) to++;
      // Trop court : on ajoute des voisines (sans dépasser maxS ni toucher une phrase corrigée)
      let grow = true;
      while (dur(from, to) < minS && grow) {
        grow = false;
        if (to + 1 < segs.length && usable(segs[to + 1]) && dur(from, to + 1) <= maxS) { to++; grow = true; }
        if (dur(from, to) < minS && from > 0 && usable(segs[from - 1]) && dur(from - 1, to) <= maxS && (!blocks.length || blocks.at(-1)[1] < from - 1)) { from--; grow = true; }
      }
      blocks.push([from, to]);
      i = to;
    }
  }
  return blocks.map(([from, to]) => ({ from, to, start: segs[from].start, end: segs[to].end ?? segs[to].start }));
}

/**
 * Verdict sur un passage.
 * @param {object[]} orig phrases d'origine
 * @param {object[]} cand phrases de la nouvelle écoute
 * @returns {{verdict: 'ok'|'fixed'|'doubt', sim: number, before: number|null, after: number|null}}
 */
export function compareBlock(orig, cand, { agree = VERIFY.agree, margin = VERIFY.margin, doubtful = VERIFY.doubtful, focus = false } = {}) {
  const a = orig.map((s) => s.text).join(' ');
  const b = cand.map((s) => s.text).join(' ');
  const sim = similarity(a, b);
  // focus : la confiance « avant » est celle des phrases douteuses, pas des voisines ajoutées pour le contexte
  const unsure = orig.filter((s) => s.conf != null && s.conf < doubtful);
  const before = (focus && unsure.length ? blockConf(unsure) : null) ?? blockConf(orig), after = blockConf(cand);
  const surer = after != null && after >= Math.max((before ?? 0.5) + margin, doubtful);
  // Mêmes mots : rien à changer
  if (similarity(a, b, { soft: false }) >= 0.999) return { verdict: 'ok', sim, before, after };
  // Seulement des écarts d'orthographe (« revite » / « Revit », « valider » / « validé ») : on prend la version la plus sûre.
  // Un seul mot vraiment différent (« mardi » / « jeudi ») n'est jamais considéré comme un accord.
  const x = normWords(a), y = normWords(b);
  if (x.length && y.length && wordDistance(x, y, { soft: 'meaning' }) === 0) return { verdict: surer ? 'fixed' : 'ok', sim, before, after };
  void agree;
  // La nouvelle écoute n'entend rien : on garde, mais c'est à vérifier
  if (!normWords(b).length) return { verdict: 'doubt', sim, before, after };
  return { verdict: surer ? 'fixed' : 'doubt', sim, before, after };
}

/** Intervenant de chaque nouvelle phrase : celui de la phrase d'origine qui la recouvre le plus. */
export function carrySpeakers(cand, orig) {
  return cand.map((c) => {
    let best = null, over = 0;
    for (const o of orig) {
      const ov = Math.min(c.end ?? c.start, o.end ?? o.start) - Math.max(c.start, o.start);
      if (ov > over) { over = ov; best = o; }
    }
    best ??= orig.reduce((p, o) => (Math.abs(o.start - c.start) < Math.abs(p.start - c.start) ? o : p), orig[0]);
    return best?.spk != null ? { ...c, spk: best.spk } : { ...c };
  });
}
