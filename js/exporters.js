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

/** Texte continu : regroupe les segments en paragraphes (pause > 2 s ou ~600 caractères). */
export function toParagraphs(segments) {
  const paras = [];
  let cur = '';
  let prevEnd = null;
  for (const s of segments) {
    const t = s.text.trim();
    if (!t) continue;
    if (cur && ((prevEnd != null && s.start - prevEnd > 2) || cur.length > 600)) {
      paras.push(cur);
      cur = '';
    }
    cur = cur ? `${cur} ${t}` : t;
    prevEnd = s.end;
  }
  if (cur) paras.push(cur);
  return paras;
}

export function toTxt(segments, { timestamps }) {
  if (timestamps) return segments.map((s) => `[${fmtClock(s.start)}] ${s.text.trim()}`).join('\n') + '\n';
  return toParagraphs(segments).join('\n\n') + '\n';
}

export function toMarkdown(segments, { timestamps, title, meta }) {
  const head = [`# ${title}`, '', meta ? `> ${meta}` : '', ''].filter((l, i) => l || i !== 2);
  const body = timestamps
    ? segments.map((s) => `**${fmtClock(s.start)}** — ${s.text.trim()}`).join('\n\n')
    : toParagraphs(segments).join('\n\n');
  return `${head.join('\n')}\n${body}\n`;
}

export function toSrt(segments) {
  return segments
    .filter((s) => s.text.trim())
    .map((s, i) => `${i + 1}\n${fmtSrt(s.start)} --> ${fmtSrt(Math.max(s.end, s.start + 0.5))}\n${s.text.trim()}\n`)
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
