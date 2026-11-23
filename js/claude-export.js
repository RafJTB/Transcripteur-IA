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
    key: 'actions',
    label: 'Relevé de décisions et d’actions',
    short: 'Qui fait quoi, pour quand',
    ask: `Établis le relevé de décisions et d'actions de cette réunion :
1. Décisions prises : une par ligne, formulée clairement (ce qui a été validé, choisi, abandonné ou reporté).
2. Actions à mener, sous forme de tableau : action | responsable | échéance | passage (horodatage, s'il est fourni).
   – Une action = une tâche concrète, commençant par un verbe à l'infinitif (« Mettre à jour la maquette structure »).
   – Responsable : la personne qui s'est engagée ou à qui on l'a demandé ; « à préciser » si ce n'est pas clair.
   – Échéance : la date ou le délai dit dans l'échange ; « à préciser » sinon.
3. Points en suspens : questions restées sans réponse ou sujets à reprendre.
Ne retiens que ce qui est réellement décidé ou demandé : pas les simples idées ou hypothèses.`,
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
export function buildPrompt({ type, extra = '', title = '', meta = '', transcript, language = 'français', translatedFrom = null, both = false, speakers = null, attached = '' }) {
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
  // Transcription trop longue pour la zone de message : elle est jointe en fichier
  if (attached) lines.push(`La transcription complète est dans le fichier joint « ${attached} ».`, ...(head ? ['', head] : []));
  else lines.push('<transcription>', ...(head ? [head, ''] : []), transcript.trim(), '</transcription>');
  return lines.join('\n');
}

/**
 * IA vers lesquelles envoyer la consigne. Seul Claude accepte de manière fiable une consigne courte dans l'adresse :
 * la consigne est copiée et collée. `max` : longueur au-delà de laquelle la transcription est jointe en fichier
 * (limites de la zone de message, approximatives et susceptibles de changer).
 */
export const AI_TARGETS = [
  { key: 'claude', label: 'Claude', sub: 'claude.ai', url: CLAUDE_NEW, max: Infinity, privacy: 'Le texte est envoyé à Anthropic (ton compte claude.ai).' },
  { key: 'm365', label: 'Copilot Microsoft 365', sub: 'compte pro ou d’école', url: 'https://m365.cloud.microsoft/chat', max: 12000, privacy: 'Le texte est envoyé à Microsoft 365 Copilot. Avec un compte pro ou d’école, il reste dans le périmètre de ton organisation (protection des données entreprise, si elle est activée chez toi).' },
  { key: 'chatgpt', label: 'ChatGPT', sub: 'chatgpt.com', url: 'https://chatgpt.com/', max: 60000, privacy: 'Le texte est envoyé à OpenAI (ton compte ChatGPT). Avec un compte personnel, il peut servir à améliorer leurs modèles, sauf si tu l’as désactivé (Paramètres → Gestion des données).' },
  { key: 'gemini', label: 'Gemini', sub: 'gemini.google.com', url: 'https://gemini.google.com/app', max: 60000, privacy: 'Le texte est envoyé à Google (Gemini). Avec un compte personnel, les conversations peuvent être relues et servir à améliorer le service, selon ton réglage « Activité dans les applis Gemini ». Avec un compte Google Workspace pro, ce sont les règles de ton organisation.' },
];
export const aiTarget = (key) => AI_TARGETS.find((t) => t.key === key) || AI_TARGETS[0];

/** Lien claude.ai pré-rempli, ou null si la consigne est trop longue pour un lien. */
export function claudeUrl(prompt) {
  const q = encodeURIComponent(prompt);
  return q.length <= MAX_URL_PROMPT ? `${CLAUDE_NEW}?q=${q}` : null;
}
