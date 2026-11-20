// Calendrier : fichiers .ics (format Outlook), événements Microsoft Graph, réunion en cours / prochaine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIcs, graphToEvent, currentEvent, nextEvent, wallToUtc, ianaZone, meetingLink, personName, slimEvent, weekStartOf, expandRule } from '../../js/calendar.js';

const FROM = Date.UTC(2026, 10, 1);
const TO = Date.UTC(2027, 1, 1);

// Export Outlook typique : fuseau Windows, lignes repliées, virgules échappées, Teams, répétition avec exception
const ICS = [
  'BEGIN:VCALENDAR', 'PRODID:Microsoft Exchange Server 2010', 'VERSION:2.0',
  'BEGIN:VTIMEZONE', 'TZID:Romance Standard Time', 'BEGIN:STANDARD', 'DTSTART:16010101T030000', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'END:STANDARD', 'END:VTIMEZONE',
  'BEGIN:VEVENT',
  'UID:abc-ledona',
  'SUMMARY;LANGUAGE=fr-FR:Point équipe projet Ledona',
  'DTSTART;TZID=Romance Standard Time:20261120T100000',
  'DTEND;TZID=Romance Standard Time:20261120T110000',
  'LOCATION:Réunion Microsoft Teams',
  'DESCRIPTION:Ordre du jour : scan\\, Revit\\nRejoindre : https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=%7b%7d',
  ' \\nFin',
  'ORGANIZER;CN=Raf Jeantin:mailto:raf@exemple.fr',
  'ATTENDEE;ROLE=REQ-PARTICIPANT;CN="Martin, Julie":mailto:Julie.Martin@exemple.fr',
  'ATTENDEE;CN=marc.dubois@exemple.fr:mailto:marc.dubois@exemple.fr',
  'BEGIN:VALARM', 'TRIGGER:-PT15M', 'ACTION:DISPLAY', 'END:VALARM',
  'END:VEVENT',
  // Réunion hebdomadaire lundi et mercredi, 4 fois, sauf le mercredi 25
  'BEGIN:VEVENT', 'UID:weekly-1', 'SUMMARY:Synthèse BIM',
  'DTSTART;TZID=Romance Standard Time:20261123T140000', 'DTEND;TZID=Romance Standard Time:20261123T150000',
  'RRULE:FREQ=WEEKLY;COUNT=4;BYDAY=MO,WE;WKST=MO', 'EXDATE;TZID=Romance Standard Time:20261125T140000',
  'END:VEVENT',
  // Une occurrence déplacée (lundi 30 → 16 h)
  'BEGIN:VEVENT', 'UID:weekly-1', 'SUMMARY:Synthèse BIM (décalée)', 'RECURRENCE-ID;TZID=Romance Standard Time:20261130T140000',
  'DTSTART;TZID=Romance Standard Time:20261130T160000', 'DTEND;TZID=Romance Standard Time:20261130T170000', 'END:VEVENT',
  // Journée entière, et réunion annulée, et heure UTC
  'BEGIN:VEVENT', 'UID:off', 'SUMMARY:Congés', 'DTSTART;VALUE=DATE:20261224', 'DTEND;VALUE=DATE:20261226', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:cancel', 'SUMMARY:Annulé : Réunion budget', 'STATUS:CANCELLED', 'DTSTART:20261121T090000Z', 'DTEND:20261121T100000Z', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:utc', 'SUMMARY:Point client', 'DTSTART:20261201T130000Z', 'DURATION:PT45M', 'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

test('fuseaux : Windows → IANA, heure murale → UTC (heure d’hiver et d’été)', () => {
  assert.equal(ianaZone('Romance Standard Time'), 'Europe/Paris');
  assert.equal(ianaZone('Europe/Paris'), 'Europe/Paris');
  assert.equal(ianaZone('Fuseau inconnu'), null);
  assert.equal(wallToUtc({ y: 2026, m: 11, d: 20, h: 10, mi: 0, s: 0 }, 'Europe/Paris'), Date.UTC(2026, 10, 20, 9)); // UTC+1
  assert.equal(wallToUtc({ y: 2026, m: 7, d: 1, h: 10, mi: 0, s: 0 }, 'Europe/Paris'), Date.UTC(2026, 6, 1, 8)); // UTC+2
});

test('parseIcs : réunion Outlook (titre, heure, participants, lien Teams, texte)', () => {
  const ev = parseIcs(ICS, { from: FROM, to: TO });
  const l = ev.find((e) => e.uid === 'abc-ledona');
  assert.equal(l.title, 'Point équipe projet Ledona');
  assert.equal(l.start, Date.UTC(2026, 10, 20, 9));
  assert.equal(l.end - l.start, 3600000);
  assert.equal(l.online, 'Teams');
  assert.match(l.joinUrl, /^https:\/\/teams\.microsoft\.com\/l\/meetup-join\//);
  assert.match(l.description, /scan, Revit\nRejoindre/);
  assert.match(l.description, /Fin$/, 'ligne repliée recollée');
  assert.deepEqual(l.organizer, { name: 'Raf Jeantin', email: 'raf@exemple.fr' });
  assert.deepEqual(l.attendees.map((a) => a.email), ['julie.martin@exemple.fr', 'marc.dubois@exemple.fr']);
  assert.equal(l.attendees[0].name, 'Martin, Julie');
});

test('parseIcs : répétition, exception, occurrence déplacée, annulation, journée entière, durée', () => {
  const ev = parseIcs(ICS, { from: FROM, to: TO });
  const w = ev.filter((e) => e.uid === 'weekly-1');
  // 4 occurrences (lun 23, mer 25, lun 30, mer 2) moins le mercredi 25 ; lundi 30 déplacé à 16 h
  assert.deepEqual(w.map((e) => new Date(e.start).toISOString()), ['2026-11-23T13:00:00.000Z', '2026-11-30T15:00:00.000Z', '2026-12-02T13:00:00.000Z']);
  assert.equal(w[1].title, 'Synthèse BIM (décalée)');
  assert.ok(w.every((e) => e.recurring));
  assert.ok(!ev.some((e) => e.uid === 'cancel'), 'annulée retirée');
  const off = ev.find((e) => e.uid === 'off');
  assert.ok(off.allDay);
  assert.equal(off.end - off.start, 2 * 86400000);
  const utc = ev.find((e) => e.uid === 'utc');
  assert.equal(utc.start, Date.UTC(2026, 11, 1, 13));
  assert.equal(utc.end - utc.start, 45 * 60000);
  assert.deepEqual(ev.map((e) => e.start), [...ev.map((e) => e.start)].sort((a, b) => a - b), 'trié');
  assert.equal(new Set(ev.map((e) => e.id)).size, ev.length, 'identifiants uniques');
});

test('expandRule : mensuel (2e mardi), quotidien avec fin, intervalle', () => {
  const toUtc = (w) => Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi);
  const s = { y: 2026, m: 11, d: 10, h: 9, mi: 0, s: 0 };
  const m = expandRule('FREQ=MONTHLY;BYDAY=2TU;COUNT=3', s, { toUtc });
  assert.deepEqual(m.map((w) => `${w.m}/${w.d}`), ['11/10', '12/8', '1/12']);
  const d = expandRule('FREQ=DAILY;INTERVAL=2;UNTIL=20261116T090000Z', s, { toUtc });
  assert.deepEqual(d.map((w) => w.d), [10, 12, 14, 16]);
  const last = expandRule('FREQ=MONTHLY;BYDAY=-1FR;COUNT=2', s, { toUtc });
  assert.deepEqual(last.map((w) => `${w.m}/${w.d}`), ['11/27', '12/25']);
});

test('graphToEvent : événement Outlook (Microsoft Graph)', () => {
  const g = {
    id: 'AAMk1', iCalUId: 'ical-1', subject: 'Revue de synthèse', isAllDay: false, isCancelled: false, isOnlineMeeting: true, type: 'occurrence',
    start: { dateTime: '2026-11-20T13:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-11-20T14:30:00.0000000', timeZone: 'UTC' },
    location: { displayName: 'Salle B' }, bodyPreview: 'Ordre du jour…',
    organizer: { emailAddress: { name: 'Raf', address: 'Raf@exemple.fr' } },
    attendees: [{ emailAddress: { name: 'Julie Martin', address: 'julie@exemple.fr' }, status: { response: 'accepted' } }],
    onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/xyz' }, webLink: 'https://outlook.office365.com/owa/?itemid=1',
  };
  const e = graphToEvent(g);
  assert.equal(e.start, Date.UTC(2026, 10, 20, 13));
  assert.equal(e.end, Date.UTC(2026, 10, 20, 14, 30));
  assert.equal(e.online, 'Teams');
  assert.equal(e.organizer.email, 'raf@exemple.fr');
  assert.equal(e.attendees[0].response, 'accepted');
  assert.ok(e.recurring);
  const day = graphToEvent({ id: 'x', subject: 'Salon', isAllDay: true, start: { dateTime: '2026-11-25T00:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-11-26T00:00:00.0000000', timeZone: 'UTC' } });
  assert.equal(day.start, new Date(2026, 10, 25).getTime());
  assert.equal(graphToEvent({ id: 'y', subject: 'Visio', start: { dateTime: '2026-11-20T08:00:00' }, end: { dateTime: '2026-11-20T09:00:00' }, bodyPreview: 'lien https://meet.google.com/abc-defg-hij' }).online, 'Meet');
});

test('réunion en cours, prochaine réunion', () => {
  const t = Date.UTC(2026, 10, 20, 9);
  const evs = [
    { id: 'a', title: 'A', start: t - 3600000, end: t - 60000 },
    { id: 'b', title: 'B', start: t + 5 * 60000, end: t + 3600000 },
    { id: 'c', title: 'Journée', start: t - 3600000, end: t + 8 * 3600000, allDay: true },
    { id: 'd', title: 'D', start: t + 2 * 3600000, end: t + 3 * 3600000 },
  ];
  assert.equal(currentEvent(evs, t)?.id, 'b', 'commence dans 5 min');
  assert.equal(currentEvent(evs, t, { before: 60000 }), null);
  assert.equal(nextEvent(evs, t)?.id, 'b');
  assert.equal(nextEvent(evs, t + 2 * 3600000)?.id, 'd');
});

test('outils : lien de réunion, nom lisible, résumé gardé, début de semaine', () => {
  assert.equal(meetingLink('voir https://teams.microsoft.com/l/meetup-join/abc.'), 'https://teams.microsoft.com/l/meetup-join/abc');
  assert.equal(meetingLink('rien'), '');
  assert.equal(personName({ name: 'julie.martin@exemple.fr', email: 'julie.martin@exemple.fr' }), 'Julie Martin');
  assert.equal(personName({ name: 'Marc Dubois', email: 'm@x.fr' }), 'Marc Dubois');
  const s = slimEvent({ id: '1', title: 'T', start: 1, end: 2, description: 'long', attendees: [{ name: 'A', email: 'a@x', response: 'accepted' }] });
  assert.deepEqual(Object.keys(s).sort(), ['attendees', 'end', 'id', 'joinUrl', 'location', 'online', 'organizer', 'source', 'start', 'title']);
  assert.deepEqual(s.attendees, [{ name: 'A', email: 'a@x' }]);
  const w = new Date(weekStartOf(new Date(2026, 10, 20, 15).getTime()));
  assert.equal(w.getDay(), 1);
  assert.equal(w.getDate(), 16);
});
