// Modules purs de l'appli : recherche, relevé d'actions, exports, lexique, voix, couleurs, Claude, espaces.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keywords, intentOf, searchMeetings, dashStats, weekStart, speakerTotals } from '../../js/insights.js';
import { extractActions, actionsToMarkdown, findDue, splitSentences } from '../../js/actions.js';
import { fmtClock, toSrt, toTxt, toMarkdown, safeFilename } from '../../js/exporters.js';
import { compileLexicon, applyLexicon, DEFAULT_LEXICON } from '../../js/lexicon.js';
import { cosine, normalize, matchVoices, centroids } from '../../js/voices.js';
import { accentVars, ACCENTS } from '../../js/perso.js';
import { buildPrompt, claudeUrl, SUMMARY_TYPES, MAX_URL_PROMPT } from '../../js/claude-export.js';
import { spacesError } from '../../js/spaces.js';
import { guessLang } from '../../js/langid.js';

const DAY = 86400000;
const NOW = new Date('2026-11-20T10:00:00').getTime();

// ---------- Recherche (insights.js) ----------
test('keywords ignore les mots vides et les mots de consigne', () => {
  assert.deepEqual(keywords('Questionne-moi sur le dossier Ledona'), ['ledona']);
  assert.deepEqual(keywords('Quelles décisions pour le lot CVC ?'), ['lot', 'cvc']);
});

test('intentOf : décisions, actions ou passages', () => {
  assert.equal(intentOf('Qu’a-t-on décidé ?'), 'decision');
  assert.equal(intentOf('Qui doit envoyer les plans ?'), 'action');
  assert.equal(intentOf('Parle-moi du scan'), 'any');
});

test('searchMeetings : passages pertinents et période', () => {
  const doc = (id, ago, texts) => ({ id, title: id, createdAt: NOW - ago * DAY, segments: texts.map((text, i) => ({ text, start: i * 10 })) });
  const sources = [
    { doc: doc('a', 1, ['Le scan 3D est complet.', 'Rien à voir.']), items: [] },
    { doc: doc('b', 20, ['Le scan du R+1 est à refaire.']), items: [] },
  ];
  const all = searchMeetings('scan', sources, { now: NOW });
  assert.deepEqual(all.hits.map((h) => h.doc.id).sort(), ['a', 'b']);
  const week = searchMeetings('scan cette semaine', sources, { now: NOW });
  assert.deepEqual(week.hits.map((h) => h.doc.id), ['a']);
});

test('dashStats et weekStart', () => {
  const docs = [{ createdAt: NOW - DAY, durationS: 600, segments: [{ conf: 0.8 }] }, { createdAt: NOW - 10 * DAY, durationS: 300, segments: [] }];
  const s = dashStats(docs, NOW);
  assert.equal(s.count, 2);
  assert.equal(s.countWeek, 1);
  assert.equal(s.seconds, 900);
  assert.equal(s.secondsPrev, 300);
  assert.equal(new Date(weekStart(NOW)).getDay(), 1, 'lundi');
});

test('speakerTotals cumule le temps de parole par nom', () => {
  const docs = [{ speakers: [{ name: 'Raf' }, { name: 'Julie' }], segments: [{ start: 0, end: 10, spk: 0 }, { start: 10, end: 15, spk: 1 }] }];
  const t = speakerTotals(docs);
  assert.ok(Array.isArray(t) || typeof t === 'object');
  assert.match(JSON.stringify(t), /Raf/);
});

// ---------- Relevé d'actions (actions.js) ----------
test('extractActions : décisions, actions, responsable et échéance', () => {
  const segments = [
    { text: 'Pour Ledona, on valide le scan 3D intérieur.', start: 0, spk: 0 },
    { text: 'Il faut intégrer les données du scan dans Revit avant vendredi.', start: 10, spk: 0 },
    { text: 'Julie, tu peux t’en charger ?', start: 20, spk: 0 },
    { text: 'Oui, je m’en occupe.', start: 25, spk: 1 },
    { text: 'On va dire que ça va.', start: 30, spk: 1 },
  ];
  const items = extractActions(segments, { speakers: [{ name: 'Raf' }, { name: 'Julie' }], meetingTime: NOW });
  const dec = items.filter((x) => x.type === 'decision');
  const act = items.filter((x) => x.type === 'action');
  assert.equal(dec.length, 1);
  assert.match(dec[0].text, /scan 3D/);
  assert.ok(act.some((a) => /Revit/.test(a.text) && /vendredi/.test(a.due)));
  assert.ok(act.some((a) => a.who === 'Julie'), 'Julie répond « je m’en occupe »');
  assert.ok(!items.some((x) => /On va dire/.test(x.text)), 'fausse action écartée');
  const md = actionsToMarkdown(items, { title: 'Ledona' });
  assert.match(md, /Ledona/);
  assert.match(md, /Revit/);
});

