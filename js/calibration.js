// Outils de qualité du micro : diagnostic de la pièce et calibration par dictée.
// Fonctions pures (sans interface), testables à part.

/** Phrases de dictée : français courant + un peu de vocabulaire du bâtiment, longueur proche. */
export const DICTATION = [
  'La réunion de synthèse aura lieu jeudi matin pour valider la maquette numérique et vérifier les réservations dans les murs porteurs.',
  'Le bureau d’études doit transmettre le dossier des ouvrages exécutés avant la fin du mois, avec tous les plans mis à jour.',
  'Nous avons détecté plusieurs conflits entre les gaines de ventilation et la structure du troisième étage du bâtiment.',
];

/** Réglages recommandés pour le micro intégré d'un PC portable. */
export const LAPTOP_PRESET = Object.freeze({
  gainDb: 0,
  autoGainControl: true, // micro loin de la bouche : le gain automatique aide
  noiseSuppression: true, // ventilateur, clavier
  echoCancellation: true, // haut-parleurs du PC
  highpass: true, // grondements, souffle du ventilateur, chocs sur le bureau
});

/** Réglages comparés pendant la calibration (l'appareil et l'écho restent ceux de l'utilisateur). */
export const CALIBRATION_CONFIGS = [
  { key: 'A', label: 'Réduction du bruit + gain automatique', short: 'Recommandé PC portable', settings: { noiseSuppression: true, autoGainControl: true, highpass: true } },
  { key: 'B', label: 'Sans réduction du bruit', short: 'Son plus naturel', settings: { noiseSuppression: false, autoGainControl: true, highpass: true } },
  { key: 'C', label: 'Gain automatique coupé', short: 'Volume fixe', settings: { noiseSuppression: true, autoGainControl: false, highpass: true } },
];

// ---------------------------------------------------------------------
// Score de dictée (taux de mots justes)
// ---------------------------------------------------------------------

/** Mots normalisés : minuscules, apostrophes unifiées, ponctuation retirée, nombres simples écrits en lettres. */
export function words(text) {
  const nums = { 1: 'un', 2: 'deux', 3: 'trois', '3e': 'troisième', 4: 'quatre' };
  return (text || '')
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/'/g, "' ") // « d'études » → « d' » + « études »
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .split(/\s+/)
    .map((w) => nums[w] || w)
    .filter(Boolean);
}

/**
 * Compare la phrase lue à la transcription (distance d'édition sur les mots).
 * Renvoie le score (0–1 = part de mots justes) et l'alignement pour l'affichage.
 */
export function dictationScore(reference, hypothesis) {
  const r = words(reference);
  const h = words(hypothesis);
  const n = r.length;
  const m = h.length;
  const d = Array.from({ length: n + 1 }, (_, i) => Array.from({ length: m + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
    }
  }
  // Alignement (pour surligner les erreurs)
  const ops = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1)) {
      ops.unshift(r[i - 1] === h[j - 1] ? { type: 'ok', ref: r[i - 1] } : { type: 'sub', ref: r[i - 1], hyp: h[j - 1] });
      i--; j--;
    } else if (i > 0 && d[i][j] === d[i - 1][j] + 1) {
      ops.unshift({ type: 'del', ref: r[i - 1] });
      i--;
    } else {
      ops.unshift({ type: 'ins', hyp: h[j - 1] });
      j--;
    }
  }
  const errors = d[n][m];
  return { score: n ? Math.max(0, 1 - errors / n) : 0, errors, total: n, ops };
}

// ---------------------------------------------------------------------
// Diagnostic de la pièce (à partir des niveaux mesurés : { t, db } toutes les ~50 ms)
// ---------------------------------------------------------------------

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

/**
 * Estimation de la réverbération : après chaque fin de mot suivie d'une pause, temps mis par
 * le son pour baisser de 15 dB. Une pièce sèche descend vite, une pièce qui résonne traîne.
 * Indicatif seulement (résolution 50 ms, micro de PC).
 */
export function estimateDecay(levels, speechLevel) {
  const times = [];
  for (let i = 1; i < levels.length - 2; i++) {
    const a = levels[i];
    if (a.db < speechLevel - 6) continue;
    if (levels[i + 1].db >= a.db - 1) continue; // il faut un début de descente
    let k = i + 1;
    while (k < levels.length && levels[k].t - a.t < 1.2 && levels[k].db > a.db - 15) {
      if (levels[k].db > levels[k - 1].db + 3) break; // la parole reprend : pas une vraie pause
      k++;
    }
    if (k < levels.length && levels[k].db <= a.db - 15 && levels[k].t - a.t < 1.2) times.push(levels[k].t - a.t);
  }
  if (times.length < 3) return null;
  times.sort((x, y) => x - y);
  return pct(times, 0.5);
}

