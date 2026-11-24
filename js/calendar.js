// Calendrier : lecture des fichiers .ics (export Outlook, Google…) et des événements Microsoft Graph.
// Fonctions pures, testables seules. Toutes les heures sont converties en millisecondes UTC.

const DAY = 86400000;

/** Fuseaux Windows (exports Outlook) → fuseaux IANA. */
const WINDOWS_TZ = {
  'Romance Standard Time': 'Europe/Paris', 'W. Europe Standard Time': 'Europe/Berlin', 'Central Europe Standard Time': 'Europe/Budapest',
  'Central European Standard Time': 'Europe/Warsaw', 'GMT Standard Time': 'Europe/London', 'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'E. Europe Standard Time': 'Europe/Chisinau', 'FLE Standard Time': 'Europe/Kyiv', 'GTB Standard Time': 'Europe/Bucharest',
  'Russian Standard Time': 'Europe/Moscow', 'Morocco Standard Time': 'Africa/Casablanca', 'W. Central Africa Standard Time': 'Africa/Lagos',
  'Eastern Standard Time': 'America/New_York', 'Central Standard Time': 'America/Chicago', 'Mountain Standard Time': 'America/Denver',
  'Pacific Standard Time': 'America/Los_Angeles', 'Atlantic Standard Time': 'America/Halifax', 'SA Pacific Standard Time': 'America/Bogota',
  'E. South America Standard Time': 'America/Sao_Paulo', 'Arabian Standard Time': 'Asia/Dubai', 'India Standard Time': 'Asia/Kolkata',
  'China Standard Time': 'Asia/Shanghai', 'Singapore Standard Time': 'Asia/Singapore', 'Tokyo Standard Time': 'Asia/Tokyo',
  'AUS Eastern Standard Time': 'Australia/Sydney', 'New Zealand Standard Time': 'Pacific/Auckland', 'Mauritius Standard Time': 'Indian/Mauritius',
  'SA Western Standard Time': 'America/La_Paz', 'UTC': 'UTC', 'Coordinated Universal Time': 'UTC',
};

/** Nom de fuseau utilisable par le navigateur (ou null : heure locale). */
export function ianaZone(tzid) {
  if (!tzid) return null;
  const t = String(tzid).replace(/^"|"$/g, '').trim();
  const z = WINDOWS_TZ[t] || t.replace(/^\/[^/]+\/[^/]+\//, ''); // « /mozilla.org/20050126_1/Europe/Paris »
  try { new Intl.DateTimeFormat('en-US', { timeZone: z }); return z; } catch { return null; }
}

/** Décalage (ms) du fuseau `tz` à l'instant `t` (UTC). */
function offsetAt(t, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - Math.floor(t / 1000) * 1000;
}

/** Heure « murale » {y, m, d, h, mi, s} dans un fuseau → instant UTC (ms). Sans fuseau : heure locale de l'appareil. */
export function wallToUtc(w, tz) {
  if (tz === 'UTC') return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s);
  if (!tz) return new Date(w.y, w.m - 1, w.d, w.h, w.mi, w.s).getTime();
  const guess = Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s);
  let t = guess - offsetAt(guess, tz);
  t = guess - offsetAt(t, tz); // deuxième passe : changements d'heure
  return t;
}

/** Valeur de date iCalendar (20261120T140000[Z] ou 20261120) → heure murale. */
function parseIcsDate(v) {
  const m = String(v).match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  return { y: +m[1], m: +m[2], d: +m[3], h: +(m[4] || 0), mi: +(m[5] || 0), s: +(m[6] || 0), utc: !!m[7], date: !m[4] };
}

