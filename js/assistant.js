// Assistant : prépare les extraits des réunions donnés au modèle de langage (RAG), la consigne,
// et met en forme la réponse. Fonctions pures, testables seules.

import { searchMeetings, keywords } from './insights.js';

export const SYSTEM_PROMPT = `Tu es l'assistant de l'application « Transcripteur IA » : un collègue rigoureux et efficace qui connaît les réunions de l'utilisateur grâce aux extraits fournis. Ce sont des transcriptions automatiques : quelques mots peuvent être mal reconnus ; si le sens est évident, corrige-le sans le signaler.
Principes :
- Comprends d'abord ce que l'utilisateur veut vraiment (une réponse précise, une synthèse, un quiz, un texte à rédiger, un avis…) et fais exactement cela.
- Appuie-toi sur les extraits. Tu peux relier les informations, en tirer des conclusions, repérer des incohérences ou des risques : dans ce cas, distingue clairement ce qui a été dit de ce que tu en déduis.
- N'invente jamais un nom, une date, un chiffre ou une décision absents des extraits. S'il manque l'information, dis-le en une phrase et propose ce que tu peux faire à la place.
- Après chaque information tirée des extraits, cite sa source avec son numéro entre crochets, par exemple [R2].
- « Ce dossier », « ce projet », « cette réunion » désignent le périmètre indiqué en tête des extraits.
- Réponds en français, directement, sans introduction ni formule de politesse. Longueur adaptée : courte pour une question simple ; structurée (titres courts, listes à puces) pour une synthèse.`;

/** Consigne propre à chaque type de demande (ajoutée à la question). */
export const TASKS = {
  quiz: `Tâche : interroger l'utilisateur pour vérifier qu'il maîtrise le contenu de ces réunions (comme un examinateur bienveillant).
- Pose UNE seule question à la fois, précise et utile (une décision, un chiffre, un responsable, une échéance, un problème soulevé, une solution retenue), sans donner la réponse ni d'indice évident.
- Quand l'utilisateur répond : dis d'abord si c'est juste, partiellement juste ou faux, donne la bonne réponse en une ou deux phrases avec sa source, puis pose la question suivante sur un autre sujet.
- Varie les sujets et la difficulté. Indique le score après chaque correction (par exemple « Score : 2/3 »).
- Si l'utilisateur dit qu'il ne sait pas, donne la réponse et passe à la suivante.`,
  summary: `Tâche : faire une synthèse utile de ces réunions. Une phrase de contexte, puis sous des titres courts : points clés, décisions, actions (qui, pour quand), points en suspens ou risques. Garde l'essentiel, sans recopier les extraits.`,
  draft: `Tâche : rédiger le texte demandé (e-mail, compte rendu, message…), prêt à être envoyé, à partir des extraits. Ton professionnel et clair. Pas de numéros de sources dans le texte rédigé : mets-les sur une dernière ligne « Sources : [R1] [R3] ».`,
  list: `Tâche : lister les éléments demandés, un par ligne, avec qui et pour quand si c'est connu. S'il n'y en a pas, dis-le.`,
  qa: '',
};

const foldQ = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Type de demande : quiz, synthèse, rédaction, liste (décisions / actions) ou question. */
export function taskOf(q) {
  const f = foldQ(q);
  if (/questionn|interroge|teste[sz]?[- ]?moi|test de connaissance|quiz|pose[rsz]?[- ]?(moi )?(des|quelques|une|\d+) questions?|fais[- ]moi reviser|revis(er|ion)|entraine[sz]?[- ]?moi|verifie[sz]? (que|si) je/.test(f)) return 'quiz';
  if (/redige|rediger|ecri[st]|ecrire|prepare[sz]? (un|une|le|la) (mail|e-mail|courriel|message|compte|cr|note)|brouillon|(un|le) mail|e-mail|courriel/.test(f)) return 'draft';
  if (/resum|synthe|de quoi (on a|a-t-on|avons-nous|ca) parl|points? (cle|important|essentiel)|compte[- ]rendu|fais (le|un) point|bilan|ce qu.il faut retenir/.test(f)) return 'summary';
  if (/(quelles?|liste|toutes? les|les) (decisions?|actions?|taches?)|qui doit|reste a faire|a faire/.test(f)) return 'list';
  return 'qa';
}

/**
 * La question prolonge-t-elle la conversation en cours (même extraits) ?
 * Réponse à un quiz, « et pour le lot 3 ? », « développe », « pourquoi ? »…
 */
export function isFollowUp(q, prevTask, task = taskOf(q)) {
  const f = foldQ(q).trim();
  if (task !== 'qa') return false;
  if (prevTask === 'quiz') return !/^(stop|arrete|fin du quiz|on arrete|c.est bon)/.test(f) && f.split(/\s+/).length <= 40;
  if (/^(et|mais|alors|donc|pourquoi|comment ca|c.est.a.dire|explique|developpe|precise|detaille|continue|encore|ok|d.accord|oui|non|vas[- ]y|suivant|autre chose|plus de details|tu peux)/.test(f)) return true;
  return f.split(/\s+/).length <= 5;
}

