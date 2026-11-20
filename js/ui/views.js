// Navigation entre les pages et les onglets.

import { $, $$, state } from './core.js';
import { renderAnalytics, renderDashboard, renderQuick } from './dashboard.js';
import { renderActions, renderAnalysis, renderInsights, renderSummary } from './doc-tabs.js';
import { renderHistory } from './history.js';
import { renderModelsPage, renderPerso } from './pages.js';
import { monitor, player, recorder } from './recording.js';
import { renderSpaces } from './spaces.js';

// ======================================================================
// Interface v3 : vues, onglets du document, panneau d'analyse
// ======================================================================
const PAGE_OF = { home: 'home', record: 'record', doc: 'doc', projects: 'history', history: 'history', settings: 'settings', analytics: 'analytics', models: 'models', help: 'help', custom: 'custom', spaces: 'spaces' };

/** Affiche une vue (accueil, document, projets / historique, paramètres). */
/** Téléphone : le panneau « Analyse audio » s'ouvre en plein écran (onglet Analyse). */
export function toggleSheet(open = !document.body.classList.contains('sheet-open')) {
  document.body.classList.toggle('sheet-open', open);
  $('#nav [data-nav="panel"]').classList.toggle('active', open);
  if (open) {
    $$('#nav [data-nav]').forEach((b) => b.dataset.nav !== 'panel' && b.classList.remove('active'));
    requestAnimationFrame(() => monitor?.draw());
  } else setView(state.page === 'history' ? ($('#step-history').dataset.mode === 'projects' ? 'projects' : 'history') : state.page);
}

export function setView(name) {
  if (document.body.classList.contains('sheet-open')) { document.body.classList.remove('sheet-open'); $('#nav [data-nav="panel"]')?.classList.remove('active'); }
  const page = PAGE_OF[name] || 'home';
  state.page = page;
  document.body.dataset.page = page;
  $$('.view').forEach((v) => v.classList.toggle('active', v.dataset.page === page));
  const navKey = page === 'doc' ? 'projects' : page === 'record' ? 'home' : name;
  $$('#nav [data-nav]').forEach((b) => b.classList.toggle('active', b.dataset.nav === navKey));
  if (page === 'history') {
    $('#h-hist').textContent = name === 'projects' ? 'Mes projets' : 'Historique';
    $('#step-history').dataset.mode = name === 'projects' ? 'projects' : 'history';
    if (name === 'history') state.folder = 'all';
    renderHistory();
  }
  if (page === 'home') renderDashboard();
  else if (page !== 'record' && page !== 'doc') renderQuick();
  if (page === 'analytics') renderAnalytics();
  if (page === 'models') renderModelsPage();
  if (page === 'custom') renderPerso();
  if (page === 'spaces') renderSpaces();
  if (page === 'record') requestAnimationFrame(() => monitor?.draw());
  if (page === 'doc') requestAnimationFrame(() => player?.draw());
  else {
    // Hors du document : lecture en pause et panneau d'analyse vierge (sauf micro en cours d'utilisation)
    if (player?.loaded && !player.audio.paused) player.audio.pause();
    if (monitor && recorder.state === 'idle' && page !== 'record') { monitor.clearPlayback(); monitor.reset(); }
  }
  renderInsights();
}

export function setDocTab(tab) {
  state.dtab = tab;
  $$('[data-dtab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.dtab === tab)));
  $$('[data-dpanel]').forEach((p) => (p.hidden = p.dataset.dpanel !== tab));
  if (tab === 'analysis') renderAnalysis();
  if (tab === 'summary') renderSummary();
  if (tab === 'actions') renderActions();
}

// ======================================================================
// Tiroirs
// ======================================================================
export function openDrawer(id) {
  const d = $(id);
  d.classList.add('open');
  d.setAttribute('aria-hidden', 'false');
  $('.drawer-panel button, .drawer-panel input', d)?.focus();
}
export function closeDrawers() {
  $$('.drawer.open').forEach((d) => { d.classList.remove('open'); d.setAttribute('aria-hidden', 'true'); });
}
