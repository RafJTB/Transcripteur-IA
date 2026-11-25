// Présentation (thème, fond d'écran, couleurs, effets, survol) : copiée dans le Google Drive
// de l'utilisateur pour être retrouvée sur ses autres navigateurs. La plus récente gagne.
// Ce module ne touche qu'au stockage du navigateur ; l'interface réapplique les réglages ensuite.

const K = {
  perso: 'transcripteur.perso',
  img: 'transcripteur.perso.image',
  theme: 'transcripteur.theme',
  u: 'transcripteur.look.u',
  auto: 'transcripteur.look.auto',
  on: 'transcripteur.look.sync',
  status: 'transcripteur.look.status',
};
const get = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const set = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); return true; } catch { return false; } };

/** Empreinte courte d'un texte (FNV-1a 32 bits) : sait si l'image de fond a changé sans la renvoyer. */
export function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return s ? h.toString(16).padStart(8, '0') + s.length.toString(36) : '';
}

const HEX = /^#[0-9a-f]{6}$/i;
const num = (v, min, max, d) => (Number.isFinite(+v) ? Math.max(min, Math.min(max, +v)) : d);

/** Réglages reçus du Drive : seuls les champs connus, avec les bons types (jamais de CSS venu d'ailleurs). */
export function cleanPerso(p) {
  const o = p && typeof p === 'object' ? p : {};
  return {
    bg: typeof o.bg === 'string' && /^[a-z0-9-]{1,40}$/.test(o.bg) ? o.bg : 'photo',
    blur: num(o.blur, 0, 40, 14),
    veil: num(o.veil, 0, 200, 100),
    panel: num(o.panel, 0, 400, 100),
    accent: HEX.test(o.accent || '') ? o.accent.toLowerCase() : null,
    hover: ['all', 'click', 'off'].includes(o.hover) ? o.hover : 'all',
    hoverColor: o.hoverColor === 'accent' || HEX.test(o.hoverColor || '') ? String(o.hoverColor).toLowerCase() : null,
  };
}

const DEF = { bg: 'photo', blur: 14, veil: 100, panel: 100, accent: null, hover: 'all', hoverColor: null };
/** Réglages différents de ceux par défaut. */
export function isCustomPerso(p) {
  if (!p || typeof p !== 'object') return false;
  const c = cleanPerso(p);
  return Object.keys(DEF).some((k) => c[k] !== DEF[k]);
}

const IMG = /^data:image\/(webp|jpeg|png);base64,[A-Za-z0-9+/=]+$/;

export const Look = {
  /** Synchronisation de la présentation (activée par défaut). */
  enabled: () => get(K.on) !== '0',
  setEnabled(on) { set(K.on, on ? '1' : '0'); if (on) Look.touch(); },
  /** Date de la dernière modification faite par l'utilisateur sur ce navigateur (0 = jamais). */
  updatedAt: () => Number(get(K.u)) || 0,
  /** À appeler après un changement fait par l'utilisateur (pas après une importation). */
  touch() { set(K.u, String(Date.now())); set(K.auto, null); Look.onTouch?.(); },
  onTouch: null,
  image: () => get(K.img) || '',
  /** Présentation différente de celle par défaut (le thème seul ne compte pas : il suit souvent Windows). */
  isCustom() {
    let p = null;
    try { p = JSON.parse(get(K.perso) || 'null'); } catch { /* ignore */ }
    return isCustomPerso(p) || !!get(K.img);
  },
  /** Date posée automatiquement (réglages d'avant cette fonction), sans relancer de synchronisation. */
  stamp() { set(K.u, String(Date.now())); set(K.auto, '1'); },
  /** Dernier échange avec le Drive, affiché dans Personnalisation. */
  status() { try { return JSON.parse(get(K.status) || 'null'); } catch { return null; } },
  setStatus(kind, extra = '') { set(K.status, JSON.stringify({ kind, at: Date.now(), extra: String(extra).slice(0, 160) })); Look.onStatus?.(); },
  onStatus: null,
  /** Ce qui part dans le Drive (l'image de fond, plus lourde, part dans un fichier à part). */
  snapshot() {
    let perso = null;
    try { perso = JSON.parse(get(K.perso) || 'null'); } catch { /* ignore */ }
    const theme = get(K.theme);
    const clean = perso ? cleanPerso(perso) : null;
    return { v: 1, u: Look.updatedAt(), auto: get(K.auto) === '1', custom: isCustomPerso(clean) || !!Look.image(), theme: theme === 'light' || theme === 'dark' ? theme : null, perso: clean, imgHash: hash(Look.image()) };
  },
  /**
   * Applique des réglages venus du Drive (sans les marquer comme une modification locale).
   * @param {object} remote  contenu de presentation.json
   * @param {string|null} image  image de fond personnelle (data URL), si elle a changé
   * @returns {boolean} true si quelque chose a été appliqué
   */
  apply(remote, image = null) {
    if (!remote || typeof remote !== 'object') return false;
    if (remote.theme === 'light' || remote.theme === 'dark') set(K.theme, remote.theme);
    if (remote.perso) set(K.perso, JSON.stringify(cleanPerso(remote.perso)));
    if (typeof image === 'string' && IMG.test(image) && image.length < 6e6) set(K.img, image);
    else if (remote.imgHash === '') set(K.img, null);
    set(K.u, String(Number(remote.u) || Date.now()));
    set(K.auto, remote.auto ? '1' : null);
    return true;
  },
};