/** Verdict du diagnostic. `silence` et `speech` : niveaux { t, db } des deux phases. */
export function analyzeRoom(silence, speech) {
  const sDb = silence.map((l) => l.db).sort((a, b) => a - b);
  const vDb = speech.map((l) => l.db).sort((a, b) => a - b);
  if (sDb.length < 10 || vDb.length < 20) return null;
  const noise = pct(sDb, 0.5);
  const voice = pct(vDb, 0.9);
  const snr = voice - noise;
  const decay = estimateDecay(speech, voice);

  const res = { noise, voice, snr, decay, items: [], advice: [] };
  // Affichage borné (un silence numérique parfait donnerait des valeurs absurdes)
  const nTxt = noise < -90 ? '< −90 dBFS' : `${Math.round(noise)} dBFS`.replace('-', '−');
  const sTxt = snr > 60 ? '> 60 dB' : `${Math.round(snr)} dB`;
  // Bruit de fond
  if (noise < -60) res.items.push({ key: 'noise', level: 'ok', label: 'Bruit de fond', value: nTxt, text: 'Pièce très calme.' });
  else if (noise < -48) res.items.push({ key: 'noise', level: 'ok', label: 'Bruit de fond', value: nTxt, text: 'Bruit de fond faible.' });
  else if (noise < -38) {
    res.items.push({ key: 'noise', level: 'warn', label: 'Bruit de fond', value: nTxt, text: 'Bruit de fond audible (ventilateur, clim, circulation ?).' });
    res.advice.push('Garde la réduction du bruit et le filtre des basses activés ; éloigne-toi des sources de bruit.');
  } else {
    res.items.push({ key: 'noise', level: 'err', label: 'Bruit de fond', value: nTxt, text: 'Pièce bruyante.' });
    res.advice.push('Change de pièce si possible, ou ferme portes et fenêtres : le bruit va gêner la transcription.');
  }
  // Voix / bruit
  if (voice < -50) {
    res.items.push({ key: 'snr', level: 'err', label: 'Voix', value: 'non détectée', text: 'Ta voix n’a pas été captée : vérifie le micro choisi.' });
    res.advice.unshift('Ta voix n’a pas été captée : vérifie le micro sélectionné et qu’il n’est pas coupé (touche micro du clavier ?).');
  } else if (snr >= 30) res.items.push({ key: 'snr', level: 'ok', label: 'Écart voix / bruit', value: sTxt, text: 'Excellent : ta voix ressort très nettement.' });
  else if (snr >= 20) res.items.push({ key: 'snr', level: 'ok', label: 'Écart voix / bruit', value: sTxt, text: 'Bon.' });
  else if (snr >= 12) {
    res.items.push({ key: 'snr', level: 'warn', label: 'Écart voix / bruit', value: sTxt, text: 'Moyen : la voix ne ressort pas assez du bruit.' });
    res.advice.push('Rapproche-toi de l’écran (le micro est souvent au-dessus de l’écran ou près du clavier) et parle un peu plus fort.');
  } else {
    res.items.push({ key: 'snr', level: 'err', label: 'Écart voix / bruit', value: sTxt, text: 'Faible : la voix se confond avec le bruit.' });
    res.advice.push('Rapproche-toi nettement du PC et réduis le bruit ambiant : c’est le point le plus important.');
  }
  // Réverbération
  if (decay == null) {
    res.items.push({ key: 'reverb', level: 'idle', label: 'Écho de la pièce', value: '—', text: 'Non mesurable : marque de courtes pauses entre les mots la prochaine fois.' });
  } else if (decay < 0.25) {
    res.items.push({ key: 'reverb', level: 'ok', label: 'Écho de la pièce', value: `${decay.toFixed(2).replace('.', ',')} s`, text: 'Pièce sèche, peu d’écho.' });
  } else if (decay < 0.45) {
    res.items.push({ key: 'reverb', level: 'warn', label: 'Écho de la pièce', value: `${decay.toFixed(2).replace('.', ',')} s`, text: 'Un peu d’écho.' });
    res.advice.push('Un peu d’écho : rapproche-toi du micro (ça réduit la part d’écho capté).');
  } else {
    res.items.push({ key: 'reverb', level: 'err', label: 'Écho de la pièce', value: `${decay.toFixed(2).replace('.', ',')} s`, text: 'Pièce qui résonne.' });
    res.advice.push('La pièce résonne : préfère une petite pièce meublée (rideaux, moquette) et rapproche-toi du micro. Aucun réglage ne corrige vraiment l’écho.');
  }
  const worst = res.items.some((x) => x.level === 'err') ? 'err' : res.items.some((x) => x.level === 'warn') ? 'warn' : 'ok';
  res.verdict = {
    ok: 'Bonnes conditions pour transcrire avec le micro du PC.',
    warn: 'Conditions correctes, mais améliorables.',
    err: 'Conditions difficiles : la transcription risque d’être moins fiable.',
  }[worst];
  res.level = worst;
  if (!res.advice.length) res.advice.push('Rien à changer. Pour en être sûr, lance la calibration.');
  return res;
}
