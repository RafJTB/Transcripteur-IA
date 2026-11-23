// Onglet Calendrier (Outlook ou fichier .ics), « Prochaine réunion » de l'Accueil, enregistrement relié à la réunion, rappels.

import { History } from '../history.js';
import { Outlook } from '../outlook.js';
import { currentEvent, nextEvent, parseIcs, personName, slimEvent, weekStartOf } from '../calendar.js';
import { $, ask, esc, lsGet, lsSet, state, toast, writeClipboard } from './core.js';
import { notify } from './notifs.js';
import { openDoc } from './history.js';
import { setView } from './views.js';

const KEY = 'transcripteur.calendar';
const DAY = 86400000;
const cal = { week: 0, busy: false, error: '', reminded: new Set() };
const ICON = {
  cal: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
  mic: '<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
  join: '<svg viewBox="0 0 24 24"><path d="M15 10l5-3v10l-5-3z"/><rect x="3" y="6" width="12" height="12" rx="2"/></svg>',
  people: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><circle cx="17" cy="9" r="2.5"/><path d="M16 14.2a5 5 0 0 1 5.5 5.8"/></svg>',
  pin: '<svg viewBox="0 0 24 24"><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>',
  doc: '<svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>',
  ms: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#f25022" stroke="none" d="M3 3h8.5v8.5H3z"/><path fill="#7fba00" stroke="none" d="M12.5 3H21v8.5h-8.5z"/><path fill="#00a4ef" stroke="none" d="M3 12.5h8.5V21H3z"/><path fill="#ffb900" stroke="none" d="M12.5 12.5H21V21h-8.5z"/></svg>',
};

// ---------- Événements gardés dans ce navigateur ----------
function load() { try { return JSON.parse(localStorage.getItem(KEY) || 'null') || { events: [] }; } catch { return { events: [] }; } }
function save(c) { try { localStorage.setItem(KEY, JSON.stringify(c)); } catch { /* stockage plein */ } }
export const calendarEvents = () => load().events || [];
const remindOn = () => lsGet('calendar.remind', '1') === '1';

const fmtH = (t) => new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
const fmtDay = (t) => { const x = new Date(t).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }); return x.charAt(0).toUpperCase() + x.slice(1); };
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
const range = (e) => (e.allDay ? 'Journée' : `${fmtH(e.start)} – ${fmtH(e.end)}`);

/** Lit l'agenda Outlook (de 1 semaine avant à 6 semaines après) et le garde. */
async function refreshOutlook({ quiet = false } = {}) {
  if (!Outlook.connected() || cal.busy) return;
  cal.busy = true;
  cal.error = '';
  renderIfVisible();
  try {
    const from = weekStartOf(Date.now(), -1), to = weekStartOf(Date.now(), 6);
    const events = await Outlook.events(from, to);
    save({ source: 'outlook', account: Outlook.user()?.email || '', events, fetchedAt: Date.now() });
    if (!quiet) toast(`Agenda Outlook à jour : ${events.length} événement${events.length > 1 ? 's' : ''}.`, 'ok', 3000);
  } catch (e) {
    cal.error = e.message;
    if (!quiet || e.needSignIn) toast(e.message, 'err', 7000);
  } finally {
    cal.busy = false;
    renderIfVisible();
    renderNext();
  }
}

async function importIcs(file) {
  try {
    const text = await file.text();
    if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('Ce fichier n’est pas un calendrier (.ics).');
    const events = parseIcs(text, { from: Date.now() - 30 * DAY, to: Date.now() + 180 * DAY });
    if (Outlook.connected() && !(await ask('Remplacer l’agenda Outlook ?', 'Le fichier importé remplacera l’agenda Outlook affiché, et la connexion Microsoft sera fermée.', 'Importer'))) return;
    if (Outlook.connected()) Outlook.signOut();
    save({ source: 'ics', file: file.name, events, fetchedAt: Date.now() });
    cal.week = 0;
    toast(`${events.length} événement${events.length > 1 ? 's' : ''} importé${events.length > 1 ? 's' : ''} depuis « ${file.name} ».`, 'ok', 4000);
  } catch (e) { toast(e.message, 'err', 6000); }
  renderIfVisible();
  renderNext();
}

