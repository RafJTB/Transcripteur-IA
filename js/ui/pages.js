// Pages Personnalisation et Modèles.

import { ACCENTS, BACKGROUNDS, BG_CATS, DEFAULTS as PERSO_DEFAULTS, accentVars, applyPerso, customImage, loadPerso, saveCustomImage, savePerso, shrinkImage } from '../perso.js';
import { MODELS, isStreaming, pickVariant } from '../config.js';
import { $, caps, esc, fmtMB, state, store, toast } from './core.js';
import { Auth, Sync } from '../cloud.js';
import { Look } from '../presentation.js';
import { monitor, player } from './recording.js';
import { initHoverGlow, refreshHoverGlow } from './hover-glow.js';
import { initLiquidTabs } from './liquid-tabs.js';

// ---------- Page Personnalisation ----------
let bgCat = 'all'; // famille affichée dans le catalogue de fonds
const PLUS_ICON = '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>';
/** Enregistre les réglages, avec ce que le petit script en tête de page applique avant l'affichage. */
function persist(p) {
  p.css = (BACKGROUNDS.find((b) => b.id === p.bg) || BACKGROUNDS[0]).css;
  p.accentVars = p.accent ? accentVars(p.accent) : null;
  savePerso(p);
  return p;
}

/** Changement fait par l'utilisateur : appliqué, et marqué pour la synchronisation entre navigateurs. */
function setPerso(patch) {
  const p = persist({ ...loadPerso(), ...patch });
  applyPerso(p);
  applyThemeColors();
  renderPerso();
  Look.touch();
}

