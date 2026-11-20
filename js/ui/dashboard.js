// Accueil (tableau de bord) et page Analyses.

import { Auth, Folders } from '../cloud.js';
import { dailyMinutes, dashStats, periodStart, speakerTotals, topicShares, weeklyMinutes } from '../insights.js';
import { extractActions } from '../actions.js';
import { speakerColor } from '../speakers.js';
import { askAssistant, askClaudeAbout, asstAbort, asstBusy, bindAssistantSettings, bindScope, lastQuestion, renderChat, setScope } from './assistant.js';
import { $, $$, CLAUDE_ICON, DAY_MS, esc, fmtHours, fmtShortDur, modelById, relDay, state, store, toast } from './core.js';
import { sendToClaude } from './doc.js';
import { openDoc } from './history.js';
import { bindPerso, renderModelsPage } from './pages.js';
import { player, selectTab } from './recording.js';
import { renderAutoInfo } from './sound.js';
import { initSpaces } from './spaces.js';
import { myDocs } from './transcription.js';
import { setDocTab, setView, toggleSheet } from './views.js';

/** Petite pastille d'évolution (« ↑ 3 cette sem. »). */
const trend = (txt, kind = 'up') => (txt ? `<span class="trend ${kind}">${kind === 'up' ? '↑' : kind === 'down' ? '↓' : ''} ${esc(txt)}</span>` : '');

export const STAT_ICONS = {
  docs: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  time: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  people: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><circle cx="17" cy="9" r="2.5"/><path d="M16 14.2a5 5 0 0 1 5.5 5.8"/></svg>',
  star: '<svg viewBox="0 0 24 24"><path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"/></svg>',
};
const statTile = (cls, icon, value, label, extra = '') => `<div class="glass stat-tile ${cls}"><span class="st-ico">${icon}</span><div><b>${esc(value)}</b><small>${esc(label)}${extra}</small></div></div>`;

function statTiles(docs, st) {
  const folders = Folders.list().length;
  const people = speakerTotals(docs).filter((p) => !p.unknown).length;
  const dConf = st.confWeek != null && st.confPrev != null ? Math.round((st.confWeek - st.confPrev) * 100) : null;
  return [
    statTile('t-violet', STAT_ICONS.docs, String(st.count), 'Transcriptions', trend(st.countWeek ? `${st.countWeek} cette sem.` : '')),
    statTile('t-blue', STAT_ICONS.time, st.seconds ? fmtHours(st.seconds) : '0 h', 'Audio traité', trend(st.secondsWeek >= 60 ? `${fmtHours(st.secondsWeek)} cette sem.` : '')),
    folders
      ? statTile('t-indigo', STAT_ICONS.people, String(folders), folders > 1 ? 'Projets' : 'Projet')
      : statTile('t-indigo', STAT_ICONS.people, String(people), people > 1 ? 'Voix connues' : 'Voix connue'),
    statTile('t-amber', STAT_ICONS.star, st.conf != null ? `${Math.round(st.conf * 100)} %` : '—', 'Compréhension', dConf ? trend(`${Math.abs(dConf)} pts`, dConf > 0 ? 'up' : 'down') : ''),
  ].join('');
}

/** Icône d'un projet, d'après les mots de son titre. */
export function docIcon(title) {
  const t = String(title).toLowerCase();
  if (/chantier|gros|œuvre|oeuvre|visite|opr|réception/.test(t)) return ['amber', '<svg viewBox="0 0 24 24"><path d="M4 18h16M6 18v-3a6 6 0 0 1 12 0v3M12 9V6M9.5 9.5 8 7M14.5 9.5 16 7"/></svg>'];
  if (/formation|cours|tuto|webinaire|conférence/.test(t)) return ['blue', '<svg viewBox="0 0 24 24"><path d="m2 9 10-5 10 5-10 5z"/><path d="M6 11v5c3 2 9 2 12 0v-5M22 9v6"/></svg>'];
  if (/bim|maquette|synthèse|coordination|revit|ifc|modèle|clash/.test(t)) return ['violet', '<svg viewBox="0 0 24 24"><path d="M4 21V5l8-3v19M12 9l8 3v9M2 21h20M7 8h2M7 12h2M7 16h2M15 14h2M15 17h2"/></svg>'];
  if (/équipe|point|réunion|meeting|call|visio|daily/.test(t)) return ['indigo', STAT_ICONS.people];
  return ['slate', '<svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></svg>'];
}

const STATUS = (d) => (d.status === 'running' || d.status === 'live' ? ['run', 'En cours'] : d.status === 'interrupted' ? ['warn', 'Interrompue'] : ['ok', 'Terminée']);

