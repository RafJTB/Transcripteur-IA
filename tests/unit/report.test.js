// Compte rendu : contenu, page à imprimer, fichier Word.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as D from 'docx';
import { unzipSync, strFromU8 } from 'fflate';
import { buildReport, reportHtml, reportDocx, mdBlocks, inlineRuns, transcriptBlocks, metaRows } from '../../js/report.js';
import { extractActions } from '../../js/actions.js';

const T = new Date('2026-11-19T14:30:00').getTime();
const doc = {
  id: 'd1', title: 'Point équipe projet Ledona', createdAt: T, durationS: 1830, source: 'Micro',
  speakers: [{ name: 'Raf' }, { name: 'Julie' }, { name: 'Marc' }],
  summary: '## Points clés\n- Scan 3D **validé**\n- Familles BIM génériques\n\nLe budget est validé.',
  segments: [
    { text: 'Pour Ledona, on valide le scan 3D intérieur.', start: 0, end: 4, spk: 0 },
    { text: 'Il faut intégrer les données du scan dans Revit avant vendredi.', start: 5, end: 9, spk: 0 },
    { text: 'Julie, tu peux t’en charger ?', start: 10, end: 12, spk: 0 },
    { text: 'Oui, je m’en occupe.', start: 13, end: 15, spk: 1 },
    { text: 'Marc va relancer le BET fluides.', start: 20, end: 24, spk: 2 },
  ],
};
const actions = extractActions(doc.segments, { speakers: doc.speakers, meetingTime: T });

test('transcriptBlocks regroupe les phrases d’une même personne', () => {
  const b = transcriptBlocks(doc.segments, ['Raf', 'Julie', 'Marc']);
  assert.equal(b.length, 3);
  assert.equal(b[0].who, 'Raf');
  assert.match(b[0].text, /scan 3D.*Revit.*charger/);
  assert.equal(b[1].start, 13);
});

test('mdBlocks et inlineRuns : titres, puces, gras', () => {
  const b = mdBlocks(doc.summary);
  assert.deepEqual(b.map((x) => x.type), ['h', 'li', 'li', 'p']);
  assert.deepEqual(inlineRuns('Scan **validé** ok'), [{ text: 'Scan ', bold: false }, { text: 'validé', bold: true }, { text: ' ok', bold: false }]);
  assert.deepEqual(mdBlocks('**Décisions :**\n1. Une').map((x) => x.type), ['h', 'li']);
});

test('buildReport : en-tête, décisions, actions (responsable, échéance), options', () => {
  const r = buildReport(doc, { actions, folder: 'Ledona', now: T });
  assert.equal(r.title, 'Point équipe projet Ledona');
  assert.match(r.dateText, /^Jeudi 19 novembre 2026$/);
  assert.equal(r.duration, '31 min');
  assert.deepEqual(r.participants, ['Raf', 'Julie', 'Marc']);
  assert.deepEqual(metaRows(r).map(([k]) => k), ['Date', 'Durée', 'Participants', 'Projet']);
  assert.equal(r.decisions.length, 1);
  assert.match(r.actions.find((a) => /Revit/.test(a.text)).due, /^ven\. 20 nov\.$/, 'échéance en date');
  assert.equal(r.actions.find((a) => /charger/.test(a.text)).who, 'Julie');
  assert.equal(r.summary.length, 4);
  assert.equal(r.transcript.length, 3);
  const lite = buildReport(doc, { actions, include: { summary: false, transcript: false } });
  assert.equal(lite.summary.length, 0);
  assert.equal(lite.transcript.length, 0);
  // Actions retirées (onglet Actions) : absentes ; faites : marquées
  const hidden = actions.map((a) => ({ ...a, hidden: /BET/.test(a.text), done: /Revit/.test(a.text) }));
  const r2 = buildReport(doc, { actions: hidden });
  assert.ok(!r2.actions.some((a) => /BET/.test(a.text)));
  assert.ok(r2.actions.find((a) => /Revit/.test(a.text)).done);
});

test('participants anonymes : nombre de personnes', () => {
  const r = buildReport({ ...doc, speakers: [{ name: 'Personne 1' }, { name: 'Personne 2' }] }, {});
  assert.deepEqual(metaRows(r).find(([k]) => k === 'Participants'), ['Participants', '2 personnes']);
});

test('reportHtml : page A4, texte échappé, sections', () => {
  const r = buildReport({ ...doc, title: 'Réunion <b>test</b>' }, { actions, now: T });
  const html = reportHtml(r);
  assert.match(html, /size: A4/);
  assert.ok(html.includes('Réunion &lt;b&gt;test&lt;/b&gt;'));
  assert.ok(!html.includes('<b>test</b>'));
  for (const s of ['Résumé', 'Décisions', 'Actions', 'Annexe · Transcription', '<b>validé</b>', 'Julie']) assert.ok(html.includes(s), s);
});

test('reportDocx : un vrai fichier Word avec tout le contenu', async () => {
  const r = buildReport(doc, { actions, folder: 'Ledona', include: { timestamps: true }, now: T });
  const blob = await reportDocx(r, D);
  const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  assert.ok(files['word/document.xml'], 'document.xml présent');
  const xml = strFromU8(files['word/document.xml']);
  for (const s of ['COMPTE RENDU DE RÉUNION', 'Point équipe projet Ledona', 'PARTICIPANTS', 'Raf, Julie, Marc', 'Résumé', 'validé', 'Décisions', 'Actions', 'RESPONSABLE', 'Revit', 'Julie', 'Annexe · Transcription', '00:13']) {
    assert.ok(xml.includes(s), `manque : ${s}`);
  }
  const footer = Object.keys(files).find((k) => /word\/footer\d*\.xml/.test(k));
  assert.match(strFromU8(files[footer]), /PAGE/);
});
