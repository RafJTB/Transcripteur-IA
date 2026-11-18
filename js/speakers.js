// « Qui parle ? » : regroupement des voix et attribution des phrases.
// Fonctions pures (sans navigateur), testables seules.
//
// Étapes :
//   1. le worker découpe l'audio en fenêtres de 10 s et repère les voix de chaque fenêtre
//      (pyannote), puis calcule l'empreinte de chaque voix (WeSpeaker) : un « extrait » ;
//   2. clusterSpeakers() regroupe les extraits qui ont la même voix ;
//   3. buildTimeline() en déduit qui parle à chaque instant ;
//   4. assignSpeakers() attribue chaque phrase à une personne (et coupe une phrase
//      partagée par deux personnes quand la ponctuation le permet).

/** Couleurs des intervenants (lisibles en clair et en sombre). */
export const SPEAKER_COLORS = ['#5b5bf0', '#22b07d', '#e0912f', '#d9577a', '#8b6cf0', '#1fa5b8', '#b0894f', '#7d9a2b'];
export const speakerColor = (i) => SPEAKER_COLORS[i % SPEAKER_COLORS.length];
export const defaultSpeakerName = (i) => `Personne ${i + 1}`;

/** Similarité minimale pour fusionner deux groupes (cosinus, empreintes WeSpeaker). */
export const MERGE_THRESHOLD = 0.5;

function normalize(v) {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/**
 * Regroupement hiérarchique (lien moyen) des empreintes vocales.
 * @param {{emb: ArrayLike<number>, dur: number}[]} items extraits (empreinte + durée de parole)
 * @param {{k?: number|null, threshold?: number, minShare?: number}} o
 *   k : nombre de personnes imposé (sinon automatique, selon `threshold`)
 *   minShare : un groupe qui parle moins que cette part du temps est rattaché au plus proche
 * @returns {number[]} numéro de groupe de chaque extrait (0..K-1)
 */
export function clusterSpeakers(items, { k = null, threshold = MERGE_THRESHOLD, minShare = 0.03 } = {}) {
  const n = items.length;
  if (!n) return [];
  if (n === 1) return [0];
  const embs = items.map((it) => normalize(it.emb));
  // Matrice des similarités (moyenne des paires entre groupes, mise à jour par Lance-Williams)
  const S = new Float32Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const s = dot(embs[i], embs[j]);
      S[i * n + j] = s;
      S[j * n + i] = s;
    }
  }
  const size = new Array(n).fill(1);
  const alive = new Array(n).fill(true);
  const parent = Array.from({ length: n }, (_, i) => i);
  const best = new Int32Array(n);
  const rowBest = (i) => {
    let b = -1;
    let bv = -Infinity;
    for (let j = 0; j < n; j++) {
      if (j === i || !alive[j]) continue;
      const v = S[i * n + j];
      if (v > bv) { bv = v; b = j; }
    }
    best[i] = b;
  };
  for (let i = 0; i < n; i++) rowBest(i);

  let groups = n;
  const target = k ? Math.max(1, Math.min(k, n)) : 1;
  while (groups > target) {
    let a = -1;
    let av = -Infinity;
    for (let i = 0; i < n; i++) {
      if (!alive[i] || best[i] < 0) continue;
      const v = S[i * n + best[i]];
      if (v > av) { av = v; a = i; }
    }
    if (a < 0) break;
    if (!k && av < threshold) break;
    const b = best[a];
    // Fusion de b dans a
    for (let j = 0; j < n; j++) {
      if (!alive[j] || j === a || j === b) continue;
      const v = (size[a] * S[a * n + j] + size[b] * S[b * n + j]) / (size[a] + size[b]);
      S[a * n + j] = v;
      S[j * n + a] = v;
    }
    size[a] += size[b];
    alive[b] = false;
    for (let i = 0; i < n; i++) if (parent[i] === b) parent[i] = a;
    groups--;
    rowBest(a);
    for (let i = 0; i < n; i++) if (alive[i] && (best[i] === a || best[i] === b)) rowBest(i);
    // La nouvelle ligne a peut être devenue la meilleure pour d'autres
    for (let i = 0; i < n; i++) if (alive[i] && i !== a && best[i] >= 0 && S[i * n + a] > S[i * n + best[i]]) best[i] = a;
  }

  // Groupes → numéros, puis rattachement des « petits » groupes (bruits, toux, fausses voix)
  let roots = [...new Set(parent)];
  const dur = new Map(roots.map((r) => [r, 0]));
  items.forEach((it, i) => dur.set(parent[i], dur.get(parent[i]) + (it.dur || 0)));
  const total = [...dur.values()].reduce((x, y) => x + y, 0) || 1;
  const centroid = (r) => {
    const c = new Float32Array(embs[0].length);
    items.forEach((_, i) => { if (parent[i] === r) for (let d = 0; d < c.length; d++) c[d] += embs[i][d] * (items[i].dur || 1); });
    return normalize(c);
  };
  if (!k) {
    const big = roots.filter((r) => dur.get(r) / total >= minShare && dur.get(r) >= 2);
    if (big.length && big.length < roots.length) {
      const cents = new Map(big.map((r) => [r, centroid(r)]));
      for (const r of roots) {
        if (cents.has(r)) continue;
        const c = centroid(r);
        let to = big[0];
        let tv = -Infinity;
        for (const b of big) { const v = dot(c, cents.get(b)); if (v > tv) { tv = v; to = b; } }
        for (let i = 0; i < n; i++) if (parent[i] === r) parent[i] = to;
      }
      roots = big;
    }
  }
  const num = new Map(roots.map((r, i) => [r, i]));
  return parent.map((p) => num.get(p));
}