// ---------- Enregistrement relié à une réunion ----------
/** Réunion choisie pour le prochain enregistrement (bouton « Enregistrer » d'un événement). */
export function recordEvent(ev) {
  state.pendingEvent = ev;
  setView('record');
  renderPending();
}
/** Au démarrage d'un enregistrement : la réunion choisie, sinon celle qui a lieu maintenant. */
export function takeRecordingEvent() {
  const picked = state.pendingEvent;
  state.pendingEvent = null;
  renderPending();
  if (picked) return slimEvent(picked);
  const now = currentEvent(calendarEvents(), Date.now());
  if (now) toast(`Enregistrement relié à « ${now.title} » (calendrier).`, 'info', 4000);
  return now ? slimEvent(now) : null;
}
function renderPending() {
  const box = $('#rec-event');
  if (!box) return;
  const e = state.pendingEvent;
  box.hidden = !e;
  if (!e) return;
  box.innerHTML = `<span class="ce-ico">${ICON.cal}</span><span class="ce-txt"><small>Réunion du calendrier</small><b>${esc(e.title)}</b><small>${esc(range(e))}${e.attendees?.length ? ` · ${e.attendees.length} participant${e.attendees.length > 1 ? 's' : ''}` : ''}</small></span><button type="button" class="spc-x" data-cancel-event title="Ne pas relier" aria-label="Ne pas relier cet enregistrement à la réunion"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>`;
}

// ---------- Page Calendrier ----------
function renderIfVisible() { if (state.page === 'calendar') renderCalendar(); }

function eventRow(e, docs) {
  const now = Date.now();
  const live = !e.allDay && e.start - 10 * 60000 <= now && now < e.end;
  const past = e.end <= now;
  const linked = docs.find((d) => d.event?.id === e.id);
  const people = (e.attendees || []).filter((a) => a.email !== e.organizer?.email);
  return `<article class="cal-ev${live ? ' live' : ''}${past ? ' past' : ''}${e.allDay ? ' allday' : ''}" data-ev="${esc(e.id)}">
    <div class="ce-time"><b>${e.allDay ? 'Journée' : fmtH(e.start)}</b>${e.allDay ? '' : `<small>${fmtH(e.end)}</small>`}</div>
    <div class="ce-main">
      <strong>${esc(e.title)}</strong>
      <div class="ce-meta">${live ? '<i class="ce-live">en cours</i>' : ''}${e.online ? `<span class="ce-tag">${esc(e.online)}</span>` : ''}${e.location && !/Microsoft Teams|Teams Meeting/i.test(e.location) ? `<span>${ICON.pin}${esc(e.location)}</span>` : ''}${people.length ? `<span title="${esc(people.slice(0, 12).map(personName).join(', '))}">${ICON.people}${people.length}</span>` : ''}${e.recurring ? '<span>répétée</span>' : ''}</div>
    </div>
    <div class="ce-acts">${[
      linked ? `<button class="btn sm" type="button" data-open-doc="${esc(linked.id)}">${ICON.doc}Transcription</button>` : '',
      e.joinUrl && !past ? `<a class="btn sm" href="${esc(e.joinUrl)}" target="_blank" rel="noopener noreferrer">${ICON.join}Rejoindre</a>` : '',
      !e.allDay && !past && !linked ? `<button class="btn sm${live ? ' primary' : ''}" type="button" data-rec-ev="${esc(e.id)}">${ICON.mic}Enregistrer</button>` : '',
    ].join('')}</div>
  </article>`;
}