function recentRows(docs) {
  if (!docs.length) return '<p class="dash-empty">Aucune transcription pour l’instant. Lance ta première avec « Nouvelle transcription ».</p>';
  return docs.slice(0, 12).map((d) => {
    const [tone, icon] = docIcon(d.title);
    const [sk, sl] = STATUS(d);
    const n = d.speakers?.length || 0;
    const meta = [relDay(d.createdAt), d.durationS ? fmtShortDur(d.durationS) : null, n > 1 ? `${n} intervenants` : null].filter(Boolean).join(' · ');
    return `<div class="recent-row" data-doc="${esc(d.id)}" tabindex="0">
      <span class="r-ico ${tone}">${icon}</span>
      <div class="r-main"><b>${esc(d.title)}</b><small><svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/></svg>${esc(meta)}</small></div>
      <span class="r-status ${sk}">${sk === 'ok' ? '<svg viewBox="0 0 24 24"><path d="m5 12 5 5 9-10"/></svg>' : ''}${sl}</span>
      <div class="r-acts">
        <button class="r-btn" type="button" data-act="play" title="Écouter" aria-label="Écouter"${d.audioId ? '' : ' disabled'}><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></button>
        <button class="r-btn" type="button" data-act="open" title="Ouvrir la transcription" aria-label="Ouvrir"><svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></svg></button>
        <button class="r-btn ghost" type="button" data-act="more" title="Plus" aria-label="Plus d’options"><svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg></button>
      </div>
    </div>`;
  }).join('');
}

/** Courbe lissée (Catmull-Rom → Bézier) pour la mini-courbe. */
function smoothPath(pts) {
  if (pts.length < 2) return '';
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0]},${p2[1].toFixed(1)}`;
  }
  return d;
}

function sparkline(days) {
  const W = 220, H = 70, pad = 8;
  const max = Math.max(...days.map((d) => d.minutes), 1);
  const pts = days.map((d, i) => [Math.round(pad + (i * (W - 2 * pad)) / (days.length - 1)), H - pad - (d.minutes / max) * (H - 2 * pad - 14)]);
  const line = smoothPath(pts);
  const peak = days.reduce((b, d, i) => (d.minutes > days[b].minutes ? i : b), 0);
  const [px, py] = pts[peak];
  const label = days[peak].minutes ? fmtShortDur(days[peak].minutes * 60) : '';
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
    <defs><linearGradient id="spk-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".35"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>
    <path d="${line} L${pts[pts.length - 1][0]},${H} L${pts[0][0]},${H} Z" fill="url(#spk-fill)" stroke="none"/>
    <path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2.2" vector-effect="non-scaling-stroke"/>
    ${label ? `<line x1="${px}" x2="${px}" y1="${py}" y2="${H}" stroke="var(--accent)" stroke-dasharray="2 3" stroke-opacity=".5" vector-effect="non-scaling-stroke"/><circle cx="${px}" cy="${py}" r="4" fill="var(--card-solid)" stroke="var(--accent)" stroke-width="2" vector-effect="non-scaling-stroke"/>` : ''}
  </svg>${label ? `<span class="spark-tip" style="left:${(px / W) * 100}%">${esc(label)}</span>` : ''}`;
}

const TOPIC_COLORS = ['#8b7cff', '#c4b5fd', '#6d5dfc', '#a5b4fc'];

/** Donut SVG (parts 0..1) */
function donutSvg(parts, colors, { gap = 0.8 } = {}) {
  const R = 15.915;
  let off = 0;
  return `<circle cx="21" cy="21" r="${R}" stroke="rgb(var(--ov) / 0.08)"/>` + parts.map((v, i) => {
    const pct = v * 100;
    const len = Math.max(0, pct - (parts.length > 1 ? gap : 0));
    const c = `<circle cx="21" cy="21" r="${R}" stroke="${colors[i % colors.length]}" stroke-dasharray="${len} ${100 - len}" stroke-dashoffset="${-off}"/>`;
    off += pct;
    return c;
  }).join('');
}

export function actionSources(docs) {
  return docs.map((d) => {
    const st = d.actionState || {};
    const items = extractActions(d.segments || [], { speakers: d.speakers || [], meetingTime: d.createdAt })
      .filter((x) => st[x.key] !== 'hidden')
      .map((x) => ({ ...x, done: st[x.key] === 'done' }));
    return { doc: d, items };
  });
}

