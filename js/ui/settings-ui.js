// Page Paramètres : sommaire des catégories à gauche, une catégorie affichée à droite.

import { Auth } from '../cloud.js';
import { $, $$, esc, lsGet, lsSet, state } from './core.js';

const TABS = ['compte', 'ia', 'voix', 'moteur', 'lexique', 'stockage', 'apropos'];
let current = TABS.includes(lsGet('set.tab', '')) ? lsGet('set.tab', '') : 'compte';

/** Affiche une catégorie (et la retient pour la prochaine visite). */
export function setSettingsTab(tab) {
  if (!TABS.includes(tab)) return;
  current = tab;
  lsSet('set.tab', tab);
  $$('#set-nav [data-set]').forEach((b) => {
    const on = b.dataset.set === tab;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
    // Sommaire en bandeau (téléphone) : la catégorie choisie reste visible
    const nav = b.parentElement;
    if (on && nav.scrollWidth > nav.clientWidth) nav.scrollLeft = Math.max(0, b.offsetLeft - 8);
  });
  $$('.set-sec').forEach((s) => (s.hidden = s.dataset.sec !== tab));
}

/** Pastilles d'état du sommaire et aperçu du lexique. */
export function renderSettings() {
  if (!$('#set-nav')) return;
  setSettingsTab(current);
  const dot = (k, cls, title = '') => { const d = $(`#set-nav [data-dot="${k}"]`); if (d) { d.className = `set-dot ${cls}`; d.title = title; } };
  const u = Auth.user();
  dot('compte', u ? (Auth.expired() ? 'warn' : 'ok') : 'off', u ? (Auth.expired() ? 'Session expirée : reconnecte-toi' : 'Connecté') : 'Pas connecté');
  const c = state.caps;
  dot('moteur', !c ? '' : c.webgpu && !state.forceWasm ? 'ok' : 'warn', !c ? '' : c.webgpu && !state.forceWasm ? 'Carte graphique (rapide)' : 'Processeur (plus lent)');
  renderLexPreview();
}

function renderLexPreview() {
  const box = $('#lex-preview');
  if (!box) return;
  const on = (state.lexicon || []).filter((e) => e.enabled !== false && (e.from || '').trim() && (e.to || '').trim());
  $('#lex-count').textContent = on.length ? `${on.length} mot${on.length > 1 ? 's' : ''}` : '';
  $('#lex-count').hidden = !on.length;
  box.innerHTML = on.length
    ? on.slice(0, 10).map((e) => `<span>${esc(e.from)}<em>→</em>${esc(e.to)}</span>`).join('') + (on.length > 10 ? `<span class="more">+${on.length - 10}</span>` : '')
    : '<span class="none">Aucun mot pour l’instant : ajoute un sigle ou un nom propre mal compris.</span>';
}

export function bindSettings() {
  const nav = $('#set-nav');
  if (!nav) return;
  nav.addEventListener('click', (e) => {
    const b = e.target.closest('[data-set]');
    if (b) setSettingsTab(b.dataset.set);
  });
  // Flèches haut / bas dans le sommaire
  nav.addEventListener('keydown', (e) => {
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    e.preventDefault();
    const i = TABS.indexOf(current) + (e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1);
    const tab = TABS[(i + TABS.length) % TABS.length];
    setSettingsTab(tab);
    $(`#set-nav [data-set="${tab}"]`)?.focus();
  });
  // Lexique modifié (dans son panneau) : l'aperçu suit
  let t = 0;
  document.addEventListener('input', (e) => { if (e.target.closest?.('#lex-list')) { clearTimeout(t); t = setTimeout(renderLexPreview, 200); } });
  document.addEventListener('click', (e) => { if (e.target.closest?.('#lex-list, #lex-add, [data-close]')) setTimeout(renderLexPreview, 50); });
  setSettingsTab(current);
}
