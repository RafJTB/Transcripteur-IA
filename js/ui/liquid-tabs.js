// Onglets en « verre liquide » : une pastille de verre se pose sous l'onglet sélectionné
// et glisse vers le nouveau en s'étirant comme une goutte. Une pastille par groupe d'onglets.

const GROUPS = [
  // [conteneur, onglets, est sélectionné ?]
  ['#nav', '[data-nav]', (b) => b.classList.contains('active')],
  ['.dtabs', 'button', (b) => b.getAttribute('aria-selected') === 'true'],
  ['.seg', 'button', (b) => b.getAttribute('aria-selected') === 'true'],
  ['#set-nav', '[data-set]', (b) => b.classList.contains('on')],
  ['.proj-side .folder-bar', '.fchip[data-folder]', (b) => b.classList.contains('active')],
  ['#bg-cats', '.bg-cat', (b) => b.classList.contains('on')],
];

const reduce = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const hosts = new Map(); // conteneur → { item, isOn, pill, last }

function place(host, st, animate) {
  const items = [...host.querySelectorAll(st.item)].filter((b) => b.parentElement === host);
  const on = items.find((b) => st.isOn(b) && b.offsetParent !== null);
  items.forEach((b) => (b === on ? b.setAttribute('data-lg-on', '') : b.removeAttribute('data-lg-on')));
  if (!st.pill.isConnected) { host.prepend(st.pill); animate = false; }
  if (!on || !on.offsetWidth) { st.pill.classList.remove('on'); st.last = null; return; }
  const to = { x: on.offsetLeft, y: on.offsetTop, w: on.offsetWidth, h: on.offsetHeight };
  const set = (r) => { const s = st.pill.style; s.transform = `translate(${r.x}px, ${r.y}px)`; s.width = `${r.w}px`; s.height = `${r.h}px`; };
  const from = st.last;
  const moved = from && (from.x !== to.x || from.y !== to.y);
  st.pill.classList.toggle('still', !animate || !moved || reduce());
  clearTimeout(st.t);
  if (animate && moved && !reduce()) {
    // Étape 1 : la goutte s'étire jusqu'au nouvel onglet ; étape 2 : elle s'y rassemble
    const x = Math.min(from.x, to.x), y = Math.min(from.y, to.y);
    set({ x, y, w: Math.max(from.x + from.w, to.x + to.w) - x, h: Math.max(from.y + from.h, to.y + to.h) - y });
    st.t = setTimeout(() => set(to), 150);
  } else set(to);
  st.pill.classList.add('on');
  st.last = to;
}

function watch(host, item, isOn) {
  if (hosts.has(host)) return;
  const pill = document.createElement('span');
  pill.className = 'lg-pill';
  pill.setAttribute('aria-hidden', 'true');
  const st = { item, isOn, pill, last: null, t: 0 };
  hosts.set(host, st);
  host.classList.add('lg-host');
  host.prepend(pill);
  let raf = 0;
  const later = (animate) => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => place(host, st, animate)); };
  // Sélection qui change, liste reconstruite, conteneur qui apparaît ou change de taille
  new MutationObserver((muts) => {
    const real = muts.filter((m) => m.target !== pill && !(m.type === 'childList' && [...m.addedNodes, ...m.removedNodes].every((n) => n === pill)));
    if (real.length) later(real.some((m) => m.type === 'attributes'));
  }).observe(host, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'aria-selected'] });
  new ResizeObserver(() => later(false)).observe(host);
  later(false);
}

export function initLiquidTabs() {
  // Réfraction (le verre déforme légèrement ce qu'il y a derrière) : seulement si le navigateur sait le faire
  try { if (CSS.supports('backdrop-filter', 'url(#lg-refract) blur(2px)')) document.documentElement.classList.add('lg-refract'); } catch { /* ignore */ }
  for (const [sel, item, isOn] of GROUPS) document.querySelectorAll(sel).forEach((h) => watch(h, item, isOn));
}