/**
 * Qui parle à chaque instant.
 * @param {{regions: [number, number][]}[]} items extraits (plages en secondes)
 * @param {number[]} labels groupe de chaque extrait
 * @returns {{start: number, end: number, spk: number}[]} tours de parole triés et fusionnés
 */
export function buildTimeline(items, labels) {
  const turns = [];
  items.forEach((it, i) => { for (const [s, e] of it.regions) turns.push({ start: s, end: e, spk: labels[i] }); });
  turns.sort((a, b) => a.start - b.start);
  const out = [];
  for (const t of turns) {
    const last = out[out.length - 1];
    if (last && last.spk === t.spk && t.start - last.end < 0.6) last.end = Math.max(last.end, t.end);
    else out.push({ ...t });
  }
  return out;
}

/** Temps de parole de chaque personne dans [a, b]. */
function overlapBySpeaker(timeline, a, b) {
  const m = new Map();
  for (const t of timeline) {
    if (t.end <= a) continue;
    if (t.start >= b) break;
    const o = Math.min(b, t.end) - Math.max(a, t.start);
    if (o > 0) m.set(t.spk, (m.get(t.spk) || 0) + o);
  }
  return m;
}

/** Fin de phrase la plus proche de `pos` (index juste après la ponctuation), ou -1. */
function nearestBreak(text, pos, tol) {
  let best = -1;
  let bd = Infinity;
  const re = /[.?!…]+["»”)]?\s+/g;
  let m;
  while ((m = re.exec(text))) {
    const at = m.index + m[0].length;
    if (at <= 0 || at >= text.length) continue;
    const d = Math.abs(at - pos);
    if (d < bd) { bd = d; best = at; }
  }
  return bd <= tol ? best : -1;
}

/** Changements de personne à l'intérieur de [a, b] (tours trop courts ignorés). */
function runsWithin(timeline, a, b, minRun = 0.8) {
  const runs = [];
  for (const t of timeline) {
    if (t.end <= a) continue;
    if (t.start >= b) break;
    const s = Math.max(a, t.start);
    const e = Math.min(b, t.end);
    if (e - s < minRun) continue;
    const last = runs[runs.length - 1];
    if (last && last.spk === t.spk) last.end = e;
    else runs.push({ spk: t.spk, start: s, end: e });
  }
  return runs;
}

/**
 * Attribue une personne (`spk`) à chaque phrase.
 * Une phrase partagée par deux personnes est coupée à la fin de phrase la plus proche du
 * changement de voix (pas d'horodatage par mot : coupe proportionnelle au temps).
 * Les champs propres à une phrase (traduction…) sont gardés sur le premier morceau seulement.
 */
export function assignSpeakers(segments, timeline) {
  const out = [];
  let prev = null;
  for (const seg of segments) {
    const a = seg.start;
    const b = Math.max(seg.end, seg.start + 0.2);
    const runs = runsWithin(timeline, a, b);
    let pieces = [{ ...seg }];
    if (runs.length > 1 && seg.tr == null) {
      pieces = [];
      let text = seg.text;
      let from = a;
      let used = 0;
      for (let r = 0; r < runs.length - 1; r++) {
        const cut = runs[r].end;
        const rest = text;
        const pos = Math.round(((cut - from) / (b - from)) * rest.length);
        const at = nearestBreak(rest, pos, Math.max(12, rest.length * 0.25));
        if (at < 0) continue;
        pieces.push({ ...seg, start: from, end: cut, text: rest.slice(0, at).trim(), spk: runs[r].spk });
        text = rest.slice(at);
        from = cut;
        used++;
      }
      if (!used) pieces = [{ ...seg }];
      else pieces.push({ ...seg, start: from, end: seg.end, text: text.trim(), spk: runs[runs.length - 1].spk });
    }
    for (const p of pieces) {
      if (p.spk == null) {
        const m = overlapBySpeaker(timeline, p.start, Math.max(p.end, p.start + 0.2));
        let who = null;
        let wv = 0;
        for (const [s, v] of m) if (v > wv) { wv = v; who = s; }
        // Phrase sans voix détectée : même personne que la phrase précédente, sinon la plus proche
        if (who == null) who = prev ?? nearestTurn(timeline, p.start)?.spk ?? 0;
        p.spk = who;
      }
      prev = p.spk;
      out.push(p);
    }
  }
  return out;
}

function nearestTurn(timeline, t) {
  let best = null;
  let bd = Infinity;
  for (const x of timeline) {
    const d = t < x.start ? x.start - t : t > x.end ? t - x.end : 0;
    if (d < bd) { bd = d; best = x; }
  }
  return best;
}

/**
 * Renumérote les personnes par ordre d'apparition (Personne 1 = la première qui parle)
 * et calcule leur temps de parole.
 * @returns {{segments: object[], speakers: {name: string, seconds: number}[]}}
 */
export function orderSpeakers(segments, names = []) {
  const map = new Map();
  for (const s of segments) if (s.spk != null && !map.has(s.spk)) map.set(s.spk, map.size);
  const speakers = [...map.keys()].map((_, i) => ({ name: names[i] || defaultSpeakerName(i), seconds: 0 }));
  const segs = segments.map((s) => {
    if (s.spk == null) return s;
    const n = map.get(s.spk);
    speakers[n].seconds += Math.max(0, s.end - s.start);
    return { ...s, spk: n };
  });
  return { segments: segs, speakers };
}

/** Recalcule le temps de parole (après une correction manuelle). */
export function speakingTime(segments, count) {
  const t = new Array(count).fill(0);
  for (const s of segments) if (s.spk != null && s.spk < count) t[s.spk] += Math.max(0, s.end - s.start);
  return t;
}