const fmtTime = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const fmtDate = (t) => new Date(t).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
const fold = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/**
 * Choisit les extraits utiles pour la question.
 * - Question précise : recherche (décisions, actions, passages), complétée par le texte du périmètre.
 * - Synthèse, quiz, rédaction : un aperçu de TOUTE la réunion ou du dossier (morceaux répartis du début à la fin),
 *   pour ne pas se limiter aux premières minutes.
 * @param {string} q question
 * @param {{doc: object, items: object[]}[]} sources réunions avec leurs décisions / actions repérées
 * @param {{budget?: number, now?: number, task?: string, scoped?: boolean, scopeLabel?: string}} o
 *   budget : taille maximale des extraits (caractères) ; scoped : un dossier ou une réunion a été choisi
 * @returns {{refs: object[], context: string, intent: string, task: string, hits: number}}
 */
export function buildContext(q, sources, { budget = 4000, now = Date.now(), task = taskOf(q), scoped = false, scopeLabel = '', fill } = {}) {
  if (fill) scoped = true;
  const fq = fold(q);
  const docs = sources.map((s) => s.doc).sort((a, b) => b.createdAt - a.createdAt);
  const itemsOf = new Map(sources.map((s) => [s.doc.id, s.items || []]));
  const { intent, hits, words } = searchMeetings(q, sources, { limit: 14, now });
  const refs = [];
  const seen = new Set();
  let used = 0;
  const speakerOf = (doc, i) => {
    const s = doc.segments?.[i];
    const p = s?.spk != null ? doc.speakers?.[s.spk]?.name : null;
    return p && !/^Personne \d+$/.test(p) ? p : null;
  };
  const add = (r, cap = budget) => {
    const k = `${r.doc.id}:${r.i}:${r.type}`;
    if (seen.has(k)) return false;
    const len = r.text.length + 80;
    if (used + len > Math.min(budget, cap)) return false;
    seen.add(k);
    used += len;
    refs.push({ ...r, n: refs.length + 1 });
    return true;
  };
  /** Texte d'une réunion en morceaux d'environ 700 caractères (avec qui parle). */
  const chunksOf = (d) => {
    const out = [];
    let chunk = '';
    let start = 0;
    let first = 0;
    for (const [i, s] of (d.segments || []).entries()) {
      if (chunk.length > 700) { out.push({ doc: d, type: 'extrait', i: first, start, text: chunk.trim(), who: null }); chunk = ''; }
      if (!chunk) { start = s.start; first = i; }
      const who = speakerOf(d, i);
      chunk += `${who ? `${who} : ` : ''}${s.text} `;
    }
    if (chunk.trim()) out.push({ doc: d, type: 'extrait', i: first, start, text: chunk.trim(), who: null });
    return out;
  };
  /** Aperçu réparti de plusieurs réunions dans ce qui reste du budget (résumé écrit, décisions, puis texte). */
  const cover = (list, { items = false } = {}) => {
    if (!list.length) return;
    const room = budget - used;
    const per = Math.max(900, Math.floor(room / list.length));
    for (const d of list) {
      const cap = used + per;
      if (d.summary?.trim()) add({ doc: d, type: 'resume', i: 0, start: 0, text: d.summary.trim().slice(0, 1500), who: null }, cap);
      if (items) for (const x of (itemsOf.get(d.id) || []).slice(0, 6)) add({ doc: d, type: x.type, i: x.i, start: x.start, text: x.text, who: x.who, done: x.done }, cap);
      const ch = chunksOf(d);
      const n = Math.max(1, Math.floor((cap - used) / 790));
      const pick = n >= ch.length ? ch : Array.from({ length: n }, (_, k) => ch[Math.round((k * (ch.length - 1)) / Math.max(1, n - 1))]);
      for (const c of pick) add(c, cap);
    }
  };
  // Réunions visées : nommée dans la question, « la dernière », tout le périmètre choisi, ou celles où l'on trouve le sujet
  const named = docs.filter((d) => words.some((w) => w.length > 3 && fold(d.title).includes(w)));
  const hitDocs = [...new Set(hits.map((h) => h.doc))];
  const focus = named.length ? named
    : /(derniere|precedente) reunion|reunion d.hier|reunion de ce matin/.test(fq) ? docs.slice(0, 1)
    : scoped ? docs
    : task === 'qa' || task === 'list' ? []
    : hitDocs.length ? hitDocs.slice(0, 4) : docs.slice(0, 3);

  const addHits = () => {
    for (const h of hits) {
      let text = h.text;
      if (h.type === 'passage') {
        const segs = h.doc.segments || [];
        text = [h.i - 1, h.i, h.i + 1].filter((k) => segs[k]).map((k) => {
          const who = speakerOf(h.doc, k);
          return `${who ? `${who} : ` : ''}${segs[k].text}`;
        }).join(' ');
      }
      add({ doc: h.doc, type: h.type, i: h.i, start: h.start, text, who: h.who || speakerOf(h.doc, h.i), done: h.done });
    }
  };
  if (task === 'quiz' || task === 'summary' || task === 'draft') {
    // Vue d'ensemble d'abord, passages trouvés ensuite
    cover(focus, { items: true });
    addHits();
  } else {
    addHits();
    // Rien de précis : décisions et actions récentes
    if (!refs.length) {
      for (const s of sources.slice().sort((a, b) => b.doc.createdAt - a.doc.createdAt).slice(0, 6)) {
        for (const x of s.items) {
          if (intent !== 'any' && x.type !== intent) continue;
          add({ doc: s.doc, type: x.type, i: x.i, start: x.start, text: x.text, who: x.who, done: x.done });
        }
      }
    }
    cover(focus);
  }
  // Ordre de lecture : par réunion, puis dans le temps
  const rank = new Map(docs.map((d, k) => [d.id, k]));
  refs.sort((a, b) => (a.doc.id === b.doc.id ? (a.type === 'resume' ? -1 : b.type === 'resume' ? 1 : a.start - b.start) : rank.get(a.doc.id) - rank.get(b.doc.id)));
  refs.forEach((r, k) => (r.n = k + 1));
  // Contenu d'abord, contexte ensuite (les petits modèles recopient sinon les en-têtes)
  const label = { decision: 'décision', action: 'action à faire', passage: 'passage', extrait: 'extrait', resume: 'résumé écrit par l’utilisateur' };
  const at = (r) => (r.type === 'resume' ? '' : ` à ${fmtTime(r.start)}`);
  const lines = refs.map((r) => `[R${r.n}] ${r.text} (${label[r.type] || 'passage'}${r.who ? `, ${r.type === 'action' ? 'responsable' : 'dit par'} ${r.who}` : ''}${r.done ? ', faite' : ''} ; réunion « ${r.doc.title} » du ${fmtDate(r.doc.createdAt)}${at(r)})`);
  const list = docs.slice(0, scoped ? 20 : 8).map((d) => `- « ${d.title} », ${fmtDate(d.createdAt)}${d.durationS ? `, ${Math.max(1, Math.round(d.durationS / 60))} min` : ''}${d.speakers?.length > 1 ? `, ${d.speakers.length} intervenants` : ''}`);
  const head = scoped && scopeLabel ? `Périmètre choisi par l'utilisateur : « ${scopeLabel} » (${docs.length} réunion${docs.length > 1 ? 's' : ''}).` : 'Périmètre : toutes les réunions de l’utilisateur.';
  const context = `Aujourd'hui : ${fmtDate(now)}\n${head}\nRéunions${scoped ? '' : ' récentes'} :\n${list.join('\n') || '(aucune)'}\n\nExtraits :\n${lines.join('\n\n') || '(aucun extrait ne correspond à la question)'}`;
  return { refs, context, intent, task, hits: hits.length };
}

