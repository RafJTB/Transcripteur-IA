// Formats d'export : texte brut, Markdown, SRT.

const pad = (n, w = 2) => String(Math.floor(n)).padStart(w, '0');

export function fmtClock(s) {
  s = Math.max(0, s || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

function fmtSrt(s) {
  s = Math.max(0, s || 0);
  const ms = Math.round((s - Math.floor(s)) * 1000);
  return `${pad(s / 3600)}:${pad((s % 3600) / 60)}:${pad(s % 60)},${pad(ms, 3)}`;
}

/** Nom de l'intervenant d'une phrase (si « Qui parle ? » a été lancé), sinon null. */
const who = (s, names) => (names && s.spk != null && names[s.spk]) || null;

/**
 * Texte continu : regroupe les segments en paragraphes (pause > 2 s, ~600 caractères,
 * ou changement d'intervenant). Avec `names`, chaque paragraphe commence par « Nom : ».
 */
export function toParagraphs(segments, names = null) {
  const paras = [];
  let cur = '';
  let curWho = null;
  let prevEnd = null;
  const flush = () => { if (cur) paras.push(curWho ? `${curWho} : ${cur}` : cur); cur = ''; };
  for (const s of segments) {
    const t = s.text.trim();
    if (!t) continue;
    const w = who(s, names);
    if (cur && (w !== curWho || (prevEnd != null && s.start - prevEnd > 2) || cur.length > 600)) flush();
    curWho = w;
    cur = cur ? `${cur} ${t}` : t;
    prevEnd = s.end;
  }
  flush();
  return paras;
}

export function toTxt(segments, { timestamps, speakers = null }) {
  if (timestamps) return segments.map((s) => `[${fmtClock(s.start)}] ${who(s, speakers) ? `${who(s, speakers)} : ` : ''}${s.text.trim()}`).join('\n') + '\n';
  return toParagraphs(segments, speakers).join('\n\n') + '\n';
}

export function toMarkdown(segments, { timestamps, title, meta, speakers = null }) {
  const head = [`# ${title}`, '', meta ? `> ${meta}` : '', ''].filter((l, i) => l || i !== 2);
  const bold = (p) => p.replace(/^([^:\n]{1,40}) : /, '**$1 :** ');
  const body = timestamps
    ? segments.map((s) => `**${fmtClock(s.start)}** — ${who(s, speakers) ? `**${who(s, speakers)} :** ` : ''}${s.text.trim()}`).join('\n\n')
    : toParagraphs(segments, speakers).map((p) => (speakers ? bold(p) : p)).join('\n\n');
  return `${head.join('\n')}\n${body}\n`;
}

export function toSrt(segments, { speakers = null } = {}) {
  return segments
    .filter((s) => s.text.trim())
    .map((s, i) => `${i + 1}\n${fmtSrt(s.start)} --> ${fmtSrt(Math.max(s.end, s.start + 0.5))}\n${who(s, speakers) ? `${who(s, speakers)} : ` : ''}${s.text.trim()}\n`)
    .join('\n');
}

export function download(filename, content, mime) {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export function safeFilename(s) {
  return (s || 'transcription').replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 60) || 'transcription';
}