export async function renderCalendar() {
  const box = $('#cal-page');
  if (!box) return;
  const c = load();
  const docs = (await History.list().catch(() => [])).filter((d) => d.event?.id);
  const has = c.source && (c.source === 'ics' || Outlook.connected());
  const start = weekStartOf(Date.now(), cal.week);
  const end = start + 7 * DAY;
  const days = Array.from({ length: 7 }, (_, i) => start + i * DAY);
  const evs = (c.events || []).filter((e) => e.end > start && e.start < end);
  const today = Date.now();
  const src = c.source === 'outlook'
    ? `${ICON.ms}<span><b>Outlook</b><small>${esc(Outlook.user()?.email || c.account || '')}${c.fetchedAt ? ` · à jour ${sameDay(c.fetchedAt, today) ? `à ${fmtH(c.fetchedAt)}` : `le ${new Date(c.fetchedAt).toLocaleDateString('fr-FR')}`}` : ''}</small></span>`
    : c.source === 'ics' ? `${ICON.cal}<span><b>Fichier importé</b><small>${esc(c.file || '.ics')} · ${new Date(c.fetchedAt).toLocaleDateString('fr-FR')} (pas de mise à jour automatique)</small></span>` : '';
  const head = `<div class="cal-bar glass">
      <div class="cal-src">${has ? src : ''}</div>
      <div class="cal-nav"><button class="icon-btn" type="button" data-week="-1" aria-label="Semaine précédente"><svg viewBox="0 0 24 24"><path d="m15 6-6 6 6 6"/></svg></button><button class="btn sm" type="button" data-week="0">Aujourd’hui</button><button class="icon-btn" type="button" data-week="1" aria-label="Semaine suivante"><svg viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg></button>
        <b class="cal-range">${new Date(start).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })} – ${new Date(end - DAY).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' })}</b></div>
      <div class="cal-tools">${c.source === 'outlook' && Outlook.connected() ? `<button class="btn sm" type="button" data-cal="refresh"${cal.busy ? ' disabled' : ''}>${cal.busy ? 'Mise à jour…' : 'Actualiser'}</button>` : ''}
        <label class="cal-remind"><input type="checkbox" id="cal-remind"${remindOn() ? ' checked' : ''} /><span>Rappel 2 min avant</span></label>
        <button class="link-btn" type="button" data-cal="settings">Source</button></div>
    </div>`;
  if (!has) { box.innerHTML = setupHtml(c); return; }
  const err = cal.error ? `<p class="cal-err">${esc(cal.error)}${Outlook.connected() ? '' : ' <button class="btn xs" type="button" data-cal="connect">Se reconnecter</button>'}</p>` : '';
  box.innerHTML = head + err + `<div class="cal-week">${days.map((d) => {
    const list = evs.filter((e) => (e.allDay ? e.start < d + DAY && e.end > d : sameDay(e.start, d)));
    const isToday = sameDay(d, today);
    // Jours passés sans réunion : masqués
    if (!list.length && d + DAY <= today) return '';
    return `<section class="cal-day${isToday ? ' today' : ''}${list.length ? '' : ' is-empty'}"><h4>${esc(fmtDay(d))}${isToday ? ' <i>aujourd’hui</i>' : ''}</h4>${list.length ? list.map((e) => eventRow(e, docs)).join('') : '<p class="cal-none">Rien de prévu</p>'}</section>`;
  }).join('')}</div>` + `<section class="cal-settings glass dash-card" id="cal-settings" hidden>${setupHtml(c, true)}</section>`;
}

