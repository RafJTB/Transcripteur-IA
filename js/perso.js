// Personnalisation : fond d'écran, flou, voile et opacité des panneaux.
// Réglages gardés dans ce navigateur (localStorage) ; l'image importée est réduite avant d'être gardée.
// (Le petit script en tête de index.html applique les mêmes réglages dès le chargement, sans flash.)

const KEY = 'transcripteur.perso';
const IMG_KEY = 'transcripteur.perso.image';

export const BACKGROUNDS = [
  { id: 'photo', label: 'Salon violet', css: "url('assets/bg.webp')" },
  { id: 'aurore', label: 'Aurore', css: 'radial-gradient(at 18% 22%, #7c3aed 0, transparent 52%), radial-gradient(at 82% 28%, #db2777 0, transparent 46%), radial-gradient(at 50% 92%, #2563eb 0, transparent 56%), #1e1b4b' },
  { id: 'ocean', label: 'Océan', css: 'radial-gradient(at 15% 25%, #0284c7 0, transparent 52%), radial-gradient(at 85% 72%, #4f46e5 0, transparent 52%), radial-gradient(at 60% 10%, #0d9488 0, transparent 40%), #0b1e3f' },
  { id: 'foret', label: 'Forêt', css: 'radial-gradient(at 25% 30%, #059669 0, transparent 50%), radial-gradient(at 80% 80%, #0f766e 0, transparent 55%), radial-gradient(at 75% 15%, #4d7c0f 0, transparent 40%), #062a23' },
  { id: 'crepuscule', label: 'Crépuscule', css: 'radial-gradient(at 20% 85%, #ea580c 0, transparent 50%), radial-gradient(at 80% 20%, #9333ea 0, transparent 55%), radial-gradient(at 50% 50%, #be185d 0, transparent 45%), #2a1235' },
  { id: 'graphite', label: 'Graphite', css: 'radial-gradient(at 30% 20%, #475569 0, transparent 55%), radial-gradient(at 80% 85%, #312e81 0, transparent 55%), #0f1117' },
  { id: 'uni', label: 'Uni', css: 'none' },
];

export const DEFAULTS = { bg: 'photo', blur: 14, veil: 100, panel: 100, accent: null, hover: 'all', hoverColor: null };

/** Couleurs d'accent (onglets sélectionnés, boutons, liens). La première est celle d'origine. */
export const ACCENTS = [
  { id: 'violet', label: 'Violet', hex: '#6a58f6' },
  { id: 'indigo', label: 'Indigo', hex: '#4f46e5' },
  { id: 'bleu', label: 'Bleu', hex: '#2563eb' },
  { id: 'cyan', label: 'Cyan', hex: '#0891b2' },
  { id: 'vert', label: 'Vert', hex: '#059669' },
  { id: 'ambre', label: 'Ambre', hex: '#d97706' },
  { id: 'corail', label: 'Corail', hex: '#ea580c' },
  { id: 'rose', label: 'Rose', hex: '#db2777' },
  { id: 'rouge', label: 'Rouge', hex: '#dc2626' },
  { id: 'graphite', label: 'Graphite', hex: '#475569' },
];

const toRgb = (hex) => {
  const h = String(hex).replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((x) => x + x).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const mix = (a, b, k) => a.map((v, i) => Math.round(v + (b[i] - v) * k));
const trip = (c) => c.join(' ');
const hexOf = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');

/** Variables CSS d'une couleur d'accent, pour le thème sombre et le thème clair. */
export function accentVars(hex) {
  const base = toRgb(hex);
  const W = [255, 255, 255], B = [0, 0, 0];
  const selA = mix(base, W, 0.25);
  const out = {};
  for (const theme of ['dark', 'light']) {
    const acc = theme === 'dark' ? mix(base, W, 0.3) : mix(base, B, 0.12);
    const acc2 = theme === 'dark' ? base : mix(base, W, 0.15);
    const text = theme === 'dark' ? mix(base, W, 0.65) : mix(base, B, 0.3);
    out[theme] = {
      '--sel-a': trip(selA), '--sel-b': trip(base),
      '--accent': hexOf(acc), '--accent-rgb': trip(acc),
      '--accent-2': hexOf(acc2), '--accent-2-rgb': trip(acc2),
      '--accent-text': hexOf(text),
    };
  }
  return out;
}

const ACCENT_KEYS = ['--sel-a', '--sel-b', '--accent', '--accent-rgb', '--accent-2', '--accent-2-rgb', '--accent-text'];

export function loadPerso() {
  let p = {};
  try { p = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { p = {}; }
  return { ...DEFAULTS, ...p };
}

export function savePerso(p) {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* stockage plein */ }
}

export function customImage() {
  try { return localStorage.getItem(IMG_KEY) || ''; } catch { return ''; }
}

/** Applique les réglages à la page (variables CSS sur <html>). */
export function applyPerso(p = loadPerso()) {
  const s = document.documentElement.style;
  const img = p.bg === 'custom' ? customImage() : '';
  const bg = img ? `url("${img}")` : (BACKGROUNDS.find((b) => b.id === p.bg) || BACKGROUNDS[0]).css;
  s.setProperty('--bg-image', bg);
  s.setProperty('--bg-blur', `${Math.max(0, Math.min(40, Number(p.blur) || 0))}px`);
  s.setProperty('--veil-k', String(Math.max(0, Math.min(2, (Number(p.veil) || 0) / 100))));
  s.setProperty('--panel-k', String(Math.max(0, Math.min(4, (Number(p.panel) || 0) / 100))));
  // Couleur d'accent : selon le thème affiché (rien = couleurs d'origine de la feuille de style)
  const theme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  const vars = p.accent ? accentVars(p.accent)[theme] : null;
  for (const k of ACCENT_KEYS) vars ? s.setProperty(k, vars[k]) : s.removeProperty(k);
  // Lueur au survol des blocs : quels blocs, et quelle couleur (rien = couleur d'accent)
  document.documentElement.dataset.hover = ['all', 'click', 'off'].includes(p.hover) ? p.hover : 'all';
  if (/^#[0-9a-f]{6}$/i.test(p.hoverColor || '')) s.setProperty('--hover-rgb', trip(toRgb(p.hoverColor)));
  else s.removeProperty('--hover-rgb');
}

/**
 * Réduit une image importée (≤ 2048 px de large, WebP ou JPEG) pour qu'elle tienne dans le stockage du navigateur.
 * @returns {Promise<string>} data URL
 */
export async function shrinkImage(file, max = 2048) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  for (const q of [0.82, 0.7, 0.55]) {
    let url = c.toDataURL('image/webp', q);
    if (!url.startsWith('data:image/webp')) url = c.toDataURL('image/jpeg', q);
    if (url.length < 3.2e6) return url;
  }
  throw new Error('Image trop lourde, même réduite. Essaie une image plus petite.');
}

/** Garde l'image importée. Renvoie false si le stockage du navigateur est plein. */
export function saveCustomImage(url) {
  try { localStorage.setItem(IMG_KEY, url); return true; } catch { return false; }
}
