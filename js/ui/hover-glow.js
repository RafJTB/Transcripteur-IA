// Lueur au survol des blocs : le bord du bloc s'allume là où est la souris.
// Une seule couche (position fixe, sans clic) est posée sur le bloc survolé : aucun bloc n'est modifié.
// Couleur : --hover-rgb (couleur d'accent par défaut). Blocs concernés : <html data-hover="all|click|off">.

const BLOCKS = [
  '.proj-row', '.proj-side .fchip', '#set-nav [data-set]', '.proj-side', '.card', '.glass', '.settings-card', '.set-card', '.hero-tile', '.audio-card', '.stat-tile', '.proj-card', '.model-card',
  '.bg-tile', '.spc-item', '.spc-doc', '.cal-ev', '.capture-tiles > button', '.opt-row', '.recent-row', '.picker',
].join(', ');
const SKIP = '.glass-btn, .glass-select, .btn, .view, .modal, .toasts, input, textarea, select';
const OUTSIDE = '.sidebar, .topbar, .hover-glow';

/**
 * Un « bloc » : un élément connu, ou tout élément arrondi avec un fond ou une bordure,
 * d'une taille raisonnable. Les nouvelles pages sont ainsi couvertes sans liste à tenir à jour.
 */
function isBlock(e) {
  if (e.matches(SKIP)) return false;
  if (e.matches(BLOCKS)) return true;
  const r = e.getBoundingClientRect();
  if (r.width < 120 || r.height < 44) return false;
  const cs = getComputedStyle(e);
  if ((parseFloat(cs.borderTopLeftRadius) || 0) < 8) return false;
  const bg = cs.backgroundColor !== 'rgba(0, 0, 0, 0)' || cs.backgroundImage !== 'none' || (cs.backdropFilter && cs.backdropFilter !== 'none');
  return bg || (parseFloat(cs.borderTopWidth) || 0) > 0;
}

let glow = null;
let px = -1, py = -1, raf = 0;
let lastBlock = null, lastColor = null;

// ---------- Couleur automatique : celle du bloc survolé ----------
const ICONS = '.sq, .st-ico, .r-ico, .pr-ico, .set-ic, .ct-ico, .pk-ico, .opt-ico, .am-ico, .ic';
const TRIPLE = /^\s*(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})\s*$/;

/** « r g b » d'une couleur vive (assez saturée et visible), sinon null. */
function vivid(r, g, b, a = 1) {
  if (a < 0.15) return null;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  if (mx < 60 || (mx - mn) / mx < 0.3) return null; // gris, blanc ou trop sombre
  return `${Math.round(r)} ${Math.round(g)} ${Math.round(b)}`;
}
/** La couleur la plus vive d'un texte CSS (couleur unie ou dégradé) : celle qu'on remarque. */
function firstRgb(txt) {
  let best = null, bestSat = -1;
  for (const m of String(txt || '').matchAll(/rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?/g)) {
    const a = m[4] == null ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    const c = vivid(+m[1], +m[2], +m[3], a);
    if (!c) continue;
    const mx = Math.max(+m[1], +m[2], +m[3]), sat = (mx - Math.min(+m[1], +m[2], +m[3])) / mx;
    if (sat > bestSat) { best = c; bestSat = sat; }
  }
  return best;
}
/** Couleur du bloc : sa couleur propre (dossier, catégorie…), sinon celle de son icône. */
export function blockColor(e) {
  const cs = getComputedStyle(e);
  for (const v of ['--fc', '--c']) {
    const m = cs.getPropertyValue(v).match(TRIPLE);
    if (m) return `${+m[1]} ${+m[2]} ${+m[3]}`; // couleur attribuée au bloc : respectée telle quelle, même grise
  }
  // Icône connue : son fond, sinon sa couleur de trait
  const ic = e.querySelector(ICONS);
  if (ic) {
    const is = getComputedStyle(ic);
    const c = firstRgb(is.backgroundImage) || firstRgb(is.backgroundColor) || firstRgb(is.color);
    if (c) return c;
  }
  // Sinon : le premier élément « de taille d'icône » (16 à 96 px) au fond coloré
  const all = e.querySelectorAll('*');
  for (let i = 0; i < all.length && i < 60; i++) {
    const el = all[i];
    const r = el.getBoundingClientRect();
    if (r.width < 16 || r.height < 16 || r.width > 96 || r.height > 96) continue;
    const es = getComputedStyle(el);
    const c = firstRgb(es.backgroundImage) || firstRgb(es.backgroundColor);
    if (c) return c;
  }
  return null;
}