function setupHtml(c, inline = false) {
  const conf = Outlook.configured();
  const uri = Outlook.redirectUri();
  return `<div class="${inline ? '' : 'glass dash-card '}cal-setup">
    <header class="dash-head"><h3>${ICON.cal}Relier ton agenda</h3></header>
    <p>Tes réunions apparaissent ici ; « Enregistrer » crée la transcription avec le bon titre et les participants. L’agenda est lu en <b>lecture seule</b>, directement par ton navigateur.</p>
    <div class="cal-choices">
      <div class="cal-choice">
        <b>${ICON.ms} Outlook / Microsoft 365</b>
        <small>Mis à jour automatiquement. Un compte pro ou d’école peut demander l’accord du service informatique.</small>
        ${conf ? `<button class="btn primary" type="button" data-cal="connect">${ICON.ms}Se connecter avec Microsoft</button>` : '<p class="an-note">À faire une fois : inscrire l’appli chez Microsoft (gratuit, 10 min), voir ci-dessous.</p>'}
        ${Outlook.connected() ? `<button class="link-btn" type="button" data-cal="signout">Se déconnecter (${esc(Outlook.user()?.email || '')})</button>` : ''}
      </div>
      <div class="cal-choice">
        <b>${ICON.cal} Fichier .ics</b>
        <small>Exporté d’Outlook (Fichier → Enregistrer le calendrier), de Google Agenda… Pas de mise à jour automatique.</small>
        <label class="btn"><input type="file" id="cal-ics" accept=".ics,text/calendar" hidden />Importer un fichier .ics</label>
        ${c.source === 'ics' ? '<button class="link-btn" type="button" data-cal="clear">Retirer le calendrier importé</button>' : ''}
      </div>
    </div>
    <details class="cal-guide"${conf ? '' : ' open'}>
      <summary>Inscrire l’appli chez Microsoft${conf ? ' (déjà fait)' : ''}</summary>
      <ol>
        <li>Ouvre <a href="https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade" target="_blank" rel="noopener">Microsoft Entra → Inscriptions d’applications</a> (ou portal.azure.com) avec ton compte Microsoft, puis <b>Nouvelle inscription</b>.</li>
        <li>Nom : <i>Transcripteur IA</i>. Types de comptes : <b>comptes dans un annuaire organisationnel et comptes Microsoft personnels</b>.</li>
        <li>URI de redirection : plateforme <b>Application monopage (SPA)</b>, adresse <code>${esc(uri)}</code> <button class="btn xs" type="button" data-cal="copy-uri">Copier</button>, puis <b>Inscrire</b>.</li>
        <li>Copie l’<b>ID d’application (client)</b> et colle-le ici. Aucun secret n’est nécessaire.</li>
      </ol>
      <div class="cal-client"><input class="text-input" id="cal-client" placeholder="00000000-0000-0000-0000-000000000000" spellcheck="false" autocomplete="off" value="${esc(Outlook.clientId())}"${Outlook.fixed() ? ' disabled' : ''} /><button class="btn sm" type="button" data-cal="save-client"${Outlook.fixed() ? ' disabled' : ''}>Enregistrer</button></div>
    </details>
  </div>`;
}

// ---------- « Prochaine réunion » (Accueil) ----------
export function renderNext() {
  const box = $('#dash-next');
  if (!box) return;
  const evs = calendarEvents();
  const e = nextEvent(evs, Date.now());
  const soon = e && e.start - Date.now() < 3 * DAY;
  box.hidden = !e || !soon;
  if (box.hidden) return;
  const live = e.start - 10 * 60000 <= Date.now();
  const when = live ? (Date.now() >= e.start ? 'En cours' : `Dans ${Math.max(1, Math.round((e.start - Date.now()) / 60000))} min`) : sameDay(e.start, Date.now()) ? `Aujourd’hui à ${fmtH(e.start)}` : `${new Date(e.start).toLocaleDateString('fr-FR', { weekday: 'long' })} à ${fmtH(e.start)}`;
  box.innerHTML = `<span class="ce-ico${live ? ' live' : ''}">${ICON.cal}</span>
    <div class="dn-txt"><small>${live ? '<i class="ce-live">' + esc(when) + '</i>' : esc(when)} · prochaine réunion</small><b>${esc(e.title)}</b><small>${esc(range(e))}${e.online ? ` · ${esc(e.online)}` : ''}${e.attendees?.length ? ` · ${e.attendees.length} participant${e.attendees.length > 1 ? 's' : ''}` : ''}</small></div>
    <div class="dn-acts">${e.joinUrl ? `<a class="btn sm" href="${esc(e.joinUrl)}" target="_blank" rel="noopener noreferrer">${ICON.join}Rejoindre</a>` : ''}<button class="btn sm primary" type="button" data-rec-ev="${esc(e.id)}">${ICON.mic}Enregistrer</button><button class="icon-btn" type="button" data-nav="calendar" title="Ouvrir le calendrier" aria-label="Ouvrir le calendrier"><svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg></button></div>`;
}

