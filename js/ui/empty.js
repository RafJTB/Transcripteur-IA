// Pages vides illustrées : un dessin (couleurs du thème), un titre, une phrase et le bon bouton.

const ART = {
  // Une réunion qui devient du texte
  meetings: `<svg viewBox="0 0 160 110" class="em-art" aria-hidden="true">
    <ellipse cx="80" cy="100" rx="62" ry="6" class="em-shadow"/>
    <rect x="34" y="18" width="92" height="74" rx="12" class="em-card"/>
    <rect x="46" y="32" width="44" height="6" rx="3" class="em-ink"/><rect x="46" y="46" width="68" height="5" rx="2.5" class="em-soft"/>
    <rect x="46" y="57" width="58" height="5" rx="2.5" class="em-soft"/><rect x="46" y="68" width="38" height="5" rx="2.5" class="em-soft"/>
    <circle cx="124" cy="24" r="17" class="em-accent"/><rect x="119.5" y="14" width="9" height="15" rx="4.5" class="em-on"/><path d="M114 25a10 10 0 0 0 20 0M124 35v4" class="em-on-line"/>
    <path d="M18 54h10M14 64h14M20 74h8" class="em-wave"/></svg>`,
  // Une liste cochée
  actions: `<svg viewBox="0 0 160 110" class="em-art" aria-hidden="true">
    <ellipse cx="80" cy="100" rx="60" ry="6" class="em-shadow"/>
    <rect x="30" y="14" width="100" height="80" rx="12" class="em-card"/>
    <rect x="44" y="30" width="12" height="12" rx="3.5" class="em-accent"/><path d="m47 36 2.5 2.5 4.5-5" class="em-on-line"/><rect x="62" y="33" width="52" height="6" rx="3" class="em-soft"/>
    <rect x="44" y="50" width="12" height="12" rx="3.5" class="em-accent"/><path d="m47 56 2.5 2.5 4.5-5" class="em-on-line"/><rect x="62" y="53" width="40" height="6" rx="3" class="em-soft"/>
    <rect x="44" y="70" width="12" height="12" rx="3.5" class="em-box"/><rect x="62" y="73" width="46" height="6" rx="3" class="em-soft"/>
    <path d="M128 18l3 7 7 3-7 3-3 7-3-7-7-3 7-3z" class="em-spark"/></svg>`,
  // Un dossier ouvert
  folder: `<svg viewBox="0 0 160 110" class="em-art" aria-hidden="true">
    <ellipse cx="80" cy="100" rx="58" ry="6" class="em-shadow"/>
    <path d="M30 34a8 8 0 0 1 8-8h22l8 8h54a8 8 0 0 1 8 8v42a8 8 0 0 1-8 8H38a8 8 0 0 1-8-8z" class="em-card"/>
    <path d="M30 46h100" class="em-soft-line"/><rect x="58" y="56" width="44" height="6" rx="3" class="em-soft"/><rect x="66" y="68" width="28" height="5" rx="2.5" class="em-soft"/>
    <circle cx="122" cy="26" r="10" class="em-accent"/><path d="M122 21v10M117 26h10" class="em-on-line"/></svg>`,
  // Une loupe sur un texte
  search: `<svg viewBox="0 0 160 110" class="em-art" aria-hidden="true">
    <ellipse cx="80" cy="100" rx="56" ry="6" class="em-shadow"/>
    <rect x="32" y="20" width="76" height="70" rx="12" class="em-card"/>
    <rect x="44" y="34" width="44" height="6" rx="3" class="em-soft"/><rect x="44" y="47" width="52" height="5" rx="2.5" class="em-soft"/><rect x="44" y="58" width="34" height="5" rx="2.5" class="em-soft"/>
    <circle cx="108" cy="62" r="18" class="em-glass"/><path d="m121 75 12 12" class="em-handle"/></svg>`,
  // Deux personnes reliées
  people: `<svg viewBox="0 0 160 110" class="em-art" aria-hidden="true">
    <ellipse cx="80" cy="100" rx="60" ry="6" class="em-shadow"/>
    <rect x="26" y="30" width="48" height="58" rx="12" class="em-card"/><rect x="86" y="30" width="48" height="58" rx="12" class="em-card"/>
    <circle cx="50" cy="52" r="10" class="em-accent"/><rect x="38" y="68" width="24" height="6" rx="3" class="em-soft"/>
    <circle cx="110" cy="52" r="10" class="em-accent2"/><rect x="98" y="68" width="24" height="6" rx="3" class="em-soft"/>
    <path d="M70 22c6-8 14-8 20 0" class="em-link"/><circle cx="80" cy="16" r="4" class="em-accent"/></svg>`,
};

/**
 * Page vide illustrée.
 * @param {{art: keyof ART, title: string, text?: string, actions?: {label: string, attrs: string, primary?: boolean}[], small?: boolean}} o
 */
export function emptyState({ art = 'meetings', title, text = '', actions = [], small = false, inline = false }) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  if (inline) return `<div class="em inline">${ART[art] || ''}<span class="em-txt"><b>${esc(title)}</b>${text ? `<small>${esc(text)}</small>` : ''}${actions.length ? `<span class="em-actions">${actions.map((a) => `<button type="button" class="btn ${a.primary ? 'primary' : ''} sm" ${a.attrs}>${esc(a.label)}</button>`).join('')}</span>` : ''}</span></div>`;
  return `<div class="em${small ? ' sm' : ''}">${ART[art] || ''}<b>${esc(title)}</b>${text ? `<small>${esc(text)}</small>` : ''}${actions.length ? `<span class="em-actions">${actions.map((a) => `<button type="button" class="btn ${a.primary ? 'primary' : ''} sm" ${a.attrs}>${esc(a.label)}</button>`).join('')}</span>` : ''}</div>`;
}
