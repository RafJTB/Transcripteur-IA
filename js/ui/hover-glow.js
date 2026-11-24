// Lueur au survol des blocs : le bord du bloc s'allume là où est la souris.
// Une seule couche (position fixe, sans clic) est posée sur le bloc survolé : aucun bloc n'est modifié.
// Couleur : --hover-rgb (couleur d'accent par défaut). Blocs concernés : <html data-hover="all|click|off">.

const BLOCKS = [
  '.proj-row', '.proj-side', '.card', '.glass', '.settings-card', '.set-card', '.hero-tile', '.audio-card', '.stat-tile', '.proj-card', '.model-card',
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
export const refreshHoverGlow = schedule;
