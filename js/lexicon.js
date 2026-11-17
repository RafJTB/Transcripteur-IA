// Lexique de corrections appliqué après la transcription (sauvegardé dans le navigateur).
const KEY = 'transcripteur.lexique.v1';

export const DEFAULT_LEXICON = [
  { from: 'ifc', to: 'IFC', enabled: true },
  { from: 'i f c', to: 'IFC', enabled: true },
  { from: 'bim', to: 'BIM', enabled: true },
  { from: 'b i m', to: 'BIM', enabled: true },
  { from: 'lod', to: 'LOD', enabled: true },
  { from: 'l o d', to: 'LOD', enabled: true },
  // « loin » est un mot courant (« c'est loin ») : désactivé par défaut pour ne pas abîmer le texte.
  { from: 'loin', to: 'LOIN', enabled: false, note: 'Mot courant en français : à activer seulement si besoin' },
  { from: 'revit', to: 'Revit', enabled: true },
  { from: 'revite', to: 'Revit', enabled: true },
  { from: 'rêvit', to: 'Revit', enabled: true },
  { from: 'autocad', to: 'AutoCAD', enabled: true },
  { from: 'auto cad', to: 'AutoCAD', enabled: true },
  { from: 'navisworks', to: 'Navisworks', enabled: true },
  { from: 'navis works', to: 'Navisworks', enabled: true },
  { from: 'naviswork', to: 'Navisworks', enabled: true },
  { from: 'acc', to: 'ACC', enabled: true },
  { from: 'autodesk construction cloud', to: 'Autodesk Construction Cloud', enabled: true },
  { from: 'cctp', to: 'CCTP', enabled: true },
  { from: 'doe', to: 'DOE', enabled: true },
  { from: 'dce', to: 'DCE', enabled: true },
  { from: 'dpgf', to: 'DPGF', enabled: true },
  { from: 'bcf', to: 'BCF', enabled: true },
  { from: 'maquette numerique', to: 'maquette numérique', enabled: true },
];

export function loadLexicon() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* stockage indisponible */ }
  return DEFAULT_LEXICON.map((e) => ({ ...e }));
}

export function saveLexicon(entries) {
  try {
    localStorage.setItem(KEY, JSON.stringify(entries));
  } catch { /* stockage indisponible */ }
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Compile le lexique en règles regex (mots entiers, insensibles à la casse, espaces/tirets souples). */
export function compileLexicon(entries) {
  return entries
    .filter((e) => e.enabled !== false && e.from?.trim() && e.to != null)
    .sort((a, b) => b.from.length - a.from.length)
    .map((e) => {
      const body = e.from.trim().split(/[\s-]+/).map(esc).join('[\\s\\-]+');
      return { re: new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'giu'), to: e.to };
    });
}

export function applyLexicon(text, rules) {
  let out = text;
  for (const r of rules) out = out.replace(r.re, r.to);
  return out;
}