const mode = () => document.documentElement.dataset.hover || 'all';

/** Le bloc le plus proche sous la souris (le plus petit), ou rien. */
function pick(el) {
  const m = mode();
  if (m === 'off' || !el?.closest || el.closest(OUTSIDE)) return null;
  const big = innerWidth * innerHeight * 0.6;
  for (let e = el; e && e !== document.body; e = e.parentElement) {
    if (!isBlock(e)) continue;
    const r = e.getBoundingClientRect();
    if (r.width * r.height > big) return null; // page entière : pas de lueur
    if (m === 'click' && getComputedStyle(e).cursor !== 'pointer') continue;
    return e;
  }
  return null;
}

/** Partie visible du bloc (les zones qui défilent le coupent). */
function visible(e, r) {
  let t = r.top, l = r.left, b = r.bottom, rt = r.right;
  for (let a = e.parentElement; a && a !== document.body; a = a.parentElement) {
    const cs = getComputedStyle(a);
    if (/auto|scroll|hidden|clip/.test(cs.overflowX + cs.overflowY)) {
      const ar = a.getBoundingClientRect();
      t = Math.max(t, ar.top); l = Math.max(l, ar.left); b = Math.min(b, ar.bottom); rt = Math.min(rt, ar.right);
    }
  }
  return { t, l, b, r: rt };
}

function hide() { glow?.classList.remove('on'); }

function update() {
  raf = 0;
  if (px < 0) return hide();
  const e = pick(document.elementFromPoint(px, py));
  if (!e) return hide();
  const r = e.getBoundingClientRect();
  const v = visible(e, r);
  if (v.b - v.t < 4 || v.r - v.l < 4) return hide();
  const s = glow.style;
  s.left = `${r.left}px`;
  s.top = `${r.top}px`;
  s.width = `${r.width}px`;
  s.height = `${r.height}px`;
  const br = getComputedStyle(e).borderRadius;
  s.borderRadius = !br || /^0(px)?$/.test(br) ? '12px' : br; // bloc sans arrondi : arrondi discret
  s.clipPath = `inset(${Math.max(0, v.t - r.top)}px ${Math.max(0, r.right - v.r)}px ${Math.max(0, r.bottom - v.b)}px ${Math.max(0, v.l - r.left)}px)`;
  s.setProperty('--mx', `${px - r.left}px`);
  s.setProperty('--my', `${py - r.top}px`);
  // Couleur automatique : calculée seulement quand on change de bloc
  if (document.documentElement.dataset.hoverAuto !== '0') {
    if (e !== lastBlock) { lastBlock = e; lastColor = blockColor(e); }
    if (lastColor) s.setProperty('--hover-rgb', lastColor);
    else s.removeProperty('--hover-rgb');
  } else { lastBlock = null; s.removeProperty('--hover-rgb'); } // couleur fixe ou accent : jamais celle d'un bloc
  glow.classList.add('on');
}

const schedule = () => { if (!raf) raf = requestAnimationFrame(update); };

export function initHoverGlow() {
  if (glow || !window.matchMedia?.('(hover: hover)').matches) return; // écrans tactiles : rien
  glow = document.createElement('div');
  glow.className = 'hover-glow';
  glow.setAttribute('aria-hidden', 'true');
  document.body.appendChild(glow);
  document.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') { px = -1; return schedule(); }
    px = e.clientX; py = e.clientY;
    schedule();
  }, { passive: true });
  document.addEventListener('pointerleave', () => { px = -1; schedule(); });
  document.documentElement.addEventListener('mouseleave', () => { px = -1; schedule(); });
  window.addEventListener('scroll', schedule, { passive: true, capture: true });
  window.addEventListener('resize', schedule, { passive: true });
  window.addEventListener('blur', () => { px = -1; schedule(); });
}

/** Après un changement de réglage : met la lueur à jour tout de suite. */
export const refreshHoverGlow = () => { lastBlock = null; schedule(); };
