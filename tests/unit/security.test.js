// Sécurité : données reçues d'autres personnes (espaces) ou de services (calendrier), politique de sécurité de la page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sanitizeSharedDoc } from '../../js/spaces.js';
import { safeUrl, graphToEvent, meetingLink } from '../../js/calendar.js';

test('réunion partagée forgée : seuls les champs connus, bons types, tailles limitées', () => {
  const evil = JSON.parse(JSON.stringify({
    title: 'Point <img src=x onerror=alert(1)>', createdAt: 'pas un nombre', durationS: 60, language: 'fr"><script>',
    status: 'running', job: { modelId: 'turbo' }, audioId: 'aud-de-quelqu-un', owner: 'victime@exemple.fr', folderId: 'f1', audioWhere: 'drive',
    remoteSeen: false, verify: { changes: [{ before: '<b>' }] }, liveLag: { avg: '<script>' }, inconnu: 'x',
    segments: [{ text: { toString: 1 }, start: '3', spk: 999, conf: 7, lang: 'fr<', tr: 42 }, null, { text: 'Bonjour', start: 1, end: 2, spk: 1, conf: 0.8 }],
    speakers: [{ name: 'Raf', emb: [1, 2, 3] }, { name: { x: 1 } }],
    event: { title: 'Réunion', start: 1, end: 2, attendees: [{ email: 'client@x.fr' }], joinUrl: 'javascript:alert(1)' },
    actionState: { a: 'done', b: 'pwned', c: { x: 1 } }, actionWho: { a: 'Julie', b: 5 },
    __proto__: { polluted: true },
  }));
  const c = sanitizeSharedDoc(evil);
  for (const k of ['status', 'job', 'audioId', 'owner', 'folderId', 'audioWhere', 'remoteSeen', 'verify', 'liveLag', 'inconnu']) assert.ok(!(k in c), `champ ${k} retiré`);
  assert.equal(c.createdAt, undefined);
  assert.equal(c.language, undefined);
  assert.equal(c.title, 'Point <img src=x onerror=alert(1)>'); // texte gardé tel quel : il est échappé à l'affichage
  assert.equal(c.segments.length, 2);
  assert.equal(typeof c.segments[0].text, 'string');
  assert.equal(c.segments[0].start, 0);
  assert.ok(!('spk' in c.segments[0]) && !('lang' in c.segments[0]) && !('tr' in c.segments[0]));
  assert.ok(!('conf' in c.segments[0]) || c.segments[0].conf <= 1);
  assert.deepEqual(c.segments[1], { text: 'Bonjour', start: 1, end: 2, spk: 1, conf: 0.8 });
  assert.deepEqual(c.speakers, [{ name: 'Raf' }, { name: 'Personne 2' }]);
  assert.deepEqual(c.event, { title: 'Réunion', start: 1, end: 2 });
  assert.deepEqual(c.actionState, { a: 'done' });
  assert.deepEqual(c.actionWho, { a: 'Julie' });
  assert.equal({}.polluted, undefined, 'pas de pollution de prototype');
  assert.equal(sanitizeSharedDoc(null).segments.length, 0);
  assert.equal(sanitizeSharedDoc({ segments: Array(60000).fill({ text: 'a', start: 0 }) }).segments.length, 50000);
});

test('liens : https uniquement', () => {
  assert.equal(safeUrl('https://teams.microsoft.com/l/meetup-join/x'), 'https://teams.microsoft.com/l/meetup-join/x');
  for (const u of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,<script>', 'http://exemple.fr', 'https://x" onmouseover="a', '', null]) assert.equal(safeUrl(u), '', String(u));
  const e = graphToEvent({ id: '1', subject: 'x', start: { dateTime: '2026-11-20T08:00:00', timeZone: 'UTC' }, end: { dateTime: '2026-11-20T09:00:00', timeZone: 'UTC' }, onlineMeeting: { joinUrl: 'javascript:alert(document.cookie)' }, webLink: 'javascript:1' });
  assert.equal(e.joinUrl, '');
  assert.equal(e.webLink, '');
  assert.equal(meetingLink('javascript:https://teams.microsoft.com/l/meetup-join/x'), 'https://teams.microsoft.com/l/meetup-join/x');
});

test('page : politique de sécurité stricte, aucun script intégré', () => {
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1] || '';
  assert.match(csp, /script-src 'self' https:\/\/cdn\.jsdelivr\.net 'wasm-unsafe-eval';/);
  assert.ok(!/script-src[^;]*'unsafe-inline'/.test(csp), 'pas de script intégré autorisé');
  assert.ok(!/script-src[^;]*'unsafe-eval'/.test(csp.replace("'wasm-unsafe-eval'", '')), 'pas d’eval');
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'self'/);
  assert.ok(!/connect-src[^;]*\s\*[\s;]/.test(csp), 'envois limités aux services utilisés');
  assert.ok(html.indexOf('Content-Security-Policy') < html.indexOf('<script'), 'politique avant le premier script');
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/g)];
  assert.equal(inline.length, 0, 'aucun <script> sans src');
  assert.ok(!/\son[a-z]+="/i.test(html), 'aucun gestionnaire d’événement dans le HTML');
  assert.match(html, /<meta name="referrer" content="no-referrer"/);
});
