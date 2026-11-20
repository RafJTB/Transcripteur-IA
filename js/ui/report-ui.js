// Compte rendu de la réunion ouverte : fenêtre d'options, puis Word (.docx) ou PDF (impression).

import { Folders } from '../cloud.js';
import { download, safeFilename } from '../exporters.js';
import { loadPerso } from '../perso.js';
import { DEFAULT_ACCENT, DOCX_URL, buildReport, reportDocx, reportHtml } from '../report.js';
import { $, lsGet, lsSet, state, toast } from './core.js';
import { shownSegments } from './doc.js';
import { docActions } from './doc-tabs.js';
import { setDocTab } from './views.js';

const KEY = 'transcripteur.report';
const OPTIONS = [
  ['summary', 'Résumé', 'le texte de l’onglet Résumé IA'],
  ['actions', 'Décisions et actions', 'relevé de l’onglet Actions (qui, quoi, pour quand)'],
  ['transcript', 'Transcription en annexe', 'tout le texte, avec les intervenants'],
  ['timestamps', 'Heures dans la transcription', 'repères 00:12:30 devant chaque intervention'],
];
const loadOpts = () => { try { return { summary: true, actions: true, transcript: true, timestamps: false, ...JSON.parse(lsGet(KEY, '{}')) }; } catch { return {}; } };
const accent = () => loadPerso().accent || DEFAULT_ACCENT;

/** Contenu du compte rendu de la réunion ouverte. */
function currentReport(include) {
  const d = state.doc;
  return buildReport(d, { segments: shownSegments(), actions: docActions(d), folder: Folders.get(d.folderId)?.name || '', include });
}

let docxLib = null;
async function makeDocx(include) {
  docxLib ??= await import(DOCX_URL);
  const r = currentReport(include);
  const blob = await reportDocx(r, docxLib, { accent: accent() });
  download(`${safeFilename(`Compte rendu ${r.title}`)}.docx`, blob, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
}

/** PDF : la page du compte rendu est imprimée ; le navigateur propose « Enregistrer au format PDF ». */
function makePdf(include) {
  const r = currentReport(include);
  const frame = document.createElement('iframe');
  frame.className = 'report-frame';
  frame.setAttribute('aria-hidden', 'true');
  frame.srcdoc = reportHtml(r, { accent: accent() });
  const title = document.title;
  const restore = () => { document.title = title; setTimeout(() => frame.remove(), 1000); };
  frame.onload = () => {
    // Le nom proposé pour le PDF reprend le titre de la page
    document.title = `Compte rendu - ${r.title}`;
    frame.contentWindow.addEventListener('afterprint', restore, { once: true });
    frame.contentWindow.focus();
    frame.contentWindow.print();
    setTimeout(restore, 60_000);
  };
  document.body.append(frame);
}

/** Fenêtre d'options, puis le format choisi. */
export function openReport() {
  const d = state.doc;
  if (!d || !state.segments.length) return;
  const opts = loadOpts();
  const hasSummary = !!d.summary?.trim();
  const m = document.createElement('div');
  m.className = 'modal';
  m.innerHTML = `<div class="modal-box report-box" role="dialog" aria-modal="true" aria-labelledby="rep-h">
    <h3 id="rep-h">Compte rendu</h3>
    <p>Un document propre à envoyer après la réunion, fabriqué sur ton appareil.</p>
    <div class="rep-opts">${OPTIONS.map(([k, label, sub]) => {
      const off = k === 'summary' && !hasSummary;
      return `<label class="rep-opt${off ? ' off' : ''}"><input type="checkbox" data-opt="${k}"${opts[k] && !off ? ' checked' : ''}${off ? ' disabled' : ''} /><span><b>${label}</b><small>${off ? 'pas encore de résumé : <button type="button" class="link-btn" data-go-summary>en écrire un ou le demander à Claude</button>' : sub}</small></span></label>`;
    }).join('')}</div>
    <div class="modal-actions"><button class="btn" type="button" data-x>Annuler</button><button class="btn" type="button" data-fmt="pdf">PDF</button><button class="btn primary" type="button" data-fmt="docx">Word (.docx)</button></div>
  </div>`;
  const close = () => m.remove();
  const read = () => Object.fromEntries(OPTIONS.map(([k]) => [k, !!m.querySelector(`[data-opt="${k}"]`)?.checked]));
  const sync = () => { m.querySelector('[data-opt="timestamps"]').disabled = !m.querySelector('[data-opt="transcript"]').checked; };
  m.addEventListener('change', sync);
  m.addEventListener('click', async (e) => {
    if (e.target === m || e.target.closest('[data-x]')) return close();
    if (e.target.closest('[data-go-summary]')) { close(); return setDocTab('summary'); }
    const b = e.target.closest('[data-fmt]');
    if (!b) return;
    const include = read();
    if (!hasSummary) include.summary = opts.summary; // garder le choix pour la prochaine fois
    lsSet(KEY, JSON.stringify(include));
    if (!hasSummary) include.summary = false;
    if (b.dataset.fmt === 'pdf') { close(); return makePdf(include); }
    b.disabled = true;
    b.textContent = 'Préparation…';
    try {
      await makeDocx(include);
      close();
      toast('Compte rendu Word téléchargé.', 'ok', 3000);
    } catch (err) {
      console.warn(err);
      b.disabled = false;
      b.textContent = 'Word (.docx)';
      toast(/fetch|import|network/i.test(String(err?.message || err)) ? 'Impossible de charger l’outil Word (connexion ?). Le PDF fonctionne sans connexion.' : `Le compte rendu Word n’a pas pu être créé : ${err?.message || err}`, 'err', 6000);
    }
  });
  m.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  document.body.append(m);
  sync();
  m.querySelector('[data-fmt="docx"]').focus();
}

export function bindReport() {
  $('#btn-report')?.addEventListener('click', () => { $('#export-menu').open = false; openReport(); });
  $('#act-report')?.addEventListener('click', openReport);
}