/** Présentation importée depuis le Drive (autre navigateur) : appliquée sans être renvoyée. */
export function applyRemoteLook() {
  const t = store.get('theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  persist(loadPerso());
  applyPerso();
  applyThemeColors();
  renderPerso();
  refreshHoverGlow();
  toast('Ta présentation a été importée depuis ton Google Drive.', 'ok', 4000);
}

/** Ligne « Retrouver ma présentation sur mes autres navigateurs ». */
export function renderLookSync() {
  const el = $('#look-sync-info');
  if (!el) return;
  const u = Auth.user();
  el.textContent = !Look.enabled() ? 'Désactivé : cette présentation reste propre à ce navigateur.'
    : u ? `Thème, fond, couleurs et effets sont enregistrés dans le Google Drive de ${u.email} et appliqués sur tes autres navigateurs connectés à ce compte.`
      : 'Connecte-toi à Google (en bas à gauche) : ta présentation te suivra sur tes autres navigateurs.';
}

export function renderPerso() {
  renderLookSync();
  const grid = $('#bg-grid');
  if (!grid) return;
  const p = loadPerso();
  const img = customImage();
  // Familles : « Tous », puis chaque famille ; la famille du fond actuel est proposée à l'ouverture
  const cats = [['all', 'Tous'], ...BG_CATS, ['mine', 'Ton image']];
  if (!cats.some(([k]) => k === bgCat)) bgCat = 'all';
  const nOf = (k) => (k === 'all' ? BACKGROUNDS.length : k === 'mine' ? '' : BACKGROUNDS.filter((b) => b.cat === k).length);
  $('#bg-cats').innerHTML = cats.map(([k, label]) => `<button type="button" role="tab" class="bg-cat${bgCat === k ? ' on' : ''}" data-cat="${k}" aria-selected="${bgCat === k}">${esc(label)}${nOf(k) !== '' ? `<small>${nOf(k)}</small>` : ''}</button>`).join('');
  $('#bg-count').textContent = `${BACKGROUNDS.length} fonds`;
  const shown = BACKGROUNDS.filter((b) => bgCat === 'all' || b.cat === bgCat);
  const sw = (b) => (b.id === 'uni' ? '' : b.thumb ? `background-image:url('${esc(b.thumb)}')` : `background:${esc(b.css)};background-size:cover;background-position:center`);
  grid.innerHTML = (bgCat === 'mine' ? [] : shown).map((b) => `<button class="bg-tile${p.bg === b.id ? ' active' : ''}" type="button" data-bg="${b.id}"><span class="sw${b.id === 'uni' ? ' uni' : ''}" style="${sw(b)}"></span>${esc(b.label)}</button>`).join('')
    + (bgCat === 'all' || bgCat === 'mine'
      ? (img
        ? `<button class="bg-tile${p.bg === 'custom' ? ' active' : ''}" type="button" data-bg="custom"><span class="sw" style="background-image:url('${img}')"></span>Ton image <small>· <span data-change>changer</span></small></button>`
        : `<button class="bg-tile" type="button" data-import><span class="sw add">${PLUS_ICON}</span>Importer une image</button>`)
      : '');
  const cur = (p.accent || ACCENTS[0].hex).toLowerCase();
  const known = ACCENTS.find((a) => a.hex === cur);
  $('#accent-row').innerHTML = ACCENTS.map((a) => {
    const v = accentVars(a.hex).dark;
    return `<button type="button" class="acc-sw${a.hex === cur ? ' active' : ''}" data-accent="${a.hex}" title="${esc(a.label)}" aria-label="${esc(a.label)}" style="--a:rgb(${v['--sel-a']});--b:${a.hex}"><i></i></button>`;
  }).join('') + `<label class="acc-sw custom${known ? '' : ' active'}" title="Couleur personnalisée"><i></i><input type="color" id="accent-custom" value="${cur}" aria-label="Couleur personnalisée" /></label><span class="accent-name">${esc(known ? known.label : `Personnalisée (${cur})`)}</span>`;
  // Survol des blocs
  const hm = ['all', 'click', 'off'].includes(p.hover) ? p.hover : 'all';
  document.querySelectorAll('#hover-mode [data-hover]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.hover === hm)));
  const hc = p.hoverColor === 'accent' ? '' : (p.hoverColor || '').toLowerCase();
  const hAuto = !p.hoverColor, hAcc = p.hoverColor === 'accent';
  const hKnown = ACCENTS.find((a) => a.hex === hc);
  const accHex = (p.accent || ACCENTS[0].hex).toLowerCase();
  const accV = accentVars(accHex).dark;
  $('#hover-row').classList.toggle('off', hm === 'off');
  $('#hover-row').innerHTML = `<button type="button" class="acc-sw auto${hAuto ? ' active' : ''}" data-hcolor="" title="Automatique : la couleur du bloc survolé" aria-label="Automatique : la couleur du bloc survolé"><i></i></button>`
    + `<button type="button" class="acc-sw same${hAcc ? ' active' : ''}" data-hcolor="accent" title="Comme la couleur d’accent" aria-label="Comme la couleur d’accent" style="--a:rgb(${accV['--sel-a']});--b:${accHex}"><i></i></button>`
    + ACCENTS.map((a) => {
      const v = accentVars(a.hex).dark;
      return `<button type="button" class="acc-sw${a.hex === hc ? ' active' : ''}" data-hcolor="${a.hex}" title="${esc(a.label)}" aria-label="${esc(a.label)}" style="--a:rgb(${v['--sel-a']});--b:${a.hex}"><i></i></button>`;
    }).join('')
    + `<label class="acc-sw custom${hc && !hKnown ? ' active' : ''}" title="Couleur personnalisée"><i></i><input type="color" id="hover-custom" value="${hc || accHex}" aria-label="Couleur personnalisée du survol" /></label><span class="accent-name">${esc(hAuto ? 'Automatique : la couleur du bloc survolé' : hAcc ? 'Comme la couleur d’accent' : hKnown ? hKnown.label : `Personnalisée (${hc})`)}</span>`;
  const light = document.documentElement.dataset.theme === 'light';
  $('#perso-blur').value = p.blur;
  $('#perso-blur-v').textContent = `${p.blur} px`;
  $('#perso-veil').value = p.veil;
  $('#perso-veil-l').textContent = light ? 'Éclaircissement du fond' : 'Assombrissement du fond';
  $('#perso-veil-v').textContent = `${p.veil} %`;
  $('#perso-panel').value = p.panel;
  // Opacité réelle des panneaux dans le thème affiché
  $('#perso-panel-v').textContent = `${Math.min(100, Math.round((light ? 28 : 16) * (p.panel / 100)))} %`;
}

export function bindPerso() {
  applyPerso();
  initHoverGlow();
  initLiquidTabs();
  Sync.onLook = applyRemoteLook;
  $('#look-sync').checked = Look.enabled();
  $('#look-sync').onchange = (e) => { Look.setEnabled(e.target.checked); renderLookSync(); };
  $('#bg-cats').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cat]');
    if (!b) return;
    bgCat = b.dataset.cat;
    renderPerso();
  });
  $('#bg-grid').addEventListener('click', (e) => {
    const t = e.target.closest('[data-bg], [data-import]');
    if (!t) return;
    if (t.hasAttribute('data-import') || e.target.closest('[data-change]')) return $('#bg-file').click();
    setPerso({ bg: t.dataset.bg });
  });
  $('#bg-file').onchange = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    try {
      const url = await shrinkImage(f);
      if (!saveCustomImage(url)) return toast('Stockage du navigateur plein : impossible de garder cette image.', 'err', 6000);
      setPerso({ bg: 'custom' });
      toast('Fond d’écran mis à jour.', 'ok', 2500);
    } catch (err) {
      toast(err.message || 'Image illisible.', 'err', 6000);
    }
  };
  const live = (id, key) => {
    $(id).addEventListener('input', (e) => {
      const p = { ...loadPerso(), [key]: Number(e.target.value) };
      applyPerso(p);
      savePerso({ ...p, css: (BACKGROUNDS.find((b) => b.id === p.bg) || BACKGROUNDS[0]).css });
      renderPerso();
      Look.touch();
    });
  };
  live('#perso-blur', 'blur');
  live('#perso-veil', 'veil');
  live('#perso-panel', 'panel');
  $('#perso-reset').onclick = () => setPerso({ ...PERSO_DEFAULTS });
  $('#accent-row').addEventListener('click', (e) => {
    const b = e.target.closest('[data-accent]');
    if (b) setPerso({ accent: b.dataset.accent === ACCENTS[0].hex ? null : b.dataset.accent });
  });
  // Sélecteur libre : aperçu en direct, enregistré à la fermeture
  $('#accent-row').addEventListener('input', (e) => {
    if (e.target.id !== 'accent-custom') return;
    applyPerso({ ...loadPerso(), accent: e.target.value });
  });
  $('#accent-row').addEventListener('change', (e) => {
    if (e.target.id === 'accent-custom') setPerso({ accent: e.target.value.toLowerCase() });
  });
  // Survol des blocs : blocs concernés et couleur
  $('#hover-mode').addEventListener('click', (e) => {
    const b = e.target.closest('[data-hover]');
    if (b) setPerso({ hover: b.dataset.hover });
  });
  $('#hover-row').addEventListener('click', (e) => {
    const b = e.target.closest('[data-hcolor]');
    if (b) { setPerso({ hoverColor: b.dataset.hcolor || null }); refreshHoverGlow(); }
  });
  $('#hover-row').addEventListener('input', (e) => {
    if (e.target.id === 'hover-custom') applyPerso({ ...loadPerso(), hoverColor: e.target.value });
  });
  $('#hover-row').addEventListener('change', (e) => {
    if (e.target.id === 'hover-custom') setPerso({ hoverColor: e.target.value.toLowerCase() });
  });
  // Le libellé et l'opacité affichée dépendent du thème
  $('#btn-theme').addEventListener('click', () => setTimeout(() => { applyPerso(); applyThemeColors(); renderPerso(); }));
  renderPerso();
}

