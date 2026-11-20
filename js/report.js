// Compte rendu de réunion : contenu (fonctions pures), puis mise en page Word (.docx) ou page à imprimer en PDF.
// Tout est fabriqué sur l'appareil. La bibliothèque « docx » est chargée seulement pour l'export Word.

export const DOCX_URL = 'https://cdn.jsdelivr.net/npm/docx@9.15.2/+esm';
export const DEFAULT_ACCENT = '#6a58f6';

const pad = (n) => String(n).padStart(2, '0');
export const fmtTime = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600);
  return h ? `${h}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}` : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
};
export const fmtDuration = (s) => {
  const m = Math.round((s || 0) / 60);
  if (m < 1) return 'moins d’une minute';
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${pad(m % 60)}`;
};
const fmtDay = (t) => new Date(t).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const fmtHour = (t) => new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
const fmtDue = (d) => new Date(d).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** Phrases regroupées en interventions (même personne, pas de longue pause), avec l'heure de début. */
export function transcriptBlocks(segments, names = null) {
  const out = [];
  let cur = null;
  for (const s of segments || []) {
    const t = String(s.text || '').trim();
    if (!t || s.tentative) continue;
    const who = (names && s.spk != null && names[s.spk]) || null;
    if (cur && cur.who === who && s.start - cur.end <= 2 && cur.text.length < 700) {
      cur.text += ` ${t}`;
      cur.end = s.end ?? s.start;
    } else {
      cur = { who, start: s.start || 0, end: s.end ?? s.start ?? 0, text: t };
      out.push(cur);
    }
  }
  return out.map(({ end, ...b }) => b);
}

/**
 * Résumé (souvent en Markdown, par exemple collé depuis Claude) → blocs simples.
 * @returns {{type: 'h'|'li'|'p', text: string}[]}
 */
export function mdBlocks(text) {
  const out = [];
  let para = [];
  const flush = () => { if (para.length) out.push({ type: 'p', text: para.join(' ') }); para = []; };
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line || /^(-{3,}|\*{3,}|_{3,})$/.test(line)) { flush(); continue; }
    const h = line.match(/^#{1,6}\s+(.*)$/) || line.match(/^\*\*([^*]+)\*\*\s*:?$/);
    const li = line.match(/^(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (h) { flush(); out.push({ type: 'h', text: h[1].replace(/\s*:$/, '') }); }
    else if (li) { flush(); out.push({ type: 'li', text: li[1] }); }
    else para.push(line);
  }
  flush();
  return out;
}

/** Texte avec **gras** → morceaux [{text, bold}]. */
export function inlineRuns(text) {
  const out = [];
  const re = /\*\*(.+?)\*\*/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), bold: false });
    out.push({ text: m[1], bold: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), bold: false });
  return out.map((r) => ({ ...r, text: r.text.replace(/(^|\s)\*([^*]+)\*(?=\s|$|[.,;:])/g, '$1$2').replace(/`/g, '') }));
}

/**
 * Contenu du compte rendu.
 * @param {object} doc la réunion (titre, date, durée, intervenants, résumé…)
 * @param {{segments?: object[], actions?: object[], folder?: string, include?: object, now?: number}} o
 *   actions : relevé de l'onglet Actions (extractActions + état fait / retiré)
 *   include : { summary, actions, transcript, timestamps }
 */
export function buildReport(doc, { segments = doc.segments || [], actions = [], folder = '', include = {}, now = Date.now() } = {}) {
  const inc = { summary: true, actions: true, transcript: true, timestamps: false, ...include };
  const names = (doc.speakers || []).map((p) => p?.name).filter(Boolean);
  const speaking = new Set(segments.map((s) => s.spk).filter((x) => x != null));
  const participants = (doc.speakers || []).filter((p, i) => p?.name && (!speaking.size || speaking.has(i))).map((p) => p.name);
  const shown = actions.filter((x) => !x.hidden);
  const due = (x) => (x.date ? fmtDue(x.date) : x.due ? x.due : '');
  return {
    title: doc.title || 'Réunion',
    date: doc.createdAt || now,
    dateText: cap(fmtDay(doc.createdAt || now)),
    timeText: fmtHour(doc.createdAt || now),
    duration: doc.durationS ? fmtDuration(doc.durationS) : '',
    participants: participants.filter((n) => !/^Personne \d+$/.test(n)).length ? participants : [],
    unnamed: participants.length && participants.every((n) => /^Personne \d+$/.test(n)) ? participants.length : 0,
    folder,
    source: doc.source || '',
    summary: inc.summary && doc.summary?.trim() ? mdBlocks(doc.summary) : [],
    decisions: inc.actions ? shown.filter((x) => x.type === 'decision').map((x) => ({ text: x.text, who: x.who || '', start: x.start })) : [],
    actions: inc.actions ? shown.filter((x) => x.type === 'action').map((x) => ({ text: x.text, who: x.who || '', due: due(x), done: !!x.done, start: x.start })) : [],
    transcript: inc.transcript ? transcriptBlocks(segments, names.length > 1 ? names : null) : [],
    include: inc,
    generated: now,
  };
}

