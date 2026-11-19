// Carnet de voix : reconnaître les intervenants d'une réunion à l'autre.
// Quand tu renommes « Personne 1 » en « Julie », l'empreinte moyenne de sa voix (WeSpeaker)
// est gardée dans ce navigateur. Aux réunions suivantes, chaque voix est comparée au carnet.

/** Similarité (cosinus) minimale pour reconnaître une voix connue. Prudent : mieux vaut « Personne 2 » qu'un mauvais nom. */
export const VOICE_MATCH = 0.6;
/** Écart minimal avec la 2e voix la plus proche (sinon : trop ambigu, pas de nom). */
export const VOICE_MARGIN = 0.05;
/** Poids maximal de l'historique : une voix continue d'évoluer (micro, pièce, état de forme). */
const MAX_WEIGHT = 10;
const KEY = 'transcripteur.voices';

export function normalize(v) {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  return Float32Array.from(v, (x) => x / n);
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return -1;
  let s = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { s += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return s / (Math.sqrt(na * nb) || 1);
}

/** Empreinte compacte à stocker (4 décimales suffisent). */
export const packEmb = (v) => Array.from(v, (x) => Math.round(x * 1e4) / 1e4);

/**
 * Empreinte moyenne de chaque groupe de voix (pondérée par le temps de parole).
 * @param {{emb: ArrayLike<number>, dur: number}[]} items
 * @param {number[]} labels groupe de chaque extrait
 * @returns {Map<number, Float32Array>}
 */
export function centroids(items, labels) {
  const acc = new Map();
  items.forEach((it, i) => {
    const l = labels[i];
    if (l == null || !it.emb?.length) return;
    const e = normalize(it.emb);
    let c = acc.get(l);
    if (!c) acc.set(l, (c = new Float32Array(e.length)));
    const w = it.dur || 1;
    for (let d = 0; d < c.length; d++) c[d] += e[d] * w;
  });
  for (const [l, c] of acc) acc.set(l, normalize(c));
  return acc;
}

/**
 * Associe chaque voix de la réunion à une voix du carnet (au plus une fois chacune).
 * @param {(ArrayLike<number>|null)[]} embs empreinte de chaque intervenant
 * @param {{name: string, emb: number[]}[]} book
 * @returns {{index: number, sim: number}[]} index dans le carnet (-1 si inconnue)
 */
export function matchVoices(embs, book, { threshold = VOICE_MATCH, margin = VOICE_MARGIN } = {}) {
  const res = embs.map(() => ({ index: -1, sim: 0 }));
  if (!book.length) return res;
  const sims = embs.map((e) => book.map((v) => (e ? cosine(e, v.emb) : -1)));
  // Voix trop proches de deux noms à la fois : on ne tranche pas
  const ok = sims.map((row) => {
    const s = [...row].sort((a, b) => b - a);
    return s.length < 2 || s[0] - s[1] >= margin;
  });
  const pairs = [];
  sims.forEach((row, i) => row.forEach((s, j) => { if (ok[i] && s >= threshold) pairs.push({ i, j, s }); }));
  pairs.sort((a, b) => b.s - a.s);
  const usedI = new Set(), usedJ = new Set();
  for (const p of pairs) {
    if (usedI.has(p.i) || usedJ.has(p.j)) continue;
    usedI.add(p.i);
    usedJ.add(p.j);
    res[p.i] = { index: p.j, sim: p.s };
  }
  return res;
}

/** Ajoute (ou affine) une voix dans le carnet. Renvoie le nouveau carnet. */
export function learnVoice(book, name, emb, now = Date.now()) {
  const key = name.trim().toLowerCase();
  const out = book.map((v) => ({ ...v }));
  const v = out.find((x) => x.name.trim().toLowerCase() === key);
  const e = normalize(emb);
  if (!v) {
    out.push({ name: name.trim(), emb: packEmb(e), n: 1, updatedAt: now });
    return out;
  }
  const w = Math.min(v.n || 1, MAX_WEIGHT);
  const old = normalize(v.emb);
  v.emb = packEmb(normalize(old.map((x, d) => x * w + e[d])));
  v.n = (v.n || 1) + 1;
  v.name = name.trim();
  v.updatedAt = now;
  return out;
}

/** Carnet stocké dans ce navigateur. */
export const VoiceBook = {
  load() {
    try {
      const v = JSON.parse(localStorage.getItem(KEY) || '[]');
      return Array.isArray(v) ? v.filter((x) => x?.name && Array.isArray(x.emb)) : [];
    } catch { return []; }
  },
  save(book) {
    try { localStorage.setItem(KEY, JSON.stringify(book)); } catch { /* stockage plein ou bloqué */ }
  },
  learn(name, emb) {
    const book = learnVoice(VoiceBook.load(), name, emb);
    VoiceBook.save(book);
    return book;
  },
  remove(name) {
    VoiceBook.save(VoiceBook.load().filter((v) => v.name !== name));
  },
  clear() {
    try { localStorage.removeItem(KEY); } catch { /* ignore */ }
  },
};
