// Assistant : prépare les extraits des réunions donnés au modèle de langage (RAG), la consigne,
// et met en forme la réponse. Fonctions pures, testables seules.

import { searchMeetings, keywords } from './insights.js';

export const SYSTEM_PROMPT = `Tu es l'assistant de l'application « Transcripteur IA ». Tu réponds aux questions de l'utilisateur sur SES réunions, uniquement à partir des extraits fournis (des transcriptions automatiques, qui peuvent contenir des erreurs de reconnaissance).
Règles :
- Réponds en français, de façon brève et précise : 2 à 6 phrases, ou une courte liste à puces.
- Réponds avec le CONTENU des extraits (ce qui a été dit, décidé ou demandé), reformulé simplement. Ne recopie pas les titres, dates ou heures des extraits, sauf si la question les demande.
- Après chaque information, cite sa source avec son numéro entre crochets, par exemple [R2].
- Si la réponse n'est pas dans les extraits, dis-le simplement. N'invente jamais un nom, une date, un chiffre ou une décision.
- Une « décision » est ce qui a été validé ou choisi ; une « action » est une tâche à faire, avec si possible qui et pour quand.
- Pas de formule de politesse ni de conclusion : uniquement la réponse.`;

const fmtTime = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const fmtDate = (t) => new Date(t).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
const fold = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/**
 * Choisit les extraits utiles pour la question.
 * @param {string} q question
 * @param {{doc: object, items: object[]}[]} sources réunions avec leurs décisions / actions repérées
 * @param {{budget?: number, now?: number}} o budget : taille maximale des extraits (caractères)
 * @returns {{refs: object[], context: string, intent: string}}
 */
export function buildContext(q, sources, { budget = 4000, now = Date.now(), fill = false } = {}) {
  const fq = fold(q);
  const docs = sources.map((s) => s.doc).sort((a, b) => b.createdAt - a.createdAt);
  const { intent, hits } = searchMeetings(q, sources, { limit: 14, now });
  const refs = [];
  const seen = new Set();
  let used = 0;
  const speakerOf = (doc, i) => {
    const s = doc.segments?.[i];
    const p = s?.spk != null ? doc.speakers?.[s.spk]?.name : null;
    return p && !/^Personne \d+$/.test(p) ? p : null;
  };
  const add = (r) => {
    const k = `${r.doc.id}:${r.i}:${r.type}`;
    if (seen.has(k)) return false;
    const len = r.text.length + 80;
    if (used + len > budget) return false;
    seen.add(k);
    used += len;
    refs.push({ ...r, n: refs.length + 1 });
    return true;
  };
  /** Texte d'une réunion en morceaux d'environ 700 caractères (avec qui parle). */
  const addChunks = (d) => {
    let chunk = '';
    let start = 0;
    let first = 0;
    for (const [i, s] of (d.segments || []).entries()) {
      if (chunk.length > 700) { if (!add({ doc: d, type: 'extrait', i: first, start, text: chunk.trim(), who: null })) return; chunk = ''; }
      if (!chunk) { start = s.start; first = i; }
      const who = speakerOf(d, i);
      chunk += `${who ? `${who} : ` : ''}${s.text} `;
    }
    if (chunk) add({ doc: d, type: 'extrait', i: first, start, text: chunk.trim(), who: null });
  };
  // 1. « Ma dernière réunion », « résume… » : le début de la réunion la plus récente (ou celle nommée)
  const wantsSummary = /(derniere|precedente) reunion|resume|de quoi (on a|a-t-on|avons-nous) parle|sujet de la reunion/.test(fq);
  if (wantsSummary && docs.length) {
    const words = keywords(q);
    const named = docs.find((d) => words.some((w) => fold(d.title).includes(w)));
    const d = named || docs[0];
    let chunk = '';
    let start = 0;
    let first = 0;
    (d.segments || []).forEach((s, i) => {
      if (chunk.length > 700) { add({ doc: d, type: 'extrait', i: first, start, text: chunk.trim(), who: null }); chunk = ''; }
      if (!chunk) { start = s.start; first = i; }
      const who = speakerOf(d, i);
      chunk += `${who ? `${who} : ` : ''}${s.text} `;
    });
    if (chunk) add({ doc: d, type: 'extrait', i: first, start, text: chunk.trim(), who: null });
  }
  // 2. Résultats de la recherche (décisions, actions, passages) avec un peu de contexte autour des passages
  for (const h of hits) {
    let text = h.text;
    if (h.type === 'passage') {
      const segs = h.doc.segments || [];
      text = [h.i - 1, h.i, h.i + 1].filter((k) => segs[k]).map((k) => {
        const who = speakerOf(h.doc, k);
        return `${who ? `${who} : ` : ''}${segs[k].text}`;
      }).join(' ');
    }
    add({ doc: h.doc, type: h.type, i: h.i, start: h.start, text, who: h.who || speakerOf(h.doc, h.i) });
  }
  // 3. Rien de précis : décisions et actions récentes
  if (!refs.length) {
    for (const s of sources.slice().sort((a, b) => b.doc.createdAt - a.doc.createdAt).slice(0, 6)) {
      for (const x of s.items) {
        if (intent !== 'any' && x.type !== intent) continue;
        add({ doc: s.doc, type: x.type, i: x.i, start: x.start, text: x.text, who: x.who });
      }
    }
  }
  // 4. Périmètre choisi (une réunion, un petit dossier) : on complète avec leur texte, dans la limite du budget
  if (fill) for (const d of docs) addChunks(d);
  refs.sort((a, b) => (a.doc.id === b.doc.id ? a.start - b.start : 0));
  refs.forEach((r, k) => (r.n = k + 1));
  // Contenu d'abord, contexte ensuite (les petits modèles recopient sinon les en-têtes)
  const label = { decision: 'décision', action: 'action à faire', passage: 'passage', extrait: 'extrait' };
  const lines = refs.map((r) => `[R${r.n}] ${r.text} (${label[r.type] || 'passage'}${r.who ? `, ${r.type === 'action' ? 'responsable' : 'dit par'} ${r.who}` : ''}${r.done ? ', faite' : ''} ; réunion « ${r.doc.title} », ${fmtDate(r.doc.createdAt)})`);
  const list = docs.slice(0, 8).map((d) => `- « ${d.title} », ${fmtDate(d.createdAt)}${d.durationS ? `, ${Math.max(1, Math.round(d.durationS / 60))} min` : ''}${d.speakers?.length > 1 ? `, ${d.speakers.length} intervenants` : ''}`);
  const context = `Aujourd'hui : ${fmtDate(now)}.\nRéunions récentes de l'utilisateur :\n${list.join('\n') || '(aucune)'}\n\nExtraits :\n${lines.join('\n\n') || '(aucun extrait ne correspond à la question)'}`;
  return { refs, context, intent };
}