function insightsHtml(docs) {
  const now = Date.now();
  const st = dashStats(docs, now);
  const days = dailyMinutes(docs, 7, now);
  const delta = st.secondsPrev > 0 ? Math.round(((st.secondsWeek - st.secondsPrev) / st.secondsPrev) * 100) : null;
  const topics = topicShares(docs.slice(0, 40));
  const week = actionSources(docs.filter((d) => d.createdAt >= now - 7 * DAY_MS));
  const prev = actionSources(docs.filter((d) => d.createdAt >= now - 14 * DAY_MS && d.createdAt < now - 7 * DAY_MS));
  const nAct = week.reduce((a, s) => a + s.items.filter((x) => x.type === 'action').length, 0);
  const nPrev = prev.reduce((a, s) => a + s.items.filter((x) => x.type === 'action').length, 0);
  const nOpen = week.reduce((a, s) => a + s.items.filter((x) => x.type === 'action' && !x.done).length, 0);
  const aDelta = nPrev > 0 ? Math.round(((nAct - nPrev) / nPrev) * 100) : null;
  return `
    <div class="ins-col">
      <h4>Temps d’audio traité</h4>
      <div class="ins-big"><b>${st.secondsWeek ? fmtHours(st.secondsWeek) : '0 min'}</b>${delta != null ? trend(`${Math.abs(delta)} %`, delta >= 0 ? 'up' : 'down') : ''}</div>
      <small class="ins-sub">${delta != null ? 'vs semaine précédente' : 'ces 7 derniers jours'}</small>
      <div class="spark-wrap">${sparkline(days)}</div>
    </div>
    <div class="ins-col">
      <h4>Sujets principaux</h4>
      ${topics.length ? `<div class="ins-topics"><svg class="mini-donut" viewBox="0 0 42 42" aria-hidden="true">${donutSvg(topics.map((t) => t.share), TOPIC_COLORS)}</svg>
        <ul class="legend">${topics.slice(0, 3).map((t, i) => `<li style="--spk:${TOPIC_COLORS[i]}"><i class="dot"></i><span>${esc(t.label)}</span><b>${Math.round(t.share * 100)} %</b></li>`).join('')}</ul></div>`
      : '<p class="dash-empty sm">Les sujets apparaissent après quelques transcriptions.</p>'}
    </div>
    <div class="ins-col">
      <h4>Actions extraites</h4>
      <div class="ins-big"><b>${nAct}</b>${aDelta != null && aDelta !== 0 ? trend(`${Math.abs(aDelta)} %`, aDelta > 0 ? 'up' : 'down') : ''}</div>
      <small class="ins-sub">ces 7 derniers jours${nAct ? ` · ${nOpen} à faire` : ''}</small>
      <button class="link-btn more-link" type="button" data-nav="analytics">Voir les actions en cours<svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg></button>
    </div>`;
}

export function helloText() {
  const h = new Date().getHours();
  const name = Auth.user()?.name?.split(/[\s@]/)[0];
  return `${h >= 18 || h < 5 ? 'Bonsoir' : 'Bonjour'}${name ? ` ${name}` : ''} ! 👋`;
}

let dashToken = 0;
export async function renderDashboard() {
  const t = ++dashToken;
  const docs = await myDocs();
  if (t !== dashToken) return;
  $('#hero-hello').textContent = helloText();
  $('#dash-stats').innerHTML = statTiles(docs, dashStats(docs));
  $('#dash-recent').innerHTML = recentRows(docs);
  $('#dash-insights').innerHTML = insightsHtml(docs);
  renderQuick(docs);
}

/** Panneau « Analyse rapide » : temps de parole par personne sur la période. */
export async function renderQuick(docs = null) {
  docs ??= await myDocs();
  const range = $('#quick-range').value;
  const from = periodStart(range);
  const list = speakerTotals(docs.filter((d) => d.createdAt >= from));
  const total = list.reduce((a, p) => a + p.seconds, 0);
  const top = list.filter((p) => !p.unknown).slice(0, 3);
  const rest = total - top.reduce((a, p) => a + p.seconds, 0);
  const rows = [...top.map((p, i) => ({ name: p.name, s: p.seconds, c: speakerColor(i) })), ...(rest > 0 ? [{ name: top.length ? 'Autres' : 'Non identifiés', s: rest, c: 'rgb(var(--ov) / 0.35)' }] : [])];
  $('#quick-donut').innerHTML = total ? donutSvg(rows.map((r) => r.s / total), rows.map((r) => r.c)) : donutSvg([], []);
  $('#quick-total').textContent = total ? fmtShortDur(total) : '—';
  $('#quick-legend').innerHTML = total
    ? rows.map((r) => `<li style="--spk:${r.c}"><i class="dot"></i><span>${esc(r.name)}</span><b>${Math.round((r.s / total) * 100)} %</b></li>`).join('')
    : `<li class="none">${docs.length ? 'Lance « Qui parle ? » sur une réunion pour voir qui parle le plus.' : 'Rien sur cette période.'}</li>`;
}

