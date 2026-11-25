// Onglets en « verre liquide » : une pastille de verre se pose sous l'onglet sélectionné
// et glisse vers le nouveau en s'étirant comme une goutte. Une pastille par groupe d'onglets.

import { blockColor } from './hover-glow.js';

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
  if (st.dragging) return; // la pastille suit la souris : on ne la replace pas
  const items = [...host.querySelectorAll(st.item)].filter((b) => b.parentElement === host);
  const on = items.find((b) => st.isOn(b) && b.offsetParent !== null);
  items.forEach((b) => (b === on ? b.setAttribute('data-lg-on', '') : b.removeAttribute('data-lg-on')));
  if (!st.pill.isConnected) { host.prepend(st.pill); animate = false; }
  if (!on || !on.offsetWidth) { st.pill.classList.remove('on'); st.last = null; return; }
  // Teinte : la couleur propre de l'onglet choisi (dossier, catégorie, icône colorée) ; sinon verre neutre
  const c = blockColor(on);
  if (c) st.pill.style.setProperty('--lg-a', c); else st.pill.style.removeProperty('--lg-a');
  st.pill.classList.toggle('neutral', !c);
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
  enableDrag(host, st);
}

// ---------- Glisser : rester appuyé et déplacer la souris, la pastille suit ----------
const visibleItems = (host, st) => [...host.querySelectorAll(st.item)].filter((b) => b.parentElement === host && b.offsetParent !== null && b.offsetWidth > 0);

function enableDrag(host, st) {
  let d = null;
  const pillRect = (r, s = 1) => {
    const p = st.pill.style;
    p.transform = `translate(${r.x}px, ${r.y}px) scale(${d?.vertical ? 1 : s}, ${d?.vertical ? s : 1})`;
    p.width = `${r.w}px`;
    p.height = `${r.h}px`;
  };
  const follow = (e) => {
    const items = visibleItems(host, st);
    if (!items.length) return;
    const hr = host.getBoundingClientRect();
    const v = d.vertical;
    // Position de la souris dans le groupe (en tenant compte d'un éventuel défilement)
    const p = v ? e.clientY - hr.top + host.scrollTop : e.clientX - hr.left + host.scrollLeft;
    const start = (b) => (v ? b.offsetTop : b.offsetLeft), size = (b) => (v ? b.offsetHeight : b.offsetWidth);
    // Onglet sous la souris (ou le plus proche, entre deux rubriques)
    let under = items[0], best = Infinity;
    for (const b of items) {
      const c = start(b) + size(b) / 2, dist = Math.abs(p - c);
      if (dist < best) { best = dist; under = b; }
    }
    const len = size(under);
    const min = start(items[0]), max = start(items[items.length - 1]) + size(items[items.length - 1]) - len;
    const pos = Math.max(min, Math.min(max, p - len / 2));
    // Étirement selon la vitesse : plus on va vite, plus la goutte s'allonge
    const now = performance.now(), dt = Math.max(1, now - d.t), speed = Math.abs(p - d.p) / dt;
    d.t = now; d.p = p;
    d.s = d.s * 0.6 + Math.min(1.22, 1 + speed * 0.12) * 0.4;
    d.rect = v ? { x: under.offsetLeft, y: pos, w: under.offsetWidth, h: len } : { x: pos, y: under.offsetTop, w: len, h: under.offsetHeight };
    pillRect(d.rect, d.s);
    if (under !== d.under) {
      d.under = under;
      items.forEach((b) => (b === under ? b.setAttribute('data-lg-on', '') : b.removeAttribute('data-lg-on')));
    }
  };
  host.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || (e.pointerType === 'touch' && host.id !== 'nav')) return;
    const item = e.target.closest(st.item);
    if (!item || item.parentElement !== host || !st.pill.classList.contains('on')) return;
    d = { id: e.pointerId, x0: e.clientX, y0: e.clientY, from: item, under: null, active: false, t: performance.now(), p: 0, s: 1 };
  });
  host.addEventListener('pointermove', (e) => {
    if (!d || e.pointerId !== d.id) return;
    if (!d.active) {
      if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 6) return; // simple clic : rien ne change
      const items = visibleItems(host, st);
      d.vertical = items.length > 1 && items[1].offsetTop !== items[0].offsetTop;
      d.active = true;
      st.dragging = true;
      clearTimeout(st.t);
      try { host.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      host.classList.add('lg-dragging');
      st.pill.classList.remove('still');
      st.pill.classList.add('drag');
      const hr = host.getBoundingClientRect();
      d.p = d.vertical ? e.clientY - hr.top + host.scrollTop : e.clientX - hr.left + host.scrollLeft;
    }
    e.preventDefault();
    follow(e);
  });
  const finish = (e, choose) => {
    if (!d || e.pointerId !== d.id) return;
    const g = d;
    d = null;
    if (!g.active) return;
    st.dragging = false;
    host.classList.remove('lg-dragging');
    st.pill.classList.remove('drag');
    try { host.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    // Le clic natif qui suit le relâchement ne doit pas ouvrir un autre onglet
    st.swallow = true;
    setTimeout(() => { st.swallow = false; }, 0);
    if (choose && g.under && !st.isOn(g.under)) g.under.click(); // l'onglet sous la souris est ouvert
    st.last = g.rect || null; // la goutte part d'où est la souris et se pose sur l'onglet choisi
    place(host, st, true);
  };
  host.addEventListener('pointerup', (e) => finish(e, true));
  host.addEventListener('pointercancel', (e) => finish(e, false));
  host.addEventListener('lostpointercapture', (e) => finish(e, true));
  host.addEventListener('click', (e) => { if (st.swallow && e.isTrusted) { e.stopPropagation(); e.preventDefault(); } }, true);
}

export function initLiquidTabs() {
  // Réfraction (le verre déforme légèrement ce qu'il y a derrière) : seulement si le navigateur sait le faire
  try { if (CSS.supports('backdrop-filter', 'url(#lg-refract) blur(2px)')) document.documentElement.classList.add('lg-refract'); } catch { /* ignore */ }
  for (const [sel, item, isOn] of GROUPS) document.querySelectorAll(sel).forEach((h) => watch(h, item, isOn));
}
