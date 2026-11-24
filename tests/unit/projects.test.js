import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FOLDER_COLORS, NO_FOLDER_COLOR, dayGroup, dayLabel, folderColor, speakerShares } from '../../js/projects.js';

test('couleurs de dossier : stables, différentes dans l’ordre de création, gris sans dossier', () => {
  const all = Array.from({ length: 8 }, (_, i) => ({ id: `f${i}` }));
  const colors = all.map((f) => folderColor(f.id, all));
  assert.equal(new Set(colors).size, 8);
  assert.equal(folderColor('f3', all), FOLDER_COLORS[3]);
  assert.equal(folderColor(null), NO_FOLDER_COLOR);
  assert.equal(folderColor('inconnu'), folderColor('inconnu')); // repli stable
});

test('temps de parole : parts par personne, total 100, plus bavard d’abord', () => {
  const doc = {
    speakers: [{ name: 'Raf' }, { name: 'Julie' }],
    segments: [{ spk: 0, start: 0, end: 10 }, { spk: 1, start: 10, end: 40 }, { spk: 0, start: 40, end: 50 }, { text: 'sans locuteur', start: 50, end: 60 }],
  };
  const s = speakerShares(doc);
  assert.deepEqual(s.map((x) => x.name), ['Julie', 'Raf']);
  assert.equal(s.reduce((a, x) => a + x.pct, 0), 100);
  assert.equal(s[0].pct, 60);
  assert.deepEqual(speakerShares({ segments: [] }), []);
  assert.equal(speakerShares({ segments: [{ spk: 2, start: 0, end: 5 }] })[0].name, 'Personne 3');
});

test('périodes : aujourd’hui, cette semaine, puis par mois ; libellés courts', () => {
  const now = new Date(2026, 10, 24, 15, 0).getTime();
  const at = (d, h = 10) => new Date(2026, 10, d, h, 0).getTime();
  assert.equal(dayGroup(at(24, 9), now).key, 'today');
  assert.equal(dayGroup(at(20), now).key, 'week');
  const g = dayGroup(at(10), now);
  assert.equal(g.label, 'Novembre 2026');
  assert.equal(dayGroup(new Date(2026, 9, 3).getTime(), now).label, 'Octobre 2026');
  assert.equal(dayLabel(at(24, 9), now), '09:00');
  assert.equal(dayLabel(at(23), now), 'Hier');
  assert.equal(dayLabel(at(20), now), 'Vendredi');
  assert.match(dayLabel(at(10), now), /^10 nov/);
  assert.match(dayLabel(new Date(2025, 0, 5).getTime(), now), /2025/);
});