export function bindDashboard() {
  $('#dash-new').onclick = () => { setView('record'); selectTab('mic'); };
  $('#dash-import').onclick = () => { setView('record'); selectTab('file'); $('#file-input').click(); };
  $('#dash-recent').addEventListener('click', async (e) => {
    const row = e.target.closest('.recent-row');
    if (!row) return;
    const act = e.target.closest('[data-act]')?.dataset.act || 'open';
    const d = (await myDocs()).find((x) => x.id === row.dataset.doc);
    if (!d) return;
    if (act === 'more') return openRecentMenu(e.target.closest('[data-act]'), d);
    openDoc(d);
    if (act === 'play' && d.audioId) {
      const t0 = Date.now();
      const tick = () => {
        if (state.audio?.audioId === d.audioId && player?.loaded) player.audio.play().catch(() => {});
        else if (Date.now() - t0 < 8000) setTimeout(tick, 150);
      };
      tick();
    }
  });
  $('#dash-recent').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.classList.contains('recent-row')) e.target.click(); });
  $('#quick-range').onchange = () => renderQuick();
  $('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (asstBusy) return asstAbort?.();
    const q = $('#chat-input').value;
    $('#chat-input').value = '';
    askAssistant(q);
  });
  $('#chat').addEventListener('click', async (e) => {
    const s = e.target.closest('[data-q]');
    if (s) return askAssistant(s.dataset.q);
    if (e.target.closest('[data-claude]')) return askClaudeAbout(lastQuestion);
    const o = e.target.closest('[data-open]');
    if (!o) return;
    const d = (await myDocs()).find((x) => x.id === o.dataset.open);
    if (!d) return;
    openDoc(d);
    const i = Number(o.dataset.i);
    requestAnimationFrame(() => {
      const row = $$('#transcript .segment')[i];
      row?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      row?.classList.add('flash');
      setTimeout(() => row?.classList.remove('flash'), 1300);
    });
  });
  $$('#an-range [data-range]').forEach((b) => (b.onclick = () => {
    $$('#an-range [data-range]').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
    renderAnalytics();
  }));
  $('#an-actions').addEventListener('click', async (e) => {
    const o = e.target.closest('[data-open]');
    if (!o) return;
    const d = (await myDocs()).find((x) => x.id === o.dataset.open);
    if (d) { openDoc(d); setDocTab('actions'); }
  });
  $('#models-page').addEventListener('click', (e) => {
    const b = e.target.closest('[data-use]');
    if (!b) return;
    const r = $(`#models input[value="${b.dataset.use}"]`);
    if (!r || r.disabled) return;
    r.checked = true;
    r.dispatchEvent(new Event('change', { bubbles: true }));
    store.set('model.manual', '1');
    renderAutoInfo();
    renderModelsPage();
    toast(`Modèle « ${modelById(b.dataset.use).label} » choisi pour les prochaines transcriptions.`, 'ok', 3500);
  });
  $$('.dash-close').forEach((b) => (b.onclick = () => toggleSheet(false)));
  // Ctrl + K : recherche
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#hist-search').focus(); }
  });
  renderChat();
  bindAssistantSettings();
  bindPerso();
  bindScope();
  initSpaces();
}

function openRecentMenu(btn, d) {
  $('#recent-pop')?.remove();
  const pop = document.createElement('div');
  pop.id = 'recent-pop';
  pop.className = 'recent-pop';
  pop.innerHTML = `<button type="button" data-m="open">Ouvrir</button><button type="button" data-m="actions">Décisions et actions</button><button type="button" data-m="claude">${CLAUDE_ICON}Résumer avec Claude</button><button type="button" data-m="ask">Interroger l’assistant</button>`;
  document.body.appendChild(pop);
  const r = btn.getBoundingClientRect();
  pop.style.top = `${Math.min(innerHeight - 140, r.bottom + 6)}px`;
  pop.style.left = `${Math.max(12, r.right - 210)}px`;
  const close = (e) => { if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener('pointerdown', close, true); } };
  setTimeout(() => document.addEventListener('pointerdown', close, true));
  pop.onclick = (e) => {
    const m = e.target.closest('[data-m]')?.dataset.m;
    if (!m) return;
    pop.remove();
    if (m === 'ask') {
      setScope({ type: 'doc', id: d.id, label: d.title });
      if (matchMedia('(max-width: 760px)').matches) toggleSheet(true);
      return;
    }
    openDoc(d);
    if (m === 'actions') setDocTab('actions');
    if (m === 'claude') setTimeout(() => sendToClaude(), 50);
  };
}