// ---------- Rappels ----------
function tick() {
  renderNext();
  if (!remindOn()) return;
  const now = Date.now();
  for (const e of calendarEvents()) {
    if (e.allDay || cal.reminded.has(e.id)) continue;
    if (e.start > now && e.start - now <= 2 * 60000) {
      cal.reminded.add(e.id);
      notify({ kind: 'info', title: `Ta réunion commence : ${e.title}`, text: `${fmtH(e.start)}${e.online ? ` · ${e.online}` : ''} · ouvre la notification pour l’enregistrer.`, action: `cal:${e.id}`, system: true });
      toast(`« ${e.title} » commence à ${fmtH(e.start)} : pense à l’enregistrer.`, 'info', 8000);
    }
  }
}
/** Notification « Ta réunion commence » ouverte. */
export function openCalendarNotif(id) {
  const e = calendarEvents().find((x) => x.id === id);
  if (e) recordEvent(e);
  else setView('calendar');
}

// ---------- Démarrage ----------
/** Retour de la connexion Microsoft (à traiter avant celui de Google : même adresse). */
export async function handleCalendarReturn() {
  if (!Outlook.isReturn()) return;
  const r = await Outlook.handleRedirect();
  if (!r) return;
  // L'onglet Calendrier s'ouvre une fois l'interface prête (initCalendar)
  cal.openAfterBoot = true;
  if (!r.ok) { cal.error = r.error; toast(r.error, 'err', 9000); return; }
  toast(`Agenda Outlook relié (${r.user.email}).`, 'ok', 3000);
  cal.firstLoad = refreshOutlook({ quiet: true });
}

export function initCalendar() {
  document.addEventListener('click', async (e) => {
    const rec = e.target.closest('[data-rec-ev]');
    if (rec) { const ev = calendarEvents().find((x) => x.id === rec.dataset.recEv); if (ev) recordEvent(ev); return; }
    if (e.target.closest('[data-cancel-event]')) { state.pendingEvent = null; renderPending(); return; }
    const od = e.target.closest('[data-open-doc]');
    if (od && e.target.closest('#cal-page')) { const d = await History.get(od.dataset.openDoc); if (d) openDoc(d); return; }
    const wk = e.target.closest('#cal-page [data-week]');
    if (wk) { cal.week = wk.dataset.week === '0' ? 0 : cal.week + Number(wk.dataset.week); renderCalendar(); return; }
    const act = e.target.closest('#cal-page [data-cal]')?.dataset.cal;
    if (!act) return;
    if (act === 'refresh') return refreshOutlook();
    if (act === 'connect') return Outlook.signIn(Outlook.user()?.email || '').catch((err) => toast(err.message, 'err', 6000));
    if (act === 'signout') { Outlook.signOut(); save({ events: [] }); cal.error = ''; renderCalendar(); renderNext(); return; }
    if (act === 'clear') { save({ events: [] }); renderCalendar(); renderNext(); return; }
    if (act === 'settings') { const s = $('#cal-settings'); if (s) s.hidden = !s.hidden; return; }
    if (act === 'copy-uri') { await writeClipboard(Outlook.redirectUri()); toast('Adresse copiée.', 'ok', 2000); return; }
    if (act === 'save-client') {
      const v = $('#cal-client').value.trim();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return toast('L’ID d’application ressemble à 00000000-0000-0000-0000-000000000000.', 'warn', 5000);
      Outlook.setClientId(v);
      toast('Identifiant enregistré : tu peux te connecter.', 'ok', 3000);
      renderCalendar();
    }
  });
  document.addEventListener('change', (e) => {
    if (e.target.id === 'cal-ics' && e.target.files?.[0]) { importIcs(e.target.files[0]); e.target.value = ''; }
    if (e.target.id === 'cal-remind') { lsSet('calendar.remind', e.target.checked ? '1' : '0'); toast(e.target.checked ? 'Rappel activé : une notification 2 minutes avant chaque réunion (appli ouverte).' : 'Rappels désactivés.', 'ok', 3500); }
  });
  renderNext();
  if (cal.openAfterBoot) setView('calendar');
  setInterval(tick, 30_000);
  // Agenda Outlook relu au démarrage s'il date de plus de 30 minutes
  const c = load();
  if (c.source === 'outlook' && Outlook.connected() && Date.now() - (c.fetchedAt || 0) > 30 * 60000) refreshOutlook({ quiet: true });
}
// Pour les tests automatisés
export const _calendar = { load, save, refreshOutlook, tick };
