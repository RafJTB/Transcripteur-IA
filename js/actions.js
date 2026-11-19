// Relevé de décisions et d'actions : repérage par règles (100 % local, sans IA).
// Fonctions pures, testables seules. Le repérage est volontairement prudent :
// mieux vaut rater une action que noyer le relevé de phrases sans intérêt.
// Pour un relevé fin, l'appli propose « Affiner avec Claude ».

// \b de JavaScript ignore les accents (« validé ») : frontières et lettres redéfinies
const L = 'A-Za-z0-9_À-ÖØ-öø-ÿŒœ';
const BND = `(?:(?<![${L}])(?=[${L}])|(?<=[${L}])(?![${L}]))`;
const W = (re) => new RegExp(re.source.replaceAll('\\b', BND).replaceAll('\\w', `[${L}]`), re.flags);

const DAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

// Formules de remplissage en début de phrase (retirées de l'affichage)
const FILLER = W(/^(?:(?:bon|bah|ben|alors|donc|euh+|heu+|hum+|ok|okay|d'accord|ouais|oui|voilà|écoute[sz]?|du coup|et|mais|en fait|bref|par contre|sinon|ensuite|et puis|parfait|super|très bien|nickel|top)\b[\s,.!…-]*)+/i);

// Décisions
const DECISION = W(new RegExp([
  "\\bon (?:valide|a validé|acte|a acté|retient|a retenu|garde|part sur|choisit|a choisi|opte|a opté|abandonne|reporte|décale|arrête|lance|maintient|fige|tranche)\\b",
  "\\b(?:c'est|ça c'est|c’est) (?:validé|acté|décidé|tranché|entendu|figé|bon pour moi|ok pour moi)\\b",
  "\\b(?:on a|nous avons) décidé\\b",
  "\\bdécision\\s*:",
  "\\bvalidé par\\b",
  "\\bgo pour\\b",
  "\\b(?:on fait|on part) comme ça\\b",
  "\\b(?:je suis|on est|tout le monde est) d'accord pour\\b",
].join('|'), 'i'));

// Actions : demandes et engagements explicites (fiables)
const ACTION_STRONG = W(new RegExp([
  "\\bil (?:faut|faudrait|faudra|va falloir) (?:que |qu'|qu’)?(?!(?:dire|savoir|voir|avouer|reconnaître|croire|pas)\\b)",
  "\\b(?:faut|faudrait) que\\b",
  "\\b(?:tu|vous) (?:dois|doit|devez|devrais|devriez|devras|devrez)\\b",
  "\\b(?:on|nous) (?:doit|devons|devrait|devrions|devra|devrons)\\b",
  "\\b(?:tu peux|tu pourrais|tu pourras|pourrais-tu|peux-tu|vous pouvez|vous pourriez|pourriez-vous|est-ce que tu peux|est-ce que vous pouvez)\\b",
  "\\bmerci de\\b",
  "\\b(?:n'oublie|n’oublie|n'oubliez|n’oubliez) pas\\b",
  "\\bpense[zs]? à\\b",
  "\\bje (?:m'en|m’en) (?:occupe|charge)\\b",
  "\\b(?:je|tu|il|elle|on) (?:m'|t'|s'|m’|t’|s’)?(?:occupe|occupes|charge|charges) (?:de|du|des)\\b",
  "\\bse charger? de\\b",
  "\\b(?:je|j') (?:te|t'|t’|vous|lui|leur) (?:envoie|transmets|transfère|renvoie|fais suivre|partage|mets en copie|rappelle)\\b",
  "\\bje (?:relance|reviens vers|regarde ça|vérifie ça|fais le point|prends l'action|prends ça)\\b",
  "\\b(?:action|todo|à faire)\\s*:",
].join('|'), 'i'));

// Engagements au futur (« je vais envoyer », « on fera ») : retenus seulement avec un verbe d'action ou une échéance
const FUTURE = W(/\b(?:\w+ va|(?:je|j')\s?vais|tu vas|on va|vous allez|il va|elle va|ils vont|(?:je|j')\s?\w+rai|tu \w+ras|on \w+ra|vous \w+rez)\b/i);
const NOT_FUTURE = W(/\b(?:on va dire|(?:on va|nous allons|je vais|on peut) (?:parler|discuter|aborder|commencer|passer|faire un (?:tour|point rapide))|je vais (?:vous |te )?(?:expliquer|présenter|montrer|parler|dire|commencer|finir|terminer|résumer|partager mon écran|être (?:honnête|franc|bref))|je (?:serai|aurai|pourrai|saurai|voudrais?)|tu verras|on verra|on va voir|ça va|comment va|il va (?:de soi|sans dire)|qui va bien)\b/i);
const ACTION_VERB = W(/\b(?:envo\w*|transm\w*|transf[eé]r\w*|v[ée]rifi\w*|relanc\w*|pr[ée]par\w*|mett\w*|mettr\w*|corrig\w*|modifi\w*|appel\w*|rappel\w*|contact\w*|organis\w*|planifi\w*|cal(?:er|e|era|erai)\b|regard\w*|valid\w*|int[ée]gr\w*|repren\w*|reprendr\w*|r[ée]dig\w*|compl[ée]t\w*|chiffr\w*|command\w*|finalis\w*|d[ée]pos\w*|partag\w*|livr\w*|export\w*|lanc\w*|programm\w*|demand\w*|pr[ée]ven\w*|r[ée]serv\w*|imprim\w*|sign\w*|mettre à jour|faire|fera\w*|ferai\w*|ferez|r[ée]gl\w*|r[ée]soudr\w*|traiter|trait\w*|check\w*|caler|bloquer|bloqu\w*|r[ée]server|fixer|fix\w*|nettoy\w*|purg\w*|cr[ée]er|cr[ée]\w*)\b/i);

// Échéances
const DUE = W(new RegExp([
  "\\b(?:d'ici|avant|pour|d’ici) (?:la fin (?:de la semaine|du mois|de la journée)|(?:le |la )?(?:prochaine réunion|prochain point|prochaine fois)|demain|ce soir|(?:" + DAYS.join('|') + ")(?: prochain)?|le \\d{1,2}(?:er)?(?: (?:" + MONTHS.join('|') + "))?|\\d{1,2}(?:er)? (?:" + MONTHS.join('|') + ")|\\d+ (?:jours?|semaines?))",
  "\\b(?:" + DAYS.join('|') + ")(?: prochain| matin| après-midi| soir)?\\b",
  "\\b(?:demain|après-demain|aujourd'hui|aujourd’hui|ce soir|cet après-midi|ce matin)\\b",
  "\\b(?:cette semaine|la semaine prochaine|semaine prochaine|en fin de semaine|fin de semaine|fin du mois|en fin de mois|le mois prochain|en fin de journée)\\b",
  "\\b(?:à|pour) la prochaine (?:réunion|fois)\\b",
  "\\b(?:le )?\\d{1,2}(?:er)? (?:" + MONTHS.join('|') + ")\\b",
  "\\bdans \\d+ (?:jours?|semaines?)\\b",
  "\\b(?:asap|au plus vite|dès que possible|rapidement|en urgence|en priorité)\\b",
].join('|'), 'i'));

// Demande sous forme de question : « Julie, tu peux… ? », « Pourrais-tu… ? »
const REQUEST = W(/^(?:[A-ZÀ-Ý]\w+,\s*)?(?:est-ce que |est-ce qu'|et )?(?:(?:tu|vous) (?:peux|pouvez|pourrais|pourriez|pourras|pourrez)|pourrais-tu|peux-tu|pourriez-vous|pouvez-vous|tu me (?:fais|envoies|dis)|vous me (?:faites|envoyez))\b/i);

// Acquiescement seul : « pas de souci, je m'en occupe »
const ACK = W(/^(?:(?:pas de (?:souci|problème)|ça marche|ça roule|entendu|c'est noté|noté|ça me va)[\s,.!]*)*(?:je (?:m'en occupe|m'en charge|le fais|la fais|les fais|regarde ça|vérifie ça|m'y mets|fais ça|gère|m'occupe de ça))?[\s.!]*$/i);

// Mots en majuscule qui ne sont pas des prénoms
const NOT_NAMES = new Set(['bon', 'bah', 'ben', 'alors', 'donc', 'ok', 'okay', 'oui', 'non', 'voilà', 'merci', 'parfait', 'super', 'bref', 'ensuite', 'après', 'puis', 'enfin', 'sinon', 'attends', 'écoute', 'écoutez', 'bonjour', 'salut', 'tiens', 'regarde', 'pardon', 'désolé', 'excuse', 'vous', 'tu', 'on', 'je', 'il', 'elle', 'nous', 'top', 'nickel', 'là', 'ici', 'aussi', 'mais', 'et', 'ou', 'le', 'la', 'les']);

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** Découpe un texte en phrases. */
export function splitSentences(text) {
  return String(text || '')
    .split(/(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 3);
}

/** Phrase nettoyée pour l'affichage (sans « bon, alors, euh »). */
export function cleanSentence(s) {
  let t = s.replace(FILLER, '').trim();
  if (t.length > 220) t = t.slice(0, 219).replace(/\s+\S*$/, '') + '…';
  return cap(t || s.trim());
}

/** Échéance trouvée dans une phrase, telle qu'elle est dite (ou null). */
export function findDue(s) {
  const m = s.match(DUE);
  return m ? m[0].toLowerCase().trim() : null;
}

/**
 * Date réelle d'une échéance relative (« vendredi », « demain »…) par rapport au jour de la réunion.
 * @returns {Date|null}
 */
export function dueDate(due, meetingTime) {
  if (!due || !meetingTime) return null;
  const base = new Date(meetingTime);
  base.setHours(12, 0, 0, 0);
  const d = due.toLowerCase();
  const add = (n) => new Date(base.getTime() + n * 86400000);
  if (/après-demain/.test(d)) return add(2);
  if (/demain/.test(d)) return add(1);
  if (/aujourd|ce soir|ce matin|cet après-midi|fin de journée/.test(d)) return add(0);
  const day = DAYS.findIndex((x) => new RegExp(`\\b${x}\\b`).test(d));
  if (day >= 0) {
    // Le prochain jour de ce nom (« vendredi » dit un vendredi = la semaine suivante)
    return add((day - base.getDay() + 7) % 7 || 7);
  }
  const dm = d.match(new RegExp(`(\\d{1,2})(?:er)? (${MONTHS.join('|')})`));
  if (dm) {
    const m = MONTHS.indexOf(dm[2]);
    let y = base.getFullYear();
    if (m < base.getMonth() - 1) y++;
    return new Date(y, m, Number(dm[1]), 12);
  }
  const dn = d.match(/dans (\d+) (jour|semaine)/);
  if (dn) return add(Number(dn[1]) * (dn[2] === 'semaine' ? 7 : 1));
  return null;
}

/** Prénom cité dans la phrase : « Julie, tu… », « Marc s'en occupe », ou un intervenant connu. */
function namedIn(s, known) {
  for (const n of known) {
    if (n && new RegExp(`(^|[\\s,'’])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(s)) return n;
  }
  const lead = s.match(/^(?:[^,]{0,20},\s*)?([A-ZÉÈÀÂÎÔÛÇ][a-zéèêëàâîïôöûüç-]{1,20})\s*,/);
  if (lead && !NOT_NAMES.has(lead[1].toLowerCase())) return lead[1];
  const subj = s.match(/\b([A-ZÉÈÀÂÎÔÛÇ][a-zéèêëàâîïôöûüç-]{1,20}) (?:va|s'en occupe|s’en occupe|se charge|s'occupe|s’occupe|doit|devra|peut|pourra|enverra|fera)\b/);
  if (subj && !NOT_NAMES.has(subj[1].toLowerCase())) return subj[1];
  return null;
}

/**
 * Repère les décisions et les actions d'une transcription.
 * @param {{text: string, start: number, spk?: number}[]} segments
 * @param {{speakers?: {name: string}[], meetingTime?: number}} o
 * @returns {{type: 'decision'|'action', text: string, who: string|null, due: string|null, date: Date|null, i: number, start: number, key: string}[]}
 */
export function extractActions(segments, { speakers = [], meetingTime = null } = {}) {
  const names = speakers.map((p) => p?.name).filter((n) => n && !/^Personne \d+$/.test(n));
  const nameOf = (spk) => (spk != null && speakers[spk]?.name) || null;
  const out = [];
  const seen = new Set();
  segments.forEach((seg, i) => {
    for (const raw of splitSentences(seg.text)) {
      const s = raw.replace(/’/g, "'");
      const question = /\?\s*$/.test(s);
      const isDecision = !question && DECISION.test(s);
      const strong = ACTION_STRONG.test(s);
      const due = findDue(s);
      const future = !question && FUTURE.test(s) && !NOT_FUTURE.test(s) && (ACTION_VERB.test(s) || due);
      const request = question && REQUEST.test(s.replace(FILLER, '').trim());
      const isAction = (strong && (!question || request)) || future;
      if (!isDecision && !isAction) continue;
      // « Oui, je m'en occupe » juste après une demande : c'est le responsable de cette demande
      if (ACK.test(s.replace(FILLER, '').trim())) {
        const prev = out[out.length - 1];
        if (prev?.type === 'action' && i - prev.i <= 3 && seg.spk != null) { if (!prev.named) prev.who = nameOf(seg.spk) || prev.who; continue; }
      }
      const text = cleanSentence(raw);
      const key = `${Math.round(seg.start * 10)}:${text.slice(0, 40).toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Qui ?
      let who = namedIn(s, names);
      const named = !!who;
      if (!who && isAction) {
        if (/\b(?:je|j'|moi je)\b/i.test(s) && !/\b(?:tu|vous)\b/i.test(s)) who = nameOf(seg.spk);
        else if (/\b(?:tu|vous|pourrais-tu|peux-tu|pourriez-vous)\b/i.test(s)) {
          // La personne à qui l'on parle : celle qui répond juste après
          const next = segments.slice(i + 1, i + 4).find((x) => x.spk != null && x.spk !== seg.spk);
          who = next ? nameOf(next.spk) : null;
        }
      }
      out.push({
        type: isDecision && !isAction ? 'decision' : isAction ? 'action' : 'decision',
        text,
        who,
        due: isAction ? due : null,
        date: isAction ? dueDate(due, meetingTime) : null,
        i,
        start: seg.start,
        key,
        named,
      });
    }
  });
  return out;
}

/** Relevé au format Markdown (à coller dans un mail, Teams, Notion…). */
export function actionsToMarkdown(items, { title = '', fmtDate = (d) => d.toLocaleDateString('fr-FR') } = {}) {
  const dec = items.filter((x) => x.type === 'decision');
  const act = items.filter((x) => x.type === 'action');
  const lines = [];
  if (title) lines.push(`# Relevé — ${title}`, '');
  lines.push('## Décisions', '');
  lines.push(...(dec.length ? dec.map((x) => `- ${x.text}`) : ['- Aucune décision relevée.']), '');
  lines.push('## Actions', '');
  if (act.length) {
    lines.push('| Action | Responsable | Échéance | Fait |', '|---|---|---|---|');
    for (const x of act) {
      const due = x.due ? `${x.due}${x.date ? ` (${fmtDate(x.date)})` : ''}` : 'à préciser';
      lines.push(`| ${x.text.replace(/\|/g, '/')} | ${x.who || 'à préciser'} | ${due} | ${x.done ? '✓' : ''} |`);
    }
  } else lines.push('Aucune action relevée.');
  return lines.join('\n');
}
