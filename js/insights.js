// Tableau de bord : chiffres, sujets et recherche dans les réunions.
// Fonctions pures (sans navigateur), testables seules. Tout est calculé sur l'appareil.

const DAY = 86400000;

/** Début de la semaine (lundi 0 h) contenant `t`. */
export function weekStart(t) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

/** Début de période : 'week' (7 derniers jours), 'month' (30 jours) ou 'all'. */
export function periodStart(range, now = Date.now()) {
  if (range === 'week') return now - 7 * DAY;
  if (range === 'month') return now - 30 * DAY;
  return 0;
}

const durOf = (d) => d.durationS || d.segments?.[d.segments.length - 1]?.end || 0;
const confOf = (d) => {
  const c = (d.segments || []).filter((s) => s.conf != null);
  return c.length ? c.reduce((a, s) => a + s.conf, 0) / c.length : null;
};

/**
 * Chiffres clés : sur toute la période, et « cette semaine » vs « semaine d'avant » (7 jours glissants).
 * @param {object[]} docs
 */
export function dashStats(docs, now = Date.now()) {
  const inRange = (d, a, b) => d.createdAt >= a && d.createdAt < b;
  const w0 = now - 7 * DAY, w1 = now - 14 * DAY;
  const cur = docs.filter((d) => inRange(d, w0, now + 1));
  const prev = docs.filter((d) => inRange(d, w1, w0));
  const avg = (list) => {
    const v = list.map(confOf).filter((x) => x != null);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  return {
    count: docs.length,
    countWeek: cur.length,
    seconds: docs.reduce((a, d) => a + durOf(d), 0),
    secondsWeek: cur.reduce((a, d) => a + durOf(d), 0),
    secondsPrev: prev.reduce((a, d) => a + durOf(d), 0),
    conf: avg(docs),
    confWeek: avg(cur),
    confPrev: avg(prev),
  };
}

/** Minutes d'audio par jour, sur les `days` derniers jours (le plus ancien en premier). */
export function dailyMinutes(docs, days = 7, now = Date.now()) {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const start = today.getTime() - (days - 1) * DAY;
  const out = Array.from({ length: days }, (_, i) => ({ day: start + i * DAY, minutes: 0 }));
  for (const d of docs) {
    const i = Math.floor((d.createdAt - start) / DAY);
    if (i >= 0 && i < days) out[i].minutes += durOf(d) / 60;
  }
  return out;
}

/** Minutes d'audio par semaine, sur les `weeks` dernières semaines. */
export function weeklyMinutes(docs, weeks = 8, now = Date.now()) {
  const w = weekStart(now);
  const out = Array.from({ length: weeks }, (_, i) => ({ week: w - (weeks - 1 - i) * 7 * DAY, minutes: 0, count: 0 }));
  for (const d of docs) {
    const i = Math.round((weekStart(d.createdAt) - out[0].week) / (7 * DAY));
    if (i >= 0 && i < weeks) { out[i].minutes += durOf(d) / 60; out[i].count++; }
  }
  return out;
}

/**
 * Temps de parole cumulé par personne nommée. Les « Personne N » (non identifiées) sont regroupées.
 * @returns {{name: string, seconds: number, unknown?: boolean}[]} trié du plus au moins bavard
 */
export function speakerTotals(docs) {
  const m = new Map();
  let unknown = 0;
  for (const d of docs) {
    const sp = d.speakers || [];
    if (!sp.length) continue;
    for (const s of d.segments || []) {
      if (s.spk == null || !sp[s.spk]) continue;
      const t = Math.max(0, s.end - s.start);
      const name = sp[s.spk].name;
      if (!name || /^Personne \d+$/.test(name)) { unknown += t; continue; }
      const k = name.trim().toLowerCase();
      const cur = m.get(k) || { name: name.trim(), seconds: 0 };
      cur.seconds += t;
      m.set(k, cur);
    }
  }
  const out = [...m.values()].sort((a, b) => b.seconds - a.seconds);
  if (unknown > 0) out.push({ name: 'Non identifiés', seconds: unknown, unknown: true });
  return out;
}

// Sujets : mots-clés du bâtiment et de la gestion de projet (repérage simple, sans IA)
export const TOPICS = [
  { key: 'bim', label: 'BIM', words: ['bim', 'maquette', 'maquettes', 'ifc', 'revit', 'navisworks', 'autocad', 'lod', 'loin', 'acc', 'synthèse', 'clash', 'clashs', 'conflit', 'conflits', 'coordination', 'convention', 'charte', 'modélisation', 'modèle', 'nomenclature', 'famille', 'familles', 'gabarit', 'jumeau', 'scan', 'nuage', 'bcf', 'dwg', 'plugin', 'dynamo'] },
  { key: 'tech', label: 'Technique', words: ['réseau', 'réseaux', 'gaine', 'gaines', 'structure', 'béton', 'voile', 'voiles', 'dalle', 'dalles', 'poutre', 'poutres', 'poteau', 'poteaux', 'cvc', 'plomberie', 'électricité', 'électrique', 'fluide', 'fluides', 'réservation', 'réservations', 'façade', 'plancher', 'isolation', 'ventilation', 'chauffage', 'climatisation', 'faux', 'plafond', 'cloison', 'cloisons', 'menuiserie', 'charpente', 'toiture', 'fondation', 'fondations', 'acoustique', 'thermique', 'diamètre', 'diamètres', 'sprinkler', 'désenfumage'] },
  { key: 'orga', label: 'Organisation', words: ['planning', 'délai', 'délais', 'échéance', 'équipe', 'client', 'maître', 'ouvrage', 'moa', 'moe', 'budget', 'coût', 'coûts', 'devis', 'chiffrage', 'livrable', 'livrables', 'validation', 'réunion', 'compte', 'rendu', 'lot', 'lots', 'contrat', 'marché', 'facture', 'phase', 'jalon', 'priorité', 'ressources', 'avenant'] },
  { key: 'site', label: 'Chantier', words: ['chantier', 'sécurité', 'livraison', 'grue', 'levage', 'terrassement', 'gros', 'œuvre', 'coulage', 'coffrage', 'ferraillage', 'compagnons', 'sous-traitant', 'réception', 'réserves', 'visite', 'opr', 'installation', 'base', 'vie', 'échafaudage', 'intempéries'] },
];
const WORD_TOPIC = new Map(TOPICS.flatMap((t) => t.words.map((w) => [w, t.key])));

/** Part de chaque sujet (par nombre de mots-clés entendus). */
export function topicShares(docs) {
  const n = new Map(TOPICS.map((t) => [t.key, 0]));
  for (const d of docs) {
    for (const s of d.segments || []) {
      for (const w of String(s.text || '').toLowerCase().match(/[a-zà-ÿœæ-]+/g) || []) {
        const k = WORD_TOPIC.get(w);
        if (k) n.set(k, n.get(k) + 1);
      }
    }
  }
  const total = [...n.values()].reduce((a, b) => a + b, 0);
  if (!total) return [];
  return TOPICS.map((t) => ({ key: t.key, label: t.label, hits: n.get(t.key), share: n.get(t.key) / total }))
    .filter((t) => t.hits > 0)
    .sort((a, b) => b.share - a.share);
}

// Recherche dans les réunions (assistant local)
const fold = (s) => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const STOP = new Set(fold('le la les un une des de du d l à au aux et ou en dans sur pour par avec sans ce cet cette ces qui que quoi quel quelle quels quelles est sont été a ont on il elle ils elles nous vous je tu me te se mon ma mes ton ta tes son sa ses leur leurs y ne pas plus moins tout tous toute toutes être avoir fait faire quand comment pourquoi combien où concernant propos sujet dit dire prises prise prendre réunion réunions projet projets décision décisions décidé décidée décidés décidées validé validée validés validées action actions tâche tâches responsable responsables échéance échéances cours reste semaine mois aujourd hui hier dernier dernière derniers dernières récent récente récentes récents liste donne montre rappelle est-ce qu questionne questionner questionnes interroge interroger teste tester quiz question questions pose poser dossier dossiers resume resumer résume résumer synthese synthèse redige rediger rédige rédiger ecris écris ecrire écrire mail moi peux peut veux voudrais aimerais stp svp merci sur ça cela ceci').split(' '));

/** Mots utiles d'une question (sans les mots vides). */
export function keywords(q) {
  return [...new Set((String(q).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').match(/[a-z0-9œæ-]{2,}/g) || [])
    .map((w) => w.replace(/-(?:moi|toi|nous|vous|le|la|les|lui|leur|en|y|t-il|t-elle|t-on|il|elle|on)$/, ''))
    .filter((w) => !STOP.has(w) && w.length > 2))];
}


/** Ce que la question cherche : décisions, actions, ou passages. */
export function intentOf(q) {
  const f = fold(q);
  if (/decid|decision|valide|acte|tranche|choisi/.test(f)) return 'decision';
  if (/action|a faire|qui doit|qui fait|tache|todo|responsable|echeance|en cours|reste a/.test(f)) return 'action';
  return 'any';
}

/**
 * Cherche dans les réunions.
 * @param {string} question
 * @param {{doc: object, items: {type: string, text: string, i: number, start: number, who?: string}[]}[]} sources
 *   items : décisions et actions déjà repérées dans chaque réunion
 * @returns {{intent: string, words: string[], hits: {doc: object, type: string, text: string, i: number, start: number, who?: string, score: number}[]}}
 */
export function searchMeetings(question, sources, { limit = 6, now = Date.now() } = {}) {
  const words = keywords(question);
  const intent = intentOf(question);
  // Période citée dans la question
  const fq = fold(question);
  const since = /aujourd/.test(fq) ? new Date(new Date(now).setHours(0, 0, 0, 0)).getTime()
    : /\bhier\b/.test(fq) ? new Date(new Date(now).setHours(0, 0, 0, 0)).getTime() - DAY
    : /semaine/.test(fq) ? now - 7 * DAY
    : /\bmois\b/.test(fq) ? now - 30 * DAY
    : 0;
  sources = sources.filter(({ doc }) => (doc.createdAt || 0) >= since);
  const hits = [];
  const scoreText = (txt, title = '') => {
    const t = fold(txt), ti = fold(title);
    let sc = 0;
    for (const w of words) {
      const stem = w.length > 5 ? w.slice(0, w.length - 2) : w; // « décisions » ~ « décision »
      if (t.includes(stem)) sc += 2;
      if (ti.includes(stem)) sc += 1.5;
    }
    return sc;
  };
  for (const { doc, items } of sources) {
    const pool = intent === 'any' ? items : items.filter((x) => x.type === intent);
    for (const x of pool) {
      const sc = words.length ? scoreText(x.text, doc.title) : 1;
      if (sc > 0) hits.push({ doc, ...x, score: sc + 1 });
    }
    if (intent === 'any' && words.length) {
      (doc.segments || []).forEach((s, i) => {
        const sc = scoreText(s.text, doc.title);
        if (sc >= 2) hits.push({ doc, type: 'passage', text: s.text, i, start: s.start, score: sc });
      });
    }
  }
  // Les plus pertinents d'abord, puis les plus récents
  hits.sort((a, b) => b.score - a.score || b.doc.createdAt - a.doc.createdAt);
  const seen = new Set();
  const out = [];
  for (const h of hits) {
    const k = `${h.doc.id}:${h.i}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(h);
    if (out.length >= limit) break;
  }
  return { intent, words, hits: out };
}