/** Lignes iCalendar dépliées → [{name, params, value}]. */
function icsLines(text) {
  const raw = String(text).replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const out = [];
  for (const line of raw) {
    if (!line.trim()) continue;
    // NOM;PARAM=…;PARAM="…:…":valeur (les deux-points entre guillemets ne coupent pas)
    let i = 0, q = false;
    for (; i < line.length; i++) { const c = line[i]; if (c === '"') q = !q; else if (c === ':' && !q) break; }
    const head = line.slice(0, i), value = line.slice(i + 1);
    const parts = head.match(/(?:[^;"]|"[^"]*")+/g) || [head];
    const params = {};
    for (const p of parts.slice(1)) { const k = p.indexOf('='); if (k > 0) params[p.slice(0, k).toUpperCase()] = p.slice(k + 1).replace(/^"|"$/g, ''); }
    out.push({ name: parts[0].toUpperCase(), params, value });
  }
  return out;
}
const unescapeText = (s) => String(s || '').replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1').trim();

/** Lien Teams (ou Meet / Zoom) trouvé dans un texte. */
export function meetingLink(...texts) {
  for (const t of texts) {
    const m = String(t || '').match(/https:\/\/(?:teams\.microsoft\.com\/l\/meetup-join|teams\.live\.com\/meet)\/[^\s"<>)]+/i)
      || String(t || '').match(/https:\/\/(?:meet\.google\.com\/[a-z-]+|[a-z0-9.-]*zoom\.us\/j\/[^\s"<>)]+)/i);
    if (m) return m[0].replace(/[.,;]+$/, '');
  }
  return '';
}
const kindOf = (url) => (/teams\./i.test(url) ? 'Teams' : /meet\.google/i.test(url) ? 'Meet' : /zoom\.us/i.test(url) ? 'Zoom' : '');

const WD = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const addDays = (w, n) => { const d = new Date(Date.UTC(w.y, w.m - 1, w.d + n)); return { ...w, y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() }; };
const weekday = (w) => new Date(Date.UTC(w.y, w.m - 1, w.d)).getUTCDay();
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/**
 * Dates d'une règle de répétition (RRULE), en heure murale, à partir du début.
 * Gère FREQ DAILY / WEEKLY / MONTHLY / YEARLY, INTERVAL, COUNT, UNTIL, BYDAY (dont « 2TU », « -1FR »), BYMONTHDAY.
 */
export function expandRule(rule, start, { until = Infinity, limit = 730, toUtc }) {
  const r = Object.fromEntries(String(rule).split(';').map((p) => p.split('=')).filter((p) => p[0]).map(([k, v]) => [k.toUpperCase(), v]));
  const freq = r.FREQ, interval = Math.max(1, +r.INTERVAL || 1), count = r.COUNT ? +r.COUNT : Infinity;
  let end = until;
  if (r.UNTIL) { const u = parseIcsDate(r.UNTIL); if (u) end = Math.min(end, u.utc ? Date.UTC(u.y, u.m - 1, u.d, u.h, u.mi, u.s) : toUtc(u.date ? { ...u, h: 23, mi: 59, s: 59 } : u)); }
  const byday = (r.BYDAY || '').split(',').filter(Boolean).map((x) => { const m = x.match(/^([+-]?\d+)?([A-Z]{2})$/); return m ? { n: m[1] ? +m[1] : 0, wd: WD.indexOf(m[2]) } : null; }).filter(Boolean);
  const bymd = (r.BYMONTHDAY || '').split(',').filter(Boolean).map(Number);
  const out = [];
  const push = (w) => {
    const t = toUtc(w);
    if (t < toUtc(start)) return true;
    if (t > end || out.length >= count) return false;
    out.push(w);
    return out.length < limit;
  };
  if (freq === 'DAILY') {
    for (let w = start; ; w = addDays(w, interval)) if (!push(w)) break;
  } else if (freq === 'WEEKLY') {
    const days = byday.length ? byday.map((b) => b.wd).sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)) : [weekday(start)];
    // Semaines commençant le lundi (WKST=MO, la valeur d'Outlook)
    let monday = addDays(start, -((weekday(start) + 6) % 7));
    for (let guard = 0; guard < 5000; guard++, monday = addDays(monday, 7 * interval)) {
      let go = true;
      for (const wd of days) { if (!push(addDays(monday, (wd + 6) % 7))) { go = false; break; } }
      if (!go) break;
    }
  } else if (freq === 'MONTHLY' || freq === 'YEARLY') {
    let y = start.y, m = start.m;
    for (let guard = 0; guard < 2000; guard++) {
      const cands = [];
      if (byday.length) {
        for (const b of byday) {
          const all = [];
          for (let d = 1; d <= daysInMonth(y, m); d++) if (weekday({ y, m, d }) === b.wd) all.push(d);
          const pick = b.n > 0 ? [all[b.n - 1]] : b.n < 0 ? [all[all.length + b.n]] : all;
          for (const d of pick) if (d) cands.push(d);
        }
      } else for (const d of bymd.length ? bymd : [start.d]) { const dd = d < 0 ? daysInMonth(y, m) + d + 1 : d; if (dd >= 1 && dd <= daysInMonth(y, m)) cands.push(dd); }
      let go = true;
      if (freq === 'MONTHLY' || m === start.m) for (const d of [...new Set(cands)].sort((a, b) => a - b)) { if (!push({ ...start, y, m, d })) { go = false; break; } }
      if (!go) break;
      if (freq === 'MONTHLY') { m += interval; while (m > 12) { m -= 12; y++; } } else y += interval;
    }
  } else push(start);
  return out;
}

/**
 * Lit un fichier .ics et renvoie les événements entre `from` et `to` (répétitions dépliées, annulations retirées).
 * @returns {object[]} événements triés par début
 */
export function parseIcs(text, { from = Date.now() - 30 * DAY, to = Date.now() + 120 * DAY } = {}) {
  const lines = icsLines(text);
  const vevents = [];
  let cur = null, depth = 0;
  for (const l of lines) {
    if (l.name === 'BEGIN' && l.value.toUpperCase() === 'VEVENT') { cur = { props: [] }; depth = 0; continue; }
    if (!cur) continue;
    if (l.name === 'BEGIN') { depth++; continue; } // VALARM…
    if (l.name === 'END' && depth) { depth--; continue; }
    if (l.name === 'END' && l.value.toUpperCase() === 'VEVENT') { vevents.push(cur); cur = null; continue; }
    if (!depth) cur.props.push(l);
  }
  const base = [];
  const overrides = new Map(); // uid → Map(instant d'origine → événement modifié)
  for (const v of vevents) {
    const get = (n) => v.props.find((p) => p.name === n);
    const all = (n) => v.props.filter((p) => p.name === n);
    const ds = get('DTSTART');
    if (!ds) continue;
    const tz = ianaZone(ds.params.TZID);
    const sw = parseIcsDate(ds.value);
    if (!sw) continue;
    const allDay = sw.date || ds.params.VALUE === 'DATE';
    const toUtc = (w) => (allDay ? new Date(w.y, w.m - 1, w.d).getTime() : w.utc ? Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) : wallToUtc(w, tz));
    const de = get('DTEND');
    let dur;
    if (de) {
      const ew = parseIcsDate(de.value);
      const etz = ianaZone(de.params.TZID) || tz;
      const e = ew && (allDay ? new Date(ew.y, ew.m - 1, ew.d).getTime() : ew.utc ? Date.UTC(ew.y, ew.m - 1, ew.d, ew.h, ew.mi, ew.s) : wallToUtc(ew, etz));
      dur = e ? e - toUtc(sw) : 3600000;
    } else {
      const m = String(get('DURATION')?.value || '').match(/P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?/);
      dur = m && m[0] !== 'P' ? (((+m[1] || 0) * 7 + (+m[2] || 0)) * 86400 + (+m[3] || 0) * 3600 + (+m[4] || 0) * 60 + (+m[5] || 0)) * 1000 : allDay ? DAY : 3600000;
    }
    const desc = unescapeText(get('DESCRIPTION')?.value);
    const loc = unescapeText(get('LOCATION')?.value);
    const person = (p) => ({ name: unescapeText(p.params.CN || '') || String(p.value).replace(/^mailto:/i, ''), email: String(p.value).replace(/^mailto:/i, '').toLowerCase() });
    const link = meetingLink(get('X-MICROSOFT-SKYPETEAMSMEETINGURL')?.value, get('URL')?.value, loc, desc);
    const ev = {
      uid: get('UID')?.value || `${sw.y}${sw.m}${sw.d}${sw.h}${sw.mi}-${unescapeText(get('SUMMARY')?.value)}`,
      title: unescapeText(get('SUMMARY')?.value) || '(Sans titre)',
      allDay,
      dur: Math.max(0, dur),
      location: loc,
      description: desc.slice(0, 2000),
      organizer: get('ORGANIZER') ? person(get('ORGANIZER')) : null,
      attendees: all('ATTENDEE').map(person),
      joinUrl: link,
      online: kindOf(link),
      cancelled: /CANCELLED/i.test(get('STATUS')?.value || '') || /^(annulé|canceled|cancelled)\s*:/i.test(unescapeText(get('SUMMARY')?.value)),
      source: 'ics',
    };
    const rid = get('RECURRENCE-ID');
    if (rid) {
      const rw = parseIcsDate(rid.value);
      const rt = rw && (rw.utc ? Date.UTC(rw.y, rw.m - 1, rw.d, rw.h, rw.mi, rw.s) : allDay ? new Date(rw.y, rw.m - 1, rw.d).getTime() : wallToUtc(rw, ianaZone(rid.params.TZID) || tz));
      if (!overrides.has(ev.uid)) overrides.set(ev.uid, new Map());
      overrides.get(ev.uid).set(rt, { ...ev, start: toUtc(sw) });
      continue;
    }
    const ex = new Set(all('EXDATE').flatMap((p) => p.value.split(',').map((x) => { const w = parseIcsDate(x); return w && (w.utc ? Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) : wallToUtc(w, ianaZone(p.params.TZID) || tz)); })));
    const rule = get('RRULE')?.value;
    const starts = rule ? expandRule(rule, sw, { until: to + DAY, toUtc }).map(toUtc) : [toUtc(sw)];
    for (const s of starts) if (!ex.has(s)) base.push({ ...ev, start: s, recurring: !!rule });
  }
  // Occurrences modifiées (heure ou titre changés, ou annulées une seule fois)
  const out = [];
  for (const e of base) {
    const o = overrides.get(e.uid)?.get(e.start);
    if (o) { overrides.get(e.uid).delete(e.start); out.push({ ...o, recurring: true }); } else out.push(e);
  }
  for (const m of overrides.values()) for (const o of m.values()) out.push({ ...o, recurring: true });
  return out
    .map(({ dur, ...e }) => ({ ...e, end: e.start + dur, id: `${e.uid}@${e.start}` }))
    .filter((e) => !e.cancelled && e.end > from && e.start < to)
    .sort((a, b) => a.start - b.start);
}

/** Lien web sûr (https uniquement), sinon chaîne vide. */
export const safeUrl = (u) => (/^https:\/\/[^\s"'<>]+$/i.test(String(u || '').trim()) ? String(u).trim() : '');

/** Événement Microsoft Graph (calendarView, heures en UTC) → événement de l'appli. */
export function graphToEvent(g) {
  const utc = (x) => {
    if (!x?.dateTime) return null;
    const tz = x.timeZone && x.timeZone !== 'UTC' ? ianaZone(x.timeZone) : 'UTC';
    const m = x.dateTime.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
    return m ? wallToUtc({ y: +m[1], m: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +m[6] }, tz) : Date.parse(x.dateTime);
  };
  let start = utc(g.start), end = utc(g.end);
  if (g.isAllDay) {
    // Journée entière : la date compte, pas l'heure (affichée dans le fuseau de l'appareil)
    const d = (x) => { const m = x?.dateTime?.match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? new Date(+m[1], +m[2] - 1, +m[3]).getTime() : null; };
    start = d(g.start); end = d(g.end);
  }
  const link = safeUrl(g.onlineMeeting?.joinUrl) || meetingLink(g.location?.displayName, g.bodyPreview, g.body?.content);
  const who = (a) => ({ name: a?.emailAddress?.name || a?.emailAddress?.address || '', email: String(a?.emailAddress?.address || '').toLowerCase() });
  return {
    id: g.id,
    uid: g.iCalUId || g.id,
    title: g.subject || '(Sans titre)',
    start, end,
    allDay: !!g.isAllDay,
    location: g.location?.displayName || '',
    description: String(g.bodyPreview || '').slice(0, 2000),
    organizer: g.organizer ? who(g.organizer) : null,
    attendees: (g.attendees || []).map((a) => ({ ...who(a), response: a.status?.response || '' })),
    joinUrl: link || '',
    online: kindOf(link) || (g.isOnlineMeeting ? 'Teams' : ''),
    webLink: safeUrl(g.webLink),
    recurring: g.type === 'occurrence' || g.type === 'exception',
    cancelled: !!g.isCancelled,
    source: 'outlook',
  };
}

/** Réunion en cours (ou qui commence dans les `before` ms) à l'instant `now`. Les journées entières sont ignorées. */
export function currentEvent(events, now = Date.now(), { before = 10 * 60000 } = {}) {
  const live = events.filter((e) => !e.allDay && !e.cancelled && e.start - before <= now && now < e.end);
  // La plus proche de son début
  return live.sort((a, b) => Math.abs(now - a.start) - Math.abs(now - b.start))[0] || null;
}

/** Prochaine réunion (en cours ou à venir), hors journées entières. */
export function nextEvent(events, now = Date.now()) {
  return events.filter((e) => !e.allDay && !e.cancelled && e.end > now).sort((a, b) => a.start - b.start)[0] || null;
}

/** Ce qu'on garde d'un événement dans une transcription. */
export const slimEvent = (e) => e && ({ id: e.id, title: e.title, start: e.start, end: e.end, location: e.location || '', joinUrl: e.joinUrl || '', online: e.online || '', organizer: e.organizer || null, attendees: (e.attendees || []).slice(0, 40).map(({ name, email }) => ({ name, email })), source: e.source });

/** Prénom + nom lisible d'un participant (« Julie Martin », sinon la partie avant @). */
export const personName = (p) => {
  const n = String(p?.name || '').trim();
  if (n && !n.includes('@')) return n;
  const local = String(p?.email || n).split('@')[0];
  return local.split(/[._-]+/).filter(Boolean).map((x) => x[0].toUpperCase() + x.slice(1)).join(' ');
};

/** Lundi 0 h (heure locale) de la semaine qui contient `t`, décalée de `offset` semaines. */
export function weekStartOf(t = Date.now(), offset = 0) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + offset * 7);
  return d.getTime();
}
