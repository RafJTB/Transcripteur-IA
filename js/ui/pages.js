// Pages Personnalisation et Modèles.

import { ACCENTS, BACKGROUNDS, DEFAULTS as PERSO_DEFAULTS, accentVars, applyPerso, customImage, loadPerso, saveCustomImage, savePerso, shrinkImage } from '../perso.js';
import { MODELS, isStreaming, pickVariant } from '../config.js';
import { $, caps, esc, fmtMB, state, store, toast } from './core.js';
import { monitor, player } from './recording.js';

// ---------- Page Personnalisation ----------
const PLUS_ICON = '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>';
function setPerso(patch) {
  const p = { ...loadPerso(), ...patch };
  p.css = (BACKGROUNDS.find((b) => b.id === p.bg) || BACKGROUNDS[0]).css;
  // Gardé tout calculé pour le petit script en tête de page (couleur appliquée avant l'affichage)
  p.accentVars = p.accent ? accentVars(p.accent) : null;
  savePerso(p);
  applyPerso(p);
  applyThemeColors();
  renderPerso();
}

export function renderPerso() {
  const grid = $('#bg-grid');
  if (!grid) return;
  const p = loadPerso();
  const img = customImage();
  grid.innerHTML = BACKGROUNDS.map((b) => `<button class="bg-tile${p.bg === b.id ? ' active' : ''}" type="button" data-bg="${b.id}"><span class="sw${b.id === 'uni' ? ' uni' : ''}" style="${b.id === 'uni' ? '' : `background:${esc(b.css)};background-size:cover;background-position:center`}"></span>${esc(b.label)}</button>`).join('')
    + (img
      ? `<button class="bg-tile${p.bg === 'custom' ? ' active' : ''}" type="button" data-bg="custom"><span class="sw" style="background-image:url('${img}')"></span>Ton image <small>· <span data-change>changer</span></small></button>`
      : `<button class="bg-tile" type="button" data-import><span class="sw add">${PLUS_ICON}</span>Importer une image</button>`);
  const cur = (p.accent || ACCENTS[0].hex).toLowerCase();
  const known = ACCENTS.find((a) => a.hex === cur);
  $('#accent-row').innerHTML = ACCENTS.map((a) => {
    const v = accentVars(a.hex).dark;
    return `<button type="button" class="acc-sw${a.hex === cur ? ' active' : ''}" data-accent="${a.hex}" title="${esc(a.label)}" aria-label="${esc(a.label)}" style="--a:rgb(${v['--sel-a']});--b:${a.hex}"><i></i></button>`;
  }).join('') + `<label class="acc-sw custom${known ? '' : ' active'}" title="Couleur personnalisée"><i></i><input type="color" id="accent-custom" value="${cur}" aria-label="Couleur personnalisée" /></label><span class="accent-name">${esc(known ? known.label : `Personnalisée (${cur})`)}</span>`;
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
