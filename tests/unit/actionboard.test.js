import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actionPeople, actionsToText, collectActions, countActions, filterActions, groupActions } from '../../js/actionboard.js';

const DAY = 86400000;
// texts : [[intervenant, phrase], …]
const mk = (id, title, at, names, texts, extra = {}) => ({
  id, title, createdAt: at, segments: texts.map(([spk, text], i) => ({ text, start: i * 60, end: i * 60 + 55, spk })),
  speakers: names.map((name) => ({ name })), ...extra,
});
// Lundi 23 novembre 2026, 10 h
const monday = new Date(2026, 10, 23, 10).getTime();
const docs = [
  mk('a', 'Point Ledona', monday, ['Raf', 'Julie', 'Marc'], [
    [0, 'Il faut intégrer les données du scan dans Revit avant vendredi.'],
    [0, 'Julie, tu peux t’en charger ?'],
    [1, 'Oui, je m’en occupe.'],
    [0, 'Marc va relancer le BET fluides pour les diamètres des réseaux.'],
  ]),
  mk('b', 'Chantier', monday - 10 * DAY, ['Raf', 'Paul'], [[1, 'Je vais envoyer les photos au bureau d’études demain.'], [0, 'D’accord.']]),
];

test('suivi des actions : rassemblées, responsables, échéances, retards', () => {
  const now = monday + 2 * DAY; // mercredi
  const items = collectActions(docs, now);
  assert.ok(items.length >= 3);
  const scan = items.find((x) => /scan/.test(x.text));
  assert.ok(scan.soon && !scan.overdue); // vendredi, dans les 7 jours
  assert.ok(items.some((x) => x.who === 'Julie'));
  assert.ok(items.some((x) => x.who === 'Marc'));
  const photos = items.find((x) => /photos/.test(x.text));
  assert.equal(photos.overdue, true); // « demain » il y a 10 jours
  const c = countActions(items);
  assert.equal(c.overdue, 1);
  assert.equal(c.done, 0);
  // Filtres
  assert.ok(filterActions(items, { status: 'overdue' }).every((x) => x.overdue));
  assert.ok(filterActions(items, { status: 'all', who: 'Julie' }).every((x) => x.who === 'Julie'));
  assert.equal(filterActions(items, { status: 'all', q: 'fluides' }).length, 1);
  // Par échéance : retards en premier
  assert.equal(groupActions(items, 'due', now)[0].key, 'late');
  // Responsables : le plus chargé d'abord, « sans responsable » en dernier
  const people = actionPeople(items);
  assert.ok(people.length >= 2);
  if (people.some((p) => !p.name)) assert.equal(people[people.length - 1].name, '');
});

test('suivi des actions : état « fait », « retiré » et responsable choisi respectés ; liste à copier', () => {
  const [first] = collectActions(docs, monday);
  const d = structuredClone(docs);
  d[0].actionState = { [first.key]: 'done' };
  d[0].actionWho = { [first.key]: 'Sophie' };
  const items = collectActions(d, monday);
  const it = items.find((x) => x.key === first.key);
  assert.equal(it.done, true);
  assert.equal(it.who, 'Sophie');
  d[0].actionState = { [first.key]: 'hidden' };
  assert.ok(!collectActions(d, monday).some((x) => x.key === first.key));
  const txt = actionsToText(items);
  assert.match(txt, /Sophie :\n- \[x\]/);
  assert.match(txt, /· Point Ledona/);
});