// ---------- Page Modèles ----------
export function renderModelsPage() {
  const box = $('#models-page');
  if (!box) return;
  const auto = state.autoTune && store.get('model.manual') !== '1';
  const MODEL_ICONS = [
    '<svg viewBox="0 0 24 24"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>',
    '<svg viewBox="0 0 24 24"><path d="M12 3v18M5 7h14M5 7l-3 7a4 4 0 0 0 6 0zM19 7l-3 7a4 4 0 0 0 6 0z"/></svg>',
    '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/></svg>',
    '<svg viewBox="0 0 24 24"><path d="M3 12h3l2-6 4 12 3-9 2 3h4"/></svg>',
  ];
  box.innerHTML = MODELS.map((m, mi) => {
    const v = state.caps ? pickVariant(m, caps()) : m.variants.webgpu;
    const off = !!state.caps && !v;
    const cur = m.id === state.modelId;
    const cached = state.cache[m.id];
    return `<section class="glass model-card${cur ? ' current' : ''}${off ? ' off' : ''}">
      <header><span class="mc-ico">${MODEL_ICONS[mi % MODEL_ICONS.length]}</span><div><h3>${esc(m.label)}</h3><small>${esc(m.name)}</small></div>${cur ? `<span class="mc-cur">${auto ? 'Choisi automatiquement' : 'Utilisé'}</span>` : ''}</header>
      <p>${esc(m.description)}</p>
      <div class="mc-tags"><span>${fmtMB((v || m.variants.webgpu).sizeMB)}</span><span class="${cached ? 'ok' : ''}">${cached ? 'Déjà téléchargé' : 'À télécharger'}</span>${isStreaming(m) ? '<span class="live">Vrai temps réel</span>' : ''}${m.heavy && state.caps && !caps().webgpu && !off ? '<span class="warn">Lent sans carte graphique</span>' : ''}${off ? '<span class="warn">Carte graphique requise</span>' : ''}</div>
      <button class="btn ${cur ? '' : 'primary'} sm" type="button" data-use="${m.id}"${cur || off ? ' disabled' : ''}>${cur ? 'Modèle actuel' : 'Utiliser ce modèle'}</button>
    </section>`;
  }).join('') + `<p class="an-note">${state.autoTune ? 'Le réglage automatique choisit le modèle selon ton appareil ; en choisir un ici le remplace jusqu’à ce que tu réactives le réglage automatique.' : 'Réglage automatique désactivé : le modèle choisi ici est utilisé pour toutes les transcriptions.'} Moteur : ${esc($('#pill-engine span')?.textContent || '')}</p>`;
}

// ======================================================================
// Démarrage
// ======================================================================
export function applyThemeColors() {
  monitor?.refreshColors();
  player?.refreshColors();
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());
}