test('findDue et splitSentences', () => {
  assert.match(findDue('à rendre avant le 12 décembre'), /12 décembre/);
  assert.equal(findDue('rien de prévu'), null);
  assert.equal(splitSentences('Une phrase. Une autre ! Et la dernière ?').length, 3);
});

// ---------- Exports (exporters.js) ----------
test('fmtClock, toSrt, toTxt, toMarkdown, safeFilename', () => {
  assert.equal(fmtClock(65), '01:05');
  assert.equal(fmtClock(3725), '1:02:05');
  const segs = [{ text: 'Bonjour.', start: 0, end: 1.5, spk: 0 }, { text: 'Salut.', start: 2, end: 3.25, spk: 1 }];
  const srt = toSrt(segs);
  assert.match(srt, /^1\n00:00:00,000 --> 00:00:01,500\nBonjour\./);
  assert.match(toTxt(segs, { timestamps: false, speakers: ['Raf', 'Julie'] }), /Raf : Bonjour\./);
  assert.match(toMarkdown(segs, { timestamps: true, title: 'Titre', meta: 'meta' }), /^# Titre/);
  assert.ok(!/[/\\:*?"<>|]/.test(safeFilename('Réunion : lot 3/4 ?')));
});

// ---------- Lexique (lexicon.js) ----------
test('lexique : mots entiers, casse, espaces souples ; « loin » désactivé par défaut', () => {
  const rules = compileLexicon(DEFAULT_LEXICON);
  assert.equal(applyLexicon('on exporte en i f c depuis revite', rules), 'on exporte en IFC depuis Revit');
  assert.equal(applyLexicon('c’est loin', rules), 'c’est loin');
  assert.equal(applyLexicon('accord', rules), 'accord', 'pas dans un autre mot');
});

// ---------- Voix connues (voices.js) ----------
test('voix : cosinus, centroïdes et reconnaissance', () => {
  assert.ok(Math.abs(cosine([1, 0], [1, 0]) - 1) < 1e-9);
  assert.ok(Math.abs(cosine([1, 0], [0, 1])) < 1e-9);
  const n = normalize([3, 4]);
  assert.ok(Math.abs(Math.hypot(...n) - 1) < 1e-6);
  const c = centroids([{ emb: [1, 0] }, { emb: [0.9, 0.1] }, { emb: [0, 1] }], [0, 0, 1]);
  assert.equal(c.size, 2);
  const book = [{ name: 'Raf', emb: [1, 0] }, { name: 'Julie', emb: [0, 1] }];
  const m = matchVoices([[0.98, 0.05], [0.02, 0.99], [0.7, 0.7]], book);
  assert.deepEqual(m.map((x) => x.index), [0, 1, -1], 'troisième voix ambiguë : inconnue');
});

// ---------- Couleurs (perso.js) ----------
test('accentVars : variables pour les deux thèmes', () => {
  const v = accentVars(ACCENTS[0].hex);
  for (const th of ['dark', 'light']) {
    assert.match(v[th]['--accent'], /^#[0-9a-f]{6}$/);
    assert.match(v[th]['--sel-b'], /^\d+ \d+ \d+$/);
  }
  assert.equal(v.dark['--sel-b'], '106 88 246');
});

// ---------- Claude (claude-export.js) ----------
test('buildPrompt et claudeUrl', () => {
  const type = SUMMARY_TYPES[0].id;
  const p = buildPrompt({ type, title: 'Ledona', meta: 'meta', transcript: 'Bonjour.' });
  assert.match(p, /Ledona/);
  assert.match(p, /Bonjour\./);
  const u = claudeUrl('court');
  assert.match(u, /^https:\/\/claude\.ai\/new/);
  assert.ok(typeof MAX_URL_PROMPT === 'number');
});

// ---------- Espaces (spaces.js) ----------
test('spacesError : messages en clair', () => {
  assert.match(spacesError({ message: 'permission denied for table spaces', code: '42501' }), /Droits manquants/);
  assert.match(spacesError({ message: 'duplicate key value violates unique constraint' }), /déjà membre/);
  assert.match(spacesError(new Error('Failed to fetch')), /joindre le serveur/);
  assert.match(spacesError({ message: 'new row violates row-level security policy' }), /refusée/);
});

// ---------- Langue (langid.js) ----------
test('guessLang distingue français et anglais', () => {
  assert.equal(guessLang('Bonjour à tous, on fait le point sur le chantier et les livraisons de la semaine.'), 'fr');
  assert.equal(guessLang('Hello everyone, let us review the schedule and the deliveries for this week.'), 'en');
});
