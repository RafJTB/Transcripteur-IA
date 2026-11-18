// Envoi de la transcription vers Claude (claude.ai) pour en faire un résumé.
// Fonctions pures : construction de la consigne et du lien. Rien n'est envoyé sans clic.

export const CLAUDE_NEW = 'https://claude.ai/new';
/** Au-delà, le lien pré-rempli serait trop long : on colle depuis le presse-papiers. */
export const MAX_URL_PROMPT = 6000;

export const SUMMARY_TYPES = [
  {
    key: 'cr',
    label: 'Compte rendu de réunion',
    short: 'Décisions, actions, points en suspens',
    ask: `Rédige un compte rendu de réunion structuré :
1. Objet et contexte (en 2–3 phrases).
2. Participants, s'ils sont identifiables dans les échanges.
3. Points abordés, regroupés par thème.
4. Décisions prises.
5. Actions à mener, sous forme de tableau : action | responsable | échéance (indique « à préciser » si l'information manque).
6. Points en suspens et questions ouvertes.`,
  },
  {
    key: 'court',
    label: 'Résumé court',
    short: 'L’essentiel en quelques lignes',
    ask: 'Fais un résumé court (5 à 10 lignes) qui donne l’essentiel, suivi des 3 à 5 points clés à retenir.',
  },
  {
    key: 'points',
    label: 'Points clés',
    short: 'Liste à puces hiérarchisée',
    ask: 'Liste les points clés sous forme de puces hiérarchisées, regroupées par thème. Une idée par puce, phrases courtes.',
  },
  {
    key: 'detail',
    label: 'Résumé détaillé',
    short: 'Structuré par thèmes, sans perte d’information',
    ask: 'Fais un résumé détaillé, structuré par thèmes avec des titres, sans perdre d’information importante (chiffres, dates, noms, références).',
  },
];

/**
 * Consigne complète à donner à Claude.
 * @param {{type: string, extra?: string, title?: string, meta?: string, transcript: string}} o
 */
export function buildPrompt({ type, extra = '', title = '', meta = '', transcript, language = 'français', translatedFrom = null, both = false, speakers = null }) {
  const t = SUMMARY_TYPES.find((x) => x.key === type) || SUMMARY_TYPES[0];
  const intro = translatedFrom
    ? both
      ? `Voici la transcription automatique d’un enregistrement audio en ${translatedFrom}, chaque phrase étant suivie de sa traduction automatique en français.`
      : `Voici la transcription automatique d’un enregistrement audio en ${translatedFrom}, traduite automatiquement en français.`
    : `Voici la transcription automatique d’un enregistrement audio (en ${language}).`;
  const lines = [
    intro,
    `Elle peut contenir des erreurs de reconnaissance${translatedFrom ? ' et de traduction' : ''} (mots mal compris, ponctuation approximative) : corrige-les mentalement d’après le contexte, sans inventer d’informations. Si un passage est incompréhensible ou ambigu, signale-le plutôt que de deviner.`,
    '',
    t.ask,
  ];
  if (speakers?.length > 1)
    lines.splice(2, 0, `Les intervenants (${speakers.join(', ')}) ont été reconnus automatiquement à leur voix : l’attribution d’une phrase peut parfois être fausse. Utilise leurs noms dans ta réponse (qui a dit, proposé ou pris en charge quoi).`);
  if (extra.trim()) lines.push('', `Consignes supplémentaires : ${extra.trim()}`);
  lines.push('', 'Réponds en français, avec des titres et une mise en forme claire.', '');
  const head = [title && `Titre : ${title}`, meta && `Infos : ${meta}`].filter(Boolean).join('\n');
  lines.push('<transcription>', ...(head ? [head, ''] : []), transcript.trim(), '</transcription>');
  return lines.join('\n');
}

/** Lien claude.ai pré-rempli, ou null si la consigne est trop longue pour un lien. */
export function claudeUrl(prompt) {
  const q = encodeURIComponent(prompt);
  return q.length <= MAX_URL_PROMPT ? `${CLAUDE_NEW}?q=${q}` : null;
}
