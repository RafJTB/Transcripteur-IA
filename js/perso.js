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

export const DEFAULTS = { bg: 'photo', blur: 14, veil: 100, panel: 100 };

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