/** Retire les renvois [R1] d'une ancienne réponse (les numéros changent d'un contexte à l'autre). */
const stripRefs = (t) => String(t).replace(/\s*\[(?:Sources?\s*:?\s*)?R\d+(?:\s*[,;]\s*R?\d+)*\]/gi, '');

/**
 * Messages pour le modèle.
 * @param {string} q question
 * @param {string} context extraits (buildContext)
 * @param {{q: string, a: string}[]} history échanges précédents de la conversation (du plus ancien au plus récent)
 * @param {{task?: string, contextInSystem?: boolean, keepRefs?: boolean, maxTurns?: number, maxChars?: number}} o
 *   contextInSystem : extraits dans la consigne système (Claude : mis en cache d'une question à l'autre) ;
 *   keepRefs : les extraits n'ont pas changé, les anciens renvois [Rn] restent valables.
 */
export function buildMessages(q, context, history = [], { task = taskOf(q), contextInSystem = false, keepRefs = false, maxTurns = 4, maxChars = 900 } = {}) {
  if (history && !Array.isArray(history)) history = [history];
  const turns = (history || []).filter((h) => h?.q && h?.a).slice(-maxTurns);
  const msgs = [{ role: 'system', content: contextInSystem ? `${SYSTEM_PROMPT}\n\n<extraits>\n${context}\n</extraits>` : SYSTEM_PROMPT }];
  for (const h of turns) {
    msgs.push({ role: 'user', content: h.q });
    const a = keepRefs ? h.a : stripRefs(h.a);
    msgs.push({ role: 'assistant', content: a.length > maxChars ? `${a.slice(0, maxChars)}…` : a });
  }
  const t = TASKS[task] ? `${TASKS[task]}\n\n` : '';
  msgs.push({ role: 'user', content: contextInSystem ? `${t}${q}` : `${context}\n\n${t}Demande de l'utilisateur : ${q}` });
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
export function citedRefs(text, refs, max = 4, fallback = true) {
  const cited = [...new Set([...String(text).matchAll(/\[(?:Sources?\s*:?\s*)?(R\d+(?:\s*[,;]\s*R?\d+)*)\]/gi)].flatMap((m) => [...m[1].matchAll(/(\d+)/g)].map((x) => Number(x[1]))))];
  const list = cited.length ? cited.map((n) => refs.find((r) => r.n === n)).filter(Boolean) : fallback ? refs.slice(0, 2) : [];
  return list.slice(0, max);
}