/** Lignes d'informations (en-tête). */
export function metaRows(r) {
  return [
    ['Date', `${r.dateText} · ${r.timeText}`],
    r.duration && ['Durée', r.duration],
    r.participants.length ? ['Participants', r.participants.join(', ')] : r.unnamed ? ['Participants', `${r.unnamed} personnes`] : null,
    r.folder && ['Projet', r.folder],
  ].filter(Boolean);
}

const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const inlineHtml = (t) => inlineRuns(t).map((r) => (r.bold ? `<b>${esc(r.text)}</b>` : esc(r.text))).join('');

/** Page HTML à imprimer (ou à enregistrer en PDF), format A4. */
export function reportHtml(r, { accent = DEFAULT_ACCENT } = {}) {
  const meta = metaRows(r).map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
  let summary = '';
  if (r.summary.length) {
    let html = '';
    let list = false;
    for (const b of r.summary) {
      if (b.type === 'li') { if (!list) { html += '<ul>'; list = true; } html += `<li>${inlineHtml(b.text)}</li>`; continue; }
      if (list) { html += '</ul>'; list = false; }
      html += b.type === 'h' ? `<h3>${inlineHtml(b.text)}</h3>` : `<p>${inlineHtml(b.text)}</p>`;
    }
    if (list) html += '</ul>';
    summary = `<section><h2>Résumé</h2>${html}</section>`;
  }
  const decisions = r.include.actions ? `<section><h2>Décisions</h2>${r.decisions.length ? `<ul class="dec">${r.decisions.map((d) => `<li>${esc(d.text)}${d.who ? ` <span class="who">(${esc(d.who)})</span>` : ''}</li>`).join('')}</ul>` : '<p class="none">Aucune décision repérée.</p>'}</section>` : '';
  const actions = r.include.actions ? `<section><h2>Actions</h2>${r.actions.length ? `<table class="act"><thead><tr><th>Action</th><th>Responsable</th><th>Échéance</th><th>État</th></tr></thead><tbody>${r.actions.map((a) => `<tr${a.done ? ' class="done"' : ''}><td>${esc(a.text)}</td><td>${esc(a.who || '—')}</td><td>${esc(a.due || '—')}</td><td>${a.done ? 'Fait' : 'À faire'}</td></tr>`).join('')}</tbody></table>` : '<p class="none">Aucune action repérée.</p>'}</section>` : '';
  const transcript = r.transcript.length ? `<section class="annex"><h2>Annexe · Transcription</h2>${r.transcript.map((b) => `<p>${r.include.timestamps ? `<span class="t">${fmtTime(b.start)}</span> ` : ''}${b.who ? `<b>${esc(b.who)} :</b> ` : ''}${esc(b.text)}</p>`).join('')}</section>` : '';
  const gen = new Date(r.generated).toLocaleDateString('fr-FR');
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${esc(`Compte rendu - ${r.title}`)}</title><style>
@page { size: A4; margin: 18mm 16mm 18mm; @bottom-left { content: "Compte rendu · ${esc(r.title).replace(/"/g, '')}"; font: 8pt system-ui, sans-serif; color: #8a8f98; } @bottom-right { content: counter(page) " / " counter(pages); font: 8pt system-ui, sans-serif; color: #8a8f98; } }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; font: 10.5pt/1.5 "Segoe UI", system-ui, -apple-system, Roboto, Arial, sans-serif; color: #1d2129; }
header { border-left: 4px solid ${accent}; padding: 2px 0 2px 14px; margin-bottom: 16px; }
.kicker { margin: 0; font-size: 8.5pt; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; color: ${accent}; }
h1 { margin: 4px 0 0; font-size: 20pt; line-height: 1.2; }
dl { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 24px; margin: 0 0 22px; padding: 12px 14px; background: #f4f5f8; border-radius: 8px; }
dl div { min-width: 0; } dt { font-size: 8pt; text-transform: uppercase; letter-spacing: .06em; color: #6b7280; } dd { margin: 1px 0 0; font-weight: 600; }
section { margin: 0 0 18px; }
h2 { margin: 0 0 8px; padding-bottom: 4px; font-size: 13pt; color: ${accent}; border-bottom: 1px solid #e3e5ea; break-after: avoid; }
h3 { margin: 12px 0 4px; font-size: 11pt; break-after: avoid; }
p { margin: 0 0 6px; } ul { margin: 0 0 8px; padding-left: 20px; } li { margin: 2px 0; }
.who { color: #6b7280; } .none { color: #6b7280; font-style: italic; }
table { width: 100%; border-collapse: collapse; font-size: 9.5pt; } th { text-align: left; font-size: 8pt; text-transform: uppercase; letter-spacing: .05em; color: #6b7280; border-bottom: 1.5px solid #d6d9df; padding: 5px 6px; }
td { padding: 6px; border-bottom: 1px solid #eceef2; vertical-align: top; } tr { break-inside: avoid; } td:nth-child(2), td:nth-child(3), td:nth-child(4) { white-space: nowrap; width: 1%; }
tr.done td { color: #6b7280; } tr.done td:first-child { text-decoration: line-through; }
.annex { break-before: page; } .annex p { font-size: 9.5pt; } .t { color: ${accent}; font-variant-numeric: tabular-nums; font-size: 8.5pt; }
footer { margin-top: 24px; font-size: 8pt; color: #8a8f98; }
</style></head><body>
<header><p class="kicker">Compte rendu de réunion</p><h1>${esc(r.title)}</h1></header>
<dl>${meta}</dl>
${summary}${decisions}${actions}${transcript}
<footer>Compte rendu généré le ${gen} par Transcripteur IA, à partir d’une transcription automatique : à relire avant diffusion.</footer>
</body></html>`;
}

/**
 * Document Word (.docx).
 * @param {object} r compte rendu (buildReport)
 * @param {object} D module « docx »
 * @returns {Promise<Blob>}
 */
export async function reportDocx(r, D, { accent = DEFAULT_ACCENT } = {}) {
  const color = accent.replace('#', '').toUpperCase();
  const GREY = '6B7280';
  const runs = (t, o = {}) => inlineRuns(t).map((x) => new D.TextRun({ text: x.text, bold: x.bold || o.bold, color: o.color, size: o.size, italics: o.italics }));
  const P = (children, o = {}) => new D.Paragraph({ children, spacing: { after: 100 }, ...o });
  const H2 = (text) => new D.Paragraph({ heading: D.HeadingLevel.HEADING_2, keepNext: true, children: [new D.TextRun({ text, color, bold: true, size: 26 })], spacing: { before: 280, after: 120 }, border: { bottom: { style: D.BorderStyle.SINGLE, size: 4, color: 'E3E5EA', space: 2 } } });
  const none = (t) => P([new D.TextRun({ text: t, italics: true, color: GREY })]);
  const cellBorder = { top: { style: D.BorderStyle.NONE, size: 0, color: 'FFFFFF' }, left: { style: D.BorderStyle.NONE, size: 0, color: 'FFFFFF' }, right: { style: D.BorderStyle.NONE, size: 0, color: 'FFFFFF' }, bottom: { style: D.BorderStyle.SINGLE, size: 4, color: 'ECEEF2' } };
  const cell = (children, o = {}) => new D.TableCell({ children: Array.isArray(children) ? children : [children], borders: cellBorder, margins: { top: 80, bottom: 80, left: 100, right: 100 }, ...o });

  const body = [
    new D.Paragraph({ children: [new D.TextRun({ text: 'COMPTE RENDU DE RÉUNION', bold: true, color, size: 17, characterSpacing: 30 })], spacing: { after: 60 } }),
    new D.Paragraph({ heading: D.HeadingLevel.TITLE, children: [new D.TextRun({ text: r.title, bold: true, size: 40 })], spacing: { after: 240 } }),
  ];
  // Informations
  const rows = metaRows(r).map(([k, v]) => new D.TableRow({ children: [
    cell(P([new D.TextRun({ text: k.toUpperCase(), size: 16, color: GREY })], { spacing: { after: 0 } }), { width: { size: 22, type: D.WidthType.PERCENTAGE }, shading: { fill: 'F4F5F8', type: D.ShadingType.CLEAR, color: 'auto' } }),
    cell(P([new D.TextRun({ text: v, bold: true })], { spacing: { after: 0 } }), { shading: { fill: 'F4F5F8', type: D.ShadingType.CLEAR, color: 'auto' } }),
  ] }));
  if (rows.length) body.push(new D.Table({ rows, width: { size: 100, type: D.WidthType.PERCENTAGE } }));
  // Résumé
  if (r.summary.length) {
    body.push(H2('Résumé'));
    for (const b of r.summary) {
      if (b.type === 'h') body.push(new D.Paragraph({ keepNext: true, children: runs(b.text, { bold: true, size: 22 }), spacing: { before: 160, after: 60 } }));
      else if (b.type === 'li') body.push(new D.Paragraph({ children: runs(b.text), numbering: { reference: 'puces', level: 0 }, spacing: { after: 40 } }));
      else body.push(P(runs(b.text)));
    }
  }
  if (r.include.actions) {
    body.push(H2('Décisions'));
    if (r.decisions.length) for (const d of r.decisions) body.push(new D.Paragraph({ numbering: { reference: 'puces', level: 0 }, spacing: { after: 40 }, children: [new D.TextRun(d.text), ...(d.who ? [new D.TextRun({ text: ` (${d.who})`, color: GREY })] : [])] }));
    else body.push(none('Aucune décision repérée.'));
    body.push(H2('Actions'));
    if (r.actions.length) {
      const head = ['Action', 'Responsable', 'Échéance', 'État'].map((t) => cell(P([new D.TextRun({ text: t.toUpperCase(), size: 16, color: GREY, bold: true })], { spacing: { after: 0 } })));
      const lines = r.actions.map((a) => new D.TableRow({ cantSplit: true, children: [
        cell(P([new D.TextRun({ text: a.text, strike: a.done, color: a.done ? GREY : undefined })], { spacing: { after: 0 } }), { width: { size: 58, type: D.WidthType.PERCENTAGE } }),
        cell(P([new D.TextRun(a.who || '—')], { spacing: { after: 0 } })),
        cell(P([new D.TextRun(a.due || '—')], { spacing: { after: 0 } })),
        cell(P([new D.TextRun({ text: a.done ? 'Fait' : 'À faire', color: a.done ? GREY : color, bold: !a.done })], { spacing: { after: 0 } })),
      ] }));
      body.push(new D.Table({ rows: [new D.TableRow({ tableHeader: true, children: head }), ...lines], width: { size: 100, type: D.WidthType.PERCENTAGE } }));
    } else body.push(none('Aucune action repérée.'));
  }
  if (r.transcript.length) {
    body.push(new D.Paragraph({ children: [new D.PageBreak()] }));
    body.push(H2('Annexe · Transcription'));
    for (const b of r.transcript) {
      body.push(new D.Paragraph({ spacing: { after: 80 }, children: [
        ...(r.include.timestamps ? [new D.TextRun({ text: `${fmtTime(b.start)}  `, color, size: 18 })] : []),
        ...(b.who ? [new D.TextRun({ text: `${b.who} : `, bold: true, size: 20 })] : []),
        new D.TextRun({ text: b.text, size: 20 }),
      ] }));
    }
  }
  body.push(new D.Paragraph({ spacing: { before: 360 }, children: [new D.TextRun({ text: `Compte rendu généré le ${new Date(r.generated).toLocaleDateString('fr-FR')} par Transcripteur IA, à partir d’une transcription automatique : à relire avant diffusion.`, size: 16, color: '8A8F98' })] }));

  const footer = new D.Footer({ children: [new D.Paragraph({ alignment: D.AlignmentType.RIGHT, children: [
    new D.TextRun({ text: `Compte rendu · ${r.title}    `, size: 16, color: '8A8F98' }),
    new D.TextRun({ children: [D.PageNumber.CURRENT, ' / ', D.PageNumber.TOTAL_PAGES], size: 16, color: '8A8F98' }),
  ] })] });
  const doc = new D.Document({
    creator: 'Transcripteur IA',
    title: `Compte rendu - ${r.title}`,
    styles: { default: { document: { run: { font: 'Calibri', size: 21, color: '1D2129' }, paragraph: { spacing: { line: 276 } } } } },
    numbering: { config: [{ reference: 'puces', levels: [{ level: 0, format: D.LevelFormat.BULLET, text: '•', alignment: D.AlignmentType.LEFT, style: { paragraph: { indent: { left: 360, hanging: 240 } } } }] }] },
    sections: [{ properties: { page: { margin: { top: 1020, bottom: 1020, left: 1000, right: 1000 } } }, footers: { default: footer }, children: body }],
  });
  return D.Packer.toBlob(doc);
}