/** Messages pour le modèle (avec, éventuellement, l'échange précédent pour les questions de suivi). */
export function buildMessages(q, context, previous = null) {
  const msgs = [{ role: 'system', content: SYSTEM_PROMPT }];
  if (previous?.q && previous?.a) {
    msgs.push({ role: 'user', content: previous.q });
    msgs.push({ role: 'assistant', content: previous.a.slice(0, 600) });
  }
  msgs.push({ role: 'user', content: `${context}\n\nQuestion : ${q}` });
  return msgs;
}

const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Mise en forme légère de la réponse (gras, listes, sources [R1] cliquables). */
export function renderAnswer(text, refs) {
  const byN = new Map(refs.map((r) => [r.n, r]));
  const inline = (s) => esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/(?:\s*\[(?:Sources?\s*:?\s*)?R\d+(?:\s*[,;]\s*R?\d+)*\])+/gi, (m) => ' ' + [...m.matchAll(/R?(\d+)/gi)].map(([, n]) => {
      const r = byN.get(Number(n));
      return r ? `<button type="button" class="src" data-open="${esc(r.doc.id)}" data-i="${r.i}" title="${esc(r.doc.title)} · ${fmtTime(r.start)}">${n}</button>` : '';
    }).join(''));
  const out = [];
  let list = null;
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    const li = line.match(/^(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (li) { (list ??= []).push(`<li>${inline(li[1])}</li>`); continue; }
    if (list) { out.push(`<ul>${list.join('')}</ul>`); list = null; }
    if (line) out.push(`<p>${inline(line.replace(/^#+\s*/, ''))}</p>`);
  }
  if (list) out.push(`<ul>${list.join('')}</ul>`);
  return out.join('');
}

/** Sources citées dans la réponse (sinon, les premières données au modèle). */
export function citedRefs(text, refs, max = 4) {
  const cited = [...new Set([...String(text).matchAll(/\[(?:Sources?\s*:?\s*)?(R\d+(?:\s*[,;]\s*R?\d+)*)\]/gi)].flatMap((m) => [...m[1].matchAll(/(\d+)/g)].map((x) => Number(x[1]))))];
  const list = cited.length ? cited.map((n) => refs.find((r) => r.n === n)).filter(Boolean) : refs.slice(0, 2);
  return list.slice(0, max);
}