// ---------- Page Analyses ----------
export async function renderAnalytics() {
  const docs = await myDocs();
  const range = $('#an-range [aria-selected="true"]')?.dataset.range || 'month';
  const sel = docs.filter((d) => d.createdAt >= periodStart(range));
  const secs = sel.reduce((a, d) => a + (d.durationS || 0), 0);
  const src = actionSources(sel);
  const acts = src.flatMap((s) => s.items.filter((x) => x.type === 'action').map((x) => ({ ...x, doc: s.doc })));
  const decs = src.reduce((a, s) => a + s.items.filter((x) => x.type === 'decision').length, 0);
  const open = acts.filter((x) => !x.done);
  $('#an-stats').innerHTML = [
    statTile('t-violet', STAT_ICONS.docs, String(sel.length), sel.length > 1 ? 'Transcriptions' : 'Transcription'),
    statTile('t-blue', STAT_ICONS.time, secs ? fmtHours(secs) : '0 h', 'Audio traité'),
    statTile('t-indigo', STAT_ICONS.check, `${acts.length - open.length}/${acts.length}`, 'Actions faites'),
    statTile('t-amber', STAT_ICONS.star, String(decs), decs > 1 ? 'Décisions' : 'Décision'),
  ].join('');
  // Semaines
  const weeks = weeklyMinutes(docs, 8);
  const wmax = Math.max(...weeks.map((w) => w.minutes), 1);
  $('#an-weeks').innerHTML = weeks.map((w) => `<div class="an-bar" title="${w.count} transcription${w.count > 1 ? 's' : ''} · ${fmtShortDur(w.minutes * 60)}"><span style="height:${Math.max(2, (w.minutes / wmax) * 100)}%"></span><small>${new Date(w.week).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })}</small><b>${w.minutes ? fmtShortDur(w.minutes * 60) : ''}</b></div>`).join('');
  // Intervenants
  const sp = speakerTotals(sel);
  const stot = sp.reduce((a, p) => a + p.seconds, 0) || 1;
  $('#an-speakers').innerHTML = sp.length
    ? `<ul class="an-list">${sp.slice(0, 8).map((p, i) => `<li style="--spk:${p.unknown ? 'rgb(var(--ov) / 0.35)' : speakerColor(i)}"><span><i class="dot"></i>${esc(p.name)}</span><div class="bar-in"><i style="width:${Math.round((p.seconds / stot) * 100)}%"></i></div><b>${fmtShortDur(p.seconds)}</b></li>`).join('')}</ul>`
    : '<p class="dash-empty">Pas encore d’intervenants reconnus sur cette période.</p>';
  // Sujets
  const tp = topicShares(sel);
  $('#an-topics').innerHTML = tp.length
    ? `<div class="ins-topics big"><svg class="mini-donut" viewBox="0 0 42 42" aria-hidden="true">${donutSvg(tp.map((t) => t.share), TOPIC_COLORS)}</svg><ul class="legend">${tp.map((t, i) => `<li style="--spk:${TOPIC_COLORS[i]}"><i class="dot"></i><span>${esc(t.label)}</span><b>${Math.round(t.share * 100)} %</b></li>`).join('')}</ul></div><p class="an-note">D’après les mots-clés entendus (BIM, technique, organisation, chantier).</p>`
    : '<p class="dash-empty">Pas assez de texte sur cette période.</p>';
  // Actions en cours
  $('#an-actions-sum').textContent = acts.length ? `${open.length} à faire sur ${acts.length}` : '';
  $('#an-actions').innerHTML = open.length
    ? `<ul class="an-acts">${open.slice(0, 30).map((x) => `<li><button type="button" data-open="${esc(x.doc.id)}"><span class="a-txt">${esc(x.text)}</span><span class="a-meta">${x.who ? `<i class="act-who"><i class="dot"></i>${esc(x.who)}</i>` : ''}${x.date ? `<i class="act-due">${esc(x.date.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' }))}</i>` : ''}<small>${esc(x.doc.title)} · ${relDay(x.doc.createdAt)}</small></span></button></li>`).join('')}</ul>`
    : `<p class="dash-empty">${acts.length ? 'Tout est fait sur cette période. 👏' : 'Aucune action repérée sur cette période.'}</p>`;
}
